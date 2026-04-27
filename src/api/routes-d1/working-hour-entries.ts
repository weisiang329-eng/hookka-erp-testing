// ---------------------------------------------------------------------------
// D1-backed working_hour_entries route.
//
//   GET    /api/working-hour-entries?attendanceId=...
//   GET    /api/working-hour-entries?date=YYYY-MM-DD
//   GET    /api/working-hour-entries?workerId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
//   POST   /api/working-hour-entries                — create one entry
//   POST   /api/working-hour-entries/bulk            — replace all entries for an attendance
//   PUT    /api/working-hour-entries/:id             — update hours / category / notes
//   DELETE /api/working-hour-entries/:id
//
// One row per (attendance × department × category). Hours are decimal
// (e.g. 7.5). PRODUCTION_SHORTFALL / WAREHOUSING / REPAIR / MAINTENANCE are
// non-production depts; for those, category MUST be empty. For SOFA / BEDFRAME
// / ACCESSORY production depts, category is required. The bulk endpoint is
// the primary write path used by the Working Hours breakdown UI — it wipes
// the existing per-attendance rows and inserts the new ones in one shot, so
// the UI doesn't have to track which rows changed.
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type EntryRow = {
  id: string;
  attendanceId: string;
  workerId: string;
  date: string;
  departmentCode: string;
  category: string | null;
  hours: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

// Production departments — for these, category (SOFA / BEDFRAME / ACCESSORY)
// is required. Everything else (WAREHOUSING / REPAIR / MAINTENANCE /
// PRODUCTION_SHORTFALL) is non-production and must NOT carry a category.
const PRODUCTION_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
]);
const VALID_CATEGORIES = new Set(["SOFA", "BEDFRAME", "ACCESSORY"]);

function rowToEntry(r: EntryRow) {
  return {
    id: r.id,
    attendanceId: r.attendanceId,
    workerId: r.workerId,
    date: r.date,
    departmentCode: r.departmentCode,
    category: r.category ?? "",
    hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
    notes: r.notes ?? "",
  };
}

function genId(): string {
  return `whe-${crypto.randomUUID().slice(0, 8)}`;
}

function genAttId(): string {
  return `att-${crypto.randomUUID().slice(0, 8)}`;
}

// Resolve (workerId, date) → attendance_records.id, auto-creating a PRESENT
// row if none exists. The flat Working Hours grid lets supervisors enter
// hours rows without first clocking the worker in — this helper makes that
// work transparently. Returns null if the worker doesn't exist.
async function resolveOrCreateAttendance(
  c: Context<Env>,
  workerId: string,
  date: string,
): Promise<{ id: string; employeeId: string; date: string } | null> {
  const existing = await c.var.DB
    .prepare("SELECT id, employeeId, date FROM attendance_records WHERE employeeId = ? AND date = ?")
    .bind(workerId, date)
    .first<{ id: string; employeeId: string; date: string }>();
  if (existing) return existing;

  const worker = await c.var.DB
    .prepare(
      "SELECT w.id, w.name, w.departmentCode, d.shortName as deptShortName FROM workers w LEFT JOIN departments d ON d.id = w.departmentId WHERE w.id = ?",
    )
    .bind(workerId)
    .first<{ id: string; name: string; departmentCode: string | null; deptShortName: string | null }>();
  if (!worker) return null;

  const id = genAttId();
  await c.var.DB
    .prepare(
      `INSERT INTO attendance_records (
         id, employeeId, employeeName, departmentCode, departmentName,
         date, clockIn, clockOut, status, workingMinutes, productionTimeMinutes,
         efficiencyPct, overtimeMinutes, deptBreakdown, notes
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'PRESENT', 0, 0, 0, 0, '[]', '')`,
    )
    .bind(
      id,
      worker.id,
      worker.name,
      worker.departmentCode ?? "",
      worker.deptShortName ?? "",
      date,
    )
    .run();
  return { id, employeeId: worker.id, date };
}

type EntryInput = {
  departmentCode?: unknown;
  category?: unknown;
  hours?: unknown;
  notes?: unknown;
};

function validateEntry(input: EntryInput): { ok: true; data: { departmentCode: string; category: string; hours: number; notes: string } } | { ok: false; error: string } {
  const departmentCode = typeof input.departmentCode === "string" ? input.departmentCode.trim() : "";
  if (!departmentCode) return { ok: false, error: "departmentCode required" };

  const rawCategory = typeof input.category === "string" ? input.category.trim().toUpperCase() : "";
  const isProduction = PRODUCTION_DEPTS.has(departmentCode);
  if (isProduction) {
    if (!rawCategory) return { ok: false, error: `category required for production dept ${departmentCode}` };
    if (!VALID_CATEGORIES.has(rawCategory))
      return { ok: false, error: `invalid category "${rawCategory}" — must be SOFA, BEDFRAME, or ACCESSORY` };
  } else if (rawCategory) {
    return { ok: false, error: `category not allowed for non-production dept ${departmentCode}` };
  }

  const hoursNum = typeof input.hours === "number" ? input.hours : Number(input.hours);
  if (!Number.isFinite(hoursNum) || hoursNum < 0) return { ok: false, error: "hours must be a non-negative number" };

  const notes = typeof input.notes === "string" ? input.notes : "";
  return { ok: true, data: { departmentCode, category: isProduction ? rawCategory : "", hours: hoursNum, notes } };
}

// ---------------------------------------------------------------------------
// GET — three query modes (attendanceId | date | workerId+from+to)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const attendanceId = c.req.query("attendanceId");
  const date = c.req.query("date");
  const workerId = c.req.query("workerId");
  const from = c.req.query("from");
  const to = c.req.query("to");

  let stmt;
  if (attendanceId) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE attendanceId = ? ORDER BY departmentCode, category",
    ).bind(attendanceId);
  } else if (workerId && from && to) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE workerId = ? AND date >= ? AND date <= ? ORDER BY date, departmentCode",
    ).bind(workerId, from, to);
  } else if (date) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE date = ? ORDER BY workerId, departmentCode",
    ).bind(date);
  } else if (from && to) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE date >= ? AND date <= ? ORDER BY date, workerId, departmentCode",
    ).bind(from, to);
  } else {
    return c.json({ success: false, error: "Provide attendanceId, date, or (from + to [+ workerId])" }, 400);
  }

  const res = await stmt.all<EntryRow>();
  const data = (res.results ?? []).map(rowToEntry);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST / — create one entry
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  let body: { attendanceId?: unknown; workerId?: unknown; date?: unknown } & EntryInput;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  // Two ways to attribute an entry to its parent attendance row:
  //   - explicit attendanceId (legacy / direct), OR
  //   - workerId + date — server auto-resolves to the existing attendance
  //     row, or auto-creates a PRESENT row if the worker hasn't been
  //     clocked-in yet for that date. This is the path used by the new
  //     flat Working Hours grid: supervisors enter (worker × dept × cat ×
  //     hours) directly without first opening an attendance row.
  let att: { id: string; employeeId: string; date: string } | null = null;
  const explicitAttId = typeof body.attendanceId === "string" ? body.attendanceId : "";
  if (explicitAttId) {
    att = await c.var.DB
      .prepare("SELECT id, employeeId, date FROM attendance_records WHERE id = ?")
      .bind(explicitAttId)
      .first<{ id: string; employeeId: string; date: string }>();
    if (!att) return c.json({ success: false, error: "Attendance record not found" }, 400);
  } else {
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const date = typeof body.date === "string" ? body.date : "";
    if (!workerId || !date) {
      return c.json({ success: false, error: "Provide attendanceId, or workerId + date" }, 400);
    }
    att = await resolveOrCreateAttendance(c, workerId, date);
    if (!att) return c.json({ success: false, error: "Worker not found" }, 400);
  }

  const v = validateEntry(body);
  if (!v.ok) return c.json({ success: false, error: v.error }, 400);

  const id = genId();
  await c.var.DB.prepare(
    `INSERT INTO working_hour_entries (id, attendanceId, workerId, date, departmentCode, category, hours, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      att.id,
      att.employeeId,
      att.date,
      v.data.departmentCode,
      v.data.category || null,
      v.data.hours,
      v.data.notes,
    )
    .run();

  const row = await c.var.DB.prepare("SELECT * FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  return c.json({ success: true, data: rowToEntry(row!) }, 201);
});

// ---------------------------------------------------------------------------
// POST /bulk — replace all entries for an attendance row in one transaction.
// Body: { attendanceId | (workerId + date), entries: [{ departmentCode, category, hours, notes }] }
// ---------------------------------------------------------------------------
app.post("/bulk", async (c) => {
  let body: { attendanceId?: unknown; workerId?: unknown; date?: unknown; entries?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  if (!Array.isArray(body.entries)) return c.json({ success: false, error: "entries must be an array" }, 400);

  let att: { id: string; employeeId: string; date: string } | null = null;
  const explicitAttId = typeof body.attendanceId === "string" ? body.attendanceId : "";
  if (explicitAttId) {
    att = await c.var.DB
      .prepare("SELECT id, employeeId, date FROM attendance_records WHERE id = ?")
      .bind(explicitAttId)
      .first<{ id: string; employeeId: string; date: string }>();
    if (!att) return c.json({ success: false, error: "Attendance record not found" }, 400);
  } else {
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const date = typeof body.date === "string" ? body.date : "";
    if (!workerId || !date) {
      return c.json({ success: false, error: "Provide attendanceId, or workerId + date" }, 400);
    }
    att = await resolveOrCreateAttendance(c, workerId, date);
    if (!att) return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // Validate every entry up-front so a single bad row aborts before any write.
  const validated: Array<{ departmentCode: string; category: string; hours: number; notes: string }> = [];
  for (let i = 0; i < body.entries.length; i++) {
    const v = validateEntry(body.entries[i] as EntryInput);
    if (!v.ok) return c.json({ success: false, error: `entries[${i}]: ${v.error}` }, 400);
    validated.push(v.data);
  }

  const stmts = [
    c.var.DB.prepare("DELETE FROM working_hour_entries WHERE attendanceId = ?").bind(att.id),
    ...validated.map((e) =>
      c.var.DB.prepare(
        `INSERT INTO working_hour_entries (id, attendanceId, workerId, date, departmentCode, category, hours, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        genId(),
        att.id,
        att.employeeId,
        att.date,
        e.departmentCode,
        e.category || null,
        e.hours,
        e.notes,
      ),
    ),
  ];
  await c.var.DB.batch(stmts);

  const res = await c.var.DB.prepare(
    "SELECT * FROM working_hour_entries WHERE attendanceId = ? ORDER BY departmentCode, category",
  )
    .bind(att.id)
    .all<EntryRow>();
  const data = (res.results ?? []).map(rowToEntry);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// PUT /:id — partial update of an entry (departmentCode / category / hours / notes)
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  let body: EntryInput;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  const existing = await c.var.DB.prepare(
    "SELECT * FROM working_hour_entries WHERE id = ?",
  )
    .bind(id)
    .first<EntryRow>();
  if (!existing) return c.json({ success: false, error: "Entry not found" }, 404);

  // Merge incoming fields onto the existing row, then re-validate the whole.
  const merged: EntryInput = {
    departmentCode: body.departmentCode ?? existing.departmentCode,
    category: body.category ?? existing.category ?? "",
    hours: body.hours ?? existing.hours,
    notes: body.notes ?? existing.notes ?? "",
  };
  const v = validateEntry(merged);
  if (!v.ok) return c.json({ success: false, error: v.error }, 400);

  await c.var.DB.prepare(
    `UPDATE working_hour_entries
       SET departmentCode = ?, category = ?, hours = ?, notes = ?,
           updatedAt = datetime('now')
     WHERE id = ?`,
  )
    .bind(v.data.departmentCode, v.data.category || null, v.data.hours, v.data.notes, id)
    .run();

  const row = await c.var.DB.prepare("SELECT * FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  return c.json({ success: true, data: rowToEntry(row!) });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT id FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Entry not found" }, 404);
  await c.var.DB.prepare("DELETE FROM working_hour_entries WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: { id } });
});

export default app;
