// ---------------------------------------------------------------------------
// planning-packer.ts — ONE finite-capacity day packer, shared by every
// department.
//
// Why this exists (owner 2026-08-03): runCutting / runSewing / runWood /
// runFraming are four hand-copied variants of the same loop. Because they were
// copied rather than shared, their units drifted apart — sewing/framing/foam/
// upholstery meter minutes, fabric cutting meters cut slots, wood cutting
// meters sets, packing and webbing meter nothing at all. Every department now
// calls this instead, so the units can never diverge again.
//
// The rules this encodes, in the owner's words:
//
//   1. "不要排得太多导致做不来，也不要排得太少" — a day's budget is the
//      department's MEASURED recent throughput, and packing stops when the day
//      is full. No day is left half empty while work waits behind it, and no
//      day is handed more than the floor has ever actually done.
//
//   2. "不要突然有一天直接开 10 个小时的 OT" — overtime is computed for the
//      WHOLE horizon up front and spread flat across every working day from
//      today to the deadline, capped per day. A single day can never be handed
//      a spike. This mirrors OT_MAX_HOURS_PER_DAY in agent-learning.ts, which
//      already carried the owner's red line ("宁可迟交也不压榨人") but only as
//      advice in the morning brief — it is enforced here, at scheduling time.
//
//   3. When even a flat, fully-spread OT plan cannot make a deadline, the
//      packer does NOT quietly schedule the work late and hope. It reports the
//      shortfall so the latest-promised orders can be renegotiated EARLY.
//
// Pure: no DB, no clock, no Date. The caller supplies the working-day horizon
// as an ordered array of opaque day numbers, so this module is fully testable
// and can never disagree with the calendar its caller already trusts.
//
// ── STATUS (2026-08-03) ─────────────────────────────────────────────────────
// NOT YET WIRED INTO THE ENGINE. planning-chain.ts departments share their
// placement rule through `firstDayWithRoom`, which is the de-duplication this
// module was originally meant to provide; what is still exclusive to here is
// OVERTIME PLANNING and OVERSIZE SPLITTING.
//
// Adopting it is a real behaviour change, not a refactor — it would move the
// dates the floor works to:
//   • units larger than a day would be SPLIT across days instead of being
//     accepted whole onto an empty day (today's soft-ceiling behaviour);
//   • days would be allowed to carry up to +2h of planned OT, so work that
//     currently slides to a later day would stay put instead.
//
// The owner's OT REPORTING is already live by a different route — section 8 of
// the morning brief (agent-learning.ts collectOtSignals) computes the same
// ≤2h/day, spread-flat, start-early plan against measured capacity, and
// section 9 (planning-late-risk.ts) names the promises that cannot be met.
// So nothing the owner asked for is missing; what is missing is OT baked into
// the schedule itself, which deserves its own reviewed change rather than
// riding along with an unrelated one.
// ---------------------------------------------------------------------------

/** One schedulable chunk of work — a job card, or an SO-unit of job cards. */
export interface PackUnit {
  id: string;
  /** Work content. Always MINUTES — the whole point of the shared packer. */
  minutes: number;
  /** Earliest schedulable day (index into the horizon, not a day number). */
  floorIdx: number;
  /**
   * Latest day this may finish on to keep its customer promise (horizon
   * index), from the backward pass. Null when the order carries no date.
   */
  deadlineIdx: number | null;
  /**
   * Sort key, most-urgent first. Callers pass slack-based keys; the packer
   * never invents a priority of its own.
   */
  priority: Array<number | string>;
  /**
   * Optional changeover group (fabric code on the CNC). Units sharing a group
   * placed back-to-back on one day pay the changeover only once.
   */
  groupKey?: string;
}

export interface PackOptions {
  /** Ordered working days. Index i is "the i-th schedulable day from today". */
  horizonLength: number;
  /** Measured throughput, minutes per working day. */
  dailyBudgetMin: number;
  /**
   * Humane ceiling on EXTRA minutes per day. Owner red line: 2h. Spread flat,
   * never spiked. Zero disables overtime entirely.
   */
  otMaxMinPerDay: number;
  /**
   * Minutes lost when consecutive work on a day changes groupKey. Only charged
   * when the group actually changes, so batching earns real time back.
   */
  changeoverMin?: number;
  /**
   * A unit larger than one day's budget is spread across consecutive days
   * instead of blowing a single day open. Off means it takes a whole day and
   * overflows (the legacy escape hatch) — kept only for parity tests.
   */
  splitOversize?: boolean;
}

export interface Placement {
  id: string;
  /** Horizon index the unit was placed on. Split units yield several rows. */
  dayIdx: number;
  minutes: number;
  /** True when this row is one slice of a unit too big for a single day. */
  split: boolean;
}

export interface LateUnit {
  id: string;
  /** The day it actually landed on. */
  dayIdx: number;
  deadlineIdx: number;
  /** Working days past the promise. */
  daysLate: number;
}

export interface PackResult {
  placements: Placement[];
  /** Horizon index → minutes of normal-time work placed. */
  loadByDay: Map<number, number>;
  /** Horizon index → minutes of OT used. Flat by construction. */
  otByDay: Map<number, number>;
  /** Total OT minutes across the horizon. */
  otTotalMin: number;
  /**
   * Units that still miss their deadline after OT was spread. These are the
   * orders to renegotiate — surfaced, never silently absorbed.
   */
  late: LateUnit[];
  /** Units with no room left in the horizon at all. */
  unplaced: string[];
  /** True when a second pass added OT to rescue deadlines. */
  otApplied: boolean;
}

interface DayState {
  used: number;
  lastGroup: string | null;
}

/** Cost of adding `unit` to a day whose last group was `lastGroup`. */
function costOn(unit: PackUnit, day: DayState, changeoverMin: number): number {
  if (!unit.groupKey || changeoverMin <= 0) return unit.minutes;
  // First work of the day pays a changeover too — the machine must be rigged
  // for something regardless of what ran yesterday.
  if (day.lastGroup === unit.groupKey) return unit.minutes;
  return unit.minutes + changeoverMin;
}

/**
 * ONE packing pass at the given per-day budgets. Deterministic: identical
 * inputs always yield identical placements.
 */
function packOnce(
  units: PackUnit[],
  budgets: number[],
  opts: PackOptions,
): {
  placements: Placement[];
  days: DayState[];
  late: LateUnit[];
  unplaced: string[];
} {
  const changeoverMin = opts.changeoverMin ?? 0;
  const splitOversize = opts.splitOversize !== false;
  const days: DayState[] = Array.from({ length: opts.horizonLength }, () => ({
    used: 0,
    lastGroup: null,
  }));
  const placements: Placement[] = [];
  const late: LateUnit[] = [];
  const unplaced: string[] = [];

  for (const unit of units) {
    let remaining = unit.minutes;
    let idx = Math.max(0, unit.floorIdx);
    let placedAny = false;
    let lastDayIdx = -1;
    let guard = 0;

    while (remaining > 0 && idx < opts.horizonLength && guard < opts.horizonLength * 2 + 8) {
      guard++;
      const day = days[idx];
      const budget = budgets[idx] ?? 0;
      const room = budget - day.used;
      if (room <= 0) {
        idx++;
        continue;
      }

      // Charge the changeover once, on the first slice that lands on this day.
      const probe: PackUnit = { ...unit, minutes: remaining };
      const wouldCost = costOn(probe, day, changeoverMin);
      const overhead = wouldCost - remaining;

      if (wouldCost <= room) {
        day.used += wouldCost;
        day.lastGroup = unit.groupKey ?? day.lastGroup;
        placements.push({
          id: unit.id,
          dayIdx: idx,
          minutes: remaining,
          split: placedAny,
        });
        lastDayIdx = idx;
        remaining = 0;
        placedAny = true;
        break;
      }

      if (!splitOversize) {
        // Legacy behaviour: an empty day swallows the unit whole, cap or not.
        if (day.used === 0) {
          day.used += wouldCost;
          day.lastGroup = unit.groupKey ?? day.lastGroup;
          placements.push({ id: unit.id, dayIdx: idx, minutes: remaining, split: false });
          lastDayIdx = idx;
          remaining = 0;
          placedAny = true;
          break;
        }
        idx++;
        continue;
      }

      // Split: take what fits after paying this day's changeover.
      const usable = room - overhead;
      if (usable <= 0) {
        idx++;
        continue;
      }
      day.used += usable + overhead;
      day.lastGroup = unit.groupKey ?? day.lastGroup;
      placements.push({ id: unit.id, dayIdx: idx, minutes: usable, split: true });
      lastDayIdx = idx;
      remaining -= usable;
      placedAny = true;
      idx++;
    }

    if (remaining > 0) {
      unplaced.push(unit.id);
      continue;
    }
    if (unit.deadlineIdx !== null && lastDayIdx > unit.deadlineIdx) {
      late.push({
        id: unit.id,
        dayIdx: lastDayIdx,
        deadlineIdx: unit.deadlineIdx,
        daysLate: lastDayIdx - unit.deadlineIdx,
      });
    }
  }

  return { placements, days, late, unplaced };
}

/**
 * Pack every unit into the horizon.
 *
 * Pass 1 runs at normal capacity. If nothing misses a deadline, that is the
 * answer and no overtime is proposed — overtime is a last resort, not a
 * default. If something WOULD be late, pass 2 spreads the shortfall flat
 * across every working day up to the last affected deadline, capped at
 * otMaxMinPerDay, and re-packs. Spreading is deliberately flat and computed
 * over the whole horizon so no single day is ever handed a spike.
 *
 * Anything still late after that is reported, not hidden: the honest answer is
 * "this cannot be made on time — renegotiate", never a quietly late date.
 */
export function packDepartment(units: PackUnit[], opts: PackOptions): PackResult {
  const sorted = [...units].sort((a, b) => cmpPriority(a.priority, b.priority));
  const base = Array.from({ length: opts.horizonLength }, () => opts.dailyBudgetMin);

  const first = packOnce(sorted, base, opts);
  if (first.late.length === 0 || opts.otMaxMinPerDay <= 0) {
    return finalise(first, base, opts, false);
  }

  // Shortfall = the work that landed past its deadline. Spread it flat from
  // day 0 to the LAST affected deadline so the earliest days carry their share
  // too — starting OT early is the whole point.
  let shortfallMin = 0;
  let lastDeadline = 0;
  for (const l of first.late) {
    const unit = sorted.find((u) => u.id === l.id);
    if (unit) shortfallMin += unit.minutes;
    if (l.deadlineIdx > lastDeadline) lastDeadline = l.deadlineIdx;
  }
  const spreadDays = Math.max(1, Math.min(opts.horizonLength, lastDeadline + 1));
  const perDay = Math.min(opts.otMaxMinPerDay, Math.ceil(shortfallMin / spreadDays));

  const withOt = base.map((b, i) => (i < spreadDays ? b + perDay : b));
  const second = packOnce(sorted, withOt, opts);

  // Only keep the OT plan if it actually bought something.
  if (second.late.length >= first.late.length) {
    return finalise(first, base, opts, false);
  }
  return finalise(second, withOt, opts, true);
}

function finalise(
  run: ReturnType<typeof packOnce>,
  budgets: number[],
  opts: PackOptions,
  otApplied: boolean,
): PackResult {
  const loadByDay = new Map<number, number>();
  const otByDay = new Map<number, number>();
  let otTotalMin = 0;
  run.days.forEach((d, i) => {
    if (d.used <= 0) return;
    const normal = Math.min(d.used, opts.dailyBudgetMin);
    const ot = Math.max(0, d.used - opts.dailyBudgetMin);
    loadByDay.set(i, normal);
    if (ot > 0) {
      otByDay.set(i, ot);
      otTotalMin += ot;
    }
  });
  void budgets;
  return {
    placements: run.placements,
    loadByDay,
    otByDay,
    otTotalMin,
    late: run.late,
    unplaced: run.unplaced,
    otApplied,
  };
}

/** Lexicographic compare over mixed number/string keys. */
export function cmpPriority(a: Array<number | string>, b: Array<number | string>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * Slack in working days: how much room a unit has left before its promise.
 * Negative means the promise is already arithmetically impossible — that is a
 * fact to report today, not a date to quietly push out.
 */
export function slackDays(unit: {
  floorIdx: number;
  deadlineIdx: number | null;
  minutes: number;
}, dailyBudgetMin: number): number | null {
  if (unit.deadlineIdx === null) return null;
  const ownDays = dailyBudgetMin > 0 ? Math.ceil(unit.minutes / dailyBudgetMin) : 1;
  return unit.deadlineIdx - unit.floorIdx - ownDays + 1;
}
