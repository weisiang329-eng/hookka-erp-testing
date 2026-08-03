// ===========================================================================
// PHASE 2 — full production-chain scheduler (Fab Cut -> ... -> Packing + Webbing).
//
// A 1:1 TypeScript port of the trusted Python builders (build_{sewing,woodcut,
// framing}_daily_xlsx.py, owner-confirmed Wei Siang 2026-06-01/02), every label
// translated to English. computeChain(input) runs the whole chain ONCE so every
// department shares ONE calendar and consistent floors, then exposes each
// dept's snapshot (English headers, per-SO grouped Calendar + load-vs-cap
// By Day + Summary & Notes).
//
// Production chain & couplings (ported exactly):
//   Fab Cut -> Fab Sew -> Wood Cut -> Framing(+Webbing same-day + HB-foam
//   same-day) -> Foam Bonding(sofa) -> Upholstery -> Packing.
//   - Fab Sew: minutes/day per lane; floor = the line's last cut day +1 wd
//     (day 1 if no cut / cut done). Reports cut-blocked hours per lane-day.
//   - Wood Cut: sets/day per lane; floor = SO's fab-sew end +2 wd. Whole SO same
//     day; all sizes of a model together.
//   - Framing: hours/day per lane; floor = wood-cut day +1. Webbing + HB-foam
//     (wipType HEADBOARD) ride the SAME day (don't consume framing hours).
//   - Foam Bonding (sofa): base+armrest consume an 8h/day cap; back cushion
//     rides the same day uncapped. Floor = sofa framing day +1.
//   - Upholstery: bedframe floor = framing day +1; sofa floor = base foam +1.
//   - Packing: no cap; pack day = SO's upholstery day (same day).
//   - Webbing: no own schedule -- same day as the SO's Framing.
//
// Pure functions: no Hono / DB types. Dates are LOCAL YYYY-MM-DD; all working-
// day math is integer-based. All emitted text is English.
// ===========================================================================
import type { CapacityConfig, ChainConfig, Lane } from "./planning-capacity";
import {
  deptDeadlines,
  durationDays,
  UNDATED_SLACK,
  type ChainDeptId,
  type DeadlineLane,
} from "./planning-deadlines";
import {
  Calendar,
  DOW,
  FAR_DAY,
  dowOf,
  fmtIso,
  fmtMonDayDow,
  parseYmd,
  runCutting,
  type Cell,
  type CutCard,
  type ScheduleSnapshot,
} from "./planning-scheduler";

// ── Public input / output shapes ─────────────────────────────────────────────

/**
 * One normalized WAITING production line handed to the chain. A single line
 * flows through every department its lane participates in; the same object is
 * read by sewing, wood, framing, foam, upholstery and packing.
 */
export type ChainDept =
  | "FAB_SEW"
  | "WOOD_CUT"
  | "FOAM_CUTTING"
  | "FRAMING"
  | "WEBBING"
  | "FOAM"
  | "UPHOLSTERY"
  | "PACKING";

export interface ChainCard {
  /** Which production department this WAITING card belongs to. */
  dept: ChainDept;
  /** "SO / PO" display id (the line, e.g. "SO-2605-171-01"). */
  soPo: string;
  /** Company SO id (the order — several lines share one). */
  soId: string;
  /** Customer name. */
  customer: string;
  /** Full WIP label (one set/row text). */
  label: string;
  /** Fabric / colour code. */
  fabric: string;
  /** Item category → lane (BEDFRAME / SOFA / ACCESSORY). */
  lane: Lane;
  /** Model (size-stripped for bedframe grouping in wood/framing). */
  model: string;
  /** Size label, e.g. "5FT" / "28". May be "". */
  size: string;
  /** Number of sets (>= 1). */
  sets: number;
  /** Per-line production minutes for THIS card's department work. */
  mins: number;
  /** Customer delivery date YYYY-MM-DD, or null when undated. */
  customerDd: string | null;
  /** Hookka expected DD YYYY-MM-DD, or null. */
  expectedDd: string | null;
  /**
   * Part type, used by wood/framing/foam to identify base vs cushion etc.
   * One of: DIVAN | HEADBOARD | SOFA_BASE | SOFA_ARMREST | SOFA_CUSHION | "".
   */
  wipType: string;
  /** True when this line's fabric is already cut (no cut floor needed). */
  /**
   * A FROZEN card's real working day, YYYY-MM-DD, or null when the card is
   * free to be scheduled.
   *
   * schedule-proposals.ts refuses to propose a new date for work already SENT
   * to the floor (`distributedAt`) or due within 3 days — those dates are
   * committed. The engine, however, used to re-plan those cards anyway and
   * charge their minutes to whatever day IT picked. The work then happened on
   * the frozen day while the engine believed that day was free, so the next
   * three days were quietly over-committed — precisely the window where an
   * over-commitment cannot be recovered. A pinned card consumes its capacity
   * on the day it will really be worked.
   */
  pinnedDue: string | null;
  cutDone: boolean;
  /** True when this line has no fabric-cut step at all. */
  noCutStep: boolean;
}

/**
 * Machine-readable (card, day) assignment emitted to an optional collector
 * (Phase 2 due-date proposals). `date` is the LOCAL YYYY-MM-DD working day the
 * engine scheduled this card's department work on (for FAB_CUT: the batch's
 * last cut day, same coupling as cutLastDay).
 */
export interface ChainAssignment {
  dept: ChainDept | "FAB_CUT";
  soPo: string;
  /** Company SO id; "" for FAB_CUT cards (CutCard carries no soId). */
  soId: string;
  lane: string;
  fabric: string;
  sets: number;
  date: string;
  /** The exact input card object — an identity key for caller-side maps. */
  card: ChainCard | CutCard;
}

export interface ChainInput {
  /** WAITING FAB_CUT cards (lane BEDFRAME/SOFA/ACCESSORY) — the cutting input. */
  cutCards: CutCard[];
  /** WAITING production lines for the downstream chain (one row per card). */
  chainCards: ChainCard[];
  config: CapacityConfig;
  holidays: string[];
  startDate: string;
  generatedAt: string;
  /**
   * OPTIONAL collector — called once per scheduled (card, day) across ALL
   * departments after the chain is computed. Purely additive: when omitted
   * (every pre-Phase-2 call site) the run is byte-identical.
   */
  collect?: (a: ChainAssignment) => void;
  /**
   * OPTIONAL measured daily budget per department, in MINUTES
   * (planning-adaptive-capacity.ts). computeChain is pure, so the caller
   * resolves this from the database and passes it in.
   *
   * A department present here is scheduled against what the floor has actually
   * been producing; a department absent falls back to its hardcoded constant in
   * `config`. Omitting the field entirely reproduces the legacy run exactly.
   */
  dailyBudgetByDept?: Record<string, number>;
}

export interface ChainOutput {
  cutting: ScheduleSnapshot;
  sewing: ScheduleSnapshot;
  woodCutting: ScheduleSnapshot;
  framing: ScheduleSnapshot;
  foamBonding: ScheduleSnapshot;
  upholstery: ScheduleSnapshot;
  packing: ScheduleSnapshot;
  webbing: ScheduleSnapshot;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Downstream production lanes (pillows only sew). */
type ChainLane = "BEDFRAME" | "SOFA";
const CHAIN_LANES: ChainLane[] = ["BEDFRAME", "SOFA"];
const SEW_LANE_ORDER: Lane[] = ["BEDFRAME", "SOFA", "ACCESSORY"];
const SEW_LANE_LABEL: Record<Lane, string> = {
  BEDFRAME: "Bedframe",
  SOFA: "Sofa",
  ACCESSORY: "Pillow",
};
const LANE_LABEL: Record<ChainLane, string> = { BEDFRAME: "Bedframe", SOFA: "Sofa" };

function ddKey(s: string | null): number {
  return s ? (parseYmd(s) ?? FAR_DAY) : FAR_DAY;
}

/** Round to 1 decimal place (hours), avoiding -0. */
function round1(n: number): number {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? 0 : r;
}

/** Lexicographic compare of (number|string) key tuples. */
function cmpKey(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ── Measured daily budgets ──────────────────────────────────────────────────
//
// A department's minute budget comes from planning-adaptive-capacity.ts when
// the caller supplied one, and from the hardcoded constant otherwise. The
// adaptive figure is ONE number for the whole department, but sewing, framing
// and upholstery hold SEPARATE per-lane budgets so bedframe volume can never
// starve sofa. Splitting the measured total in the same proportion as the
// configured lane caps keeps that protection intact while scaling the total to
// what the floor actually does.
//
// A department with no measured value, or a configured split that sums to
// zero, falls straight back to its constant — never to zero.
function laneBudget(
  budgets: Record<string, number> | undefined,
  dept: string,
  configuredForLane: number,
  configuredTotal: number,
): number {
  const measured = budgets?.[dept];
  if (measured === undefined || !Number.isFinite(measured) || measured <= 0) {
    return configuredForLane;
  }
  if (configuredTotal <= 0) return configuredForLane;
  return Math.max(1, Math.round(measured * (configuredForLane / configuredTotal)));
}

/** Whole-department budget (no lane split), falling back to the constant. */
function deptBudget(
  budgets: Record<string, number> | undefined,
  dept: string,
  configured: number,
): number {
  const measured = budgets?.[dept];
  if (measured === undefined || !Number.isFinite(measured) || measured <= 0) return configured;
  return Math.max(1, Math.round(measured));
}

// ── Slack priority ──────────────────────────────────────────────────────────
//
// Departments used to queue on raw customer delivery date, which cannot tell
// an order with six departments left from one that only needs packing when
// both are due the same day — it broke the tie on the SO reference string.
//
// SLACK is the working days of room left once the backward pass says when this
// department must be finished. Smaller is more urgent, negative means the
// promise is already arithmetically impossible, and it is self-correcting: an
// order that slips loses slack and climbs the queue with nobody expediting it.
//
// Undated work sorts behind every dated order (UNDATED_SLACK) — it has made no
// promise, so it may never displace one.
function slackFor(
  cal: Calendar,
  chain: ChainConfig,
  dept: ChainDeptId,
  lane: ChainLane | Lane,
  cdd: number,
  floor: number,
  minutes: number,
  dailyBudgetMin: number,
): number {
  if (cdd === FAR_DAY) return UNDATED_SLACK;
  const deadline = deptDeadlines({
    customerDd: cdd,
    lane: (lane === "SOFA" ? "SOFA" : lane === "BEDFRAME" ? "BEDFRAME" : "ACCESSORY") as DeadlineLane,
    chain,
    backWorkday: (day, n) => cal.backWorkday(day, n),
  })[dept];
  if (deadline === null) return UNDATED_SLACK;
  return deadline - floor - durationDays(minutes, dailyBudgetMin) + 1;
}

/**
 * The committed day for a group of cards, or null when none is frozen.
 *
 * A unit whose work is already promised to a day must be PLACED there and must
 * consume that day's capacity, rather than being re-planned somewhere the
 * engine finds convenient. Mixed units take the EARLIEST pinned day: the unit
 * moves together, and the frozen card is the one whose date cannot slip.
 */
function pinnedDayOf(cards: ChainCard[], cal: Calendar): number | null {
  let best: number | null = null;
  for (const c of cards) {
    if (!c.pinnedDue) continue;
    const d = parseYmd(c.pinnedDue);
    if (d === null) continue;
    const clamped = Math.max(d, cal.day1);
    if (best === null || clamped < best) best = clamped;
  }
  return best;
}

/**
 * The day a unit should occupy: THE one piece of placement logic, shared by
 * every department instead of hand-copied into each.
 *
 * Two rules live here and both are easy to get subtly wrong in a copy:
 *
 *   • a PINNED unit owns its day outright — committed work is not re-planned,
 *     and it charges its capacity where it will really be worked;
 *   • an EMPTY day accepts a unit however oversized it is. Without that escape
 *     the walk never terminates for any unit bigger than a day's budget. It is
 *     deliberate, not an oversight: it is also why capacity is a soft ceiling
 *     rather than a hard one.
 *
 * Does NOT charge the load — callers do, because sewing distributes a group's
 * cards across days after choosing the start.
 */
function firstDayWithRoom(
  cal: Calendar,
  load: Map<number, number>,
  cost: number,
  cap: number,
  floor: number,
  pin: number | null,
): number {
  if (pin !== null) return pin;
  let d = Math.max(floor, cal.day1);
  let guard = 0;
  while ((load.get(d) ?? 0) + cost > cap && (load.get(d) ?? 0) !== 0 && guard < 3650) {
    d = cal.stepWorkday(d);
    guard++;
  }
  return d;
}

// ── Planned overtime ────────────────────────────────────────────────────────
//
// Owner red line (2026-08-03): "不要突然有一天直接开 10 个小时的 OT，一个工作
// 人员怎么能一天连续做 20 个小时呢？所以你一定要提前把 OT 分摊开."
//
// So overtime is never decided day-by-day as the packer walks. Each department
// packs ONCE at normal capacity; only if something then lands past its promise
// is a shortfall computed for the WHOLE horizon and spread FLAT across every
// working day up to the last affected deadline, capped per day. The department
// is then re-packed against those raised budgets. A single day can therefore
// never be handed a spike, and the extra hours start immediately rather than
// piling up in front of the deadline.
//
// Matches OT_MAX_HOURS_PER_DAY in agent-learning.ts, which the morning brief
// already reports against — the schedule and the brief must not disagree about
// what "humane OT" means.
const OT_MAX_MIN_PER_DAY = 120;

/** Latest day this unit may run and still keep its promise (backward pass). */
function deadlineFor(
  cal: Calendar,
  chain: ChainConfig,
  dept: ChainDeptId,
  lane: ChainLane | Lane,
  cdd: number,
): number | null {
  if (cdd === FAR_DAY) return null;
  return deptDeadlines({
    customerDd: cdd,
    lane: (lane === "SOFA" ? "SOFA" : lane === "BEDFRAME" ? "BEDFRAME" : "ACCESSORY") as DeadlineLane,
    chain,
    backWorkday: (day, n) => cal.backWorkday(day, n),
  })[dept];
}

/**
 * Flat OT minutes per day needed to pull `shortfallMin` of work back inside
 * the deadlines, spread over `spreadDays` working days and capped.
 *
 * Deliberately flat and horizon-wide: the point is that no day is special.
 */
function otPerDay(shortfallMin: number, spreadDays: number): number {
  if (shortfallMin <= 0 || spreadDays <= 0) return 0;
  return Math.min(OT_MAX_MIN_PER_DAY, Math.ceil(shortfallMin / spreadDays));
}

interface OtPlaceable {
  cost: number;
  floor: number;
  pin: number | null;
  deadline: number | null;
}

/**
 * Place every unit, adding humane overtime ONLY if the normal-capacity pass
 * would miss a promise.
 *
 * Units are NOT split across days — "a whole SO is cut the same day, never
 * split" is an explicit grouping rule of this engine, so the packer's
 * oversize-splitting is deliberately not adopted here.
 *
 * Returns the OT actually planned per day so the caller can surface it.
 */
function placeUnitsWithOt<T>(
  units: T[],
  cal: Calendar,
  cap: number,
  load: Map<number, number>,
  read: (u: T) => OtPlaceable,
  assign: (u: T, day: number) => void,
): Map<number, number> {
  const run = (budget: (day: number) => number): { late: T[]; lastDeadline: number } => {
    load.clear();
    const late: T[] = [];
    let lastDeadline = cal.day1;
    for (const u of units) {
      const p = read(u);
      let d = p.pin ?? Math.max(p.floor, cal.day1);
      let guard = 0;
      while (
        p.pin === null &&
        (load.get(d) ?? 0) + p.cost > budget(d) &&
        (load.get(d) ?? 0) !== 0 &&
        guard < 3650
      ) {
        d = cal.stepWorkday(d);
        guard++;
      }
      assign(u, d);
      load.set(d, (load.get(d) ?? 0) + p.cost);
      if (p.deadline !== null && d > p.deadline) {
        late.push(u);
        if (p.deadline > lastDeadline) lastDeadline = p.deadline;
      }
    }
    return { late, lastDeadline };
  };

  const first = run(() => cap);
  if (first.late.length === 0) return new Map();

  const shortfall = first.late.reduce((s, u) => s + read(u).cost, 0);
  const spreadDays = Math.max(1, cal.workdayIndex(first.lastDeadline));
  const perDay = otPerDay(shortfall, spreadDays);
  if (perDay <= 0) return new Map();

  const second = run((day) => (cal.workdayIndex(day) <= spreadDays ? cap + perDay : cap));
  // Keep the OT plan only when it actually rescued something.
  if (second.late.length >= first.late.length) {
    run(() => cap);
    return new Map();
  }

  const ot = new Map<number, number>();
  for (const [day, used] of load) {
    const over = used - cap;
    if (over > 0) ot.set(day, Math.min(over, perDay));
  }
  return ot;
}

/** The measured value for a department, or null when there isn't a usable one. */
function measuredMinutes(
  budgets: Record<string, number> | undefined,
  dept: string,
): number | null {
  const m = budgets?.[dept];
  return m !== undefined && Number.isFinite(m) && m > 0 ? m : null;
}

const SIZE_SUFFIX = /-\((SS|SK|K|Q|S)\)\s*$/;
/** Size-stripped model key for bedframe (all sizes of a model group together). */
function normModel(card: ChainCard): string {
  let m = (card.model || "").trim();
  if (card.lane === "BEDFRAME") m = m.replace(SIZE_SUFFIX, "");
  return m || "(none)";
}

// =============================================================================
// FABRIC SEWING
// =============================================================================
// Per-crew minutes/day; whole SO sewn together; cdd-first; pack each day full;
// floor = the line's last cut day + handoff (day 1 if cut done / no cut step).
// Reports per lane-day the cut-blocked minutes (spare crew waiting on cutting).

interface SewCard {
  card: ChainCard;
  sewMins: number;
  floor: number;
  reason: "cut-done" | "no-cut-step" | "cut-pending-unplanned" | "after-cut";
  day: number;
}
interface SewGroup {
  so: string;
  cards: SewCard[];
  mins: number;
  floor: number;
  cdd: number;
  start: number;
  end: number;
}
interface SewResult {
  byLane: Record<Lane, SewCard[]>;
  groupsByLane: Record<Lane, SewGroup[]>;
  loadByLane: Record<Lane, Map<number, number>>;
  /** soId → last sew day-number (whole-order finish). */
  sewEnd: Map<string, number>;
}

function runSewing(
  chainCards: ChainCard[],
  cal: Calendar,
  chain: ChainConfig,
  cutLastDay: Map<string, number>,
  budgets?: Record<string, number>,
): SewResult {
  const byLane: Record<Lane, SewCard[]> = { BEDFRAME: [], SOFA: [], ACCESSORY: [] };
  for (const c of chainCards) {
    if (c.dept !== "FAB_SEW") continue;
    const lane: Lane = (["BEDFRAME", "SOFA", "ACCESSORY"] as Lane[]).includes(c.lane)
      ? c.lane
      : "ACCESSORY";
    let mins = c.mins;
    if (lane === "ACCESSORY") mins = chain.pillowMinEach * c.sets;
    let floor: number;
    let reason: SewCard["reason"];
    if (c.noCutStep) {
      floor = cal.day1;
      reason = "no-cut-step";
    } else if (c.cutDone) {
      floor = cal.day1;
      reason = "cut-done";
    } else {
      const cd = cutLastDay.get(c.soPo);
      if (cd === undefined) {
        floor = cal.day1;
        reason = "cut-pending-unplanned";
      } else {
        floor = cal.addWorkdays(cd, chain.sewHandoffDays);
        reason = "after-cut";
      }
    }
    byLane[lane].push({ card: c, sewMins: mins, floor, reason, day: cal.day1 });
  }

  const groupsByLane: Record<Lane, SewGroup[]> = { BEDFRAME: [], SOFA: [], ACCESSORY: [] };
  const loadByLane: Record<Lane, Map<number, number>> = {
    BEDFRAME: new Map(),
    SOFA: new Map(),
    ACCESSORY: new Map(),
  };
  const sewConfiguredTotal =
    chain.sewCapMin.BEDFRAME + chain.sewCapMin.SOFA + chain.sewCapMin.ACCESSORY;
  const capOf = (lane: Lane): number =>
    laneBudget(
      budgets,
      "FAB_SEW",
      chain.sewCapMin[lane as keyof ChainConfig["sewCapMin"]] ?? 0,
      sewConfiguredTotal,
    );

  for (const lane of SEW_LANE_ORDER) {
    const groups = new Map<string, SewCard[]>();
    for (const c of byLane[lane]) {
      const arr = groups.get(c.card.soId) ?? [];
      arr.push(c);
      groups.set(c.card.soId, arr);
    }
    const glist: SewGroup[] = [];
    for (const [so, cs] of groups) {
      glist.push({
        so,
        cards: cs,
        mins: cs.reduce((a, c) => a + c.sewMins, 0),
        floor: cs.reduce((a, c) => Math.max(a, c.floor), cal.day1),
        cdd: cs.reduce((a, c) => Math.min(a, ddKey(c.card.customerDd)), FAR_DAY),
        start: cal.day1,
        end: cal.day1,
      });
    }
    const load = loadByLane[lane];
    const cap = capOf(lane);
    const sl = (g: SewGroup): number =>
      slackFor(cal, chain, "FAB_SEW", lane, g.cdd, g.floor, g.mins, cap);
    // COMMITTED groups are placed first so they claim their day BEFORE free
    // work competes for it — otherwise free work takes the slot and the pinned
    // group lands on top of it, which is the double-booking this fixes.
    // Ties then break on the bigger job first (-mins): with equal urgency the
    // harder group should claim the day before small work fragments it.
    const pinRank = (g: SewGroup): number =>
      pinnedDayOf(g.cards.map((c) => c.card), cal) === null ? 1 : 0;
    glist.sort((a, b) =>
      cmpKey([pinRank(a), sl(a), a.cdd, -a.mins], [pinRank(b), sl(b), b.cdd, -b.mins]),
    );
    for (const g of glist) {
      const pin = pinnedDayOf(g.cards.map((c) => c.card), cal);
      const d = firstDayWithRoom(cal, load, g.mins, cap, g.floor, pin);
      g.start = d;
      let cur = d;
      let room = cap - (load.get(cur) ?? 0);
      for (const c of [...g.cards].sort((x, y) => y.sewMins - x.sewMins)) {
        // A committed group never spills onto a later day — its date is fixed.
        while (pin === null && room < c.sewMins && (load.get(cur) ?? 0) > 0) {
          cur = cal.stepWorkday(cur);
          room = cap - (load.get(cur) ?? 0);
        }
        c.day = cur;
        load.set(cur, (load.get(cur) ?? 0) + c.sewMins);
        room -= c.sewMins;
      }
      g.end = cur;
    }
    groupsByLane[lane] = glist;
  }

  const sewEnd = new Map<string, number>();
  for (const lane of SEW_LANE_ORDER) {
    for (const g of groupsByLane[lane]) {
      if (!g.so) continue;
      const prev = sewEnd.get(g.so);
      if (prev === undefined || g.end > prev) sewEnd.set(g.so, g.end);
    }
  }
  return { byLane, groupsByLane, loadByLane, sewEnd };
}

/** Minutes of work whose fabric isn't cut yet on day d but is already due. */
function sewBlockedMin(cards: SewCard[], d: number): number {
  let blocked = 0;
  for (const c of cards) {
    if (c.floor > d && c.card.customerDd) {
      const dd = parseYmd(c.card.customerDd);
      if (dd !== null && dd <= d) blocked += c.sewMins;
    }
  }
  return blocked;
}

function renderSewing(
  sew: SewResult,
  cal: Calendar,
  chain: ChainConfig,
  generatedAt: string,
  cutLastDay: Map<string, number>,
  budgets?: Record<string, number>,
): ScheduleSnapshot {
  // MUST match the budget runSewing packed against, or the sheet's
  // load-vs-capacity column reports against a capacity nobody scheduled to.
  const sewConfiguredTotal =
    chain.sewCapMin.BEDFRAME + chain.sewCapMin.SOFA + chain.sewCapMin.ACCESSORY;
  const capOf = (lane: Lane): number =>
    laneBudget(
      budgets,
      "FAB_SEW",
      chain.sewCapMin[lane as keyof ChainConfig["sewCapMin"]] ?? 0,
      sewConfiguredTotal,
    );

  // Upstream (Fabric Cutting) day for one sewing line, matched on its PO/Line
  // key (soPo). Display only — does not feed any scheduling math.
  const upstreamDate = (c: SewCard): Cell => {
    const cd = cutLastDay.get(c.card.soPo);
    return cd !== undefined ? fmtMonDayDow(cd) : "—";
  };

  const calHeaders: Cell[] = [
    "Lane",
    "SO ID",
    "Customer",
    "Model",
    "Size",
    "PO / Line",
    "Item",
    "Qty",
    "Mins",
    "Customer DD",
    "Fabric",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];
  const REASON_LABEL: Record<SewCard["reason"], string> = {
    "cut-done": "Cut done",
    "no-cut-step": "No cut (ready fabric)",
    "cut-pending-unplanned": "Cut pending (soon)",
    "after-cut": "Waiting for fabric",
  };

  interface Flat {
    day: number;
    li: number;
    lane: Lane;
    c: SewCard;
  }
  const allc: Flat[] = [];
  SEW_LANE_ORDER.forEach((lane, li) => {
    for (const c of sew.byLane[lane]) allc.push({ day: c.day, li, lane, c });
  });
  allc.sort((a, b) =>
    cmpKey(
      [a.day, a.li, a.c.card.soId || "", -a.c.sewMins],
      [b.day, b.li, b.c.card.soId || "", -b.c.sewMins],
    ),
  );

  let curDate = -1;
  let curSo = "";
  for (const { day, lane, c } of allc) {
    if (day !== curDate) {
      curDate = day;
      curSo = "\u0000";
      const tag = SEW_LANE_ORDER.map((l) => {
        const placed = sew.loadByLane[l].get(day) ?? 0;
        return placed
          ? `${SEW_LANE_LABEL[l]} ${round1(placed / 60)}/${Math.round(capOf(l) / 60)}h`
          : "";
      })
        .filter(Boolean)
        .join("  ");
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(day)}  ${DOW[dowOf(day)]}   (Day ${cal.dayLabelNum(day)})${
        tag ? `   ${tag}` : ""
      }`;
      calRows.push(sep);
    }
    const first = c.card.soId !== curSo;
    curSo = c.card.soId;
    calRows.push([
      first ? SEW_LANE_LABEL[lane] : "",
      first ? c.card.soId : "",
      first ? c.card.customer : "",
      c.card.model,
      c.card.size,
      c.card.soPo,
      c.card.label,
      c.card.sets,
      c.sewMins,
      c.card.customerDd ?? "",
      REASON_LABEL[c.reason],
      upstreamDate(c),
    ]);
  }

  const byDayHeaders: Cell[] = [
    "Date",
    "Day",
    "Lane",
    "SOs that day",
    "Cards",
    "Load h",
    "Cap h",
    "Use %",
    "Tier",
    "Cut-blocked h",
  ];
  const byDayRows: Cell[][] = [byDayHeaders];
  const perday: Record<Lane, Map<number, SewCard[]>> = {
    BEDFRAME: new Map(),
    SOFA: new Map(),
    ACCESSORY: new Map(),
  };
  for (const lane of SEW_LANE_ORDER) {
    for (const c of sew.byLane[lane]) {
      const arr = perday[lane].get(c.day) ?? [];
      arr.push(c);
      perday[lane].set(c.day, arr);
    }
  }
  const allDays = new Set<number>();
  for (const lane of SEW_LANE_ORDER) for (const d of perday[lane].keys()) allDays.add(d);
  for (const d of [...allDays].sort((a, b) => a - b)) {
    for (const lane of SEW_LANE_ORDER) {
      const cs = perday[lane].get(d);
      if (!cs) continue;
      const load = cs.reduce((a, c) => a + c.sewMins, 0);
      const cap = capOf(lane);
      const sos = [...new Set(cs.map((c) => c.card.soId))].sort();
      const blocked = sewBlockedMin(sew.byLane[lane], d);
      byDayRows.push([
        `${fmtIso(d)} ${DOW[dowOf(d)]}`,
        cal.dayLabelNum(d),
        SEW_LANE_LABEL[lane],
        sos.join(", "),
        cs.length,
        round1(load / 60),
        round1(cap / 60),
        cap ? `${Math.round((load / cap) * 100)}%` : "",
        "Packed",
        blocked ? round1(blocked / 60) : "",
      ]);
    }
  }

  const notes: string[] = [
    "Fabric Sewing - Day-by-Day Schedule",
    `Generated ${generatedAt} as a live recompute, scheduled on top of the cutting calendar -`,
    "fabric must be cut before it can be sewn. Read-only - nothing written to the ERP.",
    "",
    "[Capacity per day, per crew]",
    `  Sofa ${Math.round(capOf("SOFA") / 60)} h/day, Bedframe ${Math.round(
      capOf("BEDFRAME") / 60,
    )} h/day, Pillow ${chain.pillowMinEach} min/pc.`,
    "  Sofa and bedframe are two separate crews with two separate daily buckets.",
    "",
    "[How it's planned]",
    "  - Priority by Customer DD (earliest promise sewn first); a whole SO sews together.",
    "  - Each day packed to full capacity, no reserve buffer; a group bigger than a day spills forward.",
    "",
    "[Cut -> Sew handoff]",
    "  - Fabric already cut / no cut step -> can sew from day 1.",
    `  - Fabric still to be cut -> sew floor = (that line's last cut day) + ${chain.sewHandoffDays} working day.`,
    "",
    "[Cut-blocked signal]",
    "  - Each lane-day reports spare crew hours idle only because remaining cards still wait on cutting.",
    "",
    "[Resulting spans]",
  ];
  for (const lane of SEW_LANE_ORDER) {
    const gs = sew.groupsByLane[lane];
    if (gs.length) {
      const a = Math.min(...gs.map((g) => g.start));
      const b = Math.max(...gs.map((g) => g.end));
      notes.push(
        `  ${SEW_LANE_LABEL[lane].padEnd(10)} ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${
          gs.length
        } SOs / ${sew.byLane[lane].length} cards`,
      );
    }
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Fabric Sewing",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Sew Calendar": calRows,
      "By Day": byDayRows,
    },
  };
}

// =============================================================================
// WOOD CUTTING
// =============================================================================
// Whole SO cut on the same day; all sizes of a model together; cdd-first then
// floor; floor = SO's fab-sew end + handoff. Capacity in sets/day per lane.

interface WoodUnit {
  so: string;
  lane: ChainLane;
  cards: ChainCard[];
  sets: number;
  /** Work content in MINUTES — used when a measured budget is available. */
  wmin: number;
  cdd: number;
  models: string[];
  sizes: string[];
  floor: number;
  sewDone: number | null;
  modelKey: string;
  day: number;
}
interface WoodResult {
  byLane: Record<ChainLane, WoodUnit[]>;
  loadByLane: Record<ChainLane, Map<number, number>>;
  /** (soId, lane) → wood-cut day-number. */
  woodDay: Map<string, number>;
  /** True when this run packed by minutes rather than the legacy sets/day. */
  inMinutes: boolean;
  /** The budgets this run packed against — the renderer must reuse them. */
  budgets?: Record<string, number>;
}

/** A unit's set count: count base cards if present, else distinct lines. */
function unitSets(cards: ChainCard[], lane: ChainLane): number {
  const baseType = lane === "BEDFRAME" ? "DIVAN" : "SOFA_BASE";
  const base = cards.filter((c) => c.wipType === baseType);
  if (base.length) return base.reduce((a, c) => a + Math.max(1, c.sets), 0);
  return new Set(cards.map((c) => c.soPo)).size;
}

function runWood(
  chainCards: ChainCard[],
  cal: Calendar,
  chain: ChainConfig,
  sewEnd: Map<string, number>,
  budgets?: Record<string, number>,
): WoodResult {
  const byUnit = new Map<string, ChainCard[]>();
  for (const c of chainCards) {
    if (c.dept !== "WOOD_CUT") continue;
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const key = `${c.soId}|${c.lane}`;
    const arr = byUnit.get(key) ?? [];
    arr.push(c);
    byUnit.set(key, arr);
  }
  const byLane: Record<ChainLane, WoodUnit[]> = { BEDFRAME: [], SOFA: [] };
  for (const [key, cards] of byUnit) {
    const [so, laneStr] = key.split("|");
    const lane = laneStr as ChainLane;
    const sd = sewEnd.get(so);
    const floor = sd !== undefined ? cal.addWorkdays(sd, chain.woodHandoffDays) : cal.day1;
    const cdds = cards
      .map((c) => c.customerDd)
      .filter((x): x is string => !!x)
      .sort();
    const models = [...new Set(cards.map((c) => normModel(c)))].sort();
    const sizes = [...new Set(cards.map((c) => (c.size || "").trim()).filter(Boolean))].sort();
    byLane[lane].push({
      so,
      lane,
      cards,
      sets: unitSets(cards, lane),
      wmin: cards.reduce((a, c) => a + c.mins, 0),
      cdd: cdds.length ? (parseYmd(cdds[0]) ?? FAR_DAY) : FAR_DAY,
      models,
      sizes,
      floor,
      sewDone: sd ?? null,
      modelKey: models.length ? models[0] : "",
      day: cal.day1,
    });
  }

  const loadByLane: Record<ChainLane, Map<number, number>> = {
    BEDFRAME: new Map(),
    SOFA: new Map(),
  };
  const woodDay = new Map<string, number>();
  // Wood cutting is the one downstream department budgeted in SETS rather than
  // minutes. With a measured budget available it switches to minutes like every
  // other department; without one it keeps the legacy sets/day behaviour so an
  // un-measured install is unchanged. `woodInMinutes` also drives the By Day
  // sheet's units, so the displayed capacity always matches what was packed.
  const woodConfiguredSets = chain.woodCapSets.BEDFRAME + chain.woodCapSets.SOFA;
  const woodInMinutes = measuredMinutes(budgets, "WOOD_CUT") !== null;
  for (const lane of CHAIN_LANES) {
    const us = byLane[lane];
    const cap = woodInMinutes
      ? laneBudget(budgets, "WOOD_CUT", chain.woodCapSets[lane], woodConfiguredSets)
      : chain.woodCapSets[lane];
    // Slack needs the day budget to know how long a unit occupies, so the cap
    // is resolved before the sort, not after it.
    const sl = (u: WoodUnit): number =>
      slackFor(cal, chain, "WOOD_CUT", lane, u.cdd, u.floor, u.wmin, cap);
    const pr = (u: WoodUnit): number => (pinnedDayOf(u.cards, cal) === null ? 1 : 0);
    us.sort((a, b) =>
      cmpKey([pr(a), sl(a), a.cdd, a.modelKey, a.so], [pr(b), sl(b), b.cdd, b.modelKey, b.so]),
    );
    const load = loadByLane[lane];
    // OT applies only to a MINUTES budget — a sets/day cap has no hours to add.
    placeUnitsWithOt(
      us,
      cal,
      cap,
      load,
      (u) => ({
        cost: woodInMinutes ? u.wmin : u.sets,
        floor: u.floor,
        pin: pinnedDayOf(u.cards, cal),
        deadline: woodInMinutes ? deadlineFor(cal, chain, "WOOD_CUT", lane, u.cdd) : null,
      }),
      (u, d) => {
        u.day = d;
      },
    );
    for (const u of us) woodDay.set(`${u.so}|${u.lane}`, u.day);
  }
  return { byLane, loadByLane, woodDay, inMinutes: woodInMinutes, budgets };
}

function renderWood(
  wood: WoodResult,
  cal: Calendar,
  chain: ChainConfig,
  generatedAt: string,
): ScheduleSnapshot {
  const calHeaders: Cell[] = [
    "Cut Date",
    "Lane",
    "SO ID",
    "Model",
    "Sizes",
    "Item",
    "Pieces",
    "Sets",
    "Customer",
    "Customer DD",
    "Sew done",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];

  interface Flat {
    day: number;
    li: number;
    u: WoodUnit;
  }
  const allu: Flat[] = [];
  CHAIN_LANES.forEach((lane, li) => {
    for (const u of wood.byLane[lane]) allu.push({ day: u.day, li, u });
  });
  allu.sort((a, b) =>
    cmpKey([a.day, a.li, a.u.modelKey, a.u.so], [b.day, b.li, b.u.modelKey, b.u.so]),
  );

  let curDate = -1;
  for (const { u } of allu) {
    if (u.day !== curDate) {
      curDate = u.day;
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(u.day)}  ${DOW[dowOf(u.day)]}   (Day ${cal.dayLabelNum(u.day)})`;
      calRows.push(sep);
    }
    const modelsTxt = u.models.join(" + ");
    const sizesTxt = u.sizes.join(" / ");
    const sewTxt = u.sewDone !== null ? fmtMonDayDow(u.sewDone) : "Done / no sew";
    // Upstream (Fabric Sewing) day for this whole SO unit. Display only.
    const upTxt = u.sewDone !== null ? fmtMonDayDow(u.sewDone) : "—";
    u.cards.forEach((c, i) => {
      const first = i === 0;
      calRows.push([
        "",
        first ? LANE_LABEL[u.lane] : "",
        first ? u.so : "",
        first ? modelsTxt : "",
        first ? sizesTxt : "",
        c.label || c.model,
        Math.max(1, c.sets),
        first ? u.sets : "",
        first ? c.customer : "",
        c.customerDd ?? "",
        first ? sewTxt : "",
        first ? upTxt : "",
      ]);
    });
  }

  // Headers name the unit actually packed against, so the Load / Cap pair can
  // never be read in the wrong unit.
  const woodConfiguredSets = chain.woodCapSets.BEDFRAME + chain.woodCapSets.SOFA;
  const woodDisplayCap = (lane: ChainLane): number =>
    wood.inMinutes
      ? laneBudget(wood.budgets, "WOOD_CUT", chain.woodCapSets[lane], woodConfiguredSets)
      : chain.woodCapSets[lane];
  const byDayHeaders: Cell[] = [
    "Date",
    "Day",
    "Lane",
    "SOs that day",
    "SOs",
    wood.inMinutes ? "Load min" : "Sets",
    wood.inMinutes ? "Cap min" : "Cap",
  ];
  const byDayRows: Cell[][] = [byDayHeaders];
  const perday: Record<ChainLane, Map<number, WoodUnit[]>> = { BEDFRAME: new Map(), SOFA: new Map() };
  for (const lane of CHAIN_LANES) {
    for (const u of wood.byLane[lane]) {
      const arr = perday[lane].get(u.day) ?? [];
      arr.push(u);
      perday[lane].set(u.day, arr);
    }
  }
  const allDays = new Set<number>();
  for (const lane of CHAIN_LANES) for (const d of perday[lane].keys()) allDays.add(d);
  for (const d of [...allDays].sort((a, b) => a - b)) {
    for (const lane of CHAIN_LANES) {
      const us = perday[lane].get(d);
      if (!us) continue;
      const txt = us.map((u) => `${u.so}(${u.models.join("+")})`).join(", ");
      byDayRows.push([
        `${fmtIso(d)} ${DOW[dowOf(d)]}`,
        cal.dayLabelNum(d),
        LANE_LABEL[lane],
        txt,
        us.length,
        wood.inMinutes
          ? us.reduce((a, u) => a + u.wmin, 0)
          : us.reduce((a, u) => a + u.sets, 0),
        woodDisplayCap(lane),
      ]);
    }
  }

  const notes: string[] = [
    "Wood Cutting - Day-by-Day Schedule",
    `Generated ${generatedAt} as a live recompute. Wood cutting runs after fabric sewing for each order.`,
    "Read-only - nothing written to the ERP.",
    "",
    "[Chain]",
    "  Fabric Cutting -> Fabric Sewing -> Wood Cutting. Each stage runs after the previous one finishes.",
    `  Floor = (that SO's fabric-sew done day) + ${chain.woodHandoffDays} working days (1 clear buffer day).`,
    "  Orders whose sewing is already done / has no sew step start from day 1.",
    "",
    wood.inMinutes ? "[Capacity in minutes/day per lane — measured]" : "[Capacity in sets/day per lane]",
    wood.inMinutes
      ? `  Bedframe ${woodDisplayCap("BEDFRAME")} min/day, Sofa ${woodDisplayCap("SOFA")} min/day — derived from the last 7 working days of actual output. Two separate lanes.`
      : `  Bedframe ${chain.woodCapSets.BEDFRAME} sets/day, Sofa ${chain.woodCapSets.SOFA} sets/day. Two separate lanes.`,
    "",
    "[Grouping]",
    "  A whole SO is cut the same day, never split (sofa carries base + arms + back cushion together).",
    "  All sizes of a model are cut together; same models sit adjacent where the floor allows.",
    "",
    "[Priority] earliest Customer DD first, then earliest ready (sew-done floor).",
    "",
    "[Resulting spans]",
  ];
  for (const lane of CHAIN_LANES) {
    const us = wood.byLane[lane];
    if (us.length) {
      const a = Math.min(...us.map((u) => u.day));
      const b = Math.max(...us.map((u) => u.day));
      const sets = us.reduce((s, u) => s + u.sets, 0);
      notes.push(
        `  ${LANE_LABEL[lane].padEnd(10)} ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${
          us.length
        } SOs / ${sets} sets`,
      );
    }
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Wood Cutting",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Wood Cut Calendar": calRows,
      "By Day": byDayRows,
    },
  };
}

// =============================================================================
// FRAMING (+ Webbing & HB-foam same-day riders) and its downstream sub-stages
// (Sofa Foam Bonding, Upholstery, Packing).
// =============================================================================

interface FrameUnit {
  so: string;
  lane: ChainLane;
  cards: ChainCard[];
  fmin: number;
  sets: number;
  cdd: number;
  models: string[];
  floor: number;
  woodDone: number | null;
  web: ChainCard[];
  hbf: ChainCard[];
  webMin: number;
  hbfMin: number;
  modelKey: string;
  day: number;
}
interface FoamUnit {
  so: string;
  frameDay: number;
  cdd: number;
  models: string[];
  modelKey: string;
  base: ChainCard[];
  arm: ChainCard[];
  cush: ChainCard[];
  baMin: number;
  bcMin: number;
  floor: number;
  foamDay: number;
}
interface UphUnit {
  so: string;
  lane: ChainLane;
  cards: ChainCard[];
  umin: number;
  cdd: number;
  models: string[];
  modelKey: string;
  floor: number;
  upstream: number | null;
  uphDay: number;
}
interface PackUnit {
  so: string;
  lane: ChainLane;
  cards: ChainCard[];
  /** Packing work content in MINUTES. */
  pmin: number;
  cdd: number;
  models: string[];
  modelKey: string;
  packDay: number;
  uphDay: number | null;
}

/** One SO's foam-cutting work — a source stage pulled back from bonding. */
interface FoamCutUnit {
  so: string;
  lane: ChainLane;
  cards: ChainCard[];
  fcMin: number;
  cdd: number;
  models: string[];
  modelKey: string;
  /** The day this SO's foam is needed (bonding, else framing). */
  demandDay: number | null;
  day: number;
}

interface FrameResult {
  units: FrameUnit[];
  loadByLane: Record<ChainLane, Map<number, number>>;
  foamUnits: FoamUnit[];
  foamLoad: Map<number, number>;
  foamCutUnits: FoamCutUnit[];
  foamCutLoad: Map<number, number>;
  foamCutCap: number;
  uphUnits: UphUnit[];
  uphLoadByLane: Record<ChainLane, Map<number, number>>;
  packUnits: PackUnit[];
  /**
   * The minute budgets this run actually packed against — measured where a
   * budget was supplied, the configured constant otherwise. The renderers MUST
   * read these rather than re-deriving from `chain`, or every "load vs cap"
   * column reports against a capacity nobody scheduled to.
   */
  caps: {
    framing: Record<ChainLane, number>;
    foam: number;
    upholstery: Record<ChainLane, number>;
  };
}

/** A framing unit's base-set count. */
function frameSets(cards: ChainCard[], lane: ChainLane): number {
  const wt = lane === "BEDFRAME" ? "DIVAN" : "SOFA_BASE";
  const base = cards.filter((c) => c.wipType === wt);
  if (base.length) return base.reduce((a, c) => a + Math.max(1, c.sets), 0);
  return new Set(cards.map((c) => c.soPo)).size;
}

function runFraming(
  input: {
    framing: ChainCard[];
    webbing: ChainCard[];
    foam: ChainCard[];
    foamCutting: ChainCard[];
    upholstery: ChainCard[];
    packing: ChainCard[];
  },
  cal: Calendar,
  chain: ChainConfig,
  woodDay: Map<string, number>,
  budgets?: Record<string, number>,
): FrameResult {
  // ── Framing: group into SO-units, schedule per-lane hour budget ────────────
  const webBySo = new Map<string, ChainCard[]>();
  for (const c of input.webbing) {
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const k = `${c.soId}|${c.lane}`;
    const arr = webBySo.get(k) ?? [];
    arr.push(c);
    webBySo.set(k, arr);
  }
  const hbfBySo = new Map<string, ChainCard[]>();
  for (const c of input.foam) {
    if (c.wipType !== "HEADBOARD") continue;
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const k = `${c.soId}|${c.lane}`;
    const arr = hbfBySo.get(k) ?? [];
    arr.push(c);
    hbfBySo.set(k, arr);
  }

  const byUnit = new Map<string, ChainCard[]>();
  for (const c of input.framing) {
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const k = `${c.soId}|${c.lane}`;
    const arr = byUnit.get(k) ?? [];
    arr.push(c);
    byUnit.set(k, arr);
  }

  const units: FrameUnit[] = [];
  for (const [k, cards] of byUnit) {
    const [so, laneStr] = k.split("|");
    const lane = laneStr as ChainLane;
    const wd = woodDay.get(k);
    const floor = wd !== undefined ? cal.addWorkdays(wd, chain.frameHandoffDays) : cal.day1;
    const cdds = cards
      .map((c) => c.customerDd)
      .filter((x): x is string => !!x)
      .sort();
    const models = [...new Set(cards.map((c) => (c.model || "").trim()).filter(Boolean))].sort();
    const web = webBySo.get(k) ?? [];
    const hbf = hbfBySo.get(k) ?? [];
    units.push({
      so,
      lane,
      cards,
      fmin: cards.reduce((a, c) => a + c.mins, 0),
      sets: frameSets(cards, lane),
      cdd: cdds.length ? (parseYmd(cdds[0]) ?? FAR_DAY) : FAR_DAY,
      models,
      floor,
      woodDone: wd ?? null,
      web,
      hbf,
      webMin: web.reduce((a, c) => a + c.mins, 0),
      hbfMin: hbf.reduce((a, c) => a + c.mins, 0),
      modelKey: models.length ? models[0] : "",
      day: cal.day1,
    });
  }

  const loadByLane: Record<ChainLane, Map<number, number>> = { BEDFRAME: new Map(), SOFA: new Map() };
  for (const lane of CHAIN_LANES) {
    const us = units.filter((u) => u.lane === lane);
    const cap = laneBudget(
      budgets,
      "FRAMING",
      chain.frameCapMin[lane],
      chain.frameCapMin.BEDFRAME + chain.frameCapMin.SOFA,
    );
    const sl = (u: FrameUnit): number =>
      slackFor(cal, chain, "FRAMING", lane, u.cdd, u.floor, u.fmin, cap);
    const pr = (u: FrameUnit): number => (pinnedDayOf(u.cards, cal) === null ? 1 : 0);
    us.sort((a, b) =>
      cmpKey([pr(a), sl(a), a.cdd, a.modelKey, a.so], [pr(b), sl(b), b.cdd, b.modelKey, b.so]),
    );
    const load = loadByLane[lane];
    placeUnitsWithOt(
      us,
      cal,
      cap,
      load,
      (u) => ({
        cost: u.fmin,
        floor: u.floor,
        pin: pinnedDayOf(u.cards, cal),
        deadline: deadlineFor(cal, chain, "FRAMING", lane, u.cdd),
      }),
      (u, d) => {
        u.day = d;
      },
    );
  }
  const frameDayMap = new Map<string, number>();
  for (const u of units) frameDayMap.set(`${u.so}|${u.lane}`, u.day);

  // ── Sofa foam bonding: base+armrest capped 8h/day; back cushion rides same ──
  const sofaFoam = new Map<string, { base: ChainCard[]; arm: ChainCard[]; cush: ChainCard[] }>();
  for (const c of input.foam) {
    if (c.lane !== "SOFA") continue;
    const part = sofaFoam.get(c.soId) ?? { base: [], arm: [], cush: [] };
    if (c.wipType === "SOFA_BASE") part.base.push(c);
    else if (c.wipType === "SOFA_ARMREST") part.arm.push(c);
    else if (c.wipType === "SOFA_CUSHION") part.cush.push(c);
    sofaFoam.set(c.soId, part);
  }
  const foamUnits: FoamUnit[] = [];
  for (const u of units) {
    if (u.lane !== "SOFA") continue;
    const p = sofaFoam.get(u.so);
    if (!p || p.base.length + p.arm.length + p.cush.length === 0) continue;
    foamUnits.push({
      so: u.so,
      frameDay: u.day,
      cdd: u.cdd,
      models: u.models,
      modelKey: u.modelKey,
      base: p.base,
      arm: p.arm,
      cush: p.cush,
      baMin: [...p.base, ...p.arm].reduce((a, c) => a + c.mins, 0),
      bcMin: p.cush.reduce((a, c) => a + c.mins, 0),
      floor: cal.addWorkdays(u.day, chain.foamHandoffDays),
      foamDay: cal.day1,
    });
  }
  const foamLoad = new Map<number, number>();
  const foamCap = deptBudget(budgets, "FOAM", chain.foamCapMin);
  const foamSlack = (u: FoamUnit): number =>
    slackFor(cal, chain, "FOAM", "SOFA", u.cdd, u.floor, u.baMin, foamCap);
  foamUnits.sort((a, b) =>
    cmpKey(
      [foamSlack(a), a.cdd, a.modelKey, a.so],
      [foamSlack(b), b.cdd, b.modelKey, b.so],
    ),
  );
  placeUnitsWithOt(
    foamUnits,
    cal,
    foamCap,
    foamLoad,
    (u) => ({
      cost: u.baMin,
      floor: u.floor,
      pin: pinnedDayOf([...u.base, ...u.arm, ...u.cush], cal),
      deadline: deadlineFor(cal, chain, "FOAM", "SOFA", u.cdd),
    }),
    (u, d) => {
      u.foamDay = d;
    },
  );
  const foamDayMap = new Map<string, number>();
  for (const u of foamUnits) foamDayMap.set(u.so, u.foamDay);

  // ── Upholstery: bedframe floor = framing +1; sofa floor = base foam +1 ──────
  const uphByUnit = new Map<string, ChainCard[]>();
  for (const c of input.upholstery) {
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const k = `${c.soId}|${c.lane}`;
    const arr = uphByUnit.get(k) ?? [];
    arr.push(c);
    uphByUnit.set(k, arr);
  }
  const uphUnits: UphUnit[] = [];
  for (const [k, cards] of uphByUnit) {
    const [so, laneStr] = k.split("|");
    const lane = laneStr as ChainLane;
    const up = lane === "BEDFRAME" ? frameDayMap.get(k) : foamDayMap.get(so);
    const floor = up !== undefined ? cal.addWorkdays(up, chain.uphHandoffDays) : cal.day1;
    const cdds = cards
      .map((c) => c.customerDd)
      .filter((x): x is string => !!x)
      .sort();
    const models = [...new Set(cards.map((c) => (c.model || "").trim()).filter(Boolean))].sort();
    uphUnits.push({
      so,
      lane,
      cards,
      umin: cards.reduce((a, c) => a + c.mins, 0),
      cdd: cdds.length ? (parseYmd(cdds[0]) ?? FAR_DAY) : FAR_DAY,
      models,
      modelKey: models.length ? models[0] : "",
      floor,
      upstream: up ?? null,
      uphDay: cal.day1,
    });
  }
  const uphLoadByLane: Record<ChainLane, Map<number, number>> = {
    BEDFRAME: new Map(),
    SOFA: new Map(),
  };
  for (const lane of CHAIN_LANES) {
    const us = uphUnits.filter((u) => u.lane === lane);
    const cap = laneBudget(
      budgets,
      "UPHOLSTERY",
      chain.uphCapMin[lane],
      chain.uphCapMin.BEDFRAME + chain.uphCapMin.SOFA,
    );
    const sl = (u: UphUnit): number =>
      slackFor(cal, chain, "UPHOLSTERY", lane, u.cdd, u.floor, u.umin, cap);
    const pr = (u: UphUnit): number => (pinnedDayOf(u.cards, cal) === null ? 1 : 0);
    us.sort((a, b) =>
      cmpKey([pr(a), sl(a), a.cdd, a.modelKey, a.so], [pr(b), sl(b), b.cdd, b.modelKey, b.so]),
    );
    const load = uphLoadByLane[lane];
    placeUnitsWithOt(
      us,
      cal,
      cap,
      load,
      (u) => ({
        cost: u.umin,
        floor: u.floor,
        pin: pinnedDayOf(u.cards, cal),
        deadline: deadlineFor(cal, chain, "UPHOLSTERY", lane, u.cdd),
      }),
      (u, d) => {
        u.uphDay = d;
      },
    );
  }
  const uphDayMap = new Map<string, number>();
  for (const u of uphUnits) uphDayMap.set(`${u.so}|${u.lane}`, u.uphDay);

  // ── Packing: no cap; pack day = SO's upholstery day ────────────────────────
  const packByUnit = new Map<string, ChainCard[]>();
  for (const c of input.packing) {
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const k = `${c.soId}|${c.lane}`;
    const arr = packByUnit.get(k) ?? [];
    arr.push(c);
    packByUnit.set(k, arr);
  }
  const packUnits: PackUnit[] = [];
  for (const [k, cards] of packByUnit) {
    const [so, laneStr] = k.split("|");
    const lane = laneStr as ChainLane;
    const ud = uphDayMap.get(k);
    const cdds = cards
      .map((c) => c.customerDd)
      .filter((x): x is string => !!x)
      .sort();
    const models = [...new Set(cards.map((c) => (c.model || "").trim()).filter(Boolean))].sort();
    packUnits.push({
      so,
      lane,
      cards,
      pmin: cards.reduce((a, c) => a + c.mins, 0),
      cdd: cdds.length ? (parseYmd(cdds[0]) ?? FAR_DAY) : FAR_DAY,
      models,
      modelKey: models.length ? models[0] : "",
      packDay: ud ?? cal.day1,
      uphDay: ud ?? null,
    });
  }

  // ── Packing capacity (owner 2026-08-03) ────────────────────────────────────
  // Packing used to inherit the upholstery day with NO budget, which meant the
  // plan could never show a packing bottleneck because it could not model one:
  // any number of orders could "finish" on the same day. With a measured
  // budget it packs forward like every other department, so an overloaded
  // packing bench finally shows up in the schedule and in the OT outlook.
  //
  // No lane split — packing is one bench, not two.
  const packCap = measuredMinutes(budgets, "PACKING");
  if (packCap !== null) {
    const packLoad = new Map<number, number>();
    const packSlack = (u: PackUnit): number =>
      slackFor(cal, chain, "PACKING", u.lane, u.cdd, u.packDay, u.pmin, packCap);
    packUnits.sort((a, b) =>
      cmpKey([packSlack(a), a.cdd, a.modelKey, a.so], [packSlack(b), b.cdd, b.modelKey, b.so]),
    );
    placeUnitsWithOt(
      packUnits,
      cal,
      packCap,
      packLoad,
      (u) => ({
        // Floor stays the upholstery day — packing can never precede it.
        cost: u.pmin,
        floor: u.uphDay ?? cal.day1,
        pin: pinnedDayOf(u.cards, cal),
        deadline: deadlineFor(cal, chain, "PACKING", u.lane, u.cdd),
      }),
      (u, d) => {
        u.packDay = d;
      },
    );
  }

  const frameTotal = chain.frameCapMin.BEDFRAME + chain.frameCapMin.SOFA;
  const uphTotal = chain.uphCapMin.BEDFRAME + chain.uphCapMin.SOFA;
  // ── Foam Cutting (owner 2026-08-03) ───────────────────────────────────────
  // A SOURCE stage: it waits on no upstream department (the raw foam is simply
  // there), so its floor is day 1 like Fabric Cutting and Wood Cutting. What
  // ties it to the chain is DEMAND — its output is needed by Foam Bonding, so
  // each SO's cut is pulled back `foamCutLeadDays` working days from that SO's
  // bonding day. Owner: "把它放成 Foam Bonding 的前一天就是了" (revisit later).
  //
  // Its cards were invisible to the whole engine until now: FOAM_CUTTING was
  // absent from DEPT_CODE_TO_CHAIN, so loadChainInputs silently dropped every
  // one of them and neither planned the work nor counted its hours.
  const foamCutCap = deptBudget(budgets, "FOAM_CUTTING", chain.foamCutCapMin);
  const foamCutByUnit = new Map<string, ChainCard[]>();
  for (const c of input.foamCutting) {
    if (c.lane !== "BEDFRAME" && c.lane !== "SOFA") continue;
    const k = `${c.soId}|${c.lane}`;
    const arr = foamCutByUnit.get(k) ?? [];
    arr.push(c);
    foamCutByUnit.set(k, arr);
  }
  const foamCutUnits: FoamCutUnit[] = [];
  for (const [k, cards] of foamCutByUnit) {
    const [so, laneStr] = k.split("|");
    const lane = laneStr as ChainLane;
    // Demand day = this SO's bonding day when it has one, else its framing day
    // (a bedframe headboard-foam SO never reaches sofa foam bonding).
    const demand = foamDayMap.get(so) ?? frameDayMap.get(k) ?? null;
    const cdds = cards
      .map((c) => c.customerDd)
      .filter((x): x is string => !!x)
      .sort();
    foamCutUnits.push({
      so,
      lane,
      cards,
      fcMin: cards.reduce((a, c) => a + c.mins, 0),
      cdd: cdds.length ? (parseYmd(cdds[0]) ?? FAR_DAY) : FAR_DAY,
      models: [...new Set(cards.map((c) => (c.model || "").trim()).filter(Boolean))].sort(),
      modelKey: "",
      demandDay: demand,
      day: cal.day1,
    });
  }
  for (const u of foamCutUnits) u.modelKey = u.models.length ? u.models[0] : "";

  const foamCutLoad = new Map<number, number>();
  const fcSlack = (u: FoamCutUnit): number =>
    slackFor(cal, chain, "FOAM_CUTTING", u.lane, u.cdd, cal.day1, u.fcMin, foamCutCap);
  foamCutUnits.sort((a, b) =>
    cmpKey([fcSlack(a), a.cdd, a.modelKey, a.so], [fcSlack(b), b.cdd, b.modelKey, b.so]),
  );
  for (const u of foamCutUnits) {
    // Target = lead days before the day the foam is needed. Never earlier than
    // day 1, and if the pull-back lands in the past the work simply starts now.
    const target =
      u.demandDay !== null ? cal.backWorkday(u.demandDay, chain.foamCutLeadDays) : cal.day1;
    let d = Math.max(target, cal.day1);
    while ((foamCutLoad.get(d) ?? 0) + u.fcMin > foamCutCap && (foamCutLoad.get(d) ?? 0) !== 0) {
      d = cal.stepWorkday(d);
    }
    u.day = d;
    foamCutLoad.set(d, (foamCutLoad.get(d) ?? 0) + u.fcMin);
  }

  return {
    units,
    loadByLane,
    foamUnits,
    foamLoad,
    foamCutUnits,
    foamCutLoad,
    foamCutCap,
    uphUnits,
    uphLoadByLane,
    packUnits,
    caps: {
      framing: {
        BEDFRAME: laneBudget(budgets, "FRAMING", chain.frameCapMin.BEDFRAME, frameTotal),
        SOFA: laneBudget(budgets, "FRAMING", chain.frameCapMin.SOFA, frameTotal),
      },
      foam: foamCap,
      upholstery: {
        BEDFRAME: laneBudget(budgets, "UPHOLSTERY", chain.uphCapMin.BEDFRAME, uphTotal),
        SOFA: laneBudget(budgets, "UPHOLSTERY", chain.uphCapMin.SOFA, uphTotal),
      },
    },
  };
}

function renderFraming(
  fr: FrameResult,
  cal: Calendar,
  chain: ChainConfig,
  generatedAt: string,
): ScheduleSnapshot {
  // ── Framing Calendar ───────────────────────────────────────────────────────
  const calHeaders: Cell[] = [
    "Frame Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Mins",
    "Sets",
    "Webbing same day",
    "HB Foam same day",
    "Customer",
    "Customer DD",
    "Wood done",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];

  const unitsSorted = [...fr.units].sort((a, b) =>
    cmpKey(
      [a.day, a.lane === "BEDFRAME" ? 0 : 1, a.cdd, a.so],
      [b.day, b.lane === "BEDFRAME" ? 0 : 1, b.cdd, b.so],
    ),
  );
  let curDate = -1;
  for (const u of unitsSorted) {
    if (u.day !== curDate) {
      curDate = u.day;
      const bf = round1((fr.loadByLane.BEDFRAME.get(curDate) ?? 0) / 60);
      const sf = round1((fr.loadByLane.SOFA.get(curDate) ?? 0) / 60);
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(curDate)}  ${DOW[dowOf(curDate)]}   (Day ${cal.dayLabelNum(
        curDate,
      )})   -  Bedframe ${bf}/${fr.caps.framing.BEDFRAME / 60}h  ·  Sofa ${sf}/${
        fr.caps.framing.SOFA / 60
      }h`;
      calRows.push(sep);
    }
    const webTxt = u.web.length ? `${u.web.length} pc / ${u.webMin} min` : "-";
    const hbfTxt = u.hbf.length ? `${u.hbf.length} pc / ${u.hbfMin} min` : "-";
    const wdTxt = u.woodDone !== null ? fmtMonDayDow(u.woodDone) : "Done / no wood";
    // Upstream (Wood Cutting) day for this whole SO unit. Display only.
    const upTxt = u.woodDone !== null ? fmtMonDayDow(u.woodDone) : "—";
    u.cards.forEach((c, i) => {
      const first = i === 0;
      calRows.push([
        "",
        first ? LANE_LABEL[u.lane] : "",
        first ? u.so : "",
        first ? u.models.join(" + ") : "",
        c.label || c.model,
        Math.max(1, c.sets),
        c.mins,
        first ? u.sets : "",
        first ? webTxt : "",
        first ? hbfTxt : "",
        first ? c.customer : "",
        c.customerDd ?? "",
        first ? wdTxt : "",
        first ? upTxt : "",
      ]);
    });
  }

  // ── By Day (no lane column; bedframe/sofa as separate columns) ─────────────
  const byDayHeaders: Cell[] = [
    "Date",
    "Day",
    "Bedframe h",
    "Bedframe cap",
    "Sofa h",
    "Sofa cap",
    "Bedframe SOs",
    "Sofa SOs",
    "Webbing pcs (same day)",
    "HB Foam pcs (same day)",
    "SOs (model)",
  ];
  const byDayRows: Cell[][] = [byDayHeaders];
  const perday = new Map<number, FrameUnit[]>();
  for (const u of fr.units) {
    const arr = perday.get(u.day) ?? [];
    arr.push(u);
    perday.set(u.day, arr);
  }
  for (const d of [...perday.keys()].sort((a, b) => a - b)) {
    const us = perday.get(d)!;
    const bf = us.filter((u) => u.lane === "BEDFRAME");
    const sf = us.filter((u) => u.lane === "SOFA");
    const txt = us.map((u) => `${u.so}(${u.models.join("+")})`).join(", ");
    byDayRows.push([
      `${fmtIso(d)} ${DOW[dowOf(d)]}`,
      cal.dayLabelNum(d),
      round1((fr.loadByLane.BEDFRAME.get(d) ?? 0) / 60),
      fr.caps.framing.BEDFRAME / 60,
      round1((fr.loadByLane.SOFA.get(d) ?? 0) / 60),
      fr.caps.framing.SOFA / 60,
      bf.length,
      sf.length,
      us.reduce((a, u) => a + u.web.length, 0),
      us.reduce((a, u) => a + u.hbf.length, 0),
      txt,
    ]);
  }

  // ── Sofa Foam Bonding ──────────────────────────────────────────────────────
  const foamHeaders: Cell[] = ["Date", "Day", "Foam h", "Cap", "Pieces (Base/Arm/Cushion)", "SOs (model)"];
  const foamRows: Cell[][] = [foamHeaders];
  const fbByDay = new Map<number, FoamUnit[]>();
  for (const u of fr.foamUnits) {
    const arr = fbByDay.get(u.foamDay) ?? [];
    arr.push(u);
    fbByDay.set(u.foamDay, arr);
  }
  for (const d of [...fbByDay.keys()].sort((a, b) => a - b)) {
    const us = fbByDay.get(d)!;
    const nb = us.reduce((a, u) => a + u.base.length, 0);
    const na = us.reduce((a, u) => a + u.arm.length, 0);
    const nc = us.reduce((a, u) => a + u.cush.length, 0);
    foamRows.push([
      `${fmtIso(d)} ${DOW[dowOf(d)]}`,
      cal.dayLabelNum(d),
      round1((fr.foamLoad.get(d) ?? 0) / 60),
      fr.caps.foam / 60,
      `${nb}/${na}/${nc}`,
      us.map((u) => `${u.so}(${u.models.join("+")})`).join(", "),
    ]);
  }

  // ── Upholstery ─────────────────────────────────────────────────────────────
  const uphHeaders: Cell[] = [
    "Date",
    "Day",
    "Bedframe h",
    "Bedframe cap",
    "Sofa h",
    "Sofa cap",
    "Bedframe SOs",
    "Sofa SOs",
    "SOs (model)",
  ];
  const uphRows: Cell[][] = [uphHeaders];
  const uphPerday = new Map<number, UphUnit[]>();
  for (const u of fr.uphUnits) {
    const arr = uphPerday.get(u.uphDay) ?? [];
    arr.push(u);
    uphPerday.set(u.uphDay, arr);
  }
  for (const d of [...uphPerday.keys()].sort((a, b) => a - b)) {
    const us = uphPerday.get(d)!;
    const bf = us.filter((u) => u.lane === "BEDFRAME");
    const sf = us.filter((u) => u.lane === "SOFA");
    uphRows.push([
      `${fmtIso(d)} ${DOW[dowOf(d)]}`,
      cal.dayLabelNum(d),
      round1((fr.uphLoadByLane.BEDFRAME.get(d) ?? 0) / 60),
      fr.caps.upholstery.BEDFRAME / 60,
      round1((fr.uphLoadByLane.SOFA.get(d) ?? 0) / 60),
      fr.caps.upholstery.SOFA / 60,
      bf.length,
      sf.length,
      us.map((u) => `${u.so}(${u.models.join("+")})`).join(", "),
    ]);
  }

  // ── Packing ────────────────────────────────────────────────────────────────
  const packHeaders: Cell[] = ["Date", "Day", "Total Pieces", "Bedframe SOs", "Sofa SOs", "SOs (model)"];
  const packRows: Cell[][] = [packHeaders];
  const packPerday = new Map<number, PackUnit[]>();
  for (const u of fr.packUnits) {
    const arr = packPerday.get(u.packDay) ?? [];
    arr.push(u);
    packPerday.set(u.packDay, arr);
  }
  for (const d of [...packPerday.keys()].sort((a, b) => a - b)) {
    const us = packPerday.get(d)!;
    const bf = us.filter((u) => u.lane === "BEDFRAME");
    const sf = us.filter((u) => u.lane === "SOFA");
    packRows.push([
      `${fmtIso(d)} ${DOW[dowOf(d)]}`,
      cal.dayLabelNum(d),
      us.reduce((a, u) => a + u.cards.length, 0),
      bf.length,
      sf.length,
      us.map((u) => `${u.so}(${u.models.join("+")})`).join(", "),
    ]);
  }

  // ── Summary & Notes ────────────────────────────────────────────────────────
  const totWeb = fr.units.reduce((a, u) => a + u.web.length, 0);
  const totHbf = fr.units.reduce((a, u) => a + u.hbf.length, 0);
  const notes: string[] = [
    "Framing - Day-by-Day Schedule",
    `Generated ${generatedAt} as a live recompute. Read-only - nothing written to the ERP.`,
    "",
    "[Chain] Fabric Cutting -> Fabric Sewing -> Wood Cutting -> Framing.",
    `  Floor = (that SO's wood-cut day) + ${chain.frameHandoffDays} working day. Wood already done -> day 1.`,
    "",
    "[Capacity in production hours/day, per lane]",
    `  Bedframe ${fr.caps.framing.BEDFRAME / 60} h/day, Sofa ${fr.caps.framing.SOFA / 60} h/day. Separate teams.`,
    "",
    "[Same-day riders] Each SO's webbing + headboard-foam bonding run the SAME day as its framing,",
    `  on separate stations - they do NOT consume framing hours. Same-day total: Webbing ${totWeb} pc, HB Foam ${totHbf} pc.`,
    "",
    "[Sofa back-end] Webbing same day; foam bonding the next working day:",
    `  - base + armrest scheduled to an ${fr.caps.foam / 60} h/day cap, overflow pushed forward.`,
    "  - back cushion bonded the same day as its base, but does NOT consume that cap.",
    "",
    "[Upholstery] Bedframe = framing + 1 wd; Sofa = base foam bonding + 1 wd.",
    `  Caps: Bedframe ${fr.caps.upholstery.BEDFRAME / 60} h/day, Sofa ${fr.caps.upholstery.SOFA / 60} h/day.`,
    "",
    "[Packing] No capacity cap; pack day = the SO's upholstery day.",
    "",
    "[Priority] earliest Customer DD first, then earliest ready (wood-cut floor). Whole SO framed together.",
    "",
    "[Resulting spans]",
  ];
  for (const lane of CHAIN_LANES) {
    const us = fr.units.filter((u) => u.lane === lane);
    if (us.length) {
      const a = Math.min(...us.map((u) => u.day));
      const b = Math.max(...us.map((u) => u.day));
      const h = Math.round(us.reduce((s, u) => s + u.fmin, 0) / 60);
      notes.push(
        `  ${LANE_LABEL[lane].padEnd(10)} ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${
          us.length
        } SOs / ${h} h`,
      );
    }
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Framing",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Framing Calendar": calRows,
      "By Day": byDayRows,
      "Sofa Foam Bonding": foamRows,
      Upholstery: uphRows,
      Packing: packRows,
    },
  };
}

// =============================================================================
// FOAM BONDING / UPHOLSTERY / PACKING — rich per-SO grouped Calendar views.
// These reuse the framing computation (foamUnits / uphUnits / packUnits) but
// render their own per-SO grouped "Calendar" + "By Day" sheets so each page can
// use the RICH renderer (modelled on fabric-sewing / framing).
// =============================================================================

function renderFoamBonding(
  fr: FrameResult,
  cal: Calendar,
  chain: ChainConfig,
  generatedAt: string,
): ScheduleSnapshot {
  const calHeaders: Cell[] = [
    "Foam Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Base",
    "Armrest",
    "Cushion",
    "Foam Mins",
    "Customer DD",
    "Frame done",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];
  const sorted = [...fr.foamUnits].sort((a, b) =>
    cmpKey([a.foamDay, a.cdd, a.so], [b.foamDay, b.cdd, b.so]),
  );
  let curDate = -1;
  for (const u of sorted) {
    if (u.foamDay !== curDate) {
      curDate = u.foamDay;
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(curDate)}  ${DOW[dowOf(curDate)]}   (Day ${cal.dayLabelNum(
        curDate,
      )})   -  Foam ${round1((fr.foamLoad.get(curDate) ?? 0) / 60)}/${fr.caps.foam / 60}h`;
      calRows.push(sep);
    }
    const frameDoneTxt = fmtMonDayDow(u.frameDay);
    // Upstream (Framing) day for this sofa SO unit. Display only.
    const upTxt = frameDoneTxt;
    calRows.push([
      "",
      "Sofa",
      u.so,
      u.models.join(" + "),
      "Base + Armrest + Back Cushion",
      u.base.length,
      u.arm.length,
      u.cush.length,
      u.baMin + u.bcMin,
      "",
      frameDoneTxt,
      upTxt,
    ]);
  }

  const byDayHeaders: Cell[] = ["Date", "Day", "Lane", "SOs that day", "SOs", "Foam h", "Cap h"];
  const byDayRows: Cell[][] = [byDayHeaders];
  const byDay = new Map<number, FoamUnit[]>();
  for (const u of fr.foamUnits) {
    const arr = byDay.get(u.foamDay) ?? [];
    arr.push(u);
    byDay.set(u.foamDay, arr);
  }
  for (const d of [...byDay.keys()].sort((a, b) => a - b)) {
    const us = byDay.get(d)!;
    byDayRows.push([
      `${fmtIso(d)} ${DOW[dowOf(d)]}`,
      cal.dayLabelNum(d),
      "Sofa",
      us.map((u) => `${u.so}(${u.models.join("+")})`).join(", "),
      us.length,
      round1((fr.foamLoad.get(d) ?? 0) / 60),
      fr.caps.foam / 60,
    ]);
  }

  const notes: string[] = [
    "Sofa Foam Bonding - Day-by-Day Schedule",
    `Generated ${generatedAt} as a live recompute. Read-only - nothing written to the ERP.`,
    "",
    "[Chain] Runs the working day after each sofa's framing (webbing rides framing the same day).",
    `  Floor = (sofa framing day) + ${chain.foamHandoffDays} working day.`,
    "",
    `[Capacity] base + armrest capped ${fr.caps.foam / 60} h/day; overflow pushed forward.`,
    "  Back cushion bonded the same day as its base, but does NOT consume the cap.",
    "",
    "[Priority] earliest Customer DD first, then earliest ready (framing floor). Whole SO together.",
  ];
  if (fr.foamUnits.length) {
    const a = Math.min(...fr.foamUnits.map((u) => u.foamDay));
    const b = Math.max(...fr.foamUnits.map((u) => u.foamDay));
    notes.push("");
    notes.push(`  Sofa  ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${fr.foamUnits.length} SOs`);
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Foam Bonding",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Foam Calendar": calRows,
      "By Day": byDayRows,
    },
  };
}

function renderUpholstery(
  fr: FrameResult,
  cal: Calendar,
  chain: ChainConfig,
  generatedAt: string,
): ScheduleSnapshot {
  const calHeaders: Cell[] = [
    "Uph Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Mins",
    "Customer DD",
    "Upstream done",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];
  const sorted = [...fr.uphUnits].sort((a, b) =>
    cmpKey(
      [a.uphDay, a.lane === "BEDFRAME" ? 0 : 1, a.cdd, a.so],
      [b.uphDay, b.lane === "BEDFRAME" ? 0 : 1, b.cdd, b.so],
    ),
  );
  let curDate = -1;
  for (const u of sorted) {
    if (u.uphDay !== curDate) {
      curDate = u.uphDay;
      const bf = round1((fr.uphLoadByLane.BEDFRAME.get(curDate) ?? 0) / 60);
      const sf = round1((fr.uphLoadByLane.SOFA.get(curDate) ?? 0) / 60);
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(curDate)}  ${DOW[dowOf(curDate)]}   (Day ${cal.dayLabelNum(
        curDate,
      )})   -  Bedframe ${bf}/${fr.caps.upholstery.BEDFRAME / 60}h  ·  Sofa ${sf}/${
        fr.caps.upholstery.SOFA / 60
      }h`;
      calRows.push(sep);
    }
    const upTxt = u.upstream !== null ? fmtMonDayDow(u.upstream) : "Done / day 1";
    // Upstream (Framing for bedframe, Foam Bonding for sofa) day. Display only.
    const upColTxt = u.upstream !== null ? fmtMonDayDow(u.upstream) : "—";
    u.cards.forEach((c, i) => {
      const first = i === 0;
      calRows.push([
        "",
        first ? LANE_LABEL[u.lane] : "",
        first ? u.so : "",
        first ? u.models.join(" + ") : "",
        c.label || c.model,
        Math.max(1, c.sets),
        c.mins,
        first ? c.customerDd ?? "" : "",
        first ? upTxt : "",
        first ? upColTxt : "",
      ]);
    });
  }

  const byDayHeaders: Cell[] = ["Date", "Day", "Lane", "SOs that day", "SOs", "Load h", "Cap h"];
  const byDayRows: Cell[][] = [byDayHeaders];
  const perday: Record<ChainLane, Map<number, UphUnit[]>> = { BEDFRAME: new Map(), SOFA: new Map() };
  for (const u of fr.uphUnits) {
    const arr = perday[u.lane].get(u.uphDay) ?? [];
    arr.push(u);
    perday[u.lane].set(u.uphDay, arr);
  }
  const allDays = new Set<number>();
  for (const lane of CHAIN_LANES) for (const d of perday[lane].keys()) allDays.add(d);
  for (const d of [...allDays].sort((a, b) => a - b)) {
    for (const lane of CHAIN_LANES) {
      const us = perday[lane].get(d);
      if (!us) continue;
      byDayRows.push([
        `${fmtIso(d)} ${DOW[dowOf(d)]}`,
        cal.dayLabelNum(d),
        LANE_LABEL[lane],
        us.map((u) => `${u.so}(${u.models.join("+")})`).join(", "),
        us.length,
        round1((fr.uphLoadByLane[lane].get(d) ?? 0) / 60),
        fr.caps.upholstery[lane] / 60,
      ]);
    }
  }

  const notes: string[] = [
    "Upholstery - Day-by-Day Schedule",
    `Generated ${generatedAt} as a live recompute. Read-only - nothing written to the ERP.`,
    "",
    "[Chain] Bedframe upholstery = framing + 1 wd (webbing rides framing same day).",
    "  Sofa upholstery = base foam bonding + 1 wd.",
    "",
    "[Capacity in production hours/day, per lane]",
    `  Bedframe ${fr.caps.upholstery.BEDFRAME / 60} h/day, Sofa ${fr.caps.upholstery.SOFA / 60} h/day. Separate lanes; overflow pushed forward.`,
    "",
    "[Priority] earliest Customer DD first, then earliest ready (upstream floor). Whole SO together.",
    "",
    "[Resulting spans]",
  ];
  for (const lane of CHAIN_LANES) {
    const us = fr.uphUnits.filter((u) => u.lane === lane);
    if (us.length) {
      const a = Math.min(...us.map((u) => u.uphDay));
      const b = Math.max(...us.map((u) => u.uphDay));
      const h = Math.round(us.reduce((s, u) => s + u.umin, 0) / 60);
      notes.push(
        `  ${LANE_LABEL[lane].padEnd(10)} ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${
          us.length
        } SOs / ${h} h`,
      );
    }
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Upholstery",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Uph Calendar": calRows,
      "By Day": byDayRows,
    },
  };
}

function renderPacking(
  fr: FrameResult,
  cal: Calendar,
  generatedAt: string,
): ScheduleSnapshot {
  const calHeaders: Cell[] = [
    "Pack Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Customer DD",
    "Uph done",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];
  const sorted = [...fr.packUnits].sort((a, b) =>
    cmpKey(
      [a.packDay, a.lane === "BEDFRAME" ? 0 : 1, a.cdd, a.so],
      [b.packDay, b.lane === "BEDFRAME" ? 0 : 1, b.cdd, b.so],
    ),
  );
  let curDate = -1;
  for (const u of sorted) {
    if (u.packDay !== curDate) {
      curDate = u.packDay;
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(curDate)}  ${DOW[dowOf(curDate)]}   (Day ${cal.dayLabelNum(curDate)})`;
      calRows.push(sep);
    }
    const upTxt = u.uphDay !== null ? fmtMonDayDow(u.uphDay) : "Done / day 1";
    // Upstream (Upholstery) day for this whole SO unit. Display only.
    const upColTxt = u.uphDay !== null ? fmtMonDayDow(u.uphDay) : "—";
    u.cards.forEach((c, i) => {
      const first = i === 0;
      calRows.push([
        "",
        first ? LANE_LABEL[u.lane] : "",
        first ? u.so : "",
        first ? u.models.join(" + ") : "",
        c.label || c.model,
        Math.max(1, c.sets),
        first ? c.customerDd ?? "" : "",
        first ? upTxt : "",
        first ? upColTxt : "",
      ]);
    });
  }

  const byDayHeaders: Cell[] = ["Date", "Day", "Lane", "SOs that day", "SOs", "Total Pieces"];
  const byDayRows: Cell[][] = [byDayHeaders];
  const perday: Record<ChainLane, Map<number, PackUnit[]>> = { BEDFRAME: new Map(), SOFA: new Map() };
  for (const u of fr.packUnits) {
    const arr = perday[u.lane].get(u.packDay) ?? [];
    arr.push(u);
    perday[u.lane].set(u.packDay, arr);
  }
  const allDays = new Set<number>();
  for (const lane of CHAIN_LANES) for (const d of perday[lane].keys()) allDays.add(d);
  for (const d of [...allDays].sort((a, b) => a - b)) {
    for (const lane of CHAIN_LANES) {
      const us = perday[lane].get(d);
      if (!us) continue;
      byDayRows.push([
        `${fmtIso(d)} ${DOW[dowOf(d)]}`,
        cal.dayLabelNum(d),
        LANE_LABEL[lane],
        us.map((u) => `${u.so}(${u.models.join("+")})`).join(", "),
        us.length,
        us.reduce((a, u) => a + u.cards.length, 0),
      ]);
    }
  }

  const notes: string[] = [
    "Packing - Day-by-Day Schedule",
    `Generated ${generatedAt} as a live recompute. Read-only - nothing written to the ERP.`,
    "",
    "[Chain] Packing is the last stage. Pack day = the SO's upholstery day (same day, no handoff wait).",
    "",
    "[Capacity] No capacity cap - whatever finishes upholstery on a day is packed that day.",
    "",
    "[Priority] inherits the upholstery order: earliest Customer DD first, then earliest ready.",
  ];
  if (fr.packUnits.length) {
    const a = Math.min(...fr.packUnits.map((u) => u.packDay));
    const b = Math.max(...fr.packUnits.map((u) => u.packDay));
    notes.push("");
    notes.push(`  Packing  ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${fr.packUnits.length} SOs`);
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Packing",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Pack Calendar": calRows,
      "By Day": byDayRows,
    },
  };
}

// =============================================================================
// WEBBING — no own schedule; same day as the SO's Framing.
// =============================================================================
function renderWebbing(
  fr: FrameResult,
  cal: Calendar,
  generatedAt: string,
): ScheduleSnapshot {
  // Webbing rides framing: each SO with webbing cards is shown on its framing day.
  const calHeaders: Cell[] = [
    "Frame Date (same day)",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Webbing Pieces",
    "Webbing Mins",
    "Customer DD",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];
  const withWeb = fr.units.filter((u) => u.web.length > 0);
  const sorted = [...withWeb].sort((a, b) =>
    cmpKey(
      [a.day, a.lane === "BEDFRAME" ? 0 : 1, a.cdd, a.so],
      [b.day, b.lane === "BEDFRAME" ? 0 : 1, b.cdd, b.so],
    ),
  );
  let curDate = -1;
  for (const u of sorted) {
    if (u.day !== curDate) {
      curDate = u.day;
      const sep = Array<Cell>(calHeaders.length).fill("");
      sep[0] = `${fmtIso(curDate)}  ${DOW[dowOf(curDate)]}   (Day ${cal.dayLabelNum(curDate)})`;
      calRows.push(sep);
    }
    const cdd = u.cards.find((c) => c.customerDd)?.customerDd ?? "";
    // Upstream (Wood Cutting) day — webbing rides framing, whose upstream is
    // wood cutting. Display only.
    const upTxt = u.woodDone !== null ? fmtMonDayDow(u.woodDone) : "—";
    calRows.push([
      "",
      LANE_LABEL[u.lane],
      u.so,
      u.models.join(" + "),
      "Webbing (same day as framing)",
      u.web.length,
      u.webMin,
      cdd,
      upTxt,
    ]);
  }

  const byDayHeaders: Cell[] = [
    "Frame Date (same day)",
    "Day",
    "Webbing Pieces (same day)",
    "SOs framed that day (model)",
  ];
  const byDayRows: Cell[][] = [byDayHeaders];
  const perday = new Map<number, FrameUnit[]>();
  for (const u of fr.units) {
    const arr = perday.get(u.day) ?? [];
    arr.push(u);
    perday.set(u.day, arr);
  }
  for (const d of [...perday.keys()].sort((a, b) => a - b)) {
    const us = perday.get(d)!;
    const web = us.reduce((a, u) => a + u.web.length, 0);
    if (!web) continue;
    byDayRows.push([
      `${fmtIso(d)} ${DOW[dowOf(d)]}`,
      cal.dayLabelNum(d),
      web,
      us
        .filter((u) => u.web.length)
        .map((u) => `${u.so}(${u.models.join("+")})`)
        .join(", "),
    ]);
  }

  const totWeb = fr.units.reduce((a, u) => a + u.web.length, 0);
  const notes: string[] = [
    "Webbing - Same Day as Framing",
    `Generated ${generatedAt} as a live recompute. Read-only - nothing written to the ERP.`,
    "",
    "[No separate schedule] Each SO's webbing is done the SAME day as that SO's framing,",
    "  on a separate crew running in parallel - it does not consume the framing hour budget.",
    "",
    `[Volume] Same-day webbing total: ${totWeb} pieces across the framing plan.`,
    "",
    "[How to read] Each row is a framing day with the webbing pieces that ride along on that day.",
    "  Open the Framing department page for the full per-order framing detail.",
  ];
  if (sorted.length) {
    const a = Math.min(...sorted.map((u) => u.day));
    const b = Math.max(...sorted.map((u) => u.day));
    notes.push("");
    notes.push(`  Webbing  ${fmtMonDayDow(a)} -> ${fmtMonDayDow(b)}   ${sorted.length} SOs`);
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  return {
    generatedAt,
    department: "Webbing",
    sheets: {
      "Summary & Notes": notes.map((t) => [t] as Cell[]),
      "Webbing Calendar": calRows,
      "By Day": byDayRows,
    },
  };
}

// =============================================================================
// ORCHESTRATOR — run the whole chain ONCE, expose each dept's snapshot.
// =============================================================================
export function computeChain(input: ChainInput): ChainOutput {
  const emit = input.collect;
  const cut = runCutting({
    cards: input.cutCards,
    config: input.config,
    holidays: input.holidays,
    startDate: input.startDate,
    generatedAt: input.generatedAt,
    // Measured CNC minutes flip cutting out of the legacy slot model.
    dailyBudgetMin: input.dailyBudgetByDept?.FAB_CUT,
    // Forward the cut-head assignments to the chain-level collector.
    collect: emit
      ? (a) =>
          emit({
            dept: "FAB_CUT",
            soPo: a.soPo,
            soId: "",
            lane: a.lane,
            fabric: a.fabric,
            sets: a.sets,
            date: a.date,
            card: a.card,
          })
      : undefined,
  });
  const cal = cut.cal;
  const chain = input.config.chain;

  const budgets = input.dailyBudgetByDept;
  const byDept = (d: ChainDept): ChainCard[] => input.chainCards.filter((c) => c.dept === d);
  const sew = runSewing(input.chainCards, cal, chain, cut.cutLastDay, budgets);
  const wood = runWood(input.chainCards, cal, chain, sew.sewEnd, budgets);
  const fr = runFraming(
    {
      framing: byDept("FRAMING"),
      webbing: byDept("WEBBING"),
      foam: byDept("FOAM"),
      foamCutting: byDept("FOAM_CUTTING"),
      upholstery: byDept("UPHOLSTERY"),
      packing: byDept("PACKING"),
    },
    cal,
    chain,
    wood.woodDay,
    budgets,
  );

  // ── Optional Phase-2 collector: one call per scheduled (card, day) ────────
  // Emitted from the computed structures (the same day every calendar sheet
  // row is rendered from), NOT from inside the renderers — so the collector
  // can never disturb the display output. Purely additive.
  if (emit) {
    const send = (dept: ChainDept, c: ChainCard, day: number): void =>
      emit({
        dept,
        soPo: c.soPo,
        soId: c.soId,
        lane: c.lane,
        fabric: c.fabric,
        sets: c.sets,
        date: fmtIso(day),
        card: c,
      });
    for (const lane of SEW_LANE_ORDER) {
      for (const sc of sew.byLane[lane]) send("FAB_SEW", sc.card, sc.day);
    }
    for (const lane of CHAIN_LANES) {
      for (const u of wood.byLane[lane]) for (const c of u.cards) send("WOOD_CUT", c, u.day);
    }
    for (const u of fr.units) {
      for (const c of u.cards) send("FRAMING", c, u.day);
      // Webbing + HB-foam ride the SAME day as the SO's framing.
      for (const c of u.web) send("WEBBING", c, u.day);
      for (const c of u.hbf) send("FOAM", c, u.day);
    }
    for (const u of fr.foamUnits) {
      // Base + armrest consume the foam cap; back cushion rides the same day.
      for (const c of [...u.base, ...u.arm, ...u.cush]) send("FOAM", c, u.foamDay);
    }
    for (const u of fr.foamCutUnits) for (const c of u.cards) send("FOAM_CUTTING", c, u.day);
    for (const u of fr.uphUnits) for (const c of u.cards) send("UPHOLSTERY", c, u.uphDay);
    for (const u of fr.packUnits) for (const c of u.cards) send("PACKING", c, u.packDay);
  }

  return {
    cutting: cut.snapshot,
    sewing: renderSewing(sew, cal, chain, input.generatedAt, cut.cutLastDay, budgets),
    woodCutting: renderWood(wood, cal, chain, input.generatedAt),
    framing: renderFraming(fr, cal, chain, input.generatedAt),
    foamBonding: renderFoamBonding(fr, cal, chain, input.generatedAt),
    upholstery: renderUpholstery(fr, cal, chain, input.generatedAt),
    packing: renderPacking(fr, cal, input.generatedAt),
    webbing: renderWebbing(fr, cal, input.generatedAt),
  };
}
