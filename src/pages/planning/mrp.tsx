import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Layers,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Factory,
  Package,
  ShoppingCart,
  ArrowDownUp,
  Filter,
} from "lucide-react";
import type { MaterialRequirement, MRPRun } from "@/lib/mock-data";

type Tab = "DASHBOARD" | "REQUIREMENTS" | "FABRIC";
type StatusFilter = "ALL" | "SUFFICIENT" | "LOW" | "SHORTAGE";
type Horizon = "1w" | "2w" | "1m" | "all";
const HORIZONS: { key: Horizon; label: string }[] = [
  { key: "1w", label: "This Week" },
  { key: "2w", label: "2 Weeks" },
  { key: "1m", label: "1 Month" },
  { key: "all", label: "All" },
];

type FabricDetail = {
  id: string;
  code: string;
  name: string;
  category: string;
  sohMeters: number;
  poOutstanding: number;
  weeklyUsage: number;
  twoWeekUsage: number;
  monthlyUsage: number;
  shortage: boolean;
};

const TABS: { key: Tab; label: string }[] = [
  { key: "DASHBOARD", label: "MRP Dashboard" },
  { key: "REQUIREMENTS", label: "Material Requirements" },
  { key: "FABRIC", label: "Fabric Planning" },
];

function statusBadgeColor(status: string) {
  switch (status) {
    case "SUFFICIENT":
      return "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]";
    case "LOW":
      return "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]";
    case "SHORTAGE":
      return "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]";
    default:
      return "bg-gray-100 text-gray-600 border-gray-300";
  }
}

function statusDotColor(status: string) {
  switch (status) {
    case "SUFFICIENT":
      return "bg-[#4F7C3A]";
    case "LOW":
      return "bg-[#9C6F1E]";
    case "SHORTAGE":
      return "bg-[#9A3A2D]";
    default:
      return "bg-gray-400";
  }
}

export default function MRPPage() {
  const [activeTab, setActiveTab] = useState<Tab>("DASHBOARD");
  const [mrpData, setMrpData] = useState<MRPRun | null>(null);
  const [fabricData, setFabricData] = useState<FabricDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [sortDesc, setSortDesc] = useState(true);
  const [horizon, setHorizon] = useState<Horizon>("all");

  const fetchMRP = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mrp");
      const json = await res.json();
      if (json.success && json.data) {
        setMrpData(json.data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMRP();
  }, [fetchMRP]);

  const runMRP = async (h?: Horizon) => {
    const selectedHorizon = h ?? horizon;
    setRunning(true);
    try {
      const res = await fetch(`/api/mrp?horizon=${selectedHorizon}`, { method: "POST" });
      const json = await res.json();
      if (json.success && json.data) {
        setMrpData(json.data);
        if (json.fabricDetail) {
          setFabricData(json.fabricDetail);
        }
      }
    } catch {
      // ignore
    } finally {
      setRunning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
        <span className="ml-3 text-[#6B7280]">Loading MRP data...</span>
      </div>
    );
  }

  const requirements = mrpData?.requirements ?? [];
  const shortages = requirements.filter((r) => r.status === "SHORTAGE");
  const lowItems = requirements.filter((r) => r.status === "LOW");
  const sufficientItems = requirements.filter((r) => r.status === "SUFFICIENT");

  // Filtered & sorted requirements for tab 2
  const filteredRequirements = requirements
    .filter((r) => statusFilter === "ALL" || r.status === statusFilter)
    .sort((a, b) =>
      sortDesc
        ? b.netRequired - a.netRequired
        : a.netRequired - b.netRequired
    );

  // Fabric items for tab 3 (filter requirements to fabric categories)
  const fabricCategories = ["BM_FABRIC", "SM_FABRIC"];
  const fabricRequirements = requirements.filter((r) =>
    fabricCategories.includes(r.materialCategory)
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1D1B] flex items-center gap-2">
            <Layers className="h-7 w-7 text-[#6B5C32]" />
            Material Requirements Planning
          </h1>
          <p className="text-sm text-[#6B7280] mt-1">
            Plan material needs based on active production orders and BOM
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Planning Horizon Selector */}
          <div className="flex items-center gap-1 bg-[#F0ECE9] rounded-lg p-0.5">
            {HORIZONS.map((h) => (
              <button
                key={h.key}
                onClick={() => { setHorizon(h.key); runMRP(h.key); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  horizon === h.key
                    ? "bg-white text-[#6B5C32] shadow-sm"
                    : "text-[#6B7280] hover:text-[#1F1D1B]"
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>
          <Button
            variant="primary"
            onClick={() => runMRP()}
            disabled={running}
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Running MRP...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Run MRP
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-0 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === "DASHBOARD" && (
        <DashboardTab
          mrpData={mrpData}
          shortages={shortages}
          lowItems={lowItems}
          sufficientItems={sufficientItems}
        />
      )}

      {activeTab === "REQUIREMENTS" && (
        <RequirementsTab
          requirements={filteredRequirements}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          sortDesc={sortDesc}
          setSortDesc={setSortDesc}
          allRequirements={requirements}
        />
      )}

      {activeTab === "FABRIC" && (
        <FabricTab
          fabricRequirements={fabricRequirements}
          fabricData={fabricData}
          mrpData={mrpData}
        />
      )}
    </div>
  );
}

// ===============================================
// Tab 1: MRP Dashboard
// ===============================================
function DashboardTab({
  mrpData,
  shortages,
  lowItems,
  sufficientItems,
}: {
  mrpData: MRPRun | null;
  shortages: MaterialRequirement[];
  lowItems: MaterialRequirement[];
  sufficientItems: MaterialRequirement[];
}) {
  const kpis = [
    {
      label: "Last Run Date",
      value: mrpData
        ? new Date(mrpData.runDate).toLocaleDateString("en-MY", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Never",
      icon: Clock,
      color: "text-[#6B5C32]",
    },
    {
      label: "Production Orders",
      value: mrpData?.productionOrderCount ?? 0,
      icon: Factory,
      color: "text-[#3E6570]",
    },
    {
      label: "Materials Checked",
      value: mrpData?.totalMaterials ?? 0,
      icon: Package,
      color: "text-[#3E6570]",
    },
    {
      label: "Shortages Found",
      value: mrpData?.shortageCount ?? 0,
      icon: AlertTriangle,
      color: shortages.length > 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]",
    },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280] font-medium uppercase tracking-wide">
                    {kpi.label}
                  </p>
                  <p className="text-xl font-bold text-[#1F1D1B] mt-1">
                    {kpi.value}
                  </p>
                </div>
                <kpi.icon className={`h-8 w-8 ${kpi.color} opacity-70`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Material Status Overview */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Material Status Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-[#EEF3E4] border border-[#C6DBA8]">
              <CheckCircle2 className="h-8 w-8 text-[#4F7C3A]" />
              <div>
                <p className="text-2xl font-bold text-[#4F7C3A]">
                  {sufficientItems.length}
                </p>
                <p className="text-xs text-[#4F7C3A] font-medium">Sufficient</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-[#FAEFCB] border border-[#E8D597]">
              <AlertTriangle className="h-8 w-8 text-[#9C6F1E]" />
              <div>
                <p className="text-2xl font-bold text-[#9C6F1E]">
                  {lowItems.length}
                </p>
                <p className="text-xs text-[#9C6F1E] font-medium">Low Stock</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-[#F9E1DA] border border-[#E8B2A1]">
              <AlertTriangle className="h-8 w-8 text-[#9A3A2D]" />
              <div>
                <p className="text-2xl font-bold text-[#9A3A2D]">
                  {shortages.length}
                </p>
                <p className="text-xs text-[#9A3A2D] font-medium">Shortage</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Shortage Summary */}
      {shortages.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
              Material Shortages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {shortages.map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-lg bg-[#F9E1DA] border border-[#E8B2A1]"
                >
                  <p className="font-semibold text-[#9A3A2D] text-sm">
                    {item.materialName}
                  </p>
                  <p className="text-xs text-[#9A3A2D] mt-0.5">
                    {item.materialCategory}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-[#9A3A2D]">
                      Need: <strong>{item.grossRequired}</strong> {item.unit}
                    </span>
                    <span className="text-[#9A3A2D]">
                      Have: <strong>{item.onHand}</strong> {item.unit}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[#9A3A2D] font-medium">
                    Shortage: {item.netRequired} {item.unit}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Low Stock Warning */}
      {lowItems.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[#9C6F1E]" />
              Low Stock Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {lowItems.map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-lg bg-[#FAEFCB] border border-[#E8D597]"
                >
                  <p className="font-semibold text-[#9C6F1E] text-sm">
                    {item.materialName}
                  </p>
                  <p className="text-xs text-[#9C6F1E] mt-0.5">
                    {item.materialCategory}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-[#9C6F1E]">
                      Need: <strong>{item.grossRequired}</strong> {item.unit}
                    </span>
                    <span className="text-[#9C6F1E]">
                      Have: <strong>{item.onHand}</strong> {item.unit}
                    </span>
                  </div>
                  {item.suggestedPOQty > 0 && (
                    <div className="mt-1 text-xs text-[#9C6F1E] font-medium">
                      Suggested PO: {item.suggestedPOQty} {item.unit}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ===============================================
// Tab 2: Material Requirements Table
// ===============================================
function RequirementsTab({
  requirements,
  statusFilter,
  setStatusFilter,
  sortDesc,
  setSortDesc,
  allRequirements,
}: {
  requirements: MaterialRequirement[];
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  sortDesc: boolean;
  setSortDesc: (d: boolean) => void;
  allRequirements: MaterialRequirement[];
}) {
  const { toast } = useToast();
  const filters: { key: StatusFilter; label: string; count: number }[] = [
    { key: "ALL", label: "All", count: allRequirements.length },
    {
      key: "SHORTAGE",
      label: "Shortage",
      count: allRequirements.filter((r) => r.status === "SHORTAGE").length,
    },
    {
      key: "LOW",
      label: "Low",
      count: allRequirements.filter((r) => r.status === "LOW").length,
    },
    {
      key: "SUFFICIENT",
      label: "Sufficient",
      count: allRequirements.filter((r) => r.status === "SUFFICIENT").length,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[#6B7280]" />
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors cursor-pointer ${
                statusFilter === f.key
                  ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                  : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F0ECE9]"
              }`}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSortDesc(!sortDesc)}
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          Net Req {sortDesc ? "High-Low" : "Low-High"}
        </Button>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                  <th className="text-left p-3 font-medium text-[#6B7280]">Material</th>
                  <th className="text-left p-3 font-medium text-[#6B7280]">Category</th>
                  <th className="text-center p-3 font-medium text-[#6B7280]">Unit</th>
                  <th className="text-right p-3 font-medium text-[#6B7280] bg-[#E0EDF0]/50">This Wk</th>
                  <th className="text-right p-3 font-medium text-[#6B7280] bg-[#E0EDF0]/30">Next Wk</th>
                  <th className="text-right p-3 font-medium text-[#6B7280] bg-[#E0EDF0]/20">2-4 Wk</th>
                  <th className="text-right p-3 font-medium text-[#6B7280] bg-[#E0EDF0]/10">4+ Wk</th>
                  <th className="text-right p-3 font-medium text-[#6B7280]">Total Req</th>
                  <th className="text-right p-3 font-medium text-[#6B7280]">On Hand</th>
                  <th className="text-right p-3 font-medium text-[#6B7280]">Net Req</th>
                  <th className="text-center p-3 font-medium text-[#6B7280]">Status</th>
                  <th className="text-right p-3 font-medium text-[#6B7280]">Sugg. PO</th>
                  <th className="text-left p-3 font-medium text-[#6B7280]">Supplier</th>
                  <th className="text-center p-3 font-medium text-[#6B7280]">Order By</th>
                  <th className="text-center p-3 font-medium text-[#6B7280]">Action</th>
                </tr>
              </thead>
              <tbody>
                {requirements.map((req) => {
                  const buckets = (req as Record<string, unknown>).byBucket as Record<string, number> | undefined;
                  const leadTime = (req as Record<string, unknown>).leadTimeDays as number | undefined;
                  const orderBy = (req as Record<string, unknown>).suggestedOrderDate as string | undefined;
                  const supplierName = (req as Record<string, unknown>).preferredSupplierName as string | undefined;
                  const tw = buckets?.THIS_WEEK || 0;
                  const nw = buckets?.NEXT_WEEK || 0;
                  const w34 = buckets?.WEEK_3_4 || 0;
                  const beyond = buckets?.BEYOND || 0;
                  return (
                  <tr
                    key={req.id}
                    className={`border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/30 transition-colors ${
                      req.status === "SHORTAGE" ? "bg-[#F9E1DA]/30" : ""
                    }`}
                  >
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <div className={`h-2 w-2 rounded-full ${statusDotColor(req.status)}`} />
                        <span className="font-medium text-[#1F1D1B]">{req.materialName}</span>
                      </div>
                    </td>
                    <td className="p-3 text-[#6B7280] text-xs">{req.materialCategory}</td>
                    <td className="p-3 text-center text-[#6B7280]">{req.unit}</td>
                    <td className={`p-3 text-right bg-[#E0EDF0]/50 ${tw > 0 ? "font-bold text-[#9A3A2D]" : "text-[#6B7280]"}`}>{tw || "-"}</td>
                    <td className={`p-3 text-right bg-[#E0EDF0]/30 ${nw > 0 ? "font-medium text-[#9C6F1E]" : "text-[#6B7280]"}`}>{nw || "-"}</td>
                    <td className={`p-3 text-right bg-[#E0EDF0]/20 ${w34 > 0 ? "text-[#1F1D1B]" : "text-[#6B7280]"}`}>{w34 || "-"}</td>
                    <td className="p-3 text-right bg-[#E0EDF0]/10 text-[#6B7280]">{beyond || "-"}</td>
                    <td className="p-3 text-right font-medium">{req.grossRequired}</td>
                    <td className="p-3 text-right">{req.onHand}</td>
                    <td className={`p-3 text-right font-bold ${req.netRequired > 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>{req.netRequired}</td>
                    <td className="p-3 text-center">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${statusBadgeColor(req.status)}`}>{req.status}</span>
                    </td>
                    <td className="p-3 text-right font-medium">{req.suggestedPOQty > 0 ? `${req.suggestedPOQty}` : "-"}</td>
                    <td className="p-3 text-left text-xs text-[#6B7280]">
                      {supplierName || "-"}
                      {leadTime ? <span className="block text-[10px] text-[#9CA3AF]">{leadTime}d lead</span> : null}
                    </td>
                    <td className="p-3 text-center text-xs">
                      {orderBy ? (
                        <span className={`font-medium ${new Date(orderBy) <= new Date() ? "text-[#9A3A2D]" : "text-[#6B7280]"}`}>
                          {new Date(orderBy).toLocaleDateString("en-MY", { day: "2-digit", month: "short" })}
                        </span>
                      ) : "-"}
                    </td>
                    <td className="p-3 text-center">
                      {req.status === "SHORTAGE" && (
                        <Button variant="outline" size="sm" onClick={() => toast.info(`PO suggestion for ${req.materialName} — ${req.suggestedPOQty} ${req.unit}`)}>
                          <ShoppingCart className="h-3.5 w-3.5" />
                          PO
                        </Button>
                      )}
                    </td>
                  </tr>
                  );
                })}
                {requirements.length === 0 && (
                  <tr>
                    <td
                      colSpan={15}
                      className="p-8 text-center text-[#6B7280]"
                    >
                      No material requirements found. Run MRP to generate.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ===============================================
// Tab 3: Fabric Planning (Fab Maint)
// ===============================================
function FabricTab({
  fabricRequirements,
  fabricData,
  mrpData: _mrpData,
}: {
  fabricRequirements: MaterialRequirement[];
  fabricData: FabricDetail[];
  mrpData: MRPRun | null;
}) {
  // If we have detailed fabric data from a POST run, use it
  // Otherwise, build from requirements
  const hasFabricDetail = fabricData.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#6B7280]">
          Fabric-specific planning based on BOM usage from active production
          orders. Replicates the Fab Maint sheet view.
        </p>
      </div>

      {hasFabricDetail ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Fabric Inventory & Usage Planning
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                    <th className="text-left p-3 font-medium text-[#6B7280]">
                      Fabric Code
                    </th>
                    <th className="text-left p-3 font-medium text-[#6B7280]">
                      Description
                    </th>
                    <th className="text-left p-3 font-medium text-[#6B7280]">
                      Category
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      SOH (m)
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      PO Outstanding
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      1 Week Usage
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      2 Week Usage
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      1 Month Usage
                    </th>
                    <th className="text-center p-3 font-medium text-[#6B7280]">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fabricData.map((fab) => (
                    <tr
                      key={fab.id}
                      className={`border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/30 transition-colors ${
                        fab.shortage ? "bg-[#F9E1DA]/40" : ""
                      }`}
                    >
                      <td className="p-3 font-mono font-medium text-[#1F1D1B]">
                        {fab.code}
                      </td>
                      <td className="p-3 text-[#1F1D1B]">{fab.name}</td>
                      <td className="p-3">
                        <Badge>{fab.category.replace("_", " ")}</Badge>
                      </td>
                      <td className="p-3 text-right font-medium">
                        {fab.sohMeters}
                      </td>
                      <td className="p-3 text-right text-[#6B7280]">
                        {fab.poOutstanding}
                      </td>
                      <td className="p-3 text-right">{fab.weeklyUsage}</td>
                      <td className="p-3 text-right">{fab.twoWeekUsage}</td>
                      <td className="p-3 text-right">{fab.monthlyUsage}</td>
                      <td className="p-3 text-center">
                        {fab.shortage ? (
                          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]">
                            SHORTAGE
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]">
                            OK
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* Fallback: show fabric requirements from MRP data */
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Fabric Requirements Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                    <th className="text-left p-3 font-medium text-[#6B7280]">
                      Fabric Material
                    </th>
                    <th className="text-left p-3 font-medium text-[#6B7280]">
                      Category
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      SOH (m)
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      Gross Required
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      Net Required
                    </th>
                    <th className="text-center p-3 font-medium text-[#6B7280]">
                      Status
                    </th>
                    <th className="text-right p-3 font-medium text-[#6B7280]">
                      Sugg. PO Qty
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fabricRequirements.length > 0 ? (
                    fabricRequirements.map((req) => (
                      <tr
                        key={req.id}
                        className={`border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/30 transition-colors ${
                          req.status === "SHORTAGE" ? "bg-[#F9E1DA]/40" : ""
                        }`}
                      >
                        <td className="p-3 font-medium text-[#1F1D1B]">
                          {req.materialName}
                        </td>
                        <td className="p-3">
                          <Badge>
                            {req.materialCategory.replace("_", " ")}
                          </Badge>
                        </td>
                        <td className="p-3 text-right">{req.onHand}</td>
                        <td className="p-3 text-right font-medium">
                          {req.grossRequired}
                        </td>
                        <td
                          className={`p-3 text-right font-bold ${
                            req.netRequired > 0
                              ? "text-[#9A3A2D]"
                              : "text-[#4F7C3A]"
                          }`}
                        >
                          {req.netRequired}
                        </td>
                        <td className="p-3 text-center">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${statusBadgeColor(
                              req.status
                            )}`}
                          >
                            {req.status}
                          </span>
                        </td>
                        <td className="p-3 text-right font-medium">
                          {req.suggestedPOQty > 0
                            ? `${req.suggestedPOQty} ${req.unit}`
                            : "-"}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={7}
                        className="p-8 text-center text-[#6B7280]"
                      >
                        No fabric data available. Click &quot;Run MRP&quot; to
                        generate detailed fabric planning data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
