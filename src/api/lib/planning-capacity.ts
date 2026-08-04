// ---------------------------------------------------------------------------
// Planning capacity configuration (Fab Cut, Phase 1).
//
// The cutting scheduler (planning-scheduler.ts) is driven entirely by these
// constants — the per-lane caps, the shared bedframe+sofa pool, the reserve
// tiers and the lead/window knobs. They are the TypeScript port of the values
// confirmed by the factory owner in the trusted Python cutter (Wei Siang,
// 2026-06-01). Keeping them in their own typed module means:
//   • the pure scheduler takes a CapacityConfig argument (no hard-coded magic
//     numbers buried in the algorithm), so it stays testable; and
//   • the owner can override any value at runtime via kv_config without a
//     deploy (loadCapacityConfig merges kv_config['planning_capacity'] over the
//     defaults below).
//
// No Hono / DB types leak into the scheduler — only this loader touches the DB.
// All values are integers / day-index based; nothing here depends on a clock.
// ---------------------------------------------------------------------------

/** Production lanes the cutting scheduler plans, in priority order. */
export type Lane = "BEDFRAME" | "SOFA" | "ACCESSORY";

/** A reserve tier: working days up to (and including) `uptoDay` get `cuts`. */
export interface ReserveTier {
  /** Inclusive working-day index ceiling (1 = first working day). */
  uptoDay: number;
  /** Total bedframe+sofa cuts allowed per day inside this tier. */
  cuts: number;
}

/**
 * Per-department capacities + handoffs for the downstream chain
 * (Fab Sew → Wood Cut → Framing → Foam Bonding → Upholstery → Packing).
 *
 * All defaults mirror the trusted Python builders
 * (scripts/_algo_ref/build_{sewing,woodcut,framing}_daily_xlsx.py, owner-
 * confirmed Wei Siang 2026-06-01/02). Production lanes here are BEDFRAME / SOFA
 * (+ ACCESSORY for sewing pillows only). Capacities are integers; minutes/day
 * for the hour-gated stages, sets/day for wood cutting. Handoffs are working
 * days. Nothing here depends on a clock.
 */
export interface ChainConfig {
  /** Fabric sewing: minutes/day per lane (SOFA 2100, BEDFRAME 1200, ACCESSORY 240). */
  sewCapMin: { BEDFRAME: number; SOFA: number; ACCESSORY: number };
  /** Pillow sew time override (min/pc) — ERP's 300 is wrong; the bench reality is 15. */
  pillowMinEach: number;
  /** Cut → sew handoff in working days (sew floor = cut day + this). */
  sewHandoffDays: number;
  /** Wood cutting: sets/day per lane (BEDFRAME 20, SOFA 10). */
  woodCapSets: { BEDFRAME: number; SOFA: number };
  /** Sew → wood handoff in working days (wood floor = sew end + this). */
  woodHandoffDays: number;
  /** Framing: minutes/day per lane (BEDFRAME 22h, SOFA 8h). */
  frameCapMin: { BEDFRAME: number; SOFA: number };
  /** Wood → frame handoff in working days. */
  frameHandoffDays: number;
  /** Sofa foam bonding: minutes/day for base+armrest only (8h). */
  foamCapMin: number;
  /** Sofa framing → foam handoff in working days. */
  foamHandoffDays: number;
  /**
   * Foam Cutting (owner 2026-08-03). A SOURCE stage like Fabric Cutting and
   * Wood Cutting — it waits on no upstream department, because the raw foam is
   * simply there. What it IS tied to is the day its output is needed, so it is
   * pulled back this many WORKING days from that SO's Foam Bonding day.
   * Owner: "把它放成 Foam Bonding 的前一天就是了" — 1, revisit later.
   */
  foamCutLeadDays: number;
  /** Foam Cutting: minutes/day. Measured throughput overrides this. */
  foamCutCapMin: number;
  /**
   * Walk-in reserve (owner 2026-08-04: "有些时候他们会一直插单").
   *
   * The near days are packed FULL — that work is imminent and there is no
   * point holding capacity back from it. From `reserveAfterDay` onwards a
   * slice of each day is left unplanned so an order that walks in tomorrow
   * has somewhere to go; without it the plan fills every future day and every
   * insert forces a reshuffle of work already promised to the floor.
   *
   * Owner's numbers: full for the first 3 working days, then hold back 10-20%.
   */
  reserveAfterDay: number;
  /** Percent of a day held back beyond `reserveAfterDay` (0-90). */
  reservePct: number;
  /** Upholstery: minutes/day per lane (BEDFRAME 24h, SOFA 12h). */
  uphCapMin: { BEDFRAME: number; SOFA: number };
  /** Upstream → upholstery handoff in working days. */
  uphHandoffDays: number;
}

/**
 * Owner-confirmed downstream-chain defaults (Wei Siang, 2026-06-01/02), ported
 * verbatim from the trusted Python builders:
 *   • sew minutes/day: SOFA 2100 / BEDFRAME 1200 / ACCESSORY 240; pillow 15min/pc
 *   • wood sets/day: BEDFRAME 20 / SOFA 10
 *   • framing minutes/day: BEDFRAME 1320 (22h) / SOFA 480 (8h)
 *   • foam (base+armrest) 480 min/day (8h)
 *   • upholstery minutes/day: BEDFRAME 1440 (24h) / SOFA 720 (12h)
 *   • handoffs: cut→sew +1, sew→wood +2, wood→frame +1, frame→foam +1, →uph +1
 */
export const DEFAULT_CHAIN_CONFIG: ChainConfig = {
  sewCapMin: { BEDFRAME: 1200, SOFA: 2100, ACCESSORY: 240 },
  pillowMinEach: 15,
  sewHandoffDays: 1,
  woodCapSets: { BEDFRAME: 20, SOFA: 10 },
  woodHandoffDays: 2,
  frameCapMin: { BEDFRAME: 22 * 60, SOFA: 8 * 60 },
  frameHandoffDays: 1,
  foamCapMin: 8 * 60,
  foamHandoffDays: 1,
  foamCutLeadDays: 1,
  foamCutCapMin: 8 * 60,
  reserveAfterDay: 3,
  reservePct: 15,
  uphCapMin: { BEDFRAME: 24 * 60, SOFA: 12 * 60 },
  uphHandoffDays: 1,
};

export interface CapacityConfig {
  /** Per-lane ceiling of cuts/day inside the shared pool. */
  laneCap: Record<Lane, number>;
  /**
   * Reserve-capacity tiers for the shared bedframe+sofa pool, ascending by
   * `uptoDay`. Near days are packed tight; far days stay loose so spare slots
   * remain for orders that walk in later. The last tier's `uptoDay` should be
   * effectively unbounded.
   */
  reserveTiers: ReserveTier[];
  /** Guaranteed minimum sofa cuts/day so sofa is never starved by bedframe. */
  sofaMin: number;
  /** Max sets in ONE cut, per lane. Bigger batches auto-split into chunks. */
  setupCap: Record<Lane, number>;
  /**
   * Only merge same-cut orders whose customer delivery dates fall within this
   * many days of each other. Orders due further out wait for a later batch.
   */
  pullWindowDays: number;
  /**
   * When a batch splits into multiple cuts, each later cut floors this many
   * working days before its own earliest customer DD (non-cluster lanes).
   */
  chunkLeadDays: number;
  /**
   * Cluster lanes keep a model's cuts together, flooring this many working
   * days before the model's earliest customer DD (looser than chunkLeadDays so
   * a model's later cuts pull in next to its first).
   */
  modelLeadDays: number;
  /** Lanes that use the model-block (concentrated) ordering. */
  clusterLanes: Lane[];
  /** Whether each lane's capacity figure is owner-confirmed (Pillow is TBC). */
  laneConfirmed: Record<Lane, boolean>;
  /** Downstream-chain capacities + handoffs (sew → … → packing). */
  chain: ChainConfig;
  /**
   * CNC cutting model (owner 2026-07-11). Fabric Cutting moved from the
   * slot-based "cuts/day" model to ONE CNC machine cutting in MINUTES:
   *   - a bedframe SET (Headboard + Divan together) ≈ 8 min
   *   - a sofa SET ≈ 20 min
   *   - an accessory / pillow piece ≈ 4 min
   *   - every fabric/colour change ≈ 10 min re-rigging — so scheduling must
   *     batch SAME-FABRIC work together (fabric is the primary grouping key).
   * Machine count 1; daily runtime follows demand (no hard cap) — the
   * `referenceDayMin` is only a reporting yardstick (≈ one 9h shift) for
   * "today's CNC load ≈ X hours" style displays, not a scheduling ceiling.
   * These feed the Morning Brief now and Scheduler v2 (fabric-first batching)
   * next; the legacy slot fields above stay until v2 replaces them.
   */
  cnc: {
    bedframeSetMin: number;
    sofaSetMin: number;
    accessoryPieceMin: number;
    fabricChangeMin: number;
    machines: number;
    referenceDayMin: number;
  };
}

/**
 * Owner-confirmed defaults (Wei Siang, 2026-06-01), ported verbatim from
 * scripts/_algo_ref/build_cutting_daily_xlsx.py.
 *   • pool reserve tiers: days 1-3 → 7, 4-7 → 6, 8+ → 5
 *   • lane ceilings: bedframe 6 / sofa 6 / accessory 8
 *   • setup caps (sets per cut): bedframe 8 / sofa 3 / accessory 8
 *   • sofa guaranteed minimum: 3 cuts/day
 *   • pull window 10 days; chunk lead 3; model lead 6
 *   • cluster lanes: bedframe + sofa
 */
export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  laneCap: { BEDFRAME: 6, SOFA: 6, ACCESSORY: 8 },
  reserveTiers: [
    { uptoDay: 3, cuts: 7 },
    { uptoDay: 7, cuts: 6 },
    { uptoDay: Number.MAX_SAFE_INTEGER, cuts: 5 },
  ],
  sofaMin: 3,
  setupCap: { BEDFRAME: 8, SOFA: 3, ACCESSORY: 8 },
  pullWindowDays: 10,
  chunkLeadDays: 3,
  modelLeadDays: 6,
  clusterLanes: ["BEDFRAME", "SOFA"],
  laneConfirmed: { BEDFRAME: true, SOFA: true, ACCESSORY: false },
  chain: DEFAULT_CHAIN_CONFIG,
  cnc: {
    bedframeSetMin: 8,
    sofaSetMin: 20,
    accessoryPieceMin: 4,
    fabricChangeMin: 10,
    machines: 1,
    referenceDayMin: 9 * 60,
  },
};

/** Minimal DB shape — mirrors the `.first()` accessor used across routes. */
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

const LANES: Lane[] = ["BEDFRAME", "SOFA", "ACCESSORY"];

function isLaneRecord(v: unknown): v is Partial<Record<Lane, number>> {
  return typeof v === "object" && v !== null;
}

/** Deep-clone the default so callers never mutate the shared constant. */
function cloneDefaults(): CapacityConfig {
  return {
    laneCap: { ...DEFAULT_CAPACITY_CONFIG.laneCap },
    reserveTiers: DEFAULT_CAPACITY_CONFIG.reserveTiers.map((t) => ({ ...t })),
    sofaMin: DEFAULT_CAPACITY_CONFIG.sofaMin,
    setupCap: { ...DEFAULT_CAPACITY_CONFIG.setupCap },
    pullWindowDays: DEFAULT_CAPACITY_CONFIG.pullWindowDays,
    chunkLeadDays: DEFAULT_CAPACITY_CONFIG.chunkLeadDays,
    modelLeadDays: DEFAULT_CAPACITY_CONFIG.modelLeadDays,
    clusterLanes: [...DEFAULT_CAPACITY_CONFIG.clusterLanes],
    laneConfirmed: { ...DEFAULT_CAPACITY_CONFIG.laneConfirmed },
    chain: cloneChain(),
    cnc: { ...DEFAULT_CAPACITY_CONFIG.cnc },
  };
}

/** Deep-clone the default chain config so callers never mutate the constant. */
function cloneChain(): ChainConfig {
  const c = DEFAULT_CHAIN_CONFIG;
  return {
    sewCapMin: { ...c.sewCapMin },
    pillowMinEach: c.pillowMinEach,
    sewHandoffDays: c.sewHandoffDays,
    woodCapSets: { ...c.woodCapSets },
    woodHandoffDays: c.woodHandoffDays,
    frameCapMin: { ...c.frameCapMin },
    frameHandoffDays: c.frameHandoffDays,
    foamCapMin: c.foamCapMin,
    foamHandoffDays: c.foamHandoffDays,
    foamCutLeadDays: c.foamCutLeadDays,
    foamCutCapMin: c.foamCutCapMin,
    reserveAfterDay: c.reserveAfterDay,
    reservePct: c.reservePct,
    uphCapMin: { ...c.uphCapMin },
    uphHandoffDays: c.uphHandoffDays,
  };
}

/** Merge a (possibly partial / malformed) chain override over the defaults. */
function mergeChain(base: ChainConfig, override: unknown): void {
  if (typeof override !== "object" || override === null) return;
  const o = override as Record<string, unknown>;
  const posInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  const nonNegInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

  const mergeLaneMin = (target: Record<string, number>, src: unknown, keys: string[]): void => {
    if (typeof src !== "object" || src === null) return;
    const s = src as Record<string, unknown>;
    for (const k of keys) {
      const v = posInt(s[k]);
      if (v !== null) target[k] = v;
    }
  };

  mergeLaneMin(base.sewCapMin, o.sewCapMin, ["BEDFRAME", "SOFA", "ACCESSORY"]);
  mergeLaneMin(base.woodCapSets, o.woodCapSets, ["BEDFRAME", "SOFA"]);
  mergeLaneMin(base.frameCapMin, o.frameCapMin, ["BEDFRAME", "SOFA"]);
  mergeLaneMin(base.uphCapMin, o.uphCapMin, ["BEDFRAME", "SOFA"]);

  const pme = posInt(o.pillowMinEach);
  if (pme !== null) base.pillowMinEach = pme;
  const fcm = posInt(o.foamCapMin);
  if (fcm !== null) base.foamCapMin = fcm;
  const fccm = posInt(o.foamCutCapMin);
  if (fccm !== null) base.foamCutCapMin = fccm;

  for (const key of [
    "sewHandoffDays",
    "woodHandoffDays",
    "frameHandoffDays",
    "foamHandoffDays",
    "uphHandoffDays",
    "foamCutLeadDays",
    "reserveAfterDay",
    "reservePct",
  ] as const) {
    const v = nonNegInt(o[key]);
    if (v !== null) base[key] = v;
  }
}

/**
 * Merge a (possibly partial, possibly malformed) override object over the
 * defaults. Only well-typed fields are taken; anything missing or the wrong
 * shape falls back to the default. Pure — no DB / clock.
 */
export function mergeCapacityConfig(override: unknown): CapacityConfig {
  const cfg = cloneDefaults();
  if (typeof override !== "object" || override === null) return cfg;
  const o = override as Record<string, unknown>;

  if (isLaneRecord(o.laneCap)) {
    for (const lane of LANES) {
      const v = o.laneCap[lane];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) cfg.laneCap[lane] = Math.floor(v);
    }
  }
  if (isLaneRecord(o.setupCap)) {
    for (const lane of LANES) {
      const v = o.setupCap[lane];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) cfg.setupCap[lane] = Math.floor(v);
    }
  }
  if (Array.isArray(o.reserveTiers)) {
    const tiers: ReserveTier[] = [];
    for (const t of o.reserveTiers) {
      if (
        typeof t === "object" &&
        t !== null &&
        typeof (t as ReserveTier).uptoDay === "number" &&
        typeof (t as ReserveTier).cuts === "number" &&
        (t as ReserveTier).cuts > 0
      ) {
        tiers.push({
          uptoDay: Math.floor((t as ReserveTier).uptoDay),
          cuts: Math.floor((t as ReserveTier).cuts),
        });
      }
    }
    if (tiers.length > 0) {
      tiers.sort((a, b) => a.uptoDay - b.uptoDay);
      cfg.reserveTiers = tiers;
    }
  }
  if (typeof o.sofaMin === "number" && Number.isFinite(o.sofaMin) && o.sofaMin >= 0) {
    cfg.sofaMin = Math.floor(o.sofaMin);
  }
  if (typeof o.pullWindowDays === "number" && o.pullWindowDays > 0) {
    cfg.pullWindowDays = Math.floor(o.pullWindowDays);
  }
  if (typeof o.chunkLeadDays === "number" && o.chunkLeadDays >= 0) {
    cfg.chunkLeadDays = Math.floor(o.chunkLeadDays);
  }
  if (typeof o.modelLeadDays === "number" && o.modelLeadDays >= 0) {
    cfg.modelLeadDays = Math.floor(o.modelLeadDays);
  }
  if (Array.isArray(o.clusterLanes)) {
    const lanes = o.clusterLanes.filter(
      (l): l is Lane => typeof l === "string" && (LANES as string[]).includes(l),
    );
    cfg.clusterLanes = lanes;
  }
  if (isLaneRecord(o.laneConfirmed)) {
    for (const lane of LANES) {
      const v = (o.laneConfirmed as Record<string, unknown>)[lane];
      if (typeof v === "boolean") cfg.laneConfirmed[lane] = v;
    }
  }
  mergeChain(cfg.chain, o.chain);
  // CNC model overrides (owner-tunable per-key; invalid values keep defaults).
  if (typeof o.cnc === "object" && o.cnc !== null) {
    const oc = o.cnc as Record<string, unknown>;
    const keys = [
      "bedframeSetMin",
      "sofaSetMin",
      "accessoryPieceMin",
      "fabricChangeMin",
      "machines",
      "referenceDayMin",
    ] as const;
    for (const k of keys) {
      const v = oc[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        cfg.cnc[k] = k === "machines" ? Math.max(1, Math.floor(v)) : v;
      }
    }
  }
  return cfg;
}

/**
 * Load the effective capacity config: kv_config['planning_capacity'] merged
 * over DEFAULT_CAPACITY_CONFIG. A missing / malformed row yields the defaults.
 */
export async function loadCapacityConfig(db: DbLike): Promise<CapacityConfig> {
  let override: unknown = null;
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("planning_capacity")
      .first<{ value: string }>();
    if (row?.value) override = JSON.parse(row.value);
  } catch {
    // Missing table / malformed JSON → fall back to defaults.
    override = null;
  }
  return mergeCapacityConfig(override);
}
