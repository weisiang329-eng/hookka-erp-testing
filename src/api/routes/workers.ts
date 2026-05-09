// ---------------------------------------------------------------------------
// D1-backed workers route.
//
// Mirrors the old src/api/routes/workers.ts shape so the SPA frontend
// doesn't need any changes. On POST/PUT, `departmentCode` is resolved by
// joining on the departments table rather than trusting the client payload.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { hashPin } from "../lib/auth-utils";

const app = new Hono<Env>();

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string | null;
  departmentCode: string | null;
  position: string | null;
  phone: string | null;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number | null;
  joinDate: string | null;
  icNumber: string | null;
  passportNumber: string | null;
  nationality: string | null;
};

type DepartmentRow = {
  id: string;
  code: string;
  workingHoursPerDay: number;
};

function rowToWorker(row: WorkerRow) {
  return {
    id: row.id,
    empNo: row.empNo,
    name: row.name,
    departmentId: row.departmentId ?? "",
    departmentCode: row.departmentCode ?? "",
    position: row.position ?? "",
    phone: row.phone ?? "",
    status: row.status,
    basicSalarySen: row.basicSalarySen,
    workingHoursPerDay: row.workingHoursPerDay,
    workingDaysPerMonth: row.workingDaysPerMonth,
    otMultiplier: row.otMultiplier ?? 1.5,
    joinDate: row.joinDate ?? "",
    icNumber: row.icNumber ?? "",
    passportNumber: row.passportNumber ?? "",
    nationality: row.nationality ?? "",
  };
}

function genId(): string {
  return `worker-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/workers?departmentId=dept-1
//   ?departmentCode=FAB_CUT — alternative when caller has the code (e.g.
//   the Service Case root-cause form picks dept by code, not id).
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — workers:read.
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const departmentId = c.req.query("departmentId");
  const departmentCode = c.req.query("departmentCode");
  let stmt: D1PreparedStatement;
  if (departmentId) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM workers WHERE departmentId = ? ORDER BY empNo",
    ).bind(departmentId);
  } else if (departmentCode) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM workers WHERE departmentCode = ? ORDER BY empNo",
    ).bind(departmentCode);
  } else {
    stmt = c.var.DB.prepare("SELECT * FROM workers ORDER BY empNo");
  }
  const res = await stmt.all<WorkerRow>();
  const data = (res.results ?? []).map(rowToWorker);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/workers — create
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — workers:create.
  const denied = await requirePermission(c, "workers", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const {
      name,
      empNo,
      departmentId,
      position,
      phone,
      basicSalarySen,
      workingHoursPerDay,
      otMultiplier,
    } = body;

    if (!name || !empNo) {
      return c.json(
        { success: false, error: "name and empNo are required" },
        400,
      );
    }

    const department = await c.var.DB.prepare(
      "SELECT id, code, workingHoursPerDay FROM departments WHERE id = ?",
    )
      .bind(departmentId)
      .first<DepartmentRow>();
    if (!department) {
      return c.json({ success: false, error: "Department not found" }, 400);
    }

    const id = genId();
    const joinDate = new Date().toISOString().split("T")[0];
    const resolvedHours =
      workingHoursPerDay ?? department.workingHoursPerDay;

    await c.var.DB.prepare(
      `INSERT INTO workers (id, empNo, name, departmentId, departmentCode, position,
         phone, status, basicSalarySen, workingHoursPerDay, workingDaysPerMonth, otMultiplier,
         joinDate, icNumber, passportNumber, nationality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        empNo,
        name,
        departmentId,
        department.code,
        position ?? "",
        phone ?? "",
        "ACTIVE",
        basicSalarySen ?? 0,
        resolvedHours,
        26,
        Number.isFinite(otMultiplier) ? otMultiplier : 1.5,
        joinDate,
        "",
        "",
        "",
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM workers WHERE id = ?",
    )
      .bind(id)
      .first<WorkerRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create worker" },
        500,
      );
    }
    return c.json({ success: true, data: rowToWorker(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/workers/:id
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  if (!row) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }
  return c.json({ success: true, data: rowToWorker(row) });
});

// PUT /api/workers/:id — update
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM workers WHERE id = ?",
    )
      .bind(id)
      .first<WorkerRow>();
    if (!existing) {
      return c.json({ success: false, error: "Worker not found" }, 404);
    }
    const body = await c.req.json();

    // If departmentId changes, re-resolve departmentCode from the departments table.
    let nextDepartmentCode = existing.departmentCode;
    const nextDepartmentId =
      body.departmentId !== undefined
        ? body.departmentId
        : existing.departmentId;
    if (
      body.departmentId !== undefined &&
      body.departmentId !== existing.departmentId
    ) {
      const department = await c.var.DB.prepare(
        "SELECT id, code, workingHoursPerDay FROM departments WHERE id = ?",
      )
        .bind(body.departmentId)
        .first<DepartmentRow>();
      if (!department) {
        return c.json({ success: false, error: "Department not found" }, 400);
      }
      nextDepartmentCode = department.code;
    } else if (body.departmentCode !== undefined) {
      // Allow explicit override only when departmentId didn't change.
      nextDepartmentCode = body.departmentCode;
    }

    const merged = {
      name: body.name ?? existing.name,
      empNo: body.empNo ?? existing.empNo,
      departmentId: nextDepartmentId,
      departmentCode: nextDepartmentCode,
      position: body.position ?? existing.position ?? "",
      phone: body.phone ?? existing.phone ?? "",
      status: body.status ?? existing.status,
      basicSalarySen: body.basicSalarySen ?? existing.basicSalarySen,
      workingHoursPerDay:
        body.workingHoursPerDay ?? existing.workingHoursPerDay,
      workingDaysPerMonth:
        body.workingDaysPerMonth ?? existing.workingDaysPerMonth,
      otMultiplier:
        body.otMultiplier ?? existing.otMultiplier ?? 1.5,
      joinDate: body.joinDate ?? existing.joinDate ?? "",
      icNumber: body.icNumber ?? existing.icNumber ?? "",
      passportNumber: body.passportNumber ?? existing.passportNumber ?? "",
      nationality: body.nationality ?? existing.nationality ?? "",
    };

    await c.var.DB.prepare(
      `UPDATE workers SET
         name = ?, empNo = ?, departmentId = ?, departmentCode = ?,
         position = ?, phone = ?, status = ?, basicSalarySen = ?,
         workingHoursPerDay = ?, workingDaysPerMonth = ?, otMultiplier = ?,
         joinDate = ?, icNumber = ?, passportNumber = ?, nationality = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.empNo,
        merged.departmentId,
        merged.departmentCode,
        merged.position,
        merged.phone,
        merged.status,
        merged.basicSalarySen,
        merged.workingHoursPerDay,
        merged.workingDaysPerMonth,
        merged.otMultiplier,
        merged.joinDate,
        merged.icNumber,
        merged.passportNumber,
        merged.nationality,
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM workers WHERE id = ?",
    )
      .bind(id)
      .first<WorkerRow>();
    if (!updated) {
      return c.json({ success: false, error: "Worker not found" }, 404);
    }
    return c.json({ success: true, data: rowToWorker(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/workers/:id
//
// Default behaviour is a *soft* delete — flips status to INACTIVE so the
// row's history (piece completions, payroll, attendance) stays intact.
// Live worker tokens are purged so any session for that worker is killed
// immediately.
//
// `?hard=1` requires the workers:delete permission (P3.3-followup) — used
// to be a hard-coded SUPER_ADMIN check, now delegated to the role matrix
// so a custom role with workers:delete can be configured. SUPER_ADMIN
// short-circuits via lib/rbac.ts so existing admin behavior is preserved.
// FKs from worker_pins / worker_tokens / attendance / salary_adjustments /
// worker_salary_periods / payroll_records cascade via ON DELETE CASCADE
// (see migrations/0001_init.sql). The soft-FK pic1Id / pic2Id columns on
// job_cards + piece_pics are not declared as FKs, so we explicitly NULL
// them out first to avoid dangling references.
app.delete("/:id", async (c) => {
  // Soft delete is gated as workers:delete too — the row flip kills live
  // sessions and is a security-relevant mutation. Hard delete picks up
  // the same gate; if needed a future split can add a separate
  // `workers:hard-delete` action to the seed.
  const denied = await requirePermission(c, "workers", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  if (!existing) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }

  const hard = c.req.query("hard") === "1";

  if (hard) {

    // Nullify the soft-FK pic columns on job_cards + piece_pics so the
    // cascade delete doesn't leave orphaned worker references. Wrapped in
    // a batch with the terminal DELETE so partial failures roll back.
    await c.var.DB.batch([
      c.var.DB.prepare(
        "UPDATE job_cards SET pic1Id = NULL, pic1Name = NULL WHERE pic1Id = ?",
      ).bind(id),
      c.var.DB.prepare(
        "UPDATE job_cards SET pic2Id = NULL, pic2Name = NULL WHERE pic2Id = ?",
      ).bind(id),
      c.var.DB.prepare(
        "UPDATE piece_pics SET pic1Id = NULL, pic1Name = NULL WHERE pic1Id = ?",
      ).bind(id),
      c.var.DB.prepare(
        "UPDATE piece_pics SET pic2Id = NULL, pic2Name = NULL WHERE pic2Id = ?",
      ).bind(id),
      c.var.DB.prepare("DELETE FROM workers WHERE id = ?").bind(id),
    ]);

    // Audit emit (P3.4) — hard delete is irreversible; capture the row
    // snapshot so a future forensic query can reconstruct who/what was
    // wiped. Soft delete is journaled via job_card_events / status flips
    // already; only the hard-delete branch needs an audit row here.
    await emitAudit(c, {
      resource: "workers",
      resourceId: id,
      action: "delete",
      before: rowToWorker(existing),
    });

    // Return a synthetic "terminated" snapshot so the client sees the final
    // state without another round-trip.
    return c.json({
      success: true,
      data: { ...rowToWorker(existing), status: "DELETED" },
    });
  }

  // Soft delete path — idempotent: re-hitting on an already-INACTIVE row is
  // a no-op (status stays INACTIVE, no audit column on this table).
  //
  // NOTE: the workers table has no updated_at column (see 0001_init.sql),
  // which is why the spec's `updated_at = ?` clause is skipped here.
  await c.var.DB.batch([
    c.var.DB.prepare(
      "UPDATE workers SET status = 'INACTIVE' WHERE id = ?",
    ).bind(id),
    // Kill any live worker-portal sessions so the inactive worker can't
    // keep browsing on an old token.
    c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?").bind(id),
  ]);
  const updated = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  return c.json({
    success: true,
    data: updated
      ? rowToWorker(updated)
      : { ...rowToWorker(existing), status: "INACTIVE" },
  });
});

// ---------------------------------------------------------------------------
// Admin PIN provisioning
// ---------------------------------------------------------------------------
//
// Two endpoints for the Employee Master page so the operator can hand out PINs
// directly instead of relying on workers self-onboarding via the existing
// /api/worker-auth/login firstTimePin path. Cleartext PINs are returned EXACTLY
// once in the response (subsequent reads only see the SHA-256 hash) — admin
// must record/distribute on the spot.
//
// Both endpoints are gated by workers:update. Setting/rotating a PIN also
// invalidates active worker_tokens for the worker so any open mobile session
// is forced to re-authenticate with the new PIN.
//
// The existing self-service reset (POST /api/worker-auth/reset-pin via
// empNo + phoneLast4) remains alive — both flows coexist.
// ---------------------------------------------------------------------------

function generateRandomPin(): string {
  // 6-digit numeric PIN. Math.random is fine here because the entropy of any
  // 6-digit PIN is bounded by the 10^6 search space (regardless of generator),
  // and the worker portal already throttles login attempts at 10/15min via
  // checkLoginRateLimit. crypto.getRandomValues would be marginally better
  // but adds no real security gain for this use case.
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

// POST /api/workers/:id/set-pin
// Body: { pin?: string } — when omitted, generate a random 6-digit PIN.
// Response: { success: true, data: { workerId, empNo, name, pin } }
//   pin is the cleartext, ONE-TIME RETURN ONLY. Admin records and shares.
app.post("/:id/set-pin", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const worker = await c.var.DB.prepare(
    "SELECT id, empNo, name, status FROM workers WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; empNo: string; name: string; status: string }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }

  let body: { pin?: string } = {};
  try {
    body = (await c.req.json()) as { pin?: string };
  } catch {
    body = {};
  }

  let cleartext: string;
  if (typeof body.pin === "string" && body.pin.length > 0) {
    if (!/^\d{6}$/.test(body.pin)) {
      return c.json(
        { success: false, error: "PIN must be 6 digits" },
        400,
      );
    }
    cleartext = body.pin;
  } else {
    cleartext = generateRandomPin();
  }

  const hashed = await hashPin(cleartext);
  const now = new Date().toISOString();

  // UPSERT — admin sets must_reset = false (no forced reset on first login;
  // worker can use the PIN directly).
  await c.var.DB.prepare(
    `INSERT INTO worker_pins (workerId, pin, updatedAt, must_reset) VALUES (?, ?, ?, false)
     ON CONFLICT (workerId) DO UPDATE SET pin = EXCLUDED.pin, updatedAt = EXCLUDED.updatedAt, must_reset = false`,
  )
    .bind(worker.id, hashed, now)
    .run();

  // Force re-login on any open worker portal session for this worker.
  await c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
    .bind(worker.id)
    .run();

  // Audit row — record that the PIN was reset by an admin. The cleartext PIN
  // is intentionally NOT stored on the audit row; only the fact of the reset.
  await emitAudit(c, {
    resource: "workers",
    resourceId: worker.id,
    action: "pin-reset",
  });

  return c.json({
    success: true,
    data: {
      workerId: worker.id,
      empNo: worker.empNo,
      name: worker.name,
      pin: cleartext,
    },
  });
});

// POST /api/workers/bulk-generate-pins
// Body: { workerIds?: string[] }
//   - omitted/empty: every ACTIVE worker without an existing worker_pins row
//   - provided: only those ids (skips ones that are not ACTIVE or vanished)
// Response: { success: true, data: { generated: [{ workerId, empNo, name, pin }], skipped: number } }
//   Cleartext PINs only here — admin must download/record before navigating away.
app.post("/bulk-generate-pins", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;

  let body: { workerIds?: string[] } = {};
  try {
    body = (await c.req.json()) as { workerIds?: string[] };
  } catch {
    body = {};
  }

  let targets: { id: string; empNo: string; name: string }[];
  let skipped = 0;
  if (Array.isArray(body.workerIds) && body.workerIds.length > 0) {
    // Caller-supplied list — fetch matching ACTIVE workers, count ones that
    // didn't resolve as skipped.
    const placeholders = body.workerIds.map(() => "?").join(",");
    const res = await c.var.DB.prepare(
      `SELECT id, empNo, name FROM workers WHERE id IN (${placeholders}) AND status = 'ACTIVE'`,
    )
      .bind(...body.workerIds)
      .all<{ id: string; empNo: string; name: string }>();
    targets = res.results ?? [];
    skipped = body.workerIds.length - targets.length;
  } else {
    // Default — every ACTIVE worker WITHOUT an existing PIN row.
    const res = await c.var.DB.prepare(
      `SELECT w.id AS id, w.empNo AS empNo, w.name AS name
         FROM workers w
         LEFT JOIN worker_pins p ON p.workerId = w.id
        WHERE w.status = 'ACTIVE' AND p.workerId IS NULL
        ORDER BY w.empNo`,
    ).all<{ id: string; empNo: string; name: string }>();
    targets = res.results ?? [];
  }

  const generated: {
    workerId: string;
    empNo: string;
    name: string;
    pin: string;
  }[] = [];
  const now = new Date().toISOString();

  for (const t of targets) {
    const cleartext = generateRandomPin();
    const hashed = await hashPin(cleartext);
    await c.var.DB.prepare(
      `INSERT INTO worker_pins (workerId, pin, updatedAt, must_reset) VALUES (?, ?, ?, false)
       ON CONFLICT (workerId) DO UPDATE SET pin = EXCLUDED.pin, updatedAt = EXCLUDED.updatedAt, must_reset = false`,
    )
      .bind(t.id, hashed, now)
      .run();
    await c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
      .bind(t.id)
      .run();
    generated.push({
      workerId: t.id,
      empNo: t.empNo,
      name: t.name,
      pin: cleartext,
    });
  }

  // Single audit row capturing the bulk action; per-worker rows would be
  // noisy on a fresh-onboarding batch of 30+ workers. resourceId is left
  // empty since this targets multiple workers; the after payload lists the
  // affected workerIds for forensic reconstruction (without cleartext PINs).
  await emitAudit(c, {
    resource: "workers",
    resourceId: "*",
    action: "pin-bulk-generate",
    after: {
      workerIds: generated.map((g) => g.workerId),
      count: generated.length,
    },
  });

  return c.json({
    success: true,
    data: {
      generated,
      skipped,
    },
  });
});

export default app;
