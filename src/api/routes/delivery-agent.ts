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
  autoApproveDeliveryProposals,
} from "../lib/delivery-agent";
import { activeInstructions } from "../lib/agent-feedback";
import { autoApplyConfigProposals } from "../lib/agent-learning";
import {
  isAgentPaused,
  isAutoApproveOn,
  isKillSwitchOn,
  recordAgentRun,
  llmKeyIfBudgetAllows,
} from "../lib/agent-console";

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
  due_date?: string | null;
  dueDate?: string | null;
  do_count?: number | string | null;
  doCount?: number | string | null;
  drop_count?: number | string | null;
  dropCount?: number | string | null;
  driver?: string | null;
  recipients?: string | null;
}

function rowToProposal(r: ProposalRow) {
  let recipients: Array<{ customer: string; hub: string; doCount: number; valueSen: number }> = [];
  try {
    const raw = r.recipients;
    if (raw && typeof raw === "string") recipients = JSON.parse(raw);
  } catch {
    recipients = [];
  }
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
    // Packing-list fields (LOAD_PLAN). Empty/0 for INVOICE_GAP / POD_CHASE.
    dueDate: (r.dueDate ?? r.due_date) ?? "",
    doCount: Number(r.doCount ?? r.do_count) || 0,
    dropCount: Number(r.dropCount ?? r.drop_count) || 0,
    driver: r.driver ?? "",
    recipients,
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
  // Autonomy: with the DELIVERY auto-approve gate ON, the agent decides its
  // own proposals (recording-only — the office executes from the approved
  // list; nothing is created or dispatched). Gate OFF → owner approves.
  let autoApproved = 0;
  let autoTunedParams = 0;
  if (await isAutoApproveOn(db, "DELIVERY")) {
    autoApproved = await autoApproveDeliveryProposals(db, "AGENT_AUTO").catch((err) => {
      console.warn("[delivery-agent] auto-approve failed:", err);
      return 0;
    });
    // Full-auto also self-tunes its cs.transitDays.* parameters (bounded +
    // logged, no owner approval — owner ruling 2026-07-13).
    autoTunedParams = await autoApplyConfigProposals(db, "DELIVERY", "AGENT_AUTO").catch(() => 0);
  }
  const brief = await collectDeliveryBrief(db, orgId, today);
  const ownerNotes = opts.anthropicApiKey
    ? await activeInstructions(db, "DELIVERY")
    : [];
  brief.aiFocus = await generateDeliveryFocus(
    opts.anthropicApiKey,
    brief,
    opts.usageSink,
    ownerNotes,
  );
  await storeDeliveryBriefSnapshot(db, brief);
  return {
    date: today,
    proposals: counts,
    autoApproved,
    autoTunedParams,
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
        anthropicApiKey: await llmKeyIfBudgetAllows(c.var.DB, c.env.ANTHROPIC_API_KEY, "DELIVERY"),
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
        anthropicApiKey: await llmKeyIfBudgetAllows(c.var.DB, c.env.ANTHROPIC_API_KEY, "DELIVERY"),
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

// ── GET /truck-capacity-analysis ─────────────────────────────────────────────
// Read-only. Derives each lorry's realistic "full load" from HISTORY so the
// owner can set a packing threshold (owner 2026-07-16: "看历史 packing list
// 通常装多少才算 full load，也看罗里容量"). For every packing list in the
// window it sums the member DOs' live volume (m³), unit count and drop count,
// then reports the distribution overall and per destination state, alongside
// the registered truck capacities. NEVER writes.
app.get("/truck-capacity-analysis", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;
  const months = Math.max(1, Math.min(24, Number(c.req.query("months")) || 6));
  const cutoff = new Date(Date.now() - months * 30 * 86400000).toISOString();

  const pct = (sorted: number[], p: number): number => {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return Math.round(sorted[i] * 100) / 100;
  };
  const dist = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const sum = s.reduce((t, v) => t + v, 0);
    return {
      runs: s.length,
      avg: s.length ? Math.round((sum / s.length) * 100) / 100 : 0,
      p50: pct(s, 50),
      p90: pct(s, 90),
      max: s.length ? Math.round(s[s.length - 1] * 100) / 100 : 0,
    };
  };

  try {
    // 1 · Packing lists in window.
    const plRes = await db
      .prepare("SELECT id, do_ids, created_at FROM packing_lists WHERE org_id = ? AND created_at >= ?")
      .bind(orgId, cutoff)
      .all<{ id: string; do_ids?: string; doIds?: string }>();
    const pls = plRes.results ?? [];

    // 2 · Collect member DO ids and load their volume/units/state in bulk.
    const allDoIds = new Set<string>();
    const plDoIds = new Map<string, string[]>();
    for (const pl of pls) {
      let ids: string[] = [];
      try {
        const parsed = JSON.parse((pl.doIds ?? pl.do_ids ?? "[]") as string);
        if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === "string");
      } catch {
        ids = [];
      }
      plDoIds.set(pl.id, ids);
      ids.forEach((id) => allDoIds.add(id));
    }

    const doInfo = new Map<string, { m3: number; units: number; state: string; hubId: string }>();
    const idList = [...allDoIds];
    for (let i = 0; i < idList.length; i += 400) {
      const chunk = idList.slice(i, i + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT id, totalM3, totalItems, customerState, hubId FROM delivery_orders WHERE id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{
          id: string;
          totalM3?: number | string;
          totalm3?: number | string;
          totalItems?: number | string;
          totalitems?: number | string;
          customerState?: string;
          customerstate?: string;
          hubId?: string;
          hubid?: string;
        }>();
      for (const d of r.results ?? []) {
        doInfo.set(d.id, {
          m3: Number(d.totalM3 ?? d.totalm3 ?? 0) || 0,
          units: Number(d.totalItems ?? d.totalitems ?? 0) || 0,
          state: ((d.customerState ?? d.customerstate ?? "") as string).toUpperCase(),
          hubId: (d.hubId ?? d.hubid ?? "") as string,
        });
      }
    }

    // 3 · Hub-state fallback for DOs missing customerState.
    const hubState = new Map<string, string>();
    const hubIds = [...new Set([...doInfo.values()].map((d) => d.hubId).filter(Boolean))];
    for (let i = 0; i < hubIds.length; i += 400) {
      const chunk = hubIds.slice(i, i + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const r = await db
        .prepare(`SELECT id, state FROM delivery_hubs WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ id: string; state?: string }>();
      for (const h of r.results ?? []) hubState.set(h.id, (h.state ?? "").toUpperCase());
    }

    // 4 · Per-PL rollup: carried m³, units, drops, majority state.
    const m3s: number[] = [];
    const unitsArr: number[] = [];
    const dosArr: number[] = [];
    const byState = new Map<string, { m3: number[]; units: number[]; dos: number[] }>();
    let plsCounted = 0;
    for (const [plId, ids] of plDoIds) {
      if (!ids.length) continue;
      let m3 = 0;
      let units = 0;
      const stateCount = new Map<string, number>();
      for (const id of ids) {
        const info = doInfo.get(id);
        if (!info) continue;
        m3 += info.m3;
        units += info.units;
        const st = info.state || hubState.get(info.hubId) || "UNKNOWN";
        stateCount.set(st, (stateCount.get(st) ?? 0) + 1);
      }
      let majState = "UNKNOWN";
      let best = -1;
      for (const [st, n] of stateCount) if (n > best) [majState, best] = [st, n];
      m3s.push(m3);
      unitsArr.push(units);
      dosArr.push(ids.length);
      if (!byState.has(majState)) byState.set(majState, { m3: [], units: [], dos: [] });
      const bs = byState.get(majState)!;
      bs.m3.push(m3);
      bs.units.push(units);
      bs.dos.push(ids.length);
      plsCounted++;
      void plId;
    }

    // 5 · Registered truck capacities (reference — capacity_m3 volume-only).
    const vRes = await db
      .prepare(
        "SELECT plate_no, vehicle_type, capacity_m3 FROM three_pl_vehicles WHERE status = 'ACTIVE' ORDER BY capacity_m3 DESC LIMIT 100",
      )
      .bind()
      .all<{
        plate_no?: string;
        plateNo?: string;
        vehicle_type?: string;
        vehicleType?: string;
        capacity_m3?: number | string;
        capacityM3?: number | string;
        capacitym3?: number | string;
      }>();
    const vehicles = (vRes.results ?? []).map((v) => ({
      plateNo: (v.plateNo ?? v.plate_no ?? "") as string,
      vehicleType: (v.vehicleType ?? v.vehicle_type ?? "") as string,
      capacityM3: Math.round((Number(v.capacityM3 ?? v.capacity_m3 ?? v.capacitym3 ?? 0) || 0) * 100) / 100,
    }));

    const states = [...byState.entries()]
      .map(([state, v]) => ({ state, m3: dist(v.m3), units: dist(v.units), dos: dist(v.dos) }))
      .sort((a, b) => b.m3.runs - a.m3.runs);

    return c.json({
      ok: true,
      windowMonths: months,
      packingListsAnalyzed: plsCounted,
      overall: { m3: dist(m3s), units: dist(unitsArr), drops: dist(dosArr) },
      byState: states,
      truckCapacitiesM3: vehicles,
      note:
        "carried m³ = Σ member DOs' stored totalM3; products with unit M³ = 0 understate volume. " +
        "Use overall.m3.p90 / per-state p90 as the 'full enough' line; compare to truckCapacitiesM3.",
    });
  } catch (err) {
    console.error("[delivery-agent/truck-capacity-analysis] failed:", err);
    return c.json({ ok: false, error: "analysis failed" }, 500);
  }
});

export default app;
