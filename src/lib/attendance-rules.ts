// ---------------------------------------------------------------------------
// Attendance rules — turn a worker's punch in/out into the day's payable work,
// shortfall, and overtime, per Wei Siang's spec (confirmed 2026-06-09).
//
//   • Shift 08:00–18:00, 1 h unpaid lunch → 9 payable work hours. Mon–Sat.
//   • Late: a clock-in within 15 min of 08:00 is forgiven; MORE than 15 min late
//     counts from 08:00 (the grace is a threshold, not a free allowance).
//   • Short: fewer than 9 worked hours → the shortfall is deducted at the hourly
//     rate. Coming late and leaving early are just two ways to fall short — the
//     shortfall is counted ONCE (never a separate late penalty on top).
//   • Overtime: only past 18:00, floored to a COMPLETED quarter — 0–14→0,
//     15–29→15, 30–44→30, 45–59→45. Fifteen minutes worked earns fifteen
//     minutes (HR via owner 2026-08-02). OT minutes feed the × otMultiplier pay.
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
  /** Lateness forgiven up to this many minutes (15). */
  lateGraceMin: number;
  /**
   * Penal lateness rounds UP to blocks of this many minutes.
   *
   * 1 = charge the actual minutes, which is what HR describes (owner
   * 2026-08-02: 「当超过了 15 分钟，就会以分钟来计算，根据具体迟到了多少分钟来
   * 扣钱」). Kept as a rule field rather than deleted because it is
   * effective-dated in pay_rule_versions — historical periods keep whatever
   * they were computed under.
   */
  lateBlockMin: number;
  /**
   * Overtime floors to a completed block of this many minutes (15); less than
   * one block earns nothing. Effective-dated, NOT a constant — see OT_MIN_MINUTES.
   */
  otBlockMin: number;
};

/**
 * Overtime does not start until this many minutes past the shift end.
 *
 * 15, per HR via the owner 2026-08-02: 「只要做满 15 分钟，就会算 15 分钟的 OT
 * … 做 20 分钟只算 15，做 29 分钟也只算 15，做 30 分钟就算 30」. That is exactly
 * floor-to-a-quarter with a 15-minute floor.
 *
 * It was 30 from 2026-07-04 to 2026-08-02, on the strength of a note reading
 * 「OT 要30分鐘才算」 — which turned every 15–29 minute stay into unpaid time.
 * Measured across July's 889 punches, that cost workers 135 minutes of OT over
 * 9 days.
 *
 * Exported because the PUNCH is not the only path to overtime: the payroll
 * engine also derives it from LOGGED HOURS (hours above the worker's standard
 * day), and that path had no minimum at all — so a day recorded as 7.52h
 * against a 7.5h standard paid 1 minute of overtime, and ANN's July payslip
 * printed "0 hrs x RM 13.59 x 1.5 = RM 3.06". One threshold, both paths.
 */
export const OT_MIN_MINUTES = 15;

export const HOOKKA_ATTENDANCE: AttendanceRules = {
  startMin: 8 * 60, // 480
  endMin: 18 * 60, // 1080
  lunchMin: 60,
  lunchStartMin: 12 * 60, // 720 (12:00)
  lunchEndMin: 13 * 60, // 780 (13:00)
  standardWorkMin: 9 * 60, // 540
  lateGraceMin: 15,
  lateBlockMin: 1,
  otBlockMin: 15,
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
export function roundOutMinute(
  minuteOfHour: number,
  blockMin: number = OT_MIN_MINUTES,
): number {
  // Floor to a COMPLETED block. 15 EARNS 15 — HR, via the owner 2026-08-02:
  // 「不满 15 分钟不算，要做满 15 分钟才会算 15 分钟」. The old table returned 0
  // for exactly 15 because a 2026-06-09 note read the rule as "must EXCEED 15",
  // so a worker who stayed to precisely 18:15 was paid nothing for it.
  const b = Math.max(1, Math.round(blockMin) || 1);
  return Math.floor(Math.max(0, minuteOfHour) / b) * b;
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
    // Block size comes from the EFFECTIVE-DATED rules, not a constant, so a
    // change today cannot rewrite what a past month was computed under.
    const block = rules.otBlockMin ?? OT_MIN_MINUTES;
    const roundedOut =
      Math.floor(clockOutMin / 60) * 60 + roundOutMinute(clockOutMin % 60, block);
    otMin = Math.max(0, roundedOut - rules.endMin);
    // Short of one whole block earns nothing, and the tail then also stops
    // offsetting the shortfall — consistent with it not counting as work.
    if (otMin < block) otMin = 0;
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
export function otMinutesAtLeastMinimum(
  surplusMinutes: number,
  /** Block size from the effective-dated rules; defaults to today's 15. */
  blockMin: number = OT_MIN_MINUTES,
): number {
  const block = Math.max(1, Math.round(blockMin) || 1);
  const m = Math.max(0, Math.round(Number(surplusMinutes) || 0));
  // Same shape as the punch path: floor to a completed block, nothing below one.
  return m >= block ? Math.floor(m / block) * block : 0;
}
