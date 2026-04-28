// ---------------------------------------------------------------------------
// Phase 6 — job_cards read endpoints.
//
// Endpoints:
//   GET /api/job-cards?picId=X&from=YYYY-MM-DD&to=YYYY-MM-DD
//                                    Worker-scoped completed job cards
//                                    (status COMPLETED/TRANSFERRED). Used by
//                                    the Employee Performance tab so workers
//                                    who only get recorded via PIC slots
//                                    (not attendance punches) still surface.
//                                    Returns rows joined to production_orders
//                                    so each entry carries productCode + poNo.
//   GET /api/job-cards/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//                                    Per-worker production-time totals
//                                    (productionTimeMinutes summed across
//                                    completed JCs, halved when both PIC
//                                    slots are filled). Backs the Production
//                                    Time + Efficiency % columns on the
//                                    Efficiency Overview tab.
//   GET /api/job-cards/:id/events    Event audit log (newest first,
//                                    paginated). Reads from the
//                                    parallel write table created in
//                                    migrations/0039_job_card_events.sql.
//
// Writes to job_cards themselves keep happening through the PATCH handler in
// production-orders.ts.
//
// NOTE: this file is DISTINCT from routes/jobcard-sync.ts, which is
// an admin one-shot that reconciles job_cards against the current BOM.
// Keeping them separate so the audit-read surface has a clean URL space.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /api/job-cards?picId=X[&from=YYYY-MM-DD][&to=YYYY-MM-DD][&status=...]
//
// Returns COMPLETED + TRANSFERRED job_cards rows where the worker is PIC1 or
// PIC2 (matched on pic1Id / pic2Id), joined to production_orders so each row
// carries productCode + poNo without a second round-trip.
//
// Why this exists: Employee Performance tab used to read attendance_records
// only — workers who do real production work (PIC on completed JCs) but
// don't have explicit clock-in/clock-out punches looked like they did
// nothing. This endpoint is the second data source.
//
// Each row's `picSlot` tells the caller which side this worker was on so
// the FE can apply the existing "halve PIC2 contribution" convention if it
// wants to.
// ---------------------------------------------------------------------------
type WorkerJcRow = {
  id: string;
  productionOrderId: string;
  poNo: string | null;
  productCode: string | null;
  departmentCode: string | null;
  wipCode: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  completedDate: string | null;
  productionTimeMinutes: number;
  status: string;
  pic1Id: string | null;
  pic2Id: string | null;
};

app.get("/", async (c) => {
  const picId = c.req.query("picId");
  if (!picId) {
    return c.json({ success: false, error: "picId required" }, 400);
  }
  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;

  // Allowed terminal statuses. Default to both COMPLETED + TRANSFERRED — both
  // mean "the worker finished the job", just one was handed off downstream.
  const statusParam = c.req.query("status");
  const statuses = statusParam
    ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
    : ["COMPLETED", "TRANSFERRED"];
  if (statuses.length === 0) {
    return c.json({ success: false, error: "status filter empty" }, 400);
  }

  const db = c.var.DB;
  const statusPlaceholders = statuses.map(() => "?").join(",");
  const dateFilter: string[] = [];
  const dateBinds: string[] = [];
  if (from) {
    dateFilter.push("jc.completedDate >= ?");
    dateBinds.push(from);
  }
  if (to) {
    dateFilter.push("jc.completedDate <= ?");
    dateBinds.push(to);
  }
  const dateClause = dateFilter.length > 0 ? ` AND ${dateFilter.join(" AND ")}` : "";

  const sql = `
    SELECT
      jc.id              AS id,
      jc.productionOrderId AS productionOrderId,
      po.poNo            AS poNo,
      po.productCode     AS productCode,
      jc.departmentCode  AS departmentCode,
      jc.wipCode         AS wipCode,
      jc.wipLabel        AS wipLabel,
      jc.wipQty          AS wipQty,
      jc.completedDate   AS completedDate,
      jc.productionTimeMinutes AS productionTimeMinutes,
      jc.status          AS status,
      jc.pic1Id          AS pic1Id,
      jc.pic2Id          AS pic2Id
    FROM job_cards jc
    LEFT JOIN production_orders po ON po.id = jc.productionOrderId
    WHERE jc.orgId = ?
      AND (jc.pic1Id = ? OR jc.pic2Id = ?)
      AND jc.status IN (${statusPlaceholders})
      AND jc.completedDate IS NOT NULL
      ${dateClause}
    ORDER BY jc.completedDate DESC, jc.id DESC
    LIMIT 5000
  `;

  const orgId = getOrgId(c);
  const res = await db
    .prepare(sql)
    .bind(orgId, picId, picId, ...statuses, ...dateBinds)
    .all<WorkerJcRow>();

  const rows = res.results ?? [];
  const data = rows.map((r) => {
    const pic1Filled = !!(r.pic1Id && r.pic1Id !== "");
    const pic2Filled = !!(r.pic2Id && r.pic2Id !== "");
    // job_cards.productionTimeMinutes is per-unit; wipQty is the JC's
    // unit count (e.g. a bedframe Divan WIP for a 2-unit PO has wipQty=2).
    // The "actual production time" = perUnit x wipQty, which is what the
    // worker actually spent and what should appear in Daily Breakdown +
    // be summed for Total Production Hrs. Bug fix 2026-04-28: was
    // returning per-unit, so a 15-min/unit JC with qty=2 looked like 15
    // min instead of 30.
    const wipQty = Math.max(1, Number(r.wipQty) || 1);
    const perUnitMin = r.productionTimeMinutes ?? 0;
    return {
      id: r.id,
      productionOrderId: r.productionOrderId,
      poNo: r.poNo ?? "",
      productCode: r.productCode ?? "",
      departmentCode: r.departmentCode ?? "",
      wipCode: r.wipCode ?? "",
      wipLabel: r.wipLabel ?? "",
      wipQty,
      completedDate: r.completedDate,
      productionTimeMinutes: perUnitMin * wipQty,
      perUnitMinutes: perUnitMin,
      status: r.status,
      picSlot: r.pic1Id === picId ? "PIC1" : r.pic2Id === picId ? "PIC2" : "",
      // hasBothPics tells the FE whether to halve this worker's contribution
      // when summing per-employee production minutes. When BOTH PIC slots
      // are filled the worker shares the JC with a partner -> half each;
      // when only one slot is filled (solo), full minutes go to that one.
      hasBothPics: pic1Filled && pic2Filled,
    };
  });

  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/job-cards/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-worker production-time totals across COMPLETED + TRANSFERRED job_cards
// in the date range. Backs the "Production Time" + "Efficiency %" columns on
// the Efficiency Overview tab so the page can compute Production / Working
// without round-tripping every individual JC row.
//
// Halving rule: when a JC has BOTH pic1Id and pic2Id filled in, each worker
// gets credited with productionTimeMinutes / 2. This matches the existing
// "PIC2 = assist" convention used in EmployeeDetailTab and the Google Sheet
// `populateDetailTable` logic. Solo JCs (only pic1Id) credit the full amount
// to that worker.
//
// Implementation: single GROUP BY over a UNION ALL of (PIC1 contribution,
// PIC2 contribution). Easier to type-check than a one-pass CASE pivot and
// the row count is bounded by job_cards * 2.
// ---------------------------------------------------------------------------
type WorkerProdSummaryRow = {
  workerId: string;
  productionMinutes: number | string | null;
  jcCount: number | string | null;
};

app.get("/summary", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // Aliases use snake_case so Postgres preserves them (unquoted identifiers
  // get folded to lowercase, breaking JS reads on camelCase aliases like
  // productionMinutes -> productionminutes which postgres.js cannot restore).
  // The driver's transform.column.from layer converts snake_case back to
  // camelCase for us (worker_id -> workerId, production_minutes ->
  // productionMinutes, jc_count -> jcCount). Bug fix 2026-04-28: this
  // endpoint silently returned 0 productionMinutes for every worker because
  // r.productionMinutes was undefined.
  // PIC contribution rule (mirrored on FE):
  //   - Both slots filled  -> each worker gets productionTimeMinutes / 2
  //   - Only one slot filled (solo) -> that worker gets full minutes
  // Bug fix 2026-04-28: previously the PIC2 branch required pic1Id IS NOT
  // NULL too, so a JC where the operator put the worker only in pic2 (no
  // pic1) was invisible to /summary entirely. Now PIC2 stands alone and
  // solo-PIC2 contributes the full minutes, matching how /api/job-cards
  // already returns the row.
  // Bug fix 2026-04-28: productionTimeMinutes is per-unit; multiply by
  // wipQty (max(1, ...) so a missing wipQty still counts as 1 unit) to
  // get the actual time the worker spent. A 15-min/unit JC with qty=2
  // = 30 min real time; previously we summed per-unit values so PIC's
  // production minutes were under-counted whenever wipQty > 1.
  const sql = `
    SELECT wid AS worker_id,
           SUM(contrib_min) AS production_minutes,
           COUNT(*) AS jc_count
      FROM (
        SELECT pic1Id AS wid,
               CASE WHEN pic2Id IS NOT NULL AND pic2Id != ''
                    THEN (productionTimeMinutes * GREATEST(1, COALESCE(wipQty, 1))) / 2.0
                    ELSE (productionTimeMinutes * GREATEST(1, COALESCE(wipQty, 1)))
               END AS contrib_min
          FROM job_cards
         WHERE pic1Id IS NOT NULL AND pic1Id != ''
           AND status IN ('COMPLETED','TRANSFERRED')
           AND completedDate IS NOT NULL
           AND completedDate >= ? AND completedDate <= ?

        UNION ALL

        SELECT pic2Id AS wid,
               CASE WHEN pic1Id IS NOT NULL AND pic1Id != ''
                    THEN (productionTimeMinutes * GREATEST(1, COALESCE(wipQty, 1))) / 2.0
                    ELSE (productionTimeMinutes * GREATEST(1, COALESCE(wipQty, 1)))
               END AS contrib_min
          FROM job_cards
         WHERE pic2Id IS NOT NULL AND pic2Id != ''
           AND status IN ('COMPLETED','TRANSFERRED')
           AND completedDate IS NOT NULL
           AND completedDate >= ? AND completedDate <= ?
      ) sub
     WHERE wid IS NOT NULL AND wid != ''
     GROUP BY wid
  `;

  const res = await c.var.DB
    .prepare(sql)
    .bind(from, to, from, to)
    .all<WorkerProdSummaryRow>();

  const data = (res.results ?? []).map((r) => ({
    workerId: r.workerId,
    productionMinutes: Math.round(Number(r.productionMinutes) || 0),
    jcCount: Number(r.jcCount) || 0,
  }));

  return c.json({ success: true, data, total: data.length });
});

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

  const db = c.var.DB;
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
