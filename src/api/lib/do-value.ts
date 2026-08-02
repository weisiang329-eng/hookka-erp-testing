// ---------------------------------------------------------------------------
// do-value.ts — ONE source of truth for "value of goods" derivation.
//
// delivery_orders has no monetary column. Each item is priced at the unit
// price of ITS OWN sales-order line, resolved deterministically via the
// item's production order: the PO records exactly which SO + line
// (productCode + sizeCode + fabricCode) it was made for, so there is no
// fuzzy "first price for this product code" guessing and no double-count
// when a product appears on more than one SO line.
//
// Resolution order per item (first hit wins):
//   1. PO's (salesOrderId, productCode, sizeCode, fabricCode) → SO line
//   2. PO's (salesOrderId, productCode) → SO line   (size/fabric drift)
//   3. (anySO, productCode) → SO line                (legacy / no PO)
//   4. 0
//
// Shared by the Delivery per-row Amount, the DO /stats tab totals, the
// Planning/Pending Delivery PO values, the invoices, AND the Sales Orders
// Delivered/Outstanding split — so every surface reconciles to the cent.
// ---------------------------------------------------------------------------
import { withSnapshot } from "./snapshot";

export type SoLinePriceIndex = {
  poById: Map<
    string,
    {
      salesOrderId: string;
      productCode: string;
      sizeCode: string;
      fabricCode: string;
    }
  >;
  byFull: Map<string, number>; // `${soId}|${code}|${size}|${fab}` → unitPriceSen
  byCode: Map<string, number>; // `${soId}|${code}` → unitPriceSen
  byAnyCode: Map<string, number>; // `${code}` → unitPriceSen (last resort)
};

export function priceForItem(
  idx: SoLinePriceIndex,
  productionOrderId: string | null | undefined,
  fallbackSoId: string | null | undefined,
  productCode: string | null | undefined,
): number {
  const code = productCode ?? "";
  const po = productionOrderId ? idx.poById.get(productionOrderId) : undefined;
  const soId = po?.salesOrderId || fallbackSoId || "";
  if (po && soId) {
    const full = idx.byFull.get(
      `${soId}|${po.productCode}|${po.sizeCode}|${po.fabricCode}`,
    );
    if (full != null) return full;
    const byCode = idx.byCode.get(`${soId}|${po.productCode}`);
    if (byCode != null) return byCode;
  }
  if (soId && code) {
    const byCode = idx.byCode.get(`${soId}|${code}`);
    if (byCode != null) return byCode;
  }
  return idx.byAnyCode.get(code) ?? 0;
}

// Whole-org price index (2 bulk reads, no N+1) — scopes SO items via their
// SO so it is correct whether or not sales_order_items carries orgId.
export async function loadSoLinePriceIndex(
  db: D1Database,
  orgId: string,
): Promise<SoLinePriceIndex> {
  const [poRes, siRes] = await Promise.all([
    db
      .prepare(
        "SELECT id, salesOrderId, productCode, sizeCode, fabricCode FROM production_orders WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        id: string;
        salesOrderId: string | null;
        productCode: string | null;
        sizeCode: string | null;
        fabricCode: string | null;
      }>(),
    db
      .prepare(
        `SELECT si.salesOrderId AS salesOrderId, si.productCode AS productCode,
                si.sizeCode AS sizeCode, si.fabricCode AS fabricCode,
                si.unitPriceSen AS unitPriceSen
           FROM sales_order_items si
           JOIN sales_orders s ON s.id = si.salesOrderId
          WHERE s.orgId = ?`,
      )
      .bind(orgId)
      .all<{
        salesOrderId: string | null;
        productCode: string | null;
        sizeCode: string | null;
        fabricCode: string | null;
        unitPriceSen: number;
      }>(),
  ]);
  const poById = new Map<
    string,
    {
      salesOrderId: string;
      productCode: string;
      sizeCode: string;
      fabricCode: string;
    }
  >();
  for (const p of poRes.results ?? []) {
    poById.set(p.id, {
      salesOrderId: p.salesOrderId ?? "",
      productCode: p.productCode ?? "",
      sizeCode: p.sizeCode ?? "",
      fabricCode: p.fabricCode ?? "",
    });
  }
  const byFull = new Map<string, number>();
  const byCode = new Map<string, number>();
  const byAnyCode = new Map<string, number>();
  for (const si of siRes.results ?? []) {
    const so = si.salesOrderId ?? "";
    const code = si.productCode ?? "";
    const up = si.unitPriceSen || 0;
    const fk = `${so}|${code}|${si.sizeCode ?? ""}|${si.fabricCode ?? ""}`;
    if (!byFull.has(fk)) byFull.set(fk, up);
    const ck = `${so}|${code}`;
    if (!byCode.has(ck)) byCode.set(ck, up);
    if (code && !byAnyCode.has(code)) byAnyCode.set(code, up);
  }
  return { poById, byFull, byCode, byAnyCode };
}

// Per-DO exact value (item qty × its SO-line price).
export async function loadDoValueMap(
  db: D1Database,
  orgId: string,
): Promise<Map<string, number>> {
  const [idx, itemsRes] = await Promise.all([
    loadSoLinePriceIndex(db, orgId),
    db
      .prepare(
        "SELECT deliveryOrderId, productionOrderId, productCode, quantity FROM delivery_order_items WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        deliveryOrderId: string;
        productionOrderId: string | null;
        productCode: string | null;
        quantity: number;
      }>(),
  ]);
  const doSo = new Map<string, string>();
  const doRows = await db
    .prepare("SELECT id, salesOrderId FROM delivery_orders WHERE orgId = ?")
    .bind(orgId)
    .all<{ id: string; salesOrderId: string | null }>();
  for (const d of doRows.results ?? []) doSo.set(d.id, d.salesOrderId ?? "");

  const m = new Map<string, number>();
  for (const di of itemsRes.results ?? []) {
    const price = priceForItem(
      idx,
      di.productionOrderId,
      doSo.get(di.deliveryOrderId) ?? "",
      di.productCode,
    );
    const add = price * (di.quantity || 0);
    m.set(di.deliveryOrderId, (m.get(di.deliveryOrderId) ?? 0) + add);
  }
  return m;
}

// ── Cached DO value map (perf 2026-07-13) ────────────────────────────────────
// The DO list computed the WHOLE-ORG value map on every read (loadSoLinePrice-
// Index scans every PO + SO line), so even a 50-row page paid a 27s cold /
// 1.6-5s warm recompute (owner: "之前 OK、突然變卡"). This wraps the SAME
// computation in a snapshot + serve-stale-while-revalidate: the read gets the
// last exact result instantly and the recompute runs in the background off the
// request path. The number is BYTE-IDENTICAL to loadDoValueMap — accuracy is
// untouched (owner: "銷售額一定要準確"); only the timing moves. Any snapshot
// failure falls straight back to the direct computation.
// A BOOLEAN, not the promise. Caching the promise meant a failed DDL was
// remembered as done for the life of the isolate — the table was never created
// and never retried — and a pending promise holds the socket of the request
// that made it, which db-pg.ts forbids sharing across requests. The flag is
// set only on success, so a transient failure simply leaves the next request
// to try again. Failure behaviour is unchanged: it is still swallowed here.
let _doValSnapMig = false;
async function ensureDoValueSnapshot(db: D1Database): Promise<void> {
  if (_doValSnapMig) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS do_value_map_snapshot (
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
    _doValSnapMig = true;
  } catch {
    /* transient — leave the flag unset so the next request retries */
  }
}

export async function loadDoValueMapCached(
  db: D1Database,
  orgId: string,
  c?: { env: unknown; executionCtx?: { waitUntil(p: Promise<unknown>): void } },
): Promise<Map<string, number>> {
  try {
    await ensureDoValueSnapshot(db);
    const obj = await withSnapshot<{ m: Record<string, number> }>(
      db,
      {
        tableName: "do_value_map_snapshot",
        // Any change to a table the value depends on invalidates the snapshot
        // → the next read recomputes (in the background via SWR). Guarantees
        // the cached figure never drifts from the live data.
        sourceTables: [
          "delivery_orders",
          "delivery_order_items",
          "production_orders",
          "sales_order_items",
        ],
      },
      orgId,
      async () => {
        const m = await loadDoValueMap(db, orgId);
        const rec: Record<string, number> = {};
        for (const [k, v] of m) rec[k] = v;
        return { m: rec };
      },
      "",
      c,
      { staleWhileRevalidate: true },
    );
    const out = new Map<string, number>();
    for (const [k, v] of Object.entries(obj?.m ?? {})) out.set(k, Number(v) || 0);
    return out;
  } catch {
    // Snapshot layer unavailable → direct (still exact) computation.
    return loadDoValueMap(db, orgId);
  }
}

// Per-PO exact value (PO qty × its own SO-line price) — for the
// Planning / Pending Delivery tabs (PO-based, no DO yet).
export async function loadPoValueMap(
  db: D1Database,
  orgId: string,
): Promise<Map<string, number>> {
  const [idx, poRes] = await Promise.all([
    loadSoLinePriceIndex(db, orgId),
    db
      .prepare(
        "SELECT id, salesOrderId, productCode, quantity FROM production_orders WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        id: string;
        salesOrderId: string | null;
        productCode: string | null;
        quantity: number;
      }>(),
  ]);
  const m = new Map<string, number>();
  for (const p of poRes.results ?? []) {
    const price = priceForItem(idx, p.id, p.salesOrderId, p.productCode);
    m.set(p.id, price * (p.quantity || 0));
  }
  return m;
}

// DO statuses that mean "goods have left the warehouse" (delivered value).
const SHIPPED_DO_STATUSES = new Set([
  "LOADED",
  "IN_TRANSIT",
  "DELIVERED",
  "INVOICED",
]);

// Total value of items ACTUALLY delivered = Σ over delivery_order_items on
// shipped (non-cancelled) DOs of (qty × its own SO-line price). This is the
// item-level "Delivered" figure: a partially-delivered SO contributes only
// the value of the items that actually went on a delivery note. Used by the
// Sales Orders Delivered/Outstanding split so it reconciles, to the cent,
// with the Delivery side (same resolver) instead of using whole-SO header
// totals (which over-count partially-delivered orders).
export async function loadDeliveredItemsValueSen(
  db: D1Database,
  orgId: string,
): Promise<number> {
  const [idx, itemsRes, doRes] = await Promise.all([
    loadSoLinePriceIndex(db, orgId),
    db
      .prepare(
        "SELECT deliveryOrderId, productionOrderId, productCode, quantity FROM delivery_order_items WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        deliveryOrderId: string;
        productionOrderId: string | null;
        productCode: string | null;
        quantity: number;
      }>(),
    db
      .prepare(
        "SELECT id, salesOrderId, status FROM delivery_orders WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{ id: string; salesOrderId: string | null; status: string }>(),
  ]);
  const doSo = new Map<string, string>();
  const doShipped = new Map<string, boolean>();
  for (const d of doRes.results ?? []) {
    doSo.set(d.id, d.salesOrderId ?? "");
    doShipped.set(d.id, SHIPPED_DO_STATUSES.has(d.status));
  }
  let total = 0;
  for (const di of itemsRes.results ?? []) {
    if (!doShipped.get(di.deliveryOrderId)) continue;
    const price = priceForItem(
      idx,
      di.productionOrderId,
      doSo.get(di.deliveryOrderId) ?? "",
      di.productCode,
    );
    total += price * (di.quantity || 0);
  }
  return total;
}
