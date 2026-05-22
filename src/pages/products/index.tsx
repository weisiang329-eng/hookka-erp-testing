import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cachedFetchJson, invalidateCachePrefix, useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { Link } from "react-router-dom";
import { formatCurrency } from "@/lib/utils";
import { Plus, Trash2, Check, Calendar, History, Pencil } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { ProductSchema } from "@/lib/schemas/product";
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
    if (!window.confirm(`Remove assignment to ${customerName}?`)) return;
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
  | "sofaLegHeights"
  | "sofaSpecials"
  | "sofaSizes";

type PricedOption = { value: string; priceSen: number };

type MaintenanceConfig = {
  divanHeights: PricedOption[];
  legHeights: PricedOption[];
  totalHeights: PricedOption[];
  gaps: string[];
  specials: PricedOption[];
  sofaLegHeights: PricedOption[];
  sofaSpecials: PricedOption[];
  sofaSizes: string[];
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
  legHeights: [
    { value: "No Leg", priceSen: 0 },
    { value: '1"', priceSen: 0 },
    { value: '2"', priceSen: 0 },
    { value: '4"', priceSen: 0 },
    { value: '6"', priceSen: 0 },
    { value: '7"', priceSen: 16000 },
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
  sofaLegHeights: [
    { value: "No Leg", priceSen: 0 },
    { value: '4"', priceSen: 0 },
    { value: '6"', priceSen: 0 },
  ],
  sofaSpecials: [
    { value: "Nylon Fabric", priceSen: 0 },
    { value: "5537 Backrest", priceSen: 0 },
    { value: "Separate Backrest Packing", priceSen: 0 },
  ],
  sofaSizes: ["24", "26", "28", "30", "32", "35"],
};

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
  { key: "sofaSizes", label: "Sizes", description: "Available sofa seat height sizes (inches)", section: "Sofa" },
  { key: "sofaLegHeights", label: "Leg Heights", description: "Sofa leg height options with surcharge pricing", priced: true, section: "Sofa" },
  { key: "sofaSpecials", label: "Specials", description: "Sofa special order options with surcharge pricing", priced: true, section: "Sofa" },
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

    return {
      divanHeights: ensurePriced(parsed.divanHeights, DEFAULT_MAINTENANCE_CONFIG.divanHeights),
      legHeights: ensurePriced(parsed.legHeights, DEFAULT_MAINTENANCE_CONFIG.legHeights),
      totalHeights: ensurePriced(parsed.totalHeights, DEFAULT_MAINTENANCE_CONFIG.totalHeights),
      gaps: ensureStrings(parsed.gaps, DEFAULT_MAINTENANCE_CONFIG.gaps),
      specials: ensurePriced(parsed.specials, DEFAULT_MAINTENANCE_CONFIG.specials),
      sofaLegHeights: ensurePriced(parsed.sofaLegHeights, DEFAULT_MAINTENANCE_CONFIG.sofaLegHeights),
      sofaSpecials: ensurePriced(parsed.sofaSpecials, DEFAULT_MAINTENANCE_CONFIG.sofaSpecials),
      sofaSizes: ensureStrings(parsed.sofaSizes, DEFAULT_MAINTENANCE_CONFIG.sofaSizes),
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
  const [tab, setTab] = useState<MaintenanceTab>("divanHeights");
  const [newValue, setNewValue] = useState("");
  const [newPriceSen, setNewPriceSen] = useState(0);
  // (Legacy click-to-edit state removed — inputs are now always editable
  // when editMode is on, mirroring the SKU Master pattern.)
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMsg, setToastMsg] = useState("Saved");

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

  const isFabricsTab = tab === "fabrics";
  const meta = MAINTENANCE_TABS.find((t) => t.key === tab)!;
  const isPricedTab = !isFabricsTab && (meta.priced ?? false);
  const currentStringList = !isFabricsTab && !isPricedTab ? (config[tab as MaintenanceListKey] as string[]) : [];
  const currentPricedList = !isFabricsTab && isPricedTab ? (config[tab as MaintenanceListKey] as PricedOption[]) : [];

  function addEntry() {
    if (isFabricsTab || !editMode) return;
    const k = tab as MaintenanceListKey;
    const v = newValue.trim();
    if (!v) return;
    if (isPricedTab) {
      const list = config[k] as PricedOption[];
      if (list.some(o => o.value === v)) { setNewValue(""); return; }
      setConfig(prev => ({ ...prev, [k]: [...(prev[k] as PricedOption[]), { value: v, priceSen: newPriceSen }] }));
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

  function handleCancel() {
    if (
      isDirty &&
      !window.confirm("Discard your unsaved Maintenance edits?")
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
          const res = await fetch(`/api/fabric-tracking/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ priceTier: toTier }),
          });
          if (!res.ok) {
            throw new Error(`Failed to update fabric tier (HTTP ${res.status})`);
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
                  <input
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEntry(); } }}
                    placeholder={`Add new ${meta.label.toLowerCase().replace(/s$/, "")}...`}
                    className="flex-1 text-sm border border-[#E2DDD8] rounded-md px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                  />
                  {isPricedTab && (
                    <div className="flex items-center gap-1">
                      {/* Surcharge can be negative — some variants are a
                        * discount off the base price (e.g. "No Leg" = -RM10).
                        * Label stays neutral; the number carries its sign. */}
                      <span className="text-xs text-gray-500">RM</span>
                      <input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        step="0.01"
                        value={newPriceSen / 100}
                        onChange={(e) => setNewPriceSen(Math.round(parseFloat(e.target.value || "0") * 100))}
                        className="w-24 text-right text-sm border border-[#E2DDD8] rounded-md px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                        placeholder="0.00"
                      />
                    </div>
                  )}
                  <button
                    onClick={addEntry}
                    disabled={!newValue.trim()}
                    className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
              )}

              {/* List */}
              <div className="space-y-1.5">
                {isPricedTab ? (
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
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-400">RM</span>
                            {editMode ? (
                              <input
                                type="number" onFocus={(e) => e.currentTarget.select()}
                                step="0.01"
                                value={entry.priceSen / 100}
                                onChange={(e) => updatePrice(idx, Math.round(parseFloat(e.target.value || "0") * 100))}
                                className="w-20 text-right text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32]"
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
  const [viewMode, setViewMode] = useState<"skuMaster" | "maintenance">("skuMaster");
  const [products, setProducts] = useState<Product[]>([]);
  const [configs, setConfigs] = useState<ProductDeptConfig[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("BEDFRAME");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [loading, setLoading] = useState(true);
  // Master Maintenance config (kv_config 'variants-config'). Variant editor
  // dialog reads divan/leg/gap/specials/sofa option lists from here so any
  // value the operator adds in the Maintenance tab is immediately
  // selectable as a default.
  const [maintenanceConfig, setMaintenanceConfig] = useState<MaintenanceConfig>(DEFAULT_MAINTENANCE_CONFIG);
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
  const [editingPrice1, setEditingPrice1] = useState<string | null>(null);
  const [price1Input, setPrice1Input] = useState("");
  const [importing, setImporting] = useState(false);

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
      const requests = Array.from(dirtyEdits.values()).map((d) => {
        const prod = products.find((p) => p.id === d.productId);
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
        return fetch(`/api/products/${d.productId}/prices`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => ({ ok: r.ok, status: r.status, productId: d.productId }));
      });
      const results = await Promise.all(requests);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        alert(
          `${failed.length} of ${results.length} updates failed. The successful ones were saved.`,
        );
      }
      // Wipe local dirty state and reload so the table reflects the new
      // currently-effective price (or shows the Pending badge if the
      // effective date is in the future).
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
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydrate of master config + fabrics for the variant dialog */
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
  /* eslint-enable react-hooks/set-state-in-effect */

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
      const res = await fetch(`/api/products/${productId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultVariants: defaults }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        toast.error(`Save failed: ${json.error || res.statusText}`);
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
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
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
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return products.filter((p) => p.category === categoryFilter);
    return products.filter((p) => {
      const hay = [p.code, p.name, p.description, p.baseModel, p.category]
        .map((v) => (v || "").toLowerCase())
        .join(" ");
      return hay.includes(q);
    });
  }, [products, categoryFilter, searchQuery]);

  // ── Row virtualization for the SKU-master catalog table ────────────────
  // The catalog renders one inline-edit row per product (10+ grid cells,
  // price inputs, an expand panel). At a few hundred SKUs that is thousands
  // of DOM nodes — slow first paint, and a full re-render of every row on
  // each price keystroke. The virtualizer keeps only the visible window
  // (~20 rows) mounted; row heights vary (a row grows tall when expanded),
  // so measureElement measures each rendered row instead of a fixed guess.
  const productsScrollRef = useRef<HTMLDivElement>(null);
  const catalogRowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => productsScrollRef.current,
    estimateSize: () => 40,
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
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
        <div className="flex gap-2 items-center">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                categoryFilter === cat && !searchQuery
                  ? "bg-[#111827] text-white"
                  : "bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6]"
              }`}
            >
              {cat.charAt(0) + cat.slice(1).toLowerCase()}
            </button>
          ))}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search all products..."
            className="px-3 py-1.5 rounded-md text-xs border border-[#E5E7EB] bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30 w-56"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-[11px] text-[#6B7280] hover:text-[#111827] px-1"
              title="Clear search"
            >
              ✕
            </button>
          )}
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
          {/* Edit / Save / Cancel — every price edit on this page goes
              through this gate now. Cells are click-to-edit only while
              editMode is on; clicking Save opens a modal that asks for the
              effective date and dispatches one product_prices history row
              per dirty product. */}
          {!editMode ? (
            <button
              onClick={() => setEditMode(true)}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E5E7EB] hover:bg-[#F3F4F6] transition-colors"
            >
              Edit Prices
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
                onClick={() => {
                  if (
                    dirtyEdits.size > 0 &&
                    !confirm(
                      `Discard ${dirtyEdits.size} unsaved change${dirtyEdits.size === 1 ? "" : "s"}?`,
                    )
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

      {/* Subtitle for SKU Master */}
      {viewMode === "skuMaster" && (
        <p className="text-sm text-[#6B7280] -mt-4">
          {filtered.length} product{filtered.length !== 1 ? "s" : ""} &middot; Production configs from SKU sheet
        </p>
      )}

      {/* Maintenance View */}
      {viewMode === "maintenance" && <MaintenanceView />}

      {/* Table — different column layout for Bedframe vs Sofa */}
      {viewMode === "skuMaster" && (() => {
        const isSofa = categoryFilter === "SOFA";
        const isAccessory = categoryFilter === "ACCESSORY";
        const colSpanN = isSofa ? 13 : isAccessory ? 8 : 10;
        const gridCols = isSofa
          // Sofa: Code | Description | Model | 24 | 28 | 30 | 32 | 35 | Unit | Fabric | Total Min | Variants
          // 24/28/30/32/35 price cells need "RM 1,000.00" room (0.95fr).
          // Total Min column was too narrow (0.6fr) — "1405 min" wrapped to
          // two lines. Widened to 0.9fr and trimmed Description by 0.3fr to
          // compensate (descriptions echo the SKU code, plenty of headroom).
          ? "1.3fr 1.2fr 0.55fr 0.95fr 0.95fr 0.95fr 0.95fr 0.95fr 0.6fr 0.5fr 0.9fr 0.7fr"
          : isAccessory
          // ACCESSORY: Code | Description | Base Price | Unit M3 | Fabric
          // (no Category/Size/Price2 — pillows don't carry those), and
          // no Total Min / Variants / seat-height columns either.
          ? "1.3fr 2.5fr 1fr 0.7fr 1fr"
          // Bedframe: Total Min bumped 0.7→0.9 for the same reason as sofa.
          : "1.3fr 1.8fr 0.8fr 0.8fr 1fr 1fr 0.7fr 0.7fr 0.9fr 0.8fr";
        const thCls = "px-3 py-1.5 text-[11px] font-medium text-[#6B7280] uppercase tracking-wider";
        return (
      <div className="bg-white rounded-lg border border-[#E5E7EB] overflow-hidden">
        <div
          ref={productsScrollRef}
          className="overflow-auto"
          style={{ maxHeight: "calc(100vh - 320px)" }}
        >
          <table className="min-w-full divide-y divide-[#E5E7EB]">
            <thead className="bg-[#F9FAFB] sticky top-0 z-10">
              <tr>
                <th colSpan={colSpanN} className="p-0">
                  <div className="grid" style={{ gridTemplateColumns: gridCols }}>
                    {/* Product Code header carries an invisible chevron
                      * spacer so the "Product Code" label lines up with
                      * the body cell's code text — the body row renders
                      * an expand arrow before the code, and without this
                      * placeholder the header text sat ~20px to the left
                      * of the code values below. */}
                    <div className={`${thCls} text-left flex items-center gap-1.5`}>
                      <span className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                      Product Code
                    </div>
                    <div className={`${thCls} text-left`}>Description</div>
                    {isSofa ? (
                      <>
                        <div className={`${thCls} text-left`}>Model</div>
                        <div className={`${thCls} text-right`}>24</div>
                        <div className={`${thCls} text-right`}>28</div>
                        <div className={`${thCls} text-right`}>30</div>
                        <div className={`${thCls} text-right`}>32</div>
                        <div className={`${thCls} text-right`}>35</div>
                        <div className={`${thCls} text-right`}>Unit (m&sup3;)</div>
                        <div className={`${thCls} text-right`}>Fabric</div>
                        <div className={`${thCls} text-right`}>Total Min</div>
                        <div className={`${thCls} text-center`}>Variants</div>
                      </>
                    ) : isAccessory ? (
                      <>
                        <div className={`${thCls} text-right`}>Base Price</div>
                        <div className={`${thCls} text-right`}>Unit (m&sup3;)</div>
                        <div className={`${thCls} text-right`}>Fabric</div>
                      </>
                    ) : (
                      <>
                        <div className={`${thCls} text-left`}>Category</div>
                        <div className={`${thCls} text-left`}>Size</div>
                        <div className={`${thCls} text-right`}>Price 2</div>
                        <div className={`${thCls} text-right`}>Price 1</div>
                        <div className={`${thCls} text-right`}>Unit (m&sup3;)</div>
                        <div className={`${thCls} text-right`}>Fabric</div>
                        <div className={`${thCls} text-right`}>Total Min</div>
                        <div className={`${thCls} text-center`}>Variants</div>
                      </>
                    )}
                  </div>
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
                        className="grid cursor-pointer hover:bg-[#F9FAFB] transition-colors"
                        style={{ gridTemplateColumns: gridCols }}
                        onClick={() => setExpandedId(isExpanded ? null : p.id)}
                      >
                        <div className="px-3 py-1.5 flex items-center gap-1.5">
                          <svg
                            className={`w-3.5 h-3.5 text-[#9CA3AF] transition-transform flex-shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="text-xs font-mono font-medium text-[#111827] whitespace-nowrap">{p.code}</span>
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
                        <div className="px-3 py-1.5 min-w-0">
                          <span className="text-xs text-[#111827] truncate block">{p.name}</span>
                          <span className="block text-[11px] text-[#9CA3AF] truncate">{p.description}</span>
                        </div>

                        {isSofa ? (
                          /* ===== SOFA columns: Model | 24 | 28 | 30 | 32 | 35 ===== */
                          <>
                            <div className="px-3 py-1.5 text-sm text-[#111827]">{p.baseModel}</div>
                            {(['24"', '28"', '30"', '32"', '35"'] as const).map((h) => {
                              const hNum = h.replace('"', '');
                              // Match heights regardless of storage type — DB has carried
                              // int 24, string "24", and string '24"' at different times, so
                              // normalise both sides before comparing. Prevents the find()
                              // miss that caused the Products page to show blank sofa prices
                              // and produced duplicate entries on edit.
                              const norm = (v: unknown) => String(v ?? "").replace('"', '').trim();
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
                              return (
                                <div key={h} className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                                  {isEditingThis ? (
                                    <input
                                      autoFocus
                                      type="number" onFocus={(e) => e.currentTarget.select()}
                                      step="0.01"
                                      value={seatPriceInputs[h] ?? ""}
                                      onChange={(e) => setSeatPriceInputs((prev) => ({ ...prev, [h]: e.target.value }))}
                                      onBlur={() => {
                                        const val = Math.round(parseFloat(seatPriceInputs[h] || "0") * 100);
                                        setEditingSeatPrices(null);
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
                            })}
                          </>
                        ) : isAccessory ? null : (
                          /* ===== BEDFRAME / ALL columns: Category | Size | Price 2 | Price 1 ===== */
                          <>
                            <div className="px-3 py-1.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                p.category === "BEDFRAME" ? "bg-[#FAEFCB] text-[#9C6F1E]" : "bg-[#E0EDF0] text-[#3E6570]"
                              }`}>
                                {p.category}
                              </span>
                            </div>
                            <div className="px-3 py-1.5 text-sm text-[#111827]">{p.sizeLabel}</div>
                            {/* Price 2 */}
                            <div className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {isEditingThisPrice ? (
                                <input
                                  autoFocus
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  value={priceInput}
                                  onChange={(e) => setPriceInput(e.target.value)}
                                  onBlur={() => {
                                    const val = Math.round(parseFloat(priceInput || "0") * 100);
                                    setEditingPrice(null);
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
                            {/* Price 1 */}
                            <div className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {editingPrice1 === p.id ? (
                                <input
                                  autoFocus
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  value={price1Input}
                                  onChange={(e) => setPrice1Input(e.target.value)}
                                  onBlur={() => {
                                    const val = Math.round(parseFloat(price1Input || "0") * 100);
                                    setEditingPrice1(null);
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
                          </>
                        )}
                        {isAccessory ? (
                          /* ===== ACCESSORY columns: Base Price | Unit M3 | Fabric (no edit) ===== */
                          <>
                            <div className="px-3 py-1.5 text-right">
                              <span className="text-sm font-medium text-[#111827]">
                                {basePrice > 0 ? formatCurrency(basePrice) : <span className="text-[#9CA3AF]">-</span>}
                              </span>
                            </div>
                            <div className="px-3 py-1.5 text-right text-sm text-[#111827]">
                              {(cfg?.unitM3 ?? p.unitM3).toFixed(3)}
                            </div>
                            <div className="px-3 py-1.5 text-right text-sm text-[#111827]">
                              {(cfg?.fabricUsage ?? p.fabricUsage)} m
                            </div>
                          </>
                        ) : (
                          <>
                            {/* Unit M3 - editable */}
                            <div className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {editingM3 === p.id ? (
                                <input
                                  autoFocus
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  value={m3Input}
                                  onChange={(e) => setM3Input(e.target.value)}
                                  onBlur={() => {
                                    const val = parseFloat(m3Input || "0") || 0;
                                    setEditingM3(null);
                                    setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, unitM3: val } : pr));
                                    fetchJson(`/api/products/${p.id}`, ProductMutationSchema, {
                                      method: "PUT",
                                      body: { unitM3: val },
                                    }).then((data) => {
                                      if (data.success && data.data) {
                                        invalidateCachePrefix("/api/products");
                                        invalidateCachePrefix("/api/bom");
                                        invalidateCachePrefix("/api/bom-master-templates");
                                        setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, ...(data.data as Partial<Product>) } : pr));
                                      }
                                    }).catch(() => {});
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                    if (e.key === "Escape") setEditingM3(null);
                                  }}
                                  className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                  step="0.001"
                                />
                              ) : (
                                <button
                                  onClick={() => { setEditingM3(p.id); setM3Input((cfg?.unitM3 ?? p.unitM3).toFixed(3)); }}
                                  className="text-sm text-[#111827] hover:text-[#6B5C32] hover:underline"
                                >
                                  {(cfg?.unitM3 ?? p.unitM3).toFixed(3)}
                                </button>
                              )}
                            </div>
                            <div className="px-3 py-1.5 text-right text-sm text-[#111827]">
                              {(cfg?.fabricUsage ?? p.fabricUsage)} m
                            </div>
                            <div className="px-3 py-1.5 text-right text-sm font-medium text-[#111827] whitespace-nowrap">
                              {totalMin} min
                            </div>
                            {/* Variants badge */}
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
                          </>
                        )}
                      </div>
                      {/* Expanded section */}
                      {isExpanded && (
                        <div className="px-4 pb-4 space-y-3">
                          {cfg && <ProductionConfig config={cfg} />}

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
