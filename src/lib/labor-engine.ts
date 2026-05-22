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
// Worked example — ANN: RM2,650/mo, 26 days, 8 h/day, OT ×1.5; May 2026
// has one public holiday (1 May):
//   payroll day rate   = 265000 ÷ 26      ≈ 101.92 sen-RM  (RM101.92)
//   OT hourly rate     = 265000 ÷ 26 ÷ 8 × 1.5 ≈ RM19.11
//   production day rate= 265000 ÷ (26−1)  = RM106.00
// Full attendance + 15 h OT → payroll gross = production cost = RM2,936.66.
// ---------------------------------------------------------------------------

/** Monday(1)..Saturday(6) are working weekdays; Sunday(0) is off. */
const WORKING_DOW: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);

/** Fallbacks used only to avoid divide-by-zero on a half-set-up worker. */
const FALLBACK_WORKING_DAYS_PER_MONTH = 26;

/**
 * A worker's maintained Employee Master figures. Everything the engine
 * needs about the person; no DB types leak in here so this module stays
 * pure and unit-testable.
 */
export type LaborWorker = {
  /** Monthly basic salary, in sen. */
  basicSalarySen: number;
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
};

/** What one worker's month costs and earns. All money fields in sen. */
export type MonthlyLaborResult = {
  /** Public holidays (working-weekday) in the month. */
  holidaysInMonth: number;
  /** Distinct dates the worker logged any hours. */
  daysWorked: number;
  /** Total overtime hours (decimal) — hours above the worker's standard day. */
  otHours: number;

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
    /** Basic pay actually earned = full salary − absence deduction. */
    basicEarnedSen: number;
    /** Overtime pay. */
    otPaySen: number;
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
  const daysWorked = hoursByDate.size;

  // ── Overtime: per date, the hours above the worker's standard day.
  //    Summed across the month. No threshold when hours/day is unset.
  let otHours = 0;
  if (workingHoursPerDay > 0) {
    for (const h of hoursByDate.values()) {
      if (h > workingHoursPerDay) otHours += h - workingHoursPerDay;
    }
  }

  // ── Holidays + the two divisors.
  const holidaysInMonth = countPublicHolidaysInMonth(
    year,
    month,
    publicHolidays,
  );
  // Payroll: ÷ nominal working days (26). Production cost: ÷ working days
  // left after public holidays — clamped to ≥1 so it never divides by 0.
  const costingDivisor = Math.max(1, workingDaysPerMonth - holidaysInMonth);

  const payrollDailyRateSen = basicSalarySen / workingDaysPerMonth;
  const otHourlyRateSen =
    workingHoursPerDay > 0
      ? (payrollDailyRateSen / workingHoursPerDay) * otMultiplier
      : 0;
  const costingDailyRateSen = basicSalarySen / costingDivisor;

  // ── Payroll side (÷26).
  const elapsedWorkingDays = countElapsedWorkingDays(
    year,
    month,
    absenceThroughDay,
    publicHolidays,
  );
  const absentDays = Math.max(0, elapsedWorkingDays - daysWorked);
  const absenceDeductionSen = Math.round(absentDays * payrollDailyRateSen);
  const basicEarnedSen = Math.max(0, basicSalarySen - absenceDeductionSen);
  const otPaySen = Math.round(otHours * otHourlyRateSen);
  const grossSen = basicEarnedSen + otPaySen;

  // ── Production labor cost side. Regular = days actually worked × the
  //    holiday-adjusted day rate. OT cost equals OT pay exactly (÷26).
  const regularCostSen = Math.round(daysWorked * costingDailyRateSen);
  const otCostSen = otPaySen;
  const totalCostSen = regularCostSen + otCostSen;

  return {
    holidaysInMonth,
    daysWorked,
    otHours,
    payrollDailyRateSen,
    otHourlyRateSen,
    costingDailyRateSen,
    payroll: {
      fullSalarySen: basicSalarySen,
      absentDays,
      absenceDeductionSen,
      basicEarnedSen,
      otPaySen,
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
 *   rate = basicSalary ÷ (workingDaysPerMonth − public holidays)
 *               ÷ workingHoursPerDay ÷ 60
 *
 * The divisor drops the month's public holidays — the same production-cost
 * divisor computeMonthlyLabor uses — so a holiday month costs each
 * produced minute more. Returns 0 only when salary or hours/day is
 * non-positive. `month` is 1-indexed.
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
  const workingDaysPerMonth =
    worker.workingDaysPerMonth > 0
      ? worker.workingDaysPerMonth
      : FALLBACK_WORKING_DAYS_PER_MONTH;
  const holidays = countPublicHolidaysInMonth(year, month, publicHolidays);
  const costingDivisor = Math.max(1, workingDaysPerMonth - holidays);
  return basicSalarySen / costingDivisor / workingHoursPerDay / 60;
}
