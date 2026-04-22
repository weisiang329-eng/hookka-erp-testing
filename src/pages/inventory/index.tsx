import { useState, useMemo, useEffect } from "react";
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
import { products, rawMaterials, productionOrders, rmBatches, fgBatches, type Product, type RawMaterial } from "@/lib/mock-data";
import type { RMBatch, FGBatch } from "@/types";
import {
  weightedAvgCostSen, totalBatchValueSen, totalRemainingQty,
  laborRateForDate,
} from "@/lib/costing";
import { getRawMaterialStock } from "@/lib/material-lookup";
import {
  SUCCESS, NEUTRAL,
  INVENTORY_TYPE_COLOR,
  getStockSemantic, getWipAgeSemantic,
} from "@/lib/design-tokens";

// -- FIFO cost column helpers ----------------------------------------------
// These read from the module-scope `rmBatches`/`fgBatches` arrays populated
// by GRN receipts and PO completions.
function batchesForRM(rmId: string): RMBatch[] {
  return rmBatches.filter((b) => b.rmId === rmId);
}

/** Return all FG layers for a product (oldest-first). */
function batchesForProduct(productId: string): FGBatch[] {
  return fgBatches
    .filter((b) => b.productId === productId)
    .sort((a, b) => a.completedDate.localeCompare(b.completedDate));
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

function oldestRMAgeDays(rmId: string): number {
  return oldestBatchAgeDays(
    batchesForRM(rmId),
    (b: RMBatch) => b.receivedDate,
  );
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

/**
 * Estimated per-unit BOM material cost for a product, using the current
 * weighted-average RM batch prices. Mirrors the BOM→RM resolution used in
 * `postProductionOrderCompletion` but averages (rather than FIFO-slicing)
 * since nothing is actually being consumed — this is a display-only
 * estimate for WIP cost. Returns 0 if the product has no BOM or no RMs
 * with priced batches could be matched.
 */
function bomMaterialCostPerUnitSen(product: Product | undefined): number {
  if (!product?.bomComponents?.length) return 0;
  let totalSen = 0;
  for (const bom of product.bomComponents) {
    const perUnit = Number(bom.qtyPerUnit) || 0;
    if (perUnit <= 0) continue;
    const waste = Math.max(0, Number(bom.wastePct) || 0) / 100;
    const qtyWithWaste = perUnit * (1 + waste);

    // Preferred RM set: exact match on name/code, else full category group.
    const categoryMatches = getRawMaterialStock(bom.materialCategory).items;
    const exact = categoryMatches.find(
      (rm) =>
        rm.description === bom.materialName || rm.itemCode === bom.materialName,
    );
    const rmPool = exact ? [exact] : categoryMatches;
    if (rmPool.length === 0) continue;

    // Weighted avg across the entire pool's active batches.
    const poolBatches = rmPool.flatMap((rm) => batchesForRM(rm.id));
    const avgUnitCost = weightedAvgCostSen(poolBatches);
    if (avgUnitCost <= 0) continue;

    totalSen += qtyWithWaste * avgUnitCost;
  }
  return totalSen;
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

// --- Finished Products with mock stock ---
type FGItem = Product & { stockQty: number };

// --- WIP ---
// WIP items are derived from production orders, grouped by WIP code.
// Same WIP code = one row, qty summed. Double-click to see all SO IDs.
type WIPSource = {
  poCode: string;
  quantity: number;
  completedDate: string;
  ageDays: number;
};
type WIPItem = {
  id: string;
  wipCode: string;      // e.g. "1013-(Q) -HB 20" (WD)"
  wipType: string;      // e.g. "Divan", "Headboard", "Base", "Cushion"
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
};

// --- Create FG form ---
type CreateFGForm = {
  code: string;
  name: string;
  category: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
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
function deriveFGStock(): FGItem[] {
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
const fgItems: FGItem[] = deriveFGStock();

// WIP type labels from wipKey codes
const WIP_TYPE_LABELS: Record<string, string> = {
  FG: "Finished Good",
  DIVAN: "Divan",
  HEADBOARD: "Headboard",
  SOFA_BASE: "Base",
  SOFA_CUSHION: "Cushion",
  SOFA_ARMREST: "Armrest",
  SOFA_HEADREST: "Headrest",
};

// Derive WIP items from production orders.
// For each WIP group (by wipKey), walk through the dept sequence.
// A completed dept whose NEXT dept is NOT completed = stock sits here.
// This way we see WIP at every department stage, not just the last one.
function deriveWIPFromPO(orders: typeof productionOrders): WIPItem[] {
  const today = new Date();
  // Today's labor rate — applied to work-done-so-far. Using today's (rather
  // than each completion date's) rate is an approximation; the WIP row is
  // an estimate anyway and the rate only floats month-to-month.
  const todayLaborRatePerMinSen = laborRateForDate(today);

  // First pass: collect raw WIP entries
  type RawEntry = {
    wipCode: string; wipType: string; relatedProduct: string;
    completedBy: string; poCode: string; quantity: number;
    completedDate: string; ageDays: number;
    // Cost per this source emission (already × qty)
    estValueSen: number;  // doneMinsInGroup × (BOM/totalPOMins + rate) × qty
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
        const wipCodeStr = card.wipLabel || card.wipCode || WIP_TYPE_LABELS[wipKey] || wipKey;
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
          wipType: WIP_TYPE_LABELS[wipKey] || wipKey,
          relatedProduct: po.productCode,
          completedBy: card.departmentCode,
          poCode: po.poNo,
          quantity: qty,
          completedDate,
          ageDays,
          estValueSen: unitCostSen * qty,
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
      completedDate: r.completedDate,
      ageDays: r.ageDays,
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

// Unique itemGroups for RM filter
const RM_ITEM_GROUPS = Array.from(new Set(rawMaterials.map(r => r.itemGroup))).sort();

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
    key: "wipType",
    label: "Type",
    render: (_v, row) => {
      const sem = INVENTORY_TYPE_COLOR[row.wipType] ?? NEUTRAL;
      return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${sem.bg} ${sem.text} ${sem.border}`}>{row.wipType}</span>;
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
    render: (_v, row) => <span className="font-medium text-[#1F1D1B]">{row.totalQty}</span>,
  },
  {
    key: "sources",
    label: "POs",
    align: "right",
    render: (_v, row) => <span className="text-sm text-[#6B7280]">{row.sources.length}</span>,
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

  const [rmSearch, setRmSearch] = useState("");
  const [rmCategoryFilter, setRmCategoryFilter] = useState<string>("ALL");

  // Create FG modal
  const [showCreateFG, setShowCreateFG] = useState(false);
  const [fgForm, setFgForm] = useState<CreateFGForm>({ code: "", name: "", category: "BEDFRAME", baseModel: "", sizeCode: "", sizeLabel: "" });

  // Create RM modal
  const [showCreateRM, setShowCreateRM] = useState(false);
  const [rmForm, setRmForm] = useState<CreateRMForm>({ itemCode: "", description: "", baseUOM: "PCS", itemGroup: "PLYWOOD", balanceQty: 0 });

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
  }, [fgSearch, fgCategoryFilter]);

  // Fetch production orders from API (includes persisted overrides)
  const [poData, setPoData] = useState(productionOrders);
  useEffect(() => {
    fetch("/api/production-orders")
      .then(r => r.json())
      .then(d => { if (d.success && d.data) setPoData(d.data); })
      .catch(() => {});
  }, []);
  const wipItems = useMemo(() => deriveWIPFromPO(poData), [poData]);

  const filteredWIP = useMemo(() => {
    let data = wipItems;
    if (wipSearch.trim()) {
      const q = wipSearch.toLowerCase();
      data = data.filter(d => d.wipCode.toLowerCase().includes(q) || d.relatedProduct.toLowerCase().includes(q) || d.wipType.toLowerCase().includes(q) || d.sources.some(s => s.poCode.toLowerCase().includes(q)));
    }
    return data;
  }, [wipItems, wipSearch]);

  const filteredRM = useMemo(() => {
    let data = rawMaterials;
    if (rmCategoryFilter !== "ALL") {
      data = data.filter(d => d.itemGroup === rmCategoryFilter);
    }
    if (rmSearch.trim()) {
      const q = rmSearch.toLowerCase();
      data = data.filter(d => d.itemCode.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
    }
    return data;
  }, [rmSearch, rmCategoryFilter]);

  // ---- KPIs ----
  const fgBedframeCount = fgItems.filter(p => p.category === "BEDFRAME").length;
  const fgSofaCount = fgItems.filter(p => p.category === "SOFA").length;
  const fgTotalStock = fgItems.reduce((s, p) => s + p.stockQty, 0);

  const wipTotalQty = wipItems.reduce((s, w) => s + w.totalQty, 0);
  const wipOldest = wipItems.length > 0 ? Math.max(...wipItems.map(w => w.oldestAgeDays)) : 0;
  const wipOver7Days = wipItems.filter(w => w.oldestAgeDays > 7).length;

  const rmCategoriesCount = RM_ITEM_GROUPS.length;
  const rmLowStock = rawMaterials.filter(r => r.balanceQty > 0 && r.balanceQty < 5).length;
  const rmZeroStock = rawMaterials.filter(r => r.balanceQty === 0).length;

  const contextMenu = inventoryContextMenu(toast.info);

  // Edit FG dialog state
  const [editFG, setEditFG] = useState<FGItem | null>(null);
  const [editFGForm, setEditFGForm] = useState({ costPriceSen: 0, stockQty: 0, unitM3: 0, fabricUsage: 0, productionTimeMinutes: 0 });

  const handleDoubleClickFG = (row: FGItem) => {
    setEditFG(row);
    setEditFGForm({
      costPriceSen: row.costPriceSen,
      stockQty: row.stockQty,
      unitM3: row.unitM3,
      fabricUsage: row.fabricUsage,
      productionTimeMinutes: row.productionTimeMinutes,
    });
  };
  const [wipDetail, setWipDetail] = useState<WIPItem | null>(null);
  const handleDoubleClickWIP = (row: WIPItem) => { setWipDetail(row); };

  // Edit RM dialog state
  const [editRM, setEditRM] = useState<RawMaterial | null>(null);
  const [editRMForm, setEditRMForm] = useState({ description: "", baseUOM: "", itemGroup: "", balanceQty: 0 });

  const handleDoubleClickRM = (row: RawMaterial) => {
    setEditRM(row);
    setEditRMForm({
      description: row.description,
      baseUOM: row.baseUOM,
      itemGroup: row.itemGroup,
      balanceQty: row.balanceQty,
    });
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

  // Import handlers — these mutate the in-memory arrays. Paired with
  // the existing toast pattern so the user gets feedback. TODO: also
  // call a persistence hook once Step 1 JSON persistence lands so
  // imported rows survive dev-server restart.
  const handleImportFG = (rows: Record<string, unknown>[]) => {
    let created = 0, updated = 0;
    for (const row of rows) {
      const code = String(row.code || "").trim();
      if (!code) continue;
      const basePriceSen = Math.round(Number(row.basePriceSen || 0) * 100);
      const costPriceSen = Math.round(Number(row.costPriceSen || 0) * 100);

      const existing = products.find(p => p.code === code);
      if (existing) {
        existing.name = String(row.name || existing.name);
        existing.category = String(row.category || existing.category) as Product["category"];
        existing.baseModel = String(row.baseModel || existing.baseModel);
        existing.sizeCode = String(row.sizeCode || existing.sizeCode);
        existing.sizeLabel = String(row.sizeLabel || existing.sizeLabel);
        if (row.basePriceSen) existing.basePriceSen = basePriceSen;
        if (row.costPriceSen) existing.costPriceSen = costPriceSen;
        if (row.fabricUsage) existing.fabricUsage = Number(row.fabricUsage);
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
        products.push(newProduct);
        created++;
      }
    }
    toast.success(`Imported: ${created} created, ${updated} updated`);
    return { created, updated };
  };

  const handleImportRM = (rows: Record<string, unknown>[]) => {
    let created = 0, updated = 0;
    for (const row of rows) {
      const itemCode = String(row.itemCode || "").trim();
      if (!itemCode) continue;

      const existing = rawMaterials.find(r => r.itemCode === itemCode);
      if (existing) {
        existing.description = String(row.description || existing.description);
        existing.baseUOM = String(row.baseUOM || existing.baseUOM);
        existing.itemGroup = String(row.itemGroup || existing.itemGroup);
        if (row.balanceQty !== undefined && row.balanceQty !== "") {
          existing.balanceQty = Number(row.balanceQty);
        }
        if (row.isActive !== undefined && row.isActive !== "") {
          existing.isActive = Boolean(row.isActive);
        }
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
        rawMaterials.push(newRM);
        created++;
      }
    }
    toast.success(`Imported: ${created} created, ${updated} updated`);
    return { created, updated };
  };

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
              {["ALL", "BEDFRAME", "SOFA"].map(cat => (
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
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" size="sm" onClick={() => setShowCreateFG(false)}>Cancel</Button>
                  <Button variant="primary" size="sm" disabled={!fgForm.code || !fgForm.name} onClick={() => { toast.success("Product created: " + fgForm.code); setShowCreateFG(false); setFgForm({ code: "", name: "", category: "BEDFRAME", baseModel: "", sizeCode: "", sizeLabel: "" }); }}>
                    Save Product
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

          {/* Search only — no filter buttons */}
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

          {/* DataGrid */}
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
              <p className="text-xl font-bold text-[#1F1D1B]">{rawMaterials.length}</p>
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
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-lg font-bold text-[#111827]">{editRM.itemCode}</h2>
                <p className="text-xs text-gray-500">{editRM.description}</p>
              </div>
              <button onClick={() => setEditRM(null)} className="p-1 rounded hover:bg-gray-100">
                <X className="h-4 w-4 text-gray-400" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
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
        isExistingKey={(key) => rawMaterials.some((r) => r.itemCode === key)}
        onImport={handleImportRM}
        currentRows={rawMaterials.map((r) => ({
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
