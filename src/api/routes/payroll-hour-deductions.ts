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
  maybeApplyAutoDayDock,
  computePunchShortfallHours,
  computeUnderLoggedShortfallHours,
  rulesForWorkerHours,
  MANUAL_DOCK_SOURCE,
} from "../lib/attendance-deduct";
import { resolvePayRulesAsOf, toAttendanceRules } from "../../lib/pay-rules";
import { loadPayRuleVersions } from "../lib/pay-rules-store";

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
// POST /settle-period  — FULL AUTO settle a whole month (owner 2026-07-04, A).
// Body: { period: "YYYY-MM" }
//
// The manual Keep-pay/Deduct backlog is RETIRED — every under-settled day now
// auto-docks its shortfall; nothing waits for a human. For each factory worker,
// each working day (Mon–Sat minus public holidays) in the month, the shortfall
// is the LARGER of:
//   • the PUNCH shortfall (from clock in/out via the shift algorithm — late past
//     grace, short of a full day; a day with only a clock-in / no clock-out
//     yields no punch shortfall), and
//   • the UNDER-LOGGED ("To-fill") shortfall = expected − logged working hours,
//     when the worker logged SOME hours but fewer than a full day.
// A day with ZERO logged AND no complete punch is an ABSENCE — left to the
// monthly salary deduction, never docked here. The larger of the two evidences
// wins so neither a short punch nor an under-logged grid entry is missed, and
// they never double-dock (one AUTO row per worker-day).
//
// Guards (per day, inside maybeApplyAutoDayDock): a MANUAL dock is never
// overridden (historical Keep-pay/Deduct picks survive); a finalised month is
// never touched; a full/over day clears any stale AUTO row. Idempotent — a
// re-run recomputes the same AUTO docks. Does NOT regenerate payslips; the
// caller regenerates once after, exactly like a single dock.
//
// Owner ACCEPTED the weak-wifi risk: a worker who worked a full day but whose
// punch-out failed AND whose office grid logs fewer hours will be auto-docked.
// His explicit call — the office fixes it by keying the real hours (which
// clears the AUTO dock on the next settle) or entering a MANUAL Keep-pay row.
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

  const [yearS, monthS] = period.split("-");
  const year = Number(yearS);
  const month = Number(monthS); // 1-indexed

  // Public holidays — same kv_config source the engine reads. A holiday is never
  // a working day, so it never docks.
  const phRow = await c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const holidays = new Set<string>();
  if (phRow?.value) {
    try {
      const parsed = JSON.parse(phRow.value);
      if (Array.isArray(parsed))
        for (const d of parsed)
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) holidays.add(d);
    } catch { /* malformed — no holidays */ }
  }

  // The month's working days (Mon–Sat, excluding Sundays and public holidays).
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  const workingDays: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow === 0) continue; // Sunday — non-working
    const iso = `${year}-${mm}-${String(d).padStart(2, "0")}`;
    if (holidays.has(iso)) continue; // public holiday
    workingDays.push(iso);
  }

  // Factory workers + their standard daily hours (the To-fill expectation). Only
  // ACTIVE / RESIGNED-in-month people; office / sales / admin never log factory
  // hours so they never appear in the To-fill gap.
  const workersRes = await c.var.DB.prepare(
    "SELECT id, workingHoursPerDay FROM workers WHERE status = 'ACTIVE' OR (status = 'RESIGNED' AND resignedAt LIKE ?)",
  )
    .bind(`${period}-%`)
    .all<{ id: string; workingHoursPerDay: number | null }>();
  // RAW contracted hours (0 = unset). Kept raw rather than pre-defaulted because
  // the two consumers below want different fallbacks: the To-fill expectation
  // defaults to 9h (matches the UI), while the punch rules fall back to whatever
  // the effective-dated pay rules say — pre-defaulting to 9 here would let this
  // map silently override a changed global shift. See BUG-2026-07-17-006.
  const hoursByWorker = new Map<string, number>();
  for (const w of workersRes.results ?? []) {
    hoursByWorker.set(w.id, Number(w.workingHoursPerDay) || 0);
  }

  // The month's punches, keyed per (worker|date). A row with both times present
  // feeds the shift algorithm; clock-in-only rows are ignored (no clock-out →
  // no punch shortfall), mirroring the live-punch guard.
  const punchRes = await c.var.DB.prepare(
    "SELECT employeeId, date, clockIn, clockOut FROM attendance_records WHERE date LIKE ?",
  )
    .bind(`${period}-%`)
    .all<{ employeeId: string; date: string; clockIn: string | null; clockOut: string | null }>();
  const punchByKey = new Map<string, { clockIn: string | null; clockOut: string | null }>();
  for (const p of punchRes.results ?? []) {
    if (!p.employeeId || !p.date) continue;
    punchByKey.set(`${p.employeeId}|${p.date}`, { clockIn: p.clockIn, clockOut: p.clockOut });
  }

  // The month's LOGGED working hours, summed per (worker|date). This is the
  // To-fill evidence: expected − logged on a partial day.
  const heRes = await c.var.DB.prepare(
    "SELECT workerId, date, hours FROM working_hour_entries WHERE date LIKE ?",
  )
    .bind(`${period}-%`)
    .all<{ workerId: string; date: string; hours: number | string }>();
  const loggedByKey = new Map<string, number>();
  for (const e of heRes.results ?? []) {
    if (!e.workerId || !e.date) continue;
    const k = `${e.workerId}|${e.date}`;
    loggedByKey.set(k, (loggedByKey.get(k) ?? 0) + (Number(e.hours) || 0));
  }

  // Effective-dated rules for the punch shortfall (resolved per date).
  let versions: Awaited<ReturnType<typeof loadPayRuleVersions>> = [];
  try {
    versions = await loadPayRuleVersions(c.var.DB);
  } catch {
    versions = [];
  }

  const tally: Record<string, number> = {
    applied: 0,
    "no-shortfall": 0,
    "period-locked": 0,
    "manual-exists": 0,
    "punch-source": 0,
    "logged-source": 0,
  };
  let dockedHours = 0;
  let periodLockedHit = false;

  for (const [workerId, contractedHours] of hoursByWorker) {
    const expected = contractedHours > 0 ? contractedHours : 9; // To-fill default
    for (const date of workingDays) {
      const key = `${workerId}|${date}`;
      const punch = punchByKey.get(key);
      const logged = loggedByKey.get(key);
      // Nothing recorded at all → absence (salary-deduction territory). Skip.
      const hasPunch = !!(punch && punch.clockIn && punch.clockOut);
      const hasLogged = (logged ?? 0) > 0;
      // ZERO logged hours = the payroll engine already counts this day as an
      // ABSENCE and docks the full ÷26 day rate. An hour dock on top would
      // charge the same day twice — and the absence is always the bigger of the
      // two, so skipping can never under-charge. (Was: skip only when there is
      // ALSO no punch, which let a short/broken punch stack a second deduction
      // onto an absent day.)
      if (!hasLogged) continue;

      // Punch shortfall (shift algorithm) — 0 unless a complete punch is short.
      // Scored against THIS worker's contracted day, not the factory-wide 9h:
      // ANN's full 7.5h day read as "1.5h short" every day until this landed
      // (BUG-2026-07-17-006). This is the path that builds the month.
      let punchShort = 0;
      if (hasPunch) {
        const rules = rulesForWorkerHours(
          toAttendanceRules(resolvePayRulesAsOf(versions, date)),
          contractedHours,
        );
        punchShort = computePunchShortfallHours(punch!.clockIn, punch!.clockOut, rules).shortfallHours;
      }
      // Under-logged shortfall — expected − logged on a partial day.
      const loggedShort = hasLogged
        ? computeUnderLoggedShortfallHours(logged ?? 0, expected)
        : 0;

      // A day with ZERO logged hours is an ABSENCE — already charged in full by
      // the engine — and must never also carry an hour dock. That rule is NOT
      // enforced here: it lives in maybeApplyAutoDayDock (reason "absent-day")
      // so the live punch path and the office re-apply endpoint are covered by
      // the same guard. See BUG-2026-08-01-002.
      const shortfall = Math.max(punchShort, loggedShort);
      const source = punchShort >= loggedShort ? "from punch" : "from unlogged hours";
      const r = await maybeApplyAutoDayDock(c.var.DB, {
        workerId,
        date,
        shortfallHours: shortfall,
        note:
          shortfall > 0
            ? `Auto: short ${Math.round(shortfall * 100) / 100}h (${source})`
            : "Auto: full day",
      });
      tally[r.reason] = (tally[r.reason] ?? 0) + 1;
      if (r.applied) {
        dockedHours += r.hours ?? 0;
        tally[source === "from punch" ? "punch-source" : "logged-source"] += 1;
      }
      if (r.reason === "period-locked") periodLockedHit = true;
    }
    // A finalised month short-circuits everything — stop scanning once we know.
    if (periodLockedHit) break;
  }

  return c.json({
    success: true,
    data: {
      period,
      workers: hoursByWorker.size,
      workingDays: workingDays.length,
      ...tally,
      dockedHours: Math.round(dockedHours * 100) / 100,
      periodLocked: periodLockedHit,
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
