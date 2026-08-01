// ---------------------------------------------------------------------------
// D1-backed delivery-orders route.
//
// Mirrors the old src/api/routes/delivery-orders.ts response shape so the SPA
// frontend doesn't need any changes. `items` is returned as a nested array
// joined from delivery_order_items. JSON columns (`fgUnitIds`,
// `proofOfDelivery`) are parsed on read and stringified on write.
//
// Phase coverage: full CRUD (phase 3) + the phase-4 stocking cascade —
// fg_units stamping on LOADED, FIFO COGS + SO status cascade + auto-
// invoice on DELIVERED, and the LOADED → DRAFT reversal that unstamps
// fg_units when the operator reopens the DO. The header used to flag
// these as deferred but the work landed; only the comment was stale.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { consumeFGBatchesForDO } from "../lib/do-cost-cascade";
import {
  // loadDoValueMap is referenced in the comments below (it's the resolver this
  // file's pricing mirrors) but every call here goes through the cached variant.
  // The dead import blocked the commit hook; it's still imported where it's
  // genuinely used (lib/delivery-agent.ts).
  loadDoValueMapCached,
  loadPoValueMap,
  loadSoLinePriceIndex,
  priceForItem,
} from "../lib/do-value";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import { checkDeliveryOrderLocked, lockedResponse } from "../lib/lock-helpers";
import { nextInvoiceNo, buildInvoiceLedgerLegs } from "./invoices";
import { readGstRatePct } from "../lib/note-ledger";
import {
  ledgerHasSource,
  buildJournalEntryStatements,
} from "../lib/journal-hash";
import {
  selectBestBomByCode,
  piecesFor as piecesForShared,
  deriveComponentRacks,
  buildRepairNote,
  type PackingJcRow,
} from "../lib/print-extras-shared";
import { parseRepairScope, type RepairScope } from "../../lib/repair-scope";
import { formatRacksCompact } from "../../lib/rack-format";
import { createPackingListCore } from "./packing-lists";
import { fetchFilteredPOs, attachCustomerSO } from "./production-orders";
import {
  buildReadyPlanning,
  type ReadyPlanningPO,
} from "../../lib/delivery-pipeline";
import {
  groupPosByCustomerHub,
  projectCreditFailure,
} from "../lib/pl-first-grouping";
import { enqueueEmail } from "../lib/email-outbox";
import {
  dispatchNoticeTemplate,
  invoiceNoticeTemplate,
  resolveDispatchRecipient,
  resolveInvoiceRecipient,
  fmtEmailDate,
} from "../lib/customer-notify";
import { buildSimpleTablePdf } from "../lib/assistant-exports";
// Server-side render of the SAME unified DO / Invoice the FE downloads and
// e-mails. Workers-pure (pdf-lib), so the pure-backend notice path (a
// transition with no client render) produces the identical document instead
// of the simplified branded fallback. buildSimpleTablePdf stays the ULTIMATE
// fallback if the unified render ever throws on Workers.
import { buildUnifiedDocPdf } from "../lib/unified-do-invoice-pdf";
import {
  buildUnifiedDoData,
  buildUnifiedInvoiceData,
} from "../../lib/build-unified-doc-data";
import { HOOKKA_LOGO_PNG_BASE64 } from "../lib/hookka-logo-base64";
import { computeInvoicePrintExtras } from "../lib/invoice-print-extras";
import { ensureInvoicePoLinkColumn } from "../lib/invoice-po-link";
import { getOrCreateQrToken, qrScanUrl } from "../lib/do-qr-token";
// Company office number — the driver-contact fallback on dispatch notices
// (owner rule: no driver phone on file → give the company's number).


import {
  loadHubStateMap,
  loadDoInvoiceMap,
  loadProductM3Map,
  loadRepairScopeByPo,
  rowToOrderList,
  genInvoiceId,
  resolveDoSalesOrderIds,
  computeDoInvoiceLines,
  buildDoDeliveredSoAndInvoice,
  fetchOrderWithItems,
  loadServiceOrderHubMeta,
  createDeliveryOrderForPOs,
  computeDoPrintExtras,
  ensureNotifyEmailColumns,
  ensureDeliveryIncompleteColumn,
  queueDoCustomerNotice,
  applyDeliveryOrderUpdate,
} from "./delivery-orders/_helpers";
import type {
  DeliveryOrderRow,
  DeliveryOrderItemRow,
  DoCreateOutcome,
} from "./delivery-orders/_helpers";

// Re-export the helpers that external modules / tests import from this route
// module, so importers of ".../delivery-orders" keep working with no changes.
export {
  fireCustomerNoticeBestEffort,
  loadHubStateMap,
  loadProductM3Map,
  resolveDoSalesOrderIds,
  computeDoInvoiceLines,
  loadServiceOrderHubMeta,
  ensureDeliveryIncompleteColumn,
  queueDoCustomerNotice,
  applyDeliveryOrderUpdate,
} from "./delivery-orders/_helpers";

const app = new Hono<Env>();

// GET /api/delivery-orders — list all, nested items
//
// Opt-in pagination via ?page=N&limit=M. When either is supplied, SQL
// LIMIT/OFFSET is applied and delivery_order_items is scoped to the
// page's DO IDs. Default limit=50, cap=500. Omitting both params returns
// the full list (backward compatible).
//
// ?includeArchive=true — phase-5 historical toggle. delivery_orders has
// no archive table (phase 5 only archives production + sales), so this
// flag is currently a no-op here — accepted for API symmetry with the
// other three list endpoints but never changes the result set. Left as
// a param so callers can pass the same query string uniformly.
app.get("/", async (c) => {
  // RBAC gate — listing DOs requires delivery-orders:read.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const db = c.var.DB;
  const orgId = getOrgId(c);
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;

  if (!paginate) {
    const [orders, items, valueMap] = await Promise.all([
      db
        .prepare("SELECT * FROM delivery_orders WHERE orgId = ? ORDER BY created_at DESC")
        .bind(orgId)
        .all<DeliveryOrderRow>(),
      db
        .prepare("SELECT * FROM delivery_order_items WHERE orgId = ?")
        .bind(orgId)
        .all<DeliveryOrderItemRow>(),
      loadDoValueMapCached(db, orgId, c),
    ]);
    const itemRows = items.results ?? [];
    const orderRows = orders.results ?? [];
    const [m3Map, hubStateMap, invoiceMap, repairScopeByPo] = await Promise.all([
      loadProductM3Map(db, itemRows.map((i) => i.productCode)),
      loadHubStateMap(db, orderRows.map((o) => o.hubId)),
      loadDoInvoiceMap(db, orgId),
      loadRepairScopeByPo(db, itemRows.map((i) => i.productionOrderId)),
    ]);
    // De-quadratic (2026-06-04): group items by deliveryOrderId ONCE so each
    // rowToOrderList gets only its own items instead of re-scanning ALL items
    // (rowToOrder + rowToOrderList each filter the full array per row). GET
    // /api/delivery-orders was P95 10-19s — this O(orders × items) scan was a
    // top driver. Output byte-identical: the per-row filters still run, over a
    // pre-narrowed list.
    const itemsByDO = new Map<string, DeliveryOrderItemRow[]>();
    for (const it of itemRows) {
      const arr = itemsByDO.get(it.deliveryOrderId);
      if (arr) arr.push(it);
      else itemsByDO.set(it.deliveryOrderId, [it]);
    }
    const data = orderRows.map((o) => {
      const order = rowToOrderList(o, itemsByDO.get(o.id) ?? [], m3Map, hubStateMap, repairScopeByPo);
      order.valueSen = valueMap.get(o.id) ?? 0;
      order.invoiceNo = invoiceMap.get(o.id) ?? "";
      return order;
    });
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  // Search term resolved before `limit` so an active search can lift the page
  // cap and return every match in one shot (the delivery page sends a high
  // limit while searching so results aren't trapped on page 2/3).
  const dq = (c.req.query("search") || c.req.query("q") || "").trim();
  const limit = Math.min(dq ? 2000 : 500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  // Optional search (?search= / ?q=). Matches the operator's real lookup keys,
  // not just DO no. + customer name: our company SO, customer PO, and vehicle
  // plate live on delivery_orders; the per-line SO numbers and the customer's
  // own SO / Reference live on the items and their sales_orders (a DO can span
  // several SOs), so those go through an EXISTS subquery. Fires only when a
  // term is present, so the unsearched list path is byte-identical to before.
  let dWhere = "";
  let dBinds: string[] = [];
  if (dq) {
    const like = `%${dq}%`;
    dWhere =
      " AND (do_no ILIKE ? OR customer_name ILIKE ? OR company_so ILIKE ?" +
      " OR company_so_id ILIKE ? OR customer_po_id ILIKE ? OR vehicle_no ILIKE ?" +
      " OR EXISTS (SELECT 1 FROM delivery_order_items di" +
      " LEFT JOIN sales_orders so2 ON so2.company_so_id = di.sales_order_no" +
      " WHERE di.delivery_order_id = delivery_orders.id" +
      " AND (di.sales_order_no ILIKE ? OR so2.customer_po_id ILIKE ?" +
      " OR so2.customer_so_id ILIKE ? OR so2.reference ILIKE ?)))";
    dBinds = [like, like, like, like, like, like, like, like, like, like];
  }

  const [countRes, pageRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM delivery_orders WHERE orgId = ?${dWhere}`)
      .bind(orgId, ...dBinds)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT * FROM delivery_orders WHERE orgId = ?${dWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(orgId, ...dBinds, limit, offset)
      .all<DeliveryOrderRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const orderRows = pageRes.results ?? [];

  let items: DeliveryOrderItemRow[] = [];
  if (orderRows.length > 0) {
    const ids = orderRows.map((o) => o.id);
    const placeholders = ids.map(() => "?").join(",");
    const itemsRes = await db
      .prepare(
        `SELECT * FROM delivery_order_items WHERE orgId = ? AND deliveryOrderId IN (${placeholders})`,
      )
      .bind(orgId, ...ids)
      .all<DeliveryOrderItemRow>();
    items = itemsRes.results ?? [];
  }
  const [m3Map, hubStateMap, valueMap, invoiceMap, repairScopeByPo] =
    await Promise.all([
      loadProductM3Map(db, items.map((i) => i.productCode)),
      loadHubStateMap(db, orderRows.map((o) => o.hubId)),
      loadDoValueMapCached(db, orgId, c),
      loadDoInvoiceMap(db, orgId),
      loadRepairScopeByPo(db, items.map((i) => i.productionOrderId)),
    ]);
  // De-quadratic: same per-DO grouping as the full-list branch above.
  const itemsByDO = new Map<string, DeliveryOrderItemRow[]>();
  for (const it of items) {
    const arr = itemsByDO.get(it.deliveryOrderId);
    if (arr) arr.push(it);
    else itemsByDO.set(it.deliveryOrderId, [it]);
  }
  const data = orderRows.map((o) => {
    const order = rowToOrderList(o, itemsByDO.get(o.id) ?? [], m3Map, hubStateMap, repairScopeByPo);
    order.valueSen = valueMap.get(o.id) ?? 0;
    order.invoiceNo = invoiceMap.get(o.id) ?? "";
    return order;
  });
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/delivery-orders/stats — whole-dataset status bucket counts.
//
// Returns { byStatus: Record<string, number>, total }. Used by the delivery
// list page summary cards + tab badges so counts reflect the full table
// rather than only the current paginated page. Registered BEFORE /:id
// (Hono route ordering: static routes before wildcards).
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  // RBAC gate — stats are aggregate reads of the same data, gated identically.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);

  // PR 3 (2026-05-20) — cache-aside snapshot. See lib/delivery-snapshot.ts
  // for the architecture. Mirror of the pattern in routes/dashboard-overview.ts.
  {
    const { readDeliveryStatsSnapshot, getDeliveryStatsMaxUpdatedAt, isSnapshotFresh } =
      await import("../lib/delivery-snapshot");
    const [snap, currentMax] = await Promise.all([
      readDeliveryStatsSnapshot(c.var.DB, orgId),
      getDeliveryStatsMaxUpdatedAt(c.var.DB),
    ]);
    if (isSnapshotFresh(snap, currentMax) && snap) {
      return c.json({ success: true, ...snap.data });
    }
  }

  // Per-status count + RM value. Value = exact goods value (the SAME
  // per-DO resolver loadDoValueMap feeds the per-row Amount column), so
  // the column sums to the tab total to the cent and "Delivered"
  // reconciles with the Sales Orders "Delivered" total — no SQL-join
  // double-count, no invoiced-amount anchoring. Counts come from one
  // row-per-DO read (exact, no item-join multiplication).
  const [statusRes, valueMap] = await Promise.all([
    c.var.DB.prepare(
      "SELECT id, status FROM delivery_orders WHERE orgId = ?",
    )
      .bind(orgId)
      .all<{ id: string; status: string }>(),
    // Cached (snapshot + SWR) — same exact per-DO figure as the direct
    // loadDoValueMap, just off the cold-recompute path so /stats stops
    // paying the whole-org price-index scan on a cold read.
    loadDoValueMapCached(c.var.DB, orgId, c),
  ]);
  const byStatus: Record<string, number> = {};
  const valueByStatus: Record<string, number> = {};
  let total = 0;
  for (const row of statusRes.results ?? []) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    valueByStatus[row.status] =
      (valueByStatus[row.status] ?? 0) + (valueMap.get(row.id) ?? 0);
    total += 1;
  }
  const payload = { byStatus, valueByStatus, total };

  // PR 3 write-back. Errors swallowed — cache is perf, not load-bearing.
  try {
    const { writeDeliveryStatsSnapshot, getDeliveryStatsMaxUpdatedAt } =
      await import("../lib/delivery-snapshot");
    const currentMax = await getDeliveryStatsMaxUpdatedAt(c.var.DB);
    await writeDeliveryStatsSnapshot(
      c.var.DB,
      orgId,
      payload as Record<string, unknown>,
      currentMax ?? new Date().toISOString(),
    );
  } catch (e) {
    console.warn("[delivery-stats-snapshot] write-back failed:", e);
  }

  return c.json({ success: true, ...payload });
});

// ---------------------------------------------------------------------------
// GET /api/delivery-orders/po-values — exact value per production order
// (its own SO-line unit price × qty). The Planning / Pending Delivery
// tabs are PO-based (goods not yet on a DO); this lets the page show the
// exact Sales Figure from the same resolver the DO/invoice path uses,
// instead of guessing price by product code. Registered BEFORE /:id.
// ---------------------------------------------------------------------------
app.get("/po-values", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);

  // PR 3 (2026-05-20) — cache-aside snapshot. /po-values is the heaviest
  // delivery endpoint (per-PO resolver runs through every SO line of every
  // active PO), so this is the highest-value snapshot in PR 3. Layer 2
  // watches delivery_orders + delivery_order_items + sales_orders +
  // sales_order_items — a price edit on any line correctly invalidates.
  {
    const { readDeliveryPoValuesSnapshot, getDeliveryPoValuesMaxUpdatedAt, isSnapshotFresh } =
      await import("../lib/delivery-snapshot");
    const [snap, currentMax] = await Promise.all([
      readDeliveryPoValuesSnapshot(c.var.DB, orgId),
      getDeliveryPoValuesMaxUpdatedAt(c.var.DB),
    ]);
    if (isSnapshotFresh(snap, currentMax) && snap) {
      return c.json({ success: true, ...snap.data });
    }
  }

  const map = await loadPoValueMap(c.var.DB, orgId);
  const payload = { values: Object.fromEntries(map) };

  try {
    const { writeDeliveryPoValuesSnapshot, getDeliveryPoValuesMaxUpdatedAt } =
      await import("../lib/delivery-snapshot");
    const currentMax = await getDeliveryPoValuesMaxUpdatedAt(c.var.DB);
    await writeDeliveryPoValuesSnapshot(
      c.var.DB,
      orgId,
      payload as Record<string, unknown>,
      currentMax ?? new Date().toISOString(),
    );
  } catch (e) {
    console.warn("[delivery-po-values-snapshot] write-back failed:", e);
  }

  return c.json({ success: true, ...payload });
});

// COMPLETE set of production-order ids already carried on a non-cancelled
// Delivery Order — the AUTHORITATIVE "already delivered" set, NOT capped by the
// list page size. The Pending-Delivery list + Command Center MUST use this to
// decide what is still un-delivered. A capped DO fetch (page 1, limit 200)
// silently re-surfaced already-delivered orders (e.g. SO-2603-157, delivered on
// March DOs) once total DOs grew past one page — BUG-2026-06-27, root fix. One
// cheap DISTINCT, no row payload, so every consumer can hold the full set.
app.get("/linked-po-ids", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB
    .prepare(
      `SELECT DISTINCT doi.productionOrderId AS poId
         FROM delivery_order_items doi
         JOIN delivery_orders d ON d.id = doi.deliveryOrderId
        WHERE doi.orgId = ?
          AND doi.productionOrderId IS NOT NULL
          AND doi.productionOrderId <> ''
          AND d.status <> 'CANCELLED'`,
    )
    .bind(orgId)
    .all<{ poId?: string | null }>();
  const poIds = (res.results ?? [])
    .map((r) => r.poId)
    .filter((x): x is string => !!x);
  return c.json({ success: true, poIds });
});

// ---------------------------------------------------------------------------
// GET /api/delivery-orders/ready-planning — server-side Planning / Ready lists.
//
// Perf 2026-07-13: the Delivery page used to pull the whole ~1.2MB
// /api/production-orders?fields=minimal&include=jobCards ONLY to derive its
// Planning + "Ready for DO" rows client-side. This assembles the SAME inputs
// server-side and runs the SHARED buildReadyPlanning (src/lib/delivery-pipeline.ts,
// extracted verbatim from the page's mapPO) → the rows are byte-identical by
// construction (same code, same data). The page now fetches this small result
// instead of the 1.2MB payload. Registered BEFORE /:id (Hono static-first).
// ---------------------------------------------------------------------------
app.get("/ready-planning", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;

  // Runtime self-apply — migration files are inert on deploy, so the snapshot
  // table must be created here (awaited) before withSnapshot reads/writes it.
  // Exact generic-withSnapshot schema (org_id + cache_key composite PK).
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS delivery_ready_planning_snapshot (
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

  // Snapshot-cached + serve-stale: the compute below does the whole-org PO+JC
  // load + join (same cost the production-orders list pays), so without a cache
  // the delivery page would block its cold paint on an ~8s request. withSnapshot
  // serves the last good {ready,planning} instantly and refreshes in the
  // background; freshness tracks production_orders / job_cards / delivery_order_items.
  const { withSnapshot } = await import("../lib/snapshot");
  const data = await withSnapshot(
    db,
    {
      tableName: "delivery_ready_planning_snapshot",
      sourceTables: [
        "production_orders",
        "job_cards",
        "delivery_order_items",
        "delivery_orders",
        "sales_orders",
        "sales_order_items",
        "consignment_orders",
      ],
    },
    orgId,
    async () => {
  const [pos, soRes, itemRes, linkedRes, poValMap] = await Promise.all([
    fetchFilteredPOs(db, orgId, null, true, false, true),
    db
      .prepare(
        "SELECT id, companySOId, customerId, customerSO, customerSOId, customerPO, customerPOId, reference, hookkaExpectedDD FROM sales_orders WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        id: string;
        companySOId?: string;
        customerId?: string;
        customerSO?: string;
        customerSOId?: string;
        customerPO?: string;
        customerPOId?: string;
        reference?: string;
        hookkaExpectedDD?: string;
      }>(),
    db
      .prepare(
        "SELECT salesOrderId, productCode, unitPriceSen FROM sales_order_items WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        salesOrderId: string;
        productCode?: string;
        unitPriceSen?: number;
      }>(),
    db
      .prepare(
        `SELECT DISTINCT doi.productionOrderId AS poId
           FROM delivery_order_items doi
           JOIN delivery_orders d ON d.id = doi.deliveryOrderId
          WHERE doi.orgId = ?
            AND doi.productionOrderId IS NOT NULL
            AND doi.productionOrderId <> ''
            AND d.status <> 'CANCELLED'`,
      )
      .bind(orgId)
      .all<{ poId?: string | null }>(),
    loadPoValueMap(db, orgId),
  ]);

  // Enrich customerSO / customerPOId / hookkaExpectedDD onto the POs — the SAME
  // attachCustomerSO the /api/production-orders payload runs, so the po fields
  // the row builder reads match the page's poRaw exactly.
  await attachCustomerSO(
    db,
    pos as Array<{
      salesOrderId: string;
      consignmentOrderId: string;
      customerSO: string;
    }>,
  );

  const linkedPOIds = new Set(
    (linkedRes.results ?? [])
      .map((r) => r.poId)
      .filter((x): x is string => !!x),
  );

  const itemsBySo = new Map<
    string,
    { productCode?: string; unitPriceSen?: number }[]
  >();
  for (const it of itemRes.results ?? []) {
    const arr = itemsBySo.get(it.salesOrderId);
    if (arr) arr.push(it);
    else itemsBySo.set(it.salesOrderId, [it]);
  }

  const soMap = new Map<
    string,
    { hookkaExpectedDD: string; companySOId: string; customerId: string }
  >();
  const soRefMap = new Map<
    string,
    { customerSO: string; reference: string; customerPO: string }
  >();
  const soPriceByProduct = new Map<string, Map<string, number>>();
  for (const so of soRes.results ?? []) {
    soMap.set(so.id, {
      hookkaExpectedDD: so.hookkaExpectedDD || "",
      companySOId: so.companySOId || "",
      customerId: so.customerId || "",
    });
    // Dual-keyed + *Id-first, mirroring the page's soRefMap builder.
    const v = {
      customerSO: so.customerSOId || so.customerSO || "",
      reference: so.reference || "",
      customerPO: so.customerPOId || so.customerPO || "",
    };
    soRefMap.set(so.id, v);
    if (so.companySOId) soRefMap.set(so.companySOId, v);
    const priceMap = new Map<string, number>();
    for (const it of itemsBySo.get(so.id) ?? []) {
      if (it.productCode)
        priceMap.set(it.productCode, Number(it.unitPriceSen) || 0);
    }
    soPriceByProduct.set(so.id, priceMap);
  }

  const productM3Map = await loadProductM3Map(
    db,
    (pos as Array<{ productCode?: string }>).map((p) => p.productCode),
  );

  const { ready, planning } = buildReadyPlanning({
    allPOs: pos as unknown as ReadyPlanningPO[],
    linkedPOIds,
    soMap,
    soRefMap,
    poValMap,
    soPriceByProduct,
    productM3Map,
  });
      return { ready, planning };
    },
    "",
    c,
    { staleWhileRevalidate: true },
  );
  return c.json({ success: true, ...data });
});

// ---------------------------------------------------------------------------
// GET /api/delivery-orders/pending-sos
//
// Confirmed / in-production / ready-to-ship Sales Orders that have NO delivery
// order yet. These are exactly what the mobile Delivery "Planning" (not yet
// ready) and "Pending Delivery" (ready-to-ship) tabs show — a DO only exists
// from *Pending Dispatch* onward (design 2026-07 / INDEX rule 7: "Planning and
// Pending Delivery show confirmed SOs that are ready but have no DO yet — never
// show a DO in Planning / Pending Delivery"). "Has a DO" = the SO is the DO's
// primary salesOrderId OR one of the SOs its production orders belong to (multi-
// SO DOs), across non-cancelled DOs. Registered BEFORE /:id.
// ---------------------------------------------------------------------------
app.get("/pending-sos", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    `SELECT id, companySO, companySOId, customerName, customerState,
            customerPO, customerPOId, customerSO, customerSOId, reference,
            hubName, hookkaExpectedDD, totalSen, status
       FROM sales_orders
      WHERE orgId = ?
        AND status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')
        AND id NOT IN (
          SELECT salesOrderId FROM delivery_orders
            WHERE orgId = ? AND salesOrderId IS NOT NULL AND salesOrderId <> ''
              AND status <> 'CANCELLED'
          UNION
          SELECT DISTINCT po.salesOrderId
            FROM delivery_order_items doi
            JOIN delivery_orders d ON d.id = doi.deliveryOrderId
            JOIN production_orders po ON po.id = doi.productionOrderId
           WHERE d.status <> 'CANCELLED'
             AND po.salesOrderId IS NOT NULL AND po.salesOrderId <> ''
        )
      ORDER BY hookkaExpectedDD ASC`,
  )
    .bind(orgId, orgId)
    .all<Record<string, unknown>>();
  const data = (res.results ?? []).map((r) => ({
    ...r,
    // planTab drives the mobile sub-tab: ready-to-ship → "pending", else "planning".
    planTab: r.status === "READY_TO_SHIP" ? "pending" : "planning",
  }));
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/backfill-customer-po
//
// One-shot historical repair (Wei Siang 2026-06-03). Old DOs never snapshotted
// their Sales Order's Customer PO, so ~41% of DOs show a blank Customer PO and
// the operator can't find orders by it. Every Sales Order DOES carry a
// customerPOId; this copies it onto each DO that is missing one — preferring the
// DO's own primary salesOrderId, then falling back to the most common non-empty
// customerPOId across the DO's items' sales orders (joined by SO number).
//
//   ?dry=1  → preview only: counts + samples, no writes.
//   (default) → execute: one batched UPDATE.
//
// Idempotent: only touches DOs whose customerPOId is NULL/empty; re-running is a
// no-op once filled. Temporary migration endpoint; delete once backfilled.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-customer-po", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";

  const dosRes = await c.var.DB.prepare(
    "SELECT id, doNo, salesOrderId FROM delivery_orders WHERE orgId = ? AND (customerPOId IS NULL OR customerPOId = '')",
  )
    .bind(orgId)
    .all<{ id: string; doNo: string; salesOrderId: string | null }>();
  const dos = dosRes.results ?? [];

  let scanned = 0;
  let filled = 0;
  let stillEmpty = 0;
  const samples: { doNo: string; po: string }[] = [];
  const updates: D1PreparedStatement[] = [];

  for (const d of dos) {
    scanned++;
    let po: string | null = null;
    // 1) Prefer the DO's own primary sales order.
    if (d.salesOrderId) {
      const so = await c.var.DB.prepare(
        "SELECT customerPOId FROM sales_orders WHERE id = ?",
      )
        .bind(d.salesOrderId)
        .first<{ customerPOId: string | null }>();
      if (so?.customerPOId && so.customerPOId.trim()) po = so.customerPOId.trim();
    }
    // 2) Fall back to the most common non-empty PO across the DO's items' SOs.
    if (!po) {
      const r = await c.var.DB.prepare(
        `SELECT so.customerPOId AS po, COUNT(*) AS n
           FROM delivery_order_items di
           JOIN sales_orders so ON so.companySOId = di.salesOrderNo
          WHERE di.deliveryOrderId = ?
            AND so.customerPOId IS NOT NULL AND so.customerPOId <> ''
          GROUP BY so.customerPOId
          ORDER BY n DESC
          LIMIT 1`,
      )
        .bind(d.id)
        .first<{ po: string }>();
      if (r?.po && r.po.trim()) po = r.po.trim();
    }
    if (po) {
      filled++;
      if (samples.length < 10) samples.push({ doNo: d.doNo, po });
      if (!dry) {
        updates.push(
          c.var.DB.prepare(
            "UPDATE delivery_orders SET customerPOId = ? WHERE id = ?",
          ).bind(po, d.id),
        );
      }
    } else {
      stillEmpty++;
    }
  }

  if (!dry && updates.length > 0) {
    await c.var.DB.batch(updates);
  }

  return c.json({
    success: true,
    dry,
    scanned,
    filled,
    stillEmpty,
    samples,
  });
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/backfill-customer-so
//
// One-shot historical repair (Wei Siang 2026-06-03). Sibling of
// backfill-customer-po. Migration 0146 added delivery_orders.customerSOId /
// customerSO / reference (the customer's own SO number + reference, shown as
// the "Customer SO" / "Customer Ref" columns) with NO backfill, so every DO
// has them blank even though the linked sales orders carry the values. This
// copies each missing field from the DO's primary salesOrderId, else from the
// most-common non-empty value across the DO's items' sales orders (joined by
// the INTERNAL SO number: delivery_order_items.salesOrderNo = sales_orders.
// companySOId).
//
//   ?dry=1  → preview only: counts + samples, no writes.
//   (default) → execute: one batched UPDATE.
//
// Idempotent: only touches DOs whose customerSOId AND customerSO AND reference
// are all NULL/empty; re-running is a no-op once filled. Each field is filled
// independently via COALESCE so a partially-filled DO keeps what it has.
// Temporary migration endpoint; delete once backfilled.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-customer-so", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";

  const dosRes = await c.var.DB.prepare(
    `SELECT id, doNo, salesOrderId, customerSOId, customerSO, reference
       FROM delivery_orders
      WHERE orgId = ?
        AND (customerSOId IS NULL OR customerSOId = '')
        AND (customerSO IS NULL OR customerSO = '')
        AND (reference IS NULL OR reference = '')`,
  )
    .bind(orgId)
    .all<{
      id: string;
      doNo: string;
      salesOrderId: string | null;
      customerSOId: string | null;
      customerSO: string | null;
      reference: string | null;
    }>();
  const dos = dosRes.results ?? [];

  let scanned = 0;
  let filled = 0;
  let stillEmpty = 0;
  const fieldsFilled = { customerSOId: 0, customerSO: 0, reference: 0 };
  const samples: {
    doNo: string;
    customerSOId: string;
    customerSO: string;
    reference: string;
  }[] = [];
  const updates: D1PreparedStatement[] = [];

  for (const d of dos) {
    scanned++;
    let ref: {
      customerSOId: string | null;
      customerSO: string | null;
      reference: string | null;
    } | null = null;

    // 1) Prefer the DO's own primary sales order.
    if (d.salesOrderId) {
      ref = await c.var.DB.prepare(
        "SELECT customerSOId, customerSO, reference FROM sales_orders WHERE id = ?",
      )
        .bind(d.salesOrderId)
        .first<{
          customerSOId: string | null;
          customerSO: string | null;
          reference: string | null;
        }>();
    }

    // 2) Fall back, PER FIELD, to the most common non-empty value across the
    //    DO's items' sales orders (joined by internal SO number companySOId).
    const pickMostCommon = async (col: string): Promise<string | null> => {
      const r = await c.var.DB.prepare(
        `SELECT so.${col} AS v, COUNT(*) AS n
           FROM delivery_order_items di
           JOIN sales_orders so ON so.companySOId = di.salesOrderNo
          WHERE di.deliveryOrderId = ?
            AND so.${col} IS NOT NULL AND so.${col} <> ''
          GROUP BY so.${col}
          ORDER BY n DESC
          LIMIT 1`,
      )
        .bind(d.id)
        .first<{ v: string }>();
      return r?.v && r.v.trim() ? r.v.trim() : null;
    };

    let soId = ref?.customerSOId && ref.customerSOId.trim() ? ref.customerSOId.trim() : null;
    let so = ref?.customerSO && ref.customerSO.trim() ? ref.customerSO.trim() : null;
    let refn = ref?.reference && ref.reference.trim() ? ref.reference.trim() : null;
    if (!soId) soId = await pickMostCommon("customerSOId");
    if (!so) so = await pickMostCommon("customerSO");
    if (!refn) refn = await pickMostCommon("reference");

    if (!soId && !so && !refn) {
      stillEmpty++;
      continue;
    }
    filled++;
    if (soId) fieldsFilled.customerSOId++;
    if (so) fieldsFilled.customerSO++;
    if (refn) fieldsFilled.reference++;
    if (samples.length < 10) {
      samples.push({
        doNo: d.doNo,
        customerSOId: soId ?? "",
        customerSO: so ?? "",
        reference: refn ?? "",
      });
    }
    if (!dry) {
      updates.push(
        c.var.DB.prepare(
          `UPDATE delivery_orders
              SET customerSOId = COALESCE(NULLIF(?, ''), customerSOId),
                  customerSO   = COALESCE(NULLIF(?, ''), customerSO),
                  reference    = COALESCE(NULLIF(?, ''), reference)
            WHERE id = ?`,
        ).bind(soId ?? "", so ?? "", refn ?? "", d.id),
      );
    }
  }

  if (!dry && updates.length > 0) {
    await c.var.DB.batch(updates);
  }

  return c.json({
    success: true,
    dry,
    scanned,
    filled,
    stillEmpty,
    fieldsFilled,
    samples,
  });
});

// POST /api/delivery-orders/backfill-delivered-cascade
//
// One-shot historical repair (Wei Siang 2026-05-16). Every DO that is
// physically DELIVERED/INVOICED but whose sales orders were never advanced
// (multi-SO DOs the old gate skipped, or DOs delivered before the cascade
// existed) and whose combined invoice was never created. Walks each such
// DO through the EXACT same buildDoDeliveredSoAndInvoice helper the live
// transition now uses, so the repair and the live path can never drift.
//
//   ?dry=1  → preview only: counts + estimated invoice value, no writes.
//   (default) → execute: one atomic batch per DO, sequential (a shared SO
//                across DOs would deadlock if parallel — BUG-2026-05-16-002),
//                with the same invoice-number retry the PUT path uses.
//
// Idempotent: the helper skips SOs already at/past DELIVERED and skips the
// invoice if one already references the DO — safe to run repeatedly.
// Temporary migration endpoint; delete once the book is repaired.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-delivered-cascade", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";
  const now = new Date().toISOString();

  const dosRes = await c.var.DB.prepare(
    "SELECT * FROM delivery_orders WHERE orgId = ? AND status IN ('DELIVERED','INVOICED') ORDER BY created_at ASC",
  )
    .bind(orgId)
    .all<DeliveryOrderRow>();
  const dos = dosRes.results ?? [];

  let dosScanned = 0;
  let invoicesCreated = 0;
  let sosAdvanced = 0;
  let totalInvoicedSen = 0;
  // Dedupe SO counting across DOs: in dry-run nothing is written so a
  // shared SO would be counted by every DO that touches it; the real
  // run self-dedupes via DB state but the Set keeps both consistent.
  const advancedSoSet = new Set<string>();
  const errors: { doId: string; doNo: string; error: string }[] = [];
  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "userId",
    ) ?? null;

  for (const doRow of dos) {
    dosScanned++;
    try {
      const dc = await buildDoDeliveredSoAndInvoice(
        c.var.DB,
        doRow,
        now,
        orgId,
        actorUserId,
      );
      if (dc.statements.length === 0) continue;
      if (dc.createdInvoice) {
        invoicesCreated++;
        totalInvoicedSen += dc.invoiceTotalSen;
      }
      for (const soId of dc.soAdvanced) {
        if (!advancedSoSet.has(soId)) {
          advancedSoSet.add(soId);
          sosAdvanced++;
        }
      }
      if (dry) continue;

      // Execute this DO's repair as its own atomic batch, with the
      // same invoice-number-collision retry as the live PUT path.
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await c.var.DB.batch(dc.statements);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isInvoiceDup =
            /ux_invoices_invoice_no|invoices_invoice_no|duplicate key/i.test(
              msg,
            );
          if (
            isInvoiceDup &&
            dc.rebuildInvoiceInsert &&
            dc.invoiceStmtIdx >= 0 &&
            attempt < 5
          ) {
            attempt++;
            dc.statements[dc.invoiceStmtIdx] = dc.rebuildInvoiceInsert(
              await nextInvoiceNo(c.var.DB),
            );
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      errors.push({
        doId: doRow.id,
        doNo: doRow.doNo,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return c.json({
    success: true,
    mode: dry ? "dry-run" : "executed",
    deliveredDosFound: dos.length,
    dosScanned,
    sosAdvanced,
    invoicesCreated,
    totalInvoicedSen,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/backfill-fix-underbilled-invoices
//
// One-shot finance repair (Wei Siang 2026-05-16). Multi-SO delivery notes
// carry an OLD invoice the pre-fix single-SO auto-invoice created — it
// billed only ONE sales order's slice of a note that delivered several
// (under-billed); a few are over-billed. Every delivered DO's invoice must
// EXACTLY equal the delivered goods value (computeDoInvoiceLines — same
// basis as live creation). ZERO tolerance: any cent of mismatch, up OR
// down, is corrected; the invoice id + number are kept; the customer's
// outstanding A/R is adjusted by the exact signed delta.
//
// SAFETY: only rewrites a DO whose single non-cancelled invoice is DRAFT
// (never sent, never paid, not in accounting). Anything that can't be
// safely auto-fixed — non-DRAFT (SENT/PARTIAL/PAID/OVERDUE), several
// invoices on one DO, no invoice at all, or a computed value of 0 (SO
// resolution failed — never zero out a real invoice on a failed compute)
// — is NOT touched but its exact discrepancy is still tallied so the
// manual backlog is quantified to the cent, not hand-waved. Every scanned
// DO lands in exactly one bucket and the buckets reconcile.
//
//   ?dry=1  → preview only, no writes.
// Temporary migration endpoint; delete once the book is corrected.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-fix-underbilled-invoices", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";
  const now = new Date().toISOString();

  const dosRes = await c.var.DB.prepare(
    "SELECT * FROM delivery_orders WHERE orgId = ? AND status IN ('DELIVERED','INVOICED') ORDER BY created_at ASC",
  )
    .bind(orgId)
    .all<DeliveryOrderRow>();
  const dos = dosRes.results ?? [];

  let scanned = 0;
  // Auto-fixed (DRAFT, single invoice)
  let upN = 0,
    upSen = 0; // under-billed → topped up (sen added)
  let downN = 0,
    downSen = 0; // over-billed → reduced (sen removed, positive)
  let exactN = 0; // already exactly right
  // Not auto-fixed — tallied for manual handling, exact discrepancy kept
  let lockedN = 0,
    lockedUnderSen = 0,
    lockedOverSen = 0; // non-DRAFT invoice
  let multiN = 0,
    multiUnderSen = 0,
    multiOverSen = 0; // >1 invoice on the DO
  let noInvN = 0,
    noInvMissingSen = 0; // delivered, zero invoice
  let noComputeN = 0; // SO resolution gave 0 — left untouched
  // Grand reconciliation
  let totalGoodsSen = 0; // Σ correct delivered value over ALL scanned
  let totalInvoicedNowSen = 0; // Σ current non-cancelled invoice value
  let netOutstandingChangeSen = 0; // signed Σ of deltas actually applied
  const errors: { doId: string; doNo: string; error: string }[] = [];

  for (const doRow of dos) {
    scanned++;
    try {
      const invs =
        (
          await c.var.DB.prepare(
            "SELECT id, status, totalSen FROM invoices WHERE deliveryOrderId = ? AND status != 'CANCELLED'",
          )
            .bind(doRow.id)
            .all<{ id: string; status: string; totalSen: number }>()
        ).results ?? [];
      const curInvoiced = invs.reduce(
        (s, v) => s + (Number(v.totalSen) || 0),
        0,
      );
      totalInvoicedNowSen += curInvoiced;

      const soIds = await resolveDoSalesOrderIds(
        c.var.DB,
        doRow.id,
        doRow.salesOrderId,
      );
      const { invItems, computedTotal } = await computeDoInvoiceLines(
        c.var.DB,
        doRow.id,
        soIds,
      );
      totalGoodsSen += computedTotal;
      const diff = computedTotal - curInvoiced; // + = under, - = over

      // --- Cannot safely auto-fix: tally exact discrepancy, do not touch ---
      if (invs.length === 0) {
        noInvN++;
        noInvMissingSen += computedTotal;
        continue;
      }
      if (computedTotal === 0) {
        noComputeN++;
        continue;
      }
      if (invs.length > 1) {
        multiN++;
        if (diff > 0) multiUnderSen += diff;
        else if (diff < 0) multiOverSen += -diff;
        continue;
      }
      const inv = invs[0];
      if (inv.status !== "DRAFT") {
        lockedN++;
        if (diff > 0) lockedUnderSen += diff;
        else if (diff < 0) lockedOverSen += -diff;
        continue;
      }

      const oldTotal = Number(inv.totalSen) || 0;
      if (computedTotal === oldTotal) {
        exactN++;
        continue;
      }

      // --- Auto-fix this DRAFT invoice to EXACTLY the delivered value ---
      if (computedTotal > oldTotal) {
        upN++;
        upSen += computedTotal - oldTotal;
      } else {
        downN++;
        downSen += oldTotal - computedTotal;
      }
      netOutstandingChangeSen += computedTotal - oldTotal;
      if (dry) continue;

      const stmts: D1PreparedStatement[] = [
        c.var.DB.prepare(
          "DELETE FROM invoice_items WHERE invoiceId = ?",
        ).bind(inv.id),
      ];
      for (const it of invItems) {
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO invoice_items (
               id, invoiceId, productCode, productName, sizeLabel, fabricCode,
               quantity, unitPriceSen, totalSen, production_order_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            it.id,
            inv.id,
            it.productCode,
            it.productName,
            it.sizeLabel,
            it.fabricCode,
            it.quantity,
            it.unitPriceSen,
            it.totalSen,
            // BUG-2026-07-17-001 — carry the DO's per-line link (see InvItem).
            it.productionOrderId,
          ),
        );
      }
      stmts.push(
        c.var.DB.prepare(
          "UPDATE invoices SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?",
        ).bind(computedTotal, computedTotal, now, inv.id),
        c.var.DB.prepare(
          "UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?",
        ).bind(computedTotal - oldTotal, doRow.customerId),
      );
      await c.var.DB.batch(stmts);
    } catch (e) {
      errors.push({
        doId: doRow.id,
        doNo: doRow.doNo,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const bucketSum =
    upN +
    downN +
    exactN +
    lockedN +
    multiN +
    noInvN +
    noComputeN +
    errors.length;

  return c.json({
    success: true,
    mode: dry ? "dry-run" : "executed",
    deliveredDosScanned: scanned,
    bucketsReconcile: bucketSum === scanned,
    autoFixed: {
      underBilled: { n: upN, addedSen: upSen },
      overBilled: { n: downN, removedSen: downSen },
      exactAlready: { n: exactN },
      netOutstandingChangeSen,
    },
    needsManual: {
      lockedNonDraft: {
        n: lockedN,
        underSen: lockedUnderSen,
        overSen: lockedOverSen,
      },
      multipleInvoices: {
        n: multiN,
        underSen: multiUnderSen,
        overSen: multiOverSen,
      },
      noInvoice: { n: noInvN, missingSen: noInvMissingSen },
      computeReturnedZero: { n: noComputeN },
    },
    reconciliation: {
      totalDeliveredGoodsSen: totalGoodsSen,
      totalInvoicedBeforeSen: totalInvoicedNowSen,
      gapBeforeSen: totalGoodsSen - totalInvoicedNowSen,
    },
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/backfill-void-reissue-underbilled
//
// One-shot finance repair (Wei Siang 2026-05-18, BUG-2026-05-18-004).
// Sibling of /backfill-fix-underbilled-invoices, but for the invoices that
// one CANNOT safely touch: a single non-cancelled SENT/OVERDUE invoice that
// is already posted to the ledger and is mis-billed vs the delivered goods
// value (the pricing bug billed unmatched items at 0). Those can't be
// rewritten in place — the ledger model only supports post + reverse, not
// in-place adjust. So per qualifying DO we VOID + RE-ISSUE:
//
//   batch 1 (atomic): reverse the old invoice's ledger posting (idempotent
//     invoice_void legs, exact mirror — old items left intact), set the old
//     invoice CANCELLED, INSERT a new SENT invoice + items at the CORRECT
//     value, net the customer's A/R by EXACTLY (correct - old) [the void
//     path itself never touches A/R — this is the one explicit gap we close
//     here], flip the DO to INVOICED.
//   batch 2: post the new invoice's ledger (reads the now-committed new
//     items for the category split, same as the live DRAFT->SENT path).
//
// SAFETY: only DOs whose single non-cancelled invoice is SENT/OVERDUE with
// paidAmount = 0 are auto-fixed. PAID / partially-paid (money received),
// DRAFT (use the other backfill), >1 invoice, no invoice, or computed value
// 0 are NEVER touched — each is tallied with its exact discrepancy so the
// manual backlog is quantified. Idempotent: a re-run sees the old invoice
// CANCELLED (excluded) and the new one already correct (exact) -> no-op;
// ledgerHasSource guards prevent double reverse / double post.
//
//   ?dry=1 → preview only, no writes; returns the full per-invoice table
//            (old no, old total, correct total, delta) — this IS the
//            reconciliation/audit artifact.
// Temporary migration endpoint; delete once the book is corrected.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-void-reissue-underbilled", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";
  const now = new Date().toISOString();
  const invoiceDate = now.split("T")[0];
  const due = new Date();
  due.setDate(due.getDate() + 30);
  const dueDate = due.toISOString().split("T")[0];
  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "userId",
    ) ?? null;

  const dosRes = await c.var.DB.prepare(
    "SELECT * FROM delivery_orders WHERE orgId = ? AND status IN ('DELIVERED','INVOICED') ORDER BY created_at ASC",
  )
    .bind(orgId)
    .all<DeliveryOrderRow>();
  const dos = dosRes.results ?? [];

  let scanned = 0;
  let fixedN = 0,
    fixedDeltaSen = 0; // net signed A/R change applied
  let exactN = 0;
  let paidN = 0,
    paidDiffSen = 0; // money received — never touched
  let draftN = 0; // belongs to the other backfill
  let noInvN = 0;
  let noComputeN = 0;
  const rows: Array<{
    doNo: string;
    customer: string;
    oldInvoiceNo: string;
    oldStatus: string;
    oldTotalSen: number;
    correctTotalSen: number;
    deltaSen: number;
    action: string;
  }> = [];
  const errors: { doId: string; doNo: string; error: string }[] = [];

  for (const doRow of dos) {
    scanned++;
    try {
      // Self-heal: an earlier build of this migration wrongly flipped
      // fixed DOs to INVOICED, which crashed the Delivered total and hid
      // them (the Invoice tab was removed). Nothing was INVOICED before
      // this migration and the system keeps auto-invoiced DOs at
      // DELIVERED — so normalise any INVOICED DO back to DELIVERED.
      // Idempotent; runs regardless of which bucket the DO lands in.
      if (!dry && doRow.status === "INVOICED") {
        await c.var.DB.prepare(
          "UPDATE delivery_orders SET status = 'DELIVERED', updated_at = ? WHERE id = ?",
        )
          .bind(now, doRow.id)
          .run();
        doRow.status = "DELIVERED";
      }
      const invs =
        (
          await c.var.DB.prepare(
            "SELECT id, invoiceNo, status, subtotalSen, totalSen, paidAmount FROM invoices WHERE deliveryOrderId = ? AND status != 'CANCELLED'",
          )
            .bind(doRow.id)
            .all<{
              id: string;
              invoiceNo: string;
              status: string;
              subtotalSen: number;
              totalSen: number;
              paidAmount: number;
            }>()
        ).results ?? [];

      const soIds = await resolveDoSalesOrderIds(
        c.var.DB,
        doRow.id,
        doRow.salesOrderId,
      );
      const { invItems, computedTotal } = await computeDoInvoiceLines(
        c.var.DB,
        doRow.id,
        soIds,
      );

      if (invs.length === 0) {
        noInvN++;
        continue;
      }
      if (computedTotal === 0) {
        noComputeN++;
        continue;
      }
      const oldTotal = invs.reduce(
        (s, v) => s + (Number(v.totalSen) || 0),
        0,
      );
      if (computedTotal === oldTotal) {
        exactN++;
        continue;
      }
      if (invs.some((v) => v.status === "DRAFT")) {
        draftN++; // /backfill-fix-underbilled-invoices owns DRAFT
        continue;
      }
      if (
        invs.some(
          (v) =>
            (Number(v.paidAmount) || 0) > 0 ||
            v.status === "PAID" ||
            v.status === "PARTIAL_PAID",
        )
      ) {
        paidN++;
        paidDiffSen += computedTotal - oldTotal;
        continue;
      }
      // Every non-cancelled invoice on this DO is SENT/OVERDUE & unpaid →
      // void ALL of them + re-issue ONE correct invoice. One safe path for
      // both the single-invoice case (the 40) and the merged multi-invoice
      // case (e.g. DO-2604-001's two RM 616 invoices).
      // Phase 2 — the reissued invoice carries tax decided NOW (gross
      // basis); the A/R delta therefore compares new GROSS vs old total.
      const reissueRatePct = await readGstRatePct(c.var.DB);
      const reissueTaxSen = Math.max(
        0,
        Math.round((computedTotal * reissueRatePct) / 100),
      );
      const reissueGrossSen = computedTotal + reissueTaxSen;
      const deltaSen = reissueGrossSen - oldTotal;
      const oldNos = invs.map((v) => v.invoiceNo).join(", ");
      rows.push({
        doNo: doRow.doNo,
        customer: doRow.customerName ?? "",
        oldInvoiceNo: oldNos,
        oldStatus:
          invs.length > 1
            ? `${invs.length}x${invs[0].status}`
            : invs[0].status,
        oldTotalSen: oldTotal,
        correctTotalSen: computedTotal,
        deltaSen,
        action: dry ? "would-void-reissue" : "voided-reissued",
      });
      fixedN++;
      fixedDeltaSen += deltaSen;
      if (dry) continue;

      const newId = genInvoiceId();
      const newNo = await nextInvoiceNo(c.var.DB);

      // ---- batch 1: reverse old GL + cancel old + create new + A/R + DO ----
      const b1: D1PreparedStatement[] = [];
      for (const oldInv of invs) {
        const posted = await ledgerHasSource(
          c.var.DB,
          orgId,
          "invoice",
          oldInv.id,
        );
        const reversed = await ledgerHasSource(
          c.var.DB,
          orgId,
          "invoice_void",
          oldInv.id,
        );
        if (posted && !reversed) {
          const { legs } = await buildInvoiceLedgerLegs(
            c.var.DB,
            orgId,
            {
              id: oldInv.id,
              invoiceNo: oldInv.invoiceNo,
              customerId: doRow.customerId,
              subtotalSen:
                Number(oldInv.subtotalSen) ||
                Number(oldInv.totalSen) ||
                0,
            },
            actorUserId,
            true,
            // Phase 2 — reverse EXACTLY what the old invoice posted.
            Number((oldInv as { taxSen?: number }).taxSen) || 0,
          );
          const { statements } = await buildJournalEntryStatements(
            c.var.DB,
            orgId,
            legs,
          );
          b1.push(...statements);
        }
        b1.push(
          c.var.DB.prepare(
            "UPDATE invoices SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
          ).bind(now, oldInv.id),
        );
        // Hide the superseded invoice's GL legs (original + reversal) so the
        // void doesn't linger in the GL.
        b1.push(
          c.var.DB.prepare(
            "UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceType IN ('invoice','invoice_void') AND sourceId = ? AND orgId = ?",
          ).bind(oldInv.id, orgId),
        );
      }
      b1.push(
        c.var.DB.prepare(
          `INSERT INTO invoices (
             id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
             customerId, customerName, customerState, hubId, hubName,
             subtotalSen, taxSen, totalSen, status, invoiceDate, dueDate, paidAmount,
             paymentDate, paymentMethod, notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          newId,
          newNo,
          doRow.id,
          doRow.doNo,
          doRow.salesOrderId || soIds[0] || null,
          doRow.companySOId ?? "",
          doRow.customerId,
          doRow.customerName,
          doRow.customerState,
          doRow.hubId,
          doRow.hubName,
          computedTotal,
          reissueTaxSen,
          reissueGrossSen,
          "SENT",
          invoiceDate,
          dueDate,
          0,
          null,
          "",
          `Reissue of ${oldNos} — under-billed fix (BUG-2026-05-18-004)`,
          now,
          now,
        ),
      );
      for (const it of invItems) {
        b1.push(
          c.var.DB.prepare(
            `INSERT INTO invoice_items (
               id, invoiceId, productCode, productName, sizeLabel, fabricCode,
               quantity, unitPriceSen, totalSen, production_order_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            it.id,
            newId,
            it.productCode,
            it.productName,
            it.sizeLabel,
            it.fabricCode,
            it.quantity,
            it.unitPriceSen,
            it.totalSen,
            // BUG-2026-07-17-001 — carry the DO's per-line link (see InvItem).
            it.productionOrderId,
          ),
        );
      }
      // Net A/R by EXACTLY the delta: original creation added +old; the
      // void path never subtracts; the new INSERT above doesn't touch A/R.
      // So the single correct adjustment is (correct - old).
      // Deliberately do NOT flip the DO to INVOICED — the system keeps
      // auto-invoiced DOs at DELIVERED (the Invoice tab was removed for
      // that reason). Flipping only these crashed the Delivered total and
      // hid them. Invoice/ledger/A/R correctness is independent of
      // DO.status; the loop-top self-heal restores any stragglers.
      b1.push(
        c.var.DB.prepare(
          "UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?",
        ).bind(deltaSen, doRow.customerId),
      );
      await c.var.DB.batch(b1);

      // ---- batch 2: post the NEW invoice's ledger (items now committed) --
      if (!(await ledgerHasSource(c.var.DB, orgId, "invoice", newId))) {
        const { legs } = await buildInvoiceLedgerLegs(
          c.var.DB,
          orgId,
          {
            id: newId,
            invoiceNo: newNo,
            customerId: doRow.customerId,
            subtotalSen: computedTotal,
          },
          actorUserId,
          false,
          // Phase 2 — post the tax decided at re-issue (stored on the row).
          reissueTaxSen,
        );
        const { statements } = await buildJournalEntryStatements(
          c.var.DB,
          orgId,
          legs,
        );
        await c.var.DB.batch(statements);
      }
    } catch (e) {
      errors.push({
        doId: doRow.id,
        doNo: doRow.doNo,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const bucketSum =
    fixedN +
    exactN +
    paidN +
    draftN +
    noInvN +
    noComputeN +
    errors.length;

  return c.json({
    success: true,
    mode: dry ? "dry-run" : "executed",
    deliveredDosScanned: scanned,
    bucketsReconcile: bucketSum === scanned,
    voidReissued: { n: fixedN, netARChangeSen: fixedDeltaSen },
    exactAlready: { n: exactN },
    needsManual: {
      paidOrPartPaid: { n: paidN, diffSen: paidDiffSen },
      draftUseOtherBackfill: { n: draftN },
      noInvoice: { n: noInvN },
      computeReturnedZero: { n: noComputeN },
    },
    rows,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/backfill-normalize-invoiced-to-delivered
//
// One-shot status normaliser (Wei Siang 2026-06-09). The invoice-creation
// path flips a DO to status='INVOICED' (see the createInvoiceForDO statement
// that sets status='INVOICED', overdue='INVOICED'), but the system
// DELIBERATELY keeps auto-invoiced DOs at 'DELIVERED' so they stay in the
// searchable Delivered list — that's why the live self-heal in
// /backfill-void-reissue-underbilled normalises stragglers back, and why
// that backfill's re-issue path deliberately does NOT flip the DO to
// INVOICED. Between manual runs, recently-invoiced DOs sit at INVOICED and
// fall OUT of the Delivered list. This endpoint flips ONLY those back.
//
// STATUS ONLY. Selects DOs at status='INVOICED' that genuinely have a
// non-cancelled invoice (the safe equivalent of "has an invoice number" —
// the invoice number lives on the invoices table, joined by
// deliveryOrderId, not as a column on delivery_orders), and sets each to
// 'DELIVERED'. Invoice / ledger / A-R / overdue / fg_units correctness is
// independent of DO.status (per the comments on the sibling backfills), so
// nothing else is touched and no cascade is triggered. Idempotent: a re-run
// finds nothing at INVOICED → no-op.
//
//   ?dry=1 → preview only, no writes; returns the matching rows
//            (doNo, invoiceNo, status). This IS the audit artifact.
// Temporary migration endpoint; delete once the book is corrected.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-normalize-invoiced-to-delivered", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";
  const now = new Date().toISOString();

  // Column names copied verbatim from the sibling backfills above:
  // delivery_orders uses camelCase (status, doNo) but snake_case timestamps
  // (created_at / updated_at) — see /backfill-fix-underbilled-invoices.
  const dosRes = await c.var.DB.prepare(
    "SELECT * FROM delivery_orders WHERE orgId = ? AND status = 'INVOICED' ORDER BY created_at ASC",
  )
    .bind(orgId)
    .all<DeliveryOrderRow>();
  const dos = dosRes.results ?? [];

  let scanned = 0;
  let normalisedN = 0;
  let noInvN = 0; // INVOICED status but no live invoice — left untouched
  const rows: Array<{ doNo: string; invoiceNo: string; status: string }> = [];
  const errors: { doId: string; doNo: string; error: string }[] = [];

  for (const doRow of dos) {
    scanned++;
    try {
      // The invoice number lives on the invoices table (joined by
      // deliveryOrderId) — there is NO invoiceNo column on delivery_orders.
      // Query shape copied verbatim from /backfill-void-reissue-underbilled.
      const invs =
        (
          await c.var.DB.prepare(
            "SELECT invoiceNo FROM invoices WHERE deliveryOrderId = ? AND status != 'CANCELLED'",
          )
            .bind(doRow.id)
            .all<{ invoiceNo: string }>()
        ).results ?? [];

      // Safe gate: only flip a DO that genuinely has a live invoice. An
      // INVOICED-status DO with zero non-cancelled invoices is an anomaly
      // this status-only normaliser deliberately does NOT touch.
      if (invs.length === 0) {
        noInvN++;
        continue;
      }

      rows.push({
        doNo: doRow.doNo,
        invoiceNo: invs.map((v) => v.invoiceNo).join(", "),
        status: doRow.status,
      });
      if (dry) continue;

      // STATUS ONLY — no cascade, no invoice/ledger/A-R/overdue/fg_units.
      // UPDATE copied verbatim from the sibling backfills' self-heal.
      await c.var.DB.prepare(
        "UPDATE delivery_orders SET status = 'DELIVERED', updated_at = ? WHERE id = ?",
      )
        .bind(now, doRow.id)
        .run();
      normalisedN++;
    } catch (e) {
      errors.push({
        doId: doRow.id,
        doNo: doRow.doNo,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return c.json({
    success: true,
    mode: dry ? "dry-run" : "executed",
    dry,
    scanned,
    deliveredDosScanned: scanned,
    normalisedToDelivered: { n: dry ? 0 : normalisedN, wouldNormalise: rows.length },
    skippedNoLiveInvoice: { n: noInvN },
    rows,
    list: rows,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/backfill-dedupe-delivered
//
// One-shot cleanup (Wei Siang 2026-05-16): a production order can only be
// delivered once. Where the SAME production order's items sit on >1
// non-cancelled DO (the historical duplicates — root cause now blocked at
// POST), keep the items on the EARLIEST DO and DELETE the duplicate
// delivery_order_items rows from the later DO(s). Deliberately does NOT
// touch cost_ledger / fg_batches / fg_units / invoices — per operator,
// the cost step isn't in use yet; this only removes the duplicate
// delivery lines so Delivered value (derived from the remaining items)
// recomputes correctly and reconciles.
//
// Only the duplicate PO's lines are removed — a mixed DO keeps its other
// (legitimate) orders' lines. Idempotent (re-run: each PO on 1 DO → 0).
//   ?dry=1 → preview only, no writes.
// Temporary migration endpoint; delete once the book is clean.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-dedupe-delivered", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";

  const [doRes, itemRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT id, doNo, deliveredAt, dispatchedAt, created_at FROM delivery_orders WHERE orgId = ? AND status != 'CANCELLED'",
    )
      .bind(orgId)
      .all<{
        id: string;
        doNo: string;
        deliveredAt: string | null;
        dispatchedAt: string | null;
        created_at: string | null;
      }>(),
    c.var.DB.prepare(
      "SELECT id, deliveryOrderId, productionOrderId FROM delivery_order_items WHERE orgId = ? AND productionOrderId IS NOT NULL AND productionOrderId != ''",
    )
      .bind(orgId)
      .all<{
        id: string;
        deliveryOrderId: string;
        productionOrderId: string;
      }>(),
  ]);

  const doDate = new Map<string, string>();
  const doNo = new Map<string, string>();
  for (const d of doRes.results ?? []) {
    doDate.set(d.id, d.deliveredAt || d.dispatchedAt || d.created_at || "");
    doNo.set(d.id, d.doNo);
  }
  const allItems = (itemRes.results ?? []).filter((i) =>
    doDate.has(i.deliveryOrderId),
  );

  // Total live item count per DO (to flag any DO emptied by the cleanup).
  const doItemCount = new Map<string, number>();
  for (const it of allItems)
    doItemCount.set(
      it.deliveryOrderId,
      (doItemCount.get(it.deliveryOrderId) ?? 0) + 1,
    );

  // Group item rows by production order.
  const byPO = new Map<
    string,
    { itemId: string; doId: string }[]
  >();
  for (const it of allItems) {
    const arr = byPO.get(it.productionOrderId) ?? [];
    arr.push({ itemId: it.id, doId: it.deliveryOrderId });
    byPO.set(it.productionOrderId, arr);
  }

  const deleteItemIds: string[] = [];
  const dupDOs = new Set<string>();
  const keeperDOs = new Set<string>();
  let duplicatedPOs = 0;
  const removedPerDO = new Map<string, number>();

  for (const [, rows] of byPO) {
    const dosForPO = new Set(rows.map((r) => r.doId));
    if (dosForPO.size < 2) continue; // PO on a single DO — fine
    duplicatedPOs++;
    // Keeper = earliest DO (by date, then id) carrying this PO.
    const ordered = [...dosForPO].sort((a, b) => {
      const da = doDate.get(a) ?? "";
      const db = doDate.get(b) ?? "";
      if (da !== db) return da < db ? -1 : 1;
      return a < b ? -1 : 1;
    });
    const keeper = ordered[0];
    keeperDOs.add(keeper);
    for (const r of rows) {
      if (r.doId === keeper) continue;
      deleteItemIds.push(r.itemId);
      dupDOs.add(r.doId);
      removedPerDO.set(r.doId, (removedPerDO.get(r.doId) ?? 0) + 1);
    }
  }

  // Any DO that loses ALL its items? (Forensic said none — flag if so.)
  const emptiedDOs: string[] = [];
  for (const [doId, removed] of removedPerDO) {
    if (removed >= (doItemCount.get(doId) ?? 0))
      emptiedDOs.push(doNo.get(doId) ?? doId);
  }

  if (!dry && deleteItemIds.length > 0) {
    for (let i = 0; i < deleteItemIds.length; i += 100) {
      const chunk = deleteItemIds.slice(i, i + 100);
      const ph = chunk.map(() => "?").join(",");
      await c.var.DB.prepare(
        `DELETE FROM delivery_order_items WHERE id IN (${ph})`,
      )
        .bind(...chunk)
        .run();
    }
  }

  return c.json({
    success: true,
    mode: dry ? "dry-run" : "executed",
    duplicatedProductionOrders: duplicatedPOs,
    duplicateItemRowsRemoved: deleteItemIds.length,
    duplicateDOsTouched: dupDOs.size,
    keeperDOs: keeperDOs.size,
    dosEmptiedByCleanup: emptiedDOs,
  });
});

// POST /api/delivery-orders — create
app.post("/", async (c) => {
  // RBAC gate — only roles with delivery-orders:create may insert a new DO.
  const denied = await requirePermission(c, "delivery-orders", "create");
  if (denied) return denied;

  try {
    const body = await c.req.json();
    // The whole former inline body lives in createDeliveryOrderForPOs —
    // same guards, same error shapes, same audit emit. Map 1:1 back onto
    // the original HTTP responses.
    const result = await createDeliveryOrderForPOs(c, body);
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ success: true, data: result.created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/delivery-orders] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating delivery order" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/packing-list-first — Packing-List-first dispatch.
//
// The operator multi-selects ready production orders on Pending Delivery
// (possibly spanning customers and hubs), fills the 3PL provider / vehicle /
// driver / delivery date ONCE, and this endpoint:
//   1. Groups the POs by (customerId, hubId) — one DO per customer per hub.
//   2. PRE-VALIDATES everything (CO guard, once-only-delivery, customer
//      resolution, credit limit summed ACROSS each customer's groups)
//      BEFORE creating anything — any failure creates NOTHING.
//   3. Creates one DRAFT DO per group SEQUENTIALLY through the same
//      createDeliveryOrderForPOs core as POST / (genNextDoNo is read-MAX+1,
//      parallel creation would collide on doNo).
//   4. Creates ONE packing list carrying every new DO id via the same
//      createPackingListCore as packing-lists POST /.
// If a creation fails mid-way despite pre-validation (race), every DO this
// request created is deleted again (DRAFT DOs have no inventory or cost
// effects) and the SO hookkaDeliveryOrder stamps are restored — no orphans.
//
// body: { productionOrderIds: string[], providerId?, vehicleId?, driverId?,
//         deliveryDate?, remarks?, preview? }
// preview: true → run steps 1-2 only and return the grouping (the FE dialog
// shows it), so the preview can never drift from what creation would do.
// ---------------------------------------------------------------------------
app.post("/packing-list-first", async (c) => {
  // Same RBAC as DO create (packing-lists POST / uses the same pair too).
  const denied = await requirePermission(c, "delivery-orders", "create");
  if (denied) return denied;
  // Org scope for the packing-list insert — resolved OUTSIDE the try so an
  // unresolved org propagates exactly like packing-lists POST / does.
  const orgId = getOrgId(c);

  try {
    const body = await c.req.json<{
      productionOrderIds?: unknown;
      providerId?: string | null;
      vehicleId?: string | null;
      driverId?: string | null;
      deliveryDate?: string | null;
      remarks?: string | null;
      preview?: boolean;
    }>();
    const productionOrderIds = Array.isArray(body.productionOrderIds)
      ? [
          ...new Set(
            (body.productionOrderIds as unknown[]).filter(
              (x): x is string => typeof x === "string" && x.length > 0,
            ),
          ),
        ]
      : [];
    if (productionOrderIds.length === 0) {
      return c.json(
        { success: false, error: "Select at least one production order." },
        400,
      );
    }

    // ---- Step 1: load the POs --------------------------------------------
    type PlFirstPoRow = {
      id: string;
      poNo: string | null;
      salesOrderId: string | null;
      consignmentOrderId: string | null;
      serviceOrderId: string | null;
      productCode: string | null;
      quantity: number | null;
      customerName: string | null;
      customerState: string | null;
    };
    const placeholders = productionOrderIds.map(() => "?").join(",");
    const poRes = await c.var.DB.prepare(
      `SELECT id, poNo, salesOrderId, consignmentOrderId, serviceOrderId,
              productCode, quantity, customerName, customerState
         FROM production_orders WHERE id IN (${placeholders})`,
    )
      .bind(...productionOrderIds)
      .all<PlFirstPoRow>();
    const poRows = poRes.results ?? [];
    const poById = new Map(poRows.map((r) => [r.id, r]));
    const missingPoIds = productionOrderIds.filter((id) => !poById.has(id));
    if (missingPoIds.length > 0) {
      return c.json(
        {
          success: false,
          error: `Some selected production orders no longer exist (${missingPoIds.length} of ${productionOrderIds.length}). Refresh and re-select.`,
        },
        400,
      );
    }

    // CO POs route via Consignment Notes — same guard (and wording) as the
    // DO-create core.
    const coPoNos = poRows.filter((r) => r.consignmentOrderId).map((r) => r.poNo);
    if (coPoNos.length > 0) {
      return c.json(
        {
          success: false,
          error: `Consignment-Order POs cannot be added to a Delivery Order. Use a Consignment Note instead. Offending POs: ${coPoNos.join(", ")}`,
        },
        400,
      );
    }

    // Once-only-delivery pre-check across the WHOLE selection. The per-group
    // core re-checks at create time; this catches it before anything exists.
    const dupLinkRes = await c.var.DB.prepare(
      `SELECT DISTINCT di.productionOrderId AS poId, d.doNo AS doNo, d.status AS status
         FROM delivery_order_items di
         JOIN delivery_orders d ON d.id = di.deliveryOrderId
        WHERE di.productionOrderId IN (${placeholders})
          AND d.status != 'CANCELLED'`,
    )
      .bind(...productionOrderIds)
      .all<{ poId: string; doNo: string; status: string }>();
    const alreadyLinked = dupLinkRes.results ?? [];
    if (alreadyLinked.length > 0) {
      const lines = alreadyLinked
        .map(
          (r) => `${poById.get(r.poId)?.poNo ?? r.poId} → ${r.doNo} (${r.status})`,
        )
        .join(", ");
      return c.json(
        {
          success: false,
          error: `These production orders are already on a delivery order (a PO can only be delivered once): ${lines}. Remove them from the selection.`,
        },
        409,
      );
    }

    // ---- Step 2: resolve each PO's (customer, hub) and group --------------
    const soIds = [
      ...new Set(poRows.map((r) => r.salesOrderId ?? "").filter((x) => x !== "")),
    ];
    type SoMetaRow = {
      id: string;
      hubId: string | null;
      hubName: string | null;
      customerId: string | null;
      customerName: string | null;
    };
    const soMetaById = new Map<string, SoMetaRow>();
    if (soIds.length > 0) {
      const ph = soIds.map(() => "?").join(",");
      const soMetaRes = await c.var.DB.prepare(
        `SELECT id, hubId, hubName, customerId, customerName
           FROM sales_orders WHERE id IN (${ph})`,
      )
        .bind(...soIds)
        .all<SoMetaRow>();
      for (const r of soMetaRes.results ?? []) soMetaById.set(r.id, r);
    }

    // Service POs have no parent SO — their destination lives on the service
    // order (stamped at creation; legacy rows live-derive from the source
    // order inside the helper). Same hub source the DO-create core uses, so
    // grouping and the created DOs can't disagree.
    const svcIdsForHub = [
      ...new Set(
        poRows.map((r) => r.serviceOrderId ?? "").filter((x) => x !== ""),
      ),
    ];
    const svcHubMeta = await loadServiceOrderHubMeta(c.var.DB, svcIdsForHub);

    // Customer fallback by PO.customerName — the same chain the DO-create
    // core uses for POs whose parent SO carries no customer.
    const nameToCustomerId = new Map<string, string>();
    const unresolvedNames = new Set<string>();
    for (const po of poRows) {
      const so = po.salesOrderId ? soMetaById.get(po.salesOrderId) : undefined;
      if (!so?.customerId && po.customerName) unresolvedNames.add(po.customerName);
    }
    for (const name of unresolvedNames) {
      const cr = await c.var.DB.prepare(
        `SELECT id FROM customers WHERE name = ? LIMIT 1`,
      )
        .bind(name)
        .first<{ id: string }>();
      if (cr?.id) nameToCustomerId.set(name, cr.id);
    }

    const groupInputs: { poId: string; customerId: string; hubId: string }[] = [];
    for (const poId of productionOrderIds) {
      const po = poById.get(poId);
      if (!po) continue; // unreachable — missing ids rejected above
      const so = po.salesOrderId ? soMetaById.get(po.salesOrderId) : undefined;
      const svc = po.serviceOrderId
        ? svcHubMeta.get(po.serviceOrderId)
        : undefined;
      const customerId =
        so?.customerId ??
        svc?.customerId ??
        (po.customerName ? nameToCustomerId.get(po.customerName) : undefined);
      if (!customerId) {
        return c.json(
          {
            success: false,
            error: `Cannot determine the customer for production order ${po.poNo ?? poId}. Link it to a sales order or set its customer first.`,
          },
          400,
        );
      }
      groupInputs.push({
        poId,
        customerId,
        hubId: so?.hubId ?? svc?.hubId ?? "",
      });
    }
    const groups = groupPosByCustomerHub(groupInputs);

    // ---- Step 3: customers (existence + credit inputs) --------------------
    const customerIds = [...new Set(groups.map((g) => g.customerId))];
    const cph = customerIds.map(() => "?").join(",");
    const custRes = await c.var.DB.prepare(
      `SELECT id, name, creditLimitSen, outstandingSen FROM customers WHERE id IN (${cph})`,
    )
      .bind(...customerIds)
      .all<{
        id: string;
        name: string;
        creditLimitSen: number;
        outstandingSen: number;
      }>();
    const customerById = new Map((custRes.results ?? []).map((r) => [r.id, r]));
    for (const g of groups) {
      if (!customerById.has(g.customerId)) {
        const firstPo = poById.get(g.poIds[0]);
        return c.json(
          {
            success: false,
            error: `Customer not found for production order ${firstPo?.poNo ?? g.poIds[0]}.`,
          },
          400,
        );
      }
    }

    // ---- Step 4: credit pre-validation per customer ACROSS groups ---------
    // The per-DO gate inside the core only sees one group at a time and
    // outstandingSen doesn't move at DO create, so N same-customer groups
    // would each pass individually even when their SUM blows the limit.
    // projectCreditFailure (pl-first-grouping.ts) checks the sum up front.
    const creditGroups = groups.map((g) => {
      const soSet = new Set<string>();
      const items: { productCode: string; quantity: number }[] = [];
      for (const poId of g.poIds) {
        const po = poById.get(poId);
        if (!po) continue;
        if (po.salesOrderId) soSet.add(po.salesOrderId);
        items.push({
          productCode: po.productCode ?? "",
          quantity: Number(po.quantity) || 0,
        });
      }
      return { customerId: g.customerId, soIds: [...soSet], items };
    });
    let priceRows: {
      salesOrderId: string;
      productCode: string | null;
      unitPriceSen: number;
    }[] = [];
    if (soIds.length > 0) {
      const ph = soIds.map(() => "?").join(",");
      const priceRes = await c.var.DB.prepare(
        `SELECT salesOrderId, productCode, unitPriceSen
           FROM sales_order_items
          WHERE salesOrderId IN (${ph})`,
      )
        .bind(...soIds)
        .all<{
          salesOrderId: string;
          productCode: string | null;
          unitPriceSen: number;
        }>();
      priceRows = priceRes.results ?? [];
    }
    const creditFail = projectCreditFailure(
      creditGroups,
      priceRows,
      [...customerById.values()].map((r) => ({
        id: r.id,
        creditLimitSen: Number(r.creditLimitSen) || 0,
        outstandingSen: Number(r.outstandingSen) || 0,
      })),
    );
    if (creditFail) {
      const failName =
        customerById.get(creditFail.customerId)?.name ?? creditFail.customerId;
      return c.json(
        {
          success: false,
          error: `Credit limit exceeded for ${failName}. The selected orders together exceed the remaining credit — nothing was created.`,
          code: "CREDIT_LIMIT_EXCEEDED",
          details: {
            customerId: creditFail.customerId,
            customerName: failName,
            limit: creditFail.limitSen,
            outstanding: creditFail.outstandingSen,
            doTotal: creditFail.doTotalSen,
            projected: creditFail.projectedSen,
          },
        },
        409,
      );
    }

    // ---- Step 5: packing_lists storage pre-flight -------------------------
    // Fail BEFORE creating DOs when the table is missing, instead of
    // creating and immediately rolling back. Same 503 packing-lists POST /
    // returns for this condition.
    try {
      await c.var.DB.prepare("SELECT id FROM packing_lists LIMIT 1").first();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/relation .*packing_lists.* does not exist|no such table/i.test(msg)) {
        return c.json(
          {
            success: false,
            error: "Packing list storage is not set up yet. Apply migration 0139.",
          },
          503,
        );
      }
      throw e;
    }

    // Group display metadata for the preview payload + error labels.
    const groupMeta = groups.map((g) => {
      const firstPo = poById.get(g.poIds[0]);
      const so = firstPo?.salesOrderId
        ? soMetaById.get(firstPo.salesOrderId)
        : undefined;
      const cust = customerById.get(g.customerId);
      let unitCount = 0;
      for (const poId of g.poIds) {
        unitCount += Number(poById.get(poId)?.quantity) || 0;
      }
      return {
        customerId: g.customerId,
        customerName: cust?.name ?? firstPo?.customerName ?? g.customerId,
        hubId: g.hubId,
        hubName: g.hubId ? so?.hubName ?? "" : "",
        customerState: firstPo?.customerState ?? "",
        poCount: g.poIds.length,
        unitCount,
        poNos: g.poIds.map((id) => poById.get(id)?.poNo ?? id),
      };
    });

    if (body.preview === true) {
      return c.json({
        success: true,
        preview: true,
        doCount: groups.length,
        groups: groupMeta,
      });
    }

    // ---- Step 6: snapshot SO stamps for surgical rollback ------------------
    // Single-SO DO creation overwrites sales_orders.hookkaDeliveryOrder; if
    // we have to roll back we restore exactly what was there before.
    const soStampPrev = new Map<string, string | null>();
    if (soIds.length > 0) {
      const ph = soIds.map(() => "?").join(",");
      const stampRes = await c.var.DB.prepare(
        `SELECT id, hookkaDeliveryOrder FROM sales_orders WHERE id IN (${ph})`,
      )
        .bind(...soIds)
        .all<{ id: string; hookkaDeliveryOrder: string | null }>();
      for (const r of stampRes.results ?? []) {
        soStampPrev.set(r.id, r.hookkaDeliveryOrder ?? null);
      }
    }

    // ---- Step 7: create one DRAFT DO per group, SEQUENTIALLY ---------------
    const createdDos: {
      id: string;
      doNo: string;
      salesOrderId: string | null;
    }[] = [];
    const rollbackCreatedDos = async () => {
      for (const d of [...createdDos].reverse()) {
        try {
          // Mirrors DELETE /:id for a DRAFT DO (items + header), plus the
          // SO-stamp restore the generic delete doesn't need.
          await c.var.DB.batch([
            c.var.DB.prepare(
              "DELETE FROM delivery_order_items WHERE deliveryOrderId = ?",
            ).bind(d.id),
            c.var.DB.prepare("DELETE FROM delivery_orders WHERE id = ?").bind(
              d.id,
            ),
          ]);
          if (d.salesOrderId) {
            // Restore the SO's previous DO stamp only if WE set it (it still
            // carries our doNo) — never clobber a concurrent change.
            await c.var.DB.prepare(
              "UPDATE sales_orders SET hookkaDeliveryOrder = ? WHERE id = ? AND hookkaDeliveryOrder = ?",
            )
              .bind(
                soStampPrev.get(d.salesOrderId) ?? null,
                d.salesOrderId,
                d.doNo,
              )
              .run();
          }
          await emitAudit(c, {
            resource: "delivery-orders",
            resourceId: d.id,
            action: "delete",
            before: {
              status: "DRAFT",
              doNo: d.doNo,
              reason: "packing-list-first rollback",
            },
          });
        } catch (e) {
          // Best effort — log loudly. A leftover DRAFT DO has no inventory
          // or cost effects and can be deleted from Pending Dispatch.
          console.error(
            "[POST /api/delivery-orders/packing-list-first] rollback failed for DO",
            d.id,
            e,
          );
        }
      }
    };

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const meta = groupMeta[gi];
      let result: DoCreateOutcome;
      try {
        result = await createDeliveryOrderForPOs(
          c,
          {
            productionOrderIds: g.poIds,
            providerId: body.providerId ?? null,
            vehicleId: body.vehicleId ?? null,
            driverId: body.driverId ?? null,
            // Pin the group's customer (already validated above). Without
            // this, a multi-SO group would make the core fall back to a
            // PO.customerName lookup, which can fail on rows whose name
            // column is blank even though the SO knows the customer.
            customerId: g.customerId,
            // One DO = one customer + one hub = one drop.
            dropPoints: 1,
            // Pin the group's hub so the delivery address resolves to THAT
            // hub even when the group spans several SOs (the core only
            // auto-resolves the hub for single-SO DOs).
            hubId: g.hubId || undefined,
            deliveryDate:
              typeof body.deliveryDate === "string" ? body.deliveryDate : "",
            remarks: typeof body.remarks === "string" ? body.remarks : "",
          },
          (info) => createdDos.push(info),
        );
      } catch (err) {
        await rollbackCreatedDos();
        throw err;
      }
      if (!result.ok) {
        // Pre-validation should have caught everything; landing here means a
        // concurrent change (race). Undo our partial work, then surface the
        // core's error verbatim with the failing group named.
        await rollbackCreatedDos();
        const label = `${meta.customerName}${meta.hubName ? ` / ${meta.hubName}` : ""}`;
        const origError =
          typeof result.body.error === "string"
            ? result.body.error
            : "Failed to create delivery order.";
        return c.json(
          {
            ...result.body,
            error: `Could not create the delivery order for ${label}: ${origError} Nothing was created.`,
          },
          result.status,
        );
      }
    }

    // ---- Step 8: one packing list carrying every new DO --------------------
    const plResult = await createPackingListCore(c, orgId, {
      doIds: createdDos.map((d) => d.id),
      remarks: typeof body.remarks === "string" ? body.remarks : undefined,
    });
    if (!plResult.ok) {
      await rollbackCreatedDos();
      return c.json(plResult.body, plResult.status);
    }

    return c.json(
      {
        success: true,
        data: {
          packingList: plResult.data,
          deliveryOrders: createdDos.map((d) => ({ id: d.id, doNo: d.doNo })),
        },
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[POST /api/delivery-orders/packing-list-first] failed:",
      msg,
      err,
    );
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json(
      { success: false, error: msg || "Internal error creating packing list" },
      500,
    );
  }
});

app.get("/:id/print-extras", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const data = await computeDoPrintExtras(c.var.DB, id);
  if (!data) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  return c.json({ success: true, data });
});

app.post("/:id/notify-customer", async (c) => {
  // Same RBAC gate as the status transition that triggers it.
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: string;
    pdfBase64?: string;
    pdfFilename?: string;
    itemsBreakdown?: string;
    customerPOIds?: string[];
  };
  return queueDoCustomerNotice(c, id, body);
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/:id/resend-notice — operator FORCE re-send of the
// customer DO/Invoice email (2026-06-24).
//
// Why: many DOs were delivered/invoiced BEFORE the backend choke-point trigger
// shipped, so their deliveredEmailAt / dispatchEmailAt stamps are null AND the
// customer was never emailed (Houzs Century alone has 128). The normal notice
// path is one-shot by design (atomic claim on the stamp), so once a stamp is
// set — or the operator simply wants to re-send — there is no way to re-fire.
// This endpoint clears the relevant stamp back to NULL so the atomic claim
// inside queueDoCustomerNotice can win again, then calls that SAME helper
// (recipient chain + server-rendered PDF fallback + no-recipient silent skip
// + the atomic re-claim). There is deliberately NO second send path: the only
// delta vs the auto-notice is that we release the idempotency stamp first.
//
// Body: { kind: "DELIVERED" | "DISPATCHED" }.
//   DELIVERED clears deliveredEmailAt (the invoice notice);
//   DISPATCHED clears dispatchEmailAt (the dispatch notice).
//
// The response surfaces what actually happened so the FE can toast correctly:
//   { success:true, sent:true, to }                 — queued to the outbox
//   { success:true, sent:false, skipped:true, reason } — no email / no invoice
//   { success:false, error }                         — hard failure (4xx/5xx)
//
// ⚠️ Deliberately PER-DO only. An auto-blast of all 128 backlog DOs at once is
// spam + would overwhelm the customer; the operator re-sends the ones they
// actually need from the DO detail page / list row.
// ---------------------------------------------------------------------------
app.post("/:id/resend-notice", async (c) => {
  // Admin gate — same delivery-orders:update permission every DO mutation uses
  // (notify-customer, status transitions, edit). A force re-send is a mutation
  // of the email-sent stamp, so it belongs behind the same gate.
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: string;
    // Optional client-rendered PDF — when the operator re-sends after an edit,
    // the page renders the SAME unified PDF it downloads and passes it here so
    // the customer's re-sent email carries the exact document, not the
    // server-side fallback. Omitted → queueDoCustomerNotice renders its own.
    pdfBase64?: string;
    pdfFilename?: string;
  };
  const kind =
    body.kind === "DISPATCHED" || body.kind === "DELIVERED" ? body.kind : null;
  if (!kind) {
    return c.json(
      { success: false, error: 'kind must be "DISPATCHED" or "DELIVERED"' },
      400,
    );
  }

  try {
    // Guarantee the stamp columns exist before we clear one (a DO delivered
    // before the notify feature shipped may predate the column on some envs).
    await ensureNotifyEmailColumns(c.var.DB);

    const exists = await c.var.DB.prepare(
      "SELECT id FROM delivery_orders WHERE id = ?",
    )
      .bind(id)
      .first<{ id: string }>();
    if (!exists) {
      return c.json(
        { success: false, error: "Delivery order not found" },
        404,
      );
    }

    // Release the idempotency stamp so queueDoCustomerNotice's atomic claim
    // (UPDATE ... WHERE col IS NULL) can win and re-fire. The column name is
    // one of two fixed literals — never user input.
    const stampCol =
      kind === "DISPATCHED" ? "dispatchEmailAt" : "deliveredEmailAt";
    await c.var.DB.prepare(
      `UPDATE delivery_orders SET ${stampCol} = NULL WHERE id = ?`,
    )
      .bind(id)
      .run();

    // Re-fire through the SAME helper the auto-notice + FE trigger use. It
    // owns the recipient chain, the server-rendered invoice-PDF fallback, the
    // no-recipient silent skip, and re-claims the stamp it just had cleared.
    // Forward any client-rendered PDF so an edited invoice re-sends the exact
    // document the operator sees (else the helper renders its own fallback).
    const res = await queueDoCustomerNotice(c, id, {
      kind,
      pdfBase64: body.pdfBase64,
      pdfFilename: body.pdfFilename,
    });
    const j = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      queued?: boolean;
      skipped?: boolean;
      reason?: string;
      to?: string;
      error?: string;
    };

    if (!res.ok || j?.success === false) {
      return c.json(
        { success: false, error: j?.error || "Failed to re-send notice" },
        // Mirror the helper's status (409 status-guard, 404, 500, ...).
        (res.status === 200 ? 500 : res.status) as 400 | 404 | 409 | 500,
      );
    }
    if (j?.skipped) {
      // No recipient / no invoice / nothing to send — re-stamp the cleared
      // column is NOT needed (queueDoCustomerNotice only claims when it sends),
      // so the DO is simply left un-emailed and the FE warns the operator.
      return c.json({
        success: true,
        sent: false,
        skipped: true,
        reason: j?.reason || "skipped",
      });
    }
    return c.json({ success: true, sent: true, to: j?.to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[POST /api/delivery-orders/${id}/resend-notice] failed:`,
      msg,
    );
    return c.json(
      { success: false, error: msg || "Failed to re-send notice" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/:id/resolve-incomplete — clear the
// "delivered with issues" flag and create the invoice that was withheld.
//
// A DO delivered "with issues" (2nd QR scan, or the office equivalent) sits at
// DELIVERED with delivery_incomplete = 1 and NO invoice. Once the operator has
// sorted the paperwork they call this to (a) clear the flag and (b) run the
// EXACT same buildDoDeliveredSoAndInvoice cascade a complete delivery would
// have — combined invoice across every linked SO, SO→INVOICED, DO→INVOICED,
// ledger post, A/R — with the same invoice-number-collision retry as the PUT
// path. Then it best-effort queues the SAME customer invoice notice. Nothing
// is reimplemented; the only delta vs a normal delivery is the timing.
// ---------------------------------------------------------------------------
app.post("/:id/resolve-incomplete", async (c) => {
  // Same gate as the delivery transition that set the flag.
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  try {
    await ensureDeliveryIncompleteColumn(c.var.DB);
    const existing = await c.var.DB.prepare(
      "SELECT * FROM delivery_orders WHERE id = ?",
    )
      .bind(id)
      .first<DeliveryOrderRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Delivery order not found" },
        404,
      );
    }
    if (Number(existing.delivery_incomplete) !== 1) {
      return c.json(
        {
          success: false,
          error: "This delivery is not marked as delivered-with-issues.",
        },
        409,
      );
    }
    // The flag only ever rides a DELIVERED DO; guard anyway so a stray state
    // can't slip an INVOICED/CANCELLED row through the cascade.
    if (existing.status !== "DELIVERED") {
      return c.json(
        {
          success: false,
          error: `Cannot resolve: delivery order is "${existing.status}", expected DELIVERED.`,
        },
        409,
      );
    }

    const now = new Date().toISOString();
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get(
        "userId",
      ) ?? null;

    // Clear the flag FIRST in the batch; the cascade's DO→INVOICED update (if
    // any) lands after and leaves delivery_incomplete = 0 untouched.
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        "UPDATE delivery_orders SET delivery_incomplete = 0, updated_at = ? WHERE id = ?",
      ).bind(now, id),
    ];

    // incomplete = false → create the withheld invoice + bill the SOs.
    const dc = await buildDoDeliveredSoAndInvoice(
      c.var.DB,
      existing,
      now,
      orgId,
      actorUserId,
      false,
    );
    let invoiceStmtIdx = -1;
    let rebuildInvoiceInsert: ((no: string) => D1PreparedStatement) | null =
      null;
    if (dc.statements.length > 0) {
      const base = statements.length;
      statements.push(...dc.statements);
      if (dc.invoiceStmtIdx >= 0 && dc.rebuildInvoiceInsert) {
        invoiceStmtIdx = base + dc.invoiceStmtIdx;
        rebuildInvoiceInsert = dc.rebuildInvoiceInsert;
      }
    }

    // Same invoice-number-collision retry as the live PUT path.
    {
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await c.var.DB.batch(statements);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isInvoiceDup =
            /ux_invoices_invoice_no|invoices_invoice_no|duplicate key/i.test(
              msg,
            );
          if (
            isInvoiceDup &&
            rebuildInvoiceInsert &&
            invoiceStmtIdx >= 0 &&
            attempt < 5
          ) {
            attempt++;
            statements[invoiceStmtIdx] = rebuildInvoiceInsert(
              await nextInvoiceNo(c.var.DB),
            );
            continue;
          }
          throw e;
        }
      }
    }

    // Best-effort customer invoice notice — same one the complete path sends.
    // Idempotent (deliveredEmailAt claim) and never blocks the resolve.
    if (dc.createdInvoice) {
      try {
        const noticeRes = await queueDoCustomerNotice(c, id, {
          kind: "DELIVERED",
        });
        await noticeRes.json().catch(() => undefined);
      } catch (noticeErr) {
        console.warn(
          `[resolve-incomplete] ${existing.doNo}: invoice notice failed:`,
          noticeErr instanceof Error ? noticeErr.message : noticeErr,
        );
      }
    }

    await emitAudit(c, {
      resource: "delivery-orders",
      resourceId: id,
      action: "update",
      before: { status: "DELIVERED", deliveryIncomplete: true },
      after: {
        status: dc.createdInvoice ? "INVOICED" : "DELIVERED",
        deliveryIncomplete: false,
      },
    });

    const updated = await fetchOrderWithItems(c.var.DB, id);
    return c.json({
      success: true,
      data: updated,
      createdInvoice: dc.createdInvoice,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/delivery-orders/:id/resolve-incomplete] failed:", msg);
    return c.json(
      { success: false, error: msg || "Failed to resolve delivery" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /api/delivery-orders/:id/qr-token — authed QR endpoint for the driver
// scan flow. Lazily mints the DO's unguessable qrtoken (migration 0167,
// runtime self-applied) on first use and returns the public scan URL.
// Scanning the QR with a normal phone camera opens /d/<token> — no login —
// where the crew/driver can Mark Dispatched / Mark Delivered through the
// SAME transition path as the office buttons (routes/public-do-qr.ts).
// ---------------------------------------------------------------------------
app.get("/:id/qr-token", async (c) => {
  // Read-level gate — the QR is printed by whoever can view/print the DO
  // (same gate as /print-extras above). Minting the token is an idempotent
  // internal detail of "show me the QR".
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const exists = await c.var.DB.prepare(
    "SELECT id, doNo FROM delivery_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; doNo: string }>();
  if (!exists) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  const token = await getOrCreateQrToken(c.var.DB, "delivery_orders", id);
  if (!token) {
    return c.json({ success: false, error: "Failed to generate QR token" }, 500);
  }
  return c.json({
    success: true,
    data: {
      token,
      url: qrScanUrl(new URL(c.req.url).origin, token),
      doNo: exists.doNo,
    },
  });
});

// GET /api/delivery-orders/:id — single + downstream documents
//
// Reverse link (owner 2026-08-01): delivery_returns.delivery_order_id points
// AT the DO, so a return was only discoverable from the Delivery Returns list.
// The DO page never mentioned returns at all — a delivery could have goods
// coming back (stock reversed, a credit note or a repair service order raised
// off it) and the DO it came from showed a clean DELIVERED/INVOICED document.
// idx_delivery_returns_do already exists (0207), so this is one index seek.
// Same `Promise.all` + `linkedX` shape as sales-orders.ts GET /:id.
app.get("/:id", async (c) => {
  // RBAC gate — single-record reads also require delivery-orders:read.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const id = c.req.param("id");
  const [order, lockReason, returnsRes] = await Promise.all([
    fetchOrderWithItems(c.var.DB, id),
    // Lock status (Invoice exists?) — surfaced to the DO detail page so the
    // edit form can disable + render a "locked because Invoice X exists" banner.
    checkDeliveryOrderLocked(c.var.DB, id),
    // return_no / return_type have NO column-rename-map.json entry, so the
    // physical snake_case names are spelled out with quoted camelCase aliases
    // (same convention as delivery-returns.ts HEADER_COLS). Best-effort: the
    // table is runtime-created by the delivery-returns route, so a site that
    // has never opened that module simply reports no returns.
    c.var.DB.prepare(
      `SELECT id, return_no AS "returnNo", status,
              return_type AS "returnType", reason,
              returned_at AS "returnedAt", created_at AS "createdAt"
         FROM delivery_returns
        WHERE delivery_order_id = ?
        ORDER BY created_at DESC`,
    )
      .bind(id)
      .all<{
        id: string;
        returnNo: string | null;
        status: string | null;
        returnType: string | null;
        reason: string | null;
        returnedAt: string | null;
        createdAt: string | null;
      }>()
      .catch(() => ({ results: [] })),
  ]);
  if (!order) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  const linkedReturns = (returnsRes.results ?? []).map((r) => ({
    id: r.id,
    returnNo: r.returnNo ?? "",
    status: r.status ?? "",
    returnType: r.returnType ?? "",
    reason: r.reason ?? "",
    returnedAt: r.returnedAt ?? null,
    createdAt: r.createdAt ?? null,
  }));
  return c.json({ success: true, data: order, lockReason, linkedReturns });
});

// PUT /api/delivery-orders/:id — update (supports status transitions, PoD,
// driver/lorry changes, and full item replacement).
app.put("/:id", async (c) => {
  // RBAC gate — every mutation path on the DO row goes through PUT, including
  // status transitions (load / dispatch / deliver / invoice), driver swaps,
  // and POD writes. Single delivery-orders:update gate covers all of them.
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
  }
  return applyDeliveryOrderUpdate(c, id, body);
});

// DELETE /api/delivery-orders/:id — only DRAFT rows are deletable.
app.delete("/:id", async (c) => {
  // RBAC gate — DO deletion is destructive, gated by delivery-orders:delete.
  const denied = await requirePermission(c, "delivery-orders", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id, status FROM delivery_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: `Only DRAFT delivery orders can be deleted (current: ${existing.status})`,
      },
      400,
    );
  }
  await c.var.DB.batch([
    c.var.DB.prepare(
      "DELETE FROM delivery_order_items WHERE deliveryOrderId = ?",
    ).bind(id),
    c.var.DB.prepare("DELETE FROM delivery_orders WHERE id = ?").bind(id),
  ]);

  // Audit emit (P3.4) — DO deletion. before-snapshot captures the status so
  // we know what was destroyed.
  await emitAudit(c, {
    resource: "delivery-orders",
    resourceId: id,
    action: "delete",
    before: { status: existing.status },
  });

  return c.json({ success: true });
});

export default app;
