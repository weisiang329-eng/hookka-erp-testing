import { useState, useEffect, useMemo } from "react";
import { cachedFetchJson, invalidateCachePrefix, useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { Link } from "react-router-dom";
import { formatCurrency } from "@/lib/utils";
import { Plus, Trash2, Save, AlertCircle, Check } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { ProductSchema } from "@/lib/schemas/product";

const ProductMutationSchema = mutationWithData(ProductSchema);
import {
  fetchVariantsConfig,
  getVariantsConfigSync,
  patchVariantsConfig,
  subscribeKvConfig,
  subscribeKvConfigSaveError,
  flushKvConfig,
  VARIANTS_CONFIG_KEY,
  type VariantsConfig,
} from "@/lib/kv-config";

// ---------- Types matching mock-data ----------
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
  seatHeightPrices?: { height: string; priceSen: number }[];
  productionTimeMinutes: number;
  subAssemblies: string[];
  deptWorkingTimes: DeptWorkingTime[];
};

type VariantOption = {
  value: string;
  label: string;
  priceSen: number;
  isDefault: boolean;
};

type ProductVariantConfig = {
  category: string; // FABRIC, DIVAN_HEIGHT, LEG_HEIGHT, SPECIAL
  label: string;
  options: VariantOption[];
};

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
const DEFAULT_VARIANT_CONFIGS: Record<string, ProductVariantConfig[]> = {
  // Bedframe defaults
  "1003": [
    { category: "DIVAN_HEIGHT", label: "Divan Height", options: [
      { value: '8"', label: '8"', priceSen: 0, isDefault: true },
      { value: '10"', label: '10"', priceSen: 5000, isDefault: false },
      { value: '12"', label: '12"', priceSen: 10000, isDefault: false },
    ]},
    { category: "LEG_HEIGHT", label: "Leg Height", options: [
      { value: "NO_LEG", label: "No Leg", priceSen: 0, isDefault: true },
      { value: '2"', label: '2"', priceSen: 0, isDefault: false },
      { value: '4"', label: '4"', priceSen: 3000, isDefault: false },
      { value: '6"', label: '6"', priceSen: 5000, isDefault: false },
    ]},
    { category: "SPECIAL", label: "Special Order", options: [
      { value: "NONE", label: "None", priceSen: 0, isDefault: true },
      { value: "NO_LEG", label: "No Leg", priceSen: 0, isDefault: false },
      { value: "EXTRA_FOAM", label: "Extra Foam", priceSen: 8000, isDefault: false },
    ]},
  ],
};

// ---------- Variant Editor Dialog ----------
function VariantEditorDialog({
  open, onClose, product, variants, onSave,
}: {
  open: boolean; onClose: () => void; product: Product;
  variants: ProductVariantConfig[]; onSave: (v: ProductVariantConfig[]) => void;
}) {
  const [configs, setConfigs] = useState<ProductVariantConfig[]>([]);

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot deep clone of variants into editor state when dialog opens */
  useEffect(() => {
    if (open) setConfigs(variants.map((v) => ({ ...v, options: v.options.map((o) => ({ ...o })) })));
  }, [open, variants]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function addVariantCategory() {
    setConfigs((prev) => [...prev, {
      category: "CUSTOM", label: "Custom Option", options: [
        { value: "default", label: "Default", priceSen: 0, isDefault: true },
      ],
    }]);
  }

  function removeCategory(ci: number) {
    setConfigs((prev) => prev.filter((_, i) => i !== ci));
  }

  function updateCategory(ci: number, field: string, value: string) {
    setConfigs((prev) => prev.map((c, i) => i === ci ? { ...c, [field]: value } : c));
  }

  function addOption(ci: number) {
    setConfigs((prev) => prev.map((c, i) =>
      i === ci ? { ...c, options: [...c.options, { value: "", label: "", priceSen: 0, isDefault: false }] } : c
    ));
  }

  function removeOption(ci: number, oi: number) {
    setConfigs((prev) => prev.map((c, i) =>
      i === ci ? { ...c, options: c.options.filter((_, j) => j !== oi) } : c
    ));
  }

  function updateOption(ci: number, oi: number, field: string, value: string | number | boolean) {
    setConfigs((prev) => prev.map((c, i) =>
      i === ci ? {
        ...c,
        options: c.options.map((o, j) => {
          if (j !== oi) return field === "isDefault" && value === true ? { ...o, isDefault: false } : o;
          return { ...o, [field]: value };
        }),
      } : c
    ));
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[680px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E5E7EB]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Variant Maintenance</h2>
            <p className="text-xs text-[#6B7280] mt-0.5">{product.code} — {product.name}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {configs.map((cfg, ci) => (
            <div key={ci} className="border border-[#E5E7EB] rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <select value={cfg.category} onChange={(e) => updateCategory(ci, "category", e.target.value)}
                  className="text-sm border border-[#E5E7EB] rounded px-2 py-1 bg-white">
                  <option value="DIVAN_HEIGHT">Divan Height</option>
                  <option value="LEG_HEIGHT">Leg Height</option>
                  <option value="FABRIC">Fabric</option>
                  <option value="SPECIAL">Special Order</option>
                  <option value="SEAT_HEIGHT">Seat Height</option>
                  <option value="SOFA_LEG">Sofa Leg</option>
                  <option value="CUSTOM">Custom</option>
                </select>
                <input value={cfg.label} onChange={(e) => updateCategory(ci, "label", e.target.value)}
                  className="text-sm border border-[#E5E7EB] rounded px-2 py-1 flex-1" placeholder="Label" />
                <button onClick={() => removeCategory(ci)} className="p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>

              {/* Options table */}
              <div className="space-y-1">
                <div className="grid grid-cols-[1fr_1.5fr_0.8fr_0.5fr_0.3fr] gap-1 text-[10px] font-medium text-[#6B7280] uppercase px-1">
                  <span>Value</span><span>Label</span><span>Price +/-</span><span>Default</span><span></span>
                </div>
                {cfg.options.map((opt, oi) => (
                  <div key={oi} className="grid grid-cols-[1fr_1.5fr_0.8fr_0.5fr_0.3fr] gap-1 items-center">
                    <input value={opt.value} onChange={(e) => updateOption(ci, oi, "value", e.target.value)}
                      className="text-xs border border-[#E5E7EB] rounded px-1.5 py-1 font-mono" />
                    <input value={opt.label} onChange={(e) => updateOption(ci, oi, "label", e.target.value)}
                      className="text-xs border border-[#E5E7EB] rounded px-1.5 py-1" />
                    <input type="number" value={opt.priceSen / 100} onChange={(e) => updateOption(ci, oi, "priceSen", Math.round(parseFloat(e.target.value || "0") * 100))}
                      className="text-xs border border-[#E5E7EB] rounded px-1.5 py-1" step="0.01" />
                    <div className="flex justify-center">
                      <input type="radio" name={`default-${ci}`} checked={opt.isDefault}
                        onChange={() => updateOption(ci, oi, "isDefault", true)} className="accent-[#6B5C32]" />
                    </div>
                    <button onClick={() => removeOption(ci, oi)} className="text-[#9A3A2D] hover:text-[#7A2E24] text-center">
                      <svg className="w-3.5 h-3.5 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button onClick={() => addOption(ci)} className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded hover:bg-gray-200">
                  + Add Option
                </button>
              </div>
            </div>
          ))}

          <button onClick={addVariantCategory}
            className="w-full py-2 text-xs border border-dashed border-[#E5E7EB] rounded-lg text-[#6B7280] hover:bg-[#F9FAFB]">
            + Add Variant Category
          </button>
        </div>

        <div className="px-6 py-4 border-t border-[#E5E7EB] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-[#E5E7EB] rounded-lg text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={() => { onSave(configs); onClose(); }} className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A]">Save Variants</button>
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
  const [config, setConfig] = useState<MaintenanceConfig>(DEFAULT_MAINTENANCE_CONFIG);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [tab, setTab] = useState<MaintenanceTab>("divanHeights");
  const [newValue, setNewValue] = useState("");
  const [newPriceSen, setNewPriceSen] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMsg, setToastMsg] = useState("Saved");
  // Server-side save state. Before this flag existed the UI flipped to
  // "Auto-saved" as soon as setKvConfig returned — which is before the PUT
  // even leaves the browser — so a 401 / 500 on the actual request left
  // the badge green while the server still held the old value. Users
  // would add a dozen gaps, see "Auto-saved", refresh, and find only the
  // original 7. saveError is set from kv-config's error listener and
  // cleared on the next successful save.
  const [saveError, setSaveError] = useState<string>("");

  // Fabrics from API
  const [fabricsList, setFabricsList] = useState<FabricTrackingItem[]>([]);
  const [fabricsLoading, setFabricsLoading] = useState(false);
  const [fabricSearch, setFabricSearch] = useState("");

  /* eslint-disable react-hooks/set-state-in-effect -- mount-time hydrate of kv-config + subscription to cross-tab updates */
  useEffect(() => {
    // Render immediately from whatever the shared kv-config cache already has
    // (prevents a flash of defaults when bouncing between pages). Then fetch
    // fresh from D1 and overwrite — the snapshot keeps auto-save from
    // re-pushing the hydrated value straight back to the server.
    const cached = parseMaintenanceConfig(getVariantsConfigSync());
    setConfig(cached);
    setSavedSnapshot(JSON.stringify(cached));

    let cancelled = false;
    void fetchVariantsConfig().then((v) => {
      if (cancelled) return;
      const fresh = parseMaintenanceConfig(v);
      setConfig(fresh);
      setSavedSnapshot(JSON.stringify(fresh));
    });

    // Pick up writes from other tabs/pages (e.g. BOM's ProductionTimesDialog)
    // so the Maintenance view never drifts from what's actually saved.
    const off = subscribeKvConfig(VARIANTS_CONFIG_KEY, (v) => {
      const latest = parseMaintenanceConfig(v as VariantsConfig | null);
      setConfig(latest);
      setSavedSnapshot(JSON.stringify(latest));
    });
    // Server rejected the PUT — flip the badge from green "Auto-saved" to
    // amber "Save failed" and surface the HTTP error so the user knows
    // their edits haven't actually persisted yet. Cleared on next
    // successful flush below.
    const offErr = subscribeKvConfigSaveError(VARIANTS_CONFIG_KEY, (e) => {
      setSaveError(e.message);
    });
    return () => {
      cancelled = true;
      off();
      offErr();
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-save: push every config change to D1 and wait for server
  // confirmation before marking the snapshot as saved. The previous
  // implementation optimistically advanced savedSnapshot the instant the
  // setTimeout fired, which meant a rejected PUT (expired auth, 500,
  // offline) silently dropped changes while the UI still said
  // "Auto-saved". Now: schedule a 500ms debounce, write to the in-memory
  // cache via patchVariantsConfig, then flushKvConfig to force the
  // pending PUT and await the HTTP response. Only on ok=true do we move
  // the snapshot forward; on failure the saveError listener flips the
  // badge to amber and leaves isDirty true so the user can retry.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const snap = JSON.stringify(config);
    if (snap === savedSnapshot) return;
    let cancelled = false;
    // Debounce + per-effect cancellation flag: useTimeout's ref-based
    // latest-fn capture and shared `fired` semantics don't compose cleanly
    // with the local `cancelled` closure used to discard a stale flush
    // when `config` changes again before 500ms elapses. Keep raw + disable.
    // eslint-disable-next-line no-restricted-syntax -- debounced autosave with per-effect cancellation closure
    const t = setTimeout(async () => {
      saveMaintenanceConfig(config);
      const ok = await flushKvConfig(VARIANTS_CONFIG_KEY);
      if (cancelled) return;
      if (ok) {
        setSavedSnapshot(snap);
        setSaveError("");
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Best-effort flush of any pending save when the user navigates away or
  // closes the tab while we still have dirty state. Without this, a quick
  // add-then-refresh loses the add because the 500ms debounce never fires.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      if (JSON.stringify(config) !== savedSnapshot) {
        // Fire-and-forget; the browser usually gives us enough time for a
        // small JSON PUT. We can't await here — unload is synchronous.
        void flushKvConfig(VARIANTS_CONFIG_KEY);
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [config, savedSnapshot]);

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

  const isDirty = useMemo(() => JSON.stringify(config) !== savedSnapshot, [config, savedSnapshot]);

  const isFabricsTab = tab === "fabrics";
  const meta = MAINTENANCE_TABS.find((t) => t.key === tab)!;
  const isPricedTab = !isFabricsTab && (meta.priced ?? false);
  const currentStringList = !isFabricsTab && !isPricedTab ? (config[tab as MaintenanceListKey] as string[]) : [];
  const currentPricedList = !isFabricsTab && isPricedTab ? (config[tab as MaintenanceListKey] as PricedOption[]) : [];

  function addEntry() {
    if (isFabricsTab) return;
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
    if (isFabricsTab) return;
    const k = tab as MaintenanceListKey;
    setConfig(prev => ({
      ...prev,
      [k]: (prev[k] as (string | PricedOption)[]).filter((_, i) => i !== idx),
    }));
  }

  function updatePrice(idx: number, priceSen: number) {
    if (isFabricsTab) return;
    const k = tab as MaintenanceListKey;
    setConfig(prev => ({
      ...prev,
      [k]: (prev[k] as PricedOption[]).map((o, i) => i === idx ? { ...o, priceSen } : o),
    }));
  }

  function updateEntryValue(idx: number, newVal: string) {
    if (isFabricsTab) return;
    if (!newVal.trim()) return;
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

  function startEditing(idx: number, currentVal: string) {
    setEditingIdx(idx);
    setEditingValue(currentVal);
  }

  function commitEdit(idx: number) {
    updateEntryValue(idx, editingValue);
    setEditingIdx(null);
    setEditingValue("");
  }

  async function handleSave() {
    saveMaintenanceConfig(config);
    const ok = await flushKvConfig(VARIANTS_CONFIG_KEY);
    if (ok) {
      setSavedSnapshot(JSON.stringify(config));
      setSaveError("");
      showToast("Variants saved");
    } else {
      showToast("Save failed — check your connection and try again");
    }
  }

  function handleReset() {
    if (!window.confirm("Reset all variants to factory defaults? Unsaved changes will be lost.")) return;
    setConfig(DEFAULT_MAINTENANCE_CONFIG);
  }

  return (
    <div className="space-y-4">
      {/* Save / Reset bar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#6B7280]">
          Centralized master data for product variants. Used by BOM, Sales Orders, and Production.
        </p>
        <div className="flex items-center gap-2">
          {saveError ? (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-[#9A3A2D] bg-[#F9E1DA] border border-[#E4B3A7] rounded-md px-2 py-1"
              title={saveError}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              Save failed — click Save Changes
            </span>
          ) : isDirty ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#9C6F1E] bg-[#FAEFCB] border border-[#E8D597] rounded-md px-2 py-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Saving...
            </span>
          ) : savedSnapshot !== JSON.stringify(DEFAULT_MAINTENANCE_CONFIG) ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#4F7C3A] bg-[#EEF3E4] border border-[#C6DBA8] rounded-md px-2 py-1">
              <Check className="w-3.5 h-3.5" />
              Auto-saved
            </span>
          ) : null}
          <button
            onClick={handleReset}
            className="text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
          >
            Reset to defaults
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>

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
                  onClick={() => { setTab(t.key); setNewValue(""); setNewPriceSen(0); setEditingIdx(null); }}
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
                              onChange={async (e) => {
                                const tier = e.target.value as "PRICE_1" | "PRICE_2";
                                try {
                                  const res = await fetch(`/api/fabric-tracking/${f.id}`, {
                                    method: "PUT",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ priceTier: tier }),
                                  });
                                  if (res.ok) {
                                    invalidateCachePrefix("/api/fabric-tracking");
                                    invalidateCachePrefix("/api/raw-materials");
                                    setFabricsList((prev) =>
                                      prev.map((fb) => (fb.id === f.id ? { ...fb, priceTier: tier } : fb))
                                    );
                                    showToast("Fabric updated");
                                  }
                                } catch { /* ignore */ }
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
              {/* Add row */}
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
                        type="number"
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

              {/* List */}
              <div className="space-y-1.5">
                {isPricedTab ? (
                  currentPricedList.length === 0 ? (
                    <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                      No entries yet. Add one above to get started.
                    </div>
                  ) : (
                    currentPricedList.map((entry, idx) => (
                      <div
                        key={`${tab}-${idx}`}
                        className="flex items-center justify-between px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors group"
                      >
                        <div
                          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                          onClick={() => { if (editingIdx !== idx) startEditing(idx, entry.value); }}
                        >
                          <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                          {editingIdx === idx ? (
                            <input
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onBlur={() => commitEdit(idx)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); commitEdit(idx); }
                                if (e.key === "Escape") { setEditingIdx(null); setEditingValue(""); }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-sm font-medium border-2 border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none w-48"
                            />
                          ) : (
                            <span className="text-sm text-[#111827] font-medium group-hover:text-[#6B5C32] group-hover:underline">
                              {entry.value}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-400">RM</span>
                            <input
                              type="number"
                              step="0.01"
                              value={entry.priceSen / 100}
                              onChange={(e) => updatePrice(idx, Math.round(parseFloat(e.target.value || "0") * 100))}
                              className="w-20 text-right text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <button
                            onClick={() => removeEntry(idx)}
                            className="p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                            title="Remove"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )
                ) : (
                  currentStringList.length === 0 ? (
                    <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                      No entries yet. Add one above to get started.
                    </div>
                  ) : (
                    currentStringList.map((entry, idx) => (
                      <div
                        key={`${tab}-${idx}`}
                        className="flex items-center justify-between px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors group"
                      >
                        <div
                          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                          onClick={() => { if (editingIdx !== idx) startEditing(idx, entry); }}
                        >
                          <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                          {editingIdx === idx ? (
                            <input
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onBlur={() => commitEdit(idx)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); commitEdit(idx); }
                                if (e.key === "Escape") { setEditingIdx(null); setEditingValue(""); }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-sm font-medium border-2 border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none w-48"
                            />
                          ) : (
                            <span className="text-sm text-[#111827] font-medium group-hover:text-[#6B5C32] group-hover:underline">
                              {entry}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => removeEntry(idx)}
                          className="p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                          title="Remove"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
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
  const [variantMap, setVariantMap] = useState<Record<string, ProductVariantConfig[]>>({});
  const [editingVariant, setEditingVariant] = useState<Product | null>(null);
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
        toast.warning("CSV 是空的或只有表头。");
        return;
      }
      const headers = parseCsvLine(lines[0]).map((h) => h.trim());
      const codeIdx = headers.indexOf("code");
      if (codeIdx === -1) {
        toast.warning("CSV 必须包含 'code' 列。");
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

  // Initialize variant configs from defaults
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot mount-time seed of static defaults */
  useEffect(() => {
    const map: Record<string, ProductVariantConfig[]> = {};
    Object.entries(DEFAULT_VARIANT_CONFIGS).forEach(([model, configs]) => {
      map[model] = configs;
    });
    setVariantMap(map);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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
          // 24/28/30/32/35 price columns need room for "RM 1,000.00" with
          // thousands separators — 0.65fr clipped the text; widened to 0.95fr.
          // Description + Model compressed slightly to claim the headroom.
          ? "1.3fr 1.5fr 0.55fr 0.95fr 0.95fr 0.95fr 0.95fr 0.95fr 0.6fr 0.5fr 0.6fr 0.7fr"
          : isAccessory
          // ACCESSORY: Code | Description | Base Price | Unit M3 | Fabric
          // (no Category/Size/Price2 — pillows don't carry those), and
          // no Total Min / Variants / seat-height columns either.
          ? "1.3fr 2.5fr 1fr 0.7fr 1fr"
          : "1.3fr 2fr 0.8fr 0.8fr 1fr 1fr 0.7fr 0.7fr 0.7fr 0.8fr";
        const thCls = "px-3 py-1.5 text-[11px] font-medium text-[#6B7280] uppercase tracking-wider";
        return (
      <div className="bg-white rounded-lg border border-[#E5E7EB] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-[#E5E7EB]">
            <thead className="bg-[#F9FAFB]">
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
              {filtered.map((p) => {
                const cfg = configMap.get(p.code);
                const isExpanded = expandedId === p.id;
                const totalMin = cfg ? totalConfigMinutes(cfg) : p.productionTimeMinutes;
                const price1Val = p.price1Sen ?? 0;
                const basePrice = p.basePriceSen ?? p.costPriceSen ?? 0;
                const modelVariants = variantMap[p.baseModel] || [];
                const isEditingThisPrice = editingPrice === p.id;

                return (
                  <tr key={p.id} className="group">
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
                              const sh = (p.seatHeightPrices || []).find((s) => norm(s.height) === hNum);
                              const editKey = `${p.id}__${h}`;
                              const isEditingThis = editingSeatPrices === editKey;
                              return (
                                <div key={h} className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                                  {isEditingThis ? (
                                    <input
                                      autoFocus
                                      type="number"
                                      step="0.01"
                                      value={seatPriceInputs[h] ?? ""}
                                      onChange={(e) => setSeatPriceInputs((prev) => ({ ...prev, [h]: e.target.value }))}
                                      onBlur={() => {
                                        const val = Math.round(parseFloat(seatPriceInputs[h] || "0") * 100);
                                        setEditingSeatPrices(null);
                                        const hN = h.replace('"', '');
                                        let arr = p.seatHeightPrices || [];
                                        // Same normalisation rule as the read path so we never
                                        // accidentally append a duplicate entry (string "28"
                                        // next to int 28, or '28"' next to "28"). The canonical
                                        // stored form is the plain string "24".."35" — set by
                                        // migration 0031 and maintained on every write below.
                                        if (!arr.find((s) => norm(s.height) === hN)) {
                                          arr = [...arr, { height: hN, priceSen: val }];
                                        }
                                        const updated = arr.map((s) =>
                                          norm(s.height) === hN ? { ...s, height: hN, priceSen: val } : s
                                        );
                                        setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, seatHeightPrices: updated } : pr));
                                        fetchJson(`/api/products/${p.id}`, ProductMutationSchema, {
                                          method: "PUT",
                                          body: { seatHeightPrices: updated },
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
                                        if (e.key === "Escape") setEditingSeatPrices(null);
                                      }}
                                      className="w-full text-right text-xs border border-[#6B5C32] rounded px-1 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => {
                                        setSeatPriceInputs({ [h]: ((sh?.priceSen ?? 0) / 100).toFixed(2) });
                                        setEditingSeatPrices(editKey);
                                      }}
                                      className="text-sm tabular-nums text-[#111827] hover:text-[#6B5C32] hover:underline"
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
                                  type="number"
                                  value={priceInput}
                                  onChange={(e) => setPriceInput(e.target.value)}
                                  onBlur={() => {
                                    const val = Math.round(parseFloat(priceInput || "0") * 100);
                                    setEditingPrice(null);
                                    setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, basePriceSen: val } : pr));
                                    fetchJson(`/api/products/${p.id}`, ProductMutationSchema, {
                                      method: "PUT",
                                      body: { basePriceSen: val },
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
                                    if (e.key === "Escape") setEditingPrice(null);
                                  }}
                                  className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                  step="0.01"
                                />
                              ) : (
                                <button
                                  onClick={() => { setEditingPrice(p.id); setPriceInput((basePrice / 100).toFixed(2)); }}
                                  className="text-sm font-medium text-[#111827] hover:text-[#6B5C32] hover:underline"
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
                                  type="number"
                                  value={price1Input}
                                  onChange={(e) => setPrice1Input(e.target.value)}
                                  onBlur={() => {
                                    const val = Math.round(parseFloat(price1Input || "0") * 100);
                                    setEditingPrice1(null);
                                    setProducts((prev) => prev.map((pr) => pr.id === p.id ? { ...pr, price1Sen: val } : pr));
                                    fetchJson(`/api/products/${p.id}`, ProductMutationSchema, {
                                      method: "PUT",
                                      body: { price1Sen: val },
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
                                    if (e.key === "Escape") setEditingPrice1(null);
                                  }}
                                  className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                  step="0.01"
                                />
                              ) : (
                                <button
                                  onClick={() => { setEditingPrice1(p.id); setPrice1Input((price1Val / 100).toFixed(2)); }}
                                  className="text-sm font-medium text-[#111827] hover:text-[#6B5C32] hover:underline"
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
                                  type="number"
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
                            <div className="px-3 py-1.5 text-right text-sm font-medium text-[#111827]">
                              {totalMin} min
                            </div>
                            {/* Variants badge */}
                            <div className="px-3 py-1.5 flex justify-center" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => setEditingVariant(p)}
                                className={`text-[10px] font-medium px-2 py-1 rounded-full border transition-colors ${
                                  modelVariants.length > 0
                                    ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] hover:bg-[#EEF3E4]"
                                    : "bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100"
                                }`}
                              >
                                {modelVariants.length > 0 ? `${modelVariants.length} types` : "Configure"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                      {/* Expanded section */}
                      {isExpanded && (
                        <div className="px-4 pb-4 space-y-3">
                          {cfg && <ProductionConfig config={cfg} />}

                          {/* Variant Defaults Summary */}
                          {modelVariants.length > 0 && (
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
                                {modelVariants.map((vc, i) => {
                                  const defaultOpt = vc.options.find((o) => o.isDefault);
                                  return (
                                    <div key={i} className="bg-white rounded-md px-3 py-2 border border-[#E5E7EB]">
                                      <div className="text-[10px] font-medium text-[#6B7280] uppercase">{vc.label}</div>
                                      <div className="text-sm font-medium text-[#111827]">
                                        {defaultOpt?.label || "-"}
                                        {defaultOpt && defaultOpt.priceSen > 0 && (
                                          <span className="text-xs text-[#4F7C3A] ml-1">+{formatCurrency(defaultOpt.priceSen)}</span>
                                        )}
                                      </div>
                                      <div className="text-[10px] text-[#9CA3AF]">{vc.options.length} options available</div>
                                    </div>
                                  );
                                })}
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
          variants={variantMap[editingVariant.baseModel] || []}
          onSave={(v) => setVariantMap((prev) => ({ ...prev, [editingVariant.baseModel]: v }))}
        />
      )}
    </div>
  );
}
