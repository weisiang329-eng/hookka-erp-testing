import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, Search, ChevronUp, ChevronDown, Factory, BarChart3 } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";

type JobCard = {
  id: string; departmentId: string; departmentCode: string; departmentName: string; sequence: number;
  status: "WAITING"|"IN_PROGRESS"|"PAUSED"|"COMPLETED"|"TRANSFERRED"|"BLOCKED";
  dueDate: string; prerequisiteMet: boolean;
  pic1Id: string|null; pic1Name: string; pic2Id: string|null; pic2Name: string;
  completedDate: string|null; estMinutes: number; actualMinutes: number|null;
  category: string; productionTimeMinutes: number; overdue: string;
};

type ProductionOrder = {
  id: string; poNo: string;
  salesOrderId: string; salesOrderNo: string; lineNo: number;
  customerPOId: string; customerReference: string; customerName: string; customerState: string;
  companySOId: string;
  productId: string; productCode: string; productName: string; itemCategory: "SOFA"|"BEDFRAME"|"ACCESSORY";
  sizeCode: string; sizeLabel: string; fabricCode: string; quantity: number;
  gapInches: number|null; divanHeightInches: number|null; legHeightInches: number|null;
  specialOrder: string; notes: string;
  status: "PENDING"|"IN_PROGRESS"|"COMPLETED"|"ON_HOLD"|"CANCELLED"|"PAUSED";
  currentDepartment: string; progress: number;
  jobCards: JobCard[];
  startDate: string; targetEndDate: string; completedDate: string|null;
  rackingNumber: string; stockedIn: boolean;
};

const DEPARTMENTS = [
  { name: "Fab Cut", code: "FAB_CUT", color: "#3B82F6" },
  { name: "Fab Sew", code: "FAB_SEW", color: "#6366F1" },
  { name: "Wood Cut", code: "WOOD_CUT", color: "#F59E0B" },
  { name: "Foam", code: "FOAM", color: "#8B5CF6" },
  { name: "Framing", code: "FRAMING", color: "#F97316" },
  { name: "Webbing", code: "WEBBING", color: "#10B981" },
  { name: "Upholstery", code: "UPHOLSTERY", color: "#F43F5E" },
  { name: "Packing", code: "PACKING", color: "#06B6D4" },
];

type SortField = "poNo" | "customerName" | "productCode" | "targetEndDate" | "progress" | "status";
type SortDir = "asc" | "desc";

// Hoisted so react-hooks/static-components is happy. State lives in the
// parent and flows in via props.
function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronUp className="h-3 w-3 text-[#D1CBC5]" />;
  return dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-[#6B5C32]" />
  ) : (
    <ChevronDown className="h-3 w-3 text-[#6B5C32]" />
  );
}

function getOverdueDisplay(order: ProductionOrder): { label: string; icon: string; className: string } {
  if (order.status === "COMPLETED") {
    return { label: "COMPLETED", icon: "\u2705", className: "text-[#4F7C3A] bg-[#EEF3E4]" };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(order.targetEndDate);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return { label: `${Math.abs(diffDays)}d overdue`, icon: "\u274C", className: "text-[#9A3A2D] bg-[#F9E1DA]" };
  }
  return { label: `${diffDays}d left`, icon: "\u23F3", className: "text-[#9C6F1E] bg-[#FAEFCB]" };
}

function getDeptEfficiency(orders: ProductionOrder[]) {
  return DEPARTMENTS.map((dept) => {
    let active = 0;
    let completed = 0;
    let totalEstHours = 0;
    let totalActualHours = 0;

    for (const order of orders) {
      const jc = order.jobCards.find((j) => j.departmentCode === dept.code);
      if (!jc) continue;
      if (jc.status === "IN_PROGRESS" || jc.status === "PAUSED") active++;
      if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") {
        completed++;
        totalEstHours += jc.estMinutes / 60;
        totalActualHours += (jc.actualMinutes || jc.estMinutes) / 60;
      }
    }

    const efficiency = totalActualHours > 0 ? Math.round((totalEstHours / totalActualHours) * 100) : 0;
    let statusLabel: string;
    let statusColor: string;
    if (efficiency >= 95) { statusLabel = "Excellent"; statusColor = "text-[#4F7C3A] bg-[#EEF3E4]"; }
    else if (efficiency >= 80) { statusLabel = "Good"; statusColor = "text-[#3E6570] bg-[#E0EDF0]"; }
    else if (efficiency >= 60) { statusLabel = "Fair"; statusColor = "text-[#9C6F1E] bg-[#FAEFCB]"; }
    else if (efficiency > 0) { statusLabel = "Needs Improvement"; statusColor = "text-[#9A3A2D] bg-[#F9E1DA]"; }
    else { statusLabel = "No Data"; statusColor = "text-gray-500 bg-gray-50"; }

    return { ...dept, active, completed, totalEstHours, totalActualHours, efficiency, statusLabel, statusColor };
  });
}

export default function MasterTrackerPage() {
  const navigate = useNavigate();
  const { data: ordersResp, loading } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>("/api/production-orders");
  const orders: ProductionOrder[] = useMemo(
    () => (ordersResp?.success ? ordersResp.data ?? [] : Array.isArray(ordersResp) ? ordersResp : []),
    [ordersResp]
  );

  // Filters
  const [categoryTab, setCategoryTab] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Sorting
  const [sortField, setSortField] = useState<SortField>("poNo");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filteredOrders = useMemo(() => {
    let result = [...orders];

    // Category tab filter
    if (categoryTab !== "ALL") {
      result = result.filter((o) => o.itemCategory === categoryTab);
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (o) =>
          o.poNo.toLowerCase().includes(q) ||
          o.salesOrderNo.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.productCode.toLowerCase().includes(q) ||
          o.customerPOId.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (statusFilter !== "ALL") {
      result = result.filter((o) => o.status === statusFilter);
    }

    // Date range filter
    if (dateFrom) {
      result = result.filter((o) => o.targetEndDate >= dateFrom);
    }
    if (dateTo) {
      result = result.filter((o) => o.targetEndDate <= dateTo);
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "poNo": cmp = a.poNo.localeCompare(b.poNo); break;
        case "customerName": cmp = a.customerName.localeCompare(b.customerName); break;
        case "productCode": cmp = a.productCode.localeCompare(b.productCode); break;
        case "targetEndDate": cmp = a.targetEndDate.localeCompare(b.targetEndDate); break;
        case "progress": cmp = a.progress - b.progress; break;
        case "status": cmp = a.status.localeCompare(b.status); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [orders, categoryTab, searchQuery, statusFilter, dateFrom, dateTo, sortField, sortDir]);

  const deptEfficiency = useMemo(() => getDeptEfficiency(orders), [orders]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#6B5C32] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/production")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold text-[#1F1D1B]">Master Tracker</h1>
            <p className="text-xs text-[#6B7280]">
              All production orders with department completion dates - BF & SF Master Tracker
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/production")}>
            Production Overview
          </Button>
        </div>
      </div>

      {/* Department Efficiency Overview */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
            All Departments Efficiency Overview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-9 px-3 text-left font-medium text-[#374151]">Department</th>
                  <th className="h-9 px-3 text-right font-medium text-[#374151]">Active</th>
                  <th className="h-9 px-3 text-right font-medium text-[#374151]">Completed</th>
                  <th className="h-9 px-3 text-right font-medium text-[#374151]">Est Hours</th>
                  <th className="h-9 px-3 text-right font-medium text-[#374151]">Actual Hours</th>
                  <th className="h-9 px-3 text-right font-medium text-[#374151]">Efficiency %</th>
                  <th className="h-9 px-3 text-left font-medium text-[#374151]">Status</th>
                </tr>
              </thead>
              <tbody>
                {deptEfficiency.map((dept) => (
                  <tr key={dept.code} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dept.color }} />
                        <span className="font-medium text-[#1F1D1B]">{dept.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-[#3E6570]">{dept.active}</td>
                    <td className="px-3 py-2 text-right font-medium text-[#4F7C3A]">{dept.completed}</td>
                    <td className="px-3 py-2 text-right text-[#4B5563]">{dept.totalEstHours.toFixed(1)}h</td>
                    <td className="px-3 py-2 text-right text-[#4B5563]">{dept.totalActualHours.toFixed(1)}h</td>
                    <td className="px-3 py-2 text-right font-bold">{dept.efficiency > 0 ? `${dept.efficiency}%` : "-"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${dept.statusColor}`}>
                        {dept.statusLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Category Tabs */}
            <div className="flex rounded-lg border border-[#E2DDD8] overflow-hidden">
              {(["ALL", "BEDFRAME", "SOFA"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setCategoryTab(tab)}
                  className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                    categoryTab === tab
                      ? "bg-[#6B5C32] text-white"
                      : "bg-white text-[#4B5563] hover:bg-[#F0ECE9]"
                  }`}
                >
                  {tab === "ALL" ? "All" : tab === "BEDFRAME" ? "Bedframe" : "Sofa"}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-[320px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
              <Input
                placeholder="Search PO, SO, customer, product..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
            </div>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-[#4B5563] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
            >
              <option value="ALL">All Status</option>
              <option value="PENDING">Pending</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="COMPLETED">Completed</option>
              <option value="ON_HOLD">On Hold</option>
              <option value="CANCELLED">Cancelled</option>
            </select>

            {/* Date Range */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#6B7280]">From</span>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 w-36 text-sm"
              />
              <span className="text-xs text-[#6B7280]">To</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 w-36 text-sm"
              />
            </div>

            <span className="text-xs text-[#9CA3AF]">
              {filteredOrders.length} of {orders.length} orders
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Master Tracker Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Factory className="h-5 w-5 text-[#6B5C32]" />
            {categoryTab === "BEDFRAME" ? "BF" : categoryTab === "SOFA" ? "SF" : "BF & SF"} Master Tracker ({filteredOrders.length} items)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-9 px-2 text-left font-medium text-[#374151] sticky left-0 bg-[#F0ECE9] z-10 cursor-pointer" onClick={() => toggleSort("poNo")}>
                    <div className="flex items-center gap-1">SO ID <SortIcon active={sortField === "poNo"} dir={sortDir} /></div>
                  </th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Sales Order</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Cust PO ID</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleSort("customerName")}>
                    <div className="flex items-center gap-1">Customer <SortIcon active={sortField === "customerName"} dir={sortDir} /></div>
                  </th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">State</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleSort("productCode")}>
                    <div className="flex items-center gap-1">Product <SortIcon active={sortField === "productCode"} dir={sortDir} /></div>
                  </th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Category</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Size</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Fabric</th>
                  <th className="h-9 px-2 text-right font-medium text-[#374151]">Gap</th>
                  <th className="h-9 px-2 text-right font-medium text-[#374151]">Divan</th>
                  <th className="h-9 px-2 text-right font-medium text-[#374151]">Leg</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Special</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Notes</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleSort("targetEndDate")}>
                    <div className="flex items-center gap-1">Target End <SortIcon active={sortField === "targetEndDate"} dir={sortDir} /></div>
                  </th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Hookka DD</th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Overdue</th>
                  {/* Department Completion Date columns */}
                  {DEPARTMENTS.map((dept) => (
                    <th
                      key={dept.code}
                      className="h-9 px-2 text-center font-medium text-white"
                      style={{ backgroundColor: dept.color }}
                    >
                      {dept.name} CD
                    </th>
                  ))}
                  <th className="h-9 px-2 text-left font-medium text-[#374151]">Stocked In</th>
                  <th className="h-9 px-2 text-right font-medium text-[#374151] cursor-pointer" onClick={() => toggleSort("progress")}>
                    <div className="flex items-center gap-1 justify-end">Progress <SortIcon active={sortField === "progress"} dir={sortDir} /></div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={27} className="py-12 text-center text-[#9CA3AF] text-sm">
                      No production orders match the current filters.
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((order) => {
                    const overdue = getOverdueDisplay(order);
                    return (
                      <tr
                        key={order.id}
                        className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                        onClick={() => navigate(`/production/${order.id}`)}
                      >
                        <td className="px-2 py-1.5 font-medium doc-number sticky left-0 bg-white z-10">
                          {order.poNo}
                        </td>
                        <td className="px-2 py-1.5 doc-number text-[#4B5563]">{order.salesOrderNo}</td>
                        <td className="px-2 py-1.5 doc-number text-[#4B5563]">{order.customerPOId}</td>
                        <td className="px-2 py-1.5 font-medium text-[#1F1D1B] max-w-[120px] truncate">{order.customerName}</td>
                        <td className="px-2 py-1.5 text-[#4B5563]">{order.customerState}</td>
                        <td className="px-2 py-1.5 doc-number">{order.productCode}</td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            order.itemCategory === "BEDFRAME" ? "bg-[#E0EDF0] text-[#3E6570]" :
                            order.itemCategory === "SOFA" ? "bg-[#F9E1DA] text-[#9A3A2D]" :
                            "bg-gray-50 text-gray-600"
                          }`}>
                            {order.itemCategory}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-[#4B5563]">{order.sizeLabel}</td>
                        <td className="px-2 py-1.5 doc-number text-[#4B5563]">{order.fabricCode}</td>
                        <td className="px-2 py-1.5 text-right text-[#4B5563]">{order.gapInches ?? "-"}</td>
                        <td className="px-2 py-1.5 text-right text-[#4B5563]">{order.divanHeightInches ?? "-"}</td>
                        <td className="px-2 py-1.5 text-right text-[#4B5563]">{order.legHeightInches ?? "-"}</td>
                        <td className="px-2 py-1.5">
                          {order.specialOrder ? (
                            <span className="text-[10px] bg-[#F9E1DA] text-[#9A3A2D] px-1 py-0.5 rounded">{order.specialOrder.replace(/_/g, " ")}</span>
                          ) : "-"}
                        </td>
                        <td className="px-2 py-1.5 text-[#6B7280] max-w-[80px] truncate" title={order.notes}>{order.notes || "-"}</td>
                        <td className="px-2 py-1.5 text-[#4B5563]">{formatDate(order.targetEndDate)}</td>
                        <td className="px-2 py-1.5 text-[#4B5563]">{formatDate(order.targetEndDate)}</td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${overdue.className}`}>
                            {overdue.icon} {overdue.label}
                          </span>
                        </td>
                        {/* Department Completion Dates */}
                        {DEPARTMENTS.map((dept) => {
                          const jc = order.jobCards.find((j) => j.departmentCode === dept.code);
                          const isCompleted = jc?.status === "COMPLETED" || jc?.status === "TRANSFERRED";
                          const isCurrent = order.currentDepartment === dept.code && !isCompleted;
                          return (
                            <td
                              key={dept.code}
                              className="px-2 py-1.5 text-center"
                              style={{
                                backgroundColor: isCompleted
                                  ? "#DCFCE7"
                                  : isCurrent
                                  ? "#FEF9C3"
                                  : "transparent",
                              }}
                            >
                              {isCompleted && jc?.completedDate ? (
                                <span className="text-[#4F7C3A] font-medium">{formatDate(jc.completedDate)}</span>
                              ) : isCurrent ? (
                                <span className="text-[#9C6F1E] font-medium text-[10px]">IN PROGRESS</span>
                              ) : (
                                <span className="text-[#D1CBC5]">-</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 text-[#4B5563]">{order.rackingNumber || "-"}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1.5 justify-end">
                            <div className="h-1.5 w-14 rounded-full bg-[#E2DDD8]">
                              <div
                                className="h-1.5 rounded-full bg-[#6B5C32] transition-all"
                                style={{ width: `${order.progress}%` }}
                              />
                            </div>
                            <span className="text-[10px] font-medium text-[#6B7280] w-7 text-right">{order.progress}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
