import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Plus, X } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import type {
  SupplierMaterialBinding,
  PriceHistory,
  SupplierScorecard,
} from "@/lib/mock-data";

type SupplierInfo = {
  id: string;
  name: string;
};

export default function PricingPage() {
  const [activeTab, setActiveTab] = useState<"price-list" | "price-history" | "comparison">("price-list");
  const [search, setSearch] = useState("");
  const [selectedMaterial, setSelectedMaterial] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { toast } = useToast();

  const { data: bindingsResp, refresh: reloadBindings } = useCachedJson<{ success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]>("/api/supplier-materials");
  const { data: historyResp } = useCachedJson<{ success?: boolean; data?: PriceHistory[] } | PriceHistory[]>("/api/price-history");
  const { data: scorecardsResp } = useCachedJson<{ success?: boolean; data?: SupplierScorecard[] } | SupplierScorecard[]>("/api/supplier-scorecards");
  const { data: suppliersResp } = useCachedJson<{ success?: boolean; data?: { id: string; name: string }[] } | { id: string; name: string }[]>("/api/suppliers");

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
  const suppliers: SupplierInfo[] = useMemo(() => {
    const list = (suppliersResp as { data?: { id: string; name: string }[] } | undefined)?.data ?? (Array.isArray(suppliersResp) ? suppliersResp : []);
    return (Array.isArray(list) ? list : []).map((s: { id: string; name: string }) => ({
      id: s.id,
      name: s.name,
    }));
  }, [suppliersResp]);

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

  // Unique material codes for comparison dropdown
  const materialCodes = useMemo(() => {
    const codes = Array.from(new Set(bindings.map((b) => b.materialCode)));
    return codes.sort();
  }, [bindings]);

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
          Manage supplier-material bindings, track price changes, and compare suppliers
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
          supplierMap={supplierMap}
          search={search}
          onSearchChange={setSearch}
          onAddClick={() => setShowAddDialog(true)}
        />
      )}

      {showAddDialog && (
        <AddBindingDialog
          suppliers={suppliers}
          onClose={() => setShowAddDialog(false)}
          onCreated={() => {
            invalidateCachePrefix("/api/supplier-materials");
            invalidateCachePrefix("/api/suppliers");
            setShowAddDialog(false);
            reloadBindings();
            toast.success("Supplier-material binding created");
          }}
          onError={(msg) => toast.error(msg)}
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

// ---- Price List Tab ----
function PriceListTab({
  bindings,
  supplierMap,
  search,
  onSearchChange,
  onAddClick,
}: {
  bindings: SupplierMaterialBinding[];
  supplierMap: Record<string, string>;
  search: string;
  onSearchChange: (v: string) => void;
  onAddClick: () => void;
}) {
  const filtered = useMemo(() => {
    if (!search) return bindings;
    const q = search.toLowerCase();
    return bindings.filter(
      (b) =>
        b.materialCode.toLowerCase().includes(q) ||
        b.materialName.toLowerCase().includes(q) ||
        b.supplierSku.toLowerCase().includes(q) ||
        (supplierMap[b.supplierId] ?? "").toLowerCase().includes(q)
    );
  }, [bindings, search, supplierMap]);

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>All Supplier-Material Bindings</CardTitle>
          <div className="flex items-center gap-2">
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="pb-3 pr-4">Material Code</th>
                <th className="pb-3 pr-4">Material Name</th>
                <th className="pb-3 pr-4">Supplier</th>
                <th className="pb-3 pr-4">Supplier SKU</th>
                <th className="pb-3 pr-4 text-right">Unit Price</th>
                <th className="pb-3 pr-4">Currency</th>
                <th className="pb-3 pr-4 text-right">Lead Time</th>
                <th className="pb-3 pr-4 text-right">MOQ</th>
                <th className="pb-3 pr-4">Main</th>
                <th className="pb-3">Valid Period</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2DDD8]">
              {filtered.map((b) => (
                <tr key={b.id} className="hover:bg-[#F0ECE9]/50">
                  <td className="py-3 pr-4 font-mono text-xs">{b.materialCode}</td>
                  <td className="py-3 pr-4">{b.materialName}</td>
                  <td className="py-3 pr-4">{supplierMap[b.supplierId] ?? b.supplierId}</td>
                  <td className="py-3 pr-4 font-mono text-xs">{b.supplierSku}</td>
                  <td className="py-3 pr-4 text-right font-medium">
                    {formatCurrency(b.unitPrice, b.currency)}
                  </td>
                  <td className="py-3 pr-4">{b.currency}</td>
                  <td className="py-3 pr-4 text-right">{b.leadTimeDays}d</td>
                  <td className="py-3 pr-4 text-right">{b.moq}</td>
                  <td className="py-3 pr-4">
                    {b.isMainSupplier && (
                      <Badge className="bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]">
                        Main
                      </Badge>
                    )}
                  </td>
                  <td className="py-3 text-xs text-gray-500">
                    {formatDate(b.priceValidFrom)} - {formatDate(b.priceValidTo)}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-gray-400">
                    No bindings found
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

// ---- Add Binding Dialog ----
function AddBindingDialog({
  suppliers,
  onClose,
  onCreated,
  onError,
}: {
  suppliers: SupplierInfo[];
  onClose: () => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    supplierId: "",
    materialCode: "",
    materialName: "",
    supplierSku: "",
    unitPrice: "",
    currency: "MYR",
    leadTimeDays: "7",
    moq: "1",
    paymentTerms: "NET30",
    priceValidFrom: new Date().toISOString().slice(0, 10),
    priceValidTo: "2026-12-31",
    isMainSupplier: false,
  });
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.supplierId || !form.materialCode || !form.materialName || !form.supplierSku || !form.unitPrice) {
      onError("Fill in supplier, material code, name, SKU, and unit price.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/supplier-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: form.supplierId,
          materialCode: form.materialCode,
          materialName: form.materialName,
          supplierSku: form.supplierSku,
          unitPrice: Number(form.unitPrice),
          currency: form.currency,
          leadTimeDays: Number(form.leadTimeDays) || 7,
          moq: Number(form.moq) || 1,
          paymentTerms: form.paymentTerms,
          priceValidFrom: form.priceValidFrom,
          priceValidTo: form.priceValidTo,
          isMainSupplier: form.isMainSupplier,
        }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as { success?: boolean; error?: string };
      if (res.ok && json.success) {
        onCreated();
      } else {
        onError(json.error || "Failed to create binding");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E2DDD8]">
          <h3 className="text-base font-semibold text-[#1F1D1B]">Add Supplier-Material Binding</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-3 text-sm">
          <label className="col-span-2">
            <span className="block text-xs font-medium text-gray-600 mb-1">Supplier *</span>
            <select
              value={form.supplierId}
              onChange={(e) => set("supplierId", e.target.value)}
              className="w-full border border-[#E2DDD8] rounded px-2 py-1.5 bg-white"
            >
              <option value="">Select supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Material Code *</span>
            <Input value={form.materialCode} onChange={(e) => set("materialCode", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Material Name *</span>
            <Input value={form.materialName} onChange={(e) => set("materialName", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Supplier SKU *</span>
            <Input value={form.supplierSku} onChange={(e) => set("supplierSku", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Unit Price *</span>
            <Input type="number" step="0.01" value={form.unitPrice} onChange={(e) => set("unitPrice", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Currency</span>
            <select
              value={form.currency}
              onChange={(e) => set("currency", e.target.value)}
              className="w-full border border-[#E2DDD8] rounded px-2 py-1.5 bg-white"
            >
              <option value="MYR">MYR</option>
              <option value="RMB">RMB</option>
            </select>
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Lead Time (days)</span>
            <Input type="number" value={form.leadTimeDays} onChange={(e) => set("leadTimeDays", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">MOQ</span>
            <Input type="number" value={form.moq} onChange={(e) => set("moq", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Payment Terms</span>
            <Input value={form.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Valid From</span>
            <Input type="date" value={form.priceValidFrom} onChange={(e) => set("priceValidFrom", e.target.value)} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-600 mb-1">Valid To</span>
            <Input type="date" value={form.priceValidTo} onChange={(e) => set("priceValidTo", e.target.value)} />
          </label>
          <label className="col-span-2 flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={form.isMainSupplier}
              onChange={(e) => set("isMainSupplier", e.target.checked)}
            />
            <span className="text-xs font-medium text-gray-600">Mark as main supplier for this material</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[#E2DDD8] bg-[#FAF8F4]">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={saving}
            className="bg-[#6B5C32] hover:bg-[#574A28] text-white"
          >
            {saving ? "Saving…" : "Create Binding"}
          </Button>
        </div>
      </div>
    </div>
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
