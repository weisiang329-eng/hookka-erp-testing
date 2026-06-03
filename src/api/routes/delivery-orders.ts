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
import type { Env } from "../worker";
import { consumeFGBatchesForDO } from "../lib/do-cost-cascade";
import {
  loadDoValueMap,
  loadPoValueMap,
  loadSoLinePriceIndex,
  priceForItem,
} from "../lib/do-value";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import { checkDeliveryOrderLocked, lockedResponse } from "../lib/lock-helpers";
import { nextInvoiceNo, buildInvoiceLedgerLegs } from "./invoices";
import {
  ledgerHasSource,
  buildJournalEntryStatements,
} from "../lib/journal-hash";
import {
  breakBomIntoWips,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";
import { isHeadboardOnlySpecial } from "./fg-units";

const app = new Hono<Env>();

// Status transitions allowed by the mock-data impl. Preserved here so the
// frontend sees identical error messages.
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["LOADED"],
  LOADED: ["DRAFT", "IN_TRANSIT", "DELIVERED"],
  IN_TRANSIT: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
};

type DeliveryOrderRow = {
  id: string;
  doNo: string;
  salesOrderId: string | null;
  companySO: string | null;
  companySOId: string | null;
  customerId: string;
  customerPOId: string | null;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  deliveryAddress: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
  deliveryDate: string | null;
  hookkaExpectedDD: string | null;
  driverId: string | null;
  driverName: string | null;
  driverContactPerson: string | null;
  driverPhone: string | null;
  vehicleId: string | null;
  vehicleNo: string | null;
  vehicleType: string | null;
  totalM3: number;
  totalItems: number;
  status: string;
  overdue: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  remarks: string | null;
  dropPoints: number | null;
  deliveryCostSen: number | null;
  lorryId: string | null;
  lorryName: string | null;
  doQrCode: string | null;
  fgUnitIds: string | null;
  signedAt: string | null;
  signedByWorkerId: string | null;
  signedByWorkerName: string | null;
  proofOfDelivery: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type DeliveryOrderItemRow = {
  id: string;
  deliveryOrderId: string;
  productionOrderId: string | null;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  itemM3: number;
  rackingNumber: string | null;
  packingStatus: string | null;
  salesOrderNo: string | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Returns itemM3 from the live products table when available, falling
// back to the stored row value (legacy DOs created before 2026-04-27
// were persisted with itemM3=0 — see BUG-2026-04-27).
function pickItemM3(
  row: DeliveryOrderItemRow,
  productM3Map?: Map<string, number>,
): number {
  if (productM3Map && row.productCode) {
    const v = productM3Map.get(row.productCode);
    if (v && v > 0) return v;
  }
  return row.itemM3;
}

function rowToItem(
  row: DeliveryOrderItemRow,
  productM3Map?: Map<string, number>,
) {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId ?? "",
    poNo: row.poNo ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    itemM3: pickItemM3(row, productM3Map),
    rackingNumber: row.rackingNumber ?? "",
    packingStatus: row.packingStatus ?? "PENDING",
    salesOrderNo: row.salesOrderNo ?? "",
  };
}

// Loads { hubId → state } for the given hub ids. Used by the list path
// to surface the hub's state on each row even when delivery_orders.customerState
// is NULL (operator created the DO without typing a state but did pick a hub).
// Frontend prefers hubState over customerState in the State column fallback chain.
async function loadHubStateMap(
  db: D1Database,
  hubIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(hubIds.filter((h): h is string => !!h)),
  );
  if (ids.length === 0) return new Map();
  const ph = ids.map(() => "?").join(",");
  const res = await db
    .prepare(`SELECT id, state FROM delivery_hubs WHERE id IN (${ph})`)
    .bind(...ids)
    .all<{ id: string; state: string | null }>();
  const map = new Map<string, string>();
  for (const r of res.results ?? []) {
    if (r.state) map.set(r.id, r.state);
  }
  return map;
}

// Loads { productCode → unitM3 } for the given codes. Used by every DO
// read path so legacy items (itemM3=0) get backfilled on the fly.
async function loadProductM3Map(
  db: D1Database,
  productCodes: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const codes = Array.from(
    new Set(productCodes.filter((c): c is string => !!c)),
  );
  if (codes.length === 0) return new Map();
  const ph = codes.map(() => "?").join(",");
  const res = await db
    .prepare(`SELECT code, unitM3 FROM products WHERE code IN (${ph})`)
    .bind(...codes)
    .all<{ code: string; unitM3: number }>();
  const map = new Map<string, number>();
  for (const r of res.results ?? []) {
    map.set(r.code, Number(r.unitM3) || 0);
  }
  return map;
}

function rowToOrder(
  row: DeliveryOrderRow,
  items: DeliveryOrderItemRow[] = [],
  productM3Map?: Map<string, number>,
  hubStateMap?: Map<string, string>,
) {
  const pod = parseJson<Record<string, unknown> | null>(row.proofOfDelivery, null);
  const fgUnitIds = parseJson<string[]>(row.fgUnitIds, []);
  // hubState is the state code stored on delivery_hubs.state (resolved via hubId).
  // Kept separate from customerState — they're semantically different (the customer's
  // billing state vs the destination hub's geographic state). Frontend's State column
  // falls back hubState → customerState → "-" so a DO with a hub but no customerState
  // still shows the right state.
  const hubState =
    hubStateMap && row.hubId ? hubStateMap.get(row.hubId) ?? "" : "";
  const base: Record<string, unknown> = {
    id: row.id,
    doNo: row.doNo,
    salesOrderId: row.salesOrderId ?? "",
    companySO: row.companySO ?? "",
    companySOId: row.companySOId ?? "",
    customerId: row.customerId,
    customerPOId: row.customerPOId ?? "",
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubState,
    deliveryAddress: row.deliveryAddress ?? "",
    contactPerson: row.contactPerson ?? "",
    contactPhone: row.contactPhone ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    dropPoints: row.dropPoints ?? undefined,
    deliveryCostSen: row.deliveryCostSen ?? undefined,
    lorryId: row.lorryId,
    lorryName: row.lorryName ?? "",
    deliveryDate: row.deliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    driverId: row.driverId,
    driverName: row.driverName ?? "",
    driverContactPerson: row.driverContactPerson ?? "",
    driverPhone: row.driverPhone ?? "",
    vehicleId: row.vehicleId ?? "",
    vehicleNo: row.vehicleNo ?? "",
    vehicleType: row.vehicleType ?? "",
    items: items
      .filter((i) => i.deliveryOrderId === row.id)
      .map((it) => rowToItem(it, productM3Map)),
    // Recompute totalM3 on read using live product unitM3 — legacy DOs
    // were persisted with itemM3=0 / totalM3=0 before BUG-2026-04-27 fix.
    totalM3: productM3Map
      ? Math.round(
          items
            .filter((i) => i.deliveryOrderId === row.id)
            .reduce((s, it) => s + pickItemM3(it, productM3Map) * it.quantity, 0) *
            100,
        ) / 100
      : row.totalM3,
    totalItems: row.totalItems,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
    remarks: row.remarks ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
    doQrCode: row.doQrCode ?? undefined,
    fgUnitIds: fgUnitIds.length ? fgUnitIds : undefined,
    signedAt: row.signedAt,
    signedByWorkerId: row.signedByWorkerId,
    signedByWorkerName: row.signedByWorkerName ?? undefined,
  };
  if (pod) base.proofOfDelivery = pod;
  return base;
}

// ---------------------------------------------------------------------------
// rowToOrderList — slim variant of rowToOrder for the LIST endpoint
// (GET /api/delivery-orders). The delivery list page (src/pages/delivery/
// index.tsx) maps each DO through mapDOToRow, which only ever reads a small
// fixed set of per-item fields, and the list grid / its columns / filters /
// sort / per-row Print DO + Print Packing List only ever consume those.
// It never shows the proof-of-delivery blob (signature + up to 5 photos,
// all base64 data URLs) or the DO QR-code image. The detail endpoint
// GET /:id keeps the full rowToOrder payload (the standalone DO detail
// route still loads everything).
//
// What this drops, with zero change to anything the grid shows / filters /
// sorts / exports / prints:
//   - proofOfDelivery -> null   (huge base64 signature + photo blob; the
//     list page's mapDOToRow does not read it at all)
//   - doQrCode        -> null   (base64 QR image; mapDOToRow does not read it)
//   - items[]         -> slimmed to exactly the 11 fields mapDOToRow reads:
//       id, productionOrderId, salesOrderNo, poNo, productCode, productName,
//       sizeLabel, fabricCode, quantity, itemM3, rackingNumber
//     The only per-item field dropped is `packingStatus` — mapDOToRow never
//     reads it, and the only writer of packingStatus on the list page sends
//     a hardcoded literal ("PACKED") on PUT, never the read-back value.
// ---------------------------------------------------------------------------
function rowToOrderList(
  row: DeliveryOrderRow,
  items: DeliveryOrderItemRow[] = [],
  productM3Map?: Map<string, number>,
  hubStateMap?: Map<string, string>,
): Record<string, unknown> {
  const full = rowToOrder(row, items, productM3Map, hubStateMap);
  return {
    ...full,
    proofOfDelivery: null,
    doQrCode: null,
    items: items
      .filter((i) => i.deliveryOrderId === row.id)
      .map((it) => ({
        id: it.id,
        productionOrderId: it.productionOrderId ?? "",
        salesOrderNo: it.salesOrderNo ?? "",
        poNo: it.poNo ?? "",
        productCode: it.productCode ?? "",
        productName: it.productName ?? "",
        sizeLabel: it.sizeLabel ?? "",
        fabricCode: it.fabricCode ?? "",
        quantity: it.quantity,
        itemM3: pickItemM3(it, productM3Map),
        rackingNumber: it.rackingNumber ?? "",
      })),
  };
}

function genDoId(): string {
  return `do-${crypto.randomUUID().slice(0, 8)}`;
}

function genDoItemId(): string {
  return `doi-${crypto.randomUUID().slice(0, 8)}`;
}

// Async sequential DO number — DO-YYMM-NNN, NNN = max-existing-suffix-in-YYMM + 1.
// Was random `DO-YYMM-XXXX` hash before 2026-04-27 (user request: numbering
// rule in Settings says DO-YYMM-NNN sequential). Mirrors the SO generator
// in src/api/routes/sales-orders.ts generateCompanySOId.
async function genNextDoNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `DO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT doNo FROM delivery_orders WHERE doNo LIKE ? ORDER BY doNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ doNo: string }>();
  if (!res) return `${prefix}001`;
  const seq = parseInt(res.doNo.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoiceId(): string {
  return `inv-${crypto.randomUUID().slice(0, 8)}`;
}

// Wei Siang 2026-05-16: resolve EVERY sales order a DO touches.
// delivery_orders.salesOrderId is only set for single-SO DOs (POST
// leaves it NULL when the DO spans multiple SOs — see lines ~509-521).
// Multi-SO DOs were therefore never cascading SO status at all. Walk
// delivery_order_items → production_orders.salesOrderId to catch the
// multi-SO case, union with the legacy single-SO FK, dedupe.
export async function resolveDoSalesOrderIds(
  db: D1Database,
  doId: string,
  existingSalesOrderId: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  if (existingSalesOrderId) ids.add(existingSalesOrderId);
  const rows = await db
    .prepare(
      `SELECT DISTINCT po.salesOrderId AS soId
         FROM delivery_order_items di
         JOIN production_orders po ON po.id = di.productionOrderId
        WHERE di.deliveryOrderId = ?
          AND po.salesOrderId IS NOT NULL
          AND po.salesOrderId != ''`,
    )
    .bind(doId)
    .all<{ soId: string | null }>();
  for (const r of rows.results ?? []) {
    if (r.soId) ids.add(r.soId);
  }
  return Array.from(ids);
}

// DO / PO "Sales Figure" resolver moved to ../lib/do-value (single source
// of truth, also used by the Sales Orders Delivered/Outstanding split).

function genInvoiceItemId(): string {
  return `invi-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// buildDoDeliveredSoAndInvoice — the DELIVERED-side cascade, shared by the
// live PUT transition and the one-shot historical backfill.
//
// For a delivered DO it produces the statements that:
//   1. advance EVERY sales order the DO touches (resolveDoSalesOrderIds —
//      multi-SO aware) to DELIVERED, unless that SO is already at/past
//      DELIVERED or is CANCELLED;
//   2. create ONE combined DRAFT invoice for the whole DO spanning all
//      those SOs (Wei Siang 2026-05-16 chose one invoice per delivery
//      note), idempotent — skipped if any invoice already references the
//      DO; the customer's outstanding A/R is bumped in the same set.
//
// fg_units / FIFO-COGS are deliberately NOT here — those are live-dispatch
// concerns the PUT path owns and the backfill must not re-run.
//
// The caller owns the batch + the invoice-number retry. invoiceStmtIdx is
// the index of the invoice INSERT WITHIN the returned `statements` array
// (or -1); the caller offsets it if it concatenates into a larger batch.
// ---------------------------------------------------------------------------
type DoForDeliveredCascade = {
  id: string;
  doNo: string;
  salesOrderId: string | null;
  companySOId: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  // PR 5 (2026-05-20) — customer-block snapshot for invoice creation.
  deliveryAddress: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
  customerPOId: string | null;
  hubId: string | null;
  hubName: string | null;
};

// An SO at/past DELIVERED, or cancelled, must not be touched by a
// delivered DO (don't downgrade INVOICED/CLOSED, don't resurrect
// CANCELLED, don't re-stamp DELIVERED).
const SO_TERMINAL_FOR_DELIVERED = new Set([
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "CANCELLED",
]);

type InvItem = {
  id: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
};

// Combined invoice lines for a DO across ALL its linked SOs: each DO item
// priced at its product's SO unit price; fall back to billing the SO lines
// directly, then to the SOs' header totals. Shared by live invoice
// creation AND the under-billed-invoice repair so the two can't drift —
// "every delivered item has an amount" must mean the same thing in both.
export async function computeDoInvoiceLines(
  db: D1Database,
  doId: string,
  soIds: string[],
): Promise<{ invItems: InvItem[]; computedTotal: number }> {
  if (soIds.length === 0) return { invItems: [], computedTotal: 0 };

  // BUG-2026-05-18-004 fix. Price every delivered item with the EXACT same
  // resolver the DO "value" uses — the whole-org price index + the DO's own
  // salesOrderId as fallback (see loadDoValueMap in ../lib/do-value). The
  // old code built a NARROW per-DO index (only this DO's POs + the linked
  // SOs' lines); any item whose code didn't match one of those lines was
  // silently priced at 0, and the "bill the whole SO" fallback only fired
  // when the WHOLE total was 0 — so a partial match left the invoice far
  // below the delivered value (net ≈ RM 165k under-billed across 84). Using
  // the shared whole-org resolver makes the invoice reconcile to the DO
  // value to the cent, which is do-value.ts's stated single-source intent.
  const meta = await db
    .prepare("SELECT orgId, salesOrderId FROM delivery_orders WHERE id = ?")
    .bind(doId)
    .first<{ orgId: string | null; salesOrderId: string | null }>();
  const orgId = meta?.orgId ?? "hookka";
  const doSoId = meta?.salesOrderId ?? soIds[0] ?? "";

  const [idx, doItemsRes] = await Promise.all([
    loadSoLinePriceIndex(db, orgId),
    db
      .prepare(
        `SELECT productionOrderId, productCode, productName, sizeLabel, fabricCode, quantity
           FROM delivery_order_items WHERE deliveryOrderId = ?`,
      )
      .bind(doId)
      .all<{
        productionOrderId: string | null;
        productCode: string | null;
        productName: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        quantity: number;
      }>(),
  ]);
  const doItems = doItemsRes.results ?? [];

  let invItems: InvItem[] = doItems.map((di) => {
    // Identical call to loadDoValueMap → invoice total == DO value.
    const unitPriceSen = priceForItem(
      idx,
      di.productionOrderId,
      doSoId,
      di.productCode,
    );
    return {
      id: genInvoiceItemId(),
      productCode: di.productCode ?? "",
      productName: di.productName ?? "",
      sizeLabel: di.sizeLabel ?? "",
      fabricCode: di.fabricCode ?? "",
      quantity: di.quantity,
      unitPriceSen,
      totalSen: unitPriceSen * di.quantity,
    };
  });
  let computedTotal = invItems.reduce((s, i) => s + i.totalSen, 0);

  // Fallback 1: nothing priced at all → bill the linked SO lines directly.
  if (computedTotal === 0) {
    const soPh = soIds.map(() => "?").join(",");
    const soItemsRes = await db
      .prepare(
        `SELECT productCode, productName, sizeLabel, fabricCode, quantity, unitPriceSen, lineTotalSen
           FROM sales_order_items WHERE salesOrderId IN (${soPh})`,
      )
      .bind(...soIds)
      .all<{
        productCode: string | null;
        productName: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        quantity: number;
        unitPriceSen: number;
        lineTotalSen: number;
      }>();
    const sis = soItemsRes.results ?? [];
    if (sis.length > 0) {
      invItems = sis.map((si) => ({
        id: genInvoiceItemId(),
        productCode: si.productCode ?? "",
        productName: si.productName ?? "",
        sizeLabel: si.sizeLabel ?? "",
        fabricCode: si.fabricCode ?? "",
        quantity: si.quantity,
        unitPriceSen: si.unitPriceSen,
        totalSen: si.lineTotalSen || si.unitPriceSen * si.quantity,
      }));
      computedTotal = invItems.reduce((s, i) => s + i.totalSen, 0);
    }
  }

  // Fallback 2: still 0 → sum of every linked SO's header total.
  if (computedTotal === 0) {
    const soPh = soIds.map(() => "?").join(",");
    const soTotal = await db
      .prepare(
        `SELECT COALESCE(SUM(totalSen), 0) AS t
           FROM sales_orders WHERE id IN (${soPh})`,
      )
      .bind(...soIds)
      .first<{ t: number }>();
    computedTotal = Number(soTotal?.t) || 0;
  }

  return { invItems, computedTotal };
}

async function buildDoDeliveredSoAndInvoice(
  db: D1Database,
  doRow: DoForDeliveredCascade,
  now: string,
): Promise<{
  statements: D1PreparedStatement[];
  rebuildInvoiceInsert: ((no: string) => D1PreparedStatement) | null;
  invoiceStmtIdx: number;
  createdInvoice: boolean;
  invoiceTotalSen: number;
  soAdvanced: string[];
}> {
  const statements: D1PreparedStatement[] = [];
  const soAdvanced: string[] = [];
  let rebuildInvoiceInsert: ((no: string) => D1PreparedStatement) | null = null;
  let invoiceStmtIdx = -1;
  let createdInvoice = false;
  let invoiceTotalSen = 0;

  const soIds = await resolveDoSalesOrderIds(db, doRow.id, doRow.salesOrderId);

  // 1. Advance every linked SO to DELIVERED (skip terminal/cancelled).
  for (const soId of soIds) {
    const soRow = await db
      .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
      .bind(soId)
      .first<{ id: string; status: string }>();
    if (!soRow || SO_TERMINAL_FOR_DELIVERED.has(soRow.status)) continue;
    soAdvanced.push(soId);
    statements.push(
      db
        .prepare(
          "UPDATE sales_orders SET status = 'DELIVERED', updated_at = ? WHERE id = ?",
        )
        .bind(now, soRow.id),
      db
        .prepare(
          `INSERT INTO so_status_changes
             (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genStatusChangeId(),
          soRow.id,
          soRow.status,
          "DELIVERED",
          "System",
          now,
          "DO delivered",
          JSON.stringify([`DO ${doRow.doNo} marked DELIVERED`]),
        ),
    );
  }

  // 2. One combined invoice for the whole DO — idempotent.
  const existingInvoice = await db
    .prepare("SELECT id FROM invoices WHERE deliveryOrderId = ? LIMIT 1")
    .bind(doRow.id)
    .first<{ id: string }>();

  if (!existingInvoice && soIds.length > 0) {
    const { invItems, computedTotal } = await computeDoInvoiceLines(
      db,
      doRow.id,
      soIds,
    );

    const invId = genInvoiceId();
    const invoiceNo = await nextInvoiceNo(db);
    const invoiceDate = now.split("T")[0];
    const due = new Date();
    due.setDate(due.getDate() + 30);
    const dueDate = due.toISOString().split("T")[0];
    // Combined invoice spans multiple SOs — anchor the header SO to the
    // DO's own (legacy single-SO) or the first resolved one so the row
    // isn't orphaned; the authoritative link is deliveryOrderId.
    const headerSoId = doRow.salesOrderId || soIds[0] || null;

    rebuildInvoiceInsert = (no: string) =>
      db
        .prepare(
          // PR 5 — INSERT carries customerAddress / attention /
          // customerPhone / customerPOId snapshotted from the DO.
          // Mirrors the manual POST /api/invoices INSERT in invoices.ts.
          `INSERT INTO invoices (
             id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
             customerId, customerName, customerState, customerAddress,
             attention, customerPhone, customerPOId, hubId, hubName,
             subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
             paymentDate, paymentMethod, notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          invId,
          no,
          doRow.id,
          doRow.doNo,
          headerSoId,
          doRow.companySOId ?? "",
          doRow.customerId,
          doRow.customerName,
          doRow.customerState,
          doRow.deliveryAddress,
          doRow.contactPerson,
          doRow.contactPhone,
          doRow.customerPOId,
          doRow.hubId,
          doRow.hubName,
          computedTotal,
          computedTotal,
          "DRAFT",
          invoiceDate,
          dueDate,
          0,
          null,
          "",
          soIds.length > 1 ? `Combined invoice for ${soIds.length} SOs` : "",
          now,
          now,
        );
    invoiceStmtIdx = statements.length;
    statements.push(rebuildInvoiceInsert(invoiceNo));
    for (const item of invItems) {
      statements.push(
        db
          .prepare(
            `INSERT INTO invoice_items (
               id, invoiceId, productCode, productName, sizeLabel, fabricCode,
               quantity, unitPriceSen, totalSen
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            item.id,
            invId,
            item.productCode,
            item.productName,
            item.sizeLabel,
            item.fabricCode,
            item.quantity,
            item.unitPriceSen,
            item.totalSen,
          ),
      );
    }
    // Outstanding A/R follows delivered goods (same batch as the invoice
    // so a partial failure can't strand one without the other).
    statements.push(
      db
        .prepare(
          `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
        )
        .bind(computedTotal, doRow.customerId),
    );
    createdInvoice = true;
    invoiceTotalSen = computedTotal;
  }

  return {
    statements,
    rebuildInvoiceInsert,
    invoiceStmtIdx,
    createdInvoice,
    invoiceTotalSen,
    soAdvanced,
  };
}

async function fetchOrderWithItems(db: D1Database, id: string) {
  const [order, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM delivery_orders WHERE id = ?")
      .bind(id)
      .first<DeliveryOrderRow>(),
    db
      .prepare("SELECT * FROM delivery_order_items WHERE deliveryOrderId = ?")
      .bind(id)
      .all<DeliveryOrderItemRow>(),
  ]);
  if (!order) return null;
  const items = itemsRes.results ?? [];
  const [m3Map, hubStateMap] = await Promise.all([
    loadProductM3Map(db, items.map((i) => i.productCode)),
    loadHubStateMap(db, [order.hubId]),
  ]);
  return rowToOrder(order, items, m3Map, hubStateMap);
}

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
      loadDoValueMap(db, orgId),
    ]);
    const itemRows = items.results ?? [];
    const orderRows = orders.results ?? [];
    const [m3Map, hubStateMap] = await Promise.all([
      loadProductM3Map(db, itemRows.map((i) => i.productCode)),
      loadHubStateMap(db, orderRows.map((o) => o.hubId)),
    ]);
    const data = orderRows.map((o) => {
      const order = rowToOrderList(o, itemRows, m3Map, hubStateMap);
      order.valueSen = valueMap.get(o.id) ?? 0;
      return order;
    });
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  const [countRes, pageRes] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM delivery_orders WHERE orgId = ?")
      .bind(orgId)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT * FROM delivery_orders WHERE orgId = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .bind(orgId, limit, offset)
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
  const [m3Map, hubStateMap, valueMap] = await Promise.all([
    loadProductM3Map(db, items.map((i) => i.productCode)),
    loadHubStateMap(db, orderRows.map((o) => o.hubId)),
    loadDoValueMap(db, orgId),
  ]);
  const data = orderRows.map((o) => {
    const order = rowToOrderList(o, items, m3Map, hubStateMap);
    order.valueSen = valueMap.get(o.id) ?? 0;
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
    loadDoValueMap(c.var.DB, orgId),
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
           JOIN sales_orders so ON so.companySO = di.salesOrderNo
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

  for (const doRow of dos) {
    dosScanned++;
    try {
      const dc = await buildDoDeliveredSoAndInvoice(c.var.DB, doRow, now);
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
               quantity, unitPriceSen, totalSen
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const deltaSen = computedTotal - oldTotal;
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
      }
      b1.push(
        c.var.DB.prepare(
          `INSERT INTO invoices (
             id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
             customerId, customerName, customerState, hubId, hubName,
             subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
             paymentDate, paymentMethod, notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          computedTotal,
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
               quantity, unitPriceSen, totalSen
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        const { legs, taxSen } = await buildInvoiceLedgerLegs(
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
        );
        const { statements } = await buildJournalEntryStatements(
          c.var.DB,
          orgId,
          legs,
        );
        await c.var.DB.batch([
          ...statements,
          c.var.DB.prepare(
            "UPDATE invoices SET taxSen = ? WHERE id = ?",
          ).bind(taxSen, newId),
        ]);
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

    // Resolve salesOrderId + seed items from productionOrderIds when the
    // caller came from Pending Delivery (bulk Create DO). All POs must belong
    // to the same SO — otherwise we reject so the user can split the DO.
    type PoRow = {
      id: string;
      poNo: string | null;
      salesOrderId: string | null;
      companySOId: string | null;
      productCode: string | null;
      productName: string | null;
      sizeLabel: string | null;
      fabricCode: string | null;
      quantity: number | null;
      rackingNumber: string | null;
      customerName: string | null;
      customerState: string | null;
    };
    const productionOrderIds: string[] = Array.isArray(body.productionOrderIds)
      ? (body.productionOrderIds as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];
    let poRowsForItems: PoRow[] = [];
    let resolvedSalesOrderId: string | undefined = body.salesOrderId ?? undefined;
    if (productionOrderIds.length > 0) {
      const placeholders = productionOrderIds.map(() => "?").join(",");
      const poRes = await c.var.DB.prepare(
        `SELECT id, poNo, salesOrderId, consignmentOrderId, companySOId,
                productCode, productName,
                sizeLabel, fabricCode, quantity, rackingNumber,
                customerName, customerState
           FROM production_orders WHERE id IN (${placeholders})`,
      )
        .bind(...productionOrderIds)
        .all<PoRow & { consignmentOrderId?: string | null }>();
      poRowsForItems = poRes.results ?? [];
      if (poRowsForItems.length === 0) {
        return c.json(
          { success: false, error: "No matching production orders" },
          400,
        );
      }
      // CO POs route via Consignment Notes, not Delivery Orders. Frontend
      // already filters them out of the DO picker (delivery/index.tsx),
      // but a direct API call (or seed script) could leak them in. Belt-
      // and-braces guard rejects any CO PO at POST time.
      const coPoNos = poRowsForItems
        .filter(
          (r) =>
            (r as unknown as { consignmentOrderId?: string | null })
              .consignmentOrderId,
        )
        .map((r) => r.poNo);
      if (coPoNos.length > 0) {
        return c.json(
          {
            success: false,
            error: `Consignment-Order POs cannot be added to a Delivery Order. Use a Consignment Note instead. Offending POs: ${coPoNos.join(", ")}`,
          },
          400,
        );
      }
      // ROOT-CAUSE GUARD (Wei Siang 2026-05-16): a production order can
      // only be delivered ONCE. Reject any PO already on a non-cancelled
      // DO. Without this, the same POs could be put on a 2nd/3rd DO and
      // re-delivered — each re-delivery re-ran the FG FIFO consumption
      // (cost_ledger FG_DELIVERED) and inflated SO/Delivered value
      // (BUG-2026-05-16: 13 duplicate DOs, 200 units & RM 24,647 of FG
      // double-consumed). Frontend hides already-linked POs, but that's
      // display-only — this is the authoritative backend block.
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
        const poNoById = new Map(poRowsForItems.map((r) => [r.id, r.poNo]));
        const lines = alreadyLinked
          .map(
            (r) =>
              `${poNoById.get(r.poId) ?? r.poId} → ${r.doNo} (${r.status})`,
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
      // Multi-SO is still allowed ONLY within the same customer + same hub
      // (operators consolidate several SOs of one customer going to one
      // destination onto one truck). The two guards below reverse both
      // dimensions of the 2026-04-27 free-mix allowance: a DO can no longer
      // mix customers (CUSTOMER-CONSISTENCY) or hubs (HUB-CONSISTENCY).
      const soIds = new Set(poRowsForItems.map((r) => r.salesOrderId ?? ""));
      soIds.delete("");

      if (soIds.size > 0) {
        const soIdArr = [...soIds];
        const ph = soIdArr.map(() => "?").join(",");
        // One lookup feeds both guards — the parent SOs' customer + hub.
        const soMetaRes = await c.var.DB.prepare(
          `SELECT id, hubId, hubName, customerId, customerName
             FROM sales_orders WHERE id IN (${ph})`,
        )
          .bind(...soIdArr)
          .all<{
            id: string;
            hubId: string | null;
            hubName: string | null;
            customerId: string | null;
            customerName: string | null;
          }>();
        const soMeta = soMetaRes.results ?? [];

        // CUSTOMER-CONSISTENCY GUARD (Wei Siang 2026-05-28): a DO is keyed to
        // ONE customer ("我们的 DO 是对标顾客的"). Reject a selection whose
        // parent SOs span 2+ distinct customers — the operator must build one
        // DO per customer (Quick Dispatch already auto-splits this way).
        const custMap = new Map<string, string>();
        for (const r of soMeta) {
          if (r.customerId) {
            custMap.set(r.customerId, r.customerName || r.customerId);
          }
        }
        if (custMap.size > 1) {
          const names = [...custMap.values()].join(", ");
          return c.json(
            {
              success: false,
              error: `This delivery order mixes ${custMap.size} customers (${names}). A DO can only deliver for one customer — split into separate DOs, one per customer.`,
            },
            400,
          );
        }

        // HUB-CONSISTENCY GUARD (Wei Siang 2026-05-28): a single DO must
        // deliver to ONE hub. Different hubs = physically different drop-off
        // addresses, so they can't share one DO (the printed DO carries a
        // single Deliver-To address — mixing hubs would ship some branches'
        // goods to the wrong address). Reject when the selection spans 2+
        // distinct non-empty hubs.
        const hubMap = new Map<string, string>();
        for (const r of soMeta) {
          if (r.hubId && r.hubId !== "") {
            hubMap.set(r.hubId, r.hubName || r.hubId);
          }
        }
        if (hubMap.size > 1) {
          const names = [...hubMap.values()].join(", ");
          return c.json(
            {
              success: false,
              error: `This delivery order mixes ${hubMap.size} delivery hubs (${names}). A DO can only deliver to one hub — split into separate DOs, one per hub.`,
            },
            400,
          );
        }
      }

      // Pick a representative salesOrderId for the legacy single-SO
      // cascade fields (sales_orders.hookkaDeliveryOrder etc.). When the
      // DO genuinely spans multiple SOs, leave salesOrderId NULL — the
      // DELIVERED cascade walks fg_units → poId to find every SO and
      // updates each (added below).
      if (!resolvedSalesOrderId && soIds.size === 1) {
        resolvedSalesOrderId = [...soIds][0];
      }
    }

    const salesOrderId: string | undefined = resolvedSalesOrderId;

    // Validate customer (salesOrder link optional at this phase).
    let salesOrderRow: {
      id: string;
      customerId: string;
      customerName: string | null;
      customerState: string | null;
      customerPOId: string | null;
      companySO: string | null;
      companySOId: string | null;
      hubId: string | null;
      hookkaExpectedDD: string | null;
    } | null = null;
    if (salesOrderId) {
      salesOrderRow = await c.var.DB.prepare(
        `SELECT id, customerId, customerName, customerState, customerPOId,
                companySO, companySOId, hubId, hookkaExpectedDD
           FROM sales_orders WHERE id = ?`,
      )
        .bind(salesOrderId)
        .first();
      if (!salesOrderRow) {
        return c.json(
          { success: false, error: "Sales order not found" },
          400,
        );
      }
    }

    // customerId fallback chain (relaxed 2026-04-27 for multi-SO DOs):
    //   1. body.customerId (explicit)
    //   2. salesOrderRow.customerId (single-SO path)
    //   3. lookup by name from the first PO row's customerName when the
    //      DO spans multiple SOs (so multi-customer DOs still have a
    //      representative customer for legacy contact / cascade fields).
    let customerId: string | undefined =
      body.customerId ?? salesOrderRow?.customerId;
    if (!customerId && poRowsForItems.length > 0) {
      const firstName = poRowsForItems[0].customerName;
      if (firstName) {
        const cr = await c.var.DB.prepare(
          `SELECT id FROM customers WHERE name = ? LIMIT 1`,
        )
          .bind(firstName)
          .first<{ id: string }>();
        if (cr?.id) customerId = cr.id;
      }
    }
    if (!customerId) {
      return c.json(
        { success: false, error: "customerId or salesOrderId is required" },
        400,
      );
    }
    const customerRow = await c.var.DB.prepare(
      `SELECT id, name, contactName, phone, creditLimitSen, outstandingSen
         FROM customers WHERE id = ?`,
    )
      .bind(customerId)
      .first<{
        id: string;
        name: string;
        contactName: string | null;
        phone: string | null;
        creditLimitSen: number;
        outstandingSen: number;
      }>();
    if (!customerRow) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }

    // Resolve the (optional) default delivery hub so address/contact default
    // the way the mock-data route used to.
    let defaultHub: {
      id: string;
      shortName: string | null;
      address: string | null;
    } | null = null;
    const hubTarget = body.hubId ?? salesOrderRow?.hubId ?? null;
    if (hubTarget) {
      defaultHub = await c.var.DB.prepare(
        "SELECT id, shortName, address FROM delivery_hubs WHERE id = ?",
      )
        .bind(hubTarget)
        .first();
    } else {
      defaultHub = await c.var.DB.prepare(
        "SELECT id, shortName, address FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 1",
      )
        .bind(customerId)
        .first();
    }

    const itemsInput: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];
    const itemsFromInput = itemsInput.map((item) => ({
      id: (item.id as string) || genDoItemId(),
      productionOrderId: (item.productionOrderId as string) || "",
      salesOrderNo: (item.salesOrderNo as string) || "",
      poNo: (item.poNo as string) || "",
      productCode: (item.productCode as string) || "",
      productName: (item.productName as string) || "",
      sizeLabel: (item.sizeLabel as string) || "",
      fabricCode: (item.fabricCode as string) || "",
      quantity: Number(item.quantity) || 0,
      itemM3: Number(item.itemM3) || 0,
      rackingNumber: (item.rackingNumber as string) || "",
      packingStatus: (item.packingStatus as string) || "PENDING",
    }));
    // Look up unitM3 from the products table for every PO's productCode
    // so DO line items have accurate volumes — was hardcoded 0 before
    // (BUG-2026-04-27: DO detail showed Total M³ = 0.00 even when the
    // upstream Pending Delivery grid reported real per-PO Unit M³).
    const productM3Map = new Map<string, number>();
    if (poRowsForItems.length > 0) {
      const codes = Array.from(
        new Set(
          poRowsForItems
            .map((p) => p.productCode)
            .filter((c): c is string => !!c),
        ),
      );
      if (codes.length > 0) {
        const ph = codes.map(() => "?").join(",");
        const m3Res = await c.var.DB.prepare(
          `SELECT code, unitM3 FROM products WHERE code IN (${ph})`,
        )
          .bind(...codes)
          .all<{ code: string; unitM3: number }>();
        for (const r of m3Res.results ?? []) {
          productM3Map.set(r.code, Number(r.unitM3) || 0);
        }
      }
    }
    // Fallback: if caller didn't pass items but gave productionOrderIds, seed
    // line items from the POs we already loaded.
    const items =
      itemsFromInput.length > 0
        ? itemsFromInput
        : poRowsForItems.map((po) => ({
            id: genDoItemId(),
            productionOrderId: po.id,
            salesOrderNo: po.companySOId ?? "",
            poNo: po.poNo ?? "",
            productCode: po.productCode ?? "",
            productName: po.productName ?? "",
            sizeLabel: po.sizeLabel ?? "",
            fabricCode: po.fabricCode ?? "",
            quantity: Number(po.quantity) || 0,
            itemM3: productM3Map.get(po.productCode ?? "") ?? 0,
            rackingNumber: po.rackingNumber ?? "",
            packingStatus: "PENDING" as const,
          }));

    const totalM3 =
      Math.round(items.reduce((s, i) => s + i.itemM3 * i.quantity, 0) * 100) /
      100;
    const totalItems = items.reduce((s, i) => s + i.quantity, 0);

    // -------------------------------------------------------------------
    // Credit-limit gate (Policy A — gate at DO POST):
    //   Customer can place SO of any amount; pickup (DO dispatch) is
    //   gated by credit limit. This is the only gate — DELIVERED
    //   transition no longer rechecks (option B/C is intentionally
    //   not implemented).
    //
    //   The "DO total" we project here matches the auto-DRAFT-invoice
    //   total computed at the DELIVERED cascade (delivery-orders.ts
    //   ~L1647-1685): DO line quantity × the SO line unit price for the
    //   matching productCode. We sum across every SO referenced by
    //   either body.salesOrderId OR the production_orders attached to
    //   the DO's items (multi-SO DOs leave salesOrderId null but still
    //   pull prices from each item's parent SO).
    //
    //   When creditLimitSen <= 0 the customer has no limit configured
    //   (common during onboarding) — let the DO through unchecked.
    // -------------------------------------------------------------------
    let projectedDoTotalSen = 0;
    if (customerRow.creditLimitSen > 0) {
      const soIdsForPricing = new Set<string>();
      if (salesOrderId) soIdsForPricing.add(salesOrderId);
      for (const po of poRowsForItems) {
        if (po.salesOrderId) soIdsForPricing.add(po.salesOrderId);
      }
      const priceByCode = new Map<string, number>();
      if (soIdsForPricing.size > 0) {
        const ph = [...soIdsForPricing].map(() => "?").join(",");
        const priceRes = await c.var.DB.prepare(
          `SELECT productCode, unitPriceSen
             FROM sales_order_items
            WHERE salesOrderId IN (${ph})`,
        )
          .bind(...soIdsForPricing)
          .all<{ productCode: string | null; unitPriceSen: number }>();
        for (const r of priceRes.results ?? []) {
          if (r.productCode && !priceByCode.has(r.productCode)) {
            priceByCode.set(r.productCode, r.unitPriceSen);
          }
        }
      }
      for (const it of items) {
        const unit = priceByCode.get(it.productCode) ?? 0;
        projectedDoTotalSen += unit * it.quantity;
      }
      const projectedOutstanding =
        customerRow.outstandingSen + projectedDoTotalSen;
      if (projectedOutstanding > customerRow.creditLimitSen) {
        return c.json(
          {
            success: false,
            error: "Credit limit exceeded",
            code: "CREDIT_LIMIT_EXCEEDED",
            details: {
              limit: customerRow.creditLimitSen,
              outstanding: customerRow.outstandingSen,
              doTotal: projectedDoTotalSen,
              projected: projectedOutstanding,
            },
          },
          409,
        );
      }
    }

    const now = new Date().toISOString();
    const id = genDoId();
    const doNo: string = body.doNo || (await genNextDoNo(c.var.DB));

    // Provider / vehicle / driver lookup chain (3PL refactor 2026-04-27).
    //
    // body.providerId — id of a row in the `drivers` table (the legacy
    //   COMPANY table — see migration 0014's naming-misnomer note). Used
    //   to denormalize the company's display name + dispatcher contact.
    // body.vehicleId  — id of a row in `three_pl_vehicles`. Provides the
    //   plate + vehicleType and the per-trip / per-extra-drop rates that
    //   recompute deliveryCostSen.
    // body.driverId   — id of a row in `three_pl_drivers` (an actual
    //   PERSON). Provides driverName + driverPhone.
    //
    // Backwards compat: pre-refactor callers passed body.driverId meaning
    // "company id". If body.providerId is missing AND body.driverId
    // doesn't resolve to a person but DOES resolve to a `drivers` row,
    // treat it as the legacy provider id.
    let providerIdResolved =
      (body.providerId as string | undefined) ?? null;
    let resolvedDriverId = (body.driverId as string | undefined) ?? null;
    let resolvedDriverName = (body.driverName as string | undefined) ?? "";
    let resolvedDriverPhone = (body.driverPhone as string | undefined) ?? "";
    let resolvedDriverContact =
      (body.driverContactPerson as string | undefined) ?? "";
    let resolvedVehicleId = (body.vehicleId as string | undefined) ?? null;
    let resolvedVehicleNo = (body.vehicleNo as string | undefined) ?? "";
    let resolvedVehicleType = (body.vehicleType as string | undefined) ?? "";
    let resolvedDeliveryCostSen = Number(body.deliveryCostSen) || 0;
    const dropPointsForCost = Number(body.dropPoints) || 1;

    // Driver person lookup first — and the legacy-id fallback path needs
    // to know whether driverId hit a person row or not.
    if (resolvedDriverId) {
      const person = await c.var.DB.prepare(
        "SELECT id, providerId, name, phone FROM three_pl_drivers WHERE id = ?",
      )
        .bind(resolvedDriverId)
        .first<{
          id: string;
          providerId: string;
          name: string;
          phone: string | null;
        }>();
      if (person) {
        resolvedDriverName = person.name;
        resolvedDriverPhone = person.phone ?? "";
        // Auto-fill provider from the driver's parent if caller didn't
        // pass one explicitly — the UI normally picks provider first
        // anyway, but this keeps the DO row consistent.
        if (!providerIdResolved) providerIdResolved = person.providerId;
      } else {
        // Backcompat: maybe driverId was a legacy COMPANY id from the
        // pre-refactor mutation contract. If so, treat it as providerId.
        const legacyProvider = await c.var.DB.prepare(
          "SELECT id FROM drivers WHERE id = ?",
        )
          .bind(resolvedDriverId)
          .first<{ id: string }>();
        if (legacyProvider && !providerIdResolved) {
          providerIdResolved = legacyProvider.id;
          // The pre-refactor contract treated driverId as company id and
          // had no separate person field — clear the resolved person id
          // so downstream code doesn't store a non-person id in driverId.
          resolvedDriverId = null;
        }
      }
    }

    // Provider (company) lookup — denormalize name + dispatcher contact.
    if (providerIdResolved) {
      const provider = await c.var.DB.prepare(
        "SELECT id, name, vehicleNo, contactPerson, ratePerTripSen, ratePerExtraDropSen FROM drivers WHERE id = ?",
      )
        .bind(providerIdResolved)
        .first<{
          id: string;
          name: string;
          vehicleNo: string | null;
          contactPerson: string | null;
          ratePerTripSen: number;
          ratePerExtraDropSen: number;
        }>();
      if (provider) {
        // When a driver person was picked, prefer their name as the
        // displayed driverName; otherwise fall back to the company name
        // (legacy DOs read driverName as "the 3PL").
        if (!resolvedDriverName) resolvedDriverName = provider.name;
        resolvedDriverContact = provider.contactPerson ?? "";
        // Fall back to the company-level vehicleNo only if no vehicle
        // was picked (kept for the partial-data case where the operator
        // hasn't assigned a specific lorry yet).
        if (!resolvedVehicleId && provider.vehicleNo && !resolvedVehicleNo) {
          resolvedVehicleNo = provider.vehicleNo;
        }
        // Provider-level rate fallback for cost — overridden below if a
        // vehicle is picked (vehicle rates take precedence).
        if (!resolvedVehicleId && !body.deliveryCostSen) {
          resolvedDeliveryCostSen =
            provider.ratePerTripSen +
            Math.max(0, dropPointsForCost - 1) * provider.ratePerExtraDropSen;
        }
      }
    }

    // Vehicle lookup — plate + type + per-vehicle rate (overrides company rate).
    if (resolvedVehicleId) {
      const vehicle = await c.var.DB.prepare(
        "SELECT id, plateNo, vehicleType, ratePerTripSen, ratePerExtraDropSen FROM three_pl_vehicles WHERE id = ?",
      )
        .bind(resolvedVehicleId)
        .first<{
          id: string;
          plateNo: string;
          vehicleType: string | null;
          ratePerTripSen: number;
          ratePerExtraDropSen: number;
        }>();
      if (vehicle) {
        resolvedVehicleNo = vehicle.plateNo;
        resolvedVehicleType = vehicle.vehicleType ?? "";
        if (!body.deliveryCostSen) {
          resolvedDeliveryCostSen =
            vehicle.ratePerTripSen +
            Math.max(0, dropPointsForCost - 1) * vehicle.ratePerExtraDropSen;
        }
      } else {
        // Stored id no longer exists — null it out so the DO doesn't
        // dangle a stale FK.
        resolvedVehicleId = null;
      }
    }

    // driverId column on delivery_orders historically meant "company id"
    // and is what existing reads (and the SO cascade) rely on. After the
    // 3PL refactor we store providerIdResolved here so the column stays
    // semantically the same; the new vehicleId / vehicleType / driverPhone
    // columns carry the per-trip specifics. driverName denormalizes the
    // PERSON when one is picked, otherwise the company (legacy behavior).
    const statements = [
      c.var.DB.prepare(
        `INSERT INTO delivery_orders (
           id, doNo, salesOrderId, companySO, companySOId, customerId,
           customerPOId, customerName, customerState, hubId, hubName,
           deliveryAddress, contactPerson, contactPhone, deliveryDate,
           hookkaExpectedDD, driverId, driverName, driverContactPerson,
           driverPhone, vehicleId, vehicleNo, vehicleType, totalM3,
           totalItems, status, overdue, dispatchedAt, deliveredAt, remarks,
           dropPoints, deliveryCostSen, lorryId, lorryName, doQrCode,
           fgUnitIds, signedAt, signedByWorkerId, signedByWorkerName,
           proofOfDelivery, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?)`,
      ).bind(
        id,
        doNo,
        salesOrderRow?.id ?? null,
        salesOrderRow?.companySO ?? body.companySO ?? null,
        salesOrderRow?.companySOId ?? body.companySOId ?? null,
        customerRow.id,
        salesOrderRow?.customerPOId ?? body.customerPOId ?? null,
        customerRow.name,
        salesOrderRow?.customerState ?? body.customerState ?? null,
        defaultHub?.id ?? null,
        defaultHub?.shortName ?? null,
        body.deliveryAddress ?? defaultHub?.address ?? "",
        body.contactPerson ?? customerRow.contactName ?? "",
        body.contactPhone ?? customerRow.phone ?? "",
        body.deliveryDate ?? "",
        salesOrderRow?.hookkaExpectedDD ?? "",
        providerIdResolved,
        resolvedDriverName,
        resolvedDriverContact,
        // Postgres columns added by migration 0063 are NOT NULL DEFAULT ''.
        // Bind null here -> "violates not-null constraint" because the
        // supabase-compat adapter passes the literal null through. Coerce to ''
        // so an unselected driver/vehicle becomes the documented default.
        resolvedDriverPhone ?? "",
        resolvedVehicleId ?? "",
        resolvedVehicleNo,
        resolvedVehicleType ?? "",
        totalM3,
        totalItems,
        "DRAFT",
        "PENDING",
        null,
        null,
        body.remarks ?? "",
        dropPointsForCost,
        resolvedDeliveryCostSen,
        body.lorryId ?? null,
        body.lorryName ?? null,
        body.doQrCode ?? null,
        body.fgUnitIds ? JSON.stringify(body.fgUnitIds) : null,
        null,
        null,
        null,
        null,
        now,
        now,
      ),
      ...items.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO delivery_order_items (
             id, deliveryOrderId, productionOrderId, poNo, productCode,
             productName, sizeLabel, fabricCode, quantity, itemM3,
             rackingNumber, packingStatus, salesOrderNo
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          id,
          item.productionOrderId,
          item.poNo,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.itemM3,
          item.rackingNumber,
          item.packingStatus,
          item.salesOrderNo,
        ),
      ),
    ];

    // Mirror the old impl: stamp the SO's hookkaDeliveryOrder so the SO view
    // knows a DO exists. We do this inside the batch so it rolls back together.
    if (salesOrderRow) {
      statements.push(
        c.var.DB.prepare(
          "UPDATE sales_orders SET hookkaDeliveryOrder = ?, updated_at = ? WHERE id = ?",
        ).bind(doNo, now, salesOrderRow.id),
      );
    }

    // Phase-4 (revised 2026-04-27): DRAFT DOs no longer lock fg_units —
    // they show up under "Reserved" on the Inventory page (still our
    // stock, just earmarked). The actual STOCK_OUT + fg_units LOADED
    // stamping moves to the DRAFT → LOADED transition in PUT below, so
    // the inventory deduction tracks the dispatch boundary (which is
    // also the invoice boundary). See the PUT handler "Phase-4 stamp on
    // dispatch" block.

    await c.var.DB.batch(statements);

    const created = await fetchOrderWithItems(c.var.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create delivery order" },
        500,
      );
    }

    // Audit emit (P3.4) — DO create. Mirrors the sales-orders pattern.
    await emitAudit(c, {
      resource: "delivery-orders",
      resourceId: id,
      action: "create",
      after: { status: "DRAFT", doNo, salesOrderId: salesOrderRow?.id ?? null },
    });

    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/delivery-orders] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating delivery order" }, 500);
  }
});

// GET /api/delivery-orders/:id/print-extras
//
// Read-only print enrichment. Returns the few fields the redesigned DO /
// Invoice printout needs that are NOT denormalised onto the DO payload,
// fetched via joins ONLY for this one DO so the (recently stabilised)
// core DO/invoice APIs are untouched:
//   - customerSO   : sales_orders.customerSOId  (via delivery_orders.salesOrderId)
//   - customerRef   : first non-empty production_orders.customerReference
//                     across the DO's items
//   - per item      : gap / divan / leg inches + computed total height,
//                     from production_orders (via di.productionOrderId)
// Registered BEFORE /:id (Hono matches routes in order).
app.get("/:id/print-extras", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const doRow = await c.var.DB.prepare(
    `SELECT id, salesOrderId, hubId, deliveryAddress, customerState,
            contactPerson, contactPhone
       FROM delivery_orders WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      salesOrderId: string | null;
      hubId: string | null;
      deliveryAddress: string | null;
      customerState: string | null;
      contactPerson: string | null;
      contactPhone: string | null;
    }>();
  if (!doRow) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  let customerSO = "";
  if (doRow.salesOrderId) {
    const so = await c.var.DB.prepare(
      "SELECT customerSOId FROM sales_orders WHERE id = ?",
    )
      .bind(doRow.salesOrderId)
      .first<{ customerSOId: string | null }>();
    customerSO = so?.customerSOId ?? "";
  }

  // Deliver-To address MUST follow the hub the DO is assigned to — a
  // customer can have several hubs (KL, Penang, ...) each with its own
  // address. delivery_orders.deliveryAddress is a create-time snapshot
  // that can disagree with the chosen hub (operator report: DO tagged
  // "KL" but printed the Penang address). Resolve the authoritative
  // address from delivery_hubs by hubId; fall back to the stored value
  // only when the DO has no hub.
  let deliverTo = "";
  let deliveryAddress = doRow.deliveryAddress ?? "";
  let hubState = doRow.customerState ?? "";
  let hubContactName = doRow.contactPerson ?? "";
  let hubContactPhone = doRow.contactPhone ?? "";
  if (doRow.hubId) {
    const hub = await c.var.DB.prepare(
      `SELECT shortName, address, state, contactName, phone
         FROM delivery_hubs WHERE id = ?`,
    )
      .bind(doRow.hubId)
      .first<{
        shortName: string | null;
        address: string | null;
        state: string | null;
        contactName: string | null;
        phone: string | null;
      }>();
    if (hub) {
      deliverTo = hub.shortName ?? "";
      if (hub.address) deliveryAddress = hub.address;
      if (hub.state) hubState = hub.state;
      if (hub.contactName) hubContactName = hub.contactName;
      if (hub.phone) hubContactPhone = hub.phone;
    }
  }

  // Resolve per line from TWO independent paths and prefer whichever
  // has data:
  //   (a) production order  — via di.productionOrderId (can be NULL on
  //       consolidated multi-SO DOs, which is why the old single-path
  //       query printed everything blank).
  //   (b) sales order       — via di.salesOrderNo = sales_orders.companySOId
  //       (the same path the on-screen items table uses, always present).
  const itRes = await c.var.DB.prepare(
    `SELECT di.id,
            di.salesOrderNo AS diSalesOrderNo,
            di.productCode,
            di.fabricCode,
            di.sizeLabel,
            di.quantity,
            po.customerReference AS customerReference,
            po.customerPOId AS customerPOId,
            po.itemCategory AS itemCategory,
            po.salesOrderNo AS salesOrderNo,
            po.companySOId AS companySOId,
            po.salesOrderId AS salesOrderId,
            po.specialOrder AS specialOrder,
            po.gapInches AS gapInches,
            po.divanHeightInches AS divanHeightInches,
            po.legHeightInches AS legHeightInches,
            poso.customerSOId AS lineCustomerSO,
            poso.customerPO AS posoCustomerPO,
            poso.customerPOId AS posoCustomerPOId,
            poso.reference AS posoReference,
            so2.id AS soId2,
            so2.customerPO AS soCustomerPO,
            so2.customerPOId AS soCustomerPOId,
            so2.customerSOId AS soCustomerSO,
            so2.reference AS soReference
       FROM delivery_order_items di
       LEFT JOIN production_orders po ON po.id = di.productionOrderId
       LEFT JOIN sales_orders poso ON poso.id = po.salesOrderId
       LEFT JOIN sales_orders so2
              ON so2.companySOId = di.salesOrderNo
              OR so2.companySO = di.salesOrderNo
      WHERE di.deliveryOrderId = ?`,
  )
    .bind(id)
    .all<{
      id: string;
      diSalesOrderNo: string | null;
      productCode: string | null;
      fabricCode: string | null;
      sizeLabel: string | null;
      quantity: number | null;
      customerReference: string | null;
      customerPOId: string | null;
      itemCategory: string | null;
      salesOrderNo: string | null;
      companySOId: string | null;
      salesOrderId: string | null;
      specialOrder: string | null;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      lineCustomerSO: string | null;
      posoCustomerPO: string | null;
      posoCustomerPOId: string | null;
      posoReference: string | null;
      soId2: string | null;
      soCustomerPO: string | null;
      soCustomerPOId: string | null;
      soCustomerSO: string | null;
      soReference: string | null;
    }>();

  // Spec fallback: many production_orders rows (older cascades / imports)
  // never got itemCategory + divan/leg/gap/special copied from the SO
  // line, so they read null and the DO printed a blank "OTHER" block.
  // The customer-facing source of truth is sales_order_items. Pull the
  // SO-line spec and prefer it ONLY where the production order is null —
  // keyed by (salesOrderId, productCode, sizeCode, fabricCode): an
  // identical SKU config always carries the same build spec, so this is
  // safe even when it isn't the exact same line.
  const soIds = Array.from(
    new Set(
      (itRes.results ?? [])
        .flatMap((r) => [r.salesOrderId || "", r.soId2 || ""])
        .filter(Boolean),
    ),
  );
  type SpecVal = {
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    specialOrder: string | null;
  };
  // Two granularities so a tiny size/fabric-label mismatch between the
  // DO line and the SO line still recovers the spec: exact first, then
  // a looser SO+productCode bucket.
  const soiTight = new Map<string, SpecVal>();
  const soiLoose = new Map<string, SpecVal>();
  const mergeInto = (map: Map<string, SpecVal>, k: string, s: SpecVal) => {
    const prev = map.get(k);
    map.set(k, {
      itemCategory: prev?.itemCategory ?? s.itemCategory ?? null,
      gapInches: prev?.gapInches ?? s.gapInches ?? null,
      divanHeightInches: prev?.divanHeightInches ?? s.divanHeightInches ?? null,
      legHeightInches: prev?.legHeightInches ?? s.legHeightInches ?? null,
      specialOrder: prev?.specialOrder ?? s.specialOrder ?? null,
    });
  };
  if (soIds.length > 0) {
    const ph = soIds.map(() => "?").join(",");
    const soiRes = await c.var.DB.prepare(
      `SELECT salesOrderId, productCode, fabricCode, sizeLabel,
              itemCategory, gapInches, divanHeightInches,
              legHeightInches, specialOrder
         FROM sales_order_items
        WHERE salesOrderId IN (${ph})`,
    )
      .bind(...soIds)
      .all<{
        salesOrderId: string | null;
        productCode: string | null;
        fabricCode: string | null;
        sizeLabel: string | null;
        itemCategory: string | null;
        gapInches: number | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        specialOrder: string | null;
      }>();
    for (const s of soiRes.results ?? []) {
      const sv: SpecVal = {
        itemCategory: s.itemCategory ?? null,
        gapInches: s.gapInches ?? null,
        divanHeightInches: s.divanHeightInches ?? null,
        legHeightInches: s.legHeightInches ?? null,
        specialOrder: s.specialOrder ?? null,
      };
      mergeInto(
        soiTight,
        `${s.salesOrderId || ""}|${s.productCode || ""}|${s.fabricCode || ""}|${s.sizeLabel || ""}`,
        sv,
      );
      mergeInto(
        soiLoose,
        `${s.salesOrderId || ""}|${s.productCode || ""}`,
        sv,
      );
    }
  }

  // Piece breakdown straight from the product BOM (the same source
  // production uses): bom_templates.wipComponents -> breakBomIntoWips.
  // So a Queen/King DIVAN node already carries its real qty and a sofa
  // is its set of WIP pieces — no size guessing.
  const codes = Array.from(
    new Set(
      (itRes.results ?? [])
        .map((r) => (r.productCode || "").trim())
        .filter(Boolean),
    ),
  );
  const bomByCode = new Map<
    string,
    { wipComponents: string | null; baseModel: string | null }
  >();
  if (codes.length > 0) {
    const ph = codes.map(() => "?").join(",");
    const bomRes = await c.var.DB.prepare(
      `SELECT productCode, baseModel, wipComponents, versionStatus, effectiveFrom
         FROM bom_templates WHERE productCode IN (${ph})`,
    )
      .bind(...codes)
      .all<{
        productCode: string | null;
        baseModel: string | null;
        wipComponents: string | null;
        versionStatus: string | null;
        effectiveFrom: string | null;
      }>();
    const best = new Map<
      string,
      {
        wipComponents: string | null;
        baseModel: string | null;
        active: boolean;
        eff: string;
      }
    >();
    for (const b of bomRes.results ?? []) {
      const pc = (b.productCode || "").trim();
      if (!pc) continue;
      const active = (b.versionStatus || "").toUpperCase() === "ACTIVE";
      const eff = b.effectiveFrom || "";
      const prev = best.get(pc);
      // Prefer ACTIVE, then the latest effectiveFrom.
      const better =
        !prev ||
        (active && !prev.active) ||
        (active === prev.active && eff > prev.eff);
      if (better)
        best.set(pc, {
          wipComponents: b.wipComponents,
          baseModel: b.baseModel,
          active,
          eff,
        });
    }
    for (const [pc, v] of best)
      bomByCode.set(pc, {
        wipComponents: v.wipComponents,
        baseModel: v.baseModel,
      });
  }
  // Reliable customer PO / SO / Ref via the SALES ORDER — the same path
  // the on-screen items table uses. The arbitrary multi-join aliases
  // (poso.customerSOId / so2.customerSOId …) don't round-trip the
  // Postgres compat layer, so customerSO came back blank even when it
  // exists. Resolve from a clean sales_orders query keyed by SO no. / id.
  const diSoById = new Map<string, string>();
  {
    const diRes = await c.var.DB.prepare(
      "SELECT id, salesOrderNo FROM delivery_order_items WHERE deliveryOrderId = ?",
    )
      .bind(id)
      .all<{ id: string; salesOrderNo: string | null }>();
    for (const dr of diRes.results ?? [])
      if (dr.id) diSoById.set(dr.id, dr.salesOrderNo || "");
  }
  const soKeys = Array.from(
    new Set(
      (itRes.results ?? [])
        .flatMap((r) => [
          r.salesOrderNo || "",
          r.companySOId || "",
          r.salesOrderId || "",
          diSoById.get(r.id) || "",
        ])
        .filter(Boolean),
    ),
  );
  type SoRef = {
    customerPO: string | null;
    customerSO: string | null;
    reference: string | null;
  };
  const soRef = new Map<string, SoRef>();
  if (soKeys.length > 0) {
    const ph = soKeys.map(() => "?").join(",");
    const soRes = await c.var.DB.prepare(
      `SELECT id, companySO, companySOId, customerPO, customerSOId, reference
         FROM sales_orders
        WHERE companySOId IN (${ph}) OR companySO IN (${ph}) OR id IN (${ph})`,
    )
      .bind(...soKeys, ...soKeys, ...soKeys)
      .all<{
        id: string | null;
        companySO: string | null;
        companySOId: string | null;
        customerPO: string | null;
        customerSOId: string | null;
        reference: string | null;
      }>();
    for (const s of soRes.results ?? []) {
      const v: SoRef = {
        customerPO: s.customerPO ?? null,
        customerSO: s.customerSOId ?? null,
        reference: s.reference ?? null,
      };
      for (const k of [s.companySOId, s.companySO, s.id])
        if (k) soRef.set(k, v);
    }
  }

  // Per-line set composition string, e.g. "1 HB + 2 DIVAN" (bedframe)
  // or "1 1A + 1 2A + 1 STOOL" (sofa set). Mirrors production-builder's
  // headboard-only / divan-only filters. null when there's no real BOM.
  const piecesFor = (
    code: string,
    baseModel: string | null,
    wipComponents: string | null,
    cat: string | null,
    special: string | null,
    sizeLabel: string,
    fabricCode: string,
    g: number | null,
    d: number | null,
    l: number | null,
    qty: number,
  ): string | null => {
    const C = (cat || "").toUpperCase();
    const cu = code.toUpperCase();
    const isBedframe = C === "BEDFRAME" || cu.startsWith("DIVAN");
    // A sofa "1A" / a stool / an accessory IS one finished set — it is
    // NOT broken into Base / Cushion / Arm WIP pieces on a delivery
    // order. Count it as its own FG unit, labelled by its variant so
    // the roll-up can list "2 1A(LHF) + 1 STOOL".
    if (!isBedframe) {
      // Label by the sofa TYPE (product-code variant, e.g. "1A(LHF)",
      // "STOOL") — that's what "一套沙发" means — not the seat size.
      const dash = code.indexOf("-");
      const variant =
        (dash >= 0 ? code.slice(dash + 1).trim() : "") ||
        (sizeLabel && sizeLabel.trim()) ||
        code ||
        "SET";
      return `${qty || 1} ${variant}`;
    }
    if (!wipComponents) return null;
    const variants: BomVariantContext = {
      productCode: code,
      model: baseModel || code,
      sizeLabel,
      sizeCode: "",
      fabricCode,
      divanHeightInches: d,
      legHeightInches: l,
      gapInches: g,
    };
    let wips = breakBomIntoWips(wipComponents, code, variants);
    if (wips.length === 1 && wips[0].wipCode === "FG_MAIN") return null;
    // What actually ships = what reaches PACKING. Count only the WIPs
    // that have a PACKING process so the figure matches the loaded
    // pieces ("packing 有多少东西就是多少东西"). Keep all if the BOM
    // never marks packing (don't zero the line out).
    const packed = wips.filter((w) =>
      (w.processes || []).some(
        (p) => String(p.deptCode || "").toUpperCase() === "PACKING",
      ),
    );
    if (packed.length) wips = packed;
    if (cu.startsWith("DIVAN")) {
      wips = wips.filter((w) => w.wipType.toUpperCase() === "DIVAN");
    } else if (C === "BEDFRAME" && isHeadboardOnlySpecial(special)) {
      wips = wips.filter((w) => w.wipType.toUpperCase() !== "DIVAN");
    }
    if (wips.length === 0) return null;
    const agg = new Map<string, number>();
    const order: string[] = [];
    for (const w of wips) {
      const t = w.wipType.toUpperCase();
      const label =
        t === "HEADBOARD"
          ? "HB"
          : t === "DIVAN"
            ? "DIVAN"
            : (w.wipLabel || w.wipType || "PC").trim();
      if (!agg.has(label)) order.push(label);
      agg.set(
        label,
        (agg.get(label) || 0) +
          (Number(w.quantityMultiplier) || 1) * (qty || 1),
      );
    }
    return order.map((lab) => `${agg.get(lab)} ${lab}`).join(" + ");
  };

  let customerRef = "";
  const items: Record<
    string,
    {
      itemCategory: string | null;
      customerPOId: string | null;
      customerSO: string | null;
      customerRef: string | null;
      salesOrderNo: string | null;
      specialOrder: string | null;
      pieces: string | null;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
    }
  > = {};
  for (const r of itRes.results ?? []) {
    const soId = r.salesOrderId || r.soId2 || "";
    const pc = r.productCode || "";
    const fc = r.fabricCode || "";
    const sl = r.sizeLabel || "";
    const fb =
      soiTight.get(`${soId}|${pc}|${fc}|${sl}`) ||
      soiLoose.get(`${soId}|${pc}`);
    // production order first; sales-order line fills every blank.
    const g = r.gapInches ?? fb?.gapInches ?? null;
    const d = r.divanHeightInches ?? fb?.divanHeightInches ?? null;
    const l = r.legHeightInches ?? fb?.legHeightInches ?? null;
    const itemCategory = r.itemCategory ?? fb?.itemCategory ?? null;
    const specialOrder = r.specialOrder ?? fb?.specialOrder ?? null;
    const soNo = r.salesOrderNo || r.companySOId || diSoById.get(r.id) || "";
    const sr =
      soRef.get(soNo) ||
      soRef.get(r.salesOrderId || "") ||
      soRef.get(r.companySOId || "");
    const customerPOId = r.customerPOId || sr?.customerPO || null;
    const customerSO = sr?.customerSO || null;
    const customerRefLine =
      r.customerReference || sr?.reference || null;
    if (!customerRef && customerRefLine) customerRef = customerRefLine;
    const total =
      g == null && d == null && l == null
        ? null
        : (Number(g) || 0) + (Number(d) || 0) + (Number(l) || 0);
    const bom = bomByCode.get((r.productCode || "").trim());
    const pieces = bom
      ? piecesFor(
          r.productCode || "",
          bom.baseModel,
          bom.wipComponents,
          itemCategory,
          specialOrder,
          r.sizeLabel || "",
          r.fabricCode || "",
          g,
          d,
          l,
          Number(r.quantity) || 1,
        )
      : null;
    items[r.id] = {
      itemCategory,
      customerPOId,
      customerSO,
      customerRef: customerRefLine,
      salesOrderNo: soNo || null,
      specialOrder,
      pieces,
      gapInches: g,
      divanHeightInches: d,
      legHeightInches: l,
      totalHeightInches: total,
    };
  }
  return c.json({
    success: true,
    data: {
      customerSO,
      customerRef,
      deliverTo,
      deliveryAddress,
      hubState,
      hubContactName,
      hubContactPhone,
      items,
    },
  });
});

// GET /api/delivery-orders/:id — single
app.get("/:id", async (c) => {
  // RBAC gate — single-record reads also require delivery-orders:read.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const id = c.req.param("id");
  const order = await fetchOrderWithItems(c.var.DB, id);
  if (!order) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  // Lock status (Invoice exists?) — surfaced to the DO detail page so the
  // edit form can disable + render a "locked because Invoice X exists" banner.
  const lockReason = await checkDeliveryOrderLocked(c.var.DB, id);
  return c.json({ success: true, data: order, lockReason });
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
  try {
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
    // Cascade lock — once an Invoice references this DO, the DO becomes
    // read-only (its line items are already on the customer's bill).
    // Status-only transitions to CANCELLED still go through here, but
    // those are gated by other guards below; the lock only fires for
    // edits that touch items / quantities / customer / driver.
    const lockMsg = await checkDeliveryOrderLocked(c.var.DB, id);
    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.items &&
      !body.customerId &&
      !body.driverId &&
      !body.vehicleId &&
      !body.deliveryDate;
    if (lockMsg && !isStatusOnly) {
      return c.json(lockedResponse(lockMsg), 403);
    }
    const now = new Date().toISOString();

    // --- status transition validation (same rules as mock-data) ---
    let nextStatus: string = existing.status;
    let nextDispatchedAt: string | null = existing.dispatchedAt;
    let nextDeliveredAt: string | null = existing.deliveredAt;
    let nextOverdue: string | null = existing.overdue;

    if (body.status && body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status];
      if (!allowed || !allowed.includes(body.status)) {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${existing.status} → ${body.status}. Allowed transitions from ${existing.status}: ${allowed?.join(", ") || "none"}`,
          },
          400,
        );
      }
      nextStatus = body.status;
      if (nextStatus === "LOADED") nextDispatchedAt = now;
      if (nextStatus === "DRAFT") nextDispatchedAt = null;
      if (nextStatus === "IN_TRANSIT" && !nextDispatchedAt)
        nextDispatchedAt = now;
      if (nextStatus === "DELIVERED") {
        // prefer pod timestamp if provided, otherwise stamp now
        const podAt =
          body.proofOfDelivery?.deliveredAt ?? existing.deliveredAt ?? now;
        nextDeliveredAt = podAt;
        nextOverdue = "COMPLETED";
        // FIFO FG_DELIVERED COGS is emitted inside the cascadedToDelivered
        // block below so it rides the same atomic batch as the UPDATE.
      }
      if (nextStatus === "INVOICED") {
        nextOverdue = "INVOICED";
      }
    }

    // --- proof of delivery blob ---
    let nextProofOfDelivery: string | null = existing.proofOfDelivery;
    if (body.proofOfDelivery) {
      const pod = body.proofOfDelivery;
      nextProofOfDelivery = JSON.stringify({
        receiverName: pod.receiverName ?? "",
        receiverIC: pod.receiverIC ?? "",
        signatureDataUrl: pod.signatureDataUrl ?? "",
        photoDataUrls: Array.isArray(pod.photoDataUrls)
          ? pod.photoDataUrls.slice(0, 5)
          : [],
        remarks: pod.remarks ?? "",
        deliveredAt: pod.deliveredAt ?? now,
        capturedBy: pod.capturedBy ?? "",
      });
    }

    // --- simple field merges ---
    // The driverId column on delivery_orders historically meant "company id"
    // and stays semantically the same after the 3PL refactor. Callers can
    // pass providerId (preferred) or driverId (legacy alias for the company)
    // to update it; the new vehicleId / driverPhone / vehicleType columns
    // travel separately. See the lookup chain further down.
    const merged = {
      deliveryDate:
        body.deliveryDate === undefined
          ? existing.deliveryDate
          : body.deliveryDate,
      driverId:
        body.providerId !== undefined
          ? body.providerId
          : body.driverId === undefined
            ? existing.driverId
            : body.driverId,
      driverName:
        body.driverName === undefined
          ? existing.driverName
          : body.driverName,
      driverContactPerson:
        body.driverContactPerson === undefined
          ? existing.driverContactPerson
          : body.driverContactPerson,
      driverPhone:
        body.driverPhone === undefined
          ? existing.driverPhone
          : body.driverPhone,
      vehicleId:
        body.vehicleId === undefined ? existing.vehicleId : body.vehicleId,
      vehicleNo:
        body.vehicleNo === undefined ? existing.vehicleNo : body.vehicleNo,
      vehicleType:
        body.vehicleType === undefined
          ? existing.vehicleType
          : body.vehicleType,
      deliveryAddress:
        body.deliveryAddress === undefined
          ? existing.deliveryAddress
          : body.deliveryAddress,
      contactPerson:
        body.contactPerson === undefined
          ? existing.contactPerson
          : body.contactPerson,
      contactPhone:
        body.contactPhone === undefined
          ? existing.contactPhone
          : body.contactPhone,
      remarks: body.remarks === undefined ? existing.remarks : body.remarks,
      dropPoints:
        body.dropPoints === undefined
          ? existing.dropPoints
          : Number(body.dropPoints) || 1,
      deliveryCostSen:
        body.deliveryCostSen === undefined
          ? existing.deliveryCostSen
          : Number(body.deliveryCostSen) || 0,
      lorryId: body.lorryId === undefined ? existing.lorryId : body.lorryId,
      lorryName:
        body.lorryName === undefined ? existing.lorryName : body.lorryName,
    };

    // --- lorry lookup: if a new lorryId is provided, pick up driver/plate ---
    if (body.lorryId !== undefined && body.lorryId) {
      const lorry = await c.var.DB.prepare(
        "SELECT id, name, plateNumber, driverName FROM lorries WHERE id = ?",
      )
        .bind(body.lorryId)
        .first<{
          id: string;
          name: string;
          plateNumber: string | null;
          driverName: string | null;
        }>();
      if (lorry) {
        merged.lorryId = lorry.id;
        merged.lorryName = lorry.name;
        merged.driverName = lorry.driverName ?? merged.driverName;
        merged.vehicleNo = lorry.plateNumber ?? merged.vehicleNo;
      }
    } else if (body.lorryId === null) {
      merged.lorryId = null;
      merged.lorryName = "";
    }

    // --- 3PL refactor lookup chain (provider + vehicle + driver person) ---
    //
    // body.providerId — preferred field for the COMPANY id (legacy
    //   `drivers` table). body.driverId is also accepted for backcompat
    //   when it resolves to a `drivers` row (pre-refactor mutation
    //   contract treated driverId as the company id).
    // body.vehicleId  — three_pl_vehicles row. Per-vehicle rates take
    //   precedence over company rates for deliveryCostSen recompute.
    // body.driverId   — when it resolves in `three_pl_drivers`, sets
    //   driverName + driverPhone for the actual person. Otherwise we
    //   treat it as a legacy company id (see above).
    const incomingDriverId =
      body.driverId !== undefined ? body.driverId : null;
    let incomingProviderId =
      body.providerId !== undefined ? body.providerId : null;

    // Resolve the driver-person side first (so we can detect the legacy
    // "driverId == company id" case and not stamp it onto driverName).
    if (incomingDriverId) {
      const person = await c.var.DB.prepare(
        "SELECT id, providerId, name, phone FROM three_pl_drivers WHERE id = ?",
      )
        .bind(incomingDriverId)
        .first<{
          id: string;
          providerId: string;
          name: string;
          phone: string | null;
        }>();
      if (person) {
        merged.driverName = person.name;
        merged.driverPhone = person.phone ?? "";
        if (!incomingProviderId && merged.driverId !== person.providerId) {
          // Auto-fill provider from the driver's parent if caller didn't
          // pass one (keeps the DO row consistent).
          incomingProviderId = person.providerId;
          merged.driverId = person.providerId;
        }
      } else {
        // Backcompat: driverId may be a legacy COMPANY id from the
        // pre-refactor contract — only treat it as such if no providerId
        // was passed explicitly.
        const legacyProvider = await c.var.DB.prepare(
          "SELECT id FROM drivers WHERE id = ?",
        )
          .bind(incomingDriverId)
          .first<{ id: string }>();
        if (legacyProvider && !incomingProviderId) {
          incomingProviderId = legacyProvider.id;
          merged.driverId = legacyProvider.id;
        }
      }
    }

    // Provider (company) lookup — denormalize name + dispatcher contact.
    // Only triggers when the caller actively touched the provider field
    // this PUT (so editing unrelated fields doesn't overwrite the stored
    // company name/contact silently).
    if (incomingProviderId) {
      const provider = await c.var.DB.prepare(
        "SELECT id, name, vehicleNo, contactPerson, ratePerTripSen, ratePerExtraDropSen FROM drivers WHERE id = ?",
      )
        .bind(incomingProviderId)
        .first<{
          id: string;
          name: string;
          vehicleNo: string | null;
          contactPerson: string | null;
          ratePerTripSen: number;
          ratePerExtraDropSen: number;
        }>();
      if (provider) {
        // Don't clobber a person's name if one was just resolved above.
        if (!incomingDriverId || merged.driverName === existing.driverName) {
          merged.driverName = merged.driverName || provider.name;
        }
        merged.driverContactPerson = provider.contactPerson ?? "";
        if (
          !merged.vehicleId &&
          provider.vehicleNo &&
          (body.vehicleNo === undefined || !merged.vehicleNo)
        ) {
          merged.vehicleNo = provider.vehicleNo;
        }
        if (!merged.vehicleId && body.deliveryCostSen === undefined) {
          const drops = merged.dropPoints ?? 1;
          merged.deliveryCostSen =
            provider.ratePerTripSen +
            Math.max(0, drops - 1) * provider.ratePerExtraDropSen;
        }
      }
    }

    // Vehicle lookup — plate + type + per-vehicle rate (overrides company rate).
    if (body.vehicleId !== undefined && body.vehicleId) {
      const vehicle = await c.var.DB.prepare(
        "SELECT id, plateNo, vehicleType, ratePerTripSen, ratePerExtraDropSen FROM three_pl_vehicles WHERE id = ?",
      )
        .bind(body.vehicleId)
        .first<{
          id: string;
          plateNo: string;
          vehicleType: string | null;
          ratePerTripSen: number;
          ratePerExtraDropSen: number;
        }>();
      if (vehicle) {
        merged.vehicleId = vehicle.id;
        merged.vehicleNo = vehicle.plateNo;
        merged.vehicleType = vehicle.vehicleType ?? "";
        if (body.deliveryCostSen === undefined) {
          const drops = merged.dropPoints ?? 1;
          merged.deliveryCostSen =
            vehicle.ratePerTripSen +
            Math.max(0, drops - 1) * vehicle.ratePerExtraDropSen;
        }
      }
    } else if (body.vehicleId === null) {
      merged.vehicleId = null;
      merged.vehicleType = "";
    }

    // --- totals recomputed only if items replaced ---
    let newItems:
      | Array<ReturnType<typeof itemFromBody>>
      | null = null;
    function itemFromBody(item: Record<string, unknown>) {
      return {
        id: (item.id as string) || genDoItemId(),
        productionOrderId: (item.productionOrderId as string) || "",
        salesOrderNo: (item.salesOrderNo as string) || "",
        poNo: (item.poNo as string) || "",
        productCode: (item.productCode as string) || "",
        productName: (item.productName as string) || "",
        sizeLabel: (item.sizeLabel as string) || "",
        fabricCode: (item.fabricCode as string) || "",
        quantity: Number(item.quantity) || 0,
        itemM3: Number(item.itemM3) || 0,
        rackingNumber: (item.rackingNumber as string) || "",
        packingStatus: (item.packingStatus as string) || "PACKED",
      };
    }
    let nextTotalM3 = existing.totalM3;
    let nextTotalItems = existing.totalItems;
    if (Array.isArray(body.items)) {
      newItems = (body.items as Array<Record<string, unknown>>).map(itemFromBody);
      nextTotalM3 =
        Math.round(
          newItems.reduce((s, i) => s + i.itemM3 * i.quantity, 0) * 100,
        ) / 100;
      nextTotalItems = newItems.reduce((s, i) => s + i.quantity, 0);
    }

    // --- batch the update + optional items replacement ---
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `UPDATE delivery_orders SET
           deliveryDate = ?, driverId = ?, driverName = ?,
           driverContactPerson = ?, driverPhone = ?, vehicleId = ?,
           vehicleNo = ?, vehicleType = ?,
           deliveryAddress = ?, contactPerson = ?, contactPhone = ?,
           remarks = ?, dropPoints = ?, deliveryCostSen = ?, lorryId = ?,
           lorryName = ?, status = ?, overdue = ?, dispatchedAt = ?,
           deliveredAt = ?, proofOfDelivery = ?, totalM3 = ?, totalItems = ?,
           updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.deliveryDate,
        merged.driverId,
        merged.driverName,
        merged.driverContactPerson,
        // Migration 0063 made driverPhone / vehicleId / vehicleType NOT NULL
        // DEFAULT ''. The create path already coerces these to '' (see the
        // INSERT bind); the edit path did not, so saving a DO with no vehicle
        // (Vehicle = "Optional") sent a literal null and tripped the
        // "vehicle_id violates not-null constraint" error. Coerce to '' here
        // too so an unselected driver/vehicle becomes the documented default.
        merged.driverPhone ?? "",
        merged.vehicleId ?? "",
        merged.vehicleNo,
        merged.vehicleType ?? "",
        merged.deliveryAddress,
        merged.contactPerson,
        merged.contactPhone,
        merged.remarks,
        merged.dropPoints,
        merged.deliveryCostSen,
        merged.lorryId,
        merged.lorryName,
        nextStatus,
        nextOverdue,
        nextDispatchedAt,
        nextDeliveredAt,
        nextProofOfDelivery,
        nextTotalM3,
        nextTotalItems,
        now,
        id,
      ),
    ];

    // Wei Siang 2026-05-16: invoice-number collision guard. The
    // auto-DRAFT-invoice on DELIVERED uses nextInvoiceNo() (read-MAX
    // +1). Even with the frontend serialized, the SELECT can lag the
    // previous batch's commit under the Hyperdrive/Supabase pooler →
    // two DOs compute the same INV-YYMM-NNN → ux_invoices_invoice_no
    // violation rolls the whole DO→DELIVERED back ("N of M failed").
    // We track the invoice INSERT so the batch can be retried with a
    // freshly-regenerated number (by retry time the conflicting row
    // is definitely visible). Stays NULL when no invoice is created.
    let invoiceStmtIdx = -1;
    let rebuildInvoiceInsert: ((no: string) => D1PreparedStatement) | null =
      null;

    if (newItems !== null) {
      statements.push(
        c.var.DB.prepare(
          "DELETE FROM delivery_order_items WHERE deliveryOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO delivery_order_items (
               id, deliveryOrderId, productionOrderId, poNo, productCode,
               productName, sizeLabel, fabricCode, quantity, itemM3,
               rackingNumber, packingStatus, salesOrderNo
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.productionOrderId,
            item.poNo,
            item.productCode,
            item.productName,
            item.sizeLabel,
            item.fabricCode,
            item.quantity,
            item.itemM3,
            item.rackingNumber,
            item.packingStatus,
            item.salesOrderNo,
          ),
        );
      }
    }

    // -------------------------------------------------------------------
    // Phase-4 stamp on dispatch (DRAFT → LOADED, added 2026-04-27):
    // This is the inventory boundary — until now the PO is "Reserved"
    // (still our stock, no invoice yet); flipping to LOADED is the
    // moment we mark fg_units LOADED and write a STOCK_OUT so the
    // Inventory page's Available count drops. Mirrors the old POST-time
    // logic, just deferred to the dispatch event.
    // -------------------------------------------------------------------
    const stampedOnDispatch =
      existing.status === "DRAFT" && nextStatus === "LOADED";
    if (stampedOnDispatch) {
      // Source POs come from the items array — either freshly-replaced
      // (newItems) or the existing delivery_order_items rows.
      const itemPoIds = newItems
        ? newItems.map((i) => i.productionOrderId).filter(Boolean)
        : (
            await c.var.DB.prepare(
              `SELECT productionOrderId FROM delivery_order_items
                 WHERE deliveryOrderId = ?`,
            )
              .bind(id)
              .all<{ productionOrderId: string | null }>()
          ).results?.map((r) => r.productionOrderId).filter(
            (s): s is string => !!s,
          ) ?? [];
      if (itemPoIds.length > 0) {
        const ph = itemPoIds.map(() => "?").join(",");
        const poRows =
          (
            await c.var.DB.prepare(
              `SELECT id, productCode, productName, quantity, rackingNumber
                 FROM production_orders WHERE id IN (${ph})`,
            )
              .bind(...itemPoIds)
              .all<{
                id: string;
                productCode: string | null;
                productName: string | null;
                quantity: number | null;
                rackingNumber: string | null;
              }>()
          ).results ?? [];
        for (const po of poRows) {
          statements.push(
            c.var.DB.prepare(
              // CN-side dispatch (consignment-note-shared.ts:807) stamps
              // cnId on units when goods leave for a consignment customer.
              // Without the cnId-NULL guard here, a sibling DO POST would
              // STEAL a unit already LOADED onto a CN — fg_units row
              // becomes "doId set, cnId set, status overwritten" with
              // both downstream docs claiming the same physical unit.
              `UPDATE fg_units
                  SET doId = ?, status = 'LOADED', loadedAt = ?
                WHERE poId = ?
                  AND (doId IS NULL OR doId = '')
                  AND (cnId IS NULL OR cnId = '')`,
            ).bind(id, now, po.id),
            c.var.DB.prepare(
              `INSERT INTO stock_movements (
                 id, type, rackLocationId, rackLabel, productionOrderId,
                 productCode, productName, quantity, reason, performedBy,
                 created_at
               ) VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
            ).bind(
              `mov-${crypto.randomUUID().slice(0, 8)}`,
              null,
              po.rackingNumber ?? "",
              po.id,
              po.productCode ?? "",
              po.productName ?? "",
              Number(po.quantity) || 0,
              `DO ${existing.doNo} dispatched`,
              now,
            ),
          );
        }

        // BUG-2026-04-30-003: removed wip_items decrement. The UPH +N
        // subtract is now performed at UPH-all-done in
        // applyWipInventoryChange (production-orders.ts, Plan B branch),
        // mirroring the frontend `deriveFGStock` rule. By the time DO
        // reaches LOADED, wip_items has already been zeroed for these
        // UPH labels — so the dispatch-time decrement is redundant and
        // would now drive stockQty negative. DO LOADED only updates
        // fg_units / stock_movements now (formerly BUG-2026-04-27-021).
      }
    }

    // -------------------------------------------------------------------
    // Wei Siang 2026-05-16: SO status cascade on dispatch.
    // DRAFT → LOADED = goods left the warehouse = "dispatched". The SO
    // is no longer Outstanding (operator's definition: dispatched =
    // sent out). Flip every READY_TO_SHIP SO this DO touches →
    // SHIPPED. Multi-SO DOs handled via resolveDoSalesOrderIds.
    // Guard: only READY_TO_SHIP advances (matches sales-orders.ts
    // VALID_TRANSITIONS READY_TO_SHIP → SHIPPED); SOs already
    // DELIVERED/INVOICED/CLOSED or still IN_PRODUCTION are left alone.
    // -------------------------------------------------------------------
    if (stampedOnDispatch) {
      const soIds = await resolveDoSalesOrderIds(
        c.var.DB,
        id,
        existing.salesOrderId,
      );
      for (const soId of soIds) {
        const soRow = await c.var.DB.prepare(
          "SELECT id, status FROM sales_orders WHERE id = ?",
        )
          .bind(soId)
          .first<{ id: string; status: string }>();
        if (soRow && soRow.status === "READY_TO_SHIP") {
          statements.push(
            c.var.DB.prepare(
              "UPDATE sales_orders SET status = 'SHIPPED', updated_at = ? WHERE id = ?",
            ).bind(now, soRow.id),
            c.var.DB.prepare(
              `INSERT INTO so_status_changes
                 (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              genStatusChangeId(),
              soRow.id,
              soRow.status,
              "SHIPPED",
              "System",
              now,
              "DO dispatched",
              JSON.stringify([`DO ${existing.doNo} dispatched (LOADED)`]),
            ),
          );
        }
      }
    }

    // -------------------------------------------------------------------
    // Reversal on LOADED → DRAFT transition (phase-4 finish, 2026-04-26):
    // unstamp fg_units that were marked LOADED + tied to this DO when the
    // operator reopens the DO for editing. Without this, units stay
    // wedged in 'LOADED' state with an obsolete doId pointer and the
    // warehouse view double-counts them. Audit rows in stock_movements
    // are intentionally NOT deleted — those are immutable history; we
    // append a STOCK_IN counter-movement instead so the racking ledger
    // shows the round-trip.
    // -------------------------------------------------------------------
    const revertedToDraft =
      existing.status === "LOADED" && nextStatus === "DRAFT";
    if (revertedToDraft) {
      const stampedPosRes = await c.var.DB.prepare(
        `SELECT DISTINCT poId FROM fg_units WHERE doId = ?`,
      )
        .bind(id)
        .all<{ poId: string }>();
      const stampedPoIds = (stampedPosRes.results ?? [])
        .map((r) => r.poId)
        .filter(Boolean);
      statements.push(
        c.var.DB.prepare(
          `UPDATE fg_units
              SET doId = NULL, status = 'PENDING', loadedAt = NULL
            WHERE doId = ?`,
        ).bind(id),
      );
      for (const poId of stampedPoIds) {
        const po = await c.var.DB.prepare(
          `SELECT id, productCode, productName, quantity, rackingNumber
             FROM production_orders WHERE id = ?`,
        )
          .bind(poId)
          .first<{
            id: string;
            productCode: string | null;
            productName: string | null;
            quantity: number | null;
            rackingNumber: string | null;
          }>();
        if (!po) continue;
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO stock_movements (
               id, type, rackLocationId, rackLabel, productionOrderId,
               productCode, productName, quantity, reason, performedBy,
               created_at
             ) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
          ).bind(
            `mov-${crypto.randomUUID().slice(0, 8)}`,
            null,
            po.rackingNumber ?? "",
            po.id,
            po.productCode ?? "",
            po.productName ?? "",
            Number(po.quantity) || 0,
            `DO ${existing.doNo} reverted to DRAFT`,
            now,
          ),
        );
      }

      // BUG-2026-04-30-003: removed wip_items re-credit on LOADED→DRAFT.
      // Forward decrement was removed (UPH +N is now subtracted at
      // UPH-all-done in applyWipInventoryChange), so the reverse credit
      // is no longer needed and would now drive stockQty positive past
      // its true balance. fg_units rollback (the unstamp loop above)
      // remains intact (formerly BUG-2026-04-27-021 reverse).
    }

    // -------------------------------------------------------------------
    // Wei Siang 2026-05-16: SO status reversal on un-dispatch.
    // LOADED → DRAFT means the operator pulled the DO back (goods
    // didn't actually leave). Any SO this DO bumped to SHIPPED must
    // drop back to READY_TO_SHIP so it re-enters Outstanding. Only
    // reverse SHIPPED — an SO already DELIVERED/INVOICED/CLOSED by a
    // different DO is left untouched.
    // -------------------------------------------------------------------
    if (revertedToDraft) {
      const soIds = await resolveDoSalesOrderIds(
        c.var.DB,
        id,
        existing.salesOrderId,
      );
      for (const soId of soIds) {
        const soRow = await c.var.DB.prepare(
          "SELECT id, status FROM sales_orders WHERE id = ?",
        )
          .bind(soId)
          .first<{ id: string; status: string }>();
        if (soRow && soRow.status === "SHIPPED") {
          statements.push(
            c.var.DB.prepare(
              "UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
            ).bind(now, soRow.id),
            c.var.DB.prepare(
              `INSERT INTO so_status_changes
                 (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              genStatusChangeId(),
              soRow.id,
              soRow.status,
              "READY_TO_SHIP",
              "System",
              now,
              "DO reverted to DRAFT",
              JSON.stringify([`DO ${existing.doNo} un-dispatched (LOADED→DRAFT)`]),
            ),
          );
        }
      }
    }

    // -------------------------------------------------------------------
    // Cascades on DELIVERED transition (E1 + E2):
    //   * fg_units.status = 'DELIVERED' for every unit linked to this DO
    //   * sales_orders.status = 'DELIVERED' + so_status_changes audit row
    //   * Auto-create a DRAFT invoice linked to this DO (idempotent — skip
    //     if any invoice already references this deliveryOrderId).
    // Everything goes into the same batch so a partial failure rolls back.
    // -------------------------------------------------------------------
    const cascadedToDelivered =
      existing.status !== "DELIVERED" && nextStatus === "DELIVERED";
    if (cascadedToDelivered) {
      // fg_units sync: flip every unit whose doId matches.
      statements.push(
        c.var.DB.prepare(
          `UPDATE fg_units SET status = 'DELIVERED', deliveredAt = ? WHERE doId = ?`,
        ).bind(nextDeliveredAt ?? now, id),
      );

      // FIFO FG_DELIVERED COGS — consume fg_batches across layers and emit
      // one cost_ledger entry per slice. Idempotent inside the helper. Uses
      // the in-memory newItems if the caller replaced items, otherwise the
      // current DB rows.
      const itemsForCogs = newItems
        ? newItems.map((i) => ({
            id: i.id,
            productCode: i.productCode,
            productName: i.productName,
            quantity: i.quantity,
          }))
        : (
            await c.var.DB.prepare(
              `SELECT id, productCode, productName, quantity
                 FROM delivery_order_items WHERE deliveryOrderId = ?`,
            )
              .bind(id)
              .all<{
                id: string;
                productCode: string | null;
                productName: string | null;
                quantity: number;
              }>()
          ).results ?? [];
      const cogs = await consumeFGBatchesForDO(
        c.var.DB,
        id,
        existing.doNo,
        itemsForCogs,
        nextDeliveredAt ?? now,
      );
      if (!cogs.skipped && cogs.statements.length > 0) {
        statements.push(...cogs.statements);
      }

      // SO status cascade + ONE combined invoice across EVERY sales
      // order this DO touches (multi-SO aware via resolveDoSalesOrderIds).
      // Replaces the old `if (existing.salesOrderId)` gate that silently
      // skipped multi-SO DOs — leaving their SOs stranded at
      // IN_PRODUCTION/READY_TO_SHIP and creating no invoice
      // (BUG-2026-05-16-005). Shared with the historical backfill.
      {
        const dc = await buildDoDeliveredSoAndInvoice(
          c.var.DB,
          existing,
          now,
        );
        if (dc.statements.length > 0) {
          const base = statements.length;
          statements.push(...dc.statements);
          if (dc.invoiceStmtIdx >= 0 && dc.rebuildInvoiceInsert) {
            invoiceStmtIdx = base + dc.invoiceStmtIdx;
            rebuildInvoiceInsert = dc.rebuildInvoiceInsert;
          }
        }
      }
    }

    // Wei Siang 2026-05-16: retry the batch on an invoice-number
    // collision. The conflicting invoice IS committed by the time we
    // catch (the other request's batch finished), so a fresh
    // nextInvoiceNo() now reads past it. Only the invoice INSERT
    // statement is swapped; everything else (fg_units, COGS, SO
    // cascade) is unchanged and idempotent under the same `existing`
    // snapshot. Cap at 5 tries so a genuinely-stuck unique error
    // still surfaces instead of looping forever.
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
            const freshNo = await nextInvoiceNo(c.var.DB);
            statements[invoiceStmtIdx] = rebuildInvoiceInsert(freshNo);
            continue;
          }
          throw e;
        }
      }
    }

    const updated = await fetchOrderWithItems(c.var.DB, id);

    // Audit emit (P3.4) — status transitions on a DO are forensic events
    // (e.g. "who marked DO-XXX delivered"). The SO cascade already writes
    // so_status_changes for the upstream SO; this gives the DO itself a
    // first-class trail. Snapshot before/after status only — full row
    // snapshots can balloon the audit table once POD blobs land.
    if (existing.status !== nextStatus) {
      await emitAudit(c, {
        resource: "delivery-orders",
        resourceId: id,
        action: "update",
        before: { status: existing.status },
        after: { status: nextStatus },
      });
    }

    return c.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/delivery-orders/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating delivery order" }, 500);
  }
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
