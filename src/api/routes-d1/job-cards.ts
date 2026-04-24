// ---------------------------------------------------------------------------
// Phase 6 — job_cards read endpoints.
//
// Intentionally narrow scope right now:
//   GET /api/job-cards/:id/events   Event audit log (newest first,
//                                    paginated). Reads from the
//                                    parallel write table created in
//                                    migrations/0039_job_card_events.sql.
//
// No UI yet — this endpoint exists for future audit screens + programmatic
// rollback tooling. Writes to job_cards themselves keep happening through
// the PATCH handler in production-orders.ts.
//
// NOTE: this file is DISTINCT from routes-d1/jobcard-sync.ts, which is
// an admin one-shot that reconciles job_cards against the current BOM.
// Keeping them separate so the audit-read surface has a clean URL space.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /api/job-cards/:id/events
//
// Query params:
//   ?page=N&limit=M    Default page=1, limit=50, cap 500. Newest first
//                      (ORDER BY ts DESC, id DESC — id acts as tiebreaker
//                      when two events land in the same millisecond).
//
// Response:
//   { success, data: Event[], page, limit, total }
//   Event.payload is returned as a parsed JSON object (not a string)
//   so the frontend doesn't need to JSON.parse every row.
// ---------------------------------------------------------------------------
type EventRow = {
  id: string;
  jobCardId: string;
  productionOrderId: string;
  eventType: string;
  payload: string;
  actorUserId: string | null;
  actorName: string | null;
  source: string | null;
  ts: string;
};

app.get("/:id/events", async (c) => {
  const jobCardId = c.req.param("id");
  if (!jobCardId) {
    return c.json({ success: false, error: "jobCardId required" }, 400);
  }

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  const db = c.env.DB;
  const [countRes, pageRes] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM job_card_events WHERE jobCardId = ?")
      .bind(jobCardId)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT * FROM job_card_events
          WHERE jobCardId = ?
          ORDER BY ts DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(jobCardId, limit, offset)
      .all<EventRow>(),
  ]);

  const total = countRes?.n ?? 0;
  const rows = pageRes.results ?? [];
  const data = rows.map((r) => ({
    id: r.id,
    jobCardId: r.jobCardId,
    productionOrderId: r.productionOrderId,
    eventType: r.eventType,
    payload: safeParseJson(r.payload),
    actorUserId: r.actorUserId,
    actorName: r.actorName,
    source: r.source,
    ts: r.ts,
  }));

  return c.json({ success: true, data, page, limit, total });
});

// Never throw on a malformed payload — audit rows should still be readable
// even if a writer accidentally stored invalid JSON.
function safeParseJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s, _parseError: true };
  }
}

export default app;
