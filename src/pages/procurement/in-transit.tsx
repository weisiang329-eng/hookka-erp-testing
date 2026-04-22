import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import type { GoodsInTransit, TransitStatus } from "@/lib/mock-data";
import {
  Ship,
  Plane,
  Truck,
  Package,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Search,
  Clock,
  ShieldCheck,
  DollarSign,
  Box,
  Anchor,
} from "lucide-react";

// --- Status colors per spec ---
const STATUS_COLORS: Record<TransitStatus, string> = {
  ORDERED: "#6366F1",
  SHIPPED: "#3B82F6",
  IN_TRANSIT: "#F59E0B",
  CUSTOMS: "#F97316",
  RECEIVED: "#10B981",
};

const STATUS_SEQUENCE: TransitStatus[] = ["ORDERED", "SHIPPED", "IN_TRANSIT", "CUSTOMS", "RECEIVED"];

const SHIPPING_ICONS: Record<string, typeof Ship> = {
  SEA: Ship,
  AIR: Plane,
  LAND: Truck,
  COURIER: Package,
};

function daysInTransit(item: GoodsInTransit): number {
  const today = new Date();
  const start = item.shippedDate ? new Date(item.shippedDate) : new Date(item.orderDate);
  const end = item.actualArrival ? new Date(item.actualArrival) : today;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

function isOverdue(item: GoodsInTransit): boolean {
  if (item.status === "RECEIVED") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expected = new Date(item.expectedArrival);
  expected.setHours(0, 0, 0, 0);
  return expected < today;
}

// --- Status Badge ---
function TransitBadge({ status }: { status: TransitStatus }) {
  const color = STATUS_COLORS[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border"
      style={{
        backgroundColor: `${color}15`,
        color: color,
        borderColor: `${color}40`,
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// --- Progress Indicator ---
function StatusProgress({ status }: { status: TransitStatus }) {
  const currentIdx = STATUS_SEQUENCE.indexOf(status);
  return (
    <div className="flex items-center gap-1">
      {STATUS_SEQUENCE.map((s, i) => {
        const isActive = i <= currentIdx;
        const color = STATUS_COLORS[s];
        return (
          <div key={s} className="flex items-center">
            <div
              className="h-2.5 w-2.5 rounded-full transition-all"
              style={{
                backgroundColor: isActive ? color : "#E2DDD8",
              }}
              title={s.replace(/_/g, " ")}
            />
            {i < STATUS_SEQUENCE.length - 1 && (
              <div
                className="h-0.5 w-4"
                style={{
                  backgroundColor: i < currentIdx ? STATUS_COLORS[STATUS_SEQUENCE[i + 1]] : "#E2DDD8",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Shipping Method Icon ---
function MethodIcon({ method }: { method: string }) {
  const Icon = SHIPPING_ICONS[method] || Package;
  return <Icon className="h-4 w-4 text-[#6B5C32]" />;
}

// ============================
// MAIN PAGE COMPONENT
// ============================
export default function GoodsInTransitPage() {
  const [data, setData] = useState<GoodsInTransit[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"dashboard" | "detail" | "landed">("dashboard");
  const [statusFilter, setStatusFilter] = useState<TransitStatus | "ALL">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedLandedId, setSelectedLandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/goods-in-transit");
      if (!res.ok) return;
      const json = await res.json();
      setData(json.data ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // --- Filtered data ---
  const filtered = useMemo(() => {
    let result = data;
    if (statusFilter !== "ALL") {
      result = result.filter((g) => g.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (g) =>
          g.poNumber.toLowerCase().includes(q) ||
          g.supplierName.toLowerCase().includes(q) ||
          g.carrierName.toLowerCase().includes(q) ||
          (g.containerNumber && g.containerNumber.toLowerCase().includes(q)) ||
          (g.trackingNumber && g.trackingNumber.toLowerCase().includes(q))
      );
    }
    return result;
  }, [data, statusFilter, searchQuery]);

  // --- Computed stats ---
  const totalInTransit = data.filter((g) => g.status !== "RECEIVED").length;
  const overdueItems = data.filter(isOverdue);
  const inCustoms = data.filter((g) => g.status === "CUSTOMS").length;
  const totalTransitValue = data
    .filter((g) => g.status !== "RECEIVED")
    .reduce((sum, g) => sum + g.landedCost, 0);

  const statusCounts = useMemo(() => {
    const counts: Record<TransitStatus, number> = { ORDERED: 0, SHIPPED: 0, IN_TRANSIT: 0, CUSTOMS: 0, RECEIVED: 0 };
    data.forEach((g) => { counts[g.status]++; });
    return counts;
  }, [data]);

  // --- Selected item for landed cost ---
  const selectedLanded = useMemo(
    () => data.find((g) => g.id === selectedLandedId) ?? null,
    [data, selectedLandedId]
  );

  // --- Tab buttons ---
  const tabs = [
    { key: "dashboard" as const, label: "Dashboard", icon: Box },
    { key: "detail" as const, label: "Transit Detail", icon: Search },
    { key: "landed" as const, label: "Landed Cost", icon: DollarSign },
  ];

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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1D1B]">Goods in Transit</h1>
          <p className="text-sm text-[#6B7280] mt-1">
            Track goods ordered from suppliers -- sea, air, land and courier shipments
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ==================== DASHBOARD TAB ==================== */}
      {activeTab === "dashboard" && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-[#6B7280]">Total In Transit</p>
                    <p className="text-2xl font-bold text-[#1F1D1B]">{totalInTransit}</p>
                  </div>
                  <div className="h-10 w-10 rounded-full bg-blue-50 flex items-center justify-center">
                    <Truck className="h-5 w-5 text-blue-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-[#6B7280]">Overdue Shipments</p>
                    <p className="text-2xl font-bold text-red-600">{overdueItems.length}</p>
                  </div>
                  <div className="h-10 w-10 rounded-full bg-red-50 flex items-center justify-center">
                    <AlertTriangle className="h-5 w-5 text-red-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-[#6B7280]">In Customs</p>
                    <p className="text-2xl font-bold text-orange-600">{inCustoms}</p>
                  </div>
                  <div className="h-10 w-10 rounded-full bg-orange-50 flex items-center justify-center">
                    <ShieldCheck className="h-5 w-5 text-orange-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-[#6B7280]">Total Transit Value</p>
                    <p className="text-2xl font-bold text-[#6B5C32]">{formatCurrency(totalTransitValue)}</p>
                  </div>
                  <div className="h-10 w-10 rounded-full bg-[#F0ECE9] flex items-center justify-center">
                    <DollarSign className="h-5 w-5 text-[#6B5C32]" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Status Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>Status Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {STATUS_SEQUENCE.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(statusFilter === s ? "ALL" : s)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 border transition-all cursor-pointer ${
                      statusFilter === s
                        ? "border-[#6B5C32] bg-[#F0ECE9]"
                        : "border-[#E2DDD8] hover:border-[#6B5C32]/30"
                    }`}
                  >
                    <div
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: STATUS_COLORS[s] }}
                    />
                    <span className="text-sm font-medium text-[#1F1D1B]">{s.replace(/_/g, " ")}</span>
                    <span className="text-sm text-[#6B7280]">({statusCounts[s]})</span>
                  </button>
                ))}
                {statusFilter !== "ALL" && (
                  <Button variant="ghost" size="sm" onClick={() => setStatusFilter("ALL")}>
                    Clear filter
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
            <Input
              placeholder="Search PO#, supplier, carrier, tracking..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Main Table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                      <th className="text-left px-4 py-3 font-medium text-[#6B7280]">PO #</th>
                      <th className="text-left px-4 py-3 font-medium text-[#6B7280]">Supplier</th>
                      <th className="text-center px-4 py-3 font-medium text-[#6B7280]">Method</th>
                      <th className="text-left px-4 py-3 font-medium text-[#6B7280]">Status</th>
                      <th className="text-left px-4 py-3 font-medium text-[#6B7280]">Progress</th>
                      <th className="text-left px-4 py-3 font-medium text-[#6B7280]">Expected</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Days</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={8} className="text-center py-8 text-[#6B7280]">
                          No transit entries found.
                        </td>
                      </tr>
                    )}
                    {filtered.map((item) => {
                      const overdue = isOverdue(item);
                      return (
                        <tr
                          key={item.id}
                          className={`border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/30 transition-colors ${
                            overdue ? "bg-red-50/50" : ""
                          }`}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[#1F1D1B]">{item.poNumber}</span>
                              {overdue && (
                                <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                              )}
                            </div>
                            {item.currency === "RMB" && (
                              <span className="text-[10px] text-orange-600 font-medium">RMB</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-[#1F1D1B]">{item.supplierName}</td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-1" title={item.shippingMethod}>
                              <MethodIcon method={item.shippingMethod} />
                              <span className="text-xs text-[#6B7280]">{item.shippingMethod}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <TransitBadge status={item.status} />
                          </td>
                          <td className="px-4 py-3">
                            <StatusProgress status={item.status} />
                          </td>
                          <td className="px-4 py-3">
                            <span className={overdue ? "text-red-600 font-medium" : "text-[#1F1D1B]"}>
                              {item.expectedArrival}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={`font-medium ${overdue ? "text-red-600" : "text-[#1F1D1B]"}`}>
                              {daysInTransit(item)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-[#1F1D1B]">
                            {formatCurrency(item.landedCost)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ==================== TRANSIT DETAIL TAB ==================== */}
      {activeTab === "detail" && (
        <div className="space-y-4">
          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
            <Input
              placeholder="Search PO#, supplier, tracking..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {filtered.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-[#6B7280]">
                No transit entries found.
              </CardContent>
            </Card>
          )}

          {filtered.map((item) => {
            const isExpanded = expandedId === item.id;
            const overdue = isOverdue(item);
            const days = daysInTransit(item);
            return (
              <Card key={item.id} className={overdue ? "border-red-300 bg-red-50/30" : ""}>
                {/* Collapsed Header */}
                <button
                  className="w-full text-left cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <MethodIcon method={item.shippingMethod} />
                        <div>
                          <CardTitle className="text-base">
                            {item.poNumber}
                            {overdue && (
                              <span className="ml-2 text-xs text-red-600 font-normal">OVERDUE</span>
                            )}
                          </CardTitle>
                          <p className="text-sm text-[#6B7280]">{item.supplierName}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <TransitBadge status={item.status} />
                        <StatusProgress status={item.status} />
                        <span className="text-sm font-medium text-[#1F1D1B]">
                          {formatCurrency(item.landedCost)}
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-[#6B7280]" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-[#6B7280]" />
                        )}
                      </div>
                    </div>
                  </CardHeader>
                </button>

                {/* Expanded Detail */}
                {isExpanded && (
                  <CardContent className="border-t border-[#E2DDD8] pt-4 space-y-6">
                    {/* Shipping Info */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Shipping</h4>
                        <div className="space-y-1 text-sm">
                          <p><span className="text-[#6B7280]">Method:</span> <span className="font-medium">{item.shippingMethod}</span></p>
                          <p><span className="text-[#6B7280]">Carrier:</span> <span className="font-medium">{item.carrierName}</span></p>
                          {item.containerNumber && (
                            <p><span className="text-[#6B7280]">Container:</span> <span className="font-mono text-xs bg-[#F0ECE9] px-1.5 py-0.5 rounded">{item.containerNumber}</span></p>
                          )}
                          {item.trackingNumber && (
                            <p><span className="text-[#6B7280]">Tracking:</span> <span className="font-mono text-xs bg-[#F0ECE9] px-1.5 py-0.5 rounded">{item.trackingNumber}</span></p>
                          )}
                        </div>
                      </div>

                      {/* Timeline */}
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Timeline</h4>
                        <div className="space-y-2 text-sm">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLORS.ORDERED }} />
                            <span className="text-[#6B7280]">Ordered:</span>
                            <span className="font-medium">{item.orderDate}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: item.shippedDate ? STATUS_COLORS.SHIPPED : "#E2DDD8" }} />
                            <span className="text-[#6B7280]">Shipped:</span>
                            <span className="font-medium">{item.shippedDate ?? "Pending"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: overdue ? "#EF4444" : "#E2DDD8" }} />
                            <span className="text-[#6B7280]">Expected:</span>
                            <span className={`font-medium ${overdue ? "text-red-600" : ""}`}>{item.expectedArrival}</span>
                          </div>
                          {item.actualArrival && (
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLORS.RECEIVED }} />
                              <span className="text-[#6B7280]">Received:</span>
                              <span className="font-medium">{item.actualArrival}</span>
                            </div>
                          )}
                          {item.customsClearanceDate && (
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLORS.CUSTOMS }} />
                              <span className="text-[#6B7280]">Customs Cleared:</span>
                              <span className="font-medium">{item.customsClearanceDate}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-1 pt-1 border-t border-[#E2DDD8]">
                            <Clock className="h-3.5 w-3.5 text-[#6B7280]" />
                            <span className="text-[#6B7280]">Days in transit:</span>
                            <span className={`font-bold ${overdue ? "text-red-600" : "text-[#1F1D1B]"}`}>{days}</span>
                          </div>
                        </div>
                      </div>

                      {/* Customs */}
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Customs</h4>
                        <div className="space-y-1 text-sm">
                          <p>
                            <span className="text-[#6B7280]">Status:</span>{" "}
                            <Badge variant="status" status={item.customsStatus === "HELD" ? "ON_HOLD" : item.customsStatus === "CLEARED" ? "COMPLETED" : item.customsStatus === "PENDING" ? "PENDING" : "DRAFT"}>
                              {item.customsStatus}
                            </Badge>
                          </p>
                          <p><span className="text-[#6B7280]">Currency:</span> <span className="font-medium">{item.currency}</span></p>
                          {item.exchangeRate && (
                            <p><span className="text-[#6B7280]">Exchange Rate:</span> <span className="font-medium">1 RMB = {item.exchangeRate} MYR</span></p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Cost Breakdown */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Cost Breakdown</h4>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="bg-[#F0ECE9] rounded-lg p-3 text-center">
                          <p className="text-xs text-[#6B7280]">Product Cost</p>
                          <p className="text-sm font-bold text-[#1F1D1B]">{formatCurrency(item.productCost)}</p>
                        </div>
                        <div className="bg-blue-50 rounded-lg p-3 text-center">
                          <p className="text-xs text-[#6B7280]">Shipping</p>
                          <p className="text-sm font-bold text-blue-700">{formatCurrency(item.shippingCost)}</p>
                        </div>
                        <div className="bg-orange-50 rounded-lg p-3 text-center">
                          <p className="text-xs text-[#6B7280]">Customs Duty</p>
                          <p className="text-sm font-bold text-orange-700">{formatCurrency(item.customsDuty)}</p>
                        </div>
                        {item.exchangeRate && (
                          <div className="bg-purple-50 rounded-lg p-3 text-center">
                            <p className="text-xs text-[#6B7280]">FX Rate</p>
                            <p className="text-sm font-bold text-purple-700">{item.exchangeRate}</p>
                          </div>
                        )}
                        <div className="bg-green-50 rounded-lg p-3 text-center">
                          <p className="text-xs text-[#6B7280]">Landed Cost</p>
                          <p className="text-sm font-bold text-green-700">{formatCurrency(item.landedCost)}</p>
                        </div>
                      </div>
                    </div>

                    {/* Items Table */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Items ({item.items.length})</h4>
                      <div className="overflow-x-auto rounded-lg border border-[#E2DDD8]">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-[#F0ECE9]/50 border-b border-[#E2DDD8]">
                              <th className="text-left px-3 py-2 font-medium text-[#6B7280]">Code</th>
                              <th className="text-left px-3 py-2 font-medium text-[#6B7280]">Material</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">Qty</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">Unit Cost</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {item.items.map((mat, idx) => (
                              <tr key={idx} className="border-b border-[#E2DDD8] last:border-0">
                                <td className="px-3 py-2 font-mono text-xs">{mat.materialCode}</td>
                                <td className="px-3 py-2">{mat.materialName}</td>
                                <td className="px-3 py-2 text-right">{mat.quantity}</td>
                                <td className="px-3 py-2 text-right">{formatCurrency(mat.unitCost)}</td>
                                <td className="px-3 py-2 text-right font-medium">{formatCurrency(mat.unitCost * mat.quantity)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Notes */}
                    {item.notes && (
                      <div className="bg-[#F0ECE9] rounded-lg p-3">
                        <p className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider mb-1">Notes</p>
                        <p className="text-sm text-[#1F1D1B]">{item.notes}</p>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ==================== LANDED COST TAB ==================== */}
      {activeTab === "landed" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Selector */}
            <div className="lg:col-span-1 space-y-3">
              <h3 className="text-sm font-semibold text-[#6B7280] uppercase tracking-wider">Select Shipment</h3>
              <div className="space-y-2 max-h-[600px] overflow-y-auto">
                {data.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedLandedId(item.id)}
                    className={`w-full text-left rounded-lg border p-3 transition-all cursor-pointer ${
                      selectedLandedId === item.id
                        ? "border-[#6B5C32] bg-[#F0ECE9]"
                        : "border-[#E2DDD8] hover:border-[#6B5C32]/30"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <MethodIcon method={item.shippingMethod} />
                        <div>
                          <p className="text-sm font-medium text-[#1F1D1B]">{item.poNumber}</p>
                          <p className="text-xs text-[#6B7280]">{item.supplierName}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <TransitBadge status={item.status} />
                        <p className="text-xs text-[#6B7280] mt-1">{item.currency}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Calculator */}
            <div className="lg:col-span-2">
              {!selectedLanded ? (
                <Card>
                  <CardContent className="py-16 text-center">
                    <Anchor className="h-12 w-12 text-[#E2DDD8] mx-auto mb-4" />
                    <p className="text-[#6B7280]">Select a shipment to view landed cost breakdown</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4">
                  {/* Header */}
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle>{selectedLanded.poNumber} - Landed Cost</CardTitle>
                          <p className="text-sm text-[#6B7280] mt-1">{selectedLanded.supplierName}</p>
                        </div>
                        <TransitBadge status={selectedLanded.status} />
                      </div>
                    </CardHeader>
                    <CardContent>
                      {/* Cost Waterfall */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8]">
                          <span className="text-sm text-[#6B7280]">Product Cost</span>
                          <span className="text-sm font-medium text-[#1F1D1B]">
                            {selectedLanded.currency === "RMB" ? `RMB ${(selectedLanded.productCost / 100).toFixed(2)}` : formatCurrency(selectedLanded.productCost)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8]">
                          <span className="text-sm text-[#6B7280]">+ Shipping Cost</span>
                          <span className="text-sm font-medium text-blue-700">
                            {selectedLanded.currency === "RMB" ? `RMB ${(selectedLanded.shippingCost / 100).toFixed(2)}` : formatCurrency(selectedLanded.shippingCost)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8]">
                          <span className="text-sm text-[#6B7280]">+ Customs Duty</span>
                          <span className="text-sm font-medium text-orange-700">
                            {selectedLanded.currency === "RMB" ? `RMB ${(selectedLanded.customsDuty / 100).toFixed(2)}` : formatCurrency(selectedLanded.customsDuty)}
                          </span>
                        </div>
                        {selectedLanded.exchangeRate && (
                          <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8] bg-purple-50/50 px-2 rounded">
                            <span className="text-sm text-purple-700">Exchange Rate (RMB to MYR)</span>
                            <span className="text-sm font-bold text-purple-700">{selectedLanded.exchangeRate}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between py-3 bg-green-50 px-3 rounded-lg">
                          <span className="text-sm font-semibold text-green-800">Total Landed Cost (MYR)</span>
                          <span className="text-lg font-bold text-green-800">{formatCurrency(selectedLanded.landedCost)}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Per-unit Landed Cost */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Per-Unit Landed Cost</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto rounded-lg border border-[#E2DDD8]">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-[#F0ECE9]/50 border-b border-[#E2DDD8]">
                              <th className="text-left px-3 py-2 font-medium text-[#6B7280]">Material</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">Qty</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">Unit Cost</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">+ Overhead/unit</th>
                              <th className="text-right px-3 py-2 font-medium text-[#6B7280]">Landed/unit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              const totalQty = selectedLanded.items.reduce((s, i) => s + i.quantity, 0);
                              const overhead = selectedLanded.shippingCost + selectedLanded.customsDuty;
                              const overheadPerUnit = totalQty > 0 ? Math.round(overhead / totalQty) : 0;
                              return selectedLanded.items.map((mat, idx) => {
                                let unitCostMYR = mat.unitCost;
                                if (selectedLanded.exchangeRate) {
                                  unitCostMYR = Math.round(mat.unitCost * selectedLanded.exchangeRate);
                                }
                                const landedPerUnit = unitCostMYR + overheadPerUnit;
                                return (
                                  <tr key={idx} className="border-b border-[#E2DDD8] last:border-0">
                                    <td className="px-3 py-2">
                                      <p className="font-medium">{mat.materialName}</p>
                                      <p className="text-xs text-[#6B7280] font-mono">{mat.materialCode}</p>
                                    </td>
                                    <td className="px-3 py-2 text-right">{mat.quantity}</td>
                                    <td className="px-3 py-2 text-right">{formatCurrency(unitCostMYR)}</td>
                                    <td className="px-3 py-2 text-right text-blue-700">{formatCurrency(overheadPerUnit)}</td>
                                    <td className="px-3 py-2 text-right font-bold text-green-700">{formatCurrency(landedPerUnit)}</td>
                                  </tr>
                                );
                              });
                            })()}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          </div>

          {/* Recent Landed Costs by Supplier */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Landed Costs by Supplier</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                      <th className="text-left px-4 py-3 font-medium text-[#6B7280]">Supplier</th>
                      <th className="text-center px-4 py-3 font-medium text-[#6B7280]">Shipments</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Total Product Cost</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Total Shipping</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Total Duty</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Total Landed</th>
                      <th className="text-right px-4 py-3 font-medium text-[#6B7280]">Overhead %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const bySupplier = new Map<string, { name: string; count: number; product: number; shipping: number; duty: number; landed: number }>();
                      data.forEach((g) => {
                        const existing = bySupplier.get(g.supplierId);
                        if (existing) {
                          existing.count++;
                          existing.product += g.productCost;
                          existing.shipping += g.shippingCost;
                          existing.duty += g.customsDuty;
                          existing.landed += g.landedCost;
                        } else {
                          bySupplier.set(g.supplierId, {
                            name: g.supplierName,
                            count: 1,
                            product: g.productCost,
                            shipping: g.shippingCost,
                            duty: g.customsDuty,
                            landed: g.landedCost,
                          });
                        }
                      });
                      return Array.from(bySupplier.entries()).map(([id, s]) => {
                        const overheadPct = s.product > 0 ? (((s.shipping + s.duty) / s.product) * 100).toFixed(1) : "0.0";
                        return (
                          <tr key={id} className="border-b border-[#E2DDD8]">
                            <td className="px-4 py-3 font-medium text-[#1F1D1B]">{s.name}</td>
                            <td className="px-4 py-3 text-center">{s.count}</td>
                            <td className="px-4 py-3 text-right">{formatCurrency(s.product)}</td>
                            <td className="px-4 py-3 text-right text-blue-700">{formatCurrency(s.shipping)}</td>
                            <td className="px-4 py-3 text-right text-orange-700">{formatCurrency(s.duty)}</td>
                            <td className="px-4 py-3 text-right font-bold text-green-700">{formatCurrency(s.landed)}</td>
                            <td className="px-4 py-3 text-right text-[#6B7280]">{overheadPct}%</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
