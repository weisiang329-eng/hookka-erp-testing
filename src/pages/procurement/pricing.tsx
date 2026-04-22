import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
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
  const [bindings, setBindings] = useState<SupplierMaterialBinding[]>([]);
  const [history, setHistory] = useState<PriceHistory[]>([]);
  const [scorecards, setScorecards] = useState<SupplierScorecard[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierInfo[]>([]);
  const [search, setSearch] = useState("");
  const [selectedMaterial, setSelectedMaterial] = useState("");

  useEffect(() => {
    fetch("/api/supplier-materials").then((r) => r.json()).then((d) => setBindings(d.data ?? d)).catch(() => {});
    fetch("/api/price-history").then((r) => r.json()).then((d) => setHistory(d.data ?? d)).catch(() => {});
    fetch("/api/supplier-scorecards").then((r) => r.json()).then((d) => setScorecards(d.data ?? d)).catch(() => {});
    fetch("/api/suppliers").then((r) => r.json()).then((d) => {
      const list = d.data ?? d;
      setSuppliers(
        (Array.isArray(list) ? list : []).map((s: { id: string; name: string }) => ({
          id: s.id,
          name: s.name,
        }))
      );
    }).catch(() => {});
  }, []);

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
}: {
  bindings: SupplierMaterialBinding[];
  supplierMap: Record<string, string>;
  search: string;
  onSearchChange: (v: string) => void;
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
        <div className="flex items-center justify-between">
          <CardTitle>All Supplier-Material Bindings</CardTitle>
          <div className="w-72">
            <Input
              placeholder="Search material, supplier, SKU..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
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
