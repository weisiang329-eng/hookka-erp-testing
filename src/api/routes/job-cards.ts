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
import { requirePermission } from "../lib/rbac";
import { jcMinutesTotal } from "../../lib/job-card-minutes";

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
  // job_cards is production data — gate with the same production-read
  // permission as production-orders.ts so the Employee Performance tab
  // (whose users already read /api/production-orders) is unaffected.
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;

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
    // min instead of 30. FAB_CUT exception (jcMinutesTotal): merged FABRIC
    // CUTTING cards store productionTimeMinutes as the per-SET TOTAL already
    // (wipQty = piece count), so the helper skips the ×wipQty there to avoid
    // a 3× over-count in the worker's Production Hrs.
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
      productionTimeMinutes: jcMinutesTotal(perUnitMin, r),
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
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;

  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // PR 7 — cache-aside snapshot. cache_key encodes the date window.
  const { getOrgId } = await import("../lib/tenant");
  const { readSnapshot, writeSnapshot, getSourceSignature, isSnapshotFresh } =
    await import("../lib/snapshot");
  const orgId = getOrgId(c);
  const snapConfig = {
    tableName: "job_cards_summary_snapshot",
    sourceTables: ["job_cards", "worker_nonprod_requests"],
  };
  const cacheKey = `from=${from}&to=${to}`;
  const _snap_check = await Promise.all([
    readSnapshot(c.var.DB, snapConfig, orgId, cacheKey),
    getSourceSignature(c.var.DB, snapConfig.sourceTables),
  ]);
  if (isSnapshotFresh(_snap_check[0], _snap_check[1].maxUpdatedAt, _snap_check[1].rowCount) && _snap_check[0]) {
    return c.json({ success: true, ..._snap_check[0].data });
  }
  const _snap_currentMax = _snap_check[1].maxUpdatedAt;
  const _snap_sourceRows = _snap_check[1].rowCount;

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
  // FAB_CUT exception (mirrors jcMinutesTotal + the cost cascade): merged
  // FABRIC CUTTING cards store productionTimeMinutes as the per-SET TOTAL
  // (wipQty = piece count), so multiplying by wipQty there triple-counts
  // (190-min/3-piece set would read 570). Guard with a CASE so FAB_CUT uses
  // the stored total as-is while every other dept keeps the ×wipQty.
  const jcTotalMin =
    "CASE WHEN departmentCode = 'FAB_CUT' THEN COALESCE(productionTimeMinutes, 0) " +
    "ELSE COALESCE(productionTimeMinutes, 0) * GREATEST(1, COALESCE(wipQty, 1)) END";
  const sql = `
    SELECT wid AS worker_id,
           SUM(contrib_min) AS production_minutes,
           COUNT(*) AS jc_count
      FROM (
        SELECT pic1Id AS wid,
               CASE WHEN pic2Id IS NOT NULL AND pic2Id != ''
                    THEN (${jcTotalMin}) / 2.0
                    ELSE (${jcTotalMin})
               END AS contrib_min
          FROM job_cards
         WHERE pic1Id IS NOT NULL AND pic1Id != ''
           AND status IN ('COMPLETED','TRANSFERRED')
           AND completedDate IS NOT NULL
           AND completedDate >= ? AND completedDate <= ?

        UNION ALL

        SELECT pic2Id AS wid,
               CASE WHEN pic1Id IS NOT NULL AND pic1Id != ''
                    THEN (${jcTotalMin}) / 2.0
                    ELSE (${jcTotalMin})
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

  const byWorker = new Map<
    string,
    { workerId: string; productionMinutes: number; jcCount: number }
  >();
  for (const r of res.results ?? []) {
    byWorker.set(r.workerId, {
      workerId: r.workerId,
      productionMinutes: Math.round(Number(r.productionMinutes) || 0),
      jcCount: Number(r.jcCount) || 0,
    });
  }

  // Approved EXTRA PRODUCTION TIME (kind='ADD_PROD') → add to the per-worker
  // production minutes (the Efficiency % numerator on the Employees page). A
  // worker with no approved claims is unaffected; a worker with claims but no
  // completed JCs in range still surfaces (jcCount 0) so the credit shows.
  const { computeApprovedAddProdMinutesByWorker } = await import(
    "../lib/efficiency-allowance"
  );
  const addProd = await computeApprovedAddProdMinutesByWorker(c.var.DB, from, to);
  for (const [wid, mins] of addProd) {
    const cur = byWorker.get(wid);
    if (cur) {
      cur.productionMinutes += mins;
    } else {
      byWorker.set(wid, { workerId: wid, productionMinutes: mins, jcCount: 0 });
    }
  }

  const data = Array.from(byWorker.values());
  const _snap_payload = { data, total: data.length };
  try {
    await writeSnapshot(
      c.var.DB,
      snapConfig,
      orgId,
      _snap_payload,
      _snap_currentMax ?? new Date().toISOString(),
      cacheKey,
      _snap_sourceRows,
    );
  } catch (e) {
    console.warn("[job-cards-summary-snapshot] write-back failed:", e);
  }
  return c.json({ success: true, ..._snap_payload });
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
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;

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

// ---------------------------------------------------------------------------
// GET /api/job-cards/duedate-original-backup[?format=csv]
//
// One-shot, READ-ONLY recovery dump. A bulk write (~2026-06-01) overwrote the
// dueDate on ~3,876 job cards with no backup file saved. The job_card_events
// audit log captured every change as a DUE_DATE_CHANGED event whose payload
// JSON carries { from, to }. For each job card we surface the `from` value of
// its EARLIEST DUE_DATE_CHANGED event — that `from` is the original dueDate as
// it stood immediately before the first recorded change (which, for cards only
// touched by the bulk overwrite, IS the pre-overwrite value).
//
// Logic: a single batched query (no per-card loops). A CTE ranks the
// DUE_DATE_CHANGED events per job card with ROW_NUMBER() OVER (PARTITION BY
// jobCardId ORDER BY ts ASC, id ASC) and we keep rank 1 = earliest. We return
// the raw payload TEXT and parse `from` in JS rather than relying on a
// Postgres JSON operator, because payload is stored as plain TEXT (not jsonb)
// and the d1-compat layer makes ->>' fragile across SQLite/Postgres. The dump
// joins job_cards (current dueDate + department) and production_orders
// (companySOId + poNo) so every row reads as "SO-XXXX dept → original date".
//
// Output:
//   default  JSON { generatedAt, count, rows: [...] }
//   ?format=csv  text/csv with a Content-Disposition attachment header so the
//                browser saves it as a file.
//
// This endpoint MUTATES NOTHING — pure read/dump. Safe to call repeatedly.
// ---------------------------------------------------------------------------
// NOTE: the db-pg compat layer reverse-maps EVERY result column name back to
// its original camelCase via column-rename-map.json (falling back to
// postgres.toCamel for ad-hoc aliases). So even though the SQL aliases these
// columns to snake_case, the runtime row keys arrive camelCase. Read them as
// camelCase here — reading snake_case silently yields undefined → null (the
// 2026-06-03 "backup file is empty" bug). Only `payload` is unchanged by
// toCamel, which is why originalDueDate kept working while the rest went null.
type DueDateBackupRow = {
  jobCardId: string;
  productionOrderId: string;
  companySOId: string | null;
  poNo: string | null;
  departmentCode: string | null;
  currentDueDate: string | null;
  payload: string;
  firstChangedAt: string;
};

app.get("/duedate-original-backup", async (c) => {
  // Read-only production data — gate behind job-cards:read (admins hold the
  // *:* wildcard and pass automatically).
  const denied = await requirePermission(c, "job-cards", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const db = c.var.DB;

  // Earliest DUE_DATE_CHANGED event per job card (rank 1), joined to the
  // current job_cards row + its production order for SO/PO/dept context.
  //
  // Org scoping: job_card_events has no orgId column (the sibling
  // /:id/events route also filters on jobCardId alone), so we scope through
  // the INNER JOIN to production_orders.orgId, which IS tenant-stamped
  // (migration 0049). An INNER JOIN here means events whose PO is in another
  // org are excluded — exactly the multi-tenant boundary we want.
  //
  // Aliases are snake_case so Postgres (which folds unquoted identifiers to
  // lowercase) preserves them — but the db-pg layer then toCamel's every
  // result key, so we read camelCase keys off the rows (see DueDateBackupRow).
  const sql = `
    WITH ranked AS (
      SELECT
        e.jobCardId          AS job_card_id,
        e.productionOrderId  AS production_order_id,
        e.payload            AS payload,
        e.ts                 AS ts,
        ROW_NUMBER() OVER (
          PARTITION BY e.jobCardId
          ORDER BY e.ts ASC, e.id ASC
        ) AS rn
      FROM job_card_events e
      WHERE e.eventType = 'DUE_DATE_CHANGED'
    )
    SELECT
      r.job_card_id           AS job_card_id,
      r.production_order_id    AS production_order_id,
      po.companySOId           AS company_so_id,
      po.poNo                  AS po_no,
      jc.departmentCode        AS department_code,
      jc.dueDate               AS current_due_date,
      r.payload                AS payload,
      r.ts                     AS first_changed_at
    FROM ranked r
    JOIN production_orders po       ON po.id = r.production_order_id AND po.orgId = ?
    LEFT JOIN job_cards jc          ON jc.id = r.job_card_id
    WHERE r.rn = 1
    ORDER BY po.companySOId, jc.departmentCode, r.job_card_id
  `;

  const res = await db.prepare(sql).bind(orgId).all<DueDateBackupRow>();
  const raw = res.results ?? [];

  const rows = raw.map((r) => {
    let originalDueDate: string | null = null;
    const parsed = safeParseJson(r.payload);
    if (parsed && typeof parsed === "object" && "from" in (parsed as object)) {
      const from = (parsed as { from?: unknown }).from;
      originalDueDate = typeof from === "string" ? from : from == null ? null : String(from);
    }
    return {
      jobCardId: r.jobCardId,
      productionOrderId: r.productionOrderId,
      companySOId: r.companySOId ?? null,
      poNo: r.poNo ?? null,
      departmentCode: r.departmentCode ?? null,
      currentDueDate: r.currentDueDate ?? null,
      originalDueDate,
      firstChangedAt: r.firstChangedAt,
    };
  });

  const generatedAt = new Date().toISOString();

  const format = (c.req.query("format") ?? "").toLowerCase();
  if (format === "csv") {
    const header = [
      "Job Card Id",
      "SO",
      "PO No",
      "Department",
      "Current Due Date",
      "Original Due Date",
      "First Changed At",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.jobCardId,
          r.companySOId ?? "",
          r.poNo ?? "",
          r.departmentCode ?? "",
          r.currentDueDate ?? "",
          r.originalDueDate ?? "",
          r.firstChangedAt,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    // Trailing newline so the file ends cleanly; \r\n for Excel-friendly CSV.
    const body = lines.join("\r\n") + "\r\n";
    const fileStamp = generatedAt.slice(0, 19).replace(/[:T]/g, "-");
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="duedate-original-backup-${fileStamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return c.json({ generatedAt, count: rows.length, rows });
});

// ---------------------------------------------------------------------------
// GET /api/job-cards/completion-pic-original-backup[?dept=UPHOLSTERY]
//
// READ-ONLY recovery diagnosis. Companion to /duedate-original-backup, but for
// cleared COMPLETION DATES and PIC assignments (the cache/flicker + May-12
// data-loss family). Every dashboard clear writes a job_card_events row whose
// payload carries the OLD value:
//   COMPLETED_DATE_CLEARED → { from: <old date> }
//   PIC_CLEARED            → { slot: 'pic1'|'pic2', from: <old id>, fromName }
// We surface the LATEST clear per (job card × field) and flag it `recoverable`
// when the card's CURRENT value for that field is still blank — i.e. the clear
// was never superseded by a later legitimate edit, so it's safe to restore.
//
// MUTATES NOTHING — pure read/dump. Optional ?dept=UPHOLSTERY narrows to one
// department. Org-scoped through production_orders.orgId (job_card_events has
// no orgId column), exactly like /duedate-original-backup.
// ---------------------------------------------------------------------------
type ClearBackupRow = {
  jobCardId: string;
  eventType: string;
  payload: string;
  ts: string;
  actorName: string | null;
  companySOId: string | null;
  poNo: string | null;
  departmentCode: string | null;
  currentStatus: string | null;
  currentCompletedDate: string | null;
  currentPic1Id: string | null;
  currentPic1Name: string | null;
  currentPic2Id: string | null;
  currentPic2Name: string | null;
};

app.get("/completion-pic-original-backup", async (c) => {
  const denied = await requirePermission(c, "job-cards", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const db = c.var.DB;
  const dept = (c.req.query("dept") ?? "").toUpperCase(); // "" = all departments

  const sql = `
    SELECT
      e.jobCardId          AS job_card_id,
      e.eventType          AS event_type,
      e.payload            AS payload,
      e.ts                 AS ts,
      e.actorName          AS actor_name,
      po.companySOId       AS company_so_id,
      po.poNo              AS po_no,
      jc.departmentCode    AS department_code,
      jc.status            AS current_status,
      jc.completedDate     AS current_completed_date,
      jc.pic1Id            AS current_pic1_id,
      jc.pic1Name          AS current_pic1_name,
      jc.pic2Id            AS current_pic2_id,
      jc.pic2Name          AS current_pic2_name
    FROM job_card_events e
    JOIN production_orders po ON po.id = e.productionOrderId AND po.orgId = ?
    LEFT JOIN job_cards jc    ON jc.id = e.jobCardId
    WHERE e.eventType IN ('COMPLETED_DATE_CLEARED', 'PIC_CLEARED')
    ORDER BY e.jobCardId, e.ts ASC
  `;

  const res = await db.prepare(sql).bind(orgId).all<ClearBackupRow>();
  const raw = res.results ?? [];

  // Keep the LATEST clear per (job card × field). Rows are sorted ts ASC, so a
  // later clear naturally overwrites an earlier one in the map.
  const latest = new Map<
    string,
    {
      r: ClearBackupRow;
      field: "completedDate" | "pic1" | "pic2";
      oldValue: string;
      oldName: string | null;
    }
  >();
  for (const r of raw) {
    if (dept && (r.departmentCode ?? "").toUpperCase() !== dept) continue;
    const parsed = safeParseJson(r.payload) as
      | { from?: unknown; slot?: unknown; fromName?: unknown }
      | null;
    if (!parsed || typeof parsed !== "object") continue;
    const oldValue = parsed.from == null ? "" : String(parsed.from);
    if (oldValue === "") continue; // nothing to restore
    let field: "completedDate" | "pic1" | "pic2";
    let oldName: string | null = null;
    if (r.eventType === "COMPLETED_DATE_CLEARED") {
      field = "completedDate";
    } else {
      field = parsed.slot === "pic2" ? "pic2" : "pic1";
      oldName = parsed.fromName == null ? null : String(parsed.fromName);
    }
    latest.set(`${r.jobCardId}|${field}`, { r, field, oldValue, oldName });
  }

  const rows = Array.from(latest.values()).map(({ r, field, oldValue, oldName }) => {
    const currentValue =
      field === "completedDate"
        ? r.currentCompletedDate
        : field === "pic1"
          ? r.currentPic1Id
          : r.currentPic2Id;
    const currentName =
      field === "pic1"
        ? r.currentPic1Name
        : field === "pic2"
          ? r.currentPic2Name
          : null;
    const recoverable = currentValue == null || currentValue === "";
    return {
      jobCardId: r.jobCardId,
      companySOId: r.companySOId ?? null,
      poNo: r.poNo ?? null,
      departmentCode: r.departmentCode ?? null,
      field,
      oldValue,
      oldName,
      currentValue: currentValue ?? null,
      currentName,
      currentStatus: r.currentStatus ?? null,
      clearedAt: r.ts,
      actor: r.actorName ?? null,
      recoverable,
    };
  });
  rows.sort((a, b) => (a.companySOId ?? "").localeCompare(b.companySOId ?? ""));

  return c.json({
    success: true,
    generatedAt: new Date().toISOString(),
    dept: dept || "ALL",
    total: rows.length,
    recoverable: rows.filter((x) => x.recoverable).length,
    rows,
  });
});

// Quote a CSV cell only when needed (comma, quote, CR or LF), doubling any
// embedded quotes per RFC 4180. Keeps simple values unquoted for readability.
function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default app;
