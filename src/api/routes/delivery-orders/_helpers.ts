// ---------------------------------------------------------------------------
// delivery-orders route — module-level helpers.
//
// Mechanically split out of src/api/routes/delivery-orders.ts (behavior-
// preserving; every declaration below is verbatim from the route module — only
// `export` prefixes, one-level-deeper relative import paths, and this header
// were added). The route module re-exports the ones external importers / tests
// depend on.
// ---------------------------------------------------------------------------

import type { Context } from "hono";
import type { Env } from "../../worker";
import { consumeFGBatchesForDO } from "../../lib/do-cost-cascade";
import { loadSoLinePriceIndex, priceForItem } from "../../lib/do-value";
import { getOrgId } from "../../lib/tenant";
import { emitAudit } from "../../lib/audit";
import { checkDeliveryOrderLocked, lockedResponse } from "../../lib/lock-helpers";
import { nextInvoiceNo, buildInvoiceLedgerLegs } from "../invoices";
import { buildJournalEntryStatements } from "../../lib/journal-hash";
import {
  selectBestBomByCode,
  piecesFor as piecesForShared,
  deriveComponentRacks,
  buildRepairNote,
  type PackingJcRow,
} from "../../lib/print-extras-shared";
import { parseRepairScope, type RepairScope } from "../../../lib/repair-scope";
import { formatRacksCompact } from "../../../lib/rack-format";
import { enqueueEmail } from "../../lib/email-outbox";
import {
  dispatchNoticeTemplate,
  invoiceNoticeTemplate,
  resolveDispatchRecipient,
  resolveInvoiceRecipient,
  fmtEmailDate,
} from "../../lib/customer-notify";
import { buildSimpleTablePdf } from "../../lib/assistant-exports";
import { buildUnifiedDocPdf } from "../../lib/unified-do-invoice-pdf";
import {
  buildUnifiedDoData,
  buildUnifiedInvoiceData,
} from "../../../lib/build-unified-doc-data";
import { HOOKKA_LOGO_PNG_BASE64 } from "../../lib/hookka-logo-base64";
import { computeInvoicePrintExtras } from "../../lib/invoice-print-extras";
import { ensureInvoicePoLinkColumn } from "../../lib/invoice-po-link";

// Status transitions allowed by the mock-data impl. Preserved here so the
// frontend sees identical error messages.
export const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["LOADED"],
  LOADED: ["DRAFT", "IN_TRANSIT", "DELIVERED"],
  IN_TRANSIT: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
};

// ---------------------------------------------------------------------------
// fireCustomerNoticeBestEffort — the BACKEND safety-net trigger for the
// customer DO/Invoice emails (BUG-2026-06-23: ZERO of 128 Houzs DOs ever
// emailed because the notice was FRONT-END-scattered — fired by a handful of
// React buttons that the dominant delivery paths (driver-sticker QR scan,
// bulk list actions, the "Generate Invoice" button, any stale FE row list)
// never reach).
//
// queueDoCustomerNotice already owns the recipient chain, the no-recipient
// silent skip, the server-rendered PDF fallback, AND the atomic idempotency
// claim (UPDATE ... WHERE dispatchEmailAt/deliveredEmailAt IS NULL). Calling
// it from the backend transition choke-point guarantees a send regardless of
// which UI/driver path drove the transition, while the same idempotency stamp
// means it never double-sends with the surviving (branded-PDF) FE trigger —
// whichever caller wins the claim sends exactly one email; the loser no-ops.
//
// Fire-and-forget: queued via executionCtx.waitUntil so a notice never blocks
// or fails (or rolls back) the already-committed transition. queueDoCustomerNotice
// swallows its own errors (returns an error Response rather than throwing), but
// we still guard with try/catch + .catch() so nothing can escape onto the
// transition's response path. Outside a Worker isolate (unit tests / local
// node) executionCtx throws on access — we fall back to letting the promise
// run detached.
// ---------------------------------------------------------------------------
export function fireCustomerNoticeBestEffort(
  c: Context<Env>,
  deliveryOrderId: string,
  kind: "DISPATCHED" | "DELIVERED",
): void {
  const run = (async () => {
    try {
      // Yield the idempotency claim to the browser first (owner 2026-07:
      // customers complained they kept getting the plain server-rendered
      // fallback PDF instead of the real branded DO/Invoice). A browser-driven
      // transition ALSO fires POST /:id/notify-customer with the REAL client
      // PDF a second or two later; without this wait the backend choke-point
      // claims the stamp first and sends the fallback, so the client's real
      // PDF is idempotency-skipped. Waiting ~10s lets the browser's real-PDF
      // send win; non-browser paths (driver QR scan, cron, bulk) have no such
      // send, so after the wait THIS still fires the fallback and the customer
      // is still notified. The wait runs inside waitUntil — it doesn't slow the
      // transition response at all.
      // eslint-disable-next-line no-restricted-syntax -- backend Worker, deferred fallback send
      await new Promise((r) => setTimeout(r, 10_000));
      const res = await queueDoCustomerNotice(c, deliveryOrderId, { kind });
      // Consume the body so the Response object never leaks.
      await res.json().catch(() => undefined);
    } catch (err) {
      console.warn(
        `[delivery-orders] ${deliveryOrderId}: backend ${kind} customer notice failed (FE trigger / cron may still cover it):`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
  try {
    const ctx = (c as unknown as {
      executionCtx?: { waitUntil(p: Promise<unknown>): void };
    }).executionCtx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(run);
      return;
    }
  } catch {
    // executionCtx getter throws outside a Worker isolate — fine, the promise
    // above is already running detached; we just don't hold the request open.
  }
  // No executionCtx — make sure a rejection can't surface as an unhandled
  // promise; the work still runs (and the 5-min outbox cron is the backstop).
  void run.catch(() => undefined);
}

export type DeliveryOrderRow = {
  id: string;
  doNo: string;
  salesOrderId: string | null;
  companySO: string | null;
  companySOId: string | null;
  customerId: string;
  customerPOId: string | null;
  customerSOId: string | null;
  customerSO: string | null;
  reference: string | null;
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
  // Runtime-added flag (ensureDeliveryIncompleteColumn). 1 = the goods were
  // physically delivered but the paperwork was incomplete (e.g. damaged
  // items returning to the office), so the auto-invoice is WITHHELD until an
  // operator resolves it. Lowercase snake_case so the unquoted-identifier
  // fold can't split read/write keys. Absent (undefined) on rows read before
  // the ALTER lands → treated as 0.
  delivery_incomplete?: number | null;
};

export type DeliveryOrderItemRow = {
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

// Per-SO customer identifiers, keyed by the SO number (companySOId, e.g.
// "SO-2607-007"). A DO can consolidate lines from SEVERAL sales orders (see
// DO-2607-043 — 3 distinct SOs), so its header companySO/customerPO/customerSO/
// reference are blank; the identifiers the operator reconciles against live on
// each line's own sales order. This mirrors what the DESKTOP delivery list does
// client-side (src/pages/delivery/index.tsx ~340: SO id → {customerPO,
// customerSO, reference} map) — the mobile single-DO GET now joins it server-side
// so the detail header + line items carry the same info. Additive: only the
// detail path (fetchOrderWithItems) passes the map; the list path omits it and
// its output is byte-identical.
export type SoRefs = {
  companySO: string;
  companySOId: string;
  customerName: string;
  customerPO: string;
  customerPOId: string;
  customerSO: string;
  customerSOId: string;
  reference: string;
};

export async function loadSoRefsMap(
  db: D1Database,
  soNos: Array<string | null | undefined>,
): Promise<Map<string, SoRefs>> {
  const ids = [...new Set(soNos.filter((s): s is string => !!s))];
  const map = new Map<string, SoRefs>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  // Same camelCase columns the /pending-sos SELECT already reads — proven safe
  // against the unquoted-identifier fold (no column-rename-map entry needed).
  const res = await db
    .prepare(
      `SELECT companySO, companySOId, customerName,
              customerPO, customerPOId, customerSO, customerSOId, reference
         FROM sales_orders WHERE companySOId IN (${placeholders})`,
    )
    .bind(...ids)
    .all<SoRefs>();
  for (const r of res.results ?? []) {
    if (r.companySOId) map.set(r.companySOId, r);
  }
  return map;
}

export function parseJson<T>(raw: string | null, fallback: T): T {
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
export function pickItemM3(
  row: DeliveryOrderItemRow,
  productM3Map?: Map<string, number>,
): number {
  if (productM3Map && row.productCode) {
    const v = productM3Map.get(row.productCode);
    if (v && v > 0) return v;
  }
  return row.itemM3;
}

export function rowToItem(
  row: DeliveryOrderItemRow,
  productM3Map?: Map<string, number>,
  repairScopeByPo?: Map<string, string | null>,
  soRefs?: Map<string, SoRefs>,
) {
  // Per-line customer identifiers, resolved from THIS line's own sales order
  // (owner 2026-07-11: a consolidated DO's line items must each show whose
  // Cust PO / Cust SO / Reference they belong to). Empty when no map supplied
  // (list path) or the line's SO isn't found.
  const so = soRefs && row.salesOrderNo ? soRefs.get(row.salesOrderNo) : undefined;
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
    customerPOId: so?.customerPOId || so?.customerPO || "",
    customerSO: so?.customerSO || so?.customerSOId || "",
    reference: so?.reference || "",
    // Partial-repair scope (raw JSON) from the line's production order, for the
    // DO detail "Repair: <parts> (code)" badge. null when no map is supplied
    // (list path) or the PO has no scope.
    repairScope: row.productionOrderId
      ? repairScopeByPo?.get(row.productionOrderId) ?? null
      : null,
  };
}

// Loads { hubId → state } for the given hub ids. Used by the list path
// to surface the hub's state on each row even when delivery_orders.customerState
// is NULL (operator created the DO without typing a state but did pick a hub).
// Frontend prefers hubState over customerState in the State column fallback chain.
// Exported so the public DO-QR edit flow can resolve a DO's state the same way
// the office "Available Production Orders" picker does (same-state gate).
export async function loadHubStateMap(
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

// Loads { deliveryOrderId → invoiceNo } for every DO that has been transferred
// to an invoice (invoices.deliveryOrderId = do.id, one invoice per DO). Feeds
// the "Transfer To" column on the Delivered tab so the operator can see which
// invoice a delivered DO became. One org-scoped query, not per-row.
export async function loadDoInvoiceMap(
  db: D1Database,
  orgId: string,
): Promise<Map<string, string>> {
  // Exclude CANCELLED invoices and take the newest active one, so a DO that was
  // invoiced → cancelled → re-issued shows its LIVE invoice number, not the dead
  // one. (2026-06-04: 18 DOs displayed a cancelled invoice whose amount no longer
  // matched the DO; the active re-issue matched the DO exactly.)
  const res = await db
    .prepare(
      `SELECT deliveryOrderId, invoiceNo
         FROM invoices
        WHERE orgId = ? AND deliveryOrderId IS NOT NULL AND deliveryOrderId <> ''
          AND status <> 'CANCELLED'
        ORDER BY createdAt DESC`,
    )
    .bind(orgId)
    .all<{ deliveryOrderId: string; invoiceNo: string }>();
  const map = new Map<string, string>();
  for (const r of res.results ?? []) {
    // Rows come newest-active-first (cancelled already filtered out), so the
    // first row we keep per DO is its current live invoice.
    if (r.deliveryOrderId && !map.has(r.deliveryOrderId)) {
      map.set(r.deliveryOrderId, r.invoiceNo);
    }
  }
  return map;
}

// Loads { productCode → unitM3 } for the given codes. Used by every DO
// read path so legacy items (itemM3=0) get backfilled on the fly. Exported
// so the public DO-QR edit flow can backfill itemM3 on its addable POs too.
export async function loadProductM3Map(
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

// productionOrderId → raw repairScope JSON, for the DO detail items' "Repair:
// <parts> (code)" badge. SELECT * so the runtime-added repairScope column
// round-trips the Postgres compat layer (read dual-key, lowercase-folded).
export async function loadRepairScopeByPo(
  db: D1Database,
  poIds: (string | null)[],
): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(poIds.filter((x): x is string => !!x)));
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const res = await db
    .prepare(`SELECT * FROM production_orders WHERE id IN (${ph})`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  for (const row of res.results ?? []) {
    const pid = String(row.id ?? "");
    if (!pid) continue;
    out.set(
      pid,
      (row.repairScope as string) ?? (row.repairscope as string) ?? null,
    );
  }
  return out;
}

export function rowToOrder(
  row: DeliveryOrderRow,
  items: DeliveryOrderItemRow[] = [],
  productM3Map?: Map<string, number>,
  hubStateMap?: Map<string, string>,
  repairScopeByPo?: Map<string, string | null>,
  soRefs?: Map<string, SoRefs>,
) {
  const pod = parseJson<Record<string, unknown> | null>(row.proofOfDelivery, null);
  const fgUnitIds = parseJson<string[]>(row.fgUnitIds, []);
  // The distinct sales orders this DO consolidates (from its line items). Used
  // to (a) show "Sales Orders: SO-x, SO-y" on a multi-SO DO whose header
  // companySO is blank, and (b) backfill the header customer identifiers by
  // aggregating across those SOs. Empty when soRefs isn't supplied (list path).
  const myItems = items.filter((i) => i.deliveryOrderId === row.id);
  const distinctSoNos = [
    ...new Set(myItems.map((i) => i.salesOrderNo).filter((s): s is string => !!s)),
  ];
  const salesOrderNos = distinctSoNos.join(", ");
  const aggr = (pick: (r: SoRefs) => string): string => {
    if (!soRefs) return "";
    const vals = [
      ...new Set(
        distinctSoNos
          .map((n) => (soRefs.get(n) ? pick(soRefs.get(n)!) : ""))
          .filter(Boolean),
      ),
    ];
    return vals.join(", ");
  };
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
    // Backfill the header from the DO's line SOs when it's a consolidated DO
    // with a blank header (single SO → adopt it; multiple → salesOrderNos lists
    // them and the customer identifiers aggregate across all of them). Gated on
    // soRefs so ONLY the detail path (fetchOrderWithItems) enriches — the list
    // path (rowToOrderList) stays byte-identical to before, protecting the many
    // desktop + mobile consumers of GET /api/delivery-orders.
    companySO: row.companySO || (soRefs && distinctSoNos.length === 1 ? distinctSoNos[0]! : ""),
    companySOId: row.companySOId || (soRefs && distinctSoNos.length === 1 ? distinctSoNos[0]! : ""),
    salesOrderNos: soRefs ? salesOrderNos : "",
    customerId: row.customerId,
    customerPOId: row.customerPOId || aggr((r) => r.customerPOId || r.customerPO),
    customerSOId: row.customerSOId ?? "",
    customerSO: row.customerSO || aggr((r) => r.customerSO || r.customerSOId),
    reference: row.reference || aggr((r) => r.reference),
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
      .map((it) => rowToItem(it, productM3Map, repairScopeByPo, soRefs)),
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
    // Delivered-with-issues flag — drives the "invoice on hold" banner on the
    // DO detail page and blocks the Convert-to-Invoice / manual-invoice paths
    // until an operator resolves it. Folded-lowercase runtime column.
    deliveryIncomplete: !!Number(row.delivery_incomplete),
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
export function rowToOrderList(
  row: DeliveryOrderRow,
  items: DeliveryOrderItemRow[] = [],
  productM3Map?: Map<string, number>,
  hubStateMap?: Map<string, string>,
  repairScopeByPo?: Map<string, string | null>,
): Record<string, unknown> {
  const full = rowToOrder(row, items, productM3Map, hubStateMap, repairScopeByPo);
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
        // So the DO detail/view modal (opened from the list) shows the repair
        // badge without waiting for a save round-trip (review M1).
        repairScope: it.productionOrderId
          ? repairScopeByPo?.get(it.productionOrderId) ?? null
          : null,
      })),
  };
}

export function genDoId(): string {
  return `do-${crypto.randomUUID().slice(0, 8)}`;
}

export function genDoItemId(): string {
  return `doi-${crypto.randomUUID().slice(0, 8)}`;
}

// Async sequential DO number — DO-YYMM-NNN, NNN = max-existing-suffix-in-YYMM + 1.
// Was random `DO-YYMM-XXXX` hash before 2026-04-27 (user request: numbering
// rule in Settings says DO-YYMM-NNN sequential). Mirrors the SO generator
// in src/api/routes/sales-orders.ts generateCompanySOId.
export async function genNextDoNo(db: D1Database): Promise<string> {
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

export function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

export function genInvoiceId(): string {
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

export function genInvoiceItemId(): string {
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
export type DoForDeliveredCascade = {
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
  // Dispatch / delivered timestamps + planned delivery date. The invoice date
  // follows the DISPATCH date (when goods physically shipped) — the reliable
  // basis, since deliveredAt is often back-filled late at sign-off. Falls back
  // to delivered, then planned delivery date, then today (Wei Siang 2026-06-03).
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryDate: string | null;
};

// An SO at/past DELIVERED, or cancelled, must not be touched by a
// delivered DO (don't downgrade INVOICED/CLOSED, don't resurrect
// CANCELLED, don't re-stamp DELIVERED).
export const SO_TERMINAL_FOR_DELIVERED = new Set([
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "CANCELLED",
]);

export type InvItem = {
  id: string;
  // The DO line this invoice line was billed FROM (BUG-2026-07-17-001).
  // delivery_order_items carries the real per-line link (productionOrderId →
  // its SO + line), but invoice_items used to store only productCode/fabricCode
  // — so the printout had to RECONSTRUCT the customer PO by matching on code,
  // first-one-wins. On a consolidated DO with repeated product+fabric lines from
  // DIFFERENT SOs that mislabels lines: on INV-2607-060, 4 of 12 lines cited the
  // wrong customer PO, and three SOs' PO numbers never appeared at all.
  // The answer was never a better guess — the DO already knows. Carry the link.
  productionOrderId: string | null;
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
  // BUG-2026-07-17-001 — the single choke point every invoice INSERT flows
  // through, so the runtime ALTER lives here: awaited before any caller writes
  // invoice_items.production_order_id. Deploys don't replay migration files;
  // this is the load-bearing copy. Memoised per isolate.
  await ensureInvoicePoLinkColumn(db);
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

  // Partial-delivery: a line that went into a Delivery Return is NOT delivered,
  // so it's excluded from the invoice (the good lines are billed; the returned
  // ones drop out). Best-effort — if the delivery_return tables don't exist yet
  // (no returns raised on this deployment), the query throws and we bill all.
  let returnedPoIds = new Set<string>();
  try {
    const retRes = await db
      .prepare(
        `SELECT dri.production_order_id AS "poId"
           FROM delivery_return_items dri
           JOIN delivery_returns dr ON dr.id = dri.delivery_return_id
          WHERE dr.delivery_order_id = ? AND dr.status <> 'CANCELLED'`,
      )
      .bind(doId)
      .all<{ poId: string | null }>();
    returnedPoIds = new Set(
      (retRes.results ?? [])
        .map((r) => r.poId)
        .filter((x): x is string => !!x),
    );
  } catch {
    /* delivery_return tables not present — nothing to exclude */
  }
  const activeDoItems = returnedPoIds.size
    ? doItems.filter(
        (di) => !di.productionOrderId || !returnedPoIds.has(di.productionOrderId),
      )
    : doItems;

  let invItems: InvItem[] = activeDoItems.map((di) => {
    // Identical call to loadDoValueMap → invoice total == DO value.
    const unitPriceSen = priceForItem(
      idx,
      di.productionOrderId,
      doSoId,
      di.productCode,
    );
    return {
      id: genInvoiceItemId(),
      productionOrderId: di.productionOrderId ?? null,
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
        // Fallback path — billing the SO lines directly because the DO had no
        // priceable items. There IS no DO line behind these, so there is no
        // production-order link to carry; null is the honest value (the print
        // path falls back to the invoice-level refs for these).
        productionOrderId: null,
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

export async function buildDoDeliveredSoAndInvoice(
  db: D1Database,
  doRow: DoForDeliveredCascade,
  now: string,
  // Org + actor for the auto-post ledger legs (DO delivered → invoice is
  // created AND posted/SENT in the same batch, Wei Siang 2026-06-03).
  orgId: string,
  actorUserId: string | null,
  // delivered-with-issues: still cascade the SO/fg_units/COGS to DELIVERED,
  // but WITHHOLD the invoice (+ the SO→INVOICED and DO→INVOICED bumps) until
  // an operator resolves it. Default false → every existing caller unchanged.
  incomplete = false,
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

  // SOs that should end at INVOICED once the invoice is created. Superset of
  // soAdvanced: also includes SOs ALREADY at DELIVERED (this DO was delivered
  // "with issues" earlier and is now being resolved, or another DO already
  // delivered the shared SO). Excludes only the truly terminal-for-billing
  // states (INVOICED / CLOSED / CANCELLED). Without this the resolve path —
  // where every linked SO is already DELIVERED — would create the invoice but
  // leave the SOs stranded at DELIVERED.
  const soBillable: string[] = [];

  // 1. Advance every linked SO to DELIVERED (skip terminal/cancelled).
  for (const soId of soIds) {
    const soRow = await db
      .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
      .bind(soId)
      .first<{ id: string; status: string }>();
    if (!soRow) continue;
    // Already billed or dead — never touch (also keeps it out of soBillable).
    if (
      soRow.status === "INVOICED" ||
      soRow.status === "CLOSED" ||
      soRow.status === "CANCELLED"
    )
      continue;
    soBillable.push(soId);
    // Only advance + write the audit row when it isn't DELIVERED yet — an
    // already-DELIVERED SO (resolve case) is billable but needs no re-stamp.
    if (SO_TERMINAL_FOR_DELIVERED.has(soRow.status)) continue;
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
          JSON.stringify([`${doRow.doNo} marked DELIVERED`]),
        ),
    );
  }

  // 2. One combined invoice for the whole DO — idempotent.
  const existingInvoice = await db
    .prepare("SELECT id FROM invoices WHERE deliveryOrderId = ? LIMIT 1")
    .bind(doRow.id)
    .first<{ id: string }>();

  if (!existingInvoice && soIds.length > 0 && !incomplete) {
    const { invItems, computedTotal } = await computeDoInvoiceLines(
      db,
      doRow.id,
      soIds,
    );

    const invId = genInvoiceId();
    const invoiceNo = await nextInvoiceNo(db);
    // Invoice date = the DISPATCH date (when goods physically left), not the
    // sign-off date and not "today" (Wei Siang 2026-06-03). deliveredAt is
    // often back-filled late at sign-off and would bunch revenue into the
    // wrong month; dispatch is the reliable ship date. Fall back to delivered,
    // then the planned delivery date, then now.
    const shipDate =
      (doRow.dispatchedAt && doRow.dispatchedAt.split("T")[0]) ||
      (doRow.deliveredAt && doRow.deliveredAt.split("T")[0]) ||
      (doRow.deliveryDate && doRow.deliveryDate.split("T")[0]) ||
      now.split("T")[0];
    const invoiceDate = shipDate;
    // Due date stays relative to the invoice (dispatch) date so terms remain
    // consistent with when the invoice is dated.
    const due = new Date(`${shipDate}T00:00:00.000Z`);
    due.setDate(due.getDate() + 30);
    const dueDate = due.toISOString().split("T")[0];
    // Combined invoice spans multiple SOs — anchor the header SO to the
    // DO's own (legacy single-SO) or the first resolved one so the row
    // isn't orphaned; the authoritative link is deliveryOrderId.
    const headerSoId = doRow.salesOrderId || soIds[0] || null;

    // Phase 2 (2026-06) — build the ledger legs FIRST so the INSERT can
    // carry the decided tax and the GROSS total (subtotal + SST). The
    // in-memory invItems are passed straight to the builder (itemsOverride)
    // because the invoice_items INSERTs are in this same un-executed batch
    // — the old post-INSERT build saw zero items and misposted every
    // auto-invoice's revenue to the generic BEDFRAME sales account.
    const { legs: autoLegs, taxSen: autoTaxSen } =
      await buildInvoiceLedgerLegs(
        db,
        orgId,
        {
          id: invId,
          invoiceNo,
          customerId: doRow.customerId,
          subtotalSen: computedTotal,
        },
        actorUserId,
        false,
        null,
        invItems.map((it) => ({
          productCode: it.productCode,
          totalSen: it.totalSen,
        })),
      );
    const grossTotalSen = computedTotal + autoTaxSen;

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
             subtotalSen, taxSen, totalSen, status, invoiceDate, dueDate, paidAmount,
             paymentDate, paymentMethod, notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          autoTaxSen,
          grossTotalSen,
          // Auto-confirmed: created already POSTED (SENT), with its ledger
          // legs written below — not left as a DRAFT for a second manual step.
          "SENT",
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
               quantity, unitPriceSen, totalSen, production_order_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            // BUG-2026-07-17-001 — keep the DO's per-line link so the printout
            // never has to guess the customer PO by product code again.
            item.productionOrderId,
          ),
      );
    }
    // Outstanding A/R follows delivered goods (same batch as the invoice
    // so a partial failure can't strand one without the other). GROSS —
    // the customer owes the SST too (Phase 2).
    statements.push(
      db
        .prepare(
          `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
        )
        .bind(grossTotalSen, doRow.customerId),
    );
    createdInvoice = true;
    invoiceTotalSen = grossTotalSen;

    // ---- Auto-post the just-created invoice (no DRAFT step) --------------
    // The legs were built ABOVE (before the INSERT) so the row could carry
    // the decided tax + gross total; here they join the same batch. Can't
    // double-post: this branch only runs when no invoice yet exists for
    // the DO (existingInvoice guard above).
    const { statements: ledgerStmts } = await buildJournalEntryStatements(
      db,
      orgId,
      autoLegs,
    );
    statements.push(...ledgerStmts);
    // SOs were advanced to DELIVERED above; now that they're billed, bump to
    // INVOICED (matches the manual post's SO cascade). soBillable, not
    // soAdvanced, so the resolve path (SOs already DELIVERED) bills them too.
    for (const sid of soBillable) {
      statements.push(
        db
          .prepare(
            // AND status = 'DELIVERED' (2026-07-04 audit): every legitimate
            // path has the SO at DELIVERED by this point (advanced earlier in
            // THIS batch, or already-DELIVERED on the resolve path). The guard
            // makes a stale/concurrent re-fire a no-op instead of downgrading
            // an already-INVOICED/CLOSED SO back to INVOICED.
            "UPDATE sales_orders SET status = 'INVOICED', updated_at = ? WHERE id = ? AND status = 'DELIVERED'",
          )
          .bind(now, sid),
      );
    }
    // Flip the DO to INVOICED too — pushed last so it wins over any caller's
    // own DELIVERED update batched ahead of dc.statements.
    statements.push(
      db
        .prepare(
          "UPDATE delivery_orders SET status = 'INVOICED', overdue = 'INVOICED', updated_at = ? WHERE id = ?",
        )
        .bind(now, doRow.id),
    );
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

export async function fetchOrderWithItems(db: D1Database, id: string) {
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
  const [m3Map, hubStateMap, repairScopeByPo, soRefs] = await Promise.all([
    loadProductM3Map(db, items.map((i) => i.productCode)),
    loadHubStateMap(db, [order.hubId]),
    loadRepairScopeByPo(db, items.map((i) => i.productionOrderId)),
    loadSoRefsMap(db, items.map((i) => i.salesOrderNo)),
  ]);
  return rowToOrder(order, items, m3Map, hubStateMap, repairScopeByPo, soRefs);
}

// ---------------------------------------------------------------------------
// DO-creation core — the verbatim body of POST / below, extracted so the
// Packing-List-first auto-split flow (POST /packing-list-first) can create
// each per-(customer, hub) DO through the EXACT same guards / lookups /
// insert batch / audit emit as a hand-created DO. The route maps the result
// 1:1 onto the original HTTP responses, so POST / behavior is unchanged.
//
// `body` keeps the untyped shape it had as `await c.req.json()` inside the
// old inline handler — typing it would force casts into the extracted lines.
// `onCreated` (optional) fires synchronously right after the INSERT batch
// commits, BEFORE the re-read + audit emit, so a caller that creates several
// DOs in one request can track every committed row for rollback even when a
// later step of this function throws.
// ---------------------------------------------------------------------------
export type DoCreateOutcome =
  | {
      ok: true;
      /** The full DO payload exactly as POST / returns it. */
      created: NonNullable<Awaited<ReturnType<typeof fetchOrderWithItems>>>;
      id: string;
      doNo: string;
      /** Single-SO id stamped onto the DO row (null for multi-SO DOs). */
      salesOrderId: string | null;
    }
  | { ok: false; status: 400 | 409 | 500; body: Record<string, unknown> };

// Service-PO destination metadata. Service POs (production_orders.
// serviceOrderId set, salesOrderId NULL) carry their delivery hub on the
// SERVICE order: service_orders.hubId is stamped at creation from the source
// SO/CO (2026-06-11). Legacy service orders predate that column, so fall back
// to live-deriving the hub from the source order. The hubId SELECT is
// try/catch'd because the column self-applies on first service-order POST —
// DO creation must keep working on isolates where it hasn't landed yet.
// Exported so the public DO-QR edit flow can resolve a service-order PO's
// customer + hub the same canonical way (production_orders has no customerId
// column — customer is derived from the SO / service order).
export async function loadServiceOrderHubMeta(
  db: D1Database,
  serviceOrderIds: string[],
): Promise<
  Map<
    string,
    { hubId: string | null; customerId: string | null; customerName: string | null }
  >
> {
  const out = new Map<
    string,
    { hubId: string | null; customerId: string | null; customerName: string | null }
  >();
  const ids = [...new Set(serviceOrderIds.filter((x) => x))];
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  type SvcRow = {
    id: string;
    hubId?: string | null;
    sourceType: string | null;
    sourceId: string | null;
    customerId: string | null;
    customerName: string | null;
  };
  let rows: SvcRow[] = [];
  try {
    const res = await db
      .prepare(
        `SELECT id, hubId, sourceType, sourceId, customerId, customerName
           FROM service_orders WHERE id IN (${ph})`,
      )
      .bind(...ids)
      .all<SvcRow>();
    rows = res.results ?? [];
  } catch {
    const res = await db
      .prepare(
        `SELECT id, sourceType, sourceId, customerId, customerName
           FROM service_orders WHERE id IN (${ph})`,
      )
      .bind(...ids)
      .all<SvcRow>();
    rows = res.results ?? [];
  }

  // Legacy rows (no stored hub): derive from the source order live.
  const soNeed = rows.filter((r) => !r.hubId && r.sourceType === "SO" && r.sourceId);
  const coNeed = rows.filter((r) => !r.hubId && r.sourceType === "CO" && r.sourceId);
  const soHub = new Map<string, string | null>();
  if (soNeed.length > 0) {
    const p2 = soNeed.map(() => "?").join(",");
    const res = await db
      .prepare(`SELECT id, hubId FROM sales_orders WHERE id IN (${p2})`)
      .bind(...soNeed.map((r) => r.sourceId))
      .all<{ id: string; hubId: string | null }>();
    for (const r of res.results ?? []) soHub.set(r.id, r.hubId);
  }
  const coHub = new Map<string, string | null>();
  if (coNeed.length > 0) {
    const p2 = coNeed.map(() => "?").join(",");
    const res = await db
      .prepare(`SELECT id, hubId FROM consignment_orders WHERE id IN (${p2})`)
      .bind(...coNeed.map((r) => r.sourceId))
      .all<{ id: string; hubId: string | null }>();
    for (const r of res.results ?? []) coHub.set(r.id, r.hubId);
  }

  for (const r of rows) {
    const derived =
      r.hubId ??
      (r.sourceType === "SO"
        ? soHub.get(r.sourceId ?? "") ?? null
        : r.sourceType === "CO"
          ? coHub.get(r.sourceId ?? "") ?? null
          : null);
    out.set(r.id, {
      hubId: derived,
      customerId: r.customerId,
      customerName: r.customerName,
    });
  }
  return out;
}

// Shared DO composition guard — the three integrity rules that keep a DO
// physically deliverable:
//   (1) a production order can be delivered only ONCE,
//   (2) one DO = one customer,
//   (3) one DO = one delivery hub (one physical drop-off address).
// This lives in ONE place so the create path (POST) and the edit / Add-Items
// path (PUT) enforce IDENTICAL rules and can never drift. Root cause of
// DO-2606-029 (Wei Siang 2026-06-11): a DO mixed two hubs because the three
// guards lived ONLY in the create path — "Add Items" on the edit screen
// replaced the item set with zero validation, so a Penang order slipped into
// a KL DO.
//
// excludeDoId — on edit, the DO being saved already legitimately holds these
// POs; pass its id so the duplicate-delivery check skips itself (a PO already
// on THIS DO is fine; only a PO on ANOTHER live DO is the problem).
export async function validateDoComposition(
  db: D1Database,
  productionOrderIds: string[],
  excludeDoId: string | null,
): Promise<{ ok: true } | { ok: false; status: 400 | 409; error: string }> {
  const poIds = [...new Set(productionOrderIds.filter((x) => x))];
  if (poIds.length === 0) return { ok: true };
  const placeholders = poIds.map(() => "?").join(",");

  // PO rows — poNo for messages, salesOrderId / serviceOrderId for the
  // customer/hub lookup.
  const poRes = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, serviceOrderId FROM production_orders WHERE id IN (${placeholders})`,
    )
    .bind(...poIds)
    .all<{
      id: string;
      poNo: string;
      salesOrderId: string | null;
      serviceOrderId: string | null;
    }>();
  const poRows = poRes.results ?? [];
  const poNoById = new Map(poRows.map((r) => [r.id, r.poNo]));

  // (1) duplicate-delivery guard — reject any PO already on another
  // non-cancelled DO. ROOT-CAUSE GUARD (Wei Siang 2026-05-16): a PO can only
  // be delivered once (re-delivery double-consumes FG via FIFO COGS).
  const dupRes = await db
    .prepare(
      `SELECT DISTINCT di.productionOrderId AS poId, d.doNo AS doNo, d.status AS status
         FROM delivery_order_items di
         JOIN delivery_orders d ON d.id = di.deliveryOrderId
        WHERE di.productionOrderId IN (${placeholders})
          AND d.status != 'CANCELLED'${excludeDoId ? "\n          AND d.id != ?" : ""}`,
    )
    .bind(...poIds, ...(excludeDoId ? [excludeDoId] : []))
    .all<{ poId: string; doNo: string; status: string }>();
  const alreadyLinked = dupRes.results ?? [];
  if (alreadyLinked.length > 0) {
    const lines = alreadyLinked
      .map((r) => `${poNoById.get(r.poId) ?? r.poId} → ${r.doNo} (${r.status})`)
      .join(", ");
    return {
      ok: false,
      status: 409,
      error: `These production orders are already on a delivery order (a PO can only be delivered once): ${lines}. Remove them from the selection.`,
    };
  }

  // (2)+(3) customer + hub consistency — derived from the parent SOs PLUS the
  // service orders (service POs have no SO; their destination lives on
  // service_orders, stamped from the source order). Both dimensions fold into
  // the SAME maps so a service PO can't smuggle a second customer/destination
  // into a DO.
  const custMap = new Map<string, string>();
  const hubMap = new Map<string, string>();

  const soIds = [...new Set(poRows.map((r) => r.salesOrderId ?? "").filter((x) => x))];
  if (soIds.length > 0) {
    const ph = soIds.map(() => "?").join(",");
    const soRes = await db
      .prepare(
        `SELECT id, hubId, hubName, customerId, customerName
           FROM sales_orders WHERE id IN (${ph})`,
      )
      .bind(...soIds)
      .all<{
        id: string;
        hubId: string | null;
        hubName: string | null;
        customerId: string | null;
        customerName: string | null;
      }>();
    for (const r of soRes.results ?? []) {
      if (r.customerId) custMap.set(r.customerId, r.customerName || r.customerId);
      if (r.hubId && r.hubId !== "") hubMap.set(r.hubId, r.hubName || r.hubId);
    }
  }

  const svcIds = [
    ...new Set(poRows.map((r) => r.serviceOrderId ?? "").filter((x) => x)),
  ];
  if (svcIds.length > 0) {
    const svcMeta = await loadServiceOrderHubMeta(db, svcIds);
    const unnamedHubIds = new Set<string>();
    for (const m of svcMeta.values()) {
      if (m.customerId && !custMap.has(m.customerId)) {
        custMap.set(m.customerId, m.customerName || m.customerId);
      }
      if (m.hubId && !hubMap.has(m.hubId)) unnamedHubIds.add(m.hubId);
    }
    if (unnamedHubIds.size > 0) {
      // Name the service hubs so a mix rejection reads like the SO one
      // ("Houzs KL, Houzs PG") instead of raw ids.
      const ph = [...unnamedHubIds].map(() => "?").join(",");
      const hubRes = await db
        .prepare(`SELECT id, shortName FROM delivery_hubs WHERE id IN (${ph})`)
        .bind(...unnamedHubIds)
        .all<{ id: string; shortName: string | null }>();
      const nameById = new Map(
        (hubRes.results ?? []).map((h) => [h.id, h.shortName]),
      );
      for (const h of unnamedHubIds) hubMap.set(h, nameById.get(h) || h);
    }
  }

  // CUSTOMER-CONSISTENCY (Wei Siang 2026-05-28): a DO is keyed to ONE
  // customer.
  if (custMap.size > 1) {
    return {
      ok: false,
      status: 400,
      error: `This delivery order mixes ${custMap.size} customers (${[...custMap.values()].join(", ")}). A DO can only deliver for one customer — split into separate DOs, one per customer.`,
    };
  }

  // HUB-CONSISTENCY (Wei Siang 2026-05-28): a single DO must deliver to ONE
  // hub. Different hubs = different physical drop-off addresses.
  if (hubMap.size > 1) {
    return {
      ok: false,
      status: 400,
      error: `This delivery order mixes ${hubMap.size} delivery hubs (${[...hubMap.values()].join(", ")}). A DO can only deliver to one hub — split into separate DOs, one per hub.`,
    };
  }
  return { ok: true };
}

export async function createDeliveryOrderForPOs(
  c: Context<Env>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  onCreated?: (info: {
    id: string;
    doNo: string;
    salesOrderId: string | null;
  }) => void,
): Promise<DoCreateOutcome> {
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
      serviceOrderId: string | null;
      // itemCategory + specialOrder feed deriveComponentRacks so the DO-item
      // rack snapshot is the AGGREGATED per-piece "Rack 3, 4", not the lossy
      // production_orders.rackingNumber single-rack mirror.
      itemCategory: string | null;
      specialOrder: string | null;
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
                serviceOrderId, productCode, productName,
                sizeLabel, fabricCode, quantity, rackingNumber,
                customerName, customerState, itemCategory, specialOrder
           FROM production_orders WHERE id IN (${placeholders})`,
      )
        .bind(...productionOrderIds)
        .all<PoRow & { consignmentOrderId?: string | null }>();
      poRowsForItems = poRes.results ?? [];
      if (poRowsForItems.length === 0) {
        return {
          ok: false,
          status: 400,
          body: { success: false, error: "No matching production orders" },
        };
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
        return {
          ok: false,
          status: 400,
          body: {
            success: false,
            error: `Consignment-Order POs cannot be added to a Delivery Order. Use a Consignment Note instead. Offending POs: ${coPoNos.join(", ")}`,
          },
        };
      }
      // ROOT-CAUSE GUARD (Wei Siang 2026-05-16): a production order can
      // only be delivered ONCE. Reject any PO already on a non-cancelled
      // DO. Without this, the same POs could be put on a 2nd/3rd DO and
      // re-delivered — each re-delivery re-ran the FG FIFO consumption
      // (cost_ledger FG_DELIVERED) and inflated SO/Delivered value
      // (BUG-2026-05-16: 13 duplicate DOs, 200 units & RM 24,647 of FG
      // double-consumed). Frontend hides already-linked POs, but that's
      // display-only — this is the authoritative backend block.
      // Duplicate-delivery + customer + hub consistency — the three DO
      // composition rules, now enforced from ONE shared helper so the create
      // and edit paths can never drift (see validateDoComposition).
      const composition = await validateDoComposition(
        c.var.DB,
        productionOrderIds,
        null,
      );
      if (!composition.ok) {
        return {
          ok: false,
          status: composition.status,
          body: { success: false, error: composition.error },
        };
      }

      // Pick a representative salesOrderId for the legacy single-SO
      // cascade fields (sales_orders.hookkaDeliveryOrder etc.). When the
      // DO genuinely spans multiple SOs, leave salesOrderId NULL — the
      // DELIVERED cascade walks fg_units → poId to find every SO and
      // updates each (added below).
      const soIds = new Set(poRowsForItems.map((r) => r.salesOrderId ?? ""));
      soIds.delete("");
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
      customerSOId: string | null;
      customerSO: string | null;
      reference: string | null;
      companySO: string | null;
      companySOId: string | null;
      hubId: string | null;
      hookkaExpectedDD: string | null;
    } | null = null;
    if (salesOrderId) {
      salesOrderRow = await c.var.DB.prepare(
        `SELECT id, customerId, customerName, customerState, customerPOId,
                customerSOId, customerSO, reference,
                companySO, companySOId, hubId, hookkaExpectedDD
           FROM sales_orders WHERE id = ?`,
      )
        .bind(salesOrderId)
        .first();
      if (!salesOrderRow) {
        return {
          ok: false,
          status: 400,
          body: { success: false, error: "Sales order not found" },
        };
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
      return {
        ok: false,
        status: 400,
        body: { success: false, error: "customerId or salesOrderId is required" },
      };
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
      return {
        ok: false,
        status: 400,
        body: { success: false, error: "Customer not found" },
      };
    }

    // Resolve the (optional) default delivery hub so address/contact default
    // the way the mock-data route used to.
    let defaultHub: {
      id: string;
      shortName: string | null;
      address: string | null;
    } | null = null;
    let hubTarget = body.hubId ?? salesOrderRow?.hubId ?? null;
    // Service POs: the destination lives on the SERVICE order (stamped from
    // the source SO/CO at creation; legacy rows live-derive inside the
    // helper). Without this, a service DO fell back to the customer's default
    // hub — wrong branch — and could even print a blank Deliver-To
    // (DO-2606-030). The composition guard above already ensures the
    // selection spans at most ONE distinct service hub.
    if (!hubTarget && poRowsForItems.length > 0) {
      const svcIds = [
        ...new Set(
          poRowsForItems.map((r) => r.serviceOrderId ?? "").filter((x) => x),
        ),
      ];
      if (svcIds.length > 0) {
        const svcMeta = await loadServiceOrderHubMeta(c.var.DB, svcIds);
        for (const m of svcMeta.values()) {
          if (m.hubId) {
            hubTarget = m.hubId;
            break;
          }
        }
      }
    }
    // Consolidated multi-SO DO: salesOrderRow is NULL (no single SO), so the
    // else-branch below would fall back to the customer's DEFAULT hub and stamp
    // "Houzs KL" on a DO whose lines all ship to Penang. The address came out
    // right (it is bound per-line further down), but the hub LABEL was wrong on
    // 15 post-guard DOs — the header said KL while every line was PG/SRW/SBH,
    // breaking every hub/state grouping (delivery planning, 3PL state rates).
    //
    // The lines themselves know the hub: read the DISTINCT hubId across the SOs
    // in this DO. The one-customer/one-hub composition guard already ran above,
    // so a well-formed selection has exactly ONE — use it. If somehow more than
    // one survives, do NOT guess: leave hubTarget null and let the existing
    // default-hub fallback stand (no worse than before). BUG-CLASSES.md C3.
    if (!hubTarget && poRowsForItems.length > 0) {
      const soIdsForHub = [
        ...new Set(poRowsForItems.map((r) => r.salesOrderId ?? "").filter((x) => x)),
      ];
      if (soIdsForHub.length > 0) {
        const ph = soIdsForHub.map(() => "?").join(",");
        const hubRes = await c.var.DB.prepare(
          `SELECT DISTINCT hubId FROM sales_orders
            WHERE id IN (${ph}) AND hubId IS NOT NULL AND hubId <> ''`,
        )
          .bind(...soIdsForHub)
          .all<{ hubId: string }>();
        const distinctHubs = (hubRes.results ?? []).map((r) => r.hubId);
        if (distinctHubs.length === 1) hubTarget = distinctHubs[0];
      }
    }
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

    // -------------------------------------------------------------------
    // Per-piece rack snapshot. delivery_order_items.rackingNumber is frozen
    // at DO-creation and read back by every downstream surface (DO detail,
    // DO view modal, DO HTML print, packing-list PDF, public DO QR). A unit
    // whose pieces span racks (HB on Rack 3, DIVAN on Rack 4) must snapshot
    // "Rack 3, 4" — NOT the lossy production_orders.rackingNumber mirror that
    // only ever holds one rack. We aggregate the distinct racks off each PO's
    // PACKING job cards via deriveComponentRacks (the SAME derivation the DO
    // /print-extras + PDF use) and flatten through formatRacksCompact (the
    // shared dedup/sort/"Rack 3, 4" formatter). Additive: only override when
    // an aggregated value exists; lines with no PACKING cards / no linked PO
    // keep whatever rack they already had. Existing DOs are untouched.
    // -------------------------------------------------------------------
    if (poRowsForItems.length > 0) {
      const poMetaById = new Map(
        poRowsForItems.map((po) => [
          po.id,
          {
            itemCategory: po.itemCategory ?? null,
            specialOrder: po.specialOrder ?? null,
          },
        ]),
      );
      const packingByPo = new Map<string, PackingJcRow[]>();
      const aggPoIds = Array.from(
        new Set(
          items
            .map((it) => it.productionOrderId)
            .filter((pid): pid is string => !!pid && poMetaById.has(pid)),
        ),
      );
      if (aggPoIds.length > 0) {
        const ph = aggPoIds.map(() => "?").join(",");
        const jcRes = await c.var.DB.prepare(
          `SELECT productionOrderId, wipType, wipLabel, rackingNumber,
                  completedDate, status
             FROM job_cards
            WHERE departmentCode = 'PACKING' AND productionOrderId IN (${ph})`,
        )
          .bind(...aggPoIds)
          .all<PackingJcRow>();
        for (const jc of jcRes.results ?? []) {
          const pid = jc.productionOrderId || "";
          if (!pid) continue;
          const list = packingByPo.get(pid);
          if (list) list.push(jc);
          else packingByPo.set(pid, [jc]);
        }
        for (const it of items) {
          const pid = it.productionOrderId;
          if (!pid) continue;
          const meta = poMetaById.get(pid);
          const cards = packingByPo.get(pid);
          if (!meta || !cards || cards.length === 0) continue;
          const { componentRacks } = deriveComponentRacks(
            cards,
            meta.itemCategory,
            meta.specialOrder,
          );
          const agg = formatRacksCompact(
            componentRacks.flatMap((cr) => cr.racks),
          );
          if (agg) it.rackingNumber = agg;
        }
      }
    }

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
        return {
          ok: false,
          status: 409,
          body: {
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
        };
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
    // 0/0 hasRate guard (mirrors packing-lists.ts rateForDo, BUG-2026-06-25).
    // A rate pair of 0/0 means "never keyed in 3PL Maintenance", NOT "free".
    // Precedence stays vehicle-over-provider, but a RATE-LESS vehicle must fall
    // THROUGH to its provider's rates instead of masking them with RM 0 — the
    // exact latent DO-write bug BUG-2026-06-25 flagged as untouched (a 0/0
    // vehicle used to "win" and silently persist deliveryCostSen = 0). We stage
    // a provider-derived fallback here and only let a vehicle override it when
    // the vehicle actually has a keyed rate. When neither side has a rate, the
    // operator's explicit deliveryCostSen (or 0) stands untouched — additive,
    // existing legitimately-0 DOs are unaffected.
    const hasRatePair = (trip: number, drop: number): boolean =>
      (Number(trip) || 0) > 0 || (Number(drop) || 0) > 0;
    let providerRateCostSen: number | null = null;

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
        // Provider-level rate fallback for cost. Only meaningful when the
        // provider actually has a keyed rate (0/0 = unset, not free). Staged
        // into providerRateCostSen so the vehicle block below can fall through
        // to it when the picked vehicle is itself rate-less.
        if (!body.deliveryCostSen &&
            hasRatePair(provider.ratePerTripSen, provider.ratePerExtraDropSen)) {
          providerRateCostSen =
            provider.ratePerTripSen +
            Math.max(0, dropPointsForCost - 1) * provider.ratePerExtraDropSen;
          // No vehicle picked → the provider rate IS the cost.
          if (!resolvedVehicleId) resolvedDeliveryCostSen = providerRateCostSen;
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
          if (hasRatePair(vehicle.ratePerTripSen, vehicle.ratePerExtraDropSen)) {
            // Vehicle has its own keyed rate → it wins (existing precedence).
            resolvedDeliveryCostSen =
              vehicle.ratePerTripSen +
              Math.max(0, dropPointsForCost - 1) * vehicle.ratePerExtraDropSen;
          } else if (providerRateCostSen !== null) {
            // Rate-less vehicle (0/0 = unset) → fall through to the provider's
            // keyed rate instead of masking it with RM 0 (BUG-2026-06-25 class).
            resolvedDeliveryCostSen = providerRateCostSen;
          }
          // else: neither vehicle nor provider has a rate → leave the
          // operator's explicit cost (or 0) as-is; don't invent a number.
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
           customerPOId, customerSOId, customerSO, reference,
           customerName, customerState, hubId, hubName,
           deliveryAddress, contactPerson, contactPhone, deliveryDate,
           hookkaExpectedDD, driverId, driverName, driverContactPerson,
           driverPhone, vehicleId, vehicleNo, vehicleType, totalM3,
           totalItems, status, overdue, dispatchedAt, deliveredAt, remarks,
           dropPoints, deliveryCostSen, lorryId, lorryName, doQrCode,
           fgUnitIds, signedAt, signedByWorkerId, signedByWorkerName,
           proofOfDelivery, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        doNo,
        salesOrderRow?.id ?? null,
        salesOrderRow?.companySO ?? body.companySO ?? null,
        salesOrderRow?.companySOId ?? body.companySOId ?? null,
        customerRow.id,
        salesOrderRow?.customerPOId ?? body.customerPOId ?? null,
        // Snapshot the customer's own SO no. + reference onto the DO at
        // creation (single-SO path; multi-SO DOs leave these null and the UI
        // live-joins per line). Mirrors the customerPOId snapshot above so a DO
        // is a durable, self-contained document — Wei Siang 2026-06-03.
        salesOrderRow?.customerSOId ?? body.customerSOId ?? null,
        salesOrderRow?.customerSO ?? body.customerSO ?? null,
        salesOrderRow?.reference ?? body.reference ?? null,
        customerRow.name,
        salesOrderRow?.customerState ?? body.customerState ?? null,
        defaultHub?.id ?? null,
        defaultHub?.shortName ?? null,
        // An explicit blank / whitespace deliveryAddress from the caller must
        // NOT discard the hub's real address. `??` only falls through on
        // null/undefined, so a "" used to win and printed a blank Deliver-To
        // (root cause of DO-2606-030's missing address). Fall through to the
        // resolved hub address whenever the caller's value is blank.
        typeof body.deliveryAddress === "string" && body.deliveryAddress.trim()
          ? body.deliveryAddress
          : defaultHub?.address ?? "",
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

    // The row is committed from here on — let multi-DO callers track it for
    // rollback even if the re-read or audit emit below throws.
    onCreated?.({ id, doNo, salesOrderId: salesOrderRow?.id ?? null });

    const created = await fetchOrderWithItems(c.var.DB, id);
    if (!created) {
      return {
        ok: false,
        status: 500,
        body: { success: false, error: "Failed to create delivery order" },
      };
    }

    // Audit emit (P3.4) — DO create. Mirrors the sales-orders pattern.
    await emitAudit(c, {
      resource: "delivery-orders",
      resourceId: id,
      action: "create",
      after: { status: "DRAFT", doNo, salesOrderId: salesOrderRow?.id ?? null },
    });

    return {
      ok: true,
      created,
      id,
      doNo,
      salesOrderId: salesOrderRow?.id ?? null,
    };
}

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
// Extracted so the DELIVERED customer-notice email builds the SAME rich DO
// the owner downloads/prints (category / per-line refs / spec / pieces).
// Read-only; returns null when the DO is not found. Same output shape the
// GET /:id/print-extras endpoint returns.
export async function computeDoPrintExtras(
  db: Env["Variables"]["DB"],
  id: string,
) {
  const doRow = await db.prepare(
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
    return null;
  }
  let customerSO = "";
  if (doRow.salesOrderId) {
    const so = await db.prepare(
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
    const hub = await db.prepare(
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
  //
  // Every alias here is snake_case ON PURPOSE. Postgres folds an UNQUOTED
  // identifier to lower case, and db-pg.ts's `columnFrom` only re-camelCases
  // names it can find in the inverse rename map or that contain an underscore.
  // `AS soId2` therefore came back as `soid2`, so `r.soId2` at :2403/:2703 was
  // ALWAYS undefined — path (b), the entire reason this query was widened, never
  // resolved a single row. Same trap already documented in pricing-integrity.ts.
  // `scripts/audit-sql-aliases.mjs` now fails the build on a new one.
  const itRes = await db.prepare(
    `SELECT di.id,
            di.salesOrderNo AS di_sales_order_no,
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
            poso.customerSOId AS line_customer_so,
            poso.customerPO AS poso_customer_po,
            poso.customerPOId AS poso_customer_po_id,
            poso.reference AS poso_reference,
            so2.id AS so_id2,
            so2.customerPO AS so_customer_po,
            so2.customerPOId AS so_customer_po_id,
            so2.customerSOId AS so_customer_so,
            so2.reference AS so_reference
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
      lineCustomerSo: string | null;
      posoCustomerPo: string | null;
      posoCustomerPoId: string | null;
      posoReference: string | null;
      soId2: string | null;
      soCustomerPo: string | null;
      soCustomerPoId: string | null;
      soCustomerSo: string | null;
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
    const soiRes = await db.prepare(
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
    const bomRes = await db.prepare(
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
    // Prefer ACTIVE, then the latest effectiveFrom — shared with the CN
    // print-extras so both pick the same BOM version per product code.
    for (const [pc, v] of selectBestBomByCode(bomRes.results ?? []))
      bomByCode.set(pc, v);
  }
  // Reliable customer PO / SO / Ref via the SALES ORDER — the same path
  // the on-screen items table uses. The arbitrary multi-join aliases
  // (poso.customerSOId / so2.customerSOId …) don't round-trip the
  // Postgres compat layer, so customerSO came back blank even when it
  // exists. Resolve from a clean sales_orders query keyed by SO no. / id.
  const diSoById = new Map<string, string>();
  // di.id -> production order id. Fetched via this clean single-table query
  // (NOT an alias on the big multi-join above — renamed aliases there don't
  // round-trip the Postgres compat layer, see the soRef comment below).
  // Join key for the per-component PACKING job-card read further down.
  const diPoById = new Map<string, string>();
  {
    const diRes = await db.prepare(
      "SELECT id, salesOrderNo, productionOrderId FROM delivery_order_items WHERE deliveryOrderId = ?",
    )
      .bind(id)
      .all<{
        id: string;
        salesOrderNo: string | null;
        productionOrderId: string | null;
      }>();
    for (const dr of diRes.results ?? []) {
      if (!dr.id) continue;
      diSoById.set(dr.id, dr.salesOrderNo || "");
      if (dr.productionOrderId) diPoById.set(dr.id, dr.productionOrderId);
    }
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
    const soRes = await db.prepare(
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

  // Per-component PACKING job cards for the DO's production orders — the
  // ONLY place the per-component rack + packing completion live (one PACKING
  // JC per top-level component, each with its own rackingNumber +
  // completedDate; production_orders.rackingNumber is a lossy last-writer
  // mirror, so it is deliberately NOT used here). One bulk read for all POs.
  type PackingJcRow = {
    productionOrderId: string | null;
    wipType: string | null;
    wipLabel: string | null;
    rackingNumber: string | null;
    completedDate: string | null;
    status: string | null;
  };
  const packingJcsByPo = new Map<string, PackingJcRow[]>();
  {
    const poIds = Array.from(new Set(diPoById.values()));
    if (poIds.length > 0) {
      const ph = poIds.map(() => "?").join(",");
      const jcRes = await db.prepare(
        `SELECT productionOrderId, wipType, wipLabel, rackingNumber,
                completedDate, status
           FROM job_cards
          WHERE departmentCode = 'PACKING' AND productionOrderId IN (${ph})`,
      )
        .bind(...poIds)
        .all<PackingJcRow>();
      for (const jc of jcRes.results ?? []) {
        const pid = jc.productionOrderId || "";
        if (!pid) continue;
        const list = packingJcsByPo.get(pid);
        if (list) list.push(jc);
        else packingJcsByPo.set(pid, [jc]);
      }
    }
  }

  // Per-PO repair scope (partial repair). Loaded with SELECT * so the runtime-
  // added repairScope column round-trips the Postgres compat layer (an aliased
  // camelCase column on the big multi-join above would NOT — the same reason
  // diPoById is a clean single-table read). Used to narrow a partial-repair
  // line's printed pieces to just the repaired compartment(s).
  const repairScopeByPo = new Map<string, RepairScope | null>();
  {
    const poIds = Array.from(new Set(diPoById.values()));
    if (poIds.length > 0) {
      const ph = poIds.map(() => "?").join(",");
      const rsRes = await db.prepare(
        `SELECT * FROM production_orders WHERE id IN (${ph})`,
      )
        .bind(...poIds)
        .all<Record<string, unknown>>();
      for (const row of rsRes.results ?? []) {
        const pid = String(row.id ?? "");
        if (!pid) continue;
        repairScopeByPo.set(
          pid,
          parseRepairScope(
            (row.repairScope as string) ?? (row.repairscope as string) ?? null,
          ),
        );
      }
    }
  }

  // Per-line set composition string, e.g. "1 HB + 2 DIVAN" (bedframe)
  // or "1 1A + 1 2A + 1 STOOL" (sofa set). Shared with the CN print-extras
  // (src/api/lib/print-extras-shared.ts) so both documents produce the
  // identical pieces string — positional shim over the shared object-arg fn.
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
    repairScope?: RepairScope | null,
  ): string | null =>
    piecesForShared({
      code,
      baseModel,
      wipComponents,
      cat,
      special,
      sizeLabel,
      fabricCode,
      gapInches: g,
      divanHeightInches: d,
      legHeightInches: l,
      qty,
      repairScope,
    });

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
      // "Repair: HB only" when this line is a narrowed partial repair; null
      // otherwise. Printed under the DO line's spec (English — PDF has no CJK).
      repairNote: string | null;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
      // Packing completion date — set ONLY when every PACKING JC of the
      // line's PO is COMPLETED/TRANSFERRED (latest completedDate); null =
      // not fully packed. Matches the on-screen Packed column (mapPO).
      packedDate: string | null;
      // Warehouse rack per component type, e.g.
      // [{ label: "HB", racks: ["Rack 3"] },
      //  { label: "DIVAN", racks: ["Rack 3", "Rack 20"] }].
      componentRacks: { label: string; racks: string[] }[];
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
    // Partial repair: narrow the printed pieces to just the repaired
    // compartment(s). The note is built ONLY when the scope actually narrowed
    // the line (filtered ≠ full) so a stale-pick fallback never prints a
    // misleading "only". Inventory / invoice are unaffected — they key off the
    // line's set quantity, never this pieces string.
    const lineScope = repairScopeByPo.get(diPoById.get(r.id) || "") ?? null;
    const hasPartial = !!(
      lineScope?.components && lineScope.components.length > 0
    );
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
          hasPartial ? lineScope : null,
        )
      : null;
    let repairNote: string | null = null;
    if (bom && hasPartial && pieces) {
      const fullPieces = piecesFor(
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
        null,
      );
      if (pieces !== fullPieces) repairNote = buildRepairNote(pieces);
    }
    // Packed date + per-component racks from the PO's PACKING job cards.
    // Same rule as the on-screen Packed column (delivery/index.tsx mapPO):
    // every PACKING card done ⇒ latest completedDate; any open card ⇒ null.
    // HB-only BEDFRAME specials ignore stranded DIVAN packing cards (and
    // their racks — a component that isn't shipping has no load location).
    // Shared with the CN print-extras (src/api/lib/print-extras-shared.ts).
    const { packedDate, componentRacks } = deriveComponentRacks(
      packingJcsByPo.get(diPoById.get(r.id) || "") ?? [],
      itemCategory,
      specialOrder,
    );
    items[r.id] = {
      itemCategory,
      customerPOId,
      customerSO,
      customerRef: customerRefLine,
      salesOrderNo: soNo || null,
      specialOrder,
      pieces,
      repairNote,
      gapInches: g,
      divanHeightInches: d,
      legHeightInches: l,
      totalHeightInches: total,
      packedDate,
      componentRacks,
    };
  }
  return {
    customerSO,
    customerRef,
    deliverTo,
    deliveryAddress,
    hubState,
    hubContactName,
    hubContactPhone,
    items,
  };
}

// ---------------------------------------------------------------------------
// POST /api/delivery-orders/:id/notify-customer — customer goods-movement
// emails (2026-06-11).
//
//   kind "DISPATCHED": dispatch notice with the branded DO PDF attached.
//     Recipient: hub email first, customer email second, both blank → skip
//     silently (console.log only, nothing recorded).
//   kind "DELIVERED": invoice notice with the Invoice PDF attached.
//     Recipient: customer email first, hub email second. Requires the
//     auto-created invoice row — no invoice → skip (it's an invoice notice).
//
// The frontend (src/pages/delivery/index.tsx) calls this fire-and-forget
// AFTER a successful status transition; an email failure must NEVER block,
// slow, or roll back the transition, so this endpoint only ever enqueues
// into the durable outbox (outbox_emails — drained by the cron at
// /api/internal/process-email-outbox) and answers 200 for every skip case.
//
// Numbers come from the DB row (doNo, dispatch/delivery dates, invoice
// no/date/amount) — never from the caller. The caller supplies only what it
// derived from our own /print-extras payload (the per-item component
// breakdown + customer PO list, the same object that fed the attached PDF)
// plus the PDF itself.
//
// Idempotency: dispatchEmailAt / deliveredEmailAt stamps on
// delivery_orders, claimed atomically (UPDATE … WHERE col IS NULL) so a
// double-click or a re-transition can't spam the customer. The columns are
// runtime self-applied below; unquoted camelCase DDL folds to lowercase
// (dispatchemailat / deliveredemailat), so reads are dual-key — see
// BUG-2026-06-11-007 in docs/BUG-HISTORY.md.
// ---------------------------------------------------------------------------
export let notifyEmailColumns: Promise<void> | null = null;
export function ensureNotifyEmailColumns(db: D1Database): Promise<void> {
  if (notifyEmailColumns) return notifyEmailColumns;
  notifyEmailColumns = (async () => {
    const stmts = [
      "ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS dispatchEmailAt TEXT",
      "ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS deliveredEmailAt TEXT",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch {
        // ignore — column may already exist or DDL transiently rejected
      }
    }
  })();
  return notifyEmailColumns;
}

// ---------------------------------------------------------------------------
// delivery_incomplete (2026-06-14) — the "delivered with issues" flag for the
// QR deliver flow. 2nd scan offers two outcomes: complete (→ auto-invoice +
// notice, the existing path) or "with issues" (goods delivered but paperwork
// incomplete — e.g. damaged units returning to the office). The latter still
// cascades the SO/fg_units/COGS to DELIVERED but WITHHOLDS the invoice +
// customer notice until an operator resolves it (POST /:id/resolve-incomplete).
//
// INTEGER 0/1 (codebase precedent for boolean flags, e.g. po_scan_samples.
// isGold), NOT NULL DEFAULT 0 so every pre-existing DO reads as "complete" and
// not one current flow changes. Runtime self-applied (no manual migration),
// same idempotent IF-NOT-EXISTS pattern as ensureNotifyEmailColumns. Exported
// so invoices.ts (manual-invoice gate) and public-do-qr.ts (scan summary) can
// guarantee the column exists before their own SELECTs read it.
// ---------------------------------------------------------------------------
export let deliveryIncompleteColumn: Promise<void> | null = null;
export function ensureDeliveryIncompleteColumn(db: D1Database): Promise<void> {
  if (deliveryIncompleteColumn) return deliveryIncompleteColumn;
  deliveryIncompleteColumn = (async () => {
    try {
      await db
        .prepare(
          "ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS delivery_incomplete INTEGER NOT NULL DEFAULT 0",
        )
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
  })();
  return deliveryIncompleteColumn;
}

// Uint8Array → base64 (chunked so a multi-page PDF doesn't blow the arg
// limit of String.fromCharCode). Workers runtime has btoa built in.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// queueDoCustomerNotice — the FULL body of POST /:id/notify-customer above,
// extracted verbatim so the public QR scan flow (routes/public-do-qr.ts)
// can queue the SAME customer notice the office click queues after a
// transition — recipient chain, idempotency stamps and the server-rendered
// invoice-PDF fallback all behave identically. The public caller passes
// only { kind } (no client-rendered PDF), which this path already supports:
// dispatch notices go out without an attachment and invoice notices fall
// back to buildSimpleTablePdf.
// ---------------------------------------------------------------------------
export async function queueDoCustomerNotice(
  c: Context<Env>,
  id: string,
  body: {
    kind?: string;
    pdfBase64?: string;
    pdfFilename?: string;
    itemsBreakdown?: string;
    customerPOIds?: string[];
  },
): Promise<Response> {
  try {
    await ensureNotifyEmailColumns(c.var.DB);
    const kind =
      body.kind === "DISPATCHED" || body.kind === "DELIVERED"
        ? body.kind
        : null;
    if (!kind) {
      return c.json(
        { success: false, error: 'kind must be "DISPATCHED" or "DELIVERED"' },
        400,
      );
    }

    // SELECT * so the runtime-added stamp columns come back too (they live
    // folded-lowercase; never use an explicit camelCase projection for them).
    const doRow = await c.var.DB.prepare(
      "SELECT * FROM delivery_orders WHERE id = ?",
    )
      .bind(id)
      .first<
        DeliveryOrderRow & {
          dispatchEmailAt?: string | null;
          dispatchemailat?: string | null;
          deliveredEmailAt?: string | null;
          deliveredemailat?: string | null;
        }
      >();
    if (!doRow) {
      return c.json({ success: false, error: "Delivery order not found" }, 404);
    }

    // Status guard — a notice for a state the DO isn't in is a stray call.
    if (
      kind === "DISPATCHED" &&
      doRow.status !== "LOADED" &&
      doRow.status !== "IN_TRANSIT"
    ) {
      return c.json(
        {
          success: false,
          error: `Dispatch notice requires a dispatched DO (LOADED/IN_TRANSIT); ${doRow.doNo} is ${doRow.status}`,
        },
        409,
      );
    }
    if (
      kind === "DELIVERED" &&
      doRow.status !== "DELIVERED" &&
      doRow.status !== "INVOICED"
    ) {
      return c.json(
        {
          success: false,
          error: `Invoice notice requires a delivered DO (DELIVERED/INVOICED); ${doRow.doNo} is ${doRow.status}`,
        },
        409,
      );
    }

    // Idempotency pre-check (dual-key read — runtime column is folded).
    const alreadySentAt =
      kind === "DISPATCHED"
        ? (doRow.dispatchEmailAt ?? doRow.dispatchemailat ?? null)
        : (doRow.deliveredEmailAt ?? doRow.deliveredemailat ?? null);
    if (alreadySentAt) {
      return c.json({ success: true, skipped: true, reason: "already sent" });
    }

    // Recipient chain — hub email + customer email straight from the DB.
    let hubEmail: string | null = null;
    let hubShortName = "";
    let hubAddress = "";
    if (doRow.hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT shortName, address, email FROM delivery_hubs WHERE id = ?",
      )
        .bind(doRow.hubId)
        .first<{
          shortName: string | null;
          address: string | null;
          email: string | null;
        }>();
      if (hub) {
        hubEmail = hub.email;
        hubShortName = hub.shortName ?? "";
        hubAddress = hub.address ?? "";
      }
    }
    const customer = await c.var.DB.prepare(
      "SELECT email FROM customers WHERE id = ?",
    )
      .bind(doRow.customerId)
      .first<{ email: string | null }>();
    const to =
      kind === "DISPATCHED"
        ? resolveDispatchRecipient(hubEmail, customer?.email)
        : resolveInvoiceRecipient(customer?.email, hubEmail);
    if (!to) {
      // Owner rule: both blank → don't send, don't record anything.
      console.log(
        `[delivery-orders] ${doRow.doNo}: ${kind} notice skipped — no hub or customer email on file`,
      );
      return c.json({ success: true, skipped: true, reason: "no recipient" });
    }

    // Caller-supplied display strings (derived from our own /print-extras —
    // the same object that fed the attached PDF). Numbering stays DB-owned.
    const customerPOIds = Array.isArray(body.customerPOIds)
      ? body.customerPOIds.map((s) => String(s).trim()).filter(Boolean)
      : [];
    if (customerPOIds.length === 0 && (doRow.customerPOId ?? "").trim()) {
      customerPOIds.push(String(doRow.customerPOId).trim());
    }
    const itemsBreakdown = String(body.itemsBreakdown ?? "").trim();
    const pdfBase64 =
      typeof body.pdfBase64 === "string" && body.pdfBase64.trim()
        ? body.pdfBase64.trim()
        : null;

    let subjectHtmlText: {
      subject: string;
      html: string;
      text: string;
    };
    let attachments:
      | Array<{ filename: string; contentBase64: string }>
      | undefined;

    // Honesty guard: the outbox drops attachments over its 5 MB decoded cap
    // AFTER this template is rendered — so decide "attached or not" with the
    // SAME size rule up front, or the email claims an attachment it doesn't
    // carry (first real send, DO-2606-027: 34-item PDF blew the cap and the
    // customer got "please find attached" with nothing attached).
    const PDF_ATTACH_CAP_BYTES = 5 * 1024 * 1024;
    const pdfTooBig =
      !!pdfBase64 && Math.floor(pdfBase64.length * 0.75) > PDF_ATTACH_CAP_BYTES;
    if (pdfTooBig) {
      console.warn(
        `[delivery-orders] ${doRow.doNo}: ${kind} PDF exceeds the 5 MB attachment cap — sending the notice without it`,
      );
    }
    const attachablePdf = pdfTooBig ? null : pdfBase64;

    if (kind === "DISPATCHED") {
      const deliverTo =
        [hubShortName, hubAddress].filter(Boolean).join(", ") ||
        doRow.deliveryAddress ||
        "";
      if (attachablePdf) {
        attachments = [
          {
            filename:
              String(body.pdfFilename ?? "").trim() || `${doRow.doNo}.pdf`,
            contentBase64: attachablePdf,
          },
        ];
      } else {
        // Server-rendered fallback DO PDF. The dispatch notice usually fires
        // from the backend transition choke-point (queueDoCustomerNotice({kind}))
        // which has NO client-rendered PDF — so without this the customer got
        // the DO email with NOTHING attached (owner 2026-06-26). 2026-07-02
        // upgrade: render the SAME unified DO the FE downloads/e-mails
        // (buildUnifiedDoData + buildUnifiedDocPdf; Workers-pure pdf-lib) so the
        // pure-backend path matches "what the owner sees". buildSimpleTablePdf
        // stays the ULTIMATE fallback so a render bug never kills the notice.
        try {
          const itRes = await c.var.DB.prepare(
            `SELECT id, productCode, productName, fabricCode, sizeLabel, quantity, rackingNumber
               FROM delivery_order_items WHERE deliveryOrderId = ?`,
          )
            .bind(id)
            .all<{
              id: string;
              productCode: string | null;
              productName: string | null;
              fabricCode: string | null;
              sizeLabel: string | null;
              quantity: number;
              rackingNumber: string | null;
            }>();
          // Same per-line enrichment (category / order refs / spec / pieces)
          // the download path gets, so the emailed DO == what the owner prints
          // (owner 2026-07-13). Best-effort — a null just degrades to the plain
          // layout, never blocks the notice.
          const doExtras = await computeDoPrintExtras(c.var.DB, id).catch(() => null);
          const lineRows = (itRes.results ?? []).map((it) => ({
            id: String(it.id),
            productCode: it.productCode || "-",
            productName: it.productName || "-",
            fabricCode: it.fabricCode || "",
            sizeLabel: it.sizeLabel || "",
            quantity: Number(it.quantity ?? 0),
            rackingNumber: it.rackingNumber || null,
            extra: doExtras?.items?.[String(it.id)],
          }));
          // Pull customer's billing address for the Bill To block.
          const custRow = await c.var.DB.prepare(
            "SELECT company_address AS \"companyAddress\" FROM customers WHERE id = ?",
          )
            .bind(doRow.customerId)
            .first<{ companyAddress: string | null }>();
          let bytes: Uint8Array;
          try {
            bytes = await buildUnifiedDocPdf(
              buildUnifiedDoData(
                {
                  doNo: doRow.doNo,
                  docDate: doRow.dispatchedAt ?? "",
                  customerName: doRow.customerName,
                  deliverTo: doExtras?.deliverTo || deliverTo || "",
                  deliveryAddress: doExtras?.deliveryAddress || custRow?.companyAddress || "",
                  contactName: doExtras?.hubContactName || "",
                  contactPhone: doExtras?.hubContactPhone || "",
                  driverName: doRow.driverName ?? "",
                  driverPhone: (doRow.driverPhone ?? "").trim(),
                  lorryPlate: doRow.vehicleNo ?? "",
                  fallbackCustomerSO: doExtras?.customerSO || doRow.customerSO || "",
                  fallbackCustomerRef: doExtras?.customerRef || "",
                  items: lineRows.map((it) => ({
                    id: it.id,
                    productCode: it.productCode,
                    productName: it.productName,
                    fabricCode: it.fabricCode,
                    sizeLabel: it.sizeLabel,
                    quantity: it.quantity,
                    extra: it.extra,
                  })),
                },
                HOOKKA_LOGO_PNG_BASE64,
              ),
            );
          } catch (brandedErr) {
            console.warn(
              `[delivery-orders] ${doRow.doNo}: unified DO fallback failed, using simple table`,
              brandedErr instanceof Error ? brandedErr.message : brandedErr,
            );
            // ULTIMATE fallback — bare table, but the customer still gets
            // SOMETHING attached. Same shape/content as the pre-2026-06-30
            // fallback so behaviour only IMPROVES, never regresses.
            bytes = await buildSimpleTablePdf({
              title: `Delivery Order ${doRow.doNo}`,
              subtitle: `${doRow.customerName} · Dispatched ${fmtEmailDate(doRow.dispatchedAt)}`,
              columns: ["Product Code", "Description", "Qty", "Rack"],
              rows: lineRows.map((it) => [
                it.productCode,
                it.productName,
                String(it.quantity),
                it.rackingNumber || "-",
              ]),
              footer: `HOOKKA INDUSTRIES SDN BHD · Delivery Order ${doRow.doNo}`,
            });
          }
          attachments = [
            {
              filename: `${doRow.doNo}.pdf`,
              contentBase64: bytesToBase64(bytes),
            },
          ];
        } catch (pdfErr) {
          console.warn(
            `[delivery-orders] ${doRow.doNo}: fallback DO PDF failed — sending notice without attachment`,
            pdfErr instanceof Error ? pdfErr.message : pdfErr,
          );
        }
      }
      // Contact No. resolution (owner 2026-06-27 — reverses the 2026-06-12
      // "driver-phone-only, omit if none" stance): the 3PL still has a number
      // even when the DO didn't capture the driver's own phone (driver was
      // free-typed, or an older DO). Resolve in order so the customer always
      // gets someone to call: (1) the phone stored on the DO → (2) the named
      // 3PL driver's phone → (3) the provider's dispatcher contact (joined via
      // the DO's providerId). Best-effort; row still omitted only if all empty.
      let driverContact = (doRow.driverPhone ?? "").trim();
      if (!driverContact && (doRow.driverName ?? "").trim()) {
        const drv = await c.var.DB.prepare(
          "SELECT phone FROM three_pl_drivers WHERE name = ? AND COALESCE(phone,'') <> '' LIMIT 1",
        )
          .bind((doRow.driverName ?? "").trim())
          .first<{ phone?: string | null }>();
        if (drv?.phone) driverContact = String(drv.phone).trim();
      }
      if (!driverContact) {
        const prov = await c.var.DB.prepare(
          "SELECT d.phone AS phone FROM delivery_orders o JOIN drivers d ON d.id = o.providerId WHERE o.id = ? AND COALESCE(d.phone,'') <> '' LIMIT 1",
        )
          .bind(doRow.id)
          .first<{ phone?: string | null }>();
        if (prov?.phone) driverContact = String(prov.phone).trim();
      }
      subjectHtmlText = dispatchNoticeTemplate({
        doNo: doRow.doNo,
        customerName: doRow.customerName,
        customerPOIds,
        dispatchedAt: doRow.dispatchedAt ?? null,
        deliverTo,
        itemsBreakdown,
        hasAttachment: !!attachments,
        // Driver block: name + lorry plate from the DO's 3PL assignment;
        // Contact No. resolved above (DO phone → 3PL driver → provider contact).
        driverName: doRow.driverName ?? null,
        driverContact: driverContact || null,
        lorryPlate: doRow.vehicleNo ?? null,
      });
    } else {
      // Invoice notice — resolve the DO's LIVE invoice the same way
      // loadDoInvoiceMap does (newest non-CANCELLED row for this DO).
      const inv = await c.var.DB.prepare(
        `SELECT id, invoiceNo, invoiceDate, totalSen
           FROM invoices
          WHERE deliveryOrderId = ? AND status <> 'CANCELLED'
          ORDER BY createdAt DESC
          LIMIT 1`,
      )
        .bind(id)
        .first<{
          id: string;
          invoiceNo: string;
          invoiceDate: string | null;
          totalSen: number;
        }>();
      if (!inv) {
        // The email IS the invoice notice; without an invoice row there is
        // nothing to send.
        return c.json({ success: true, skipped: true, reason: "no invoice" });
      }

      if (pdfBase64) {
        attachments = [
          {
            filename:
              String(body.pdfFilename ?? "").trim() ||
              // invoiceNo already carries the "INV-" prefix — don't double it.
              `${/^INV/i.test(inv.invoiceNo) ? inv.invoiceNo : `INV-${inv.invoiceNo}`}.pdf`,
            contentBase64: pdfBase64,
          },
        ];
      } else {
        // Server-rendered fallback (frontend couldn't produce the PDF).
        // 2026-07-02 upgrade: render the SAME unified invoice the FE
        // downloads/e-mails (buildUnifiedInvoiceData + buildUnifiedDocPdf;
        // Workers-pure pdf-lib) so the pure-backend path matches "what the
        // owner sees". The simple table stays the ULTIMATE fallback so a
        // render bug never kills the notice.
        try {
          const itRes = await c.var.DB.prepare(
            `SELECT id, productCode, productName, fabricCode, sizeLabel, quantity, unitPriceSen, totalSen
               FROM invoice_items WHERE invoiceId = ?`,
          )
            .bind(inv.id)
            .all<{
              id: string;
              productCode: string | null;
              productName: string | null;
              fabricCode: string | null;
              sizeLabel: string | null;
              quantity: number;
              unitPriceSen: number;
              totalSen: number;
            }>();
          // Same per-line enrichment (category / order refs / spec) + due date
          // the download path gets, so the emailed invoice == what the owner
          // prints (owner 2026-07-13). Best-effort — a null just degrades to
          // the plain layout, never blocks the notice.
          const printExtras = await computeInvoicePrintExtras(c.var.DB, inv.id).catch(() => null);
          const dueRow = await c.var.DB.prepare(
            "SELECT dueDate FROM invoices WHERE id = ?",
          )
            .bind(inv.id)
            .first<{ dueDate: string | null }>();
          const items = (itRes.results ?? []).map((it) => ({
            id: String(it.id),
            productCode: it.productCode || "-",
            productName: it.productName || "-",
            fabricCode: it.fabricCode || "",
            sizeLabel: it.sizeLabel || "",
            quantity: Number(it.quantity ?? 0),
            unitPriceSen: Number(it.unitPriceSen ?? 0),
            lineTotalSen: Number(it.totalSen ?? 0),
            extra: printExtras?.items?.[String(it.id)],
          }));
          const subtotalSen = items.reduce((s, it) => s + it.lineTotalSen, 0);
          const totalSen = Number(inv.totalSen) || subtotalSen;
          const taxSen = Math.max(0, totalSen - subtotalSen);
          // Pull customer's billing address for the Bill To block.
          const custRow = await c.var.DB.prepare(
            "SELECT company_address AS \"companyAddress\" FROM customers WHERE id = ?",
          )
            .bind(doRow.customerId)
            .first<{ companyAddress: string | null }>();
          let bytes: Uint8Array;
          try {
            bytes = await buildUnifiedDocPdf(
              buildUnifiedInvoiceData(
                {
                  invoiceNo: inv.invoiceNo,
                  doNo: doRow.doNo,
                  docDate: inv.invoiceDate ?? "",
                  dueDate: dueRow?.dueDate ?? "",
                  terms: "NET 30",
                  customerName: doRow.customerName,
                  billAddress: custRow?.companyAddress ?? "",
                  fallbackCustomerSO: printExtras?.customerSO || doRow.customerSO || "",
                  fallbackCustomerRef: printExtras?.customerRef || "",
                  items: items.map((it) => ({
                    id: it.id,
                    productCode: it.productCode,
                    productName: it.productName,
                    fabricCode: it.fabricCode,
                    sizeLabel: it.sizeLabel,
                    quantity: it.quantity,
                    priceSen: it.unitPriceSen,
                    lineTotalSen: it.lineTotalSen,
                    extra: it.extra,
                  })),
                  subtotalSen,
                  taxSen,
                  totalSen,
                },
                HOOKKA_LOGO_PNG_BASE64,
              ),
            );
          } catch (brandedErr) {
            console.warn(
              `[delivery-orders] ${doRow.doNo}: unified invoice fallback failed, using simple table`,
              brandedErr instanceof Error ? brandedErr.message : brandedErr,
            );
            const rm = (sen: number) =>
              ((Number(sen) || 0) / 100).toLocaleString("en-MY", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
            bytes = await buildSimpleTablePdf({
              title: `Invoice ${inv.invoiceNo}`,
              subtitle: `${doRow.customerName} · Delivery Order ${doRow.doNo} · ${fmtEmailDate(inv.invoiceDate)}`,
              columns: [
                "Product Code",
                "Description",
                "Qty",
                "Unit Price (RM)",
                "Amount (RM)",
              ],
              rows: items.map((it) => [
                it.productCode,
                it.productName,
                String(it.quantity),
                rm(it.unitPriceSen),
                rm(it.lineTotalSen),
              ]),
              totals: ["", "", "", "TOTAL (RM)", rm(totalSen)],
              footer: `HOOKKA INDUSTRIES SDN BHD · Computer-generated invoice ${inv.invoiceNo}`,
            });
          }
          attachments = [
            {
              // invoiceNo already carries the "INV-" prefix — don't double it.
              filename: `${/^INV/i.test(inv.invoiceNo) ? inv.invoiceNo : `INV-${inv.invoiceNo}`}.pdf`,
              contentBase64: bytesToBase64(bytes),
            },
          ];
        } catch (pdfErr) {
          console.warn(
            `[delivery-orders] ${doRow.doNo}: fallback invoice PDF failed — sending notice without attachment`,
            pdfErr instanceof Error ? pdfErr.message : pdfErr,
          );
        }
      }

      subjectHtmlText = invoiceNoticeTemplate({
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        doNo: doRow.doNo,
        customerName: doRow.customerName,
        customerPOIds,
        deliveredAt: doRow.deliveredAt ?? null,
        totalSen: Number(inv.totalSen) || 0,
      });
    }

    // Atomic idempotency claim BEFORE the enqueue — two racing calls both
    // pass the pre-check above, but only one wins this UPDATE. The column
    // name is one of two fixed literals (never user input).
    const stampCol =
      kind === "DISPATCHED" ? "dispatchEmailAt" : "deliveredEmailAt";
    const nowIso = new Date().toISOString();
    const claim = await c.var.DB.prepare(
      `UPDATE delivery_orders SET ${stampCol} = ? WHERE id = ? AND ${stampCol} IS NULL`,
    )
      .bind(nowIso, id)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) {
      return c.json({ success: true, skipped: true, reason: "already sent" });
    }

    try {
      await enqueueEmail(c, {
        to,
        subject: subjectHtmlText.subject,
        html: subjectHtmlText.html,
        text: subjectHtmlText.text,
        attachments,
      });
    } catch (enqErr) {
      // Release the claim so the operator can retry; the transition itself
      // is long done and stays untouched.
      try {
        await c.var.DB.prepare(
          `UPDATE delivery_orders SET ${stampCol} = NULL WHERE id = ?`,
        )
          .bind(id)
          .run();
      } catch {
        /* best-effort release */
      }
      throw enqErr;
    }

    return c.json({ success: true, queued: true, to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[POST /api/delivery-orders/${id}/notify-customer] failed:`,
      msg,
    );
    return c.json(
      { success: false, error: msg || "Failed to queue customer notice" },
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// applyDeliveryOrderUpdate — the FULL body of PUT /api/delivery-orders/:id
// above, extracted verbatim so the public QR scan flow (routes/public-do-qr.ts
// POST /api/public/do-qr/:token/advance) transitions a DO through the EXACT
// same path as an office click — every guard + cascade (status-transition
// validation, fg_units stamping + STOCK_OUT on dispatch, SO SHIPPED cascade,
// fg_units DELIVERED + FIFO COGS + SO/auto-invoice cascade with the
// invoice-number collision retry, audit emit) runs once here and only here.
// There is deliberately NO second write path to drift (same rule as
// createPackingListCore in packing-lists.ts).
//
// Auth/orgId contract: the office route gates with requirePermission before
// calling. The public route validates the unguessable qrtoken instead and
// stashes the DO row's own orgId on the context (the DELIVERED cascade reads
// getOrgId(c) for the invoice ledger legs) — see public-do-qr.ts.
// ---------------------------------------------------------------------------
export async function applyDeliveryOrderUpdate(
  c: Context<Env>,
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
): Promise<Response> {
  try {
    // Guarantee the delivered-with-issues column exists before SELECT * reads
    // it (the office PUT and the public QR scan both land here). Cached promise
    // → the ALTER runs at most once per worker; later calls are a no-op await.
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
    // Cascade lock — once an Invoice references this DO, the DO becomes
    // read-only (its line items are already on the customer's bill).
    // Status-only transitions to CANCELLED still go through here, but
    // those are gated by other guards below; the lock only fires for
    // edits that touch items / quantities / customer / driver.
    const lockMsg = await checkDeliveryOrderLocked(c.var.DB, id);
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

    // delivered-with-issues request (2nd QR scan "Delivered with issues", or
    // the office equivalent). Only meaningful on a →DELIVERED transition.
    const wantIncomplete =
      body.deliveryIncomplete === true || body.deliveryIncomplete === 1;
    const wasIncomplete = Number(existing.delivery_incomplete) === 1;

    // --- status transition validation (same rules as mock-data) ---
    let nextStatus: string = existing.status;
    let nextDispatchedAt: string | null = existing.dispatchedAt;
    let nextDeliveredAt: string | null = existing.deliveredAt;
    let nextOverdue: string | null = existing.overdue;
    // Carry the flag forward untouched unless a →DELIVERED transition sets it.
    let nextDeliveryIncomplete = wasIncomplete ? 1 : 0;

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
      // Hard gate: a DO delivered "with issues" cannot be invoiced until the
      // paperwork is resolved (POST /:id/resolve-incomplete clears the flag and
      // creates the withheld invoice). Blocks the "Convert to Invoice" button
      // (DELIVERED → INVOICED is a bare status flip that does NOT create an
      // invoice row) from finalising an unbilled DO.
      if (body.status === "INVOICED" && wasIncomplete) {
        return c.json(
          {
            success: false,
            error:
              "This delivery was marked DELIVERED WITH ISSUES — resolve the paperwork (Mark documents complete) before it can be invoiced.",
          },
          409,
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
        // Stamp the flag from THIS delivery's outcome (complete clears it,
        // with-issues sets it). FIFO FG_DELIVERED COGS is emitted inside the
        // cascadedToDelivered block below so it rides the same atomic batch.
        nextDeliveryIncomplete = wantIncomplete ? 1 : 0;
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
      // Edit / Add-Items must obey the SAME three composition rules as create
      // (Wei Siang 2026-06-11). Before this guard, "Add Items" on the edit
      // screen replaced the item set with zero validation, so a PO from
      // another customer/hub could be merged into this DO and silently split
      // the destination (root cause of DO-2606-029). excludeDoId = this DO so
      // its own existing POs don't trip the duplicate-delivery check.
      const editPoIds = newItems
        .map((i) => i.productionOrderId)
        .filter((x): x is string => !!x);
      const composition = await validateDoComposition(c.var.DB, editPoIds, id);
      if (!composition.ok) {
        return c.json(
          { success: false, error: composition.error },
          composition.status,
        );
      }
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
           delivery_incomplete = ?, updated_at = ?
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
        nextDeliveryIncomplete,
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
              `${existing.doNo} dispatched`,
              now,
            ),
          );
        }

        // Auto stock-out (owner 2026-06-25): dispatch (DRAFT→LOADED) physically
        // removes the goods from their warehouse racks, so the Rack grid
        // self-clears instead of accumulating shipped pieces. The STOCK_OUT
        // movement is already logged per-PO above (the audit record), so here we
        // only DELETE the rack_items for THIS DO's POs and recompute each
        // affected rack's stored status. Idempotent (a re-dispatch finds no
        // rack_items) + scoped to this DO. Wrapped so a warehouse read hiccup
        // can't block the dispatch; the writes ride the same atomic batch as the
        // rest of the dispatch cascade.
        try {
          const affectedRacks =
            (
              await c.var.DB.prepare(
                `SELECT DISTINCT rackLocationId FROM rack_items
                   WHERE productionOrderId IN (${ph})`,
              )
                .bind(...itemPoIds)
                .all<{ rackLocationId: string }>()
            ).results ?? [];
          if (affectedRacks.length > 0) {
            statements.push(
              c.var.DB.prepare(
                `DELETE FROM rack_items WHERE productionOrderId IN (${ph})`,
              ).bind(...itemPoIds),
            );
            for (const ar of affectedRacks) {
              statements.push(
                c.var.DB.prepare(
                  // Recompute the STORED status (read by the rack picker's
                  // `SELECT rack, status`). A legacy denormalized single-item
                  // rack (productCode set, no rack_items) stays OCCUPIED — only
                  // scan-flow rack_items clear on dispatch.
                  `UPDATE rack_locations
                      SET status = CASE
                        WHEN reserved = 1 THEN 'RESERVED'
                        WHEN (EXISTS(SELECT 1 FROM rack_items WHERE rackLocationId = ?)
                              OR productCode IS NOT NULL) THEN 'OCCUPIED'
                        ELSE 'EMPTY' END
                    WHERE id = ?`,
                ).bind(ar.rackLocationId, ar.rackLocationId),
              );
            }
          }
        } catch (e) {
          console.warn(
            `[DO ${existing.doNo}] dispatch rack auto-stock-out skipped:`,
            e,
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
              JSON.stringify([`${existing.doNo} dispatched (LOADED)`]),
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
            `${existing.doNo} reverted to DRAFT`,
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
              JSON.stringify([`${existing.doNo} un-dispatched (LOADED→DRAFT)`]),
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
        // The auto-created invoice must be dated to when the DO was
        // delivered, not "today" — pass the just-computed delivered timestamp
        // (nextDeliveredAt) so buildDoDeliveredSoAndInvoice dates the invoice
        // to the delivery, even though `existing` is the pre-update snapshot.
        const cascadeOrgId = getOrgId(c);
        const cascadeActorUserId =
          (c as unknown as { get: (k: string) => string | undefined }).get(
            "userId",
          ) ?? null;
        const dc = await buildDoDeliveredSoAndInvoice(
          c.var.DB,
          { ...existing, deliveredAt: nextDeliveredAt ?? existing.deliveredAt },
          now,
          cascadeOrgId,
          cascadeActorUserId,
          // Delivered with issues → withhold the invoice (SO/COGS still cascade).
          nextDeliveryIncomplete === 1,
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

    // -------------------------------------------------------------------
    // BACKEND customer-notice trigger (the safety net — BUG-2026-06-23).
    // This is the SINGLE choke-point every DO status transition funnels
    // through (office PUT /:id AND the public driver-sticker QR scan), so
    // firing here guarantees the dispatch/invoice email goes out no matter
    // which UI/driver path drove the transition — including the bulk-list
    // actions and PL-first dispatches whose FE notify call was skipped or
    // ran against a stale row set. Fire-and-forget + idempotency-stamped, so
    // it neither blocks the transition nor double-sends with the FE trigger.
    //
    //   * DISPATCHED → on any transition that lands the DO in LOADED (the
    //     dispatch boundary; public-do-qr maps its DISPATCH step to to:LOADED).
    //   * DELIVERED  → on the move into DELIVERED (sends the invoice notice,
    //     using the DO's auto-created invoice) AND on a direct DELIVERED →
    //     INVOICED bare flip ("Convert to Invoice" button) so that path also
    //     notifies. queueDoCustomerNotice no-ops if no invoice row exists yet.
    // -------------------------------------------------------------------
    if (existing.status !== "LOADED" && nextStatus === "LOADED") {
      fireCustomerNoticeBestEffort(c, id, "DISPATCHED");
    }
    if (
      existing.status !== "DELIVERED" &&
      existing.status !== "INVOICED" &&
      (nextStatus === "DELIVERED" || nextStatus === "INVOICED")
    ) {
      fireCustomerNoticeBestEffort(c, id, "DELIVERED");
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
}
