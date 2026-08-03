// ---------------------------------------------------------------------------
// planning-adaptive-capacity.ts — the scheduler's daily minute budget, MEASURED
// instead of declared.
//
// Every per-department budget in planning-capacity.ts is a constant ported from
// the 2026-06-01 Python builders — i.e. from before the CNC changeover on
// 2026-07-11. The floor got faster and the scheduler never found out, which is
// why the plan sat at 15-21% while the past 14 working days ran at 97-125%.
// AGENTS-BLUEPRINT promised this ("产能感知 = 近 7 工作天实际完成量（自适应，
// CNC 变快数字自动涨）") and only the Capacity Loading chart ever delivered it.
//
// The rule: a department's budget for tomorrow is what that department has
// actually been producing per working day, subject to three guard rails, in
// order of application:
//
//   1. COLD START — a department with no completed work in the window keeps its
//      configured constant. A quiet week must never drive a budget to zero and
//      strand every order behind it.
//   2. RATE LIMIT — the budget moves at most ±20% per day away from the last
//      value that was actually used. Capacity that lurches reschedules the
//      whole factory overnight; the floor stops trusting a plan that changes
//      shape every morning. Drift, don't jump.
//   3. FIRST-RUN CEILING — with no prior value to rate-limit against, a single
//      bad data day (a bulk back-dated completion, say) could otherwise install
//      an absurd budget in one step, so the first observation is capped at 3×
//      the configured constant.
//
// Persistence is OPT-IN (`persist: true`). The read-only audit previews what
// this WOULD set without writing, so a GET never mutates the plan; only the
// agent's own scheduled run commits a new value.
// ---------------------------------------------------------------------------

import { loadHolidaySet, workingDaysBack, ymdInSgt } from "./agent-learning";
import { loadCapacityConfig, type CapacityConfig } from "./planning-capacity";
import { fabCutEngineMinutes } from "./planning-capacity-audit";

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

/** kv_config key holding the last committed budget per department. */
export const EFFECTIVE_CAPACITY_KEY = "planning_effective_capacity";

/** Most a budget may move per day, either direction. */
export const MAX_DAILY_DRIFT = 0.2;
/** With no prior value, cap the first observation at this multiple of config. */
export const FIRST_RUN_MAX_GROWTH = 3;
/** A department is never budgeted below this — a floor, not a target. */
export const MIN_BUDGET_MIN = 30;

// ── How capacity is measured ────────────────────────────────────────────────
//
// Daily output is VERY noisy — Fabric Cutting's last 14 working days ran from
// 35% to 165% of its own average, Wood Cutting had a 14% day. A 7-day plain
// mean therefore measures "which 7 days happened to be in the window" as much
// as it measures capacity, and a single bad day drags the whole budget down.
//
// So capacity is taken as a TRIMMED MEAN over a window of working days:
//   • zero-output days dropped — an unlogged holiday, a shutdown or a missing
//     completion batch is an absence of DATA, not evidence of low capacity.
//     Averaging them in would teach the engine the factory is slower than it is;
//   • top and bottom decile discarded — a heroic push and a broken machine are
//     both real, and both are the wrong number to plan every day around.
//
// What survives is "what this department does on an ordinary day", which is the
// only figure a schedule should be built on. The ±20%/day drift limit then
// smooths the remaining movement.
//
// WINDOW LENGTH is a real trade-off and the owner's call (2026-08-03): a long
// window is statistically calmer but keeps averaging in a workforce that no
// longer exists — "工厂有时候我添加人、减少人". 15 working days (~2.5 weeks of
// Mon-Sat) is short enough that a headcount change shows up within a fortnight,
// while still giving the trim 13 days to work with after the extremes are cut.
/** Working days of history used for the robust capacity estimate. */
export const CAPACITY_WINDOW_DAYS = 15;
/** Fraction discarded from EACH end before averaging. */
export const TRIM_FRACTION = 0.1;
/** Below this many samples, trimming throws away more signal than noise. */
export const MIN_SAMPLES_FOR_TRIM = 8;

/** kv_config key holding owner-pinned budgets that override measurement. */
export const CAPACITY_PINS_KEY = "planning_capacity_pins";

/** Bounds on a pinned value — a typo must not install an absurd budget. */
export const MIN_PIN_MIN = 30;
export const MAX_PIN_MIN = 24 * 60 * 20; // 20 people × 24h, far past any real day

/**
 * Central tendency of a noisy daily-output series, with the extremes removed.
 *
 * A plain mean lets one heroic day or one breakdown move the number the whole
 * factory is scheduled against; the median throws away most of the data to
 * avoid that. Trimming a decile off each end keeps the bulk of the evidence
 * while refusing to plan around either tail. Small samples are averaged
 * outright — with under `MIN_SAMPLES_FOR_TRIM` points, trimming discards
 * signal rather than noise.
 *
 * Pure, so the statistic can be tested without a database.
 */
export function trimmedMean(samples: number[], trim = TRIM_FRACTION): number {
  const xs = samples.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length < MIN_SAMPLES_FOR_TRIM) {
    return Math.round(xs.reduce((s, n) => s + n, 0) / xs.length);
  }
  const cut = Math.floor(xs.length * trim);
  const kept = xs.slice(cut, xs.length - cut);
  const use = kept.length > 0 ? kept : xs;
  return Math.round(use.reduce((s, n) => s + n, 0) / use.length);
}

export type CapacityReason =
  | "measured"
  | "cold-start"
  | "rate-limited-up"
  | "rate-limited-down"
  | "first-run-capped"
  | "pinned";

export interface DeptBudget {
  dept: string;
  /** The robust estimate the budget is built on, minutes per working day. */
  measuredMinPerDay: number;
  /** Working days with real output that fed the estimate. */
  sampleDays: number;
  /** Lowest and highest daily output seen in the window — the spread. */
  observedMin: number;
  observedMax: number;
  /** The hardcoded constant this department would otherwise use. */
  configuredMinPerDay: number;
  /** The budget in force before this resolve (null on the very first run). */
  previousMinPerDay: number | null;
  /** What the scheduler should actually use tomorrow. */
  effectiveMinPerDay: number;
  reason: CapacityReason;
}

export interface AdaptiveCapacity {
  date: string;
  /** Convenience map for the scheduler: dept → effective minutes/day. */
  byDept: Record<string, number>;
  budgets: DeptBudget[];
  /** True when a new value was committed to kv_config. */
  persisted: boolean;
}

const DEPTS = [
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
 * The constant a department falls back to. Packing and Webbing have never had
 * a budget, so they have no constant to fall back to — they rely entirely on
 * measurement, and until they have been measured they stay unbudgeted (null).
 */
export function configuredMinutes(cfg: CapacityConfig, dept: string): number | null {
  const c = cfg.chain;
  switch (dept) {
    case "FAB_CUT":
      return fabCutEngineMinutes(cfg);
    case "FAB_SEW":
      return c.sewCapMin.BEDFRAME + c.sewCapMin.SOFA + c.sewCapMin.ACCESSORY;
    case "FRAMING":
      return c.frameCapMin.BEDFRAME + c.frameCapMin.SOFA;
    case "FOAM":
      return c.foamCapMin;
    case "FOAM_CUTTING":
      return c.foamCutCapMin;
    case "UPHOLSTERY":
      return c.uphCapMin.BEDFRAME + c.uphCapMin.SOFA;
    case "WOOD_CUT":
      // Budgeted in sets, so there is no minute constant to fall back to.
      return null;
    default:
      return null;
  }
}

/**
 * Apply the three guard rails to one department. Pure — exported so the rules
 * can be tested without a database.
 */
export function resolveOne(
  dept: string,
  measured: number,
  configured: number | null,
  previous: number | null,
  pinned: number | null = null,
  samples: number[] = [],
): DeptBudget {
  const clean = samples.filter((n) => Number.isFinite(n) && n > 0);
  const spread = {
    sampleDays: clean.length,
    observedMin: clean.length ? Math.round(Math.min(...clean)) : 0,
    observedMax: clean.length ? Math.round(Math.max(...clean)) : 0,
  };
  // A PIN is the owner overriding measurement on purpose ("裁剪一天能做 1200
  // 分钟"). It wins outright — no drift limit, no cold-start fallback — because
  // a value that measurement is allowed to walk back isn't a pin at all. The
  // measured figure is still reported alongside so the console can show how
  // far the pin sits from reality.
  if (pinned !== null && Number.isFinite(pinned) && pinned > 0) {
    return {
      dept,
      measuredMinPerDay: Math.max(0, Math.round(measured)),
      ...spread,
      configuredMinPerDay: configured ?? 0,
      previousMinPerDay: previous,
      effectiveMinPerDay: Math.min(MAX_PIN_MIN, Math.max(MIN_PIN_MIN, Math.round(pinned))),
      reason: "pinned",
    };
  }
  const base: Omit<DeptBudget, "effectiveMinPerDay" | "reason"> = {
    dept,
    measuredMinPerDay: Math.max(0, Math.round(measured)),
    ...spread,
    configuredMinPerDay: configured ?? 0,
    previousMinPerDay: previous,
  };

  // 1. Cold start — nothing finished in the window.
  if (base.measuredMinPerDay <= 0) {
    const fallback = previous ?? configured ?? 0;
    return {
      ...base,
      effectiveMinPerDay: Math.max(MIN_BUDGET_MIN, Math.round(fallback)),
      reason: "cold-start",
    };
  }

  let target = base.measuredMinPerDay;
  let reason: CapacityReason = "measured";

  // 2. Rate limit against the value currently in force.
  if (previous !== null && previous > 0) {
    const up = previous * (1 + MAX_DAILY_DRIFT);
    const down = previous * (1 - MAX_DAILY_DRIFT);
    if (target > up) {
      target = up;
      reason = "rate-limited-up";
    } else if (target < down) {
      target = down;
      reason = "rate-limited-down";
    }
  } else if (configured !== null && configured > 0 && target > configured * FIRST_RUN_MAX_GROWTH) {
    // 3. First-run ceiling — no history to drift from.
    target = configured * FIRST_RUN_MAX_GROWTH;
    reason = "first-run-capped";
  }

  return {
    ...base,
    effectiveMinPerDay: Math.max(MIN_BUDGET_MIN, Math.round(target)),
    reason,
  };
}

interface StoredCapacity {
  date?: string;
  byDept?: Record<string, unknown>;
}

async function loadPrevious(db: DbLike): Promise<Record<string, number>> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(EFFECTIVE_CAPACITY_KEY)
      .first<{ value: string }>();
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as StoredCapacity | null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed?.byDept ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export interface DeptSamples {
  /** One entry per working day that produced something, in minutes. */
  daily: number[];
}

/**
 * Per-department, per-day output over the long window.
 *
 * Grouped by DAY rather than summed, because the whole point is to see the
 * spread and discard the tails — a single SUM/N cannot tell a steady 900 from
 * alternating 200 and 1600. Sundays and public holidays are excluded (capacity
 * is per WORKING day; Sunday output is exceptional and must not raise the
 * everyday budget), and days with no output are simply absent, which is what
 * lets zero-days drop out naturally.
 */
export async function collectCapacitySamples(
  db: DbLike,
  today: string,
  since: string,
  holidays: Set<string>,
): Promise<Map<string, DeptSamples>> {
  const out = new Map<string, DeptSamples>();
  try {
    const res = await db
      .prepare(
        `SELECT jc.departmentCode AS dept,
                substr(jc.completedDate::text,1,10) AS day,
                SUM(CASE WHEN jc.departmentCode = 'FAB_CUT'
                         THEN COALESCE(jc.actualMinutes, jc.estMinutes, 0)
                         ELSE COALESCE(jc.actualMinutes, jc.estMinutes, 0) * COALESCE(jc.wipQty, 1) END) AS minutes
           FROM job_cards jc
          WHERE jc.status IN ('COMPLETED','TRANSFERRED')
            AND substr(jc.completedDate::text,1,10) >= ?
            AND substr(jc.completedDate::text,1,10) < ?
          GROUP BY 1, 2`,
      )
      .bind(since, today)
      .all<{ dept: string; day: string; minutes: number | string }>();

    for (const r of res.results ?? []) {
      const day = String(r.day ?? "");
      if (!day) continue;
      if (holidays.has(day)) continue;
      // Sunday = 0. Excluded so exceptional weekend work never becomes the
      // everyday budget.
      if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) continue;
      const mins = Number(r.minutes) || 0;
      if (mins <= 0) continue;
      const entry = out.get(r.dept) ?? { daily: [] };
      entry.daily.push(mins);
      out.set(r.dept, entry);
    }
  } catch (e) {
    console.warn("[adaptive-capacity] sample collection failed:", e);
  }
  return out;
}

/** Owner-pinned budgets, dept → minutes/day. Absent key = not pinned. */
export async function loadCapacityPins(db: DbLike): Promise<Record<string, number>> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(CAPACITY_PINS_KEY)
      .first<{ value: string }>();
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as Record<string, unknown> | null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export interface PinResult {
  ok: boolean;
  dept: string;
  /** The value actually stored after clamping, or null when cleared. */
  minutesPerDay: number | null;
  error?: string;
}

/**
 * Pin (or clear) one department's daily budget.
 *
 * This is the SAFE path for "裁剪一天能做 1200 分钟" said in chat: a typed,
 * bounded, audited write into kv_config — NOT free text injected into a prompt.
 * The distinction that matters is not chat-vs-UI, it is validated-write vs
 * unvalidated-text; scheduling arithmetic may only ever come from the former.
 *
 * Passing null clears the pin and hands the department back to measurement.
 */
export async function setCapacityPin(
  db: DbLike,
  dept: string,
  minutesPerDay: number | null,
): Promise<PinResult> {
  const code = dept.trim().toUpperCase();
  if (!DEPTS.includes(code)) {
    return { ok: false, dept: code, minutesPerDay: null, error: `unknown department "${dept}"` };
  }
  if (minutesPerDay !== null) {
    if (!Number.isFinite(minutesPerDay) || minutesPerDay < MIN_PIN_MIN || minutesPerDay > MAX_PIN_MIN) {
      return {
        ok: false,
        dept: code,
        minutesPerDay: null,
        error: `minutes/day must be between ${MIN_PIN_MIN} and ${MAX_PIN_MIN}`,
      };
    }
  }
  const pins = await loadCapacityPins(db);
  if (minutesPerDay === null) delete pins[code];
  else pins[code] = Math.round(minutesPerDay);

  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(CAPACITY_PINS_KEY, JSON.stringify(pins), new Date().toISOString())
    .run();

  return { ok: true, dept: code, minutesPerDay: minutesPerDay === null ? null : pins[code] };
}

export interface ResolveOptions {
  /**
   * Commit the resolved budgets to kv_config. Off by default so read-only
   * surfaces (the capacity audit) can preview without moving the plan.
   */
  persist?: boolean;
}

/**
 * Resolve every department's daily minute budget from measured throughput.
 * Read-only unless `persist` is set.
 */
export async function resolveAdaptiveCapacity(
  db: DbLike,
  opts: ResolveOptions = {},
): Promise<AdaptiveCapacity> {
  const date = ymdInSgt();
  const holidays = await loadHolidaySet(db);
  const since = workingDaysBack(date, CAPACITY_WINDOW_DAYS, holidays);
  const [cfg, samples, previous, pins] = await Promise.all([
    loadCapacityConfig(db),
    collectCapacitySamples(db, date, since, holidays),
    loadPrevious(db),
    loadCapacityPins(db),
  ]);

  const budgets = DEPTS.map((dept) => {
    const daily = samples.get(dept)?.daily ?? [];
    return resolveOne(
      dept,
      // The robust estimate — an ordinary day, not the average of every day.
      trimmedMean(daily),
      configuredMinutes(cfg, dept),
      previous[dept] ?? null,
      pins[dept] ?? null,
      daily,
    );
  });

  const byDept: Record<string, number> = {};
  for (const b of budgets) byDept[b.dept] = b.effectiveMinPerDay;

  let persisted = false;
  if (opts.persist) {
    try {
      await db
        .prepare(
          `INSERT INTO kv_config (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(EFFECTIVE_CAPACITY_KEY, JSON.stringify({ date, byDept }), new Date().toISOString())
        .run();
      persisted = true;
    } catch (e) {
      // A failed write must not break scheduling — this run simply uses the
      // resolved values without recording them, and the next run re-derives.
      console.warn("[adaptive-capacity] persist failed:", e);
    }
  }

  return { date, byDept, budgets, persisted };
}
