// ---------------------------------------------------------------------------
// payroll_hour_deductions route.
//
//   GET    /api/payroll-hour-deductions?period=YYYY-MM   — list docks in a month
//   POST   /api/payroll-hour-deductions                   — upsert one dock
//   DELETE /api/payroll-hour-deductions/:id               — remove one dock
//
// A "dock" is hours the owner removes from a worker's pay for a specific day,
// set from the Labor Cost "Under-recorded hours" review: the worker came but
// logged fewer hours than a full day and that short time is NOT to be paid
// (it was neither a data-entry miss to backfill nor idle-but-paid standby).
// One row per (workerId, date) — re-docking the same day overwrites. Payroll
// generation reads these and subtracts hours x the worker's div-working-days
// hourly rate from basic earned (see payslips.ts + labor-engine.ts), so the
// worker's pay drops by exactly the value Labor Cost never credited and the
// under-recorded gap closes.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type DeductionRow = {
  id: string;
  workerId: string;
  date: string;
  hours: number | string;
  note: string | null;
};

function rowToDeduction(r: DeductionRow) {
  return {
    id: r.id,
    workerId: r.workerId,
    date: r.date,
    hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
    note: r.note ?? "",
  };
}

function genId(): string {
  return `phd-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// GET /?period=YYYY-MM  — list the period's docks (omit period → all)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  const period = c.req.query("period");
  const stmt = period
    ? c.var.DB.prepare(
        "SELECT id, workerId, date, hours, note FROM payroll_hour_deductions WHERE date LIKE ? ORDER BY date, workerId",
      ).bind(`${period}-%`)
    : c.var.DB.prepare(
        "SELECT id, workerId, date, hours, note FROM payroll_hour_deductions ORDER BY date DESC, workerId",
      );
  const res = await stmt.all<DeductionRow>();
  const data = (res.results ?? []).map(rowToDeduction);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /  — upsert one dock. Body: { workerId, date, hours, note? }
// One row per (workerId, date): re-docking the same day overwrites.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  let body: { workerId?: unknown; date?: unknown; hours?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const hoursNum = typeof body.hours === "number" ? body.hours : Number(body.hours);
  const note = typeof body.note === "string" ? body.note : "";
  if (!workerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json(
      { success: false, error: "workerId and date (YYYY-MM-DD) are required" },
      400,
    );
  }
  if (!Number.isFinite(hoursNum) || hoursNum <= 0) {
    return c.json({ success: false, error: "hours must be a positive number" }, 400);
  }
  // Worker must exist (guards against a stale id).
  const worker = await c.var.DB.prepare("SELECT id FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ id: string }>();
  if (!worker) return c.json({ success: false, error: "Worker not found" }, 400);

  // Upsert: delete any existing dock for this (worker, date) then insert, so a
  // re-dock overwrites rather than stacking. One transactional batch.
  const id = genId();
  await c.var.DB.batch([
    c.var.DB
      .prepare("DELETE FROM payroll_hour_deductions WHERE workerId = ? AND date = ?")
      .bind(workerId, date),
    c.var.DB
      .prepare(
        "INSERT INTO payroll_hour_deductions (id, workerId, date, hours, note) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, workerId, date, hoursNum, note || null),
  ]);
  const row = await c.var.DB.prepare(
    "SELECT id, workerId, date, hours, note FROM payroll_hour_deductions WHERE id = ?",
  )
    .bind(id)
    .first<DeductionRow>();
  return c.json({ success: true, data: rowToDeduction(row!) }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /:id  — remove one dock (undo)
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id FROM payroll_hour_deductions WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Not found" }, 404);
  await c.var.DB.prepare("DELETE FROM payroll_hour_deductions WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: { id } });
});

export default app;
