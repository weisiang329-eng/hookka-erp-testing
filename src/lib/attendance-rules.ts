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
  /** Unpaid lunch, minutes (60). */
  lunchMin: number;
  /** Payable work target, minutes (9 h = 540). */
  standardWorkMin: number;
  /** Lateness forgiven up to this many minutes (10). */
  lateGraceMin: number;
};

export const HOOKKA_ATTENDANCE: AttendanceRules = {
  startMin: 8 * 60, // 480
  endMin: 18 * 60, // 1080
  lunchMin: 60,
  standardWorkMin: 9 * 60, // 540
  lateGraceMin: 10,
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
  // Within grace → treat as on-time for the work-hours maths.
  const effectiveIn = isLate ? clockInMin : rules.startMin;

  // Regular (non-OT) work ends at the shift end; lunch is always unpaid.
  const regularEnd = Math.min(clockOutMin, rules.endMin);
  const regularWorkMin = Math.max(
    0,
    regularEnd - effectiveIn - rules.lunchMin,
  );

  // Overtime past the shift end — clock-out minute floored to a quarter.
  let otMin = 0;
  if (clockOutMin > rules.endMin) {
    const roundedOut =
      Math.floor(clockOutMin / 60) * 60 + roundOutMinute(clockOutMin % 60);
    otMin = Math.max(0, roundedOut - rules.endMin);
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
