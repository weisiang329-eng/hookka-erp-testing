// ---------------------------------------------------------------------------
// planning-capacity-audit.ts — READ-ONLY reconciliation of what the planning
// engine THINKS each department can do per day against what it ACTUALLY did.
//
// Why this exists (owner 2026-08-03): the Capacity Loading chart showed the
// plan at 15-21% while the past 14 working days ran at 97-125%. The cause is
// not missing dueDates — it is that every per-department budget in
// planning-capacity.ts is a hardcoded constant ported from the 2026-06-01
// Python builders, i.e. from BEFORE the CNC changeover on 2026-07-11. The
// engine has no idea the factory got faster.
//
// This module changes NOTHING. It only answers, per department:
//   "engine ceiling = X min/day · actual output = Y min/day · X is Z% of Y".
//
// Actual throughput comes from collectRollingCapacity() in agent-learning.ts —
// deliberately reused rather than re-implemented so the audit and the P3
// learning loop can never drift apart on what "actual" means.
//
// Expressing each engine ceiling in MINUTES is the whole point: today the
// engine meters four departments in minutes, Fabric Cutting in cut slots,
// Wood Cutting in sets, and Packing / Webbing not at all. Minutes is the only
// unit all eight can be compared in.
// ---------------------------------------------------------------------------

import {
  collectRollingCapacity,
  loadHolidaySet,
  workingDaysBack,
  ymdInSgt,
  ROLLING_WORKING_DAYS,
} from "./agent-learning";
import { loadCapacityConfig, type CapacityConfig } from "./planning-capacity";

// Structurally identical to agent-learning.ts's DbLike (this module passes the
// same handle straight through to collectRollingCapacity). `run` is required
// for that assignability only — nothing here ever calls it.
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

/** How the scheduler actually meters a department's daily budget today. */
export type EngineUnit = "minutes" | "cut-slots" | "sets" | "none";

export interface DeptCapacityAudit {
  dept: string;
  label: string;
  /** The unit the engine budgets this department in RIGHT NOW. */
  engineUnit: EngineUnit;
  /** Human-readable dump of the configured numbers behind engineMinPerDay. */
  configured: string;
  /**
   * The engine's steady-state daily ceiling converted to minutes. Null when
   * the department has no budget at all (Packing / Webbing). "Steady state"
   * means the LAST reserve tier — i.e. day 8 onwards, which is most of the
   * 21-day planning window.
   */
  engineMinPerDay: number | null;
  /** Rolling actual output, minutes per working day (7 working days). */
  actualMinPerDay: number;
  /** engineMinPerDay ÷ actualMinPerDay × 100. Null when either side is 0/null. */
  enginePctOfActual: number | null;
  /** What a minutes-based engine should budget — i.e. the actual throughput. */
  suggestedMinPerDay: number;
  note: string;
}

/**
 * A WAITING card carrying no production time at all. The scheduler prices work
 * as `productionTimeMinutes × wipQty`, falling back to `estMinutes` — when both
 * are zero the card costs nothing, so the engine happily stacks unlimited
 * numbers of them onto one day. They are invisible overload.
 */
export interface ZeroMinuteCards {
  dept: string;
  cards: number;
}

export interface CapacityAudit {
  generatedAt: string;
  /** First day of the rolling actual window (inclusive) and the exclusive end. */
  windowFrom: string;
  windowTo: string;
  windowWorkingDays: number;
  depts: DeptCapacityAudit[];
  /**
   * Data-quality check: WAITING cards the scheduler will treat as free work.
   * Empty is the healthy state.
   */
  zeroMinuteCards: ZeroMinuteCards[];
  zeroMinuteTotal: number;
}

const DEPT_LABELS: Record<string, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  WOOD_CUT: "Wood Cutting",
  FOAM_CUTTING: "Foam Cutting",
  FRAMING: "Framing",
  FOAM: "Foam Bonding",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
  WEBBING: "Webbing",
};

const DEPT_ORDER = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM_CUTTING",
  "FRAMING",
  "FOAM",
  "UPHOLSTERY",
  "PACKING",
  "WEBBING",
];

/**
 * The steady-state cut budget the cutting scheduler really grants each lane.
 * Mirrors runCutting's bfCapFn / sofaCapFn EXACTLY — including the fact that
 * laneCap.BEDFRAME and sofaMin both clamp bedframe, which is what drops the
 * bedframe lane to 2 cuts/day on the last reserve tier under the defaults.
 */
export function steadyStateCuts(cfg: CapacityConfig): {
  pool: number;
  bedframe: number;
  sofa: number;
  accessory: number;
} {
  const tiers = cfg.reserveTiers;
  const pool = tiers.length ? tiers[tiers.length - 1].cuts : 0;
  const bedframe = Math.min(cfg.laneCap.BEDFRAME, Math.max(1, pool - cfg.sofaMin));
  // Sofa shares the pool: it may fill up to min(pool, bedframeUsed + laneCap.SOFA),
  // so what is LEFT for sofa is that ceiling minus what bedframe already took.
  const sofa = Math.max(0, Math.min(pool, bedframe + cfg.laneCap.SOFA) - bedframe);
  // Accessory runs on its own pool, not the shared one.
  const accessory = cfg.laneCap.ACCESSORY;
  return { pool, bedframe, sofa, accessory };
}

/**
 * Fabric Cutting's effective daily ceiling in CNC minutes. The scheduler
 * grants CUT SLOTS; each slot carries at most setupCap[lane] sets; each set
 * costs cnc.<lane>SetMin. Fabric changes are NOT added — the slot model has
 * no notion of them (which is precisely why same-fabric batching currently
 * earns nothing in the schedule).
 */
export function fabCutEngineMinutes(cfg: CapacityConfig): number {
  const cuts = steadyStateCuts(cfg);
  return Math.round(
    cuts.bedframe * cfg.setupCap.BEDFRAME * cfg.cnc.bedframeSetMin +
      cuts.sofa * cfg.setupCap.SOFA * cfg.cnc.sofaSetMin +
      cuts.accessory * cfg.setupCap.ACCESSORY * cfg.cnc.accessoryPieceMin,
  );
}

/**
 * Rolling actual SETS per working day, per department — only needed to convert
 * Wood Cutting's sets/day budget into minutes. Same window and same
 * status/date filter as collectRollingCapacity so the two are consistent.
 */
async function collectRollingSets(
  db: DbLike,
  today: string,
  since: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await db
      .prepare(
        `SELECT jc.departmentCode AS dept,
                SUM(COALESCE(jc.wipQty, 1)) AS sets
           FROM job_cards jc
          WHERE jc.status IN ('COMPLETED','TRANSFERRED')
            AND substr(jc.completedDate::text,1,10) >= ?
            AND substr(jc.completedDate::text,1,10) < ?
          GROUP BY 1`,
      )
      .bind(since, today)
      .all<{ dept: string; sets: number | string }>();
    for (const r of res.results ?? []) {
      out.set(r.dept, Number(r.sets) || 0);
    }
  } catch {
    // Best-effort — a missing column just means Wood Cutting reports no
    // minutes equivalent, never a failed audit.
  }
  return out;
}

/**
 * WAITING cards whose production time resolves to zero, per department. These
 * are scheduled as if they take no time at all, so they silently overload
 * whatever day they land on.
 */
async function collectZeroMinuteCards(db: DbLike): Promise<ZeroMinuteCards[]> {
  try {
    const res = await db
      .prepare(
        `SELECT jc.departmentCode AS dept, COUNT(*) AS cards
           FROM job_cards jc
          WHERE jc.status = 'WAITING'
            AND COALESCE(jc.productionTimeMinutes, 0) <= 0
            AND COALESCE(jc.estMinutes, 0) <= 0
          GROUP BY 1
          ORDER BY 2 DESC`,
      )
      .bind()
      .all<{ dept: string; cards: number | string }>();
    return (res.results ?? []).map((r) => ({
      dept: r.dept ?? "(none)",
      cards: Number(r.cards) || 0,
    }));
  } catch {
    return [];
  }
}

function pct(engine: number | null, actual: number): number | null {
  if (engine === null || actual <= 0) return null;
  return Math.round((engine / actual) * 1000) / 10;
}

/**
 * Build the full audit. Read-only: no writes, no schedule run, two cheap
 * aggregate queries plus the capacity config.
 */
export async function buildCapacityAudit(db: DbLike): Promise<CapacityAudit> {
  const today = ymdInSgt();
  const holidays = await loadHolidaySet(db);
  const since = workingDaysBack(today, ROLLING_WORKING_DAYS, holidays);

  const [cfg, actualMin, actualSets, zeroMinuteCards] = await Promise.all([
    loadCapacityConfig(db),
    collectRollingCapacity(db, today, holidays),
    collectRollingSets(db, today, since),
    collectZeroMinuteCards(db),
  ]);

  const chain = cfg.chain;
  const cuts = steadyStateCuts(cfg);

  // Wood Cutting is budgeted in SETS. Convert using the department's own
  // observed minutes-per-set over the same window; with no completed sets in
  // the window there is nothing to convert from, so it stays null.
  const woodSetsTotal = actualSets.get("WOOD_CUT") ?? 0;
  const woodMinPerDay = actualMin.get("WOOD_CUT") ?? 0;
  const woodMinPerSet =
    woodSetsTotal > 0 ? (woodMinPerDay * ROLLING_WORKING_DAYS) / woodSetsTotal : null;
  const woodCapSets = chain.woodCapSets.BEDFRAME + chain.woodCapSets.SOFA;

  const depts: DeptCapacityAudit[] = DEPT_ORDER.map((dept) => {
    const actual = actualMin.get(dept) ?? 0;
    let engineUnit: EngineUnit = "minutes";
    let engineMin: number | null = null;
    let configured = "";
    let note = "";

    switch (dept) {
      case "FAB_CUT": {
        engineUnit = "cut-slots";
        engineMin = fabCutEngineMinutes(cfg);
        configured =
          `steady-state pool ${cuts.pool} cuts/day → bedframe ${cuts.bedframe} · ` +
          `sofa ${cuts.sofa} · accessory ${cuts.accessory}; ` +
          `setup ${cfg.setupCap.BEDFRAME}/${cfg.setupCap.SOFA}/${cfg.setupCap.ACCESSORY} sets per cut; ` +
          `CNC ${cfg.cnc.bedframeSetMin}/${cfg.cnc.sofaSetMin}/${cfg.cnc.accessoryPieceMin} min per set`;
        note =
          "Budgeted in cut SLOTS, not minutes. A batch of 1 set consumes a whole " +
          "slot, so fragmented orders burn the day's budget without filling it. " +
          "Fabric changes cost nothing here, so same-fabric batching earns nothing.";
        break;
      }
      case "FAB_SEW": {
        engineMin =
          chain.sewCapMin.BEDFRAME + chain.sewCapMin.SOFA + chain.sewCapMin.ACCESSORY;
        configured =
          `bedframe ${chain.sewCapMin.BEDFRAME} + sofa ${chain.sewCapMin.SOFA} + ` +
          `accessory ${chain.sewCapMin.ACCESSORY} min/day`;
        note =
          "Already minutes-based and due-date ordered. Lanes hold separate budgets, " +
          "so this sum is the best case only when all three lanes have work.";
        break;
      }
      case "WOOD_CUT": {
        engineUnit = "sets";
        engineMin = woodMinPerSet === null ? null : Math.round(woodCapSets * woodMinPerSet);
        configured = `bedframe ${chain.woodCapSets.BEDFRAME} + sofa ${chain.woodCapSets.SOFA} sets/day`;
        note =
          woodMinPerSet === null
            ? "Budgeted in SETS. No completed sets in the window, so no minutes equivalent."
            : `Budgeted in SETS. Converted at the observed ${Math.round(woodMinPerSet)} min/set ` +
              "over the same window.";
        break;
      }
      case "FRAMING": {
        engineMin = chain.frameCapMin.BEDFRAME + chain.frameCapMin.SOFA;
        configured = `bedframe ${chain.frameCapMin.BEDFRAME} + sofa ${chain.frameCapMin.SOFA} min/day`;
        note = "Already minutes-based and due-date ordered.";
        break;
      }
      case "FOAM": {
        engineMin = chain.foamCapMin;
        configured = `${chain.foamCapMin} min/day`;
        note =
          "Covers sofa base + armrest ONLY. Headboard foam and back cushions ride " +
          "the framing/foam day unbudgeted, so actual output legitimately exceeds this.";
        break;
      }
      case "UPHOLSTERY": {
        engineMin = chain.uphCapMin.BEDFRAME + chain.uphCapMin.SOFA;
        configured = `bedframe ${chain.uphCapMin.BEDFRAME} + sofa ${chain.uphCapMin.SOFA} min/day`;
        note = "Already minutes-based and due-date ordered.";
        break;
      }
      case "PACKING": {
        engineUnit = "none";
        configured = "no budget";
        note =
          "No capacity at all — packing units simply follow the upholstery day. " +
          "The schedule cannot show a packing bottleneck because it cannot model one.";
        break;
      }
      case "WEBBING": {
        engineUnit = "none";
        configured = "no budget";
        note =
          "No capacity at all — webbing rides the same day as its SO's framing.";
        break;
      }
      default:
        break;
    }

    return {
      dept,
      label: DEPT_LABELS[dept] ?? dept,
      engineUnit,
      configured,
      engineMinPerDay: engineMin,
      actualMinPerDay: actual,
      enginePctOfActual: pct(engineMin, actual),
      suggestedMinPerDay: actual,
      note,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    windowFrom: since,
    windowTo: today,
    windowWorkingDays: ROLLING_WORKING_DAYS,
    depts,
    zeroMinuteCards,
    zeroMinuteTotal: zeroMinuteCards.reduce((s, z) => s + z.cards, 0),
  };
}
