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
  const [selectedMaterial, setSelectedMaterial] = useState("");

  const materialBindings = useMemo(
    () => (selectedMaterial ? bindings.filter((b) => b.materialCode === selectedMaterial) : []),
    [bindings, selectedMaterial]
  );
  const cheapestPrice = useMemo(() => {
    if (materialBindings.length === 0) return 0;
    return Math.min(...materialBindings.map((b) => b.unitPrice));
  }, [materialBindings]);
  const fastestLead = useMemo(() => {
    if (materialBindings.length === 0) return 0;
    return Math.min(...materialBindings.map((b) => b.leadTimeDays));
  }, [materialBindings]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Supplier Comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm">
            <label className="block text-sm font-medium text-gray-700 mb-1">Select Material</label>
            <select
              value={selectedMaterial}
              onChange={(e) => setSelectedMaterial(e.target.value)}
              className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
            >
              <option value="">-- Choose a material --</option>
              {materialCodes.map((code) => {
                const binding = bindings.find((b) => b.materialCode === code);
                return (
                  <option key={code} value={code}>
                    {code} - {binding?.materialName ?? ""}
                  </option>
                );
              })}
            </select>
          </div>
        </CardContent>
      </Card>

      {selectedMaterial && materialBindings.length === 0 && (
        <p className="text-center text-gray-400 py-8">No suppliers found for this material</p>
      )}

      {materialBindings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {materialBindings.map((b) => {
            const isCheapest = b.unitPrice === cheapestPrice;
            const isFastest = b.leadTimeDays === fastestLead;
            const scorecard = scorecardMap[b.supplierId];

            let borderClass = "border-[#E2DDD8]";
            if (isCheapest && isFastest) borderClass = "border-[#C6DBA8] ring-1 ring-[#C6DBA8]";
            else if (isCheapest) borderClass = "border-[#C6DBA8] ring-1 ring-[#C6DBA8]";
            else if (isFastest) borderClass = "border-[#A8CAD2] ring-1 ring-[#A8CAD2]";

            return (
              <Card key={b.id} className={`${borderClass} relative`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base">
                      {supplierMap[b.supplierId] ?? b.supplierId}
                    </CardTitle>
                    <div className="flex gap-1">
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
          })}
        </div>
      )}
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
  const [batchField, setBatchField] = useState<"paymentTerms" | "purchaseOrgCode" | "status">("paymentTerms");
  const [batchValue, setBatchValue] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);

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

  // Batch edit — set ONE safe shared field on every selected supplier. Sends
  // the FULL supplier row with that one field changed (safe whether the PUT
  // merges or replaces). Names/codes are never offered (unique per supplier).
  const applyBatchEdit = async () => {
    const val = batchValue.trim();
    if (!val) { toast.error("Pick a value to apply."); return; }
    if (selectedSuppliers.length === 0) return;
    setBatchBusy(true);
    const ids = new Set(selectedSuppliers.map((s) => s.id));
    // Optimistic (mirrors handleSaveSupplier); invalidateCache reconciles after.
    setSuppliers((prev) => prev.map((s) => (ids.has(s.id) ? { ...s, [batchField]: val } : s)));
    let ok = 0;
    const failed: string[] = [];
    for (const s of selectedSuppliers) {
      try {
        const payload: Record<string, unknown> = { ...s, [batchField]: val };
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
    }
    invalidateCache("/api/suppliers");
    setBatchBusy(false);
    setShowBatchEdit(false);
    setSelectedSuppliers([]);
    if (failed.length === 0) {
      toast.success(`Updated ${ok} supplier(s).`);
    } else {
      toast.error(`${ok} updated, ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`);
    }
  };

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
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Active Suppliers</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{activeSuppliers}</p>
            </div>
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Suppliers</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{totalSuppliers}</p>
            </div>
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Blacklisted</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{blacklisted}</p>
            </div>
            <X className="h-5 w-5 text-[#9A3A2D]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Avg Rating</p>
              <p className="text-xl font-bold text-amber-600">{avgRating}</p>
            </div>
            <Star className="h-5 w-5 text-amber-400 fill-amber-400" />
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
            <Button variant="outline" onClick={() => { setBatchValue(""); setShowBatchEdit(true); }}>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => !batchBusy && setShowBatchEdit(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">
                Batch Edit — {selectedSuppliers.length} supplier{selectedSuppliers.length === 1 ? "" : "s"}
              </h2>
              <button
                type="button"
                onClick={() => !batchBusy && setShowBatchEdit(false)}
                className="text-[#9CA3AF] hover:text-[#374151]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Field to change</label>
                <select
                  value={batchField}
                  onChange={(e) => { setBatchField(e.target.value as typeof batchField); setBatchValue(""); }}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="paymentTerms">Payment Terms</option>
                  <option value="purchaseOrgCode">Purchase Company</option>
                  <option value="status">Status</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">New value (applies to all selected)</label>
                {batchField === "purchaseOrgCode" ? (
                  <select
                    value={batchValue}
                    onChange={(e) => setBatchValue(e.target.value)}
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
                ) : batchField === "status" ? (
                  <select
                    value={batchValue}
                    onChange={(e) => setBatchValue(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  >
                    <option value="">Pick a status…</option>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="BLACKLISTED">Blacklisted</option>
                  </select>
                ) : (
                  <select
                    value={batchValue}
                    onChange={(e) => setBatchValue(e.target.value)}
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
              </div>
              <p className="text-xs text-[#9CA3AF]">
                Only this one field changes on the {selectedSuppliers.length} selected supplier{selectedSuppliers.length === 1 ? "" : "s"}. Names and codes are never touched.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 p-5 border-t border-[#E2DDD8]">
              <Button variant="outline" onClick={() => setShowBatchEdit(false)} disabled={batchBusy}>Cancel</Button>
              <Button variant="primary" onClick={applyBatchEdit} disabled={batchBusy || !batchValue}>
                {batchBusy ? "Applying…" : `Apply to ${selectedSuppliers.length}`}
              </Button>
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
