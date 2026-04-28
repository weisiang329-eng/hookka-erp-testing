// ---------------------------------------------------------------------------
// MDM (Master Data Management) review queue — Phase C #4 quick-win.
//
// Detection-only API surface. Ops triage suspected duplicate customers /
// suppliers / products by:
//   1. GET    /api/mdm/review-queue?status=PENDING — open inbox
//   2. POST   /api/mdm/review-queue/:id/dismiss    — false-positive
//   3. POST   /api/mdm/review-queue/:id/merge      — closes the flag after
//                                                    ops merged via the
//                                                    existing customer/
//                                                    supplier UI
//   4. POST   /api/mdm/detection/run               — admin-triggered scan
//                                                    (until cron lands)
//
// Schema: migrations/0052_mdm_review_queue.sql.
// Detection logic: src/api/lib/mdm-detect.ts.
//
// All endpoints sit BEHIND the global authMiddleware in worker.ts. The
// detection-run endpoint additionally sniffs the user's role to keep
// non-admins from flooding the queue with duplicate scans (defence in
// depth — RLS would be the next-step hardening, see roadmap §1).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { runMdmDetectionPass } from "../lib/mdm-detect";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row + API shapes
// ---------------------------------------------------------------------------

type ReviewQueueRow = {
  id: string;
  resourceType: string;
  primaryId: string;
  candidateId: string;
  score: number;
  signals: string;
  status: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  notes: string;
  orgId: string;
};

function rowToApi(r: ReviewQueueRow) {
  let signals: string[] = [];
  try {
    const parsed = JSON.parse(r.signals);
    if (Array.isArray(parsed)) signals = parsed.filter((s) => typeof s === "string");
  } catch {
    // Defensive: a corrupt signals payload shouldn't 500 the inbox query.
    signals = [];
  }
  return {
    id: r.id,
    resourceType: r.resourceType,
    primaryId: r.primaryId,
    candidateId: r.candidateId,
    score: r.score,
    signals,
    status: r.status,
    detectedAt: r.detectedAt,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
    notes: r.notes ?? "",
  };
}

const ALLOWED_STATUSES = new Set([
  "PENDING",
  "REVIEWING",
  "MERGED",
  "DISMISSED",
]);

// ---------------------------------------------------------------------------
// GET /api/mdm/review-queue?status=PENDING
//
// List candidate pairs. Defaults to status=PENDING so the operator inbox
// returns just the open work. Pass status=ALL to skip the filter (useful
// for an audit / "what did we resolve last week" view).
// ---------------------------------------------------------------------------
app.get("/review-queue", async (c) => {
  const orgId = getOrgId(c);
  const statusParam = (c.req.query("status") ?? "PENDING").toUpperCase();
  const limitParam = parseInt(c.req.query("limit") ?? "", 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitParam) ? limitParam : 100));

  // ALL = no status predicate; otherwise validate against the enum so a
  // typo doesn't silently return the empty set.
  const useStatus = statusParam !== "ALL";
  if (useStatus && !ALLOWED_STATUSES.has(statusParam)) {
    return c.json(
      { success: false, error: "invalid status — must be one of PENDING/REVIEWING/MERGED/DISMISSED/ALL" },
      400,
    );
  }

  const sql = useStatus
    ? `SELECT id, resourceType, primaryId, candidateId, score, signals, status,
              detectedAt, resolvedAt, resolvedBy, notes, orgId
         FROM mdm_review_queue
        WHERE orgId = ? AND status = ?
        ORDER BY detectedAt DESC
        LIMIT ?`
    : `SELECT id, resourceType, primaryId, candidateId, score, signals, status,
              detectedAt, resolvedAt, resolvedBy, notes, orgId
         FROM mdm_review_queue
        WHERE orgId = ?
        ORDER BY detectedAt DESC
        LIMIT ?`;

  const stmt = useStatus
    ? c.var.DB.prepare(sql).bind(orgId, statusParam, limit)
    : c.var.DB.prepare(sql).bind(orgId, limit);

  const res = await stmt.all<ReviewQueueRow>();
  const data = (res.results ?? []).map(rowToApi);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// Helper: load + ownership-check a queue row.
// ---------------------------------------------------------------------------
async function loadRow(
  db: D1Database,
  id: string,
  orgId: string,
): Promise<ReviewQueueRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM mdm_review_queue WHERE id = ? AND orgId = ? LIMIT 1",
    )
    .bind(id, orgId)
    .first<ReviewQueueRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Helper: state transition with optional notes.
// ---------------------------------------------------------------------------
async function resolveRow(
  c: Context<Env>,
  id: string,
  newStatus: "MERGED" | "DISMISSED",
): Promise<Response> {
  const orgId = getOrgId(c);
  const row = await loadRow(c.var.DB, id, orgId);
  if (!row) {
    return c.json({ success: false, error: "Review queue entry not found" }, 404);
  }
  if (row.status === "MERGED" || row.status === "DISMISSED") {
    return c.json(
      {
        success: false,
        error: `Already resolved as ${row.status}`,
        currentStatus: row.status,
      },
      409,
    );
  }

  let notes = row.notes;
  try {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.notes === "string") notes = body.notes;
  } catch {
    // Empty / no body — fine, keep existing notes.
  }

  const resolvedBy =
    (c.get as unknown as (k: string) => unknown)("userId") as string | undefined ?? null;

  await c.var.DB.prepare(
    `UPDATE mdm_review_queue
        SET status = ?, resolvedAt = CURRENT_TIMESTAMP, resolvedBy = ?, notes = ?
      WHERE id = ? AND orgId = ?`,
  )
    .bind(newStatus, resolvedBy, notes, id, orgId)
    .run();

  const updated = await loadRow(c.var.DB, id, orgId);
  return c.json({ success: true, data: updated ? rowToApi(updated) : null });
}

// ---------------------------------------------------------------------------
// POST /api/mdm/review-queue/:id/dismiss
//
// Mark a queue row as DISMISSED (false positive — the two records are
// actually distinct). Body may include { notes: string } for audit context.
// ---------------------------------------------------------------------------
app.post("/review-queue/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  return resolveRow(c, id, "DISMISSED");
});

// ---------------------------------------------------------------------------
// POST /api/mdm/review-queue/:id/merge
//
// Mark a queue row as MERGED. The actual record-merge happens elsewhere
// (existing customer/supplier UI); this just closes the flag. Body may
// include { notes: string } describing which row was kept.
// ---------------------------------------------------------------------------
app.post("/review-queue/:id/merge", async (c) => {
  const id = c.req.param("id");
  return resolveRow(c, id, "MERGED");
});

// ---------------------------------------------------------------------------
// POST /api/mdm/detection/run
//
// Admin-triggered detection pass. Wires through to runMdmDetectionPass()
// in lib/mdm-detect.ts which scans customers + suppliers and inserts new
// candidate pairs. Idempotent — UNIQUE constraint dedupes re-runs.
//
// Returns the run statistics so ops can see what landed.
//
// TODO once Cron infra exists (see wrangler.toml — companion-Worker
// pattern), wire this to a nightly schedule and keep this endpoint as a
// manual override.
// ---------------------------------------------------------------------------
app.post("/detection/run", async (c) => {
  const orgId = getOrgId(c);
  try {
    const stats = await runMdmDetectionPass(c.var.DB, orgId);
    return c.json({ success: true, ...stats });
  } catch (e) {
    console.error("[mdm/detection/run] error:", e);
    return c.json(
      { success: false, error: "detection pass failed" },
      500,
    );
  }
});

export default app;
