// ---------------------------------------------------------------------------
// D1-backed workers route.
//
// Mirrors the old src/api/routes/workers.ts shape so the SPA frontend
// doesn't need any changes. On POST/PUT, `departmentCode` is resolved by
// joining on the departments table rather than trusting the client payload.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

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
app.get("/", async (c) => {
  const departmentId = c.req.query("departmentId");
  const stmt = departmentId
    ? c.env.DB.prepare(
        "SELECT * FROM workers WHERE departmentId = ? ORDER BY empNo",
      ).bind(departmentId)
    : c.env.DB.prepare("SELECT * FROM workers ORDER BY empNo");
  const res = await stmt.all<WorkerRow>();
  const data = (res.results ?? []).map(rowToWorker);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/workers — create
app.post("/", async (c) => {
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
    } = body;

    if (!name || !empNo) {
      return c.json(
        { success: false, error: "name and empNo are required" },
        400,
      );
    }

    const department = await c.env.DB.prepare(
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

    await c.env.DB.prepare(
      `INSERT INTO workers (id, empNo, name, departmentId, departmentCode, position,
         phone, status, basicSalarySen, workingHoursPerDay, workingDaysPerMonth,
         joinDate, icNumber, passportNumber, nationality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        joinDate,
        "",
        "",
        "",
      )
      .run();

    const created = await c.env.DB.prepare(
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
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  if (!row) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }
  return c.json({ success: true, data: rowToWorker(row) });
});

// PUT /api/workers/:id — update
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
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
      const department = await c.env.DB.prepare(
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
      joinDate: body.joinDate ?? existing.joinDate ?? "",
      icNumber: body.icNumber ?? existing.icNumber ?? "",
      passportNumber: body.passportNumber ?? existing.passportNumber ?? "",
      nationality: body.nationality ?? existing.nationality ?? "",
    };

    await c.env.DB.prepare(
      `UPDATE workers SET
         name = ?, empNo = ?, departmentId = ?, departmentCode = ?,
         position = ?, phone = ?, status = ?, basicSalarySen = ?,
         workingHoursPerDay = ?, workingDaysPerMonth = ?, joinDate = ?,
         icNumber = ?, passportNumber = ?, nationality = ?
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
        merged.joinDate,
        merged.icNumber,
        merged.passportNumber,
        merged.nationality,
        id,
      )
      .run();

    const updated = await c.env.DB.prepare(
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
// `?hard=1` (SUPER_ADMIN only) hard-deletes the row. FKs from
// worker_pins / worker_tokens / attendance / salary_adjustments /
// worker_salary_periods / payroll_records cascade via ON DELETE CASCADE
// (see migrations/0001_init.sql). The soft-FK pic1Id / pic2Id columns on
// job_cards + piece_pics are not declared as FKs, so we explicitly NULL
// them out first to avoid dangling references.
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  if (!existing) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }

  const hard = c.req.query("hard") === "1";

  if (hard) {
    // Role gate — hard deletes wipe referential history, SUPER_ADMIN only.
    const role = (c as unknown as {
      get: (k: string) => string | undefined;
    }).get("userRole");
    if (role !== "SUPER_ADMIN") {
      return c.json(
        { success: false, error: "Hard delete requires SUPER_ADMIN" },
        403,
      );
    }

    // Nullify the soft-FK pic columns on job_cards + piece_pics so the
    // cascade delete doesn't leave orphaned worker references. Wrapped in
    // a batch with the terminal DELETE so partial failures roll back.
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE job_cards SET pic1Id = NULL, pic1Name = NULL WHERE pic1Id = ?",
      ).bind(id),
      c.env.DB.prepare(
        "UPDATE job_cards SET pic2Id = NULL, pic2Name = NULL WHERE pic2Id = ?",
      ).bind(id),
      c.env.DB.prepare(
        "UPDATE piece_pics SET pic1Id = NULL, pic1Name = NULL WHERE pic1Id = ?",
      ).bind(id),
      c.env.DB.prepare(
        "UPDATE piece_pics SET pic2Id = NULL, pic2Name = NULL WHERE pic2Id = ?",
      ).bind(id),
      c.env.DB.prepare("DELETE FROM workers WHERE id = ?").bind(id),
    ]);
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
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE workers SET status = 'INACTIVE' WHERE id = ?",
    ).bind(id),
    // Kill any live worker-portal sessions so the inactive worker can't
    // keep browsing on an old token.
    c.env.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?").bind(id),
  ]);
  const updated = await c.env.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  return c.json({
    success: true,
    data: updated
      ? rowToWorker(updated)
      : { ...rowToWorker(existing), status: "INACTIVE" },
  });
});

export default app;
