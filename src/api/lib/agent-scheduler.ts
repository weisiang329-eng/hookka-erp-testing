// ---------------------------------------------------------------------------
// agent-scheduler.ts — the agents' SELF-scheduling brain (owner ruling
// 2026-07-12: "这个就是 agent 要自己决定，而不是我决定").
//
// A dumb external heartbeat (GH Actions, every 30 min) POSTs
// /api/internal/agents/heartbeat. Nothing about cadence lives in the cron —
// each beat, decideAgentRuns() looks at the FACTORY'S OWN PULSE and decides
// which agents should run right now:
//
//   • how many delivery events (dispatched / delivered) since the last run
//   • how many new sales orders since the last proposals run
//   • how long since the last run, how many runs already today
//   • has the punctual morning cron already covered today (fallback role)
//
// Every decision — run or skip — carries a human-readable reason that lands
// in the agent_runs summary, so the console always shows WHY the agent chose
// to move. The owner keeps exactly three overrides: per-family Pause, the
// global kill switch, and the hard bounds below. Thresholds are tunable via
// kv_config['agent_schedule'] (the learning loops may propose changes to it
// later); the HARD_* bounds are structural and not configurable.
//
// This module only DECIDES. Executing the runs (and recording them) is the
// heartbeat route's job — decisions stay pure and testable.
// ---------------------------------------------------------------------------

import { isAgentPaused } from "./agent-console";

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

// Structural bounds — an agent can never talk itself past these.
const HARD_MAX_RUNS_PER_DAY = 6;
const HARD_MIN_GAP_HOURS = 1;

export interface ScheduleConfig {
  delivery: {
    /** MYT hour (fraction ok) before which the daily first run won't fire. */
    firstRunHour: number;
    /** Dispatched+delivered events since last run that justify an extra run. */
    eventThreshold: number;
    minGapHours: number;
    maxRunsPerDay: number;
  };
  production: {
    firstRunHour: number;
    /** New sales orders since the last proposals run that justify a re-run. */
    soThreshold: number;
    minGapHours: number;
    maxRunsPerDay: number;
  };
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  delivery: { firstRunHour: 7.5, eventThreshold: 3, minGapHours: 3, maxRunsPerDay: 4 },
  production: { firstRunHour: 8, soThreshold: 5, minGapHours: 3, maxRunsPerDay: 3 },
};

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

export async function loadScheduleConfig(db: DbLike): Promise<ScheduleConfig> {
  let parsed: Partial<Record<"delivery" | "production", Record<string, unknown>>> = {};
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("agent_schedule")
      .first<{ value: string }>();
    if (row?.value) {
      const p = JSON.parse(row.value);
      if (p && typeof p === "object") parsed = p as typeof parsed;
    }
  } catch {
    /* absent / malformed — defaults */
  }
  const d = parsed.delivery ?? {};
  const p = parsed.production ?? {};
  return {
    delivery: {
      firstRunHour: clampNum(d.firstRunHour, 6, 12, DEFAULT_SCHEDULE.delivery.firstRunHour),
      eventThreshold: clampNum(d.eventThreshold, 1, 50, DEFAULT_SCHEDULE.delivery.eventThreshold),
      minGapHours: clampNum(d.minGapHours, HARD_MIN_GAP_HOURS, 12, DEFAULT_SCHEDULE.delivery.minGapHours),
      maxRunsPerDay: clampNum(d.maxRunsPerDay, 1, HARD_MAX_RUNS_PER_DAY, DEFAULT_SCHEDULE.delivery.maxRunsPerDay),
    },
    production: {
      firstRunHour: clampNum(p.firstRunHour, 6, 12, DEFAULT_SCHEDULE.production.firstRunHour),
      soThreshold: clampNum(p.soThreshold, 1, 100, DEFAULT_SCHEDULE.production.soThreshold),
      minGapHours: clampNum(p.minGapHours, HARD_MIN_GAP_HOURS, 12, DEFAULT_SCHEDULE.production.minGapHours),
      maxRunsPerDay: clampNum(p.maxRunsPerDay, 1, HARD_MAX_RUNS_PER_DAY, DEFAULT_SCHEDULE.production.maxRunsPerDay),
    },
  };
}

export interface AgentRunDecision {
  task: "delivery-run" | "production-proposals";
  reason: string;
  /** True on the first delivery run of the day — the only run that spends
   *  LLM tokens on the AI focus paragraph (later runs reuse the morning's). */
  firstOfDay: boolean;
}

export interface HeartbeatDecisions {
  decisions: AgentRunDecision[];
  skipped: Array<{ task: string; reason: string }>;
}

interface TaskStats {
  lastRunIso: string | null;
  runsToday: number;
}

async function taskStats(db: DbLike, task: string, todayMyt: string): Promise<TaskStats> {
  try {
    const row = await db
      .prepare(
        `SELECT MAX(started_at) AS last,
                SUM(CASE WHEN substr(started_at, 1, 10) = ? THEN 1 ELSE 0 END) AS today
           FROM agent_runs WHERE agent = ? AND status <> 'error'`,
      )
      .bind(todayMyt, task)
      .first<{ last?: string | null; today?: number | string | null }>();
    return {
      lastRunIso: row?.last ?? null,
      runsToday: Number(row?.today) || 0,
    };
  } catch {
    return { lastRunIso: null, runsToday: 0 };
  }
}

async function countSince(db: DbLike, sql: string, sinceIso: string): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(sinceIso).first<{ n: number | string }>();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

function gapHours(lastRunIso: string | null, nowMs: number): number {
  if (!lastRunIso) return Infinity;
  const t = new Date(lastRunIso).getTime();
  return Number.isNaN(t) ? Infinity : (nowMs - t) / 36e5;
}

/**
 * The decision pass — pure reads, no writes, no LLM. `now` is injectable for
 * tests; defaults to the real clock.
 */
export async function decideAgentRuns(
  db: DbLike,
  now: Date = new Date(),
): Promise<HeartbeatDecisions> {
  const nowMs = now.getTime();
  const myt = new Date(nowMs + 8 * 60 * 60 * 1000); // MYT = UTC+8
  const todayMyt = myt.toISOString().slice(0, 10);
  const hourMyt = myt.getUTCHours() + myt.getUTCMinutes() / 60;

  const cfg = await loadScheduleConfig(db);
  const decisions: AgentRunDecision[] = [];
  const skipped: Array<{ task: string; reason: string }> = [];

  // ── Delivery Agent ─────────────────────────────────────────────────────────
  if (await isAgentPaused(db as never, "DELIVERY")) {
    skipped.push({ task: "delivery-run", reason: "paused (console)" });
  } else {
    const st = await taskStats(db, "delivery-run", todayMyt);
    if (st.runsToday === 0) {
      if (hourMyt >= cfg.delivery.firstRunHour) {
        decisions.push({
          task: "delivery-run",
          reason: "first run of the day (self-scheduled)",
          firstOfDay: true,
        });
      } else {
        skipped.push({
          task: "delivery-run",
          reason: `before first-run hour (${cfg.delivery.firstRunHour}:00 MYT)`,
        });
      }
    } else if (st.runsToday >= cfg.delivery.maxRunsPerDay) {
      skipped.push({
        task: "delivery-run",
        reason: `daily cap reached (${st.runsToday}/${cfg.delivery.maxRunsPerDay})`,
      });
    } else if (gapHours(st.lastRunIso, nowMs) < cfg.delivery.minGapHours) {
      skipped.push({
        task: "delivery-run",
        reason: `ran ${Math.round(gapHours(st.lastRunIso, nowMs) * 10) / 10}h ago (< ${cfg.delivery.minGapHours}h gap)`,
      });
    } else {
      const since = st.lastRunIso ?? `${todayMyt}T00:00:00Z`;
      const [delivered, dispatched] = await Promise.all([
        countSince(
          db,
          "SELECT COUNT(*) AS n FROM delivery_orders WHERE deliveredAt IS NOT NULL AND deliveredAt >= ?",
          since,
        ),
        countSince(
          db,
          "SELECT COUNT(*) AS n FROM delivery_orders WHERE dispatchedAt IS NOT NULL AND dispatchedAt >= ?",
          since,
        ),
      ]);
      const events = delivered + dispatched;
      if (events >= cfg.delivery.eventThreshold) {
        decisions.push({
          task: "delivery-run",
          reason: `${delivered} delivered + ${dispatched} dispatched since last run — sweeping invoice/POD gaps`,
          firstOfDay: false,
        });
      } else {
        skipped.push({
          task: "delivery-run",
          reason: `only ${events} delivery event(s) since last run (< ${cfg.delivery.eventThreshold})`,
        });
      }
    }
  }

  // ── Production Agent (proposals regen; brief + learning stay on the 07:00
  //    report cron — the heartbeat is their fallback via first-run rule) ──────
  if (await isAgentPaused(db as never, "PRODUCTION")) {
    skipped.push({ task: "production-proposals", reason: "paused (console)" });
  } else {
    const st = await taskStats(db, "production-proposals", todayMyt);
    if (st.runsToday === 0) {
      if (hourMyt >= cfg.production.firstRunHour) {
        decisions.push({
          task: "production-proposals",
          reason: "first proposals run of the day (self-scheduled)",
          firstOfDay: true,
        });
      } else {
        skipped.push({
          task: "production-proposals",
          reason: `before first-run hour (${cfg.production.firstRunHour}:00 MYT)`,
        });
      }
    } else if (st.runsToday >= cfg.production.maxRunsPerDay) {
      skipped.push({
        task: "production-proposals",
        reason: `daily cap reached (${st.runsToday}/${cfg.production.maxRunsPerDay})`,
      });
    } else if (gapHours(st.lastRunIso, nowMs) < cfg.production.minGapHours) {
      skipped.push({
        task: "production-proposals",
        reason: `ran ${Math.round(gapHours(st.lastRunIso, nowMs) * 10) / 10}h ago (< ${cfg.production.minGapHours}h gap)`,
      });
    } else {
      const since = st.lastRunIso ?? `${todayMyt}T00:00:00Z`;
      const newSos = await countSince(
        db,
        "SELECT COUNT(*) AS n FROM sales_orders WHERE created_at >= ?",
        since,
      );
      if (newSos >= cfg.production.soThreshold) {
        decisions.push({
          task: "production-proposals",
          reason: `${newSos} new sales order(s) since last run — refreshing schedule proposals`,
          firstOfDay: false,
        });
      } else {
        skipped.push({
          task: "production-proposals",
          reason: `only ${newSos} new sales order(s) since last run (< ${cfg.production.soThreshold})`,
        });
      }
    }
  }

  return { decisions, skipped };
}
