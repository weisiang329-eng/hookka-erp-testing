// ---------------------------------------------------------------------------
// Labor engine — the single source of truth for "what a worker's month
// costs and earns".
//
// ONE calculation, computed purely from the office-maintained Working Hours
// grid (working_hour_entries), drives THREE outputs:
//
//   1. Production labor cost   → written into cost_ledger
//   2. Payroll / payslips      → the admin Payroll screen
//   3. Worker phone pay view   → /worker/pay
//
// Before this module, OT was generated with Math.random() in the payslip /
// payroll routes, and the on-screen Labor Cost report hard-coded a 9-hour
// OT threshold for every worker. This engine replaces all of that with one
// consistent, per-worker formula.
//
// ── The two divisors (spec from Wei Siang, 2026-05-22) ─────────────────────
//
// A worker is paid a fixed monthly salary. Two different rates are derived
// from it, on purpose:
//
//   • PAYROLL — absence deduction AND all overtime — divide the salary by
//     the worker's nominal `workingDaysPerMonth` (26). This is the
//     contractual day/hour rate. A public holiday is NOT an absence, so a
//     no-show on a holiday is never deducted; the divisor stays 26.
//
//   • PRODUCTION-COST regular day rate — divide the salary by
//     (workingDaysPerMonth − public holidays that month). Public holidays
//     shrink the number of productive days, so the same monthly salary
//     spread over fewer days makes each day of output cost MORE
//     ("output 价变高"). Overtime inside production cost still uses the
//     ÷26 rate — OT cost equals OT pay exactly.
//
// Worked example — ANN: RM2,650/mo, 26 days, 8 h/day (span 8+1h lunch = ÷9),
// OT ×1.5; May 2026 has two weekday public holidays (1 + 27 May):
//   payroll day rate   = 265000 ÷ 26            ≈ RM101.92
//   OT hourly rate     = 265000 ÷ 26 ÷ 9 × 1.5  ≈ RM16.99
//   production day rate= 265000 ÷ 24            ≈ RM110.42
// Full attendance + 15 h OT → payroll gross = production cost = RM2,904.81.
// ---------------------------------------------------------------------------

import {
  resolvePayRulesAsOf,
  payrollDayRateSen,
  payrollHourDivisor,
  type PayRuleVersion,
  type PayRulesConfig,
} from "./pay-rules";
import { OT_MIN_MINUTES } from "./attendance-rules";

/** Monday(1)..Saturday(6) are working weekdays; Sunday(0) is off. */
const WORKING_DOW: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);

/** Fallbacks used only to avoid divide-by-zero on a half-set-up worker. */
const FALLBACK_WORKING_DAYS_PER_MONTH = 26;

// Hourly-rate divisor (÷10), Sunday 2× and public-holiday 3× now live in the
// EFFECTIVE-DATED pay rules (src/lib/pay-rules.ts DEFAULT_PAY_RULES, owner
// 2026-06-11) and are resolved per date inside computeMonthlyLabor. Day-typed
// OT semantics are unchanged: Sunday/holiday pay the premium on EVERY hour
// (holiday-on-Sunday counts as Sunday); weekday OT keeps the per-worker
// otMultiplier above the standard day.

/**
 * A worker's maintained Employee Master figures. Everything the engine
 * needs about the person; no DB types leak in here so this module stays
 * pure and unit-testable.
 */
export type LaborWorker = {
  /** Monthly basic salary, in sen. Ignored when payMode is DAILY. */
  basicSalarySen: number;
  /**
   * "MONTHLY" (default) or "DAILY".
   *
   * MONTHLY starts from the full salary and deducts days not worked. DAILY
   * starts from zero and pays days worked — the right model for an outsourced
   * person who may come five days in a month, where the monthly rule would
   * record 21 absences against a salary they were never on.
   */
  payMode?: string | null;
  /** Rate per day worked, in sen. Only read when payMode is DAILY. */
  dailyRateSen?: number | null;
  /** Nominal working days per month — the payroll divisor. Typically 26. */
  workingDaysPerMonth: number;
  /** Standard hours in a normal working day — the OT threshold. e.g. 8 or 9. */
  workingHoursPerDay: number;
  /** OT premium multiplier. 1.5 = OT paid at 1.5× the hourly rate. */
  otMultiplier: number;
};

/**
 * One Working Hours row: a worker logged `hours` on `date`. A worker can
 * have several rows for the same date (one per department / category) —
 * the engine sums them per date before doing anything.
 */
export type WorkerDayHours = {
  /** YYYY-MM-DD. */
  date: string;
  /** Decimal hours logged on that date for this row. */
  hours: number;
};

/**
 * Count declared public holidays that fall in `year`/`month` AND land on a
 * working weekday (Mon–Sat). A holiday on a Sunday is ignored — Sunday is
 * already a non-working day, so it doesn't shrink the productive month.
 * `month` is 1-indexed (1 = January).
 */
export function countPublicHolidaysInMonth(
  year: number,
  month: number,
  publicHolidays: Iterable<string>,
): number {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  let count = 0;
  for (const iso of publicHolidays) {
    if (typeof iso !== "string" || !iso.startsWith(prefix)) continue;
    const day = Number(iso.slice(8, 10));
    if (!Number.isInteger(day) || day < 1 || day > 31) continue;
    const dow = new Date(year, month - 1, day).getDay();
    if (WORKING_DOW.has(dow)) count++;
  }
  return count;
}

/**
 * Count working weekdays (Mon–Sat, minus declared public holidays) in
 * `year`/`month` from day 1 through `throughDay` inclusive.
 *
 * This sizes the absence count: a worker is "absent" on an elapsed working
 * weekday they logged no hours for. For a finished month pass the month's
 * last day; for the current month pass today's day-of-month so future days
 * aren't counted as absences yet. `month` is 1-indexed.
 */
export function countElapsedWorkingDays(
  year: number,
  month: number,
  throughDay: number,
  publicHolidays: Iterable<string>,
): number {
  const holidaySet =
    publicHolidays instanceof Set
      ? (publicHolidays as Set<string>)
      : new Set(publicHolidays);
  const lastDay = new Date(year, month, 0).getDate();
  const end = Math.min(Math.max(Math.floor(throughDay), 0), lastDay);
  const mm = String(month).padStart(2, "0");
  let count = 0;
  for (let d = 1; d <= end; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (!WORKING_DOW.has(dow)) continue; // Sunday — non-working
    const iso = `${year}-${mm}-${String(d).padStart(2, "0")}`;
    if (holidaySet.has(iso)) continue; // public holiday — not a workday
    count++;
  }
  return count;
}

/**
 * The day-of-month through which absences should be COUNTED for the given
 * period, after applying a data-entry grace.
 *
 * Spec from Wei Siang (2026-06-02): the office does not key Working Hours in
 * real time, so a recent working day with no hours is more likely "not entered
 * yet" than a true absence. An absence is only confirmed — and only then
 * docked — once the day is at least `graceWorkingDays` working days in the
 * past. Worked example he gave: a no-show on the 25th, with the 26th and 27th
 * still unrecorded, only starts being deducted on the 28th (grace = 2 working
 * days; Sundays and public holidays don't count toward the grace).
 *
 * Behaviour by period:
 *   - A finished (past) month: the whole month is well past the grace window,
 *     so the full month counts — returns the month's last day.
 *   - The current month: returns (today − graceWorkingDays working days)'s
 *     day-of-month, so the last couple of working days are held back as
 *     "maybe just unentered" and not yet charged.
 *   - A future month, or a month so early that the grace cutoff lands before
 *     it: returns 0 (nothing counted yet).
 *
 * `month` is 1-indexed. `today` is injected (not read from the clock) so the
 * function stays pure and testable. `graceWorkingDays = 0` reproduces the old
 * "count through today" behaviour exactly.
 */
export function absenceCutoffDay(
  year: number,
  month: number,
  today: Date,
  graceWorkingDays: number,
  publicHolidays: Iterable<string>,
): number {
  const holidaySet =
    publicHolidays instanceof Set
      ? (publicHolidays as Set<string>)
      : new Set(publicHolidays);
  const isHoliday = (d: Date): boolean => {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    return holidaySet.has(iso);
  };

  // Walk backwards from today by `graceWorkingDays` working days (Mon–Sat,
  // skipping public holidays). The day we land on is the confirmation cutoff.
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let remaining = Math.max(0, Math.floor(graceWorkingDays));
  while (remaining > 0) {
    cutoff.setDate(cutoff.getDate() - 1);
    if (WORKING_DOW.has(cutoff.getDay()) && !isHoliday(cutoff)) remaining--;
  }

  const monthLastDay = new Date(year, month, 0).getDate();
  const cutoffYM = cutoff.getFullYear() * 12 + cutoff.getMonth(); // 0-indexed month
  const periodYM = year * 12 + (month - 1);

  if (periodYM < cutoffYM) return monthLastDay; // finished month — count it all
  if (periodYM > cutoffYM) return 0; // cutoff hasn't reached this month yet
  return cutoff.getDate(); // current/cutoff month — count through the cutoff day
}

/**
 * A day's logged hours, cleaned to the 2 dp they are actually recorded in.
 *
 * Hours reach the engine as a SUM of per-department rows, and those rows come
 * out of `prorateHours`' cent arithmetic — so a 7.5h day can arrive as
 * 7.500000000000001. Compared raw against a 7.5h standard that is "overtime",
 * and ANN's July drill-down duly listed seven OT days of 0.0h while the payslip
 * printed "0 hrs x RM 13.59 x 1.5 = RM 3.06" — a formula nobody can explain to
 * the worker it is paid to (owner 2026-08-01: 「OT 可是0hours？」).
 *
 * Rounding to 2 dp before every threshold test kills the dust and leaves real
 * fragments intact: 7.52h is still 0.02h of overtime. Money is unchanged for
 * every day that was genuinely over the line.
 */
function loggedHours(h: number): number {
  return Math.round((Number(h) || 0) * 100) / 100;
}

/**
 * Hours above the standard day that actually COUNT as overtime.
 *
 * The punch path has required 30 minutes since 2026-07-04; this path — overtime
 * derived from logged hours — had no minimum, so a 1-minute surplus was paid.
 * Same rule, both paths. Sunday / public-holiday work is untouched: the whole
 * day is premium there, it is not a "surplus over the standard day".
 */
function countableOtHours(surplus: number): number {
  const h = loggedHours(surplus);
  return h * 60 >= OT_MIN_MINUTES ? h : 0;
}

// ── Per-day attendance detail (DISPLAY ONLY — no money) ─────────────────────
//
// computeMonthlyLabor returns the COUNT of absent days and the TOTAL overtime
// hours, but not WHICH days. This helper enumerates the specific dates from the
// SAME inputs, using the IDENTICAL absence + grace-cutoff + per-date OT
// logic, so the Payroll screen can show "Absent: 03 Jun, 04 Jun" and
// "OT: 05 Jun — 2h" beneath a row. It computes NO amounts and changes nothing
// about the pay calculation — it is purely additive and safe to call alongside
// computeMonthlyLabor with the same arguments.

/** Day-level breakdown of a worker's month: which days were absent, and which
 *  had overtime (with the OT hours). All money lives in computeMonthlyLabor. */
export type AttendanceDayDetail = {
  /** ISO dates (YYYY-MM-DD) the worker was ABSENT — an elapsed working day
   *  within the grace cutoff with no hours logged (UNIFIED ÷26: pre-join /
   *  post-resign working days included). The list length equals
   *  computeMonthlyLabor's payroll.absentDays for the normal case. */
  absentDates: string[];
  /** Days with overtime: the date plus the OT hours on that date (hours above
   *  the worker's standard working day). Mirrors how computeMonthlyLabor sums
   *  otHours, just kept per-date. Empty when the worker has no OT. */
  otDays: Array<{ date: string; hours: number }>;
};

/** The subset of MonthlyLaborInput this helper needs. Same field meanings as
 *  computeMonthlyLabor so the caller passes the identical values. */
export type AttendanceDayDetailInput = {
  worker: Pick<LaborWorker, "workingHoursPerDay">;
  /** 4-digit year. */
  year: number;
  /** 1-indexed month (1 = January). */
  month: number;
  /** The worker's Working Hours rows for the month (raw, one per date×dept). */
  days: WorkerDayHours[];
  /** Declared public-holiday dates (YYYY-MM-DD). */
  publicHolidays: Iterable<string>;
  /** Count absences only through this day-of-month (the grace cutoff). */
  absenceThroughDay: number;
  /** Back-compat only (UNIFIED ÷26) — accepted, no longer narrows the walk. */
  employmentStartDay?: number;
  /** Back-compat only (UNIFIED ÷26) — accepted, no longer narrows the walk. */
  employmentEndDay?: number;
};

/**
 * Enumerate the absent dates + overtime days for one worker's month. Pure and
 * derived from the SAME attendance rows + holidays + grace cutoff that
 * computeMonthlyLabor uses — surfaces the per-day detail WITHOUT recomputing or
 * altering any pay amount. `month` is 1-indexed.
 */
export function computeAttendanceDayDetail(
  input: AttendanceDayDetailInput,
): AttendanceDayDetail {
  const { worker, year, month, days, publicHolidays, absenceThroughDay } = input;
  const holidaySet =
    publicHolidays instanceof Set
      ? (publicHolidays as Set<string>)
      : new Set(publicHolidays);
  const workingHoursPerDay = Math.max(0, worker.workingHoursPerDay || 0);

  // Sum hours per date, dropping rows outside the target month — IDENTICAL to
  // computeMonthlyLabor's per-date aggregation.
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}-`;
  const hoursByDate = new Map<string, number>();
  for (const row of days) {
    if (typeof row.date !== "string" || !row.date.startsWith(monthPrefix)) continue;
    const h = Number(row.hours) || 0;
    hoursByDate.set(row.date, (hoursByDate.get(row.date) ?? 0) + h);
  }

  // Overtime days, DAY-TYPED — the same split computeMonthlyLabor pays, retained
  // per-date so the worker's OT drill-down lists exactly the days they were paid
  // OT for: Sunday / public holiday → the whole day is OT (premium); ordinary
  // weekday → only the hours above the standard day.
  const otDays: Array<{ date: string; hours: number }> = [];
  for (const [date, raw] of hoursByDate) {
    const h = loggedHours(raw);
    if (h <= 0) continue;
    const [yy, mmN, dd] = date.split("-").map(Number);
    const dow = new Date(yy, (mmN || 1) - 1, dd || 1).getDay();
    let otH: number;
    if (dow === 0 || holidaySet.has(date)) {
      otH = h; // Sunday / public holiday → whole day at premium
    } else if (workingHoursPerDay > 0 && h > workingHoursPerDay) {
      otH = countableOtHours(h - workingHoursPerDay); // weekday → hours above the standard day
    } else {
      otH = 0;
    }
    if (otH > 0) otDays.push({ date, hours: otH });
  }
  otDays.sort((a, b) => a.date.localeCompare(b.date));

  // Absent dates: working days (Mon–Sat minus public holidays) with no logged
  // hours, through the grace cutoff. UNIFIED ÷26 model (owner 2026-06-11):
  // there is no employment window any more — days before a mid-month join or
  // after a resignation simply count (and dock) as absences, exactly like the
  // pay maths in computeMonthlyLabor. (employmentStartDay/EndDay are accepted
  // for back-compat but no longer narrow the walk.)
  const monthLastDay = new Date(year, month, 0).getDate();
  const startDay = 1;
  const throughDay = Math.min(absenceThroughDay, monthLastDay);
  const mm = String(month).padStart(2, "0");
  const absentDates: string[] = [];
  for (let d = startDay; d <= throughDay; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (!WORKING_DOW.has(dow)) continue; // Sunday — non-working
    const iso = `${year}-${mm}-${String(d).padStart(2, "0")}`;
    if (holidaySet.has(iso)) continue; // public holiday — not a workday
    if ((hoursByDate.get(iso) ?? 0) <= 0) absentDates.push(iso);
  }

  return { absentDates, otDays };
}

// ── Effective-dated salary ─────────────────────────────────────────────────
// A worker's salary can change mid-month (a raise). worker_salary_history holds
// the dated rows; workers.basic_salary_sen is the current snapshot + fallback.

/** One effective-dated salary row (the subset the salary helpers need). */
export type SalaryHistoryRow = {
  /** YYYY-MM-DD, inclusive — the first day this salary applies. */
  effectiveFrom: string;
  /** Salary in sen effective from effectiveFrom. */
  basicSalarySen: number;
};

/**
 * The salary (sen) effective on `isoDate` = the newest history row whose
 * effectiveFrom is <= isoDate. Falls back to `fallbackSen` when no row qualifies
 * (e.g. a date before the worker's first row). Pure.
 */
export function salaryAsOfSen(
  history: readonly SalaryHistoryRow[],
  fallbackSen: number,
  isoDate: string,
): number {
  let best: SalaryHistoryRow | undefined;
  for (const row of history) {
    if (typeof row?.effectiveFrom !== "string") continue;
    if (row.effectiveFrom <= isoDate) {
      if (!best || row.effectiveFrom > best.effectiveFrom) best = row;
    }
  }
  return best
    ? Math.max(0, best.basicSalarySen || 0)
    : Math.max(0, fallbackSen || 0);
}

/**
 * Day-weighted salary (sen) for a worker over `year`/`month`: each working day
 * (Mon–Sat minus public holidays) is valued at the salary effective that day,
 * then averaged over the month's working days. For a month with NO salary change
 * this returns that single salary exactly, so unchanged months are unaffected.
 * A mid-month raise yields the by-day basic-pay figure exactly (and a very close
 * OT/absence figure), and lets Payroll AND the Labor Cost reconciliation use ONE
 * salary per worker per month so the two stay aligned. `month` is 1-indexed.
 */
export function effectiveSalarySenForMonth(
  history: readonly SalaryHistoryRow[],
  fallbackSen: number,
  year: number,
  month: number,
  publicHolidays: Iterable<string>,
): number {
  const holidaySet =
    publicHolidays instanceof Set
      ? (publicHolidays as Set<string>)
      : new Set(publicHolidays);
  const monthLastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  let totalWorkingDays = 0;
  let weightedSumSen = 0;
  for (let d = 1; d <= monthLastDay; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (!WORKING_DOW.has(dow)) continue; // Sunday — non-working
    const iso = `${year}-${mm}-${String(d).padStart(2, "0")}`;
    if (holidaySet.has(iso)) continue; // public holiday
    totalWorkingDays++;
    weightedSumSen += salaryAsOfSen(history, fallbackSen, iso);
  }
  return totalWorkingDays > 0
    ? Math.round(weightedSumSen / totalWorkingDays)
    : Math.max(0, fallbackSen || 0);
}

/** Inputs for one worker, one month. */
export type MonthlyLaborInput = {
  worker: LaborWorker;
  /** 4-digit year. */
  year: number;
  /** 1-indexed month (1 = January). */
  month: number;
  /**
   * This worker's Working Hours rows for the month — raw, one per
   * (date × department × category). Rows outside `year`/`month` are
   * ignored, so a slightly wider query is harmless.
   */
  days: WorkerDayHours[];
  /** Declared public-holiday dates (YYYY-MM-DD) — kv_config['public_holidays']. */
  publicHolidays: Iterable<string>;
  /**
   * Count absences only through this day-of-month. Finished month → pass
   * the month's last day (e.g. 31). Current month → pass today's date so
   * days that haven't happened yet aren't charged as absences.
   */
  absenceThroughDay: number;
  /**
   * Last day-of-month the worker was employed (their resignation date's day),
   * INCLUSIVE. Days after this are neither worked nor absent — the person has
   * left. Omit (undefined) for everyone still employed: they are treated as
   * employed for the whole month.
   */
  employmentEndDay?: number;
  /**
   * First day-of-month the worker was employed (their join date's day),
   * INCLUSIVE. UNIFIED ÷26 model (owner 2026-06-11): this no longer narrows
   * the pay maths — working days before the join date count and dock as plain
   * absences, like any other unworked day. Accepted for back-compat with
   * existing callers. A worker whose join date is in a LATER month should be
   * excluded from this period's payroll entirely by the caller.
   */
  employmentStartDay?: number;
  /**
   * LEGACY (pre-2026-06-11 window proration). Accepted for back-compat but
   * IGNORED: under the unified ÷26 model every worker is full salary −
   * absences(÷26) − docks, join/resign months included.
   */
  prorateToService?: boolean;
  /**
   * Effective-dated pay-rule versions (owner 2026-06-11). Day-level maths use
   * the rules in force on each date; omitted/empty → DEFAULT_PAY_RULES, which
   * reproduces the previously-hardcoded behaviour exactly.
   */
  payRuleVersions?: PayRuleVersion[];
  /**
   * Hours the owner has explicitly docked from this worker this month, set per
   * day from the Labor Cost "Under-recorded hours" review when the short time is
   * NOT to be paid (it was neither a data-entry miss to backfill nor idle-but-
   * paid standby). Valued at the UNIFIED hourly rate (÷26 ÷ the worker's
   * hours+lunch span) and subtracted from basic earned, so the under-recorded
   * gap closes and Payroll reconciles with Labor Cost. Default 0.
   */
  shortHourDeductionHours?: number;
};

/** What one worker's month costs and earns. All money fields in sen. */
export type MonthlyLaborResult = {
  /** Public holidays (working-weekday) in the month. */
  holidaysInMonth: number;
  /** Distinct dates the worker logged any hours. */
  daysWorked: number;
  /** Total overtime hours (decimal) = weekday-above-standard + all Sunday + all holiday. */
  otHours: number;
  /** OT hours on ordinary weekdays (Mon–Sat, non-holiday): hours above the standard day. */
  otWeekdayHours: number;
  /** OT hours on Sundays: EVERY logged hour (rest-day premium from hour 1). */
  otSundayHours: number;
  /** OT hours on public holidays (Mon–Sat): EVERY logged hour. */
  otHolidayHours: number;

  /** Payroll day rate (÷ workingDaysPerMonth), in sen — may be fractional. */
  payrollDailyRateSen: number;
  /** OT rate per hour (÷26 basis × otMultiplier), in sen — may be fractional. */
  otHourlyRateSen: number;
  /** Production-cost day rate (÷ (days − holidays)), in sen — may be fractional. */
  costingDailyRateSen: number;

  /** Payroll — what the worker is paid, BEFORE statutory deductions. */
  payroll: {
    /** Full monthly salary (the headline figure shown to the worker). */
    fullSalarySen: number;
    /** Elapsed working days the worker logged no hours for. */
    absentDays: number;
    /** Money docked for those absent days. */
    absenceDeductionSen: number;
    /** Money docked for owner-flagged unworked hours (under-recorded review). */
    shortHourDeductionSen: number;
    /** Basic pay actually earned = full salary − absence − short-hour dock. */
    basicEarnedSen: number;
    /** Overtime pay (weekday + Sunday + holiday, day-typed multipliers). */
    otPaySen: number;
    /** Weekday OT pay = weekday OT hours × otMultiplier × (÷26 ÷ day-span). */
    otWeekdayPaySen: number;
    /** Sunday OT pay = all Sunday hours × 2 × (÷26 ÷ day-span). */
    otSundayPaySen: number;
    /** Public-holiday OT pay = all holiday hours × 3 × (÷26 ÷ day-span). */
    otHolidayPaySen: number;
    /** Gross = basic earned + OT (before EPF/SOCSO/EIS/PCB). */
    grossSen: number;
  };

  /** Production labor cost — the figure posted to cost_ledger. */
  cost: {
    /** Regular cost = days worked × production-cost day rate. */
    regularCostSen: number;
    /** Overtime cost — identical to payroll OT pay (÷26 basis). */
    otCostSen: number;
    /** Total production labor cost for the worker this month. */
    totalCostSen: number;
  };
};

/**
 * Compute one worker's month — payroll + production labor cost — from the
 * Working Hours grid. Pure: same inputs always give the same result.
 */
export function computeMonthlyLabor(
  input: MonthlyLaborInput,
): MonthlyLaborResult {
  const { worker, year, month, days, publicHolidays, absenceThroughDay } =
    input;
  const basicSalarySen = Math.max(0, worker.basicSalarySen || 0);
  const workingDaysPerMonth =
    worker.workingDaysPerMonth > 0
      ? worker.workingDaysPerMonth
      : FALLBACK_WORKING_DAYS_PER_MONTH;
  const workingHoursPerDay = Math.max(0, worker.workingHoursPerDay || 0);
  const otMultiplier = worker.otMultiplier > 0 ? worker.otMultiplier : 1;

  // ── Sum hours per date. A worker can have several department rows on
  //    one date; only the per-date total matters for pay + OT. Rows
  //    outside the target month are dropped so a wider query is safe.
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}-`;
  const hoursByDate = new Map<string, number>();
  for (const row of days) {
    if (typeof row.date !== "string" || !row.date.startsWith(monthPrefix)) {
      continue;
    }
    const h = Number(row.hours) || 0;
    hoursByDate.set(row.date, (hoursByDate.get(row.date) ?? 0) + h);
  }
  // Days WORKED for pay/cost purposes = dates with hours on a WORKING weekday
  // (Mon–Sat, not a public holiday). Sunday / public-holiday dates are pure OT
  // days — every hour on them is classified 2×/3× below, so they earn OT pay +
  // OT cost ONLY. They must NOT offset a weekday absence (a Sunday shift can't
  // cancel a Monday no-show), charge a regular day-rate in production cost, or
  // count as a served day for part-month proration. (Owner 2026-06-11:
  // Sundays are non-working; anyone punching one is paid straight 2× OT and a
  // weekday absence still docks.)
  const holidaySet =
    publicHolidays instanceof Set ? publicHolidays : new Set(publicHolidays);
  let daysWorked = 0;
  for (const [date, h] of hoursByDate) {
    if (h <= 0) continue;
    const [yy, mm, dd] = date.split("-").map(Number);
    const dow = new Date(yy, (mm || 1) - 1, dd || 1).getDay();
    if (dow !== 0 && !holidaySet.has(date)) daysWorked++;
  }

  // ── Overtime, DAY-TYPED (owner spec 2026-06-10):
  //    • weekday (Mon–Sat, not a public holiday): hours ABOVE the standard day.
  //    • Sunday: EVERY logged hour that day (rest-day premium, from hour 1).
  //    • public holiday (on a Mon–Sat): EVERY logged hour that day (× 3).
  //    A public holiday that falls on a Sunday counts as a Sunday (Sunday wins).
  //    Weekday OT keeps the per-worker otMultiplier; Sunday/holiday use the fixed
  //    2× / 3× below. otHours stays the grand total (back-compat + worker My Pay).
  //    Day-of-week is built from the date's y/m/d ints — matches the rest of the
  //    engine (WORKING_DOW) and is timezone-agnostic.
  let otWeekdayHours = 0;
  let otSundayHours = 0;
  let otHolidayHours = 0;
  for (const [date, h] of hoursByDate) {
    if (h <= 0) continue;
    const [yy, mm, dd] = date.split("-").map(Number);
    const dow = new Date(yy, (mm || 1) - 1, dd || 1).getDay();
    if (dow === 0) {
      otSundayHours += h; // Sunday — whole day at 2× (wins over a holiday too)
    } else if (holidaySet.has(date)) {
      otHolidayHours += h; // public holiday on a weekday — whole day at 3×
    } else if (workingHoursPerDay > 0) {
      otWeekdayHours += countableOtHours(loggedHours(h) - workingHoursPerDay); // ordinary weekday — above the standard day
    }
  }
  const otHours = otWeekdayHours + otSundayHours + otHolidayHours;

  // ── Holidays + the two divisors.
  const holidaysInMonth = countPublicHolidaysInMonth(
    year,
    month,
    publicHolidays,
  );
  // Two divisors, on purpose — UNIFIED ÷26 model (owner 2026-06-11):
  //   • PAYROLL (absence, late/short docks, the OT base) → ÷ the nominal
  //     workingDaysPerMonth (26, per-worker): ONE contractual day rate for
  //     everything money-side. Hourly rates divide it again by the worker's
  //     day SPAN = daily working hours + lunch (9h+1h = ÷10 → RM78.85/day,
  //     RM7.88/h on RM2,050; a 7.5h worker → ÷8.5). rateHoursPerDay is only
  //     the fallback for workers with no hours set.
  //     Join/resign is NOT a proration: unworked working days (pre-join and
  //     post-resign included) just count and dock as absences.
  //   • PRODUCTION COST → ÷ the ACTUAL working days in THIS calendar month
  //     = Mon–Sat days minus public holidays (24 in a 26-Mon–Sat month with
  //     2 holidays; varies by month). A logged day of output is valued at
  //     this ÷working-days rate. Internal costing only — never changes pay.
  // They differ on absent days — payroll docks ÷26, production loses
  // ÷working-days. That SIGNED gap is folded into the Labor Cost department
  // buckets, so Payroll and Labor Cost still tie out.
  // Clamped to ≥1 so it never divides by 0.
  const costingDivisor = Math.max(
    1,
    countElapsedWorkingDays(year, month, new Date(year, month, 0).getDate(), publicHolidays),
  );

  // workingHoursPerDay is the OT THRESHOLD and (plus lunch) the hourly-rate
  // divisor; it never divides the DAY rate (that's always ÷26).
  const daysInMonth = new Date(year, month, 0).getDate();
  // Effective-dated pay rules (owner 2026-06-11): day-level maths resolve the
  // rules in force ON each date; month-level rates (the display OT rate + the
  // late/short hourly rate, whose dock hours arrive as a month total) use the
  // rules as of the month's LAST day. No versions supplied → DEFAULT_PAY_RULES
  // → byte-identical to the previously-hardcoded behaviour.
  const monthEndYmd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const rulesAt = (date: string) =>
    resolvePayRulesAsOf(input.payRuleVersions, date);
  const cfgMonthEnd = rulesAt(monthEndYmd);
  // The payroll DAY rate under the configured divisor mode (owner 2026-06-11:
  // ÷26 / ÷calendar days / ÷actual working days — a dropdown choice now).
  // Default "fixed26" = salary ÷ workingDaysPerMonth, the unified rate.
  // Is this an outsourced / per-day person? Hoisted above the DAY RATE, which
  // now branches on it (2026-08-31) — the cost side and the pay side both read
  // it, so it has to be settled before either.
  const isDailyPaid =
    (worker.payMode ?? "MONTHLY") === "DAILY" && (worker.dailyRateSen ?? 0) > 0;

  // Month-level (resolved at month end), like the absence dock it prices.
  //
  // Owner 2026-08-31: 「简单来说就是跟我们目前的 flow 普通员工一样，只是他不是放
  // monthly 薪水而是放 daily 薪水，其他一模一样的。你也是用 monthly 薪水来计算
  // daily rate 的，这个是没有 monthly rate 直接 daily rate。」
  //
  // So an outsourced person takes the SAME road as everyone else; the only
  // difference is where the day rate comes from. A monthly worker's is
  // salary ÷ 26; theirs is simply the agreed figure. Everything downstream —
  // the hour rate, the short-hour dock, the day-typed overtime — then falls out
  // of the identical formulas instead of needing a parallel set.
  const payrollDailyRateSen = workerPayrollDayRateSen(
    { basicSalarySen, payMode: worker.payMode, dailyRateSen: worker.dailyRateSen },
    {
      workingDaysPerMonth,
      calendarDays: daysInMonth,
      workingDaysInMonth: costingDivisor,
    },
    cfgMonthEnd,
  );
  // Hourly divisor (owner 2026-06-11): default = the worker's OWN day span —
  // daily hours + lunch (9h + 1h = ÷10; 7.5h → ÷8.5); mode can switch it to
  // hours-only or a fixed number. No hours set → rateHoursPerDay fallback.
  // Lunch is effective-dated, so the divisor resolves per date like the rest.
  const hourDivisorAt = (cfg: PayRulesConfig): number =>
    payrollHourDivisor(workingHoursPerDay, cfg);
  const otBaseHourlyRateSen =
    payrollDailyRateSen / hourDivisorAt(cfgMonthEnd); // ÷26 ÷ day-span, before the day multiplier
  const otHourlyRateSen = otBaseHourlyRateSen * otMultiplier; // weekday OT rate (÷26÷10×mult) — back-compat
  // Unified ÷26 (owner 2026-06-11): the late/short hourly rate uses the SAME
  // ÷26 base as OT (was ÷calendar÷10).
  const lateHourlyRateSen = otBaseHourlyRateSen;
  // Production cost per day worked. A monthly worker's day costs their salary
  // spread over the month's working days; a daily worker's day costs exactly
  // the agreed day rate — that IS their cost, and it does not depend on a
  // monthly salary they do not have.
  //
  // Owner 2026-08-02: 「这个人是 outsource…他是根据他的 daywork（85 块一天）来计算
  // 的…并且这个薪水需要计算进我们的 labour cost，还有我们的 department labour。」
  // Without this branch basicSalarySen is 0 for them, so costingDailyRateSen is
  // 0, so regularCostSen is 0 — the person works a full month in a department
  // and contributes nothing to that department's cost. Every hour they log
  // would make the factory look cheaper than it is.
  const costingDailyRateSen = isDailyPaid
    ? Math.max(0, worker.dailyRateSen ?? 0)
    : basicSalarySen / costingDivisor;

  // Per-date OT MONEY — each date's hours are paid with the multipliers and
  // hour-divisor in force ON that date (a mid-month rule change applies from
  // its exact effective day). With constant rules this sums to exactly the
  // old hours×rate figures.
  let otWeekdayPayExact = 0;
  let otSundayPayExact = 0;
  let otHolidayPayExact = 0;
  for (const [date, h] of hoursByDate) {
    if (h <= 0) continue;
    const [py, pm, pd] = date.split("-").map(Number);
    const pdow = new Date(py, (pm || 1) - 1, pd || 1).getDay();
    const cfg = rulesAt(date);
    const base = payrollDailyRateSen / hourDivisorAt(cfg);
    if (pdow === 0) {
      otSundayPayExact += h * base * cfg.sundayOtMultiplier;
    } else if (holidaySet.has(date)) {
      otHolidayPayExact += h * base * cfg.holidayOtMultiplier;
    } else if (workingHoursPerDay > 0) {
      otWeekdayPayExact += countableOtHours(h - workingHoursPerDay) * base * otMultiplier;
    }
  }

  // ── Payroll side — UNIFIED ÷26 (owner 2026-06-11, "use 26 days for all"):
  // absence, OT and late/short all use the SAME contractual rate, salary ÷
  // workingDaysPerMonth (26 by default, per-worker in Employee Master).
  // Join / resign mid-month is NOT a proration any more: working days in the
  // month the worker did not work — INCLUDING days before their join date and
  // after their last day — simply count as ABSENT days and dock ÷26. One
  // formula for everyone: full salary − absences(÷26) − docks.
  const monthLastDay = new Date(year, month, 0).getDate();
  const throughDay = Math.min(absenceThroughDay, monthLastDay);
  const elapsedWorkingDays = Math.max(
    0,
    countElapsedWorkingDays(year, month, throughDay, publicHolidays),
  );
  // Clamp days-worked to the elapsed window so a stray future-dated log can't
  // make absences negative.
  const workedWithinWindow = Math.min(daysWorked, elapsedWorkingDays);
  // A day an outsourced person does not come is not an ABSENCE — there is no
  // salary for it to be absent from. Reporting 2 absent days against someone
  // hired by the day is meaningless on a payslip and invites someone to dock
  // it. Owner 2026-08-02: 「我们的算法就是根据你的日薪去计算。」
  const absentDays = isDailyPaid
    ? 0
    : Math.max(0, elapsedWorkingDays - workedWithinWindow);
  // Absence docks the ÷26 contractual day rate (RM78.85 on RM2,050) — the
  // same divisor as OT. The ÷26-vs-÷working-days difference per absent day is
  // bridged on the Labor Cost screen (the absence-leniency line).
  // DAILY pay mode (outsourced people, owner 2026-08-02). Monthly starts from a
  // full salary and DEDUCTS the days not worked; daily starts from zero and PAYS
  // the days worked. For someone who comes five days in a month those are not
  // two routes to the same number — the monthly rule would record 21 absences
  // and dock a salary they were never on. Own staff are untouched: payMode
  // defaults to MONTHLY, and this whole branch is skipped.
  // (isDailyPaid is defined with the rates above — the cost side needs it too.)
  const absenceDeductionSen = isDailyPaid
    ? 0
    : Math.round(absentDays * payrollDailyRateSen);
  // Owner-flagged / punch-derived unworked hours dock at (salary ÷ 26) ÷ the
  // effective-dated hour divisor — the same RM7.88/h base the OT rate uses.
  const shortHourDeductionHours = Math.max(0, input.shortHourDeductionHours || 0);
  // Short-hour docks apply to per-day people too (owner 2026-08-31, from a real
  // case: CHAU logged FOUR hours on 17 Aug against a 9-hour day and was paid the
  // full RM 85 — 「如果他没来，是要扣掉薪水的」).
  //
  // Nothing new had to be detected. The row was already there —
  // `Auto: short 5h (from punch)` on 2026-08-17 — written by the same punch
  // rules that dock everyone else. The engine collected it and then threw it
  // away here, because the old rule zeroed it and the hourly rate was 0 anyway
  // (it divided from a salary they do not have). With the day rate now taken
  // directly, that hourly rate is real and the existing dock simply lands.
  const shortHourDeductionSen = Math.round(shortHourDeductionHours * lateHourlyRateSen);
  // Daily: rate x days actually worked. There is no absence line to subtract —
  // a day not worked simply is not paid.
  // Deliberately `daysWorked`, NOT `workedWithinWindow`. The latter is clamped
  // by the absence window (elapsed working days), which is the right basis for
  // deciding what to DOCK but the wrong one for deciding what to PAY: a day
  // that falls outside that window would be worked and then not paid for. For
  // daily pay the rule is simply "days logged, days paid".
  const basicEarnedSen = isDailyPaid
    ? Math.max(
        0,
        Math.round(daysWorked * (worker.dailyRateSen ?? 0)) - shortHourDeductionSen,
      )
    : Math.max(
        0,
        Math.max(0, basicSalarySen - absenceDeductionSen) - shortHourDeductionSen,
      );
  // Day-typed OT pay. Weekday uses the per-worker rate (base × otMultiplier) so a
  // weekday-only worker is byte-identical to before; Sunday/holiday use the fixed
  // 2×/3× on the base rate. Each bucket is rounded, then summed → otPaySen.
  //
  // Outsourced people now earn overtime too. Owner 2026-08-02 wrote the
  // original rule as 「outsource 暂时没有」 — 暂时 — and on 2026-08-31 asked for
  // it: 「也要放 OT rate」.
  //
  // No separate formula: the rates above already divide from
  // payrollDailyRateSen, which for a per-day person IS their agreed day rate.
  // Weekday OT still needs a standard day to be ABOVE, so it stays zero until
  // Hours/day is set on the worker — while Sunday and public-holiday hours are
  // premium from the first hour and apply at once, exactly as for own staff.
  const otWeekdayPaySen = Math.round(otWeekdayPayExact);
  const otSundayPaySen = Math.round(otSundayPayExact);
  const otHolidayPaySen = Math.round(otHolidayPayExact);
  const otPaySen = otWeekdayPaySen + otSundayPaySen + otHolidayPaySen;
  const grossSen = basicEarnedSen + otPaySen;

  // ── Production labor cost side. Regular = days actually worked × the
  //    holiday-adjusted ÷working-days rate (everyone alike — the unified ÷26
  //    payroll model removed the part-month personal rate). OT cost equals OT
  //    pay exactly.
  const regularCostSen = Math.round(daysWorked * costingDailyRateSen);
  const otCostSen = otPaySen;
  const totalCostSen = regularCostSen + otCostSen;

  return {
    holidaysInMonth,
    daysWorked,
    otHours,
    otWeekdayHours,
    otSundayHours,
    otHolidayHours,
    payrollDailyRateSen,
    otHourlyRateSen,
    costingDailyRateSen,
    payroll: {
      fullSalarySen: basicSalarySen,
      absentDays,
      absenceDeductionSen,
      shortHourDeductionSen,
      basicEarnedSen,
      otPaySen,
      otWeekdayPaySen,
      otSundayPaySen,
      otHolidayPaySen,
      grossSen,
    },
    cost: {
      regularCostSen,
      otCostSen,
      totalCostSen,
    },
  };
}

// ---------------------------------------------------------------------------
// Production labor cost — per-minute rate for cost_ledger.
//
// computeMonthlyLabor (above) answers "what does this worker's MONTH cost
// and earn". The cost ledger needs a finer figure: when a job card
// completes, its production minutes are costed straight into cost_ledger.
//
// Per Wei Siang (2026-05-22): a job card is NOT traced back to actual
// working hours — it is costed off its production minutes ×
// productionCostRatePerMinuteSen. The rate uses the production-cost
// divisor (working days − public holidays) so a holiday month costs each
// produced minute more.
// ---------------------------------------------------------------------------

/** Fallback worker figures — un-attributed labor, or a half-set-up worker. */
export const DEFAULT_COSTING_WORKER: LaborWorker = {
  basicSalarySen: 205_000, // RM 2050 / month
  workingDaysPerMonth: 26,
  workingHoursPerDay: 9,
  otMultiplier: 1.5,
};

/**
 * Coerce a (possibly half-set-up) worker record into a usable LaborWorker.
 * Any missing or non-positive field falls back to DEFAULT_COSTING_WORKER,
 * so a worker with no salary set still costs at the default rate rather
 * than zero. Pass `undefined` for un-attributed labor.
 */
export function costingWorkerOrDefault(worker?: {
  basicSalarySen?: number | null;
  workingHoursPerDay?: number | null;
  workingDaysPerMonth?: number | null;
  otMultiplier?: number | null;
}): LaborWorker {
  return {
    basicSalarySen:
      worker?.basicSalarySen && worker.basicSalarySen > 0
        ? worker.basicSalarySen
        : DEFAULT_COSTING_WORKER.basicSalarySen,
    workingHoursPerDay:
      worker?.workingHoursPerDay && worker.workingHoursPerDay > 0
        ? worker.workingHoursPerDay
        : DEFAULT_COSTING_WORKER.workingHoursPerDay,
    workingDaysPerMonth:
      worker?.workingDaysPerMonth && worker.workingDaysPerMonth > 0
        ? worker.workingDaysPerMonth
        : DEFAULT_COSTING_WORKER.workingDaysPerMonth,
    otMultiplier:
      worker?.otMultiplier && worker.otMultiplier > 0
        ? worker.otMultiplier
        : DEFAULT_COSTING_WORKER.otMultiplier,
  };
}

/**
 * Production-cost labor rate, in SEN per MINUTE, for one worker in the
 * given month:
 *
 *   rate = basicSalary ÷ (ACTUAL Mon-Sat working days this month − public
 *               holidays) ÷ workingHoursPerDay ÷ 60
 *
 * The divisor is the real per-month working-day count (countElapsedWorkingDays)
 * — the same production-cost divisor computeMonthlyLabor uses — so a holiday or
 * short month costs each produced minute more. Returns 0 only when salary or
 * hours/day is non-positive. `month` is 1-indexed.
 */
export function productionCostRatePerMinuteSen(
  worker: LaborWorker,
  year: number,
  month: number,
  publicHolidays: Iterable<string>,
): number {
  const basicSalarySen = Math.max(0, worker.basicSalarySen || 0);
  const workingHoursPerDay = Math.max(0, worker.workingHoursPerDay || 0);
  if (basicSalarySen <= 0 || workingHoursPerDay <= 0) return 0;
  // Same costing divisor as computeMonthlyLabor: the ACTUAL Mon-Sat working
  // days in this calendar month minus public holidays (NOT the nominal 26).
  const costingDivisor = Math.max(
    1,
    countElapsedWorkingDays(year, month, new Date(year, month, 0).getDate(), publicHolidays),
  );
  return basicSalarySen / costingDivisor / workingHoursPerDay / 60;
}

// ---------------------------------------------------------------------------
// Outsourced / per-day people, on the COST side.
//
// Owner 2026-08-02: 「所以如果它是 outsource 的话，它就应该要用 outsource 的算法，
// 而不是去看我们正常 workers 的计算方式。」 and 「他也是跟着我们部门一样正常做的，
// 只是看要如何计算他的薪水而已。」
//
// So: they log hours in departments exactly like everyone else, and every
// report that costs those hours must include them — but priced their own way.
// A monthly worker's hour costs salary ÷ working days ÷ hours-per-day. That
// formula cannot be reused here: an outsourced person has no monthly salary
// (basicSalarySen = 0) and no standard day (workingHoursPerDay = 0), so it
// yields 0, and a 0 cost is how someone disappears from Labor Cost and
// Department Labor while still filling a seat on the floor.
//
// Their unit is the DAY, not the hour. One day logged costs one day rate,
// however many hours or departments that day was split across — which is also
// exactly what payroll pays them, so the reports and the payslip agree.
// ---------------------------------------------------------------------------

/**
 * A worker's PAYROLL day rate — the one number every hourly figure divides
 * from (overtime, the short-hour dock, the absence deduction).
 *
 * Exported because it was being re-derived on the payslip LIST and DETAIL
 * screens, each straight from `basicSalarySen`. That is 0 for an outsourced
 * person, so both showed a RM 0.00 deduction against a gross that had visibly
 * dropped — the money was right and the reason was invisible, which is the
 * exact failure this repo keeps paying for. One definition, three callers.
 */
export function workerPayrollDayRateSen(
  worker: {
    basicSalarySen?: number | null;
    payMode?: string | null;
    dailyRateSen?: number | null;
  },
  ctx: { workingDaysPerMonth: number; calendarDays: number; workingDaysInMonth: number },
  cfg: PayRulesConfig,
): number {
  // A per-day person's day rate is not derived from anything — it IS the
  // agreed figure (owner 2026-08-31: 「这个是没有 monthly rate 直接 daily rate」).
  if (isDailyPaidWorker(worker)) return Math.max(0, worker.dailyRateSen ?? 0);
  return payrollDayRateSen(Math.max(0, worker.basicSalarySen ?? 0), ctx, cfg);
}

/** True when this person is paid per day worked rather than a monthly salary. */
export function isDailyPaidWorker(worker: {
  payMode?: string | null;
  dailyRateSen?: number | null;
}): boolean {
  return (
    (worker.payMode ?? "MONTHLY") === "DAILY" && (worker.dailyRateSen ?? 0) > 0
  );
}

/**
 * What one logged DAY costs for a daily-paid worker, in sen. Zero for anyone
 * else — callers keep their existing monthly maths for those.
 *
 * Deliberately independent of hours: a short day and a long day both cost the
 * agreed rate, because that is what is actually paid. Callers that need a
 * per-entry figure should split this across the day's entries with
 * `dailyPaidEntryCostSen`.
 */
export function dailyPaidDayCostSen(worker: {
  payMode?: string | null;
  dailyRateSen?: number | null;
}): number {
  return isDailyPaidWorker(worker) ? Math.max(0, worker.dailyRateSen ?? 0) : 0;
}

/**
 * A daily-paid worker's day rate apportioned to ONE of that day's entries, by
 * that entry's share of the day's hours.
 *
 * The split matters because a person can log to more than one department in a
 * day and each department must carry its share — the same pro-rata rule the
 * monthly path already uses for OT. With a single entry it returns the whole
 * day rate; summed over one day's entries it always returns exactly the day
 * rate, so department totals still reconcile to payroll.
 *
 * `dayHours` of 0 (a punch with no hours) yields 0 rather than dividing by
 * zero — an unworked day is not a paid day.
 */
export function dailyPaidEntryCostSen(
  worker: { payMode?: string | null; dailyRateSen?: number | null },
  entryHours: number,
  dayHours: number,
): number {
  const dayCost = dailyPaidDayCostSen(worker);
  if (dayCost <= 0) return 0;
  const total = Math.max(0, dayHours);
  if (total <= 0) return 0;
  const share = Math.max(0, entryHours) / total;
  return dayCost * share;
}
