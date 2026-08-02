// ---------------------------------------------------------------------------
// agent-feedback.ts — the agents' NOTEBOOK of owner teachings (owner ruling
// 2026-07-12: "它做错了，我会直接告诉它" — corrections must PERSIST, like
// telling a member of staff once and having them remember).
//
// One row per standing instruction the owner gave an agent in chat (the
// teach_agent assistant tool writes here, SUPER_ADMIN only). ACTIVE rows are
// injected into that agent's LLM brain calls (production 今日焦点, delivery
// AI focus) as owner instructions the model must respect, and surfaced on
// the console. Retiring an instruction stops the injection — nothing is
// hard-deleted, the teaching history is part of the audit story.
//
// Scope note: this teaches the agent's JUDGMENT layer (what to emphasise,
// what to avoid, house rules). Corrections to the MATH (capacities, handoff
// days, transit days) still go through config proposals / kv config so the
// deterministic engines stay deterministic.
//
// Runtime self-apply, snake_case columns, dual-keyed reads (db-pg folds
// snake_case → camelCase in results).
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

let _mig = false;
export async function ensureFeedbackTable(db: DbLike): Promise<void> {
  if (_mig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS agent_feedback (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         agent TEXT NOT NULL,
         instruction TEXT NOT NULL,
         created_by TEXT,
         status TEXT NOT NULL DEFAULT 'ACTIVE',
         retired_at TEXT
       )`,
    )
    .bind()
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent ON agent_feedback(agent, status)",
    )
    .bind()
    .run();
  _mig = true;
}

export interface AgentFeedbackRow {
  id: string;
  createdAt: string;
  agent: string;
  instruction: string;
  createdBy: string | null;
  status: string;
}

export async function addAgentFeedback(
  db: DbLike,
  p: { agent: string; instruction: string; createdBy: string | null },
): Promise<string> {
  await ensureFeedbackTable(db);
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO agent_feedback (id, created_at, agent, instruction, created_by)
       VALUES (?,?,?,?,?)`,
    )
    .bind(id, new Date().toISOString(), p.agent, p.instruction.slice(0, 2000), p.createdBy)
    .run();
  return id;
}

export async function retireAgentFeedback(db: DbLike, id: string): Promise<boolean> {
  await ensureFeedbackTable(db);
  await db
    .prepare(
      "UPDATE agent_feedback SET status = 'RETIRED', retired_at = ? WHERE id = ? AND status = 'ACTIVE'",
    )
    .bind(new Date().toISOString(), id)
    .run();
  return true;
}

interface RawRow {
  id: string;
  created_at?: string;
  createdAt?: string;
  agent: string;
  instruction: string;
  created_by?: string | null;
  createdBy?: string | null;
  status: string;
}

export async function listAgentFeedback(
  db: DbLike,
  agent?: string,
  status = "ACTIVE",
): Promise<AgentFeedbackRow[]> {
  await ensureFeedbackTable(db);
  const res = agent
    ? await db
        .prepare(
          "SELECT * FROM agent_feedback WHERE agent = ? AND status = ? ORDER BY created_at DESC LIMIT 100",
        )
        .bind(agent, status)
        .all<RawRow>()
    : await db
        .prepare(
          "SELECT * FROM agent_feedback WHERE status = ? ORDER BY created_at DESC LIMIT 200",
        )
        .bind(status)
        .all<RawRow>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    createdAt: (r.createdAt ?? r.created_at) ?? "",
    agent: r.agent,
    instruction: r.instruction,
    createdBy: (r.createdBy ?? r.created_by) ?? null,
    status: r.status,
  }));
}

/**
 * The ACTIVE instructions for one agent as plain strings — best-effort
 * (a broken notebook must never sink a brief), newest first, capped so the
 * prompt stays lean.
 */
export async function activeInstructions(
  db: DbLike,
  agent: string,
  cap = 12,
): Promise<string[]> {
  try {
    const rows = await listAgentFeedback(db, agent, "ACTIVE");
    return rows.slice(0, cap).map((r) => r.instruction);
  } catch {
    return [];
  }
}
