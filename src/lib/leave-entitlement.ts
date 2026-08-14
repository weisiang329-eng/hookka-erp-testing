// ---------------------------------------------------------------------------
// leave-entitlement.ts — the ONE place leave entitlement, chargeable days and
// the leave-year boundary are decided.
//
// Why this module exists
// ----------------------
// Before it, the same three decisions were made in three places that disagreed:
//
//   * `src/pages/employees.tsx` — `LEAVE_ENTITLEMENTS = { ANNUAL: 8, MEDICAL: 14 }`,
//     balance summed over ALL history (no year boundary), public holidays not
//     excluded.
//   * `src/api/routes/worker.ts` — `annualEntitlement = 14` (NOT 8: the worker's
//     phone showed nearly double the office's annual figure for as long as the
//     endpoint has existed), `medicalEntitlement = 14`, balance clamped at 0,
//     and a calendar-year filter the office did not have.
//   * `src/api/routes/leaves.ts` — stored whatever `days` the client posted.
//
// Three copies of one policy is bug class C4 ("more than one copy of the same
// price list"): only one gets updated and the others rot silently. The office
// and the phone disagreeing about ANNUAL by 6 days is that rot, already shipped.
// Per C13, the rule now lives in ONE pure module that the screen AND the routes
// both call.
//
// This module is deliberately pure: no DB, no `Env`, no fetch. That is what lets
// `src/pages/*` (browser) and `src/api/*` (Worker) share it, and what makes it
// testable without a database.
// ---------------------------------------------------------------------------

/** Leave types the system stores. Mirrors `LEAVE_TYPES` in `employees.tsx`. */
export type LeaveType =
  | "ANNUAL"
  | "MEDICAL"
  | "UNPAID"
  | "EMERGENCY"
  | "PUBLIC_HOLIDAY";

/** The two types that draw down an entitlement. */
export type EntitledLeaveType = "ANNUAL" | "MEDICAL";

// ---------------------------------------------------------------------------
// Defaults — these ARE today's behaviour, on purpose.
//
// 8 / 14 are the numbers `employees.tsx` has always used. They are the default
// so that adding the per-worker columns below changes NOBODY's balance until
// the owner sets an override. Do not "upgrade" these to the statutory tiers
// without the owner's decision — that silently grants people more leave.
// ---------------------------------------------------------------------------
export const DEFAULT_ANNUAL_ENTITLEMENT_DAYS = 8;
export const DEFAULT_MEDICAL_ENTITLEMENT_DAYS = 14;

/**
 * Malaysian Employment Act 1955 s.60E statutory annual-leave minimums, by
 * completed years of service.
 *
 * ⚠️ EXPORTED BUT NOT WIRED IN. This is reference data for the owner's pending
 * decision (flat 8 vs statutory tiers vs per-employee override), not the active
 * policy. `resolveEntitlementDays` does NOT consult it. Wiring it in is a
 * deliberate act that raises entitlement for anyone with 2+ years of service —
 * it must be the owner's call, not a side effect of this module existing.
 */
export const STATUTORY_ANNUAL_TIERS: readonly {
  minServiceYears: number;
  days: number;
}[] = [
  { minServiceYears: 0, days: 8 },
  { minServiceYears: 2, days: 12 },
  { minServiceYears: 5, days: 16 },
];

/**
 * The statutory annual entitlement for a given completed-years-of-service
 * figure. Provided so the owner's decision is a one-line change (and so the
 * tiers are tested rather than folklore), NOT called by the balance path.
 */
export function statutoryAnnualEntitlementDays(serviceYears: number): number {
  const yrs = Number.isFinite(serviceYears) ? Math.max(0, serviceYears) : 0;
  let days = STATUTORY_ANNUAL_TIERS[0].days;
  for (const tier of STATUTORY_ANNUAL_TIERS) {
    if (yrs >= tier.minServiceYears) days = tier.days;
  }
  return days;
}

// ---------------------------------------------------------------------------
// Dates. All YMD strings ("2026-08-14"), compared as strings.
//
// String comparison is correct for zero-padded ISO dates and — unlike `new
// Date(...)` — carries no timezone. A `new Date("2026-08-14")` is midnight UTC,
// which is the previous DAY in UTC+8, and this codebase has already been bitten
// by date arithmetic that shifted under a timezone.
// ---------------------------------------------------------------------------

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && YMD_RE.test(value);
}

/**
 * Parse `kv_config['public_holidays']`.
 *
 * The SAME source and the SAME validation the payroll paths already use
 * (`payslips.ts`, `payroll-hour-deductions.ts`, `dashboard-overview.ts`): a JSON
 * array of "YYYY-MM-DD" strings, anything malformed treated as no holidays.
 * There is deliberately NO second holiday list in this repo — the owner
 * maintains one, in Employees, and this reads it.
 */
export function parsePublicHolidays(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const d of parsed) if (isYmd(d)) out.add(d);
    }
  } catch {
    /* malformed payload — treat as no holidays, same as the payroll paths */
  }
  return out;
}

/**
 * How many configured public holidays fall inside [startYmd, endYmd] inclusive.
 *
 * Iterates the HOLIDAY set, not the date range: the set is a few dozen entries
 * a year, while a mistyped end date ("2226-01-01") would otherwise spin through
 * 73,000 days. Cost is O(holidays) and a typo cannot hang the page.
 */
export function countPublicHolidaysInRange(
  startYmd: string,
  endYmd: string,
  publicHolidays: ReadonlySet<string>,
): number {
  if (!isYmd(startYmd) || !isYmd(endYmd) || endYmd < startYmd) return 0;
  let n = 0;
  for (const h of publicHolidays) {
    if (h >= startYmd && h <= endYmd) n++;
  }
  return n;
}

/**
 * The days a leave request actually CONSUMES from its entitlement.
 *
 * = the stored `days` for that request, minus any public holiday inside its
 * date range, floored at 0.
 *
 * Two deliberate choices:
 *
 *  1. It subtracts from the STORED `days` rather than recomputing the calendar
 *     span. The office PUT lets an approver edit `days` by hand; recomputing
 *     the span would silently discard that edit. When `days` is the untouched
 *     span (the normal case) the two are identical.
 *  2. It does NOT exclude weekends or rest days. This codebase has no rest-day
 *     model of any kind — grep for `rest_day` / `restDay` returns nothing — and
 *     inventing one here would be fabricating a policy the owner never set.
 *     If Hookka wants weekends excluded, that is a separate owner decision and
 *     needs a real rest-day source first.
 */
export function chargeableLeaveDays(
  leave: { startDate?: string | null; endDate?: string | null; days?: number | null },
  publicHolidays: ReadonlySet<string>,
): number {
  const stored = Number(leave.days);
  const base = Number.isFinite(stored) && stored > 0 ? stored : 0;
  const start = leave.startDate ?? "";
  const end = leave.endDate ?? "";
  if (!isYmd(start) || !isYmd(end)) return base;
  const holidays = countPublicHolidaysInRange(start, end, publicHolidays);
  return Math.max(0, base - holidays);
}

/**
 * The inclusive calendar span of a date range, in days — i.e. exactly what the
 * two client-side `calculateDays` helpers compute today, with no holiday logic.
 * Kept as the value WRITTEN to `leaves.days` so the stored column keeps meaning
 * the same thing it always has; the holiday exclusion is applied on READ by
 * `chargeableLeaveDays`.
 */
export function calendarLeaveDays(startYmd: string, endYmd: string): number {
  if (!isYmd(startYmd) || !isYmd(endYmd)) return 1;
  const s = Date.UTC(
    Number(startYmd.slice(0, 4)),
    Number(startYmd.slice(5, 7)) - 1,
    Number(startYmd.slice(8, 10)),
  );
  const e = Date.UTC(
    Number(endYmd.slice(0, 4)),
    Number(endYmd.slice(5, 7)) - 1,
    Number(endYmd.slice(8, 10)),
  );
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

// ---------------------------------------------------------------------------
// The leave YEAR.
//
// BOUNDARY: the CALENDAR year of the request's START date.
//
// This is not a fresh invention — it is the boundary already shipped and in use
// on the worker's phone: `worker.ts` filters its YTD figures with
// `r.startDate.startsWith(String(new Date().getFullYear()))`. The office screen
// had NO boundary at all, which is the actual defect (a balance that only ever
// decreases, forever). Adopting the phone's existing rule makes the two agree
// and follows the precedent the codebase already set, rather than introducing a
// third opinion.
//
// The alternative — the anniversary of `workers.join_date` — is what strict
// Employment Act accrual uses, and it is a real option. It is NOT chosen here
// because nothing in this codebase does anniversary-based accounting (payroll
// periods, payslips and the existing YTD filter are all calendar), so it would
// be a new concept with no precedent. Flagged for the owner.
//
// A request that SPANS new year is attributed wholly to its start date's year,
// which is likewise what the shipped filter does.
// ---------------------------------------------------------------------------

export function leaveYearOfYmd(ymd: string): number | null {
  if (!isYmd(ymd)) return null;
  return Number(ymd.slice(0, 4));
}

export function isInLeaveYear(startYmd: string | null | undefined, year: number): boolean {
  return isYmd(startYmd ?? "") && leaveYearOfYmd(startYmd as string) === year;
}

/** The leave year a date falls in; defaults to "now" in the caller's clock. */
export function currentLeaveYear(now: Date = new Date()): number {
  return now.getFullYear();
}

// ---------------------------------------------------------------------------
// Entitlement resolution
// ---------------------------------------------------------------------------

/**
 * The per-worker override columns, accepted in BOTH spellings.
 *
 * Rows reach callers through two different paths in this repo — the rename-map
 * `SELECT *` translation (camelCase) and raw snake_case reads — and
 * HOOKKA-GOTCHAS requires reading dual-keyed (`r.camelCase ?? r.snake_case`) so
 * it cannot matter which spelling won.
 */
export type WorkerEntitlementFields = {
  annualLeaveEntitlementDays?: number | string | null;
  annual_leave_entitlement_days?: number | string | null;
  medicalLeaveEntitlementDays?: number | string | null;
  medical_leave_entitlement_days?: number | string | null;
};

function readOverride(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * The entitlement in days for one worker and one leave type.
 *
 * Per-worker override when set, otherwise the default. A NULL/absent override —
 * which is every existing row, because the new columns are added nullable with
 * no default — resolves to exactly today's 8 / 14. That is what makes this
 * change a no-op on deploy.
 */
export function resolveEntitlementDays(
  type: EntitledLeaveType,
  worker: WorkerEntitlementFields | null | undefined,
): number {
  const w = worker ?? {};
  if (type === "ANNUAL") {
    return (
      readOverride(w.annualLeaveEntitlementDays ?? w.annual_leave_entitlement_days) ??
      DEFAULT_ANNUAL_ENTITLEMENT_DAYS
    );
  }
  return (
    readOverride(w.medicalLeaveEntitlementDays ?? w.medical_leave_entitlement_days) ??
    DEFAULT_MEDICAL_ENTITLEMENT_DAYS
  );
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export type LeaveLike = {
  type?: string | null;
  status?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  days?: number | null;
};

export type LeaveBalance = {
  type: EntitledLeaveType;
  leaveYear: number;
  entitlementDays: number;
  usedDays: number;
  remainingDays: number;
};

/**
 * One worker's balance for one leave type, in one leave year.
 *
 * Counts only APPROVED requests of that type whose START date falls in the
 * given leave year, and charges each one its holiday-excluded day count.
 *
 * `remainingDays` is NOT clamped at zero: an over-drawn balance is real
 * information the approver needs to see, and the office screen has always shown
 * it (it styles a low balance red). `worker.ts` used to clamp it, which hid
 * over-draw from the only person who could notice it.
 */
export function computeLeaveBalance(opts: {
  leaves: readonly LeaveLike[];
  worker: WorkerEntitlementFields | null | undefined;
  type: EntitledLeaveType;
  leaveYear: number;
  publicHolidays: ReadonlySet<string>;
}): LeaveBalance {
  const { leaves, worker, type, leaveYear, publicHolidays } = opts;
  const entitlementDays = resolveEntitlementDays(type, worker);
  let usedDays = 0;
  for (const l of leaves) {
    if (l.type !== type) continue;
    if (l.status !== "APPROVED") continue;
    if (!isInLeaveYear(l.startDate, leaveYear)) continue;
    usedDays += chargeableLeaveDays(l, publicHolidays);
  }
  return {
    type,
    leaveYear,
    entitlementDays,
    usedDays,
    remainingDays: entitlementDays - usedDays,
  };
}
