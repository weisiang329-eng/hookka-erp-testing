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
import {
  ensureDeductionSourceColumn,
  maybeApplyAutoPunchDock,
  MANUAL_DOCK_SOURCE,
} from "../lib/attendance-deduct";

const app = new Hono<Env>();

type DeductionRow = {
  id: string;
  workerId: string;
  date: string;
  hours: number | string;
  note: string | null;
  source: string | null;
};

function rowToDeduction(r: DeductionRow) {
  return {
    id: r.id,
    workerId: r.workerId,
    date: r.date,
    hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
    note: r.note ?? "",
    // 'MANUAL' (owner, from the under-recorded review) vs 'AUTO' (from a punch).
    // Older rows predate the column → treated as MANUAL.
    source: r.source ?? MANUAL_DOCK_SOURCE,
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
  await ensureDeductionSourceColumn(c.var.DB);
  const period = c.req.query("period");
  const stmt = period
    ? c.var.DB.prepare(
        "SELECT id, workerId, date, hours, note, source FROM payroll_hour_deductions WHERE date LIKE ? ORDER BY date, workerId",
      ).bind(`${period}-%`)
    : c.var.DB.prepare(
        "SELECT id, workerId, date, hours, note, source FROM payroll_hour_deductions ORDER BY date DESC, workerId",
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

  await ensureDeductionSourceColumn(c.var.DB);

  // Upsert: delete any existing dock for this (worker, date) then insert, so a
  // re-dock overwrites rather than stacking. One transactional batch. Tagged
  // MANUAL — this is the owner deciding; the punch auto-dock will then never
  // override it (see attendance-deduct.ts guard 2).
  const id = genId();
  await c.var.DB.batch([
    c.var.DB
      .prepare("DELETE FROM payroll_hour_deductions WHERE workerId = ? AND date = ?")
      .bind(workerId, date),
    c.var.DB
      .prepare(
        "INSERT INTO payroll_hour_deductions (id, workerId, date, hours, note, source) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, workerId, date, hoursNum, note || null, MANUAL_DOCK_SOURCE),
  ]);
  const row = await c.var.DB.prepare(
    "SELECT id, workerId, date, hours, note, source FROM payroll_hour_deductions WHERE id = ?",
  )
    .bind(id)
    .first<DeductionRow>();
  return c.json({ success: true, data: rowToDeduction(row!) }, 201);
});

// ---------------------------------------------------------------------------
// POST /auto-from-punch  — office-keyed punch → auto short-hour dock.
// Body: { workerId, date, clockIn, clockOut }  (clock times "HH:MM")
//
// When the office keys a worker's clock in/out in the Working Hours grid, this
// applies the SAME guarded rule the worker phone punch uses: late past the
// 10-min grace and/or short of a 9-hour day → dock the shortfall, tagged AUTO.
// Heavily guarded inside the helper (no clock-out → skip, finalised month →
// skip, never overrides a manual dock). Idempotent per (worker, date) and
// always safe to re-call — returns what it did + why.
// ---------------------------------------------------------------------------
app.post("/auto-from-punch", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  let body: {
    workerId?: unknown;
    date?: unknown;
    clockIn?: unknown;
    clockOut?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const clockIn = typeof body.clockIn === "string" ? body.clockIn : null;
  const clockOut = typeof body.clockOut === "string" ? body.clockOut : null;
  if (!workerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json(
      { success: false, error: "workerId and date (YYYY-MM-DD) are required" },
      400,
    );
  }
  const result = await maybeApplyAutoPunchDock(c.var.DB, {
    workerId,
    date,
    clockIn,
    clockOut,
  });
  return c.json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// POST /settle-period  — AUTO-settle a whole month from real punches.
// Body: { period: "YYYY-MM" }
//
// Owner 2026-07-04: the manual Keep-pay/Deduct backlog is retired — every day
// with a real punch settles from the shift algorithm, no human pick. Live
// punch-out already settles each day (worker.ts → maybeApplyAutoPunchDock); this
// endpoint replays that over EVERY punch in a period so a month of existing
// punches (or punches keyed before this feature) all settle at once. It is a
// thin batch loop over the SAME per-day helper — identical guards apply per day
// (no clock-out → skip; finalised month → skip; a MANUAL dock is never
// overridden; full day → clears any stale AUTO row). Idempotent: re-running
// recomputes the same AUTO docks. Returns per-reason counts so the caller (and
// the month-recompute script) can eyeball what changed. Does NOT regenerate
// payslips — the caller regenerates once after, exactly like a single Deduct.
// ---------------------------------------------------------------------------
app.post("/settle-period", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  let body: { period?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const period = typeof body.period === "string" ? body.period.trim() : "";
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return c.json(
      { success: false, error: "period (YYYY-MM) is required" },
      400,
    );
  }
  await ensureDeductionSourceColumn(c.var.DB);
  // Pull the month's punches (both times present is enforced per-day inside the
  // helper; we still fetch clock-in-only rows so the tally reflects them).
  const res = await c.var.DB.prepare(
    "SELECT employeeId, date, clockIn, clockOut FROM attendance_records WHERE date LIKE ? ORDER BY date, employeeId",
  )
    .bind(`${period}-%`)
    .all<{ employeeId: string; date: string; clockIn: string | null; clockOut: string | null }>();
  const punches = res.results ?? [];

  const tally: Record<string, number> = {
    applied: 0,
    "no-clockout": 0,
    "invalid-times": 0,
    "no-shortfall": 0,
    "period-locked": 0,
    "manual-exists": 0,
  };
  let dockedHours = 0;
  for (const p of punches) {
    if (!p.employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date ?? ""))) continue;
    const r = await maybeApplyAutoPunchDock(c.var.DB, {
      workerId: p.employeeId,
      date: p.date,
      clockIn: p.clockIn,
      clockOut: p.clockOut,
    });
    tally[r.reason] = (tally[r.reason] ?? 0) + 1;
    if (r.applied) dockedHours += r.hours ?? 0;
  }
  return c.json({
    success: true,
    data: {
      period,
      punches: punches.length,
      ...tally,
      dockedHours: Math.round(dockedHours * 100) / 100,
    },
  });
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
