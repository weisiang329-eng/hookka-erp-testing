// ---------------------------------------------------------------------------
// Auto attendance deduction — turn a worker's punch (clock in/out) into a
// payroll dock automatically, applying the SAME shift rules the office uses
// (08:00–18:00, 1h unpaid lunch = 9 payable hours, 10-min late grace, OT only
// past 18:00 beyond 15 min). Replaces the owner having to open the Labor Cost
// "Under-recorded hours" review and click Deduct for every late / short day.
//
// This MOVES REAL MONEY, so it is heavily guarded — the goal is "never wrongly
// dock", accepting "sometimes under-dock and let the owner top up manually":
//   1. NO clock-out → never dock. A forgotten clock-out must not be read as a
//      short day and cost the worker a full day's pay.
//   2. Already-finalised month (any payslip APPROVED / PAID) → never touch it.
//      Mirrors the regenerate guard in payslips.ts; an approved payslip is
//      inviolate.
//   3. A manual (owner-created) dock on that day → never override it. The
//      owner's decision always wins; auto only ever manages its own AUTO rows.
//   4. Shortfall below a few minutes → no dock (rounding / within-grace noise).
//
// The dock is stored in payroll_hour_deductions exactly like a manual one (one
// row per worker-day, valued downstream at the ÷working-days hourly rate), but
// tagged source = 'AUTO' so the review screen can label it and the owner can
// Undo any wrong one — and so this code never fights a manual dock. Auto docks
// only ever land on a DRAFT (not-yet-approved) month, so the owner reviews the
// live estimate and can reverse before finalising.
// ---------------------------------------------------------------------------
import {
  computeAttendanceDay,
  hhmmToMinutes,
  HOOKKA_ATTENDANCE,
  type AttendanceRules,
} from "../../lib/attendance-rules";
import { resolvePayRulesAsOf, toAttendanceRules } from "../../lib/pay-rules";
import { loadPayRuleVersions } from "./pay-rules-store";

// D1-compat shape (the SupabaseAdapter installed as c.var.DB). Declared locally
// so this stays pure + unit-testable with a mock DB.
interface BoundStatement {
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}
interface Statement {
  bind(...args: unknown[]): BoundStatement;
  run(): Promise<unknown>;
}
export interface DeductDbLike {
  prepare(sql: string): Statement;
  batch(stmts: unknown[]): Promise<unknown>;
}

export const AUTO_DOCK_SOURCE = "AUTO";
export const MANUAL_DOCK_SOURCE = "MANUAL";

// Below this many hours we don't dock — a couple of minutes is rounding noise,
// and the 10-min late grace is already inside computeAttendanceDay (a worker
// within grace produces zero shortfall and never reaches here).
const MIN_DOCK_HOURS = 0.05; // 3 minutes

// Runtime "migration" for the source column (the ensurePendingMigrations
// pattern). Additive + IF NOT EXISTS + DEFAULT 'MANUAL' so every existing dock
// is back-tagged MANUAL and a re-run is a no-op. Module-level promise cache so
// it runs at most once per isolate. Mirrors migrations-postgres/0155.
let _sourceColMig: Promise<void> | null = null;
export function ensureDeductionSourceColumn(db: DeductDbLike): Promise<void> {
  if (_sourceColMig) return _sourceColMig;
  _sourceColMig = (async () => {
    await db
      .prepare(
        "ALTER TABLE payroll_hour_deductions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL'",
      )
      .run();
  })();
  return _sourceColMig;
}

/** For tests only — reset the module-level migration cache between cases. */
export function _resetDeductionSourceMigForTests(): void {
  _sourceColMig = null;
}

export type PunchShortfall = {
  /** Both times parsed and clock-out is after clock-in. */
  valid: boolean;
  /** A clock-out time was supplied (false ⇒ never dock). */
  hasClockOut: boolean;
  /** Hours short of the standard 9h day (≥ 0), rounded to 2dp. */
  shortfallHours: number;
  /** Minutes late past the grace window (display only). */
  lateMin: number;
  /** Overtime minutes past 18:00 (display only; OT is separate, adds pay). */
  otMin: number;
};

/**
 * Shortfall hours implied by one day's clock in/out, via the shared attendance
 * rules. The shortfall already FOLDS IN lateness beyond grace (a late clock-in
 * shrinks regular work, growing the shortfall) AND leaving early, so it is the
 * single "hours not worked below a full day" figure — never add lateMin on top
 * or you double-count. Pure.
 */
export function computePunchShortfallHours(
  clockIn: string | null | undefined,
  clockOut: string | null | undefined,
  rules: AttendanceRules = HOOKKA_ATTENDANCE,
): PunchShortfall {
  const inMin = hhmmToMinutes(clockIn ?? null);
  const outMin = hhmmToMinutes(clockOut ?? null);
  const hasClockOut = outMin !== null;
  if (inMin === null || outMin === null || outMin <= inMin) {
    return { valid: false, hasClockOut, shortfallHours: 0, lateMin: 0, otMin: 0 };
  }
  const day = computeAttendanceDay(inMin, outMin, rules);
  const shortfallHours = Math.round((day.shortfallMin / 60) * 100) / 100;
  return { valid: true, hasClockOut: true, shortfallHours, lateMin: day.lateMin, otMin: day.otMin };
}

/**
 * The under-logged ("To-fill") shortfall for ONE working day, in hours:
 * expected − logged, when the worker logged SOME hours but fewer than a full
 * day. Owner 2026-07-04 (FULL auto): these days now auto-dock the shortfall
 * instead of waiting for a manual Keep-pay/Deduct pick.
 *
 * A day with ZERO logged hours is NOT under-logged — it is an ABSENCE, already
 * settled by the monthly salary deduction (÷working-days). Returning 0 here
 * leaves those alone. Rounded to 2 dp; never negative. Pure.
 */
export function computeUnderLoggedShortfallHours(
  loggedHours: number,
  expectedHours: number,
): number {
  const logged = Number(loggedHours) || 0;
  const expected = Number(expectedHours) || 0;
  if (logged <= 0 || expected <= 0) return 0; // absent / no expectation → not under-logged
  const short = expected - logged;
  if (short <= 0) return 0; // full day (or over) → nothing to dock
  return Math.round(short * 100) / 100;
}

export type AutoDockReason =
  | "applied"
  | "no-clockout"
  | "invalid-times"
  | "no-shortfall"
  | "period-locked"
  | "manual-exists";

export type AutoDockResult = {
  applied: boolean;
  reason: AutoDockReason;
  hours?: number;
};

/**
 * Compute and (if all guards pass) upsert an AUTO short-hour dock for one
 * worker-day from their punch. Returns what it did + why. Safe to call on every
 * clock-out: idempotent (re-punch overwrites the same AUTO row), and every
 * not-applied path is the SAFE direction (no dock). The caller should still
 * wrap this best-effort so a DB hiccup never fails the punch itself.
 */
export async function maybeApplyAutoPunchDock(
  db: DeductDbLike,
  input: {
    workerId: string;
    date: string; // YYYY-MM-DD (Malaysia local)
    clockIn?: string | null; // HH:MM
    clockOut?: string | null; // HH:MM
  },
): Promise<AutoDockResult> {
  const { workerId, date } = input;
  // Effective-dated rules: the shift/grace/blocks in force ON the punch date.
  // Best-effort — any load failure falls back to the built-in defaults so a
  // config hiccup can never block or mis-dock a punch.
  let rules: AttendanceRules = HOOKKA_ATTENDANCE;
  try {
    const versions = await loadPayRuleVersions(db as unknown as D1Database);
    rules = toAttendanceRules(resolvePayRulesAsOf(versions, date));
  } catch {
    rules = HOOKKA_ATTENDANCE;
  }

  // BUG-2026-07-17-006 — a full day is THIS worker's day, not everyone's.
  // `rules.standardWorkMin` is a GLOBAL 9h. Workers can be contracted for
  // fewer: ANN (EMP-004) is workingHoursPerDay = 7.5. The PAY side already
  // honours it (payslips.ts: hourlyRate = payrollDailyRateSen /
  // worker.workingHoursPerDay → RM2650/(26×7.5) = RM13.59/hr) and so does the
  // settle-period To-fill path (payroll-hour-deductions.ts:270,
  // `h > 0 ? h : 9`) — but THIS punch path did not, so every full 7.5h day she
  // worked was scored 9 − 7.5 = "1.5h short" and auto-docked. On the July
  // payslip that is a 1.5h dock on EVERY working day (−RM233.58 over 13 days)
  // for a worker who was never short at all (owner: 「我記得ann是工作少1.5小時
  // 的」「沒有跟?」).
  //
  // Only standardWorkMin is overridden: otMin is derived from clock-out past
  // `rules.endMin`, so OT thresholds are untouched by this.
  // Best-effort, same posture as the rules load — a lookup failure keeps the
  // global default rather than blocking the punch.
  try {
    const w = await db
      .prepare("SELECT workingHoursPerDay FROM workers WHERE id = ?")
      .bind(workerId)
      .first<{ workingHoursPerDay: number | null }>();
    const h = Number(w?.workingHoursPerDay) || 0;
    if (h > 0 && Math.round(h * 60) !== rules.standardWorkMin) {
      rules = { ...rules, standardWorkMin: Math.round(h * 60) };
    }
  } catch {
    /* keep the global default */
  }

  const sf = computePunchShortfallHours(input.clockIn, input.clockOut, rules);

  // Guard 1: a clock-out is REQUIRED. No clock-out → never dock a full day on a
  // guess. (Checked first, before any DB work.)
  if (!sf.hasClockOut) return { applied: false, reason: "no-clockout" };
  if (!sf.valid) return { applied: false, reason: "invalid-times" };

  const noteParts = [`Auto: short ${sf.shortfallHours}h`];
  if (sf.lateMin > 0) noteParts.push(`late ${sf.lateMin}m`);
  return maybeApplyAutoDayDock(db, {
    workerId,
    date,
    shortfallHours: sf.shortfallHours,
    note: `${noteParts.join(", ")} (from punch)`,
  });
}

/**
 * The shared guard-and-apply core: given a PRE-COMPUTED shortfall for one
 * worker-day, upsert (or clear) its AUTO dock. Used by BOTH the punch path
 * (maybeApplyAutoPunchDock, shortfall from clock in/out) and the under-logged
 * path (owner 2026-07-04 FULL auto: shortfall = expected − logged working
 * hours). The guards are identical either way — a MANUAL dock is never
 * overridden, a finalised month is never touched, a below-noise shortfall
 * writes nothing (and clears any stale AUTO row). Idempotent per (worker, date).
 */
export async function maybeApplyAutoDayDock(
  db: DeductDbLike,
  input: {
    workerId: string;
    date: string; // YYYY-MM-DD
    shortfallHours: number;
    note: string;
  },
): Promise<AutoDockResult> {
  const { workerId, date, note } = input;
  const shortfallHours = Math.round((Number(input.shortfallHours) || 0) * 100) / 100;

  await ensureDeductionSourceColumn(db);

  // Any existing dock for this (worker, date)?
  const existing = await db
    .prepare(
      "SELECT id, source FROM payroll_hour_deductions WHERE workerId = ? AND date = ?",
    )
    .bind(workerId, date)
    .first<{ id: string; source: string | null }>();

  // Guard: NEVER override an owner's manual decision (Deduct or any non-AUTO).
  // This is how historical MANUAL Keep-pay / Deduct picks survive a re-settle.
  if (existing && (existing.source ?? MANUAL_DOCK_SOURCE) === MANUAL_DOCK_SOURCE) {
    return { applied: false, reason: "manual-exists" };
  }

  // Guard: never touch a finalised month (any payslip APPROVED / PAID).
  const period = date.slice(0, 7);
  const locked = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM payslips WHERE period = ? AND status != 'DRAFT'",
    )
    .bind(period)
    .first<{ c: number | string }>();
  if (Number(locked?.c ?? 0) > 0) return { applied: false, reason: "period-locked" };

  // Guard: no real shortfall → no dock. If a stale AUTO dock exists (e.g. the
  // punch/hours were corrected to a full day), clear it so it stops reducing pay.
  if (shortfallHours < MIN_DOCK_HOURS) {
    if (existing) {
      await db
        .prepare("DELETE FROM payroll_hour_deductions WHERE id = ?")
        .bind(existing.id)
        .run();
    }
    return { applied: false, reason: "no-shortfall" };
  }

  // Apply. DELETE+INSERT in one batch (overwrite). We only reach here when the
  // existing row is AUTO or absent — a manual dock was already returned above —
  // so this never clobbers an owner decision.
  const id = `phd-${crypto.randomUUID().slice(0, 8)}`;
  await db.batch([
    db
      .prepare("DELETE FROM payroll_hour_deductions WHERE workerId = ? AND date = ?")
      .bind(workerId, date),
    db
      .prepare(
        "INSERT INTO payroll_hour_deductions (id, workerId, date, hours, note, source) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, workerId, date, shortfallHours, note, AUTO_DOCK_SOURCE),
  ]);
  return { applied: true, reason: "applied", hours: shortfallHours };
}
