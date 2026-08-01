// ---------------------------------------------------------------------------
// Attendance rules — turn a worker's punch in/out into the day's payable work,
// shortfall, and overtime, per Wei Siang's spec (confirmed 2026-06-09).
//
//   • Shift 08:00–18:00, 1 h unpaid lunch → 9 payable work hours. Mon–Sat.
//   • Late: a clock-in within 10 min of 08:00 is forgiven; MORE than 10 min late
//     counts from 08:00 (the grace is a threshold, not a free allowance).
//   • Short: fewer than 9 worked hours → the shortfall is deducted at the hourly
//     rate. Coming late and leaving early are just two ways to fall short — the
//     shortfall is counted ONCE (never a separate late penalty on top).
//   • Overtime: only past 18:00, and only if it EXCEEDS 15 min. The clock-out
//     minute is floored to a quarter — 0–15→0, 16–29→15, 30–44→30, 45–59→45
//     (confirmed rounding table; note 15→0 enforces the ">15 min" rule). OT
//     minutes feed the existing × otMultiplier overtime pay.
//
// Pure + deterministic: this only maps times → minutes, so it can be unit-tested
// to the minute. All money / payroll wiring lives in the payroll engine.
// ---------------------------------------------------------------------------

export type AttendanceRules = {
  /** Shift start, minutes since midnight (08:00 = 480). */
  startMin: number;
  /** Shift end / OT boundary, minutes since midnight (18:00 = 1080). */
  endMin: number;
  /** Unpaid lunch, minutes (60) — the full break length / overlap cap. */
  lunchMin: number;
  /** Lunch window start, minutes since midnight (12:00 = 720). */
  lunchStartMin: number;
  /** Lunch window end, minutes since midnight (13:00 = 780). */
  lunchEndMin: number;
  /** Payable work target, minutes (9 h = 540). */
  standardWorkMin: number;
  /** Lateness forgiven up to this many minutes (10). */
  lateGraceMin: number;
  /** Penal lateness rounds UP to blocks of this many minutes (15). */
  lateBlockMin: number;
};

/**
 * Overtime does not start until this many minutes past the shift end
 * (owner 2026-07-04: 「OT 要30分鐘才算」 — an 18:28 punch-out is 0 OT, not 15).
 *
 * Exported because the PUNCH is not the only path to overtime: the payroll
 * engine also derives it from LOGGED HOURS (hours above the worker's standard
 * day), and that path had no minimum at all — so a day recorded as 7.52h
 * against a 7.5h standard paid 1 minute of overtime, and ANN's July payslip
 * printed "0 hrs x RM 13.59 x 1.5 = RM 3.06". One threshold, both paths.
 */
export const OT_MIN_MINUTES = 30;

export const HOOKKA_ATTENDANCE: AttendanceRules = {
  startMin: 8 * 60, // 480
  endMin: 18 * 60, // 1080
  lunchMin: 60,
  lunchStartMin: 12 * 60, // 720 (12:00)
  lunchEndMin: 13 * 60, // 780 (13:00)
  standardWorkMin: 9 * 60, // 540
  lateGraceMin: 10,
  lateBlockMin: 15,
};

export type AttendanceDay = {
  /** Minutes late vs 08:00 (0 when within the grace window). */
  lateMin: number;
  /** Late beyond the grace → deductible. */
  isLate: boolean;
  /** Payable regular minutes (≤ standardWorkMin), lunch removed. */
  regularWorkMin: number;
  /** standardWorkMin − regularWorkMin — the minutes to deduct at hourly rate. */
  shortfallMin: number;
  /** Rounded overtime minutes (paid at × otMultiplier downstream). */
  otMin: number;
};

/** "HH:MM" → minutes since midnight, or null if missing / malformed. */
export function hhmmToMinutes(hhmm: string | null | undefined): number | null {
  if (typeof hhmm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Floor a clock-out MINUTE-of-hour to a quarter, per the confirmed rounding
 * table: 0–15→0, 16–29→15, 30–44→30, 45–59→45. The 15→0 boundary enforces the
 * spec's "OT must exceed 15 min" rule (18:00–18:15 yields 0 OT).
 */
export function roundOutMinute(minuteOfHour: number): number {
  if (minuteOfHour <= 15) return 0;
  if (minuteOfHour <= 29) return 15;
  if (minuteOfHour <= 44) return 30;
  return 45;
}

/**
 * Map a day's punch in/out (minutes since midnight, Malaysia local) to its
 * payable work, shortfall, and overtime.
 */
export function computeAttendanceDay(
  clockInMin: number,
  clockOutMin: number,
  rules: AttendanceRules = HOOKKA_ATTENDANCE,
): AttendanceDay {
  // Lateness vs the shift start, with the grace window.
  const rawLate = Math.max(0, clockInMin - rules.startMin);
  const isLate = rawLate > rules.lateGraceMin;
  const lateMin = isLate ? rawLate : 0;
  // Penal lateness rounds UP to 15-min blocks (owner 2026-06-11): one minute
  // into a block costs the whole block (08:11 → charged as 08:15; 08:16 →
  // 08:30). Deliberately ASYMMETRIC with OT, which floors (16–29 min OT → 15)
  // — both directions favour the company. Within grace → on-time.
  const penalLateMin = isLate
    ? Math.ceil(rawLate / rules.lateBlockMin) * rules.lateBlockMin
    : 0;
  const effectiveIn = rules.startMin + penalLateMin;

  // Regular (non-OT) work ends at the shift end. Lunch (12:00–13:00) is unpaid
  // ONLY for the part of it the worker is actually on shift: we deduct the
  // overlap of [effectiveIn, regularEnd] with the lunch window, capped at the
  // lunch length. Arrive AFTER 1pm → zero overlap → no lunch deducted (owner
  // 2026-06-28: they came after lunch, so it's just a half day — don't also
  // dock the break). Arrive mid-lunch → only the remaining break minutes drop.
  const regularEnd = Math.min(clockOutMin, rules.endMin);
  const lunchOverlap = Math.min(
    rules.lunchMin,
    Math.max(
      0,
      Math.min(regularEnd, rules.lunchEndMin) -
        Math.max(effectiveIn, rules.lunchStartMin),
    ),
  );
  const regularWorkMin = Math.max(0, regularEnd - effectiveIn - lunchOverlap);

  // Overtime past the shift end — clock-out minute floored to a quarter.
  let otMin = 0;
  if (clockOutMin > rules.endMin) {
    const roundedOut =
      Math.floor(clockOutMin / 60) * 60 + roundOutMinute(clockOutMin % 60);
    otMin = Math.max(0, roundedOut - rules.endMin);
    // OT only counts from 30 minutes past shift end (owner correction
    // 2026-07-04: "OT 要30分鐘才算" — an 18:28 punch-out is 0 OT, not 15).
    // Below the threshold the tail also stops offsetting the shortfall,
    // consistent with it not being counted as work. From 30 minutes on,
    // quarters apply as before (18:30→30, 18:45→45).
    if (otMin < OT_MIN_MINUTES) otMin = 0;
  }

  // Shortfall — same-day OT OFFSETS it first (owner 2026-06-11): a worker who
  // comes 30 min late but works 2 h past 18:00 is short NOTHING — the evening
  // time covers the morning gap at 1:1 (plain time, not 1.5×); only a
  // remainder gets docked. The otMin figure itself stays UN-netted on purpose:
  // the grid logs regular+OT as ONE Hours figure and the payroll engine pays
  // OT only on hours ABOVE the 9-h standard, so the PAID OT nets naturally
  // there (8.5 regular + 2 punch-OT = 10.5 logged → engine pays 1.5 h at the
  // OT rate). Netting otMin here too would double-net.
  const shortfallMin = Math.max(
    0,
    rules.standardWorkMin - regularWorkMin - otMin,
  );

  return { lateMin, isLate, regularWorkMin, shortfallMin, otMin };
}

/**
 * Minutes of overtime that actually COUNT, given a raw surplus over the
 * standard day. Below the factory minimum nothing is earned.
 *
 * Shared so every surface agrees — the payroll engine, the worker's own My Pay
 * screen, and the office attendance grid each derived overtime independently
 * and only the punch path applied the minimum. A worker could see 0.02h of
 * overtime on their phone for a day the payslip paid nothing for.
 */
export function otMinutesAtLeastMinimum(surplusMinutes: number): number {
  const m = Math.max(0, Math.round(Number(surplusMinutes) || 0));
  return m >= OT_MIN_MINUTES ? m : 0;
}
