// ---------------------------------------------------------------------------
// Fabric Cutting — pure day-by-day cut scheduler (Phase 1).
//
// This is a 1:1 TypeScript port of the trusted Python cutter
// (scripts/_algo_ref/build_cutting_daily_xlsx.py, owner-confirmed 2026-06-01),
// with every label translated to English. It is INTENTIONALLY free of Hono /
// DB types: it takes a plain normalized card array + a CapacityConfig + a
// holiday list + a start date, and returns a snapshot-shaped object whose sheet
// rows match the existing Fabric Cutting page renderer exactly. That keeps the
// algorithm unit-testable and the route a thin adapter.
//
// THE ALGORITHM (extracted from the Python):
//   • Calendar: START = caller-supplied first working day; is_offday(d) =
//     Sunday OR a holiday. Saturday is a working day. Working-day indexing is
//     integer-based (no clock).
//   • Cards: caller passes only WAITING FAB_CUT cards whose order is not
//     ON_HOLD / CANCELLED. Lane = order itemCategory.
//   • A "cut" identity = config (wipLabel's first segment) + size. Same-cut
//     cards whose customer DDs fall within PULL_WINDOW days merge into one
//     batch; a cluster spanning > PULL_WINDOW splits at its largest internal
//     gap. Undated cards ride the last batch.
//   • A cut holds SETUP_CAP sets; bigger batches split into chunks of ≤ cap;
//     slots = ceil(sets / cap), each slot = one day.
//   • Placement floor: urgent cuts ASAP; a later chunk floors MODEL_LEAD (BF /
//     SOFA cluster lanes) or CHUNK_LEAD (others) working days before its
//     earliest DD, never before START.
//   • Per-day capacity: BF+SOFA share one pool with reserve tiers by working-
//     day index. Lane ceilings BF / SOFA / ACCESSORY (ACCESSORY has its own
//     pool). BF scheduled first into the shared counter; SOFA fills the
//     remainder but is guaranteed SOFA_MIN.
//   • Dates are formatted as LOCAL YYYY-MM-DD (never toISOString — that shifts
//     by timezone).
//
// All emitted text is English.
// ---------------------------------------------------------------------------
import type { CapacityConfig, Lane } from "./planning-capacity";

// ── Public input / output shapes ───────────────────────────────────────────

/** One normalized WAITING FAB_CUT card handed to the scheduler. */
export interface CutCard {
  /** "SO / PO" display id, e.g. "SO-2605-171-01". */
  soPo: string;
  /** Customer name. */
  customer: string;
  /** Full WIP label (one set/row text). */
  label: string;
  /** Fabric / colour code. */
  fabric: string;
  /** Item category → lane. */
  lane: Lane;
  /** Cutting config = wipLabel first segment (the cut identity sans size). */
  config: string;
  /** Size label, e.g. "5FT" / "28". May be "". */
  size: string;
  /** Number of sets (>= 1). */
  sets: number;
  /** Customer delivery date as YYYY-MM-DD, or "" / null when undated. */
  customerDd: string | null;
  /** Hookka expected DD as YYYY-MM-DD, or "" / null. */
  expectedDd: string | null;
}

/** A snapshot cell — string or number (mirrors the static JSON). */
export type Cell = string | number;

/**
 * Machine-readable (card, day) assignment emitted to an optional collector
 * (Phase 2 due-date proposals). `date` is the LOCAL YYYY-MM-DD of the batch's
 * LAST scheduled cut day — the day this card's fabric finishes cutting, the
 * same day the downstream chain couples on (cutLastDay).
 */
export interface CutAssignment {
  dept: "FAB_CUT";
  soPo: string;
  lane: Lane;
  fabric: string;
  sets: number;
  date: string;
  /** The exact input CutCard object — an identity key for caller-side maps. */
  card: CutCard;
}

export interface SchedulerInput {
  cards: CutCard[];
  config: CapacityConfig;
  /** Holiday dates as YYYY-MM-DD. */
  holidays: string[];
  /** First working day as YYYY-MM-DD (caller already advanced past off-days). */
  startDate: string;
  /** Date the schedule was generated, YYYY-MM-DD (for the snapshot header). */
  generatedAt: string;
  /**
   * OPTIONAL collector — called once per scheduled card AFTER placement, with
   * the machine-readable assignment. Purely additive: when omitted (every
   * pre-Phase-2 call site) the run is byte-identical to the old behaviour.
   */
  collect?: (a: CutAssignment) => void;
}

export interface ScheduleSnapshot {
  generatedAt: string;
  department: string;
  /**
   * Named sheets — one calendar + a By Day load sheet + Summary & Notes per
   * department. Phase 1 cutting emits "Cut Calendar"; the Phase 2 chain depts
   * emit their own calendar sheet name (Sew Calendar, Framing Calendar, …),
   * so the map is keyed by string rather than a fixed cutting shape.
   */
  sheets: Record<string, Cell[][]>;
}

// ── Integer date arithmetic (no Date objects in the hot path) ───────────────
// We represent a calendar date as a "day number" — the count of days since an
// epoch — computed from a YYYY-MM-DD string. This keeps every comparison /
// add / subtract integer-based and timezone-proof. We convert back to a
// YYYY-MM-DD string (and a weekday) only when formatting output.

export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

/** Days from 1970-01-01 for a Y/M/D (proleptic Gregorian). Pure integer math. */
function toDayNum(t: Ymd): number {
  // Howard Hinnant's days-from-civil algorithm.
  const y = t.m <= 2 ? t.y - 1 : t.y;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (t.m > 2 ? t.m - 3 : t.m + 9) + 2) / 5) + t.d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of toDayNum. */
function fromDayNum(z: number): Ymd {
  const zz = z + 719468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** Day-of-week for a day number. 0 = Sunday … 6 = Saturday. */
export function dowOf(dayNum: number): number {
  // 1970-01-01 (dayNum 0) was a Thursday (4).
  return ((dayNum % 7) + 4 + 7) % 7;
}

export function parseYmd(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return toDayNum({ y: +m[1], m: +m[2], d: +m[3] });
}

/** LOCAL YYYY-MM-DD from a day number. */
export function fmtIso(dayNum: number): string {
  const t = fromDayNum(dayNum);
  const mm = String(t.m).padStart(2, "0");
  const dd = String(t.d).padStart(2, "0");
  return `${t.y}-${mm}-${dd}`;
}

/** "DD Mon" short label, e.g. "25 May". */
export function fmtDayMon(dayNum: number): string {
  const t = fromDayNum(dayNum);
  return `${String(t.d).padStart(2, "0")} ${MONTHS[t.m - 1]}`;
}

/** "MM-DD Www" label, e.g. "06-03 Tue". */
export function fmtMonDayDow(dayNum: number): string {
  const t = fromDayNum(dayNum);
  return `${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")} ${DOW[dowOf(dayNum)]}`;
}

export const FAR_DAY = toDayNum({ y: 9999, m: 12, d: 31 });

// ── Calendar helpers (ported: is_offday / next_workday / step_workday /
//    workday_index / back_workday / add_workdays) ───────────────────────────

export class Calendar {
  private holidays: Set<number>;
  readonly start: number; // START day number
  readonly day1: number; // next_workday(START)

  constructor(startDayNum: number, holidayDayNums: number[]) {
    this.holidays = new Set(holidayDayNums);
    this.start = startDayNum;
    this.day1 = this.nextWorkday(startDayNum);
  }

  isOffday(d: number): boolean {
    return dowOf(d) === 0 || this.holidays.has(d);
  }
  nextWorkday(d: number): number {
    let x = d;
    while (this.isOffday(x)) x += 1;
    return x;
  }
  stepWorkday(d: number): number {
    return this.nextWorkday(d + 1);
  }
  /** 1 = first working day (day1); off-days skipped. */
  workdayIndex(d: number): number {
    let i = 0;
    let x = this.day1;
    while (x <= d) {
      i += 1;
      x = this.stepWorkday(x);
    }
    return i;
  }
  /** n working days BEFORE d (skips off-days). */
  backWorkday(d: number, n: number): number {
    let x = d;
    let k = n;
    while (k > 0) {
      x -= 1;
      while (this.isOffday(x)) x -= 1;
      k -= 1;
    }
    return x;
  }
  /** n working days AFTER d (skips off-days). add(d,0) = next_workday(d). */
  addWorkdays(d: number, n: number): number {
    let x = this.nextWorkday(d);
    for (let k = 0; k < n; k++) x = this.stepWorkday(x);
    return x;
  }
  /** Day number rendered as the calendar's "Day N" relative to day1. */
  dayLabelNum(d: number): number {
    return d - this.day1 + 1;
  }
}

// ── Reserve-tier pool budget ────────────────────────────────────────────────

function poolCap(cal: Calendar, cfg: CapacityConfig, d: number): number {
  const i = cal.workdayIndex(d);
  for (const tier of cfg.reserveTiers) {
    if (i <= tier.uptoDay) return tier.cuts;
  }
  return cfg.reserveTiers[cfg.reserveTiers.length - 1].cuts;
}

// ── Identity / size helpers ─────────────────────────────────────────────────

const SIZE_RANK: Record<string, number> = {
  "6FT": 0,
  "5FT": 1,
  "4FT": 2,
  "3.5FT": 3,
  "3FT": 4,
};
function sizeRank(s: string): number {
  return SIZE_RANK[(s || "").trim()] ?? 50;
}

function baseModel(cfg: string): string {
  const m = (cfg || "").trim();
  return m ? m.split("-")[0] : "(none)";
}

// ── Internal scheduling structures ──────────────────────────────────────────

interface Group {
  config: string;
  bmodel: string;
  size: string;
  items: CutCard[];
  sets: number;
  slots: number;
  cddMin: string; // "" when undated
  cddMax: string;
  floor: number; // day number
  part: [number, number]; // (i, n) chunk index / count
  // filled in by schedule():
  days: number[];
  start: number;
  end: number;
  cut: string; // e.g. "B1"
}

// Split a cut-identity's cards into sub-batches by customer-DD proximity:
// keep all in one cluster, split a cluster spanning > pullWindow at its largest
// internal gap; undated cards ride the last batch.
function splitByWindow(items: CutCard[], pullWindow: number): CutCard[][] {
  const dated = items
    .filter((it) => parseYmd(it.customerDd) !== null)
    .sort((a, b) => parseYmd(a.customerDd)! - parseYmd(b.customerDd)!);
  const undated = items.filter((it) => parseYmd(it.customerDd) === null);
  if (dated.length === 0) return undated.length ? [undated] : [[]];

  const spanDays = (cluster: CutCard[]): number =>
    parseYmd(cluster[cluster.length - 1].customerDd)! - parseYmd(cluster[0].customerDd)!;

  let clusters: CutCard[][] = [dated];
  // Repeatedly break the widest over-window cluster at its biggest day-gap.
  for (;;) {
    const wide = clusters.find((cl) => spanDays(cl) > pullWindow);
    if (!wide) break;
    let bestGap = -1;
    let gi = 0;
    for (let i = 0; i < wide.length - 1; i++) {
      const gap = parseYmd(wide[i + 1].customerDd)! - parseYmd(wide[i].customerDd)!;
      if (gap > bestGap) {
        bestGap = gap;
        gi = i;
      }
    }
    clusters = clusters.filter((cl) => cl !== wide);
    clusters.push(wide.slice(0, gi + 1));
    clusters.push(wide.slice(gi + 1));
  }
  clusters.sort((a, b) => parseYmd(a[0].customerDd)! - parseYmd(b[0].customerDd)!);
  clusters[clusters.length - 1].push(...undated);
  return clusters;
}

function peDay(s: string | null | undefined): number {
  return parseYmd(s) ?? FAR_DAY;
}

function buildGroups(laneRows: CutCard[], lane: Lane, cal: Calendar, cfg: CapacityConfig): Group[] {
  const cap = cfg.setupCap[lane];
  const buckets = new Map<string, CutCard[]>();
  for (const r of laneRows) {
    const key = `${r.config}\u0000${r.size}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  interface Sub {
    cfg: string;
    sz: string;
    items: CutCard[];
    bmodel: string;
    earliest: string; // "" when undated
  }
  const subs: Sub[] = [];
  for (const items of buckets.values()) {
    for (const b of splitByWindow(items, cfg.pullWindowDays)) {
      const dds = b.map((it) => it.customerDd).filter((x): x is string => parseYmd(x) !== null);
      const earliest = dds.length ? dds.reduce((a, c) => (parseYmd(c)! < parseYmd(a)! ? c : a)) : "";
      const first = b[0];
      subs.push({
        cfg: first?.config ?? "(none)",
        sz: first?.size ?? "",
        items: b,
        bmodel: first ? baseModel(first.config) : "(none)",
        earliest,
      });
    }
  }

  // Model-block ordering for cluster lanes; pure JIT for the rest.
  const modelEarliest = new Map<string, string>();
  for (const s of subs) {
    const cur = modelEarliest.get(s.bmodel);
    if (cur === undefined || peDay(s.earliest) < peDay(cur)) modelEarliest.set(s.bmodel, s.earliest);
  }
  const isCluster = cfg.clusterLanes.includes(lane);
  const orderKey = (s: Sub): (number | string)[] =>
    isCluster
      ? [peDay(modelEarliest.get(s.bmodel) ?? ""), s.bmodel, peDay(s.earliest), sizeRank(s.sz), s.cfg]
      : [peDay(s.earliest), s.bmodel, sizeRank(s.sz), s.cfg];

  const sortedSubs = [...subs].sort((a, b) => {
    const ka = orderKey(a);
    const kb = orderKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });

  const groups: Group[] = [];
  for (const s of sortedSubs) {
    // Earliest-due cards first, so a too-big batch splits urgent-first.
    const items = [...s.items].sort((a, b) => {
      const ca = a.customerDd || "9999-99-99";
      const cb = b.customerDd || "9999-99-99";
      if (ca !== cb) return ca < cb ? -1 : 1;
      const fa = a.fabric || "";
      const fb = b.fabric || "";
      if (fa !== fb) return fa < fb ? -1 : 1;
      const pa = a.soPo || "";
      const pb = b.soPo || "";
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });

    const chunks: CutCard[][] = [];
    let cur: CutCard[] = [];
    let cursum = 0;
    for (const it of items) {
      if (cur.length && cursum + it.sets > cap) {
        chunks.push(cur);
        cur = [];
        cursum = 0;
      }
      cur.push(it);
      cursum += it.sets;
    }
    if (cur.length) chunks.push(cur);

    chunks.forEach((ch, ci) => {
      const sets = ch.reduce((acc, it) => acc + it.sets, 0);
      const cdds = ch
        .map((it) => it.customerDd)
        .filter((x): x is string => parseYmd(x) !== null)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const chMin = cdds.length ? cdds[0] : "";
      const lead = isCluster ? cfg.modelLeadDays : cfg.chunkLeadDays;
      let floor: number;
      if (!chMin) {
        floor = cal.day1;
      } else {
        floor = Math.max(cal.day1, cal.backWorkday(peDay(chMin), lead));
      }
      groups.push({
        config: s.cfg,
        bmodel: s.bmodel,
        size: s.sz,
        items: ch,
        sets,
        slots: Math.max(1, Math.ceil(sets / cap)),
        cddMin: chMin,
        cddMax: cdds.length ? cdds[cdds.length - 1] : "",
        floor,
        part: [ci + 1, chunks.length],
        days: [],
        start: cal.day1,
        end: cal.day1,
        cut: "",
      });
    });
  }
  return groups;
}

// Day-pool scheduler. capFn(day) = that day's cut budget for THIS lane. A
// shared `used` counter lets two lanes draw from one pool.
function scheduleLane(
  groups: Group[],
  cal: Calendar,
  capFn: (d: number) => number,
  used: Map<number, number>,
): void {
  for (const g of groups) {
    const n = g.slots;
    g.days = [];
    let d = g.floor || cal.day1;
    const seen = new Set<number>();
    while (g.days.length < n) {
      const u = used.get(d) ?? 0;
      if (!seen.has(d) && u < capFn(d)) {
        used.set(d, u + 1);
        g.days.push(d);
        seen.add(d);
      }
      d = cal.stepWorkday(d);
    }
    g.start = g.days[0];
    g.end = g.days[g.days.length - 1];
  }
}

// ── Output formatting helpers ───────────────────────────────────────────────

const LANE_ORDER: Lane[] = ["BEDFRAME", "SOFA", "ACCESSORY"];
// English-only lane labels (the static snapshot carried mixed text; the page's
// resolveLane matches on the English word, so plain English is correct).
const LANE_LABEL: Record<Lane, string> = {
  BEDFRAME: "Bedframe",
  SOFA: "Sofa",
  ACCESSORY: "Pillow",
};

function deadlineLabel(g: Group): string {
  const lo = g.cddMin;
  const hi = g.cddMax;
  let lbl: string;
  if (!lo && !hi) lbl = "no date";
  else if (lo && hi && lo !== hi) lbl = `${fmtDayMon(parseYmd(lo)!)} -> ${fmtDayMon(parseYmd(hi)!)}`;
  else lbl = fmtDayMon(parseYmd(lo || hi)!);
  const [pa, pn] = g.part;
  if (pn > 1) lbl += `  (cut ${pa}/${pn})`;
  return lbl;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Internal cutting run. Returns the rendered snapshot PLUS the structures the
 * downstream chain needs: the calendar (so every dept shares one calendar) and
 * a map of soPo → its LAST scheduled cut day-number (a line cut across several
 * config groups waits for the last). The public scheduleCutting() is a thin
 * wrapper that returns only the snapshot.
 */
export interface CuttingRun {
  snapshot: ScheduleSnapshot;
  cal: Calendar;
  /** soPo → last scheduled cut day-number. */
  cutLastDay: Map<string, number>;
}

export function runCutting(input: SchedulerInput): CuttingRun {
  const cfg = input.config;
  const startDayNum = parseYmd(input.startDate);
  if (startDayNum === null) {
    throw new Error(`scheduleCutting: invalid startDate "${input.startDate}"`);
  }
  const holidayNums = input.holidays
    .map((h) => parseYmd(h))
    .filter((x): x is number => x !== null);
  const cal = new Calendar(startDayNum, holidayNums);

  // Shared bedframe+sofa pool. Bedframe scheduled first into `poolUsed`.
  const poolUsed = new Map<number, number>();

  // cap_for(lane, day): bedframe held back so sofaMin slots stay for sofa;
  // sofa fills the pool up to its own ceiling; accessory has its own pool.
  const bfCapFn = (d: number): number =>
    Math.min(cfg.laneCap.BEDFRAME, Math.max(1, poolCap(cal, cfg, d) - cfg.sofaMin));

  const bfRows = input.cards.filter((r) => r.lane === "BEDFRAME");
  const bfGroups = buildGroups(bfRows, "BEDFRAME", cal, cfg);
  scheduleLane(bfGroups, cal, bfCapFn, poolUsed);
  // Snapshot of bedframe-only cuts per day (sofa cap reads this).
  const bfUsed = new Map(poolUsed);

  const sofaCapFn = (d: number): number =>
    Math.min(poolCap(cal, cfg, d), (bfUsed.get(d) ?? 0) + cfg.laneCap.SOFA);

  const laneGroups: Record<Lane, Group[]> = {
    BEDFRAME: bfGroups,
    SOFA: [],
    ACCESSORY: [],
  };

  for (const lane of LANE_ORDER) {
    if (lane === "BEDFRAME") {
      // already scheduled
    } else if (lane === "SOFA") {
      const rows = input.cards.filter((r) => r.lane === "SOFA");
      const gs = buildGroups(rows, "SOFA", cal, cfg);
      scheduleLane(gs, cal, sofaCapFn, poolUsed); // shares pool
      laneGroups.SOFA = gs;
    } else {
      const rows = input.cards.filter((r) => r.lane === lane);
      const gs = buildGroups(rows, lane, cal, cfg);
      const ownPool = new Map<number, number>();
      scheduleLane(gs, cal, () => cfg.laneCap[lane], ownPool); // own capacity
      laneGroups[lane] = gs;
    }
    laneGroups[lane].forEach((g, i) => {
      g.cut = `${lane[0]}${i + 1}`;
    });
  }

  // Display cap for the By Day sheet (sofa = pool capacity bedframe left free).
  const dispCap = (lane: Lane, d: number): number => {
    if (lane === "SOFA") return Math.min(cfg.laneCap.SOFA, poolCap(cal, cfg, d) - (bfUsed.get(d) ?? 0));
    if (lane === "BEDFRAME") return bfCapFn(d);
    return cfg.laneCap[lane];
  };

  // ── Sheet 1: Cut Calendar (interleaved by date) ────────────────────────────
  const calHeaders: Cell[] = [
    "Cut Date",
    "Lane",
    "Cut #",
    "Model",
    "Size",
    "SO / PO",
    "Customer",
    "Item (one set/row)",
    "Fabric",
    "Sets",
    "Slots",
    "Customer DD",
    "Our Expected DD",
    "Batch Deadline (earliest cust. DD)",
    "Upstream",
  ];
  const calRows: Cell[][] = [calHeaders];

  interface FlatG {
    start: number;
    li: number;
    lane: Lane;
    g: Group;
  }
  const allg: FlatG[] = [];
  LANE_ORDER.forEach((lane, li) => {
    for (const g of laneGroups[lane]) allg.push({ start: g.start, li, lane, g });
  });
  allg.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.li !== b.li) return a.li - b.li;
    return a.g.cut < b.g.cut ? -1 : a.g.cut > b.g.cut ? 1 : 0;
  });

  let curDate = -1;
  const blank = (n: number): Cell[] => Array<Cell>(n).fill("");
  for (const { start: sdate, lane, g } of allg) {
    if (sdate !== curDate) {
      curDate = sdate;
      const dayN = cal.dayLabelNum(sdate);
      const sep = blank(calHeaders.length);
      sep[0] = `${fmtIso(sdate)}  ${DOW[dowOf(sdate)]}   (Day ${dayN})`;
      calRows.push(sep);
    }
    const dstr = g.start !== g.end ? `-> ${fmtMonDayDow(g.end)}` : "";
    g.items.forEach((r, i) => {
      const first = i === 0;
      calRows.push([
        first ? dstr : "",
        first ? LANE_LABEL[lane] : "",
        first ? g.cut : "",
        first ? g.config : "",
        first ? g.size : "",
        r.soPo,
        r.customer,
        r.label,
        r.fabric,
        r.sets,
        first ? g.slots : "",
        r.customerDd ?? "",
        r.expectedDd ?? "",
        first ? deadlineLabel(g) : "",
        // Fabric Cutting is the chain head — no upstream department.
        "—",
      ]);
    });
  }

  // ── Sheet 2: By Day (one row per lane-day) ─────────────────────────────────
  const byDayHeaders: Cell[] = [
    "Date",
    "Day",
    "Lane",
    "Models that day (model-size x slots)",
    "Slots",
    "Orders",
    "Cap",
  ];
  const byDayRows: Cell[][] = [byDayHeaders];

  // perday[lane][dayNum] = list of (group, slotsThatDay)
  const perday: Record<Lane, Map<number, Array<{ g: Group }>>> = {
    BEDFRAME: new Map(),
    SOFA: new Map(),
    ACCESSORY: new Map(),
  };
  for (const lane of LANE_ORDER) {
    for (const g of laneGroups[lane]) {
      for (const d of g.days) {
        const arr = perday[lane].get(d) ?? [];
        arr.push({ g });
        perday[lane].set(d, arr);
      }
    }
  }
  const allDays = new Set<number>();
  for (const lane of LANE_ORDER) for (const d of perday[lane].keys()) allDays.add(d);
  const sortedDays = [...allDays].sort((a, b) => a - b);
  for (const d of sortedDays) {
    for (const lane of LANE_ORDER) {
      const entries = perday[lane].get(d);
      if (!entries) continue;
      const models = entries
        .map(({ g }) => {
          const slotsThatDay = g.days.filter((x) => x === d).length;
          const x = slotsThatDay > 1 ? ` x${slotsThatDay}` : "";
          const cont = g.start !== g.end && d !== g.start ? " (cont.)" : "";
          return `${g.config} (${g.size})${x}${cont}`;
        })
        .join(", ");
      const norders = entries.reduce((acc, { g }) => acc + (d === g.start ? g.items.length : 0), 0);
      const slotsTotal = entries.reduce((acc, { g }) => acc + g.days.filter((x) => x === d).length, 0);
      byDayRows.push([
        `${fmtIso(d)} ${DOW[dowOf(d)]}`,
        cal.dayLabelNum(d),
        LANE_LABEL[lane],
        models,
        slotsTotal,
        norders,
        dispCap(lane, d),
      ]);
    }
  }

  // ── Sheet 0: Summary & Notes (English) ─────────────────────────────────────
  const spans: Partial<Record<Lane, { a: number; b: number; ng: number; ni: number }>> = {};
  for (const lane of LANE_ORDER) {
    const gs = laneGroups[lane];
    if (gs.length) {
      spans[lane] = {
        a: Math.min(...gs.map((g) => g.start)),
        b: Math.max(...gs.map((g) => g.end)),
        ng: gs.length,
        ni: gs.reduce((acc, g) => acc + g.items.length, 0),
      };
    }
  }
  const ncards = input.cards.length;
  const byDist: Record<Lane, number> = {
    BEDFRAME: input.cards.filter((r) => r.lane === "BEDFRAME").length,
    SOFA: input.cards.filter((r) => r.lane === "SOFA").length,
    ACCESSORY: input.cards.filter((r) => r.lane === "ACCESSORY").length,
  };
  const t0 = cfg.reserveTiers[0]?.cuts ?? 7;
  const t1 = cfg.reserveTiers[1]?.cuts ?? 6;
  const t2 = cfg.reserveTiers[cfg.reserveTiers.length - 1]?.cuts ?? 5;

  const notes: string[] = [
    "Fabric Cutting - Day-by-Day Schedule",
    `Generated ${input.generatedAt} as a live recompute from current orders. Schedules ONLY cards still to be cut (WAITING):`,
    "excludes already-cut, on-hold and cancelled. Read-only - nothing written to the ERP.",
    "",
    "[Scope]",
    `  Cards still to cut = ${ncards}  (Bedframe ${byDist.BEDFRAME} / Sofa ${byDist.SOFA} / Pillow ${byDist.ACCESSORY}).`,
    "  - Drops already-cut (COMPLETED) cards + on-hold + cancelled.",
    "  - Pillows are scheduled to match their SO's customer date so the order ships complete.",
    "",
    "[What counts as one 'cut']",
    "  - By full configuration, not model: two arm layouts of the same model are two different cuts.",
    "  - Bedframe K/Q/SS/S (6FT/5FT/3.5FT/3FT) are also different cuts.",
    "  - Same config + same size are batched together (different fabric is fine, kept in one batch).",
    "",
    "[How it's planned] merge same cuts where sensible, but don't force far-future ones together",
    `  - Same config + same size: orders with customer dates within ${cfg.pullWindowDays} days are pulled together into one cut.`,
    `    Same model due more than ${cfg.pullWindowDays} days out waits until near its own date - don't cut too early, don't flood storage.`,
    `  - One cut holds up to ${cfg.setupCap.BEDFRAME} sets; bigger batches auto-split into 2 / 3 cuts.`,
    `    Split by customer date: urgent goes in cut #1 (ASAP), later ones in cut #2 placed ${cfg.chunkLeadDays} working days before their own date,`,
    "    so cut #2 isn't jammed next to cut #1 and fabric isn't cut too early. (See the 'Batch Deadline' column's 1/2, 2/2.)",
    "  - Priority follows each cut's OWN earliest Customer DD - a far-due cut isn't pulled forward just because the same model has an urgent order.",
    "  - Same model, different size with close dates naturally fall on the same day; far-apart dates each sit near their own date.",
    `  - Bedframe & sofa share the cutters. Combined per day: first 3 working days run ${t0} cuts (orders firmest),`,
    `    days 4-7 run ${t1} (keep slots for walk-in orders), day 8+ looser (${t2}).`,
    "    Bedframe scheduled first; on bedframe-light days sofa speeds up automatically, no need to wait for all bedframe.",
    `  - The ${cfg.pullWindowDays}-day pull window is tunable via planning capacity config.`,
    "",
    "[How to read]",
    "  - Cut Calendar: by date, each day banded; see what bedframe / sofa each cut on the same day.",
    "  - By Day: one row per lane per day, see which model-sizes each lane cuts.",
    "",
    "[Resulting spans]",
  ];
  for (const lane of LANE_ORDER) {
    const sp = spans[lane];
    if (sp) {
      const tag = cfg.laneConfirmed[lane] ? "" : "  (capacity TBC)";
      notes.push(
        `  ${LANE_LABEL[lane].padEnd(10)} ${fmtMonDayDow(sp.a)} -> ${fmtMonDayDow(sp.b)}   ${sp.ng} batches / ${sp.ni} cards${tag}`,
      );
    }
  }
  notes.push("");
  notes.push("  Note: live read-only planning, not yet written to the ERP.");

  const summaryRows: Cell[][] = notes.map((t) => [t]);

  // soPo → last scheduled cut day-number (for the downstream chain coupling).
  const cutLastDay = new Map<string, number>();
  for (const lane of LANE_ORDER) {
    for (const g of laneGroups[lane]) {
      const gEnd = g.days.length ? g.days[g.days.length - 1] : g.end;
      for (const it of g.items) {
        // Optional Phase-2 collector — additive, no effect on scheduling.
        input.collect?.({
          dept: "FAB_CUT",
          soPo: it.soPo,
          lane,
          fabric: it.fabric,
          sets: it.sets,
          date: fmtIso(gEnd),
          card: it,
        });
        const po = it.soPo;
        if (!po) continue;
        const prev = cutLastDay.get(po);
        if (prev === undefined || gEnd > prev) cutLastDay.set(po, gEnd);
      }
    }
  }

  const snapshot: ScheduleSnapshot = {
    generatedAt: input.generatedAt,
    department: "Fabric Cutting",
    sheets: {
      "Summary & Notes": summaryRows,
      "Cut Calendar": calRows,
      "By Day": byDayRows,
    },
  };
  return { snapshot, cal, cutLastDay };
}

/** Public cutting entry point — returns only the snapshot (Phase 1 contract). */
export function scheduleCutting(input: SchedulerInput): ScheduleSnapshot {
  return runCutting(input).snapshot;
}
