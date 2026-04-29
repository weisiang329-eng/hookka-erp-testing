import { useState, useMemo } from "react";
import { formatCurrency } from "@/lib/utils";
import type { FabricTracking } from "@/types";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Search,
  Package,
  Filter,
  Layers,
  Minus,
} from "lucide-react";

const CATEGORIES = ["ALL", "B.M-FABR", "S-FABR", "S.M-FABR", "LINING", "WEBBING"] as const;

// Substitute material lookup — maps fabric code patterns to available alternatives.
// In production this would come from the BOM template data; here we use a static map
// matching the substitutes defined in mock-data BOM components.
const FABRIC_SUBSTITUTES: Record<string, { name: string; costDiff: string }[]> = {
  "PC151": [
    { name: "PC200", costDiff: "+5%" },
    { name: "AVANI 01", costDiff: "-3%" },
  ],
  "PC200": [
    { name: "PC151", costDiff: "-5%" },
    { name: "AVANI 01", costDiff: "-8%" },
  ],
  "KN390": [
    { name: "SF-AT-15", costDiff: "-3%" },
    { name: "KN500", costDiff: "+8%" },
  ],
};

function getSubstitutesForFabric(fabricCode: string): { name: string; costDiff: string }[] | null {
  for (const prefix of Object.keys(FABRIC_SUBSTITUTES)) {
    if (fabricCode.startsWith(prefix)) {
      return FABRIC_SUBSTITUTES[prefix];
    }
  }
  return null;
}

const CATEGORY_LABELS: Record<string, string> = {
  "B.M-FABR": "Bedframe Main",
  "S-FABR": "Secondary",
  "S.M-FABR": "Sofa Main",
  LINING: "Lining",
  WEBBING: "Webbing",
};

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  "B.M-FABR": { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]" },
  "S-FABR": { bg: "bg-[#F1E6F0]", text: "text-[#6B4A6D]" },
  "S.M-FABR": { bg: "bg-emerald-100", text: "text-emerald-800" },
  LINING: { bg: "bg-[#FAEFCB]", text: "text-[#9C6F1E]" },
  WEBBING: { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]" },
};

type Tab = "inventory";

export default function FabricsPage() {
  const { data: fabricsResp, loading, refresh: refreshFabrics } = useCachedJson<{ success?: boolean; data?: FabricTracking[] }>("/api/fabric-tracking");
  const fabrics: FabricTracking[] = useMemo(
    () => (fabricsResp?.data ?? (Array.isArray(fabricsResp) ? (fabricsResp as FabricTracking[]) : [])),
    [fabricsResp]
  );
  const [activeTab, setActiveTab] = useState<Tab>("inventory");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");

  const filtered = useMemo(() => {
    let list = fabrics;
    if (categoryFilter !== "ALL") {
      list = list.filter((f) => f.fabricCategory === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (f) =>
          f.fabricCode.toLowerCase().includes(q) ||
          f.fabricDescription.toLowerCase().includes(q)
      );
    }
    return list;
  }, [fabrics, categoryFilter, search]);

  const totalSOH = fabrics.reduce((s, f) => s + f.soh, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-[#6B5C32] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Fabric Tracking</h1>
        <p className="text-sm text-gray-500 mt-1">
          Material inventory matching Google Sheet &quot;Fabric&quot; tab
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SummaryCard
          icon={<Layers className="h-5 w-5 text-[#6B5C32]" />}
          label="Total Fabrics"
          value={fabrics.length.toString()}
        />
        <SummaryCard
          icon={<Package className="h-5 w-5 text-[#3E6570]" />}
          label="Total SOH"
          value={`${totalSOH.toLocaleString()} m`}
        />
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6">
          {(
            [
              { key: "inventory", label: "Fabric Inventory", icon: Layers },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === "inventory" && (
        <InventoryTab
          fabrics={filtered}
          search={search}
          setSearch={setSearch}
          categoryFilter={categoryFilter}
          setCategoryFilter={setCategoryFilter}
          onPriceTierChange={async (id, tier) => {
            try {
              const res = await fetch(`/api/fabric-tracking/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ priceTier: tier }),
              });
              if (res.ok) {
                invalidateCachePrefix("/api/fabric-tracking");
                invalidateCachePrefix("/api/raw-materials");
                refreshFabrics();
              }
            } catch {
              // ignore
            }
          }}
        />
      )}
    </div>
  );
}

/* ─── Summary Card ────────────────────────────────────────────────── */
function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="text-xl font-bold text-gray-900">{value}</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Tab 1: Fabric Inventory ─────────────────────────────────────── */
function InventoryTab({
  fabrics,
  search,
  setSearch,
  categoryFilter,
  setCategoryFilter,
  onPriceTierChange,
}: {
  fabrics: FabricTracking[];
  search: string;
  setSearch: (v: string) => void;
  categoryFilter: string;
  setCategoryFilter: (v: string) => void;
  onPriceTierChange: (id: string, tier: "PRICE_1" | "PRICE_2") => void;
}) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by code or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40 focus:border-[#6B5C32]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c === "ALL" ? "All Categories" : `${c} - ${CATEGORY_LABELS[c]}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left font-semibold text-gray-600">Fabric Code</th>
              <th className="px-3 py-3 text-left font-semibold text-gray-600">Description</th>
              <th className="px-3 py-3 text-left font-semibold text-gray-600">Category</th>
              <th className="px-3 py-3 text-center font-semibold text-gray-600">Price Tier</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">Price</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">SOH</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">PO Outstanding</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">Last Month Usage</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">1-Week</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">2-Week</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">1-Month</th>
              <th className="px-3 py-3 text-right font-semibold text-gray-600">Shortage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {fabrics.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-8 text-center text-gray-400">
                  No fabrics found
                </td>
              </tr>
            ) : (
              fabrics.map((f) => {
                const catColor = CATEGORY_COLORS[f.fabricCategory] ?? {
                  bg: "bg-gray-100",
                  text: "text-gray-600",
                };
                return (
                  <tr key={f.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono font-medium text-gray-900">
                      {f.fabricCode}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{f.fabricDescription}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${catColor.bg} ${catColor.text}`}
                      >
                        {f.fabricCategory}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <select
                        value={f.priceTier || "PRICE_2"}
                        onChange={(e) =>
                          onPriceTierChange(
                            f.id,
                            e.target.value as "PRICE_1" | "PRICE_2"
                          )
                        }
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
                    <td className="px-3 py-2 text-right text-gray-700">
                      {formatCurrency(f.price)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">
                      {f.soh.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {f.poOutstanding > 0 ? (
                        <span className="text-[#9C6F1E] font-medium">
                          {f.poOutstanding.toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-gray-400">
                          <Minus className="inline h-3 w-3" />
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {f.lastMonthUsage.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {f.oneWeekUsage.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {f.twoWeeksUsage.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {f.oneMonthUsage.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-bold">
                      <span
                        className={
                          f.shortage < 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"
                        }
                      >
                        {f.shortage < 0 ? f.shortage.toLocaleString() : `+${f.shortage.toLocaleString()}`}
                      </span>
                      {f.shortage < 0 && (() => {
                        const subs = getSubstitutesForFabric(f.fabricCode);
                        if (!subs) return null;
                        return (
                          <div className="text-[10px] text-[#9C6F1E] font-normal mt-0.5 text-left">
                            &#x26A0;&#xFE0F; Substitutes: {subs.map((s) => `${s.name} (${s.costDiff})`).join(", ")}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

