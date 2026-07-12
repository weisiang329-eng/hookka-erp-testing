// ---------------------------------------------------------------------------
// Agent Console API (Production Agent Phase 3) — mounted at /api/agents.
//
// SUPER_ADMIN only (requireSuperAdmin, same hard gate as user management):
// the console can pause every agent, roll back applied schedules and flip
// approval gates, so a regular ADMIN must not reach it.
//
//   GET  /status                — per-agent card data (last/next run, today's
//                                 outputs, month token totals, flags, errors)
//   POST /run-now               {agent: brief|proposals|learning} — inline run
//   POST /pause                 {agent, paused} — pause/resume one family
//   POST /kill-all              {on} — global kill switch (agent='ALL')
//   POST /rollback-last-batch   — revert the latest applied proposal batch
//   POST /gate                  {agent, autoApprove} — approval-gate flag
//   GET  /config-proposals      — PENDING parameter proposals (learning loop)
//   POST /config-proposals/decide {ids, action} — approve writes the value
//                                 into kv_config['planning_capacity'].chain
//
// Every action emits ONE audit_events row (emitAudit — the assistant.ts
// pattern) so the owner has a full trail of who touched which agent when.
//
// Dual-key rule: the db adapter folds snake_case columns to camelCase in
// results — EVERY row read below is r.camelCase ?? r.snake_case.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requireSuperAdmin } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import {
  AGENT_FAMILIES,
  ensureAgentTables,
  isKillSwitchOn,
  listAgentControls,
  recordAgentRun,
  setAgentControl,
  type AgentFamily,
} from "../lib/agent-console";
import {
  CONFIG_PROPOSAL_KEYS,
  ensureConfigProposalTable,
  runLearning,
} from "../lib/agent-learning";
import { generateProposals, ensureProposalTables } from "../lib/schedule-proposals";
import { dispatchReport } from "./reports";
import { runDeliveryAgent } from "./delivery-agent";
import { DEFAULT_ORG_ID } from "../lib/tenant";

const app = new Hono<Env>();
export default app;

function actorId(c: { get: (k: string) => unknown }): string | null {
  const v = (c as unknown as { get: (k: string) => string | undefined }).get("userId");
  return v ?? null;
}

// The three runnable Production tasks. next-run text is a hardcoded
// description of the cron wiring (daily-reports.yml), not a computed time.
const PRODUCTION_TASKS: Array<{ agent: string; label: string; nextRun: string }> = [
  {
    agent: "production-brief",
    label: "Morning Brief",
    nextRun: "07:00 MYT · working days (cron)",
  },
  {
    agent: "production-proposals",
    label: "Schedule Proposals",
    nextRun: "self-scheduled (30-min heartbeat; re-runs when new SOs pile up) · on demand",
  },
  {
    agent: "production-learning",
    label: "Learning Loop",
    nextRun: "daily with the 07:00 brief · on demand",
  },
];

const DELIVERY_TASKS: Array<{ agent: string; label: string; nextRun: string }> = [
  {
    agent: "delivery-run",
    label: "Daily Run (proposals + learning + brief)",
    nextRun: "07:30 MYT (cron) + self-scheduled sweeps when deliveries spike · on demand",
  },
];

// ── GET /status ──────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  agent: string;
  started_at?: string;
  finished_at?: string | null;
  status: string;
  summary?: string | null;
  tokens_in?: number | string | null;
  tokens_out?: number | string | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  tokensIn?: number | string | null;
  tokensOut?: number | string | null;
}

function projectRun(r: RunRow) {
  return {
    id: r.id,
    agent: r.agent,
    startedAt: (r.startedAt ?? r.started_at) ?? null,
    finishedAt: (r.finishedAt ?? r.finished_at) ?? null,
    status: r.status,
    summary: r.summary ?? null,
    tokensIn: Number(r.tokensIn ?? r.tokens_in) || 0,
    tokensOut: Number(r.tokensOut ?? r.tokens_out) || 0,
    error: r.error ?? null,
  };
}

app.get("/status", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const db = c.var.DB;
  await ensureAgentTables(db);

  const nowIso = new Date().toISOString();
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // SGT
  const month = nowIso.slice(0, 7);

  const [recentRes, monthRes, errorRes, controls] = await Promise.all([
    db
      .prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 100")
      .bind()
      .all<RunRow>(),
    db
      .prepare(
        `SELECT agent,
                SUM(COALESCE(tokens_in, 0)) AS tokens_in,
                SUM(COALESCE(tokens_out, 0)) AS tokens_out,
                COUNT(*) AS runs
           FROM agent_runs
          WHERE substr(started_at, 1, 7) = ?
          GROUP BY agent`,
      )
      .bind(month)
      .all<{
        agent: string;
        tokens_in: number | string;
        tokens_out: number | string;
        runs: number | string;
        tokensIn?: number | string;
        tokensOut?: number | string;
      }>(),
    db
      .prepare(
        "SELECT * FROM agent_runs WHERE status = 'error' ORDER BY started_at DESC LIMIT 5",
      )
      .bind()
      .all<RunRow>(),
    listAgentControls(db),
  ]);

  const recent = (recentRes.results ?? []).map(projectRun);
  const lastByTask = new Map<string, ReturnType<typeof projectRun>>();
  let todayRuns = 0;
  for (const r of recent) {
    if (!lastByTask.has(r.agent)) lastByTask.set(r.agent, r);
    if ((r.startedAt ?? "").slice(0, 10) === today) todayRuns++;
  }

  let monthTokensIn = 0;
  let monthTokensOut = 0;
  let monthRuns = 0;
  for (const r of monthRes.results ?? []) {
    monthTokensIn += Number(r.tokensIn ?? r.tokens_in) || 0;
    monthTokensOut += Number(r.tokensOut ?? r.tokens_out) || 0;
    monthRuns += Number(r.runs) || 0;
  }

  // Phase-2/3 output counts — best-effort (tables may not be self-applied yet).
  const countSafe = async (sql: string, ...binds: unknown[]): Promise<number> => {
    try {
      const r = await db.prepare(sql).bind(...binds).first<{ n: number | string }>();
      return Number(r?.n) || 0;
    } catch {
      return 0;
    }
  };
  const [
    proposalsToday,
    pendingProposals,
    pendingConfig,
    deliveryPending,
    deliveryToday,
    csPromises30d,
    csEngine30d,
  ] = await Promise.all([
    countSafe(
      "SELECT COUNT(*) AS n FROM schedule_proposals WHERE substr(generated_at, 1, 10) = ?",
      today,
    ),
    countSafe("SELECT COUNT(*) AS n FROM schedule_proposals WHERE status = 'PENDING'"),
    countSafe("SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'PENDING'"),
    countSafe("SELECT COUNT(*) AS n FROM delivery_proposals WHERE status = 'PENDING'"),
    countSafe(
      "SELECT COUNT(*) AS n FROM delivery_proposals WHERE substr(generated_at, 1, 10) = ?",
      today,
    ),
    countSafe(
      "SELECT COUNT(*) AS n FROM cs_promise_log WHERE asked_at >= ?",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    ),
    countSafe(
      "SELECT COUNT(*) AS n FROM cs_promise_log WHERE asked_at >= ? AND confidence = 'ENGINE'",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    ),
  ]);

  const controlOf = (agent: string) => controls.find((x) => x.agent === agent);
  const killAll = controlOf("ALL")?.paused === true;

  // PRODUCTION / DELIVERY run full console lifecycles; CS is live but
  // question-driven (no cron), so it reports KPI counters instead of tasks.
  const agents = AGENT_FAMILIES.map((fam) => {
    const ctl = controlOf(fam);
    const live = fam === "PRODUCTION" || fam === "DELIVERY" || fam === "CS";
    const tasks =
      fam === "PRODUCTION"
        ? PRODUCTION_TASKS
        : fam === "DELIVERY"
          ? DELIVERY_TASKS
          : [];
    return {
      id: fam,
      live,
      paused: ctl?.paused === true,
      autoApprove: ctl?.autoApprove === true,
      tasks: tasks.map((t) => ({
        ...t,
        lastRun: lastByTask.get(t.agent) ?? null,
      })),
      today:
        fam === "PRODUCTION"
          ? { runs: todayRuns, proposalsGenerated: proposalsToday, pendingProposals }
          : fam === "DELIVERY"
            ? {
                runs: 0,
                proposalsGenerated: deliveryToday,
                pendingProposals: deliveryPending,
              }
            : null,
      cs:
        fam === "CS"
          ? { promises30d: csPromises30d, enginePromises30d: csEngine30d }
          : null,
      pendingConfigProposals: fam === "PRODUCTION" ? pendingConfig : 0,
      month:
        fam === "PRODUCTION"
          ? { runs: monthRuns, tokensIn: monthTokensIn, tokensOut: monthTokensOut }
          : null,
      recentErrors: fam === "PRODUCTION" ? (errorRes.results ?? []).map(projectRun) : [],
    };
  });

  return c.json({ success: true, data: { killAll, generatedAt: nowIso, agents } });
});

// ── POST /run-now {agent} ────────────────────────────────────────────────────
// Manual, explicit owner action: allowed while the FAMILY is paused (pause
// stops the automatic runs), but blocked by the global kill switch — 急停
// means NOTHING moves until it's lifted.

app.post("/run-now", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const db = c.var.DB;
  let body: { agent?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const agent = (body.agent ?? "").toLowerCase();
  if (!["brief", "proposals", "learning", "delivery"].includes(agent)) {
    return c.json(
      { success: false, error: "agent must be brief | proposals | learning | delivery" },
      400,
    );
  }
  if (await isKillSwitchOn(db)) {
    return c.json({
      success: false,
      error: "Global kill switch is ON — turn it off before running an agent.",
    });
  }

  await emitAudit(c, {
    resource: "agents",
    resourceId: agent === "delivery" ? "delivery-run" : `production-${agent}`,
    action: "run-now",
    source: "admin",
  });

  if (agent === "brief") {
    const result = await recordAgentRun(db, "production-brief", async (run) => {
      const sink = { tokensIn: 0, tokensOut: 0 };
      const res = await dispatchReport(c, "brief", sink);
      run.addTokens(sink.tokensIn, sink.tokensOut);
      run.setSummary(`${res.date} · sent ${res.sent} · failed ${res.failed} (run-now)`);
      return res;
    });
    return c.json({ success: true, data: result });
  }
  if (agent === "delivery") {
    const result = await recordAgentRun(db, "delivery-run", async (run) => {
      const sink = { tokensIn: 0, tokensOut: 0 };
      const r = await runDeliveryAgent(db, DEFAULT_ORG_ID, {
        anthropicApiKey: c.env.ANTHROPIC_API_KEY,
        usageSink: sink,
      });
      run.addTokens(sink.tokensIn, sink.tokensOut);
      run.setSummary(
        `${r.date} · plans ${r.proposals.loadPlans} · invoice gaps ${r.proposals.invoiceGaps} · POD ${r.proposals.podChases} · transit drifts ${r.transitDrifts} (run-now)`,
      );
      return r;
    });
    return c.json({ success: true, data: result });
  }
  if (agent === "proposals") {
    const result = await recordAgentRun(db, "production-proposals", async (run) => {
      const r = await generateProposals(db);
      run.setSummary(
        `proposed ${r.proposed} (unscheduled ${r.unscheduled} · overdue ${r.overdue} · superseded ${r.superseded}) (run-now)`,
      );
      return r;
    });
    return c.json({ success: true, data: result });
  }
  // learning
  const result = await recordAgentRun(db, "production-learning", async (run) => {
    const r = await runLearning(db, { emitProposals: true });
    run.setSummary(
      `adherence ${r.overallAdherencePct == null ? "n/a" : `${r.overallAdherencePct}%`} · ` +
        `${r.handoffs.filter((h) => h.flagged).length} handoff drift(s) · ` +
        `${r.pendingConfigProposals} config proposal(s) pending · ${r.ot.length} OT signal(s) (run-now)`,
    );
    return r;
  });
  return c.json({ success: true, data: result });
});

// ── POST /pause {agent, paused} ──────────────────────────────────────────────

app.post("/pause", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  let body: { agent?: string; paused?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const agent = (body.agent ?? "").toUpperCase() as AgentFamily;
  if (!AGENT_FAMILIES.includes(agent)) {
    return c.json({ success: false, error: "unknown agent" }, 400);
  }
  const paused = body.paused === true;
  await setAgentControl(c.var.DB, agent, { paused });
  await emitAudit(c, {
    resource: "agents",
    resourceId: agent,
    action: paused ? "pause" : "resume",
    after: { paused },
    source: "admin",
  });
  return c.json({ success: true, data: { agent, paused } });
});

// ── POST /kill-all {on} ──────────────────────────────────────────────────────

app.post("/kill-all", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  let body: { on?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const on = body.on === true;
  await setAgentControl(c.var.DB, "ALL", { paused: on });
  await emitAudit(c, {
    resource: "agents",
    resourceId: "ALL",
    action: on ? "kill-all" : "kill-all-off",
    after: { on },
    source: "admin",
  });
  return c.json({ success: true, data: { killAll: on } });
});

// ── POST /gate {agent, autoApprove} ──────────────────────────────────────────
// The approval-gate flag (提案制 ⇄ 全自动). Stored + audited now; the
// automatic paths still require manual approval until the owner explicitly
// asks for the auto-apply behaviour to be wired (AGENTS-BLUEPRINT iron rule 1:
// 护栏内自动化需 owner 明示升级).

app.post("/gate", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  let body: { agent?: string; autoApprove?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const agent = (body.agent ?? "").toUpperCase() as AgentFamily;
  if (!AGENT_FAMILIES.includes(agent)) {
    return c.json({ success: false, error: "unknown agent" }, 400);
  }
  const autoApprove = body.autoApprove === true;
  await setAgentControl(c.var.DB, agent, { autoApprove });
  await emitAudit(c, {
    resource: "agents",
    resourceId: agent,
    action: "gate",
    after: { autoApprove },
    source: "admin",
  });
  return c.json({ success: true, data: { agent, autoApprove } });
});

// ── POST /rollback-last-batch ────────────────────────────────────────────────
// Undo the LATEST applied schedule-proposal batch: every job card in the
// batch gets its dueDate set back to the proposal's current_due (the value
// it had before approval), the proposals are marked ROLLED_BACK, and the
// snapshot is stamped so it can't be rolled back twice. Cards that moved on
// (no longer WAITING) keep their dates — completed work is inviolate.

interface SnapRow {
  id: string;
  taken_at?: string;
  payload: string;
  takenAt?: string;
}

interface AppliedEntry {
  proposalId: string;
  jcId: string;
  poId: string | null;
  dept: string | null;
  soRef: string | null;
  from: string | null;
  to: string;
}

app.post("/rollback-last-batch", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const db = c.var.DB;
  await ensureProposalTables(db);

  const res = await db
    .prepare("SELECT * FROM plan_snapshots ORDER BY taken_at DESC LIMIT 25")
    .bind()
    .all<SnapRow>();

  interface SnapPayload {
    kind?: string;
    decidedBy?: string | null;
    applied?: AppliedEntry[];
    rolledBackAt?: string;
    rolledBackBy?: string | null;
  }
  let snapId: string | null = null;
  let snapTakenAt: string | null = null;
  let payload: SnapPayload | null = null;
  for (const row of res.results ?? []) {
    try {
      const p = JSON.parse(row.payload) as SnapPayload | null;
      if (p?.kind === "PROPOSALS_APPLIED" && !p.rolledBackAt && (p.applied?.length ?? 0) > 0) {
        snapId = row.id;
        snapTakenAt = (row.takenAt ?? row.taken_at) ?? null;
        payload = p;
        break;
      }
    } catch {
      // malformed snapshot — skip
    }
  }
  if (!snapId || !payload?.applied) {
    return c.json({ success: false, error: "No applied proposal batch to roll back." });
  }

  const nowIso = new Date().toISOString();
  const decidedBy = actorId(c);
  let reverted = 0;
  let skipped = 0;
  for (const entry of payload.applied) {
    if (!entry?.jcId) continue;
    // Same guard as approve: only a still-open card is touched.
    const r = (await db
      .prepare(
        `UPDATE job_cards SET dueDate = ?, updated_at = ?
          WHERE id = ? AND status = 'WAITING'`,
      )
      .bind(entry.from ?? null, nowIso, entry.jcId)
      .run()) as { meta?: { changes?: number } };
    const changed = Number(r?.meta?.changes ?? 1);
    if (changed > 0) reverted++;
    else skipped++;
    if (entry.proposalId) {
      await db
        .prepare(
          `UPDATE schedule_proposals
              SET status = 'ROLLED_BACK', decided_at = ?, decided_by = ?
            WHERE id = ?`,
        )
        .bind(nowIso, decidedBy, entry.proposalId)
        .run();
    }
  }

  // Stamp the snapshot so a second click can't double-revert the same batch.
  await db
    .prepare("UPDATE plan_snapshots SET payload = ? WHERE id = ?")
    .bind(
      JSON.stringify({ ...payload, rolledBackAt: nowIso, rolledBackBy: decidedBy }),
      snapId,
    )
    .run();

  await emitAudit(c, {
    resource: "agents",
    resourceId: snapId,
    action: "rollback-last-batch",
    after: { batchTakenAt: snapTakenAt, cards: payload.applied.length, reverted, skipped },
    source: "admin",
  });

  return c.json({
    success: true,
    data: { batchTakenAt: snapTakenAt, cards: payload.applied.length, reverted, skipped },
  });
});

// ── Config proposals (learning loop → owner approval → kv_config) ────────────

interface ConfigProposalRow {
  id: string;
  generated_at?: string;
  param_key?: string;
  current_value?: string | null;
  proposed_value?: string;
  reason?: string | null;
  status: string;
  decided_at?: string | null;
  decided_by?: string | null;
  generatedAt?: string;
  paramKey?: string;
  currentValue?: string | null;
  proposedValue?: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

app.get("/config-proposals", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const db = c.var.DB;
  await ensureConfigProposalTable(db);
  const status = (c.req.query("status") ?? "PENDING").toUpperCase();
  const res = await db
    .prepare(
      "SELECT * FROM config_proposals WHERE status = ? ORDER BY generated_at DESC LIMIT 200",
    )
    .bind(status)
    .all<ConfigProposalRow>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    generatedAt: (r.generatedAt ?? r.generated_at) ?? null,
    paramKey: (r.paramKey ?? r.param_key) ?? "",
    currentValue: (r.currentValue ?? r.current_value) ?? null,
    proposedValue: (r.proposedValue ?? r.proposed_value) ?? "",
    reason: r.reason ?? "",
    status: r.status,
    decidedAt: (r.decidedAt ?? r.decided_at) ?? null,
    decidedBy: (r.decidedBy ?? r.decided_by) ?? null,
  }));
  return c.json({ success: true, data });
});

// Approve writes the whitelisted parameter into kv_config['planning_capacity']
// (the same override object loadCapacityConfig merges over the defaults, so
// the engine + brief pick it up on the very next run). Reject just closes the
// proposal. Non-whitelisted keys are REJECTED loudly, never normalized.
app.post("/config-proposals/decide", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const db = c.var.DB;
  await ensureConfigProposalTable(db);
  let body: { ids?: unknown; action?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = (body.action ?? "").toLowerCase();
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 100)
    : [];
  if (ids.length === 0 || !["approve", "reject"].includes(action)) {
    return c.json({ success: false, error: "ids[] and action=approve|reject required" }, 400);
  }

  const nowIso = new Date().toISOString();
  const decidedBy = actorId(c);
  let decided = 0;
  const errors: string[] = [];

  for (const id of ids) {
    const row = await db
      .prepare("SELECT * FROM config_proposals WHERE id = ? AND status = 'PENDING'")
      .bind(id)
      .first<ConfigProposalRow>();
    if (!row) continue; // unknown / already decided

    const paramKey = (row.paramKey ?? row.param_key) ?? "";
    const proposedRaw = (row.proposedValue ?? row.proposed_value) ?? "";

    if (action === "approve") {
      // Two whitelisted families (reject everything else, never normalize):
      //   chain.<field>          → kv_config['planning_capacity'].chain.<field>
      //   cs.transitDays.<STATE> → kv_config['cs-agent'].transitDaysByState.<STATE>
      const chainField = CONFIG_PROPOSAL_KEYS[paramKey];
      const csState = /^cs\.transitDays\.([A-Z]{2,3})$/.exec(paramKey)?.[1] ?? null;
      const value = Number(proposedRaw);
      const maxValue = csState ? 10 : 30;
      if ((!chainField && !csState) || !Number.isFinite(value) || value < 0 || value > maxValue) {
        errors.push(`${paramKey}: not an approvable parameter`);
        continue;
      }
      const kvKey = csState ? "cs-agent" : "planning_capacity";
      // Merge into the existing override object — never clobber other keys.
      let override: Record<string, unknown> = {};
      try {
        const kv = await db
          .prepare("SELECT value FROM kv_config WHERE key = ?")
          .bind(kvKey)
          .first<{ value: string }>();
        if (kv?.value) {
          const parsed = JSON.parse(kv.value);
          if (parsed && typeof parsed === "object") override = parsed as Record<string, unknown>;
        }
      } catch {
        override = {};
      }
      if (csState) {
        const byState =
          override.transitDaysByState && typeof override.transitDaysByState === "object"
            ? (override.transitDaysByState as Record<string, unknown>)
            : {};
        byState[csState] = Math.floor(value);
        override.transitDaysByState = byState;
      } else if (chainField) {
        const chain =
          override.chain && typeof override.chain === "object"
            ? (override.chain as Record<string, unknown>)
            : {};
        chain[chainField] = Math.floor(value);
        override.chain = chain;
      }
      await db
        .prepare(
          `INSERT INTO kv_config (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .bind(kvKey, JSON.stringify(override), nowIso)
        .run();
    }

    await db
      .prepare(
        `UPDATE config_proposals
            SET status = ?, decided_at = ?, decided_by = ?
          WHERE id = ?`,
      )
      .bind(action === "approve" ? "APPROVED" : "REJECTED", nowIso, decidedBy, id)
      .run();
    decided++;

    await emitAudit(c, {
      resource: "agents",
      resourceId: id,
      action: action === "approve" ? "config-approve" : "config-reject",
      after: { paramKey, proposedValue: proposedRaw },
      source: "admin",
    });
  }

  return c.json({
    success: true,
    data: { decided, skipped: ids.length - decided, ...(errors.length ? { errors } : {}) },
  });
});

