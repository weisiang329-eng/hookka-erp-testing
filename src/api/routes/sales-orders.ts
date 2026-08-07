// ---------------------------------------------------------------------------
// D1-backed sales-orders route.
//
// Mirrors the old src/api/routes/sales-orders.ts response shape so the SPA
// frontend does not need any changes. `items` is returned as a nested array
// joined from the sales_order_items table. Status history comes from
// so_status_changes and price-override history from price_overrides.
//
// Schema-note: D1 stores timestamps in `created_at`/`updated_at` (snake_case)
// while the TS types expose `createdAt`/`updatedAt` (camelCase). The row->API
// mapper handles the rename. `so_status_changes.autoActions` is a JSON blob.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { customerScopeSql, isCustomerScoped } from "../lib/customer-scope";
import { lateToCustomerOrders } from "../lib/kpi-metrics";
import { assertCustomerBillable } from "../lib/customer-stage";
import { emitAudit, buildAuditStatement } from "../lib/audit";
import { calculateUnitPrice, calculateLineTotal } from "../../lib/pricing";
import {
  hasMixedSofaBedframe,
  SO_MIXED_CATEGORY_ERROR,
  findInvalidSofaQty,
  formatSofaQtyError,
} from "../../lib/so-category";
import {
  addDays,
  loadHookkaDDBuffer,
  hookkaDDBufferFor,
  loadLeadTimes,
  leadDaysFor,
  loadLeadTimeSettings,
} from "../lib/lead-times";
import { loadAndValidatePOAlignment } from "../lib/po-alignment-validator";
import { resolveCustomerPriceAsOf } from "./customer-products";
import { runSofaComboPass } from "../lib/sofa-combo-pass";
import {
  snapItemToCatalog,
  loadProductCatalog,
} from "./_shared/item-catalog-snap";
import { withOrgScope, getOrgId } from "../lib/tenant";
import {
  resolveCompanyCode,
  readCompanyCode,
  classifyBatchReassign,
} from "../../lib/company-dimension";
import {
  invalidateHubChangeSnapshots,
  invalidateOrderCascadeSnapshots,
} from "../lib/snapshot";
import { bumpPoListCacheVersion } from "../lib/po-list-cache";
import { loadDeliveredItemsValueSen } from "../lib/do-value";
import {
  createProductionOrdersForOrder,
  type CreatedProductionOrder,
} from "./_shared/production-builder";
import { checkSalesOrderLocked, lockedResponse } from "../lib/lock-helpers";
import {
  createEditLockOverride,
  lookupActorDisplayName,
  MIN_OVERRIDE_REASON_LEN,
} from "../lib/edit-lock-override";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import {
  validateFabricCodes,
  unknownFabricCodeError,
} from "../lib/fabric-validation";
import {
  breakBomIntoWips,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";
import {
  validateSofaSizeLabels,
  unknownSofaSizeLabelError,
} from "../lib/sofa-size-validation";
import { resolveSpecialOrderPriceSen } from "../../lib/special-order-surcharge";
import { resolveHeightPriceSen } from "../../lib/height-surcharge";
import { resolveTotalHeightPriceSen } from "../../lib/total-height-surcharge";
import { loadSpecialsConfig, loadHeightsConfig } from "../lib/specials-config";
import { validateRepairScopeInput } from "../../lib/repair-scope";
import { buildOrderFootprint } from "../lib/order-footprint";

import {
  parseCustomSpecials,
  sanitizeCustomSpecials,
  serializeCustomSpecials,
  rowToSO,
  rowToSOList,
  soListToDeliveryRefs,
  findIncompleteBomProducts,
  rowToStatusChange,
  rowToPriceOverride,
  genSoId,
  genItemId,
  genStatusId,
  genOverrideId,
  createProductionOrdersForSO,
  generateCompanySOId,
  ensureCompanySOIdUnique,
  isDuplicateSoIdError,
  fetchSOWithItems,
  cascadeSOStatusToPOs,
  VALID_TRANSITIONS,
  CS_STATUSES,
  canonicalizeRepairScopesAgainstBom,
  ensurePendingMigrations,
  pushNewlyCreatedJobCardsToSheet,
} from "./sales-orders/_helpers";
import type {
  SalesOrderRow,
  SalesOrderItemRow,
  SOStatusChangeRow,
  PriceOverrideRow,
  SOListRefLike,
  SOCascadeResult,
} from "./sales-orders/_helpers";

// Re-export the helpers that external modules / tests import from this route
// module, so importers of ".../sales-orders" keep working with no changes.
export { createProductionOrdersForSO, soListToDeliveryRefs };
export type { SalesOrderRow, SalesOrderItemRow };

const app = new Hono<Env>();


// ---------------------------------------------------------------------------
// GET /api/sales-orders — list all SOs with nested items
//
// Query params (opt-in pagination; omitting them preserves backward-compatible
// "full list" behavior for legacy consumers):
//
//   ?page=N&limit=M
//     When either is supplied, response includes { page, limit } and `data`
//     is the sliced page. Default page=1, default limit=50, hard cap 500.
//     Uses SQL LIMIT/OFFSET on sales_orders, then scopes
//     sales_order_items to only the page's SO IDs — so a 50-row page no
//     longer pulls every SO item row.
//
//   ?includeArchive=true
//     Phase-5 historical-report hook. When set, UNION ALL hot + archive
//     (sales_orders + sales_orders_archive) before applying ORDER BY /
//     LIMIT. Default off. The archive has an extra `archivedAt` column
//     the hot table doesn't; we project an empty string for hot rows so
//     the UNION column lists line up, then drop the extra column in the
//     row mapper.
// ---------------------------------------------------------------------------
// GET /api/sales-orders — list (and optional archive view) of SOs.
//
// Phase C #1 quick-win: scoped to the active orgId via withOrgScope().
// THIS IS THE PATTERN the rest of the routes will follow as the multi-tenant
// rollout continues — see src/api/lib/tenant.ts:
//
//   const { whereSql, params } = withOrgScope(c, "<table>", "<extra-where>");
//   db.prepare(`SELECT * FROM <table> ${whereSql} ORDER BY ...`)
//     .bind(...params, ...other-binds);
//
// The orgId column was added in migration 0049 with a default of 'hookka',
// so this filter is a no-op in single-tenant mode but enforces isolation
// the moment a second tenant is seeded.
app.get("/", async (c) => {
  const db = c.var.DB;
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const includeArchive = c.req.query("includeArchive") === "true";
  // 0134 — Service Order vs Sales Order filter.
  //
  // ?isServiceOrder=true  → only Service Orders (the new /service-order list)
  // ?isServiceOrder=false → only normal Sales Orders (the default — the
  //                         legacy /sales list MUST never show service
  //                         orders, so when the query param is absent we
  //                         force it to false too).
  // ?isServiceOrder=all   → both (rare — admin/reporting only).
  //
  // The filter is added to the WHERE clause via an extra AND clause built
  // here and threaded into withOrgScope's extra-where slot. Snapshot
  // cache is bypassed whenever the filter is anything other than the
  // default (false) so we don't end up serving a service-orders list out
  // of the normal SO cache key.
  const isServiceOrderParam = c.req.query("isServiceOrder");
  const serviceOrderFilter: "true" | "false" | "all" =
    isServiceOrderParam === "true"
      ? "true"
      : isServiceOrderParam === "all"
        ? "all"
        : "false";

  // Union fragment used whenever includeArchive is on. `SELECT * FROM
  // sales_orders` is padded with a literal '' for archivedAt so the
  // column list matches the archive table. Kept as a CTE-ish inline
  // subquery rather than a real view so we stay in one-file-per-route.
  const soSourceSql = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM sales_orders
        UNION ALL
        SELECT * FROM sales_orders_archive)`
    : "sales_orders";

  const itemsSourceSql = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM sales_order_items
        UNION ALL
        SELECT * FROM sales_order_items_archive)`
    : "sales_order_items";

  // Tenant scope — first bind param on every query against soSourceSql.
  // Items are scoped transitively via salesOrderId IN (...) so they don't
  // need their own orgId filter (the archive table doesn't have orgId yet).
  const extraWhere =
    serviceOrderFilter === "true"
      ? "is_service_order = TRUE"
      : serviceOrderFilter === "false"
        ? "(is_service_order = FALSE OR is_service_order IS NULL)"
        : "";
  const { whereSql: orgWhere, params: orgParams } = withOrgScope(
    c,
    "sales_orders",
    extraWhere,
  );

  if (!paginate) {
    // 2026-05-23 perf fix: FK-scope the items fetch and drop the 5,000-row
    // cap. The previous unfiltered `SELECT * FROM sales_order_items
    // LIMIT 5000` shipped EVERY org's items (no orgId / FK filter) and
    // was capped at an arbitrary 5K rows — which both leaked data across
    // tenants and silently truncated payloads as the dataset grew.
    // The paginated branch below already uses the FK-scope pattern;
    // mirror it here via the same `salesOrderId IN (SELECT id FROM ...)`
    // subquery so the cache-aside path and the paginated path return the
    // same shape, and the items are bounded by the current org's SOs.
    // Narrow the ORDERS and, through the same predicate, their items — an
    // unnarrowed item subquery would ship another salesperson's line detail
    // for orders the caller never sees.
    const fullScope = await customerScopeSql(c, "customer_id");
    const fullClause = fullScope.clause ? ` AND ${fullScope.clause}` : "";

    const computeFullList = async () => {
      const [sos, items] = await Promise.all([
        db
          .prepare(
            `SELECT * FROM ${soSourceSql} ${orgWhere}${fullClause} ORDER BY created_at DESC, id DESC`,
          )
          .bind(...orgParams, ...fullScope.binds)
          .all<SalesOrderRow>(),
        db
          .prepare(
            `SELECT * FROM ${itemsSourceSql}
              WHERE salesOrderId IN (SELECT id FROM ${soSourceSql} ${orgWhere}${fullClause})`,
          )
          .bind(...orgParams, ...fullScope.binds)
          .all<SalesOrderItemRow>(),
      ]);
      // De-quadratic (2026-06-04): group items by salesOrderId ONCE so each
      // rowToSOList does an O(1) lookup instead of re-scanning EVERY item.
      // This branch is the heaviest Sales read (full list + ALL items — hit
      // on every search/filter and by the dashboard); the old
      // O(orders × items) scan was a top driver of the slow/blank-under-load
      // behaviour. Output is byte-identical: rowToSO still filters+sorts the
      // items it is handed, just over a pre-narrowed per-SO list.
      const itemsBySO = new Map<string, SalesOrderItemRow[]>();
      for (const it of items.results ?? []) {
        const arr = itemsBySO.get(it.salesOrderId);
        if (arr) arr.push(it);
        else itemsBySO.set(it.salesOrderId, [it]);
      }
      const data = (sos.results ?? []).map((s) =>
        rowToSOList(s, itemsBySO.get(s.id) ?? []),
      );
      return { success: true as const, data, total: data.length };
    };

    // The archive variant (?includeArchive=true) unions in an extra table
    // and is rarely requested — skip the cache for it so the snapshot row
    // only ever holds the canonical (non-archive) list. Service-order
    // filtered requests also bypass the cache because the snapshot row
    // holds the unfiltered "normal SOs only" list — if a SV-filtered
    // payload landed in it, the next /sales fetch would serve service
    // orders.
    if (includeArchive || serviceOrderFilter !== "false") {
      return c.json(await computeFullList());
    }

    // PR 8 (2026-05-22) — cache-aside snapshot. The dashboard fetches this
    // whole list to resolve per-product SO unit prices; it is a SELECT *
    // over sales_orders + sales_order_items (one of the two heaviest
    // dashboard reads) and the data is relatively static. Layer 2
    // invalidates the moment either source table's freshness column moves.
    // Same reason as /stats: the snapshot is keyed by org, so a scoped payload
    // must never be written into it.
    if (isCustomerScoped(c)) {
      return c.json(await computeFullList());
    }
    const { withSnapshot } = await import("../lib/snapshot");
    const data = await withSnapshot(
      db,
      {
        tableName: "sales_orders_list_snapshot",
        sourceTables: ["sales_orders", "sales_order_items"],
      },
      getOrgId(c),
      computeFullList,
      "",
      c, // emit cache.hit / cache.miss counters → real cacheHitRatio
    );
    // The dashboard's Pending-Delivery tile only needs a per-SO
    // {productCode → unitPriceSen} price map — not the full list (720 SOs ×
    // every SO field × every 24-field item). When ?fields=price-index is set,
    // project the SAME cached list down to {id, items:[{productCode,
    // unitPriceSen}]}: byte-identical prices (same data, same items), a tiny
    // payload. The full-list path (no param) is untouched.
    if (c.req.query("fields") === "price-index") {
      const slim = ((data?.data ?? []) as Array<{
        id: string;
        items?: Array<{ productCode?: string; unitPriceSen?: number }>;
      }>).map((s) => ({
        id: s.id,
        items: (s.items ?? []).map((it) => ({
          productCode: it.productCode,
          unitPriceSen: it.unitPriceSen,
        })),
      }));
      return c.json({ success: true, data: slim, total: slim.length });
    }
    // The Delivery page fetches this whole list ONLY to join Customer PO/SO
    // numbers + reference + hookkaExpectedDD onto DO rows (the DO payload
    // doesn't carry these). It never needs line items — dropping them (each
    // SO has ~24-field items) shrinks the payload by well over 90%.
    // ?fields=delivery-refs projects the SAME cached snapshot down to the ref
    // scalars the DO grids read (id/companySOId/customerId + the four ref
    // columns dual-keyed *Id/plain + hookkaExpectedDD). Byte-identical values,
    // no items, no image. The full-list path (no param) is untouched.
    if (c.req.query("fields") === "delivery-refs") {
      const slim = soListToDeliveryRefs(
        (data?.data ?? []) as SOListRefLike[],
      );
      return c.json({ success: true, data: slim, total: slim.length });
    }
    return c.json(data);
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  // Optional server-side search — used by the global Ctrl+K palette (?search=).
  // Index-backed (pg_trgm GIN, migration 0150) ILIKE '%term%' over the columns
  // operators actually type: Company SO / Customer SO / Customer PO / customer
  // name / reference. Partial match, so "8585" finds "POO-008585". Fires ONLY
  // when `search` is present — the Sales LIST page's own search uses the
  // non-paginated branch above and is completely untouched.
  const searchTerm = (c.req.query("search") || c.req.query("q") || "").trim();
  const searchClause = searchTerm
    ? ` AND (company_so_id ILIKE ? OR customer_so_id ILIKE ? OR customer_po_id ILIKE ? OR customer_name ILIKE ? OR COALESCE(reference,'') ILIKE ?)`
    : "";
  const searchBinds = searchTerm ? Array(5).fill(`%${searchTerm}%`) : [];

  // Narrow the PAGE and the COUNT with the same predicate. The response filter
  // downstream would have removed the foreign rows anyway, but it cannot fix
  // `total` — which is why the footer read "1,229 sales orders · Page 1 / 7"
  // under an empty grid (owner 2026-08-05).
  const listScope = await customerScopeSql(c, "customer_id");
  const scopeClause = listScope.clause ? ` AND ${listScope.clause}` : "";

  const [countRes, pageRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${soSourceSql} ${orgWhere}${searchClause}${scopeClause}`)
      .bind(...orgParams, ...searchBinds, ...listScope.binds)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT * FROM ${soSourceSql} ${orgWhere}${searchClause}${scopeClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...orgParams, ...searchBinds, ...listScope.binds, limit, offset)
      .all<SalesOrderRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const soRows = pageRes.results ?? [];

  let items: SalesOrderItemRow[] = [];
  if (soRows.length > 0) {
    const ids = soRows.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");
    const itemsRes = await db
      .prepare(`SELECT * FROM ${itemsSourceSql} WHERE salesOrderId IN (${placeholders})`)
      .bind(...ids)
      .all<SalesOrderItemRow>();
    items = itemsRes.results ?? [];
  }
  // De-quadratic: same per-SO grouping as the full-list branch above so the
  // paginated path is O(items) not O(rows × items). Output byte-identical.
  const itemsBySO = new Map<string, SalesOrderItemRow[]>();
  for (const it of items) {
    const arr = itemsBySO.get(it.salesOrderId);
    if (arr) arr.push(it);
    else itemsBySO.set(it.salesOrderId, [it]);
  }
  const data = soRows.map((s) => rowToSOList(s, itemsBySO.get(s.id) ?? []));
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/backfill-hub-by-state?execute=1
// One-shot data fix (2026-07-19). The SO-create blind default stamped every
// un-matched multi-hub order with the customer's default hub ("Houzs KL") even
// though the OCR set the correct customerState — so Penang/SBH/SRW orders (and
// their stickers/DOs) followed the wrong branch. The state IS correct, so we can
// re-derive the right hub: for each multi-hub-customer SO whose customerState
// maps to EXACTLY ONE of that customer's hubs, and whose current hub differs,
// correct sales_orders.hubId/hubName. DRY-RUN by default; ?execute=1 writes.
// Shipped orders (goods already left the hub) are NEVER auto-changed — they are
// reported separately for manual review (mirrors the PATCH /:id/hub lock).
// After executing, run POST /api/fg-units/backfill-hub to push the corrected hub
// onto in-stock FG stickers, then reprint.
// (defined BEFORE /:id so the route matches first)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/sales-orders/check-customer-pos
//
// "Is this customer PO already an order in the system?" — the question the scan
// preview should be asking.
//
// It used to ask a different one: "have I seen this FILE before, and did anyone
// make a draft from it?" That answer goes stale the moment a draft is deleted,
// and it went stale silently — two of eleven POs vanished from a scan and
// nothing said so (owner 2026-08-02:「为什么我的 OCR PO 9721、9720 会没有出来
// 呢?」). Owner's own diagnosis:「系统应该是根据拉出来的顾客名字和顾客的 PO 号码
// 去做对比的,不需要看照片」.
//
// This asks the durable question instead. A deleted draft is simply not here,
// so the PO comes through clean; a live order IS here, and the caller is told
// exactly which one.
//
// READ-ONLY. Body: { pos: [{ customerPO, customerId?, customerName? }] }.
// Matching is on the customer PO number, narrowed by customer when the caller
// knows it — the same number can legitimately exist for two customers.
// ---------------------------------------------------------------------------
app.post("/check-customer-pos", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  let body: { pos?: { customerPO?: unknown; customerId?: unknown }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const asked = (Array.isArray(body.pos) ? body.pos : [])
    .map((p) => ({
      customerPO: typeof p?.customerPO === "string" ? p.customerPO.trim() : "",
      customerId: typeof p?.customerId === "string" ? p.customerId.trim() : "",
    }))
    .filter((p) => p.customerPO);
  if (asked.length === 0) return c.json({ success: true, data: [] });

  const nums = [...new Set(asked.map((p) => p.customerPO))].slice(0, 200);
  const ph = nums.map(() => "?").join(",");
  const res = await c.var.DB.prepare(
    `SELECT id, companySOId, customerPOId, customerId, customerName, status
       FROM sales_orders
      WHERE customerPOId IN (${ph})
        AND UPPER(COALESCE(status, '')) <> 'CANCELLED'`,
  )
    .bind(...nums)
    .all<{
      id: string;
      companySOId?: string | null;
      companysoid?: string | null;
      customerPOId?: string | null;
      customerpoid?: string | null;
      customerId?: string | null;
      customerid?: string | null;
      customerName?: string | null;
      customername?: string | null;
      status?: string | null;
    }>();

  const rows = (res.results ?? []).map((r) => ({
    id: r.id,
    companySOId: r.companySOId ?? r.companysoid ?? "",
    customerPO: r.customerPOId ?? r.customerpoid ?? "",
    customerId: r.customerId ?? r.customerid ?? "",
    customerName: r.customerName ?? r.customername ?? "",
    status: r.status ?? "",
  }));

  // One entry per ASKED po, in the order asked, so the caller can zip it back.
  const data = asked.map((p) => {
    const hits = rows.filter(
      (r) =>
        r.customerPO === p.customerPO &&
        // Narrow by customer only when the caller supplied one AND the stored
        // row has one — an older row with no customerId must still match.
        (!p.customerId || !r.customerId || r.customerId === p.customerId),
    );
    return { customerPO: p.customerPO, existing: hits };
  });
  return c.json({ success: true, data });
});

app.post("/backfill-hub-by-state", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "edit");
  if (denied) return denied;
  const execute = c.req.query("execute") === "1";
  const orgId = getOrgId(c);

  // Candidates: multi-hub-customer SOs whose state maps to exactly one hub that
  // is NOT the current hub. All scoping is in SQL so the payload stays small.
  const cands =
    (
      await c.var.DB.prepare(
        `SELECT so.id AS "soId", so.companySOId AS "companySOId",
                so.customerName AS "customerName", so.customerState AS "customerState",
                so.hubId AS "curHubId", so.hubName AS "curHubName",
                h.id AS "newHubId", h.shortName AS "newHubName"
           FROM sales_orders so
           JOIN delivery_hubs h
             ON h.customerId = so.customerId
            AND LOWER(h.state) = LOWER(so.customerState)
          WHERE so.orgId = ?
            AND COALESCE(so.customerState, '') <> ''
            AND (SELECT COUNT(*) FROM delivery_hubs d1 WHERE d1.customerId = so.customerId) >= 2
            AND (SELECT COUNT(*) FROM delivery_hubs d2
                  WHERE d2.customerId = so.customerId
                    AND LOWER(d2.state) = LOWER(so.customerState)) = 1
            AND (so.hubId IS NULL OR so.hubId <> h.id)`,
      )
        .bind(orgId)
        .all<{
          soId: string;
          companySOId: string | null;
          customerName: string | null;
          customerState: string | null;
          curHubId: string | null;
          curHubName: string | null;
          newHubId: string;
          newHubName: string;
        }>()
    ).results ?? [];

  // Shipment guard: never auto-change a hub once goods have left (same SHIPPED
  // set as PATCH /:id/hub). Split candidates into changeable vs manual-review.
  const soIds = cands.map((r) => r.soId);
  const shippedSet = new Set<string>();
  for (let i = 0; i < soIds.length; i += 100) {
    const chunk = soIds.slice(i, i + 100);
    if (chunk.length === 0) break;
    const ph = chunk.map(() => "?").join(",");
    const shipped =
      (
        await c.var.DB.prepare(
          `SELECT DISTINCT d.salesOrderId AS "soId"
             FROM delivery_orders d
            WHERE d.status IN ('LOADED','IN_TRANSIT','DELIVERED','INVOICED')
              AND d.salesOrderId IN (${ph})`,
        )
          .bind(...chunk)
          .all<{ soId: string | null }>()
      ).results ?? [];
    for (const s of shipped) if (s.soId) shippedSet.add(s.soId);
  }

  const changeable = cands.filter((r) => !shippedSet.has(r.soId));
  const shippedManual = cands.filter((r) => shippedSet.has(r.soId));

  // old -> new breakdown for a quick sanity-check before executing.
  const moves: Record<string, number> = {};
  for (const r of changeable) {
    const key = `${r.curHubName || "(unset)"} -> ${r.newHubName} [${r.customerState}]`;
    moves[key] = (moves[key] ?? 0) + 1;
  }

  if (execute && changeable.length > 0) {
    const now = new Date().toISOString();
    const stmts = changeable.map((r) =>
      c.var.DB
        .prepare(
          "UPDATE sales_orders SET hubId = ?, hubName = ?, updated_at = ? WHERE id = ?",
        )
        .bind(r.newHubId, r.newHubName, now, r.soId),
    );
    for (let i = 0; i < stmts.length; i += 50) {
      await c.var.DB.batch(stmts.slice(i, i + 50));
    }
  }

  return c.json({
    success: true,
    mode: execute ? "executed" : "dry-run",
    matched: cands.length,
    wouldUpdate: changeable.length,
    skippedShipped: shippedManual.length,
    moves,
    // Full per-SO before/after so a dry-run can be saved as a restore point.
    changeable: changeable.map((r) => ({
      soId: r.soId,
      companySOId: r.companySOId,
      customer: r.customerName,
      state: r.customerState,
      from: r.curHubName || "(unset)",
      to: r.newHubName,
    })),
    // Shipped SOs need a manual decision (goods already dispatched to the wrong
    // branch record) — listed, never auto-touched.
    shippedNeedsReview: shippedManual.map((r) => ({
      soId: r.soId,
      companySOId: r.companySOId,
      from: r.curHubName || "(unset)",
      to: r.newHubName,
    })),
    next:
      execute && changeable.length > 0
        ? "Now POST /api/fg-units/backfill-hub?execute=1 to push the corrected hub onto in-stock FG stickers, then reprint."
        : "Dry-run only. Re-run with ?execute=1 after reviewing the list.",
  });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/status-changes — full audit log
// (defined BEFORE /:id so the route matches first)
// ---------------------------------------------------------------------------
app.get("/status-changes", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM so_status_changes ORDER BY timestamp DESC",
  ).all<SOStatusChangeRow>();
  const data = (res.results ?? []).map(rowToStatusChange);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/stats — whole-dataset status bucket counts + revenue.
//
// Returns:
//   {
//     byStatus: Record<status, count>,
//     revenueByStatus: Record<status, totalSen>,
//     total: count,
//     totalRevenueSen: raw sum across every status,
//     csRevenueSen: "Confirmed Sales" — sum across the post-DRAFT, non-paused,
//                    non-cancelled status set (CONFIRMED → CLOSED). This is
//                    the headline revenue number the operator reads off the
//                    SO list page.
//   }
//
// Used by the list page tile cards so "Revenue" reflects the whole table
// rather than just the current paginated page (the previous client-side
// `orders.reduce(...)` was bounded by PAGE_SIZE=200 when no filter was
// active, so a 444-row dataset under-reported revenue by ~half).
//
// Single aggregate SELECT — cheap. Tenant-scoped via withOrgScope.
// Registered BEFORE /:id (Hono route ordering: static before wildcards).
// ---------------------------------------------------------------------------

app.get("/stats", async (c) => {
  const orgId = getOrgId(c);
  // 0134 — Service Order vs Sales Order scope. Same semantics as the GET
  // list above so /service-order's tab badges + dashboard cards read off
  // a SV-only aggregate instead of the combined ~570-row total.
  //   ?isServiceOrder=true  → only Service Orders (is_service_order=TRUE)
  //   ?isServiceOrder=false → only normal Sales Orders (the default)
  //   ?isServiceOrder=all   → both (admin/reporting)
  const isServiceOrderParam = c.req.query("isServiceOrder");
  const serviceOrderFilter: "true" | "false" | "all" =
    isServiceOrderParam === "true"
      ? "true"
      : isServiceOrderParam === "all"
        ? "all"
        : "false";
  const extraWhere =
    serviceOrderFilter === "true"
      ? "is_service_order = TRUE"
      : serviceOrderFilter === "false"
        ? "(is_service_order = FALSE OR is_service_order IS NULL)"
        : "";

  // A salesperson's totals must come from a NARROWED aggregate — there is no
  // row here for the response filter to drop, which is how the grid could read
  // "No confirmed orders" while the card above it read 1,229 / RM 1.4m
  // (owner 2026-08-05). The clause also has to be inside the GROUP BY, not
  // applied after, or the tab badges would still count other people's orders.
  const scope = await customerScopeSql(c, "customerId");
  const scopedWhere = [extraWhere, scope.clause].filter(Boolean).join(" AND ");

  const compute = async () => {
    const { whereSql: orgWhere, params: orgParams } = withOrgScope(
      c,
      "sales_orders",
      scopedWhere,
    );
    const res = await c.var.DB
      .prepare(
        `SELECT status                        AS "status",
                COUNT(*)                      AS "n",
                COALESCE(SUM(totalSen), 0)    AS "revenueSen"
           FROM sales_orders
           ${orgWhere}
           GROUP BY status`,
      )
      .bind(...orgParams, ...scope.binds)
      .all<{ status: string; n: number; revenueSen: number }>();
    const byStatus: Record<string, number> = {};
    const revenueByStatus: Record<string, number> = {};
    let total = 0;
    let totalRevenueSen = 0;
    let csRevenueSen = 0;
    for (const row of res.results ?? []) {
      byStatus[row.status] = row.n;
      revenueByStatus[row.status] = Number(row.revenueSen) || 0;
      total += row.n;
      totalRevenueSen += Number(row.revenueSen) || 0;
      if (CS_STATUSES.has(row.status)) {
        csRevenueSen += Number(row.revenueSen) || 0;
      }
    }
    // Service Orders are 0-amount by design, so the DO-value resolver
    // would always return 0 anyway — skip the extra reads in that mode.
    const deliveredItemsSen =
      serviceOrderFilter === "true"
        ? 0
        : await loadDeliveredItemsValueSen(c.var.DB, orgId);
    return {
      byStatus,
      revenueByStatus,
      total,
      totalRevenueSen,
      csRevenueSen,
      deliveredItemsSen,
      outstandingItemsSen: Math.max(0, csRevenueSen - deliveredItemsSen),
    };
  };

  // Snapshot key is per-org and doesn't carry the SV filter, so anything
  // other than the default (false → normal sales) bypasses the cache.
  // Otherwise a SV-filtered payload could land in the cache and the next
  // /sales fetch would serve the wrong totals.
  // The snapshot is keyed by org alone, so a scoped result must neither be
  // written into it nor read from it — one salesperson's totals would become
  // everybody's. Compute fresh; there are few enough scoped users for that to
  // be the cheap option.
  if (serviceOrderFilter !== "false" || scope.clause) {
    return c.json({ success: true, ...(await compute()) });
  }

  const { withSnapshot } = await import("../lib/snapshot");
  // PR 7 (2026-05-20) — cache-aside snapshot. Source tables:
  // sales_orders (bucket counts + revenue) and delivery_orders +
  // delivery_order_items + sales_order_items (deliveredItemsSen
  // resolver). Layer 2 invalidates on any of them changing.
  const data = await withSnapshot(
    c.var.DB,
    {
      tableName: "sales_orders_stats_snapshot",
      sourceTables: [
        "sales_orders",
        "sales_order_items",
        "delivery_orders",
        "delivery_order_items",
        "production_orders",
      ],
    },
    orgId,
    compute,
    "",
    c,
  );
  return c.json({ success: true, ...data });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/delivery-progress — per-SO delivered quantity.
//
// Returns { delivered: { [companySOId]: qty } } = Σ quantity of this SO's line
// items sitting on a DELIVERED (or INVOICED, i.e. delivered-then-invoiced) DO.
// The Sales list pairs it with each SO's own total qty to show real partial-
// delivery progress ("3/10 delivered") instead of flipping the whole order to
// one misleading label the moment a single line ships. Item→SO is via
// delivery_order_items.sales_order_no because a DO can span several SOs.
//
// Isolated, read-only, and best-effort: if it ever errors the Sales list still
// renders (the frontend just omits the partial indicator). Registered BEFORE
// /:id so Hono's router picks this handler.
// ---------------------------------------------------------------------------
app.get("/delivery-progress", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB
    .prepare(
      `SELECT di.sales_order_no AS "so", COALESCE(SUM(di.quantity), 0) AS "qty"
         FROM delivery_order_items di
        WHERE di.orgId = ?
          AND di.sales_order_no IS NOT NULL
          AND di.sales_order_no <> ''
          AND EXISTS (
                SELECT 1 FROM delivery_orders d
                 WHERE d.id = di.deliveryOrderId
                   AND d.orgId = ?
                   AND d.status IN ('DELIVERED', 'INVOICED')
              )
        GROUP BY di.sales_order_no`,
    )
    .bind(orgId, orgId)
    .all<{ so: string; qty: number }>();
  const delivered: Record<string, number> = {};
  for (const r of res.results ?? []) {
    if (r.so) delivered[r.so] = Number(r.qty) || 0;
  }
  return c.json({ success: true, delivered });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/late-to-customer?period=YYYY-MM
//
// The drill-down behind the `customer_delivery_date` KPI card's "See the list
// →" link. Returns the ids of the orders that card COUNTED — the ones whose
// first dispatch left after the date promised to the customer, in that month.
//
// The query is `lateToCustomerOrders` in src/api/lib/kpi-metrics.ts, which
// shares its CTE and its lateness test with the metric itself. That sharing is
// the whole point: a second hand-written copy would agree today and disagree
// in three months, and a list that disagrees with the number it was reached
// from destroys the number's authority.
//
// Row-level scoping is applied IN SQL, not on the way out — a salesperson
// never receives another salesperson's order ids. Their list is therefore
// legitimately shorter than the factory-wide count on the card.
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.get("/late-to-customer", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const period = (c.req.query("period") || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return c.json(
      { success: false, error: "period must be YYYY-MM" },
      400,
    );
  }
  const scope = await customerScopeSql(c, "so.customerId");
  const rows = await lateToCustomerOrders(c, period, scope);
  return c.json({ success: true, period, data: rows });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/repair-components — the pickable repair components
// for one product line (Component-level Repair Scope).
//
// Returns the product's top-level BOM WIP pieces ({key, label, type, qty})
// derived by THE SAME breakBomIntoWips call — same ACTIVE-template lookup +
// any-version fallback, same variant context — that production-builder.ts
// runs at SO confirm. That shared derivation is the contract: a `key` picked
// here is byte-identical to the wipKey the builder will stamp on this line's
// job cards, so create-time picks always match confirm-time building (and a
// BOM edited in between fails LOUDLY at confirm instead of building the
// wrong subset). qty = the WIP's per-FG piece count (bedframe Divan = 2,
// Headboard = 1) — the upper bound for the picker's per-component qty input.
//
// Missing / empty / unusable BOM (no top-level WIP nodes) → data: [] and the
// frontend hides the component picker (= all components, today's behaviour
// for legacy/flat BOMs).
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.get("/repair-components", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const productCode = (c.req.query("productCode") ?? "").trim();
  if (!productCode) {
    return c.json({ success: false, error: "productCode is required" }, 400);
  }
  const numOrNull = (v: string | undefined): number | null => {
    if (v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // SAME two-step BOM lookup as production-builder.ts (ACTIVE first, newest
  // of any status otherwise) so the picker sees exactly what confirm will.
  type BomRow = { wipComponents: string | null; baseModel: string | null };
  let bomRow = await c.var.DB
    .prepare(
      `SELECT wipComponents, baseModel FROM bom_templates
         WHERE productCode = ? AND versionStatus = 'ACTIVE'
         ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<BomRow>();
  if (!bomRow) {
    bomRow = await c.var.DB
      .prepare(
        `SELECT wipComponents, baseModel FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<BomRow>();
  }
  if (!bomRow?.wipComponents) {
    return c.json({ success: true, data: [] });
  }

  // SAME variant context the builder assembles from the SO line at confirm
  // (model comes from the BOM row itself — see BUG-2026-04-27-004). The
  // wipKey is variant-independent (raw template code); variants only shape
  // the display labels so they match the job cards 1:1.
  const variants: BomVariantContext = {
    productCode,
    model: bomRow.baseModel ?? productCode,
    sizeLabel: c.req.query("sizeLabel") ?? "",
    sizeCode: c.req.query("sizeCode") ?? "",
    fabricCode: c.req.query("fabricCode") ?? "",
    divanHeightInches: numOrNull(c.req.query("divanHeightInches")),
    legHeightInches: numOrNull(c.req.query("legHeightInches")),
    gapInches: numOrNull(c.req.query("gapInches")),
  };
  const wips = breakBomIntoWips(bomRow.wipComponents, productCode, variants);
  // breakBomIntoWips synthesizes a single FG_MAIN walker when the BOM JSON
  // is unusable — not a pickable component. Its 2-segment wipKey
  // (`code::FG_MAIN`) is unambiguous: real keys always carry the
  // ::idx::type:: segments.
  const isFallback =
    wips.length === 1 && wips[0].wipKey === `${productCode}::FG_MAIN`;
  return c.json({
    success: true,
    data: isFallback
      ? []
      : wips.map((w) => ({
          key: w.wipKey,
          label: w.wipLabel || w.wipCode,
          type: w.wipType,
          qty: w.quantityMultiplier,
        })),
  });
});


// ---------------------------------------------------------------------------
// GET /api/sales-orders/:id/edit-eligibility — can this SO be edited right now?
//
// Rules (per user 2026-04-28):
//   1. Status must be DRAFT / CONFIRMED / IN_PRODUCTION.
//   2. No job_card under the SO's POs may have a completedDate stamped.
//   3. The earliest JC's dueDate (i.e. when the first production step is
//      scheduled to finish) must be more than 2 calendar days away.
//      Once we are within 2 days of the first step's deadline, edits
//      lock so material orders / cutting plans don't get out of sync.
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.get("/:id/edit-eligibility", async (c) => {
  const id = c.req.param("id");
  const so = await c.var.DB
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Rule 1: status must be one of DRAFT / CONFIRMED / IN_PRODUCTION.
  if (so.status !== "DRAFT" && so.status !== "CONFIRMED" && so.status !== "IN_PRODUCTION") {
    return c.json({
      success: true,
      editable: false,
      reason: "status",
      status: so.status,
    });
  }

  // DRAFT/CONFIRMED short-circuit — no production to inspect.
  if (so.status === "DRAFT" || so.status === "CONFIRMED") {
    return c.json({
      success: true,
      editable: true,
      status: so.status,
    });
  }

  // IN_PRODUCTION — Option D unified rule (2026-05-06): the SO is editable
  // only when EVERY job_card under its POs is still WAITING or CANCELLED.
  // Once any JC has been stamped IN_PROGRESS / COMPLETED / TRANSFERRED, real
  // production is underway and a teardown+rebuild from sales_order_items
  // would orphan that work — so we hard-lock structural edits. This subsumes
  // the old "dept_completed" rule (which only checked completedDate) and the
  // 2-day production_window soft lock (already removed earlier).
  const productionStartedRes = await c.var.DB
    .prepare(
      `SELECT jc.departmentName, jc.departmentCode, jc.status, jc.completedDate
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE po.salesOrderId = ?
          AND jc.status NOT IN ('WAITING', 'CANCELLED')
        ORDER BY jc.sequence ASC, jc.id ASC
        LIMIT 1`,
    )
    .bind(id)
    .first<{
      departmentName: string | null;
      departmentCode: string | null;
      status: string | null;
      completedDate: string | null;
    }>();

  // Rule 2 (Option D): any JC has moved past WAITING → fully locked.
  if (productionStartedRes && productionStartedRes.status) {
    return c.json({
      success: true,
      editable: false,
      reason: "production_started",
      status: so.status,
      startedDept:
        productionStartedRes.departmentName ||
        productionStartedRes.departmentCode ||
        "A department",
      startedDeptCode: productionStartedRes.departmentCode || "",
      jcStatus: productionStartedRes.status,
      completedAt: productionStartedRes.completedDate || null,
    });
  }

  // IN_PRODUCTION + every JC still WAITING/CANCELLED → editable. PUT will
  // teardown + rebuild POs/JCs from sales_order_items on save.
  return c.json({
    success: true,
    editable: true,
    status: so.status,
  });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/:id/override-edit-lock — admin escape hatch for the
// Rule-3 production_window edit lock.
//
// Per user 2026-04-28: when the eligibility endpoint returns
// editable=false / reason="production_window" (i.e. the earliest JC's
// dueDate is within 2 calendar days of today), SUPER_ADMIN / ADMIN should
// be able to override the lock with a written reason. Everyone else stays
// locked. Each override is audit-trailed: a row in edit_lock_overrides AND
// an EDIT_LOCK_OVERRIDDEN entry in so_status_changes (so the existing
// <StatusTimeline /> on the SO detail page surfaces it without extra API
// wiring).
//
// SECURITY MODEL — why ADMIN can override Rule 3 but not Rule 2:
//   * Rule 1 (status not in DRAFT/CONFIRMED/IN_PRODUCTION): a CANCELLED /
//     SHIPPED / etc. SO has no live editing semantic — there's nothing
//     to mutate. Override would be meaningless.
//   * Rule 2 (any JC has completedDate): real production OUTPUT exists.
//     Editing items would orphan finished WIP, which is irreversible.
//     No reason text can undo a physical commitment, so this stays a
//     hard lock for everyone including SUPER_ADMIN.
//   * Rule 3 (production_window): a *soft* schedule-drift guard — no
//     output yet, just a "we're inside the 2-day cutoff so material
//     orders may drift" warning. The admin overriding is explicitly
//     accepting that schedule risk. The reason text + actor + timestamp
//     are persisted so the team can review later if drift actually hits.
//
// Returns: { success: true, overrideToken, expiresAt } on success.
// The FE forwards `overrideToken` on the next PUT /:id body to bypass
// the production_window check (only — Rules 1 & 2 still re-check).
//
// Registered BEFORE /:id and other dynamic routes so Hono's trie picks
// the right handler.
// ---------------------------------------------------------------------------
app.post("/:id/override-edit-lock", async (c) => {
  const id = c.req.param("id");

  // Role gate. The auth-middleware stamps `userRole` on the context.
  // SUPER_ADMIN / ADMIN are the only roles that can grant this override —
  // a regular OPERATOR / VIEWER cannot bypass even with a reason. We do the
  // check directly off c.get('userRole') instead of requirePermission()
  // because no granular sales-orders:override-edit-lock permission exists
  // yet; this is intentionally a role-level escape hatch.
  const role = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userRole")?.toUpperCase();
  if (role !== "SUPER_ADMIN" && role !== "ADMIN") {
    return c.json(
      {
        success: false,
        error:
          "Forbidden — only SUPER_ADMIN or ADMIN can override the edit lock.",
      },
      403,
    );
  }

  // Body validation. The reason is required + non-trivial: anything under
  // 5 chars is almost certainly a smashed-keyboard placeholder ("x", "asdf")
  // and useless for the audit review later.
  let body: { reason?: unknown };
  try {
    body = (await c.req.json()) as { reason?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reasonRaw.length < MIN_OVERRIDE_REASON_LEN) {
    return c.json(
      {
        success: false,
        error: `Reason is required (minimum ${MIN_OVERRIDE_REASON_LEN} characters after trimming).`,
      },
      400,
    );
  }

  // Re-run the same eligibility logic the GET endpoint uses. We MUST verify
  // Rule 3 actually fires right now, and Rules 1+2 are clear — otherwise
  // the override is either unnecessary (already editable) or invalid (a
  // hard-locked order). Fetching status + earliest completed JC + earliest
  // scheduled JC dueDate in parallel mirrors the eligibility GET above.
  const so = await c.var.DB
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Rule 1: status must be DRAFT / CONFIRMED / IN_PRODUCTION. Override
  // cannot resurrect a CANCELLED / SHIPPED order.
  if (
    so.status !== "DRAFT" &&
    so.status !== "CONFIRMED" &&
    so.status !== "IN_PRODUCTION"
  ) {
    return c.json(
      {
        success: false,
        error: `Cannot override — order is in status ${so.status}, which is not editable regardless of override.`,
      },
      400,
    );
  }

  // For DRAFT / CONFIRMED there's no production yet, so no Rule-3 lock
  // could even fire — the override is unnecessary. Reject so the FE
  // surfaces "edit normally" instead of writing junk audit rows.
  if (so.status === "DRAFT" || so.status === "CONFIRMED") {
    return c.json(
      {
        success: false,
        error: "No override needed — this order is already editable.",
      },
      400,
    );
  }

  const [completedRes, earliestDueRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT jc.completedDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.salesOrderId = ?
            AND jc.completedDate IS NOT NULL
            AND jc.completedDate <> ''
          LIMIT 1`,
      )
      .bind(id)
      .first<{ completedDate: string | null }>(),
    c.var.DB
      .prepare(
        `SELECT jc.dueDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.salesOrderId = ?
            AND jc.dueDate IS NOT NULL
            AND jc.dueDate <> ''
          ORDER BY jc.dueDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ dueDate: string | null }>(),
  ]);

  // Rule 2: any dept stamped a completion → hard lock, no override allowed.
  // This is the "real production output exists" guard. See block comment at
  // the top of this endpoint for why ADMIN cannot override this.
  if (completedRes && completedRes.completedDate) {
    return c.json(
      {
        success: false,
        error:
          "Cannot override — production output already exists (a department has stamped completion). Editing would orphan finished WIP. This lock cannot be bypassed.",
      },
      400,
    );
  }

  // Rule 3: production_window must currently be active for the override
  // to be meaningful. If the earliest JC dueDate is > today + 2 days the
  // SO is already editable normally — return 400 so the FE doesn't write
  // junk audit rows for a no-op override.
  const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
  let productionWindowActive = false;
  if (earliestDue.length === 10) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + 2);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (earliestDue <= cutoffStr) productionWindowActive = true;
  }
  if (!productionWindowActive) {
    return c.json(
      {
        success: false,
        error:
          "No override needed — the order is not currently within the 2-day production-window lock.",
      },
      400,
    );
  }

  // All checks pass — mint the token, write the audit-trail rows.
  const actorUserId = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userId") ?? null;
  const actorUserName = await lookupActorDisplayName(c.var.DB, actorUserId);

  const created = await createEditLockOverride(c.var.DB, {
    orderType: "SO",
    orderId: id,
    reason: reasonRaw,
    actorUserId,
    actorUserName,
    actorRole: role,
  });

  // Mirror the override into so_status_changes so the existing
  // <StatusTimeline /> on the SO detail page picks it up automatically.
  // We re-use the same fromStatus/toStatus columns: the override doesn't
  // actually transition status, so we stamp both with the current status
  // and flag the row via notes prefix "EDIT_LOCK_OVERRIDDEN: <reason>".
  // The FE formats anything starting with EDIT_LOCK_OVERRIDDEN: with a
  // distinct "Override" badge instead of the default "Status Change".
  const noteTag = `EDIT_LOCK_OVERRIDDEN: ${reasonRaw}`;
  await c.var.DB
    .prepare(
      `INSERT INTO so_status_changes
         (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      genStatusId(),
      id,
      so.status,
      so.status,
      actorUserName ?? actorUserId ?? "Admin",
      new Date().toISOString(),
      noteTag,
      JSON.stringify([
        `Override token issued (60 min TTL). earliestJcDueDate=${earliestDue}.`,
      ]),
    )
    .run();

  // Audit emit — first-class entry in audit_events too, so the global
  // audit log catches this even if status-history is later refactored.
  await emitAudit(c, {
    resource: "sales-orders",
    resourceId: id,
    action: "override-edit-lock",
    before: { editable: false, reason: "production_window", earliestJcDueDate: earliestDue },
    after: { overrideToken: created.token, expiresAt: created.expiresAt, reason: reasonRaw },
  });

  return c.json({
    success: true,
    overrideToken: created.token,
    expiresAt: created.expiresAt,
  });
});


// ---------------------------------------------------------------------------
// POST /api/sales-orders — create a new SO + items atomically
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  // RBAC gate (P3.3) — only roles with sales-orders:create may create SOs.
  const denied = await requirePermission(c, "sales-orders", "create");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);

  // Sprint 3 #4 — idempotency. If the client sends an `Idempotency-Key`
  // header, the handler is wrapped so a duplicate retry returns the
  // cached response instead of creating a duplicate SO. Requests without
  // a key run unwrapped (no-op).
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "sales-orders", idemKey, async () => {
  try {
    const body = await c.req.json();

    // Validate customer
    const customer = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(body.customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }

    // A POTENTIAL customer (created from the Sales Pipeline, not yet through the
    // Confirm gate) has no creditor code / terms / credit limit and must never
    // reach a money document. Enforced here rather than only in the picker —
    // a UI-only filter is a convenience, not a control.
    {
      const billable = await assertCustomerBillable(
        c.var.DB,
        body.customerId,
        "a sales order",
      );
      if (!billable.ok) {
        return c.json({ success: false, error: billable.error }, 400);
      }
    }

    // Duplicate-document guard (owner 2026-07): a customer PO/SO reference
    // already on a non-cancelled sales order for THIS customer is almost always
    // a re-scan or double-entry — block it with a clear message. (One customer
    // PO = one SO; partial deliveries are handled by multiple DOs off the same
    // SO, not multiple SOs, so a repeat reference is a duplicate.)
    {
      const soRefs = [body.customerPOId, body.customerSOId]
        .map((v) => (v == null ? "" : String(v).trim()))
        .filter(Boolean);
      if (soRefs.length > 0) {
        const ph = soRefs.map(() => "?").join(", ");
        const dup = await c.var.DB
          .prepare(
            `SELECT company_so_id AS "companySOId",
                    customer_po_id AS "customerPOId",
                    customer_so_id AS "customerSOId"
               FROM sales_orders
              WHERE customer_id = ?
                AND status <> 'CANCELLED'
                AND (customer_po_id IN (${ph}) OR customer_so_id IN (${ph}))
              LIMIT 1`,
          )
          .bind(customer.id, ...soRefs, ...soRefs)
          .first<{
            companySOId: string | null;
            customerPOId: string | null;
            customerSOId: string | null;
          }>();
        if (dup) {
          const matched =
            soRefs.find(
              (r) => r === dup.customerPOId || r === dup.customerSOId,
            ) ?? soRefs[0];
          return c.json(
            {
              success: false,
              error: `Customer reference "${matched}" is already on sales order ${dup.companySOId ?? "(an existing SO)"} for this customer — looks like a duplicate. Open that SO, or change the reference if it's genuinely a different order.`,
              duplicateOf: dup.companySOId,
            },
            409,
          );
        }
      }
    }

    // Resolve hub (optional)
    const hubIdField: string = body.hubId || body.deliveryHubId || "";
    let chosenHub: { id: string; state: string | null; shortName: string } | null = null;
    if (hubIdField) {
      chosenHub = await c.var.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
      )
        .bind(hubIdField, customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }
    if (!chosenHub) {
      // The hub must FOLLOW the warehouse the customer asked for — never a blind
      // guess. Previously an unmatched deliveryHub fell straight through to the
      // customer's isDefault hub ("Houzs KL"), so Penang/SBH/SRW orders were all
      // stamped KL even though the OCR set the correct state (owner 2026-07-19:
      // "state 明明是對的...應該是跟著 OCR 裏面的 warehouse"). Resolve in order:
      //   1) the order's STATE → the customer's hub in that state. customerState
      //      is OCR'd independently of the hub and is correct here, and every
      //      delivery_hub carries its state, so an exactly-one state match is the
      //      warehouse the customer named. (case-insensitive; skip if 0 or 2+.)
      //   2) else, only when the customer has EXACTLY ONE hub (nothing to guess).
      //   3) else leave the hub UNSET — never stamp a wrong branch.
      const soState =
        typeof body.customerState === "string" ? body.customerState.trim() : "";
      if (soState) {
        const stateHubs = await c.var.DB.prepare(
          "SELECT id, state, shortName FROM delivery_hubs WHERE customerId = ? AND LOWER(state) = LOWER(?) LIMIT 2",
        )
          .bind(customer.id, soState)
          .all<{ id: string; state: string | null; shortName: string }>();
        const sh = stateHubs.results ?? [];
        if (sh.length === 1) chosenHub = sh[0];
      }
      if (!chosenHub) {
        const hubs = await c.var.DB.prepare(
          "SELECT id, state, shortName FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 2",
        )
          .bind(customer.id)
          .all<{ id: string; state: string | null; shortName: string }>();
        const hubRows = hubs.results ?? [];
        if (hubRows.length === 1) chosenHub = hubRows[0];
      }
    }

    const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];

    // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single SO. They
    // run on entirely separate production lines (Fab Cut merge keys, BF qty
    // from HB, parallel lead times). Validate before any product/price
    // resolution work to fail fast and cheap.
    if (
      hasMixedSofaBedframe(
        rawItems.map((it) => ({
          itemCategory:
            typeof it.itemCategory === "string" ? it.itemCategory : null,
        })),
      )
    ) {
      return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
    }

    // Hard restriction: SOFA lines must use 1 unit each. Multiple sofas =
    // multiple lines (each qty=1). Per Wei Siang 2026-05-09 — sofa BOM is
    // per-piece and a single PO with qty=N is harder to track unit-by-unit
    // than N separate POs. BEDFRAME / ACCESSORY are unaffected (their
    // generator already expands qty>1 into per-unit POs).
    {
      const offending = findInvalidSofaQty(
        rawItems.map((it, i) => ({
          itemCategory:
            typeof it.itemCategory === "string" ? it.itemCategory : null,
          quantity:
            typeof it.quantity === "number" ? it.quantity : Number(it.quantity ?? 1),
          productCode:
            typeof it.productCode === "string" ? it.productCode : null,
          lineNo:
            typeof it.lineNo === "number" ? it.lineNo : i + 1,
        })),
      );
      if (offending) {
        return c.json(
          { success: false, error: formatSofaQtyError(offending) },
          400,
        );
      }
    }

    // Fabric integrity gate — every non-empty incoming fabricCode must
    // resolve to a row in raw_materials with a fabric itemGroup. Closes
    // the door on operators saving stale/typo codes (e.g. M2402-04 when
    // only M2402-4 exists). Empty fabricCode is legal — line items
    // without fabric simply skip the check.
    {
      const fabCheck = await validateFabricCodes(
        c.var.DB,
        rawItems.map((it) => (it.fabricCode as string | null | undefined)),
      );
      if (!fabCheck.valid) {
        return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
      }
    }

    // SOFA seat-size gate (DUP-001 phase 1 commit C, 2026-05-09). Every
    // SOFA item's sizeLabel must be in kv_config.variants-config.sofaSizes
    // — the same list the frontend dropdown reads. Rejects "28\"" when
    // canonical is "28" (and vice versa) instead of silently normalizing.
    {
      const sofaCheck = await validateSofaSizeLabels(
        c.var.DB,
        rawItems.map((it) => ({
          itemCategory: typeof it.itemCategory === "string" ? it.itemCategory : null,
          sizeLabel: typeof it.sizeLabel === "string" ? it.sizeLabel : null,
        })),
      );
      if (!sofaCheck.valid) {
        return c.json(
          unknownSofaSizeLabelError(sofaCheck.unknown, sofaCheck.allowed),
          400,
        );
      }
    }

    // Repair Scope gate (0160) — service orders may scope each line to a
    // department subset; normal sales orders must keep the column NULL
    // (the UI has no scope cell outside service mode — reject, don't
    // silently strip). Unknown presets / dept codes are 400s via the
    // shared validator (reject — don't normalize).
    const repairScopeByLine: (string | null)[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const check = validateRepairScopeInput(rawItems[i].repairScope);
      if (!check.ok) {
        return c.json(
          { success: false, error: `Line ${i + 1}: ${check.error}` },
          400,
        );
      }
      if (check.canonical && body.isServiceOrder !== true) {
        return c.json(
          {
            success: false,
            error: `Line ${i + 1}: Repair Scope is only available on Service Orders — normal sales orders are always a full build.`,
          },
          400,
        );
      }
      repairScopeByLine.push(check.canonical);
    }

    // Price-resolution date: use companySODate (may be future-dated) when given,
    // fall back to today so price history resolves correctly on confirm.
    const priceAsOf =
      typeof body.companySODate === "string" && body.companySODate
        ? body.companySODate.slice(0, 10)
        : new Date().toISOString().slice(0, 10);

    // Service orders price at EXACTLY what the operator typed — 0 means 0
    // (free / goodwill repair). The price-resolution chain below treats 0 as
    // "no price" and fills the customer/catalog price, which silently billed
    // repairs at full price (SV-2606-001 got catalog RM 730 and surfaced in
    // the sales report — owner 2026-06-11). Hoisted here so the items loop
    // and the combo pass can both skip.
    const isServiceOrder = body.isServiceOrder === true;

    // 0165 — optional Service Case linkage. /service-order/create?fromCase=…
    // sends the parent case id so the spawned SV order shows on the case's
    // "Service Orders" panel (service-cases.ts merges sales_orders rows by
    // caseid). Service-order-only: no UI anywhere puts a case on a normal
    // sales order, so reject instead of silently storing it.
    const caseIdRaw = typeof body.caseId === "string" ? body.caseId.trim() : "";
    if (caseIdRaw && !isServiceOrder) {
      return c.json(
        { success: false, error: "caseId is only available on Service Orders." },
        400,
      );
    }
    let linkedCaseId: string | null = null;
    if (caseIdRaw) {
      const caseRow = await c.var.DB
        .prepare("SELECT id FROM service_cases WHERE id = ?")
        .bind(caseIdRaw)
        .first<{ id: string }>();
      if (!caseRow) {
        return c.json(
          { success: false, error: `Service case ${caseIdRaw} not found` },
          400,
        );
      }
      linkedCaseId = caseRow.id;
    }

    // Owner-editable special-order price list, read ONCE for the whole order
    // (BUG-2026-07-17-002). Only consulted for items that omit
    // specialOrderPriceSen — i.e. the scan-a-customer-PO paths. null degrades
    // to the static catalog in src/lib/pricing-options.ts.
    const cfgSpecialsForPricing = await loadSpecialsConfig(c.var.DB);
    // Owner-editable divan / leg height price lists (2026-07-22). Same
    // one-read-per-order pattern, consulted only for items that omit the price
    // — i.e. the scan-a-customer-PO paths.
    const cfgHeightsForPricing = await loadHeightsConfig(c.var.DB);

    // Build items — resolve product basePrice fallback
    const items = await Promise.all(
      rawItems.map(async (item, idx) => {
        const productCode = String(item.productCode ?? "");
        const incomingItemCategory = String(item.itemCategory ?? "");
        const isSofaItem = incomingItemCategory === "SOFA";
        let resolvedProduct: {
          id: string;
          name: string;
          category: string;
          sizeCode: string | null;
          sizeLabel: string | null;
          basePriceSen: number | null;
          seatHeightPrices: string | null;
        } | null = null;
        if (productCode) {
          resolvedProduct = await c.var.DB.prepare(
            "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE code = ? LIMIT 1",
          )
            .bind(productCode)
            .first();
          if (!resolvedProduct) {
            resolvedProduct = await c.var.DB.prepare(
              "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE LOWER(code) = LOWER(?) LIMIT 1",
            )
              .bind(productCode)
              .first();
          }
        }

        const incomingBasePrice = Number(item.basePriceSen) || 0;
        let basePriceSen = incomingBasePrice;

        // Customer-specific price override: only consulted when the request
        // didn't explicitly supply a price. A failed lookup must not break
        // the SO create — fall through to the product-level default below.
        let cpSeatHeightPrices: Array<{ height: string; priceSen: number }> | null = null;
        let cpBasePrice: number | null = null;
        const productIdForLookup = (item.productId as string) || resolvedProduct?.id || "";
        if (!isServiceOrder && incomingBasePrice === 0 && productIdForLookup && customer.id) {
          try {
            const cp = await resolveCustomerPriceAsOf(
              c.var.DB,
              productIdForLookup,
              customer.id,
              priceAsOf,
            );
            if (cp) {
              cpBasePrice = cp.basePriceSen;
              cpSeatHeightPrices = cp.seatHeightPrices ?? null;
            }
          } catch {
            // Non-fatal: fall back to product-level pricing.
          }
        }

        if (!isServiceOrder && basePriceSen === 0 && resolvedProduct) {
          const seatHeight = String(item.seatHeight ?? "");
          if (cpSeatHeightPrices && cpSeatHeightPrices.length > 0 && seatHeight) {
            const shp = cpSeatHeightPrices.find(
              (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
            );
            basePriceSen = shp?.priceSen || cpBasePrice || resolvedProduct.basePriceSen || 0;
          } else if (resolvedProduct.seatHeightPrices && seatHeight) {
            try {
              const shpList = JSON.parse(resolvedProduct.seatHeightPrices) as Array<{
                height: string;
                priceSen: number;
              }>;
              const shp = shpList.find(
                (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
              );
              basePriceSen = shp?.priceSen || cpBasePrice || resolvedProduct.basePriceSen || 0;
            } catch {
              basePriceSen = cpBasePrice ?? resolvedProduct.basePriceSen ?? 0;
            }
          } else {
            basePriceSen = cpBasePrice ?? resolvedProduct.basePriceSen ?? 0;
          }
        }

        // 2026-07-22 BUG FIX (under-billing, RM 12,455 across divan + leg):
        // these were `Number(item.divanPriceSen) || 0` — the same trust-the-
        // client shape the 07-14 and 07-17 fixes below already repaired for
        // their own columns, left unrepaired here. The scan-a-customer-PO
        // paths post divanHeightInches / legHeightInches with NO price, so on
        // prod every one of the 105 scanned lines carrying a 10"/12" divan was
        // stored at 0 while the 104 typed by hand charged correctly.
        // resolveHeightPriceSen DERIVES only when the field is OMITTED; any
        // supplied number is trusted verbatim — including a deliberate 0.
        const divanPriceSen = resolveHeightPriceSen(
          item.divanPriceSen as number | string | null | undefined,
          item.divanHeightInches as number | string | null | undefined,
          cfgHeightsForPricing.divanHeights,
          isServiceOrder,
        );
        const legPriceSen = resolveHeightPriceSen(
          item.legPriceSen as number | string | null | undefined,
          item.legHeightInches as number | string | null | undefined,
          cfgHeightsForPricing.legHeights,
          isServiceOrder,
        );
        // 2026-07-17 BUG FIX (BUG-2026-07-17-002 — under-billing, RM 8,060 over
        // 66 SOs): this was `Number(item.specialOrderPriceSen) || 0`, which
        // trusted a field the SCAN clients never send. The typed form
        // (sales/create.tsx) computes the surcharge and always posts it, but
        // scan-po-modal.tsx and m/ScanPOSheet.tsx POST here DIRECTLY with only
        // the specialOrder TEXT — so "Divan Full Cover" stored 0 and the RM 80
        // was never billed, while the same option typed by hand charged fine.
        // Same bug class as the totalHeightPriceSen fix noted below.
        // resolveSpecialOrderPriceSen DERIVES only when the field is OMITTED;
        // any supplied number is trusted verbatim — including a deliberate 0
        // (Service Orders are free by design) and a hand-discounted price.
        const specialOrderPriceSen = resolveSpecialOrderPriceSen(
          item,
          cfgSpecialsForPricing,
        );
        // 2026-07-23: total-height (gap+divan+leg) now derives server-side like
        // divan/leg — the typed form sends it, the scan/import paths never did,
        // and it now has its own stored column (total_height_price_sen). Was
        // `Number(item.totalHeightPriceSen) || 0`, which is why it landed in
        // 0/125 eligible lines (RM 10,240 uncharged). Trusts a supplied number;
        // derives from variants-config.totalHeights only when the field is omitted.
        const totalHeightPriceSen = resolveTotalHeightPriceSen(
          item.totalHeightPriceSen as number | string | null | undefined,
          item.gapInches as number | string | null | undefined,
          item.divanHeightInches as number | string | null | undefined,
          item.legHeightInches as number | string | null | undefined,
          cfgHeightsForPricing.totalHeights,
          isServiceOrder,
        );
        const unitPriceSen = calculateUnitPrice({
          basePriceSen,
          divanPriceSen,
          legPriceSen,
          totalHeightPriceSen,
          specialOrderPriceSen,
        });
        const quantity = Number(item.quantity) || 0;
        // Per-line discount (migration 0179). Applied AFTER unit price × qty.
        // Clamped ≥ 0 so a negative discount can't inflate the line total.
        const discountSen = Math.max(0, Math.round(Number(item.discountSen) || 0));
        const lineTotalSen = Math.max(0, calculateLineTotal(unitPriceSen, quantity) - discountSen);
        const lineNo = idx + 1;
        const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;
        // Free-text custom specials per line (migration 0074). Sanitized
        // here — empty descriptions dropped, surcharge coerced to ≥0 sen.
        // Stored as JSON string in sales_order_items.customSpecials. The
        // aggregate surcharge is already folded into specialOrderPriceSen
        // by the client; we trust the client value rather than recomputing
        // (the existing flow does the same for predefined specials).
        const cleanedCustomSpecials = sanitizeCustomSpecials(item.customSpecials);

        // 2026-05-09: fabricId resolve removed. Picker now keys on fabricCode
        // directly; sales_order_items.fabricId is being dropped in a follow-up
        // migration. Persist null so existing rows aren't accidentally seeded
        // with a fresh stale id.
        const incomingFabricCode = String(item.fabricCode ?? "");

        // sizeLabel + sizeCode storage — category-driven:
        //   BEDFRAME / ACCESSORY — catalog wins (closes the OCR back-door
        //     where the modal could persist PDF junk like "(K)").
        //   SOFA — client value passes through verbatim. The dropdown
        //     source (kv_config.sofaSizes) is bare numerics ("28"), so the
        //     value the operator picks is exactly what lands. The previous
        //     normalize-add-quote logic at this site was the inverse of
        //     correct — it took clean dropdown values and produced 518 dirty
        //     rows that disagreed with the dropdown source. Removed in
        //     DUP-001 commit B (2026-05-09) along with the wrong-direction
        //     /backfill-sofa-sizelabel-quote endpoint. The strict gate that
        //     replaces it lives in commit C as validateSofaSizeLabel.
        let normalizedSizeLabel: string;
        let normalizedSizeCode: string;
        if (isSofaItem) {
          normalizedSizeLabel =
            (item.sizeLabel as string) ||
            (item.sizeCode as string) ||
            "";
          normalizedSizeCode =
            (item.sizeCode as string) || normalizedSizeLabel;
        } else {
          normalizedSizeLabel =
            resolvedProduct?.sizeLabel ||
            (item.sizeLabel as string) ||
            "";
          normalizedSizeCode =
            resolvedProduct?.sizeCode ||
            (item.sizeCode as string) ||
            "";
        }

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: resolvedProduct?.id || (item.productId as string) || "",
          productCode,
          // Catalog wins. If productCode resolves to a product, its name
          // is what we persist — the client can't shove PDF text through.
          productName:
            resolvedProduct?.name || (item.productName as string) || productCode,
          itemCategory:
            resolvedProduct?.category ||
            (item.itemCategory as string) ||
            "BEDFRAME",
          sizeCode: normalizedSizeCode,
          sizeLabel: normalizedSizeLabel,
          fabricCode: incomingFabricCode,
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          totalHeightPriceSen,
          customSpecials: cleanedCustomSpecials,
          basePriceSen,
          unitPriceSen,
          discountSen,
          lineTotalSen,
          notes: (item.notes as string) || "",
          // Canonical Repair Scope from the gate above (null = FULL).
          repairScope: repairScopeByLine[idx] ?? null,
        };
      }),
    );

    // Service orders: collapse a FULL component pick to "no components" so a
    // whole-unit repair renders as the complete unit on the DO/badge (#10b).
    if (isServiceOrder) {
      await canonicalizeRepairScopesAgainstBom(c.var.DB, items);
    }

    // Sofa combo renegotiation — covers manual create AND scan-PO/OCR orders.
    // Combo discounts are SALES pricing — service-order lines keep the
    // operator-typed price untouched.
    if (!isServiceOrder) {
      await runSofaComboPass(c.var.DB, customer.id, items, rawItems);
    }

    // NOTE (owner 2026-06-11): NO RM0 gate here by explicit request — a line
    // whose resolution ends at RM0 saves as-is (the resolution chain above
    // still fills customer/catalog prices whenever they exist).

    const subtotalSen = items.reduce((sum, i) => sum + i.lineTotalSen, 0);
    const now = new Date().toISOString();
    // 0134 — Service-Order flag (hoisted above the items loop so pricing can
    // skip; see the comment there). When true, pick the `SV-YYMM-NNN` id
    // prefix instead of `SO-YYMM-NNN` and persist is_service_order = TRUE
    // so the new SO lands on the Service Orders list (and stays out of
    // the regular Sales Orders list, which filters
    // ?isServiceOrder=false by default).
    // Number the SO by its order date (companySODate = the customer's PO date),
    // not the system clock — see generateCompanySOId. Falls back to today when
    // no order date was supplied (mirrors the INSERT's `companySODate ?? today`).
    const orderDateForId =
      typeof body.companySODate === "string" && body.companySODate
        ? body.companySODate
        : now.split("T")[0];
    // Storage-level uniqueness for the number about to be minted. The MAX+1
    // read-then-write in generateCompanySOId has a race window; this index is
    // what makes a collision fail loudly at INSERT instead of silently
    // producing two orders with the same number (see _helpers.ts).
    await ensureCompanySOIdUnique(c.var.DB);
    const companySOId = await generateCompanySOId(
      c.var.DB,
      isServiceOrder,
      orderDateForId,
    );
    const soId = genSoId();
    const today = now.split("T")[0];

    // Invariant (BUG hub-vanishes, 2026-07-28): customer_state is authoritative
    // ONLY when it derives from the resolved hub. NEVER persist the raw OCR /
    // body state on its own — that produced "state present, hub NULL" orphan
    // rows (e.g. state "Selangor" with no hub) that shipped to the wrong place.
    // body.customerState is still read ABOVE to RESOLVE the hub (state -> the
    // customer's single hub in that state); it just never lands as stored state
    // without a hub behind it. No hub => no state (consistent, and catchable).
    const customerState = chosenHub?.state ?? "";

    // Auto-derive Hookka Expected DD = customer DD - per-category buffer.
    // Filled at create time so the SO list / detail page show it right
    // away (don't wait for confirm cascade). Operator can still override
    // by passing body.hookkaExpectedDD explicitly. Mirrors what
    // production-order-builder does on confirm — but eagerly.
    let resolvedHookkaExpectedDD =
      typeof body.hookkaExpectedDD === "string" && body.hookkaExpectedDD
        ? body.hookkaExpectedDD
        : "";
    if (!resolvedHookkaExpectedDD && body.customerDeliveryDate) {
      try {
        const buf = await loadHookkaDDBuffer(c.var.DB);
        // Use the dominant item category — mixed-category SOs are
        // forbidden upstream by hasMixedSofaBedframe so first item is
        // representative.
        const dominantCat =
          (items[0]?.itemCategory as string | undefined) || "BEDFRAME";
        const days = hookkaDDBufferFor(buf, dominantCat);
        resolvedHookkaExpectedDD = addDays(
          String(body.customerDeliveryDate).slice(0, 10),
          -days,
        );
      } catch {
        // Lead-time table missing or malformed — fall through with empty
        // string. Cascade will fill it on confirm.
      }
    }

    // Customer PO image is optional — only PO_SCAN_CLAUDE source supplies it.
    // Stored inline as base64 PNG so the SO detail page can render it as
    // proof-of-source when a customer disputes a delivery.
    const customerPOImageB64 =
      typeof body.customerPOImageB64 === "string" && body.customerPOImageB64
        ? body.customerPOImageB64
        : null;

    // Multi-Company Phase 2 — the company this SO is booked under. Operator
    // picks it on the create form; an omitted / blank value defaults to HOOKKA
    // so nothing changes for callers that don't send it (OCR / scan-PO, older
    // clients). Stored uppercased to match the organisations.code convention.
    const salesOrgCode = resolveCompanyCode(body.salesOrgCode);

    // Built as a factory so a lost number race can re-mint and rebuild just
    // this statement (see the retry below) without duplicating 30 bindings.
    const rebuildSoInsert = (soNo: string) =>
      c.var.DB.prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
           customerSO, customerSOId, reference, customerId, customerName,
           customerState, hubId, hubName, companySO, companySOId, companySODate,
           customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
           subtotalSen, totalSen, status, overdue, notes,
           customerPOImageB64, is_service_order, caseid, sales_org_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        soId,
        body.customerPO ?? "",
        body.customerPOId ?? "",
        body.customerPODate ?? today,
        body.customerSO ?? "",
        body.customerSOId ?? "",
        body.reference ?? "",
        customer.id,
        customer.name,
        customerState,
        chosenHub?.id ?? null,
        chosenHub?.shortName ?? null,
        body.companySO ??
          `${isServiceOrder ? "Service Order" : "Sales Order"} ${soNo.split("-").pop()}`,
        soNo,
        body.companySODate ?? today,
        body.customerDeliveryDate ?? "",
        resolvedHookkaExpectedDD,
        body.hookkaDeliveryOrder ?? "",
        subtotalSen,
        subtotalSen,
        "DRAFT",
        "PENDING",
        body.notes ?? "",
        customerPOImageB64,
        isServiceOrder,
        linkedCaseId,
        salesOrgCode,
        now,
        now,
      );

    const statements = [
      rebuildSoInsert(companySOId),
      ...items.map((item) =>
        c.var.DB.prepare(
          // repairScope: unquoted camelCase folds to the runtime-added
          // lowercase column `repairscope` — matches both the self-applied
          // ALTER above and migration 0160.
          `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricCode, quantity, gapInches, divanHeightInches,
             divanPriceSen, legHeightInches, legPriceSen, specialOrder,
             specialOrderPriceSen, totalHeightPriceSen, customSpecials, basePriceSen, unitPriceSen, discountSen, lineTotalSen, notes, repairScope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          soId,
          item.lineNo,
          item.lineSuffix,
          item.productId,
          item.productCode,
          item.productName,
          item.itemCategory,
          item.sizeCode,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.gapInches,
          item.divanHeightInches,
          item.divanPriceSen,
          item.legHeightInches,
          item.legPriceSen,
          item.specialOrder,
          item.specialOrderPriceSen,
          item.totalHeightPriceSen,
          serializeCustomSpecials(item.customSpecials),
          item.basePriceSen,
          item.unitPriceSen,
          item.discountSen,
          item.lineTotalSen,
          item.notes,
          item.repairScope,
        ),
      ),
    ];

    try {
      await c.var.DB.batch(statements);
    } catch (e) {
      // Lost the MAX+1 race: another request minted this number between our
      // read and our write, and the unique index rejected the INSERT. Nothing
      // is persisted (the batch is atomic), so re-mint and retry once — by now
      // the winner's row is visible, so the second read returns the next free
      // number. A single retry is enough for realistic concurrency; a second
      // collision surfaces rather than looping.
      if (!isDuplicateSoIdError(e)) throw e;
      const retryId = await generateCompanySOId(
        c.var.DB,
        isServiceOrder,
        orderDateForId,
      );
      console.warn(
        `[POST /api/sales-orders] ${companySOId} was taken mid-create — retrying as ${retryId}`,
      );
      statements[0] = rebuildSoInsert(retryId);
      await c.var.DB.batch(statements);
      // The response re-reads the row (fetchSOWithItems below), so the caller
      // receives the retried number without any further plumbing.
    }

    const created = await fetchSOWithItems(c.var.DB, soId);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create sales order" },
        500,
      );
    }
    // Audit emit (P3.4) — captures the actor + after-state snapshot.
    // emitAudit is fire-and-forget on its own; awaiting just keeps tests
    // deterministic. Non-throwing on internal failure.
    await emitAudit(c, {
      resource: "sales-orders",
      resourceId: soId,
      action: "create",
      after: created,
    });
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/sales-orders] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating sales order" }, 500);
  }
  });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/:id/confirm
//
// Flips DRAFT/PENDING -> IN_PRODUCTION, writes so_status_changes, and cascades
// production_orders insertion — one PO row per SO item. All writes batched
// so a partial failure leaves no dangling state. Idempotent: re-submitting
// confirm returns the existing production orders without duplicating.
//
// 2026-04-28: confirm now lands at IN_PRODUCTION directly. Previously this
// flipped to CONFIRMED and waited for a downstream cascade to bump it; now
// the PO auto-creation kicks off lead-time scheduling synchronously, so
// CONFIRMED has no meaningful steady state. Legacy CONFIRMED rows are still
// supported through VALID_TRANSITIONS for backfill / migration purposes.
// ---------------------------------------------------------------------------
app.post("/:id/confirm", async (c) => {
  // RBAC gate — confirming an SO is the lock-in moment that fans out POs / JCs.
  // Reuses the dedicated confirm action so a "create-only" role can be
  // configured separately from "create + confirm".
  const denied = await requirePermission(c, "sales-orders", "confirm");
  if (denied) return denied;

  // Sprint 3 #4 — idempotency. Confirm is mutating (writes
  // production_orders, cascades job_cards). Wrap so a duplicate retry
  // returns the cached response instead of running the cascade twice.
  // The path id is folded into the resource so two different SOs can
  // share the same client-generated key without colliding.
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(
    c,
    `sales-orders:confirm:${c.req.param("id")}`,
    idemKey,
    async () => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<SalesOrderRow>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Hub guard (BUG hub-vanishes, 2026-07-28): confirming an SO fans out
  // production + delivery orders, so a confirmed SO MUST carry a delivery hub
  // or the goods ship to the wrong (or no) address. A DRAFT may sit hub-less
  // (operator saves progress); confirm may NOT. Only enforced when the customer
  // actually HAS hubs configured — external / hub-less customers are exempt
  // (nothing to pick). Owner rule 2026-07-28: "without hub 不可以 confirm; draft 可以".
  const hubMissing = !existing.hubId || String(existing.hubId).trim() === "";
  if (hubMissing) {
    const anyHub = await c.var.DB.prepare(
      "SELECT id FROM delivery_hubs WHERE customerId = ? LIMIT 1",
    )
      .bind(existing.customerId)
      .first<{ id: string }>();
    if (anyHub) {
      return c.json(
        {
          success: false,
          error: `Order ${existing.companySOId ?? id} has no delivery hub. Select a hub before confirming (you can keep it as a draft).`,
        },
        400,
      );
    }
  }

  // DRAFT / PENDING orders are confirmable. CONFIRMED or IN_PRODUCTION
  // orders are also allowed through IF every existing PO is CANCELLED —
  // this covers two flows:
  //   1. Backfill: SO was confirmed before the PO cascade existed and is
  //      sitting at CONFIRMED with zero POs.
  //   2. Re-cascade: operator cancelled all POs (e.g. because the SO needs
  //      extra line items) and wants the cascade to fan fresh POs out
  //      against the current item set without resetting the SO to DRAFT.
  // The PO creation helper is idempotent and now skips CANCELLED rows in
  // its existence check, so re-running confirm in either case is safe.
  const allowedStatuses = ["DRAFT", "PENDING"];
  const fallThroughStatuses = ["CONFIRMED", "IN_PRODUCTION"];
  if (!allowedStatuses.includes(existing.status)) {
    if (fallThroughStatuses.includes(existing.status)) {
      const existingPos = await c.var.DB.prepare(
        `SELECT id FROM production_orders
           WHERE salesOrderId = ? AND status <> 'CANCELLED' LIMIT 1`,
      )
        .bind(id)
        .first<{ id: string }>();
      if (existingPos) {
        return c.json(
          {
            success: false,
            error: `Order ${existing.companySOId ?? id} is already ${existing.status} with active production orders. Cancel them first to re-cascade.`,
          },
          400,
        );
      }
      // Fall through: CONFIRMED/IN_PRODUCTION + zero active POs → run cascade.
    } else {
      return c.json(
        {
          success: false,
          error: `Cannot confirm order with status ${existing.status}. Only DRAFT orders can be confirmed.`,
        },
        400,
      );
    }
  }

  // Customer PO uniqueness (BR-SO-010). SERVICE ORDERS ARE EXEMPT (Wei Siang
  // 2026-06-15): a service order (rework/repair) reuses the ORIGINAL order's
  // customer PO by design, so the original SO and any number of service orders
  // spawned from the same case legitimately share one customer PO. Without
  // this exemption a 2nd service order on the same case could never be
  // confirmed ("Customer PO … already exists on SV-…"). So: skip the check
  // when confirming a service order, AND exclude service orders from the dup
  // lookup so a service order never blocks a normal sales order either.
  if (existing.customerPOId && !existing.isServiceOrder) {
    const dup = await c.var.DB.prepare(
      `SELECT id, companySOId FROM sales_orders
         WHERE id != ? AND customerPOId = ? AND customerId = ? AND status != 'CANCELLED'
           AND (isServiceOrder IS NULL OR isServiceOrder = false)
         LIMIT 1`,
    )
      .bind(id, existing.customerPOId, existing.customerId)
      .first<{ id: string; companySOId: string | null }>();
    if (dup) {
      return c.json(
        {
          success: false,
          error: `Customer PO ${existing.customerPOId} already exists on ${dup.companySOId ?? dup.id}. Each customer PO must be unique.`,
        },
        400,
      );
    }
  }

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const now = new Date().toISOString();
  const fromStatus = existing.status;

  // Load SO items for PO cascade.
  const itemsRes = await c.var.DB.prepare(
    "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
  )
    .bind(id)
    .all<SalesOrderItemRow>();
  const items = itemsRes.results ?? [];

  // Hard restriction re-check at confirm. POST + PUT already block this,
  // but legacy data created before the rule shipped could still slip in
  // here — keep the gate in place so the production cascade never sees a
  // mixed-category SO.
  if (hasMixedSofaBedframe(items)) {
    return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
  }

  // Sofa qty>1 re-check — same rationale as the mixed-category guard:
  // POST + PUT block this upstream, but legacy SOs (e.g. SO-2604-307
  // with sofa qty=10 created before the rule shipped) need a
  // confirm-time gate to prevent the production cascade from emitting
  // a single PO with qty=10 — which would violate the "1 sofa = 1 PO"
  // production-tracking rule.
  {
    const offending = findInvalidSofaQty(items);
    if (offending) {
      return c.json(
        { success: false, error: formatSofaQtyError(offending) },
        400,
      );
    }
  }

  // BOM completeness guard — blocks confirm if any line's product has an
  // incomplete BOM. Runs BEFORE the status flip and PO cascade so a 422
  // leaves the SO in its prior status and no production_orders are created.
  const incompleteProducts = await findIncompleteBomProducts(c.var.DB, items);
  if (incompleteProducts.length > 0) {
    return c.json(
      {
        success: false,
        error: "BOM incomplete — cannot confirm. Save as draft first.",
        details: { incompleteProducts },
      },
      422,
    );
  }

  const { statements: poStmts, created: productionOrders, preExisting } =
    await createProductionOrdersForSO(c.var.DB, existing, items);

  const autoActions = preExisting
    ? ["Production orders already exist for this SO — skipped duplicate creation."]
    : productionOrders.map((po) => `Created PO ${po.poNo}`);

  // 2026-04-28: confirm lands at IN_PRODUCTION directly. The PO cascade
  // below kicks off lead-time scheduling, so the SO IS in production the
  // moment confirm completes — there is no meaningful CONFIRMED steady
  // state. CONFIRMED is retained as a transition node only for legacy rows.
  await c.var.DB.batch([
    c.var.DB.prepare(
      "UPDATE sales_orders SET status = 'IN_PRODUCTION', updated_at = ? WHERE id = ?",
    ).bind(now, id),
    c.var.DB.prepare(
      `INSERT INTO so_status_changes
         (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      genStatusId(),
      id,
      fromStatus,
      "IN_PRODUCTION",
      (body.changedBy as string) || "Admin",
      now,
      (body.notes as string) || "Order confirmed",
      JSON.stringify(autoActions),
    ),
    ...poStmts,
  ]);

  const order = await fetchSOWithItems(c.var.DB, id);

  // Phase C #3 quick-win — enqueue one PO emission message per newly
  // created production order. Runs AFTER the synchronous DB batch so
  // the SO is durably CONFIRMED before any side-effect fires. When the
  // PO_EMISSION_QUEUE binding is not configured (default until
  // docs/QUEUES-SETUP.md is executed) the helper falls back to the
  // existing inline notify, preserving today's behavior.
  if (!preExisting && productionOrders.length > 0) {
    try {
      const { enqueuePoEmission } = await import("../lib/queue-po-emission");
      const orgId = (c.get as unknown as (k: string) => string | undefined)(
        "orgId",
      );
      const customerEmail =
        (existing as unknown as { customerEmail?: string }).customerEmail ??
        undefined;
      await Promise.all(
        productionOrders.map((po) =>
          enqueuePoEmission(
            c.env as unknown as {
              PO_EMISSION_QUEUE?: { send: (m: unknown) => Promise<void> };
            },
            {
              poId: po.id,
              soId: id,
              poNo: po.poNo,
              customerEmail,
              orgId,
            },
          ),
        ),
      );
    } catch (err) {
      // Never block the confirm response on the queue. The inline
      // fallback inside enqueuePoEmission already covers the common
      // failure case; this catch is the belt for the suspenders.
      console.warn(
        "[sales-orders/confirm] PO emission enqueue failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Audit emit (P3.4) — confirm is the lock-in moment that fans out POs.
  // Snapshot the SO's state before/after so forensic queries can trace the
  // moment a PO chain was kicked off.
  await emitAudit(c, {
    resource: "sales-orders",
    resourceId: id,
    action: "confirm",
    before: existing,
    after: order,
  });

  // Google Sheets sync — fire-and-forget. Push every freshly-created JC to
  // its dept tab so the operator workspace mirrors the new POs the moment
  // confirm completes. Wrapped in waitUntil so the Sheets round-trip never
  // blocks the response. Helper silently no-ops when GOOGLE_SHEETS_SA_KEY
  // is missing — see docs/SHEETS-SYNC.md.
  if (!preExisting && productionOrders.length > 0) {
    const ctx = (c as unknown as {
      executionCtx?: { waitUntil(p: Promise<unknown>): void };
    }).executionCtx;
    const pushPromise = pushNewlyCreatedJobCardsToSheet(
      c.env as unknown as {
        GOOGLE_SHEETS_SA_KEY?: string;
        SHEETS_SPREADSHEET_ID?: string;
      },
      c.var.DB,
      productionOrders.map((p) => p.id),
    ).catch((err) => {
      console.error(
        "[sales-orders/confirm] sheets-sync push failed",
        err instanceof Error ? err.message : err,
      );
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(pushPromise);
    }
    // If executionCtx isn't available (unit tests / wrangler dev edge cases)
    // the promise still runs; we just don't await it.
  }

  // PO ↔ SO line alignment validation (defense-in-depth, warn-only).
  // Multiset-based: compares (productCode, size, fabric, divan, ...) tuple
  // bag from sales_order_items vs production_orders. Surplus / missing
  // tuples surface attribute-shuffle bugs (see SO-2605-027). Warn-only;
  // operator can run /api/import/audit-po-alignment for full details.
  const alignmentValidation = await loadAndValidatePOAlignment(c.var.DB, id);
  const alignmentWarnings: string[] = [];
  if (!alignmentValidation.ok) {
    if (alignmentValidation.actualPoCount !== alignmentValidation.expectedPoCount) {
      alignmentWarnings.push(
        `PO count mismatch: expected ${alignmentValidation.expectedPoCount} (sum of line qty), got ${alignmentValidation.actualPoCount}`,
      );
    }
    if (alignmentValidation.surplusTuples.length > 0) {
      alignmentWarnings.push(
        `${alignmentValidation.surplusTuples.length} attribute tuple(s) over-represented in POs — possible attribute shuffle, see alignmentValidation.surplusTuples`,
      );
    }
    if (alignmentValidation.missingTuples.length > 0) {
      alignmentWarnings.push(
        `${alignmentValidation.missingTuples.length} attribute tuple(s) expected from SO lines but not found in POs — see alignmentValidation.missingTuples`,
      );
    }
    console.warn(
      `[sales-orders/confirm] PO alignment validation FAILED for soId=${id}:`,
      JSON.stringify(alignmentValidation, null, 2).slice(0, 2000),
    );
  }

  return c.json({
    success: true,
    data: order,
    productionOrders,
    bomFallbacks: [],
    bomWarnings: [],
    alignmentWarnings,
    alignmentValidation,
    message: preExisting
      ? `Order confirmed. ${productionOrders.length} existing production order(s) reused.`
      : `Order confirmed. ${productionOrders.length} production order(s) created.`,
  });
    },
  );
});


// ---------------------------------------------------------------------------
// GET /api/sales-orders/:id — SO + items + statusHistory + priceOverrides
// ---------------------------------------------------------------------------
// ── GET /:ref/footprint ─────────────────────────────────────────────────────
// READ-ONLY: everything still attached to one sales order (POs, job cards,
// delivery orders, invoices, promises, proposals). Exists so "this order is
// empty, delete it" can be checked instead of assumed — deleting the head of
// the chain orphans dispatch and accounting records that month-end depends on.
// Writes nothing; it only reports and recommends.
app.get("/:ref/footprint", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const data = await buildOrderFootprint(c.var.DB, c.req.param("ref"));
  return c.json({ success: true, data });
});

app.get("/:id", async (c) => {
  let id = c.req.param("id");
  // Doc-chain callers (the DO / Invoice relationship graph, incl. consolidated
  // DOs that carry no salesOrderId) may anchor on the SO NUMBER rather than its
  // primary id. SO ids are "so-…"; treat anything else as a companySOId and
  // resolve it. The SO detail page always passes a real id, so its path is
  // untouched; a number that resolves to nothing falls through to the 404.
  if (id && !id.startsWith("so-")) {
    const byNo = await c.var.DB
      .prepare("SELECT id FROM sales_orders WHERE company_so_id = ? LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (byNo?.id) id = byNo.id;
  }
  const [so, itemsRes, statusRes, overridesRes, posRes, completedByRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    c.var.DB.prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
    c.var.DB.prepare(
      "SELECT * FROM so_status_changes WHERE soId = ? ORDER BY timestamp DESC",
    )
      .bind(id)
      .all<SOStatusChangeRow>(),
    c.var.DB.prepare("SELECT * FROM price_overrides WHERE soId = ?")
      .bind(id)
      .all<PriceOverrideRow>(),
    // Linked production orders for the SO detail page's "Linked Production
    // Orders" table + doc-flow Production node + header chip. Wired
    // 2026-04-26 — the original endpoint left this as `[]` with a "Phase
    // 4" TODO from the D1 migration, never backfilled. Frontend uses
    // itemCategory to decide whether to show the line-suffixed poNo
    // (BF/ACC) or the parent companySOId without the -NN suffix (SOFA).
    c.var.DB.prepare(
      `SELECT id, poNo, productName, productCode, itemCategory, quantity,
              status, progress, currentDepartment, completedDate
         FROM production_orders
        WHERE salesOrderId = ?
        ORDER BY poNo`,
    )
      .bind(id)
      .all<{
        id: string;
        poNo: string;
        productName: string | null;
        productCode: string | null;
        itemCategory: string | null;
        quantity: number | null;
        status: string | null;
        progress: number | null;
        currentDepartment: string | null;
        completedDate: string | null;
      }>(),
    // completedBy: names of workers who scanned the PACKING job card
    // (the final dept, best proxy for "who finished the PO"). Derived from
    // job_cards.pic1Name / pic2Name where the JC is COMPLETED. Keyed by
    // production_orders.id so we can merge into the PO list above.
    c.var.DB.prepare(
      `SELECT jc.productionOrderId,
              string_agg(DISTINCT CASE WHEN jc.pic1Name IS NOT NULL AND jc.pic1Name <> '' THEN jc.pic1Name END, ', ') AS names1,
              string_agg(DISTINCT CASE WHEN jc.pic2Name IS NOT NULL AND jc.pic2Name <> '' THEN jc.pic2Name END, ', ') AS names2
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE po.salesOrderId = ?
          AND jc.status = 'COMPLETED'
          AND (jc.pic1Name IS NOT NULL OR jc.pic2Name IS NOT NULL)
        GROUP BY jc.productionOrderId`,
    )
      .bind(id)
      .all<{ productionOrderId: string; names1: string | null; names2: string | null }>(),
  ]);
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  // Lock status — surfaced to the frontend so the SO detail / edit pages
  // can disable inputs + render a banner ("locked because PO X is
  // COMPLETED — cancel that PO to unlock"). Same query the PUT guard
  // runs; cheap (single index lookup on production_orders).
  const lockReason = await checkSalesOrderLocked(c.var.DB, id);

  // ---- Document-chain linkage (real records, not fabricated) -------------
  // The Document Relationship diagram needs the ACTUAL downstream documents
  // for this SO: the delivery order(s) it shipped on, the invoice(s) raised,
  // and the payment receipt(s) collected. We resolve them by real keys so a
  // CONSOLIDATED DO — where delivery_orders.salesOrderId is NULL and the link
  // lives per-item on delivery_order_items.salesOrderNo = companySOId — also
  // connects. (Previously the diagram only drew a DO when the SO's
  // hookkaDeliveryOrder field was stamped, which the consolidated-DO create
  // path skips, and faked the Invoice/Payment nodes from SO status alone.)
  const companySOId = so.companySOId ?? "";
  const dosRes = await c.var.DB.prepare(
    `SELECT DISTINCT d.id, d.doNo, d.status,
            d.driverName, d.hookkaExpectedDD, d.dispatchedAt, d.deliveredAt
       FROM delivery_orders d
      WHERE d.salesOrderId = ?
         OR d.id IN (
              SELECT di.deliveryOrderId
                FROM delivery_order_items di
               WHERE di.salesOrderNo = ?
            )
      ORDER BY d.doNo`,
  )
    .bind(id, companySOId)
    .all<{
      id: string; doNo: string | null; status: string | null;
      driverName: string | null; hookkaExpectedDD: string | null;
      dispatchedAt: string | null; deliveredAt: string | null;
    }>();
  const linkedDOs = (dosRes.results ?? []).map((d) => ({
    id: d.id,
    doNo: d.doNo ?? "",
    status: d.status ?? "",
    driverName: d.driverName ?? null,
    scheduledDate: d.hookkaExpectedDD ?? null,
    dispatchedAt: d.dispatchedAt ?? null,
    deliveredAt: d.deliveredAt ?? null,
  }));
  const doIds = linkedDOs.map((d) => d.id);

  // Per-PO delivery: which DO each production-order line shipped on + that DO's
  // status. Lets the Linked Production Orders table show a real per-line
  // delivery state (DO no. + Delivered/Dispatched/…) instead of the operator
  // cross-checking the Delivery page. Reuses the DOs already fetched above.
  const poDeliveryMap = new Map<string, { doNo: string; status: string }>();
  if (doIds.length > 0) {
    const diRes = await c.var.DB.prepare(
      `SELECT productionOrderId, deliveryOrderId
         FROM delivery_order_items
        WHERE deliveryOrderId IN (${doIds.map(() => "?").join(",")})
          AND productionOrderId IS NOT NULL AND productionOrderId <> ''`,
    )
      .bind(...doIds)
      .all<{ productionOrderId: string; deliveryOrderId: string }>();
    const doById = new Map(linkedDOs.map((d) => [d.id, d]));
    for (const di of diRes.results ?? []) {
      const d = doById.get(di.deliveryOrderId);
      if (d && !poDeliveryMap.has(di.productionOrderId)) {
        poDeliveryMap.set(di.productionOrderId, { doNo: d.doNo, status: d.status });
      }
    }
  }

  // Invoices: by SO link OR by any of this SO's DOs. A consolidated invoice
  // anchors its salesOrderId/companySOId to the FIRST SO in the DO, so a
  // non-anchor SO is only reachable via deliveryOrderId.
  const invWhere = ["i.salesOrderId = ?", "i.companySOId = ?"];
  const invParams: unknown[] = [id, companySOId];
  if (doIds.length > 0) {
    invWhere.push(`i.deliveryOrderId IN (${doIds.map(() => "?").join(",")})`);
    invParams.push(...doIds);
  }
  const invRes = await c.var.DB.prepare(
    `SELECT DISTINCT i.id, i.invoiceNo, i.status, i.totalSen, i.paidAmount,
            i.paymentDate
       FROM invoices i
      WHERE ${invWhere.join(" OR ")}
      ORDER BY i.invoiceNo`,
  )
    .bind(...invParams)
    .all<{
      id: string;
      invoiceNo: string | null;
      status: string | null;
      totalSen: number | null;
      paidAmount: number | null;
      paymentDate: string | null;
    }>();
  const linkedInvoices = (invRes.results ?? []).map((i) => ({
    id: i.id,
    invoiceNo: i.invoiceNo ?? "",
    status: i.status ?? "",
    totalSen: i.totalSen ?? 0,
    paidAmount: i.paidAmount ?? 0,
    paymentDate: i.paymentDate ?? null,
  }));

  // Payments: payment_records.allocations is JSON TEXT holding {invoiceId}.
  // Substring match per invoice id (same rough match the payments list uses).
  let linkedPayments: Array<{
    id: string;
    receiptNumber: string;
    date: string;
    amount: number;
    status: string;
  }> = [];
  const invIds = linkedInvoices.map((i) => i.id);
  if (invIds.length > 0) {
    const payRes = await c.var.DB.prepare(
      `SELECT DISTINCT id, receiptNumber, date, amount, status
         FROM payment_records
        WHERE ${invIds.map(() => "allocations LIKE ?").join(" OR ")}
        ORDER BY date`,
    )
      .bind(...invIds.map((iid) => `%"invoiceId":"${iid}"%`))
      .all<{
        id: string;
        receiptNumber: string | null;
        date: string | null;
        amount: number | null;
        status: string | null;
      }>();
    linkedPayments = (payRes.results ?? []).map((p) => ({
      id: p.id,
      receiptNumber: p.receiptNumber ?? "",
      date: p.date ?? "",
      amount: p.amount ?? 0,
      status: p.status ?? "",
    }));
  }

  // Build completedBy map: poId → comma-deduped worker names from scanned JCs.
  const completedByMap = new Map<string, string>();
  for (const cb of completedByRes.results ?? []) {
    const parts = [
      ...(cb.names1 ? cb.names1.split(",") : []),
      ...(cb.names2 ? cb.names2.split(",") : []),
    ].filter((n, i, a) => n && a.indexOf(n) === i); // distinct, non-empty
    if (parts.length) completedByMap.set(cb.productionOrderId, parts.join(", "));
  }

  return c.json({
    success: true,
    data: rowToSO(so, itemsRes.results ?? []),
    lockReason,
    linkedPOs: (posRes.results ?? []).map((p) => ({
      id: p.id,
      poNo: p.poNo,
      productName: p.productName ?? "",
      productCode: p.productCode ?? "",
      itemCategory: p.itemCategory ?? "",
      quantity: p.quantity ?? 0,
      status: p.status ?? "",
      progress: p.progress ?? 0,
      currentDepartment: p.currentDepartment ?? "",
      completedDate: p.completedDate ?? null,
      completedBy: completedByMap.get(p.id) ?? null,
      deliveryDoNo: poDeliveryMap.get(p.id)?.doNo ?? "",
      deliveryStatus: poDeliveryMap.get(p.id)?.status ?? "",
    })),
    statusHistory: (statusRes.results ?? []).map(rowToStatusChange),
    priceOverrides: (overridesRes.results ?? []).map(rowToPriceOverride),
    linkedDOs,
    linkedInvoices,
    linkedPayments,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/sales-orders/:id — update SO, status transitions, replace items
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  // Self-applying columns (incl. 0160 repairScope) — PUT replaces items via
  // DELETE+INSERT, so the column must exist before the INSERT runs on a
  // fresh isolate that never served a POST.
  await ensurePendingMigrations(c.var.DB);
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM sales_orders WHERE id = ?",
    )
      .bind(id)
      .first<SalesOrderRow>();
    if (!existing) {
      return c.json({ success: false, error: "Order not found" }, 404);
    }
    // Cascade lock — once any production order has reached COMPLETED, the
    // SO's structural fields (items, quantities, prices, customer) become
    // read-only because tangible output exists. Status transitions
    // (CONFIRM, ON_HOLD, RESUME, CANCEL) bypass the lock — those are
    // handled below this guard, BEFORE the items/header re-write block.
    const lockMsg = await checkSalesOrderLocked(c.var.DB, id);
    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.items &&
      !body.customerId &&
      !body.companySODate &&
      !body.customerDeliveryDate &&
      !body.hookkaExpectedDD;
    if (lockMsg && !isStatusOnly) {
      return c.json(lockedResponse(lockMsg), 403);
    }

    // ---------------------------------------------------------------------
    // Edit-eligibility re-check (defense-in-depth, mirrors the
    // /:id/edit-eligibility GET endpoint logic).
    //
    // Option D unified rule (2026-05-06): structural edits are allowed
    // while every JC under the SO is still WAITING (or CANCELLED). The
    // moment any JC has been stamped IN_PROGRESS / COMPLETED / TRANSFERRED
    // we hard-lock the SO — a teardown+rebuild from sales_order_items
    // would orphan that work. Subsumes the old dept_completed rule.
    //
    // Status-only edits skip the gate (an admin closing/cancelling
    // shouldn't be blocked).
    // ---------------------------------------------------------------------
    if (
      !isStatusOnly &&
      (existing.status === "IN_PRODUCTION" ||
        existing.status === "CONFIRMED")
    ) {
      const productionStartedRes = await c.var.DB
        .prepare(
          `SELECT jc.status, jc.departmentName, jc.departmentCode, jc.completedDate
             FROM job_cards jc
             JOIN production_orders po ON po.id = jc.productionOrderId
            WHERE po.salesOrderId = ?
              AND jc.status NOT IN ('WAITING', 'CANCELLED')
            ORDER BY jc.sequence ASC, jc.id ASC
            LIMIT 1`,
        )
        .bind(id)
        .first<{
          status: string | null;
          departmentName: string | null;
          departmentCode: string | null;
          completedDate: string | null;
        }>();

      if (productionStartedRes && productionStartedRes.status) {
        const dept =
          productionStartedRes.departmentName ||
          productionStartedRes.departmentCode ||
          "A department";
        return c.json(
          {
            success: false,
            error: `Cannot edit — ${dept} has started production (job card status: ${productionStartedRes.status}). Editing items would orphan in-flight work.`,
            reason: "production_started",
            startedDept: dept,
            startedDeptCode: productionStartedRes.departmentCode || "",
            jcStatus: productionStartedRes.status,
            completedAt: productionStartedRes.completedDate || null,
          },
          403,
        );
      }
    }
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];
    let newStatus: string = existing.status;
    let pendingStatusChangeId: string | null = null;
    let isDraftToConfirmed = false;
    // Cascade result from ON_HOLD / CANCELLED / RESUME transitions — prepended
    // to the batch below so the SO + PO + JC updates land atomically.
    let cascade: SOCascadeResult | null = null;
    // ON HOLD reason capture (0185). When the SO transitions INTO ON_HOLD the
    // operator must supply a non-empty reason (enforced below + on the FE
    // hold modal — same reject both sides). Stamped onto the SO row + the
    // so_status_changes audit notes. Cleared (NULL) on any non-hold
    // transition so a resumed / cancelled order never shows a stale reason.
    let holdReason: string | null = null; // set on → ON_HOLD, NULL otherwise
    let clearHoldFields = false; // true on any transition OUT of / not-into hold

    // --- Status change with validation ---
    if (body.status && body.status !== existing.status) {
      const requested = body.status as string;
      const validNext = VALID_TRANSITIONS[existing.status] || [];
      if (!validNext.includes(requested)) {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${existing.status} -> ${requested}. Valid transitions: ${validNext.join(", ") || "none"}`,
          },
          400,
        );
      }
      newStatus = requested;
      // 2026-04-28: confirm-equivalent transitions are DRAFT/PENDING → either
      // CONFIRMED (legacy callers) or IN_PRODUCTION (new direct path). Both
      // need the production-order cascade and the same audit-row deferral.
      isDraftToConfirmed =
        (existing.status === "DRAFT" || existing.status === "PENDING") &&
        (newStatus === "CONFIRMED" || newStatus === "IN_PRODUCTION");

      // ON HOLD reason gate (0185). Putting an order on hold REQUIRES a
      // non-empty reason — the FE hold modal enforces this too; this is the
      // backend half of the unified FE+BE input-rejection rule. Any other
      // transition clears the previously stored reason so a resumed /
      // cancelled order never carries a stale "why paused" note.
      if (newStatus === "ON_HOLD") {
        const reason =
          typeof body.holdReason === "string" ? body.holdReason.trim() : "";
        if (!reason) {
          return c.json(
            {
              success: false,
              error: "A reason is required to put this order on hold.",
            },
            400,
          );
        }
        holdReason = reason;
      } else {
        clearHoldFields = true;
      }

      // Pre-flight: block CANCELLED transition when any job_card under this
      // SO's POs has a completedDate stamped. Stranded inventory would result
      // if we cascaded CANCELLED through completed work — operators must
      // first clear the completion dates or reassign those finished units to
      // another order. Returns 409 Conflict (distinct from 4xx validation
      // errors) so the frontend can render a specific blocked-cancel modal.
      if (newStatus === "CANCELLED") {
        const blockingRes = await c.var.DB
          .prepare(
            `SELECT jc.id, jc.completedDate, jc.departmentCode, jc.departmentName, po.poNo
               FROM job_cards jc
               JOIN production_orders po ON po.id = jc.productionOrderId
              WHERE po.salesOrderId = ?
                AND jc.completedDate IS NOT NULL
                AND jc.completedDate <> ''
                AND jc.status NOT IN ('CANCELLED')
              ORDER BY jc.completedDate ASC
              LIMIT 5`,
          )
          .bind(id)
          .all<{
            id: string;
            completedDate: string;
            departmentCode: string | null;
            departmentName: string | null;
            poNo: string;
          }>();
        const blocking = blockingRes.results ?? [];
        if (blocking.length > 0) {
          return c.json(
            {
              success: false,
              error: "Cannot cancel: completed work blocks cancellation",
              blockingItems: blocking.map((b) => ({
                poNo: b.poNo,
                departmentCode: b.departmentCode || "",
                departmentName: b.departmentName || b.departmentCode || "Department",
                completedDate: b.completedDate,
              })),
              reason:
                "Clear completion dates or reassign these items to another order before cancelling.",
            },
            409,
          );
        }
      }

      // Run cascade for ON_HOLD / CANCELLED transitions and for RESUME
      // (ON_HOLD → CONFIRMED / IN_PRODUCTION). cascadeSOStatusToPOs is a no-op
      // for any other transition, so calling it unconditionally is cheap.
      cascade = await cascadeSOStatusToPOs(
        c.var.DB,
        id,
        newStatus,
        existing.status,
        now,
      );

      // Defer the status-change INSERT until after the PO cascade runs so we
      // can stamp autoActions with the created PO numbers.
      pendingStatusChangeId = genStatusId();
      if (!isDraftToConfirmed) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO so_status_changes
               (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            pendingStatusChangeId,
            id,
            existing.status,
            newStatus,
            (body.changedBy as string) || "Admin",
            now,
            // On a hold, the audit note IS the reason ("On hold: <reason>") so
            // the status-history panel reads meaningfully instead of the
            // generic default. Other transitions keep the existing default.
            holdReason
              ? `On hold: ${holdReason}`
              : (body.statusNotes as string) || `Status changed to ${newStatus}`,
            JSON.stringify(cascade?.actions ?? []),
          ),
        );
        // Queue the cascade UPDATEs for POs (and job_cards on CANCELLED).
        if (cascade && cascade.statements.length > 0) {
          statements.push(...cascade.statements);
        }
      }
    }

    // --- Customer / hub resolution ---
    let customerId = existing.customerId;
    let customerName = existing.customerName;
    let customerState = existing.customerState ?? "";
    let hubId = existing.hubId;
    let hubName = existing.hubName ?? "";

    if (body.customerId) {
      const customer = await c.var.DB.prepare(
        "SELECT id, name FROM customers WHERE id = ?",
      )
        .bind(body.customerId)
        .first<{ id: string; name: string }>();
      if (customer) {
        customerId = customer.id;
        customerName = customer.name;
      }
    }

    if (body.hubId !== undefined) {
      if (body.hubId) {
        const hub = await c.var.DB.prepare(
          "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
        )
          .bind(body.hubId, customerId)
          .first<{ id: string; state: string | null; shortName: string }>();
        if (hub) {
          hubId = hub.id;
          hubName = hub.shortName;
          customerState = hub.state ?? customerState;
        } else {
          hubId = null;
          hubName = "";
        }
      } else {
        hubId = null;
        hubName = "";
      }
    }

    // --- Merge scalar fields ---
    // 0134 — isServiceOrder is allowed in the PUT body but rarely changes
    // (the only legitimate reason is a backfill / admin correction). When
    // absent we preserve whatever the row already has.
    const mergedIsServiceOrder: boolean =
      typeof body.isServiceOrder === "boolean"
        ? body.isServiceOrder
        : existing.isServiceOrder === true;
    const merged = {
      customerPO: body.customerPO ?? existing.customerPO ?? "",
      customerPOId: body.customerPOId ?? existing.customerPOId ?? "",
      customerPODate: body.customerPODate ?? existing.customerPODate ?? "",
      customerSO: body.customerSO ?? existing.customerSO ?? "",
      customerSOId: body.customerSOId ?? existing.customerSOId ?? "",
      reference: body.reference ?? existing.reference ?? "",
      customerState,
      companySO: body.companySO ?? existing.companySO ?? "",
      companySODate: body.companySODate ?? existing.companySODate ?? "",
      customerDeliveryDate:
        body.customerDeliveryDate ?? existing.customerDeliveryDate ?? "",
      hookkaExpectedDD: body.hookkaExpectedDD ?? existing.hookkaExpectedDD ?? "",
      hookkaDeliveryOrder:
        body.hookkaDeliveryOrder ?? existing.hookkaDeliveryOrder ?? "",
      overdue: body.overdue ?? existing.overdue ?? "PENDING",
      notes: body.notes ?? existing.notes ?? "",
    };

    // --- Replace items (if provided) ---
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;

    if (body.items) {
      const rawItems: Array<Record<string, unknown>> = body.items;

      // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single SO.
      // Same rule as POST — see helper for the why. Fail fast before any
      // DB writes are queued.
      if (
        hasMixedSofaBedframe(
          rawItems.map((it) => ({
            itemCategory:
              typeof it.itemCategory === "string" ? it.itemCategory : null,
          })),
        )
      ) {
        return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
      }

      // Sofa qty>1 — same rule as POST.
      {
        const offending = findInvalidSofaQty(
          rawItems.map((it, i) => ({
            itemCategory:
              typeof it.itemCategory === "string" ? it.itemCategory : null,
            quantity:
              typeof it.quantity === "number" ? it.quantity : Number(it.quantity ?? 1),
            productCode:
              typeof it.productCode === "string" ? it.productCode : null,
            lineNo:
              typeof it.lineNo === "number" ? it.lineNo : i + 1,
          })),
        );
        if (offending) {
          return c.json(
            { success: false, error: formatSofaQtyError(offending) },
            400,
          );
        }
      }

      // Fabric integrity gate — see the POST handler for the rationale.
      // Reject before any items are deleted/inserted so a bad payload
      // can't half-write a new row set.
      {
        const fabCheck = await validateFabricCodes(
          c.var.DB,
          rawItems.map((it) => (it.fabricCode as string | null | undefined)),
        );
        if (!fabCheck.valid) {
          return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
        }
      }

      // SOFA seat-size gate — see the POST handler for the rationale.
      {
        const sofaCheck = await validateSofaSizeLabels(
          c.var.DB,
          rawItems.map((it) => ({
            itemCategory: typeof it.itemCategory === "string" ? it.itemCategory : null,
            sizeLabel: typeof it.sizeLabel === "string" ? it.sizeLabel : null,
          })),
        );
        if (!sofaCheck.valid) {
          return c.json(
            unknownSofaSizeLabelError(sofaCheck.unknown, sofaCheck.allowed),
            400,
          );
        }
      }

      // Repair Scope gate (0160) — same rule as POST: validate every line,
      // and only service orders may carry a non-FULL scope.
      const repairScopeByLine: (string | null)[] = [];
      for (let i = 0; i < rawItems.length; i++) {
        const check = validateRepairScopeInput(rawItems[i].repairScope);
        if (!check.ok) {
          return c.json(
            { success: false, error: `Line ${i + 1}: ${check.error}` },
            400,
          );
        }
        if (check.canonical && !mergedIsServiceOrder) {
          return c.json(
            {
              success: false,
              error: `Line ${i + 1}: Repair Scope is only available on Service Orders — normal sales orders are always a full build.`,
            },
            400,
          );
        }
        repairScopeByLine.push(check.canonical);
      }

      const oldItemsRes = await c.var.DB.prepare(
        "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
      )
        .bind(id)
        .all<SalesOrderItemRow>();
      const oldItems = oldItemsRes.results ?? [];
      const priceAsOf =
        typeof merged.companySODate === "string" && merged.companySODate
          ? merged.companySODate.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
      // OCR back-door closure (BUG-001 fix): catalog wins on every PUT just
      // like POST. Loaded once here, reused for every line via snapItemToCatalog.
      const productByCodeForPut = await loadProductCatalog(c.var.DB);
      // Pre-resolve the two per-line price lookups ONCE per distinct product
      // instead of per line (was a 3N query storm on a multi-line SO edit).
      // Safe-by-construction: customerId + priceAsOf are constant for this
      // request, so resolveCustomerPriceAsOf(productId) is memoizable, and the
      // products read is the same rows via one WHERE id IN (...). Values are
      // byte-identical to the per-line path — only the query count changes.
      const uniqProductIds = [
        ...new Set(
          rawItems.map((it) => (it.productId as string) || "").filter(Boolean),
        ),
      ];
      const productMap = new Map<
        string,
        { basePriceSen: number | null; seatHeightPrices: unknown }
      >();
      if (uniqProductIds.length) {
        const ph = uniqProductIds.map(() => "?").join(", ");
        const prodRows = await c.var.DB.prepare(
          `SELECT * FROM products WHERE id IN (${ph})`,
        )
          .bind(...uniqProductIds)
          .all<{ id: string; basePriceSen: number | null; seatHeightPrices: unknown }>();
        for (const r of prodRows.results ?? []) productMap.set(r.id, r);
      }
      const customerPriceMap = new Map<
        string,
        Awaited<ReturnType<typeof resolveCustomerPriceAsOf>>
      >();
      if (customerId && !mergedIsServiceOrder && uniqProductIds.length) {
        await Promise.all(
          uniqProductIds.map(async (pid) => {
            try {
              customerPriceMap.set(
                pid,
                await resolveCustomerPriceAsOf(c.var.DB, pid, customerId, priceAsOf),
              );
            } catch {
              customerPriceMap.set(pid, null);
            }
          }),
        );
      }

      // Same owner-editable specials list the POST path uses, read once per
      // request (BUG-2026-07-17-002). Needed on PUT too — without it, editing a
      // scanned SO would re-store the surcharge as 0.
      const cfgSpecialsForPricing = await loadSpecialsConfig(c.var.DB);
      // Ditto for the divan / leg height price lists (2026-07-22). Same
      // reasoning: an edit that omits the price must not zero a height that the
      // owner's list prices.
      const cfgHeightsForPricing = await loadHeightsConfig(c.var.DB);
      const isServiceOrder = existing.isServiceOrder === true;
      const newItems = await Promise.all(rawItems.map(async (item, idx) => {
        const incomingBase = Number(item.basePriceSen) || 0;
        // SOFA lines ALWAYS re-derive their base from the price list, ignoring
        // the incoming value (owner 2026-06-11): every edit re-prices the
        // CURRENT composition — add a piece and the combo pass below discounts
        // the new set; remove a piece and the survivors return to full
        // per-piece price (a combo-split base must not stick once the set is
        // broken). Non-sofa lines keep the operator-typed price (Tier 1).
        const isSofaLine = String(item.itemCategory ?? "") === "SOFA";
        // Seat height for per-seat pricing: the create page sends seatHeight,
        // but edit/stored payloads carry the bare seat size in sizeCode/sizeLabel.
        const numericSize = (s: unknown): s is string =>
          typeof s === "string" && /^\d+(\.\d+)?$/.test(s);
        const seatHeightForPrice = numericSize(item.seatHeight)
          ? (item.seatHeight as string)
          : numericSize(item.sizeCode)
            ? (item.sizeCode as string)
            : numericSize(item.sizeLabel)
              ? (item.sizeLabel as string)
              : "";
        // Service orders: the operator's typed price IS the price — no sofa
        // re-derive, no customer/catalog resolution (0 = free repair; see
        // the POST-side comment, SV-2606-001 RM 730 incident).
        let basePriceSen =
          isSofaLine && !mergedIsServiceOrder ? 0 : incomingBase;
        // Customer-specific price: when the request didn't supply a usable
        // price (or the line is a sofa being re-derived).
        const productIdForLookup = (item.productId as string) || "";
        if (!mergedIsServiceOrder && basePriceSen === 0 && productIdForLookup && customerId) {
          try {
            const cp = customerPriceMap.get(productIdForLookup) ?? null;
            if (cp) {
              if (cp.seatHeightPrices && cp.seatHeightPrices.length > 0 && seatHeightForPrice) {
                const shp = cp.seatHeightPrices.find(
                  (p) => p.height === seatHeightForPrice || p.height === `${seatHeightForPrice}"`,
                );
                basePriceSen = shp?.priceSen ?? cp.basePriceSen ?? 0;
              } else {
                basePriceSen = cp.basePriceSen ?? 0;
              }
            }
          } catch {
            // Non-fatal — keep basePriceSen at 0 if lookup fails.
          }
        }
        // Catalog fallback — parity with POST. Without this, editing a line
        // whose customer price didn't resolve silently zeroed basePriceSen.
        if (!mergedIsServiceOrder && basePriceSen === 0 && productIdForLookup) {
          try {
            const prod = productMap.get(productIdForLookup) ?? null;
            if (prod) {
              let shp: Array<{ height: string; priceSen: number }> = [];
              if (Array.isArray(prod.seatHeightPrices)) {
                shp = prod.seatHeightPrices as typeof shp;
              } else if (typeof prod.seatHeightPrices === "string") {
                try {
                  shp = JSON.parse(prod.seatHeightPrices || "[]");
                } catch {
                  shp = [];
                }
              }
              if (seatHeightForPrice && shp.length > 0) {
                const cell = shp.find(
                  (p) => p.height === seatHeightForPrice || p.height === `${seatHeightForPrice}"`,
                );
                basePriceSen = cell?.priceSen ?? (Number(prod.basePriceSen) || 0);
              } else {
                basePriceSen = Number(prod.basePriceSen) || 0;
              }
            }
          } catch {
            // Non-fatal — leave at 0; the unpriced gate below surfaces it.
          }
        }
        // 2026-07-22 BUG FIX (under-billing, RM 12,455 across divan + leg):
        // these were `Number(item.divanPriceSen) || 0` — the same trust-the-
        // client shape the 07-14 and 07-17 fixes below already repaired for
        // their own columns, left unrepaired here. The scan-a-customer-PO
        // paths post divanHeightInches / legHeightInches with NO price, so on
        // prod every one of the 105 scanned lines carrying a 10"/12" divan was
        // stored at 0 while the 104 typed by hand charged correctly.
        // resolveHeightPriceSen DERIVES only when the field is OMITTED; any
        // supplied number is trusted verbatim — including a deliberate 0.
        const divanPriceSen = resolveHeightPriceSen(
          item.divanPriceSen as number | string | null | undefined,
          item.divanHeightInches as number | string | null | undefined,
          cfgHeightsForPricing.divanHeights,
          isServiceOrder,
        );
        const legPriceSen = resolveHeightPriceSen(
          item.legPriceSen as number | string | null | undefined,
          item.legHeightInches as number | string | null | undefined,
          cfgHeightsForPricing.legHeights,
          isServiceOrder,
        );
        // 2026-07-17 BUG FIX (BUG-2026-07-17-002 — under-billing, RM 8,060 over
        // 66 SOs): this was `Number(item.specialOrderPriceSen) || 0`, which
        // trusted a field the SCAN clients never send. The typed form
        // (sales/create.tsx) computes the surcharge and always posts it, but
        // scan-po-modal.tsx and m/ScanPOSheet.tsx POST here DIRECTLY with only
        // the specialOrder TEXT — so "Divan Full Cover" stored 0 and the RM 80
        // was never billed, while the same option typed by hand charged fine.
        // Same bug class as the totalHeightPriceSen fix noted below.
        // resolveSpecialOrderPriceSen DERIVES only when the field is OMITTED;
        // any supplied number is trusted verbatim — including a deliberate 0
        // (Service Orders are free by design) and a hand-discounted price.
        const specialOrderPriceSen = resolveSpecialOrderPriceSen(
          item,
          cfgSpecialsForPricing,
        );
        // 2026-07-23 — same as the POST path: derive total-height server-side so
        // an SO EDIT re-prices the line WITH its total-height surcharge (stored
        // in its own column) instead of zeroing it. Trusts a supplied number.
        const totalHeightPriceSen = resolveTotalHeightPriceSen(
          item.totalHeightPriceSen as number | string | null | undefined,
          item.gapInches as number | string | null | undefined,
          item.divanHeightInches as number | string | null | undefined,
          item.legHeightInches as number | string | null | undefined,
          cfgHeightsForPricing.totalHeights,
          isServiceOrder,
        );
        const unitPriceSen = calculateUnitPrice({
          basePriceSen,
          divanPriceSen,
          legPriceSen,
          totalHeightPriceSen,
          specialOrderPriceSen,
        });
        const quantity = Number(item.quantity) || 0;
        // Per-line discount (migration 0179). Clamped ≥ 0.
        const discountSen = Math.max(0, Math.round(Number(item.discountSen) || 0));
        const lineTotalSen = Math.max(0, calculateLineTotal(unitPriceSen, quantity) - discountSen);
        const lineNo = idx + 1;
        const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;

        const oldItem = oldItems.find(
          (oi) =>
            oi.id === item.id ||
            (oi.productId === item.productId && oi.lineNo === lineNo),
        );

        const priceOverride =
          oldItem && oldItem.unitPriceSen !== unitPriceSen
            ? {
                id: genOverrideId(),
                originalPrice: oldItem.unitPriceSen,
                overridePrice: unitPriceSen,
                reason:
                  (item.priceOverrideReason as string) || "No reason provided",
                approvedBy: (body.changedBy as string) || "Admin",
              }
            : null;

        // 2026-05-09: fabricId resolve removed (matches POST path). Persist
        // null — column being dropped in a follow-up migration.
        const incomingFabricCode = String(item.fabricCode ?? "");

        // OCR back-door closure (BUG-001 fix, 2026-05-09): catalog wins on
        // every PUT just like POST (cd6a417). When productCode resolves to a
        // catalog product, that product is the source of truth for productId,
        // productName, itemCategory, and (BF/ACC) sizeLabel/sizeCode. Prevents
        // PDF text from sneaking back in via the Edit page when an OCR'd SO
        // gets re-saved.
        //
        // SOFA size pass-through: the SOFA-quote-add fallback that lived
        // here pre-merge (DUP-001 commit f2fa7a9 deleted it) made bare
        // dropdown values diverge from kv_config.sofaSizes canonical. The
        // strict reject gate at the top of this PUT handler
        // (validateSofaSizeLabels) now ensures only canonical values reach
        // here, so snapped.sizeLabel/sizeCode pass through verbatim.
        const snapped = snapItemToCatalog(
          {
            productCode: item.productCode,
            productId: item.productId,
            productName: item.productName,
            itemCategory: item.itemCategory,
            sizeCode: item.sizeCode,
            sizeLabel: item.sizeLabel,
          },
          productByCodeForPut,
        );
        const itemCategory = snapped.itemCategory;
        const normalizedSizeLabel = snapped.sizeLabel;
        const normalizedSizeCode = snapped.sizeCode;

        // Free-text custom specials per line (migration 0074). Same
        // sanitization as the POST path — empty descriptions dropped, the
        // surcharge sum is already folded into specialOrderPriceSen
        // client-side.
        const cleanedCustomSpecials = sanitizeCustomSpecials(item.customSpecials);

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: snapped.productId,
          productCode: snapped.productCode,
          productName: snapped.productName,
          itemCategory,
          sizeCode: normalizedSizeCode,
          sizeLabel: normalizedSizeLabel,
          fabricCode: incomingFabricCode,
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          totalHeightPriceSen,
          customSpecials: cleanedCustomSpecials,
          basePriceSen,
          unitPriceSen,
          discountSen,
          lineTotalSen,
          notes: (item.notes as string) || "",
          // Canonical Repair Scope from the gate above (null = FULL).
          repairScope: repairScopeByLine[idx] ?? null,
          _priceOverride: priceOverride,
          _lineIndex: idx,
        };
      }));

      // Service orders: collapse a FULL component pick to "no components" so a
      // whole-unit repair renders as the complete unit on the DO/badge (#10b).
      if (mergedIsServiceOrder) {
        await canonicalizeRepairScopesAgainstBom(c.var.DB, newItems);
      }

      // Sofa combo renegotiation on EDIT too — previously edit lost the combo
      // discount (the edit page has no combo logic and re-priced at full).
      // Combo discounts are SALES pricing — service-order lines keep the
      // operator-typed price untouched.
      if (!mergedIsServiceOrder) {
        await runSofaComboPass(c.var.DB, customerId, newItems, rawItems);
      }

      // NOTE (owner 2026-06-11): NO RM0 gate on edit either — by explicit request.

      subtotalSen = newItems.reduce((sum, i) => sum + i.lineTotalSen, 0);
      totalSen = subtotalSen;

      // Delete old, insert new
      statements.push(
        c.var.DB.prepare(
          "DELETE FROM sales_order_items WHERE salesOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.var.DB.prepare(
            // repairScope: unquoted camelCase folds to the runtime-added
            // lowercase column `repairscope` (matches POST + migration 0160).
            `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
               productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
               fabricCode, quantity, gapInches, divanHeightInches,
               divanPriceSen, legHeightInches, legPriceSen, specialOrder,
               specialOrderPriceSen, totalHeightPriceSen, customSpecials, basePriceSen, unitPriceSen, discountSen, lineTotalSen, notes, repairScope)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.lineNo,
            item.lineSuffix,
            item.productId,
            item.productCode,
            item.productName,
            item.itemCategory,
            item.sizeCode,
            item.sizeLabel,
            item.fabricCode,
            item.quantity,
            item.gapInches,
            item.divanHeightInches,
            item.divanPriceSen,
            item.legHeightInches,
            item.legPriceSen,
            item.specialOrder,
            item.specialOrderPriceSen,
            item.totalHeightPriceSen,
            serializeCustomSpecials(item.customSpecials),
            item.basePriceSen,
            item.unitPriceSen,
            item.discountSen,
            item.lineTotalSen,
            item.notes,
            item.repairScope,
          ),
        );

        if (item._priceOverride) {
          statements.push(
            c.var.DB.prepare(
              `INSERT INTO price_overrides
                 (id, soId, soNumber, lineIndex, originalPrice, overridePrice,
                  reason, approvedBy, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              item._priceOverride.id,
              id,
              existing.companySOId ?? "",
              item._lineIndex,
              item._priceOverride.originalPrice,
              item._priceOverride.overridePrice,
              item._priceOverride.reason,
              item._priceOverride.approvedBy,
              now,
            ),
          );
        }
      }
    }

    statements.push(
      c.var.DB.prepare(
        `UPDATE sales_orders SET
           customerPO = ?, customerPOId = ?, customerPODate = ?,
           customerSO = ?, customerSOId = ?, reference = ?,
           customerId = ?, customerName = ?, customerState = ?,
           hubId = ?, hubName = ?, companySO = ?, companySODate = ?,
           customerDeliveryDate = ?, hookkaExpectedDD = ?, hookkaDeliveryOrder = ?,
           subtotalSen = ?, totalSen = ?, status = ?, overdue = ?,
           notes = ?, is_service_order = ?,
           hold_reason = ?, held_by = ?, held_at = ?,
           pre_hold_status = ?, pre_cancel_status = ?,
           sales_org_code = ?,
           updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.customerPO,
        merged.customerPOId,
        merged.customerPODate,
        merged.customerSO,
        merged.customerSOId,
        merged.reference,
        customerId,
        customerName,
        merged.customerState,
        hubId,
        hubName,
        merged.companySO,
        merged.companySODate,
        merged.customerDeliveryDate,
        merged.hookkaExpectedDD,
        merged.hookkaDeliveryOrder,
        subtotalSen,
        totalSen,
        newStatus,
        merged.overdue,
        merged.notes,
        mergedIsServiceOrder,
        // ON HOLD reason (0185). Set on → ON_HOLD; NULLed on any transition
        // out of / not into hold; preserved otherwise (e.g. a header-only
        // edit while the order is on hold keeps the existing reason).
        holdReason !== null
          ? holdReason
          : clearHoldFields
            ? null
            : existing.holdReason ?? existing.hold_reason ?? null,
        holdReason !== null
          ? ((body.changedBy as string) || "Admin")
          : clearHoldFields
            ? null
            : existing.heldBy ?? existing.held_by ?? null,
        holdReason !== null
          ? now
          : clearHoldFields
            ? null
            : existing.heldAt ?? existing.held_at ?? null,
        // Where to come BACK to.
        //
        // pre_hold_status: the detail page has always read `order.preHoldStatus`
        // to decide where Resume goes, but nothing ever wrote it — so an
        // IN_PRODUCTION order put on hold resumed to CONFIRMED, silently moving
        // BACKWARDS a stage while the dialog cheerfully announced it.
        //
        // pre_cancel_status: the same idea for cancel, which is what makes the
        // undo exact rather than a guess (owner 2026-08-04: "i silap cancel").
        //
        // Both are captured on the way IN and cleared on the way OUT, and a
        // second cancel can never overwrite the stored value with 'CANCELLED'
        // because `existing.status` is only stored when it is not the target.
        newStatus === "ON_HOLD" && existing.status !== "ON_HOLD"
          ? existing.status
          : newStatus === "ON_HOLD"
            ? existing.preHoldStatus ?? existing.pre_hold_status ?? null
            : null,
        newStatus === "CANCELLED" && existing.status !== "CANCELLED"
          ? existing.status
          : newStatus === "CANCELLED"
            ? existing.preCancelStatus ?? existing.pre_cancel_status ?? null
            : null,
        // Multi-Company Phase 2 — company code. Only changes when the operator
        // explicitly supplies body.salesOrgCode; otherwise the existing value
        // is preserved (a header-only edit never resets the company), and a
        // pre-column row falls back to HOOKKA.
        typeof body.salesOrgCode === "string" && body.salesOrgCode.trim()
          ? resolveCompanyCode(body.salesOrgCode)
          : readCompanyCode(existing.salesOrgCode, existing.sales_org_code),
        now,
        id,
      ),
    );

    // Branch follows the order: propagate the (possibly edited) hub to this
    // SO's in-stock FG units so their packing stickers reflect the current
    // hub. Shipped/delivered units are left alone (their sticker is already
    // printed). Part of the BUG-2026-06-05 sticker-hub fix.
    if (hubName) {
      statements.push(
        c.var.DB.prepare(
          "UPDATE fg_units SET customerHub = ? WHERE soId = ? AND status NOT IN ('LOADED','DELIVERED','RETURNED')",
        ).bind(hubName, id),
      );
    }

    // --- DRAFT -> CONFIRMED cascade: auto-create production_orders ---
    let createdProductionOrders: CreatedProductionOrder[] = [];
    if (isDraftToConfirmed) {
      // BOM completeness guard — checks the items that will actually be
      // persisted (body.items if provided, else current DB rows). Fires
      // before batch runs so a 422 leaves the SO + PO tables untouched.
      const bomCheckItems: SalesOrderItemRow[] = body.items
        ? (body.items as Array<Record<string, unknown>>).map((item, idx) => ({
            id: (item.id as string) || "",
            salesOrderId: id,
            lineNo: idx + 1,
            lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
            productId: (item.productId as string) || "",
            productCode: (item.productCode as string) || "",
            productName: (item.productName as string) || "",
            itemCategory: (item.itemCategory as string) || "BEDFRAME",
            sizeCode: (item.sizeCode as string) || "",
            sizeLabel: (item.sizeLabel as string) || "",
            fabricCode: (item.fabricCode as string) || "",
            quantity: Number(item.quantity) || 0,
            gapInches: (item.gapInches as number | null) ?? null,
            divanHeightInches: (item.divanHeightInches as number | null) ?? null,
            divanPriceSen: Number(item.divanPriceSen) || 0,
            legHeightInches: (item.legHeightInches as number | null) ?? null,
            legPriceSen: Number(item.legPriceSen) || 0,
            specialOrder: (item.specialOrder as string) || "",
            specialOrderPriceSen: Number(item.specialOrderPriceSen) || 0,
            totalHeightPriceSen: Number(item.totalHeightPriceSen) || 0,
            customSpecials: serializeCustomSpecials(
              sanitizeCustomSpecials(item.customSpecials),
            ),
            basePriceSen: Number(item.basePriceSen) || 0,
            unitPriceSen: 0,
            discountSen: 0,
            lineTotalSen: 0,
            notes: (item.notes as string) || "",
          }))
        : (
            await c.var.DB.prepare(
              "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
            )
              .bind(id)
              .all<SalesOrderItemRow>()
          ).results ?? [];

      const incompleteProducts = await findIncompleteBomProducts(
        c.var.DB,
        bomCheckItems,
      );
      if (incompleteProducts.length > 0) {
        return c.json(
          {
            success: false,
            error: "BOM incomplete — cannot confirm. Save as draft first.",
            details: { incompleteProducts },
          },
          422,
        );
      }

      // Build the "effective" SO row (merged fields) so the PO cascade uses
      // the freshest customer/hub/date values — body.items may also have
      // replaced items already queued for delete+insert above.
      const effectiveSO: SalesOrderRow = {
        ...existing,
        customerPOId: merged.customerPOId,
        reference: merged.reference,
        customerId,
        customerName,
        customerState: merged.customerState,
        hubId,
        hubName,
        companySODate: merged.companySODate,
        customerDeliveryDate: merged.customerDeliveryDate,
        hookkaExpectedDD: merged.hookkaExpectedDD,
      };

      // Items source: if the body is replacing items, read them from the body
      // so we can cascade against the NEW items. Otherwise fetch from DB.
      let effectiveItems: SalesOrderItemRow[];
      if (body.items) {
        const rawItems: Array<Record<string, unknown>> = body.items;
        effectiveItems = rawItems.map((item, idx) => {
          const lineNo = idx + 1;
          const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;
          return {
            id: (item.id as string) || "",
            salesOrderId: id,
            lineNo,
            lineSuffix,
            productId: (item.productId as string) || "",
            productCode: (item.productCode as string) || "",
            productName: (item.productName as string) || "",
            itemCategory: (item.itemCategory as string) || "BEDFRAME",
            sizeCode: (item.sizeCode as string) || "",
            sizeLabel: (item.sizeLabel as string) || "",
            fabricCode: (item.fabricCode as string) || "",
            quantity: Number(item.quantity) || 0,
            gapInches: (item.gapInches as number | null) ?? null,
            divanHeightInches: (item.divanHeightInches as number | null) ?? null,
            divanPriceSen: Number(item.divanPriceSen) || 0,
            legHeightInches: (item.legHeightInches as number | null) ?? null,
            legPriceSen: Number(item.legPriceSen) || 0,
            specialOrder: (item.specialOrder as string) || "",
            specialOrderPriceSen: Number(item.specialOrderPriceSen) || 0,
            totalHeightPriceSen: Number(item.totalHeightPriceSen) || 0,
            customSpecials: serializeCustomSpecials(
              sanitizeCustomSpecials(item.customSpecials),
            ),
            basePriceSen: Number(item.basePriceSen) || 0,
            unitPriceSen: 0,
            discountSen: 0,
            lineTotalSen: 0,
            notes: (item.notes as string) || "",
            // Repair Scope — the items gate above already validated every
            // line (this branch only runs when body.items was provided);
            // re-canonicalize so the cascade sees the same stored form.
            repairScope: (() => {
              const v = validateRepairScopeInput(item.repairScope);
              return v.ok ? v.canonical : null;
            })(),
          };
        });
      } else {
        const itemsRes = await c.var.DB.prepare(
          "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
        )
          .bind(id)
          .all<SalesOrderItemRow>();
        effectiveItems = itemsRes.results ?? [];
      }

      const { statements: poStmts, created, preExisting } =
        await createProductionOrdersForSO(
          c.var.DB,
          effectiveSO,
          effectiveItems,
        );
      createdProductionOrders = created;

      const autoActions = preExisting
        ? ["Production orders already exist for this SO — skipped duplicate creation."]
        : created.map((po) => `Created PO ${po.poNo}`);

      statements.push(
        c.var.DB.prepare(
          `INSERT INTO so_status_changes
             (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          pendingStatusChangeId ?? genStatusId(),
          id,
          existing.status,
          newStatus,
          (body.changedBy as string) || "Admin",
          now,
          (body.statusNotes as string) || `Status changed to ${newStatus}`,
          JSON.stringify(autoActions),
        ),
      );
      statements.push(...poStmts);
    }

    await c.var.DB.batch(statements);

    // ---------------------------------------------------------------------
    // Cache invalidation for the ON_HOLD / CANCELLED / RESUME cascade.
    //
    // cascadeSOStatusToPOs has just rewritten production_orders.status for
    // every downstream PO, but the dept sheets do NOT read that table live —
    // they read (1) the production_orders_list_snapshot cache-aside layer and
    // (2) a KV body keyed by a per-org version. Neither notices a write made
    // from THIS module, so the shop floor kept seeing the pre-hold rows:
    //
    //   2026-07-22 — SO-2607-120 went ON_HOLD at 14:22:26Z and all 6 POs
    //   followed in the same batch, yet the Fab Sew sheet (snapshot built
    //   06:19Z) still rendered 11 plain PENDING rows with no ON HOLD badge.
    //   The owner reasonably read that as "the hold didn't run". A hold the
    //   floor cannot see is a hold that did not happen — production keeps
    //   cutting fabric on an order the customer may be cancelling.
    //
    // The snapshot layer's own freshness probe is documented as unreliable
    // (mixed TEXT/TIMESTAMP updated_at compares — see snapshot.ts), which is
    // why the hub-change path already wipes explicitly rather than trusting
    // it. Do the same here, and bump the KV version too: wiping only the
    // snapshot still leaves a warm KV body serving X-Cache: HIT for the rest
    // of its 5-minute TTL (BUG-2026-06-09-005, "doing only one layer").
    //
    // Gated on the cascade actually touching POs so an ordinary field edit
    // pays nothing. Best-effort — the cascade has already committed, so a
    // failed wipe must not fail the request.
    if (cascade && cascade.affectedPoCount > 0) {
      try {
        const orgId = getOrgId(c);
        await invalidateOrderCascadeSnapshots(c.var.DB, orgId, "sales");
        await bumpPoListCacheVersion(c, orgId);
      } catch (err) {
        console.warn(
          "[so-status-cascade] cache invalidation failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ---------------------------------------------------------------------
    // Option D — pre-production rebuild (2026-05-06).
    //
    // When the SO is CONFIRMED or IN_PRODUCTION (NOT DRAFT) and the operator
    // edited items, treat sales_order_items as the single source of truth:
    // teardown every existing production_orders + job_cards row for this SO
    // and re-fan-out from the freshly-written items. The Rule 2 gate above
    // already proved no JC has moved past WAITING, so this is safe.
    //
    // Skipped when:
    //   * isStatusOnly — no items changed, nothing to rebuild.
    //   * isDraftToConfirmed — the confirm cascade above already created POs
    //     from the new items via createProductionOrdersForSO; rebuilding now
    //     would double-fire (existing-PO short-circuit returns the just-made
    //     ones, but we'd also re-DELETE+rebuild needlessly).
    //   * existing.status === "DRAFT" and not transitioning — DRAFT has no
    //     POs yet by definition.
    //
    // Order matters in the DELETE: fg_units → job_cards → production_orders.
    // fg_units.po_id is a NOT-NULL FK without CASCADE; its presence on a
    // PENDING / fan-out-stub row would FK-block the PO delete. Pre-WAITING
    // SOs only have PENDING fg_units stubs (the Rule 2 gate forbids any PO
    // with non-PENDING fg_units), so removing them is lossless. job_cards
    // CASCADE on productionOrderId, but we DELETE explicitly to be defensive
    // against schema drift. piece_pics CASCADE on jobCardId.
    // ---------------------------------------------------------------------
    const itemsChanged = !!body.items;
    const shouldRebuild =
      itemsChanged &&
      !isStatusOnly &&
      !isDraftToConfirmed &&
      existing.status !== "DRAFT" &&
      existing.status !== "PENDING" &&
      // Skip rebuild on terminal/cancelled transitions — cascade already
      // handled the JC/PO state for those.
      newStatus !== "CANCELLED" &&
      newStatus !== "ON_HOLD";

    if (shouldRebuild) {
      // Re-fetch the freshly-written SO + items so the rebuild uses the
      // PUT's mutated state (not the pre-batch `existing` snapshot).
      const freshSO = await c.var.DB
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(id)
        .first<SalesOrderRow>();
      const freshItemsRes = await c.var.DB
        .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
        .bind(id)
        .all<SalesOrderItemRow>();
      const freshItems = freshItemsRes.results ?? [];

      if (freshSO && freshItems.length > 0) {
        // Build the rebuild statements FIRST (read-only), then run DELETE
        // + INSERTs in one batch. forceRebuild=true so the builder doesn't
        // bail on the about-to-be-deleted POs (deterministic poId
        // pord-{soId}-NN collides with the existing rows, but the DELETE
        // in the same batch frees them first).
        const built = await createProductionOrdersForOrder(
          c.var.DB,
          {
            id: freshSO.id,
            sourceType: "SO",
            companyOrderId: freshSO.companySOId ?? "",
            companyOrderDate: freshSO.companySODate,
            customerPOId: freshSO.customerPOId,
            reference: freshSO.reference,
            customerName: freshSO.customerName,
            customerState: freshSO.customerState,
            hookkaExpectedDD: freshSO.hookkaExpectedDD,
            customerDeliveryDate: freshSO.customerDeliveryDate,
          },
          freshItems.map((it) => ({
            lineNo: it.lineNo,
            productId: it.productId,
            productCode: it.productCode,
            productName: it.productName,
            itemCategory: it.itemCategory,
            sizeCode: it.sizeCode,
            sizeLabel: it.sizeLabel,
            fabricCode: it.fabricCode,
            quantity: it.quantity,
            gapInches: it.gapInches,
            divanHeightInches: it.divanHeightInches,
            legHeightInches: it.legHeightInches,
            specialOrder: it.specialOrder,
            notes: it.notes,
            // Repair Scope (0160) — dual-key: SELECT * rows carry the
            // folded-lowercase key (runtime-added column).
            repairScope: it.repairScope ?? it.repairscope ?? null,
          })),
          { forceRebuild: true },
        );

        const deleteFgUnitsStmt = c.var.DB
          .prepare(
            `DELETE FROM fg_units WHERE po_id IN (
               SELECT id FROM production_orders WHERE salesOrderId = ?)`,
          )
          .bind(id);
        const deleteJcsStmt = c.var.DB
          .prepare(
            `DELETE FROM job_cards WHERE productionOrderId IN (
               SELECT id FROM production_orders WHERE salesOrderId = ?)`,
          )
          .bind(id);
        const deletePosStmt = c.var.DB
          .prepare("DELETE FROM production_orders WHERE salesOrderId = ?")
          .bind(id);

        // FIX 5 — preserve packing-sticker tokens across the re-explosion. The
        // rebuild DELETEs every job_card for this SO's POs and recreates them
        // with brand-new ids, orphaning the qr_token on any already-printed
        // PACKING sticker → its /p/<token> page would 404. Copy the about-to-be-
        // deleted PACKING cards (that have a minted token) into job_cards_archive
        // FIRST, so the archive-aware resolver (FIX 1) keeps those old stickers
        // working. Archive the FULL rows (SELECT jc.*) exactly like the admin
        // archive run, so the column list always matches. Best-effort + awaited
        // before the batch: a failure here must NEVER block the rebuild.
        try {
          const archivedAt = new Date().toISOString();
          await c.var.DB.prepare(
            `INSERT INTO job_cards_archive
               SELECT jc.*, ? AS "archivedAt"
                 FROM job_cards jc
                WHERE jc.productionOrderId IN (
                        SELECT id FROM production_orders WHERE salesOrderId = ?)
                  AND jc.departmentCode = 'PACKING'
                  AND jc.qr_token IS NOT NULL
                  AND jc.qr_token <> ''`,
          )
            .bind(archivedAt, id)
            .run();
        } catch (e) {
          console.warn(
            "[sales-orders PUT] preserve packing qr_token to archive skipped",
            e,
          );
        }

        await c.var.DB.batch([
          deleteFgUnitsStmt,
          deleteJcsStmt,
          deletePosStmt,
          ...built.statements,
        ]);
        createdProductionOrders = built.created;
      }
    }

    // -------------------------------------------------------------------
    // BUG-2026-05-09-004 fix — targeted re-cascade on header date change.
    //
    // The rebuild block above DELETE+CREATEs everything when items
    // changed; it picks up new dates as a side effect. But operator can
    // also save a header-only PUT (status change, dates change) where
    // `body.items` is omitted, so itemsChanged=false and the rebuild
    // skips. Before this fix, JC dueDates and PO targetEndDates stayed
    // frozen at confirm time even when the customer pushed the delivery
    // date out by a week — shop floor saw stale dates on the schedule.
    //
    // Approach: in-place UPDATE (not destroy + recreate), so PO IDs / JC
    // IDs / PIC assignments / completedDate stay intact. We only touch
    // dueDate + targetEndDate. Skips any JC that's already completed —
    // re-dating finished work is wrong and confusing.
    //
    // Runs ONLY when:
    //   - rebuild did NOT fire (else dates are already fresh),
    //   - customerDeliveryDate or hookkaExpectedDD actually changed,
    //   - existing.status indicates POs exist (not DRAFT/PENDING).
    // -------------------------------------------------------------------
    const customerDDBefore = (existing.customerDeliveryDate ?? "").slice(0, 10);
    const customerDDAfter = (merged.customerDeliveryDate ?? "").slice(0, 10);
    const hookkaDDBefore = (existing.hookkaExpectedDD ?? "").slice(0, 10);
    const hookkaDDAfter = (merged.hookkaExpectedDD ?? "").slice(0, 10);
    const headerDatesChanged =
      customerDDBefore !== customerDDAfter ||
      hookkaDDBefore !== hookkaDDAfter;
    const recascadeApplicable =
      headerDatesChanged &&
      !shouldRebuild &&
      existing.status !== "DRAFT" &&
      existing.status !== "PENDING" &&
      existing.status !== "CANCELLED";

    if (recascadeApplicable) {
      try {
        type PoLite = {
          id: string;
          itemCategory: string;
        };
        type JcLite = {
          id: string;
          productionOrderId: string;
          departmentCode: string | null;
          completedDate: string | null;
        };
        const [posRes, jcsRes, leadTimes, hookkaDDBuffer, leadTimeSettings] =
          await Promise.all([
            c.var.DB
              .prepare(
                `SELECT id, itemCategory FROM production_orders WHERE salesOrderId = ?`,
              )
              .bind(id)
              .all<PoLite>(),
            c.var.DB
              .prepare(
                `SELECT jc.id, jc.productionOrderId, jc.departmentCode, jc.completedDate
                   FROM job_cards jc
                   JOIN production_orders po ON po.id = jc.productionOrderId
                  WHERE po.salesOrderId = ?`,
              )
              .bind(id)
              .all<JcLite>(),
            loadLeadTimes(c.var.DB),
            loadHookkaDDBuffer(c.var.DB),
            loadLeadTimeSettings(c.var.DB),
          ]);
        // Auto-schedule OFF => header-date change still moves PO targetEndDate
        // (the delivery anchor) but must NOT overwrite job_card dueDates, so
        // any dates staff entered manually are preserved.
        const autoSchedule = leadTimeSettings.autoScheduleEnabled;
        const pos = posRes.results ?? [];
        const jcs = jcsRes.results ?? [];
        const anchorByPoId = new Map<string, string>();
        const updateStmts: D1PreparedStatement[] = [];

        for (const po of pos) {
          const category = po.itemCategory || "BEDFRAME";
          const buf = hookkaDDBufferFor(hookkaDDBuffer, category);
          // Same anchor formula as production-builder.ts:488-494.
          // explicit hookkaExpectedDD wins; else customerDD minus buffer.
          const anchor = hookkaDDAfter
            ? hookkaDDAfter
            : customerDDAfter
              ? addDays(customerDDAfter, -buf)
              : "";
          if (!anchor) continue;
          anchorByPoId.set(po.id, anchor);
          updateStmts.push(
            c.var.DB
              .prepare(
                `UPDATE production_orders SET targetEndDate = ?, updated_at = ? WHERE id = ?`,
              )
              .bind(anchor, now, po.id),
          );
        }

        const poCategoryById = new Map<string, string>();
        for (const po of pos) poCategoryById.set(po.id, po.itemCategory || "BEDFRAME");

        // Auto-schedule OFF => leave every JC dueDate untouched (manual entry).
        for (const jc of autoSchedule ? jcs : []) {
          // Skip work that's already done — re-dating completed JCs is wrong.
          if (jc.completedDate && jc.completedDate !== "") continue;
          const anchor = anchorByPoId.get(jc.productionOrderId);
          if (!anchor) continue;
          const category = poCategoryById.get(jc.productionOrderId) || "BEDFRAME";
          const deptCode = jc.departmentCode || "";
          if (!deptCode) continue;
          const leadDays = leadDaysFor(leadTimes, category, deptCode);
          const newDueDate = addDays(anchor, -leadDays);
          updateStmts.push(
            c.var.DB
              .prepare(
                // SENT-LOCK (owner 2026-08-03): re-deriving due dates from a
                // changed SO date must not touch cards already sent to the
                // floor — those dates are committed to the departments.
                `UPDATE job_cards SET dueDate = ?, updated_at = ?
                  WHERE id = ? AND (distributedAt IS NULL OR distributedAt = '')`,
              )
              .bind(newDueDate, now, jc.id),
          );
        }

        if (updateStmts.length > 0) {
          await c.var.DB.batch(updateStmts);
          console.log(
            `[so-PUT ${id}] header-date re-cascade: ${pos.length} PO targetEndDate + ${updateStmts.length - pos.length} JC dueDate updated (new customerDD=${customerDDAfter} hookkaExpectedDD=${hookkaDDAfter})`,
          );
        }
      } catch (err) {
        // Best-effort — header save already committed, the cascade is a
        // follow-up convenience. Surface in logs so we can chase any
        // patterns of failure, but don't fail the PUT.
        console.warn(
          `[so-PUT ${id}] header-date re-cascade failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const updated = await fetchSOWithItems(c.var.DB, id);
    // The general edit path — items, prices, customer, dates — was the single
    // biggest audit blind spot in the module: create, confirm, hub-change and
    // company-reassign were all logged, but a plain PUT rewriting 1,400 lines'
    // worth of state left nothing behind. Snapshot both sides so a disputed
    // price or quantity can be traced to who changed it and when.
    await emitAudit(c, {
      resource: "sales-orders",
      resourceId: id,
      action: "update",
      before: existing,
      after: updated,
    });
    return c.json({
      success: true,
      data: updated,
      linkedPOs: createdProductionOrders,
      productionOrders: createdProductionOrders,
      // Cascade summary surfaced to the UI so the toast can show
      // "3 production orders moved to ON_HOLD". Null when the PUT
      // didn't change status or the transition doesn't cascade.
      cascade: cascade
        ? {
            affectedPoCount: cascade.affectedPoCount,
            affectedJcCount: cascade.affectedJcCount,
            actions: cascade.actions,
          }
        : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/sales-orders/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating sales order" }, 500);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/sales-orders/:id/hub — change the delivery hub for an SO.
//
// Wei Siang's rule: "as long as not yet shipped, hub can be edited."
// Operators (e.g. Violet) routinely misclick PG vs KL hub on the same
// customer (Houzs Century has both). This endpoint lets them fix it
// in-place — but only while every linked DO is still DRAFT. Once any
// DO has been LOADED / IN_TRANSIT / DELIVERED / INVOICED the goods
// have physically left the warehouse and the hub is frozen.
//
// :id may be either the SO's UUID PK or the user-visible companySOId
// code (e.g. SO-2605-051). We probe both — operators paste the code
// from a printed SO sheet, not the UUID.
//
// Body: { hubId: string, reason?: string }
//
// Audit: every successful change writes one audit_events row with
// action='hub-change', before={hubId,hubName}, after={hubId,hubName,reason?}.
// ---------------------------------------------------------------------------
app.patch("/:id/hub", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const idParam = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const newHubId = typeof body.hubId === "string" ? body.hubId.trim() : "";
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : "";
    if (!newHubId) {
      return c.json({ success: false, error: "hubId is required" }, 400);
    }

    // 1. Resolve the SO by either UUID PK or companySOId (case-insensitive).
    const so = await c.var.DB
      .prepare(
        `SELECT * FROM sales_orders
          WHERE id = ?
             OR companySOId ILIKE ?
          LIMIT 1`,
      )
      .bind(idParam, idParam)
      .first<SalesOrderRow>();
    if (!so) {
      return c.json({ success: false, error: "Sales order not found" }, 404);
    }

    // 2. Resolve the new hub. We pull address / contactName / phone as
    //    well so the DO + invoice cascade below can refresh the full
    //    customer-contact block — DO creation snaps these 5 fields onto
    //    every DO at create time (see delivery-orders.ts ~line 2546),
    //    and invoices in turn snap them from the DO. Without refreshing
    //    all five, a draft DO / invoice printed after the hub change
    //    would still show the OLD address + OLD contact even though the
    //    hubId column was updated.
    const hub = await c.var.DB
      .prepare(
        `SELECT id, shortName, address, state, contactName, phone, customerId
           FROM delivery_hubs WHERE id = ?`,
      )
      .bind(newHubId)
      .first<{
        id: string;
        shortName: string;
        address: string | null;
        state: string | null;
        contactName: string | null;
        phone: string | null;
        customerId: string;
      }>();
    if (!hub) {
      return c.json({ success: false, error: "Hub not found" }, 404);
    }

    // 3. Hub must belong to the same customer as the SO.
    if (hub.customerId !== so.customerId) {
      return c.json(
        {
          success: false,
          error: "Hub does not belong to this customer",
        },
        400,
      );
    }

    // 4. Shipment-state guard. Mirrors the same SHIPPED-DO set used by
    //    dashboard-overview + do-value (LOADED / IN_TRANSIT / DELIVERED /
    //    INVOICED — DRAFT is the only "still in warehouse" state). Walk
    //    BOTH the direct FK (delivery_orders.salesOrderId) AND the
    //    per-item join (delivery_order_items.salesOrderNo = companySOId)
    //    so a consolidated DO catches the lock too.
    const companySOId = so.companySOId ?? "";
    const shippedDoRes = await c.var.DB
      .prepare(
        `SELECT DISTINCT d.doNo, d.status
           FROM delivery_orders d
          WHERE d.status IN ('LOADED','IN_TRANSIT','DELIVERED','INVOICED')
            AND (
                  d.salesOrderId = ?
               OR d.id IN (
                    SELECT di.deliveryOrderId
                      FROM delivery_order_items di
                     WHERE di.salesOrderNo = ?
                  )
                )
          ORDER BY d.doNo
          LIMIT 1`,
      )
      .bind(so.id, companySOId)
      .first<{ doNo: string | null; status: string | null }>();
    if (shippedDoRes) {
      return c.json(
        {
          success: false,
          code: "HUB_LOCKED_SHIPPED",
          error: `Hub cannot be changed once goods have left the hub. DO ${shippedDoRes.doNo ?? "(unknown)"} is already in ${shippedDoRes.status ?? "(unknown)"}.`,
          blockingDoNo: shippedDoRes.doNo ?? "",
          blockingDoStatus: shippedDoRes.status ?? "",
        },
        409,
      );
    }

    // 5. Early-exit if nothing actually changes — avoids writing a noisy
    //    cascade trail when the operator opens the modal, picks the same
    //    hub and clicks Save out of habit.
    if (so.hubId === hub.id) {
      const same = await c.var.DB
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(so.id)
        .first<SalesOrderRow>();
      return c.json({
        success: true,
        data: same ? rowToSO(same, []) : null,
        cascade: {
          productionOrdersUpdated: 0,
          deliveryOrdersUpdated: 0,
          invoicesUpdated: 0,
          creditNotesUpdated: 0,
          debitNotesUpdated: 0,
          warningDOs: [],
          noop: true,
        },
      });
    }

    // 6. Discover downstream rows that need cascading. All counts/lookups
    //    happen BEFORE the batch so we can return accurate numbers in the
    //    response (the batch itself doesn't echo affected rowcounts on the
    //    pg adapter consistently).
    const now = new Date().toISOString();
    const beforeSnap = { hubId: so.hubId, hubName: so.hubName };
    const afterSnap: Record<string, unknown> = {
      hubId: hub.id,
      hubName: hub.shortName,
    };
    if (reason) afterSnap.reason = reason;

    // 6a. production_orders — has no hubId / hubName columns (production
    //     sheet joins back to sales_orders for those), but DOES have a
    //     denormalized `customerState` column populated at PO creation
    //     (production-orders.ts ~line 5008, INSERT INTO production_orders
    //     ... customerState). Delivery Planning page reads po.customerState
    //     directly (src/pages/delivery/index.tsx:889), so a stale value
    //     here makes the operator see "State: KL" on a row whose parent
    //     SO is now PG.
    //
    //     Update WITHOUT a status filter: even COMPLETED POs may be
    //     reprinted on the production sheet / fabric tag and must show
    //     the correct state. Per BUG-2026-05-30-006 audit + operator
    //     direction "production sheet must show new state even for
    //     COMPLETED POs".
    const posRes = await c.var.DB
      .prepare(
        `SELECT id, customerState
           FROM production_orders
          WHERE salesOrderId = ?`,
      )
      .bind(so.id)
      .all<{ id: string; customerState: string | null }>();
    const poRows = posRes.results ?? [];

    // 6b. delivery_orders — pre-shipment only (status NOT IN shipped set).
    //     Two link paths: direct FK (delivery_orders.salesOrderId) AND
    //     the per-item path (delivery_order_items.salesOrderNo = companySOId).
    //     A consolidated multi-SO DO must be visible to BOTH the discovery
    //     and the hub-mix conflict check. companySOId was already resolved
    //     above (in the shipment-lock guard) so it's reused here.
    // Pull the full contact block (customerState / deliveryAddress /
    // contactPerson / contactPhone) so the audit before-state is complete
    // and the cascade UPDATE below knows what's actually being changed.
    // These are the same 5 fields the DO snaps from delivery_hubs at
    // create time (delivery-orders.ts ~line 2546) — we mirror the full
    // create-time snapshot, not just hubId.
    const candidateDosRes = await c.var.DB
      .prepare(
        `SELECT DISTINCT d.id, d.doNo, d.status, d.hubId, d.hubName,
                         d.customerState, d.deliveryAddress,
                         d.contactPerson, d.contactPhone, d.salesOrderId
           FROM delivery_orders d
          WHERE d.status NOT IN ('LOADED','IN_TRANSIT','DELIVERED','INVOICED')
            AND (
                  d.salesOrderId = ?
               OR d.id IN (
                    SELECT di.deliveryOrderId
                      FROM delivery_order_items di
                     WHERE di.salesOrderNo = ?
                  )
                )`,
      )
      .bind(so.id, companySOId)
      .all<{
        id: string;
        doNo: string | null;
        status: string | null;
        hubId: string | null;
        hubName: string | null;
        customerState: string | null;
        deliveryAddress: string | null;
        contactPerson: string | null;
        contactPhone: string | null;
        salesOrderId: string | null;
      }>();
    const candidateDos = candidateDosRes.results ?? [];

    // For each candidate DO, discover EVERY other SO it touches (direct FK
    // + item-level join via companySOId). If any other linked SO has a hub
    // different from the new hub, this DO is multi-SO with mixed customer
    // hubs — skip it and warn. Resolving an unrelated SO's hub from KL→PG
    // can't silently rewrite a DO that also serves a sibling SO still at KL.
    const dosToUpdate: typeof candidateDos = [];
    const warningDOs: { doNo: string; reason: string }[] = [];
    for (const d of candidateDos) {
      // Collect linked SO ids: direct FK + items table.
      const linkedSosRes = await c.var.DB
        .prepare(
          `SELECT DISTINCT s.id, s.hubId, s.companySOId
             FROM sales_orders s
            WHERE s.id = (SELECT salesOrderId FROM delivery_orders WHERE id = ?)
               OR s.companySOId IN (
                    SELECT DISTINCT di.salesOrderNo
                      FROM delivery_order_items di
                     WHERE di.deliveryOrderId = ?
                       AND di.salesOrderNo IS NOT NULL
                       AND di.salesOrderNo <> ''
                  )`,
        )
        .bind(d.id, d.id)
        .all<{ id: string; hubId: string | null; companySOId: string | null }>();
      const otherSos = (linkedSosRes.results ?? []).filter(
        (s) => s.id !== so.id,
      );
      const conflict = otherSos.find((s) => (s.hubId ?? "") !== hub.id);
      if (conflict) {
        warningDOs.push({
          doNo: d.doNo ?? "",
          reason: "Multi-SO DO with different customer hub — skipped",
        });
        continue;
      }
      dosToUpdate.push(d);
    }

    // 6c. invoices — DRAFT only. Invoices link to SO via salesOrderId
    //     (denormalized at create time from the originating DO). Pull
    //     the full contact block so we can both (a) cascade the new hub's
    //     address / contactName / phone into customerAddress / attention /
    //     customerPhone, and (b) capture the before-state in audit. PDF
    //     generation reads these columns directly (see
    //     generate-invoice-pdf.ts), so refreshing only hubId/hubName
    //     would still leave the printed invoice with the OLD address.
    const invsRes = await c.var.DB
      .prepare(
        `SELECT id, hubId, hubName, customerState, customerAddress,
                attention, customerPhone
           FROM invoices
          WHERE salesOrderId = ?
            AND status = 'DRAFT'`,
      )
      .bind(so.id)
      .all<{
        id: string;
        hubId: string | null;
        hubName: string | null;
        customerState: string | null;
        customerAddress: string | null;
        attention: string | null;
        customerPhone: string | null;
      }>();
    const invRows = invsRes.results ?? [];

    // 6d. credit_notes — DRAFT only. CN links to invoice (not SO directly),
    //     so we walk via invoices.salesOrderId = so.id. CN was extended
    //     with customerState / customerAddress / attention / customerPhone
    //     in migration 0126 (mirrors the invoice contact block); creation
    //     snapshots these from the source invoice. When the SO hub
    //     changes, draft CNs printed before approval would otherwise show
    //     the OLD address.
    //
    //     Status filter: DRAFT only. APPROVED + POSTED CNs have already
    //     been applied against the invoice (isIssuedStatus, credit-notes.ts
    //     line 106); rewriting their customer block could corrupt the
    //     finance trail. APPROVED/POSTED rows skipped silently — they
    //     keep their snapshot, which matches the invoice they posted against.
    const cnsRes = await c.var.DB
      .prepare(
        `SELECT cn.id, cn.customerState, cn.customerAddress,
                cn.attention, cn.customerPhone
           FROM credit_notes cn
           JOIN invoices i ON i.id = cn.invoiceId
          WHERE i.salesOrderId = ?
            AND cn.status = 'DRAFT'`,
      )
      .bind(so.id)
      .all<{
        id: string;
        customerState: string | null;
        customerAddress: string | null;
        attention: string | null;
        customerPhone: string | null;
      }>();
    const cnRows = cnsRes.results ?? [];

    // 6e. debit_notes — same rules + status enum as credit_notes. Same
    //     0126-migration column set, same DRAFT-only safety rule.
    const dnsRes = await c.var.DB
      .prepare(
        `SELECT dn.id, dn.customerState, dn.customerAddress,
                dn.attention, dn.customerPhone
           FROM debit_notes dn
           JOIN invoices i ON i.id = dn.invoiceId
          WHERE i.salesOrderId = ?
            AND dn.status = 'DRAFT'`,
      )
      .bind(so.id)
      .all<{
        id: string;
        customerState: string | null;
        customerAddress: string | null;
        attention: string | null;
        customerPhone: string | null;
      }>();
    const dnRows = dnsRes.results ?? [];

    // 7. Build the batch. ONE transaction:
    //    - update sales_orders.hub (+ customerState)
    //    - update each production_orders.customerState — no hub columns
    //      exist on PO, but customerState is denormalized at create time
    //      (production-orders.ts line 5008) and shown directly on the
    //      Delivery Planning page.
    //    - update each eligible delivery_orders row with the FULL contact
    //      block (hubId, hubName, customerAddress, customerState,
    //      contactPerson, contactPhone) — mirrors the 6-field snapshot
    //      DO creation takes from delivery_hubs.
    //    - update each DRAFT invoices row with the equivalent fields
    //      (hubId, hubName, customerAddress, customerState, attention,
    //      customerPhone) — invoice creation snaps these from the DO,
    //      so the same staleness shows up on draft invoices.
    //    - update each DRAFT credit_notes / debit_notes row with the
    //      4-field block (customerState, customerAddress, attention,
    //      customerPhone). CN/DN have no hub_id / hub_name columns
    //      (no FK to delivery_hubs); they only carry the customer
    //      contact snapshot (migration 0126).
    //    - one audit row for SO change + one per cascaded downstream row,
    //      with both before and after carrying every field that changed.
    // Effective state mirrors sales_orders.customerState write below
    // (declared up here so the audit-after snapshots can reference it).
    const effectiveState = hub.state ?? so.customerState ?? null;
    const doAfter: Record<string, unknown> = {
      hubId: hub.id,
      hubName: hub.shortName,
      customerAddress: hub.address ?? null,
      customerState: effectiveState,
      contactPerson: hub.contactName ?? null,
      contactPhone: hub.phone ?? null,
      parentSOId: so.id,
      parentSOCode: so.companySOId,
    };
    if (reason) doAfter.reason = reason;
    const invAfter: Record<string, unknown> = {
      hubId: hub.id,
      hubName: hub.shortName,
      customerAddress: hub.address ?? null,
      customerState: effectiveState,
      attention: hub.contactName ?? null,
      customerPhone: hub.phone ?? null,
      parentSOId: so.id,
      parentSOCode: so.companySOId,
    };
    if (reason) invAfter.reason = reason;
    // CN / DN share the same 4-field snapshot (no hubId/hubName, since
    // those columns don't exist on credit_notes / debit_notes — they
    // carry the customer contact block from the source invoice but not
    // the hub linkage itself).
    const noteAfter: Record<string, unknown> = {
      customerAddress: hub.address ?? null,
      customerState: effectiveState,
      attention: hub.contactName ?? null,
      customerPhone: hub.phone ?? null,
      parentSOId: so.id,
      parentSOCode: so.companySOId,
    };
    if (reason) noteAfter.reason = reason;
    // production_orders only has customerState (no hub columns, no
    // address/contact). Use a separate after-snapshot so the audit
    // entry only records what actually changed.
    const poAfter: Record<string, unknown> = {
      customerState: effectiveState,
      parentSOId: so.id,
      parentSOCode: so.companySOId,
    };
    if (reason) poAfter.reason = reason;
    const stmts: import("@cloudflare/workers-types").D1PreparedStatement[] = [];

    stmts.push(
      c.var.DB
        .prepare(
          `UPDATE sales_orders
              SET hubId = ?, hubName = ?, customerState = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(
          hub.id,
          hub.shortName,
          hub.state ?? so.customerState ?? null,
          now,
          so.id,
        ),
    );
    const soAudit = await buildAuditStatement(c, {
      resource: "sales-orders",
      resourceId: so.id,
      action: "hub-change",
      before: beforeSnap,
      after: afterSnap,
    });
    if (soAudit) stmts.push(soAudit);

    for (const po of poRows) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE production_orders
                SET customerState = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(effectiveState, now, po.id),
      );
      const a = await buildAuditStatement(c, {
        resource: "production-orders",
        resourceId: po.id,
        action: "hub-cascade-from-so",
        before: { customerState: po.customerState },
        after: poAfter,
      });
      if (a) stmts.push(a);
    }

    // service_orders — destination inherited from this SO at service-order
    // creation (service-orders.ts, 2026-06-11). Keep it following the source
    // so a service PO dispatched AFTER a hub change lands at the new branch.
    // try/catch: the hubId column self-applies on first service-order POST,
    // so an isolate that hasn't seen one yet has no column — and therefore no
    // stored hubs to go stale (the DO path live-derives those from this SO,
    // which this very UPDATE just moved). Skipping is correct, not lossy.
    try {
      const svcRes = await c.var.DB
        .prepare(
          `SELECT id, hubId FROM service_orders
            WHERE sourceType = 'SO' AND sourceId = ?`,
        )
        .bind(so.id)
        .all<{ id: string; hubId: string | null }>();
      for (const svc of svcRes.results ?? []) {
        stmts.push(
          c.var.DB
            .prepare(`UPDATE service_orders SET hubId = ? WHERE id = ?`)
            .bind(hub.id, svc.id),
        );
        const a = await buildAuditStatement(c, {
          resource: "service-orders",
          resourceId: svc.id,
          action: "hub-cascade-from-so",
          before: { hubId: svc.hubId },
          after: {
            hubId: hub.id,
            parentSOId: so.id,
            parentSOCode: so.companySOId,
          },
        });
        if (a) stmts.push(a);
      }
    } catch {
      // hubId column not present on this isolate yet — nothing stored, skip.
    }

    for (const d of dosToUpdate) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE delivery_orders
                SET hubId = ?, hubName = ?, customerState = ?,
                    deliveryAddress = ?, contactPerson = ?, contactPhone = ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .bind(
            hub.id,
            hub.shortName,
            effectiveState,
            hub.address ?? "",
            hub.contactName ?? "",
            hub.phone ?? "",
            now,
            d.id,
          ),
      );
      const a = await buildAuditStatement(c, {
        resource: "delivery-orders",
        resourceId: d.id,
        action: "hub-cascade-from-so",
        before: {
          hubId: d.hubId,
          hubName: d.hubName,
          customerAddress: d.deliveryAddress,
          customerState: d.customerState,
          contactPerson: d.contactPerson,
          contactPhone: d.contactPhone,
        },
        after: doAfter,
      });
      if (a) stmts.push(a);
    }

    for (const inv of invRows) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE invoices
                SET hubId = ?, hubName = ?, customerState = ?,
                    customerAddress = ?, attention = ?, customerPhone = ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .bind(
            hub.id,
            hub.shortName,
            effectiveState,
            hub.address ?? "",
            hub.contactName ?? "",
            hub.phone ?? "",
            now,
            inv.id,
          ),
      );
      const a = await buildAuditStatement(c, {
        resource: "invoices",
        resourceId: inv.id,
        action: "hub-cascade-from-so",
        before: {
          hubId: inv.hubId,
          hubName: inv.hubName,
          customerAddress: inv.customerAddress,
          customerState: inv.customerState,
          attention: inv.attention,
          customerPhone: inv.customerPhone,
        },
        after: invAfter,
      });
      if (a) stmts.push(a);
    }

    for (const cn of cnRows) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE credit_notes
                SET customerState = ?, customerAddress = ?,
                    attention = ?, customerPhone = ?
              WHERE id = ?`,
          )
          .bind(
            effectiveState,
            hub.address ?? "",
            hub.contactName ?? "",
            hub.phone ?? "",
            cn.id,
          ),
      );
      const a = await buildAuditStatement(c, {
        resource: "credit-notes",
        resourceId: cn.id,
        action: "hub-cascade-from-so",
        before: {
          customerAddress: cn.customerAddress,
          customerState: cn.customerState,
          attention: cn.attention,
          customerPhone: cn.customerPhone,
        },
        after: noteAfter,
      });
      if (a) stmts.push(a);
    }

    for (const dn of dnRows) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE debit_notes
                SET customerState = ?, customerAddress = ?,
                    attention = ?, customerPhone = ?
              WHERE id = ?`,
          )
          .bind(
            effectiveState,
            hub.address ?? "",
            hub.contactName ?? "",
            hub.phone ?? "",
            dn.id,
          ),
      );
      const a = await buildAuditStatement(c, {
        resource: "debit-notes",
        resourceId: dn.id,
        action: "hub-cascade-from-so",
        before: {
          customerAddress: dn.customerAddress,
          customerState: dn.customerState,
          attention: dn.attention,
          customerPhone: dn.customerPhone,
        },
        after: noteAfter,
      });
      if (a) stmts.push(a);
    }

    await c.var.DB.batch(stmts);

    // 7b. Belt-and-braces snapshot invalidation. The cascade above bumps
    //     updated_at on every row it touches, and the cache-aside snapshot
    //     helpers (src/api/lib/snapshot.ts) auto-invalidate via Layer 2 by
    //     comparing built_from against MAX(updated_at) across configured
    //     source tables — so in theory the next SO list / Production /
    //     Dashboard / Delivery / Invoice fetch should recompute on its own.
    //     In practice the freshness probe has misfired (mixed TEXT/TIMESTAMP
    //     compares, source tables with no updated_at column, replication
    //     lag) and operators saw a stale "Houzs KL" on the SO list even
    //     after the DB row said "Houzs PG" — forcing a manual TRUNCATE of
    //     21 snapshot tables via Supabase. Wipe the affected snapshot rows
    //     here so the next read GUARANTEES a recompute. Internally swallows
    //     per-snapshot errors — a wipe failure must not fail the hub edit
    //     (the cascade has already committed).
    await invalidateHubChangeSnapshots(c.var.DB, getOrgId(c), "sales");

    // 8. Return refreshed SO header + cascade counts.
    const updated = await c.var.DB
      .prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(so.id)
      .first<SalesOrderRow>();
    return c.json({
      success: true,
      data: updated ? rowToSO(updated, []) : null,
      cascade: {
        productionOrdersUpdated: poRows.length,
        deliveryOrdersUpdated: dosToUpdate.length,
        invoicesUpdated: invRows.length,
        creditNotesUpdated: cnRows.length,
        debitNotesUpdated: dnRows.length,
        warningDOs,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PATCH /api/sales-orders/:id/hub] failed:", msg, err);
    return c.json(
      { success: false, error: msg || "Internal error updating hub" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sales-orders/:id — cascades to items via FK
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id, companySOId, status FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; companySOId: string | null; status: string | null }>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Status guard (owner 2026-08-01). This endpoint had NO status check: any SO
  // with no child rows could be deleted outright, CONFIRMED and shipped ones
  // included — a far worse failure than a draft that won't delete. Deleting a
  // draft is just discarding a keying mistake; deleting a live order destroys
  // the audit trail for something the business already acted on. Cancel those
  // instead (status → CANCELLED keeps the record and its number).
  const status = (existing.status ?? "").toUpperCase();
  if (status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: `${existing.companySOId ?? "This order"} is ${status || "not a draft"} — only DRAFT orders can be deleted. Cancel it instead to keep the record.`,
      },
      409,
    );
  }

  // A never-confirmed draft has no production orders / DOs / invoices (those
  // are created on confirm), so the FK-restricted children can't exist. If one
  // somehow does, Postgres rejects the DELETE and the raw error surfaced as a
  // bare "HTTP 500" with nothing actionable — translate it instead.
  try {
    await c.var.DB.prepare("DELETE FROM sales_orders WHERE id = ?")
      .bind(id)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/foreign key|violates|constraint/i.test(msg)) {
      return c.json(
        {
          success: false,
          error: `${existing.companySOId ?? "This order"} still has linked documents (production order, delivery order or invoice) — remove those first, or cancel the order instead.`,
        },
        409,
      );
    }
    throw e;
  }

  // Deleting a document is the single most important thing to audit — the row
  // is gone, so the audit event is the ONLY remaining record that it existed.
  // Snapshot the full pre-state, not just the id.
  await emitAudit(c, {
    resource: "sales-orders",
    resourceId: id,
    action: "delete",
    before: existing,
  });
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/copy-for-service-order — 0134.
//
// Returns a DRAFT Service Order payload built from an existing Sales Order
// or Consignment Order. The frontend then submits this payload back to
// POST /api/sales-orders (with isServiceOrder: true) to actually create
// the new SO row.
//
// Body:
//   {
//     sourceType: "SO" | "CO",
//     sourceId: "<uuid>",
//     lineItems: [{ id: "<line-uuid>", qty: 1 }, ...] // PREFERRED — per-line qty override (qty must be 1..sourceQty)
//     lineItemIds: ["<line-uuid>", ...]               // LEGACY — copies each picked line at its source qty
//                                                     // Either is OPTIONAL; omit both to copy ALL lines at source qty
//   }
//
// The qty override lets the operator copy only N of the source line's qty
// (e.g. source had 2, only redo 1). If both lineItems and lineItemIds are
// present, lineItems wins. Any qty <= 0 or > source qty is clamped to the
// valid range.
//
// Response (200):
//   {
//     success: true,
//     data: {
//       customerId, hubId, hubName, customerName, customerState,
//       items: [...],            // unit / base / divan / leg / special prices all reset to 0
//       sourceType, sourceId, sourceNo,
//       customerPO, customerPOId, // copied for reference only
//     }
//   }
//
// 4xx on bad sourceType, missing source row, or empty line-item match.
//
// Service-order policy:
//   * prices reset to 0 — operator MUST edit each line before save
//   * dates default to today (frontend supplies)
//   * customer + hub copied verbatim
//   * maintenance options (divan/leg/gap/special/customSpecials) copied
//     so all the wearings (Fabricolor / Saffa / Bigfoot / etc.) survive
// ---------------------------------------------------------------------------
app.post("/copy-for-service-order", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const sourceType: string =
      typeof body.sourceType === "string" ? body.sourceType.toUpperCase() : "";
    const sourceId: string =
      typeof body.sourceId === "string" ? body.sourceId : "";

    // New shape: lineItems = [{ id, qty }] — per-line qty override.
    // Old shape: lineItemIds = [id, ...] — copies each at source qty.
    // Either is optional; omit both to copy ALL lines at source qty.
    // If both are present, lineItems wins (it's the richer shape).
    type PickedLine = { id: string; qty: number | null };
    const pickedFromRich: PickedLine[] = Array.isArray(body.lineItems)
      ? body.lineItems
          .map((x: unknown): PickedLine | null => {
            if (!x || typeof x !== "object") return null;
            const obj = x as { id?: unknown; qty?: unknown };
            if (typeof obj.id !== "string" || !obj.id) return null;
            const rawQty = Number(obj.qty);
            const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty) : null;
            return { id: obj.id, qty };
          })
          .filter((x: PickedLine | null): x is PickedLine => x !== null)
      : [];
    const pickedFromLegacy: PickedLine[] = Array.isArray(body.lineItemIds)
      ? body.lineItemIds
          .filter((x: unknown): x is string => typeof x === "string")
          .map((id: string): PickedLine => ({ id, qty: null }))
      : [];
    // lineItems wins when present; legacy lineItemIds is the fallback.
    const pickedLines: PickedLine[] =
      pickedFromRich.length > 0 ? pickedFromRich : pickedFromLegacy;
    // Map for O(1) qty lookup when stamping the draft items.
    const pickedQtyById = new Map<string, number | null>();
    for (const p of pickedLines) pickedQtyById.set(p.id, p.qty);
    const lineItemIds: string[] = pickedLines.map((p) => p.id);

    if (sourceType !== "SO" && sourceType !== "CO") {
      return c.json(
        { success: false, error: "sourceType must be 'SO' or 'CO'" },
        400,
      );
    }
    if (!sourceId) {
      return c.json({ success: false, error: "sourceId required" }, 400);
    }

    // Pull source order + lines. SO and CO have parallel schemas but
    // different table names + a couple of column-name differences (no
    // customSpecials on the CO side, no customerPOImageB64). Branch once.
    let customer:
      | {
          customerId: string;
          customerName: string;
          customerState: string;
          hubId: string | null;
          hubName: string;
          customerPO: string;
          customerPOId: string;
          sourceNo: string;
          // 0134 — source-order reference field passes through to the
          // destination Service Order's `reference` slot (EX-prefixed).
          // Previously the destination reference was being filled with
          // the source id ("EX SO SO-2605-121") which (a) used the wrong
          // format and (b) shadowed the real Customer SO slot. Customer
          // SO now holds EX-<sourceNo>; reference holds the source's own
          // free-text reference verbatim.
          reference: string;
        }
      | null = null;
    type SrcItem = {
      id: string;
      productId: string;
      productCode: string;
      productName: string;
      itemCategory: string;
      sizeCode: string;
      sizeLabel: string;
      fabricCode: string;
      quantity: number;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      specialOrder: string;
      notes: string;
      customSpecials: Array<{ description: string; surchargeSen: number }>;
    };
    let items: SrcItem[] = [];

    if (sourceType === "SO") {
      const so = await c.var.DB
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(sourceId)
        .first<SalesOrderRow>();
      if (!so) {
        return c.json(
          { success: false, error: "Source sales order not found" },
          404,
        );
      }
      const itemRes = await c.var.DB
        .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ? ORDER BY lineNo ASC")
        .bind(sourceId)
        .all<SalesOrderItemRow>();
      const all = itemRes.results ?? [];
      const filtered =
        lineItemIds.length > 0
          ? all.filter((it) => lineItemIds.includes(it.id))
          : all;
      if (filtered.length === 0) {
        return c.json(
          {
            success: false,
            error: "No matching line items on the source sales order",
          },
          400,
        );
      }
      customer = {
        customerId: so.customerId,
        customerName: so.customerName,
        customerState: so.customerState ?? "",
        hubId: so.hubId,
        hubName: so.hubName ?? "",
        customerPO: so.customerPO ?? "",
        customerPOId: so.customerPOId ?? "",
        sourceNo: so.companySOId ?? "",
        reference: so.reference ?? "",
      };
      items = filtered.map((it) => {
        // Clamp the operator's qty override to 1..sourceQty. Falls back to
        // the source qty when no override was supplied (legacy path or
        // qty omitted).
        const srcQty = Number(it.quantity) || 0;
        const reqQty = pickedQtyById.get(it.id);
        const qty =
          reqQty == null ? srcQty : Math.max(1, Math.min(srcQty, reqQty));
        return {
          id: it.id,
          productId: it.productId ?? "",
          productCode: it.productCode ?? "",
          productName: it.productName ?? "",
          itemCategory: it.itemCategory ?? "BEDFRAME",
          sizeCode: it.sizeCode ?? "",
          sizeLabel: it.sizeLabel ?? "",
          fabricCode: it.fabricCode ?? "",
          quantity: qty,
          gapInches: it.gapInches,
          divanHeightInches: it.divanHeightInches,
          legHeightInches: it.legHeightInches,
          specialOrder: it.specialOrder ?? "",
          notes: it.notes ?? "",
          customSpecials: parseCustomSpecials(it.customSpecials),
        };
      });
    } else {
      // CO branch — separate tables, slightly different shape.
      const co = await c.var.DB
        .prepare("SELECT * FROM consignment_orders WHERE id = ?")
        .bind(sourceId)
        .first<{
          id: string;
          customerId: string;
          customerName: string;
          customerState: string | null;
          hubId: string | null;
          hubName: string | null;
          companyCOId: string | null;
          customerCO: string | null;
          customerCOId: string | null;
          reference: string | null;
        }>();
      if (!co) {
        return c.json(
          { success: false, error: "Source consignment order not found" },
          404,
        );
      }
      const itemRes = await c.var.DB
        .prepare("SELECT * FROM consignment_order_items WHERE consignmentOrderId = ? ORDER BY lineNo ASC")
        .bind(sourceId)
        .all<{
          id: string;
          productId: string | null;
          productCode: string | null;
          productName: string | null;
          itemCategory: string | null;
          sizeCode: string | null;
          sizeLabel: string | null;
          fabricCode: string | null;
          quantity: number;
          gapInches: number | null;
          divanHeightInches: number | null;
          legHeightInches: number | null;
          specialOrder: string | null;
          notes: string | null;
        }>();
      const all = itemRes.results ?? [];
      const filtered =
        lineItemIds.length > 0
          ? all.filter((it) => lineItemIds.includes(it.id))
          : all;
      if (filtered.length === 0) {
        return c.json(
          {
            success: false,
            error: "No matching line items on the source consignment order",
          },
          400,
        );
      }
      customer = {
        customerId: co.customerId,
        customerName: co.customerName,
        customerState: co.customerState ?? "",
        hubId: co.hubId,
        hubName: co.hubName ?? "",
        customerPO: co.customerCO ?? "",
        customerPOId: co.customerCOId ?? "",
        sourceNo: co.companyCOId ?? "",
        reference: co.reference ?? "",
      };
      items = filtered.map((it) => {
        // Same clamp as the SO branch — operator override wins when supplied.
        const srcQty = Number(it.quantity) || 0;
        const reqQty = pickedQtyById.get(it.id);
        const qty =
          reqQty == null ? srcQty : Math.max(1, Math.min(srcQty, reqQty));
        return {
          id: it.id,
          productId: it.productId ?? "",
          productCode: it.productCode ?? "",
          productName: it.productName ?? "",
          itemCategory: it.itemCategory ?? "BEDFRAME",
          sizeCode: it.sizeCode ?? "",
          sizeLabel: it.sizeLabel ?? "",
          fabricCode: it.fabricCode ?? "",
          quantity: qty,
          gapInches: it.gapInches,
          divanHeightInches: it.divanHeightInches,
          legHeightInches: it.legHeightInches,
          specialOrder: it.specialOrder ?? "",
          notes: it.notes ?? "",
          customSpecials: [],
        };
      });
    }

    if (!customer) {
      return c.json(
        { success: false, error: "Could not resolve customer from source" },
        500,
      );
    }

    const today = new Date().toISOString().slice(0, 10);

    // EX-prefix the operator-facing reference fields so the destination
    // Service Order is visibly tagged as a copy. The original SO/CO id
    // is preserved verbatim under sourceNo / sourceId so cascade lookups
    // still work. Customer PO is the operator's external reference; we
    // prefix it (idempotent — never double-prefix). Customer SO is rarely
    // set on the source but follow the same rule when present.
    const exPrefix = (raw: string): string => {
      const v = (raw ?? "").trim();
      if (!v) return "";
      return /^EX[-\s]/i.test(v) ? v : `EX-${v}`;
    };
    const prefixedCustomerPO = exPrefix(customer.customerPO);
    const prefixedCustomerPOId = exPrefix(customer.customerPOId);
    // 0134 — Customer SO field on the destination Service Order carries
    // EX-<sourceNo>. sourceNo is the source's companySOId / companyCOId,
    // which already includes the SO-/CO- prefix (e.g. "SO-2605-121"), so
    // exPrefix yields "EX-SO-2605-121" / "EX-CO-2605-007" directly.
    // Reference holds the source's own free-text reference verbatim with
    // the EX- prefix (blank stays blank).
    const prefixedCustomerSOId = exPrefix(customer.sourceNo);
    const prefixedReference = exPrefix(customer.reference);

    // Build the draft payload. ALL prices reset to 0 — the operator MUST
    // edit each line's unit price before saving. This is the headline
    // policy for Service Orders: no silent inheritance of the customer's
    // price book, no implicit free-of-charge.
    const draftPayload = {
      customerId: customer.customerId,
      customerName: customer.customerName,
      customerState: customer.customerState,
      hubId: customer.hubId,
      hubName: customer.hubName,
      customerPO: prefixedCustomerPO,
      customerPOId: prefixedCustomerPOId,
      customerPODate: "",
      customerSO: prefixedCustomerSOId,
      customerSOId: prefixedCustomerSOId,
      reference: prefixedReference,
      companySODate: today,
      customerDeliveryDate: today,
      hookkaExpectedDD: "",
      hookkaDeliveryOrder: "",
      notes: "",
      isServiceOrder: true,
      items: items.map((it, idx) => ({
        lineNo: idx + 1,
        lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
        productId: it.productId,
        productCode: it.productCode,
        productName: it.productName,
        itemCategory: it.itemCategory,
        sizeCode: it.sizeCode,
        sizeLabel: it.sizeLabel,
        fabricCode: it.fabricCode,
        quantity: it.quantity,
        gapInches: it.gapInches,
        divanHeightInches: it.divanHeightInches,
        // Maintenance prices ALL reset to 0 — operator edits per line.
        divanPriceSen: 0,
        legHeightInches: it.legHeightInches,
        legPriceSen: 0,
        specialOrder: it.specialOrder,
        specialOrderPriceSen: 0,
        totalHeightPriceSen: 0,
        // Carry the descriptions through but zero out the surcharge sen —
        // the line items themselves come over (Fabricolor / Saffa /
        // Bigfoot etc. are encoded in `specialOrder` text + customSpecials
        // entries) but the operator must price them fresh for the
        // service order.
        customSpecials: it.customSpecials.map((cs) => ({
          description: cs.description,
          surchargeSen: 0,
        })),
        basePriceSen: 0,
        unitPriceSen: 0,
        lineTotalSen: 0,
        notes: it.notes,
      })),
      sourceType,
      sourceId,
      sourceNo: customer.sourceNo,
    };

    return c.json({ success: true, data: draftPayload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/sales-orders/copy-for-service-order] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json(
      { success: false, error: msg || "Internal error building service-order draft" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/batch-company — Multi-Company Phase 4.
//
// Bulk re-assign the booked company (`sales_org_code`) for a set of Sales
// Orders in one confirmed action from the SO list. ADDITIVE + safe:
//
//   • Default behaviour is unchanged — this endpoint only runs when the
//     operator explicitly selects rows and picks a target company.
//   • LOCK GUARD: only EARLY-status SOs (DRAFT / CONFIRMED / ON_HOLD — see
//     `isCompanyReassignable`) are moved. Any SO already in production /
//     shipped / delivered / invoiced / closed / cancelled is SKIPPED with a
//     reason and never silently reassigned (its POs/DOs/invoices were booked
//     under the original company). Locked rows are reported, not failed —
//     the operator sees exactly which ones were held back and why.
//   • Company code is normalised through the same `resolveCompanyCode` used by
//     create/edit, so it is always a canonical UPPERCASE org code.
//
// The AUTO-allocation rule (how incoming orders get split among companies)
// is deliberately NOT implemented here — that's the owner's spec to define.
// This is the manual mechanism only.
//
// Body: { ids: string[]; salesOrgCode: string; changedBy?: string }
// Resp: { success, moved, skipped, total, targetCompany,
//         results: [{ id, companySOId, status, moved, reason? }] }
// ---------------------------------------------------------------------------
app.post("/batch-company", async (c) => {
  // Reuse the SO "update" permission — reassigning the company is a header
  // edit, same authority level as editing the SO.
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);

  try {
    const body = await c.req.json();
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = Array.from(
      new Set(
        rawIds
          .filter((v: unknown): v is string => typeof v === "string")
          .map((v: string) => v.trim())
          .filter((v: string) => v.length > 0),
      ),
    ) as string[];
    if (ids.length === 0) {
      return c.json(
        { success: false, error: "No sales orders selected." },
        400,
      );
    }
    // Guard against an accidental unbounded batch.
    if (ids.length > 500) {
      return c.json(
        { success: false, error: "Too many orders in one batch (max 500)." },
        400,
      );
    }

    // Require an explicit target company from the operator — never default
    // silently to HOOKKA on a bulk MOVE (that would be a data-losing surprise).
    if (typeof body.salesOrgCode !== "string" || body.salesOrgCode.trim() === "") {
      return c.json(
        { success: false, error: "A target company is required." },
        400,
      );
    }
    const targetCompany = resolveCompanyCode(body.salesOrgCode);
    const now = new Date().toISOString();

    // Load only the rows we need (id, status, current company, display code).
    // Tenant scope is enforced by withOrgScope so a caller can only touch SOs
    // inside their own org.
    const placeholders = ids.map(() => "?").join(", ");
    const { whereSql: orgWhere, params: orgParams } = withOrgScope(
      c,
      "sales_orders",
      `id IN (${placeholders})`,
    );
    const rowsRes = await c.var.DB.prepare(
      `SELECT id, companySOId, status, sales_org_code
         FROM sales_orders ${orgWhere}`,
    )
      .bind(...orgParams, ...ids)
      .all<{
        id: string;
        companySOId: string | null;
        status: string;
        sales_org_code: string | null;
      }>();
    const rows = rowsRes.results ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Any selected id we didn't find (deleted / cross-org) is reported as
    // "Not found" so the operator sees the full accounting; the classifier
    // only decides moved/skipped for rows that exist.
    const foundRows = ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({
        id: r.id,
        companySOId: r.companySOId,
        status: r.status,
        currentCompany: r.sales_org_code,
      }));
    const decided = classifyBatchReassign(foundRows, targetCompany);
    const notFound = ids
      .filter((id) => !byId.has(id))
      .map((id) => ({
        id,
        companySOId: id,
        status: "—",
        moved: false,
        reason: "Not found",
      }));
    const results = [...decided, ...notFound];

    const updates: import("@cloudflare/workers-types").D1PreparedStatement[] = [];
    for (const r of decided) {
      if (!r.moved) continue;
      updates.push(
        c.var.DB.prepare(
          `UPDATE sales_orders
              SET sales_org_code = ?, updated_at = ?
            WHERE id = ?`,
        ).bind(targetCompany, now, r.id),
      );
      // Best-effort audit trail (one row per moved SO). Swallowed if the
      // audit helper is unavailable — the reassignment itself must not fail.
      const before = readCompanyCode(
        null,
        byId.get(r.id)?.sales_org_code ?? null,
      );
      const audit = await buildAuditStatement(c, {
        resource: "sales-orders",
        resourceId: r.id,
        action: "company-reassign",
        before: { salesOrgCode: before },
        after: {
          salesOrgCode: targetCompany,
          changedBy: (body.changedBy as string) || "Admin",
        },
      });
      if (audit) updates.push(audit);
    }

    if (updates.length > 0) {
      await c.var.DB.batch(updates);
    }

    // The list snapshot (`sales_orders_list_snapshot`) is cache-aside keyed on
    // MAX(sales_orders.updated_at); bumping updated_at above auto-invalidates
    // it on the next read — no explicit wipe needed. (Company is a display /
    // filter dimension only; no production / DO / invoice cascade to run.)
    const moved = results.filter((r) => r.moved).length;
    const skipped = results.length - moved;
    return c.json({
      success: true,
      moved,
      skipped,
      total: results.length,
      targetCompany,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/sales-orders/batch-company] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json(
      { success: false, error: msg || "Internal error reassigning company" },
      500,
    );
  }
});

export default app;
