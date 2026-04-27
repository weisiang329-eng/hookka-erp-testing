import { useState, useMemo, useEffect } from "react";
import { cachedFetchJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Boxes, AlertTriangle, Package, Layers, Plus, X,
  Search, Archive, Upload,
} from "lucide-react";
import { BatchImportDialog, type ImportColumn } from "@/components/ui/batch-import-dialog";
// NOTE: mock arrays were previously imported here and used as the page data
// source. They are retained only for TYPE imports; all runtime data is now
// fetched live from D1 via the API. After a D1 clear the UI now correctly
// renders zero balances instead of baked-in seed values.
import { type Product, type RawMaterial } from "@/lib/mock-data";
import type { FGBatch } from "@/types";
import {
  SUCCESS, NEUTRAL,
  INVENTORY_TYPE_COLOR,
  getStockSemantic, getWipAgeSemantic,
} from "@/lib/design-tokens";

// -- FIFO cost column helpers ----------------------------------------------
// These USED to read from the module-scope `rmBatches`/`fgBatches` mock
// arrays. No D1 endpoint exists yet for batch layers, so both helpers now
// return empty arrays — downstream weighted-average cost calcs gracefully
// return 0. Wire these up once GRN/PO batch tables are exposed via the API.

/** Return all FG layers for a product (oldest-first). */
function batchesForProduct(_productId: string): FGBatch[] {
  return [];
}

/** Weighted-avg unit cost across FG layers for a product (sen). */
function avgFGUnitCostSen(productId: string): number {
  const layers = batchesForProduct(productId);
  let qty = 0;
  let cost = 0;
  for (const l of layers) {
    if (l.remainingQty <= 0) continue;
    qty += l.remainingQty;
    cost += l.remainingQty * l.unitCostSen;
  }
  return qty > 0 ? cost / qty : 0;
}

/** Total value of on-hand FG for a product (sen). */
function totalFGValueSen(productId: string): number {
  return batchesForProduct(productId).reduce(
    (s, l) => s + Math.max(0, l.remainingQty) * l.unitCostSen,
    0,
  );
}

/**
 * Days since the oldest active batch was received — this is the FIFO-next
 * batch, so its age is what the user cares about. `dateField` is
 * "receivedDate" for RM, "completedDate" for FG. Returns -1 when nothing
 * is on hand (no active batches) so the renderer can show a dash.
 */
function oldestBatchAgeDays(
  batches: { remainingQty: number }[],
  getDate: (b: never) => string,
): number {
  const today = Date.now();
  let oldestTs = Infinity;
  for (const b of batches) {
    if (b.remainingQty <= 0) continue;
    const ts = new Date(getDate(b as never)).getTime();
    if (Number.isFinite(ts) && ts < oldestTs) oldestTs = ts;
  }
  if (!Number.isFinite(oldestTs)) return -1;
  return Math.max(0, Math.floor((today - oldestTs) / 86400000));
}

function oldestFGAgeDays(productId: string): number {
  return oldestBatchAgeDays(
    batchesForProduct(productId),
    (b: FGBatch) => b.completedDate,
  );
}

/** Render an age number the same way the WIP column does. */
function renderAgeCell(ageDays: number) {
  if (ageDays < 0) {
    return <span className="text-[#9CA3AF]">—</span>;
  }
  const sem = getWipAgeSemantic(ageDays);
  const weight = ageDays > 14 ? "font-semibold" : ageDays > 7 ? "font-medium" : "";
  const textCls = ageDays > 7 ? sem.text : "text-[#1F1D1B]";
  const label = ageDays === 0 ? "Today" : ageDays === 1 ? "1 day" : `${ageDays} days`;
  return <span className={`${textCls} ${weight}`}>{label}</span>;
}

/** Display RM/unit with 2 decimals, or "—" if no cost info. */
function formatUnitCost(sen: number): string {
  if (!Number.isFinite(sen) || sen <= 0) return "—";
  return (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Display RM total with thousands separator. */
function formatValue(sen: number): string {
  if (!Number.isFinite(sen) || sen <= 0) return "—";
  return (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================
// Types
// ============================================================

type Tab = "FINISHED" | "WIP" | "RAW";

const TABS: { key: Tab; label: string }[] = [
  { key: "FINISHED", label: "Finished Products" },
  { key: "WIP", label: "WIP" },
  { key: "RAW", label: "Raw Materials" },
];

// --- Finished Products with stock ---
type FGItem = Product & { stockQty: number };

// Loose shape that covers the fields WIP/FG derivation reads from a
// production order. Typed loosely so the live API payload (which matches
// the shape but isn't typed by mock-data anymore) fits without churn.
type ProductionOrderLike = {
  poNo: string;
  productId: string;
  productCode: string;
  productName?: string;
  itemCategory?: string;
  sizeCode?: string;
  sizeLabel?: string;
  // Fabric code — needed for the sofa-set merge key (SO + fabric).
  fabricCode?: string;
  // Bedframe height components — summed into the total-height segment
  // of the condensed Fab Cut WIP label (matches the Production page's
  // `fabCutWIP` helper).
  gapInches?: number;
  divanHeightInches?: number;
  legHeightInches?: number;
  quantity: number;
  startDate: string;
  jobCards: Array<{
    departmentCode: string;
    status: string;
    sequence: number;
    completedDate?: string;
    productionTimeMinutes?: number;
    wipKey?: string;
    wipType?: string;
    wipLabel?: string;
    wipCode?: string;
    wipQty?: number;
  }>;
};

// --- WIP ---
// WIP items are derived from production orders, grouped by WIP code.
// Same WIP code = one row, qty summed. Double-click to see all SO IDs.
type WIPSource = {
  poCode: string;
  quantity: number;  // component pieces (= JC wipQty; may include BOM multiplier)
  poQty: number;     // PO.quantity — canonical "set count" driver for sofa merge;
                     // see mergeSofaWIPSets for how it maps to the set-level Qty
                     // column that mirrors Production Fab Cut's "1 set" display.
  completedDate: string;
  ageDays: number;
  // Carried on each source so the sofa-set merge can compute
  // (salesOrderNo, fabricCode) keys without re-fetching the PO.
  fabricCode: string;
  baseModel: string;
  itemCategory: string;
};
type WIPItem = {
  id: string;
  wipCode: string;      // e.g. "1013-(Q) -HB 20" (WD)"
  wipType: string;      // e.g. "Divan", "Headboard", "Base", "Cushion", "SET"
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  relatedProduct: string;
  completedBy: string;  // department that completed this WIP
  totalQty: number;     // summed qty across all POs
  oldestAgeDays: number; // FIFO: oldest item's age
  sources: WIPSource[]; // individual POs for detail view
  // Estimated cost (display only — WIP has no real FIFO batch).
  // Material is allocated across the WHOLE PO's minutes: each production
  // minute carries (fullBOM / totalPOMinsPerUnit) sen of material. A WIP
  // has absorbed (doneMinsInThisWipGroup × material-per-min) of that +
  // (doneMinsInThisWipGroup × laborRate) of labor. This scheme is fully
  // self-consistent: walking every WIP through every dept of the PO
  // accumulates exactly BOM + totalPOMins × rate = the final FG cost.
  estUnitCostSen: number;
  estTotalValueSen: number;
  // Per-JC breakdown (optional — populated for backend-derived rows). Used by
  // the WIP detail dialog to diagnose qty mismatches between the Production
  // Sheet and Inventory WIP (e.g. duplicate JCs in the same wipKey vs single
  // JC with a high wipQty).
  members?: Array<{
    poNo: string;
    jobCardId: string;
    wipType: string;
    quantity: number;
  }>;
};

// --- Create FG form ---
type CreateFGForm = {
  code: string;
  name: string;
  category: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
  // Extra fields cloned from an existing product when the user hits
  // "Copy from existing" — stay blank on a from-scratch create. The POST
  // payload forwards anything non-empty; server slots defaults where
  // undefined so we don't have to special-case fresh rows here.
  description?: string;
  basePriceSen?: number;
  price1Sen?: number;
  unitM3?: number;
  fabricUsage?: number;
  subAssemblies?: unknown;
  pieces?: unknown;
  seatHeightPrices?: unknown;
  skuCode?: string;
  fabricColor?: string;
};

const EMPTY_FG_FORM: CreateFGForm = {
  code: "", name: "", category: "BEDFRAME", baseModel: "", sizeCode: "", sizeLabel: "",
};

// --- Create RM form ---
type CreateRMForm = {
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
  balanceQty: number;
};

// ============================================================
// Mock data generation
// ============================================================

// Finished Products — stock derived from production orders where all
// upholstery cards are COMPLETED (meaning the FG is ready / stocked in).
// Each such PO contributes its quantity to the matching product's stock.
// Now accepts `products` + `productionOrders` as args (previously closed
// over mock-data module globals) so it can be driven from live D1 fetches.
function deriveFGStock(
  products: Product[],
  productionOrders: ProductionOrderLike[],
): FGItem[] {
  // Start with all products at 0 stock
  const fgMap = new Map<string, FGItem>();
  for (const p of products) {
    fgMap.set(p.id, { ...p, stockQty: 0 });
  }

  for (const po of productionOrders) {
    // Only count if upholstery is all done (= finished good)
    const uphCards = po.jobCards.filter(jc => jc.departmentCode === "UPHOLSTERY");
    if (uphCards.length === 0) continue;
    if (!uphCards.every(jc => jc.status === "COMPLETED" || jc.status === "TRANSFERRED")) continue;

    // Skip if fully delivered (stockedIn = false means already shipped out)
    // For now count all completed as in-stock; DO dispatch will deduct later

    // Match by productId or productCode
    let fg = fgMap.get(po.productId);
    if (!fg) {
      // Try matching by code
      for (const [, item] of fgMap) {
        if (item.code === po.productCode) { fg = item; break; }
      }
    }
    if (fg) {
      fg.stockQty += po.quantity;
    } else {
      // Product not in catalog — create a dynamic FG entry. We fill every
      // required Product field with a neutral default so the row passes
      // type-checks; consumers that care about catalog metadata should
      // treat any `fg-dyn-*` id as "no catalog record".
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
        };
        fgMap.set(id, dyn);
      }
      fgMap.get(id)!.stockQty += po.quantity;
    }
  }

  return Array.from(fgMap.values());
}
// (fgItems was previously a module-level const seeded from mock data. It is
// now recomputed inside the component from live fetches — see useMemo below.)

// Row shape for the merged-sofa-set grid. Populated from the
// /api/inventory/wip endpoint's SET rows (wipType === "SET") — the
// backend owns the (SO, fabric) merge logic as of Phase 4.5.
type SofaSetRow = {
  id: string;
  setLabel: string;
  salesOrderNo: string;
  fabric: string;
  totalQty: number;
  oldestAgeDays: number;
  estTotalValueSen: number;
  components: { wipType: string; qty: number }[];
  members: WIPItem[];
};

// Raw response shape from GET /api/inventory/wip. Each row is either a
// per-component WIPItem (wipType != "SET") or a merged sofa set
// (wipType === "SET"); the UI splits them at render time.
type BackendWipRow = {
  id: string;
  wipCode: string;
  wipType: string;
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  completedBy: string;
  relatedProduct: string;
  setQty: number;
  pieceQty: number;
  salesOrderNo: string | null;
  fabric: string;
  oldestAgeDays: number;
  estUnitCostSen: number;
  estTotalValueSen: number;
  members: Array<{
    poNo: string;
    jobCardId: string;
    wipType: string;
    quantity: number;
  }>;
  components?: Array<{ wipType: string; qty: number }>;
  memberItemIds?: string[];
  totalQty: number;
  sources: Array<{
    poCode: string;
    quantity: number;
    poQty: number;
    completedDate: string;
    ageDays: number;
    fabricCode: string;
    baseModel: string;
    itemCategory: string;
  }>;
};

// LEGACY — superseded by /api/inventory/wip endpoint (Phase 4.5).
// The backend now owns edge-detection + label building for FAB_CUT rows.
// Kept here (commented out below) as a dead-code reference so a grep can
// resurrect it if we ever see a regression between the two surfaces.
/*
// Derive WIP items from production orders.
// For each WIP group (by wipKey), walk through the dept sequence.
// A completed dept whose NEXT dept is NOT completed = stock sits here.
// This way we see WIP at every department stage, not just the last one.
function deriveWIPFromPO(
  orders: ProductionOrderLike[],
  products: Product[],
): WIPItem[] {
  const today = new Date();
  // Today's labor rate — applied to work-done-so-far. Using today's (rather
  // than each completion date's) rate is an approximation; the WIP row is
  // an estimate anyway and the rate only floats month-to-month.
  const todayLaborRatePerMinSen = laborRateForDate(today);

  // First pass: collect raw WIP entries
  type RawEntry = {
    wipCode: string; wipType: string; relatedProduct: string;
    completedBy: string; poCode: string; quantity: number;
    poQty: number;   // raw PO.quantity (NOT multiplied by BOM) — drives set-level Qty
    completedDate: string; ageDays: number;
    // Cost per this source emission (already × qty)
    estValueSen: number;  // doneMinsInGroup × (BOM/totalPOMins + rate) × qty
    // Extra per-source context used by the sofa-set merge.
    fabricCode: string; baseModel: string; itemCategory: string;
  };
  const raw: RawEntry[] = [];

  for (const po of orders) {
    // Upholstery all done → Finished Good, not WIP
    const uphCards = po.jobCards.filter(jc => jc.departmentCode === "UPHOLSTERY");
    if (uphCards.length > 0 && uphCards.every(jc => jc.status === "COMPLETED" || jc.status === "TRANSFERRED")) continue;

    // Resolve product once per PO for BOM cost lookup.
    const product = products.find(
      (p) => p.id === po.productId || p.code === po.productCode,
    );
    const bomCostPerUnitSen = bomMaterialCostPerUnitSen(product);

    // Total production minutes for the entire PO (per unit). Material is
    // spread evenly across this time — every minute of work "absorbs"
    // (BOM / totalPOMinsPerUnit) sen of material. This keeps the cost
    // build-up additive: unitCost-so-far + remaining-next-dept = unitCost
    // one dept later, all the way up to BOM + totalPOMins × rate at FG.
    const totalPOMinsPerUnit = po.jobCards.reduce(
      (s, c) => s + (Number(c.productionTimeMinutes) || 0),
      0,
    );
    const materialPerMinuteSen =
      totalPOMinsPerUnit > 0 ? bomCostPerUnitSen / totalPOMinsPerUnit : 0;

    // Group job cards by wipKey
    const groups = new Map<string, typeof po.jobCards>();
    for (const jc of po.jobCards) {
      const key = jc.wipKey || "FG";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(jc);
    }

    for (const [wipKey, cards] of groups) {
      const sorted = [...cards].sort((a, b) => a.sequence - b.sequence);
      const isDone = (c: typeof cards[0]) =>
        c.status === "COMPLETED" || c.status === "TRANSFERRED";

      for (let i = 0; i < sorted.length; i++) {
        const card = sorted[i];
        if (!isDone(card)) continue;
        const nextCard = sorted[i + 1];
        if (nextCard && isDone(nextCard)) continue;

        const completedDate = card.completedDate || po.startDate;
        const dComp = new Date(completedDate);
        const ageDays = Math.max(0, Math.floor((today.getTime() - dComp.getTime()) / 86400000));
        // wipKey has the form "<product>::<idx>::<TYPE>::<code>" — parse out
        // the short type segment so the Type column can show "DIVAN" instead
        // of the whole composite key. Fall back to jc.wipType when wipKey is
        // missing (seed/legacy rows).
        const wipTypeShort =
          card.wipType ||
          (wipKey.includes("::") ? wipKey.split("::")[2] || "" : wipKey) ||
          "";
        // For Fab Cut we compute the condensed WIP label on the fly from
        // PO fields so the Inventory column matches the Production page's
        // `fabCutWIP` helper (src/pages/production/index.tsx ~L1288) —
        // shape: `{product} | ({size}) | ({totalH}) | {fabric} | (FC)`
        // with the total-height segment omitted when no BF heights exist.
        // Sofa consumption math relies on this code equalling the Fab Cut
        // wipLabel so stock codes line up downstream.
        let wipCodeStr: string;
        if (card.departmentCode === "FAB_CUT") {
          const totalH =
            (po.gapInches || 0) +
            (po.divanHeightInches || 0) +
            (po.legHeightInches || 0);
          const isBF = po.itemCategory === "BEDFRAME";
          wipCodeStr = [
            po.productCode,
            po.sizeLabel ? `(${po.sizeLabel})` : "",
            // BF-only: total height first, Divan height after. Kept in
            // lockstep with Production page's fabCutWIP() helper so
            // Inventory WIP codes match exactly what operators see on the
            // Fab Cut tab.
            isBF && totalH > 0 ? `(${totalH}")` : "",
            isBF && po.divanHeightInches ? `(DV ${po.divanHeightInches}")` : "",
            po.fabricCode || "",
            "(FC)",
          ].filter(Boolean).join(" | ");
        } else {
          wipCodeStr = card.wipLabel || card.wipCode || WIP_TYPE_LABELS[wipTypeShort] || wipTypeShort || wipKey;
        }
        const qty = card.wipQty || po.quantity;

        // Labor-so-far per unit — sum productionTimeMinutes for every done
        // card at or before the edge in THIS wipKey group. "This group"
        // because physically the stock sitting at the edge has only
        // absorbed work done within its own sub-assembly flow; the DIVAN
        // pile is tracked separately on its own WIP row.
        let doneMinsPerUnit = 0;
        for (let j = 0; j <= i; j++) {
          if (isDone(sorted[j])) {
            doneMinsPerUnit += Number(sorted[j].productionTimeMinutes) || 0;
          }
        }

        const laborPerUnitSen = doneMinsPerUnit * todayLaborRatePerMinSen;
        const materialPerUnitSen = doneMinsPerUnit * materialPerMinuteSen;
        const unitCostSen = laborPerUnitSen + materialPerUnitSen;

        raw.push({
          wipCode: wipCodeStr,
          wipType: WIP_TYPE_LABELS[wipTypeShort] || wipTypeShort || "",
          relatedProduct: po.productCode,
          completedBy: card.departmentCode,
          poCode: po.poNo,
          quantity: qty,
          poQty: po.quantity || 1,
          completedDate,
          ageDays,
          estValueSen: unitCostSen * qty,
          fabricCode: po.fabricCode || "",
          baseModel: (po.productCode || "").split("-")[0],
          itemCategory: po.itemCategory || "",
        });
      }
    }
  }

  // Second pass: group by wipCode + completedBy dept → one row per unique WIP
  const grouped = new Map<string, WIPItem>();
  for (const r of raw) {
    const key = `${r.wipCode}__${r.completedBy}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        wipCode: r.wipCode,
        wipType: r.wipType,
        relatedProduct: r.relatedProduct,
        completedBy: r.completedBy,
        totalQty: 0,
        oldestAgeDays: 0,
        sources: [],
        estUnitCostSen: 0,
        estTotalValueSen: 0,
      });
    }
    const g = grouped.get(key)!;
    g.totalQty += r.quantity;
    if (r.ageDays > g.oldestAgeDays) g.oldestAgeDays = r.ageDays;
    g.estTotalValueSen += r.estValueSen;
    g.sources.push({
      poCode: r.poCode,
      quantity: r.quantity,
      poQty: r.poQty,
      completedDate: r.completedDate,
      ageDays: r.ageDays,
      fabricCode: r.fabricCode,
      baseModel: r.baseModel,
      itemCategory: r.itemCategory,
    });
  }

  // Finalise per-unit cost from grouped totals.
  for (const g of grouped.values()) {
    g.estUnitCostSen = g.totalQty > 0 ? g.estTotalValueSen / g.totalQty : 0;
  }

  const items = Array.from(grouped.values());
  // Sort by oldest age descending (FIFO)
  items.sort((a, b) => b.oldestAgeDays - a.oldestAgeDays);
  return items;
}

// Synthetic row produced by mergeSofaWIPSets — one row per
// (salesOrderNo, fabric) for sofa WIPs. Mirrors Fab Cut's merge key.
type SofaSetRow = {
  id: string;
  setLabel: string;           // e.g. "5537-1A(LHF)+1NA+1A(RHF) BO315-2"
  salesOrderNo: string;
  fabric: string;
  totalQty: number;           // sum across all component WIPs
  oldestAgeDays: number;
  estTotalValueSen: number;
  components: { wipType: string; qty: number }[];
  members: WIPItem[];         // underlying component rows, for expansion
};

// Strip the trailing "-NN" line-number suffix from a PO code
// (e.g. "SO-2604-212-01" → "SO-2604-212"). Returns input unchanged
// when no suffix is present so non-SO codes pass through.
function stripPoSuffix(poCode: string): string {
  return poCode.replace(/-\d+$/, "");
}

// Group sofa WIP rows into one synthetic "set" row per (SO, fabric).
// Non-sofa WIPs are left untouched by this helper — the UI renders them
// separately when merged-view is on.
//
// Qty semantics (matches Production Fab Cut's "1 set" convention):
//   setQty = max(poQty) across POs in the bucket
//     - one sofa set on a SO → max = 1
//     - N identical sets on a SO → max = N
//   We take max (not sum) because variants are separate POs but describe
//   pieces of the same set — summing would multiply the set count by
//   however many variants the customer configured. `pieceTotalQty` stays
//   around for debugging / detail view if we want it later.
function mergeSofaWIPSets(wipItems: WIPItem[]): SofaSetRow[] {
  // Map key `${so}::${fabric}` → accumulator
  const buckets = new Map<string, {
    salesOrderNo: string;
    fabric: string;
    qtyByComponent: Map<string, number>; // wipType → qty (piece-level)
    modelSet: Set<string>;               // product codes participating
    setQty: number;                      // max(poQty) seen in this bucket
    oldestAgeDays: number;
    estTotalValueSen: number;
    memberIds: Set<string>;              // WIPItem.id set for members
  }>();

  for (const w of wipItems) {
    // Only merge sofas — a single non-sofa source kicks the whole WIP
    // out of the merge (keeps BF / accessory rows intact).
    const allSofa =
      w.sources.length > 0 &&
      w.sources.every((s) => s.itemCategory === "SOFA");
    if (!allSofa) continue;

    for (const s of w.sources) {
      const so = stripPoSuffix(s.poCode);
      const key = `${so}::${s.fabricCode}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          salesOrderNo: so,
          fabric: s.fabricCode,
          qtyByComponent: new Map(),
          modelSet: new Set(),
          setQty: 0,
          oldestAgeDays: 0,
          estTotalValueSen: 0,
          memberIds: new Set(),
        };
        buckets.set(key, b);
      }
      b.qtyByComponent.set(
        w.wipType,
        (b.qtyByComponent.get(w.wipType) || 0) + s.quantity,
      );
      b.modelSet.add(w.relatedProduct);
      if (s.poQty > b.setQty) b.setQty = s.poQty;
      if (s.ageDays > b.oldestAgeDays) b.oldestAgeDays = s.ageDays;
      // Prorate the WIPItem's estTotalValueSen by this source's share.
      if (w.totalQty > 0) {
        b.estTotalValueSen += (s.quantity / w.totalQty) * w.estTotalValueSen;
      }
      b.memberIds.add(w.id);
    }
  }

  const wipById = new Map(wipItems.map((w) => [w.id, w]));
  const rows: SofaSetRow[] = [];
  for (const [key, b] of buckets) {
    const uniqueModels = Array.from(b.modelSet);
    // Compact label: strip shared baseModel prefix, join with "+"
    // (same rule Fab Cut uses in production/index.tsx).
    let modelLabel = uniqueModels.join("+");
    if (uniqueModels.length > 1) {
      const firstDash = uniqueModels[0].indexOf("-");
      if (firstDash > 0) {
        const prefix = uniqueModels[0].slice(0, firstDash + 1);
        if (uniqueModels.every((m) => m.startsWith(prefix))) {
          modelLabel =
            prefix + uniqueModels.map((m) => m.slice(prefix.length)).join("+");
        }
      }
    }
    const setLabel = [modelLabel, b.fabric].filter(Boolean).join(" ");
    const components = Array.from(b.qtyByComponent.entries())
      .map(([wipType, qty]) => ({ wipType, qty }))
      .sort((a, b) => a.wipType.localeCompare(b.wipType));
    // Display Qty = # of sofa sets in WIP, NOT sum of pieces. Mirrors
    // Production Fab Cut where a merged sofa row reads "Qty 1" regardless
    // of how many components the set has.
    const totalQty = b.setQty || 1;
    const members = Array.from(b.memberIds)
      .map((id) => wipById.get(id))
      .filter((x): x is WIPItem => !!x);

    rows.push({
      id: `set::${key}`,
      setLabel,
      salesOrderNo: b.salesOrderNo,
      fabric: b.fabric,
      totalQty,
      oldestAgeDays: b.oldestAgeDays,
      estTotalValueSen: b.estTotalValueSen,
      components,
      members,
    });
  }
  rows.sort((a, b) => b.oldestAgeDays - a.oldestAgeDays);
  return rows;
}
*/
// END LEGACY — /api/inventory/wip owns this logic now.

// Unique itemGroups for RM filter. When D1 has no rows we fall back to a
// canonical list so the "Add RM" modal still offers a usable item-group
// dropdown (otherwise users would see an empty <select>).
const FALLBACK_RM_ITEM_GROUPS = [
  "PLYWOOD", "FOAM", "FABRIC", "HARDWARE", "ADHESIVE", "PACKAGING", "OTHERS",
];

// ============================================================
// Column definitions
// ============================================================

const fgColumns: Column<FGItem>[] = [
  {
    key: "code",
    label: "Code",
    render: (_v, row) => <span className="doc-number font-medium">{row.code}</span>,
  },
  {
    key: "name",
    label: "Name",
    render: (_v, row) => <span className="font-medium text-[#1F1D1B] text-sm">{row.name}</span>,
  },
  {
    key: "category",
    label: "Category",
    render: (_v, row) => <Badge>{row.category}</Badge>,
  },
  {
    key: "sizeLabel",
    label: "Size / Model",
    render: (_v, row) => (
      <span className="text-[#4B5563]">
        {row.category === "BEDFRAME" ? row.sizeLabel : row.category === "SOFA" ? row.baseModel : row.sizeLabel || row.baseModel}
      </span>
    ),
  },
  {
    key: "unitM3",
    label: "Unit M3",
    align: "right",
    render: (_v, row) => <span className="text-[#6B7280]">{row.unitM3}</span>,
  },
  {
    key: "stockQty",
    label: "Stock Qty",
    align: "right",
    render: (_v, row) => {
      const sem = getStockSemantic(row.stockQty);
      const cls = row.stockQty === 0 || row.stockQty < 5 ? sem.text : "text-[#1F1D1B]";
      return <span className={`font-medium ${cls}`}>{row.stockQty}</span>;
    },
  },
  {
    key: "unitCost",
    label: "Unit Cost (RM)",
    align: "right",
    render: (_v, row) => (
      <span className="text-[#1F1D1B] tabular-nums">
        {formatUnitCost(avgFGUnitCostSen(row.id))}
      </span>
    ),
  },
  {
    key: "stockValue",
    label: "Stock Value (RM)",
    align: "right",
    render: (_v, row) => {
      const total = totalFGValueSen(row.id);
      const layers = batchesForProduct(row.id).filter((l) => l.remainingQty > 0).length;
      return (
        <div className="text-right tabular-nums">
          <div className="text-[#1F1D1B] font-medium">{formatValue(total)}</div>
          {layers > 0 && (
            <div className="text-[10px] text-[#9CA3AF]">{layers} {layers === 1 ? "layer" : "layers"}</div>
          )}
        </div>
      );
    },
  },
  {
    key: "fgAge",
    label: "Age (FIFO)",
    align: "right",
    render: (_v, row) => renderAgeCell(oldestFGAgeDays(row.id)),
  },
  {
    key: "status",
    label: "Status",
    render: (_v, row) => {
      const sem = row.status === "ACTIVE" ? SUCCESS : NEUTRAL;
      return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${sem.bg} ${sem.text} ${sem.border}`}>{row.status}</span>;
    },
  },
];

const DEPT_LABELS: Record<string, string> = {
  FAB_CUT: "Fabric Cutting", FAB_SEW: "Fabric Sewing", WOOD_CUT: "Wood Cutting",
  FOAM: "Foam Bonding", FRAMING: "Framing", WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery", PACKING: "Packing",
};

const wipColumns: Column<WIPItem>[] = [
  {
    key: "wipCode",
    label: "WIP Code",
    render: (_v, row) => <span className="text-sm font-medium text-[#1F1D1B]">{row.wipCode}</span>,
  },
  {
    key: "category",
    label: "Category",
    render: (_v, row) => {
      const sem = INVENTORY_TYPE_COLOR[row.category] ?? NEUTRAL;
      return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${sem.bg} ${sem.text} ${sem.border}`}>{row.category}</span>;
    },
  },
  {
    key: "relatedProduct",
    label: "Product",
    render: (_v, row) => <span className="doc-number text-[#4B5563]">{row.relatedProduct}</span>,
  },
  {
    key: "completedBy",
    label: "Completed By",
    render: (_v, row) => <span className="text-sm text-[#4B5563]">{DEPT_LABELS[row.completedBy] || row.completedBy}</span>,
  },
  {
    key: "totalQty",
    label: "Qty",
    align: "right",
    render: (_v, row) => {
      const breakdown = row.sources.length > 0
        ? row.sources.map((s) => `${s.poCode}: ${s.quantity}`).join(" · ")
        : "No PO breakdown available";
      return (
        <span className="font-medium text-[#1F1D1B]" title={`Total pieces in WIP at this stage. ${breakdown}`}>
          {row.totalQty}
        </span>
      );
    },
  },
  {
    key: "sources",
    label: "Source POs",
    align: "right",
    render: (_v, row) => (
      <span
        className="text-sm text-[#6B7280]"
        title={
          row.sources.length > 0
            ? `Contributed by: ${row.sources.map((s) => `${s.poCode} (qty ${s.quantity})`).join(", ")}`
            : "No production orders linked"
        }
      >
        {row.sources.length}
      </span>
    ),
  },
  {
    key: "oldestAgeDays",
    label: "Age (FIFO)",
    align: "right",
    render: (_v, row) => renderAgeCell(row.oldestAgeDays),
  },
  // Estimated cost: WIP has no real FIFO batch so this is a computed
  // estimate (material prorated by labor progress + labor-so-far). Shown
  // with "est." subtitle so users know it's not from the cost ledger.
  {
    key: "estUnitCostSen",
    label: "Unit Cost (RM)",
    align: "right",
    render: (_v, row) => (
      <div className="text-right tabular-nums">
        <div className="text-[#1F1D1B] text-sm font-medium">
          {formatUnitCost(row.estUnitCostSen)}
        </div>
        <div className="text-[10px] text-[#9CA3AF]">est.</div>
      </div>
    ),
  },
  {
    key: "estTotalValueSen",
    label: "Stock Value (RM)",
    align: "right",
    render: (_v, row) => (
      <div className="text-right tabular-nums">
        <div className="text-[#1F1D1B] text-sm font-medium">
          {formatValue(row.estTotalValueSen)}
        </div>
        <div className="text-[10px] text-[#9CA3AF]">est.</div>
      </div>
    ),
  },
];

// Columns for the merged sofa-set view. The first column doubles as an
// expand/collapse caret — click handling is wired up at the DataGrid level
// since the underlying component rows live in a separate nested grid.
const _sofaSetColumns = (
  expandedIds: Set<string>,
  toggle: (id: string) => void,
): Column<SofaSetRow>[] => [
  {
    key: "setLabel",
    label: "Set",
    render: (_v, row) => (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggle(row.id); }}
        className="flex items-center gap-1.5 text-left"
      >
        <span className="inline-block w-3 text-[#9CA3AF]">
          {expandedIds.has(row.id) ? "v" : ">"}
        </span>
        <span className="text-sm font-medium text-[#1F1D1B]">{row.setLabel}</span>
      </button>
    ),
  },
  {
    key: "fabric",
    label: "Fabric",
    render: (_v, row) => <span className="text-sm text-[#4B5563]">{row.fabric || "—"}</span>,
  },
  {
    key: "components",
    label: "Components",
    render: (_v, row) => (
      <div className="flex flex-wrap gap-1">
        {row.components.map((c) => (
          <span
            key={c.wipType}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-[#F5F1E8] text-[#6B5C32] border border-[#E2DDD8]"
          >
            {c.wipType} × {c.qty}
          </span>
        ))}
      </div>
    ),
  },
  {
    key: "totalQty",
    label: "Total Qty",
    align: "right",
    render: (_v, row) => <span className="font-medium text-[#1F1D1B]">{row.totalQty}</span>,
  },
  {
    key: "oldestAgeDays",
    label: "Oldest Age (days)",
    align: "right",
    render: (_v, row) => renderAgeCell(row.oldestAgeDays),
  },
  {
    key: "estTotalValueSen",
    label: "Est. Value (RM)",
    align: "right",
    render: (_v, row) => (
      <div className="text-right tabular-nums">
        <div className="text-[#1F1D1B] text-sm font-medium">
          {formatValue(row.estTotalValueSen)}
        </div>
        <div className="text-[10px] text-[#9CA3AF]">est.</div>
      </div>
    ),
  },
];

const rmColumns: Column<RawMaterial>[] = [
  {
    key: "itemCode",
    label: "Code",
    render: (_v, row) => <span className="doc-number font-medium">{row.itemCode}</span>,
  },
  {
    key: "balanceQty",
    label: "Stock Qty",
    align: "right",
    render: (_v, row) => {
      const sem = getStockSemantic(row.balanceQty);
      const cls = row.balanceQty === 0 || row.balanceQty < 5 ? sem.text : "text-[#1F1D1B]";
      return (
        <span className={`font-medium ${cls}`}>
          {row.balanceQty} <span className="text-[#9CA3AF] text-xs">{row.baseUOM}</span>
        </span>
      );
    },
  },
];

// ============================================================
// Context menu
// ============================================================
function inventoryContextMenu(toastFn: (msg: string) => void): ContextMenuItem[] {
  return [
    { label: "View", action: (row) => { toastFn("Detail view for: " + (row.code || row.itemCode)); } },
    { label: "Edit", action: () => {} },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => {} },
  ];
}

// ============================================================
// Component
// ============================================================

export default function InventoryPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("FINISHED");

  // Search & filter state
  const [fgSearch, setFgSearch] = useState("");
  const [fgCategoryFilter, setFgCategoryFilter] = useState<string>("ALL");

  const [wipSearch, setWipSearch] = useState("");
  // WIP view mode: "MERGED" (default) collapses sofa components into
  // (SO, fabric) set rows to match the Production page's Fab Cut layout;
  // "PER_COMPONENT" shows one row per WIP component (legacy breakdown).
  const [_wipViewMode, _setWipViewMode] = useState<"PER_COMPONENT" | "MERGED">("MERGED");
  // Which sofa-set rows are expanded to show their underlying component WIPs.
  const [_expandedSetIds, setExpandedSetIds] = useState<Set<string>>(new Set());
  const _toggleExpandedSet = (id: string) => {
    setExpandedSetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const [rmSearch, setRmSearch] = useState("");
  const [rmCategoryFilter, setRmCategoryFilter] = useState<string>("ALL");

  // Create FG modal
  const [showCreateFG, setShowCreateFG] = useState(false);
  const [fgForm, setFgForm] = useState<CreateFGForm>(EMPTY_FG_FORM);
  const [fgCopySourceId, setFgCopySourceId] = useState<string>("");
  const [fgSaving, setFgSaving] = useState(false);

  // Create RM modal
  const [showCreateRM, setShowCreateRM] = useState(false);
  const [rmForm, setRmForm] = useState<CreateRMForm>({ itemCode: "", description: "", baseUOM: "PCS", itemGroup: "PLYWOOD", balanceQty: 0 });

  // ---- Live data fetched from D1 ----
  //
  // `/api/production-orders`   → { success, data: [...] }
  // `/api/inventory`           → { success, data: { finishedProducts, wipItems, rawMaterials } }
  //                              (products + raw materials both live here)
  // `/api/products`            → { success, data: [...] }  (catalog-only fallback)
  //
  // We prefer /api/inventory because it returns both buckets in one trip.
  // If /api/inventory is stubbed (`_stub: true`) or missing, we fall back
  // to /api/products for the FG catalog and treat RM as empty.
  //
  // RM batches / FG batches have no D1 endpoint yet → always []. This
  // means weighted-average cost helpers return 0, which is correct for
  // a freshly-cleared DB.
  const [products, setProducts] = useState<Product[]>([]);
  const [liveRawMaterials, setLiveRawMaterials] = useState<RawMaterial[]>([]);
  const [poData, setPoData] = useState<ProductionOrderLike[]>([]);
  // Phase 4.5 — raw rows from /api/inventory/wip. Replaces the old
  // client-side deriveWIPFromPO + mergeSofaWIPSets pipeline.
  const [backendWipRows, setBackendWipRows] = useState<BackendWipRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchInventory = async (): Promise<{
      products: Product[];
      rawMaterials: RawMaterial[];
    }> => {
      // 1) Primary: /api/raw-materials for RM + /api/products for FG.
      //    These are the dedicated CRUD endpoints; /api/inventory is a
      //    convenience aggregator that returns the same data but with a
      //    less-rich RM shape (no min/max/status/notes).
      try {
        const [rmJson, pJson] = await Promise.all([
          cachedFetchJson<{ success?: boolean; data?: RawMaterial[]; _stub?: boolean }>("/api/raw-materials"),
          cachedFetchJson<{ success?: boolean; data?: Product[]; _stub?: boolean }>("/api/products"),
        ]);
        const okRM =
          rmJson && rmJson.success && Array.isArray(rmJson.data) && !rmJson._stub;
        const okP =
          pJson && pJson.success && Array.isArray(pJson.data) && !pJson._stub;
        if (okRM || okP) {
          return {
            products: okP ? (pJson!.data as Product[]) : [],
            rawMaterials: okRM ? (rmJson!.data as RawMaterial[]) : [],
          };
        }
      } catch { /* fall through */ }

      // 2) Fallback: aggregated /api/inventory (products + RM in one payload).
      try {
        const json = await cachedFetchJson<{ success?: boolean; data?: { finishedProducts?: Product[]; rawMaterials?: RawMaterial[] }; _stub?: boolean }>("/api/inventory");
        if (json && json.success && json.data && !json._stub) {
          return {
            products: Array.isArray(json.data.finishedProducts)
              ? json.data.finishedProducts
              : [],
            rawMaterials: Array.isArray(json.data.rawMaterials)
              ? json.data.rawMaterials
              : [],
          };
        }
      } catch { /* fall through */ }

      return { products: [], rawMaterials: [] };
    };

    const fetchPOs = async (): Promise<ProductionOrderLike[]> => {
      try {
        const json = await cachedFetchJson<{ success?: boolean; data?: ProductionOrderLike[]; _stub?: boolean }>("/api/production-orders");
        if (json && json.success && Array.isArray(json.data) && !json._stub) {
          return json.data as ProductionOrderLike[];
        }
      } catch { /* fall through */ }
      return [];
    };

    // Phase 4.5 — WIP rows come from /api/inventory/wip now. The endpoint
    // returns a single array containing BOTH per-component rows (wipType !=
    // "SET") and merged sofa-set rows (wipType === "SET"); the UI splits
    // them at render time.
    const fetchWipRows = async (): Promise<BackendWipRow[]> => {
      try {
        const json = await cachedFetchJson<{ success?: boolean; data?: BackendWipRow[]; _stub?: boolean }>("/api/inventory/wip");
        if (json && json.success && Array.isArray(json.data) && !json._stub) {
          return json.data as BackendWipRow[];
        }
      } catch { /* fall through */ }
      return [];
    };

    (async () => {
      const [inv, pos, wipRows] = await Promise.all([
        fetchInventory(),
        fetchPOs(),
        fetchWipRows(),
      ]);
      if (cancelled) return;
      setProducts(inv.products);
      setLiveRawMaterials(inv.rawMaterials);
      setPoData(pos);
      setBackendWipRows(wipRows);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, []);

  // Derived inventory — recomputed whenever the fetches resolve.
  const fgItems = useMemo<FGItem[]>(
    () => deriveFGStock(products, poData),
    [products, poData],
  );
  // Inventory WIP table — mirrors Production Order's Fab Cut tab exactly:
  //   - SOFA: one row per (SO, fabric) SET, label "5530-L(LHF)+2A(RHF) | (30)
  //     | CH141-12 | (FC)", Qty = set count, Category = SOFA.
  //   - BEDFRAME / ACCESSORY: one row per PO's Fab Cut edge, Qty = piece
  //     count, Category = BEDFRAME / ACCESSORY.
  // So we keep SOFA SET rows, drop SOFA per-component, and keep BF/ACC
  // per-component as-is.
  const wipItems = useMemo<WIPItem[]>(
    () =>
      backendWipRows
        // FAB_CUT normalization (Wei Siang Apr 26 2026): every row is now
        // per-component. The backend no longer emits SET rows; this filter
        // is defensive in case a stale cached payload still carries one.
        .filter((r) => r.wipType !== "SET")
        .map((r) => ({
          id: r.id,
          wipCode: r.wipCode,
          wipType: r.wipType,
          category: r.category,
          relatedProduct: r.relatedProduct,
          completedBy: r.completedBy,
          totalQty: r.totalQty,
          oldestAgeDays: r.oldestAgeDays,
          sources: r.sources,
          estUnitCostSen: r.estUnitCostSen,
          estTotalValueSen: r.estTotalValueSen,
          members: r.members,
        })),
    [backendWipRows],
  );

  // Unique item-groups for the RM filter dropdown — derived from live
  // data, with a canonical fallback when D1 is empty.
  const RM_ITEM_GROUPS = useMemo(() => {
    const groups = Array.from(
      new Set(liveRawMaterials.map((r) => r.itemGroup).filter(Boolean)),
    ).sort();
    return groups.length > 0 ? groups : FALLBACK_RM_ITEM_GROUPS;
  }, [liveRawMaterials]);

  // ---- Filtered data ----
  const filteredFG = useMemo(() => {
    let data = fgItems;
    if (fgCategoryFilter !== "ALL") {
      data = data.filter(d => d.category === fgCategoryFilter);
    }
    if (fgSearch.trim()) {
      const q = fgSearch.toLowerCase();
      data = data.filter(d => d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q));
    }
    return data;
  }, [fgItems, fgSearch, fgCategoryFilter]);

  const filteredWIP = useMemo(() => {
    let data = wipItems;
    if (wipSearch.trim()) {
      const q = wipSearch.toLowerCase();
      data = data.filter(d => d.wipCode.toLowerCase().includes(q) || d.relatedProduct.toLowerCase().includes(q) || d.wipType.toLowerCase().includes(q) || d.sources.some(s => s.poCode.toLowerCase().includes(q)));
    }
    return data;
  }, [wipItems, wipSearch]);

  // Merged-view derivations — both derived from the /api/inventory/wip
  // response (Phase 4.5). Backend has already merged sofa rows by
  // (SO, fabric); we just project the SET rows into SofaSetRow shape and
  // resolve their members from the per-component wipItems array.
  const wipItemsById = useMemo(() => {
    const map = new Map<string, WIPItem>();
    for (const w of wipItems) map.set(w.id, w);
    return map;
  }, [wipItems]);

  const _sofaSetRows = useMemo<SofaSetRow[]>(() => {
    const q = wipSearch.trim().toLowerCase();
    const matchSearch = (row: BackendWipRow): boolean => {
      if (!q) return true;
      if (row.wipCode.toLowerCase().includes(q)) return true;
      if ((row.relatedProduct || "").toLowerCase().includes(q)) return true;
      if ((row.fabric || "").toLowerCase().includes(q)) return true;
      if ((row.salesOrderNo || "").toLowerCase().includes(q)) return true;
      if (row.members.some((m) => m.poNo.toLowerCase().includes(q))) return true;
      return false;
    };
    return backendWipRows
      .filter((r) => r.wipType === "SET" && matchSearch(r))
      .map<SofaSetRow>((r) => {
        const members = (r.memberItemIds || [])
          .map((id) => wipItemsById.get(id))
          .filter((w): w is WIPItem => !!w);
        return {
          id: r.id,
          setLabel: r.wipCode,
          salesOrderNo: r.salesOrderNo || "",
          fabric: r.fabric,
          totalQty: r.setQty,
          oldestAgeDays: r.oldestAgeDays,
          estTotalValueSen: r.estTotalValueSen,
          components: r.components || [],
          members,
        };
      })
      .sort((a, b) => b.oldestAgeDays - a.oldestAgeDays);
  }, [backendWipRows, wipSearch, wipItemsById]);

  // Non-sofa WIPs shown alongside sofa set rows when merged-view is on.
  // Per-component SOFA rows are filtered out here so they only appear when
  // the user switches to PER_COMPONENT view (otherwise they'd double-count
  // against the merged SET rows).
  const _filteredWIPNonSofa = useMemo(
    () => filteredWIP.filter(
      (w) => !(w.sources.length > 0 && w.sources.every((s) => s.itemCategory === "SOFA")),
    ),
    [filteredWIP],
  );

  const filteredRM = useMemo(() => {
    let data = liveRawMaterials;
    if (rmCategoryFilter !== "ALL") {
      data = data.filter(d => d.itemGroup === rmCategoryFilter);
    }
    if (rmSearch.trim()) {
      const q = rmSearch.toLowerCase();
      data = data.filter(d => d.itemCode.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
    }
    return data;
  }, [liveRawMaterials, rmSearch, rmCategoryFilter]);

  // ---- KPIs ----
  const fgBedframeCount = fgItems.filter(p => p.category === "BEDFRAME").length;
  const fgSofaCount = fgItems.filter(p => p.category === "SOFA").length;
  const fgTotalStock = fgItems.reduce((s, p) => s + p.stockQty, 0);

  const wipTotalQty = wipItems.reduce((s, w) => s + w.totalQty, 0);
  const wipOldest = wipItems.length > 0 ? Math.max(...wipItems.map(w => w.oldestAgeDays)) : 0;
  const wipOver7Days = wipItems.filter(w => w.oldestAgeDays > 7).length;

  const rmCategoriesCount = RM_ITEM_GROUPS.length;
  const rmLowStock = liveRawMaterials.filter(r => r.balanceQty > 0 && r.balanceQty < 5).length;
  const rmZeroStock = liveRawMaterials.filter(r => r.balanceQty === 0).length;

  const contextMenu = inventoryContextMenu(toast.info);

  // Edit FG dialog state
  const [editFG, setEditFG] = useState<FGItem | null>(null);
  const [editFGForm, setEditFGForm] = useState({ costPriceSen: 0, stockQty: 0, unitM3: 0, fabricUsage: 0, productionTimeMinutes: 0 });
  // FG source-PO drilldown — populated when the dialog opens (2026-04-27).
  // Lists every production_order that produced this FG, qty + mfdDate per
  // PO. Mirrors the WIP detail dialog's "Job Cards" section.
  type FGSource = {
    poId: string;
    poNo: string;
    soNo: string;
    customerName: string;
    qty: number;
    mfdDate: string;
    statusCounts: Record<string, number>;
  };
  const [fgSources, setFgSources] = useState<FGSource[]>([]);
  const [fgSourcesLoading, setFgSourcesLoading] = useState(false);

  const handleDoubleClickFG = async (row: FGItem) => {
    setEditFG(row);
    setEditFGForm({
      costPriceSen: row.costPriceSen,
      stockQty: row.stockQty,
      unitM3: row.unitM3,
      fabricUsage: row.fabricUsage,
      productionTimeMinutes: row.productionTimeMinutes,
    });
    // Fire the source-PO lookup in the background so the dialog opens
    // instantly and the table fills in when ready.
    setFgSources([]);
    setFgSourcesLoading(true);
    try {
      const res = await fetch(`/api/inventory/fg-source/${encodeURIComponent(row.code)}`);
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; sources?: FGSource[] }
        | null;
      setFgSources(j?.sources ?? []);
    } catch {
      setFgSources([]);
    }
    setFgSourcesLoading(false);
  };
  const [wipDetail, setWipDetail] = useState<WIPItem | null>(null);
  const handleDoubleClickWIP = (row: WIPItem) => { setWipDetail(row); };

  // Edit RM dialog state
  const [editRM, setEditRM] = useState<RawMaterial | null>(null);
  const [editRMForm, setEditRMForm] = useState({ description: "", baseUOM: "", itemGroup: "", balanceQty: 0 });
  // RM source-batch drilldown (FIFO order). Each batch has the originating
  // purchase order so operators can trace which batch / PO supplied this
  // material — required for FIFO costing + supplier traceability.
  type RMBatch = {
    id: string;
    receivedDate: string;
    originalQty: number;
    remainingQty: number;
    unitCostSen: number;
    notes: string;
    grnNumber: string;
    poNumber: string; // Purchase Order
    poId: string;
    supplierName: string;
  };
  const [rmBatches, setRmBatches] = useState<RMBatch[]>([]);
  const [rmBatchesLoading, setRmBatchesLoading] = useState(false);

  const handleDoubleClickRM = async (row: RawMaterial) => {
    setEditRM(row);
    setEditRMForm({
      description: row.description,
      baseUOM: row.baseUOM,
      itemGroup: row.itemGroup,
      balanceQty: row.balanceQty,
    });
    setRmBatches([]);
    setRmBatchesLoading(true);
    try {
      const res = await fetch(`/api/inventory/rm-source/${encodeURIComponent(row.id)}`);
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; batches?: RMBatch[] }
        | null;
      setRmBatches(j?.batches ?? []);
    } catch {
      setRmBatches([]);
    }
    setRmBatchesLoading(false);
  };

  // Batch import state (FG and RM share the same dialog component with
  // different column schemas / key columns / handlers).
  const [showBatchImportFG, setShowBatchImportFG] = useState(false);
  const [showBatchImportRM, setShowBatchImportRM] = useState(false);

  // Template column schemas. ORDER determines column order in the Excel
  // template. The `code` / `itemCode` column is the match key — existing
  // rows with the same key get updated in-place, new keys get created.
  const fgImportColumns: ImportColumn[] = [
    { key: "code", label: "Product Code", required: true, example: "2050(A)-(K)", help: "Unique product code (cannot be changed via import)" },
    { key: "name", label: "Product Name", required: true, example: "ROMA BEDFRAME (6FT)" },
    { key: "category", label: "Category", required: true, enum: ["BEDFRAME", "SOFA", "ACCESSORY"], example: "BEDFRAME" },
    { key: "baseModel", label: "Base Model", example: "2050(A)", help: "Optional family name grouping" },
    { key: "sizeCode", label: "Size Code", example: "K", help: "K / Q / S / SS / SK / SP" },
    { key: "sizeLabel", label: "Size Label", example: "6FT" },
    { key: "basePriceSen", label: "Base Price (RM)", type: "number", example: 2500, help: "In ringgit, converted to sen internally" },
    { key: "costPriceSen", label: "Cost Price (RM)", type: "number", example: 1500 },
    { key: "fabricUsage", label: "Fabric Usage (m)", type: "number", example: 8 },
  ];

  const rmImportColumns: ImportColumn[] = [
    { key: "itemCode", label: "Item Code", required: true, example: "PC151-01", help: "Unique item code (cannot be changed via import)" },
    { key: "description", label: "Description", required: true, example: "Fabric PC151-01 Grey" },
    { key: "baseUOM", label: "Base UOM", required: true, example: "M", help: "M / PCS / KG / ROLL etc." },
    { key: "itemGroup", label: "Item Group", required: true, example: "FABRIC", help: "FABRIC / PLYWOOD / FOAM etc." },
    { key: "balanceQty", label: "Balance Qty", type: "number", example: 0 },
    { key: "isActive", label: "Active", type: "boolean", example: "TRUE" },
  ];

  // Import handlers — previously mutated mock-data module globals. Now
  // they update component state so the grids refresh immediately. NOTE:
  // these are still local-only; they do not POST to D1. A separate task
  // can wire this to /api/products and /api/inventory/raw-materials.
  const handleImportFG = (rows: Record<string, unknown>[]) => {
    let created = 0, updated = 0;
    const next = [...products];
    for (const row of rows) {
      const code = String(row.code || "").trim();
      if (!code) continue;
      const basePriceSen = Math.round(Number(row.basePriceSen || 0) * 100);
      const costPriceSen = Math.round(Number(row.costPriceSen || 0) * 100);

      const idx = next.findIndex(p => p.code === code);
      if (idx >= 0) {
        const existing = { ...next[idx] };
        existing.name = String(row.name || existing.name);
        existing.category = String(row.category || existing.category) as Product["category"];
        existing.baseModel = String(row.baseModel || existing.baseModel);
        existing.sizeCode = String(row.sizeCode || existing.sizeCode);
        existing.sizeLabel = String(row.sizeLabel || existing.sizeLabel);
        if (row.basePriceSen) existing.basePriceSen = basePriceSen;
        if (row.costPriceSen) existing.costPriceSen = costPriceSen;
        if (row.fabricUsage) existing.fabricUsage = Number(row.fabricUsage);
        next[idx] = existing;
        updated++;
      } else {
        const newProduct: Product = {
          id: `p-imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          code,
          name: String(row.name || ""),
          category: String(row.category || "BEDFRAME") as Product["category"],
          description: "",
          baseModel: String(row.baseModel || ""),
          sizeCode: String(row.sizeCode || ""),
          sizeLabel: String(row.sizeLabel || ""),
          fabricUsage: Number(row.fabricUsage) || 0,
          unitM3: 0,
          status: "ACTIVE",
          costPriceSen,
          basePriceSen,
          productionTimeMinutes: 0,
          subAssemblies: [],
          bomComponents: [],
          deptWorkingTimes: [],
        };
        next.push(newProduct);
        created++;
      }
    }
    setProducts(next);
    toast.success(`Imported: ${created} created, ${updated} updated`);
    return { created, updated };
  };

  const handleImportRM = (rows: Record<string, unknown>[]) => {
    let created = 0, updated = 0;
    const next = [...liveRawMaterials];
    for (const row of rows) {
      const itemCode = String(row.itemCode || "").trim();
      if (!itemCode) continue;

      const idx = next.findIndex(r => r.itemCode === itemCode);
      if (idx >= 0) {
        const existing = { ...next[idx] };
        existing.description = String(row.description || existing.description);
        existing.baseUOM = String(row.baseUOM || existing.baseUOM);
        existing.itemGroup = String(row.itemGroup || existing.itemGroup);
        if (row.balanceQty !== undefined && row.balanceQty !== "") {
          existing.balanceQty = Number(row.balanceQty);
        }
        if (row.isActive !== undefined && row.isActive !== "") {
          existing.isActive = Boolean(row.isActive);
        }
        next[idx] = existing;
        updated++;
      } else {
        const newRM: RawMaterial = {
          id: `rm-imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          itemCode,
          description: String(row.description || ""),
          baseUOM: String(row.baseUOM || "PCS"),
          itemGroup: String(row.itemGroup || "OTHERS"),
          isActive: row.isActive === undefined ? true : Boolean(row.isActive),
          balanceQty: Number(row.balanceQty) || 0,
        };
        next.push(newRM);
        created++;
      }
    }
    setLiveRawMaterials(next);
    toast.success(`Imported: ${created} created, ${updated} updated`);
    return { created, updated };
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Inventory</h1>
          <p className="text-xs text-[#6B7280]">Finished products, work-in-progress & raw materials</p>
        </div>
        <Card>
          <CardContent className="p-8 flex items-center justify-center text-sm text-[#6B7280]">
            Loading inventory…
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Inventory</h1>
          <p className="text-xs text-[#6B7280]">Finished products, work-in-progress & raw materials</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#E2DDD8]">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#D1CBC5]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ================= FINISHED PRODUCTS TAB ================= */}
      {activeTab === "FINISHED" && (
        <div className="space-y-4">
          {/* KPIs */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Total SKUs</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{fgItems.length}</p>
            </CardContent></Card>
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Total Stock</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{fgTotalStock.toLocaleString()} pcs</p>
            </CardContent></Card>
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Bedframe SKUs</p>
              <p className="text-xl font-bold text-[#6B5C32]">{fgBedframeCount}</p>
            </CardContent></Card>
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Sofa SKUs</p>
              <p className="text-xl font-bold text-[#6B5C32]">{fgSofaCount}</p>
            </CardContent></Card>
          </div>

          {/* Search + Filter + Add */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
              <Input
                value={fgSearch}
                onChange={e => setFgSearch(e.target.value)}
                placeholder="Search by code or name..."
                className="pl-9 h-9"
              />
            </div>
            <div className="flex gap-2">
              {["ALL", "BEDFRAME", "SOFA", "ACCESSORY"].map(cat => (
                <button
                  key={cat}
                  onClick={() => setFgCategoryFilter(cat)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                    fgCategoryFilter === cat
                      ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                      : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F0ECE9]"
                  }`}
                >
                  {cat === "ALL" ? "All" : cat.charAt(0) + cat.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowBatchImportFG(true)}>
              <Upload className="h-4 w-4" /> Batch Import
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowCreateFG(true)}>
              <Plus className="h-4 w-4" /> Add FG
            </Button>
          </div>

          {/* Create FG modal */}
          {showCreateFG && (
            <Card className="border-2 border-[#6B5C32]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-[#6B5C32]" /> Add Finished Product</CardTitle>
                  <button onClick={() => setShowCreateFG(false)} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="h-5 w-5" /></button>
                </div>
              </CardHeader>
              <CardContent>
                {/* Copy-from-existing: lazy-person shortcut. Picking a product
                    clones every field that makes sense (category / baseModel /
                    sizeCode / sizeLabel / description / prices / unitM3 /
                    fabricUsage / JSON trios) into the form below. User edits
                    what's different (typically just code + name + size) and
                    hits Save. Leave blank to create from scratch. */}
                <div className="mb-3 pb-3 border-b border-[#E2DDD8]">
                  <label className="block text-xs text-[#6B7280] mb-1">Copy from existing (optional)</label>
                  <SearchableSelect
                    value={fgCopySourceId}
                    onChange={(val) => {
                      setFgCopySourceId(val);
                      if (!val) {
                        setFgForm(EMPTY_FG_FORM);
                        return;
                      }
                      const src = products.find((p) => p.id === val);
                      if (!src) return;
                      // Pre-fill code + name from source so the user only
                      // tweaks what differs (e.g. bump a size suffix).
                      setFgForm({
                        code: src.code,
                        name: src.name,
                        category: src.category || "BEDFRAME",
                        baseModel: src.baseModel || "",
                        sizeCode: src.sizeCode || "",
                        sizeLabel: src.sizeLabel || "",
                        description: src.description || "",
                        basePriceSen: src.basePriceSen,
                        price1Sen: src.price1Sen,
                        unitM3: src.unitM3,
                        fabricUsage: src.fabricUsage,
                        subAssemblies: src.subAssemblies,
                        pieces: src.pieces,
                        seatHeightPrices: src.seatHeightPrices,
                        skuCode: src.skuCode || "",
                        fabricColor: src.fabricColor || "",
                      });
                    }}
                    options={products.map((p) => ({
                      value: p.id,
                      label: `${p.code} - ${p.name} · ${p.category}`,
                    }))}
                    placeholder="Search an existing SKU to clone from..."
                    className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Code *</label>
                    <input value={fgForm.code} onChange={e => setFgForm(f => ({ ...f, code: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 2050(A)-(K)" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Name *</label>
                    <input value={fgForm.name} onChange={e => setFgForm(f => ({ ...f, name: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. ROMA BEDFRAME (6FT)" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                    <select value={fgForm.category} onChange={e => setFgForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                      <option value="BEDFRAME">Bedframe</option>
                      <option value="SOFA">Sofa</option>
                      <option value="ACCESSORY">Accessory</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Base Model</label>
                    <input value={fgForm.baseModel} onChange={e => setFgForm(f => ({ ...f, baseModel: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 1003(A)" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Size Code</label>
                    <input value={fgForm.sizeCode} onChange={e => setFgForm(f => ({ ...f, sizeCode: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. K, Q, S" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Size Label</label>
                    <input value={fgForm.sizeLabel} onChange={e => setFgForm(f => ({ ...f, sizeLabel: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 6FT" />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-xs text-[#6B7280] mb-1">Description</label>
                    <input value={fgForm.description ?? ""} onChange={e => setFgForm(f => ({ ...f, description: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="Optional description / notes" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Base Price (RM)</label>
                    <input
                      type="number" step="0.01" min={0}
                      value={fgForm.basePriceSen !== undefined ? (fgForm.basePriceSen / 100).toFixed(2) : ""}
                      onChange={e => setFgForm(f => ({ ...f, basePriceSen: e.target.value === "" ? undefined : Math.round(parseFloat(e.target.value || "0") * 100) }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Price 1 (RM)</label>
                    <input
                      type="number" step="0.01" min={0}
                      value={fgForm.price1Sen !== undefined && fgForm.price1Sen !== null ? (fgForm.price1Sen / 100).toFixed(2) : ""}
                      onChange={e => setFgForm(f => ({ ...f, price1Sen: e.target.value === "" ? undefined : Math.round(parseFloat(e.target.value || "0") * 100) }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="Optional (bedframe tier 1)"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Unit M3</label>
                    <input
                      type="number" step="0.01" min={0}
                      value={fgForm.unitM3 !== undefined ? String(fgForm.unitM3) : ""}
                      onChange={e => setFgForm(f => ({ ...f, unitM3: e.target.value === "" ? undefined : parseFloat(e.target.value || "0") }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="e.g. 0.69"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Fabric Usage (m)</label>
                    <input
                      type="number" step="0.1" min={0}
                      value={fgForm.fabricUsage !== undefined ? String(fgForm.fabricUsage) : ""}
                      onChange={e => setFgForm(f => ({ ...f, fabricUsage: e.target.value === "" ? undefined : parseFloat(e.target.value || "0") }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="e.g. 6"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">SKU Code</label>
                    <input value={fgForm.skuCode ?? ""} onChange={e => setFgForm(f => ({ ...f, skuCode: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 5530-1NA-SIZE-BASE" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Fabric Colour</label>
                    <input value={fgForm.fabricColor ?? ""} onChange={e => setFgForm(f => ({ ...f, fabricColor: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="Optional" />
                  </div>
                </div>
                {Boolean(fgForm.seatHeightPrices || fgForm.subAssemblies || fgForm.pieces) && (
                  <div className="mt-3 p-3 rounded border border-dashed border-[#E2DDD8] bg-[#FAF9F7] text-[11px] text-[#6B7280]">
                    <div className="font-semibold text-[#6B5C32] mb-1">Carried over from source (not editable here — adjust on Products page after save):</div>
                    {fgForm.seatHeightPrices ? <div>· Seat-height price ladder (sofa tier JSON)</div> : null}
                    {fgForm.subAssemblies ? <div>· Sub-assemblies</div> : null}
                    {fgForm.pieces ? <div>· Pieces breakdown</div> : null}
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" size="sm" onClick={() => setShowCreateFG(false)} disabled={fgSaving}>Cancel</Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!fgForm.code || !fgForm.name || fgSaving}
                    onClick={async () => {
                      // POST to /api/products. Send every field the form carries —
                      // server tolerates missing optional fields and the copy-
                      // from path forwards all the cloned JSON (subAssemblies,
                      // pieces, seatHeightPrices) as-is so the new SKU truly
                      // mirrors the source.
                      setFgSaving(true);
                      try {
                        const body: Record<string, unknown> = {
                          code: fgForm.code,
                          name: fgForm.name,
                          category: fgForm.category,
                          baseModel: fgForm.baseModel || fgForm.code,
                          sizeCode: fgForm.sizeCode,
                          sizeLabel: fgForm.sizeLabel,
                        };
                        if (fgForm.description !== undefined) body.description = fgForm.description;
                        if (fgForm.basePriceSen !== undefined) body.basePriceSen = fgForm.basePriceSen;
                        if (fgForm.price1Sen !== undefined) body.price1Sen = fgForm.price1Sen;
                        if (fgForm.unitM3 !== undefined) body.unitM3 = fgForm.unitM3;
                        if (fgForm.fabricUsage !== undefined) body.fabricUsage = fgForm.fabricUsage;
                        if (fgForm.subAssemblies !== undefined) body.subAssemblies = fgForm.subAssemblies;
                        if (fgForm.pieces !== undefined) body.pieces = fgForm.pieces;
                        if (fgForm.seatHeightPrices !== undefined) body.seatHeightPrices = fgForm.seatHeightPrices;
                        if (fgForm.skuCode) body.skuCode = fgForm.skuCode;
                        if (fgForm.fabricColor) body.fabricColor = fgForm.fabricColor;

                        const res = await fetch("/api/products", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(body),
                        });
                        const json = (await res.json()) as { success?: boolean; data?: Product; error?: string };
                        if (!res.ok || !json.success) {
                          toast.error(json.error || `Failed to create product (HTTP ${res.status})`);
                          return;
                        }
                        // Optimistic local insert + cache invalidation so every
                        // other page that has /api/products cached (Sales
                        // Create, BOM, Products) refreshes on next mount.
                        if (json.data) setProducts((prev) => [...prev, json.data as Product]);
                        invalidateCachePrefix("/api/products");
                        invalidateCachePrefix("/api/inventory");
                        toast.success(`Product created: ${fgForm.code}`);
                        setShowCreateFG(false);
                        setFgForm(EMPTY_FG_FORM);
                        setFgCopySourceId("");
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed to create product");
                      } finally {
                        setFgSaving(false);
                      }
                    }}
                  >
                    {fgSaving ? "Saving…" : "Save Product"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* DataGrid */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5 text-[#6B5C32]" /> Finished Products ({filteredFG.length})</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <DataGrid
                columns={fgColumns}
                data={filteredFG}
                keyField="id"
                gridId="inventory-fg"
                contextMenuItems={contextMenu}
                onDoubleClick={handleDoubleClickFG}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ================= WIP TAB ================= */}
      {activeTab === "WIP" && (
        <div className="space-y-4">
          {/* KPIs */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Total WIP Items</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{wipItems.length}</p>
            </CardContent></Card>
            <Card><CardContent className="p-2.5 flex items-center justify-between">
              <div><p className="text-xs text-[#6B7280]">Total Qty</p><p className="text-xl font-bold text-[#6B5C32]">{wipTotalQty}</p></div>
              <Layers className="h-5 w-5 text-[#6B5C32]" />
            </CardContent></Card>
            <Card><CardContent className="p-2.5 flex items-center justify-between">
              <div><p className="text-xs text-[#6B7280]">Oldest (days)</p><p className="text-xl font-bold text-[#9C6F1E]">{wipOldest}</p></div>
              <AlertTriangle className="h-5 w-5 text-[#9C6F1E]" />
            </CardContent></Card>
            <Card><CardContent className="p-2.5 flex items-center justify-between">
              <div><p className="text-xs text-[#6B7280]">&gt; 7 Days</p><p className="text-xl font-bold text-[#9A3A2D]">{wipOver7Days}</p></div>
              <Archive className="h-5 w-5 text-[#9A3A2D]" />
            </CardContent></Card>
          </div>

          {/* Search */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
              <Input
                value={wipSearch}
                onChange={e => setWipSearch(e.target.value)}
                placeholder="Search PO code, product or type..."
                className="pl-9 h-9"
              />
            </div>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2"><Layers className="h-5 w-5 text-[#6B5C32]" /> Work in Progress ({filteredWIP.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <DataGrid
                columns={wipColumns}
                data={filteredWIP}
                keyField="id"
                gridId="inventory-wip"
                contextMenuItems={contextMenu}
                onDoubleClick={handleDoubleClickWIP}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ================= RAW MATERIALS TAB ================= */}
      {activeTab === "RAW" && (
        <div className="space-y-4">
          {/* KPIs */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Total Materials</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{liveRawMaterials.length}</p>
            </CardContent></Card>
            <Card><CardContent className="p-2.5">
              <p className="text-xs text-[#6B7280]">Categories</p>
              <p className="text-xl font-bold text-[#6B5C32]">{rmCategoriesCount}</p>
            </CardContent></Card>
            <Card><CardContent className="p-2.5 flex items-center justify-between">
              <div><p className="text-xs text-[#6B7280]">Low Stock (&lt;5)</p><p className="text-xl font-bold text-[#9C6F1E]">{rmLowStock}</p></div>
              <AlertTriangle className="h-5 w-5 text-[#9C6F1E]" />
            </CardContent></Card>
            <Card><CardContent className="p-2.5 flex items-center justify-between">
              <div><p className="text-xs text-[#6B7280]">Zero Stock</p><p className="text-xl font-bold text-[#9A3A2D]">{rmZeroStock}</p></div>
              <Boxes className="h-5 w-5 text-[#9A3A2D]" />
            </CardContent></Card>
          </div>

          {/* Search + Filter + Add */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center flex-wrap">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
              <Input
                value={rmSearch}
                onChange={e => setRmSearch(e.target.value)}
                placeholder="Search by code or name..."
                className="pl-9 h-9"
              />
            </div>
            <select
              value={rmCategoryFilter}
              onChange={e => setRmCategoryFilter(e.target.value)}
              className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white text-[#1F1D1B] focus:border-[#6B5C32] focus:outline-none"
            >
              <option value="ALL">All Categories</option>
              {RM_ITEM_GROUPS.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => setShowBatchImportRM(true)}>
              <Upload className="h-4 w-4" /> Batch Import
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowCreateRM(true)}>
              <Plus className="h-4 w-4" /> Add RM
            </Button>
          </div>

          {/* Create RM modal */}
          {showCreateRM && (
            <Card className="border-2 border-[#6B5C32]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-[#6B5C32]" /> Add Raw Material</CardTitle>
                  <button onClick={() => setShowCreateRM(false)} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="h-5 w-5" /></button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Item Code *</label>
                    <input value={rmForm.itemCode} onChange={e => setRmForm(f => ({ ...f, itemCode: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. PC151 01" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Description *</label>
                    <input value={rmForm.description} onChange={e => setRmForm(f => ({ ...f, description: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="Material description" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Item Group</label>
                    <select value={rmForm.itemGroup} onChange={e => setRmForm(f => ({ ...f, itemGroup: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                      {RM_ITEM_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Base UOM</label>
                    <select value={rmForm.baseUOM} onChange={e => setRmForm(f => ({ ...f, baseUOM: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                      {["PCS", "MTR", "ROLL", "BOX", "CTN", "SET", "KG", "PAIR"].map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Balance Qty</label>
                    <input type="number" value={rmForm.balanceQty || ""} onChange={e => setRmForm(f => ({ ...f, balanceQty: Number(e.target.value) }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="0" />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" size="sm" onClick={() => setShowCreateRM(false)}>Cancel</Button>
                  <Button variant="primary" size="sm" disabled={!rmForm.itemCode || !rmForm.description} onClick={() => { toast.success("Raw material created: " + rmForm.itemCode); setShowCreateRM(false); setRmForm({ itemCode: "", description: "", baseUOM: "PCS", itemGroup: "PLYWOOD", balanceQty: 0 }); }}>
                    Save Material
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* DataGrid */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5 text-[#6B5C32]" /> Raw Materials ({filteredRM.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <DataGrid
                columns={rmColumns}
                data={filteredRM}
                keyField="id"
                gridId="inventory-rm"
                contextMenuItems={contextMenu}
                onDoubleClick={handleDoubleClickRM}
              />
            </CardContent>
          </Card>
        </div>
      )}
      {/* Edit FG Dialog */}
      {editFG && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-[520px] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-lg font-bold text-[#111827]">{editFG.code}</h2>
                <p className="text-xs text-gray-500">{editFG.name}</p>
              </div>
              <button onClick={() => setEditFG(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {/* Read-only info */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                  <div className="h-[34px] flex items-center px-3 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm">
                    <Badge>{editFG.category}</Badge>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Base Model</label>
                  <div className="h-[34px] flex items-center px-3 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm text-[#111827]">
                    {editFG.baseModel}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Size / Model</label>
                  <div className="h-[34px] flex items-center px-3 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm text-[#111827]">
                    {editFG.category === "BEDFRAME" ? editFG.sizeLabel : editFG.baseModel}
                  </div>
                </div>
              </div>

              {/* Editable fields */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Base Price (RM)</label>
                  <Input
                    type="number"
                    value={(editFGForm.costPriceSen / 100).toFixed(2)}
                    onChange={(e) => setEditFGForm(f => ({ ...f, costPriceSen: Math.round(parseFloat(e.target.value || "0") * 100) }))}
                    className="h-[34px]"
                    step="0.01"
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Stock Qty</label>
                  <Input
                    type="number"
                    value={editFGForm.stockQty}
                    onChange={(e) => setEditFGForm(f => ({ ...f, stockQty: parseInt(e.target.value) || 0 }))}
                    className="h-[34px]"
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Unit M3</label>
                  <Input
                    type="number"
                    value={editFGForm.unitM3}
                    onChange={(e) => setEditFGForm(f => ({ ...f, unitM3: parseFloat(e.target.value) || 0 }))}
                    className="h-[34px]"
                    step="0.01"
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Fabric Usage (m)</label>
                  <Input
                    type="number"
                    value={editFGForm.fabricUsage}
                    onChange={(e) => setEditFGForm(f => ({ ...f, fabricUsage: parseFloat(e.target.value) || 0 }))}
                    className="h-[34px]"
                    step="0.1"
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Production Time (min)</label>
                  <Input
                    type="number"
                    value={editFGForm.productionTimeMinutes}
                    onChange={(e) => setEditFGForm(f => ({ ...f, productionTimeMinutes: parseInt(e.target.value) || 0 }))}
                    className="h-[34px]"
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Status</label>
                  <div className="h-[34px] flex items-center px-3 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm">
                    <Badge>{editFG.status}</Badge>
                  </div>
                </div>
              </div>

              {/* Source POs — which production orders produced this FG.
                  Mirrors the WIP detail dialog's PO breakdown. Backend
                  endpoint /api/inventory/fg-source/:productCode walks
                  fg_units grouped by poId. */}
              <div className="pt-2 border-t border-[#E2DDD8]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-[#374151]">Source Production Orders</span>
                  <span className="text-xs text-[#6B7280]">
                    {fgSourcesLoading ? "loading…" : `${fgSources.length} PO(s)`}
                  </span>
                </div>
                {fgSourcesLoading ? (
                  <p className="text-xs text-[#9CA3AF] py-2">Looking up source POs…</p>
                ) : fgSources.length === 0 ? (
                  <p className="text-xs text-[#9CA3AF] py-2">No fg_units rows for this product yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8]">
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">PO No</th>
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">SO No</th>
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">Customer</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Qty</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">MFD Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fgSources.map((s) => (
                        <tr key={s.poId} className="border-b border-[#F0ECE9]">
                          <td className="py-2 doc-number font-medium">{s.poNo || "—"}</td>
                          <td className="py-2 doc-number text-xs text-[#6B7280]">{s.soNo || "—"}</td>
                          <td className="py-2 text-xs text-[#374151]">{s.customerName || "—"}</td>
                          <td className="py-2 text-right">{s.qty}</td>
                          <td className="py-2 text-right text-xs text-[#6B7280]">
                            {s.mfdDate?.split("T")[0] || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditFG(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => {
                toast.success("Saved: " + editFG.code + " — Base Price: RM " + (editFGForm.costPriceSen / 100).toFixed(2));
                setEditFG(null);
              }}>Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* WIP Detail Dialog */}
      {wipDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-lg font-bold text-[#111827]">{wipDetail.wipCode}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <Badge>{wipDetail.wipType}</Badge>
                  <span className="text-xs text-[#6B7280]">{wipDetail.relatedProduct}</span>
                  <span className="text-xs text-[#6B7280]">• {DEPT_LABELS[wipDetail.completedBy] || wipDetail.completedBy}</span>
                </div>
              </div>
              <button onClick={() => setWipDetail(null)} className="p-1 rounded hover:bg-gray-100">
                <X className="h-4 w-4 text-gray-400" />
              </button>
            </div>
            <div className="px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-[#374151]">Total Qty: {wipDetail.totalQty}</span>
                <span className="text-sm text-[#6B7280]">{wipDetail.sources.length} PO(s)</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 text-xs text-[#6B7280] font-medium">SO ID</th>
                    <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Qty</th>
                    <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Completed</th>
                    <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {wipDetail.sources.sort((a, b) => b.ageDays - a.ageDays).map((s, i) => (
                    <tr key={i} className="border-b border-[#F0ECE9]">
                      <td className="py-2 doc-number font-medium">{s.poCode}</td>
                      <td className="py-2 text-right">{s.quantity}</td>
                      <td className="py-2 text-right text-[#6B7280]">{s.completedDate?.split("T")[0] || "-"}</td>
                      <td className="py-2 text-right">
                        <span className={s.ageDays > 14 ? "text-[#9A3A2D] font-semibold" : s.ageDays > 7 ? "text-[#9C6F1E]" : ""}>
                          {s.ageDays === 0 ? "Today" : s.ageDays === 1 ? "1 day" : `${s.ageDays} days`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Job-Card-level breakdown — diagnoses qty mismatches between
                  Production Sheet and Inventory WIP. If two rows show the
                  same wipType for one PO it's duplicate JCs in the wipKey;
                  one row with a high quantity means wipQty is set on the JC. */}
              {wipDetail.members && wipDetail.members.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-[#374151]">Job Cards</span>
                    <span className="text-xs text-[#6B7280]">{wipDetail.members.length} JC(s)</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8]">
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">JC ID</th>
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">PO</th>
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">Type</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wipDetail.members.map((m, i) => (
                        <tr key={i} className="border-b border-[#F0ECE9]">
                          <td className="py-2 doc-number text-xs" title={m.jobCardId}>{m.jobCardId.slice(0, 8)}</td>
                          <td className="py-2 doc-number text-xs">{m.poNo}</td>
                          <td className="py-2 text-xs text-[#374151]">{m.wipType}</td>
                          <td className="py-2 text-right">{m.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="px-6 py-3 border-t border-[#E2DDD8] flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setWipDetail(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit RM Dialog */}
      {editRM && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-lg font-bold text-[#111827]">{editRM.itemCode}</h2>
                <p className="text-xs text-gray-500">{editRM.description}</p>
              </div>
              <button onClick={() => setEditRM(null)} className="p-1 rounded hover:bg-gray-100">
                <X className="h-4 w-4 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Item Code</label>
                  <div className="h-[34px] flex items-center px-3 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm font-medium">{editRM.itemCode}</div>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                  <div className="h-[34px] flex items-center px-3 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm">
                    <Badge>{editRM.itemGroup}</Badge>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Description</label>
                <Input value={editRMForm.description} onChange={(e) => setEditRMForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Unit</label>
                  <select value={editRMForm.baseUOM} onChange={(e) => setEditRMForm(f => ({ ...f, baseUOM: e.target.value }))} className="w-full h-[34px] rounded border border-[#E2DDD8] px-3 text-sm">
                    {["MTR","PCS","SET","BOX","ROLL","CTN","KG","LITER","PAIR","UNIT"].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Stock Qty</label>
                  <Input type="number" value={editRMForm.balanceQty} onChange={(e) => setEditRMForm(f => ({ ...f, balanceQty: parseInt(e.target.value) || 0 }))} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Item Group</label>
                <Input value={editRMForm.itemGroup} onChange={(e) => setEditRMForm(f => ({ ...f, itemGroup: e.target.value }))} />
              </div>

              {/* Source batches in FIFO order — backed by rm_batches joined
                  to grns to recover the originating Purchase Order No. The
                  FIFO ordering matches what the cost-cascade uses to consume
                  stock, so this is the same view the accounting cascade sees. */}
              <div className="pt-2 border-t border-[#E2DDD8]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-[#374151]">Source Batches (FIFO)</span>
                  <span className="text-xs text-[#6B7280]">
                    {rmBatchesLoading ? "loading…" : `${rmBatches.length} batch(es)`}
                  </span>
                </div>
                {rmBatchesLoading ? (
                  <p className="text-xs text-[#9CA3AF] py-2">Looking up source batches…</p>
                ) : rmBatches.length === 0 ? (
                  <p className="text-xs text-[#9CA3AF] py-2">No batches recorded for this raw material yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8]">
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">PO No</th>
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">GRN</th>
                        <th className="text-left py-2 text-xs text-[#6B7280] font-medium">Supplier</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Received</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Original</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Remaining</th>
                        <th className="text-right py-2 text-xs text-[#6B7280] font-medium">Unit Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rmBatches.map((b) => (
                        <tr key={b.id} className={`border-b border-[#F0ECE9] ${b.remainingQty === 0 ? "text-[#9CA3AF]" : ""}`}>
                          <td className="py-2 doc-number font-medium">{b.poNumber || "—"}</td>
                          <td className="py-2 doc-number text-xs text-[#6B7280]">{b.grnNumber || "—"}</td>
                          <td className="py-2 text-xs text-[#374151]">{b.supplierName || "—"}</td>
                          <td className="py-2 text-right text-xs text-[#6B7280]">
                            {b.receivedDate?.split("T")[0] || "—"}
                          </td>
                          <td className="py-2 text-right">{b.originalQty}</td>
                          <td className="py-2 text-right font-medium">{b.remainingQty}</td>
                          <td className="py-2 text-right text-xs">RM {(b.unitCostSen / 100).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditRM(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => {
                toast.success("Saved: " + editRM.itemCode);
                setEditRM(null);
              }}>Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* Batch import dialogs — reusable across FG and RM with different schemas.
          `currentRows` pre-maps existing data into the same column keys so users
          can Export → edit in Excel → re-upload for bulk edits. Prices are kept
          in ringgit (sen / 100) to match the template column header "(RM)". */}
      <BatchImportDialog
        open={showBatchImportFG}
        onClose={() => setShowBatchImportFG(false)}
        title="Batch Import Finished Products"
        description="Upload an Excel or CSV file to create or update multiple products at once. Rows are matched by Product Code."
        templateFilename="fg-import-template.xlsx"
        exportFilename="fg-export.xlsx"
        columns={fgImportColumns}
        keyColumn="code"
        isExistingKey={(key) => products.some((p) => p.code === key)}
        onImport={handleImportFG}
        currentRows={products.map((p) => ({
          code: p.code,
          name: p.name,
          category: p.category,
          baseModel: p.baseModel,
          sizeCode: p.sizeCode,
          sizeLabel: p.sizeLabel,
          basePriceSen: (p.basePriceSen ?? 0) / 100,
          costPriceSen: (p.costPriceSen ?? 0) / 100,
          fabricUsage: p.fabricUsage,
        }))}
      />
      <BatchImportDialog
        open={showBatchImportRM}
        onClose={() => setShowBatchImportRM(false)}
        title="Batch Import Raw Materials"
        description="Upload an Excel or CSV file to create or update multiple raw materials at once. Rows are matched by Item Code."
        templateFilename="rm-import-template.xlsx"
        exportFilename="rm-export.xlsx"
        columns={rmImportColumns}
        keyColumn="itemCode"
        isExistingKey={(key) => liveRawMaterials.some((r) => r.itemCode === key)}
        onImport={handleImportRM}
        currentRows={liveRawMaterials.map((r) => ({
          itemCode: r.itemCode,
          description: r.description,
          baseUOM: r.baseUOM,
          itemGroup: r.itemGroup,
          balanceQty: r.balanceQty,
          isActive: r.isActive,
        }))}
      />
    </div>
  );
}
