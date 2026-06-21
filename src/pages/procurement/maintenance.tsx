// ---------------------------------------------------------------------------
// Suppliers — unified module home (2026-06-20).
//   Tab 1 — Suppliers    : supplier master CRUD + KPI tiles (formerly /procurement/maintenance)
//   Tab 2 — Price Comparison : cross-supplier material compare + scorecards
//                              (ported from /procurement/pricing's Comparison tab)
//
// Per-supplier drill-down (Info + Scorecard + Pricing & SKUs + Price History)
// lives on /suppliers/:id.
// ---------------------------------------------------------------------------
import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { SupplierFormDialog, type OrgOption } from "./supplier-form-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatCurrency } from "@/lib/utils";
import type { SupplierMaterialBinding, SupplierScorecard } from "@/types";
import {
  Plus,
  Building2,
  Star,
  Pencil,
  Trash2,
  TrendingUp,
  X,
  Info,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

// ============================================================
// Types
// ============================================================
type SupplierStatus = "ACTIVE" | "INACTIVE" | "BLACKLISTED";
type PaymentTerms = "NET15" | "NET30" | "NET45" | "NET60" | "COD";

type Supplier = {
  id: string;
  code: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  paymentTerms: PaymentTerms;
  rating: number; // 1-5
  status: SupplierStatus;
  address: string;
  // Purchase Company override (migration 0142 / multi-org letterhead).
  // Default = HOOKKA. Picks which org's letterhead prints on the PO PDF.
  // The legal/AP buyer is always HOOKKA — this is cosmetic.
  purchaseOrgCode: string;
};

// ============================================================
// Helpers
// ============================================================
function statusBadge(status: SupplierStatus) {
  const map: Record<SupplierStatus, { bg: string; text: string; border: string; label: string }> = {
    ACTIVE: { bg: "bg-green-50", text: "text-green-800", border: "border-green-300", label: "Active" },
    INACTIVE: { bg: "bg-gray-100", text: "text-gray-500", border: "border-gray-300", label: "Inactive" },
    BLACKLISTED: { bg: "bg-red-50", text: "text-red-800", border: "border-red-300", label: "Blacklisted" },
  };
  const c = map[status] || map.ACTIVE;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      {c.label}
    </span>
  );
}

function ratingStars(rating: number) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i <= rating ? "text-amber-400 fill-amber-400" : "text-gray-300"}`}
        />
      ))}
    </span>
  );
}

// ============================================================
// Price Comparison helpers (ported from /procurement/pricing)
// ============================================================
function ScoreBar({ label, value }: { label: string; value: number }) {
  const color =
    value >= 90 ? "bg-[#4F7C3A]" : value >= 75 ? "bg-[#9C6F1E]" : "bg-[#9A3A2D]";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 w-16 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs font-medium w-8 text-right">{value}%</span>
    </div>
  );
}

// ── Badge legend tooltip ─────────────────────────────────────────────────────
function BadgeLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 underline decoration-dotted"
        aria-label="Badge legend"
      >
        <Info className="h-3.5 w-3.5" />
        Badge legend
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-6 z-20 bg-white border border-[#E2DDD8] rounded-lg shadow-lg p-3 w-64 space-y-2 text-xs text-gray-700">
            <p className="font-semibold text-gray-900 mb-1">Badge meanings</p>
            <div className="flex items-start gap-2">
              <Badge className="bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] text-[10px] shrink-0">Cheapest</Badge>
              <span>Lowest unit price among all suppliers for this material.</span>
            </div>
            <div className="flex items-start gap-2">
              <Badge className="bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2] text-[10px] shrink-0">Fastest</Badge>
              <span>Shortest lead time among all suppliers for this material.</span>
            </div>
            <div className="flex items-start gap-2">
              <Badge className="bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597] text-[10px] shrink-0">Main</Badge>
              <span>Designated primary supplier for this material (set on the supplier-material binding).</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Supplier card for one material ───────────────────────────────────────────
function SupplierCard({
  b,
  isCheapest,
  isFastest,
  supplierMap,
  scorecardMap,
}: {
  b: SupplierMaterialBinding;
  isCheapest: boolean;
  isFastest: boolean;
  supplierMap: Record<string, string>;
  scorecardMap: Record<string, SupplierScorecard>;
}) {
  const scorecard = scorecardMap[b.supplierId];
  let borderClass = "border-[#E2DDD8]";
  if (isCheapest && isFastest) borderClass = "border-[#C6DBA8] ring-1 ring-[#C6DBA8]";
  else if (isCheapest) borderClass = "border-[#C6DBA8] ring-1 ring-[#C6DBA8]";
  else if (isFastest) borderClass = "border-[#A8CAD2] ring-1 ring-[#A8CAD2]";

  return (
    <Card className={`${borderClass} relative`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <CardTitle className="text-base">
            {supplierMap[b.supplierId] ?? b.supplierId}
          </CardTitle>
          <div className="flex gap-1 flex-wrap justify-end">
            {isCheapest && (
              <Badge className="bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] text-[10px]">
                Cheapest
              </Badge>
            )}
            {isFastest && (
              <Badge className="bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2] text-[10px]">
                Fastest
              </Badge>
            )}
            {b.isMainSupplier && (
              <Badge className="bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597] text-[10px]">
                Main
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">SKU</span>
            <p className="font-mono text-xs font-medium">{b.supplierSku}</p>
          </div>
          <div>
            <span className="text-gray-500">Unit Price</span>
            <p className="font-semibold">{formatCurrency(b.unitPrice, b.currency)}</p>
          </div>
          <div>
            <span className="text-gray-500">Lead Time</span>
            <p className="font-medium">{b.leadTimeDays} days</p>
          </div>
          <div>
            <span className="text-gray-500">MOQ</span>
            <p className="font-medium">{b.moq}</p>
          </div>
        </div>

        {scorecard && (
          <div className="border-t border-[#E2DDD8] pt-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Scorecard
            </p>
            <div className="space-y-1.5">
              <ScoreBar label="On-Time" value={scorecard.onTimeRate} />
              <ScoreBar label="Quality" value={scorecard.qualityRate} />
              <ScoreBar label="Lead Acc." value={scorecard.leadTimeAccuracy} />
            </div>
            <div className="flex items-center justify-between mt-2 text-xs">
              <span className="text-gray-500">
                Price Trend:{" "}
                <span className={scorecard.avgPriceTrend > 5 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}>
                  +{scorecard.avgPriceTrend}%
                </span>
              </span>
              <span className="text-gray-500">
                Rating: {"*".repeat(scorecard.overallRating)}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sort types ────────────────────────────────────────────────────────────────
type SortField = "supplierName" | "unitPrice" | "leadTimeDays";
type SortDir = "asc" | "desc";

function SortButton({
  field,
  label,
  active,
  sortDir,
  onToggle,
}: {
  field: SortField;
  label: string;
  active: boolean;
  sortDir: SortDir;
  onToggle: (field: SortField) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(field)}
      className={`inline-flex items-center gap-0.5 rounded px-2 py-1 text-xs font-medium border transition-colors ${
        active
          ? "bg-[#6B5C32] text-white border-[#6B5C32]"
          : "bg-white text-gray-600 border-[#E2DDD8] hover:bg-[#F9F8F6]"
      }`}
    >
      {label}
      {active ? (
        sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
      ) : null}
    </button>
  );
}

function ComparisonTab({
  bindings,
  supplierMap,
  scorecardMap,
  materialCodes,
}: {
  bindings: SupplierMaterialBinding[];
  supplierMap: Record<string, string>;
  scorecardMap: Record<string, SupplierScorecard>;
  materialCodes: string[];
}) {
  // Multi-select: set of selected material codes
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>([]);
  // Filter input for narrowing the materials dropdown list
  const [materialSearch, setMaterialSearch] = useState("");
  // Collapsible materials list — closed by default so it doesn't sit open forever
  // (owner: "why won't this Search close, it stays open"). Opens on focus/typing.
  const [materialOpen, setMaterialOpen] = useState(false);
  // Per-card sort + filter within the supplier cards section
  const [filterSupplier, setFilterSupplier] = useState("");
  const [sortField, setSortField] = useState<SortField>("unitPrice");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Derive a stable label for each material code
  const materialLabel = useMemo(() => {
    const map: Record<string, string> = {};
    bindings.forEach((b) => {
      if (!map[b.materialCode]) map[b.materialCode] = b.materialName;
    });
    return map;
  }, [bindings]);

  // Filtered material list for the dropdown
  const filteredMaterialCodes = useMemo(() => {
    if (!materialSearch.trim()) return materialCodes;
    const q = materialSearch.toLowerCase();
    return materialCodes.filter(
      (c) =>
        c.toLowerCase().includes(q) ||
        (materialLabel[c] ?? "").toLowerCase().includes(q)
    );
  }, [materialCodes, materialSearch, materialLabel]);

  function toggleMaterial(code: string) {
    setSelectedMaterials((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  function clearAll() {
    setSelectedMaterials([]);
  }

  // For each selected material: compute per-material cheapest / fastest values
  const materialGroups = useMemo(() => {
    return selectedMaterials.map((code) => {
      const group = bindings.filter((b) => b.materialCode === code);
      const cheapestPrice =
        group.length > 0 ? Math.min(...group.map((b) => b.unitPrice)) : 0;
      const fastestLead =
        group.length > 0 ? Math.min(...group.map((b) => b.leadTimeDays)) : 0;
      return { code, label: materialLabel[code] ?? code, group, cheapestPrice, fastestLead };
    });
  }, [selectedMaterials, bindings, materialLabel]);

  // Sort helper applied to each material's supplier cards
  function sortedAndFiltered(group: SupplierMaterialBinding[]): SupplierMaterialBinding[] {
    let rows = group;
    if (filterSupplier.trim()) {
      const q = filterSupplier.toLowerCase();
      rows = rows.filter((b) =>
        (supplierMap[b.supplierId] ?? b.supplierId).toLowerCase().includes(q) ||
        b.supplierSku.toLowerCase().includes(q)
      );
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortField === "unitPrice") cmp = a.unitPrice - b.unitPrice;
      else if (sortField === "leadTimeDays") cmp = a.leadTimeDays - b.leadTimeDays;
      else {
        const na = (supplierMap[a.supplierId] ?? a.supplierId).toLowerCase();
        const nb = (supplierMap[b.supplierId] ?? b.supplierId).toLowerCase();
        cmp = na < nb ? -1 : na > nb ? 1 : 0;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  // Cross-material summary table rows
  const crossMaterialRows = useMemo(() => {
    return materialGroups
      .filter((mg) => mg.group.length > 0)
      .map((mg) => {
        const cheapestBinding = mg.group.reduce((best, b) =>
          b.unitPrice < best.unitPrice ? b : best
        );
        const mainBinding = mg.group.find((b) => b.isMainSupplier);
        const fastestBinding = mg.group.reduce((best, b) =>
          b.leadTimeDays < best.leadTimeDays ? b : best
        );
        return {
          code: mg.code,
          label: mg.label,
          cheapestSupplier: supplierMap[cheapestBinding.supplierId] ?? cheapestBinding.supplierId,
          cheapestPrice: cheapestBinding.unitPrice,
          cheapestCurrency: cheapestBinding.currency,
          mainSupplier: mainBinding ? (supplierMap[mainBinding.supplierId] ?? mainBinding.supplierId) : "—",
          mainPrice: mainBinding ? mainBinding.unitPrice : null,
          mainCurrency: mainBinding?.currency,
          fastestSupplier: supplierMap[fastestBinding.supplierId] ?? fastestBinding.supplierId,
          fastestLeadDays: fastestBinding.leadTimeDays,
        };
      });
  }, [materialGroups, supplierMap]);

  return (
    <div className="space-y-6">
      {/* Controls card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle>Supplier Comparison</CardTitle>
            <BadgeLegend />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Material multi-select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Materials{" "}
              <span className="text-xs font-normal text-gray-400">(pick one or more)</span>
            </label>
            <div className="flex items-center gap-2 mb-2">
              <Input
                placeholder="Search materials…"
                value={materialSearch}
                onFocus={() => setMaterialOpen(true)}
                onChange={(e) => { setMaterialSearch(e.target.value); setMaterialOpen(true); }}
                onKeyDown={(e) => { if (e.key === "Escape") setMaterialOpen(false); }}
                className="max-w-xs h-8 text-sm"
              />
              <button
                type="button"
                onClick={() => setMaterialOpen((o) => !o)}
                className="text-xs text-[#6B5C32] hover:underline"
              >
                {materialOpen ? "Done" : "Browse"}
              </button>
              {selectedMaterials.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Clear all ({selectedMaterials.length})
                </button>
              )}
            </div>
            {materialOpen && (
            <div className="border border-[#E2DDD8] rounded-md overflow-auto max-h-40 bg-white">
              {filteredMaterialCodes.length === 0 ? (
                <p className="text-xs text-gray-400 px-3 py-2">No materials match</p>
              ) : (
                filteredMaterialCodes.map((code) => {
                  const checked = selectedMaterials.includes(code);
                  return (
                    <label
                      key={code}
                      className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors ${
                        checked ? "bg-[#F3F0E8]" : "hover:bg-[#F9F8F6]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMaterial(code)}
                        className="h-3.5 w-3.5 accent-[#6B5C32]"
                      />
                      <span className="font-mono text-xs font-medium text-[#1F1D1B]">{code}</span>
                      <span className="text-gray-500 text-xs truncate">{materialLabel[code] ?? ""}</span>
                    </label>
                  );
                })
              )}
            </div>
            )}
            {/* Selected chips */}
            {selectedMaterials.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {selectedMaterials.map((code) => (
                  <span
                    key={code}
                    className="inline-flex items-center gap-1 bg-[#F3F0E8] text-[#6B5C32] border border-[#D4C9A8] rounded-full px-2 py-0.5 text-xs font-medium"
                  >
                    {code}
                    <button
                      type="button"
                      onClick={() => toggleMaterial(code)}
                      className="hover:text-[#4A3E22]"
                      aria-label={`Remove ${code}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Sort + filter bar — shown only when materials are selected */}
          {selectedMaterials.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap border-t border-[#E2DDD8] pt-3">
              <span className="text-xs text-gray-500 font-medium">Sort by:</span>
              {(["unitPrice", "leadTimeDays", "supplierName"] as SortField[]).map((f) => {
                const labels: Record<SortField, string> = {
                  unitPrice: "Unit Price",
                  leadTimeDays: "Lead Time",
                  supplierName: "Supplier Name",
                };
                return (
                  <SortButton
                    key={f}
                    field={f}
                    label={labels[f]}
                    active={sortField === f}
                    sortDir={sortDir}
                    onToggle={(clicked) => {
                      if (sortField === clicked) {
                        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      } else {
                        setSortField(clicked);
                        setSortDir("asc");
                      }
                    }}
                  />
                );
              })}
              <div className="ml-auto">
                <Input
                  placeholder="Filter by supplier / SKU…"
                  value={filterSupplier}
                  onChange={(e) => setFilterSupplier(e.target.value)}
                  className="h-7 text-xs w-52"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cross-material comparison table */}
      {crossMaterialRows.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cross-Material Summary</CardTitle>
            <p className="text-xs text-gray-500 mt-0.5">
              Side-by-side best values across selected materials.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Material</th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <Badge className="bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] text-[10px]">Cheapest</Badge>
                      {" "}Supplier & Price
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <Badge className="bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597] text-[10px]">Main</Badge>
                      {" "}Supplier & Price
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <Badge className="bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2] text-[10px]">Fastest</Badge>
                      {" "}Supplier
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {crossMaterialRows.map((row, idx) => (
                    <tr
                      key={row.code}
                      className={`border-b border-[#F0EDE8] ${idx % 2 === 0 ? "bg-white" : "bg-[#FAFAF8]"}`}
                    >
                      <td className="py-2.5 px-3">
                        <span className="font-mono text-xs font-semibold text-[#1F1D1B]">{row.code}</span>
                        <span className="text-xs text-gray-400 ml-1.5">{row.label}</span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="font-medium text-[#1F1D1B]">{row.cheapestSupplier}</span>
                        <span className="text-xs text-[#4F7C3A] ml-2 font-semibold">
                          {formatCurrency(row.cheapestPrice, row.cheapestCurrency)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="font-medium text-[#1F1D1B]">{row.mainSupplier}</span>
                        {row.mainPrice !== null && row.mainCurrency && (
                          <span className="text-xs text-[#9C6F1E] ml-2 font-semibold">
                            {formatCurrency(row.mainPrice, row.mainCurrency)}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="font-medium text-[#1F1D1B]">{row.fastestSupplier}</span>
                        <span className="text-xs text-[#3E6570] ml-2">{row.fastestLeadDays}d</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-material supplier card groups */}
      {selectedMaterials.length === 0 && (
        <p className="text-center text-gray-400 py-12 text-sm">
          Select one or more materials above to see supplier comparisons.
        </p>
      )}

      {materialGroups.map(({ code, label, group, cheapestPrice, fastestLead }) => {
        const displayed = sortedAndFiltered(group);
        return (
          <div key={code} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[#1F1D1B]">
                <span className="font-mono">{code}</span>
                {label && label !== code && (
                  <span className="text-gray-500 font-normal ml-1.5">— {label}</span>
                )}
              </h3>
              <span className="text-xs text-gray-400">
                {group.length} supplier{group.length === 1 ? "" : "s"}
              </span>
            </div>

            {displayed.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">No suppliers match the current filter.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {displayed.map((b) => (
                  <SupplierCard
                    key={b.id}
                    b={b}
                    isCheapest={b.unitPrice === cheapestPrice}
                    isFastest={b.leadTimeDays === fastestLead}
                    supplierMap={supplierMap}
                    scorecardMap={scorecardMap}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Batch Edit Dialog
// ============================================================
type BatchField = "paymentTerms" | "purchaseOrgCode" | "status" | "rating";

function SupplierBatchEditDialog({
  suppliers,
  orgOptions,
  onClose,
  onDone,
  onOptimisticUpdate,
  confirm,
}: {
  suppliers: Supplier[];
  orgOptions: OrgOption[];
  onClose: () => void;
  onDone: (ok: number, failed: string[]) => void;
  onOptimisticUpdate: (field: BatchField, value: string, ids: Set<string>) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const [field, setField] = useState<BatchField>("paymentTerms");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Reset value when field changes so stale values don't carry over.
  function handleFieldChange(f: BatchField) {
    setField(f);
    setValue("");
  }

  const fieldLabel: Record<BatchField, string> = {
    paymentTerms: "Payment Terms",
    purchaseOrgCode: "Purchase Company",
    status: "Status",
    rating: "Rating (1–5)",
  };

  const canApply = value.trim() !== "" && !busy;

  async function handleApply() {
    const trimmed = value.trim();
    if (!trimmed) return;

    const confirmed = await confirm({
      title: `Apply to ${suppliers.length} supplier${suppliers.length === 1 ? "" : "s"}?`,
      message: `Set ${fieldLabel[field]} to "${field === "rating" ? `${trimmed} star${trimmed === "1" ? "" : "s"}` : trimmed}" on every selected supplier. This cannot be undone in bulk.`,
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    // Optimistic update before the network loop starts.
    const ids = new Set(suppliers.map((s) => s.id));
    onOptimisticUpdate(field, trimmed, ids);

    setBusy(true);
    setProgress({ done: 0, total: suppliers.length });
    let ok = 0;
    const failed: string[] = [];
    for (let i = 0; i < suppliers.length; i++) {
      const s = suppliers[i];
      try {
        const payload: Record<string, unknown> = { ...s, [field]: field === "rating" ? Number(trimmed) : trimmed };
        delete payload.id;
        const res = await fetch(`/api/suppliers/${s.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) ok++;
        else failed.push(s.code || s.id);
      } catch {
        failed.push(s.code || s.id);
      }
      setProgress({ done: i + 1, total: suppliers.length });
    }
    setBusy(false);
    onDone(ok, failed);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            Batch Edit — {suppliers.length} supplier{suppliers.length === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="text-[#9CA3AF] hover:text-[#374151]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <p className="text-xs text-[#6B7280]">
            Only the chosen field changes on every selected supplier.
            Names and codes are never touched.
          </p>

          {/* Field picker */}
          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">Field to change</label>
            <div className="grid grid-cols-2 gap-2">
              {(["paymentTerms", "purchaseOrgCode", "status", "rating"] as BatchField[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => handleFieldChange(f)}
                  className={`rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                    field === f
                      ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                      : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F3F4F6]"
                  }`}
                >
                  {fieldLabel[f]}
                </button>
              ))}
            </div>
          </div>

          {/* Value picker — varies by field */}
          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">
              New value (applies to all selected)
            </label>
            {field === "paymentTerms" && (
              <select
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
              >
                <option value="">Pick terms…</option>
                <option value="COD">COD</option>
                <option value="NET15">Net 15</option>
                <option value="NET30">Net 30</option>
                <option value="NET45">Net 45</option>
                <option value="NET60">Net 60</option>
              </select>
            )}
            {field === "purchaseOrgCode" && (
              <select
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
              >
                <option value="">Pick a company…</option>
                {(orgOptions.length > 0
                  ? orgOptions.map((o) => ({ value: o.code, label: `${o.code} — ${o.name}` }))
                  : [{ value: "HOOKKA", label: "HOOKKA INDUSTRIES SDN BHD" }]
                ).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            )}
            {field === "status" && (
              <select
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
              >
                <option value="">Pick a status…</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="BLACKLISTED">Blacklisted</option>
              </select>
            )}
            {field === "rating" && (
              <select
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
              >
                <option value="">Pick a rating…</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {"★".repeat(n)}{"☆".repeat(5 - n)} ({n}/5)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Progress bar while applying */}
          {busy && progress && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-[#6B7280]">
                <span>Applying…</span>
                <span>{progress.done}/{progress.total}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#6B5C32] rounded-full transition-all"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-5 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleApply()} disabled={!canApply}>
            {busy ? "Applying…" : `Apply to ${suppliers.length}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Main Page
// ============================================================
export default function SupplierMaintenancePage() {
  const navigate = useNavigate();

  // Top-level tab: Suppliers list vs. Price Comparison
  const [activeTab, setActiveTab] = useState<"suppliers" | "price-comparison">("suppliers");

  // Supplier state — D1 is source of truth, mirrored into mutable local state
  // for optimistic UI.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierSearch, setSupplierSearch] = useState("");
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  // Batch edit (multi-select → set ONE safe shared field on all selected).
  const [selectedSuppliers, setSelectedSuppliers] = useState<Supplier[]>([]);
  const [showBatchEdit, setShowBatchEdit] = useState(false);

  const { data: suppliersResp } = useCachedJson<{ success?: boolean; data?: Record<string, unknown>[] } | Record<string, unknown>[]>("/api/suppliers");

  // Organisation list — feeds the Purchase Company dropdown + column lookup.
  // We only need code + legal name; other fields live on the org admin page.
  const { data: orgsResp } = useCachedJson<{
    organisations?: Array<{ code: string; name: string; isActive?: boolean }>;
  }>("/api/organisations");

  // Price Comparison data — fetched lazily once the tab is activated (the
  // SWR-style useCachedJson hook dedupes; no re-fetch overhead if already warm).
  const { data: bindingsResp } = useCachedJson<{ success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]>(
    activeTab === "price-comparison" ? "/api/supplier-materials" : null
  );
  const { data: scorecardsResp } = useCachedJson<{ success?: boolean; data?: SupplierScorecard[] } | SupplierScorecard[]>(
    activeTab === "price-comparison" ? "/api/supplier-scorecards" : null
  );

  const bindings: SupplierMaterialBinding[] = useMemo(
    () => ((bindingsResp as { data?: SupplierMaterialBinding[] } | undefined)?.data ?? (Array.isArray(bindingsResp) ? bindingsResp as SupplierMaterialBinding[] : [])),
    [bindingsResp]
  );
  const scorecards: SupplierScorecard[] = useMemo(
    () => ((scorecardsResp as { data?: SupplierScorecard[] } | undefined)?.data ?? (Array.isArray(scorecardsResp) ? scorecardsResp as SupplierScorecard[] : [])),
    [scorecardsResp]
  );
  const supplierMap = useMemo(() => {
    const map: Record<string, string> = {};
    suppliers.forEach((s) => { map[s.id] = s.name; });
    return map;
  }, [suppliers]);
  const scorecardMap = useMemo(() => {
    const map: Record<string, SupplierScorecard> = {};
    scorecards.forEach((s) => { map[s.supplierId] = s; });
    return map;
  }, [scorecards]);
  const materialCodes = useMemo(() => {
    const codes = Array.from(new Set(bindings.map((b) => b.materialCode)));
    return codes.sort();
  }, [bindings]);
  const orgOptions: OrgOption[] = useMemo(() => {
    const list = orgsResp?.organisations ?? [];
    return list
      .filter((o) => o.isActive !== false)
      .map((o) => ({ code: o.code, name: o.name }));
  }, [orgsResp]);
  // Quick code → legal name lookup for the column pill tooltip.
  const orgNameByCode = useMemo(() => {
    const m: Record<string, string> = {};
    orgOptions.forEach((o) => {
      m[o.code] = o.name;
    });
    return m;
  }, [orgOptions]);

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR suppliers data into mutable local state for optimistic UI */
  useEffect(() => {
    const d = suppliersResp;
    if (!d) return;
    const list = Array.isArray((d as { data?: unknown[] })?.data) ? (d as { data: Record<string, unknown>[] }).data : Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
    if (!list.length) return;
    const mapped: Supplier[] = list.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? s.code ?? ""),
      code: String(s.code ?? s.id ?? ""),
      name: String(s.name ?? ""),
      contactPerson: String(s.contactPerson ?? s.attention ?? ""),
      phone: String(s.phone ?? ""),
      email: String(s.email ?? ""),
      paymentTerms: (s.paymentTerms ?? s.creditTerm ?? "NET30") as PaymentTerms,
      rating: Number(s.rating ?? 0),
      status: ((s.status ?? (s.isActive === false ? "INACTIVE" : "ACTIVE")) as SupplierStatus),
      address: String(
        s.address ??
          [s.addressLine1, s.addressLine2, s.addressLine3, s.addressLine4]
            .filter(Boolean)
            .join(", ") ??
          "",
      ),
      // Falls back to HOOKKA for pre-0142 rows (the column is missing on
      // the JSON response when the migration hasn't been applied yet).
      purchaseOrgCode: String(s.purchaseOrgCode ?? "HOOKKA"),
    }));
    setSuppliers(mapped);
  }, [suppliersResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { toast } = useToast();

  // ---- Supplier list ----
  const filteredSuppliers = useMemo(() => {
    if (!supplierSearch) return suppliers;
    const q = supplierSearch.toLowerCase();
    return suppliers.filter(
      (s) =>
        s.code.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.contactPerson.toLowerCase().includes(q) ||
        s.phone.includes(q)
    );
  }, [suppliers, supplierSearch]);

  const supplierColumns: Column<Supplier>[] = useMemo(
    () => [
      { key: "code", label: "Code", type: "docno", width: "100px", sortable: true },
      { key: "name", label: "Supplier Name", type: "text", sortable: true },
      { key: "contactPerson", label: "Contact Person", type: "text", width: "150px", sortable: true },
      { key: "phone", label: "Phone", type: "text", width: "150px" },
      { key: "paymentTerms", label: "Terms", type: "text", width: "90px", sortable: true },
      {
        key: "purchaseOrgCode",
        label: "Purchase Company",
        width: "140px",
        sortable: true,
        render: (_val: unknown, row: Supplier) => {
          const code = row.purchaseOrgCode || "HOOKKA";
          const fullName = orgNameByCode[code] || code;
          const tone =
            code === "HOOKKA"
              ? "bg-[#1F1D1B]/10 text-[#1F1D1B] border-[#1F1D1B]/30"
              : code === "OHANA"
                ? "bg-[#6B5C32]/10 text-[#6B5C32] border-[#6B5C32]/30"
                : "bg-[#8B7A4E]/10 text-[#8B7A4E] border-[#8B7A4E]/30";
          return (
            <span
              title={fullName}
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border ${tone}`}
            >
              {code}
            </span>
          );
        },
      },
      {
        key: "rating",
        label: "Rating",
        width: "120px",
        sortable: true,
        render: (_val: unknown, row: Supplier) => ratingStars(row.rating),
      },
      {
        key: "status",
        label: "Status",
        width: "110px",
        sortable: true,
        render: (_val: unknown, row: Supplier) => statusBadge(row.status),
      },
      {
        key: "actions",
        label: "Actions",
        width: "80px",
        align: "right",
        render: (_val: unknown, row: Supplier) => (
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              size="icon"
              title="Edit supplier"
              onClick={(e) => {
                e.stopPropagation();
                setEditingSupplier(row);
                setShowSupplierForm(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ],
    [orgNameByCode]
  );

  const supplierContextMenu = useMemo(
    () =>
      (row: Supplier): ContextMenuItem[] => [
        {
          label: "View Scorecard",
          icon: <TrendingUp className="h-3.5 w-3.5" />,
          action: () => navigate(`/suppliers/${row.id}`),
        },
        {
          label: "Edit",
          icon: <Pencil className="h-3.5 w-3.5" />,
          action: () => { setEditingSupplier(row); setShowSupplierForm(true); },
        },
        { label: "", separator: true, action: () => {} },
        {
          label: "Delete",
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          action: async () => {
            const id = row.id;
            // Optimistic remove, then persist AND surface failure. invalidateCache
            // re-reads the server so a failed delete reappears (no silent loss).
            setSuppliers((prev) => prev.filter((s) => s.id !== id));
            try {
              const res = await fetch(`/api/suppliers/${id}`, { method: "DELETE" });
              if (!res.ok) {
                const b = (await res.json().catch(() => ({}))) as { error?: string };
                toast.error(b.error || `Delete failed (${res.status})`);
              }
            } catch {
              toast.error("Delete failed — network error");
            }
            invalidateCache("/api/suppliers");
          },
        },
      ],
    [navigate, toast]
  );

  const handleSaveSupplier = async (data: Omit<Supplier, "id">) => {
    // Optimistic update for instant UX, then persist. A FAILED save now shows
    // a red error and invalidateCache re-reads the server so the optimistic
    // row reconciles (no more silent "looked saved but wasn't").
    let ok = false;
    let errMsg = "";
    if (editingSupplier) {
      const id = editingSupplier.id;
      setSuppliers((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...data } : s))
      );
      try {
        const res = await fetch(`/api/suppliers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        ok = res.ok;
        if (!ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          errMsg = b.error || `HTTP ${res.status}`;
        }
      } catch {
        errMsg = "network error";
      }
    } else {
      const tempId = `sup-${Date.now()}`;
      const newSupplier: Supplier = { ...data, id: tempId };
      setSuppliers((prev) => [...prev, newSupplier]);
      try {
        const res = await fetch("/api/suppliers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        ok = res.ok;
        if (ok) {
          const body = (await res.json().catch(() => ({}))) as {
            data?: { id?: string };
          };
          const realId = body.data?.id;
          if (realId) {
            setSuppliers((prev) =>
              prev.map((s) => (s.id === tempId ? { ...s, id: realId } : s)),
            );
          }
        } else {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          errMsg = b.error || `HTTP ${res.status}`;
        }
      } catch {
        errMsg = "network error";
      }
    }
    invalidateCache("/api/suppliers");
    if (ok) {
      toast.success("Supplier saved");
      setShowSupplierForm(false);
      setEditingSupplier(null);
    } else {
      // Keep the form open so the operator can retry — do NOT pretend it saved.
      toast.error(`Save failed: ${errMsg}`);
    }
  };

  const { confirm } = useConfirm();

  // KPIs
  const activeSuppliers = suppliers.filter((s) => s.status === "ACTIVE").length;
  const blacklisted = suppliers.filter((s) => s.status === "BLACKLISTED").length;
  const totalSuppliers = suppliers.length;
  const avgRating = suppliers.length > 0
    ? (suppliers.reduce((sum, s) => sum + s.rating, 0) / suppliers.length).toFixed(1)
    : "0";

  const tabs = [
    { key: "suppliers" as const, label: "Suppliers" },
    { key: "price-comparison" as const, label: "Price Comparison" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Suppliers</h1>
        <p className="text-xs text-[#6B7280] mt-0.5">
          Manage supplier information and compare material pricing across suppliers.
        </p>
      </div>

      {/* Top-level tab bar */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Price Comparison tab — cross-supplier global view */}
      {activeTab === "price-comparison" && (
        <ComparisonTab
          bindings={bindings}
          supplierMap={supplierMap}
          scorecardMap={scorecardMap}
          materialCodes={materialCodes}
        />
      )}

      {/* Suppliers tab */}
      {activeTab === "suppliers" && (<>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5">
              <Building2 className="h-5 w-5 text-[#4F7C3A]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#4F7C3A]">{activeSuppliers}</p>
              <p className="text-xs text-[#6B7280]">Active Suppliers</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5">
              <Building2 className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#1F1D1B]">{totalSuppliers}</p>
              <p className="text-xs text-[#6B7280]">Total Suppliers</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FEE2E2] p-2.5">
              <X className="h-5 w-5 text-[#9A3A2D]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#9A3A2D]">{blacklisted}</p>
              <p className="text-xs text-[#6B7280]">Blacklisted</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5">
              <Star className="h-5 w-5 text-amber-500 fill-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">{avgRating}</p>
              <p className="text-xs text-[#6B7280]">Avg Rating</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Supplier list */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="w-80">
            <Input
              placeholder="Search code, name, contact..."
              value={supplierSearch}
              onChange={(e) => setSupplierSearch(e.target.value)}
            />
          </div>
          {selectedSuppliers.length > 0 && (
            <Button variant="outline" onClick={() => setShowBatchEdit(true)}>
              <Pencil className="h-4 w-4" />
              Batch Edit ({selectedSuppliers.length})
            </Button>
          )}
          <Button variant="primary" onClick={() => { setEditingSupplier(null); setShowSupplierForm(true); }}>
            <Plus className="h-4 w-4" />
            Add Supplier
          </Button>
        </div>

        <DataGrid<Supplier>
          columns={supplierColumns}
          data={filteredSuppliers}
          keyField="id"
          virtualize
          gridId="supplier-info"
          contextMenuItems={supplierContextMenu}
          onDoubleClick={(row) => navigate(`/suppliers/${row.id}`)}
          selectable
          onSelectionChange={setSelectedSuppliers}
          emptyMessage="No suppliers found."
          stickyHeader
          maxHeight="calc(100vh - 420px)"
        />
      </div>

      {/* Supplier Form Dialog */}
      {showSupplierForm && (
        <SupplierFormDialog
          editData={editingSupplier}
          orgOptions={orgOptions}
          onSave={handleSaveSupplier}
          onClose={() => { setShowSupplierForm(false); setEditingSupplier(null); }}
        />
      )}

      {/* Batch Edit dialog — set ONE safe shared field on all selected suppliers */}
      {showBatchEdit && (
        <SupplierBatchEditDialog
          suppliers={selectedSuppliers}
          orgOptions={orgOptions}
          onClose={() => setShowBatchEdit(false)}
          onDone={(ok, failed) => {
            // Optimistic local update: re-fetch to reconcile.
            invalidateCache("/api/suppliers");
            setShowBatchEdit(false);
            setSelectedSuppliers([]);
            if (failed.length === 0) {
              toast.success(`Updated ${ok} supplier${ok === 1 ? "" : "s"}.`);
            } else {
              toast.error(
                `${ok} updated, ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`,
              );
            }
          }}
          onOptimisticUpdate={(field, value, ids) => {
            setSuppliers((prev) =>
              prev.map((s) =>
                ids.has(s.id)
                  ? { ...s, [field]: field === "rating" ? Number(value) : value }
                  : s,
              ),
            );
          }}
          confirm={confirm}
        />
      )}
      </>)}
    </div>
  );
}
