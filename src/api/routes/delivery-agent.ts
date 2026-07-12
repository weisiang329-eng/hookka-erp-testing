// ---------------------------------------------------------------------------
// delivery-agent.ts — routes for the Delivery Agent (TMS).
//
//   GET  /api/delivery-agent/brief.json          — today's delivery picture
//        (pool by state/hub, overdue-to-ship, invoice gaps, POD chases,
//        3PL learning). Parallel payload to the production Morning Brief —
//        deliberately NOT merged into production-brief.ts (no merge risk).
//   POST /api/delivery-agent/proposals/generate  — regenerate PENDING
//        LOAD_PLAN / INVOICE_GAP / POD_CHASE proposals.
//   GET  /api/delivery-agent/proposals?status=&kind=
//   POST /api/delivery-agent/proposals/approve   {ids}
//   POST /api/delivery-agent/proposals/reject    {ids}
//   POST /api/delivery-agent/run                 — manual "run the agent now"
//        (generate + snapshot the brief), permission-gated.
//   POST /api/internal/delivery-agent/run-trigger — cron entry point,
//        x-cron-secret gated (mirrors /api/internal/reports/*; the path is a
//        PUBLIC_PREFIX in auth-middleware so external cron can reach it).
//
// RED LINE (JD): approval NEVER auto-creates or dispatches delivery orders in
// v1 — it only flips the proposal to APPROVED so the office executes it via
// the existing Create Packing List / invoice flows. Nothing here writes to
// delivery_orders, sales_orders, or invoices. Every decision emits an
// audit_events row.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId, DEFAULT_ORG_ID } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import {
  ensureDeliveryAgentTables,
  collectDeliveryBrief,
  generateDeliveryProposals,
  storeDeliveryBriefSnapshot,
  generateDeliveryFocus,
  loadLatestDeliveryAiFocus,
  transitDriftLearning,
} from "../lib/delivery-agent";
import { isAgentPaused, isKillSwitchOn, recordAgentRun } from "../lib/agent-console";

const app = new Hono<Env>();

// SGT-anchored YYYY-MM-DD (same derivation as routes/reports.ts).
function todayYmdSgt(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

interface ProposalRow {
  id: string;
  status: string;
  kind: string;
  state?: string | null;
  hub?: string | null;
  recommendation?: string | null;
  // dual-key pairs (db-pg folds snake_case result columns to camelCase)
  generated_at?: string;
  generatedAt?: string;
  so_refs?: string | null;
  soRefs?: string | null;
  items_count?: number | string | null;
  itemsCount?: number | string | null;
  value_sen?: number | string | null;
  valueSen?: number | string | null;
  three_pl_cost_sen?: number | string | null;
  threePlCostSen?: number | string | null;
  decided_at?: string | null;
  decidedAt?: string | null;
  decided_by?: string | null;
  decidedBy?: string | null;
}

function rowToProposal(r: ProposalRow) {
  return {
    id: r.id,
    generatedAt: r.generatedAt ?? r.generated_at ?? "",
    kind: r.kind,
    soRefs: (r.soRefs ?? r.so_refs) ?? "",
    state: r.state ?? "",
    hub: r.hub ?? "",
    itemsCount: Number(r.itemsCount ?? r.items_count) || 0,
    valueSen: Number(r.valueSen ?? r.value_sen) || 0,
    threePlCostSen: Number(r.threePlCostSen ?? r.three_pl_cost_sen) || 0,
    recommendation: r.recommendation ?? "",
    status: r.status,
    decidedAt: (r.decidedAt ?? r.decided_at) ?? "",
    decidedBy: (r.decidedBy ?? r.decided_by) ?? "",
  };
}

/** Parse + clamp the {ids} body shared by approve / reject. */
async function readIds(c: { req: { json: () => Promise<unknown> } }): Promise<string[] | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  const ids = (body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return ids
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, 500);
}

// ── Brief ────────────────────────────────────────────────────────────────────

app.get("/brief.json", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const data = await collectDeliveryBrief(c.var.DB, orgId, todayYmdSgt());
    // The GET path never calls the LLM — surface the focus written by the
    // latest cron / run-now snapshot instead (cheap payload read).
    if (!data.aiFocus) {
      const latest = await loadLatestDeliveryAiFocus(c.var.DB);
      if (latest) data.aiFocus = latest.aiFocus;
    }
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[delivery-agent/brief.json] failed:", err);
    return c.json({ success: false, error: "brief generation failed" }, 500);
  }
});

// ── Generate ─────────────────────────────────────────────────────────────────

app.post("/proposals/generate", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const counts = await generateDeliveryProposals(c.var.DB, orgId, todayYmdSgt());
    await emitAudit(c, {
      resource: "delivery-proposals",
      resourceId: "generate",
      action: "generate",
      after: counts,
    });
    return c.json({ success: true, data: counts });
  } catch (err) {
    console.error("[delivery-agent/generate] failed:", err);
    return c.json({ success: false, error: "proposal generation failed" }, 500);
  }
});

// ── List ─────────────────────────────────────────────────────────────────────

app.get("/proposals", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  void getOrgId(c);
  const db = c.var.DB;
  await ensureDeliveryAgentTables(db);
  const status = (c.req.query("status") ?? "PENDING").toUpperCase();
  const kind = (c.req.query("kind") ?? "").toUpperCase();
  const res = kind
    ? await db
        .prepare(
          `SELECT * FROM delivery_proposals
            WHERE status = ? AND kind = ?
            ORDER BY kind, value_sen DESC
            LIMIT 1000`,
        )
        .bind(status, kind)
        .all<ProposalRow>()
    : await db
        .prepare(
          `SELECT * FROM delivery_proposals
            WHERE status = ?
            ORDER BY kind, value_sen DESC
            LIMIT 1000`,
        )
        .bind(status)
        .all<ProposalRow>();
  return c.json({ success: true, data: (res.results ?? []).map(rowToProposal) });
});

// ── Approve / Reject ─────────────────────────────────────────────────────────
//
// Approve marks the plan APPROVED for the office to execute — it does NOT
// create delivery orders, packing lists, or invoices (v1 red line). One
// audit_events row per decided proposal.

async function decideProposals(
  c: Parameters<typeof emitAudit>[0],
  ids: string[],
  decision: "APPROVED" | "REJECTED",
): Promise<number> {
  const db = c.var.DB;
  await ensureDeliveryAgentTables(db);
  const nowIso = new Date().toISOString();
  const decidedBy =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;

  let decided = 0;
  for (const id of ids) {
    const row = await db
      .prepare("SELECT * FROM delivery_proposals WHERE id = ? AND status = 'PENDING'")
      .bind(id)
      .first<ProposalRow>();
    if (!row) continue; // unknown / already decided — skip silently
    await db
      .prepare(
        `UPDATE delivery_proposals
            SET status = ?, decided_at = ?, decided_by = ?
          WHERE id = ? AND status = 'PENDING'`,
      )
      .bind(decision, nowIso, decidedBy, id)
      .run();
    decided += 1;
    await emitAudit(c, {
      resource: "delivery-proposals",
      resourceId: id,
      action: decision === "APPROVED" ? "approve" : "reject",
      before: rowToProposal(row),
      after: { ...rowToProposal(row), status: decision, decidedAt: nowIso, decidedBy },
    });
  }
  return decided;
}

app.post("/proposals/approve", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  void getOrgId(c);
  const ids = await readIds(c);
  if (!ids) return c.json({ success: false, error: "ids[] required" }, 400);
  const approved = await decideProposals(c, ids, "APPROVED");
  return c.json({
    success: true,
    data: { approved, skipped: ids.length - approved },
  });
});

app.post("/proposals/reject", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  void getOrgId(c);
  const ids = await readIds(c);
  if (!ids) return c.json({ success: false, error: "ids[] required" }, 400);
  const rejected = await decideProposals(c, ids, "REJECTED");
  return c.json({
    success: true,
    data: { rejected, skipped: ids.length - rejected },
  });
});

// ── Run (generate + learn + think + snapshot) ────────────────────────────────
// One full agent cycle: engine proposals → transit-drift learning (may write
// cross-agent cs.transitDays.* config proposals for the owner to approve) →
// Claude focus paragraph → brief snapshot. Wrapped in recordAgentRun by every
// caller so the Agent Console shows the run + its token spend.

export async function runDeliveryAgent(
  db: Env["Variables"]["DB"],
  orgId: string,
  opts: {
    anthropicApiKey?: string;
    usageSink?: { tokensIn: number; tokensOut: number };
  } = {},
) {
  const today = todayYmdSgt();
  const counts = await generateDeliveryProposals(db, orgId, today);
  const transit = await transitDriftLearning(db, orgId, today, {
    emitProposals: true,
  }).catch((err) => {
    console.warn("[delivery-agent] transit learning failed:", err);
    return [];
  });
  const brief = await collectDeliveryBrief(db, orgId, today);
  brief.aiFocus = await generateDeliveryFocus(
    opts.anthropicApiKey,
    brief,
    opts.usageSink,
  );
  await storeDeliveryBriefSnapshot(db, brief);
  return {
    date: today,
    proposals: counts,
    transitDrifts: transit.filter((t) => t.flagged).length,
    aiFocus: brief.aiFocus != null,
    brief: {
      pool: brief.pool.count,
      overdueToShip: brief.overdueToShip.count,
      invoiceGaps: brief.invoiceGaps.count,
      podChases: brief.podChases.count,
    },
  };
}

// Manual run from the UI (session + permission gated). Same console
// semantics as Production run-now: a family PAUSE stops automatic runs only,
// but the global kill switch blocks even manual runs.
app.post("/run", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  if (await isKillSwitchOn(c.var.DB)) {
    return c.json({
      success: false,
      error: "Global kill switch is ON — turn it off in the Agent Console first.",
    });
  }
  try {
    const data = await recordAgentRun(c.var.DB, "delivery-run", async (run) => {
      const sink = { tokensIn: 0, tokensOut: 0 };
      const r = await runDeliveryAgent(c.var.DB, orgId, {
        anthropicApiKey: c.env.ANTHROPIC_API_KEY,
        usageSink: sink,
      });
      run.addTokens(sink.tokensIn, sink.tokensOut);
      run.setSummary(
        `${r.date} · plans ${r.proposals.loadPlans} · invoice gaps ${r.proposals.invoiceGaps} · POD ${r.proposals.podChases} · transit drifts ${r.transitDrifts} (run)`,
      );
      return r;
    });
    await emitAudit(c, {
      resource: "delivery-proposals",
      resourceId: "run",
      action: "run",
      after: data,
    });
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[delivery-agent/run] failed:", err);
    return c.json({ success: false, error: "agent run failed" }, 500);
  }
});

// ── Cron entry point (x-cron-secret, mirrors routes/reports.ts authCron) ─────

export const internal = new Hono<Env>();

// Shared by the agents heartbeat route (routes/agent-heartbeat.ts).
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

internal.post("/run-trigger", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[delivery-agent/cron] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  // Agent Console gate — DELIVERY pause (or the global kill switch) stops the
  // automatic cron cycle; manual /run and the office pages stay available.
  if (await isAgentPaused(c.var.DB, "DELIVERY")) {
    return c.json({ ok: true, skipped: "paused" });
  }
  try {
    // Cron runs as the single-tenant org (same assumption as the report crons,
    // which run their collectors without a session).
    const data = await recordAgentRun(c.var.DB, "delivery-run", async (run) => {
      const sink = { tokensIn: 0, tokensOut: 0 };
      const r = await runDeliveryAgent(c.var.DB, DEFAULT_ORG_ID, {
        anthropicApiKey: c.env.ANTHROPIC_API_KEY,
        usageSink: sink,
      });
      run.addTokens(sink.tokensIn, sink.tokensOut);
      run.setSummary(
        `${r.date} · plans ${r.proposals.loadPlans} · invoice gaps ${r.proposals.invoiceGaps} · POD ${r.proposals.podChases} · transit drifts ${r.transitDrifts} (cron)`,
      );
      return r;
    });
    return c.json({ ok: true, ...data });
  } catch (err) {
    console.error("[delivery-agent/cron] failed:", err);
    return c.json({ ok: false, error: "agent run failed" }, 500);
  }
});

export default app;
