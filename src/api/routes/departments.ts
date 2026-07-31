// ---------------------------------------------------------------------------
// D1-backed departments route.
//
// Originally read-only (mirrored src/api/routes/departments.ts). The Working
// Hours revamp added a Manage Departments admin UI on top — POST / PUT /
// DELETE are wired here so adding/renaming/removing depts no longer requires
// a code deploy + migration. Departments has no RBAC gates (yet) — workers
// already enforces workers:* and the dept admin UI is gated client-side
// behind the same admin route.
//
// `code` is treated as the foreign key (workers.departmentCode, etc.) so it
// is set once at create time and locked from updates. id stays stable for
// row-level FK joins.
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

// Explicit snapshot wipe on write. worker_payslips_snapshot,
// department_performance_snapshot and worker_history_snapshot all derive from
// departments, but that table has no updated_at/created_at column so the
// freshness probe cannot auto-invalidate them. Every departments write path
// must DELETE the affected snapshot rows itself. Wrapped so a wipe failure
// never breaks the save.
async function wipeDepartmentSnapshots(c: Context<Env>) {
  try {
    const { getOrgId } = await import("../lib/tenant");
    const { invalidateSnapshot } = await import("../lib/snapshot");
    const orgId = getOrgId(c);
    await invalidateSnapshot(
      c.var.DB,
      { tableName: "worker_payslips_snapshot", sourceTables: [] },
      orgId,
    );
    await invalidateSnapshot(
      c.var.DB,
      { tableName: "department_performance_snapshot", sourceTables: [] },
      orgId,
    );
    await invalidateSnapshot(
      c.var.DB,
      { tableName: "worker_history_snapshot", sourceTables: [] },
      orgId,
    );
  } catch (e) {
    console.warn("[departments-write] snapshot wipe failed:", e);
  }
}

type DepartmentRow = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  sequence: number;
  color: string;
  workingHoursPerDay: number;
  isProduction: number;
};

type Department = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  sequence: number;
  color: string;
  workingHoursPerDay: number;
  isProduction: boolean;
};

function rowToDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortName: row.shortName,
    sequence: row.sequence,
    color: row.color,
    workingHoursPerDay: row.workingHoursPerDay,
    // Postgres currently stores this as INTEGER NOT NULL DEFAULT 1 (0/1) —
    // surface a real boolean to the client so the frontend doesn't have to
    // remember to truthy-check the int. Use Boolean(...) so a future BOOLEAN
    // migration (where the driver returns true/false) doesn't silently flip
    // every dept to non-production.
    isProduction: Boolean(row.isProduction),
  };
}

function genId(): string {
  return `dept-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Runtime self-apply for the FOAM_CUTTING department + the FOAM relabel.
//
// Departments live in the DB and migrations are INERT on deploy (see
// CLAUDE.md), so the ONLY way this reaches existing prod is a runtime, awaited,
// idempotent apply on a hot read path. GET /api/departments is hit on nearly
// every page load (sidebar / employee dropdowns), so we run it there.
//
// FOAM_CUTTING is a tracking/scheduling/labor stage placed immediately BEFORE
// FOAM (Foam Bonding) in the line order. Raw material stays consumed at
// FAB_CUT — this step touches no RM.
//
// Insert is guarded on "FOAM_CUTTING absent" so the one-time sequence shift
// (open a slot right before FOAM, preserving any admin-customised ordering of
// the other depts) runs exactly once. The FOAM shortName relabel is a separate
// always-safe idempotent UPDATE.
// ---------------------------------------------------------------------------
async function ensureFoamCuttingDept(c: Context<Env>): Promise<void> {
  try {
    const existing = await c.var.DB.prepare(
      "SELECT id FROM departments WHERE code = 'FOAM_CUTTING'",
    ).first<{ id: string }>();
    if (!existing) {
      const foam = await c.var.DB.prepare(
        "SELECT sequence FROM departments WHERE code = 'FOAM'",
      ).first<{ sequence: number }>();
      const foamSeq = foam?.sequence ?? 4;
      // Shift FOAM and everything after it up by one so FOAM_CUTTING can take
      // FOAM's old slot — relative order of every existing dept is preserved.
      await c.var.DB.prepare(
        "UPDATE departments SET sequence = sequence + 1 WHERE sequence >= ?",
      )
        .bind(foamSeq)
        .run();
      await c.var.DB.prepare(
        `INSERT INTO departments (id, code, name, shortName, sequence, color, workingHoursPerDay, isProduction)
         VALUES (?, 'FOAM_CUTTING', 'Foam Cutting', 'Foam Cut', ?, '#A78BFA', 9, 1)`,
      )
        .bind(genId(), foamSeq)
        .run();
    }
    // Owner request: FOAM must DISPLAY as "Foam Bonding". Idempotent — only
    // writes when it isn't already set.
    await c.var.DB.prepare(
      "UPDATE departments SET shortName = 'Foam Bonding' WHERE code = 'FOAM' AND shortName <> 'Foam Bonding'",
    ).run();
  } catch (e) {
    // Never let the self-apply break the read — a fresh DB whose departments
    // table predates isProduction, or a transient error, just falls through
    // and the caller returns whatever rows exist.
    console.warn("[departments] ensureFoamCuttingDept failed:", e);
  }
}

// Code is used as a soft FK in workers.departmentCode (and historical rows),
// so we lock it to uppercase + underscores to match the existing seed
// convention (FAB_CUT, R_AND_D, etc.). Numeric chars allowed for future-
// proofing (e.g. R_AND_D_2).
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// GET /api/departments
app.get("/", async (c) => {
  // Runtime self-apply — reaches existing prod because migrations are inert on
  // deploy. Awaited BEFORE the read so the new FOAM_CUTTING row + FOAM relabel
  // are in the returned set.
  await ensureFoamCuttingDept(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM departments ORDER BY sequence",
  ).all<DepartmentRow>();
  return c.json({
    success: true,
    data: (res.results ?? []).map(rowToDepartment),
  });
});

// POST /api/departments — create a new dept.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "departments", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const {
      code,
      name,
      shortName,
      sequence,
      color,
      workingHoursPerDay,
      isProduction,
    } = body ?? {};

    if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
      return c.json(
        {
          success: false,
          error:
            "code is required and must be uppercase letters/digits/underscores (e.g. FAB_CUT)",
        },
        400,
      );
    }
    if (typeof name !== "string" || name.trim() === "") {
      return c.json({ success: false, error: "name is required" }, 400);
    }
    if (typeof shortName !== "string" || shortName.trim() === "") {
      return c.json({ success: false, error: "shortName is required" }, 400);
    }
    if (!Number.isFinite(sequence)) {
      return c.json(
        { success: false, error: "sequence must be a number" },
        400,
      );
    }
    if (typeof color !== "string" || color.trim() === "") {
      return c.json({ success: false, error: "color is required" }, 400);
    }
    if (!Number.isFinite(workingHoursPerDay)) {
      return c.json(
        { success: false, error: "workingHoursPerDay must be a number" },
        400,
      );
    }
    if (typeof isProduction !== "boolean") {
      return c.json(
        { success: false, error: "isProduction must be a boolean" },
        400,
      );
    }

    // Uniqueness: code is the soft FK — duplicate codes would silently
    // mis-route worker assignments, so reject early with 409.
    const dupe = await c.var.DB.prepare(
      "SELECT id FROM departments WHERE code = ?",
    )
      .bind(code)
      .first<{ id: string }>();
    if (dupe) {
      return c.json(
        { success: false, error: `Department code "${code}" already exists` },
        409,
      );
    }

    const id = genId();
    await c.var.DB.prepare(
      `INSERT INTO departments (id, code, name, shortName, sequence, color, workingHoursPerDay, isProduction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        code,
        name,
        shortName,
        sequence,
        color,
        workingHoursPerDay,
        isProduction ? 1 : 0,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM departments WHERE id = ?",
    )
      .bind(id)
      .first<DepartmentRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create department" },
        500,
      );
    }
    await wipeDepartmentSnapshots(c);
    return c.json({ success: true, data: rowToDepartment(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/departments/:id — partial update. `code` is intentionally omitted
// from the whitelist because it's the soft FK in workers.departmentCode and
// historical rows; renaming would silently desynchronize joins.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "departments", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM departments WHERE id = ?",
    )
      .bind(id)
      .first<DepartmentRow>();
    if (!existing) {
      return c.json({ success: false, error: "Department not found" }, 404);
    }
    const body = await c.req.json();

    // Validate any field that was actually provided. Unset fields fall back
    // to the existing row.
    if (
      body.name !== undefined &&
      (typeof body.name !== "string" || body.name.trim() === "")
    ) {
      return c.json(
        { success: false, error: "name must be a non-empty string" },
        400,
      );
    }
    if (
      body.shortName !== undefined &&
      (typeof body.shortName !== "string" || body.shortName.trim() === "")
    ) {
      return c.json(
        { success: false, error: "shortName must be a non-empty string" },
        400,
      );
    }
    if (body.sequence !== undefined && !Number.isFinite(body.sequence)) {
      return c.json(
        { success: false, error: "sequence must be a number" },
        400,
      );
    }
    if (
      body.color !== undefined &&
      (typeof body.color !== "string" || body.color.trim() === "")
    ) {
      return c.json(
        { success: false, error: "color must be a non-empty string" },
        400,
      );
    }
    if (
      body.workingHoursPerDay !== undefined &&
      !Number.isFinite(body.workingHoursPerDay)
    ) {
      return c.json(
        { success: false, error: "workingHoursPerDay must be a number" },
        400,
      );
    }
    if (
      body.isProduction !== undefined &&
      typeof body.isProduction !== "boolean"
    ) {
      return c.json(
        { success: false, error: "isProduction must be a boolean" },
        400,
      );
    }

    const merged = {
      name: body.name ?? existing.name,
      shortName: body.shortName ?? existing.shortName,
      sequence: body.sequence ?? existing.sequence,
      color: body.color ?? existing.color,
      workingHoursPerDay:
        body.workingHoursPerDay ?? existing.workingHoursPerDay,
      isProduction:
        body.isProduction !== undefined
          ? body.isProduction
          : Boolean(existing.isProduction),
    };

    await c.var.DB.prepare(
      `UPDATE departments SET
         name = ?, shortName = ?, sequence = ?, color = ?,
         workingHoursPerDay = ?, isProduction = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.shortName,
        merged.sequence,
        merged.color,
        merged.workingHoursPerDay,
        merged.isProduction ? 1 : 0,
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM departments WHERE id = ?",
    )
      .bind(id)
      .first<DepartmentRow>();
    if (!updated) {
      return c.json({ success: false, error: "Department not found" }, 404);
    }
    await wipeDepartmentSnapshots(c);
    return c.json({ success: true, data: rowToDepartment(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/departments/:id — hard delete, blocked if any worker still
// references the dept (409 + count so the UI can prompt the admin to
// reassign). We don't soft-delete because departments doesn't carry an
// `active` column and the row count is small enough that hard deletes are
// fine once the FK check passes.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "departments", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM departments WHERE id = ?",
  )
    .bind(id)
    .first<DepartmentRow>();
  if (!existing) {
    return c.json({ success: false, error: "Department not found" }, 404);
  }

  const workerCountRow = await c.var.DB.prepare(
    "SELECT COUNT(*) AS n FROM workers WHERE departmentId = ?",
  )
    .bind(id)
    .first<{ n: number }>();
  const workerCount = workerCountRow?.n ?? 0;
  if (workerCount > 0) {
    return c.json(
      {
        success: false,
        error: `Cannot delete department: ${workerCount} worker(s) still assigned`,
        workerCount,
      },
      409,
    );
  }

  await c.var.DB.prepare("DELETE FROM departments WHERE id = ?").bind(id).run();
  await wipeDepartmentSnapshots(c);
  return c.json({ success: true, data: { id } });
});

export default app;
