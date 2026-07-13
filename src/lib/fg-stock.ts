// Single source of truth for Finished-Goods stock derivation. A production
// order whose UPHOLSTERY cards are ALL completed is a finished good; it counts
// as free stock (stockQty) unless it's earmarked by a DRAFT delivery/consignment
// (reservedQty) or already dispatched (drops out). Extracted VERBATIM from the
// Inventory page (src/pages/inventory/index.tsx) so the server can compute the
// SAME FG rows and stop shipping the ~1.2MB production-orders+jobCards payload
// to the client just to derive them. Both the FE and the
// /api/inventory/fg-stock endpoint call this ONE function → byte-identical by
// construction. See docs/PERF-DURABLE-ARCHITECTURE.md.

import type { Product } from "@/types";

export type FGItem = Product & { stockQty: number; reservedQty: number };

// The subset of a production order this derivation reads. ProductionOrderLike
// (inventory page) / MinimalPOOut (API) both satisfy it structurally.
export type FgStockPO = {
  id: string;
  productId: string;
  productCode: string;
  productName?: string;
  itemCategory?: string;
  sizeCode?: string;
  sizeLabel?: string;
  quantity: number;
  jobCards: Array<{ departmentCode: string; status: string }>;
};

// poStatusByDO: PO id → coarse warehouse state.
//   DISPATCHED → out of warehouse, don't count anywhere
//   DRAFT      → still ours but earmarked → reservedQty bucket
//   (absent)   → free stock → stockQty bucket
export function deriveFGStock(
  products: Product[],
  productionOrders: FgStockPO[],
  poStatusByDO: Map<string, "DRAFT" | "DISPATCHED">,
): FGItem[] {
  const fgMap = new Map<string, FGItem>();
  for (const p of products) {
    fgMap.set(p.id, { ...p, stockQty: 0, reservedQty: 0 });
  }

  const findOrCreate = (po: FgStockPO): FGItem | null => {
    let fg = fgMap.get(po.productId);
    if (!fg) {
      for (const [, item] of fgMap) {
        if (item.code === po.productCode) {
          fg = item;
          break;
        }
      }
    }
    if (fg) return fg;
    const id = `fg-dyn-${po.productCode}`;
    if (!fgMap.has(id)) {
      fgMap.set(
        id,
        makeDynShell({
          id,
          code: po.productCode,
          name: po.productName || po.productCode,
          category: po.itemCategory,
          sizeCode: po.sizeCode,
          sizeLabel: po.sizeLabel,
        }),
      );
    }
    return fgMap.get(id)!;
  };

  for (const po of productionOrders) {
    const uphCards = po.jobCards.filter(
      (jc) => jc.departmentCode === "UPHOLSTERY",
    );
    if (uphCards.length === 0) continue;
    if (
      !uphCards.every(
        (jc) => jc.status === "COMPLETED" || jc.status === "TRANSFERRED",
      )
    )
      continue;

    const doState = poStatusByDO.get(po.id);
    if (doState === "DISPATCHED") continue; // already out the door

    const fg = findOrCreate(po);
    if (!fg) continue;
    if (doState === "DRAFT") {
      fg.reservedQty += po.quantity;
    } else {
      fg.stockQty += po.quantity;
    }
  }

  return Array.from(fgMap.values());
}

// An FG row for a production order whose product is NOT in the active catalog
// (dynamic fg-dyn-* row). Shared by deriveFGStock's findOrCreate and the FE
// merge so both surfaces render the off-catalog row with the SAME shape.
function makeDynShell(f: {
  id: string;
  code: string;
  name: string;
  category?: string;
  sizeCode?: string;
  sizeLabel?: string;
  stockQty?: number;
  reservedQty?: number;
}): FGItem {
  return {
    id: f.id,
    code: f.code,
    name: f.name,
    category: f.category as "BEDFRAME" | "SOFA",
    description: "",
    baseModel: f.code,
    sizeCode: f.sizeCode || "",
    sizeLabel: f.sizeLabel || "",
    fabricUsage: 0,
    unitM3: 0,
    status: "ACTIVE",
    costPriceSen: 0,
    productionTimeMinutes: 0,
    subAssemblies: [],
    bomComponents: [],
    deptWorkingTimes: [],
    stockQty: f.stockQty ?? 0,
    reservedQty: f.reservedQty ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Deltas transport — how the /api/inventory/fg-stock endpoint ships the result
// and how the Inventory page merges it back onto the product catalog. Splitting
// deriveFGStock's output into (counts to merge by id) + (off-catalog dynamics)
// lets the page keep its own /api/products fetch (full product assembly) and
// drop the ~1.2MB production-orders + DO/CN state pulls with ZERO product-shape
// risk. Only rows carrying stock travel. Round-trip identity is guaranteed:
//   mergeFgDeltas(products, splitFgDeltas(deriveFGStock(products, pos, states)))
// has the same per-item stock/reserved as deriveFGStock(products, pos, states).
// (tests/fg-stock.test.mjs proves it.)
// ---------------------------------------------------------------------------
export type FgDeltaCount = { id: string; stockQty: number; reservedQty: number };
export type FgDeltaDyn = {
  id: string;
  code: string;
  name: string;
  category?: string;
  sizeCode?: string;
  sizeLabel?: string;
  stockQty: number;
  reservedQty: number;
};
export type FgDeltas = { counts: FgDeltaCount[]; dyn: FgDeltaDyn[] };

// Endpoint side: reduce the full FGItem[] to the ~few dozen rows with stock,
// split into catalog products (merge by id) vs off-catalog dynamics.
export function splitFgDeltas(fgItems: FGItem[]): FgDeltas {
  const counts: FgDeltaCount[] = [];
  const dyn: FgDeltaDyn[] = [];
  for (const f of fgItems) {
    if (f.stockQty === 0 && f.reservedQty === 0) continue;
    if (String(f.id).startsWith("fg-dyn-")) {
      dyn.push({
        id: f.id,
        code: f.code,
        name: f.name,
        category: f.category,
        sizeCode: f.sizeCode,
        sizeLabel: f.sizeLabel,
        stockQty: f.stockQty,
        reservedQty: f.reservedQty,
      });
    } else {
      counts.push({
        id: f.id,
        stockQty: f.stockQty,
        reservedQty: f.reservedQty,
      });
    }
  }
  return { counts, dyn };
}

// FE side: merge the deltas onto the product catalog → the exact FGItem[] the
// old client-side deriveFGStock produced. Catalog products get their counts by
// id (0/0 when absent); off-catalog dynamics become fg-dyn-* shells.
export function mergeFgDeltas(products: Product[], deltas: FgDeltas): FGItem[] {
  const byId = new Map(deltas.counts.map((c) => [c.id, c]));
  const items: FGItem[] = products.map((p) => {
    const c = byId.get(p.id);
    return { ...p, stockQty: c?.stockQty ?? 0, reservedQty: c?.reservedQty ?? 0 };
  });
  for (const d of deltas.dyn) {
    items.push(makeDynShell(d));
  }
  return items;
}
