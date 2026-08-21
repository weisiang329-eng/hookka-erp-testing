import { useState, useEffect, useMemo, useCallback, useRef, Fragment, type ReactNode } from "react";
import { usePermissions } from "@/lib/use-permission";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cachedFetchJson, invalidateCachePrefix, useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MoneyInput } from "@/components/ui/money-input";
import { Link, useSearchParams } from "react-router-dom";
import { formatCurrency } from "@/lib/utils";
import { isSetupField, SETUP_FIELD_LABEL, type SetupField } from "@/lib/kpi-drill";
import { Plus, Trash2, Check, Calendar, History, Pencil, FileDown, Loader2, X as XIcon } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { ProductSchema } from "@/lib/schemas/product";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { useNavGuard } from "@/lib/use-nav-guard";
import { familyOf } from "@/lib/product-family";
import { MasterPriceHistoryDialog } from "./MasterPriceHistoryDialog";
import {
  EffectiveDateConfirmModal,
  MaintenanceConfigHistoryDialog,
  MaintenanceConfigSaveModal,
  type MaintenanceHistoryRow,
} from "./MaintenanceConfigHistoryDialog";
import {
  MaintenanceItemHistoryDialog,
  type PricedItemKey,
} from "./MaintenanceItemHistoryDialog";
import { CncTemplatePanel } from "@/components/cnc/CncTemplatePanel";
import { ProductCatalog } from "@/pages/products/catalog";

// Derive the bare product code for the CNC template lookup. SKU codes look
// like "1013-(K)" / "1013 King" — the cutting templates are keyed by the
// leading code token (e.g. "1013"), so strip the variant suffix at the first
// space or "-(".
function baseProductCode(code: string): string {
  const raw = String(code ?? "").trim();
  if (!raw) return raw;
  return raw.split(/\s|-\(/)[0].trim();
}

// Keys whose entries carry a priceSen field (and therefore have a
// per-row history dialog). Non-priced keys like gaps / sofaSizes don't
// surface the calendar icon. Mirrors PricedItemKey in
// MaintenanceItemHistoryDialog.tsx.
const PRICED_ITEM_KEYS: readonly PricedItemKey[] = [
  "divanHeights",
  "legHeights",
  "totalHeights",
  "specials",
  "sofaLegHeights",
  "sofaSpecials",
];
const isPricedItemKey = (k: string): k is PricedItemKey =>
  (PRICED_ITEM_KEYS as readonly string[]).includes(k);

const ProductMutationSchema = mutationWithData(ProductSchema);
import {
  fetchVariantsConfig,
  getVariantsConfigSync,
  patchVariantsConfig,
  subscribeKvConfig,
  flushKvConfig,
  VARIANTS_CONFIG_KEY,
  type VariantsConfig,
} from "@/lib/kv-config";
import {
  DEFAULT_BEDFRAME_SIZES,
  DEFAULT_SOFA_COMPARTMENTS,
  type BedframeSize,
} from "@/lib/fg-variants";
import { optionPacksSeparately } from "@/lib/leg-packing";
// One money parser. NOTE: Unit M3 and Fabric Usage on this page are NOT money
// (cubic metres / metres) and deliberately keep `parseFloat`.
import { moneyFieldToSen } from "@/lib/money-field";
import { FALLBACK_SOFA_SEAT_HEIGHTS } from "@/lib/sofa-seat-heights";

// ---------- Types matching mock-data ----------
// Sofa fabric price tier — values mirror fabric_tracking.priceTier verbatim
// so a sofa line in CS Order resolves its price with a direct lookup
// (fabric.priceTier === entry.tier) instead of a string-mapping detour.
// UI buttons render as "P1" / "P2" / "P3" — that's a display label, not the
// data shape. P3 was added in migration 0067 alongside this matrix work.
type SofaTier = "PRICE_1" | "PRICE_2" | "PRICE_3";
const SOFA_TIERS: { value: SofaTier; label: string }[] = [
  { value: "PRICE_1", label: "P1" },
  { value: "PRICE_2", label: "P2" },
  { value: "PRICE_3", label: "P3" },
];

// Legacy entries without a tier field were stored as the company's default
// (Price 2) before the matrix existed. Pin the default here so the read path
// stays in one place — every height/tier comparison runs through this helper.
const entryTier = (t: SofaTier | undefined): SofaTier => t ?? "PRICE_2";

// Fabric roll width by product category, shown next to the Fabric (m) cell as
// display-only context so the operator knows which width the meters assume.
// Bedframe fabric comes off a 142cm roll; sofa fabric off a 149cm roll.
// Other categories have no fixed width, so no hint is shown. Not stored.
const fabricWidthHint = (category: string): string | null =>
  category === "BEDFRAME" ? "142cm" : category === "SOFA" ? "149cm" : null;

// ---------- Labor cost basis (owner: flat average salary) ----------
// Per-product labor cost uses the SAME costing basis as the production-cost
// engine in src/api/lib/po-cost-cascade.ts (postJobCardLabor) /
// src/lib/labor-engine.ts (productionCostRatePerMinuteSen):
//   rate = basic salary ÷ working_days ÷ hours_per_day ÷ 60
// The engine's default worker is RM 2050 / 26 days / 9 h. Per the owner's
// instruction this Products-page comparison instead uses a FLAT average
// salary of RM 2,200/month with the same 26-working-day / 9-hour divisors:
//   RM 2200 / 26 / 9 / 60 ≈ RM 0.156695 per minute.
// Expressed in SEN per minute (220000 sen ÷ 26 ÷ 9 ÷ 60 ≈ 15.6695 sen/min)
// so it composes directly with formatCurrency(), which takes sen. This is a
// display-only estimate — it does NOT feed cost_ledger or any cascade; the
// real posted labor still costs at each attributed worker's own rate.
const LABOR_AVG_SALARY_SEN = 220_000; // RM 2,200 / month (flat average)
const LABOR_WORKING_DAYS = 26;
const LABOR_HOURS_PER_DAY = 9;
const LABOR_RATE_PER_MIN_SEN =
  LABOR_AVG_SALARY_SEN / LABOR_WORKING_DAYS / LABOR_HOURS_PER_DAY / 60; // ≈ 15.6695 sen/min

// Labor cost (in sen) for a product given its total production minutes.
// Rounded to whole sen to match how money is stored/rendered elsewhere.
// Returns 0 when minutes are missing/zero so callers can show "—".
function laborCostSenForMinutes(totalMinutes: number): number {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return 0;
  return Math.round(totalMinutes * LABOR_RATE_PER_MIN_SEN);
}

// Optional analytic columns the owner can show/hide via the catalog "Columns"
// chooser: estimated Labor cost, Margin (price − labor) and Labor-as-% of each
// selling price. Kept as one data list so the header cells, the body cells and
// the chooser checkboxes all iterate the same single source of truth. The
// margin/labour columns compare against:
//   BEDFRAME  → Price 2 (basePriceSen) for the "P2" column, Price 1 for "P1"
//   ACCESSORY → Base Price (basePriceSen)
//   SOFA      → the lowest positive seat-height price in the selected tier
type ProdCat = "SOFA" | "ACCESSORY" | "BEDFRAME";
type AnalyticCol = {
  key: string;
  width: string; // grid track appended to gridTemplateColumns when visible
  defaultOn: boolean;
  applies: (cat: ProdCat) => boolean;
  label: (cat: ProdCat) => string;
};
const ANALYTIC_COLS: AnalyticCol[] = [
  {
    key: "labor",
    width: "minmax(100px,0.95fr)",
    defaultOn: true,
    applies: () => true,
    label: () => "Labor (est.)",
  },
  {
    key: "marginP2",
    width: "minmax(120px,1.15fr)",
    defaultOn: true,
    applies: () => true,
    label: (c) =>
      c === "SOFA" ? "Margin (tier)" : c === "ACCESSORY" ? "Margin (Base)" : "Margin (P2)",
  },
  {
    key: "laborPctP2",
    width: "minmax(90px,0.85fr)",
    defaultOn: true,
    applies: () => true,
    label: (c) =>
      c === "SOFA" ? "Labor % (tier)" : c === "ACCESSORY" ? "Labor % (Base)" : "Labor % (P2)",
  },
  {
    key: "marginP1",
    width: "minmax(120px,1.15fr)",
    defaultOn: false,
    applies: (c) => c === "BEDFRAME",
    label: () => "Margin (P1)",
  },
  {
    key: "laborPctP1",
    width: "minmax(90px,0.85fr)",
    defaultOn: false,
    applies: (c) => c === "BEDFRAME",
    label: () => "Labor % (P1)",
  },
];

// ── Base (non-analytic) column registry ────────────────────────────────────
// The SKU Master table historically hard-coded three positional column
// layouts (sofa / accessory / bedframe). To let the owner show/hide ANY
// column — not just the analytic ones — every base column is described here as
// a single source of truth: the grid track width, the header label + align,
// and whether it can be hidden. The header iterates this list, the body cells
// gate on colOn(key), and gridTemplateColumns is built from the visible subset
// — so a hidden column drops its header cell, its body cell, AND its grid
// track in lockstep (no misaligned rows). `frozen` marks the sticky Code
// column, which is always visible and pinned left. Widths keep the original
// minmax() floors so a column never crushes below its min.
type BaseColAlign = "left" | "right" | "center";
type BaseCol = {
  key: string;
  label: string;
  width: string; // grid track (minmax) when visible
  align: BaseColAlign;
  frozen?: boolean; // Code column — always on, sticky-left
  alwaysOn?: boolean; // cannot be hidden via the chooser
};
// Sofa seat-price columns are DYNAMIC: one per Maintenance "Sizes" entry
// (kv variants-config `sofaSizes` — the same list the Create-SO seat dropdown
// reads), numerically sorted. A size added in Maintenance (e.g. 20") gets its
// price column here without a code change (BUG-2026-07-27-001 follow-up).
// BEDFRAME / ACCESSORY column sets stay static.
const SOFA_HEIGHT_COL = (n: string): BaseCol => ({
  key: `h${n}`,
  label: `${n}"`,
  width: "minmax(95px,0.95fr)",
  align: "right",
});
const H_COL_RE = /^h(\d+(?:\.\d+)?)$/;
function buildBaseCols(sofaHeights: string[]): Record<ProdCat, BaseCol[]> {
  return {
    BEDFRAME: [
      { key: "code", label: "Product Code", width: "minmax(120px,1.3fr)", align: "left", frozen: true, alwaysOn: true },
      { key: "description", label: "Description", width: "minmax(160px,1.8fr)", align: "left" },
      { key: "category", label: "Category", width: "minmax(90px,0.8fr)", align: "left" },
      { key: "size", label: "Size", width: "minmax(90px,0.8fr)", align: "left" },
      { key: "price2", label: "Price 2", width: "minmax(100px,1fr)", align: "right" },
      { key: "price1", label: "Price 1", width: "minmax(100px,1fr)", align: "right" },
      { key: "unitM3", label: "Unit (m³)", width: "minmax(80px,0.7fr)", align: "right" },
      { key: "fabric", label: "Fabric (m)", width: "minmax(80px,0.7fr)", align: "right" },
      { key: "totalMin", label: "Total Min", width: "minmax(84px,0.9fr)", align: "right" },
      { key: "variants", label: "Variants", width: "minmax(84px,0.8fr)", align: "center" },
    ],
    SOFA: [
      { key: "code", label: "Product Code", width: "minmax(120px,1.3fr)", align: "left", frozen: true, alwaysOn: true },
      { key: "description", label: "Description", width: "minmax(150px,1.2fr)", align: "left" },
      { key: "model", label: "Model", width: "minmax(80px,0.55fr)", align: "left" },
      ...sofaHeights.map(SOFA_HEIGHT_COL),
      { key: "unitM3", label: "Unit (m³)", width: "minmax(72px,0.6fr)", align: "right" },
      { key: "fabric", label: "Fabric (m)", width: "minmax(72px,0.5fr)", align: "right" },
      { key: "totalMin", label: "Total Min", width: "minmax(84px,0.9fr)", align: "right" },
      { key: "variants", label: "Variants", width: "minmax(84px,0.7fr)", align: "center" },
    ],
    ACCESSORY: [
      { key: "code", label: "Product Code", width: "minmax(120px,1.3fr)", align: "left", frozen: true, alwaysOn: true },
      { key: "description", label: "Description", width: "minmax(180px,2.5fr)", align: "left" },
      { key: "basePrice", label: "Base Price", width: "minmax(100px,1fr)", align: "right" },
      { key: "unitM3", label: "Unit (m³)", width: "minmax(80px,0.7fr)", align: "right" },
      { key: "fabric", label: "Fabric (m)", width: "minmax(95px,1fr)", align: "right" },
    ],
  };
}
// Human labels for the column chooser, keyed by column key. Shared across
// categories so the chooser shows a clean name even where a category renders
// the column slightly differently (e.g. sofa height cells).
const BASE_COL_CHOOSER_LABEL: Record<string, string> = {
  description: "Description",
  category: "Category",
  size: "Size",
  model: "Model",
  price2: "Price 2",
  price1: "Price 1",
  basePrice: "Base Price",
  unitM3: "Unit (m³)",
  fabric: "Fabric (m)",
  totalMin: "Total Min",
  variants: "Variants",
};
// Chooser/header label for a base column. Dynamic sofa height keys (h20, h24…)
// aren't in the static map — derive their "Seat N"" label from the key.
function baseColChooserLabel(col: { key: string; label: string }): string {
  const m = H_COL_RE.exec(col.key);
  if (m) return `Seat ${m[1]}"`;
  return BASE_COL_CHOOSER_LABEL[col.key] ?? col.label;
}

type DeptWorkingTime = {
  departmentCode: string;
  minutes: number;
  category: string;
};

type Product = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
  fabricUsage: number;
  unitM3: number;
  status: string;
  costPriceSen: number;
  basePriceSen?: number;
  price1Sen?: number;
  // Sofa price matrix: each entry is one (height, fabric tier) cell. Legacy
  // entries without `tier` are treated as P2 so existing data keeps rendering
  // in the default tier view without a backfill.
  seatHeightPrices?: { height: string; priceSen: number; tier?: SofaTier }[];
  productionTimeMinutes: number;
  subAssemblies: string[];
  deptWorkingTimes: DeptWorkingTime[];
  // Set by /api/products when a future-dated row exists in product_prices.
  // Surfaced as a "Pending" badge next to the price columns so the operator
  // sees a scheduled change at a glance (countdown UI in MasterPriceHistoryDialog).
  hasPendingPriceChange?: boolean;
  pendingEffectiveFrom?: string;
  // Per-SKU default variant pre-fills. The Variant Maintenance dialog writes
  // here; /sales/create reads here when the operator picks this product to
  // pre-fill divan height / leg height / gap / specials / fabric on the line.
  // The line operator can still override after pre-fill.
  defaultVariants?: ProductDefaultVariants;
};

// Per-SKU default variant pre-fills. Bedframe and sofa products use
// disjoint subsets of these fields; accessories typically have none.
type ProductDefaultVariants = {
  fabricCode?: string;
  // Bedframe fields
  divanHeight?: string;
  legHeight?: string;
  gap?: string;
  // Sofa fields
  seatHeight?: string;
  // Shared (BF + SOFA) multi-select. Empty array = no defaults.
  specials?: string[];
};

// (Legacy ProductVariantConfig / VariantOption types were retired when
// per-SKU variant defaults moved to products.defaultVariants. The new
// shape — ProductDefaultVariants — lives next to the Product type above.)

type ProductDeptConfig = {
  productCode: string;
  unitM3: number;
  fabricUsage: number;
  price2Sen: number;
  fabCutCategory: string;
  fabCutMinutes: number;
  fabSewCategory: string;
  fabSewMinutes: number;
  foamCategory: string;
  foamMinutes: number;
  framingCategory: string;
  framingMinutes: number;
  upholsteryCategory: string;
  upholsteryMinutes: number;
  packingCategory: string;
  packingMinutes: number;
  subAssemblies: { code: string; name: string; quantity: number }[];
  heightsSubAssemblies: { code: string; name: string; quantity: number }[];
};

// ---------- Department colours (HOOKKA standard) ----------
const DEPT_COLORS: Record<string, string> = {
  FAB_CUT: "#3B82F6",
  FAB_SEW: "#6366F1",
  WOOD_CUT: "#F59E0B",
  FOAM: "#8B5CF6",
  FRAMING: "#F97316",
  WEBBING: "#10B981",
  UPHOLSTERY: "#F43F5E",
  PACKING: "#06B6D4",
};

// ---------- Category badge ----------
function CategoryBadge({ category, deptCode }: { category: string; deptCode: string }) {
  const color = DEPT_COLORS[deptCode] || "#6B7280";
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: `${color}18`, color, border: `1px solid ${color}40` }}
    >
      {category}
    </span>
  );
}

// ---------- Expandable Production Config ----------
function ProductionConfig({ config }: { config: ProductDeptConfig }) {
  const deptRows = [
    { code: "FAB_CUT", label: "Fabric Cutting", cat: config.fabCutCategory, min: config.fabCutMinutes },
    { code: "FAB_SEW", label: "Fabric Sewing", cat: config.fabSewCategory, min: config.fabSewMinutes },
    { code: "FOAM", label: "Foam Bonding", cat: config.foamCategory, min: config.foamMinutes },
    { code: "FRAMING", label: "Framing", cat: config.framingCategory, min: config.framingMinutes },
    { code: "UPHOLSTERY", label: "Upholstery", cat: config.upholsteryCategory, min: config.upholsteryMinutes },
    { code: "PACKING", label: "Packing", cat: config.packingCategory, min: config.packingMinutes },
  ];

  return (
    <div className="bg-[#F9FAFB] border border-[#E5E7EB] rounded-lg p-4 mt-2 space-y-4">
      {/* Department breakdown */}
      <div>
        <h4 className="text-sm font-semibold text-[#374151] mb-2">Department Estimates</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {deptRows.map((d) => (
            <div
              key={d.code}
              className="flex items-center justify-between rounded-md px-3 py-2 bg-white border border-[#E5E7EB]"
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: DEPT_COLORS[d.code] }}
                />
                <span className="text-xs text-[#6B7280]">{d.label}</span>
              </div>
              <div className="flex items-center gap-2">
                <CategoryBadge category={d.cat} deptCode={d.code} />
                <span className="text-xs font-medium text-[#111827]">{d.min} min</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Fabric usage */}
      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-[#6B7280]">Fabric Usage: </span>
          <span className="font-medium text-[#111827]">{config.fabricUsage} m</span>
        </div>
        <div>
          <span className="text-[#6B7280]">Unit M3: </span>
          <span className="font-medium text-[#111827]">{config.unitM3}</span>
        </div>
        <div>
          <span className="text-[#6B7280]">Price 2: </span>
          <span className="font-medium text-[#111827]">{formatCurrency(config.price2Sen)}</span>
        </div>
      </div>

      {/* Sub-assemblies */}
      {(config.subAssemblies.length > 0 || config.heightsSubAssemblies.length > 0) && (
        <div>
          <h4 className="text-sm font-semibold text-[#374151] mb-2">Sub-Assemblies</h4>
          <div className="space-y-1">
            {config.subAssemblies.map((sa) => (
              <div key={sa.code} className="flex items-center gap-3 text-sm bg-white rounded px-3 py-1.5 border border-[#E5E7EB]">
                <span className="text-[#6B7280] font-mono text-xs">{sa.code}</span>
                <span className="text-[#111827]">{sa.name}</span>
                <span className="ml-auto text-xs text-[#6B7280]">{sa.quantity} pcs</span>
              </div>
            ))}
            {config.heightsSubAssemblies.map((sa) => (
              <div key={sa.code} className="flex items-center gap-3 text-sm bg-white rounded px-3 py-1.5 border border-dashed border-[#D1D5DB]">
                <span className="text-[#6B7280] font-mono text-xs">{sa.code}</span>
                <span className="text-[#111827]">{sa.name}</span>
                <span className="text-xs text-[#9CA3AF] italic">(heights)</span>
                <span className="ml-auto text-xs text-[#6B7280]">{sa.quantity} pcs</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Customer Assignments Section (expanded row) ----------
type CustomerAssignment = {
  id: string;
  customerId: string;
  customerName: string;
  basePriceSen?: number | null;
  price1Sen?: number | null;
  seatHeightPrices?: { height: string; priceSen: number }[] | null;
  notes?: string | null;
};

type CustomerLite = { id: string; name: string };

function CustomerAssignmentsSection({ productId, active }: { productId: string; active: boolean }) {
  const { data: cpResp, refresh: refreshCP } = useCachedJson<{
    success?: boolean;
    data?: CustomerAssignment[];
  }>(active ? `/api/customer-products/by-product/${productId}` : null);
  const { data: customersResp } = useCachedJson<{ data?: CustomerLite[] }>(
    active ? "/api/customers" : null,
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm } = useConfirm();

  const assignments: CustomerAssignment[] = Array.isArray(cpResp?.data) ? cpResp!.data! : [];
  const allCustomers: CustomerLite[] = Array.isArray(customersResp?.data) ? customersResp!.data! : [];
  const assignedIds = new Set(assignments.map((a) => a.customerId));
  const unassigned = allCustomers.filter(
    (c) =>
      !assignedIds.has(c.id) &&
      (pickerQuery === "" || c.name.toLowerCase().includes(pickerQuery.toLowerCase())),
  );

  async function handleAssign(customerId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/customer-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, productId }),
      });
      if (res.ok) {
        invalidateCachePrefix("/api/customer-products");
        refreshCP();
        setPickerOpen(false);
        setPickerQuery("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(assignmentId: string, customerName: string) {
    if (busy) return;
    if (!(await confirm({ title: "Remove assignment?", message: `Remove assignment to ${customerName}?`, danger: true }))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/customer-products/${assignmentId}`, { method: "DELETE" });
      if (res.ok) {
        invalidateCachePrefix("/api/customer-products");
        refreshCP();
      }
    } finally {
      setBusy(false);
    }
  }

  function formatSeatHeights(sh: CustomerAssignment["seatHeightPrices"]): string {
    if (!sh || sh.length === 0) return "-";
    return sh
      .map((s) => `${String(s.height).replace('"', "")}:${(s.priceSen / 100).toFixed(0)}`)
      .join(" ");
  }

  const N = assignments.length;

  return (
    <div className="bg-[#FAF9F7] border border-[#E5E7EB] rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-[#374151]">
          Customer Assignments {N > 0 && <span className="text-[#6B7280] font-normal">({N} customer{N === 1 ? "" : "s"})</span>}
        </h4>
      </div>

      {N === 0 ? (
        <div className="text-xs text-[#9CA3AF] italic mb-3">Not assigned to any customer</div>
      ) : (
        <div className="overflow-x-auto mb-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-medium text-[#6B7280] uppercase border-b border-[#E5E7EB]">
                <th className="px-2 py-1.5">Customer</th>
                <th className="px-2 py-1.5 text-right">Base Price</th>
                <th className="px-2 py-1.5 text-right">Price 1</th>
                <th className="px-2 py-1.5">Seat Heights</th>
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} className="border-b border-[#F3F4F6] last:border-0">
                  <td className="px-2 py-1.5 text-[#111827]">{a.customerName}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[#111827]">
                    {a.basePriceSen != null && a.basePriceSen > 0 ? formatCurrency(a.basePriceSen) : <span className="text-[#9CA3AF]">-</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[#111827]">
                    {a.price1Sen != null && a.price1Sen > 0 ? formatCurrency(a.price1Sen) : <span className="text-[#9CA3AF]">-</span>}
                  </td>
                  <td className="px-2 py-1.5 text-[#6B7280] font-mono text-[11px]">
                    {formatSeatHeights(a.seatHeightPrices)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleRemove(a.id, a.customerName)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-[#B91C1C] hover:bg-[#FEE2E2] rounded disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#4F7C3A] bg-[#EEF3E4] border border-[#C6DBA8] rounded-md hover:bg-[#EEF3E4] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Assign to customer
          </button>
          {pickerOpen && (
            <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-[#E5E7EB] rounded-md shadow-lg z-10">
              <input
                autoFocus
                type="text"
                placeholder="Search customers..."
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                className="w-full px-2 py-1.5 text-xs border-b border-[#E5E7EB] focus:outline-none"
              />
              <div className="max-h-56 overflow-y-auto">
                {unassigned.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-[#9CA3AF] italic">
                    {allCustomers.length === 0 ? "Loading..." : "No unassigned customers"}
                  </div>
                ) : (
                  unassigned.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={busy}
                      onClick={() => handleAssign(c.id)}
                      className="block w-full text-left px-2 py-1.5 text-xs text-[#111827] hover:bg-[#F9FAFB] disabled:opacity-50"
                    >
                      {c.name}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <span className="text-[10px] text-[#9CA3AF] italic">(edit prices on customer page)</span>
      </div>
    </div>
  );
}

// ---------- Variant Config Defaults (per base model) ----------
// Empty by default — operators configure variants per SKU through the
// ---------- Variant Editor Dialog ----------
// Per-SKU default variant configurator. The fields displayed depend on
// product.category:
//   BEDFRAME  → Fabric · Divan Height · Leg Height · Gap · Specials
//   SOFA      → Fabric · Seat Height · Leg Height · Specials
//   ACCESSORY → Fabric only
// Option lists for divan/leg/gap/specials/sofa-* come from the master
// kv_config('variants-config') Maintenance config so anything the
// operator adds in Maintenance is immediately available here. Fabric
// options come from /api/fabric-tracking. The Save button emits the
// full ProductDefaultVariants blob; the parent persists it via
// PATCH /api/products/:id.
function VariantEditorDialog({
  open, onClose, product, defaults, maintenanceConfig, fabrics, onSave, saving,
}: {
  open: boolean;
  onClose: () => void;
  product: Product;
  defaults: ProductDefaultVariants;
  maintenanceConfig: MaintenanceConfig;
  fabrics: { code: string; description?: string }[];
  onSave: (v: ProductDefaultVariants) => void;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState<ProductDefaultVariants>({});

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot deep clone of defaults into editor state when dialog opens */
  useEffect(() => {
    if (open) {
      setDraft({
        fabricCode: defaults.fabricCode,
        divanHeight: defaults.divanHeight,
        legHeight: defaults.legHeight,
        gap: defaults.gap,
        seatHeight: defaults.seatHeight,
        specials: [...(defaults.specials ?? [])],
      });
    }
  }, [open, defaults]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!open) return null;

  const isBF = product.category === "BEDFRAME";
  const isSofa = product.category === "SOFA";

  // The specials master config is two separate lists in the maintenance
  // config (BF vs SOFA). Pick the right one for this product type.
  const specialsList: { value: string; priceSen?: number }[] = isSofa
    ? (maintenanceConfig.sofaSpecials ?? [])
    : (maintenanceConfig.specials ?? []);

  // Single-value pickers (divan / leg / gap / seat / fabric). Empty string =
  // "no default", which maps to undefined in the saved blob.
  const setSingle = (key: keyof ProductDefaultVariants, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value || undefined }));
  };

  // Multi-value picker for specials. Toggle in/out of the array.
  const toggleSpecial = (value: string) => {
    setDraft((prev) => {
      const current = prev.specials ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...prev, specials: next };
    });
  };

  const handleSave = () => {
    // Strip empty strings / empty arrays before persisting so the saved
    // blob stays compact and "configured" check (any field set) is
    // accurate.
    const out: ProductDefaultVariants = {};
    if (draft.fabricCode) out.fabricCode = draft.fabricCode;
    if (isBF) {
      if (draft.divanHeight) out.divanHeight = draft.divanHeight;
      if (draft.legHeight) out.legHeight = draft.legHeight;
      if (draft.gap) out.gap = draft.gap;
    } else if (isSofa) {
      if (draft.seatHeight) out.seatHeight = draft.seatHeight;
      if (draft.legHeight) out.legHeight = draft.legHeight;
    }
    if ((draft.specials?.length ?? 0) > 0) out.specials = draft.specials;
    onSave(out);
  };

  const handleClear = () => {
    setDraft({ specials: [] });
  };

  // Reusable single-select field renderer. Plain function (not a
  // component) so React doesn't treat it as a freshly-mounted component
  // every render — keeps internal state of <select> stable.
  const renderSelectField = (props: {
    label: string;
    value: string | undefined;
    options: { value: string; label?: string }[];
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <div className="space-y-1">
      <label className="text-xs font-medium text-[#6B7280]">{props.label}</label>
      <select
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full text-sm border border-[#E5E7EB] rounded px-2.5 py-1.5 bg-white"
      >
        <option value="">{props.placeholder ?? "— Not Set —"}</option>
        {props.options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label ?? opt.value}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[560px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E5E7EB]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Variant Defaults</h2>
            <p className="text-xs text-[#6B7280] mt-0.5">{product.code} — {product.name}</p>
            <p className="text-[10px] text-[#9CA3AF] mt-0.5">
              Sales Order pre-fills from these on product select. Operator can still override per line.
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Fabric — applies to all categories */}
          {renderSelectField({
            label: "Default Fabric",
            value: draft.fabricCode,
            onChange: (v) => setSingle("fabricCode", v),
            options: fabrics.map((f) => ({
              value: f.code,
              label: f.description ? `${f.code} — ${f.description}` : f.code,
            })),
          })}

          {isBF && (
            <>
              {renderSelectField({
                label: "Default Divan Height",
                value: draft.divanHeight,
                onChange: (v) => setSingle("divanHeight", v),
                options: (maintenanceConfig.divanHeights ?? []).map((o) => ({ value: o.value })),
              })}
              {renderSelectField({
                label: "Default Leg Height",
                value: draft.legHeight,
                onChange: (v) => setSingle("legHeight", v),
                options: (maintenanceConfig.legHeights ?? []).map((o) => ({ value: o.value })),
              })}
              {renderSelectField({
                label: "Default Gap",
                value: draft.gap,
                onChange: (v) => setSingle("gap", v),
                options: (maintenanceConfig.gaps ?? []).map((g) => ({ value: g })),
              })}
            </>
          )}

          {isSofa && (
            <>
              {renderSelectField({
                label: "Default Seat Height",
                value: draft.seatHeight,
                onChange: (v) => setSingle("seatHeight", v),
                options: (maintenanceConfig.sofaSizes ?? []).map((s) => ({ value: s })),
              })}
              {renderSelectField({
                label: "Default Leg Height",
                value: draft.legHeight,
                onChange: (v) => setSingle("legHeight", v),
                options: (maintenanceConfig.sofaLegHeights ?? []).map((o) => ({ value: o.value })),
              })}
            </>
          )}

          {/* Specials — multi-select for BF and SOFA only */}
          {(isBF || isSofa) && specialsList.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-[#6B7280]">
                Default Special Orders <span className="text-[#9CA3AF]">(multi-select)</span>
              </label>
              <div className="border border-[#E5E7EB] rounded p-2 max-h-40 overflow-y-auto space-y-1">
                {specialsList.map((s) => {
                  const checked = (draft.specials ?? []).includes(s.value);
                  return (
                    <label key={s.value} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-[#F9FAFB] px-1.5 py-1 rounded">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSpecial(s.value)}
                        className="accent-[#6B5C32]"
                      />
                      <span className="flex-1">{s.value}</span>
                      {typeof s.priceSen === "number" && s.priceSen !== 0 && (
                        <span className="text-[10px] text-[#9CA3AF] tabular-nums">
                          {s.priceSen > 0 ? "+" : ""}RM {(s.priceSen / 100).toFixed(2)}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {product.category === "ACCESSORY" && (
            <p className="text-xs text-[#6B7280] italic">
              Accessories only support a default fabric. Other variant fields don't apply.
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-[#E5E7EB] flex items-center justify-between">
          <button
            onClick={handleClear}
            disabled={saving}
            className="text-xs text-[#9A3A2D] hover:underline disabled:opacity-50"
          >
            Clear all defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm border border-[#E5E7EB] rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Defaults"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Maintenance View (Variants & Options) ----------
type MaintenanceListKey =
  | "divanHeights"
  | "legHeights"
  | "totalHeights"
  | "gaps"
  | "specials"
  | "bedframeSizes"
  | "sofaLegHeights"
  | "sofaSpecials"
  | "sofaSizes"
  | "sofaCompartments";

// BedframeSize (code · label · dimensions) + the seed catalogs live in
// @/lib/fg-variants (shared with the Add FG bulk-generate flow so they can't
// drift). Imported above.

// `packSeparately` is OPTIONAL and only meaningful on the leg-height lists
// (`legHeights` / `sofaLegHeights`). When TICKED the leg ships in its own box
// and gets its own piece on the FG packing sticker; when UNTICKED it ships
// inside the main item (no separate box). Undefined = "not set yet" — the FG
// sticker then falls back to the legacy >1" height rule so existing configs
// behave exactly as before. Set once per leg-height here in the catalog; it
// applies to every order that uses that leg height.
// `legSku` (OPTIONAL, leg-height rows only) binds this leg height to the exact
// raw_materials.itemCode the shop consumes for that leg. When set, RM
// consumption deducts THIS SKU (× the BOM leg line's qty) instead of guessing
// from the leg's inch height. Empty/undefined = not bound → consumption falls
// back to the legacy fuzzy description match. Owner 2026-07-30.
type PricedOption = { value: string; priceSen: number; packSeparately?: boolean; legSku?: string };

type MaintenanceConfig = {
  divanHeights: PricedOption[];
  legHeights: PricedOption[];
  totalHeights: PricedOption[];
  gaps: string[];
  specials: PricedOption[];
  // Bedframe size catalog (code · label · dimensions) — feeds Add FG bulk-generate.
  bedframeSizes: BedframeSize[];
  sofaLegHeights: PricedOption[];
  sofaSpecials: PricedOption[];
  sofaSizes: string[];
  // Sofa compartment pool (1A(LHF), 1A(RHF), 1NA, 2A(LHF)…) — the codes a sofa
  // model can be split into. Add FG bulk-generate lists these to tick per model.
  sofaCompartments: string[];
};

// Variants live in D1 under kv_config('variants-config'); see src/lib/kv-config.ts.

const todayIso = () => new Date().toISOString().slice(0, 10);

const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  divanHeights: [
    { value: '4"', priceSen: 0 },
    { value: '5"', priceSen: 0 },
    { value: '6"', priceSen: 0 },
    { value: '8"', priceSen: 0 },
    { value: '10"', priceSen: 5000 },
    { value: '11"', priceSen: 12000 },
    { value: '12"', priceSen: 12000 },
    { value: '13"', priceSen: 14000 },
    { value: '14"', priceSen: 14000 },
    { value: '16"', priceSen: 15000 },
  ],
  // packSeparately defaults mirror the legacy FG-sticker rule (leg > 1" gets
  // its own box) so a fresh install behaves identically to before this flag
  // existed. The owner can override per leg height in the Maintenance tab.
  legHeights: [
    { value: "No Leg", priceSen: 0, packSeparately: false },
    { value: '1"', priceSen: 0, packSeparately: false },
    { value: '2"', priceSen: 0, packSeparately: true },
    { value: '4"', priceSen: 0, packSeparately: true },
    { value: '6"', priceSen: 0, packSeparately: true },
    { value: '7"', priceSen: 16000, packSeparately: true },
  ],
  totalHeights: [
    { value: '10"', priceSen: 0 },
    { value: '12"', priceSen: 0 },
    { value: '14"', priceSen: 0 },
    { value: '16"', priceSen: 5000 },
    { value: '18"', priceSen: 5000 },
    { value: '20"', priceSen: 10000 },
    { value: '22"', priceSen: 12000 },
    { value: '24"', priceSen: 14000 },
    { value: '26"', priceSen: 15000 },
    { value: '28"', priceSen: 16000 },
  ],
  gaps: ['4"', '5"', '6"', '7"', '8"', '9"', '10"'],
  specials: [
    { value: "HB Fully Cover", priceSen: 5000 },
    { value: "Divan Top Fully Cover", priceSen: 5000 },
    { value: "Divan Full Cover", priceSen: 8000 },
    { value: "Left Drawer", priceSen: 15000 },
    { value: "Right Drawer", priceSen: 15000 },
    { value: "Front Drawer", priceSen: 12000 },
    { value: "HB Straight", priceSen: 0 },
    { value: "Divan Top(W)", priceSen: 0 },
    { value: "1 Piece Divan", priceSen: 25000 },
    { value: "Divan Curve", priceSen: 5000 },
    { value: "No Side Panel", priceSen: 4000 },
    { value: "Headboard Only", priceSen: 0 },
    { value: "Nylon Fabric", priceSen: 0 },
    { value: "5537 Backrest", priceSen: 0 },
    { value: 'Add 1" Infront L', priceSen: 0 },
    { value: "Separate Backrest Packing", priceSen: 0 },
    { value: "Divan A11", priceSen: 0 },
    { value: 'Seat Add On 4"', priceSen: 0 },
  ],
  bedframeSizes: DEFAULT_BEDFRAME_SIZES,
  sofaLegHeights: [
    { value: "No Leg", priceSen: 0, packSeparately: false },
    { value: '4"', priceSen: 0, packSeparately: true },
    { value: '6"', priceSen: 0, packSeparately: true },
  ],
  sofaSpecials: [
    { value: "Nylon Fabric", priceSen: 0 },
    { value: "5537 Backrest", priceSen: 0 },
    { value: "Separate Backrest Packing", priceSen: 0 },
  ],
  sofaSizes: FALLBACK_SOFA_SEAT_HEIGHTS,
  sofaCompartments: DEFAULT_SOFA_COMPARTMENTS,
};

// Numeric seat sizes for the SOFA price columns, from the Maintenance config.
// Cleans stray inch marks, dedupes, sorts numerically; falls back to the
// default list when the config is empty/malformed so the grid never loses
// its price columns.
function sofaHeightsFromConfig(cfg: MaintenanceConfig): string[] {
  const cleaned = (cfg.sofaSizes ?? [])
    .map((s) => String(s).replace(/"/g, "").trim())
    .filter((s) => /^\d+(?:\.\d+)?$/.test(s));
  const uniq = [...new Set(cleaned)];
  const base = uniq.length > 0 ? uniq : DEFAULT_MAINTENANCE_CONFIG.sofaSizes;
  return [...base].sort((a, b) => Number(a) - Number(b));
}

type MaintenanceTab = MaintenanceListKey | "fabrics";

type FabricTrackingItem = {
  id: string;
  fabricCode: string;
  fabricDescription: string;
  fabricCategory: string;
  priceTier?: "PRICE_1" | "PRICE_2";
  price: number;
  soh: number;
};

const MAINTENANCE_TABS: { key: MaintenanceTab; label: string; description: string; priced?: boolean; section?: string }[] = [
  { key: "divanHeights", label: "Divan Heights", description: "Bedframe divan height options with surcharge pricing", priced: true, section: "Bedframe" },
  { key: "totalHeights", label: "Total Heights", description: "Total height (Divan + Gap + Leg) surcharge pricing", priced: true, section: "Bedframe" },
  { key: "gaps", label: "Gaps", description: "Bedframe gap height options (inches)", section: "Bedframe" },
  { key: "legHeights", label: "Leg Heights", description: "Bedframe leg height options with surcharge pricing", priced: true, section: "Bedframe" },
  { key: "specials", label: "Specials", description: "Bedframe special order options with surcharge pricing", priced: true, section: "Bedframe" },
  { key: "bedframeSizes", label: "Bedframe Sizes", description: "Bedframe sizes — code · label · dimensions (e.g. K · 6FT · 183X190CM). Used by Add FG bulk generate + SKU names.", section: "Bedframe" },
  { key: "sofaSizes", label: "Sizes", description: "Available sofa seat height sizes (inches)", section: "Sofa" },
  { key: "sofaLegHeights", label: "Leg Heights", description: "Sofa leg height options with surcharge pricing", priced: true, section: "Sofa" },
  { key: "sofaSpecials", label: "Specials", description: "Sofa special order options with surcharge pricing", priced: true, section: "Sofa" },
  { key: "sofaCompartments", label: "Compartments", description: "Sofa compartment pool (1A(LHF), 1A(RHF), 1NA, 2A(LHF)…). Add FG bulk generate ticks which a model offers.", section: "Sofa" },
  { key: "fabrics", label: "Fabrics", description: "Fabric price tier assignment — determines Price 1 or Price 2 for bedframe pricing", section: "Common" },
];

function parseMaintenanceConfig(parsed: VariantsConfig | null): MaintenanceConfig {
  if (!parsed) return DEFAULT_MAINTENANCE_CONFIG;
  try {
    function ensurePriced(val: unknown, defaults: PricedOption[]): PricedOption[] {
      if (!Array.isArray(val)) return defaults;
      if (val.length === 0) return defaults;
      if (typeof val[0] === "string") {
        return (val as string[]).map(v => {
          const def = defaults.find(d => d.value === v);
          return { value: v, priceSen: def?.priceSen ?? 0 };
        });
      }
      return val as PricedOption[];
    }

    function ensureStrings(val: unknown, defaults: string[]): string[] {
      if (!Array.isArray(val)) return defaults;
      return val as string[];
    }

    // Bedframe sizes — coerce legacy/missing to defaults; tolerate rows that
    // predate the label/dimensions fields (fill blanks so the editor is safe).
    function ensureBedframeSizes(val: unknown, defaults: BedframeSize[]): BedframeSize[] {
      if (!Array.isArray(val) || val.length === 0) return defaults;
      return (val as Record<string, unknown>[]).map((r) => ({
        code: String(r?.code ?? ""),
        label: String(r?.label ?? ""),
        dimensions: String(r?.dimensions ?? ""),
      }));
    }

    return {
      divanHeights: ensurePriced(parsed.divanHeights, DEFAULT_MAINTENANCE_CONFIG.divanHeights),
      legHeights: ensurePriced(parsed.legHeights, DEFAULT_MAINTENANCE_CONFIG.legHeights),
      totalHeights: ensurePriced(parsed.totalHeights, DEFAULT_MAINTENANCE_CONFIG.totalHeights),
      gaps: ensureStrings(parsed.gaps, DEFAULT_MAINTENANCE_CONFIG.gaps),
      specials: ensurePriced(parsed.specials, DEFAULT_MAINTENANCE_CONFIG.specials),
      bedframeSizes: ensureBedframeSizes(parsed.bedframeSizes, DEFAULT_MAINTENANCE_CONFIG.bedframeSizes),
      sofaLegHeights: ensurePriced(parsed.sofaLegHeights, DEFAULT_MAINTENANCE_CONFIG.sofaLegHeights),
      sofaSpecials: ensurePriced(parsed.sofaSpecials, DEFAULT_MAINTENANCE_CONFIG.sofaSpecials),
      sofaSizes: ensureStrings(parsed.sofaSizes, DEFAULT_MAINTENANCE_CONFIG.sofaSizes),
      sofaCompartments: ensureStrings(parsed.sofaCompartments, DEFAULT_MAINTENANCE_CONFIG.sofaCompartments),
    };
  } catch {
    return DEFAULT_MAINTENANCE_CONFIG;
  }
}

function saveMaintenanceConfig(cfg: MaintenanceConfig) {
  if (typeof window === "undefined") return;
  // patchVariantsConfig merges into the existing blob, preserving
  // productionTimes / fabricGroups that BOM owns. Save is debounced client-side.
  patchVariantsConfig(cfg);
}

function MaintenanceView() {
  // savedConfig = the last persisted snapshot (the "clean" state). config =
  // the editable working copy. They diverge only while edit mode is on; when
  // edit mode is off, the inline RM inputs render as read-only text.
  const [savedConfig, setSavedConfig] = useState<MaintenanceConfig>(DEFAULT_MAINTENANCE_CONFIG);
  const [config, setConfig] = useState<MaintenanceConfig>(DEFAULT_MAINTENANCE_CONFIG);
  // Per-variant BOM/M3 defaults (owner 2026-07-11) — keyed by size code
  // (bedframe) / compartment (sofa). Add FG bulk-generate reads these to fill
  // Unit M3 + clone the chosen source BOM template onto each variant. Stored on
  // variants-config; patched immediately on change (independent of the Save
  // Snapshot flow, like the material-variant edits on the RM side).
  const [variantBomDefaults, setVariantBomDefaults] = useState<
    Record<string, { defaultBom?: string; unitM3?: number }>
  >({});
  const [bomTemplateList, setBomTemplateList] = useState<{ productCode: string; category: string }[]>([]);
  // Active raw materials for the leg-height → SKU picker (Leg Heights tabs).
  // Fetched once; the picker filters to leg-like items (description/itemCode
  // contains "LEG") plus whatever a row is already bound to.
  const [rawMaterials, setRawMaterials] = useState<{ itemCode: string; description: string }[]>([]);
  useEffect(() => {
    void fetchVariantsConfig().then((v) => {
      setVariantBomDefaults(
        (v?.variantBomDefaults as Record<string, { defaultBom?: string; unitM3?: number }> | undefined) ?? {},
      );
    });
    void cachedFetchJson<{ data?: { productCode: string; category: string }[] }>("/api/bom/templates")
      .then((d) => setBomTemplateList(d?.data ?? []))
      .catch(() => {});
    void cachedFetchJson<{ data?: { itemCode: string; description: string }[] }>("/api/raw-materials?status=ACTIVE")
      .then((d) => setRawMaterials((d?.data ?? []).map((r) => ({ itemCode: r.itemCode, description: r.description }))))
      .catch(() => {});
  }, []);
  function updateVariantDefault(code: string, patch: { defaultBom?: string; unitM3?: number }) {
    const next = { ...variantBomDefaults, [code]: { ...variantBomDefaults[code], ...patch } };
    setVariantBomDefaults(next);
    patchVariantsConfig({ variantBomDefaults: next });
  }
  const [tab, setTab] = useState<MaintenanceTab>("divanHeights");
  const [newValue, setNewValue] = useState("");
  const [newPriceSen, setNewPriceSen] = useState(0);
  // (Legacy click-to-edit state removed — inputs are now always editable
  // when editMode is on, mirroring the SKU Master pattern.)
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMsg, setToastMsg] = useState("Saved");
  const { confirm } = useConfirm();

  // Edit / Save / Cancel mode. Mirrors the SKU Master pattern at the top of
  // ProductsPage. When false, inline RM inputs are read-only text and Add /
  // Trash controls are hidden — the page is a safe browse view. Save opens
  // the effective-date modal; Cancel reverts to savedConfig.
  const [editMode, setEditMode] = useState(false);

  // Fabrics from API
  const [fabricsList, setFabricsList] = useState<FabricTrackingItem[]>([]);
  const [fabricsLoading, setFabricsLoading] = useState(false);
  const [fabricSearch, setFabricSearch] = useState("");
  // Pending fabric-tier change captured before we PUT to /api/fabric-tracking.
  // The confirm modal explains the catalog flips immediately but every existing
  // sales-order line item carries a snapshot of basePriceSen, so old SOs are
  // unaffected. Cleared after the confirm callback resolves.
  const [pendingFabricTierChange, setPendingFabricTierChange] = useState<{
    id: string;
    code: string;
    description: string;
    fromTier: string;
    toTier: "PRICE_1" | "PRICE_2";
  } | null>(null);

  // Effective-dated history workflow. The legacy kv_config('variants-config')
  // write path is still triggered inside the save flow when the new snapshot
  // is effective today (so existing live readers across BOM, Sales,
  // Production immediately see the change) — but it's no longer auto-fired
  // on every keystroke. Save Snapshot writes a row to
  // /api/maintenance-config/changes; View History opens the listing dialog.
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);

  // Per-row item history. Populated on demand when the user clicks the
  // calendar icon on a priced row. The dialog reuses the full history list
  // (one fetch covers every row in the snapshot).
  const [historyList, setHistoryList] = useState<MaintenanceHistoryRow[]>([]);
  const [itemHistoryFor, setItemHistoryFor] = useState<{ key: PricedItemKey; value: string; label: string } | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- mount-time hydrate of kv-config + subscription to cross-tab updates */
  useEffect(() => {
    // Render immediately from whatever the shared kv-config cache already has
    // (prevents a flash of defaults when bouncing between pages). Then fetch
    // fresh from D1 and overwrite.
    const cached = parseMaintenanceConfig(getVariantsConfigSync());
    setConfig(cached);
    setSavedConfig(cached);

    let cancelled = false;
    void fetchVariantsConfig().then((v) => {
      if (cancelled) return;
      const fresh = parseMaintenanceConfig(v);
      setConfig(fresh);
      setSavedConfig(fresh);
    });

    // Pick up writes from other tabs/pages (e.g. BOM's ProductionTimesDialog).
    // We never overwrite uncommitted edits — if the user is mid-edit, the
    // background blob update only refreshes the savedConfig baseline so a
    // subsequent Cancel reverts to the freshest server state.
    const off = subscribeKvConfig(VARIANTS_CONFIG_KEY, (v) => {
      const latest = parseMaintenanceConfig(v as VariantsConfig | null);
      setSavedConfig(latest);
      setConfig((prev) => (editMode ? prev : latest));
    });
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetch fabrics when tab switches to fabrics
  /* eslint-disable react-hooks/set-state-in-effect -- lazy load + loading flag toggle on tab switch */
  useEffect(() => {
    if (tab !== "fabrics") return;
    setFabricsLoading(true);
    cachedFetchJson<{ data?: FabricTrackingItem[] }>("/api/fabric-tracking")
      .then((d) => setFabricsList(d?.data ?? []))
      .catch(() => {})
      .finally(() => setFabricsLoading(false));
  }, [tab]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function showToast(msg: string) {
    setToastMsg(msg);
    setToastVisible(true);
    // Fire-and-forget toast hide from event-style callback (e.g. add-row click).
    // eslint-disable-next-line no-restricted-syntax -- one-shot toast timer from event handler
    setTimeout(() => setToastVisible(false), 2000);
  }

  const isDirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig],
  );
  // Warn before leaving with unsaved master-config edits (owner's "切頁也提醒").
  // Single guard on this route, no useBlocker conflict.
  useNavGuard(editMode && isDirty, "You have unsaved master settings. Leave without saving?");

  const isFabricsTab = tab === "fabrics";
  const meta = MAINTENANCE_TABS.find((t) => t.key === tab)!;
  const isPricedTab = !isFabricsTab && (meta.priced ?? false);
  // Leg-height tabs get an extra "Pack leg separately" checkbox per row. The
  // flag drives whether the leg becomes its own piece on the FG packing
  // sticker (its own box in the X/N count).
  const isLegTab = tab === "legHeights" || tab === "sofaLegHeights";
  // Leg-height → SKU picker options. The shop names leg raw materials with
  // "LEG" (that's what the old fuzzy consumption match keyed on), so we filter
  // the active raw-materials list to leg-like items. Sorted by itemCode.
  const legSkuCandidates = useMemo(
    () =>
      rawMaterials
        .filter((r) => /leg/i.test(r.description) || /leg/i.test(r.itemCode))
        .sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
    [rawMaterials],
  );
  // Bedframe Sizes is the one object-shaped list (code · label · dimensions);
  // it gets its own 3-column inline editor instead of the value/price row.
  const isBedframeSizesTab = tab === "bedframeSizes";
  // Sofa Compartments is a plain string list, but its editor also carries the
  // per-compartment Default BOM + Unit M3 controls (owner 2026-07-11), so it
  // gets its own render branch rather than the bare string editor.
  const isSofaCompartmentsTab = tab === "sofaCompartments";
  const currentStringList = !isFabricsTab && !isPricedTab && !isBedframeSizesTab && !isSofaCompartmentsTab ? (config[tab as MaintenanceListKey] as string[]) : [];
  const currentPricedList = !isFabricsTab && isPricedTab ? (config[tab as MaintenanceListKey] as PricedOption[]) : [];
  const currentBedframeSizes = isBedframeSizesTab ? config.bedframeSizes : [];
  const currentSofaCompartments = isSofaCompartmentsTab ? config.sofaCompartments : [];

  function addEntry() {
    if (isFabricsTab || !editMode) return;
    // Bedframe sizes are 3-field rows edited inline — "Add size" appends a blank
    // row for the operator to fill (code · label · dimensions).
    if (isBedframeSizesTab) {
      setConfig(prev => ({ ...prev, bedframeSizes: [...prev.bedframeSizes, { code: "", label: "", dimensions: "" }] }));
      return;
    }
    const k = tab as MaintenanceListKey;
    const v = newValue.trim();
    if (!v) return;
    if (isPricedTab) {
      const list = config[k] as PricedOption[];
      if (list.some(o => o.value === v)) { setNewValue(""); return; }
      // New leg-height rows default to "packed with item" (packSeparately
      // false). Packing is controlled solely by this Maintenance checkbox now,
      // so the operator ticks a height when it should ship in its own box.
      const newOpt: PricedOption = isLegTab
        ? { value: v, priceSen: newPriceSen, packSeparately: false }
        : { value: v, priceSen: newPriceSen };
      setConfig(prev => ({ ...prev, [k]: [...(prev[k] as PricedOption[]), newOpt] }));
    } else {
      const list = config[k] as string[];
      if (list.includes(v)) { setNewValue(""); return; }
      setConfig(prev => ({ ...prev, [k]: [...(prev[k] as string[]), v] }));
    }
    setNewValue("");
    setNewPriceSen(0);
  }

  function removeEntry(idx: number) {
    if (isFabricsTab || !editMode) return;
    const k = tab as MaintenanceListKey;
    setConfig(prev => ({
      ...prev,
      [k]: (prev[k] as (string | PricedOption)[]).filter((_, i) => i !== idx),
    }));
  }

  function updatePrice(idx: number, priceSen: number) {
    if (isFabricsTab || !editMode) return;
    const k = tab as MaintenanceListKey;
    setConfig(prev => ({
      ...prev,
      [k]: (prev[k] as PricedOption[]).map((o, i) => i === idx ? { ...o, priceSen } : o),
    }));
  }

  // Toggle the "Pack leg separately" flag on a leg-height row. Only the leg
  // tabs (legHeights / sofaLegHeights) surface the checkbox, but the writer is
  // generic — it just stamps the boolean onto the PricedOption at idx.
  function updatePackSeparately(idx: number, packSeparately: boolean) {
    if (isFabricsTab || !editMode) return;
    const k = tab as MaintenanceListKey;
    setConfig(prev => ({
      ...prev,
      [k]: (prev[k] as PricedOption[]).map((o, i) => i === idx ? { ...o, packSeparately } : o),
    }));
  }

  // Bind (or clear) the raw-material SKU a leg-height row consumes. Leg tabs
  // only. Empty string clears the binding (falls back to fuzzy match at
  // consumption time). Stored on the PricedOption at idx as `legSku`.
  function updateLegSku(idx: number, legSku: string) {
    if (isFabricsTab || !editMode) return;
    const k = tab as MaintenanceListKey;
    const clean = legSku.trim();
    setConfig(prev => ({
      ...prev,
      [k]: (prev[k] as PricedOption[]).map((o, i) =>
        i === idx ? { ...o, legSku: clean.length > 0 ? clean : undefined } : o,
      ),
    }));
  }

  function updateEntryValue(idx: number, newVal: string) {
    if (isFabricsTab || !editMode) return;
    // Allow blank intermediate state — operators routinely clear a value
    // before typing the new one. Empty rows get filtered on Save anyway.
    const k = tab as MaintenanceListKey;
    if (isPricedTab) {
      setConfig(prev => ({
        ...prev,
        [k]: (prev[k] as PricedOption[]).map((o, i) => i === idx ? { ...o, value: newVal } : o),
      }));
    } else {
      setConfig(prev => ({
        ...prev,
        [k]: (prev[k] as string[]).map((o, i) => i === idx ? newVal : o),
      }));
    }
  }

  // Bedframe Sizes inline editor — update one field (code / label / dimensions)
  // of the row at idx. Kept separate from updateEntryValue (which handles the
  // string + priced lists) because this list is object-shaped.
  function updateBedframeSize(idx: number, field: keyof BedframeSize, val: string) {
    if (!editMode) return;
    setConfig(prev => ({
      ...prev,
      bedframeSizes: prev.bedframeSizes.map((o, i) => (i === idx ? { ...o, [field]: val } : o)),
    }));
  }

  async function handleCancel() {
    if (
      isDirty &&
      !(await confirm({ title: "Discard unsaved edits?", message: "Discard your unsaved Maintenance edits?", danger: true }))
    ) {
      return;
    }
    setConfig(savedConfig);
    setEditMode(false);
    setNewValue("");
    setNewPriceSen(0);
  }

  function handleSaveClick() {
    if (!isDirty) {
      // Nothing to commit — just exit edit mode quietly.
      setEditMode(false);
      return;
    }
    setShowSaveModal(true);
  }

  // Open the per-row item history dialog. Fetches the full history list on
  // demand (one fetch covers every row), then surfaces the dialog scoped to
  // the (key, value) tuple the user clicked.
  async function openItemHistory(key: PricedItemKey, value: string, label: string) {
    try {
      const res = await fetch(
        `/api/maintenance-config/history?scope=master`,
      );
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: MaintenanceHistoryRow[];
      };
      setHistoryList(j.success && j.data ? j.data : []);
    } catch {
      setHistoryList([]);
    }
    setItemHistoryFor({ key, value, label });
  }

  return (
    <div className="space-y-4">
      {/* Edit / Save / Cancel bar — mirrors SKU Master. The dual-write to
          kv_config('variants-config') happens INSIDE the modal's onSaved
          handler when effectiveFrom <= today, so live readers immediately
          see the change without a round-trip through the history fetch. */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#6B7280]">
          Centralized master data for product variants. Used by BOM, Sales Orders, and Production.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistoryDialog(true)}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
            title="View effective-dated history of master maintenance config"
          >
            <History className="w-3.5 h-3.5" />
            View History
          </button>
          {!editMode ? (
            <button
              onClick={() => setEditMode(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          ) : (
            <>
              <button
                onClick={handleSaveClick}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  isDirty
                    ? "bg-[#6B5C32] text-white hover:bg-[#5A4E2A]"
                    : "bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6]"
                }`}
              >
                <Calendar className="w-3.5 h-3.5" />
                Save
              </button>
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] transition-colors"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* Effective-date snapshot modal — POSTs to /api/maintenance-config/changes
          and, on success for a today-or-earlier date, mirrors the snapshot to
          kv_config('variants-config') so live readers see the new values. */}
      <MaintenanceConfigSaveModal
        open={showSaveModal}
        scope="master"
        config={config}
        onClose={() => setShowSaveModal(false)}
        onSaved={async (effectiveFrom) => {
          setShowSaveModal(false);
          // Dual-write to kv_config only for snapshots effective today or
          // earlier. Future-dated snapshots stay in the history table until
          // their day arrives, at which point the resolver picks them up.
          if (effectiveFrom <= todayIso()) {
            saveMaintenanceConfig(config);
            await flushKvConfig(VARIANTS_CONFIG_KEY);
          }
          setSavedConfig(config);
          setEditMode(false);
          showToast("Maintenance config saved");
        }}
      />

      {/* History listing dialog */}
      <MaintenanceConfigHistoryDialog
        open={showHistoryDialog}
        scope="master"
        title="Master Maintenance — config history"
        onClose={() => setShowHistoryDialog(false)}
      />

      {/* Per-row item history dialog — opens when the user clicks the
          calendar icon on a priced row. Read-only timeline. To schedule a
          new entry the operator clicks Edit on the page, changes the RM
          input, then Save (which opens the effective-date modal). */}
      {itemHistoryFor && (
        <MaintenanceItemHistoryDialog
          open={itemHistoryFor !== null}
          itemKey={itemHistoryFor.key}
          itemValue={itemHistoryFor.value}
          itemLabel={`${meta.section ? meta.section + " " : ""}${meta.label}`}
          history={historyList}
          onClose={() => setItemHistoryFor(null)}
        />
      )}

      {/* Fabric tier change is a direct PUT to /api/fabric-tracking — there
          is no effective-dated history table for it (every sales-order line
          item already snapshots its own basePriceSen / fabricCode at SO
          creation, so old SOs are protected without a history layer).
          Operator confirms the irreversible flip in the modal first. */}
      <EffectiveDateConfirmModal
        open={pendingFabricTierChange !== null}
        title="Change fabric price tier"
        summary={
          pendingFabricTierChange
            ? `${pendingFabricTierChange.code} — ${pendingFabricTierChange.description}: ${pendingFabricTierChange.fromTier} -> ${pendingFabricTierChange.toTier}.`
            : ""
        }
        ctaLabel="Confirm tier change"
        notesPlaceholder="e.g. supplier reclassification"
        irreversible
        onClose={() => setPendingFabricTierChange(null)}
        onConfirm={async () => {
          if (!pendingFabricTierChange) return;
          const { id, toTier } = pendingFabricTierChange;
          // 2026-05-27 verifiedSave migration. Tier flip changes per-meter
          // pricing for every SO line that uses this fabric — confirm it
          // landed before reporting success.
          const result = await verifiedSave<{ id: string; priceTier?: string }>({
            endpoint: `/api/fabric-tracking/${id}`,
            method: "PUT",
            body: { priceTier: toTier },
            readback: async () => {
              const r = await fetch(`/api/fabric-tracking/${id}?_v=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
              });
              if (!r.ok) return null;
              const j = (await r.json()) as { success?: boolean; data?: { id: string; priceTier?: string } } | { id: string; priceTier?: string };
              return (j as { data?: { id: string; priceTier?: string } })?.data ?? (j as { id: string; priceTier?: string }) ?? null;
            },
            expect: { priceTier: toTier },
          });
          if (!result.ok) {
            if (result.reason === "mismatch") {
              throw new Error(formatMismatchError(result.diffs));
            } else if (result.reason === "http") {
              throw new Error(`Failed to update fabric tier (HTTP ${result.status})`);
            } else {
              throw new Error(`Save failed: ${result.details}`);
            }
          }
          invalidateCachePrefix("/api/fabric-tracking");
          invalidateCachePrefix("/api/raw-materials");
          setFabricsList((prev) =>
            prev.map((fb) => (fb.id === id ? { ...fb, priceTier: toTier } : fb)),
          );
          setPendingFabricTierChange(null);
          showToast("Fabric updated");
        }}
      />

      {/* Tabs + Content */}
      <div className="bg-white rounded-lg border border-[#E2DDD8] overflow-hidden">
        <div className="flex border-b border-[#E2DDD8] bg-[#FAF9F7] overflow-x-auto items-end">
          {MAINTENANCE_TABS.map((t, i) => {
            const prevSection = i > 0 ? MAINTENANCE_TABS[i - 1].section : undefined;
            const showSectionLabel = t.section && t.section !== prevSection;
            return (
              <div key={t.key} className="flex items-end">
                {showSectionLabel && (
                  <div className="flex items-center self-stretch">
                    {i > 0 && <div className="w-px h-6 bg-[#D1D5DB] mx-1 self-center" />}
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF] px-2 pb-3.5 self-end">
                      {t.section}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => { setTab(t.key); setNewValue(""); setNewPriceSen(0); }}
                  className={`relative px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                    tab === t.key
                      ? "text-[#6B5C32] bg-white border-b-2 border-[#6B5C32]"
                      : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
                  }`}
                >
                  {t.label}
                  <span className="ml-1.5 text-[10px] text-gray-400 font-normal">
                    ({(() => { if (t.key === "fabrics") return fabricsList.length; const list = config[t.key as MaintenanceListKey]; return Array.isArray(list) ? list.length : 0; })()})
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="p-6">
          <p className="text-sm text-gray-500 mb-4">{meta.description}</p>

          {isFabricsTab ? (
            /* ── Fabrics Tab ── */
            <div className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search fabrics by code or description..."
                  value={fabricSearch}
                  onChange={(e) => setFabricSearch(e.target.value)}
                  className="w-full text-sm border border-[#E2DDD8] rounded-md px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                />
              </div>
              {fabricsLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin h-6 w-6 border-3 border-[#6B5C32] border-t-transparent rounded-full" />
                </div>
              ) : (
                <div className="overflow-x-auto border border-[#E2DDD8] rounded-lg">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600">#</th>
                        <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600">Code</th>
                        <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600">Description</th>
                        <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600">Category</th>
                        <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-600">Price Tier</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-600">SOH</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {fabricsList
                        .filter((f) => {
                          if (!fabricSearch.trim()) return true;
                          const q = fabricSearch.toLowerCase();
                          return f.fabricCode.toLowerCase().includes(q) || f.fabricDescription.toLowerCase().includes(q);
                        })
                        .map((f, idx) => (
                        <tr key={f.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 text-[10px] text-gray-400 font-mono">{idx + 1}</td>
                          <td className="px-3 py-2 font-mono font-medium text-gray-900">{f.fabricCode}</td>
                          <td className="px-3 py-2 text-gray-700">{f.fabricDescription}</td>
                          <td className="px-3 py-2">
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
                              {f.fabricCategory}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <select
                              value={f.priceTier || "PRICE_2"}
                              onChange={(e) => {
                                const tier = e.target.value as "PRICE_1" | "PRICE_2";
                                if (tier === (f.priceTier || "PRICE_2")) return;
                                // Stage the change behind the confirm modal —
                                // the actual PUT runs once the operator OKs the
                                // "old SOs already snapshotted, catalog flips
                                // immediately" warning.
                                setPendingFabricTierChange({
                                  id: f.id,
                                  code: f.fabricCode,
                                  description: f.fabricDescription,
                                  fromTier: f.priceTier || "PRICE_2",
                                  toTier: tier,
                                });
                              }}
                              className={`text-xs font-semibold px-2 py-1 rounded border cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40 ${
                                f.priceTier === "PRICE_1"
                                  ? "bg-[#E0EDF0] border-[#A8CAD2] text-[#3E6570]"
                                  : "bg-[#FAEFCB] border-[#E8D597] text-[#9C6F1E]"
                              }`}
                            >
                              <option value="PRICE_1">Price 1</option>
                              <option value="PRICE_2">Price 2</option>
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-gray-900">{f.soh.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            /* ── Normal list tabs ── */
            <>
              {/* Add row — only visible while editing. */}
              {editMode && (
                <div className="flex gap-2 mb-4">
                  {isBedframeSizesTab ? (
                    <span className="flex-1 text-sm text-gray-400 self-center">Add a size row, then fill code · label · dimensions inline.</span>
                  ) : (
                    <input
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEntry(); } }}
                      placeholder={`Add new ${meta.label.toLowerCase().replace(/s$/, "")}...`}
                      className="flex-1 text-sm border border-[#E2DDD8] rounded-md px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                    />
                  )}
                  {isPricedTab && (
                    <div className="flex items-center gap-1">
                      {/* Surcharge can be negative — some variants are a
                        * discount off the base price (e.g. "No Leg" = -RM10).
                        * Label stays neutral; the number carries its sign. */}
                      <span className="text-xs text-gray-500">RM</span>
                      <MoneyInput
                        value={newPriceSen / 100}
                        onChange={(rm) => setNewPriceSen(Math.round((rm ?? 0) * 100))}
                        className="w-24 text-sm bg-[#FAF9F7] focus:bg-white"
                        placeholder="0.00"
                      />
                    </div>
                  )}
                  <button
                    onClick={addEntry}
                    disabled={!isBedframeSizesTab && !newValue.trim()}
                    className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                    {isBedframeSizesTab ? "Add size" : "Add"}
                  </button>
                </div>
              )}

              {/* List */}
              <div className="space-y-1.5">
                {isSofaCompartmentsTab ? (
                  currentSofaCompartments.length === 0 ? (
                    <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                      {editMode ? "No compartments yet. Add one above." : "No compartments."}
                    </div>
                  ) : (
                    currentSofaCompartments.map((code, idx) => (
                      <div key={`sofacomp-${idx}`} className="flex items-center gap-2 px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors">
                        <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                        <span className="text-sm font-mono font-medium text-[#111827] w-28 flex-shrink-0">{code}</span>
                        {editMode ? (
                          <>
                            <select value={variantBomDefaults[code]?.defaultBom ?? ""} onChange={(e) => updateVariantDefault(code, { defaultBom: e.target.value || undefined })} title="Default BOM to copy from on Add FG generate" className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-40 flex-shrink-0">
                              <option value="">BOM: —</option>
                              {bomTemplateList.filter((t) => (t.category || "").toUpperCase() === "SOFA").map((t) => <option key={t.productCode} value={t.productCode}>{t.productCode}</option>)}
                            </select>
                            <input type="number" step="0.001" min={0} onFocus={(e) => e.currentTarget.select()} value={variantBomDefaults[code]?.unitM3 ?? ""} onChange={(e) => updateVariantDefault(code, { unitM3: e.target.value === "" ? undefined : parseFloat(e.target.value) })} placeholder="M³" title="Default Unit M3" className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-20 flex-shrink-0" />
                            <button onClick={() => removeEntry(idx)} className="ml-auto p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded flex-shrink-0" title="Remove"><Trash2 className="w-4 h-4" /></button>
                          </>
                        ) : (
                          <span className="text-sm text-gray-500">
                            {variantBomDefaults[code]?.defaultBom ? <>BOM <span className="font-mono text-[#6B5C32]">{variantBomDefaults[code]?.defaultBom}</span></> : "—"}
                            {variantBomDefaults[code]?.unitM3 != null ? <span className="text-gray-400"> · M³ {variantBomDefaults[code]?.unitM3}</span> : null}
                          </span>
                        )}
                      </div>
                    ))
                  )
                ) : isBedframeSizesTab ? (
                  currentBedframeSizes.length === 0 ? (
                    <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                      {editMode ? "No sizes yet. Click Add size to start." : "No sizes."}
                    </div>
                  ) : (
                    currentBedframeSizes.map((entry, idx) => (
                      <div
                        key={`bfsize-${idx}`}
                        className="flex items-center gap-2 px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors"
                      >
                        <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                        {editMode ? (
                          <>
                            <input value={entry.code} onChange={(e) => updateBedframeSize(idx, "code", e.target.value)} placeholder="K" className="text-sm font-medium border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-20" />
                            <input value={entry.label} onChange={(e) => updateBedframeSize(idx, "label", e.target.value)} placeholder="6FT" className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-24" />
                            <input value={entry.dimensions} onChange={(e) => updateBedframeSize(idx, "dimensions", e.target.value)} placeholder="183X190CM" className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] flex-1" />
                            {/* Default BOM to copy from + default Unit M3 — Add FG
                                bulk-generate applies these per size (owner 2026-07-11). */}
                            <select value={variantBomDefaults[entry.code]?.defaultBom ?? ""} onChange={(e) => updateVariantDefault(entry.code, { defaultBom: e.target.value || undefined })} title="Default BOM to copy from on Add FG generate" className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-40 flex-shrink-0">
                              <option value="">BOM: —</option>
                              {bomTemplateList.filter((t) => (t.category || "").toUpperCase() === "BEDFRAME").map((t) => <option key={t.productCode} value={t.productCode}>{t.productCode}</option>)}
                            </select>
                            <input type="number" step="0.001" min={0} onFocus={(e) => e.currentTarget.select()} value={variantBomDefaults[entry.code]?.unitM3 ?? ""} onChange={(e) => updateVariantDefault(entry.code, { unitM3: e.target.value === "" ? undefined : parseFloat(e.target.value) })} placeholder="M³" title="Default Unit M3" className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-20 flex-shrink-0" />
                            <button onClick={() => removeEntry(idx)} className="p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded flex-shrink-0" title="Remove"><Trash2 className="w-4 h-4" /></button>
                          </>
                        ) : (
                          <span className="text-sm text-[#111827] font-medium">
                            <span className="font-mono">{entry.code}</span>
                            <span className="text-gray-400"> · </span>{entry.label}
                            <span className="text-gray-400"> · </span><span className="text-gray-500">{entry.dimensions}</span>
                            {variantBomDefaults[entry.code]?.defaultBom ? <span className="text-gray-400"> · BOM <span className="font-mono text-[#6B5C32]">{variantBomDefaults[entry.code]?.defaultBom}</span></span> : null}
                            {variantBomDefaults[entry.code]?.unitM3 != null ? <span className="text-gray-400"> · M³ {variantBomDefaults[entry.code]?.unitM3}</span> : null}
                          </span>
                        )}
                      </div>
                    ))
                  )
                ) : isPricedTab ? (
                  currentPricedList.length === 0 ? (
                    <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                      {editMode ? "No entries yet. Add one above to get started." : "No entries."}
                    </div>
                  ) : (
                    currentPricedList.map((entry, idx) => (
                      <div
                        key={`${tab}-${idx}`}
                        className="flex items-center justify-between px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors group"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {/* Per-row history icon — only on priced lists. Click
                              opens a read-only timeline of this row's RM across
                              snapshots. Shown in both browse + edit mode. */}
                          {isPricedItemKey(tab) && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void openItemHistory(tab, entry.value, meta.label);
                              }}
                              className="p-0.5 text-[#9CA3AF] hover:text-[#6B5C32] hover:bg-[#F4F0E8] rounded flex-shrink-0"
                              title="View this item's price history"
                            >
                              <History className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                          {editMode ? (
                            <input
                              value={entry.value}
                              onChange={(e) => updateEntryValue(idx, e.target.value)}
                              className="text-sm font-medium border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-48"
                            />
                          ) : (
                            <span className="text-sm text-[#111827] font-medium">
                              {entry.value}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {/* Leg SKU binding — leg-height tabs only. Binds this
                              leg height to the exact raw material consumed for
                              it. When set, RM consumption deducts THIS SKU (×
                              the BOM leg line's qty) instead of guessing from
                              the inch height. Empty = fall back to fuzzy match. */}
                          {isLegTab && (
                            editMode ? (
                              <select
                                value={entry.legSku ?? ""}
                                onChange={(e) => updateLegSku(idx, e.target.value)}
                                title="Raw material consumed for this leg height"
                                className="text-xs border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-56"
                              >
                                <option value="">SKU: — not bound —</option>
                                {/* Keep a bound-but-non-leg-named SKU visible. */}
                                {entry.legSku && !legSkuCandidates.some((r) => r.itemCode === entry.legSku) && (
                                  <option value={entry.legSku}>{entry.legSku}</option>
                                )}
                                {legSkuCandidates.map((r) => (
                                  <option key={r.itemCode} value={r.itemCode}>
                                    {r.itemCode} — {r.description}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span
                                className={`text-xs whitespace-nowrap ${entry.legSku ? "text-[#6B5C32] font-medium" : "text-gray-400"}`}
                                title="Raw material consumed for this leg height"
                              >
                                {entry.legSku ? `SKU ${entry.legSku}` : "SKU —"}
                              </span>
                            )
                          )}
                          {/* Pack leg separately — leg-height tabs only. When
                              ticked the leg ships in its own box and shows as
                              its own piece on the FG packing sticker. Legacy
                              rows that predate the flag have no stored value, so
                              we show the SAME effective rule the packing sticker
                              uses (optionPacksSeparately: explicit flag wins,
                              else legs taller than 1" pack on their own). This
                              keeps the screen honest with what actually prints,
                              without needing a stored value on every old row. */}
                          {isLegTab && (
                            editMode ? (
                              <label className="flex items-center gap-1.5 text-xs text-[#374151] cursor-pointer select-none whitespace-nowrap">
                                <input
                                  type="checkbox"
                                  checked={optionPacksSeparately(entry)}
                                  onChange={(e) => updatePackSeparately(idx, e.target.checked)}
                                  className="w-3.5 h-3.5 accent-[#6B5C32] cursor-pointer"
                                />
                                Pack leg separately
                              </label>
                            ) : (
                              <span
                                className={`text-xs whitespace-nowrap ${optionPacksSeparately(entry) ? "text-[#6B5C32] font-medium" : "text-gray-400"}`}
                                title="Whether this leg ships in its own box on the FG packing sticker"
                              >
                                {optionPacksSeparately(entry) ? "Separate box" : "Packed with item"}
                              </span>
                            )
                          )}
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-400">RM</span>
                            {editMode ? (
                              <MoneyInput
                                value={entry.priceSen / 100}
                                onChange={(rm) => updatePrice(idx, Math.round((rm ?? 0) * 100))}
                                className="w-20 text-sm"
                              />
                            ) : (
                              <span className="w-20 text-right text-sm tabular-nums text-[#111827] font-medium">
                                {(entry.priceSen / 100).toFixed(2)}
                              </span>
                            )}
                          </div>
                          {editMode && (
                            <button
                              onClick={() => removeEntry(idx)}
                              className="p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                              title="Remove"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )
                ) : (
                  currentStringList.length === 0 ? (
                    <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                      {editMode ? "No entries yet. Add one above to get started." : "No entries."}
                    </div>
                  ) : (
                    currentStringList.map((entry, idx) => (
                      <div
                        key={`${tab}-${idx}`}
                        className="flex items-center justify-between px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors group"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                          {editMode ? (
                            <input
                              value={entry}
                              onChange={(e) => updateEntryValue(idx, e.target.value)}
                              className="text-sm font-medium border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32] w-48"
                            />
                          ) : (
                            <span className="text-sm text-[#111827] font-medium">
                              {entry}
                            </span>
                          )}
                        </div>
                        {editMode && (
                          <button
                            onClick={() => removeEntry(idx)}
                            className="p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                            title="Remove"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))
                  )
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Info footer */}
      <div className="text-xs text-gray-400 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md p-3">
        Variants are stored server-side in D1 under{' '}
        <code className="bg-white px-1 rounded">/api/kv-config/{VARIANTS_CONFIG_KEY}</code>.
        Changes apply the next time BOM, SO, or Production forms are rendered.
      </div>

      {/* Toast */}
      {toastVisible && (
        <div className="fixed bottom-6 right-6 inline-flex items-center gap-2 px-4 py-2.5 bg-[#4F7C3A] text-white rounded-lg shadow-lg text-sm">
          <Check className="w-4 h-4" />
          {toastMsg}
        </div>
      )}
    </div>
  );
}

// ---------- Main Page ----------
export default function ProductsPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [viewMode, setViewMode] = useState<"skuMaster" | "catalog" | "maintenance">("skuMaster");
  const [products, setProducts] = useState<Product[]>([]);
  const [configs, setConfigs] = useState<ProductDeptConfig[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("BEDFRAME");
  const [searchQuery, setSearchQuery] = useState<string>("");
  // ── KPI drill-down ────────────────────────────────────────────────────
  // `?filter=incomplete[&missing=price|volume|fabric|bom]` arrives from the
  // `setup_completeness` card. The page never read `filter` before 2026-08-07,
  // so the link landed on the BEDFRAME tab of the full catalogue — the card
  // said "247 no BOM" and the grid showed every bedframe there is.
  //
  // The set is NOT re-derived here: "no BOM" means no ACTIVE bom_templates row
  // with non-empty wip_components, which is a table this page does not load.
  // The codes come from /api/products/setup-incomplete, which runs the four
  // predicates the metric counts with (SETUP_FIELD_SQL in kpi-metrics.ts).
  const [searchParams, setSearchParams] = useSearchParams();
  const setupDrillActive = searchParams.get("filter") === "incomplete";
  const missingParam = searchParams.get("missing");
  const missingField: SetupField | null = isSetupField(missingParam)
    ? missingParam
    : null;
  const { data: incompleteResp, loading: incompleteLoading } = useCachedJson<{
    success?: boolean;
    missing?: string;
    data?: { id: string; code: string; missing: SetupField[] }[];
  }>(
    setupDrillActive
      ? `/api/products/setup-incomplete${missingField ? `?missing=${missingField}` : ""}`
      : null,
  );
  // null = still loading; the grid keeps whatever it had rather than blinking
  // empty. An empty Set is a real answer (nothing is missing that field).
  const incompleteCodes = useMemo<Set<string> | null>(() => {
    if (!setupDrillActive) return null;
    if (!incompleteResp?.success || !Array.isArray(incompleteResp.data)) {
      return incompleteLoading ? null : new Set<string>();
    }
    return new Set(incompleteResp.data.map((r) => String(r.code)));
  }, [setupDrillActive, incompleteResp, incompleteLoading]);
  const clearSetupDrill = () => {
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete("filter");
        out.delete("missing");
        return out;
      },
      { replace: true },
    );
  };
  const [loading, setLoading] = useState(true);
  // Master Maintenance config (kv_config 'variants-config'). Variant editor
  // dialog reads divan/leg/gap/specials/sofa option lists from here so any
  // value the operator adds in the Maintenance tab is immediately
  // selectable as a default.
  const [maintenanceConfig, setMaintenanceConfig] = useState<MaintenanceConfig>(DEFAULT_MAINTENANCE_CONFIG);
  // Sofa seat-price columns follow the Maintenance "Sizes" list (numerically
  // sorted) — a size added there (e.g. 20") immediately gets its own column.
  const sofaHeightList = useMemo(
    () => sofaHeightsFromConfig(maintenanceConfig),
    [maintenanceConfig],
  );
  // Owner 2026-08-05: "我们卖价不需要给他们知道，我们只需要给他们看到成本就可以."
  // The API already withholds the figures, so these columns would render blank;
  // dropping them keeps the grid readable instead of leaving a row of dashes,
  // and takes the derived Margin / Labor-% columns with them (they are price
  // minus cost, so without a price there is nothing to show).
  const { hasPermission: hasPerm } = usePermissions();
  const canSeePricing = hasPerm("product-pricing", "read");
  const PRICE_COL_KEYS = useMemo(
    () => new Set(["price2", "price1", "basePrice", "marginP2", "marginP1", "laborPctP2", "laborPctP1"]),
    [],
  );
  const baseCols = useMemo(() => {
    const built = buildBaseCols(sofaHeightList);
    if (canSeePricing) return built;
    const out = {} as typeof built;
    for (const [cat, cols] of Object.entries(built)) {
      out[cat as keyof typeof built] = cols.filter(
        // H_COL_RE matches the dynamic sofa seat-height columns, which are
        // seat PRICES — same rule as the static price columns.
        (col) => !PRICE_COL_KEYS.has(col.key) && !H_COL_RE.test(col.key),
      );
    }
    return out;
  }, [sofaHeightList, canSeePricing, PRICE_COL_KEYS]);
  // Fabric list. Variant editor uses this for the Default Fabric
  // dropdown — same source as Sales Order's fabric picker so codes align.
  const [fabricList, setFabricList] = useState<{ code: string; description?: string }[]>([]);
  const [editingVariant, setEditingVariant] = useState<Product | null>(null);
  // PATCH-in-flight flag so the Save button can show a loading state and
  // prevent double-submit while the request is on the wire.
  const [variantSaving, setVariantSaving] = useState(false);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [editingM3, setEditingM3] = useState<string | null>(null);
  const [m3Input, setM3Input] = useState("");
  // Fabric Usage (meters of fabric per unit). Inline-editable exactly like
  // Unit M3 — click-to-edit, save on Enter/blur via PUT /api/products/:id.
  const [editingFabricUsage, setEditingFabricUsage] = useState<string | null>(null);
  const [fabricUsageInput, setFabricUsageInput] = useState("");
  const [editingPrice1, setEditingPrice1] = useState<string | null>(null);
  const [price1Input, setPrice1Input] = useState("");
  const [importing, setImporting] = useState(false);

  // ── Catalogue PDF export state ──────────────────────────────────────────
  const [exportingCatalogue, setExportingCatalogue] = useState(false);
  // Customer picker: null = closed, open = picker is showing
  const [showCatCustomerPicker, setShowCatCustomerPicker] = useState(false);
  const [catCustomerQuery, setCatCustomerQuery] = useState("");
  // Catalogue-export category filter: "ALL" or a product category (applies to
  // both the All-Customers and per-customer exports).
  const [catExportCategory, setCatExportCategory] = useState<string>("ALL");
  // Customer list loaded lazily when the picker opens
  const [catalogueCustomers, setCatalogueCustomers] = useState<
    Array<{ id: string; code: string; name: string }>
  >([]);
  const [loadingCatalogueCustomers, setLoadingCatalogueCustomers] = useState(false);

  // Sofa seat-size pricing editor
  const [editingSeatPrices, setEditingSeatPrices] = useState<string | null>(null);
  const [seatPriceInputs, setSeatPriceInputs] = useState<Record<string, string>>({});

  // Sofa price-matrix tier view. Switching the tier re-renders the same five
  // height columns with that tier's prices — the table layout is unchanged.
  // Persists to localStorage so the operator returns to whichever tier they
  // were last reviewing without having to re-pick on every page load. Reads
  // also tolerate the short "P1"/"P2"/"P3" form that an earlier build wrote
  // before the values were aligned with fabric_tracking.priceTier.
  const [sofaTier, setSofaTierState] = useState<SofaTier>(() => {
    if (typeof window === "undefined") return "PRICE_2";
    const saved = window.localStorage.getItem("hookka.products.sofaTier");
    if (saved === "PRICE_1" || saved === "PRICE_3" || saved === "PRICE_2") return saved;
    if (saved === "P1") return "PRICE_1";
    if (saved === "P3") return "PRICE_3";
    return "PRICE_2";
  });
  const setSofaTier = (t: SofaTier) => {
    setSofaTierState(t);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("hookka.products.sofaTier", t);
    }
  };

  // Analytic columns (Labor / Margin / Labor%) the owner toggles via the
  // catalog "Columns" chooser. Persisted per browser like sofaTier above so a
  // chosen layout survives reloads. Defaults from ANALYTIC_COLS[].defaultOn.
  const [analyticColVis, setAnalyticColVis] = useState<Record<string, boolean>>(
    () => {
      const base: Record<string, boolean> = {};
      for (const c of ANALYTIC_COLS) base[c.key] = c.defaultOn;
      if (typeof window === "undefined") return base;
      try {
        const saved = window.localStorage.getItem(
          "hookka.products.analyticCols",
        );
        if (saved) Object.assign(base, JSON.parse(saved) as Record<string, boolean>);
      } catch {
        /* ignore corrupt prefs — fall back to defaults */
      }
      return base;
    },
  );
  const toggleAnalyticCol = (key: string) => {
    setAnalyticColVis((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            "hookka.products.analyticCols",
            JSON.stringify(next),
          );
        } catch {
          /* ignore quota / disabled storage */
        }
      }
      return next;
    });
  };

  // Base-column visibility — the owner can hide ANY non-frozen base column
  // (Description, Category, Size, Price 1/2, Unit, Fabric, Total Min, Variants,
  // sofa seat columns). Keyed by column key across all categories (keys are
  // unique enough to share one map). Missing key ⇒ visible (default-on), so a
  // future-added column shows up without a migration. Persisted per browser.
  const [baseColVis, setBaseColVis] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = window.localStorage.getItem("hookka.products.baseCols");
      if (saved) return JSON.parse(saved) as Record<string, boolean>;
    } catch {
      /* ignore corrupt prefs */
    }
    return {};
  });
  // A column is shown unless it has been explicitly toggled off. Frozen /
  // always-on columns (Code) can never be hidden.
  const isBaseColVisible = (col: BaseCol) =>
    col.alwaysOn || col.frozen || baseColVis[col.key] !== false;
  const toggleBaseCol = (key: string) => {
    setBaseColVis((prev) => {
      const next = { ...prev, [key]: prev[key] === false ? true : false };
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            "hookka.products.baseCols",
            JSON.stringify(next),
          );
        } catch {
          /* ignore quota / disabled storage */
        }
      }
      return next;
    });
  };

  // Manual column ORDER — the owner can drag a column header left/right to
  // reorder it. Stored PER CATEGORY (the three categories define different
  // column sets) as an array of column keys in the desired visual order.
  // A key missing from the saved array keeps its registry/default position
  // (so a future-added column appears without a migration); unknown/stale
  // keys are ignored. The frozen "Product Code" column is ALWAYS pinned first
  // and can never be reordered past the freeze — applyColOrder() strips it
  // from the order list and re-prepends it. The saved order is applied to the
  // single ordered-column list (orderedCols) that drives the header row, the
  // per-column filter row, the grid-template-columns track string, AND every
  // body row's keyed cells — so header and body can never drift apart.
  const [colOrder, setColOrder] = useState<Record<string, string[]>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = window.localStorage.getItem("hookka.products.colOrder");
      if (saved) return JSON.parse(saved) as Record<string, string[]>;
    } catch {
      /* ignore corrupt prefs */
    }
    return {};
  });
  const persistColOrder = (next: Record<string, string[]>) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          "hookka.products.colOrder",
          JSON.stringify(next),
        );
      } catch {
        /* ignore quota / disabled storage */
      }
    }
  };
  // Reorder the visible-column key list `keys` to match the saved order for
  // `cat`. Frozen keys (Product Code) are always emitted first, in registry
  // order, regardless of where the saved order would place them. The rest keep
  // the saved relative order; any visible key not in the saved order is
  // appended in its original (registry/track) position so nothing disappears.
  const applyColOrder = (
    keys: string[],
    frozenKeys: Set<string>,
    cat: ProdCat,
  ): string[] => {
    const order = colOrder[cat] ?? [];
    const frozen = keys.filter((k) => frozenKeys.has(k));
    const movable = keys.filter((k) => !frozenKeys.has(k));
    if (order.length === 0) return [...frozen, ...movable];
    const inOrder = order.filter((k) => movable.includes(k));
    const rest = movable.filter((k) => !inOrder.includes(k));
    return [...frozen, ...inOrder, ...rest];
  };
  // Persist a new movable-key order for a category. `frozenKeys` are never
  // written into the saved order (they're always pinned first by applyColOrder).
  const setColOrderForCat = (cat: ProdCat, movableKeys: string[]) => {
    setColOrder((prev) => {
      const next = { ...prev, [cat]: movableKeys };
      persistColOrder(next);
      return next;
    });
  };
  // Native HTML5 drag-and-drop state for header reordering. Holds the key of
  // the column currently being dragged and the key it is hovering over, so the
  // header can render a drop indicator. Cleared on drop / dragend.
  const [draggingColKey, setDraggingColKey] = useState<string | null>(null);
  const [dragOverColKey, setDragOverColKey] = useState<string | null>(null);
  // Move `fromKey` to occupy `toKey`'s slot within the current ordered list of
  // movable keys for `cat`, then persist. Frozen keys are excluded from both
  // ends so Code stays pinned. No-op if either key is frozen or they're equal.
  const reorderColumn = (
    fromKey: string,
    toKey: string,
    orderedMovableKeys: string[],
    cat: ProdCat,
  ) => {
    if (fromKey === toKey) return;
    const from = orderedMovableKeys.indexOf(fromKey);
    const to = orderedMovableKeys.indexOf(toKey);
    if (from === -1 || to === -1) return;
    const next = [...orderedMovableKeys];
    next.splice(from, 1);
    next.splice(to, 0, fromKey);
    setColOrderForCat(cat, next);
  };

  // Per-column manual widths (px), set by dragging a header's right edge.
  // Keyed by column key; overrides the descriptor's minmax() track when set.
  // Persisted per browser so a tuned layout survives reloads. Clearing a key
  // (double-click the handle) restores the responsive minmax() default.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = window.localStorage.getItem("hookka.products.colWidths");
      if (saved) return JSON.parse(saved) as Record<string, number>;
    } catch {
      /* ignore corrupt prefs */
    }
    return {};
  });
  const persistColWidths = (next: Record<string, number>) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          "hookka.products.colWidths",
          JSON.stringify(next),
        );
      } catch {
        /* ignore quota / disabled storage */
      }
    }
  };
  // Track which column is being resized so a body-wide overlay can capture the
  // drag (and so we can suppress the row click while dragging a handle).
  const colResizeRef = useRef<{
    key: string;
    startX: number;
    startW: number;
  } | null>(null);
  const beginColResize = (
    e: React.MouseEvent,
    key: string,
    currentW: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    colResizeRef.current = { key, startX: e.clientX, startW: currentW };
    const onMove = (ev: MouseEvent) => {
      const st = colResizeRef.current;
      if (!st) return;
      const w = Math.max(48, Math.round(st.startW + (ev.clientX - st.startX)));
      setColWidths((prev) => ({ ...prev, [st.key]: w }));
    };
    const onUp = () => {
      const st = colResizeRef.current;
      colResizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      if (st) {
        setColWidths((prev) => {
          persistColWidths(prev);
          return prev;
        });
      }
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  // Double-click a resize handle to clear the manual width and return the
  // column to its responsive minmax() default.
  const clearColWidth = (key: string) => {
    setColWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      persistColWidths(next);
      return next;
    });
  };

  // Per-column client-side sort for the SKU Master table. null = natural
  // (load) order. Only a safe subset of columns is sortable — see sortValueFor.
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const toggleSort = (key: string) => {
    setSortCol((prevCol) => {
      if (prevCol !== key) {
        setSortDir("asc");
        return key;
      }
      // same column: asc → desc → off
      if (sortDir === "asc") {
        setSortDir("desc");
        return key;
      }
      setSortDir("asc");
      return null;
    });
  };

  // Per-column text filter for the SKU Master table. Keyed by column key
  // (shared across categories like colWidths / baseColVis). A non-empty value
  // means "show only rows whose value for that column contains this text"
  // (case-insensitive substring). EVERY column — base and analytic — supports
  // a filter via the inline filter row under the header; the matching string
  // for each column comes from filterValueFor(). Persisted per browser so a
  // filtered view survives reloads, matching the sort / width / visibility
  // prefs. Empty string clears that column's filter.
  const [colFilters, setColFiltersState] = useState<Record<string, string>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const saved = window.localStorage.getItem("hookka.products.colFilters");
        if (saved) return JSON.parse(saved) as Record<string, string>;
      } catch {
        /* ignore corrupt prefs */
      }
      return {};
    },
  );
  const setColFilter = (key: string, value: string) => {
    setColFiltersState((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            "hookka.products.colFilters",
            JSON.stringify(next),
          );
        } catch {
          /* ignore quota / disabled storage */
        }
      }
      return next;
    });
  };
  const clearAllColFilters = () => {
    setColFiltersState({});
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem("hookka.products.colFilters");
      } catch {
        /* ignore */
      }
    }
  };
  // Whether the inline per-column filter row is shown. Defaults off so the
  // table opens clean; toggled by the "Filter" button in the toolbar. Any
  // active filter keeps the row visible regardless.
  const [showFilterRow, setShowFilterRow] = useState(false);

  const [showColMenu, setShowColMenu] = useState(false);

  // Master price-history dialog. Holds the product whose history is open;
  // null when the dialog is closed.
  const [scheduleProductId, setScheduleProductId] = useState<string | null>(
    null,
  );
  const scheduleProduct = useMemo(
    () => products.find((p) => p.id === scheduleProductId) ?? null,
    [products, scheduleProductId],
  );

  // Bulk-edit pending changes. Every inline price edit (BF Price 2 / Price 1
  // and Sofa seat-height cells) writes here instead of going straight to the
  // products table. Keyed by productId so multiple cells in the same SKU
  // collapse into one product_prices history row at save time. The "Save N
  // changes" floating button below opens a modal that asks for an
  // effective_from date and posts one row per dirty product.
  type DirtyEdit = {
    productId: string;
    basePriceSen?: number;
    price1Sen?: number | null;
    // Full updated seatHeightPrices array for the product — the bulk save
    // POST sends the complete snapshot so the new history row's NULL
    // semantics (= inherit from products) don't accidentally clear cells
    // that weren't edited.
    seatHeightPrices?: { height: string; priceSen: number; tier?: SofaTier }[];
    // Fabric (m) per unit. NOT a price-history concept — it lives on the
    // products row, so the bulk Save flow commits it via PUT /api/products/:id
    // (no effective-date), separate from the price_prices history POST. Gated
    // behind editMode exactly like the price cells, so there are no naked
    // auto-saves on blur anymore.
    fabricUsage?: number;
    // Unit (m³) per unit. Same story as fabricUsage — a products-row field,
    // committed via PUT /api/products/:id on Save. Previously this cell fired
    // an immediate PUT on blur (a "naked edit"); it now defers to the bulk
    // Save flow and is gated behind editMode like every other cell.
    unitM3?: number;
  };
  const [dirtyEdits, setDirtyEdits] = useState<Map<string, DirtyEdit>>(new Map());
  const [showBulkSaveDialog, setShowBulkSaveDialog] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  // Page-level edit mode. Cells are read-only when off; click-to-edit
  // triggers no-op outside edit mode so the table is safe to browse.
  const [editMode, setEditMode] = useState(false);
  // Bulk save form state — surfaced when the user clicks "Save N changes".
  // Effective date defaults to today; past dates are allowed for backfill,
  // future dates park the row as Pending until that date passes.
  const [bulkEffectiveFrom, setBulkEffectiveFrom] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [bulkNotes, setBulkNotes] = useState("");

  function recordDirty(productId: string, patch: Partial<DirtyEdit>) {
    setDirtyEdits((prev) => {
      const next = new Map(prev);
      const existing = next.get(productId) ?? { productId };
      next.set(productId, { ...existing, ...patch });
      return next;
    });
  }
  function discardDirty() {
    setDirtyEdits(new Map());
    setEditMode(false);
    setBulkNotes("");
    // Reload from server to undo the optimistic local edits.
    void reloadProductsAfterSchedule();
  }

  // Bulk save — dispatch one POST /api/products/:id/prices per dirty
  // product with a single shared effective date. NULL on a field means
  // "inherit from products" at resolve time; we always pass the FULL
  // intended state (current values for unedited fields) so the new
  // history row is a complete snapshot.
  async function bulkSave() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bulkEffectiveFrom)) {
      alert("Effective date must be YYYY-MM-DD.");
      return;
    }
    if (dirtyEdits.size === 0) return;
    setBulkSaving(true);
    try {
      const requests: Promise<{ ok: boolean; status: number; productId: string }>[] = [];
      for (const d of dirtyEdits.values()) {
        const prod = products.find((p) => p.id === d.productId);
        // A row can be dirty for price fields, for fabric, or both. Price
        // fields land in product_prices history (effective-dated); fabric
        // lives on the products row. Dispatch each independently so a
        // fabric-only edit doesn't manufacture a spurious price-history row.
        const hasPriceDirt =
          d.basePriceSen !== undefined ||
          d.price1Sen !== undefined ||
          d.seatHeightPrices !== undefined;
        // Fabric (m) and Unit (m³) are both products-row fields — collapse
        // them into ONE PUT so two edits to the same row don't race.
        const hasProductRowDirt =
          d.fabricUsage !== undefined || d.unitM3 !== undefined;

        if (hasPriceDirt) {
          // Compose a complete-state body so the resolver doesn't pull a
          // missing field from the products table at a stale moment.
          const body: Record<string, unknown> = {
            effectiveFrom: bulkEffectiveFrom,
            notes: bulkNotes || null,
            basePriceSen:
              d.basePriceSen !== undefined
                ? d.basePriceSen
                : (prod?.basePriceSen ?? null),
            price1Sen:
              d.price1Sen !== undefined
                ? d.price1Sen
                : (prod?.price1Sen ?? null),
            seatHeightPrices:
              d.seatHeightPrices !== undefined
                ? d.seatHeightPrices
                : (prod?.seatHeightPrices ?? null),
          };
          requests.push(
            fetch(`/api/products/${d.productId}/prices`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }).then((r) => ({ ok: r.ok, status: r.status, productId: d.productId })),
          );
        }

        if (hasProductRowDirt) {
          // Fabric (m) / Unit (m³) are products-row fields, committed here via
          // the same PUT the inline cells used to fire on blur — except now
          // it's deferred to Save so there are no naked auto-saves. PUT merges
          // a partial body, so only the edited field(s) are sent and every
          // other field stays intact.
          const rowBody: Record<string, number> = {};
          if (d.fabricUsage !== undefined) rowBody.fabricUsage = d.fabricUsage;
          if (d.unitM3 !== undefined) rowBody.unitM3 = d.unitM3;
          requests.push(
            fetch(`/api/products/${d.productId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(rowBody),
            }).then((r) => ({ ok: r.ok, status: r.status, productId: d.productId })),
          );
        }
      }
      // No-op guard: if every dirty entry somehow carried no committable
      // field, fall through to the cleanup below rather than awaiting nothing.
      const results = await Promise.all(requests);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        alert(
          `${failed.length} of ${results.length} updates failed. The successful ones were saved.`,
        );
      }
      // Fabric (m) feeds BOM material maths, so drop those caches too — the
      // old inline blur-PUT did this, and the bulk path now owns the write.
      invalidateCachePrefix("/api/bom");
      invalidateCachePrefix("/api/bom-master-templates");
      // Wipe local dirty state and reload so the table reflects the new
      // currently-effective price (or shows the Pending badge if the
      // effective date is in the future) and the committed fabric value.
      setDirtyEdits(new Map());
      setShowBulkSaveDialog(false);
      setEditMode(false);
      setBulkNotes("");
      await reloadProductsAfterSchedule();
    } finally {
      setBulkSaving(false);
    }
  }
  // Helpers for the cell-level "is this dirty?" indicator. Sofa lookup is
  // (height, tier)-aware so editing P1 doesn't paint a P2 cell yellow.
  const isProductDirty = (productId: string) => dirtyEdits.has(productId);
  const isSeatCellDirty = (
    productId: string,
    height: string,
    tier: SofaTier,
  ) => {
    const d = dirtyEdits.get(productId);
    if (!d || !d.seatHeightPrices) return false;
    return d.seatHeightPrices.some(
      (s) => s.height === height && (s.tier ?? "PRICE_2") === tier,
    );
  };
  const isFabricDirty = (productId: string) =>
    dirtyEdits.get(productId)?.fabricUsage !== undefined;

  // ── Fabric (m) cell ────────────────────────────────────────────────────
  // Shared by BEDFRAME / SOFA and ACCESSORY rows. NO NAKED EDITS: outside
  // editMode this is plain read-only text (no click target), exactly like the
  // price cells. Inside editMode it is click-to-edit, and committing the input
  // DEFERS to the bulk Save flow via recordDirty({ fabricUsage }) — it no
  // longer fires an immediate PUT on blur. The dirty value shadows the cfg/
  // product display so the edit is visible (highlighted) until Save commits it.
  const renderFabricCell = (p: Product, cfg: ProductDeptConfig | undefined) => {
    const dirty = isFabricDirty(p.id);
    const stored = (cfg?.fabricUsage ?? p.fabricUsage) || 0;
    // While a row is dirty for fabric, show the pending value (p.fabricUsage is
    // updated optimistically on commit) instead of the cfg snapshot.
    const shown = dirty ? p.fabricUsage || 0 : stored;
    const hint = fabricWidthHint(p.category);
    return (
      <div
        className="px-3 py-1.5 text-right"
        onClick={(e) => e.stopPropagation()}
      >
        {editMode && editingFabricUsage === p.id ? (
          <input
            autoFocus
            type="number"
            onFocus={(e) => e.currentTarget.select()}
            value={fabricUsageInput}
            onChange={(e) => setFabricUsageInput(e.target.value)}
            onBlur={() => {
              const val = parseFloat(fabricUsageInput || "0") || 0;
              setEditingFabricUsage(null);
              // Local-only optimistic update + queue for the bulk Save. No
              // server write here — Save commits via PUT /api/products/:id.
              setProducts((prev) =>
                prev.map((pr) => (pr.id === p.id ? { ...pr, fabricUsage: val } : pr)),
              );
              recordDirty(p.id, { fabricUsage: val });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingFabricUsage(null);
            }}
            className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
            step="0.1"
            min="0"
          />
        ) : (
          <div className="flex items-baseline justify-end gap-1">
            {editMode ? (
              <button
                onClick={() => {
                  setEditingFabricUsage(p.id);
                  setFabricUsageInput(String(shown));
                }}
                className={`text-sm tabular-nums rounded px-1.5 transition-colors ${
                  dirty
                    ? "bg-[#FEF7E0] text-[#9C6F1E] font-semibold"
                    : "text-[#111827] hover:text-[#6B5C32] hover:underline cursor-pointer"
                }`}
                title="Click to edit fabric (m)"
              >
                {shown} m
              </button>
            ) : (
              <span className="text-sm tabular-nums text-[#111827]">{shown} m</span>
            )}
            {hint && (
              <span className="text-[10px] text-[#9CA3AF]">· {hint}</span>
            )}
          </div>
        )}
      </div>
    );
  };

  const isUnitM3Dirty = (productId: string) =>
    dirtyEdits.get(productId)?.unitM3 !== undefined;

  // ── Unit (m³) cell ─────────────────────────────────────────────────────
  // Shared by BEDFRAME / SOFA and ACCESSORY rows. Same NO-NAKED-EDITS contract
  // as renderFabricCell: read-only text outside editMode, click-to-edit inside
  // it, and the commit DEFERS to the bulk Save flow via recordDirty({ unitM3 })
  // instead of firing an immediate PUT on blur (which was the previous naked
  // auto-save). The dirty value shadows the cfg/product display until Save.
  const renderUnitM3Cell = (p: Product, cfg: ProductDeptConfig | undefined) => {
    const dirty = isUnitM3Dirty(p.id);
    const stored = cfg?.unitM3 ?? p.unitM3 ?? 0;
    const shown = dirty ? (p.unitM3 ?? 0) : stored;
    return (
      <div
        className="px-3 py-1.5 text-right"
        onClick={(e) => e.stopPropagation()}
      >
        {editMode && editingM3 === p.id ? (
          <input
            autoFocus
            type="number"
            onFocus={(e) => e.currentTarget.select()}
            value={m3Input}
            onChange={(e) => setM3Input(e.target.value)}
            onBlur={() => {
              const val = parseFloat(m3Input || "0") || 0;
              setEditingM3(null);
              // Local-only optimistic update + queue for the bulk Save. No
              // server write here — Save commits via PUT /api/products/:id.
              setProducts((prev) =>
                prev.map((pr) => (pr.id === p.id ? { ...pr, unitM3: val } : pr)),
              );
              recordDirty(p.id, { unitM3: val });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingM3(null);
            }}
            className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
            step="0.001"
            min="0"
          />
        ) : editMode ? (
          <button
            onClick={() => {
              setEditingM3(p.id);
              setM3Input(shown.toFixed(3));
            }}
            className={`text-sm tabular-nums rounded px-1.5 transition-colors ${
              dirty
                ? "bg-[#FEF7E0] text-[#9C6F1E] font-semibold"
                : "text-[#111827] hover:text-[#6B5C32] hover:underline cursor-pointer"
            }`}
            title="Click to edit Unit (m³)"
          >
            {shown.toFixed(3)}
          </button>
        ) : (
          <span className="text-sm tabular-nums text-[#111827]" title={shown.toFixed(3)}>
            {shown.toFixed(3)}
          </span>
        )}
      </div>
    );
  };

  // Reload products when a price change is scheduled or deleted so the
  // Pending badge + currently-effective price reflect the latest history.
  // Reuses the same cached endpoint the initial load uses so a future
  // background refresh sees the freshest data on its next read too.
  const reloadProductsAfterSchedule = async () => {
    invalidateCachePrefix("/api/products");
    const pData = await cachedFetchJson<{ success?: boolean; data?: Product[] }>(
      "/api/products",
    ).catch(() => null);
    if (pData?.success) setProducts((pData.data as Product[]) ?? []);
  };

  // ---------- CSV helpers ----------
  function csvEscape(val: string | number | undefined | null): string {
    const s = val == null ? "" : String(val);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = false; }
        } else {
          cur += ch;
        }
      } else {
        if (ch === ",") { out.push(cur); cur = ""; }
        else if (ch === '"') { inQuotes = true; }
        else { cur += ch; }
      }
    }
    out.push(cur);
    return out;
  }

  const EXPORT_COLUMNS = [
    "code", "name", "category", "description", "baseModel",
    "sizeCode", "sizeLabel", "fabricUsage", "unitM3", "status",
    "costPriceSen", "basePriceSen", "productionTimeMinutes",
  ] as const;

  // ── Catalogue PDF helpers ──────────────────────────────────────────────

  // Build CatalogueModelEntry[] from current products + pre-fetched photos map.
  // photoMap: resourceId (familyKey) → first FileAsset id.
  // customerAssignedFamilies: when provided, only include families in this set.
  async function buildCatalogueModels(
    photoMap: Record<string, string>,
    customerAssignedFamilies?: Set<string>,
  ) {
    // Group products by FAMILY (mirrors catalog.tsx buildModelGroups logic, one
    // tile per family) so the PDF agrees with the Catalog grid + family photos.
    const groups = new Map<string, Product[]>();
    for (const p of products) {
      const key = familyOf(p.code) || p.code;
      if (customerAssignedFamilies && !customerAssignedFamilies.has(key)) continue;
      const arr = groups.get(key);
      if (arr) arr.push(p);
      else groups.set(key, [p]);
    }
    const modelGroups = Array.from(groups.entries()).map(([familyKey, ps]) => ({
      familyKey,
      category: ps[0].category,
      name: ps[0].name,
      variantCount: ps.length,
      sizeLabels: Array.from(new Set(ps.map((p) => p.sizeLabel).filter(Boolean))).sort(),
    }));
    // Sort: category first, then family
    modelGroups.sort((a, b) =>
      a.category !== b.category
        ? a.category.localeCompare(b.category)
        : a.familyKey.localeCompare(b.familyKey),
    );

    const { fetchModelPhotoBytes } = await import("@/lib/generate-product-catalogue-pdf");

    const entries = await Promise.all(
      modelGroups.map(async (g) => {
        const fileId = photoMap[g.familyKey];
        let photoBytes: Uint8Array | null = null;
        let photoMimeType = "image/jpeg";
        if (fileId) {
          const result = await fetchModelPhotoBytes(fileId);
          if (result) {
            photoBytes = result.bytes;
            photoMimeType = result.mimeType;
          }
        }
        return {
          // The PDF's CatalogueModelEntry calls its heading field "baseModel";
          // feed it the family key so the PDF heading matches the Catalog tile.
          baseModel: g.familyKey,
          category: g.category,
          name: g.name,
          variantCount: g.variantCount,
          sizeLabels: g.sizeLabels,
          photoBytes,
          photoMimeType,
        };
      }),
    );
    return entries;
  }

  async function fetchPhotoMap(): Promise<Record<string, string>> {
    try {
      const res = await fetch("/api/files?resourceType=modular");
      const j = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: Array<{ id: string; resourceId: string; sortOrder?: number | null; uploadedAt?: string }>;
      } | null;
      if (res.ok && j?.success && Array.isArray(j.data)) {
        // Sort cover-first (lowest sort_order, then newest) so the cover photo
        // chosen in the Catalog is the exact one embedded in the PDF.
        const sorted = j.data.slice().sort((a, b) => {
          const ao = a.sortOrder ?? 1e9;
          const bo = b.sortOrder ?? 1e9;
          if (ao !== bo) return ao - bo;
          return (b.uploadedAt || "").localeCompare(a.uploadedAt || "");
        });
        const map: Record<string, string> = {};
        for (const f of sorted) {
          // First per familyKey (resourceId) after the cover-first sort = the cover photo.
          if (!map[f.resourceId]) map[f.resourceId] = f.id;
        }
        return map;
      }
    } catch {
      // fall through
    }
    return {};
  }

  // Full catalogue export (respects the active category filter in catalog view)
  async function handleExportCatalogue(catFilter?: string) {
    setExportingCatalogue(true);
    try {
      const photoMap = await fetchPhotoMap();
      const entries = await buildCatalogueModels(photoMap);
      const { default: generateProductCataloguePdf } = await import(
        "@/lib/generate-product-catalogue-pdf"
      );
      const doc = generateProductCataloguePdf(entries, {
        categoryFilter: catFilter,
      });
      const ts = new Date().toISOString().slice(0, 10);
      const catTag = catFilter ? `-${catFilter}` : "";
      doc.save(`Product-Catalogue${catTag}-${ts}.pdf`);
    } catch (err) {
      console.error("[Catalogue PDF]", err);
      toast.error("Failed to generate catalogue PDF.");
    } finally {
      setExportingCatalogue(false);
    }
  }

  // Load customers for the picker
  async function openCatalogueCustomerPicker() {
    setShowCatCustomerPicker(true);
    if (catalogueCustomers.length > 0) return; // already loaded
    setLoadingCatalogueCustomers(true);
    try {
      const res = await fetch("/api/customers");
      const j = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: Array<{ id: string; code: string; name: string }>;
      } | null;
      if (res.ok && j?.success && Array.isArray(j.data)) {
        setCatalogueCustomers(j.data);
      }
    } catch {
      // ignore
    } finally {
      setLoadingCatalogueCustomers(false);
    }
  }

  // Per-customer catalogue export
  async function handleExportCustomerCatalogue(
    customer: { id: string; code: string; name: string },
    catFilter?: string,
  ) {
    setShowCatCustomerPicker(false);
    setCatCustomerQuery("");
    setExportingCatalogue(true);
    try {
      // 1. Fetch the customer's assigned products (reuse the customer-quotation
      //    API which already resolves customer_products joined to products).
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(
        `/api/customer-quotation?customerId=${encodeURIComponent(customer.id)}&asOf=${today}`,
      );
      if (!res.ok) {
        toast.error("Could not fetch customer assigned products.");
        return;
      }
      const j = (await res.json()) as {
        success: boolean;
        data?: { products?: Array<{ code: string }> };
        error?: string;
      };
      if (!j.success || !j.data?.products) {
        toast.error(j.error || "No assigned products found for this customer.");
        return;
      }
      // Derive the set of FAMILIES the customer has at least one SKU in
      // (same familyOf rule as the Catalog grid, so the filter matches).
      const assignedFamilies = new Set<string>(
        j.data.products.map((p) => familyOf(p.code) || p.code),
      );
      if (assignedFamilies.size === 0) {
        toast.error(`${customer.name} has no assigned SKUs.`);
        return;
      }

      const photoMap = await fetchPhotoMap();
      const entries = await buildCatalogueModels(photoMap, assignedFamilies);
      if (entries.length === 0) {
        toast.error("No matching models found in the product catalogue.");
        return;
      }

      const { default: generateProductCataloguePdf } = await import(
        "@/lib/generate-product-catalogue-pdf"
      );
      const doc = generateProductCataloguePdf(entries, {
        customerName: customer.name,
        categoryFilter: catFilter,
      });
      const safeCode = (customer.code || customer.name).replace(/[^a-zA-Z0-9_-]+/g, "_");
      const ts = new Date().toISOString().slice(0, 10);
      const catTag = catFilter ? `-${catFilter}` : "";
      doc.save(`Product-Catalogue-${safeCode}${catTag}-${ts}.pdf`);
    } catch (err) {
      console.error("[Customer Catalogue PDF]", err);
      toast.error("Failed to generate customer catalogue PDF.");
    } finally {
      setExportingCatalogue(false);
    }
  }

  function handleExportCsv() {
    const header = EXPORT_COLUMNS.join(",");
    const rows = products.map((p) =>
      EXPORT_COLUMNS.map((k) => csvEscape((p as unknown as Record<string, string | number | undefined>)[k])).join(",")
    );
    const csv = [header, ...rows].join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().slice(0, 10);
    a.download = `products-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleImportCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so same file can be re-picked
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length < 2) {
        toast.warning("CSV is empty or only has headers.");
        return;
      }
      const headers = parseCsvLine(lines[0]).map((h) => h.trim());
      const codeIdx = headers.indexOf("code");
      if (codeIdx === -1) {
        toast.warning("CSV must include a 'code' column.");
        return;
      }

      const numericFields = new Set([
        "fabricUsage", "unitM3", "costPriceSen", "basePriceSen", "productionTimeMinutes",
      ]);

      const codeToProduct = new Map(products.map((p) => [p.code, p]));
      let updated = 0;
      let skipped = 0;
      const updatedProducts = [...products];

      for (let li = 1; li < lines.length; li++) {
        const cols = parseCsvLine(lines[li]);
        const code = (cols[codeIdx] || "").trim();
        if (!code) continue;
        const existing = codeToProduct.get(code);
        if (!existing) { skipped++; continue; }

        const patch: Record<string, string | number> = {};
        headers.forEach((h, i) => {
          if (h === "code" || h === "id") return;
          const raw = cols[i];
          if (raw === undefined) return;
          const trimmed = raw.trim();
          if (numericFields.has(h)) {
            if (trimmed === "") return;
            const n = Number(trimmed);
            if (!Number.isNaN(n)) patch[h] = n;
          } else {
            patch[h] = trimmed;
          }
        });

        try {
          const data = await fetchJson(`/api/products/${existing.id}`, ProductMutationSchema, {
            method: "PUT",
            body: patch,
          });
          if (data.success && data.data) {
            const idx = updatedProducts.findIndex((p) => p.id === existing.id);
            if (idx !== -1) updatedProducts[idx] = data.data as Product;
            updated++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }

      invalidateCachePrefix("/api/products");
      invalidateCachePrefix("/api/bom");
      invalidateCachePrefix("/api/bom-master-templates");
      setProducts(updatedProducts);
      toast.success(`Updated ${updated} products, skipped ${skipped} unknown codes.`);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    async function load() {
      try {
        const [pData, cData] = await Promise.all([
          cachedFetchJson<{ success?: boolean; data?: Product[] }>("/api/products"),
          cachedFetchJson<{ success?: boolean; data?: ProductDeptConfig[] }>("/api/product-configs"),
        ]);
        if (pData?.success) setProducts(pData.data as Product[]);
        if (cData?.success) setConfigs(cData.data as ProductDeptConfig[]);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Mobile deep-link auto-export — when /products is opened with
  // ?autoCustomerCatalogueId=<id>, fetch that customer + immediately
  // trigger the per-customer catalogue PDF. Used by /m/customers/:id's
  // "Export Catalogue" extraAction so mobile users get a one-tap export
  // (the heavy fetchPhotoMap + buildCatalogueModels + pdf-lib pipeline
  // stays on this page). One-shot — strips the param after firing.
  useEffect(() => {
    if (loading || products.length === 0) return;
    const url = new URL(window.location.href);
    const wantId = url.searchParams.get("autoCustomerCatalogueId");
    if (!wantId) return;
    url.searchParams.delete("autoCustomerCatalogueId");
    window.history.replaceState(null, "", url.toString());
    void (async () => {
      try {
        const res = await fetch(`/api/customers/${encodeURIComponent(wantId)}`);
        const j = (await res.json().catch(() => null)) as
          | { success?: boolean; data?: { id: string; code: string; name: string } }
          | null;
        if (res.ok && j?.success && j.data) {
          await handleExportCustomerCatalogue(j.data);
        } else {
          toast.error("Could not fetch that customer.");
        }
      } catch {
        toast.error("Catalogue export failed.");
      }
    })();
    // One-shot deep-link export — the param is stripped above, so re-runs
    // no-op; export handler + toast identities deliberately not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, products.length]);


  const configMap = useMemo(() => {
    const map = new Map<string, ProductDeptConfig>();
    configs.forEach((c) => map.set(c.productCode, c));
    return map;
  }, [configs]);

  // Hydrate maintenance config + fabric list once at mount. Both feed the
  // Variant Defaults dialog dropdowns. Maintenance config also live-syncs
  // via the kv-config subscription below so adding a divan height in the
  // Maintenance tab makes it immediately selectable here without a
  // refresh.
  useEffect(() => {
    setMaintenanceConfig(parseMaintenanceConfig(getVariantsConfigSync()));
    let cancelled = false;
    void fetchVariantsConfig().then((v) => {
      if (cancelled) return;
      setMaintenanceConfig(parseMaintenanceConfig(v));
    });
    const off = subscribeKvConfig(VARIANTS_CONFIG_KEY, (v) => {
      setMaintenanceConfig(parseMaintenanceConfig(v as VariantsConfig | null));
    });
    void cachedFetchJson<{ data?: { code: string; fabricDescription?: string }[] }>("/api/fabric-tracking")
      .then((d) => {
        if (cancelled) return;
        setFabricList(
          (d?.data ?? []).map((f) => ({ code: f.code, description: f.fabricDescription })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Persist updated default variants to /api/products/:id and refresh the
  // local product row so the badge + expand panel reflect the saved state
  // immediately. PATCH (well, PUT — that's what /api/products/:id supports)
  // is fire-once-and-await so the dialog stays open until persisted.
  const saveDefaultVariants = useCallback(async (
    productId: string,
    defaults: ProductDefaultVariants,
  ) => {
    setVariantSaving(true);
    try {
      // 2026-05-27 verifiedSave migration. Variant defaults pre-fill SO
      // lines, so a stale-cache silent overwrite would let the operator
      // think the defaults persisted when they didn't. Readback compares
      // the product code (identity guard) — the nested defaultVariants
      // shape is too varied for shallow equality.
      const result = await verifiedSave<Product>({
        endpoint: `/api/products/${productId}`,
        method: "PUT",
        body: { defaultVariants: defaults },
        readback: async () => {
          const r = await fetch(`/api/products/${productId}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: Product } | Product;
          return (j as { data?: Product })?.data ?? (j as Product) ?? null;
        },
        expect: { id: productId },
      });
      if (!result.ok) {
        if (result.reason === "mismatch") toast.error(formatMismatchError(result.diffs));
        else if (result.reason === "http") {
          let parsedErr = result.body;
          try {
            const j = JSON.parse(result.body) as { error?: string };
            if (j.error) parsedErr = j.error;
          } catch { /* keep raw body */ }
          toast.error(parsedErr || `Save failed (HTTP ${result.status})`);
        } else {
          toast.error(`Save failed: ${result.details}`);
        }
        return false;
      }
      // Patch local state — product row badge updates without a full refetch.
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, defaultVariants: defaults } : p,
        ),
      );
      invalidateCachePrefix("/api/products");
      return true;
    } finally {
      setVariantSaving(false);
    }
  }, [toast]);

  const categories = useMemo(() => {
    const cats = new Set(products.map((p) => p.category));
    return Array.from(cats).sort();
  }, [products]);

  // When searchQuery is empty, filter by the active category tab. When the
  // user types anything, cross-category search takes over so typing "pillow"
  // finds the accessory rows even while the BEDFRAME tab is active — no
  // more "why can't I find sofas while on bedframe" surprises.
  const filteredRaw = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // KPI drill-down: show exactly the SKUs the card counted, ACROSS
    // CATEGORIES. The category tab is deliberately ignored — the metric counts
    // every ACTIVE product, and the gap is overwhelmingly sofa components, so
    // honouring the default BEDFRAME tab would show a fraction of the number
    // that led here. This is the same cross-category behaviour the search box
    // already has, for the same reason.
    if (incompleteCodes !== null) {
      const inDrill = products.filter((p) => incompleteCodes.has(p.code));
      if (!q) return inDrill;
      return inDrill.filter((p) => {
        const hay = [p.code, p.name, p.description, p.baseModel, p.category]
          .map((v) => (v || "").toLowerCase())
          .join(" ");
        return hay.includes(q);
      });
    }
    if (!q) return products.filter((p) => p.category === categoryFilter);
    return products.filter((p) => {
      const hay = [p.code, p.name, p.description, p.baseModel, p.category]
        .map((v) => (v || "").toLowerCase())
        .join(" ");
      return hay.includes(q);
    });
  }, [products, categoryFilter, searchQuery, incompleteCodes]);

  // Numeric value for an analytic column (labor / margin / labor%) for a
  // product, so the analytic columns are sortable AND filterable with the
  // SAME maths the body cells render. Mirrors the body-cell logic: the
  // selling price compared against is the tier-rep price for sofas, Price 1
  // for the *P1 columns, else basePriceSen. Returns null when the value can't
  // be computed (no minutes / no price) so the caller renders "—" and sorts
  // it to the bottom.
  const analyticValueFor = useCallback(
    (p: Product, key: string): number | null => {
      const cfg = configMap.get(p.code);
      const totalMin =
        p.productionTimeMinutes > 0
          ? p.productionTimeMinutes
          : cfg
            ? totalConfigMinutes(cfg)
            : 0;
      const laborSen = laborCostSenForMinutes(totalMin);
      if (key === "labor") return laborSen > 0 ? laborSen : null;
      const isSofaCat = p.category === "SOFA";
      const sofaRep = isSofaCat
        ? ((p.seatHeightPrices || [])
            .filter((s) => entryTier(s.tier) === sofaTier && s.priceSen > 0)
            .sort((a, b) => a.priceSen - b.priceSen)[0]?.priceSen ?? 0)
        : 0;
      const mainPrice = isSofaCat ? sofaRep : (p.basePriceSen ?? p.costPriceSen ?? 0);
      const priceFor =
        key === "marginP1" || key === "laborPctP1" ? (p.price1Sen ?? 0) : mainPrice;
      if (priceFor <= 0 || laborSen <= 0) return null;
      if (key === "laborPctP2" || key === "laborPctP1")
        return (laborSen / priceFor) * 100;
      // marginP2 / marginP1
      return priceFor - laborSen;
    },
    [configMap, sofaTier],
  );

  // Per-column sort value for a product. Returns string | number; the
  // comparator below localeCompares strings and subtracts numbers. Pricing /
  // fabric / minutes read the same effective values the cells render so the
  // sort matches what the eye sees. Sofa height columns sort by that seat's
  // price in the active tier; the sofa "price" proxy uses the lowest tier
  // price (mirrors the analytic columns).
  const sortValueFor = useCallback(
    (p: Product, key: string): string | number => {
      const cfg = configMap.get(p.code);
      const seat = (h: string) =>
        (p.seatHeightPrices || []).find(
          (s) =>
            String(s.height ?? "").replace('"', "").trim() === h &&
            entryTier(s.tier) === sofaTier,
        )?.priceSen ?? -1;
      // Analytic columns (labor / margin / labor%) are sortable too. Unset
      // ("—") values map to -Infinity so they cluster together at the start in
      // ascending order — mirroring the sofa-height columns' existing missing=
      // -1 convention so sort behaviour stays consistent across the table.
      if (
        key === "labor" ||
        key === "marginP2" ||
        key === "marginP1" ||
        key === "laborPctP2" ||
        key === "laborPctP1"
      ) {
        const v = analyticValueFor(p, key);
        return v == null ? Number.NEGATIVE_INFINITY : v;
      }
      switch (key) {
        case "code":
          return (p.code || "").toLowerCase();
        case "description":
          return (p.name || p.description || "").toLowerCase();
        case "category":
          return (p.category || "").toLowerCase();
        case "size":
          return (p.sizeLabel || "").toLowerCase();
        case "model":
          return (p.baseModel || "").toLowerCase();
        case "price2":
        case "basePrice":
          return p.basePriceSen ?? p.costPriceSen ?? 0;
        case "price1":
          return p.price1Sen ?? 0;
        case "unitM3":
          return cfg?.unitM3 ?? p.unitM3 ?? 0;
        case "fabric":
          return cfg?.fabricUsage ?? p.fabricUsage ?? 0;
        case "totalMin":
          return p.productionTimeMinutes > 0
            ? p.productionTimeMinutes
            : cfg
              ? totalConfigMinutes(cfg)
              : 0;
        case "variants":
          return (
            (p.defaultVariants?.fabricCode ? 1 : 0) +
            (p.defaultVariants?.divanHeight ? 1 : 0) +
            (p.defaultVariants?.legHeight ? 1 : 0) +
            (p.defaultVariants?.gap ? 1 : 0) +
            (p.defaultVariants?.seatHeight ? 1 : 0) +
            ((p.defaultVariants?.specials?.length ?? 0) > 0 ? 1 : 0)
          );
        default: {
          // Dynamic sofa height columns (h20, h24, … from Maintenance Sizes).
          const m = H_COL_RE.exec(key);
          if (m) return seat(m[1]);
          return 0;
        }
      }
    },
    [configMap, sofaTier, analyticValueFor],
  );

  // Display string for a column used by the per-column filter row. Mirrors
  // the rendered cell text so a filter matches what the operator sees:
  // currency columns filter on the formatted "RM …" string, the variants
  // column on its "N set" / "Configure" label, analytic columns on their
  // numeric/"—" rendering. Case-insensitive substring is applied by the
  // caller. Reuses sortValueFor / analyticValueFor where the raw value is
  // already what's shown so there is a single source of truth per column.
  const filterValueFor = useCallback(
    (p: Product, key: string): string => {
      const cfg = configMap.get(p.code);
      switch (key) {
        case "code":
          return p.code || "";
        case "description":
          return `${p.name || ""} ${p.description || ""}`.trim();
        case "category":
          return p.category || "";
        case "size":
          return p.sizeLabel || "";
        case "model":
          return p.baseModel || "";
        case "price2":
        case "basePrice": {
          const v = p.basePriceSen ?? p.costPriceSen ?? 0;
          return v > 0 ? formatCurrency(v) : "";
        }
        case "price1": {
          const v = p.price1Sen ?? 0;
          return v > 0 ? formatCurrency(v) : "";
        }
        case "unitM3":
          return (cfg?.unitM3 ?? p.unitM3 ?? 0).toFixed(3);
        case "fabric":
          return `${cfg?.fabricUsage ?? p.fabricUsage ?? 0}`;
        case "totalMin": {
          const m =
            p.productionTimeMinutes > 0
              ? p.productionTimeMinutes
              : cfg
                ? totalConfigMinutes(cfg)
                : 0;
          return `${m}`;
        }
        case "variants": {
          const n =
            (p.defaultVariants?.fabricCode ? 1 : 0) +
            (p.defaultVariants?.divanHeight ? 1 : 0) +
            (p.defaultVariants?.legHeight ? 1 : 0) +
            (p.defaultVariants?.gap ? 1 : 0) +
            (p.defaultVariants?.seatHeight ? 1 : 0) +
            ((p.defaultVariants?.specials?.length ?? 0) > 0 ? 1 : 0);
          return n > 0 ? `${n} set` : "Configure";
        }
        case "labor":
        case "marginP2":
        case "marginP1":
        case "laborPctP2":
        case "laborPctP1": {
          const v = analyticValueFor(p, key);
          if (v == null) return "";
          if (key === "laborPctP2" || key === "laborPctP1")
            return `${v.toFixed(1)}%`;
          if (key === "labor") return formatCurrency(v);
          return formatCurrency(v); // margins
        }
        default: {
          // Dynamic sofa height columns (h20, h24, … from Maintenance Sizes).
          const hm = H_COL_RE.exec(key);
          if (hm) {
            const sh = (p.seatHeightPrices || []).find(
              (s) =>
                String(s.height ?? "").replace('"', "").trim() === hm[1] &&
                entryTier(s.tier) === sofaTier,
            );
            return sh && sh.priceSen > 0 ? formatCurrency(sh.priceSen) : "";
          }
          return "";
        }
      }
    },
    [configMap, sofaTier, analyticValueFor],
  );

  // Keys of the columns currently SHOWN for the active category — base
  // columns that are visible plus the applicable analytic columns that are
  // toggled on. Used to scope the per-column filter so a filter left on a
  // column that is now hidden (or belongs to a different category) doesn't
  // silently narrow the table. colFilters persists across category switches /
  // column hides, so this gate keeps the visible result honest.
  const visibleColKeys = useMemo(() => {
    const cat: ProdCat =
      categoryFilter === "SOFA"
        ? "SOFA"
        : categoryFilter === "ACCESSORY"
          ? "ACCESSORY"
          : "BEDFRAME";
    const keys = new Set<string>();
    for (const col of baseCols[cat]) {
      // Inline of isBaseColVisible so this memo depends only on baseColVis
      // (frozen / always-on columns are always shown; others unless toggled off).
      if (col.alwaysOn || col.frozen || baseColVis[col.key] !== false)
        keys.add(col.key);
    }
    for (const c of ANALYTIC_COLS) {
      if (c.applies(cat) && analyticColVis[c.key]) keys.add(c.key);
    }
    return keys;
  }, [categoryFilter, baseColVis, analyticColVis, baseCols]);

  // Apply the per-column filter row on top of the category/search result.
  // A row survives only if it matches EVERY active filter on a currently-
  // VISIBLE column (case-insensitive substring against filterValueFor). No
  // active filters ⇒ pass-through. Runs before sort so the count + sort
  // reflect the filtered set.
  const colFiltered = useMemo(() => {
    const active = Object.entries(colFilters).filter(
      ([key, v]) => v.trim() && visibleColKeys.has(key),
    );
    if (active.length === 0) return filteredRaw;
    return filteredRaw.filter((p) =>
      active.every(([key, term]) =>
        filterValueFor(p, key).toLowerCase().includes(term.trim().toLowerCase()),
      ),
    );
  }, [filteredRaw, colFilters, filterValueFor, visibleColKeys]);

  // Apply the active column sort on top of the filtered set. Stable: equal
  // keys keep their natural (load) order. When no sort is active the filtered
  // array passes through untouched so the default ordering is preserved.
  const filtered = useMemo(() => {
    if (!sortCol) return colFiltered;
    const dir = sortDir === "asc" ? 1 : -1;
    const decorated = colFiltered.map((p, i) => ({ p, i }));
    decorated.sort((a, b) => {
      const av = sortValueFor(a.p, sortCol);
      const bv = sortValueFor(b.p, sortCol);
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, {
          numeric: true,
        });
      }
      return cmp !== 0 ? cmp * dir : a.i - b.i;
    });
    return decorated.map((d) => d.p);
  }, [colFiltered, sortCol, sortDir, sortValueFor]);

  // ── Row virtualization for the SKU-master catalog table ────────────────
  // The catalog renders one inline-edit row per product (10+ grid cells,
  // price inputs, an expand panel). At a few hundred SKUs that is thousands
  // of DOM nodes — slow first paint, and a full re-render of every row on
  // each price keystroke. The virtualizer keeps only the visible window
  // (~20 rows) mounted.
  //
  // estimateSize = 45 — matches the actual measured height of a collapsed
  // BEDFRAME / SOFA / ACCESSORY row (verified 2026-05-24 against prod DOM).
  // When the guess matches reality, the first paint positions every row
  // correctly and ResizeObserver measureElement never has to shift them —
  // no layout jitter on scroll. Bumping or shrinking estimateSize would
  // reintroduce a one-frame shift each time a new window mounts.
  const productsScrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the repo-standard windowing lib (same usage as inventory/adjustments, invoices/e-invoice, bom); React Compiler skips memoizing it
  const catalogRowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => productsScrollRef.current,
    estimateSize: () => 45,
    overscan: 10,
  });

  function totalConfigMinutes(cfg: ProductDeptConfig): number {
    return cfg.fabCutMinutes + cfg.fabSewMinutes + cfg.foamMinutes + cfg.framingMinutes + cfg.upholsteryMinutes + cfg.packingMinutes;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6B7280]">
        Loading products...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header — wraps so the dense SKU Master toolbar drops onto its own
          line on narrower screens instead of squeezing the title. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-4 shrink-0">
          <h1 className="text-xl font-bold text-[#111827]">Products</h1>
          {/* View mode toggle */}
          <div className="flex bg-[#F3F4F6] rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("skuMaster")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                viewMode === "skuMaster"
                  ? "bg-white text-[#111827] shadow-sm"
                  : "text-[#6B7280] hover:text-[#111827]"
              }`}
            >
              SKU Master
            </button>
            <button
              onClick={() => setViewMode("catalog")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                viewMode === "catalog"
                  ? "bg-white text-[#111827] shadow-sm"
                  : "text-[#6B7280] hover:text-[#111827]"
              }`}
            >
              Catalog
            </button>
            <button
              onClick={() => setViewMode("maintenance")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                viewMode === "maintenance"
                  ? "bg-white text-[#111827] shadow-sm"
                  : "text-[#6B7280] hover:text-[#111827]"
              }`}
            >
              Maintenance
            </button>
          </div>
        </div>
        {viewMode === "skuMaster" && (
        <div className="flex gap-2 items-center flex-wrap justify-end">
          {/* Category filter — segmented pill group, mirrors the view toggle. */}
          <div className="inline-flex bg-[#F3F4F6] rounded-lg p-0.5">
            {categories.map((cat) => {
              const active = categoryFilter === cat && !searchQuery;
              return (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    active
                      ? "bg-white text-[#111827] shadow-sm"
                      : "text-[#6B7280] hover:text-[#111827]"
                  }`}
                >
                  {cat.charAt(0) + cat.slice(1).toLowerCase()}
                </button>
              );
            })}
          </div>
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#9CA3AF]"
              viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"
            >
              <circle cx="9" cy="9" r="6" />
              <path d="M14 14l3.5 3.5" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search all products..."
              className="pl-8 pr-7 py-1.5 rounded-md text-xs border border-[#E5E7EB] bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30 w-56"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[#9CA3AF] hover:text-[#111827]"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <div className="w-px h-5 bg-[#E5E7EB] mx-1" />
          <button
            onClick={handleExportCsv}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] transition-colors"
          >
            Export SKUs
          </button>
          <label
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
              importing
                ? "bg-[#F3F4F6] text-[#9CA3AF] border-[#E5E7EB] cursor-wait"
                : "bg-white text-[#6B7280] border-[#E5E7EB] hover:bg-[#F3F4F6]"
            }`}
          >
            {importing ? "Importing..." : "Import SKUs"}
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleImportCsv}
              disabled={importing}
            />
          </label>
          <div className="w-px h-5 bg-[#E5E7EB] mx-1" />
          {/* Edit / Save / Cancel — every inline edit on this page goes
              through this gate now (prices AND Fabric (m)). Cells are
              click-to-edit only while editMode is on; clicking Save opens a
              modal that asks for the effective date, dispatches one
              product_prices history row per dirty product, and commits any
              edited Fabric (m) via PUT /api/products/:id. */}
          {!editMode ? (
            <button
              onClick={() => setEditMode(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[#6B5C32] text-white hover:bg-[#5A4E2A] shadow-sm transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  if (dirtyEdits.size === 0) {
                    setEditMode(false);
                    return;
                  }
                  setShowBulkSaveDialog(true);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  dirtyEdits.size > 0
                    ? "bg-[#6B5C32] text-white hover:bg-[#5A4E2A]"
                    : "bg-white text-[#9CA3AF] border border-[#E5E7EB] cursor-not-allowed"
                }`}
                disabled={dirtyEdits.size === 0}
              >
                Save{dirtyEdits.size > 0 ? ` (${dirtyEdits.size})` : ""}
              </button>
              <button
                onClick={async () => {
                  if (
                    dirtyEdits.size > 0 &&
                    !(await confirm({
                      title: "Discard unsaved changes?",
                      message: `Discard ${dirtyEdits.size} unsaved change${dirtyEdits.size === 1 ? "" : "s"}?`,
                      danger: true,
                    }))
                  ) {
                    return;
                  }
                  discardDirty();
                }}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] transition-colors"
              >
                Cancel
              </button>
            </>
          )}
          {/* Filter toggle — shows/hides the per-column filter row under the
              header. Every column (base + analytic) gets a filter input. The
              badge shows how many columns are currently filtered; the row also
              auto-stays-open while any filter is active so a filtered view is
              never hidden. */}
          <div className="w-px h-5 bg-[#E5E7EB] mx-1" />
          {(() => {
            const activeFilterCount = Object.values(colFilters).filter((v) =>
              v.trim(),
            ).length;
            return (
              <button
                onClick={() => setShowFilterRow((v) => !v)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors inline-flex items-center gap-1.5 ${
                  showFilterRow || activeFilterCount > 0
                    ? "bg-[#F4F0E8] text-[#6B5C32] border-[#D9CEB3]"
                    : "bg-white text-[#6B7280] border-[#E5E7EB] hover:bg-[#F3F4F6]"
                }`}
                title="Toggle per-column filter row"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                  <path d="M3 4.5h14l-5.5 6.5v4l-3 1.5v-5.5L3 4.5z" strokeLinejoin="round" />
                </svg>
                Filter
                {activeFilterCount > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-[#6B5C32] text-white text-[9px] font-semibold">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            );
          })()}
          {Object.values(colFilters).some((v) => v.trim()) && (
            <button
              onClick={clearAllColFilters}
              className="px-2 py-1.5 rounded-md text-xs font-medium text-[#9A3A2D] hover:bg-[#F9E1DA] transition-colors"
              title="Clear all column filters"
            >
              Clear filters
            </button>
          )}
          {/* Columns chooser — show/hide ANY column (base + analytic) for the
              active category. Per-browser persistence (localStorage), like the
              Tier switcher. Frozen Code is always shown. */}
          <div className="w-px h-5 bg-[#E5E7EB] mx-1" />
          {(() => {
            const catX: ProdCat =
              categoryFilter === "SOFA"
                ? "SOFA"
                : categoryFilter === "ACCESSORY"
                  ? "ACCESSORY"
                  : "BEDFRAME";
            const toggleableBase = baseCols[catX].filter(
              (col) => !col.frozen && !col.alwaysOn,
            );
            const analyticForCat = ANALYTIC_COLS.filter((c) => c.applies(catX));
            const hiddenCount =
              toggleableBase.filter((col) => baseColVis[col.key] === false).length;
            return (
              <div className="relative">
                <button
                  onClick={() => setShowColMenu((v) => !v)}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] transition-colors inline-flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                    <rect x="3" y="3.5" width="14" height="13" rx="1.5" />
                    <path d="M8.5 3.5v13M13 3.5v13" />
                  </svg>
                  Columns
                  {hiddenCount > 0 && (
                    <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-[#6B5C32] text-white text-[9px] font-semibold">
                      {hiddenCount}
                    </span>
                  )}
                </button>
                {showColMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setShowColMenu(false)}
                    />
                    <div className="absolute right-0 mt-1 z-30 w-64 bg-white border border-[#E5E7EB] rounded-lg shadow-lg p-2 max-h-[70vh] overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1">
                        <p className="text-[10px] font-semibold text-[#9CA3AF] uppercase tracking-wide">
                          Columns
                        </p>
                        <button
                          onClick={() => {
                            // Reset layout: show all base columns, restore the
                            // default column ORDER, clear manual widths, any
                            // active sort, and all column filters. Analytics keep
                            // their own defaults (left as-is so a chosen analytic
                            // layout isn't surprising-cleared).
                            setBaseColVis({});
                            setColOrder({});
                            persistColOrder({});
                            setColWidths({});
                            persistColWidths({});
                            setSortCol(null);
                            clearAllColFilters();
                            if (typeof window !== "undefined") {
                              try {
                                window.localStorage.removeItem("hookka.products.baseCols");
                              } catch {
                                /* ignore */
                              }
                            }
                          }}
                          className="text-[10px] text-[#6B5C32] hover:underline font-medium"
                        >
                          Reset layout
                        </button>
                      </div>
                      {/* Code is always shown — surfaced disabled so the owner
                          sees it's pinned, not missing. */}
                      <label className="flex items-center gap-2 px-2 py-1.5 rounded opacity-60 cursor-not-allowed">
                        <input type="checkbox" checked disabled className="rounded border-[#D1D5DB] text-[#6B5C32]" />
                        <span className="text-xs text-[#374151]">Product Code</span>
                        <span className="ml-auto text-[9px] text-[#9CA3AF] uppercase">Frozen</span>
                      </label>
                      {toggleableBase.map((col) => (
                        <label
                          key={col.key}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#F9FAFB] cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={baseColVis[col.key] !== false}
                            onChange={() => toggleBaseCol(col.key)}
                            className="rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]"
                          />
                          <span className="text-xs text-[#374151]">
                            {baseColChooserLabel(col)}
                          </span>
                        </label>
                      ))}
                      {analyticForCat.length > 0 && (
                        <>
                          <div className="my-1 border-t border-[#F3F4F6]" />
                          <p className="px-2 py-1 text-[10px] font-semibold text-[#9CA3AF] uppercase tracking-wide">
                            Analytics
                          </p>
                          {analyticForCat.map((c) => (
                            <label
                              key={c.key}
                              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#F9FAFB] cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={!!analyticColVis[c.key]}
                                onChange={() => toggleAnalyticCol(c.key)}
                                className="rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]"
                              />
                              <span className="text-xs text-[#374151]">
                                {c.label(catX)}
                              </span>
                            </label>
                          ))}
                        </>
                      )}
                      <div className="my-1 border-t border-[#F3F4F6]" />
                      <p className="px-2 py-1 text-[10px] text-[#9CA3AF] leading-snug">
                        Drag a header to reorder · drag its right edge to resize ·
                        click to sort · use the Filter button for per-column
                        filters. Reset layout restores the default order.
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
          {/* Tier switcher — only meaningful for sofas (5 height columns
              are tier-aware). Renders as a single segmented control so the
              row-per-row table layout is preserved; clicking a tier re-renders
              the same cells with that tier's price (legacy entries default to
              P2). Hidden for BF/ACCESSORY where one price per SKU is the rule. */}
          {categoryFilter === "SOFA" && (
            <>
              <div className="w-px h-5 bg-[#E5E7EB] mx-1" />
              <span className="text-[11px] text-[#6B7280] uppercase tracking-wide">
                Tier
              </span>
              <div className="inline-flex rounded-md border border-[#E5E7EB] overflow-hidden">
                {SOFA_TIERS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setSofaTier(t.value)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      sofaTier === t.value
                        ? "bg-[#6B5C32] text-white"
                        : "bg-white text-[#6B7280] hover:bg-[#F3F4F6]"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        )}
      </div>

      {/* KPI drill-down banner — names the exact set on screen, and offers the
          other three cuts so the operator can work the gap field by field
          without going back to the KPI card. */}
      {setupDrillActive && (
        <div className="-mt-3 rounded-lg border border-[#D9CEB3] bg-[#F4F0E8] px-3 py-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#5A5550]">
            <span className="font-semibold">KPI drill-down:</span> active SKUs
            missing{" "}
            {missingField ? (
              <span className="font-semibold">{SETUP_FIELD_LABEL[missingField]}</span>
            ) : (
              "at least one of price, volume, fabric usage or BOM routing"
            )}
            {incompleteCodes !== null && (
              <> · {incompleteCodes.size} SKU{incompleteCodes.size === 1 ? "" : "s"}</>
            )}
            . Shown across every category — the metric counts them all.
          </span>
          <span className="text-[11px] text-[#9CA3AF]">
            narrow:{" "}
            {(Object.keys(SETUP_FIELD_LABEL) as SetupField[]).map((f, i) => (
              <span key={f}>
                {i > 0 && " · "}
                <Link
                  to={`/products?filter=incomplete&missing=${f}`}
                  className={
                    missingField === f
                      ? "font-semibold text-[#6B5C32]"
                      : "underline decoration-dotted text-[#6B5C32]"
                  }
                >
                  {SETUP_FIELD_LABEL[f]}
                </Link>
              </span>
            ))}
            {missingField && (
              <>
                {" · "}
                <Link
                  to="/products?filter=incomplete"
                  className="underline decoration-dotted text-[#6B5C32]"
                >
                  any
                </Link>
              </>
            )}
          </span>
          <button
            onClick={clearSetupDrill}
            className="ml-auto px-2 py-1 rounded text-[11px] font-medium text-[#6B7280] hover:bg-white transition-colors"
          >
            Show all products
          </button>
        </div>
      )}

      {/* Subtitle for SKU Master */}
      {viewMode === "skuMaster" && (
        <p className="text-sm text-[#6B7280] -mt-4">
          {filtered.length} product{filtered.length !== 1 ? "s" : ""} &middot; Production configs from SKU sheet
        </p>
      )}

      {/* Catalog view — export toolbar */}
      {viewMode === "catalog" && (
        <div className="flex items-center gap-2 justify-end -mt-1 mb-2 flex-wrap">
          <button
            onClick={openCatalogueCustomerPicker}
            disabled={exportingCatalogue || products.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[#D9CEB3] bg-[#F4F0E8] text-[#6B5C32] hover:bg-[#EDE8D8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exportingCatalogue ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileDown className="w-3.5 h-3.5" />
            )}
            Export Catalogue PDF
          </button>
        </div>
      )}

      {/* Customer picker modal for per-customer catalogue export */}
      {showCatCustomerPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => { setShowCatCustomerPicker(false); setCatCustomerQuery(""); }}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-base font-semibold text-[#1F1D1B]">Export Catalogue PDF</h2>
              <button
                onClick={() => { setShowCatCustomerPicker(false); setCatCustomerQuery(""); }}
                className="text-[#9CA3AF] hover:text-[#1F1D1B] transition-colors"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-3 border-b border-[#F3F4F6]">
              <input
                type="text"
                value={catCustomerQuery}
                onChange={(e) => setCatCustomerQuery(e.target.value)}
                placeholder="Search customers…"
                autoFocus
                className="w-full px-3 py-2 rounded-md text-sm border border-[#E2DDD8] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
              />
            </div>
            <div className="px-5 py-2.5 border-b border-[#F3F4F6] flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-[#9CA3AF] mr-1">Category</span>
              {["ALL", "BEDFRAME", "SOFA", "ACCESSORY"].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCatExportCategory(cat)}
                  className={
                    "px-2.5 py-1 rounded-md text-xs font-medium transition-colors border " +
                    (catExportCategory === cat
                      ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                      : "bg-white text-[#1F1D1B] border-[#E2DDD8] hover:bg-[#F0ECE9]")
                  }
                >
                  {cat === "ALL" ? "All" : cat.charAt(0) + cat.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {!catCustomerQuery.trim() && (
                <button
                  onClick={() => {
                    setShowCatCustomerPicker(false);
                    setCatCustomerQuery("");
                    handleExportCatalogue(catExportCategory === "ALL" ? undefined : catExportCategory);
                  }}
                  className="w-full text-left px-5 py-3 hover:bg-[#F9FAFB] transition-colors flex items-center gap-3 border-b border-[#F3F4F6]"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[#1F1D1B]">All Customers</p>
                    <p className="text-xs text-[#9CA3AF]">{catExportCategory === "ALL" ? "Full catalogue — every model" : `Every ${catExportCategory.toLowerCase()} model`}</p>
                  </div>
                  <FileDown className="h-4 w-4 text-[#6B5C32] flex-shrink-0" />
                </button>
              )}
              {loadingCatalogueCustomers ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-[#6B5C32]" />
                </div>
              ) : (() => {
                const q = catCustomerQuery.trim().toLowerCase();
                const visible = q
                  ? catalogueCustomers.filter(
                      (c) =>
                        c.name.toLowerCase().includes(q) ||
                        c.code.toLowerCase().includes(q),
                    )
                  : catalogueCustomers;
                if (visible.length === 0) {
                  return (
                    <p className="text-sm text-[#9CA3AF] text-center py-8">No customers found.</p>
                  );
                }
                return visible.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleExportCustomerCatalogue(c, catExportCategory === "ALL" ? undefined : catExportCategory)}
                    className="w-full text-left px-5 py-3 hover:bg-[#F9FAFB] transition-colors flex items-center gap-3 border-b border-[#F3F4F6] last:border-0"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1F1D1B] truncate">{c.name}</p>
                      <p className="text-xs text-[#9CA3AF]">{c.code}</p>
                    </div>
                    <FileDown className="h-4 w-4 text-[#6B5C32] flex-shrink-0" />
                  </button>
                ));
              })()}
            </div>
            <div className="px-5 py-3 border-t border-[#F3F4F6] bg-[#FAFAF9]">
              <p className="text-xs text-[#9CA3AF]">
                Pick a customer for their assigned-SKU catalogue, or "All Customers" for every model.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Catalog (Modular) View — one photo-first tile per Model. */}
      {viewMode === "catalog" && <ProductCatalog products={products} />}

      {/* Maintenance View */}
      {viewMode === "maintenance" && <MaintenanceView />}

      {/* Table — column layout driven by the BASE_COLS registry + the
          owner's per-column visibility / width / sort prefs. */}
      {viewMode === "skuMaster" && (() => {
        const isSofa = categoryFilter === "SOFA";
        const isAccessory = categoryFilter === "ACCESSORY";
        const cat: ProdCat = isSofa ? "SOFA" : isAccessory ? "ACCESSORY" : "BEDFRAME";
        // The base columns this category defines, filtered to the ones the
        // owner currently has shown. The Code column is always present (frozen).
        const visibleBaseCols = baseCols[cat].filter((col) =>
          isBaseColVisible(col),
        );
        // A hidden base / analytic column simply isn't in orderedCols (built
        // below), so its header cell, body cell, and grid track all drop in
        // lockstep — the body renders strictly from orderedCols, never a
        // per-cell visibility gate, so reorder + hide stay aligned.
        // The analytic columns the chooser currently has switched on, for this
        // category. Their grid tracks are appended to gridTemplateColumns so the
        // header + body cells line up; widths come from each column's def.
        const activeAnalyticCols = ANALYTIC_COLS.filter(
          (c) => c.applies(cat) && analyticColVis[c.key],
        );
        // One <td colSpan> spans the whole grid row; the actual columns live in
        // the inner CSS grid, so colSpan just needs to cover them all.
        const colSpanN = visibleBaseCols.length + activeAnalyticCols.length;
        // Track width for a base column: a manual drag-width (px) overrides the
        // responsive minmax() default. minmax() floors keep a column from
        // crushing below its min when many columns are shown (owner: "被挤压了").
        const trackFor = (key: string, fallback: string) =>
          colWidths[key] != null ? `${colWidths[key]}px` : fallback;
        // Single ordered list of EVERY visible column (base + active analytics).
        // The header row, the per-column filter row, the resize handles, the
        // grid-template-columns track string, AND every body row's cells all
        // iterate THIS one list, so they can never drift out of lockstep no
        // matter how the owner reorders columns. `label` is the clean name;
        // `frozen` marks the sticky Code column (always emitted first);
        // `fallbackWidth` is the registry minmax() track, used for both the grid
        // track (when no manual width is set) and the resize handle's start width.
        type OrderedCol = {
          key: string;
          label: string;
          frozen: boolean;
          fallbackWidth: string;
        };
        // Build the natural (registry track) order first: base columns, then the
        // active analytics, exactly as before. Then apply the owner's saved
        // drag-reorder for this category (frozen Code stays pinned first).
        const naturalCols: OrderedCol[] = [
          ...visibleBaseCols.map((col) => ({
            key: col.key,
            label: baseColChooserLabel(col),
            frozen: !!col.frozen,
            fallbackWidth: col.width,
          })),
          ...activeAnalyticCols.map((c) => ({
            key: c.key,
            label: c.label(cat),
            frozen: false,
            fallbackWidth: c.width,
          })),
        ];
        const colByKey = new Map(naturalCols.map((c) => [c.key, c] as const));
        const frozenKeys = new Set(
          naturalCols.filter((c) => c.frozen).map((c) => c.key),
        );
        const orderedKeys = applyColOrder(
          naturalCols.map((c) => c.key),
          frozenKeys,
          cat,
        );
        const orderedCols: OrderedCol[] = orderedKeys.map(
          (k) => colByKey.get(k)!,
        );
        // The movable (non-frozen) keys in their current visual order — the drag
        // handlers splice within this list so frozen Code is never displaced.
        const orderedMovableKeys = orderedCols
          .filter((c) => !c.frozen)
          .map((c) => c.key);
        // grid-template-columns + min-width are derived FROM orderedCols (not the
        // raw registry order) so the tracks follow the reordered header/body in
        // lockstep. A manual drag-width overrides the registry minmax() track.
        const gridColsFull = orderedCols
          .map((c) => trackFor(c.key, c.fallbackWidth))
          .join(" ");
        // UNIFORM header style — every header cell (base + analytic) is
        // IDENTICAL: same padding, same left alignment, same baseline. Sort
        // arrow + resize handle render on all of them. (Owner: headers must
        // look the same across every column.)
        const thCls =
          "px-3 py-2 text-[11px] font-semibold text-[#6B7280] uppercase tracking-wider text-left";
        // Give the scroll container a min-width so columns scroll horizontally
        // instead of crushing once the table outgrows the viewport. Derived
        // from the visible columns' minmax floors (digits parsed from each
        // track) so it tracks show/hide + manual widths automatically.
        const floorPx = (track: string): number => {
          if (track.endsWith("px")) {
            const n = parseInt(track, 10);
            return Number.isFinite(n) ? n : 90;
          }
          const m = track.match(/minmax\((\d+)px/);
          return m ? parseInt(m[1], 10) : 90;
        };
        const totalFloor = orderedCols.reduce(
          (sum, c) => sum + floorPx(trackFor(c.key, c.fallbackWidth)),
          0,
        );
        // Only force horizontal scroll once the floors exceed a comfortable
        // baseline, so a trimmed-down table still fits without a scrollbar.
        const gridMinWidth = totalFloor > 1040 ? `${totalFloor}px` : undefined;
        // Header cell with an optional sort affordance + a resize handle on the
        // right edge. Frozen Code gets special sticky styling inline below.
        const sortIndicator = (key: string) =>
          sortCol === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
        return (
      <div className="bg-white rounded-lg border border-[#E5E7EB] overflow-hidden">
        <div
          ref={productsScrollRef}
          className="overflow-auto"
          style={{ maxHeight: "calc(100vh - 320px)" }}
        >
          <table className="min-w-full divide-y divide-[#E5E7EB]">
            <thead className="bg-[#F9FAFB] sticky top-0 z-10">
              {/* Header row — UNIFORM cells driven by the single orderedCols
                  list so header / filter / body never drift out of lockstep.
                  Every column: click-to-sort (asc → desc → off), a drag handle
                  on the right edge for manual width (double-click resets), and
                  identical padding / left-alignment / baseline. The frozen Code
                  column stays sticky-left with an invisible chevron spacer so
                  its label lines up with the body's code text (expand arrow in
                  front). */}
              <tr>
                <th colSpan={colSpanN} className="p-0">
                  <div className="grid" style={{ gridTemplateColumns: gridColsFull, minWidth: gridMinWidth }}>
                    {orderedCols.map((col) => {
                      const active = sortCol === col.key;
                      // The frozen Code column is pinned first and cannot be
                      // dragged or used as a drop target — every movable column
                      // reorders only among themselves. While a column is being
                      // dragged, the column under the pointer gets a left/right
                      // accent bar showing where it would land.
                      const isDragging = draggingColKey === col.key;
                      const isDropTarget =
                        !col.frozen &&
                        dragOverColKey === col.key &&
                        draggingColKey !== null &&
                        draggingColKey !== col.key;
                      // Drop bar side: if the dragged column currently sits to
                      // the LEFT of this one it would insert AFTER (right edge),
                      // otherwise BEFORE (left edge).
                      const dropOnRight =
                        isDropTarget &&
                        orderedMovableKeys.indexOf(draggingColKey!) <
                          orderedMovableKeys.indexOf(col.key);
                      return (
                        <div
                          key={col.key}
                          draggable={!col.frozen}
                          onDragStart={(e) => {
                            if (col.frozen) return;
                            setDraggingColKey(col.key);
                            e.dataTransfer.effectAllowed = "move";
                            // Firefox requires data to be set for drag to start.
                            try {
                              e.dataTransfer.setData("text/plain", col.key);
                            } catch {
                              /* some browsers disallow setData here */
                            }
                          }}
                          onDragOver={(e) => {
                            // Allow a drop only onto another movable column.
                            if (col.frozen || draggingColKey === null) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (dragOverColKey !== col.key)
                              setDragOverColKey(col.key);
                          }}
                          onDragLeave={() => {
                            if (dragOverColKey === col.key) setDragOverColKey(null);
                          }}
                          onDrop={(e) => {
                            if (col.frozen || draggingColKey === null) return;
                            e.preventDefault();
                            reorderColumn(
                              draggingColKey,
                              col.key,
                              orderedMovableKeys,
                              cat,
                            );
                            setDraggingColKey(null);
                            setDragOverColKey(null);
                          }}
                          onDragEnd={() => {
                            setDraggingColKey(null);
                            setDragOverColKey(null);
                          }}
                          onClick={() => toggleSort(col.key)}
                          title={col.frozen ? "Click to sort" : "Drag to reorder · click to sort"}
                          className={`${thCls} relative group/th flex items-center gap-1 select-none hover:text-[#374151] ${
                            col.frozen ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
                          } ${
                            col.frozen
                              ? "sticky left-0 z-20 bg-[#F9FAFB] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.08)]"
                              : ""
                          } ${active ? "text-[#6B5C32]" : ""} ${
                            isDragging ? "opacity-40" : ""
                          }`}
                        >
                          {/* Drop-position indicator — a thin accent bar on the
                              edge the dragged column would land against. */}
                          {isDropTarget && (
                            <span
                              aria-hidden="true"
                              className={`absolute top-0 ${
                                dropOnRight ? "right-0" : "left-0"
                              } h-full w-0.5 bg-[#6B5C32]`}
                            />
                          )}
                          {col.frozen && (
                            <span className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                          )}
                          <span className="truncate" title={col.label}>{col.label}</span>
                          <span className="text-[#9CA3AF] text-[9px] leading-none">
                            {sortIndicator(col.key)}
                          </span>
                          {/* Resize handle — drag to set px width, dbl-click
                              to clear back to the responsive default. Not a
                              reorder handle: it must not start a column drag, so
                              draggable is force-off here and drag events are
                              swallowed (grabbing the edge resizes, the rest of
                              the header drags-to-reorder). */}
                          <span
                            draggable={false}
                            onDragStart={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onMouseDown={(e) =>
                              beginColResize(
                                e,
                                col.key,
                                colWidths[col.key] ?? floorPx(col.fallbackWidth),
                              )
                            }
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              clearColWidth(col.key);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            title="Drag to resize · double-click to reset"
                            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover/th:opacity-100 hover:bg-[#6B5C32]/30 transition-opacity"
                          />
                        </div>
                      );
                    })}
                  </div>
                  {/* Per-column filter row — one input per visible column, in
                      the SAME grid track order as the header + body. Toggled by
                      the "Filter" button; auto-shown while any filter is active.
                      Each input is a case-insensitive substring match against
                      that column's displayed value (filterValueFor). The frozen
                      Code filter cell is sticky-left to match its header/body. */}
                  {(showFilterRow ||
                    Object.values(colFilters).some((v) => v.trim())) && (
                    <div
                      className="grid border-t border-[#E5E7EB] bg-white"
                      style={{ gridTemplateColumns: gridColsFull, minWidth: gridMinWidth }}
                    >
                      {orderedCols.map((col) => (
                        <div
                          key={col.key}
                          className={`px-2 py-1 ${
                            col.frozen
                              ? "sticky left-0 z-[15] bg-white shadow-[2px_0_5px_-2px_rgba(0,0,0,0.08)]"
                              : ""
                          }`}
                        >
                          <input
                            type="text"
                            value={colFilters[col.key] ?? ""}
                            onChange={(e) => setColFilter(col.key, e.target.value)}
                            placeholder="Filter…"
                            aria-label={`Filter ${col.label}`}
                            className={`w-full min-w-0 text-[11px] rounded border px-1.5 py-1 bg-white focus:outline-none focus:border-[#6B5C32] focus:ring-1 focus:ring-[#6B5C32]/30 ${
                              (colFilters[col.key] ?? "").trim()
                                ? "border-[#6B5C32] bg-[#FBF8EE]"
                                : "border-[#E5E7EB]"
                            }`}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]">
              {(() => {
                const vItems = catalogRowVirtualizer.getVirtualItems();
                const padTop = vItems.length > 0 ? vItems[0].start : 0;
                const padBottom =
                  vItems.length > 0
                    ? catalogRowVirtualizer.getTotalSize() -
                      vItems[vItems.length - 1].end
                    : 0;
                return (
                  <>
                    {padTop > 0 && (
                      <tr aria-hidden="true">
                        <td
                          colSpan={colSpanN}
                          style={{ height: padTop, padding: 0, border: 0 }}
                        />
                      </tr>
                    )}
                    {vItems.map((vi) => {
                const p = filtered[vi.index];
                if (!p) return null;
                const cfg = configMap.get(p.code);
                const isExpanded = expandedId === p.id;
                // /api/products now returns productionTimeMinutes derived
                // live from the active BOM template, so prefer that over
                // the legacy product_dept_configs (cfg) snapshot — which
                // doesn't track BOM edits. cfg is only used when the API
                // returns 0 (e.g. SKU has no active template yet).
                const totalMin = p.productionTimeMinutes > 0
                  ? p.productionTimeMinutes
                  : (cfg ? totalConfigMinutes(cfg) : 0);
                const price1Val = p.price1Sen ?? 0;
                const basePrice = p.basePriceSen ?? p.costPriceSen ?? 0;
                // Estimated labor cost for this SKU = total production minutes
                // × flat-average labor rate (see LABOR_RATE_PER_MIN_SEN). 0 when
                // the SKU has no minutes yet — rendered as "—" downstream.
                const laborCostSen = laborCostSenForMinutes(totalMin);
                // Sofa selling price for the analytic columns = lowest positive
                // seat-height price in the selected tier (mirrors the expand
                // panel's representative-price logic). 0 for non-sofas, which
                // fall back to basePriceSen / price1Sen below.
                const sofaRepPriceSen = isSofa
                  ? ((p.seatHeightPrices || [])
                      .filter((s) => entryTier(s.tier) === sofaTier && s.priceSen > 0)
                      .sort((a, b) => a.priceSen - b.priceSen)[0]?.priceSen ?? 0)
                  : 0;
                // Per-SKU default variants — read straight from the product
                // row. The badge shows "✓ Configured" when ANY default field
                // is set, otherwise "Configure". Counting the number of set
                // fields in a summary list below.
                const variantDefaults: ProductDefaultVariants = p.defaultVariants ?? {};
                const variantSetCount =
                  (variantDefaults.fabricCode ? 1 : 0) +
                  (variantDefaults.divanHeight ? 1 : 0) +
                  (variantDefaults.legHeight ? 1 : 0) +
                  (variantDefaults.gap ? 1 : 0) +
                  (variantDefaults.seatHeight ? 1 : 0) +
                  ((variantDefaults.specials?.length ?? 0) > 0 ? 1 : 0);
                const hasVariantDefaults = variantSetCount > 0;
                const isEditingThisPrice = editingPrice === p.id;
                // Zebra striping + state tints. The sticky Code column must use
                // an OPAQUE background that matches its row's stripe, otherwise
                // body cells would show through it on horizontal scroll. Expanded
                // and dirty rows get a soft accent so they stand out.
                const zebra = vi.index % 2 === 1;
                const rowDirty = isProductDirty(p.id);
                const rowGridBg = isExpanded
                  ? "bg-[#F4F0E8]"
                  : rowDirty
                    ? "bg-[#FEFBF0]"
                    : zebra
                      ? "bg-[#FCFCFB]"
                      : "bg-white";
                const rowStickyBg = isExpanded
                  ? "bg-[#F4F0E8]"
                  : rowDirty
                    ? "bg-[#FEFBF0]"
                    : zebra
                      ? "bg-[#FCFCFB]"
                      : "bg-white";

                return (
                  <tr
                    key={p.id}
                    data-index={vi.index}
                    ref={catalogRowVirtualizer.measureElement}
                    className="group"
                  >
                    <td colSpan={colSpanN} className="p-0">
                      {/* Main row */}
                      <div
                        className={`grid cursor-pointer transition-colors ${rowGridBg} hover:bg-[#F4F2EC]`}
                        style={{ gridTemplateColumns: gridColsFull, minWidth: gridMinWidth }}
                        onClick={() => setExpandedId(isExpanded ? null : p.id)}
                      >
                        <div className={`px-3 py-1.5 flex items-center gap-1.5 sticky left-0 z-[5] ${rowStickyBg} group-hover:bg-[#F4F2EC] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.08)]`}>
                          <svg
                            className={`w-3.5 h-3.5 text-[#9CA3AF] transition-transform flex-shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="text-xs font-medium text-[#111827] whitespace-nowrap">{p.code}</span>
                          {/* Schedule master price change. Same dialog drives the whole
                              row (works for BF Price 2/Price 1 and Sofa seat tiers).
                              stopPropagation so the click doesn't toggle the row's
                              expansion state. */}
                          <button
                            type="button"
                            title="Schedule price change"
                            onClick={(e) => {
                              e.stopPropagation();
                              setScheduleProductId(p.id);
                            }}
                            className={`p-1 rounded flex-shrink-0 ${
                              p.hasPendingPriceChange
                                ? "text-[#B8601A] hover:bg-[#FBE4CE]"
                                : "text-[#9CA3AF] hover:text-[#6B5C32] hover:bg-[#F4F0E8]"
                            }`}
                          >
                            <Calendar className="h-3.5 w-3.5" />
                          </button>
                          {p.hasPendingPriceChange && (
                            <span
                              title={
                                p.pendingEffectiveFrom
                                  ? `Next price change effective ${p.pendingEffectiveFrom}`
                                  : "A future-dated price change is queued"
                              }
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-[#FBE4CE] text-[#B8601A] border border-[#E8B786]"
                              onClick={(e) => {
                                e.stopPropagation();
                                setScheduleProductId(p.id);
                              }}
                            >
                              Pending
                              {p.pendingEffectiveFrom &&
                                (() => {
                                  const t = new Date(
                                    new Date().toISOString().slice(0, 10) +
                                      "T00:00:00Z",
                                  ).getTime();
                                  const d = new Date(
                                    p.pendingEffectiveFrom + "T00:00:00Z",
                                  ).getTime();
                                  const days = Math.round(
                                    (d - t) / 86400000,
                                  );
                                  return ` · ${days}d`;
                                })()}
                            </span>
                          )}
                        </div>
                        {/* Body cells, keyed by column key, then rendered in the
                            SAME order as the header via orderedCols (below). The
                            grid uses ONE ordered list, so reordering a column in
                            the header reorders its body cell in lockstep — header
                            and body can never misalign. Each cell's JSX (and its
                            inline edit / dirty behaviour) is unchanged; only the
                            iteration order is now data-driven. Hidden columns
                            aren't in orderedCols, so their cells never render. */}
                        {(() => {
                          const norm = (v: unknown) => String(v ?? "").replace('"', '').trim();
                          const bodyCellByKey: Record<string, ReactNode> = {
                            description: (
                              <div className="px-3 py-1.5 min-w-0">
                                <span className="text-xs text-[#111827] truncate block" title={p.name}>{p.name}</span>
                                <span className="block text-[11px] text-[#9CA3AF] truncate" title={p.description}>{p.description}</span>
                              </div>
                            ),
                            model: (
                              <div className="px-3 py-1.5 text-sm text-[#111827] truncate" title={p.baseModel}>{p.baseModel}</div>
                            ),
                            category: (
                              <div className="px-3 py-1.5 min-w-0 flex items-center" title={p.category}>
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium max-w-full truncate ${
                                  p.category === "BEDFRAME" ? "bg-[#FAEFCB] text-[#9C6F1E]" : "bg-[#E0EDF0] text-[#3E6570]"
                                }`}>
                                  {p.category}
                                </span>
                              </div>
                            ),
                            size: (
                              <div className="px-3 py-1.5 text-sm text-[#111827] truncate" title={p.sizeLabel}>{p.sizeLabel}</div>
                            ),
                            price2: (
                            <div className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {isEditingThisPrice ? (
                                <input
                                  autoFocus
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  value={priceInput}
                                  onChange={(e) => setPriceInput(e.target.value)}
                                  onBlur={() => {
                                    // BUG-2026-08-13-095 - one money parser; an
                                    // unreadable entry abandons the edit instead of
                                    // writing NaN into the product's base price.
                                    const val = moneyFieldToSen(priceInput);
                                    setEditingPrice(null);
                                    if (val === null) return;
                                    // Local-only update — bulk Save batches every dirty
                                    // cell into one product_prices row at the picked
                                    // effective date.
                                    setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, basePriceSen: val } : pr));
                                    recordDirty(p.id, { basePriceSen: val });
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                    if (e.key === "Escape") setEditingPrice(null);
                                  }}
                                  className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                  step="0.01"
                                />
                              ) : (
                                <button
                                  onClick={() => {
                                    if (!editMode) return;
                                    setEditingPrice(p.id);
                                    setPriceInput((basePrice / 100).toFixed(2));
                                  }}
                                  className={`text-sm font-medium ${
                                    isProductDirty(p.id) && dirtyEdits.get(p.id)?.basePriceSen !== undefined
                                      ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E]"
                                      : "text-[#111827]"
                                  } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                >
                                  {basePrice > 0 ? formatCurrency(basePrice) : <span className="text-[#9CA3AF]">Set price</span>}
                                </button>
                              )}
                            </div>
                            ),
                            price1: (
                            <div className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {editingPrice1 === p.id ? (
                                <input
                                  autoFocus
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  value={price1Input}
                                  onChange={(e) => setPrice1Input(e.target.value)}
                                  onBlur={() => {
                                    const val = moneyFieldToSen(price1Input);
                                    setEditingPrice1(null);
                                    if (val === null) return;
                                    setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, price1Sen: val } : pr));
                                    recordDirty(p.id, { price1Sen: val });
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                    if (e.key === "Escape") setEditingPrice1(null);
                                  }}
                                  className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                  step="0.01"
                                />
                              ) : (
                                <button
                                  onClick={() => {
                                    if (!editMode) return;
                                    setEditingPrice1(p.id);
                                    setPrice1Input((price1Val / 100).toFixed(2));
                                  }}
                                  className={`text-sm font-medium ${
                                    isProductDirty(p.id) && dirtyEdits.get(p.id)?.price1Sen !== undefined
                                      ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E]"
                                      : "text-[#111827]"
                                  } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                >
                                  {price1Val > 0 ? formatCurrency(price1Val) : <span className="text-[#9CA3AF]">-</span>}
                                </button>
                              )}
                            </div>
                            ),
                            basePrice: (
                            <div className="px-3 py-1.5 text-right">
                              <span className="text-sm font-medium text-[#111827]">
                                {basePrice > 0 ? formatCurrency(basePrice) : <span className="text-[#9CA3AF]">-</span>}
                              </span>
                            </div>
                            ),
                            // Unit (m³) / Fabric (m) — editMode-gated, defers to Save
                            unitM3: renderUnitM3Cell(p, cfg),
                            fabric: renderFabricCell(p, cfg),
                            totalMin: (
                            <div className="px-3 py-1.5 text-right truncate" title={`${totalMin} min`}>
                              <div className="text-sm font-medium text-[#111827] truncate">{totalMin} min</div>
                              {/* Labor cost moved to its own "Labor (est.)"
                                  column — no longer duplicated under Total Min
                                  (owner 2026-06-17). */}
                            </div>
                            ),
                            variants: (
                            <div className="px-3 py-1.5 flex justify-center" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => setEditingVariant(p)}
                                className={`text-[10px] font-medium px-2 py-1 rounded-full border transition-colors ${
                                  hasVariantDefaults
                                    ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] hover:bg-[#EEF3E4]"
                                    : "bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100"
                                }`}
                                title={
                                  hasVariantDefaults
                                    ? "Edit default variants for this SKU"
                                    : "Configure default variants — Sales Order will pre-fill from these"
                                }
                              >
                                {hasVariantDefaults ? `${variantSetCount} set` : "Configure"}
                              </button>
                            </div>
                            ),
                          };
                          // Sofa per-seat-height price cells (one per height key).
                          // Identical edit behaviour as before; keys follow the
                          // dynamic Maintenance Sizes list (h20, h24, …) so they
                          // slot into orderedCols like any other column.
                          if (isSofa) {
                            for (const h of sofaHeightList.map((n) => `${n}"`)) {
                              const hNum = h.replace('"', '');
                              // Cell read: scope by (height, current tier). Legacy
                              // entries with no `tier` resolve to P2 via entryTier(),
                              // so an old SKU that only has flat per-height prices
                              // shows up under the P2 toggle and looks empty under
                              // P1 / P3 until those cells are first edited.
                              const sh = (p.seatHeightPrices || []).find(
                                (s) => norm(s.height) === hNum && entryTier(s.tier) === sofaTier,
                              );
                              const editKey = `${p.id}__${h}__${sofaTier}`;
                              const isEditingThis = editingSeatPrices === editKey;
                              bodyCellByKey[`h${hNum}`] = (
                                <div className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                                  {isEditingThis ? (
                                    <input
                                      autoFocus
                                      type="number" onFocus={(e) => e.currentTarget.select()}
                                      step="0.01"
                                      value={seatPriceInputs[h] ?? ""}
                                      onChange={(e) => setSeatPriceInputs((prev) => ({ ...prev, [h]: e.target.value }))}
                                      onBlur={() => {
                                        const val = moneyFieldToSen(seatPriceInputs[h] ?? "");
                                        setEditingSeatPrices(null);
                                        if (val === null) return;
                                        const hN = h.replace('"', '');
                                        let arr = p.seatHeightPrices || [];
                                        // Match by BOTH height and current tier so editing
                                        // P1 doesn't overwrite an existing P2 cell. Legacy
                                        // untiered entries match the P2 view (entryTier
                                        // defaults), so a P2 edit upgrades an old
                                        // {height,priceSen} row in place by writing an
                                        // explicit tier:'PRICE_2'.
                                        const matches = (s: typeof arr[number]) =>
                                          norm(s.height) === hN && entryTier(s.tier) === sofaTier;
                                        if (!arr.find(matches)) {
                                          arr = [...arr, { height: hN, priceSen: val, tier: sofaTier }];
                                        }
                                        const updated = arr.map((s) =>
                                          matches(s) ? { height: hN, priceSen: val, tier: sofaTier } : s
                                        );
                                        // Mark the cell dirty in local state so the table
                                        // reflects the edit immediately, but DON'T touch
                                        // products yet — the bulk Save flow batches every
                                        // dirty cell into one product_prices row when the
                                        // user picks an effective date.
                                        setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, seatHeightPrices: updated } : pr));
                                        recordDirty(p.id, { seatHeightPrices: updated });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                        if (e.key === "Escape") setEditingSeatPrices(null);
                                      }}
                                      className="w-full text-right text-xs border border-[#6B5C32] rounded px-1 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => {
                                        if (!editMode) return;
                                        setSeatPriceInputs({ [h]: ((sh?.priceSen ?? 0) / 100).toFixed(2) });
                                        setEditingSeatPrices(editKey);
                                      }}
                                      className={`text-sm tabular-nums ${
                                        isSeatCellDirty(p.id, hNum, sofaTier)
                                          ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E] font-semibold"
                                          : "text-[#111827]"
                                      } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                    >
                                      {sh && sh.priceSen > 0 ? formatCurrency(sh.priceSen) : <span className="text-[#9CA3AF]">-</span>}
                                    </button>
                                  )}
                                </div>
                              );
                            }
                          }
                          // Analytic cells (Labor / Margin / Labor %), keyed by
                          // each analytic column's key. Same computation as before.
                          for (const c of activeAnalyticCols) {
                            const mainPrice = isSofa ? sofaRepPriceSen : basePrice;
                            const priceFor =
                              c.key === "marginP1" || c.key === "laborPctP1"
                                ? price1Val
                                : mainPrice;
                            const isPct =
                              c.key === "laborPctP2" || c.key === "laborPctP1";
                            bodyCellByKey[c.key] = (
                              <div
                                className="px-3 py-1.5 text-right text-sm tabular-nums truncate"
                                title={filterValueFor(p, c.key) || "—"}
                              >
                                {c.key === "labor" ? (
                                  laborCostSen > 0 ? (
                                    formatCurrency(laborCostSen)
                                  ) : (
                                    <span className="text-[#9CA3AF]">—</span>
                                  )
                                ) : priceFor <= 0 || laborCostSen <= 0 ? (
                                  <span className="text-[#9CA3AF]">—</span>
                                ) : isPct ? (
                                  <span className="text-[#111827]">
                                    {((laborCostSen / priceFor) * 100).toFixed(1)}%
                                  </span>
                                ) : (
                                  (() => {
                                    const m = priceFor - laborCostSen;
                                    return (
                                      <span
                                        className={
                                          m >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                                        }
                                      >
                                        {formatCurrency(m)}
                                        <span className="ml-1 text-[10px] text-[#9CA3AF]">
                                          ({((m / priceFor) * 100).toFixed(1)}%)
                                        </span>
                                      </span>
                                    );
                                  })()
                                )}
                              </div>
                            );
                          }
                          // Render every non-frozen column's cell in the exact
                          // header order. The frozen Code cell is rendered above
                          // (sticky-left); here we emit the rest from orderedCols
                          // so body order === header order === grid-track order.
                          return orderedCols
                            .filter((col) => !col.frozen)
                            .map((col) => (
                              <Fragment key={col.key}>
                                {bodyCellByKey[col.key] ?? null}
                              </Fragment>
                            ));
                        })()}
                      </div>
                      {/* Expanded section */}
                      {isExpanded && (
                        <div className="px-4 pb-4 space-y-3">
                          {cfg && <ProductionConfig config={cfg} />}

                          {/* ---- Price vs Labor (Margin) ----
                              Owner-requested side-by-side: each selling price
                              (Price 2 = company default tier `basePriceSen`,
                              Price 1 = `price1Sen`) against the estimated labor
                              cost, with margin = price − labor in RM and %.
                              Labor here is the flat-average estimate (RM2,200 /
                              26d / 9h / 60 — see LABOR_RATE_PER_MIN_SEN), NOT
                              full landed cost, so "margin" is price-minus-labor
                              only. Existing price labels are kept verbatim. */}
                          <div className="bg-[#FAF9F7] border border-[#E5E7EB] rounded-lg p-4">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-sm font-semibold text-[#374151]">
                                Price vs Labor (Margin)
                              </h4>
                              <span className="text-[10px] text-[#9CA3AF] italic">
                                Labor = est. {formatCurrency(LABOR_RATE_PER_MIN_SEN)}/min × {totalMin} min
                                {" "}(RM 2,200/mo ÷ 26d ÷ 9h)
                              </span>
                            </div>
                            {(() => {
                              // Margin row helper. price in sen; "—" when the
                              // price is unset (0) or minutes unknown so we never
                              // show a fake 100% margin against zero labor.
                              const marginRow = (label: string, priceSen: number) => {
                                const hasPrice = priceSen > 0;
                                const hasLabor = laborCostSen > 0;
                                const marginSen = priceSen - laborCostSen;
                                const marginPct = hasPrice
                                  ? (marginSen / priceSen) * 100
                                  : null;
                                return (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">{label}</div>
                                    <div className="mt-0.5 text-sm font-semibold text-[#111827] tabular-nums">
                                      {hasPrice ? formatCurrency(priceSen) : <span className="text-[#9CA3AF]">—</span>}
                                    </div>
                                    <div className="mt-1 text-[11px] text-[#6B7280] tabular-nums">
                                      Labor {hasLabor ? formatCurrency(laborCostSen) : "—"}
                                    </div>
                                    <div className="text-[11px] tabular-nums">
                                      {hasPrice && hasLabor ? (
                                        <span className={marginSen >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
                                          Margin {formatCurrency(marginSen)}
                                          {marginPct != null ? ` (${marginPct.toFixed(1)}%)` : ""}
                                        </span>
                                      ) : (
                                        <span className="text-[#9CA3AF]">Margin —</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              };

                              // Labor-only card — reads even when a SKU has no
                              // price set yet. Shared by both layouts below.
                              const laborCard = (
                                <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                  <div className="text-[10px] font-medium text-[#6B7280] uppercase">Labor Cost (est.)</div>
                                  <div className="mt-0.5 text-sm font-semibold text-[#111827] tabular-nums">
                                    {laborCostSen > 0 ? formatCurrency(laborCostSen) : <span className="text-[#9CA3AF]">—</span>}
                                  </div>
                                  <div className="mt-1 text-[11px] text-[#6B7280] tabular-nums">{totalMin} min</div>
                                </div>
                              );

                              // Sofas don't carry flat price1Sen/basePriceSen —
                              // their selling prices live in seatHeightPrices[]
                              // per (seat height, tier). Showing the flat Price 2/
                              // Price 1/Margin cards therefore reads "—" even for a
                              // sofa that DOES have prices, which is misleading. So
                              // for sofas we derive a representative price = the
                              // lowest positive seat-height price in the currently
                              // selected tier (sofaTier) and compute the margin
                              // against THAT, labelled "from RM x (seat height …)".
                              if (isSofa) {
                                const tierRep = (p.seatHeightPrices || [])
                                  .filter(
                                    (s) => entryTier(s.tier) === sofaTier && s.priceSen > 0,
                                  )
                                  .sort((a, b) => a.priceSen - b.priceSen)[0];
                                const tierLabel =
                                  SOFA_TIERS.find((t) => t.value === sofaTier)?.label ?? "";
                                const repPriceSen = tierRep?.priceSen ?? 0;
                                const hasRep = repPriceSen > 0;
                                const hasLabor = laborCostSen > 0;
                                const marginSen = repPriceSen - laborCostSen;
                                const marginPct = hasRep ? (marginSen / repPriceSen) * 100 : null;
                                const repHeight = tierRep
                                  ? String(tierRep.height).replace('"', "")
                                  : null;
                                return (
                                  <>
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                      <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                        <div className="text-[10px] font-medium text-[#6B7280] uppercase">
                                          Price (from, {tierLabel})
                                        </div>
                                        <div className="mt-0.5 text-sm font-semibold text-[#111827] tabular-nums">
                                          {hasRep ? (
                                            <>
                                              {formatCurrency(repPriceSen)}
                                              {repHeight && (
                                                <span className="ml-1 text-[10px] font-normal text-[#9CA3AF]">
                                                  Seat {repHeight}"
                                                </span>
                                              )}
                                            </>
                                          ) : (
                                            <span className="text-[#9CA3AF]">—</span>
                                          )}
                                        </div>
                                        <div className="mt-1 text-[11px] text-[#6B7280] tabular-nums">
                                          Labor {hasLabor ? formatCurrency(laborCostSen) : "—"}
                                        </div>
                                        <div className="text-[11px] tabular-nums">
                                          {hasRep && hasLabor ? (
                                            <span className={marginSen >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
                                              Margin {formatCurrency(marginSen)}
                                              {marginPct != null ? ` (${marginPct.toFixed(1)}%)` : ""}
                                            </span>
                                          ) : (
                                            <span className="text-[#9CA3AF]">Margin —</span>
                                          )}
                                        </div>
                                      </div>
                                      {laborCard}
                                    </div>
                                    <p className="mt-2 text-[10px] text-[#9CA3AF] italic">
                                      Sofa price varies by seat height — see each height's price above. Margin here compares against the lowest seat-height price in the current {tierLabel} tier.
                                    </p>
                                  </>
                                );
                              }

                              // Bedframes / accessories keep the flat-price cards
                              // verbatim — those fields are correct for them.
                              return (
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                  {marginRow("Price 2", basePrice)}
                                  {marginRow("Price 1", price1Val)}
                                  {laborCard}
                                </div>
                              );
                            })()}
                          </div>

                          {/* Variant Defaults Summary — flat key/value cards
                              for the fields the operator has actually set,
                              one card per non-empty default. Edit hops back
                              into the dialog for changes. */}
                          {hasVariantDefaults && (
                            <div className="bg-[#FAF9F7] border border-[#E5E7EB] rounded-lg p-4">
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-semibold text-[#374151]">Variant Defaults</h4>
                                <button
                                  onClick={() => setEditingVariant(p)}
                                  className="text-xs text-[#6B5C32] hover:underline"
                                >
                                  Edit
                                </button>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                {variantDefaults.fabricCode && (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">Fabric</div>
                                    <div className="text-sm font-medium text-[#111827]">{variantDefaults.fabricCode}</div>
                                  </div>
                                )}
                                {variantDefaults.divanHeight && (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">Divan Height</div>
                                    <div className="text-sm font-medium text-[#111827]">{variantDefaults.divanHeight}</div>
                                  </div>
                                )}
                                {variantDefaults.legHeight && (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">Leg Height</div>
                                    <div className="text-sm font-medium text-[#111827]">{variantDefaults.legHeight}</div>
                                  </div>
                                )}
                                {variantDefaults.gap && (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">Gap</div>
                                    <div className="text-sm font-medium text-[#111827]">{variantDefaults.gap}</div>
                                  </div>
                                )}
                                {variantDefaults.seatHeight && (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">Seat Height</div>
                                    <div className="text-sm font-medium text-[#111827]">{variantDefaults.seatHeight}</div>
                                  </div>
                                )}
                                {(variantDefaults.specials?.length ?? 0) > 0 && (
                                  <div className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB] col-span-2 md:col-span-3">
                                    <div className="text-[10px] font-medium text-[#6B7280] uppercase">Specials</div>
                                    <div className="text-sm font-medium text-[#111827]">
                                      {(variantDefaults.specials ?? []).join(" · ")}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="flex gap-2">
                            <Link to={`/products/${p.id}/bom`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#3E6570] bg-[#E0EDF0] border border-[#A8CAD2] rounded-md hover:bg-[#E0EDF0] transition-colors"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                              </svg>
                              View BOM
                            </Link>
                            <Link to={`/products/${p.id}/documents`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#6B5C32] bg-[#F0ECE9] border border-[#D8CFC0] rounded-md hover:bg-[#E8E2D9] transition-colors"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5-3H12m-8.25-9v15.75c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9H4.875C4.254 2.25 3.75 2.754 3.75 3.375z" />
                              </svg>
                              Docs
                            </Link>
                            <button
                              onClick={() => setEditingVariant(p)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#6B5C32] bg-[#FAEFCB] border border-[#E8D597] rounded-md hover:bg-[#FAEFCB] transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
                              </svg>
                              Manage Variants
                            </button>
                          </div>

                          {/* Customer Assignments */}
                          <CustomerAssignmentsSection productId={p.id} active={isExpanded} />

                          {/* CNC Cutting Template — fabric-cutting files for
                              the BUYI E-DIGIT cutter, keyed by the bare
                              product code (variant suffix stripped) and
                              narrowed by this SKU's size. */}
                          <CncTemplatePanel
                            productCode={baseProductCode(p.code)}
                            size={p.sizeLabel}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
                    })}
                    {padBottom > 0 && (
                      <tr aria-hidden="true">
                        <td
                          colSpan={colSpanN}
                          style={{ height: padBottom, padding: 0, border: 0 }}
                        />
                      </tr>
                    )}
                  </>
                );
              })()}
            </tbody>
          </table>
        </div>

        {/* Record count footer */}
        <div className="px-4 py-2 bg-[#F9FAFB] border-t border-[#E5E7EB] flex items-center justify-between">
          <span className="text-xs text-[#6B7280]">
            Record {filtered.length > 0 ? 1 : 0} of {filtered.length}
          </span>
          <span className="text-xs text-[#9CA3AF]">
            {products.length} total products
          </span>
        </div>
      </div>
        );
      })()}

      {/* Variant Editor Dialog (only in SKU Master mode) */}
      {editingVariant && (
        <VariantEditorDialog
          open={!!editingVariant}
          onClose={() => setEditingVariant(null)}
          product={editingVariant}
          defaults={editingVariant.defaultVariants ?? {}}
          maintenanceConfig={maintenanceConfig}
          fabrics={fabricList}
          saving={variantSaving}
          onSave={async (v) => {
            const ok = await saveDefaultVariants(editingVariant.id, v);
            if (ok) setEditingVariant(null);
          }}
        />
      )}

      {/* Master price history — schedule effective-dated price changes */}
      <MasterPriceHistoryDialog
        product={scheduleProduct}
        onClose={() => setScheduleProductId(null)}
        onSaved={reloadProductsAfterSchedule}
      />

      {/* Bulk save dialog — surfaces when the user clicks "Save N changes"
          while in edit mode. Captures the effective date and an optional
          shared note, then dispatches one product_prices history row per
          dirty product. Future-dated rows park as Pending until the date
          passes; past dates are allowed for backfilling historical prices. */}
      {showBulkSaveDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => !bulkSaving && setShowBulkSaveDialog(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-[90vw] max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">
                Save {dirtyEdits.size} price change
                {dirtyEdits.size === 1 ? "" : "s"}
              </h2>
              <p className="text-xs text-[#6B7280] mt-1">
                Pick the date the new prices should take effect. All
                changes share the same effective date.
              </p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Effective from *
                </label>
                <input
                  type="date"
                  value={bulkEffectiveFrom}
                  onChange={(e) => setBulkEffectiveFrom(e.target.value)}
                  className="w-full border border-[#E2DDD8] rounded px-2 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                />
                <p className="text-[10px] text-[#9CA3AF] mt-1">
                  Past dates allowed (backfill / corrections); future dates
                  show a Pending badge until they take effect.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Notes (optional)
                </label>
                <input
                  type="text"
                  value={bulkNotes}
                  onChange={(e) => setBulkNotes(e.target.value)}
                  placeholder="e.g. Q3 sofa P2 hike"
                  className="w-full border border-[#E2DDD8] rounded px-2 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                />
              </div>
              <div className="text-xs text-[#6B7280] bg-[#F9FAFB] border border-[#E5E7EB] rounded px-3 py-2 max-h-40 overflow-y-auto">
                <p className="font-medium text-[#374151] mb-1">
                  Affecting {dirtyEdits.size} SKU
                  {dirtyEdits.size === 1 ? "" : "s"}:
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {Array.from(dirtyEdits.values()).slice(0, 8).map((d) => {
                    const prod = products.find((p) => p.id === d.productId);
                    return (
                      <li key={d.productId} className="truncate">
                        {prod ? `${prod.code} — ${prod.name}` : d.productId}
                      </li>
                    );
                  })}
                  {dirtyEdits.size > 8 && (
                    <li className="text-[#9CA3AF]">
                      …and {dirtyEdits.size - 8} more
                    </li>
                  )}
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
              <button
                onClick={() => !bulkSaving && setShowBulkSaveDialog(false)}
                disabled={bulkSaving}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void bulkSave()}
                disabled={bulkSaving || dirtyEdits.size === 0}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#6B5C32] text-white hover:bg-[#5A4E2A] disabled:opacity-50"
              >
                {bulkSaving
                  ? "Saving…"
                  : `Save ${dirtyEdits.size} change${dirtyEdits.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
