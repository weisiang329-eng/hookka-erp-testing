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
      const dyn: FGItem = {
        id,
        code: po.productCode,
        name: po.productName || po.productCode,
        category: po.itemCategory as "BEDFRAME" | "SOFA",
        description: "",
        baseModel: po.productCode,
        sizeCode: po.sizeCode || "",
        sizeLabel: po.sizeLabel || "",
        fabricUsage: 0,
        unitM3: 0,
        status: "ACTIVE",
        costPriceSen: 0,
        productionTimeMinutes: 0,
        subAssemblies: [],
        bomComponents: [],
        deptWorkingTimes: [],
        stockQty: 0,
        reservedQty: 0,
      };
      fgMap.set(id, dyn);
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
