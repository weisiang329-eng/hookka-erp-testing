// ---------------------------------------------------------------------------
// Supplier Pricing — the SINGLE home for supplier-material pricing, SKU
// mapping and costing. Three tabs:
//   - Price List   : full binding CRUD (create / edit / delete) over
//                    supplier_material_bindings, scoped by supplier + search.
//                    (Folded in from the old /procurement/maintenance
//                    "Supplier SKU & Costing" tab on 2026-06-20 so the
//                    binding list lives in exactly ONE place.)
//   - Price History: the price_histories trail (auto-written on a price
//                    change in src/api/routes/supplier-materials.ts).
//   - Comparison   : cross-supplier compare for one material + scorecards.
//
// The per-supplier drill-down (scorecard + that supplier's bindings) still
// lives on /suppliers/:id; this page is the global / cross-supplier view.
// ---------------------------------------------------------------------------
import { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { useToast } from "@/components/ui/toast";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  SKUFormDialog,
  type SupplierSKU,
  type SkuFormSupplier,
  type SkuFormInventoryItem,
} from "./sku-form-dialog";
import type {
  SupplierMaterialBinding,
  PriceHistory,
  SupplierScorecard,
} from "@/types";

type SupplierInfo = {
  id: string;
  name: string;
};

export default function PricingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<"price-list" | "price-history" | "comparison">("price-list");
  const [selectedMaterial, setSelectedMaterial] = useState("");

  // Price List filters (folded in from the old maintenance SKU & Costing tab).
  const [skuSearch, setSkuSearch] = useState("");
  const [skuSupplierFilter, setSkuSupplierFilter] = useState<string>(
    searchParams.get("supplier") ?? "",
  );

  // SKU binding dialog state — create + edit share the same form.
  const [showSKUForm, setShowSKUForm] = useState(false);
  const [editingSKU, setEditingSKU] = useState<SupplierSKU | null>(null);
  const { toast } = useToast();

  const { data: bindingsResp, refresh: reloadBindings } = useCachedJson<{ success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]>("/api/supplier-materials");
  const { data: historyResp } = useCachedJson<{ success?: boolean; data?: PriceHistory[] } | PriceHistory[]>("/api/price-history");
  const { data: scorecardsResp } = useCachedJson<{ success?: boolean; data?: SupplierScorecard[] } | SupplierScorecard[]>("/api/supplier-scorecards");
  const { data: suppliersResp } = useCachedJson<{ success?: boolean; data?: Record<string, unknown>[] } | Record<string, unknown>[]>("/api/suppliers");
  const { data: inventoryResp } = useCachedJson<{ success?: boolean; data?: { rawMaterials?: SkuFormInventoryItem[]; finishedGoods?: SkuFormInventoryItem[]; wipItems?: SkuFormInventoryItem[] } }>("/api/inventory");

  const bindings: SupplierMaterialBinding[] = useMemo(
    () => ((bindingsResp as { data?: SupplierMaterialBinding[] } | undefined)?.data ?? (Array.isArray(bindingsResp) ? bindingsResp : [])),
    [bindingsResp]
  );
  const history: PriceHistory[] = useMemo(
    () => ((historyResp as { data?: PriceHistory[] } | undefined)?.data ?? (Array.isArray(historyResp) ? historyResp : [])),
    [historyResp]
  );
  const scorecards: SupplierScorecard[] = useMemo(
    () => ((scorecardsResp as { data?: SupplierScorecard[] } | undefined)?.data ?? (Array.isArray(scorecardsResp) ? scorecardsResp : [])),
    [scorecardsResp]
  );

  // Full supplier rows — the SKUFormDialog supplier dropdown needs code + name
  // + status, and the Price List supplier-filter needs id + name.
  const supplierRows: SkuFormSupplier[] = useMemo(() => {
    const list = Array.isArray((suppliersResp as { data?: unknown[] })?.data)
      ? ((suppliersResp as { data: Record<string, unknown>[] }).data)
      : Array.isArray(suppliersResp)
        ? (suppliersResp as Record<string, unknown>[])
        : [];
    return list.map((s) => ({
      id: String(s.id ?? s.code ?? ""),
      code: String(s.code ?? s.id ?? ""),
      name: String(s.name ?? ""),
      status: String(s.status ?? (s.isActive === false ? "INACTIVE" : "ACTIVE")),
    }));
  }, [suppliersResp]);

  const suppliers: SupplierInfo[] = useMemo(
    () => supplierRows.map((s) => ({ id: s.id, name: s.name })),
    [supplierRows]
  );

  const supplierMap = useMemo(() => {
    const map: Record<string, string> = {};
    suppliers.forEach((s) => { map[s.id] = s.name; });
    return map;
  }, [suppliers]);

  // Inventory items for the SKU form's RM autocomplete.
  const inventoryItems: SkuFormInventoryItem[] = useMemo(() => {
    const d = inventoryResp;
    if (!d?.success || !d.data) return [];
    return [
      ...(d.data.rawMaterials || []),
      ...(d.data.finishedGoods || []),
      ...(d.data.wipItems || []),
    ].map((item) => ({
      id: item.id,
      itemCode: item.itemCode,
      description: item.description,
      baseUOM: item.baseUOM,
      itemGroup: item.itemGroup,
    }));
  }, [inventoryResp]);

  const scorecardMap = useMemo(() => {
    const map: Record<string, SupplierScorecard> = {};
    scorecards.forEach((s) => { map[s.supplierId] = s; });
    return map;
  }, [scorecards]);

  // Unique material codes for comparison dropdown
  const materialCodes = useMemo(() => {
    const codes = Array.from(new Set(bindings.map((b) => b.materialCode)));
    return codes.sort();
  }, [bindings]);

  // ---- binding helpers (map the page's SupplierSKU form shape onto the
  //      /api/supplier-materials body; unitPrice is sent in SEN — the binding
  //      column is integer sen, so do NOT multiply by 100). ----
  const bindingToSKU = (b: SupplierMaterialBinding): SupplierSKU => ({
    id: b.id,
    internalRMCode: b.materialCode,
    materialName: b.materialName,
    supplierId: b.supplierId,
    supplierName: supplierMap[b.supplierId],
    supplierSku: b.supplierSku,
    supplierDescription: (b as unknown as { supplierDescription?: string }).supplierDescription ?? "",
    unitPriceSen: b.unitPrice,
    currency: b.currency || "MYR",
    leadTimeDays: b.leadTimeDays,
    moq: b.moq,
    isMainSupplier: b.isMainSupplier,
    validFrom: b.priceValidFrom ?? "",
    validTo: b.priceValidTo ?? "",
  });

  const skuToBindingBody = (data: Omit<SupplierSKU, "id">) => ({
    supplierId: data.supplierId,
    materialCode: data.internalRMCode,
    materialName: data.materialName,
    supplierSku: data.supplierSku,
    supplierDescription: data.supplierDescription ?? "",
    unitPrice: data.unitPriceSen,
    currency: data.currency,
    leadTimeDays: data.leadTimeDays,
    moq: data.moq,
    isMainSupplier: data.isMainSupplier,
    priceValidFrom: data.validFrom || undefined,
    priceValidTo: data.validTo || undefined,
  });

  const handleSaveSKU = async (data: Omit<SupplierSKU, "id">) => {
    let ok = false;
    let errMsg = "";
    const url = editingSKU
      ? `/api/supplier-materials/${editingSKU.id}`
      : "/api/supplier-materials";
    const method = editingSKU ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skuToBindingBody(data)),
      });
      ok = res.ok;
      if (!ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        errMsg = b.error || `HTTP ${res.status}`;
      }
    } catch {
      errMsg = "network error";
    }
    invalidateCachePrefix("/api/supplier-materials");
    // The Price History trail is server-written on a price change; refresh it
    // so the History tab reflects an edit immediately.
    invalidateCache("/api/price-history");
    reloadBindings();
    if (ok) {
      toast.success("SKU mapping saved");
      setShowSKUForm(false);
      setEditingSKU(null);
    } else {
      // Keep the form open so the operator can retry — do NOT pretend it saved.
      toast.error(`Save failed: ${errMsg}`);
    }
  };

  const handleDeleteSKU = async (b: SupplierMaterialBinding) => {
    try {
      const res = await fetch(`/api/supplier-materials/${b.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error || `Delete failed (${res.status})`);
      } else {
        toast.success("SKU mapping deleted");
      }
    } catch {
      toast.error("Delete failed — network error");
    }
    invalidateCachePrefix("/api/supplier-materials");
    reloadBindings();
  };

  const tabs = [
    { key: "price-list" as const, label: "Price List" },
    { key: "price-history" as const, label: "Price History" },
    { key: "comparison" as const, label: "Comparison" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Supplier Pricing</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage supplier-material SKU mappings &amp; costing, track price changes, and compare suppliers
        </p>
      </div>

      {/* Tab Buttons */}
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

      {/* Tab Content */}
      {activeTab === "price-list" && (
        <PriceListTab
          bindings={bindings}
          suppliers={suppliers}
          supplierMap={supplierMap}
          search={skuSearch}
          onSearchChange={setSkuSearch}
          supplierFilter={skuSupplierFilter}
          onSupplierFilterChange={(v) => {
            setSkuSupplierFilter(v);
            const next = new URLSearchParams(searchParams);
            if (v) next.set("supplier", v); else next.delete("supplier");
            setSearchParams(next, { replace: true });
          }}
          onAddClick={() => { setEditingSKU(null); setShowSKUForm(true); }}
          onEdit={(b) => { setEditingSKU(bindingToSKU(b)); setShowSKUForm(true); }}
          onDelete={handleDeleteSKU}
        />
      )}

      {showSKUForm && (
        <SKUFormDialog
          editData={editingSKU}
          suppliers={supplierRows}
          inventoryItems={inventoryItems}
          presetSupplierId={editingSKU ? undefined : skuSupplierFilter || undefined}
          onSave={handleSaveSKU}
          onClose={() => { setShowSKUForm(false); setEditingSKU(null); }}
        />
      )}
      {activeTab === "price-history" && (
        <PriceHistoryTab history={history} supplierMap={supplierMap} />
      )}
      {activeTab === "comparison" && (
        <ComparisonTab
          bindings={bindings}
          supplierMap={supplierMap}
          scorecardMap={scorecardMap}
          materialCodes={materialCodes}
          selectedMaterial={selectedMaterial}
          onMaterialChange={setSelectedMaterial}
        />
      )}
    </div>
  );
}

// ---- Price List Tab — full binding CRUD (was the maintenance SKU & Costing
//      tab). Supplier filter + search scope the grid; Add/Edit/Delete drive
//      the shared SKUFormDialog. ----
function PriceListTab({
  bindings,
  suppliers,
  supplierMap,
  search,
  onSearchChange,
  supplierFilter,
  onSupplierFilterChange,
  onAddClick,
  onEdit,
  onDelete,
}: {
  bindings: SupplierMaterialBinding[];
  suppliers: SupplierInfo[];
  supplierMap: Record<string, string>;
  search: string;
  onSearchChange: (v: string) => void;
  supplierFilter: string;
  onSupplierFilterChange: (v: string) => void;
  onAddClick: () => void;
  onEdit: (b: SupplierMaterialBinding) => void;
  onDelete: (b: SupplierMaterialBinding) => void;
}) {
  // Resolve supplier names + a supplierDescription string onto each row for
  // display/filter (the API returns supplierDescription; it isn't on the
  // @/types SupplierMaterialBinding so read it loosely).
  type Row = SupplierMaterialBinding & { supplierName: string; supplierDescription: string };
  const rows: Row[] = useMemo(
    () => bindings.map((b) => ({
      ...b,
      supplierName: supplierMap[b.supplierId] ?? b.supplierId,
      supplierDescription: (b as unknown as { supplierDescription?: string }).supplierDescription ?? "",
    })),
    [bindings, supplierMap]
  );

  // Per-supplier counts for the dropdown — a single flat list of ~1k rows is
  // unusable, so pick a supplier to scope (Wei Siang 2026-05-10).
  const countBySupplierId = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.supplierId, (m.get(r.supplierId) ?? 0) + 1);
    return m;
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (supplierFilter) out = out.filter((r) => r.supplierId === supplierFilter);
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          r.materialCode.toLowerCase().includes(q) ||
          r.materialName.toLowerCase().includes(q) ||
          r.supplierSku.toLowerCase().includes(q) ||
          r.supplierDescription.toLowerCase().includes(q) ||
          r.supplierName.toLowerCase().includes(q)
      );
    }
    return out;
  }, [rows, search, supplierFilter]);

  const columns: Column<Row>[] = useMemo(
    () => [
      { key: "materialCode", label: "Internal Code", type: "docno", width: "130px", sortable: true },
      { key: "materialName", label: "Internal Description", type: "text", sortable: true },
      { key: "supplierName", label: "Supplier", type: "text", width: "160px", sortable: true },
      { key: "supplierSku", label: "Supplier Code", type: "text", width: "140px", sortable: true },
      { key: "supplierDescription", label: "Supplier Description", type: "text", sortable: true },
      { key: "unitPrice", label: "Unit Price", type: "currency", width: "110px", sortable: true },
      { key: "currency", label: "Currency", type: "text", width: "80px" },
      {
        key: "leadTimeDays",
        label: "Lead Time",
        width: "90px",
        sortable: true,
        render: (val: unknown) => <span>{val as number}d</span>,
      },
      { key: "moq", label: "MOQ", type: "number", width: "70px", sortable: true },
      {
        key: "isMainSupplier",
        label: "Main",
        width: "70px",
        sortable: true,
        render: (_val: unknown, row: Row) =>
          row.isMainSupplier ? (
            <Badge className="bg-green-50 text-green-800 border-green-300">Main</Badge>
          ) : (
            <span className="text-gray-400 text-xs">-</span>
          ),
      },
      {
        key: "priceValidFrom",
        label: "Valid Period",
        width: "160px",
        render: (_val: unknown, row: Row) => (
          <span className="text-xs text-gray-500">
            {formatDate(row.priceValidFrom)} - {formatDate(row.priceValidTo)}
          </span>
        ),
      },
      {
        key: "actions",
        label: "Actions",
        width: "90px",
        align: "right",
        render: (_val: unknown, row: Row) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              title="Edit"
              onClick={(e) => { e.stopPropagation(); onEdit(row); }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Delete"
              className="text-[#9A3A2D] hover:text-[#7A2E24]"
              onClick={(e) => { e.stopPropagation(); onDelete(row); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ],
    [onEdit, onDelete]
  );

  const contextMenu = useMemo(
    () =>
      (row: Row): ContextMenuItem[] => [
        {
          label: "Edit",
          icon: <Pencil className="h-3.5 w-3.5" />,
          action: () => onEdit(row),
        },
        { label: "", separator: true, action: () => {} },
        {
          label: "Delete",
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          action: () => onDelete(row),
        },
      ],
    [onEdit, onDelete]
  );

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle>Supplier-Material Bindings</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={supplierFilter}
              onChange={(e) => onSupplierFilterChange(e.target.value)}
              className="h-10 px-3 rounded border border-[#D8D2CC] bg-white text-sm min-w-[240px]"
              title="Filter bindings by supplier"
            >
              <option value="">All suppliers ({rows.length})</option>
              {[...suppliers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({countBySupplierId.get(s.id) ?? 0})
                  </option>
                ))}
            </select>
            <div className="w-72">
              <Input
                placeholder="Search material, supplier, SKU..."
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
            <Button
              onClick={onAddClick}
              className="bg-[#6B5C32] hover:bg-[#574A28] text-white gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Add Binding
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DataGrid<Row>
          columns={columns}
          data={filtered}
          keyField="id"
          virtualize
          gridId="supplier-sku-costing"
          contextMenuItems={contextMenu}
          onDoubleClick={(row) => onEdit(row)}
          emptyMessage="No bindings found."
          stickyHeader
          maxHeight="calc(100vh - 360px)"
        />
      </CardContent>
    </Card>
  );
}

// ---- Price History Tab ----
function PriceHistoryTab({
  history,
  supplierMap,
}: {
  history: PriceHistory[];
  supplierMap: Record<string, string>;
}) {
  const sorted = useMemo(
    () => [...history].sort((a, b) => b.changedDate.localeCompare(a.changedDate)),
    [history]
  );

  function changePercent(oldP: number, newP: number) {
    if (oldP === 0) return "N/A";
    const pct = ((newP - oldP) / oldP) * 100;
    return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
  }

  function statusBadge(status: string) {
    if (status === "APPROVED") {
      return (
        <Badge className="bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]">APPROVED</Badge>
      );
    }
    if (status === "PENDING") {
      return (
        <Badge className="bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]">PENDING</Badge>
      );
    }
    if (status === "REJECTED") {
      return (
        <Badge className="bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]">REJECTED</Badge>
      );
    }
    return <Badge>{status}</Badge>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Price Change History</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="pb-3 pr-4">Date</th>
                <th className="pb-3 pr-4">Material</th>
                <th className="pb-3 pr-4">Supplier</th>
                <th className="pb-3 pr-4 text-right">Old Price</th>
                <th className="pb-3 pr-4 text-right">New Price</th>
                <th className="pb-3 pr-4 text-right">Change %</th>
                <th className="pb-3 pr-4">Changed By</th>
                <th className="pb-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2DDD8]">
              {sorted.map((h) => {
                const pctStr = changePercent(h.oldPrice, h.newPrice);
                const isIncrease = h.newPrice > h.oldPrice;
                return (
                  <tr key={h.id} className="hover:bg-[#F0ECE9]/50">
                    <td className="py-3 pr-4">{formatDate(h.changedDate)}</td>
                    <td className="py-3 pr-4 font-mono text-xs">{h.materialCode}</td>
                    <td className="py-3 pr-4">{supplierMap[h.supplierId] ?? h.supplierId}</td>
                    <td className="py-3 pr-4 text-right">{formatCurrency(h.oldPrice, h.currency)}</td>
                    <td className="py-3 pr-4 text-right font-medium">{formatCurrency(h.newPrice, h.currency)}</td>
                    <td className={`py-3 pr-4 text-right font-medium ${isIncrease ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                      {pctStr}
                    </td>
                    <td className="py-3 pr-4">{h.changedBy}</td>
                    <td className="py-3">{statusBadge(h.approvalStatus)}</td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-gray-400">
                    No price history found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Comparison Tab ----
function ComparisonTab({
  bindings,
  supplierMap,
  scorecardMap,
  materialCodes,
  selectedMaterial,
  onMaterialChange,
}: {
  bindings: SupplierMaterialBinding[];
  supplierMap: Record<string, string>;
  scorecardMap: Record<string, SupplierScorecard>;
  materialCodes: string[];
  selectedMaterial: string;
  onMaterialChange: (v: string) => void;
}) {
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
              onChange={(e) => onMaterialChange(e.target.value)}
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
                          Price Trend: <span className={scorecard.avgPriceTrend > 5 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}>
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
