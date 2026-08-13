// ---------------------------------------------------------------------------
// D1-backed production-orders route.
//
// Mirrors the old src/api/routes/production-orders.ts response shape so the
// SPA frontend does not need any changes. `jobCards` is returned as a nested
// array joined from job_cards; each job card's `piecePics` is joined from
// piece_pics.
//
// Phase-4A scope: base CRUD (list/get/update/patch), /stock PO creation,
// /historical-wips + /historical-fgs aggregates, and the /scan-complete FIFO
// routing + piece-pic binding. Multi-table writes are batched.
//
// Deferred to later phases:
//   - TODO(phase-5): FIFO raw-material consumption on PO completion
//     (fg_batches/rm_batches/cost_ledger are present in schema but the
//     lookup helpers in src/lib/costing haven't been ported yet).
//     `src/lib/material-lookup` was also named here; it read the in-memory
//     mock-data fixtures, had no importer, and was deleted in
//     chore/dead-code-sweep — do not resurrect it for this.
//   - ~~TODO(phase-5): jobCard/PO override persistence~~ — CLOSED. The
//     `job-card-persistence.ts` overlay was deleted in chore/dead-code-sweep:
//     it overlaid the in-memory mock-data arrays, and the "in-memory route"
//     this note said still called it has not existed since the move to
//     Supabase Postgres. DB writes are durable; there is nothing to overlay.
//
// JSON columns: none on production_orders/job_cards themselves. piece_pics is
// its own table in the schema.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { postProductionOrderCompletion } from "../lib/fg-completion";
import { postJobCardLabor } from "../lib/po-cost-cascade";
import { resolveWorkerToken } from "./worker-auth";
import { workerCoversDept } from "../../lib/worker";
import { requirePermission } from "../lib/rbac";
import { salesOrderScopeSql, isCustomerScoped } from "../lib/customer-scope";
import {
  ensureJobCardQrTokenColumn,
  getOrCreateJobCardQrToken,
} from "../lib/jobcard-qr-token";
import { pickPackingCard } from "../lib/packing-card-resolve";
import { getOrgId } from "../lib/tenant";
import {
  poListCacheVersion,
  bumpPoListCacheVersion,
} from "../lib/po-list-cache";
import { DEPT_ORDER } from "../lib/lead-times";
import {
  validateFabricCodes,
  unknownFabricCodeError,
} from "../lib/fabric-validation";
// Helpers extracted to ./production-orders/_helpers (behaviour-preserving split).
import {
  PO_LIST_BODY_TTL_S,
  applyPoStatusChange,
  applyPoUpdate,
  applyWipInventoryChange,
  attachCustomerSO,
  buildPoListBodyKey,
  buildPoListCacheKey,
  cascadePoCompletionToCO,
  cascadePoCompletionToSO,
  cascadeUpholsteryToCO,
  cascadeUpholsteryToSO,
  ensurePendingMigrations,
  ensurePiecePicsForJc,
  fetchAllPOs,
  fetchFilteredPOs,
  fetchFreshMinimalPO,
  fetchPO,
  fetchPaginatedPOs,
  fireAndForgetSyncJc,
  genItemId,
  genJcId,
  genPoId,
  genSoId,
  invalidateProductionCachesAfterScan,
  nextSOHNumber,
  recomputePoStatusAndProgress,
  scanOrgId,
  scheduleFireAndForget,
  schedulePoListBodyRefresh,
  slimJobCardsToPlanningLite,
} from "./production-orders/_helpers";
import type {
  JobCardRow,
  OverdueBreakdownRow,
  OverduePoRow,
  PiecePicRow,
  ProductionOrderRow,
} from "./production-orders/_helpers";

// ---------------------------------------------------------------------------
// overdue-counts snapshot key — ONE definition, used by the route AND the warm
// cron. Attempt 1 at warming the dept sheets (be17d4b4) shipped a key the page
// never requested and warmed a snapshot nobody read; it was reverted. The only
// way that cannot recur is for both sides to call the same function.
//
// NOTE the timezone: this key uses UTC (new Date().toISOString()), NOT the
// MYT-shifted day the dept SHEET key uses. Different endpoints, different
// existing behaviour - deliberately preserved rather than "harmonised", since
// changing it here would silently orphan every stored snapshot row.
// ---------------------------------------------------------------------------
export function overdueTodayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
export function overdueCountsCacheKey(
  dept: string | null,
  today: string,
): string {
  return `v3&dept=${dept ?? ""}&today=${today}`;
}

const app = new Hono<Env>();
// ---------------------------------------------------------------------------
// The overdue-counts computation, callable directly.
//
// The warm cron used to reach this through app.request("/overdue-counts"), so
// that the payload and the cache key could not drift from what the page reads.
// Sound idea, broken in practice: a synthetic sub-request gets a FRESH Hono
// context whose c.var is empty — the DB binding is attached by middleware on
// the parent app, not on this router — so every warm call threw and came back
// 500. It had never warmed a single key (measured 2026-08-02: overview:500,
// FAB_CUT:500, … all ten), which is why the endpoint still sat at p50 ~8s and
// p95 30s (the client abort) after the warmer shipped.
//
// Extracting it keeps the original guarantee — ONE body, ONE cache key, used
// by both the route and the cron — while the cron passes the real context it
// already holds and names the department as an argument rather than faking a
// query string onto a synthetic request.
// ---------------------------------------------------------------------------
export async function computeOverdueCounts(
  c: Context<Env>,
  /** Department, or null for the Overview variant. */
  deptArg: string | null,
  /**
   * Tenant. The route resolves it from the session; the warm cron has NO
   * session (it authenticates with CRON_SECRET), so getOrgId throws
   * "orgId not resolved on request context" there and every warm call dies.
   * That was the SECOND cause behind the ten 500s — the cron passes
   * DEFAULT_ORG_ID explicitly, exactly as the other warmers already do.
   */
  orgIdArg?: string,
): Promise<unknown> {
  const orgId = orgIdArg ?? getOrgId(c);
  const dept =
    deptArg && deptArg.trim().length > 0 ? deptArg.trim().toUpperCase() : null;
  const today = overdueTodayUtc();

  // PR 7 — cache-aside snapshot. cache_key encodes both the dept
  // filter AND today's date — overdue counts are inherently
  // today-relative so the snapshot must roll forward at the day
  // boundary (a PO that became overdue at midnight yesterday should
  // start counting overdue today, even if no source row changed).
  // v2 bump (2026-06-12): overdue now means bedframe-by-PIECE + per-piece
  // ship-exclusion, so the cached payload's SHAPE/MEANING changed. Bumping the
  // cache_key version sidesteps every pre-existing snapshot row (old
  // bedframe-by-SO counts) cleanly instead of serving stale numbers until they
  // expire — the old rows simply go unread and age out via the nightly wipe.
  // v3 bump (2026-06-23): payload now also carries overdueBedframePoIds /
  // overdueSofaPoIds (the PO-id sets the Overview grid filters on). That is a
  // SHAPE change, so bump again — without this the new code reads the existing
  // v2 snapshot rows, which lack the id arrays, and the grid filters to 0.
  const cacheKey = overdueCountsCacheKey(dept, today);
  const { withSnapshot } = await import("../lib/snapshot");
  const result = await withSnapshot(
    c.var.DB,
    {
      tableName: "production_overdue_snapshot",
      // sales_orders added 2026-06-10: the Overview overdue branch now reads
      // sales_orders.hookkaExpectedDD, so an operator editing the SO "Our
      // Expected DD" must roll this snapshot forward (the freshness probe
      // compares MAX(updated_at) across these tables; the SO PUT bumps
      // sales_orders.updated_at).
      // delivery_orders + delivery_order_items added 2026-06-12: overdue now
      // excludes pieces already on a dispatched/delivered DO, so dispatching or
      // delivering a piece must roll the count forward. delivery_orders carries
      // updated_at (the status-transition UPDATEs bump it), which drives the
      // freshness probe; delivery_order_items has no timestamp column so the
      // probe silently skips it (nightly rebuild covers any item-only edit) —
      // it's listed for intent/documentation.
      sourceTables: [
        "production_orders",
        "job_cards",
        "sales_orders",
        "delivery_orders",
        "delivery_order_items",
      ],
    },
    orgId,
    async () => {
  // One SQL per request; the slim row list (~800 max) is aggregated in JS.
  // Per-PO `earliestOverdue` is computed via the same predicate the FE used
  // to apply locally — overview branch is anchored on the SO "Our Expected DD"
  // (sales_orders.hookkaExpectedDD) and gated on UPHOLSTERY-JC openness; dept
  // branch is the MIN(jc.dueDate) across that dept's still-open JCs that have
  // already passed today.
  let rows: OverduePoRow[];
  const ocScope = await salesOrderScopeSql(c, "po.salesOrderId", "po.consignmentOrderId");
  const ocClause = ocScope.clause ? ` AND ${ocScope.clause}` : "";
  if (dept === null) {
    // Overview overdue now keys off the PO's SO "Our Expected DD"
    // (sales_orders.hookkaExpectedDD) — the date the operator reads in the
    // Overview cell — NOT the internal targetEndDate (2026-06-10). A PO is
    // overdue when that DD has passed AND its UPHOLSTERY JC is still open.
    // NULLIF(...,'') folds an empty stored DD into NULL; a NULL/'' DD or a
    // CO-origin PO (NULL salesOrderId → subquery yields NULL) can't be late
    // against a date it doesn't have, so earliest_overdue stays NULL. The
    // surfaced earliest date is the SO DD itself (what the operator sees).
    const stmt = c.var.DB.prepare(
      `SELECT po.id,
              po.companySOId,
              po.salesOrderId,
              po.companyCOId,
              po.consignmentOrderId,
              po.customerName,
              po.itemCategory,
              po.status AS po_status,
              CASE
                WHEN po.status NOT IN ('COMPLETED','CANCELLED')
                  AND NULLIF((SELECT so.hookkaExpectedDD FROM sales_orders so
                              WHERE so.id = po.salesOrderId), '') IS NOT NULL
                  AND NULLIF((SELECT so.hookkaExpectedDD FROM sales_orders so
                              WHERE so.id = po.salesOrderId), '') < ?
                  AND EXISTS (
                    SELECT 1 FROM job_cards jc
                    WHERE jc.productionOrderId = po.id
                      AND jc.departmentCode = 'UPHOLSTERY'
                      AND jc.status NOT IN ('COMPLETED','TRANSFERRED')
                  )
                  -- Per-piece ship-exclusion (2026-06-12): a partially
                  -- invoiced/delivered SO can have its SO-level status say
                  -- INVOICED while THIS specific piece is still in the
                  -- factory. So we exclude by the PO's OWN delivery linkage,
                  -- not by SO status — only drop the piece when it actually
                  -- rides a dispatched/delivered DO.
                  AND NOT EXISTS (
                    SELECT 1 FROM delivery_order_items di
                    JOIN delivery_orders d ON d.id = di.deliveryOrderId
                    WHERE di.productionOrderId = po.id
                      AND d.status IN ('LOADED','IN_TRANSIT','DELIVERED','INVOICED')
                  )
                THEN NULLIF((SELECT so.hookkaExpectedDD FROM sales_orders so
                              WHERE so.id = po.salesOrderId), '')
                ELSE NULL
              END AS earliest_overdue
         FROM production_orders po
        WHERE po.orgId = ?${ocClause}`,
    ).bind(today, orgId, ...ocScope.binds);
    const res = await stmt.all<OverduePoRow>();
    rows = res.results ?? [];
  } else {
    const stmt = c.var.DB.prepare(
      `SELECT po.id,
              po.companySOId,
              po.salesOrderId,
              po.companyCOId,
              po.consignmentOrderId,
              po.customerName,
              po.itemCategory,
              po.status AS po_status,
              (SELECT MIN(jc.dueDate)
                 FROM job_cards jc
                WHERE jc.productionOrderId = po.id
                  AND jc.departmentCode = ?
                  AND jc.dueDate IS NOT NULL
                  AND jc.dueDate < ?
                  AND jc.status NOT IN ('COMPLETED','TRANSFERRED')) AS earliest_overdue
         FROM production_orders po
        WHERE po.orgId = ?
          AND po.status NOT IN ('COMPLETED','CANCELLED')
          -- Same per-piece ship-exclusion as the Overview branch (2026-06-12):
          -- a piece already riding a dispatched/delivered DO is out of the
          -- factory and must not count overdue, even if its dept JC is still
          -- open. Checked by the PO's own delivery linkage, not SO status.
          AND NOT EXISTS (
            SELECT 1 FROM delivery_order_items di
            JOIN delivery_orders d ON d.id = di.deliveryOrderId
            WHERE di.productionOrderId = po.id
              AND d.status IN ('LOADED','IN_TRANSIT','DELIVERED','INVOICED')
          )${ocClause}`,
    ).bind(dept, today, orgId, ...ocScope.binds);
    const res = await stmt.all<OverduePoRow>();
    rows = res.results ?? [];
  }

  // Aggregate by SO group. totalPos counts non-CANCELLED POs in the group;
  // overduePos / earliest / overdueCategories track only the overdue subset.
  // Mirrors src/pages/production/index.tsx:1277-1326.
  type Entry = Omit<OverdueBreakdownRow, "overdueCategories"> & {
    overdueCategories: Set<string>;
  };
  const byso = new Map<string, Entry>();
  for (const po of rows) {
    if (po.poStatus === "CANCELLED") continue;
    const groupId =
      po.companySOId ||
      po.salesOrderId ||
      po.companyCOId ||
      po.consignmentOrderId ||
      "";
    if (!groupId) continue;
    let entry = byso.get(groupId);
    if (!entry) {
      entry = {
        soId: groupId,
        displaySoId: po.companySOId || po.companyCOId || groupId,
        customer: po.customerName || "",
        totalPos: 0,
        overduePos: 0,
        earliest: "",
        poStatus: po.poStatus,
        salesOrderId: po.salesOrderId || "",
        overdueCategories: new Set<string>(),
      };
      byso.set(groupId, entry);
    }
    entry.totalPos += 1;
    if (!entry.salesOrderId && po.salesOrderId) entry.salesOrderId = po.salesOrderId;
    const eo = po.earliestOverdue;
    if (eo) {
      entry.overduePos += 1;
      if (po.itemCategory) entry.overdueCategories.add(po.itemCategory);
      if (!entry.earliest || eo < entry.earliest) entry.earliest = eo;
    }
  }

  const breakdown: OverdueBreakdownRow[] = Array.from(byso.values())
    .filter((r) => r.overduePos > 0)
    .map((r) => ({ ...r, overdueCategories: Array.from(r.overdueCategories) }))
    .sort((a, b) => {
      if (!a.earliest && !b.earliest) return 0;
      if (!a.earliest) return 1;
      if (!b.earliest) return -1;
      return a.earliest.localeCompare(b.earliest);
    });

  // Counts use DIFFERENT units, per the owner's verified rule (2026-06-12):
  //   • BEDFRAME = overdue PIECES — bedframes are sold per SKU/piece, so each
  //     overdue bedframe PO counts 1. Taken from the raw per-PO `rows` (an
  //     overdue PO has `earliestOverdue` set; CANCELLED guarded the same way
  //     the by-SO grouping skips them).
  //   • SOFA = overdue SETS = distinct SOs with >=1 overdue sofa piece. A sofa
  //     set's -01/-02/-03 pieces share one SO, so the existing by-SO count is
  //     the set count — kept as-is.
  const bedframeCount = rows.filter(
    (r) =>
      r.poStatus !== "CANCELLED" &&
      r.itemCategory === "BEDFRAME" &&
      !!r.earliestOverdue,
  ).length;
  const sofaCount = breakdown.filter((r) =>
    r.overdueCategories.includes("SOFA"),
  ).length;

  // PO-id sets per category — lets the Production Overview grid filter to
  // EXACTLY the overdue work the chips count, reusing this endpoint's overdue
  // set (same isOverduePO rule + per-piece ship-exclusion) so the filtered
  // rows can never drift from the chip numbers. BEDFRAME ids = the overdue
  // bedframe pieces (1 PO = 1 piece, so this matches bedframeCount exactly).
  // SOFA ids = every overdue sofa PIECE (PO) that makes up the overdue sets;
  // the chip counts SETS (distinct SOs) but the per-PO grid renders the
  // constituent overdue pieces, which is the actual work to action.
  const overdueBedframePoIds = rows
    .filter(
      (r) =>
        r.poStatus !== "CANCELLED" &&
        r.itemCategory === "BEDFRAME" &&
        !!r.earliestOverdue,
    )
    .map((r) => r.id);
  const overdueSofaPoIds = rows
    .filter(
      (r) =>
        r.poStatus !== "CANCELLED" &&
        r.itemCategory === "SOFA" &&
        !!r.earliestOverdue,
    )
    .map((r) => r.id);

      return {
        data: {
          bedframeCount,
          sofaCount,
          breakdown,
          overdueBedframePoIds,
          overdueSofaPoIds,
        },
      };
    },
    cacheKey,
  );
  return result;
}

app.get("/overdue-counts", async (c) => {
  // An aggregate, so nothing downstream can narrow it — the badge would keep
  // counting other people's overdue orders.
  const result = await computeOverdueCounts(c, c.req.query("dept") ?? null);
  return c.json({ success: true, ...(result as object) });
});


// ---------------------------------------------------------------------------
// GET /api/production-orders/tracker-summary
//
// The Master Tracker and Planning pages are dashboards (owner, 2026-08-13:
// "基本上都是 Dashboard 的作用来的"). They were each pulling EVERY production
// order with EVERY job card just to count things in the browser:
//   ?fields=minimal&include=jobCards            -> 30,721ms then ABORTED (the
//     page never loaded — api-client's 30s cap killed it)
//   ?fields=minimal&include=jobCards-lite&...   -> 13,315ms / 4.27 MB
// Counting in SQL returns the same numbers in one small payload.
//
// DELIBERATELY OMITS actual-hours and efficiency. This comment has now been
// wrong TWICE, so here is the whole chain — the conclusion is stable, the
// reasoning took three passes to get right:
//
//   v1 "actualMinutes is NULL on every job card"  — WRONG. Generalised from a
//      5-order sample that happened to be all-NULL.
//   v2 "4,340 of 36,796 are non-null, so the factory DOES measure"  — the count
//      is right, the inference is WRONG.
//   v3 (this one) every one of the 4,289 non-zero values is BYTE-IDENTICAL to
//      that same card's estMinutes, with zero exceptions, all on orders started
//      2026-04/05. It is a COPY of the standard time, not a measurement.
//
// So there is still no trustworthy measured duration anywhere in job_cards —
// but the reason is "the column was populated by copying the estimate", not
// "the column is empty". Counting a column is not the same as checking whether
// its values mean anything: check the DISTRIBUTION, not just the NULL rate.
//
// Consequences that follow: `productionTimeMinutes` is likewise not a
// substitute (it also equals estMinutes on every row), and any UI computing
// `(actualMinutes || estMinutes)` divides the estimate by itself and prints
// exactly 100% forever — which is what the retired tracker.tsx did.
//
// This endpoint therefore stays counts-and-dates. An efficiency figure belongs
// only where its denominator is independently measured — /api/department-
// performance divides by real clocked time from working_hour_entries, and its
// output genuinely varies (80% overall, 64% one day, 48% one worker).
// See docs/BUG-HISTORY.md BUG-2026-08-13-004 / -005.
// ---------------------------------------------------------------------------
app.get("/tracker-summary", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;
  const today = new Date().toISOString().slice(0, 10);
  // Throughput window: 14 days back, inclusive of today.
  const since = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);

  const [statusRows, overdueRow, deptRows, throughputRows] = await Promise.all([
    db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM production_orders
          WHERE orgId = ? GROUP BY status`,
      )
      .bind(orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM production_orders
          WHERE orgId = ?
            AND status NOT IN ('COMPLETED','TRANSFERRED','CANCELLED')
            AND targetEndDate IS NOT NULL AND targetEndDate <> ''
            AND targetEndDate < ?`,
      )
      .bind(orgId, today)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT jc.departmentCode AS dept,
                SUM(CASE WHEN jc.status IN ('IN_PROGRESS','PAUSED') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN jc.status IN ('COMPLETED','TRANSFERRED') THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN jc.status NOT IN ('IN_PROGRESS','PAUSED','COMPLETED','TRANSFERRED') THEN 1 ELSE 0 END) AS pending,
                COUNT(*) AS total
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.orgId = ?
          GROUP BY jc.departmentCode`,
      )
      .bind(orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT jc.completedDate AS d, COUNT(*) AS n
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.orgId = ?
            AND jc.completedDate IS NOT NULL AND jc.completedDate <> ''
            AND jc.completedDate >= ?
          GROUP BY jc.completedDate
          ORDER BY d`,
      )
      .bind(orgId, since)
      .all<Record<string, unknown>>(),
  ]);

  // Dual-keyed reads — the pg shim camelCases columns, but never assume it.
  const num = (r: Record<string, unknown> | null, k: string) => Number(r?.[k] ?? 0) || 0;
  const statusCounts: Record<string, number> = {};
  for (const r of statusRows.results ?? []) {
    const s = String(r.status ?? "");
    if (s) statusCounts[s] = num(r, "n");
  }
  return c.json({
    success: true,
    statusCounts,
    totalOrders: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    overdue: num(overdueRow, "n"),
    byDepartment: (deptRows.results ?? []).map((r) => ({
      departmentCode: String(r.dept ?? r.departmentCode ?? ""),
      active: num(r, "active"),
      completed: num(r, "completed"),
      pending: num(r, "pending"),
      total: num(r, "total"),
    })),
    throughput: (throughputRows.results ?? []).map((r) => ({
      date: String(r.d ?? r.completedDate ?? ""),
      completed: num(r, "n"),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/report-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Everything Reports › Production renders, aggregated in SQL over a `startDate`
// window. The page used to fetch **bare** `/api/production-orders` — every PO in
// the org WITH every job card — and add it up in the browser: measured 30,012 ms
// on prod 2026-08-13 and then killed by api-client's 30 s global abort
// (`API_TIMEOUT_MS`), so the report rendered an EMPTY Department Efficiency table
// captioned "No data available" over a request that had died. Same family as
// BUG-2026-08-13-001 / -002 / -003.
//
// The Department Efficiency arithmetic here is BUG-2026-08-13-004's rule moved
// verbatim into SQL: a completed card is credited to the ratio ONLY when it
// recorded a duration, and then it contributes to BOTH sides. There is no
// `actualMinutes -> estMinutes` fallback anywhere in this query, because that is
// exactly what pinned every department at ~100%.
//
// `measuredDistinctCards` is the one thing the client could not see. On prod
// 2026-08-13 all 4,289 non-zero `actualMinutes` values are byte-identical to
// that card's own `estMinutes` (4,289 of 4,289) — the column is populated, but
// with a COPY of the standard time, not with a measurement. A ratio built from
// those is 100.0% by construction. This counts the cards where the two genuinely
// differ so the page can refuse to publish a percentage that only looks measured.
// ---------------------------------------------------------------------------
app.get("/report-summary", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;

  const today = new Date().toISOString().slice(0, 10);
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fromRaw = (c.req.query("from") || "").trim();
  const toRaw = (c.req.query("to") || "").trim();
  if (!isDate(fromRaw) || !isDate(toRaw)) {
    return c.json(
      {
        success: false,
        error:
          "from and to are required and must be YYYY-MM-DD — this report is a windowed aggregate, never a whole-org scan.",
      },
      400,
    );
  }
  // Refuse an inverted range rather than silently returning zero rows, which
  // would look exactly like "nothing happened".
  const from = fromRaw <= toRaw ? fromRaw : toRaw;
  const to = fromRaw <= toRaw ? toRaw : fromRaw;

  const [statusRows, completedRows, deptRows, overdueRows] = await Promise.all([
    db
      .prepare(
        `SELECT status, COUNT(*) AS n
           FROM production_orders
          WHERE orgId = ? AND startDate >= ? AND startDate <= ?
          GROUP BY status`,
      )
      .bind(orgId, from, to)
      .all<Record<string, unknown>>(),
    // Only the two dates the average needs — at most a few hundred short
    // strings. Kept in JS because date arithmetic is the one thing that does
    // NOT port cleanly between Postgres and the node:sqlite test mocks.
    db
      .prepare(
        `SELECT startDate, completedDate
           FROM production_orders
          WHERE orgId = ? AND startDate >= ? AND startDate <= ?
            AND status = 'COMPLETED'
            AND completedDate IS NOT NULL AND completedDate <> ''`,
      )
      .bind(orgId, from, to)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT jc.departmentCode AS dept,
                MAX(jc.departmentName) AS dept_name,
                SUM(CASE WHEN jc.status = 'COMPLETED' THEN 1 ELSE 0 END)
                  AS completed_cards,
                SUM(CASE WHEN jc.status = 'COMPLETED'
                         THEN COALESCE(jc.estMinutes, 0) ELSE 0 END)
                  AS std_minutes,
                SUM(CASE WHEN jc.status = 'COMPLETED'
                          AND COALESCE(jc.actualMinutes, 0) > 0
                         THEN 1 ELSE 0 END)
                  AS measured_cards,
                SUM(CASE WHEN jc.status = 'COMPLETED'
                          AND COALESCE(jc.actualMinutes, 0) > 0
                         THEN COALESCE(jc.estMinutes, 0) ELSE 0 END)
                  AS measured_std_minutes,
                SUM(CASE WHEN jc.status = 'COMPLETED'
                          AND COALESCE(jc.actualMinutes, 0) > 0
                         THEN COALESCE(jc.actualMinutes, 0) ELSE 0 END)
                  AS measured_actual_minutes,
                SUM(CASE WHEN jc.status = 'COMPLETED'
                          AND COALESCE(jc.actualMinutes, 0) > 0
                          AND COALESCE(jc.actualMinutes, 0)
                              <> COALESCE(jc.estMinutes, 0)
                         THEN 1 ELSE 0 END)
                  AS measured_distinct_cards
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.orgId = ? AND po.startDate >= ? AND po.startDate <= ?
          GROUP BY jc.departmentCode`,
      )
      .bind(orgId, from, to)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT poNo, productName, targetEndDate, currentDepartment
           FROM production_orders
          WHERE orgId = ? AND startDate >= ? AND startDate <= ?
            AND status NOT IN ('COMPLETED','CANCELLED')
            AND targetEndDate IS NOT NULL AND targetEndDate <> ''
            AND targetEndDate < ?
          ORDER BY targetEndDate ASC`,
      )
      .bind(orgId, from, to, today)
      .all<Record<string, unknown>>(),
  ]);

  const num = (r: Record<string, unknown> | null, ...keys: string[]) => {
    for (const k of keys) {
      const v = r?.[k];
      if (v !== null && v !== undefined) return Number(v) || 0;
    }
    return 0;
  };
  const str = (r: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) {
      const v = r[k];
      if (v !== null && v !== undefined && String(v) !== "") return String(v);
    }
    return "";
  };

  const statusCounts: Record<string, number> = {};
  for (const r of statusRows.results ?? []) {
    const s = String(r.status ?? "");
    if (s) statusCounts[s] = num(r, "n");
  }
  const totalOrders = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  const completed = completedRows.results ?? [];
  let dayTotal = 0;
  let dayCount = 0;
  for (const r of completed) {
    const start = Date.parse(str(r, "startDate", "startdate"));
    const end = Date.parse(str(r, "completedDate", "completeddate"));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    dayTotal += (end - start) / 86400000;
    dayCount += 1;
  }

  const todayMs = Date.parse(today);
  return c.json({
    success: true,
    range: { from, to },
    totals: {
      totalOrders,
      completed: statusCounts.COMPLETED ?? 0,
      inProgress: statusCounts.IN_PROGRESS ?? 0,
      avgCompletionDays: dayCount > 0 ? dayTotal / dayCount : null,
      completedWithDates: dayCount,
    },
    statusCounts,
    departments: (deptRows.results ?? []).map((r) => ({
      departmentCode: str(r, "dept"),
      departmentName: str(r, "deptName", "dept_name") || str(r, "dept"),
      // Aliases are snake_case in the SQL (an unquoted mixed-case alias folds
      // to lower case in Postgres and reads back undefined —
      // tests/sql-identifier-safety.test.mjs). postgres.toCamel restores the
      // camel form on read; both spellings are accepted so the node:sqlite
      // mocks in tests, which do no such rewrite, read the same rows.
      completedCards: num(r, "completedCards", "completed_cards"),
      stdMinutes: num(r, "stdMinutes", "std_minutes"),
      measuredCards: num(r, "measuredCards", "measured_cards"),
      measuredStdMinutes: num(r, "measuredStdMinutes", "measured_std_minutes"),
      measuredActualMinutes: num(
        r,
        "measuredActualMinutes",
        "measured_actual_minutes",
      ),
      measuredDistinctCards: num(
        r,
        "measuredDistinctCards",
        "measured_distinct_cards",
      ),
    })),
    overdue: (overdueRows.results ?? []).map((r) => {
      const due = Date.parse(str(r, "targetEndDate", "targetenddate"));
      return {
        poNo: str(r, "poNo", "pono"),
        productName: str(r, "productName", "productname"),
        currentDepartment: str(r, "currentDepartment", "currentdepartment"),
        targetEndDate: str(r, "targetEndDate", "targetenddate"),
        daysOverdue:
          Number.isFinite(due) && Number.isFinite(todayMs)
            ? Math.round((todayMs - due) / 86400000)
            : 0,
      };
    }),
  });
});

app.get("/", async (c) => {
  const statusParam = c.req.query("status");
  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;

  const includeParam = c.req.query("include");
  // Backward compat: if `include` is not passed at all, inline jobCards.
  // If it IS passed, only include jobCards when the list contains "jobCards".
  const includeList =
    includeParam === undefined
      ? null
      : includeParam.split(",").map((s) => s.trim());
  // "jobCards-lite" (Planning) also needs the job_cards join — it just ships a
  // slimmer per-card shape (slimJobCardsToPlanningLite). So both include tokens
  // turn the JC fetch on; jobCardsLite selects the slim projection afterwards.
  const includeJobCards =
    includeList === null
      ? true
      : includeList.includes("jobCards") ||
        includeList.includes("jobCards-lite");
  const jobCardsLite =
    includeList !== null && includeList.includes("jobCards-lite");

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const includeArchive = c.req.query("includeArchive") === "true";
  // Owner 2026-08-05: production orders narrow with their sales order.
  const poCustomerScope = await salesOrderScopeSql(c, "salesOrderId");
  // Opt-in slim payload for the Production page: drops ~20 unused PO fields
  // and the whole piece_pics tree. Default stays full-response for backward
  // compat (the PO detail page + other consumers need the full shape).
  const minimal = c.req.query("fields") === "minimal";
  // Phase 4: when true, drop COMPLETED / TRANSFERRED / CANCELLED PO status
  // rows server-side. The Production page passes this on dept tabs because
  // its column filter already hides those statuses by default — shipping
  // them just to hide them client-side wastes ~60% of the wire payload.
  const excludeCompleted = c.req.query("excludeCompleted") === "true";
  // Opt-in dept-narrowing: when present, each PO's jobCards array is
  // filtered at SQL level to only the given dept code. Used by the
  // per-department pages (/production/fab-cut etc.) so they never ship
  // the other 7 depts' JC rows.
  const deptParamRaw = c.req.query("dept");
  const deptFilter =
    deptParamRaw && deptParamRaw.trim().length > 0
      ? deptParamRaw.trim().toUpperCase()
      : null;

  // Server-side itemCategory filter (BEDFRAME / SOFA / ACCESSORY). Mirrors
  // the dept normalisation above: trim + uppercase, null when empty.
  // Replaces the prior client-side .filter() pass on the Production page.
  const catParamRaw = c.req.query("cat");
  const catFilter =
    catParamRaw && catParamRaw.trim().length > 0
      ? catParamRaw.trim().toUpperCase()
      : null;

  // Server-side targetEndDate window. Both bounds are optional; either or
  // both can be supplied. NULL targetEndDate rows are preserved on both
  // sides so undated POs aren't silently hidden — matches the client-side
  // filter at production/index.tsx:1188-1189.
  const dueFrom = c.req.query("dueFrom") || null;
  const dueTo = c.req.query("dueTo") || null;

  // Sticker-print scope: a CSV of order identifiers — internal id, poNo,
  // companySOId, salesOrderId, companyCOId, or consignmentOrderId. When
  // present, only orders matching ANY token come back, so the Fab Sew / Foam
  // sticker loaders fetch the few visible orders (+ their SO/CO group siblings)
  // instead of the whole org. Bypasses the list caches below — these are
  // targeted, always-fresh reads, not the shared grid payload. 2026-06-24.
  const scopeRaw = c.req.query("scope");
  const scopeTokens = scopeRaw
    ? scopeRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : null;

  const orgId = getOrgId(c);

  // The list read can trigger a cold recompute whose SO/CO join SELECTs
  // hold_reason/held_by/held_at; ensure those columns exist FIRST so a DB that
  // hasn't seen an SO/CO write since the ON HOLD deploy doesn't 500 with
  // "column hold_reason does not exist" (BUG-2026-06-24-008). Memoized — cheap.
  await ensurePendingMigrations(c.var.DB);

  // Scoped sticker-print fetch — bypass the KV + snapshot caches (these are
  // targeted, always-fresh reads driven by which rows are on screen, NOT the
  // shared grid payload, and each scope set is one-shot so caching is pointless
  // and risks stale stickers). Pull only the matching orders and return. 2026-06-24.
  if (scopeTokens && scopeTokens.length > 0) {
    const data = await fetchFilteredPOs(
      c.var.DB,
      orgId,
      statuses,
      includeJobCards,
      includeArchive,
      minimal,
      deptFilter,
      dueFrom,
      dueTo,
      catFilter,
      excludeCompleted,
      scopeTokens,
      poCustomerScope,
    );
    await attachCustomerSO(
      c.var.DB,
      data as Array<{
        salesOrderId: string;
        consignmentOrderId: string;
        customerSO: string;
      }>,
    );
    return c.json({ success: true, data, total: data.length });
  }

  // Builds the full non-paginated list payload through the snapshot layer.
  // `swr` selects serve-stale-while-revalidate: true on the user-facing path
  // (a stale snapshot returns instantly, refresh runs in background); false
  // on the KV background refresh (already off the request path — wait for
  // fresh data so the stored body is current, and skip the version bump).
  const buildListPayload = async (swr: boolean) => {
    // The snapshot is keyed by org + query string, not by user, so a scoped
    // payload must never enter it — one salesperson's narrowed list would be
    // served to the whole factory. Few enough scoped users to just compute.
    if (isCustomerScoped(c)) {
      const data = await fetchFilteredPOs(
        c.var.DB, orgId, statuses, includeJobCards, includeArchive, minimal,
        deptFilter, dueFrom, dueTo, catFilter, excludeCompleted, null,
        poCustomerScope,
      );
      await attachCustomerSO(
        c.var.DB,
        data as Array<{ salesOrderId: string; consignmentOrderId: string; customerSO: string }>,
      );
      return { success: true as const, data: data as unknown[], total: data.length };
    }
    const { withSnapshot } = await import("../lib/snapshot");
    const snapshotCacheKey =
      new URL(c.req.url).searchParams.toString().split("&").sort().join("&");
    return withSnapshot<{
      success: true;
      data: unknown[];
      total: number;
    }>(
      c.var.DB,
      {
        tableName: "production_orders_list_snapshot",
        sourceTables: ["production_orders", "job_cards", "sales_orders", "consignment_orders"],
      },
      orgId,
      async () => {
        const data = await fetchFilteredPOs(
          c.var.DB,
          orgId,
          statuses,
          includeJobCards,
          includeArchive,
          minimal,
          deptFilter,
          dueFrom,
          dueTo,
          catFilter,
          excludeCompleted,
          null,
          poCustomerScope,
        );
        await attachCustomerSO(
          c.var.DB,
          data as Array<{
            salesOrderId: string;
            consignmentOrderId: string;
            customerSO: string;
          }>,
        );
        // Planning's include=jobCards-lite → slim each JC to its 12 read fields
        // BEFORE the snapshot stores the body (so the cached body is already the
        // slim shape). Only touches the lite request; the full include=jobCards
        // path is byte-identical.
        if (jobCardsLite) slimJobCardsToPlanningLite(data);
        return { success: true, data, total: data.length };
      },
      snapshotCacheKey,
      c,
      swr
        ? {
            // Serve-stale-while-revalidate: a stale dept sheet is returned
            // instantly (no ~2-3s recompute wait) and refreshed in the
            // background. onRevalidated bumps this endpoint's KV version when
            // the refresh lands so the edge cache stops serving the stale body
            // it cached during the SWR window.
            staleWhileRevalidate: true,
            onRevalidated: () => bumpPoListCacheVersion(c, orgId),
          }
        : undefined,
    );
  };

  // Cache check. Non-paginated list: stable body key + version-in-metadata so
  // a version mismatch serves the previous body instantly (X-Cache: STALE)
  // and refreshes in the background — see the buildPoListBodyKey comment.
  // Paginated path keeps the original versioned-key behaviour.
  const kvCache = c.env.SESSION_CACHE;
  let cacheKeyForWrite: string | null = null;
  let bodyKeyForWrite: string | null = null;
  let versionAtRead: string | null = null;
  if (kvCache) {
    const version = await poListCacheVersion(c, orgId);
    versionAtRead = version;
    if (!paginate) {
      const bodyKey = buildPoListBodyKey(orgId, new URL(c.req.url));
      bodyKeyForWrite = bodyKey;
      try {
        const got = (await kvCache.getWithMetadata(bodyKey)) as {
          value: string | null;
          metadata: { v?: string } | null;
        } | null;
        if (got && got.value !== null) {
          const isFresh = got.metadata?.v === version;
          if (!isFresh) {
            schedulePoListBodyRefresh(c, orgId, bodyKey, () =>
              buildListPayload(false),
            );
          }
          return new Response(got.value, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Cache": isFresh ? "HIT" : "STALE",
            },
          });
        }
      } catch (err) {
        console.error("[poList cache] kv get failed", err);
      }
    } else {
      const cacheKey = buildPoListCacheKey(orgId, version, new URL(c.req.url));
      try {
        const cached = await kvCache.get(cacheKey);
        if (cached !== null) {
          return new Response(cached, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Cache": "HIT",
            },
          });
        }
      } catch (err) {
        console.error("[poList cache] kv get failed", err);
      }
      cacheKeyForWrite = cacheKey;
    }
  }

  if (!paginate) {
    // Phase 6 (2026-05-24): the heavy fetch runs through the cache-aside
    // snapshot pattern — see buildListPayload above. The snapshot cache key
    // encodes every query param so dept tabs / category filters /
    // completed-toggle each get their own entry; source tables =
    // production_orders + job_cards so the next read after any PO/JC write
    // auto-recomputes. The KV layer above sits in front as the edge cache;
    // since 2026-07-03 it stores the body under a stable key with the org
    // version in metadata so version mismatches serve stale instantly.
    const cached = await buildListPayload(true);
    const body = JSON.stringify(cached);
    if (bodyKeyForWrite && kvCache) {
      const writePromise = kvCache
        .put(bodyKeyForWrite, body, {
          expirationTtl: PO_LIST_BODY_TTL_S,
          metadata: { v: versionAtRead ?? "0" },
        })
        .catch((err) => console.error("[poList cache] kv put failed", err));
      if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(writePromise);
      else void writePromise;
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
    });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const { data, total } = await fetchPaginatedPOs(
    c.var.DB,
    orgId,
    statuses,
    includeJobCards,
    page,
    limit,
    includeArchive,
    minimal,
    deptFilter,
    dueFrom,
    dueTo,
    catFilter,
    poCustomerScope,
  );
  await attachCustomerSO(
    c.var.DB,
    data as Array<{
      salesOrderId: string;
      consignmentOrderId: string;
      customerSO: string;
    }>,
  );
  const body = JSON.stringify({ success: true, data, page, limit, total });
  if (cacheKeyForWrite && kvCache) {
    const writePromise = kvCache
      .put(cacheKeyForWrite, body, { expirationTtl: 60 })
      .catch((err) => console.error("[poList cache] kv put failed", err));
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(writePromise);
    else void writePromise;
  }
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
  });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-wips
// Distinct WIPs that have appeared in any JobCard to date.
// ---------------------------------------------------------------------------
app.get("/historical-wips", async (c) => {
  const orgId = getOrgId(c);
  // PR 7 follow-up 2026-05-21 — cache-aside snapshot. This endpoint scans
  // every PO + every job card via fetchAllPOs() then dedups into a small
  // distinct-WIP list; it was missed in the original PR 7 sweep. Heavy
  // compute, tiny result — same cache-aside treatment as the other
  // aggregation endpoints. cache_key='' (no query params).
  const { withSnapshot } = await import("../lib/snapshot");
  const result = await withSnapshot(
    c.var.DB,
    {
      tableName: "historical_wips_snapshot",
      sourceTables: ["production_orders", "job_cards"],
    },
    orgId,
    async () => {
      const all = await fetchAllPOs(c.var.DB, orgId);
      type H = {
        wipLabel: string;
        wipKey?: string;
        wipCode?: string;
        wipType?: string;
        sourcePoId: string;
        sourceJcId: string;
        sourcePoNo: string;
        itemCategory: string;
        productCode: string;
        productName: string;
        sizeCode: string;
        sizeLabel: string;
        fabricCode: string;
        lastSeen: string;
      };
      const seen = new Map<string, H>();
      for (const po of all) {
        for (const jc of po.jobCards) {
          if (!jc.wipLabel) continue;
          const key = `${jc.wipLabel}::${jc.wipKey ?? ""}::${po.sizeCode}::${po.fabricCode}`;
          const prev = seen.get(key);
          if (!prev || (po.createdAt || "") > (prev.lastSeen || "")) {
            seen.set(key, {
              wipLabel: jc.wipLabel,
              wipKey: jc.wipKey,
              wipCode: jc.wipCode,
              wipType: jc.wipType,
              sourcePoId: po.id,
              sourceJcId: jc.id,
              sourcePoNo: po.poNo,
              itemCategory: po.itemCategory,
              productCode: po.productCode,
              productName: po.productName,
              sizeCode: po.sizeCode,
              sizeLabel: po.sizeLabel,
              fabricCode: po.fabricCode,
              lastSeen: po.createdAt || "",
            });
          }
        }
      }
      const list = Array.from(seen.values()).sort((a, b) => {
        if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
        return a.wipLabel.localeCompare(b.wipLabel);
      });
      return { success: true, data: list };
    },
  );
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-fgs
// ---------------------------------------------------------------------------
app.get("/historical-fgs", async (c) => {
  const orgId = getOrgId(c);
  // PR 7 follow-up 2026-05-21 — cache-aside snapshot (see historical-wips
  // above). Scans every PO via fetchAllPOs() then dedups into a small
  // distinct-FG list; missed in the original PR 7 sweep.
  const { withSnapshot } = await import("../lib/snapshot");
  const result = await withSnapshot(
    c.var.DB,
    {
      tableName: "historical_fgs_snapshot",
      sourceTables: ["production_orders", "job_cards"],
    },
    orgId,
    async () => {
      const all = await fetchAllPOs(c.var.DB, orgId);
      type H = {
        sourcePoId: string;
        sourcePoNo: string;
        itemCategory: string;
        productCode: string;
        productName: string;
        sizeCode: string;
        sizeLabel: string;
        fabricCode: string;
        lastSeen: string;
      };
      const seen = new Map<string, H>();
      for (const po of all) {
        const key = `${po.productCode}::${po.sizeCode}::${po.fabricCode}`;
        const prev = seen.get(key);
        if (!prev || (po.createdAt || "") > (prev.lastSeen || "")) {
          seen.set(key, {
            sourcePoId: po.id,
            sourcePoNo: po.poNo,
            itemCategory: po.itemCategory,
            productCode: po.productCode,
            productName: po.productName,
            sizeCode: po.sizeCode,
            sizeLabel: po.sizeLabel,
            fabricCode: po.fabricCode,
            lastSeen: po.createdAt || "",
          });
        }
      }
      const list = Array.from(seen.values()).sort((a, b) => {
        if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
        return a.productName.localeCompare(b.productName);
      });
      return { success: true, data: list };
    },
  );
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/stock — create a WIP-only or full-FG stock PO.
//
// Clones the source PO's jobCards (filtered by wipKey for WIP mode, or all
// for FG mode), resets worker-side state, generates a placeholder SOH SO,
// and creates a new PO linked to it.
// ---------------------------------------------------------------------------
app.post("/stock", async (c) => {
  const denied = await requirePermission(c, "production-orders", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const body = await c.req.json().catch(() => ({}));
  const type = body?.type as "WIP" | "FG" | undefined;
  const sourcePoId = body?.sourcePoId as string | undefined;
  const sourceJcId = body?.sourceJcId as string | undefined;
  const quantity = Math.max(1, Math.floor(Number(body?.quantity) || 0));
  const targetEndDate = body?.targetEndDate as string | undefined;

  if (type !== "WIP" && type !== "FG") {
    return c.json({ success: false, error: "type must be WIP or FG" }, 400);
  }
  if (!sourcePoId) {
    return c.json({ success: false, error: "sourcePoId is required" }, 400);
  }
  if (type === "WIP" && !sourceJcId) {
    return c.json(
      { success: false, error: "sourceJcId is required for WIP stock PO" },
      400,
    );
  }
  if (!quantity) {
    return c.json({ success: false, error: "quantity must be >= 1" }, 400);
  }
  if (!targetEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetEndDate)) {
    return c.json(
      { success: false, error: "targetEndDate must be YYYY-MM-DD" },
      400,
    );
  }

  const sourcePO = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(sourcePoId)
    .first<ProductionOrderRow>();
  if (!sourcePO) {
    return c.json({ success: false, error: "Source PO not found" }, 404);
  }
  const sourceJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(sourcePoId)
    .all<JobCardRow>();
  const sourceJcs = sourceJcsRes.results ?? [];

  let jcsToCopy: JobCardRow[];
  let selectedWipLabel = "";
  if (type === "WIP") {
    const sourceJc = sourceJcs.find((j) => j.id === sourceJcId);
    if (!sourceJc) {
      return c.json(
        { success: false, error: "Source JC not found on source PO" },
        404,
      );
    }
    selectedWipLabel = sourceJc.wipLabel || "";
    if (sourceJc.wipKey) {
      jcsToCopy = sourceJcs.filter((j) => j.wipKey === sourceJc.wipKey);
    } else {
      jcsToCopy = [sourceJc];
    }
  } else {
    jcsToCopy = [...sourceJcs];
  }
  if (jcsToCopy.length === 0) {
    return c.json(
      { success: false, error: "No jobCards to clone from source PO" },
      422,
    );
  }

  // Fabric integrity gate — sourcePO.fabricCode is copied verbatim into the
  // new stock PO + its placeholder SO row. Without this check, a legacy SO
  // with an orphan fabricCode (pre-c8696e1 data) would propagate forward
  // every time a stock PO is cloned from it. See bug_audit_known_issues.md
  // BUG-2026-05-09-005 + the 2026-05-09 fabricCode sneak-path audit.
  if (sourcePO.fabricCode) {
    const fabCheck = await validateFabricCodes(db, [sourcePO.fabricCode]);
    if (!fabCheck.valid) {
      return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
    }
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];

  // Generate SOH + new SO row.
  const sohNo = await nextSOHNumber(db);
  const soId = genSoId();

  const newItem = {
    id: genItemId(),
    lineNo: 1,
    lineSuffix: "-01",
    productId: sourcePO.productId,
    productCode: sourcePO.productCode,
    productName: sourcePO.productName,
    itemCategory: sourcePO.itemCategory,
    sizeCode: sourcePO.sizeCode,
    sizeLabel: sourcePO.sizeLabel,
    fabricCode: sourcePO.fabricCode,
    quantity,
    gapInches: sourcePO.gapInches,
    divanHeightInches: sourcePO.divanHeightInches,
    divanPriceSen: 0,
    legHeightInches: sourcePO.legHeightInches,
    legPriceSen: 0,
    specialOrder: sourcePO.specialOrder || "",
    specialOrderPriceSen: 0,
    basePriceSen: 0,
    unitPriceSen: 0,
    lineTotalSen: 0,
    notes: type === "WIP" ? `Stock WIP: ${selectedWipLabel}` : "Stock FG",
  };

  // Clone job cards — reset worker state; adjust wipQty proportional to new qty.
  const sourceQty = Math.max(1, sourcePO.quantity || 1);
  const minSeq = jcsToCopy.reduce(
    (m, j) => (j.sequence < m ? j.sequence : m),
    jcsToCopy[0].sequence,
  );

  const newJcIds = jcsToCopy.map(() => genJcId());
  const newPoId = genPoId();
  const newPoNo = `${sohNo}-01`;

  const statements: D1PreparedStatement[] = [];

  // Insert stock SO.
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
            customerSO, customerSOId, reference, customerId, customerName,
            customerState, hubId, hubName, companySO, companySOId, companySODate,
            customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
            subtotalSen, totalSen, status, overdue, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        soId,
        "",
        "",
        "",
        "",
        "",
        type === "WIP" ? `Stock WIP (${selectedWipLabel})` : "Stock FG",
        "", // customerId — stock SO has no customer; NOT NULL but empty string OK
        "— Stock —",
        "",
        null,
        null,
        sohNo,
        sohNo,
        today,
        targetEndDate,
        targetEndDate,
        "",
        0,
        0,
        "DRAFT",
        "PENDING",
        "Stock placeholder — will be renamed to the customer SO when a real order lands.",
        nowIso,
        nowIso,
      ),
  );

  // Insert minimal SO item so downstream readers don't crash.
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
           productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
           fabricCode, quantity, gapInches, divanHeightInches,
           divanPriceSen, legHeightInches, legPriceSen, specialOrder,
           specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newItem.id,
        soId,
        newItem.lineNo,
        newItem.lineSuffix,
        newItem.productId,
        newItem.productCode,
        newItem.productName,
        newItem.itemCategory,
        newItem.sizeCode,
        newItem.sizeLabel,
        newItem.fabricCode,
        newItem.quantity,
        newItem.gapInches,
        newItem.divanHeightInches,
        newItem.divanPriceSen,
        newItem.legHeightInches,
        newItem.legPriceSen,
        newItem.specialOrder,
        newItem.specialOrderPriceSen,
        newItem.basePriceSen,
        newItem.unitPriceSen,
        newItem.lineTotalSen,
        newItem.notes,
      ),
  );

  // Find first dept — for PO.currentDepartment.
  const firstDept = [...jcsToCopy].sort((a, b) => a.sequence - b.sequence)[0]
    ?.departmentCode || "WOOD_CUT";

  // Insert PO.
  statements.push(
    db
      .prepare(
        `INSERT INTO production_orders (id, poNo, salesOrderId, salesOrderNo, lineNo,
           customerPOId, customerReference, customerName, customerState, companySOId,
           productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
           fabricCode, quantity, gapInches, divanHeightInches, legHeightInches,
           specialOrder, notes, status, currentDepartment, progress, startDate,
           targetEndDate, completedDate, rackingNumber, stockedIn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newPoId,
        newPoNo,
        soId,
        sohNo,
        1,
        "",
        type === "WIP" ? `Stock WIP (${selectedWipLabel})` : "Stock FG",
        "— Stock —",
        "",
        sohNo,
        sourcePO.productId,
        sourcePO.productCode,
        sourcePO.productName,
        sourcePO.itemCategory,
        sourcePO.sizeCode,
        sourcePO.sizeLabel,
        sourcePO.fabricCode,
        quantity,
        sourcePO.gapInches,
        sourcePO.divanHeightInches,
        sourcePO.legHeightInches,
        sourcePO.specialOrder || "",
        type === "WIP"
          ? `Stock PO — WIP only (${selectedWipLabel}). Cloned from ${sourcePO.poNo}.`
          : `Stock PO — FG. Cloned from ${sourcePO.poNo}.`,
        "PENDING",
        firstDept,
        0,
        today,
        targetEndDate,
        null,
        "",
        0,
        nowIso,
        nowIso,
      ),
  );

  // Insert job cards.
  for (let i = 0; i < jcsToCopy.length; i++) {
    const jc = jcsToCopy[i];
    const newId = newJcIds[i];
    const perUnit = (jc.wipQty ?? sourceQty) / sourceQty;
    const newWipQty = Math.max(1, Math.round(perUnit * quantity));
    statements.push(
      db
        .prepare(
          `INSERT INTO job_cards (id, productionOrderId, departmentId, departmentCode,
             departmentName, sequence, status, dueDate, wipKey, wipCode, wipType,
             wipLabel, wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name,
             completedDate, estMinutes, actualMinutes, category,
             productionTimeMinutes, overdue, rackingNumber, branchKey)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId,
          newPoId,
          jc.departmentId,
          jc.departmentCode,
          jc.departmentName,
          jc.sequence,
          "WAITING",
          targetEndDate,
          jc.wipKey,
          jc.wipCode,
          jc.wipType,
          jc.wipLabel,
          newWipQty,
          jc.sequence === minSeq ? 1 : 0,
          null,
          "",
          null,
          "",
          null,
          jc.estMinutes,
          null,
          jc.category,
          jc.productionTimeMinutes,
          "PENDING",
          null,
          // Inherit the source JC's branchKey (clone path — same BOM
          // branch as the row we're copying from).
          jc.branchKey ?? "",
        ),
    );
  }

  await db.batch(statements);

  const fresh = await fetchPO(db, newPoId);
  return c.json({ success: true, data: fresh });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/resync-po-numbers
//
// One-shot backfill that re-aligns production_orders.poNo with the parent
// SO's CURRENT companySOId. Heals the desync introduced by
// scripts/restore-original-so-ids.ts before its 2026-04-30 fix — that
// script renumbered companySOId on both sales_orders AND production_orders
// but left the poNo column stale, so the production page filter (which
// matches against poNo) kept resolving by the pre-renumber SO id and
// confused operators looking for a current SO number.
//
// Body: { dryRun?: boolean } — defaults to true. Pass { dryRun: false }
// to actually write. The endpoint returns the desync count + a sample of
// the diffs in either mode, so the caller can verify scope before
// committing.
// ---------------------------------------------------------------------------
app.post("/resync-po-numbers", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  let body: { dryRun?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dryRun !== false; // default safe

  // Two layers in play here:
  //   1. supabase-compat.ts rewrites camelCase identifiers → snake_case
  //      via column-rename-map.json. Identifiers MUST be unquoted for the
  //      walker to see them (quoted identifiers are passed through verbatim
  //      and Postgres rejects them as "column does not exist").
  //   2. Postgres folds unquoted aliases to lowercase, which would silently
  //      break the JS-side `r.freshCompanySOId` etc. lookups (every row
  //      comes back as expectedPoNo: "undefined-NN").
  // So: leave column refs unquoted (let the shim rewrite them) and quote
  // only the aliases (preserve the camelCase the result mapper expects).
  const rows = await db
    .prepare(
      `SELECT po.id AS "poId",
              po.poNo AS "currentPoNo",
              po.lineNo AS "lineNo",
              po.salesOrderId AS "soId",
              so.companySOId AS "freshCompanySOId"
         FROM production_orders po
         JOIN sales_orders so ON so.id = po.salesOrderId
        WHERE po.salesOrderId IS NOT NULL
          AND so.companySOId IS NOT NULL
          AND so.companySOId <> ''`,
    )
    .all<{
      poId: string;
      currentPoNo: string;
      lineNo: number;
      soId: string;
      freshCompanySOId: string;
    }>();

  const desync: Array<{
    poId: string;
    currentPoNo: string;
    expectedPoNo: string;
    soId: string;
  }> = [];
  for (const r of rows.results ?? []) {
    const lineSuffix = `-${String(r.lineNo).padStart(2, "0")}`;
    const expectedPoNo = `${r.freshCompanySOId}${lineSuffix}`;
    if (r.currentPoNo !== expectedPoNo) {
      desync.push({
        poId: r.poId,
        currentPoNo: r.currentPoNo,
        expectedPoNo,
        soId: r.soId,
      });
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      desyncCount: desync.length,
      sample: desync.slice(0, 10),
    });
  }

  // Apply in chunks so a single failure (e.g. UNIQUE poNo collision)
  // surfaces with the exact poId and the rest of the batch still lands.
  let applied = 0;
  const errors: Array<{ poId: string; expectedPoNo: string; error: string }> = [];
  for (const d of desync) {
    try {
      await db
        .prepare("UPDATE production_orders SET poNo = ? WHERE id = ?")
        .bind(d.expectedPoNo, d.poId)
        .run();
      applied += 1;
    } catch (err) {
      errors.push({
        poId: d.poId,
        expectedPoNo: d.expectedPoNo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    desyncCount: desync.length,
    applied,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/packing-rack-tokens
// Body: { items: [{ poNo, pieceName }] }  → { tokens: { "<poNo>|<pieceName>": "<64hex>" } }
//
// AUTHED token mint for the PUBLIC packing-sticker → rack scan flow. Called at
// sticker-PRINT time (the production page builds the FG sticker set), this
// resolves each (poNo, pieceName) to its ONE PACKING job_card — exactly like the
// scan-time resolver in routes/public-rack-qr.ts (resolvePackingCard): narrow the
// PO's PACKING cards to the one whose wipLabel CONTAINS the short box label, else
// the sole PACKING card — and lazily mints that card's unguessable 64-hex
// qr_token (getOrCreateJobCardQrToken). The printed QR then encodes /p/<token>
// instead of the /worker/scan deep link, so a storekeeper with no Worker-Portal
// PIN can still set the rack. Minting lives ONLY here (behind read auth — same
// gate as "show me the QR" on the DO qr-token endpoint); the public route only
// RESOLVES tokens, never creates them.
//
// Returns a map keyed by "<poNo>|<pieceName>" so the client can attach the right
// token to each sticker; a key is omitted when no single PACKING card resolves
// (the client then keeps the /worker/scan fallback, so the worker flow is never
// broken). The token is NEVER logged.
// ---------------------------------------------------------------------------
app.post("/packing-rack-tokens", async (c) => {
  // Read-level gate — minting is an idempotent internal detail of "print the
  // sticker", same as the DO qr-token endpoint (delivery-orders.ts).
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as {
    items?: Array<{ poNo?: unknown; pieceName?: unknown }>;
  };
  const rawItems = Array.isArray(body.items) ? body.items : [];
  // De-dup the (poNo, pieceName) pairs — many physical pieces of one PO share a
  // pieceName and resolve to the same card; resolve + mint once each.
  const wanted = new Map<string, { poNo: string; pieceName: string }>();
  for (const it of rawItems) {
    const poNo = typeof it?.poNo === "string" ? it.poNo.trim() : "";
    const pieceName =
      typeof it?.pieceName === "string" ? it.pieceName.trim() : "";
    if (!poNo) continue;
    wanted.set(`${poNo}|${pieceName}`, { poNo, pieceName });
  }

  const tokens: Record<string, string> = {};
  // Parallel map: the same "<poNo>|<pieceName>" key → the resolved PACKING
  // job_card id. The client embeds it on the sticker as &jc= so the
  // /worker/scan fallback can resolve by card id even when poNo drifted and
  // the token mint couldn't persist (TASK 2 robustness). Always populated when
  // a card resolves, independent of whether the token minted.
  const cardIds: Record<string, string> = {};
  try {
    await ensureJobCardQrTokenColumn(c.var.DB);
    // Batched lookups. This was a serial per-(poNo,pieceName) loop — ~6 DB
    // round-trips each (PO → PACKING cards → mint × N) — so a handful of
    // stickers fired dozens of sequential calls and stalled the FG-sticker
    // preview/print. Now: ONE query for every PO, ONE for every PACKING card,
    // then mint the UNIQUE tokens in parallel. Output is byte-identical to the
    // old loop (same pickPackingCard narrowing, same FIX 3 per-wipLabel keys,
    // same FIX 4 null-token guard).
    const poNos = [...new Set([...wanted.values()].map((w) => w.poNo))];
    if (poNos.length > 0) {
      const poPh = poNos.map(() => "?").join(",");
      const posRes = await c.var.DB.prepare(
        `SELECT id, poNo FROM production_orders WHERE poNo IN (${poPh}) OR id IN (${poPh})`,
      )
        .bind(...poNos, ...poNos)
        .all<{ id: string; poNo: string | null }>();
      // poNo (and, defensively, id) → production_order id.
      const poIdByKey = new Map<string, string>();
      const resolvedIds = new Set<string>();
      for (const po of posRes.results ?? []) {
        if (po.poNo) poIdByKey.set(po.poNo, po.id);
        poIdByKey.set(po.id, po.id);
        resolvedIds.add(po.id);
      }

      // ADDITIVE poNo-drift recovery (the mint-side twin of the worker.ts
      // scan-lookup fallback, ~line 481). FG-PACKING stickers carry ONLY po=
      // (no jc-id to fall back on), so if the printed poNo drifted from the
      // current production_orders.poNo (SO edited → pieces renumbered, a
      // trailing space, a case change) the exact match above misses → no card
      // → no /p/ token → the reprint keeps the /worker/scan fallback that
      // dead-ends at the LOGIN page on an external phone. Recover the misses in
      // TWO batched queries (never a per-poNo loop): (a) trim/case-insensitive
      // poNo, then (b) fg_units (sticker po = the unit's stored poNo →
      // fg_units.poId is the stable PO id). Only resolves a LIVE PO (purged PO →
      // honest miss → reprint), and never overrides an exact hit. BUG-2026-06-26.
      const unresolved = poNos.filter((p) => !poIdByKey.has(p));
      if (unresolved.length > 0) {
        try {
          const ph = unresolved.map(() => "?").join(",");
          const ciRes = await c.var.DB.prepare(
            `SELECT id, poNo FROM production_orders WHERE LOWER(TRIM(poNo)) IN (${ph})`,
          )
            .bind(...unresolved.map((p) => p.trim().toLowerCase()))
            .all<{ id: string; poNo: string | null }>();
          const byNorm = new Map<string, string>();
          for (const po of ciRes.results ?? []) {
            if (po.poNo && !byNorm.has(po.poNo.trim().toLowerCase())) {
              byNorm.set(po.poNo.trim().toLowerCase(), po.id);
            }
          }
          for (const w of unresolved) {
            const id = byNorm.get(w.trim().toLowerCase());
            if (id) {
              poIdByKey.set(w, id);
              resolvedIds.add(id);
            }
          }
        } catch (e) {
          console.warn("[packing-rack-tokens] CI poNo fallback failed:", e);
        }
      }
      const stillUnresolved = poNos.filter((p) => !poIdByKey.has(p));
      if (stillUnresolved.length > 0) {
        try {
          const ph = stillUnresolved.map(() => "?").join(",");
          const fuRes = await c.var.DB.prepare(
            `SELECT poNo, poId FROM fg_units WHERE poNo IN (${ph}) AND poId IS NOT NULL`,
          )
            .bind(...stillUnresolved)
            .all<{ poNo: string | null; poId: string | null }>();
          const fuByPoNo = new Map<string, string>();
          for (const u of fuRes.results ?? []) {
            if (u.poNo && u.poId && !fuByPoNo.has(u.poNo)) {
              fuByPoNo.set(u.poNo, u.poId);
            }
          }
          // Confirm each recovered poId still points at a LIVE production_order
          // (a purged PO → drop it → honest miss, same contract as worker.ts).
          const candidateIds = [...new Set(fuByPoNo.values())].filter(
            (id) => !resolvedIds.has(id),
          );
          if (candidateIds.length > 0) {
            const livePh = candidateIds.map(() => "?").join(",");
            const liveRes = await c.var.DB.prepare(
              `SELECT id FROM production_orders WHERE id IN (${livePh})`,
            )
              .bind(...candidateIds)
              .all<{ id: string }>();
            const liveIds = new Set((liveRes.results ?? []).map((r) => r.id));
            for (const [poNo, poId] of fuByPoNo) {
              if (liveIds.has(poId)) {
                poIdByKey.set(poNo, poId);
                resolvedIds.add(poId);
              }
            }
          }
        } catch (e) {
          console.warn("[packing-rack-tokens] fg_units fallback failed:", e);
        }
      }

      const poIds = [...resolvedIds];
      // Every PACKING card for those POs in one query, grouped by PO.
      const cardsByPo = new Map<
        string,
        Array<{ id: string; wipLabel: string | null; status: string | null }>
      >();
      if (poIds.length > 0) {
        const cPh = poIds.map(() => "?").join(",");
        const cardsRes = await c.var.DB.prepare(
          `SELECT id, productionOrderId, wipLabel, status FROM job_cards
             WHERE productionOrderId IN (${cPh}) AND departmentCode = 'PACKING'`,
        )
          .bind(...poIds)
          .all<{
            id: string;
            productionOrderId: string;
            wipLabel: string | null;
            status: string | null;
          }>();
        for (const card of cardsRes.results ?? []) {
          const arr = cardsByPo.get(card.productionOrderId) ?? [];
          arr.push({ id: card.id, wipLabel: card.wipLabel, status: card.status });
          cardsByPo.set(card.productionOrderId, arr);
        }
      }
      // Resolve every wanted key → the ONE card id it should mint (pickPackingCard),
      // plus the FIX 3 per-wipLabel keys for multi-card POs. Collect first, then
      // mint the UNIQUE card ids in parallel.
      const keyToCardId = new Map<string, string>();
      for (const [key, { poNo, pieceName }] of wanted) {
        const poId = poIdByKey.get(poNo);
        if (!poId) continue;
        const cards = cardsByPo.get(poId) ?? [];
        if (cards.length === 0) continue;
        const pick = pickPackingCard(cards, pieceName);
        if (pick) keyToCardId.set(key, pick.id);
        // FIX 3 — multi-card PO: also offer a token per wipLabel key.
        if (cards.length > 1) {
          for (const card of cards) {
            const label = (card.wipLabel ?? "").trim();
            if (!label) continue;
            const labelKey = `${poNo}|${label}`;
            if (!keyToCardId.has(labelKey)) keyToCardId.set(labelKey, card.id);
          }
        }
      }
      // Mint the unique cards in parallel (each touches a distinct job_card row →
      // no contention). FIX 4: getOrCreateJobCardQrToken returns null when it
      // can't persist — never emit a dead token.
      const uniqueCardIds = [...new Set(keyToCardId.values())];
      const tokenByCardId = new Map<string, string>();
      await Promise.all(
        uniqueCardIds.map(async (cid) => {
          const t = await getOrCreateJobCardQrToken(c.var.DB, cid);
          if (t) tokenByCardId.set(cid, t);
        }),
      );
      for (const [key, cid] of keyToCardId) {
        cardIds[key] = cid;
        const t = tokenByCardId.get(cid);
        if (t) tokens[key] = t;
      }
    }
    return c.json({ success: true, data: { tokens, cardIds } });
  } catch (err) {
    console.error(
      "[POST /api/production-orders/packing-rack-tokens] failed:",
      err,
    );
    // Soft-fail: return whatever resolved so the print still proceeds (the
    // client falls back to /worker/scan for any missing token).
    return c.json({ success: true, data: { tokens, cardIds } });
  }
});

// (Removed 2026-05-09) POST /api/production-orders/regen-job-cards-bulk
//   and POST /api/production-orders/:poId/regen-job-cards used to wrap the
//   legacy backfillJobCardsForPo helper. That helper diverged from
//   createProductionOrdersForOrder (no FAB_CUT cross-PO merge, no CO
//   source-context plumbing, ignored isProjectOrder) and silently produced
//   wrong JC trees for SOFA + CO POs — see DUP-004 in
//   bug_audit_duplicate_logic.md. Both endpoints had ZERO frontend consumers
//   (verified by grep across src/) so deletion is safe. If a future regen
//   need arises, route through createProductionOrdersForOrder({ appendOnly:
//   true }) so all the merge logic flows in.

// ---------------------------------------------------------------------------
// POST /api/production-orders/:id/scan-complete
// B-flow piece-pic FIFO routing + sticker binding.
// ---------------------------------------------------------------------------
app.post("/:id/scan-complete", async (c) => {
  // Two auth paths (mirrors scan-complete-dept): a dashboard user goes through
  // RBAC; a shop-floor worker token is bound below and restricted to PACKING
  // (the only per-piece sticker routed here from the phone — Fab Cut/Sew use
  // scan-complete-dept, Sew/Uph use scan-complete-shared).
  const ctxUserId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  );
  if (ctxUserId) {
    const denied = await requirePermission(c, "production-orders", "create");
    if (denied) return denied;
  }
  const db = c.var.DB;
  const scannedId = c.req.param("id");
  const scannedPo = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(scannedId)
    .first<ProductionOrderRow>();
  if (!scannedPo) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  // ---- ON_HOLD / CANCELLED scan block ---------------------------------------
  // Paused or cancelled production orders must not accept new scans. The
  // supervisor has to resume (ON_HOLD → PENDING) before the shop floor can
  // record any more completions. COMPLETED POs are intentionally left alone —
  // FIFO sticker binding already handles that path.
  if (scannedPo.status === "ON_HOLD") {
    return c.json(
      {
        success: false,
        code: "PO_ON_HOLD",
        error: "This Production Order is ON_HOLD. Supervisor must resume before scanning.",
      },
      409,
    );
  }
  if (scannedPo.status === "CANCELLED") {
    return c.json(
      {
        success: false,
        code: "PO_CANCELLED",
        error: "This Production Order has been cancelled and cannot be scanned.",
      },
      409,
    );
  }

  const body = await c.req.json();
  const { jobCardId, workerId } = body || {};
  const rawPiece = Number(body?.pieceNo);
  const pieceNo =
    Number.isFinite(rawPiece) && rawPiece >= 1 ? Math.floor(rawPiece) : 1;
  // `force: true` means the worker has already acknowledged a soft warning
  // (PREREQUISITE_NOT_MET / UPSTREAM_LOCKED) on the previous scan-complete
  // round-trip and is re-posting to bypass it. Each forced scan gets an
  // audit row in `scan_override_audit`.
  // (force flag removed 2026-06-08 — prerequisite warning gone, no force path)
  if (!jobCardId || !workerId) {
    return c.json(
      { success: false, error: "jobCardId and workerId are required" },
      400,
    );
  }

  // ---- Worker-auth verification --------------------------------------------
  // The scan-complete endpoint is mounted under /api/production-orders, which
  // means the dashboard auth-middleware gate already passed OR the caller is
  // a worker using the shop-floor portal. For worker callers we bind the
  // body.workerId to the `x-worker-token` header so a malicious worker can't
  // post scans "as someone else" by spoofing the workerId field.
  //
  // Two accepted auth paths:
  //   1. A dashboard user (userId already set on ctx by auth-middleware) —
  //      trust body.workerId as-is (admin scanner in src/pages/production/scan).
  //   2. A worker token (x-worker-token header) — body.workerId must match
  //      the worker_tokens row; otherwise 403.
  // ctxUserId was already resolved at the top of the handler (to gate RBAC).
  const workerToken = c.req.header("x-worker-token");
  if (!ctxUserId) {
    // No dashboard auth → must be a worker call; verify the token binds to
    // the claimed workerId.
    const resolvedWorkerId = await resolveWorkerToken(db, workerToken);
    if (!resolvedWorkerId || resolvedWorkerId !== workerId) {
      return c.json(
        {
          success: false,
          error:
            "Worker auth mismatch — workerId does not match the session token.",
          code: "AUTH_MISMATCH",
        },
        403,
      );
    }
  }

  const scannedJc = await db
    .prepare("SELECT * FROM job_cards WHERE id = ? AND productionOrderId = ?")
    .bind(jobCardId, scannedId)
    .first<JobCardRow>();
  if (!scannedJc) {
    return c.json({ success: false, error: "Job card not found" }, 404);
  }
  // Worker-token scan-complete is open to ALL departments (Wei Siang
  // 2026-06-14). The Code 128 printed on the Production Schedule lets every
  // dept — including the no-sticker ones (Woodcutting / Framing / Webbing) —
  // complete its WIP by scanning, not just Packing. Auth is still enforced
  // (the worker token was bound to workerId above); PO ON_HOLD/CANCELLED and
  // the JC BLOCKED/CANCELLED gates still apply. The per-piece QR flow for
  // Fab Cut/Sew/Uph keeps routing to scan-complete-dept / -shared.
  const worker = await db
    .prepare("SELECT id, name FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ id: string; name: string }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // Upstream-lock disabled (2026-04-26, user request) — same reasoning as
  // the PATCH guard above: the flat DEPT_ORDER + wipKey predicate doesn't
  // model the BOM tree's parallel branches (FAB chain vs WOOD chain inside
  // one wipKey only converge at UPHOLSTERY). The previous predicate flagged
  // any FAB_CUT/FAB_SEW scan as UPSTREAM_LOCKED the moment WOOD_CUT
  // completed, which is wrong. Re-enable once the lock chain is derived
  // from the BOM template at runtime.

  // ---- prerequisiteMet check REMOVED (Wei Siang 2026-06-08) -----------------
  // The "Earlier dept hasn't completed. Continue anyway?" soft warning is gone.
  // The shop floor doesn't enforce strict department order, and the BOM-template
  // placeholder data (~18k JCs with unresolved keys) left the prerequisiteMet
  // flag unreliable anyway — it kept firing false warnings on already-completed
  // upstream depts. Workers may now complete any department directly, no check.

  // ---- WYSIWYG target (Wei Siang 2026-06-08) --------------------------------
  // Packing completes THE scanned piece — the piece on the scanned JC — NOT a
  // FIFO-oldest same-spec piece on some other PO. Every made-to-order piece
  // belongs to its own SO, so scanning SO-X's packing sticker completes SO-X's
  // piece, full stop. This removes the old cross-PO FIFO redirect, which could
  // route a scan of an ACTIVE order onto a DIFFERENT — even CANCELLED — order
  // (the FIFO candidate filter never excluded CANCELLED/BLOCKED, so a scan of
  // an active sofa once completed a cancelled order's packing). The scanned PO
  // is already ON_HOLD / CANCELLED-gated at the top of this handler; the
  // JC-level BLOCKED gate below stops a QC-failed piece from being packed too.
  if (
    (scannedJc.status || "").toUpperCase() === "BLOCKED" ||
    (scannedJc.status || "").toUpperCase() === "CANCELLED"
  ) {
    return c.json(
      {
        success: false,
        code: "JC_NOT_PACKABLE",
        error: `This piece is ${(scannedJc.status || "").toLowerCase()} and can't be packed.`,
      },
      409,
    );
  }
  const stickerKey = `${scannedPo.id}::${scannedJc.id}::${pieceNo}`;
  const slots = await ensurePiecePicsForJc(db, scannedJc);
  // Mirror a legacy JC-level PIC onto slot[0] so the same-worker / share / full
  // guards below see it (seed + A-flow JCs carry the PIC on the JC, not slots).
  if (slots[0]) {
    if (scannedJc.pic1Id && !slots[0].pic1Id) {
      await db
        .prepare("UPDATE piece_pics SET pic1Id = ?, pic1Name = ? WHERE id = ?")
        .bind(scannedJc.pic1Id, scannedJc.pic1Name ?? "", slots[0].id)
        .run();
      slots[0] = {
        ...slots[0],
        pic1Id: scannedJc.pic1Id,
        pic1Name: scannedJc.pic1Name ?? "",
      };
    }
    if (scannedJc.pic2Id && !slots[0].pic2Id) {
      await db
        .prepare("UPDATE piece_pics SET pic2Id = ?, pic2Name = ? WHERE id = ?")
        .bind(scannedJc.pic2Id, scannedJc.pic2Name ?? "", slots[0].id)
        .run();
      slots[0] = {
        ...slots[0],
        pic2Id: scannedJc.pic2Id,
        pic2Name: scannedJc.pic2Name ?? "",
      };
    }
  }
  // Target THIS sticker's piece (its pieceNo on the scanned JC).
  const targetSlot = slots.find((s) => s.pieceNo === pieceNo) ?? slots[0];
  if (!targetSlot) {
    return c.json(
      { success: false, error: "No piece slot found for this sticker." },
      400,
    );
  }
  // Self-bind the sticker to its own piece so a re-scan (2-worker share) lands
  // on the same slot.
  if (targetSlot.boundStickerKey !== stickerKey) {
    await db
      .prepare("UPDATE piece_pics SET boundStickerKey = ? WHERE id = ?")
      .bind(stickerKey, targetSlot.id)
      .run();
    targetSlot.boundStickerKey = stickerKey;
  }
  const target: { po: ProductionOrderRow; jc: JobCardRow; slot: PiecePicRow } =
    { po: scannedPo, jc: scannedJc, slot: targetSlot };

  // completeWholeCard (Code 128 schedule scan): finish the ENTIRE WIP in one
  // scan — PIC1 of every still-open piece becomes the scanning worker — instead
  // of one piece per scan. The 2-PIC co-sign / debounce / PIC_FULL guards are
  // per-piece QR-sticker concepts and are skipped for the whole-card path. The
  // rollup + cascades below are shared by both paths. Timestamps + assignedSlot
  // are hoisted here so both fill branches and the rollup share them.
  const wholeCard = body?.completeWholeCard === true;
  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  let assignedSlot: 1 | 2 = 1;
  let newCompletedAt: string | null = target.slot.completedAt ?? null;
  // Barcode (whole-card) feedback parity with QR: did THIS scan actually
  // complete anything, or was the row already done? Drives the ✓ card's
  // "already complete · by <who>" vs a fresh green tick.
  let wholeCardAlreadyComplete = false;

  // Same-worker guard.
  if (!wholeCard && target.slot.pic1Id === worker.id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `You are already PIC1 on this piece (${worker.name}). A second PIC must be a different worker.`,
        code: "ALREADY_PIC1",
        data: {
          jobCard: jcOut,
          assignedSlot: 1,
          workerName: worker.name,
          pieceNo: target.slot.pieceNo,
        },
      },
      409,
    );
  }
  if (!wholeCard && target.slot.pic2Id === worker.id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `You are already PIC2 on this piece (${worker.name}).`,
        code: "ALREADY_PIC2",
        data: {
          jobCard: jcOut,
          assignedSlot: 2,
          workerName: worker.name,
          pieceNo: target.slot.pieceNo,
        },
      },
      409,
    );
  }

  // 3-second piece-level debounce.
  if (!wholeCard && target.slot.lastScanAt) {
    const elapsedMs = Date.now() - new Date(target.slot.lastScanAt).getTime();
    if (elapsedMs < 3000) {
      return c.json(
        {
          success: false,
          error:
            "This piece was just scanned. Please wait a moment before scanning again.",
          code: "DEBOUNCE",
        },
        429,
      );
    }
  }

  if (!wholeCard && target.slot.pic1Id && target.slot.pic2Id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `This piece already has 2 PICs (${target.slot.pic1Name} / ${target.slot.pic2Name}). A third person cannot scan the same piece.`,
        code: "PIC_FULL",
        data: { jobCard: jcOut, pieceNo: target.slot.pieceNo },
      },
      400,
    );
  }

  // Fill the piece slot(s).
  if (wholeCard) {
    // Whole-WIP completion: PIC1 of every still-open piece → the scanning
    // worker. Idempotent — a piece already signed off keeps its existing PIC.
    // Count pieces THIS scan fills: zero ⇒ the row was already done (re-scan,
    // or a second worker after the first already finished it) → the ✓ card
    // shows "already complete · by <first worker>", matching QR.
    let filledPic1 = 0;
    let filledPic2 = 0;
    for (const s of slots) {
      if (!s.pic1Id) {
        await db
          .prepare(
            `UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, completedAt = ?, lastScanAt = ? WHERE id = ?`,
          )
          .bind(worker.id, worker.name, nowIso, nowIso, s.id)
          .run();
        filledPic1++;
      } else if (s.pic1Id !== worker.id && !s.pic2Id) {
        // 2-PIC co-sign on the WHOLE-ROW barcode: a SECOND, different worker
        // who scans the row's barcode is registered as PIC2 on every piece —
        // owner 2026-06-27 "two people scan the barcode = two PICs". Mirrors the
        // per-piece QR co-sign. A 3rd worker is a no-op (both PIC slots full).
        await db
          .prepare(
            `UPDATE piece_pics SET pic2Id = ?, pic2Name = ?, lastScanAt = ? WHERE id = ?`,
          )
          .bind(worker.id, worker.name, nowIso, s.id)
          .run();
        filledPic2++;
      }
    }
    const filledNow = filledPic1 + filledPic2;
    wholeCardAlreadyComplete = filledNow === 0;
    newCompletedAt = nowIso;
    // This scan filled PIC2-only ⇒ it was the second worker (show slot 2);
    // otherwise it opened/filled PIC1 (slot 1).
    assignedSlot = filledPic2 > 0 && filledPic1 === 0 ? 2 : 1;
  } else {
    // Per-piece (QR sticker) fill — one slot per scan, 2-PIC co-sign.
    let newPic1Id = target.slot.pic1Id;
    let newPic1Name = target.slot.pic1Name ?? "";
    let newPic2Id = target.slot.pic2Id;
    let newPic2Name = target.slot.pic2Name ?? "";

    if (!target.slot.pic1Id) {
      newPic1Id = worker.id;
      newPic1Name = worker.name;
      newCompletedAt = nowIso;
      assignedSlot = 1;
    } else {
      newPic2Id = worker.id;
      newPic2Name = worker.name;
      assignedSlot = 2;
    }

    await db
      .prepare(
        `UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ?,
           completedAt = ?, lastScanAt = ? WHERE id = ?`,
      )
      .bind(
        newPic1Id,
        newPic1Name,
        newPic2Id,
        newPic2Name,
        newCompletedAt,
        nowIso,
        target.slot.id,
      )
      .run();
  }

  // Rollup: all slots for this JC have pic1 → mark JC COMPLETED.
  const allSlots = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
    .bind(target.jc.id)
    .all<PiecePicRow>();
  const slotList = allSlots.results ?? [];
  const allPiecesDone = slotList.length > 0 && slotList.every((s) => !!s.pic1Id);
  // Distinct people credited on this card's pieces — the "by <who>" line on the
  // ✓ card so a barcode completion reads exactly like a QR one.
  const wholeCardCompletedBy = [
    ...new Set(slotList.map((s) => s.pic1Name).filter((n): n is string => !!n)),
  ];

  let jcJustCompleted = false;
  const mergedJc: JobCardRow = { ...target.jc };
  if (
    allPiecesDone &&
    target.jc.status !== "COMPLETED" &&
    target.jc.status !== "TRANSFERRED"
  ) {
    mergedJc.status = "COMPLETED";
    mergedJc.completedDate = today;
    mergedJc.overdue = "COMPLETED";
    jcJustCompleted = true;
  } else if (
    // WAITING → IN_PROGRESS on the FIRST pic1 assignment. The first scan is
    // the operator "starting" the job card; if the rollup above didn't move
    // it straight to COMPLETED (e.g. multi-piece JCs only complete after
    // every piece's pic1 is filled), flip it to IN_PROGRESS now.
    // Never overwrite COMPLETED / TRANSFERRED — those are terminal and the
    // caller is expected to 409 long before we get here.
    target.jc.status === "WAITING" &&
    assignedSlot === 1
  ) {
    mergedJc.status = "IN_PROGRESS";
  }

  // Card-level PIC1/PIC2 = the DISTINCT people who scanned the pieces (Wei Siang
  // 2026-06-07: same person across pieces → PIC1 only; two people → PIC1 + PIC2,
  // each did a piece). Recomputed each scan from the slots so the card always
  // shows who actually did the work — consistent with scan-complete-shared / -dept.
  if (slotList.length > 0) {
    const piecePeople: { id: string; name: string }[] = [];
    for (const s of slotList) {
      for (const person of [
        { id: s.pic1Id, name: s.pic1Name },
        { id: s.pic2Id, name: s.pic2Name },
      ]) {
        if (person.id && !piecePeople.some((p) => p.id === person.id)) {
          piecePeople.push({ id: person.id, name: person.name ?? "" });
        }
      }
    }
    mergedJc.pic1Id = piecePeople[0]?.id ?? null;
    mergedJc.pic1Name = piecePeople[0]?.name ?? "";
    mergedJc.pic2Id = piecePeople[1]?.id ?? null;
    mergedJc.pic2Name = piecePeople[1]?.name ?? "";
  }

  await db
    .prepare(
      `UPDATE job_cards SET status = ?, completedDate = ?, overdue = ?,
         pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ?, updated_at = NOW() WHERE id = ?`,
    )
    .bind(
      mergedJc.status,
      mergedJc.completedDate,
      mergedJc.overdue,
      mergedJc.pic1Id,
      mergedJc.pic1Name ?? "",
      mergedJc.pic2Id,
      mergedJc.pic2Name ?? "",
      mergedJc.id,
    )
    .run();

  // Google Sheets sync — fire-and-forget. Mirror the scan-complete JC row
  // to its dept tab. Helper silently no-ops when the SA key is missing.
  scheduleFireAndForget(c, fireAndForgetSyncJc(c, mergedJc, target.po));

  // If JC just completed, emit WIP inventory update.
  if (jcJustCompleted) {
    const siblings = await db
      .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
      .bind(target.po.id)
      .all<JobCardRow>();
    // Scan path is forward-only (jcJustCompleted is computed from a
    // prevStatus that wasn't COMPLETED/TRANSFERRED). Pass target.jc.status
    // for completeness so the cascade's wasDone gate evaluates correctly.
    await applyWipInventoryChange(
      db,
      target.po,
      mergedJc,
      "COMPLETED",
      siblings.results ?? [],
      target.jc.status,
      { orgId: scanOrgId(c), source: "SCAN" },
    );

    // F2 — labor cost posting (idempotent per jobCardId).
    await postJobCardLabor(db, mergedJc.id, target.po.id);
  }

  // PO progress rollup. currentDepartment is derived inline; status,
  // progress, completedDate flow through recomputePoStatusAndProgress
  // below so the same rules apply on every JC mutation site.
  const poJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(target.po.id)
    .all<JobCardRow>();
  const poJcs = poJcsRes.results ?? [];
  // Frontier = earliest department in the chain (DEPT_ORDER) that still has a
  // not-yet-done job card. A plain `find` of the first IN_PROGRESS/WAITING JC
  // reads rows in arbitrary DB order (no ORDER BY) and could report a dept
  // that doesn't reflect the order's true position in the chain — the same
  // bug as the PATCH path above. Rank incomplete JCs by DEPT_ORDER index.
  const scanDeptRank = (code: string | null | undefined): number => {
    const idx = DEPT_ORDER.indexOf((code ?? "") as (typeof DEPT_ORDER)[number]);
    return idx >= 0 ? idx : DEPT_ORDER.length;
  };
  const scanFrontier = poJcs
    .filter((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED")
    .reduce<JobCardRow | null>((earliest, j) => {
      if (!earliest) return j;
      return scanDeptRank(j.departmentCode) < scanDeptRank(earliest.departmentCode)
        ? j
        : earliest;
    }, null);
  const newCurrentDept = scanFrontier?.departmentCode || "PACKING";

  await db
    .prepare(
      `UPDATE production_orders SET currentDepartment = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(newCurrentDept, nowIso, target.po.id)
    .run();

  let scanRecomputed: Awaited<ReturnType<typeof recomputePoStatusAndProgress>> | null = null;
  // RETRY the rollup. The JC is already persisted COMPLETED above, so if this
  // throws and we give up on the first try, the PO status/progress + the SO/CO
  // cascade (gated on `allDone` below) silently never run — the card reads done
  // but the order stays stuck, and we still return success (Wei Siang 2026-06-17).
  // recomputePoStatusAndProgress is idempotent, so re-running it after a
  // transient DB blip is safe. 3 attempts; a persistent failure is logged loudly
  // (every attempt) so the stuck PO is findable rather than invisible.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      scanRecomputed = await recomputePoStatusAndProgress(db, target.po.id);
      break;
    } catch (err) {
      console.error(
        `[recomputePoStatusAndProgress] scan path failed (attempt ${attempt}/3)`,
        {
          poId: target.po.id,
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  const allDone = scanRecomputed?.after?.status === "COMPLETED";

  if (allDone) {
    // Auto-generate FG units + fg_batches row on PO completion. Runs BEFORE
    // the SO/CO cascade so order progression sees the freshly created inventory.
    // Idempotent — safe on re-entry.
    await postProductionOrderCompletion(db, target.po.id);
    await cascadePoCompletionToSO(db, target.po.salesOrderId);
    // CO-parity twin — fires on POs whose parent is a CO (consignmentOrderId
    // set, salesOrderId NULL). The SO call above no-ops in that case.
    await cascadePoCompletionToCO(db, target.po.consignmentOrderId);
  }
  await cascadeUpholsteryToSO(db, target.po.id);
  await cascadeUpholsteryToCO(db, target.po.id);

  await invalidateProductionCachesAfterScan(c);

  const freshPo = await fetchPO(db, target.po.id);
  const jcOut = freshPo?.jobCards.find((j) => j.id === target.jc.id);
  const redirected =
    target.po.id !== scannedPo.id || target.jc.id !== scannedJc.id;

  return c.json({
    success: true,
    data: {
      jobCard: jcOut,
      assignedSlot,
      workerName: worker.name,
      pieceNo: target.slot.pieceNo,
      pieceCompletedAt: newCompletedAt,
      jcJustCompleted,
      fifoRedirected: redirected,
      scannedPoId: scannedPo.id,
      scannedPoNo: scannedPo.poNo,
      assignedPoId: target.po.id,
      assignedPoNo: target.po.poNo,
      specKey: `${scannedJc.departmentCode}::${scannedJc.wipLabel || scannedPo.productCode}`,
      fifoDueDate: target.jc.dueDate || target.po.targetEndDate || "",
      stickerKey,
      // Barcode whole-card feedback parity with QR: surface WHO completed the
      // row + whether this scan found it already done (re-scan / 2nd worker).
      ...(wholeCard
        ? {
            alreadyComplete: wholeCardAlreadyComplete,
            completedBy: wholeCardCompletedBy,
          }
        : {}),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/:id/scan-complete-dept
//
// One-sticker-per-variant fan-out completion (FAB_CUT / FAB_SEW only).
//
// A sofa variant (one production_orders row) breaks into several WIP
// compartments — BASE / CUSHION / ARMREST — each its own job card in the SAME
// department. The shop floor prints ONE QR sticker per variant (sentinel
// op="FG-<DEPT>"); scanning it must complete ALL of that variant's compartment
// job cards in that ONE department, in a single scan. Owner-confirmed
// (Wei Siang 2026-06-03): one worker sews/cuts the whole variant, so attributing
// every compartment's labour to the scanning worker is correct.
//
// This is the fan-out twin of /scan-complete. It deliberately does NOT run the
// FIFO same-spec piece redirect (that path routes a single piece to the
// oldest-due card across OTHER POs — wrong for a whole-variant assembly scan,
// which belongs to THIS PO). Grouping key = (productionOrderId, departmentCode);
// compartments can never live on a different PO, so it can't over-complete.
//
// Per-card side effects mirror /scan-complete exactly (piece_pics fill →
// JC COMPLETED → applyWipInventoryChange → postJobCardLabor); the PO rollup +
// SO/CO cascade run ONCE at the end. Idempotency: each real jcId claims its own
// wip_cascade_log ticket and postJobCardLabor is keyed per jcId, and the card
// set is filtered to status NOT IN (COMPLETED,TRANSFERRED) — a re-scan finds
// nothing to do and returns success-empty.
// ---------------------------------------------------------------------------
app.post("/:id/scan-complete-dept", async (c) => {
  // Two auth paths (mirrors /scan-complete): a dashboard user (userId stamped
  // by auth-middleware) is authorised via RBAC; a shop-floor worker call
  // carries only X-Worker-Token — no dashboard session — so userRole is unset
  // and requirePermission would 401 it BEFORE the token binding below ever
  // runs. Gate the RBAC check behind "is there a dashboard user" so the worker
  // path falls through to the resolveWorkerToken bind (which 403s an absent /
  // mismatched token). auth-middleware only lets this POST through unauthenticated
  // for X-Worker-Token callers (WORKER_SCAN_COMPLETE_DEPT_RE), so the public
  // surface is exactly "a logged-in worker completing FAB_CUT / FAB_SEW".
  const ctxUserId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  );
  if (ctxUserId) {
    const denied = await requirePermission(c, "production-orders", "create");
    if (denied) return denied;
  }
  const db = c.var.DB;
  const poId = c.req.param("id");
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }
  if (po.status === "ON_HOLD") {
    return c.json(
      {
        success: false,
        code: "PO_ON_HOLD",
        error: "This Production Order is ON_HOLD. Supervisor must resume before scanning.",
      },
      409,
    );
  }
  if (po.status === "CANCELLED") {
    return c.json(
      {
        success: false,
        code: "PO_CANCELLED",
        error: "This Production Order has been cancelled and cannot be scanned.",
      },
      409,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const { deptCode, workerId } = (body || {}) as {
    deptCode?: string;
    workerId?: string;
  };
  // (force flag removed 2026-06-08 — prerequisite warning gone, no force path)
  if (!deptCode || !workerId) {
    return c.json(
      { success: false, error: "deptCode and workerId are required" },
      400,
    );
  }
  // Only the two departments that use one-sticker-per-variant fan-out. Reject
  // everything else so a stray FG-<DEPT> sentinel can't bulk-complete a
  // bedframe/wood chain that is supposed to be scanned per piece.
  if (deptCode !== "FAB_CUT" && deptCode !== "FAB_SEW") {
    return c.json(
      {
        success: false,
        code: "DEPT_NOT_SUPPORTED",
        error: `scan-complete-dept only supports FAB_CUT / FAB_SEW (got ${deptCode}).`,
      },
      400,
    );
  }

  // Worker-auth binding — identical to /scan-complete. ctxUserId was already
  // resolved at the top of the handler (to gate the RBAC check); reuse it.
  const workerToken = c.req.header("x-worker-token");
  if (!ctxUserId) {
    const resolvedWorkerId = await resolveWorkerToken(db, workerToken);
    if (!resolvedWorkerId || resolvedWorkerId !== workerId) {
      return c.json(
        {
          success: false,
          error:
            "Worker auth mismatch — workerId does not match the session token.",
          code: "AUTH_MISMATCH",
        },
        403,
      );
    }
  }
  const worker = await db
    .prepare("SELECT id, name FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ id: string; name: string }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // The compartment set for this variant in this department. COMPLETED cards are
  // KEPT (only TRANSFERRED excluded) so a 2nd different worker can co-sign as
  // PIC2 even after the 1st worker's scan already completed the card — owner
  // 2026-06-26 removed the single-PIC restriction: every dept allows two people
  // to scan while a PIC slot is open (Fab Cut / Fab Sew used to be 1-PIC because
  // completed cards were filtered out here). Same-worker rescan stays a no-op
  // (the slot loop below skips a slot this worker already holds).
  const cardsRes = await db
    .prepare(
      "SELECT * FROM job_cards WHERE productionOrderId = ? AND departmentCode = ? AND status <> 'TRANSFERRED'",
    )
    .bind(poId, deptCode)
    .all<JobCardRow>();
  const cards = cardsRes.results ?? [];
  if (cards.length === 0) {
    const freshEmpty = await fetchPO(db, poId);
    return c.json({
      success: true,
      data: {
        deptCode,
        completedJcIds: [],
        completedCount: 0,
        alreadyComplete: true,
        workerName: worker.name,
        po: freshEmpty,
      },
    });
  }

  // Prerequisite gate — soft-warn (202) if ANY compartment's upstream dept
  // hasn't completed, unless the worker already acknowledged and re-posted
  // with force:true. Mirrors /scan-complete's single-card gate.
  // prerequisiteMet warning REMOVED (Wei Siang 2026-06-08) — workers may
  // complete any dept directly; no "earlier dept hasn't completed" gate.

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  const completedJcIds: string[] = [];

  for (const jc of cards) {
    await ensurePiecePicsForJc(db, jc);
    // Two-person fill, mirroring scan-complete-shared (owner 2026-06-26 — no
    // more single-PIC on any dept): for each piece slot, fill PIC1 if open; else
    // if PIC1 is a DIFFERENT worker and PIC2 is open, this worker co-signs as
    // PIC2 (minutes split 50/50 at read time); a slot this worker already holds,
    // or one whose PIC1+PIC2 are both other people, is left untouched.
    const slotsRes = await db
      .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
      .bind(jc.id)
      .all<PiecePicRow>();
    for (const slot of slotsRes.results ?? []) {
      if (!slot.pic1Id) {
        await db
          .prepare(
            `UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, completedAt = ?, lastScanAt = ? WHERE id = ?`,
          )
          .bind(worker.id, worker.name, nowIso, nowIso, slot.id)
          .run();
      } else if (slot.pic1Id !== worker.id && !slot.pic2Id) {
        await db
          .prepare(
            `UPDATE piece_pics SET pic2Id = ?, pic2Name = ?, lastScanAt = ? WHERE id = ?`,
          )
          .bind(worker.id, worker.name, nowIso, slot.id)
          .run();
      }
    }

    const allSlotsRes = await db
      .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
      .bind(jc.id)
      .all<PiecePicRow>();
    const slotList = allSlotsRes.results ?? [];
    const allPiecesDone = slotList.length > 0 && slotList.every((s) => !!s.pic1Id);

    const mergedJc: JobCardRow = { ...jc };
    let jcJustCompleted = false;
    if (allPiecesDone && jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") {
      mergedJc.status = "COMPLETED";
      mergedJc.completedDate = today;
      mergedJc.overdue = "COMPLETED";
      jcJustCompleted = true;
    } else if (jc.status === "WAITING") {
      mergedJc.status = "IN_PROGRESS";
    }
    // Card-level PIC1/PIC2 = the DISTINCT people who scanned the pieces (Wei Siang
    // 2026-06-07: same person across pieces → PIC1 only; two people → PIC1 + PIC2,
    // each did a piece). Collect distinct workers across every slot's pic1/pic2,
    // keep the first two in scan order. Recomputed each scan so the card always
    // shows who actually did the work — never a stale single PIC.
    if (slotList.length > 0) {
      const piecePeople: { id: string; name: string }[] = [];
      for (const s of slotList) {
        for (const person of [
          { id: s.pic1Id, name: s.pic1Name },
          { id: s.pic2Id, name: s.pic2Name },
        ]) {
          if (person.id && !piecePeople.some((p) => p.id === person.id)) {
            piecePeople.push({ id: person.id, name: person.name ?? "" });
          }
        }
      }
      mergedJc.pic1Id = piecePeople[0]?.id ?? null;
      mergedJc.pic1Name = piecePeople[0]?.name ?? "";
      mergedJc.pic2Id = piecePeople[1]?.id ?? null;
      mergedJc.pic2Name = piecePeople[1]?.name ?? "";
    }

    await db
      .prepare(
        `UPDATE job_cards SET status = ?, completedDate = ?, overdue = ?,
           pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ?, updated_at = NOW() WHERE id = ?`,
      )
      .bind(
        mergedJc.status,
        mergedJc.completedDate,
        mergedJc.overdue,
        mergedJc.pic1Id,
        mergedJc.pic1Name ?? "",
        mergedJc.pic2Id,
        mergedJc.pic2Name ?? "",
        mergedJc.id,
      )
      .run();

    scheduleFireAndForget(c, fireAndForgetSyncJc(c, mergedJc, po));

    if (jcJustCompleted) {
      const siblings = await db
        .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
        .bind(poId)
        .all<JobCardRow>();
      await applyWipInventoryChange(
        db,
        po,
        mergedJc,
        "COMPLETED",
        siblings.results ?? [],
        jc.status,
        { orgId: scanOrgId(c), source: "SCAN" },
      );
      await postJobCardLabor(db, mergedJc.id, poId);
      completedJcIds.push(mergedJc.id);
    }
  }

  // ---- PO rollup + SO/CO cascade — run ONCE (mirror /scan-complete) ---------
  const poJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(poId)
    .all<JobCardRow>();
  const poJcs = poJcsRes.results ?? [];
  const deptRank = (code: string | null | undefined): number => {
    const idx = DEPT_ORDER.indexOf((code ?? "") as (typeof DEPT_ORDER)[number]);
    return idx >= 0 ? idx : DEPT_ORDER.length;
  };
  const frontier = poJcs
    .filter((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED")
    .reduce<JobCardRow | null>((earliest, j) => {
      if (!earliest) return j;
      return deptRank(j.departmentCode) < deptRank(earliest.departmentCode)
        ? j
        : earliest;
    }, null);
  const newCurrentDept = frontier?.departmentCode || "PACKING";
  await db
    .prepare(
      `UPDATE production_orders SET currentDepartment = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(newCurrentDept, nowIso, poId)
    .run();

  let recomputed: Awaited<ReturnType<typeof recomputePoStatusAndProgress>> | null = null;
  try {
    recomputed = await recomputePoStatusAndProgress(db, poId);
  } catch (err) {
    console.error("[recomputePoStatusAndProgress] scan-complete-dept failed", {
      poId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (recomputed?.after?.status === "COMPLETED") {
    await postProductionOrderCompletion(db, poId);
    await cascadePoCompletionToSO(db, po.salesOrderId);
    await cascadePoCompletionToCO(db, po.consignmentOrderId);
  }
  await cascadeUpholsteryToSO(db, poId);
  await cascadeUpholsteryToCO(db, poId);

  await invalidateProductionCachesAfterScan(c);

  const freshPo = await fetchPO(db, poId);
  return c.json({
    success: true,
    data: {
      deptCode,
      completedJcIds,
      completedCount: completedJcIds.length,
      workerName: worker.name,
      po: freshPo,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/:id/scan-complete-shared
//
// The shared Sew/Uph sticker — the EXISTING per-variant Fabric Sewing sticker
// (one QR per sofa variant / bedframe piece). The QR carries only `po` (the
// variant's own production order); the completing DEPARTMENT is decided by WHO
// scans, from their Employee-Master dept coverage:
//   - Sewing section (covers FAB_SEW / FAB_CUT — the cut+sew group cross within
//     their section) → completes this variant's FABRIC SEWING. One scan fans
//     out across every compartment card (BASE + CUSHION + ARMREST) of FAB_SEW
//     on the PO; sewing is ALSO 2-person now (1st = pic1, 2nd different worker
//     = pic2, minutes split 50/50) — owner 2026-06-26 removed the single-PIC
//     rule everywhere, so the slot loop fills pic2 the same as upholstery.
//   - Upholstery section (covers UPHOLSTERY) → completes this variant's
//     UPHOLSTERY, same per-PO fan-out. Upholstery MAY be shared: 1st worker =
//     pic1, a 2nd different worker = pic2 (minutes split 50/50 at read time),
//     a 3rd = PIC_FULL.
// Each sofa variant is its OWN production_orders row, so the (po, dept) fan-out
// completes ONLY that variant — never a sibling variant on the same customer PO.
// Order protection: an UPHOLSTERY scan is blocked until ALL of this variant's
// FAB_SEW cards are COMPLETED ("Sewing not done yet"). The whole SO flips to
// Ready-to-ship via cascadeUpholstery* once every variant's upholstery is done.
// Body: { workerId, force? }. Worker-token only (auth-middleware opens just this
// POST for X-Worker-Token callers); the worker-token binding below is the gate.
// ---------------------------------------------------------------------------
app.post("/:id/scan-complete-shared", async (c) => {
  const db = c.var.DB;
  const poId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { workerId } = (body || {}) as { workerId?: string };
  // (force flag removed 2026-06-08 — prerequisite warning gone, no force path)
  // Per-compartment + per-piece refinement (the new shared "wk" sticker). Both
  // optional and ADDITIVE — an older shared sticker that carries neither keeps
  // the whole-dept, all-pieces fan-out below exactly as before, so stickers
  // already printed on the shop floor still scan and complete.
  //   - wipKey : complete ONLY the compartment card with this wipKey (e.g. just
  //     the Divan, not the Headboard that shares the same bedframe PO) instead
  //     of every card of the resolved department.
  //   - pieceNo: bind ONLY this physical piece's slot — a qty=2 Divan prints two
  //     stickers (p=1 / p=2); each completes one piece and the card finishes
  //     once both pieces have been scanned.
  // NOTE: a SOFA compartment (wipType SOFA_*) is the EXCEPTION — its base/cushion/
  // armrest are sewn together as one variant, so wipKey/pieceNo are cleared after
  // the wipType peek below and it fans out to the whole dept (see there).
  let wipKey =
    typeof body?.wipKey === "string" && body.wipKey.length > 0
      ? body.wipKey
      : undefined;
  const rawPieceNo = Number(body?.pieceNo);
  let pieceNo =
    Number.isFinite(rawPieceNo) && rawPieceNo > 0 ? rawPieceNo : undefined;
  if (!workerId) {
    return c.json({ success: false, error: "workerId is required" }, 400);
  }

  // Worker-auth binding (mirrors scan-complete-dept). No dashboard userId →
  // bind body.workerId to the x-worker-token so a worker can't post "as" someone
  // else.
  const ctxUserId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  );
  if (ctxUserId) {
    // Dashboard caller — gate on RBAC (mirrors scan-complete-dept).
    const denied = await requirePermission(c, "production-orders", "create");
    if (denied) return denied;
  } else {
    // Shop-floor worker — bind body.workerId to the x-worker-token.
    const workerToken = c.req.header("x-worker-token");
    const resolvedWorkerId = await resolveWorkerToken(db, workerToken);
    if (!resolvedWorkerId || resolvedWorkerId !== workerId) {
      return c.json(
        {
          success: false,
          error:
            "Worker auth mismatch — workerId does not match the session token.",
          code: "AUTH_MISMATCH",
        },
        403,
      );
    }
  }

  const worker = await db
    .prepare(
      "SELECT id, name, departmentCode, departmentCodes FROM workers WHERE id = ?",
    )
    .bind(workerId)
    .first<{
      id: string;
      name: string;
      departmentCode: string | null;
      departmentCodes: string | null;
    }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // SOFA exception: a sofa BASE compartment represents the WHOLE variant — its
  // base, cushions and armrests are sewn together by one worker (Wei Siang
  // 2026-06-07: scan 1A → 1A's base + armrest + back-cushion complete together).
  // The base sticker carries the base's own wipKey so the PHONE resolves it to a
  // single card (no Divan-vs-HB-style chooser), but COMPLETION must fan out to
  // every FAB_SEW / UPHOLSTERY card of the variant. Detect a sofa compartment by
  // its wipType (SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST / SOFA_HEADREST) and drop
  // the per-compartment + per-piece scoping so the whole-dept fan-out runs.
  // Bedframe pieces (DIVAN / HEADBOARD) are NOT SOFA_* — they keep per-piece
  // scoping and stay separately scannable.
  if (wipKey) {
    const wkProbe = await db
      .prepare(
        "SELECT wipType FROM job_cards WHERE productionOrderId = ? AND wipKey = ? LIMIT 1",
      )
      .bind(poId, wipKey)
      .first<{ wipType: string | null }>();
    if ((wkProbe?.wipType || "").toUpperCase().startsWith("SOFA_")) {
      wipKey = undefined;
      pieceNo = undefined;
    }
  }

  // Resolve the scanning SECTION → target department. Cut+Sew workers (女部)
  // cross within their section, so anyone covering FAB_SEW or FAB_CUT (and NOT
  // upholstery) is the Sewing side; an UPHOLSTERY worker is the Upholstery side.
  let deptCodes: string[] = [];
  try {
    const arr = worker.departmentCodes ? JSON.parse(worker.departmentCodes) : null;
    if (Array.isArray(arr)) {
      deptCodes = arr.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
    }
  } catch {
    /* fall back to single code below */
  }
  if (deptCodes.length === 0 && worker.departmentCode) {
    deptCodes = [worker.departmentCode];
  }
  const wk = { departmentCode: worker.departmentCode, departmentCodes: deptCodes };
  const isSewSection =
    workerCoversDept(wk, "FAB_SEW") || workerCoversDept(wk, "FAB_CUT");
  // Wei Siang 2026-06-08: the floor splits into a Sewing section (Fabric Cutting
  // + Fabric Sewing) and "everyone else". A shared compartment sticker completes
  // FAB_SEW when a Sewing-section worker scans it; ANY OTHER worker (Upholstery,
  // Framing, Foam, Packing, …) completes UPHOLSTERY. Previously a worker in
  // neither named section got a 403 — wrong; they should land on UPHOLSTERY.
  // The shared sew/uph sticker resolves the department STRICTLY from the
  // worker's own section (Wei Siang 2026-06-15): a Sewing-section worker (女工部)
  // ONLY ever completes FAB_SEW; everyone else (男工部 — Upholstery, Framing,
  // Foam, …) completes UPHOLSTERY. It NEVER auto-jumps to Upholstery just
  // because FAB_SEW is already done — a sew scan on a full/finished card now
  // reports "already done / full", not a silent jump to the next department.
  const targetDept: "FAB_SEW" | "UPHOLSTERY" = isSewSection
    ? "FAB_SEW"
    : "UPHOLSTERY";
  const targetDeptLabel =
    targetDept === "FAB_SEW" ? "Fabric Sewing" : "Upholstery";

  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }
  if (po.status === "ON_HOLD") {
    return c.json(
      {
        success: false,
        code: "PO_ON_HOLD",
        error: "This Production Order is ON_HOLD. Supervisor must resume before scanning.",
      },
      409,
    );
  }
  if (po.status === "CANCELLED") {
    return c.json(
      {
        success: false,
        code: "PO_CANCELLED",
        error: "This Production Order has been cancelled and cannot be scanned.",
      },
      409,
    );
  }

  // All not-yet-done cards of the resolved department on this PO. For sofa each
  // variant is its OWN production_orders row, so this completes the WHOLE
  // variant's dept in one scan (BASE + CUSHION + ARMREST), never another
  // variant — mirrors scan-complete-dept's (po, dept) fan-out.
  // wipKey narrows to the single compartment card; without it, every card of
  // the resolved dept on this PO (legacy whole-variant fan-out).
  const cardsRes = await db
    .prepare(
      wipKey
        ? "SELECT * FROM job_cards WHERE productionOrderId = ? AND departmentCode = ? AND wipKey = ? AND status NOT IN ('COMPLETED','TRANSFERRED')"
        : "SELECT * FROM job_cards WHERE productionOrderId = ? AND departmentCode = ? AND status NOT IN ('COMPLETED','TRANSFERRED')",
    )
    .bind(...(wipKey ? [poId, targetDept, wipKey] : [poId, targetDept]))
    .all<JobCardRow>();
  const cards = cardsRes.results ?? [];
  if (cards.length === 0) {
    // No open cards of THIS worker's dept on this compartment → it's already
    // done. Report it for the worker's own dept (never advance to the next),
    // AND look up WHO did it from the finished cards' PIC slots so the amber
    // "already done" card still says by-whom (Wei Siang 2026-06-16).
    const doneRes = await db
      .prepare(
        wipKey
          ? "SELECT pp.pic1Name, pp.pic2Name FROM piece_pics pp JOIN job_cards jc ON jc.id = pp.jobCardId WHERE jc.productionOrderId = ? AND jc.departmentCode = ? AND jc.wipKey = ?"
          : "SELECT pp.pic1Name, pp.pic2Name FROM piece_pics pp JOIN job_cards jc ON jc.id = pp.jobCardId WHERE jc.productionOrderId = ? AND jc.departmentCode = ?",
      )
      .bind(...(wipKey ? [poId, targetDept, wipKey] : [poId, targetDept]))
      .all<{ pic1Name: string | null; pic2Name: string | null }>();
    const doneBy: string[] = [];
    for (const r of doneRes.results ?? []) {
      for (const nm of [r.pic1Name, r.pic2Name]) {
        const t = (nm || "").trim();
        if (t && !doneBy.includes(t)) doneBy.push(t);
      }
    }
    const freshEmpty = await fetchPO(db, poId);
    return c.json({
      success: true,
      data: {
        deptCode: targetDept,
        deptLabel: targetDeptLabel,
        completedJcIds: [],
        alreadyComplete: true,
        completedBy: doneBy,
        workerName: worker.name,
        po: freshEmpty,
      },
    });
  }

  // Order protection: Upholstery cannot start before this variant's Sewing is
  // fully done (every FAB_SEW card on the PO completed).
  if (targetDept === "UPHOLSTERY") {
    // Per-compartment order protection: this compartment's Upholstery waits on
    // ITS OWN Fabric Sewing (same wipKey), not the whole variant — so a finished
    // Divan can move to upholstery while the Headboard is still being sewn.
    // Without a wipKey (legacy sticker) it falls back to the PO-wide check.
    const sewOpen = await db
      .prepare(
        wipKey
          ? "SELECT 1 FROM job_cards WHERE productionOrderId = ? AND departmentCode = 'FAB_SEW' AND wipKey = ? AND status NOT IN ('COMPLETED','TRANSFERRED') LIMIT 1"
          : "SELECT 1 FROM job_cards WHERE productionOrderId = ? AND departmentCode = 'FAB_SEW' AND status NOT IN ('COMPLETED','TRANSFERRED') LIMIT 1",
      )
      .bind(...(wipKey ? [poId, wipKey] : [poId]))
      .first();
    if (sewOpen) {
      return c.json(
        {
          success: false,
          code: "SEWING_NOT_DONE",
          error: "Fabric Sewing for this item is not completed yet.",
        },
        409,
      );
    }
  }

  // prerequisiteMet warning REMOVED (Wei Siang 2026-06-08) — workers may
  // complete any dept directly; no "earlier dept hasn't completed" gate.

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  const completedJcIds: string[] = [];
  let anyFilled = false; // did this scan claim any slot on any card?
  let anyPicFull = false; // a card's pic1+pic2 already taken by other people
  // Distinct people who have scanned these cards — for the "completed by …"
  // message (Wei Siang 2026-06-15: completion must say BY WHOM).
  const completedBy = new Map<string, string>();

  // One scan fans out across EVERY compartment card of this dept on the PO.
  // Both Fabric Sewing and Upholstery are 2-person: the 1st scan fills pic1,
  // a 2nd different worker joins as pic2 (minutes split 50/50 at read time);
  // a 3rd different worker is rejected with PIC_FULL.
  for (const card of cards) {
    await ensurePiecePicsForJc(db, card);
    const slotsRes = await db
      .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
      .bind(card.id)
      .all<PiecePicRow>();
    // Per-piece: a "wk" sticker carries p=<pieceNo>, so bind ONLY that physical
    // piece's slot. Without pieceNo (legacy sticker) fill every slot at once.
    // Completion is still judged over ALL slots (allSlotsRes below), so the card
    // only flips COMPLETED once every piece has been scanned.
    const slotsToFill =
      pieceNo != null
        ? (slotsRes.results ?? []).filter((s) => s.pieceNo === pieceNo)
        : (slotsRes.results ?? []);
    let filled = false;
    for (const slot of slotsToFill) {
      if (!slot.pic1Id) {
        await db
          .prepare(
            "UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, completedAt = ?, lastScanAt = ? WHERE id = ?",
          )
          .bind(worker.id, worker.name, nowIso, nowIso, slot.id)
          .run();
        filled = true;
      } else if (slot.pic1Id === worker.id) {
        // same worker re-scanning this slot — no-op.
      } else if (!slot.pic2Id) {
        // 2nd worker joins as pic2. BOTH FAB_SEW and UPHOLSTERY are 2-person
        // (Wei Siang 2026-06-15: 女工部 Fabric Sewing can be scanned by 2);
        // minutes split 50/50 at read time.
        await db
          .prepare(
            "UPDATE piece_pics SET pic2Id = ?, pic2Name = ?, lastScanAt = ? WHERE id = ?",
          )
          .bind(worker.id, worker.name, nowIso, slot.id)
          .run();
        filled = true;
      } else if (slot.pic2Id && slot.pic2Id !== worker.id) {
        // Both slots taken by OTHER people → this dept's 2 places are full.
        anyPicFull = true;
      }
    }
    if (filled) anyFilled = true;

    const allSlotsRes = await db
      .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
      .bind(card.id)
      .all<PiecePicRow>();
    const slotList = allSlotsRes.results ?? [];
    const allPiecesDone =
      slotList.length > 0 && slotList.every((s) => !!s.pic1Id);
    const mergedJc: JobCardRow = { ...card };
    let jcJustCompleted = false;
    if (
      allPiecesDone &&
      card.status !== "COMPLETED" &&
      card.status !== "TRANSFERRED"
    ) {
      mergedJc.status = "COMPLETED";
      mergedJc.completedDate = today;
      mergedJc.overdue = "COMPLETED";
      jcJustCompleted = true;
    } else if (card.status === "WAITING" && filled) {
      mergedJc.status = "IN_PROGRESS";
    }
    // Card-level PIC1/PIC2 = the DISTINCT people who scanned the pieces (Wei Siang
    // 2026-06-07: same person across pieces → PIC1 only; two people → PIC1 + PIC2,
    // each did a piece). Collect distinct workers across every slot's pic1/pic2,
    // keep the first two in scan order. Recomputed each scan so the card always
    // shows who actually did the work — never a stale single PIC.
    if (slotList.length > 0) {
      const piecePeople: { id: string; name: string }[] = [];
      for (const s of slotList) {
        for (const person of [
          { id: s.pic1Id, name: s.pic1Name },
          { id: s.pic2Id, name: s.pic2Name },
        ]) {
          if (person.id && !piecePeople.some((p) => p.id === person.id)) {
            piecePeople.push({ id: person.id, name: person.name ?? "" });
          }
        }
      }
      mergedJc.pic1Id = piecePeople[0]?.id ?? null;
      mergedJc.pic1Name = piecePeople[0]?.name ?? "";
      mergedJc.pic2Id = piecePeople[1]?.id ?? null;
      mergedJc.pic2Name = piecePeople[1]?.name ?? "";
      for (const p of piecePeople) if (p.id) completedBy.set(p.id, p.name);
    }

    if (filled || jcJustCompleted) {
      await db
        .prepare(
          `UPDATE job_cards SET status = ?, completedDate = ?, overdue = ?,
             pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ?, updated_at = NOW() WHERE id = ?`,
        )
        .bind(
          mergedJc.status,
          mergedJc.completedDate,
          mergedJc.overdue,
          mergedJc.pic1Id,
          mergedJc.pic1Name ?? "",
          mergedJc.pic2Id,
          mergedJc.pic2Name ?? "",
          mergedJc.id,
        )
        .run();
      scheduleFireAndForget(c, fireAndForgetSyncJc(c, mergedJc, po));
    }

    if (jcJustCompleted) {
      const siblings = await db
        .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
        .bind(poId)
        .all<JobCardRow>();
      await applyWipInventoryChange(
        db,
        po,
        mergedJc,
        "COMPLETED",
        siblings.results ?? [],
        card.status,
        { orgId: scanOrgId(c), source: "SCAN" },
      );
      await postJobCardLabor(db, mergedJc.id, poId);
      completedJcIds.push(mergedJc.id);
    }
  }

  const completedByNames = [...completedBy.values()].filter(Boolean);

  if (!anyFilled) {
    if (anyPicFull) {
      // Both of this dept's 2 places are already taken by other people — tell
      // the worker which dept is full and BY WHOM, never jump to another dept.
      const who = completedByNames.join(" + ");
      return c.json(
        {
          success: false,
          code: "PIC_FULL",
          error: who
            ? `This item's ${targetDeptLabel} already has 2 people (${who}).`
            : `This item's ${targetDeptLabel} already has 2 people.`,
          data: {
            deptCode: targetDept,
            deptLabel: targetDeptLabel,
            completedBy: completedByNames,
          },
        },
        409,
      );
    }
    const freshEmpty = await fetchPO(db, poId);
    return c.json({
      success: true,
      data: {
        deptCode: targetDept,
        deptLabel: targetDeptLabel,
        completedJcIds: [],
        alreadyComplete: true,
        completedBy: completedByNames,
        workerName: worker.name,
        po: freshEmpty,
      },
    });
  }

  // --- PO rollup + SO/CO cascade (mirror scan-complete-dept tail) ---
  const poJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(poId)
    .all<JobCardRow>();
  const poJcs = poJcsRes.results ?? [];
  const deptRank = (code: string | null | undefined): number => {
    const idx = DEPT_ORDER.indexOf((code ?? "") as (typeof DEPT_ORDER)[number]);
    return idx >= 0 ? idx : DEPT_ORDER.length;
  };
  const frontier = poJcs
    .filter((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED")
    .reduce<JobCardRow | null>((earliest, j) => {
      if (!earliest) return j;
      return deptRank(j.departmentCode) < deptRank(earliest.departmentCode)
        ? j
        : earliest;
    }, null);
  const newCurrentDept = frontier?.departmentCode || "PACKING";
  await db
    .prepare(
      `UPDATE production_orders SET currentDepartment = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(newCurrentDept, nowIso, poId)
    .run();

  let recomputed: Awaited<ReturnType<typeof recomputePoStatusAndProgress>> | null =
    null;
  try {
    recomputed = await recomputePoStatusAndProgress(db, poId);
  } catch (err) {
    console.error("[recomputePoStatusAndProgress] scan-complete-shared failed", {
      poId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (recomputed?.after?.status === "COMPLETED") {
    await postProductionOrderCompletion(db, poId);
    await cascadePoCompletionToSO(db, po.salesOrderId);
    await cascadePoCompletionToCO(db, po.consignmentOrderId);
  }
  await cascadeUpholsteryToSO(db, poId);
  await cascadeUpholsteryToCO(db, poId);

  await invalidateProductionCachesAfterScan(c);

  const freshPo = await fetchPO(db, poId);
  return c.json({
    success: true,
    data: {
      deptCode: targetDept,
      deptLabel: targetDeptLabel,
      completedJcIds,
      completedCount: completedJcIds.length,
      completedBy: completedByNames,
      workerName: worker.name,
      po: freshPo,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/:id
//
// ?fresh=1 branch: cache-bypassing single-PO read in the SAME minimal shape the
// list returns. Reads the one PO + its job_cards straight from the DB (no KV,
// no withSnapshot / serve-stale) so a freshly-written PIC / completion can be
// shown deterministically right after the write — the list's serve-stale
// snapshot keeps handing back the pre-write row for the ~1-3 min rebuild window
// (the "flicker" patched 8× via the cache pin). The Production page calls this
// for the one PO it just edited and merges the fresh row over the grid.
// Gated on the same read permission as the job-cards GET (the nearest sibling
// that reads this exact data) — production-orders:read, satisfied by *:read.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/production-orders/board — the /m mobile Production board (perf
// 2026-07-14). The mobile board (src/pages/m/screens/ProductionScreen.tsx) used
// to pull the whole ~1.6MB `?fields=minimal&include=` payload (all 1921 POs) and
// then hide the ~1543 COMPLETED/CANCELLED ones + strip to ~11 rendered fields
// client-side. This returns ONLY the live board set server-side, slimmed to the
// exact fields the board renders — measured live: 1921→378 rows, ~1.6MB→~125KB.
//
// Live filter = the board's own client rule VERBATIM: status NOT IN
// ('COMPLETED','CANCELLED') — keeps TRANSFERRED/ON_HOLD/etc. (so it is NOT the
// list's excludeCompleted, which also drops TRANSFERRED + keeps 35-day-completed).
// customerSO is filled via the SAME attachCustomerSO the list payload runs, so the
// board's search over it is unchanged. companySO + picName are dropped: both are
// ALWAYS empty on this data (0/378 populated) — the board rendered/searched blanks.
//
// NO dead-data risk: the client keeps its search + per-dept counts over the WHOLE
// returned set (all 378 live rows are loaded — nothing is paginated away). Keyset
// (src/api/lib/keyset.ts, now in place) is the answer IF the live WIP set ever
// grows to thousands; at a few hundred, all-loaded-slim is correct + can't hide a
// record. Snapshot-cached + serve-stale so the phone's cold paint never blocks.
// ---------------------------------------------------------------------------
app.get("/board", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS production_board_snapshot (
         org_id        TEXT NOT NULL,
         cache_key     TEXT NOT NULL DEFAULT '',
         data          JSONB NOT NULL,
         built_from    TIMESTAMP NOT NULL,
         built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
         refresh_count INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (org_id, cache_key)
       )`,
    )
    .run();

  const { withSnapshot } = await import("../lib/snapshot");
  const data = await withSnapshot<{ items: unknown[] }>(
    db,
    {
      tableName: "production_board_snapshot",
      // POs change the set; sales_orders / consignment_orders feed customerSO
      // via attachCustomerSO, so a customerSO edit must invalidate too.
      sourceTables: ["production_orders", "sales_orders", "consignment_orders"],
    },
    orgId,
    async () => {
      const res = await db
        .prepare(
          `SELECT id, poNo, status, productCode, productName, customerName,
                  companySOId, salesOrderId, consignmentOrderId, quantity,
                  targetEndDate, currentDepartment, created_at
             FROM production_orders
            WHERE orgId = ?
              AND status NOT IN ('COMPLETED','CANCELLED')
            ORDER BY created_at DESC, id DESC`,
        )
        .bind(orgId)
        .all<{
          id: string;
          poNo: string;
          status: string;
          productCode: string | null;
          productName: string | null;
          customerName: string | null;
          companySOId: string | null;
          salesOrderId: string | null;
          consignmentOrderId: string | null;
          quantity: number | null;
          targetEndDate: string | null;
          currentDepartment: string | null;
        }>();
      const rows = (res.results ?? []).map((r) => ({
        ...r,
        salesOrderId: r.salesOrderId ?? "",
        consignmentOrderId: r.consignmentOrderId ?? "",
        customerSO: "",
      }));
      // Fill customerSO exactly like the list payload does.
      await attachCustomerSO(db, rows);
      const items = rows.map((r) => ({
        id: r.id,
        poNo: r.poNo,
        status: r.status,
        productCode: r.productCode ?? "",
        productName: r.productName ?? "",
        customerName: r.customerName ?? "",
        companySOId: r.companySOId ?? "",
        customerSO: r.customerSO ?? "",
        quantity: r.quantity ?? 0,
        targetEndDate: r.targetEndDate ?? "",
        currentDepartment: r.currentDepartment ?? "",
      }));
      return { items };
    },
    "",
    c,
    { staleWhileRevalidate: true },
  );

  return c.json({ success: true, data: data.items });
});

// GET /api/production-orders/scan-lookup?code=X — resolve a scanned code (a
// job-card id, a PO number, or a PO id) to the ONE matching order + its job
// cards, instead of downloading the whole ~22MB list just to find one (perf
// 2026-07-31). Returns the same { success, data: [order] } shape the scan page
// already iterates, so its matching logic is untouched. An exact-key lookup
// still finds ANY order incl. completed, so the scan flow is unchanged.
// Registered BEFORE /:id so "scan-lookup" isn't captured as an :id.
app.get("/scan-lookup", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const code = (c.req.query("code") ?? "").trim();
  if (!code) return c.json({ success: true, data: [] });
  let poId: string | null = null;
  // 1) a scanned job-card sticker → its production order
  const jc = await db
    .prepare("SELECT productionOrderId FROM job_cards WHERE id = ? LIMIT 1")
    .bind(code)
    .first<{ productionOrderId: string }>();
  if (jc?.productionOrderId) poId = jc.productionOrderId;
  // 2) a PO number (case-insensitive) or a PO id
  if (!poId) {
    const po = await db
      .prepare(
        "SELECT id FROM production_orders WHERE id = ? OR LOWER(poNo) = LOWER(?) LIMIT 1",
      )
      .bind(code, code)
      .first<{ id: string }>();
    if (po?.id) poId = po.id;
  }
  if (!poId) return c.json({ success: true, data: [] });
  const order = await fetchPO(db, poId);
  if (!order) return c.json({ success: true, data: [] });
  await attachCustomerSO(
    db,
    [order] as unknown as Array<{
      salesOrderId: string;
      consignmentOrderId: string;
      customerSO: string;
    }>,
  );
  return c.json({ success: true, data: [order] });
});

app.get("/:id", async (c) => {
  if (c.req.query("fresh") === "1") {
    const denied = await requirePermission(c, "production-orders", "read");
    if (denied) return denied;
    const orgId = getOrgId(c);
    const deptParamRaw = c.req.query("dept");
    const deptFilter =
      deptParamRaw && deptParamRaw.trim().length > 0
        ? deptParamRaw.trim().toUpperCase()
        : null;
    const fresh = await fetchFreshMinimalPO(
      c.var.DB,
      orgId,
      c.req.param("id"),
      deptFilter,
    );
    if (!fresh) {
      return c.json(
        { success: false, error: "Production order not found" },
        404,
      );
    }
    // Same Customer SO / PO / Ref / DD enrichment the list + plain GET run, so
    // the merged row carries identical joined fields (no blank Customer SO on
    // the freshly-merged row).
    await attachCustomerSO(
      c.var.DB,
      [fresh] as unknown as Array<{
        salesOrderId: string;
        consignmentOrderId: string;
        customerSO: string;
      }>,
    );
    return new Response(JSON.stringify({ success: true, data: fresh }), {
      status: 200,
      // Belt-and-braces: tell every intermediary this single-PO read is the
      // fresh source of truth and must not be cached.
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Cache": "BYPASS",
      },
    });
  }
  const po = await fetchPO(c.var.DB, c.req.param("id"));
  if (!po) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }
  // fetchPO does not batch-join the SO, so customerSO would be "" and
  // customerPOId / customerReference would carry only the (sparse) PO
  // snapshot. Run the same enrichment as the list endpoints so a single-PO
  // fetch resolves Customer SO / PO / Ref from the populated sales_orders
  // columns (mirrors commit 2c548b60 on the Delivery page).
  await attachCustomerSO(
    c.var.DB,
    [po] as Array<{
      salesOrderId: string;
      consignmentOrderId: string;
      customerSO: string;
    }>,
  );
  return c.json({ success: true, data: po });
});

// ---------------------------------------------------------------------------
// PUT /api/production-orders/:id
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /bulk-patch — Phase 2.5-B: batch endpoint for the frontend's debounced
// draft queue. Accepts an array of { poId, jobCardId, ...patchFields }, runs
// each as a self-loopback PATCH so the entire applyPoUpdate flow (auth,
// audit, cascade, cache bump) executes per-patch exactly as it would for a
// direct client request, and returns a per-patch success/error array.
//
// Why loopback fetch instead of refactoring applyPoUpdate to take body as a
// parameter:
//   * applyPoUpdate is 480 lines + threads Context for c.var.DB, getOrgId(c),
//     c.executionCtx, audit context, etc. A clean param-passing refactor is
//     ~1 day of careful surgery, with a real risk of regressing 153 audit
//     emissions and the SO/CO cascade hooks. Not worth it for the marginal
//     gain over loopback.
//   * Worker → Worker subrequests are intra-isolate (sub-100ms each), so
//     N loopbacks ≈ 1 outer HTTP + N intra-isolate work. The frontend
//     latency win is the round-trip avoidance, which loopback delivers.
//   * Cookie forwarding preserves auth so the loopback request lands at
//     authMiddleware → requirePermission → applyPoUpdate exactly as the
//     original direct PATCH would.
//
// Limits: max 50 patches per batch (Worker subrequest limit on Pro is 1000;
// 50 is conservative + matches typical UX — operators almost never batch
// more than 10-20 cells at a time).
//
// The /bulk-patch URL is mounted BEFORE /:id so Hono doesn't route
// "bulk-patch" into the PUT/PATCH /:id handler as poId="bulk-patch".
app.post("/bulk-patch", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);

  type IncomingPatch = {
    poId: string;
    jobCardId: string;
    [k: string]: unknown;
  };
  type RawBody = { patches?: unknown };

  let parsed: RawBody;
  try {
    parsed = (await c.req.json()) as RawBody;
  } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }
  const patches = Array.isArray(parsed.patches) ? (parsed.patches as IncomingPatch[]) : [];
  if (patches.length === 0) {
    return c.json({ success: false, error: "patches: non-empty array required" }, 400);
  }
  if (patches.length > 50) {
    return c.json({ success: false, error: "max 50 patches per batch" }, 400);
  }

  const baseUrl = new URL(c.req.url).origin;
  // Forward the Cookie header so the loopback request authenticates as the
  // same operator. Authorization header is also forwarded for any bearer-token
  // callers (worker-portal scan flow uses Bearer). X-CSRF-Token must also
  // forward — the inner PATCH /:id is a mutating method and the auth
  // middleware enforces the double-submit check (cookie + header must match);
  // without forwarding, every loopback fails 403 "CSRF token missing or
  // invalid". Operator hit this on a FAB_SEW PIC patch 2026-05-12.
  const cookie = c.req.header("Cookie") ?? "";
  const authHeader = c.req.header("Authorization") ?? "";
  const csrfHeader = c.req.header("X-CSRF-Token") ?? c.req.header("x-csrf-token") ?? "";

  const results = await Promise.all(
    patches.map(async (p) => {
      const { poId, jobCardId } = p;
      if (!poId || typeof poId !== "string" || !jobCardId || typeof jobCardId !== "string") {
        return { poId, jobCardId, success: false, error: "poId and jobCardId required" };
      }
      // Extract patch fields (everything except poId).
      const subBody: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) {
        if (k === "poId") continue;
        subBody[k] = v;
      }
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (cookie) headers["Cookie"] = cookie;
        if (authHeader) headers["Authorization"] = authHeader;
        if (csrfHeader) headers["X-CSRF-Token"] = csrfHeader;
        const res = await fetch(`${baseUrl}/api/production-orders/${encodeURIComponent(poId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(subBody),
        });
        if (res.ok) {
          return { poId, jobCardId, success: true };
        }
        let msg = `HTTP ${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: string } | null;
          if (errBody && typeof errBody.error === "string") msg = errBody.error;
        } catch {
          /* non-json error body */
        }
        return { poId, jobCardId, success: false, error: msg };
      } catch (err) {
        return {
          poId,
          jobCardId,
          success: false,
          error: err instanceof Error ? err.message : "network error",
        };
      }
    }),
  );

  // ── Verify-readback (Wei Siang verifiedSave 2026-05-25 rule) ────────────
  // After the PATCH loop succeeds for a row, the only thing that proves
  // the write actually persisted is a fresh SELECT from job_cards. The
  // batch Apply PIC silent-overwrite bug (BUG-2026-05-26-001) was
  // exactly this: PATCH returned 200, FE flipped to green, then the
  // post-snapshot refetch served pre-write data and the UI rolled
  // back to old PIC. With this readback, success: true here only
  // survives when the new value is what's actually in the DB.
  //
  // Heavy SELECT vs N+1: ONE query for every successful row in this
  // batch, columns scoped to the patchable fields. At max 50 patches
  // that's a single SELECT WHERE id IN (50 placeholders). Cheap.
  const successfulPatches = patches.filter((p, i) => results[i].success);
  if (successfulPatches.length > 0) {
    const ids = successfulPatches.map((p) => p.jobCardId);
    const placeholders = ids.map(() => "?").join(",");
    const readbackRes = await c.var.DB
      .prepare(
        // The readback MUST list every column applyPoUpdate can write,
        // otherwise the diff loop below reads `undefined` for an omitted
        // column and reports a false "verify-readback mismatch — X: tried
        // ..., db has undefined" even though the write persisted fine.
        // distributedAt (the "Sent to floor" tick), rackingNumber, overdue
        // and actualMinutes were missing here, so any bulk patch that set
        // one of them always reverted the cell on screen. Added 2026-06-02.
        `SELECT id, status, dueDate, completedDate, pic1Id, pic1Name, pic2Id, pic2Name,
                actualMinutes, rackingNumber, overdue, distributedAt
           FROM job_cards WHERE id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<{
        id: string;
        status: string | null;
        dueDate: string | null;
        completedDate: string | null;
        pic1Id: string | null;
        pic1Name: string | null;
        pic2Id: string | null;
        pic2Name: string | null;
        actualMinutes: number | null;
        rackingNumber: string | null;
        overdue: number | null;
        distributedAt: string | null;
      }>();
    const byId = new Map(
      (readbackRes.results ?? []).map((r) => [r.id, r] as const),
    );
    // null / undefined / "" all mean "empty" — same loose-equality rule as
    // verified-save.ts so a backend that returns "" for cleared text
    // matches a request that sent null.
    const looseEq = (a: unknown, b: unknown): boolean => {
      const norm = (v: unknown) =>
        v === null || v === undefined || v === "" ? null : v;
      return norm(a) === norm(b);
    };
    // Compute the requested-vs-actual diffs for ONE patch against ONE
    // readback row. Returns the human-readable diff strings (empty = match).
    type ReadbackRow = Record<string, unknown>;
    const diffPatch = (
      req: Record<string, unknown>,
      actual: ReadbackRow,
    ): string[] => {
      const diffs: string[] = [];
      for (const [k, v] of Object.entries(req)) {
        if (k === "poId" || k === "jobCardId" || k === "pic1Name" || k === "pic2Name") continue;
        const actualVal = (actual as Record<string, unknown>)[k];
        if (!looseEq(actualVal, v)) {
          diffs.push(`${k}: tried ${JSON.stringify(v)}, db has ${JSON.stringify(actualVal)}`);
        }
      }
      return diffs;
    };

    // First pass: walk every successful row and collect the ones whose
    // readback doesn't match. We do NOT fail them yet — the first SELECT
    // runs on the OUTER request's connection, which Hyperdrive can serve
    // from its read query cache: the loopback PATCH that wrote pic2_id ran
    // as a SEPARATE subrequest on a DIFFERENT connection, so the outer read
    // can land on a cached pre-write snapshot of the row (the textbook
    // read-after-write race across two connections). Symptom: the SECOND PIC
    // set on a card ("set PIC1 → ok, then set PIC2") spuriously reverts with
    // `pic2Id: tried "...", db has null`, and clicking again works — the
    // signature of a nondeterministic cache race, NOT a write bug.
    // BUG-2026-06-26-001.
    const mismatched: Array<{ idx: number; jcId: string; firstDiffs: string[] }> = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.success) continue;
      const req = patches[i] as Record<string, unknown>;
      const actual = byId.get(r.jobCardId);
      if (!actual) {
        results[i] = {
          ...r,
          success: false,
          error: "job_card disappeared after write — possible delete race",
        };
        continue;
      }
      const diffs = diffPatch(req, actual);
      if (diffs.length > 0) {
        mismatched.push({ idx: i, jcId: r.jobCardId, firstDiffs: diffs });
      }
    }

    // Second pass — ONE cache-bypassed re-read of only the mismatched rows.
    // Running the SELECT inside an explicit transaction (db.batch wraps the
    // statement in sql.begin) makes Hyperdrive treat it as non-cacheable, so
    // this re-read is forced back to the primary and sees the just-written
    // value. Only rows that STILL mismatch after the fresh read are genuine
    // write failures and get flipped to success:false — a true unpersisted
    // write surfaces exactly as before, while the read-after-write lag is
    // absorbed by the single retry. (No tight loop: one extra read is enough;
    // the lag is the cross-connection cache, not Postgres replication.)
    if (mismatched.length > 0) {
      const reIds = mismatched.map((m) => m.jcId);
      const rePlaceholders = reIds.map(() => "?").join(",");
      let reById = new Map<string, ReadbackRow>();
      try {
        const reReadBatch = await c.var.DB.batch<ReadbackRow>([
          c.var.DB
            .prepare(
              `SELECT id, status, dueDate, completedDate, pic1Id, pic1Name, pic2Id, pic2Name,
                      actualMinutes, rackingNumber, overdue, distributedAt
                 FROM job_cards WHERE id IN (${rePlaceholders})`,
            )
            .bind(...reIds),
        ]);
        const reRows = reReadBatch[0]?.results ?? [];
        reById = new Map(reRows.map((row) => [String(row.id), row] as const));
      } catch {
        // Re-read itself failed — fall back to the first-pass verdict so a
        // transient read blip can't mask a real mismatch.
        reById = new Map();
      }
      for (const m of mismatched) {
        const r = results[m.idx];
        const req = patches[m.idx] as Record<string, unknown>;
        const fresh = reById.get(m.jcId);
        // No fresh row (re-read failed / row vanished) → trust the first pass.
        const finalDiffs = fresh ? diffPatch(req, fresh) : m.firstDiffs;
        if (finalDiffs.length > 0) {
          results[m.idx] = {
            ...r,
            success: false,
            error: `verify-readback mismatch — ${finalDiffs.join("; ")}`,
          };
        }
      }
    }
  }

  return c.json({ success: true, results });
});

app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoUpdate(c, c.req.param("id"));
});

// ---------------------------------------------------------------------------
// PATCH /api/production-orders/:id — alias for PUT
// ---------------------------------------------------------------------------
app.patch("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoUpdate(c, c.req.param("id"));
});

// ---------------------------------------------------------------------------
// Per-PO Hold / Resume / Cancel — let the operator pause or kill ONE PO
// (one product line of an SO) without rebuilding the whole SO.
//
// Wei Siang's use case: an SO is split into many qty=1 POs (SOFA rule).
// Some POs are completed, others are still pending. The customer changes
// their mind and only wants part of the order. The operator needs to
// hold or cancel the still-pending ones, leaving the completed ones
// alone (they're real finished goods — see BUG-2026-05-28-004 memory).
//
// Rules:
//   HOLD   — only PENDING / IN_PROGRESS POs may be held. JCs are NOT
//            touched (the PATCH guards block writes against ON_HOLD POs
//            so JCs are passively frozen and resume cleanly).
//   RESUME — only ON_HOLD POs may resume. Flips back to PENDING; JCs
//            stay where they were.
//   CANCEL — only non-terminal POs may be cancelled (NOT COMPLETED,
//            NOT CANCELLED). All JCs under the PO that aren't
//            COMPLETED/TRANSFERRED flip to CANCELLED. Completed JCs
//            stay COMPLETED — re-dating finished work is wrong and
//            would orphan fg_units + cost_ledger entries.
// ---------------------------------------------------------------------------

app.post("/:id/hold", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoStatusChange(c, c.req.param("id"), "ON_HOLD");
});

app.post("/:id/resume", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoStatusChange(c, c.req.param("id"), "PENDING");
});

app.post("/:id/cancel", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoStatusChange(c, c.req.param("id"), "CANCELLED");
});

// UNCANCEL — undo a cancel (owner 2026-08-04: "i silap cancel").
//
// The PO returns to whatever it was before, and every job card THIS cancel
// took down returns to its own prior status. Cards cancelled for another
// reason keep theirs; completed work was never touched in the first place.
// Rows cancelled before pre_cancel_status existed land on PENDING, which just
// means the floor re-scans them.
app.post("/:id/uncancel", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoStatusChange(c, c.req.param("id"), "UNCANCEL");
});

// Re-export the original public helper surface so external importers
// (worker.ts, lib/consignment-note-shared.ts, tests) need no changes.
export {
  cascadeCNCompletionToCO,
  cascadeCNReversalToCO,
  ensurePiecePicsRackingColumn,
  rowToMinimalPO,
  warmPoListDeliveryVariant,
  warmPoListPlanningVariant,
  warmPoListDeptVariant,
} from "./production-orders/_helpers";
export {
  applyWipInventoryChange,
  attachCustomerSO,
  fetchFilteredPOs,
  recomputePoStatusAndProgress,
};
export type {
  JobCardRow,
  PiecePicRow,
  ProductionOrderRow,
};
export default app;

// ---------------------------------------------------------------------------
// Warm the overdue-counts snapshot for every dept + the Overview (dept=null).
//
// Health 2026-08-01 measured /api/production-orders/overdue-counts at p50
// 7,990ms and p95 30,010ms - i.e. HALF of all calls paid an ~8s cold recompute,
// and the slowest hit the client's 30s abort outright. Every dept page requests
// it on open, so this was a second cold-snapshot endpoint alongside the dept
// sheet fixed in #167 - the warm cron simply never covered it.
//
// Calls computeOverdueCounts directly with the cron's own context. It used to
// go through app.request("/overdue-counts") to guarantee the payload and cache
// key matched what the page reads — right instinct, but a synthetic sub-request
// gets an EMPTY c.var (the DB binding comes from middleware on the parent app),
// so every call threw and returned 500. Measured 2026-08-02, the warm cron's own
// output: {"overdueCounts":{"ok":false,"warmed":0,"failed":["overview:500",
// "FAB_CUT:500", … all ten]}}. It had never warmed a key since it shipped,
// which is why this endpoint stayed at p50 ~8s / p95 30s.
//
// The guarantee is kept a better way: both paths now call the SAME extracted
// function, so there is only one body and one cache key to begin with.
// ---------------------------------------------------------------------------
export async function warmOverdueCounts(
  c: Context<Env>,
  depts: readonly string[],
  /** The cron has no session — pass the tenant in, like every other warmer. */
  orgId: string,
): Promise<{ warmed: number; failed: string[] }> {
  const failed: string[] = [];
  let warmed = 0;
  // "" = the Overview variant (dept omitted), which the /production landing
  // page requests and which is the most expensive of the set.
  for (const dept of ["", ...depts]) {
    try {
      // dept is passed as an argument, not faked onto a synthetic request —
      // the context stays the real one, bindings and all.
      await computeOverdueCounts(c, dept || null, orgId);
      warmed++;
    } catch (e) {
      failed.push(`${dept || "overview"}:${e instanceof Error ? e.message : "throw"}`);
    }
  }
  return { warmed, failed };
}
