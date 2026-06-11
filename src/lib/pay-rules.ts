// ---------------------------------------------------------------------------
// Pay rules — EFFECTIVE-DATED configuration (owner 2026-06-11: "這整個都要有
// effective date").
//
// A pay-rule VERSION is a full snapshot of every configurable knob plus the
// date it takes effect. Versions are append-only; the rules that apply to a
// given DATE are those of the newest version whose effectiveFrom <= date.
// Day-level maths (lateness, OT classification, multipliers, the ÷10 hour
// divisor) resolve PER DATE, so a mid-month change applies from its exact
// effective day. Month-level statutory uses the rules as of the month's last
// day.
//
// NOT configurable here (structural, by the owner's own specs):
//   • the UNIFIED ÷26 day-rate divisor (per-worker workingDaysPerMonth in
//     Employee Master) — absences, late/short docks and the OT base all
//     dock/pay salary ÷ 26; HOURLY rates divide again by the worker's own
//     day span (daily hours + lunch — Employee Master), with rateHoursPerDay
//     as the fallback when hours are unset
//   • the per-worker weekday OT multiplier (also Employee Master)
//
// Shared by frontend AND backend so the grid, the engine, the auto-dock and
// the reconciliation can never disagree. DEFAULT_PAY_RULES reproduces the
// previously-hardcoded behaviour byte-for-byte, so an empty versions table
// changes nothing.
// ---------------------------------------------------------------------------

export type PayRulesConfig = {
  /** Shift start, minutes since midnight (480 = 08:00). */
  shiftStartMin: number;
  /** Shift end / OT boundary, minutes since midnight (1080 = 18:00). */
  shiftEndMin: number;
  /** Unpaid lunch, minutes (60). */
  lunchMin: number;
  /** Lateness forgiven up to this many minutes (10). */
  lateGraceMin: number;
  /** Penal lateness rounds UP to blocks of this many minutes (15). */
  lateBlockMin: number;
  /** FALLBACK hour divisor for OT + late/short rates, used only when a worker
   *  has no daily hours set. Normally the divisor is the worker's own day
   *  span: daily working hours + lunch (9h + 1h = ÷10; 7.5h → ÷8.5). */
  rateHoursPerDay: number;
  /** Sunday work: every hour × this (2). */
  sundayOtMultiplier: number;
  /** Public-holiday work: every hour × this (3). */
  holidayOtMultiplier: number;
  /** Working days with no hours stay "Pending" this many working days (2). */
  absenceGraceWorkingDays: number;
  /** EPF employee share, percent of basic (11). */
  epfEmployeePct: number;
  /** EPF employer share, percent of basic (13). */
  epfEmployerPct: number;
  /** SOCSO employee share, sen (745). */
  socsoEmployeeSen: number;
  /** SOCSO employer share, sen (2615). */
  socsoEmployerSen: number;
  /** EIS employee share, sen (390). */
  eisEmployeeSen: number;
  /** EIS employer share, sen (390). */
  eisEmployerSen: number;
};

export type PayRuleVersion = {
  id: string;
  /** YYYY-MM-DD — the first date these rules apply to. */
  effectiveFrom: string;
  rules: PayRulesConfig;
  createdAt?: string;
  createdBy?: string | null;
  note?: string | null;
};

/** The previously-hardcoded behaviour. An empty versions list = exactly this. */
export const DEFAULT_PAY_RULES: PayRulesConfig = {
  shiftStartMin: 8 * 60,
  shiftEndMin: 18 * 60,
  lunchMin: 60,
  lateGraceMin: 10,
  lateBlockMin: 15,
  rateHoursPerDay: 10,
  sundayOtMultiplier: 2,
  holidayOtMultiplier: 3,
  absenceGraceWorkingDays: 2,
  epfEmployeePct: 11,
  epfEmployerPct: 13,
  socsoEmployeeSen: 745,
  socsoEmployerSen: 2615,
  eisEmployeeSen: 390,
  eisEmployerSen: 390,
};

/** Coerce a half-trusted stored rules object onto the defaults (missing /
 *  malformed fields fall back per-field, so an old version row keeps working
 *  after new knobs are added). */
export function normalizePayRules(raw: unknown): PayRulesConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof PayRulesConfig): number => {
    const v = Number(r[k]);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PAY_RULES[k];
  };
  return {
    shiftStartMin: num("shiftStartMin"),
    shiftEndMin: num("shiftEndMin"),
    lunchMin: num("lunchMin"),
    lateGraceMin: num("lateGraceMin"),
    lateBlockMin: num("lateBlockMin"),
    rateHoursPerDay: Math.max(1, num("rateHoursPerDay")),
    sundayOtMultiplier: num("sundayOtMultiplier"),
    holidayOtMultiplier: num("holidayOtMultiplier"),
    absenceGraceWorkingDays: num("absenceGraceWorkingDays"),
    epfEmployeePct: num("epfEmployeePct"),
    epfEmployerPct: num("epfEmployerPct"),
    socsoEmployeeSen: num("socsoEmployeeSen"),
    socsoEmployerSen: num("socsoEmployerSen"),
    eisEmployeeSen: num("eisEmployeeSen"),
    eisEmployerSen: num("eisEmployerSen"),
  };
}

/**
 * The rules in force on `dateYmd` (YYYY-MM-DD): the newest version whose
 * effectiveFrom <= date, else the defaults. Versions may arrive unsorted.
 */
export function resolvePayRulesAsOf(
  versions: PayRuleVersion[] | null | undefined,
  dateYmd: string,
): PayRulesConfig {
  let best: PayRuleVersion | null = null;
  for (const v of versions ?? []) {
    if (typeof v?.effectiveFrom !== "string" || v.effectiveFrom > dateYmd) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  return best ? normalizePayRules(best.rules) : DEFAULT_PAY_RULES;
}

/** Adapter to the attendance-rules engine's config shape. */
export function toAttendanceRules(cfg: PayRulesConfig): {
  startMin: number;
  endMin: number;
  lunchMin: number;
  standardWorkMin: number;
  lateGraceMin: number;
  lateBlockMin: number;
} {
  return {
    startMin: cfg.shiftStartMin,
    endMin: cfg.shiftEndMin,
    lunchMin: cfg.lunchMin,
    standardWorkMin: Math.max(0, cfg.shiftEndMin - cfg.shiftStartMin - cfg.lunchMin),
    lateGraceMin: cfg.lateGraceMin,
    lateBlockMin: cfg.lateBlockMin,
  };
}

/** "HH:MM" display for a minutes-since-midnight value. */
export function minToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
