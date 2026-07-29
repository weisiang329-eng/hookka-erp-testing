// ---------------------------------------------------------------------------
// Planning > Schedule Proposals (Production Agent Phase 2).
//
//   POST /api/planning/proposals/generate  — run the chain engine and upsert
//        PENDING due-date proposals (production-orders:update).
//   GET  /api/planning/proposals?status=PENDING — list proposals (read perm).
//   POST /api/planning/proposals/approve {ids} — write job_cards.dueDate from
//        each proposal, mark APPROVED, and store ONE plan_snapshots row with
//        the applied set.
//   POST /api/planning/proposals/reject  {ids} — mark REJECTED (no JC write).
//
// This is the ONLY place Phase 2 writes to job_cards — generation is read-only
// and every write goes through the owner's explicit approval.
// Mounted at /api/planning in src/api/worker.ts (alongside planning-schedule).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { ensureProposalTables, generateProposals } from "../lib/schedule-proposals";
import { isAgentPaused, recordAgentRun } from "../lib/agent-console";

const app = new Hono<Env>();

interface ProposalRow {
  id: string;
  generated_at: string;
  jc_id: string;
  po_id: string | null;
  dept: string | null;
  so_ref: string | null;
  lane: string | null;
  fabric: string | null;
  current_due: string | null;
  proposed_due: string;
  reason: string | null;
  status: string;
  decided_at: string | null;
  decided_by: string | null;
  // db-pg adapter folds snake_case columns to camelCase in results — every
  // read below is dual-keyed (r.camelCase ?? r.snake_case), the codebase-wide
  // column-rename-map rule. Reading only snake made approve write NULL dates.
  generatedAt?: string;
  jcId?: string;
  poId?: string | null;
  soRef?: string | null;
  currentDue?: string | null;
  proposedDue?: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

function actorId(c: { get: (k: string) => unknown }): string | null {
  // userId is stamped by auth-middleware; read through the same escape hatch
  // the other routes use (worker.ts's Variables map doesn't enumerate it).
  const v = (c as unknown as { get: (k: string) => string | undefined }).get("userId");
  return v ?? null;
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
  return ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500);
}

// ── Generate ─────────────────────────────────────────────────────────────────

app.post("/proposals/generate", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  void getOrgId(c);
  // Agent Console gate — paused Production agent / global kill switch stops
  // proposal generation too (P3). The response keeps success:false so the
  // Planning tab surfaces the reason instead of a silent empty run.
  if (await isAgentPaused(c.var.DB, "PRODUCTION")) {
    return c.json({
      success: false,
      skipped: "paused",
      error: "Production agent is paused — resume it in the Agent Console.",
    });
  }
  const counts = await recordAgentRun(c.var.DB, "production-proposals", async (run) => {
    const r = await generateProposals(c.var.DB);
    run.setSummary(
      `proposed ${r.proposed} (unscheduled ${r.unscheduled} · overdue ${r.overdue} · superseded ${r.superseded})`,
    );
    return r;
  });
  return c.json({ success: true, data: counts });
});

// ── List ─────────────────────────────────────────────────────────────────────

app.get("/proposals", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  void getOrgId(c);
  const db = c.var.DB;
  await ensureProposalTables(db);
  const status = (c.req.query("status") ?? "PENDING").toUpperCase();
  const res = await db
    .prepare(
      `SELECT * FROM schedule_proposals
        WHERE status = ?
        ORDER BY so_ref, dept, jc_id
        LIMIT 1000`,
    )
    .bind(status)
    .all<ProposalRow>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    generatedAt: (r.generatedAt ?? r.generated_at),
    jcId: (r.jcId ?? r.jc_id),
    poId: (r.poId ?? r.po_id) ?? "",
    dept: r.dept ?? "",
    soRef: (r.soRef ?? r.so_ref) ?? "",
    lane: r.lane ?? "",
    fabric: r.fabric ?? "",
    currentDue: (r.currentDue ?? r.current_due),
    proposedDue: (r.proposedDue ?? r.proposed_due),
    reason: r.reason ?? "",
    status: r.status,
    decidedAt: (r.decidedAt ?? r.decided_at),
    decidedBy: (r.decidedBy ?? r.decided_by),
  }));
  return c.json({ success: true, data });
});

// ── Approve — the ONLY write path into job_cards.dueDate ─────────────────────

app.post("/proposals/approve", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  void getOrgId(c);
  const ids = await readIds(c);
  if (!ids) return c.json({ success: false, error: "ids[] required" }, 400);

  const db = c.var.DB;
  await ensureProposalTables(db);
  const nowIso = new Date().toISOString();
  const decidedBy = actorId(c);

  const applied: Array<{
    proposalId: string;
    jcId: string;
    poId: string | null;
    dept: string | null;
    soRef: string | null;
    from: string | null;
    to: string;
  }> = [];

  for (const id of ids) {
    const row = await db
      .prepare("SELECT * FROM schedule_proposals WHERE id = ? AND status = 'PENDING'")
      .bind(id)
      .first<ProposalRow>();
    if (!row) continue; // unknown / already decided — skip silently
    // Apply ONLY to a still-open card; a card completed/cancelled since
    // generation keeps its dates untouched.
    await db
      .prepare(
        // Sent-lock (owner 2026-07-29): a card already SENT to the floor
        // (distributedAt set) keeps its due date — mirrors the auto-approve
        // drain + the generation-time guard.
        `UPDATE job_cards SET dueDate = ?, updated_at = ?
          WHERE id = ? AND status = 'WAITING'
            AND (distributedAt IS NULL OR distributedAt = '')`,
      )
      .bind((row.proposedDue ?? row.proposed_due), nowIso, (row.jcId ?? row.jc_id))
      .run();
    await db
      .prepare(
        `UPDATE schedule_proposals
            SET status = 'APPROVED', decided_at = ?, decided_by = ?
          WHERE id = ?`,
      )
      .bind(nowIso, decidedBy, id)
      .run();
    applied.push({
      proposalId: id,
      jcId: (row.jcId ?? row.jc_id),
      poId: (row.poId ?? row.po_id),
      dept: row.dept,
      soRef: (row.soRef ?? row.so_ref),
      from: (row.currentDue ?? row.current_due),
      to: (row.proposedDue ?? row.proposed_due),
    });
  }

  // ONE snapshot row for the whole applied set (the audit trail of what the
  // approved plan looked like).
  if (applied.length > 0) {
    await db
      .prepare("INSERT INTO plan_snapshots (id, taken_at, date, payload) VALUES (?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        nowIso,
        nowIso.slice(0, 10),
        JSON.stringify({ kind: "PROPOSALS_APPLIED", decidedBy, applied }),
      )
      .run();
  }

  return c.json({ success: true, data: { approved: applied.length, skipped: ids.length - applied.length } });
});

// ── Reject ───────────────────────────────────────────────────────────────────

app.post("/proposals/reject", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  void getOrgId(c);
  const ids = await readIds(c);
  if (!ids) return c.json({ success: false, error: "ids[] required" }, 400);

  const db = c.var.DB;
  await ensureProposalTables(db);
  const nowIso = new Date().toISOString();
  const decidedBy = actorId(c);
  const ph = ids.map(() => "?").join(",");
  await db
    .prepare(
      `UPDATE schedule_proposals
          SET status = 'REJECTED', decided_at = ?, decided_by = ?
        WHERE status = 'PENDING' AND id IN (${ph})`,
    )
    .bind(nowIso, decidedBy, ...ids)
    .run();
  return c.json({ success: true, data: { rejected: ids.length } });
});

export default app;
