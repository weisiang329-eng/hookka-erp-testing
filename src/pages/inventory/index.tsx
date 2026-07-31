import { useState, useMemo, useEffect, startTransition } from "react";
import { cachedFetchJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { type FGItem, type FgDeltas, mergeFgDeltas } from "@/lib/fg-stock";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  Boxes, AlertTriangle, Package, Layers, Plus, X,
  Search, Archive, Upload, Trash2, Pencil, Check,
} from "lucide-react";
import { BatchImportDialog, type ImportColumn } from "@/components/ui/batch-import-dialog";
// NOTE: mock arrays were previously imported here and used as the page data
// source. They are retained only for TYPE imports; all runtime data is now
// fetched live from D1 via the API. After a D1 clear the UI now correctly
// renders zero balances instead of baked-in seed values.
import type { Product, RawMaterial, FGBatch } from "@/types";
import {
  SUCCESS, NEUTRAL,
  INVENTORY_TYPE_COLOR,
  getStockSemantic, getWipAgeSemantic,
} from "@/lib/design-tokens";
import {
  fetchVariantsConfig,
  getVariantsConfigSync,
  patchVariantsConfig,
  type VariantsConfig,
} from "@/lib/kv-config";
import {
  DEFAULT_MATERIAL_VARIANTS,
  materialVariantCode,
  materialVariantDescription,
} from "@/lib/material-variants";
import {
  DEFAULT_BEDFRAME_SIZES,
  DEFAULT_SOFA_COMPARTMENTS,
  bedframeVariantCode,
  bedframeVariantName,
  bedframeVariantDescription,
  sofaVariantCode,
  sofaVariantName,
  sofaVariantDescription,
  type BedframeSize,
} from "@/lib/fg-variants";

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
// FGItem + deriveFGStock now live in the shared @/lib/fg-stock (so the server
// FG-stock endpoint runs the identical derivation).

// (ProductionOrderLike removed 2026-07-14 — the FG page no longer pulls
// /api/production-orders; FG stock now arrives pre-derived from
// /api/inventory/fg-stock. The commented deriveWIPFromPO reference below is
// historical only.)

// --- WIP ---
// WIP items are derived from production orders, grouped by WIP code.
// Same WIP code = one row, qty summed. Double-click to see all SO IDs.
type WIPSource = {
  poCode: string;
  // The producer (positive row) or trigger (negative stub) JC id. Used
  // by the WIP detail dialog's "Job Cards" table — replaces the legacy
  // `members[]` mirror that duplicated poCode/quantity/wipType
  // alongside this id.
  jobCardId: string;
  quantity: number;  // component pieces (= JC wipQty; may include BOM multiplier)
  completedDate: string;
  ageDays: number;
  // Carried on each source so the sofa-set merge (now dormant in the
  // backend) can compute (salesOrderNo, fabricCode) keys without
  // re-fetching the PO. Still emitted by the live backend response.
  fabricCode: string;
};
type WIPItem = {
  id: string;
  wipCode: string;      // e.g. "1013-(Q) -HB 20" (WD)"
  wipType: string;      // e.g. "Divan", "Headboard", "Base", "Cushion", "SET"
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  relatedProduct: string;
  completedBy: string;  // department that completed this WIP ("PENDING" for negative rows)
  totalQty: number;     // summed qty across all POs (negative for skipped-upstream stubs)
  // FIFO oldest age; null on negative (skipped-upstream) rows since
  // there's no producer JC yet — the UI renders "—" for null.
  oldestAgeDays: number | null;
  sources: WIPSource[]; // individual POs for detail view
  // True when every contributing source PO is in category SOFA. The
  // backend computes this once at row build time so the merged-set view
  // (currently dormant) doesn't have to walk `sources[]` to derive it.
  isAllSofa: boolean;
  // Estimated cost (display only — WIP has no real FIFO batch).
  // Material is allocated across the WHOLE PO's minutes: each production
  // minute carries (fullBOM / totalPOMinsPerUnit) sen of material. A WIP
  // has absorbed (doneMinsInThisWipGroup × material-per-min) of that +
  // (doneMinsInThisWipGroup × laborRate) of labor. This scheme is fully
  // self-consistent: walking every WIP through every dept of the PO
  // accumulates exactly BOM + totalPOMins × rate = the final FG cost.
  // Both 0 on negative rows — UI renders "—" in those cells.
  estUnitCostSen: number;
  estTotalValueSen: number;
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

// deriveFGStock now lives in the shared @/lib/fg-stock (imported above) so the
// server /api/inventory/fg-stock endpoint runs the byte-identical derivation.
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
  oldestAgeDays: number | null;
  estTotalValueSen: number;
  components: { wipType: string; qty: number }[];
  members: WIPItem[];
};

// Raw response shape from GET /api/inventory/wip. One row per wip_items
// ledger entry (stock_qty != 0) — positive rows are produced WIP stock,
// negative rows are skipped-upstream stubs. The frontend renders both
// in the same DataGrid; the only visual treatment for negatives is red
// bold qty + dashes in the age/cost/value cells.
type BackendWipRow = {
  id: string;
  wipCode: string;
  wipType: string;
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  completedBy: string;
  relatedProduct: string;
  salesOrderNo: string | null;
  fabric: string;
  oldestAgeDays: number | null;
  estUnitCostSen: number;
  estTotalValueSen: number;
  totalQty: number;
  isAllSofa: boolean;
  sources: Array<{
    poCode: string;
    jobCardId: string;
    quantity: number;
    completedDate: string;
    ageDays: number;
    fabricCode: string;
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
        // For Fab Cut we prefer the JC's stored wipLabel (Option C carries
        // the merged form e.g. "5535-2A(LHF)+L(RHF) | (24) | M2402-5 | (FC)"
        // when several variants share a baseModel + fabric within the SO).
        // Fall back to per-PO recomputation only when the JC didn't store
        // one — legacy data from before the wipLabel field was reliably
        // populated. Recompute mirrors production-builder.ts buildFcWipLabel
        // and the pre-77ba23c frontend fabCutWIP() helper.
        let wipCodeStr: string;
        if (card.departmentCode === "FAB_CUT") {
          if (card.wipLabel) {
            wipCodeStr = card.wipLabel;
          } else {
            const totalH =
              (po.gapInches || 0) +
              (po.divanHeightInches || 0) +
              (po.legHeightInches || 0);
            const isBF = po.itemCategory === "BEDFRAME";
            wipCodeStr = [
              po.productCode,
              // size segment only for BF — sofa's sizeLabel is already
              // inside the productCode (e.g. "5530-2A(LHF)"), showing it
              // again as "(2A(LHF))" would duplicate.
              isBF && po.sizeLabel ? `(${po.sizeLabel})` : "",
              isBF && totalH > 0 ? `(${totalH}")` : "",
              isBF && po.divanHeightInches ? `(DV ${po.divanHeightInches}")` : "",
              po.fabricCode || "",
              "(FC)",
            ].filter(Boolean).join(" | ");
          }
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
    label: "Available",
    align: "right",
    render: (_v, row) => {
      const sem = getStockSemantic(row.stockQty);
      const cls = row.stockQty === 0 || row.stockQty < 5 ? sem.text : "text-[#1F1D1B]";
      return <span className={`font-medium ${cls}`}>{row.stockQty}</span>;
    },
  },
  {
    key: "reservedQty",
    label: "Reserved",
    align: "right",
    render: (_v, row) => (
      <span
        className={
          row.reservedQty > 0
            ? "font-medium text-[#A86A1A]"
            : "text-[#9CA3AF]"
        }
        title="In a DRAFT delivery order — still our stock, not yet dispatched/invoiced"
      >
        {row.reservedQty}
      </span>
    ),
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
    render: (_v, row) => (
      <span className="text-sm font-medium text-[#1F1D1B]">{row.wipCode}</span>
    ),
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
    render: (_v, row) => {
      // Sofa display: strip variant suffix to base model (e.g.
      // "5531-2A(LHF)" → "5531") matching how Wei Siang refers to sofas.
      // BF/ACC keep the full productCode since the variant IS the model
      // identity for those categories.
      const display = row.category === "SOFA"
        ? (row.relatedProduct || "").split("-")[0]
        : (row.relatedProduct || "");
      return <span className="doc-number text-[#4B5563]">{display}</span>;
    },
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
      // Negative qty = skipped-dept stub row (downstream COMPLETED
      // before upstream). Render in red bold so +1/-1 加加减减 reads
      // at a glance as the user advances/backfills depts.
      const isNegative = row.totalQty < 0;
      const cls = isNegative
        ? "font-bold text-[#9A3A2D]"
        : "font-medium text-[#1F1D1B]";
      const title = isNegative
        ? `Negative qty (${row.totalQty}) — downstream dept completed before upstream. Will return to 0 once the upstream dept is also marked complete.`
        : `Total pieces in WIP at this stage. ${breakdown}`;
      return (
        <span className={cls} title={title}>
          {row.totalQty}
        </span>
      );
    },
  },
  {
    key: "sources",
    label: "Source POs",
    align: "right",
    // Filter dropdown shows the count (matches what the cell renders)
    // instead of "[object Object]" from stringifying the array.
    filterAccessor: (row) => row.sources.length,
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
    render: (_v, row) => {
      // Negative rows have no producer JC yet — render dash instead of
      // a misleading "0 days".
      if (row.totalQty < 0 || row.oldestAgeDays == null) {
        return <span className="text-[#9CA3AF]">—</span>;
      }
      return renderAgeCell(row.oldestAgeDays);
    },
  },
  // Estimated cost: WIP has no real FIFO batch so this is a computed
  // estimate (material prorated by labor progress + labor-so-far). Shown
  // with "est." subtitle so users know it's not from the cost ledger.
  {
    key: "estUnitCostSen",
    label: "Unit Cost (RM)",
    align: "right",
    render: (_v, row) => {
      if (row.totalQty < 0) {
        return <span className="text-[#9CA3AF]">—</span>;
      }
      return (
        <div className="text-right tabular-nums">
          <div className="text-[#1F1D1B] text-sm font-medium">
            {formatUnitCost(row.estUnitCostSen)}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">est.</div>
        </div>
      );
    },
  },
  {
    key: "estTotalValueSen",
    label: "Stock Value (RM)",
    align: "right",
    render: (_v, row) => {
      if (row.totalQty < 0) {
        return <span className="text-[#9CA3AF]">—</span>;
      }
      return (
        <div className="text-right tabular-nums">
          <div className="text-[#1F1D1B] text-sm font-medium">
            {formatValue(row.estTotalValueSen)}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">est.</div>
        </div>
      );
    },
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
    render: (_v, row) => {
      if (row.oldestAgeDays == null) {
        return <span className="text-[#9CA3AF]">—</span>;
      }
      return renderAgeCell(row.oldestAgeDays);
    },
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
    key: "description",
    label: "Description",
    render: (_v, row) => (
      <span className="text-[#1F1D1B] text-sm">{row.description || <span className="text-[#9CA3AF] italic">—</span>}</span>
    ),
  },
  {
    key: "itemGroup",
    label: "Category",
    sortable: true,
    sortAccessor: (row) => row.itemGroup ?? "",
    render: (_v, row) => (
      <span className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-xs font-medium text-[#6B5C32]">
        {row.itemGroup || "—"}
      </span>
    ),
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

// ── Inventory in-memory snapshot (SWR) ─────────────────────────────
// Re-entering the Inventory tab re-runs a 7-endpoint load and blanks behind a
// full "Loading inventory…" gate on every single visit. Keep the last
// successfully-loaded dataset at module scope so a revisit paints instantly
// from it while a background refresh runs — instead of blanking. Scope: per
// browser tab (Hookka is single-org); lost on hard reload (cachedFetchJson
// still warms raw-materials/products there). (2026-06-04 blank-every-visit.)
let invSnapshot: {
  products: Product[];
  rawMaterials: RawMaterial[];
  fgDeltas: FgDeltas;
  backendWipRows: BackendWipRow[];
} | null = null;

// ============================================================
// Component
// ============================================================

export default function InventoryPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
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
  // Add FG "Bulk generate" mode (owner 2026-07-11): enter Base Model + Name +
  // Category, tick sizes (bedframe) / compartments (sofa), and create every
  // variant at once — Code / Size Code / Size Label / Name auto-derived, Fabric
  // + prices left blank for Batch Edit. bulkTicked holds the ticked codes;
  // variantsCfg supplies the catalogs (seed defaults until the owner customises
  // them in Products → Maintenance).
  const [fgBulkMode, setFgBulkMode] = useState(false);
  const [fgBulkTicked, setFgBulkTicked] = useState<Set<string>>(new Set());
  const [fgBulkBusy, setFgBulkBusy] = useState(false);
  const [variantsCfg, setVariantsCfg] = useState<VariantsConfig | null>(() => getVariantsConfigSync());
  useEffect(() => {
    void fetchVariantsConfig().then((v) => setVariantsCfg(v));
  }, []);

  // --- Add FG bulk-generate derivation (recomputed per render; cheap) --------
  const bulkBedSizes: BedframeSize[] =
    (variantsCfg?.bedframeSizes as BedframeSize[] | undefined) ?? DEFAULT_BEDFRAME_SIZES;
  const bulkSofaComps: string[] =
    (variantsCfg?.sofaCompartments as string[] | undefined) ?? DEFAULT_SOFA_COMPARTMENTS;
  const bulkIsBed = fgForm.category === "BEDFRAME";
  const bulkIsSofa = fgForm.category === "SOFA";
  // The pool of tickable option codes for the chosen category.
  const bulkPoolCodes: string[] = bulkIsBed
    ? bulkBedSizes.map((s) => s.code).filter(Boolean)
    : bulkIsSofa
      ? bulkSofaComps.filter(Boolean)
      : [];
  const bulkBase = fgForm.code.trim();
  // Per-variant BOM/M3 defaults keyed by size code (bedframe) / compartment
  // (sofa) — set in Products → Maintenance. On generate each variant fills its
  // Unit M3 and clones the chosen source BOM template (owner 2026-07-11).
  const bomDefaults = (variantsCfg?.variantBomDefaults ?? {}) as Record<
    string,
    { defaultBom?: string; unitM3?: number }
  >;
  // Ticked → the concrete variants that would be created (code + name + size
  // fields auto-derived). Filtered to the current pool so switching category
  // never carries stale ticks across.
  const bulkPreview = [...fgBulkTicked]
    .filter((c) => bulkPoolCodes.includes(c))
    .map((c) => {
      const meta = bomDefaults[c];
      if (bulkIsBed) {
        const sz = bulkBedSizes.find((s) => s.code === c) ?? { code: c, label: "", dimensions: "" };
        return {
          code: bedframeVariantCode(bulkBase, sz.code),
          name: bedframeVariantName(fgForm.name, sz),
          sizeCode: sz.code,
          sizeLabel: sz.label,
          description: bedframeVariantDescription(fgForm.name, sz),
          unitM3: meta?.unitM3,
          defaultBom: meta?.defaultBom,
        };
      }
      return {
        code: sofaVariantCode(bulkBase, c),
        name: sofaVariantName(fgForm.name, bulkBase, c),
        sizeCode: c,
        sizeLabel: c,
        description: sofaVariantDescription(bulkBase, c),
        unitM3: meta?.unitM3,
        defaultBom: meta?.defaultBom,
      };
    });

  function toggleBulkTick(code: string) {
    setFgBulkTicked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function runBulkGenerate() {
    if (fgBulkBusy) return;
    const base = fgForm.code.trim();
    if (!base || bulkPreview.length === 0) return;
    setFgBulkBusy(true);
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const newProducts: Product[] = [];
    // Pre-load the chosen source BOM templates once (only when some variant has a
    // default BOM) so each generated variant can clone its l1Processes +
    // wipComponents — the {PRODUCT_CODE} placeholders re-resolve to the new code.
    const bomTplByCode = new Map<string, { l1Processes: unknown; wipComponents: unknown }>();
    if (bulkPreview.some((v) => v.defaultBom)) {
      try {
        const tr = (await (await fetch("/api/bom/templates", { credentials: "include" })).json()) as {
          data?: Array<{ productCode: string; l1Processes: unknown; wipComponents: unknown }>;
        };
        for (const t of tr.data ?? []) bomTplByCode.set(t.productCode, t);
      } catch {
        /* best-effort — skip the BOM clone if the template list can't load */
      }
    }
    // Sequential — one validated POST per variant reuses the server's duplicate
    // + bedframe-sizeCode checks; existing codes are SKIPPED (reported), never
    // abort the batch.
    for (const v of bulkPreview) {
      try {
        const res = await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: v.code,
            name: v.name,
            category: fgForm.category,
            baseModel: base,
            sizeCode: v.sizeCode,
            sizeLabel: v.sizeLabel,
            description: v.description,
            ...(v.unitM3 != null ? { unitM3: v.unitM3 } : {}),
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          data?: Product;
          error?: string;
        };
        if (res.ok && j.success) {
          created++;
          if (j.data) newProducts.push(j.data);
          // Clone the size's chosen default BOM template onto this new variant
          // (best-effort — the FG is created regardless of whether the BOM copy
          // succeeds; a missing source template just skips the copy).
          if (v.defaultBom) {
            const src = bomTplByCode.get(v.defaultBom);
            if (src) {
              await fetch("/api/bom/templates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  productCode: v.code,
                  baseModel: base,
                  category: fgForm.category,
                  l1Processes: src.l1Processes,
                  wipComponents: src.wipComponents,
                }),
              }).catch(() => {});
            }
          }
        } else if ((j.error || "").toLowerCase().includes("already exists")) {
          skipped++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    setFgBulkBusy(false);
    if (newProducts.length) setProducts((prev) => [...prev, ...newProducts]);
    invalidateCachePrefix("/api/products");
    invalidateCachePrefix("/api/inventory");
    const parts = [`${created} created`];
    if (skipped) parts.push(`${skipped} already existed`);
    if (failed) parts.push(`${failed} failed`);
    const msg = parts.join(" · ");
    if (failed) toast.error(msg);
    else toast.success(msg);
    if (created > 0 && failed === 0) {
      setShowCreateFG(false);
      setFgForm(EMPTY_FG_FORM);
      setFgBulkTicked(new Set());
      setFgBulkMode(false);
    }
  }

  // Create RM modal state (declared here so the bulk-generate helpers below can
  // read rmForm / drive showCreateRM).
  const [showCreateRM, setShowCreateRM] = useState(false);
  const [rmForm, setRmForm] = useState<CreateRMForm>({ itemCode: "", description: "", baseUOM: "PCS", itemGroup: "PLYWOOD", balanceQty: 0 });
  const [rmSaving, setRmSaving] = useState(false);

  // ---- Add RM bulk-generate (owner 2026-07-11) -----------------------------
  // Mirrors Add FG: pick a category (itemGroup) + a BASE code, tick the
  // category's variants, and create one material per tick — code = base/variant
  // ("NC36/50" + "6mm" → "NC36/50/6mm"). The per-category variant list lives on
  // variants-config.materialVariants and is edited inline here (this bulk form
  // doubles as the "Material Categories" maintenance the owner asked for).
  const [rmBulkMode, setRmBulkMode] = useState(false);
  const [rmBulkTicked, setRmBulkTicked] = useState<Set<string>>(new Set());
  const [rmBulkBusy, setRmBulkBusy] = useState(false);
  // Dedicated Material Categories maintenance (owner 2026-07-11) — a standalone
  // modal to set up each category's variant list up front (the same lists the
  // Add RM bulk form reads).
  const [showMaterialCats, setShowMaterialCats] = useState(false);
  const [matCatSel, setMatCatSel] = useState<string>("");
  const [matCatNewVar, setMatCatNewVar] = useState("");
  const rmVariantsAll: Record<string, string[]> =
    (variantsCfg?.materialVariants as Record<string, string[]> | undefined) ?? DEFAULT_MATERIAL_VARIANTS;
  const rmCatVariants: string[] =
    rmVariantsAll[rmForm.itemGroup] ?? DEFAULT_MATERIAL_VARIANTS[rmForm.itemGroup] ?? [];
  const rmBulkBase = rmForm.itemCode.trim();
  const rmBulkPreview = [...rmBulkTicked]
    .filter((v) => rmCatVariants.includes(v))
    .map((v) => ({
      code: materialVariantCode(rmBulkBase, v),
      description: materialVariantDescription(rmForm.description, v),
    }));
  function toggleRmTick(v: string) {
    setRmBulkTicked((prev) => {
      const n = new Set(prev);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });
  }
  function saveRmVariants(next: Record<string, string[]>) {
    setVariantsCfg((prev) => ({ ...(prev ?? {}), materialVariants: next }) as VariantsConfig);
    patchVariantsConfig({ materialVariants: next });
  }
  function catVariants(cat: string): string[] {
    return rmVariantsAll[cat] ?? DEFAULT_MATERIAL_VARIANTS[cat] ?? [];
  }
  function addVariantToCat(cat: string, val: string) {
    const v = val.trim();
    const cur = catVariants(cat);
    if (!v || cur.includes(v)) return;
    saveRmVariants({ ...rmVariantsAll, [cat]: [...cur, v] });
  }
  function removeVariantFromCat(cat: string, val: string) {
    saveRmVariants({ ...rmVariantsAll, [cat]: catVariants(cat).filter((x) => x !== val) });
  }
  async function runRmBulkGenerate() {
    if (rmBulkBusy) return;
    const base = rmForm.itemCode.trim();
    if (!base || rmBulkPreview.length === 0) return;
    setRmBulkBusy(true);
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const newRMs: RawMaterial[] = [];
    for (const v of rmBulkPreview) {
      // Client-side dup guard — RM item codes can duplicate at the API, so skip
      // any code already present rather than create a second copy.
      if (liveRawMaterials.some((r) => (r.itemCode || "") === v.code)) {
        skipped++;
        continue;
      }
      try {
        const res = await fetch("/api/raw-materials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemCode: v.code,
            description: v.description,
            baseUOM: rmForm.baseUOM,
            itemGroup: rmForm.itemGroup,
            balanceQty: 0,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          data?: RawMaterial;
          error?: string;
        };
        if (res.ok && j.success) {
          created++;
          if (j.data) newRMs.push(j.data);
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    setRmBulkBusy(false);
    if (newRMs.length) setLiveRawMaterials((prev) => [...prev, ...newRMs]);
    invalidateCachePrefix("/api/raw-materials");
    invalidateCachePrefix("/api/inventory");
    const parts = [`${created} created`];
    if (skipped) parts.push(`${skipped} already existed`);
    if (failed) parts.push(`${failed} failed`);
    const msg = parts.join(" · ");
    if (failed) toast.error(msg);
    else toast.success(msg);
    if (created > 0 && failed === 0) {
      setShowCreateRM(false);
      setRmBulkTicked(new Set());
      setRmBulkMode(false);
    }
  }

  // (Create RM modal state moved up — see near the Add RM bulk-generate helpers.)

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
  const [products, setProducts] = useState<Product[]>(invSnapshot?.products ?? []);
  const [liveRawMaterials, setLiveRawMaterials] = useState<RawMaterial[]>(invSnapshot?.rawMaterials ?? []);
  // Server-derived FG stock (counts + off-catalog dynamics) from
  // /api/inventory/fg-stock — replaces the old client-side deriveFGStock that
  // pulled the ~1.2MB /api/production-orders + /api/delivery-orders +
  // /api/consignment-notes just to split completed POs into Available vs Reserved.
  const [fgDeltas, setFgDeltas] = useState<FgDeltas>(invSnapshot?.fgDeltas ?? { counts: [], dyn: [] });
  // Raw rows from /api/inventory/wip — the wip_items ledger view.
  // Each row corresponds to one wip_items row with stock_qty != 0;
  // negatives are skipped-upstream stubs and live in the same list as
  // positives so the grid is a single uniform render.
  const [backendWipRows, setBackendWipRows] = useState<BackendWipRow[]>(invSnapshot?.backendWipRows ?? []);
  const [loading, setLoading] = useState(!invSnapshot);

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

    // /api/inventory/fg-stock → server-side deriveFGStock, shipped as deltas
    // (counts + off-catalog dynamics). Replaces the old trio of client fetches
    // (production-orders ~1.2MB + delivery-orders + consignment-notes) that
    // existed ONLY to derive FG stock/reserved counts. Snapshot-cached +
    // serve-stale server-side, byte-identical to the old client math.
    const fetchFgDeltas = async (): Promise<FgDeltas> => {
      try {
        const json = await cachedFetchJson<{
          success?: boolean;
          data?: FgDeltas;
          _stub?: boolean;
        }>("/api/inventory/fg-stock");
        if (
          json &&
          json.success &&
          json.data &&
          !json._stub &&
          Array.isArray(json.data.counts)
        ) {
          return {
            counts: json.data.counts,
            dyn: Array.isArray(json.data.dyn) ? json.data.dyn : [],
          };
        }
      } catch { /* fall through */ }
      return { counts: [], dyn: [] };
    };

    (async () => {
      // Perf 2026-07-14: WIP is DEFERRED off the initial mount. /api/inventory/wip
      // was a ~2.3s fetch that blocked the DEFAULT Finished-Products view even
      // though `backendWipRows` feeds ONLY the WIP tab (wipItems / filteredWIP /
      // merged sofa-set view — verified it never touches the FG or RAW tabs). It
      // now loads the first time the WIP tab is opened (tab-gated effect below);
      // the visibilitychange effect keeps it fresh thereafter.
      const [inv, fg] = await Promise.all([
        fetchInventory(),
        fetchFgDeltas(),
      ]);
      if (cancelled) return;
      setProducts(inv.products);
      setLiveRawMaterials(inv.rawMaterials);
      setFgDeltas(fg);
      // Remember this dataset so re-entering Inventory paints instantly (SWR)
      // instead of re-blanking through the full reload. Only snapshot a
      // non-empty load — a degraded/stub response must not poison the cache
      // with blanks (last-known-good philosophy). Keep any prior WIP snapshot
      // (it's loaded lazily, not on this mount).
      if (
        inv.products.length ||
        inv.rawMaterials.length ||
        fg.counts.length ||
        fg.dyn.length
      ) {
        invSnapshot = {
          products: inv.products,
          rawMaterials: inv.rawMaterials,
          fgDeltas: fg,
          backendWipRows: invSnapshot?.backendWipRows ?? [],
        };
      }
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, []);

  // Lazy-load WIP the first time the WIP tab is opened (deferred off mount so
  // the default Finished-Products view isn't blocked by the ~2.3s
  // /api/inventory/wip fetch for data only this tab reads). Same cachedFetchJson
  // path the visibilitychange refetch below uses.
  useEffect(() => {
    if (activeTab !== "WIP" || backendWipRows.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const json = await cachedFetchJson<{
          success?: boolean;
          data?: BackendWipRow[];
          _stub?: boolean;
        }>("/api/inventory/wip");
        if (
          !cancelled &&
          json &&
          json.success &&
          Array.isArray(json.data) &&
          !json._stub
        ) {
          setBackendWipRows(json.data as BackendWipRow[]);
        }
      } catch { /* swallow */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Re-fetch wip_items when the tab regains focus. Fixes the stale-data
  // problem where the user marks JCs complete (or clears all completion
  // dates) on the Production page, navigates back to Inventory, and the
  // page still shows the pre-mutation snapshot. cachedFetchJson's
  // localStorage entry was already invalidated by the Production page's
  // PATCH cascade, so this background refetch picks up the fresh data
  // without a full reload.
  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      // Perf 2026-07-14: only refresh WIP when the WIP tab is actually open —
      // WIP data feeds only that tab, so a visibility-regain on Finished/Raw
      // must NOT trigger the ~2.3s /api/inventory/wip fetch (completes the
      // mount-time WIP deferral). activeTab is in this effect's deps so the
      // closure sees the current tab.
      if (activeTab !== "WIP") return;
      try {
        const json = await cachedFetchJson<{
          success?: boolean;
          data?: BackendWipRow[];
          _stub?: boolean;
        }>("/api/inventory/wip");
        if (
          !cancelled &&
          json &&
          json.success &&
          Array.isArray(json.data) &&
          !json._stub
        ) {
          setBackendWipRows(json.data as BackendWipRow[]);
        }
      } catch { /* swallow */ }
    };
    // Use visibilitychange ONLY (not window.focus) — focus fires when
    // ANY in-page popup closes (native date picker, autocomplete,
    // browser context menu), which would trigger a refetch + re-render
    // on every interaction with form controls. visibilitychange only
    // fires on tab switch / window minimize / programmatic hide.
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeTab]);

  // Derived inventory — merge the server FG-stock deltas onto the catalog
  // (byte-identical to the old client-side deriveFGStock, verified live).
  const fgItems = useMemo<FGItem[]>(
    () => mergeFgDeltas(products, fgDeltas),
    [products, fgDeltas],
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
        // Backend no longer emits SET rows; defensive filter in case a
        // stale cached payload still carries one.
        .filter((r) => r.wipType !== "SET")
        .map<WIPItem>((r) => ({
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
          isAllSofa: r.isAllSofa,
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

  // Merged sofa-set view memo. Backend stopped emitting SET rows in
  // Phase 4.5 (defensive filter at line ~1399 drops any stragglers) and
  // the slim-payload pass dropped setQty / components / memberItemIds /
  // members from the wire — so this memo can only ever resolve to an
  // empty array now. Kept as a stable empty-array reference so anything
  // that might re-wire the merged view in the future has a hook to grab.
  const _sofaSetRows = useMemo<SofaSetRow[]>(() => [], []);
  void _sofaSetRows;
  void wipItemsById;

  // Non-sofa WIPs shown alongside sofa set rows when merged-view is on.
  // Per-component SOFA rows are filtered out here so they only appear when
  // the user switches to PER_COMPONENT view (otherwise they'd double-count
  // against the merged SET rows). Uses the row-level `isAllSofa` flag —
  // see slim-payload commit removing `sources[].itemCategory`.
  const _filteredWIPNonSofa = useMemo(
    () => filteredWIP.filter((w) => !w.isAllSofa),
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
  const fgTotalReserved = fgItems.reduce((s, p) => s + p.reservedQty, 0);

  const wipTotalQty = wipItems.reduce((s, w) => s + w.totalQty, 0);
  // Negative (skipped-upstream) rows have null oldestAgeDays — they
  // contribute nothing to the "Oldest" / "> 7 Days" KPIs.
  const positiveAges = wipItems
    .map((w) => w.oldestAgeDays)
    .filter((v): v is number => typeof v === "number");
  const wipOldest = positiveAges.length > 0 ? Math.max(...positiveAges) : 0;
  const wipOver7Days = positiveAges.filter((d) => d > 7).length;

  const rmCategoriesCount = RM_ITEM_GROUPS.length;
  const rmLowStock = liveRawMaterials.filter(r => r.balanceQty > 0 && r.balanceQty < 5).length;
  const rmZeroStock = liveRawMaterials.filter(r => r.balanceQty === 0).length;


  // Edit FG dialog state
  const [editFG, setEditFG] = useState<FGItem | null>(null);
  const [editFGForm, setEditFGForm] = useState<CreateFGForm>(EMPTY_FG_FORM);
  const [editFGSaving, setEditFGSaving] = useState(false);
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
    // Pre-populate every editable field. Mirrors the Create form so the
    // operator sees exactly the same surface for both flows.
    setEditFGForm({
      code: row.code,
      name: row.name,
      category: row.category,
      baseModel: row.baseModel || "",
      sizeCode: row.sizeCode || "",
      sizeLabel: row.sizeLabel || "",
      description: row.description || "",
      basePriceSen: row.basePriceSen,
      price1Sen: row.price1Sen,
      unitM3: row.unitM3,
      fabricUsage: row.fabricUsage,
      subAssemblies: row.subAssemblies,
      pieces: row.pieces,
      seatHeightPrices: row.seatHeightPrices,
      skuCode: row.skuCode || "",
      fabricColor: row.fabricColor || "",
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
  const [editRMForm, setEditRMForm] = useState({ itemCode: "", description: "", baseUOM: "", itemGroup: "", balanceQty: 0, sheetLengthIn: "", sheetWidthIn: "" });
  const [savingRM, setSavingRM] = useState(false);
  // Delete-in-flight flag so the dialog footer can disable both buttons while
  // DELETE /api/raw-materials/:id is in transit. Mirrors the rmSaving / busy
  // pattern used elsewhere (employees.tsx Manage Departments, Add RM dialog).
  const [deletingRM, setDeletingRM] = useState(false);
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
      itemCode: row.itemCode,
      description: row.description,
      baseUOM: row.baseUOM,
      itemGroup: row.itemGroup,
      balanceQty: row.balanceQty,
      sheetLengthIn: row.sheetLengthIn != null ? String(row.sheetLengthIn) : "",
      sheetWidthIn: row.sheetWidthIn != null ? String(row.sheetWidthIn) : "",
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

  // Soft-delete a FG SKU (owner 2026-07-29: the UI had no delete action at all
  // — only View/Edit/Refresh). Calls the guarded DELETE /api/products/:id,
  // which marks the product INACTIVE (kept in history) and 409s if it is still
  // referenced by an active SO/CO line, active production order, or active BOM.
  const handleDeleteFG = async (row: FGItem) => {
    const ok = await confirm({
      title: "Delete this SKU?",
      message: `Delete "${row.code}"? It is marked INACTIVE (kept in history, not erased). Blocked if the SKU is still on an active order, production order, or BOM.`,
      danger: true,
      confirmLabel: "Delete SKU",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/products/${row.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error || "Can't delete — still referenced by active records.");
        return;
      }
      if (!res.ok) {
        toast.error(`Delete failed (HTTP ${res.status}).`);
        return;
      }
      toast.success(`SKU ${row.code} deleted.`);
      invalidateCachePrefix("/api/products");
      invalidateCachePrefix("/api/inventory");
      window.location.reload();
    } catch {
      toast.error("Delete failed. Please try again.");
    }
  };

  // Context menus per tab. Each Edit/View action opens the same dialog the
  // double-click handler does — right-click was previously stubbed
  // (`action: () => {}`) which made the menu look unresponsive to
  // operators. Refresh hard-reloads after invalidating the relevant cache
  // prefix so the next render fetches fresh data.
  const fgContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: FGItem) => { void handleDoubleClickFG(row); } },
    { label: "Edit", action: (row: FGItem) => { void handleDoubleClickFG(row); } },
    { label: "Delete", action: (row: FGItem) => { void handleDeleteFG(row); } },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => { invalidateCachePrefix("/api/products"); invalidateCachePrefix("/api/inventory"); window.location.reload(); } },
  ];
  const wipContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: WIPItem) => { handleDoubleClickWIP(row); } },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => { invalidateCachePrefix("/api/inventory"); window.location.reload(); } },
  ];
  const rmContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: RawMaterial) => { void handleDoubleClickRM(row); } },
    { label: "Edit", action: (row: RawMaterial) => { void handleDoubleClickRM(row); } },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => { invalidateCachePrefix("/api/raw-materials"); invalidateCachePrefix("/api/inventory"); window.location.reload(); } },
  ];

  // Batch import state (FG and RM share the same dialog component with
  // different column schemas / key columns / handlers).
  const [showBatchImportFG, setShowBatchImportFG] = useState(false);
  const [showBatchImportRM, setShowBatchImportRM] = useState(false);
  // Batch EDIT (separate from import) - inline edit Item Group + UOM
  // across many RMs in one move, mirroring the BOM Batch Edit Categories
  // dialog. Added 2026-04-28 per user request.
  const [showBatchEditRM, setShowBatchEditRM] = useState(false);

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
      <div className="flex border-b border-[#E2DDD8] overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => startTransition(() => setActiveTab(tab.key))}
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
              <p className="text-xs text-[#6B7280]">Available · Reserved</p>
              <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                {fgTotalStock.toLocaleString()}
                <span className="text-[#A86A1A]"> · {fgTotalReserved.toLocaleString()}</span>
                <span className="text-sm font-normal text-[#9CA3AF]"> pcs</span>
              </p>
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
                {/* Single vs Bulk generate (owner 2026-07-11). Bulk: enter Base
                    Model + Name + Category, tick sizes/compartments, create all
                    variants at once (Code/Size auto-derived; prices via Batch). */}
                <div className="mb-4 inline-flex rounded-md border border-[#E2DDD8] overflow-hidden">
                  <button onClick={() => setFgBulkMode(false)} className={`px-3.5 py-1.5 text-sm ${!fgBulkMode ? "bg-[#6B5C32] text-white font-medium" : "text-gray-500 hover:bg-[#FAF9F7]"}`}>Single</button>
                  <button onClick={() => setFgBulkMode(true)} className={`px-3.5 py-1.5 text-sm ${fgBulkMode ? "bg-[#6B5C32] text-white font-medium" : "text-gray-500 hover:bg-[#FAF9F7]"}`}>Bulk generate</button>
                </div>
                {fgBulkMode ? (
                  <div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                      <div>
                        <label className="block text-xs text-[#6B7280] mb-1">Base Model *</label>
                        <input value={fgForm.code} onChange={e => setFgForm(f => ({ ...f, code: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder={bulkIsBed ? "e.g. 1003" : "e.g. 5535"} />
                      </div>
                      <div>
                        <label className="block text-xs text-[#6B7280] mb-1">Name{bulkIsBed ? " *" : " (optional)"}</label>
                        <input value={fgForm.name} onChange={e => setFgForm(f => ({ ...f, name: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder={bulkIsBed ? "e.g. ROMA BEDFRAME" : "blank → SOFA <model> <compartment>"} />
                      </div>
                      <div>
                        <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                        <select value={fgForm.category} onChange={e => { const v = e.target.value; setFgForm(f => ({ ...f, category: v })); setFgBulkTicked(new Set()); }} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                          <option value="BEDFRAME">Bedframe</option>
                          <option value="SOFA">Sofa</option>
                        </select>
                      </div>
                    </div>

                    {bulkIsBed || bulkIsSofa ? (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-[#374151]">{bulkIsBed ? "Which sizes does this model come in?" : `Which compartments does ${bulkBase || "this model"} have?`}</span>
                          <button
                            onClick={() => { const all = bulkPoolCodes.length > 0 && bulkPoolCodes.every(c => fgBulkTicked.has(c)); setFgBulkTicked(all ? new Set() : new Set(bulkPoolCodes)); }}
                            className="text-xs text-[#6B5C32] font-medium hover:underline"
                          >
                            {bulkPoolCodes.length > 0 && bulkPoolCodes.every(c => fgBulkTicked.has(c)) ? "Clear all" : "Select all"}
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                          {bulkPoolCodes.map(code => {
                            const on = fgBulkTicked.has(code);
                            const bf = bulkIsBed ? bulkBedSizes.find(s => s.code === code) : undefined;
                            return (
                              <button key={code} onClick={() => toggleBulkTick(code)} className={`flex items-center gap-2 border rounded px-2.5 py-1.5 text-sm text-left ${on ? "border-[#6B5C32] bg-[#F4EFE3]" : "border-[#E2DDD8] bg-white text-gray-600 hover:bg-[#FAF9F7]"}`}>
                                <span className={`w-4 h-4 flex-shrink-0 rounded-sm border flex items-center justify-center ${on ? "bg-[#6B5C32] border-[#6B5C32] text-white" : "border-gray-300"}`}>{on ? <Check className="w-3 h-3" /> : null}</span>
                                <span className="min-w-0">
                                  <span className="font-mono">{code}</span>
                                  {bf?.label ? <span className="block text-[10px] text-gray-400 truncate">{bf.label} · {bf.dimensions}</span> : null}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="bg-[#FAF6EF] border border-[#E2DDD8] rounded-md p-3">
                          <div className="text-xs text-gray-500 mb-2">Will create <b className="text-[#6B5C32]">{bulkPreview.length}</b> product{bulkPreview.length === 1 ? "" : "s"} — Fabric Usage + prices left blank (fill later via Batch Edit)</div>
                          <div className="flex flex-wrap gap-1.5">
                            {bulkPreview.map(v => <span key={v.code} className="text-xs font-mono bg-white border border-[#E2DDD8] rounded px-2 py-0.5" title={v.name}>{v.code}</span>)}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="text-sm text-gray-400 py-6 text-center">Bulk generate is for Bedframe + Sofa. Pick a category above.</div>
                    )}
                  </div>
                ) : (
                <>
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
                      type="number" onFocus={(e) => e.currentTarget.select()} step="0.01" min={0}
                      value={fgForm.basePriceSen !== undefined ? (fgForm.basePriceSen / 100).toFixed(2) : ""}
                      onChange={e => setFgForm(f => ({ ...f, basePriceSen: e.target.value === "" ? undefined : Math.round(parseFloat(e.target.value || "0") * 100) }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Price 1 (RM)</label>
                    <input
                      type="number" onFocus={(e) => e.currentTarget.select()} step="0.01" min={0}
                      value={fgForm.price1Sen !== undefined && fgForm.price1Sen !== null ? (fgForm.price1Sen / 100).toFixed(2) : ""}
                      onChange={e => setFgForm(f => ({ ...f, price1Sen: e.target.value === "" ? undefined : Math.round(parseFloat(e.target.value || "0") * 100) }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="Optional (bedframe tier 1)"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Unit M3</label>
                    <input
                      type="number" onFocus={(e) => e.currentTarget.select()} step="0.01" min={0}
                      value={fgForm.unitM3 !== undefined ? String(fgForm.unitM3) : ""}
                      onChange={e => setFgForm(f => ({ ...f, unitM3: e.target.value === "" ? undefined : parseFloat(e.target.value || "0") }))}
                      className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                      placeholder="e.g. 0.69"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Fabric Usage (m)</label>
                    <input
                      type="number" onFocus={(e) => e.currentTarget.select()} step="0.1" min={0}
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
                </>
                )}
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" size="sm" onClick={() => { setShowCreateFG(false); setFgBulkTicked(new Set()); }} disabled={fgSaving || fgBulkBusy}>Cancel</Button>
                  {fgBulkMode ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!fgForm.code.trim() || bulkPreview.length === 0 || fgBulkBusy}
                    onClick={() => { void runBulkGenerate(); }}
                  >
                    {fgBulkBusy ? "Generating…" : `Generate ${bulkPreview.length} product${bulkPreview.length === 1 ? "" : "s"}`}
                  </Button>
                  ) : (
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
                  )}
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
                virtualize
                contextMenuItems={fgContextMenu}
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
                virtualize
                contextMenuItems={wipContextMenu}
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
            {/* Duplicate item codes are now allowed automatically (the
                API drops the DB unique lock on the next raw-material
                write — see ensureDupCodesUnlocked) so no manual
                "unlock" button is needed during the consolidation. */}
            <Button variant="outline" size="sm" onClick={() => setShowBatchEditRM(true)}>
              <Pencil className="h-4 w-4" /> Batch Edit
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowBatchImportRM(true)}>
              <Upload className="h-4 w-4" /> Batch Import
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setMatCatSel(matCatSel || RM_ITEM_GROUPS[0]); setShowMaterialCats(true); }}>
              <Layers className="h-4 w-4" /> Categories
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
                {/* Single vs Bulk generate (owner 2026-07-11). Bulk: pick a
                    category + base code, tick the category's variants, create
                    one material per tick (code = base/variant). */}
                <div className="mb-4 inline-flex rounded-md border border-[#E2DDD8] overflow-hidden">
                  <button onClick={() => setRmBulkMode(false)} className={`px-3.5 py-1.5 text-sm ${!rmBulkMode ? "bg-[#6B5C32] text-white font-medium" : "text-gray-500 hover:bg-[#FAF9F7]"}`}>Single</button>
                  <button onClick={() => setRmBulkMode(true)} className={`px-3.5 py-1.5 text-sm ${rmBulkMode ? "bg-[#6B5C32] text-white font-medium" : "text-gray-500 hover:bg-[#FAF9F7]"}`}>Bulk generate</button>
                </div>
                {rmBulkMode ? (
                  <div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                      <div>
                        <label className="block text-xs text-[#6B7280] mb-1">Item Group (category)</label>
                        <select value={rmForm.itemGroup} onChange={e => { setRmForm(f => ({ ...f, itemGroup: e.target.value })); setRmBulkTicked(new Set()); }} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                          {RM_ITEM_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-[#6B7280] mb-1">Base Code *</label>
                        <input value={rmForm.itemCode} onChange={e => setRmForm(f => ({ ...f, itemCode: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. NC36/50" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#6B7280] mb-1">Base UOM</label>
                        <select value={rmForm.baseUOM} onChange={e => setRmForm(f => ({ ...f, baseUOM: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                          {["PCS", "MTR", "ROLL", "BOX", "CTN", "SET", "KG", "PAIR"].map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="sm:col-span-3">
                        <label className="block text-xs text-[#6B7280] mb-1">Description (base — variant appended per item)</label>
                        <input value={rmForm.description} onChange={e => setRmForm(f => ({ ...f, description: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. Foam Sheet" />
                      </div>
                    </div>

                    <div className="text-sm font-medium text-[#374151] mb-2">Which {rmForm.itemGroup} variants? <span className="text-xs text-gray-400 font-normal">(tick to include · these are this category's saved list)</span></div>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {rmCatVariants.map(v => {
                        const on = rmBulkTicked.has(v);
                        return (
                          <span key={v} className={`inline-flex items-center gap-1.5 border rounded px-2.5 py-1 text-sm ${on ? "border-[#6B5C32] bg-[#F4EFE3]" : "border-[#E2DDD8] bg-white text-gray-600 hover:bg-[#FAF9F7]"}`}>
                            <button onClick={() => toggleRmTick(v)} className="inline-flex items-center gap-1.5">
                              <span className={`w-4 h-4 flex-shrink-0 rounded-sm border flex items-center justify-center ${on ? "bg-[#6B5C32] border-[#6B5C32] text-white" : "border-gray-300"}`}>{on ? <Check className="w-3 h-3" /> : null}</span>
                              <span className="font-mono">{v}</span>
                            </button>
                          </span>
                        );
                      })}
                      {rmCatVariants.length === 0 && <span className="text-sm text-gray-400">No variants for {rmForm.itemGroup} yet — add them in the Categories manager (toolbar), then come back here.</span>}
                    </div>
                    <div className="text-xs text-gray-400 mb-4">Tick which variants to generate. To add or remove the variants themselves, use the <b>Categories</b> button — the preset is locked here so it can't be changed by accident.</div>

                    <div className="bg-[#FAF6EF] border border-[#E2DDD8] rounded-md p-3">
                      <div className="text-xs text-gray-500 mb-2">Will create <b className="text-[#6B5C32]">{rmBulkPreview.length}</b> material{rmBulkPreview.length === 1 ? "" : "s"} — Balance Qty starts 0</div>
                      <div className="flex flex-wrap gap-1.5">
                        {rmBulkPreview.map(v => <span key={v.code} className="text-xs font-mono bg-white border border-[#E2DDD8] rounded px-2 py-0.5" title={v.description}>{v.code}</span>)}
                      </div>
                    </div>
                  </div>
                ) : (
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
                    <input type="number" onFocus={(e) => e.currentTarget.select()} value={rmForm.balanceQty || ""} onChange={e => setRmForm(f => ({ ...f, balanceQty: Number(e.target.value) }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="0" />
                  </div>
                </div>
                )}
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" size="sm" onClick={() => { setShowCreateRM(false); setRmBulkTicked(new Set()); }} disabled={rmSaving || rmBulkBusy}>Cancel</Button>
                  {rmBulkMode ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!rmForm.itemCode.trim() || rmBulkPreview.length === 0 || rmBulkBusy}
                    onClick={() => { void runRmBulkGenerate(); }}
                  >
                    {rmBulkBusy ? "Generating…" : `Generate ${rmBulkPreview.length} material${rmBulkPreview.length === 1 ? "" : "s"}`}
                  </Button>
                  ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!rmForm.itemCode || !rmForm.description || rmSaving}
                    onClick={async () => {
                      // POST to /api/raw-materials. The route handler runs the
                      // fabric cascade automatically when itemGroup is one of
                      // B.M-FABR / S.M-FABR / S-FABRIC, mirroring the row into
                      // both `fabrics` and `fabric_trackings` so the
                      // /inventory/fabrics page sees it on next mount.
                      setRmSaving(true);
                      try {
                        const res = await fetch("/api/raw-materials", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            itemCode: rmForm.itemCode,
                            description: rmForm.description,
                            baseUOM: rmForm.baseUOM,
                            itemGroup: rmForm.itemGroup,
                            balanceQty: rmForm.balanceQty,
                          }),
                        });
                        const json = (await res.json()) as { success?: boolean; data?: RawMaterial; error?: string };
                        if (!res.ok || !json.success) {
                          toast.error(json.error || `Failed to create raw material (HTTP ${res.status})`);
                          return;
                        }
                        // Optimistic local insert + cache invalidation so other
                        // pages (Inventory, Fabrics, BOM) refresh on next mount.
                        if (json.data) setLiveRawMaterials((prev) => [...prev, json.data as RawMaterial]);
                        invalidateCachePrefix("/api/raw-materials");
                        invalidateCachePrefix("/api/inventory");
                        invalidateCachePrefix("/api/fabric-tracking");
                        invalidateCachePrefix("/api/fabrics");
                        toast.success(`Raw material created: ${rmForm.itemCode}`);
                        setShowCreateRM(false);
                        setRmForm({ itemCode: "", description: "", baseUOM: "PCS", itemGroup: "PLYWOOD", balanceQty: 0 });
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed to create raw material");
                      } finally {
                        setRmSaving(false);
                      }
                    }}
                  >
                    {rmSaving ? "Saving..." : "Save Material"}
                  </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Material Categories maintenance modal (owner 2026-07-11) — set up
              each category's variant list up front; Add RM → Bulk reads them. */}
          {showMaterialCats && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowMaterialCats(false)}>
              <div className="bg-white rounded-xl shadow-xl w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
                  <div>
                    <h2 className="text-lg font-bold text-[#111827]">Material Categories</h2>
                    <p className="text-xs text-gray-500">Each category's variant list — used by Add RM → Bulk generate. Changes save automatically.</p>
                  </div>
                  <button onClick={() => setShowMaterialCats(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5 text-gray-400" /></button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                    <select value={matCatSel} onChange={(e) => setMatCatSel(e.target.value)} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                      {RM_ITEM_GROUPS.map((g) => <option key={g} value={g}>{g}{catVariants(g).length ? ` (${catVariants(g).length})` : ""}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="text-xs text-[#6B7280] mb-1.5">Variants for <span className="font-mono text-[#1F1D1B]">{matCatSel}</span></div>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {catVariants(matCatSel).map((v) => (
                        <span key={v} className="inline-flex items-center gap-1.5 border border-[#E2DDD8] rounded px-2.5 py-1 text-sm bg-[#FAF9F7]">
                          <span className="font-mono">{v}</span>
                          <button onClick={() => removeVariantFromCat(matCatSel, v)} className="text-[#9A3A2D]/50 hover:text-[#9A3A2D]" title="Remove"><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                      {catVariants(matCatSel).length === 0 && <span className="text-sm text-gray-400">No variants yet.</span>}
                    </div>
                    <div className="flex gap-2">
                      <input value={matCatNewVar} onChange={(e) => setMatCatNewVar(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addVariantToCat(matCatSel, matCatNewVar); setMatCatNewVar(""); } }} className="flex-1 border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder={`Add a ${matCatSel} variant (e.g. 6mm)`} />
                      <Button variant="outline" size="sm" onClick={() => { addVariantToCat(matCatSel, matCatNewVar); setMatCatNewVar(""); }} disabled={!matCatNewVar.trim()}><Plus className="h-4 w-4" /> Add</Button>
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
                  <Button variant="primary" size="sm" onClick={() => setShowMaterialCats(false)}>Done</Button>
                </div>
              </div>
            </div>
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
                virtualize
                contextMenuItems={rmContextMenu}
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
              {/* Editable fields — same surface as the Add Finished Product
                  form. Operator can revise any product attribute, not just
                  the price/qty subset the legacy dialog allowed. */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Code *</label>
                  <input value={editFGForm.code} onChange={e => setEditFGForm(f => ({ ...f, code: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 2050(A)-(K)" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Name *</label>
                  <input value={editFGForm.name} onChange={e => setEditFGForm(f => ({ ...f, name: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. ROMA BEDFRAME (6FT)" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                  <select value={editFGForm.category} onChange={e => setEditFGForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none">
                    <option value="BEDFRAME">Bedframe</option>
                    <option value="SOFA">Sofa</option>
                    <option value="ACCESSORY">Accessory</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Base Model</label>
                  <input value={editFGForm.baseModel} onChange={e => setEditFGForm(f => ({ ...f, baseModel: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 1003(A)" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Size Code</label>
                  <input value={editFGForm.sizeCode} onChange={e => setEditFGForm(f => ({ ...f, sizeCode: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. K, Q, S" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Size Label</label>
                  <input value={editFGForm.sizeLabel} onChange={e => setEditFGForm(f => ({ ...f, sizeLabel: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 6FT" />
                </div>
                <div className="sm:col-span-3">
                  <label className="block text-xs text-[#6B7280] mb-1">Description</label>
                  <input value={editFGForm.description ?? ""} onChange={e => setEditFGForm(f => ({ ...f, description: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="Optional description / notes" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Base Price (RM)</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()} step="0.01" min={0}
                    value={editFGForm.basePriceSen !== undefined ? (editFGForm.basePriceSen / 100).toFixed(2) : ""}
                    onChange={e => setEditFGForm(f => ({ ...f, basePriceSen: e.target.value === "" ? undefined : Math.round(parseFloat(e.target.value || "0") * 100) }))}
                    className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Price 1 (RM)</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()} step="0.01" min={0}
                    value={editFGForm.price1Sen !== undefined && editFGForm.price1Sen !== null ? (editFGForm.price1Sen / 100).toFixed(2) : ""}
                    onChange={e => setEditFGForm(f => ({ ...f, price1Sen: e.target.value === "" ? undefined : Math.round(parseFloat(e.target.value || "0") * 100) }))}
                    className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                    placeholder="Optional (bedframe tier 1)"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Unit M3</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()} step="0.01" min={0}
                    value={editFGForm.unitM3 !== undefined ? String(editFGForm.unitM3) : ""}
                    onChange={e => setEditFGForm(f => ({ ...f, unitM3: e.target.value === "" ? undefined : parseFloat(e.target.value || "0") }))}
                    className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                    placeholder="e.g. 0.69"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Fabric Usage (m)</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()} step="0.1" min={0}
                    value={editFGForm.fabricUsage !== undefined ? String(editFGForm.fabricUsage) : ""}
                    onChange={e => setEditFGForm(f => ({ ...f, fabricUsage: e.target.value === "" ? undefined : parseFloat(e.target.value || "0") }))}
                    className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                    placeholder="e.g. 6"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">SKU Code</label>
                  <input value={editFGForm.skuCode ?? ""} onChange={e => setEditFGForm(f => ({ ...f, skuCode: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="e.g. 5530-1NA-SIZE-BASE" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Fabric Colour</label>
                  <input value={editFGForm.fabricColor ?? ""} onChange={e => setEditFGForm(f => ({ ...f, fabricColor: e.target.value }))} className="w-full border border-[#E2DDD8] rounded px-3 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none" placeholder="Optional" />
                </div>
              </div>
              {Boolean(editFGForm.seatHeightPrices || editFGForm.subAssemblies || editFGForm.pieces) && (
                <div className="text-xs text-[#6B7280] bg-[#FAF9F7] border border-[#E2DDD8] rounded px-3 py-2">
                  This product also carries advanced configuration that's preserved on save:
                  {editFGForm.seatHeightPrices ? <div>· Seat-height price ladder (sofa tier JSON)</div> : null}
                  {editFGForm.subAssemblies ? <div>· Sub-assemblies</div> : null}
                  {editFGForm.pieces ? <div>· Pieces breakdown</div> : null}
                </div>
              )}

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
                  <div className="overflow-x-auto">
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
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditFG(null)} disabled={editFGSaving}>Cancel</Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!editFGForm.code || !editFGForm.name || editFGSaving}
                onClick={async () => {
                  setEditFGSaving(true);
                  try {
                    const body: Record<string, unknown> = {
                      code: editFGForm.code,
                      name: editFGForm.name,
                      category: editFGForm.category,
                      baseModel: editFGForm.baseModel || editFGForm.code,
                      sizeCode: editFGForm.sizeCode,
                      sizeLabel: editFGForm.sizeLabel,
                    };
                    if (editFGForm.description !== undefined) body.description = editFGForm.description;
                    if (editFGForm.basePriceSen !== undefined) body.basePriceSen = editFGForm.basePriceSen;
                    if (editFGForm.price1Sen !== undefined) body.price1Sen = editFGForm.price1Sen;
                    if (editFGForm.unitM3 !== undefined) body.unitM3 = editFGForm.unitM3;
                    if (editFGForm.fabricUsage !== undefined) body.fabricUsage = editFGForm.fabricUsage;
                    if (editFGForm.subAssemblies !== undefined) body.subAssemblies = editFGForm.subAssemblies;
                    if (editFGForm.pieces !== undefined) body.pieces = editFGForm.pieces;
                    if (editFGForm.seatHeightPrices !== undefined) body.seatHeightPrices = editFGForm.seatHeightPrices;
                    if (editFGForm.skuCode !== undefined) body.skuCode = editFGForm.skuCode;
                    if (editFGForm.fabricColor !== undefined) body.fabricColor = editFGForm.fabricColor;

                    const res = await fetch(`/api/products/${encodeURIComponent(editFG.id)}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                    });
                    const json = (await res.json().catch(() => null)) as
                      | { success?: boolean; data?: Product; error?: string }
                      | null;
                    if (!res.ok || !json?.success) {
                      toast.error(json?.error || `Failed to update product (HTTP ${res.status})`);
                      return;
                    }
                    // Optimistic local update so the row reflects the new
                    // values without a full refetch. Cache invalidation
                    // covers any other page that mounts /api/products.
                    if (json.data) {
                      setProducts((prev) => prev.map((p) => p.id === editFG.id ? (json.data as Product) : p));
                    }
                    invalidateCachePrefix("/api/products");
                    invalidateCachePrefix("/api/inventory");
                    toast.success(`Saved: ${editFGForm.code}`);
                    setEditFG(null);
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to update product");
                  } finally {
                    setEditFGSaving(false);
                  }
                }}
              >
                {editFGSaving ? "Saving…" : "Save Product"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* WIP Detail Dialog */}
      {wipDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
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
              <div className="overflow-x-auto">
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
              </div>

              {/* Job-Card-level breakdown — diagnoses qty mismatches between
                  Production Sheet and Inventory WIP. If two rows show the
                  same wipType for one PO it's duplicate JCs in the wipKey;
                  one row with a high quantity means wipQty is set on the JC.

                  Slim-payload note: previously read a separate `members[]`
                  array that was a 4-field mirror of `sources[]`. The
                  backend now emits `jobCardId` directly on each source,
                  so the table renders straight from `sources` — wipType
                  is row-level (constant across all JCs of the row). */}
              {wipDetail.sources.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-[#374151]">Job Cards</span>
                    <span className="text-xs text-[#6B7280]">{wipDetail.sources.length} JC(s)</span>
                  </div>
                  <div className="overflow-x-auto">
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
                      {wipDetail.sources.map((s, i) => (
                        <tr key={i} className="border-b border-[#F0ECE9]">
                          <td className="py-2 doc-number text-xs" title={s.jobCardId}>{s.jobCardId.slice(0, 8)}</td>
                          <td className="py-2 doc-number text-xs">{s.poCode}</td>
                          <td className="py-2 text-xs text-[#374151]">{wipDetail.wipType}</td>
                          <td className="py-2 text-right">{s.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
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
                  <Input
                    value={editRMForm.itemCode}
                    onChange={(e) => setEditRMForm(f => ({ ...f, itemCode: e.target.value }))}
                    placeholder="e.g. CLM-18MM 4' X 8'"
                  />
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
                  <Input type="number" onFocus={(e) => e.currentTarget.select()} value={editRMForm.balanceQty} onChange={(e) => setEditRMForm(f => ({ ...f, balanceQty: parseInt(e.target.value) || 0 }))} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Item Group</label>
                <Input value={editRMForm.itemGroup} onChange={(e) => setEditRMForm(f => ({ ...f, itemGroup: e.target.value }))} />
              </div>

              {/* Sheet size (inches) — used for FILLER / sponge area-based
                  consumption. One sheet's area = length × width; a BOM cut piece
                  consumes cutArea ÷ sheetArea of a sheet. Leave blank for
                  non-sheet materials (consumption then uses the plain qty). */}
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Sheet size <span className="text-[#9CA3AF]">(inches — for sponge / sheet materials; blank = not used)</span>
                </label>
                <div className="flex items-center gap-2">
                  <Input type="number" placeholder="Length" onFocus={(e) => e.currentTarget.select()} value={editRMForm.sheetLengthIn} onChange={(e) => setEditRMForm(f => ({ ...f, sheetLengthIn: e.target.value }))} />
                  <span className="text-[#9CA3AF]">×</span>
                  <Input type="number" placeholder="Width" onFocus={(e) => e.currentTarget.select()} value={editRMForm.sheetWidthIn} onChange={(e) => setEditRMForm(f => ({ ...f, sheetWidthIn: e.target.value }))} />
                </div>
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
                  <div className="overflow-x-auto">
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
                  </div>
                )}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-between gap-2">
              {/* Delete sits on the LEFT (secondary, destructive) so it
                  reads as a separate flow from the Save button. Matches
                  the "danger-on-the-far-side" placement used in the
                  Edit Department dialog (employees.tsx :2367 remove()). */}
              <Button
                variant="outline"
                size="sm"
                disabled={deletingRM || savingRM}
                onClick={async () => {
                  if (!(await confirm({ title: "Delete raw material", message: `Delete raw material "${editRM.itemCode}" (${editRM.description})?\n\nThis cannot be undone.`, danger: true }))) return;
                  setDeletingRM(true);
                  try {
                    const res = await fetch(`/api/raw-materials/${encodeURIComponent(editRM.id)}`, { method: "DELETE" });
                    const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
                    if (res.status === 409) {
                      // FK / fabric-still-referenced guard. Surface the
                      // backend message verbatim so ops know exactly which
                      // SO line is blocking the delete.
                      toast.error(j?.error || `Cannot delete ${editRM.itemCode}: still in use`);
                      return;
                    }
                    if (!res.ok || !j?.success) {
                      toast.error(j?.error || `Delete failed (HTTP ${res.status})`);
                      return;
                    }
                    toast.success(`Deleted ${editRM.itemCode}`);
                    // Optimistic local removal + cache invalidation so other
                    // pages (BOM, Fabrics, Stock Value) refresh on next mount.
                    const deletedId = editRM.id;
                    setLiveRawMaterials((prev) => prev.filter((r) => r.id !== deletedId));
                    invalidateCachePrefix("/api/raw-materials");
                    invalidateCachePrefix("/api/inventory");
                    invalidateCachePrefix("/api/fabric-tracking");
                    invalidateCachePrefix("/api/fabrics");
                    setEditRM(null);
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Delete failed");
                  } finally {
                    setDeletingRM(false);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> {deletingRM ? "Deleting..." : "Delete"}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditRM(null)} disabled={deletingRM || savingRM}>Cancel</Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    deletingRM ||
                    savingRM ||
                    !editRMForm.itemCode.trim() ||
                    !editRMForm.description.trim()
                  }
                  onClick={async () => {
                    const targetId = editRM.id;
                    const newCode = editRMForm.itemCode.trim();
                    const renamed = newCode !== editRM.itemCode;
                    setSavingRM(true);
                    try {
                      const res = await fetch(
                        `/api/raw-materials/${encodeURIComponent(targetId)}`,
                        {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            itemCode: newCode,
                            description: editRMForm.description.trim(),
                            baseUOM: editRMForm.baseUOM,
                            itemGroup: editRMForm.itemGroup.trim(),
                            balanceQty: editRMForm.balanceQty,
                            sheetLengthIn: editRMForm.sheetLengthIn.trim() === "" ? null : Number(editRMForm.sheetLengthIn),
                            sheetWidthIn: editRMForm.sheetWidthIn.trim() === "" ? null : Number(editRMForm.sheetWidthIn),
                          }),
                        },
                      );
                      const j = (await res.json().catch(() => null)) as
                        | { success?: boolean; error?: string }
                        | null;
                      if (!res.ok || !j?.success) {
                        // Surface the backend message verbatim (e.g. the
                        // duplicate-code guard) so ops know why it bounced.
                        toast.error(
                          j?.error || `Save failed (HTTP ${res.status})`,
                        );
                        return;
                      }
                      toast.success(
                        renamed
                          ? `Renamed ${editRM.itemCode} -> ${newCode}`
                          : `Saved ${newCode}`,
                      );
                      // Patch the row in place (id is stable across a
                      // rename) + invalidate the caches every dependent
                      // page reads so BOM / Fabrics / Stock Value pick up
                      // the new code on next mount.
                      setLiveRawMaterials((prev) =>
                        prev.map((r) =>
                          r.id === targetId
                            ? {
                                ...r,
                                itemCode: newCode,
                                description: editRMForm.description.trim(),
                                baseUOM: editRMForm.baseUOM,
                                itemGroup: editRMForm.itemGroup.trim(),
                                balanceQty: editRMForm.balanceQty,
                                sheetLengthIn: editRMForm.sheetLengthIn.trim() === "" ? null : Number(editRMForm.sheetLengthIn),
                                sheetWidthIn: editRMForm.sheetWidthIn.trim() === "" ? null : Number(editRMForm.sheetWidthIn),
                              }
                            : r,
                        ),
                      );
                      invalidateCachePrefix("/api/raw-materials");
                      invalidateCachePrefix("/api/inventory");
                      invalidateCachePrefix("/api/fabric-tracking");
                      invalidateCachePrefix("/api/fabrics");
                      setEditRM(null);
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Save failed",
                      );
                    } finally {
                      setSavingRM(false);
                    }
                  }}
                >
                  {savingRM ? "Saving..." : "Save"}
                </Button>
              </div>
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
      <BatchEditRMDialog
        open={showBatchEditRM}
        onClose={() => setShowBatchEditRM(false)}
        rawMaterials={liveRawMaterials}
        itemGroups={RM_ITEM_GROUPS}
        onSaved={(updated) => {
          setLiveRawMaterials(updated);
          invalidateCachePrefix("/api/raw-materials");
          invalidateCachePrefix("/api/inventory");
        }}
      />
    </div>
  );
}

// ---------- Batch Edit Raw Materials Dialog ----------
//
// Mirrors the BOM Batch Edit Categories UX: per-row inline editing for
// the bulk-friendly fields (Item Group, Base UOM, Active) + multi-select
// checkboxes + a "Bulk fill -> N -> [field/value]" helper for the "set
// 100 to one value" path. Saves via PUT /api/raw-materials/:id one
// request per dirty row; the page's RawMaterials state is patched
// in-place on success so a refetch isn't required.

const RM_UOM_OPTIONS = ["PCS", "MTR", "ROLL", "BOX", "CTN", "SET", "KG", "PAIR"];

type RMEdit = {
  itemCode?: string;
  description?: string;
  itemGroup?: string;
  baseUOM?: string;
  isActive?: boolean;
};

function BatchEditRMDialog({
  open,
  onClose,
  rawMaterials,
  itemGroups,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  rawMaterials: RawMaterial[];
  itemGroups: string[];
  onSaved: (next: RawMaterial[]) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("ALL");
  const [activeFilter, setActiveFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  // pendingByRm[id] = { itemGroup?, baseUOM?, isActive? }. Only edited
  // fields are present; missing fields fall back to the row's current
  // value when rendering / saving.
  const [pendingByRm, setPendingByRm] = useState<Map<string, RMEdit>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState<"itemGroup" | "baseUOM" | "isActive">("itemGroup");
  const [bulkValue, setBulkValue] = useState("");
  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setGroupFilter("ALL");
    setActiveFilter("ALL");
    setPendingByRm(new Map());
    setSelectedIds(new Set());
    setBulkField("itemGroup");
    setBulkValue("");
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const filtered = useMemo(() => {
    return rawMaterials.filter((r) => {
      if (groupFilter !== "ALL" && r.itemGroup !== groupFilter) return false;
      if (activeFilter === "ACTIVE" && !r.isActive) return false;
      if (activeFilter === "INACTIVE" && r.isActive) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!r.itemCode.toLowerCase().includes(q) && !r.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rawMaterials, search, groupFilter, activeFilter]);

  function getEffective(r: RawMaterial): {
    itemCode: string;
    description: string;
    itemGroup: string;
    baseUOM: string;
    isActive: boolean;
  } {
    const p = pendingByRm.get(r.id);
    return {
      itemCode: p?.itemCode ?? r.itemCode,
      description: p?.description ?? r.description,
      itemGroup: p?.itemGroup ?? r.itemGroup,
      baseUOM: p?.baseUOM ?? r.baseUOM,
      isActive: p?.isActive ?? r.isActive,
    };
  }

  function setField(id: string, field: keyof RMEdit, value: string | boolean) {
    const r = rawMaterials.find((rm) => rm.id === id);
    if (!r) return;
    setPendingByRm((prev) => {
      const next = new Map(prev);
      const cur = { ...(next.get(id) ?? {}) };
      // If the new value matches the row's current value, drop the
      // override; that way the dirty count stays honest.
      const original =
        field === "itemCode" ? r.itemCode :
        field === "description" ? r.description :
        field === "itemGroup" ? r.itemGroup :
        field === "baseUOM" ? r.baseUOM :
        r.isActive;
      if (value === original) {
        delete cur[field];
      } else {
        (cur as Record<string, unknown>)[field] = value;
      }
      if (Object.keys(cur).length === 0) next.delete(id);
      else next.set(id, cur);
      return next;
    });
  }

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));
  function toggleAllFiltered() {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of filtered) next.delete(r.id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of filtered) next.add(r.id);
        return next;
      });
    }
  }
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleBulkFill() {
    if (bulkField !== "isActive" && !bulkValue) {
      toast.warning("Pick a value first.");
      return;
    }
    const targets = selectedIds.size > 0
      ? filtered.filter((r) => selectedIds.has(r.id))
      : filtered;
    if (targets.length === 0) {
      toast.warning("No rows to apply to.");
      return;
    }
    const value: string | boolean =
      bulkField === "isActive" ? bulkValue === "true" : bulkValue;
    let touched = 0;
    setPendingByRm((prev) => {
      const next = new Map(prev);
      for (const r of targets) {
        const original =
          bulkField === "itemGroup" ? r.itemGroup :
          bulkField === "baseUOM" ? r.baseUOM :
          r.isActive;
        const cur = { ...(next.get(r.id) ?? {}) };
        if (value === original) {
          delete cur[bulkField];
        } else {
          (cur as Record<string, unknown>)[bulkField] = value;
          touched++;
        }
        if (Object.keys(cur).length === 0) next.delete(r.id);
        else next.set(r.id, cur);
      }
      return next;
    });
    const scope = selectedIds.size > 0 ? `${selectedIds.size} selected` : `${targets.length} visible`;
    toast.success(`Queued ${touched}/${targets.length} (${scope}). Click Save to commit.`);
  }

  async function handleSave() {
    if (pendingByRm.size === 0) {
      toast.warning("No changes to save.");
      return;
    }
    setSaving(true);
    const failures: string[] = [];
    const successes = new Map<string, RawMaterial>();
    try {
      for (const [id, edit] of pendingByRm.entries()) {
        const r = rawMaterials.find((rm) => rm.id === id);
        if (!r) continue;
        const body = {
          itemCode: (edit.itemCode ?? r.itemCode).trim(),
          description: (edit.description ?? r.description).trim(),
          baseUOM: edit.baseUOM ?? r.baseUOM,
          itemGroup: edit.itemGroup ?? r.itemGroup,
          balanceQty: r.balanceQty,
          isActive: edit.isActive ?? r.isActive,
        };
        try {
          const res = await fetch(`/api/raw-materials/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const json = (await res.json().catch(() => null)) as
            | { success?: boolean; data?: RawMaterial; error?: string }
            | null;
          if (!res.ok || !json?.success) {
            failures.push(r.itemCode);
            continue;
          }
          successes.set(id, json.data ?? { ...r, ...body });
        } catch {
          failures.push(r.itemCode);
        }
      }
      if (successes.size > 0) {
        const next = rawMaterials.map((r) => successes.get(r.id) ?? r);
        onSaved(next);
      }
      if (failures.length > 0) {
        toast.warning(
          `Saved ${successes.size}; ${failures.length} failed: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "..." : ""}`,
        );
      } else {
        toast.success(`Saved ${successes.size} raw material${successes.size !== 1 ? "s" : ""}.`);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-[1080px] max-w-[97vw] max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-bold text-[#111827]">Batch Edit Raw Materials</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Inline edit Item Group / UOM / Active per row, or use Bulk fill to set many at once.
          </p>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3">
          {/* Filters */}
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-700 mb-1">Search</label>
              <input
                type="text"
                placeholder="Filter by code / description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full border border-[#E2DDD8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#6B5C32]"
              />
            </div>
            <div className="w-44">
              <label className="block text-xs font-medium text-gray-700 mb-1">Item Group</label>
              <select
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                className="w-full border border-[#E2DDD8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#6B5C32]"
              >
                <option value="ALL">All Groups</option>
                {itemGroups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div className="w-36">
              <label className="block text-xs font-medium text-gray-700 mb-1">Status</label>
              <select
                value={activeFilter}
                onChange={(e) => setActiveFilter(e.target.value as "ALL" | "ACTIVE" | "INACTIVE")}
                className="w-full border border-[#E2DDD8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#6B5C32]"
              >
                <option value="ALL">All</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
          </div>

          {/* Bulk fill */}
          <div className="flex items-end gap-3 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Bulk fill: {selectedIds.size > 0 ? `${selectedIds.size} selected` : `all ${filtered.length} visible`} -&gt; ...
              </label>
              <div className="flex gap-2">
                <select
                  value={bulkField}
                  onChange={(e) => { setBulkField(e.target.value as "itemGroup" | "baseUOM" | "isActive"); setBulkValue(""); }}
                  className="w-32 border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-[#6B5C32]"
                >
                  <option value="itemGroup">Item Group</option>
                  <option value="baseUOM">Base UOM</option>
                  <option value="isActive">Active</option>
                </select>
                {bulkField === "itemGroup" && (
                  <select
                    value={bulkValue}
                    onChange={(e) => setBulkValue(e.target.value)}
                    className="flex-1 border border-[#E2DDD8] rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-[#6B5C32]"
                  >
                    <option value="">Pick group...</option>
                    {itemGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                )}
                {bulkField === "baseUOM" && (
                  <select
                    value={bulkValue}
                    onChange={(e) => setBulkValue(e.target.value)}
                    className="flex-1 border border-[#E2DDD8] rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-[#6B5C32]"
                  >
                    <option value="">Pick UOM...</option>
                    {RM_UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                )}
                {bulkField === "isActive" && (
                  <select
                    value={bulkValue}
                    onChange={(e) => setBulkValue(e.target.value)}
                    className="flex-1 border border-[#E2DDD8] rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-[#6B5C32]"
                  >
                    <option value="">Pick status...</option>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                )}
                <button
                  onClick={handleBulkFill}
                  disabled={bulkField !== "isActive" && !bulkValue}
                  className="px-3 py-1.5 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  Fill
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs pb-1">
              <button
                onClick={toggleAllFiltered}
                className="text-[#6B5C32] hover:underline font-medium whitespace-nowrap"
              >
                {allFilteredSelected ? `Deselect All ${filtered.length}` : `Select All ${filtered.length}`}
              </button>
              {selectedIds.size > 0 && (
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-[#9A3A2D] hover:underline whitespace-nowrap"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Header summary */}
          <div className="text-xs text-gray-500">
            {pendingByRm.size} dirty - {selectedIds.size} selected - Showing {filtered.length} of {rawMaterials.length}
          </div>

          {/* Table */}
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <div className="max-h-[55vh] overflow-y-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FAF9F7] sticky top-0 z-10">
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                    <th className="px-3 py-2 font-medium w-8">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleAllFiltered}
                        className="rounded border-gray-300 text-[#6B5C32] focus:ring-[#6B5C32]"
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">Item Code</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium w-40">Item Group</th>
                    <th className="px-3 py-2 font-medium w-28">UOM</th>
                    <th className="px-3 py-2 font-medium w-24 text-center">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                        No raw materials match the current filters.
                      </td>
                    </tr>
                  )}
                  {filtered.map((r) => {
                    const eff = getEffective(r);
                    const dirty = pendingByRm.has(r.id);
                    const isSelected = selectedIds.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        className={`border-t border-[#E2DDD8] ${
                          dirty ? "bg-[#EEF3E4]" : isSelected ? "bg-[#FAEFCB]/60" : "hover:bg-[#FAF9F7]"
                        }`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(r.id)}
                            className="rounded border-gray-300 text-[#6B5C32] focus:ring-[#6B5C32]"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={eff.itemCode}
                            onChange={(e) => setField(r.id, "itemCode", e.target.value)}
                            className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:border-[#6B5C32] bg-white font-medium ${
                              pendingByRm.get(r.id)?.itemCode !== undefined ? "border-[#4F7C3A] font-semibold text-[#4F7C3A]" : "border-[#E2DDD8] text-[#111827]"
                            }`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={eff.description}
                            onChange={(e) => setField(r.id, "description", e.target.value)}
                            className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:border-[#6B5C32] bg-white ${
                              pendingByRm.get(r.id)?.description !== undefined ? "border-[#4F7C3A] font-semibold text-[#4F7C3A]" : "border-[#E2DDD8] text-gray-600"
                            }`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={eff.itemGroup}
                            onChange={(e) => setField(r.id, "itemGroup", e.target.value)}
                            className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:border-[#6B5C32] bg-white ${
                              pendingByRm.get(r.id)?.itemGroup !== undefined ? "border-[#4F7C3A] font-semibold text-[#4F7C3A]" : "border-[#E2DDD8]"
                            }`}
                          >
                            {!itemGroups.includes(eff.itemGroup) && eff.itemGroup && (
                              <option value={eff.itemGroup}>{eff.itemGroup}</option>
                            )}
                            {itemGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={eff.baseUOM}
                            onChange={(e) => setField(r.id, "baseUOM", e.target.value)}
                            className={`w-full text-xs px-2 py-1 rounded border focus:outline-none focus:border-[#6B5C32] bg-white ${
                              pendingByRm.get(r.id)?.baseUOM !== undefined ? "border-[#4F7C3A] font-semibold text-[#4F7C3A]" : "border-[#E2DDD8]"
                            }`}
                          >
                            {!RM_UOM_OPTIONS.includes(eff.baseUOM) && eff.baseUOM && (
                              <option value={eff.baseUOM}>{eff.baseUOM}</option>
                            )}
                            {RM_UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={eff.isActive}
                            onChange={(e) => setField(r.id, "isActive", e.target.checked)}
                            className={`rounded border-gray-300 focus:ring-[#6B5C32] ${
                              pendingByRm.get(r.id)?.isActive !== undefined ? "ring-2 ring-[#4F7C3A] text-[#4F7C3A]" : "text-[#6B5C32]"
                            }`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {pendingByRm.size > 0
              ? `Will save ${pendingByRm.size} row${pendingByRm.size !== 1 ? "s" : ""}`
              : "Click each cell to edit, or use Bulk fill above."}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={pendingByRm.size === 0 || saving}
              className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : `Save ${pendingByRm.size} Change${pendingByRm.size !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
