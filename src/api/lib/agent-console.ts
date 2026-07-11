// ---------------------------------------------------------------------------
// agent-console.ts — Agent Console runtime tables + run-logging wrapper.
//
// Phase 3 of the Production Agent adds an owner-facing console (/agents) that
// can see and control every agent. This lib owns the two runtime tables:
//
//   agent_runs      — one row per agent execution (brief / proposals /
//                     learning), with status, summary, token usage and error.
//   agent_controls  — one row per agent FAMILY (PRODUCTION / DELIVERY / CS /
//                     PROCUREMENT) plus the special agent='ALL' row that acts
//                     as the global kill switch. paused=1 stops the agent's
//                     automatic actions; auto_approve is the approval-gate
//                     flag (stored now, consumed when the owner explicitly
//                     upgrades an agent to full-auto — see AGENTS-BLUEPRINT
//                     iron rule 1).
//
// Runtime self-apply (ensureProposalTables pattern): migrations do NOT
// auto-replay on deploy — these tables reach prod ONLY via the
// CREATE-IF-NOT-EXISTS below. All columns are snake_case (no
// column-rename-map entry needed); the db adapter folds snake_case →
// camelCase in results, so EVERY row read is dual-keyed
// (r.camelCase ?? r.snake_case).
// ---------------------------------------------------------------------------

/** Agent family ids used by agent_controls (plus the 'ALL' kill-switch row). */
export type AgentFamily = "PRODUCTION" | "DELIVERY" | "CS" | "PROCUREMENT";

export const AGENT_FAMILIES: AgentFamily[] = [
  "PRODUCTION",
  "DELIVERY",
  "CS",
  "PROCUREMENT",
];

/** Per-task run ids written to agent_runs (all Production for now). */
export type AgentTaskId =
  | "production-brief"
  | "production-proposals"
  | "production-learning";

let _agentMig: Promise<void> | null = null;
export function ensureAgentTables(db: D1Database): Promise<void> {
  if (_agentMig) return _agentMig;
  _agentMig = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS agent_runs (
           id TEXT PRIMARY KEY,
           agent TEXT NOT NULL,
           started_at TEXT NOT NULL,
           finished_at TEXT,
           status TEXT NOT NULL DEFAULT 'running',
           summary TEXT,
           tokens_in INTEGER NOT NULL DEFAULT 0,
           tokens_out INTEGER NOT NULL DEFAULT 0,
           error TEXT
         )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, started_at DESC)",
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS agent_controls (
           agent TEXT PRIMARY KEY,
           paused INTEGER NOT NULL DEFAULT 0,
           auto_approve INTEGER NOT NULL DEFAULT 0,
           updated_at TEXT
         )`,
      )
      .run();
    // Seed the global kill-switch row so the console always has it to toggle.
    await db
      .prepare(
        `INSERT INTO agent_controls (agent, paused, auto_approve, updated_at)
         VALUES ('ALL', 0, 0, ?)
         ON CONFLICT(agent) DO NOTHING`,
      )
      .bind(new Date().toISOString())
      .run();
  })();
  return _agentMig;
}

// ── Run logging ──────────────────────────────────────────────────────────────

export interface AgentRunHandle {
  /** Accumulate Anthropic token usage (call once per API response). */
  addTokens(tokensIn: number, tokensOut: number): void;
  /** Human-readable one-liner shown on the console ("sent 2 · failed 0"). */
  setSummary(summary: string): void;
}

/**
 * Wrap ONE agent execution: inserts a 'running' agent_runs row, runs `fn`,
 * then finalises the row as ok/error. The wrapped function's result (or
 * throw) passes straight through — logging never changes behaviour. Token
 * usage is whatever the fn reported via the handle (0 when the run made no
 * LLM call, e.g. proposals generation is a pure engine run).
 */
export async function recordAgentRun<T>(
  db: D1Database,
  agent: AgentTaskId | string,
  fn: (run: AgentRunHandle) => Promise<T>,
): Promise<T> {
  await ensureAgentTables(db);
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let tokensIn = 0;
  let tokensOut = 0;
  let summary = "";
  const handle: AgentRunHandle = {
    addTokens(i, o) {
      tokensIn += Math.max(0, Math.floor(Number(i) || 0));
      tokensOut += Math.max(0, Math.floor(Number(o) || 0));
    },
    setSummary(s) {
      summary = String(s ?? "").slice(0, 500);
    },
  };
  try {
    await db
      .prepare(
        "INSERT INTO agent_runs (id, agent, started_at, status) VALUES (?,?,?, 'running')",
      )
      .bind(id, agent, startedAt)
      .run();
  } catch (e) {
    // Logging must never block the actual work — run the fn unlogged.
    console.warn(`[agent-runs] failed to open run for ${agent}:`, e);
    return fn(handle);
  }
  try {
    const result = await fn(handle);
    await db
      .prepare(
        `UPDATE agent_runs
            SET finished_at = ?, status = 'ok', summary = ?, tokens_in = ?, tokens_out = ?
          WHERE id = ?`,
      )
      .bind(new Date().toISOString(), summary || null, tokensIn, tokensOut, id)
      .run()
      .catch((e: unknown) =>
        console.warn(`[agent-runs] failed to close run ${id}:`, e),
      );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .prepare(
        `UPDATE agent_runs
            SET finished_at = ?, status = 'error', error = ?, tokens_in = ?, tokens_out = ?
          WHERE id = ?`,
      )
      .bind(new Date().toISOString(), msg.slice(0, 800), tokensIn, tokensOut, id)
      .run()
      .catch((e: unknown) =>
        console.warn(`[agent-runs] failed to record error for ${id}:`, e),
      );
    throw err;
  }
}

// ── Pause / kill-switch checks ───────────────────────────────────────────────

interface ControlRow {
  agent: string;
  paused: number | string | null;
  auto_approve?: number | string | null;
  updated_at?: string | null;
  // db adapter folds snake_case → camelCase; dual-key every read.
  autoApprove?: number | string | null;
  updatedAt?: string | null;
}

/**
 * True when the agent family OR the global 'ALL' row is paused. Fails OPEN
 * (returns false) on any DB error so a broken controls table can never
 * silence the morning brief.
 */
export async function isAgentPaused(
  db: D1Database,
  family: AgentFamily,
): Promise<boolean> {
  try {
    await ensureAgentTables(db);
    const res = await db
      .prepare(
        "SELECT agent, paused FROM agent_controls WHERE agent IN ('ALL', ?)",
      )
      .bind(family)
      .all<ControlRow>();
    return (res.results ?? []).some((r) => Number(r.paused) === 1);
  } catch (e) {
    console.warn("[agent-controls] paused check failed (failing open):", e);
    return false;
  }
}

/** True when ONLY the global kill switch (agent='ALL') is on. */
export async function isKillSwitchOn(db: D1Database): Promise<boolean> {
  try {
    await ensureAgentTables(db);
    const r = await db
      .prepare("SELECT paused FROM agent_controls WHERE agent = 'ALL'")
      .bind()
      .first<ControlRow>();
    return Number(r?.paused) === 1;
  } catch {
    return false;
  }
}

export interface AgentControlState {
  agent: string;
  paused: boolean;
  autoApprove: boolean;
  updatedAt: string | null;
}

export async function listAgentControls(
  db: D1Database,
): Promise<AgentControlState[]> {
  await ensureAgentTables(db);
  const res = await db
    .prepare("SELECT * FROM agent_controls")
    .bind()
    .all<ControlRow>();
  return (res.results ?? []).map((r) => ({
    agent: r.agent,
    paused: Number(r.paused) === 1,
    autoApprove: Number(r.autoApprove ?? r.auto_approve) === 1,
    updatedAt: (r.updatedAt ?? r.updated_at) ?? null,
  }));
}

/** Upsert one control row (only the provided flags change). */
export async function setAgentControl(
  db: D1Database,
  agent: AgentFamily | "ALL",
  patch: { paused?: boolean; autoApprove?: boolean },
): Promise<void> {
  await ensureAgentTables(db);
  const nowIso = new Date().toISOString();
  const existing = await db
    .prepare("SELECT * FROM agent_controls WHERE agent = ?")
    .bind(agent)
    .first<ControlRow>();
  const paused =
    patch.paused ?? (existing ? Number(existing.paused) === 1 : false);
  const autoApprove =
    patch.autoApprove ??
    (existing
      ? Number(existing.autoApprove ?? existing.auto_approve) === 1
      : false);
  await db
    .prepare(
      `INSERT INTO agent_controls (agent, paused, auto_approve, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET
         paused = excluded.paused,
         auto_approve = excluded.auto_approve,
         updated_at = excluded.updated_at`,
    )
    .bind(agent, paused ? 1 : 0, autoApprove ? 1 : 0, nowIso)
    .run();
}
