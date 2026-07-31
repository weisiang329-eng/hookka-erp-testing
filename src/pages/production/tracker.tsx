import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, Search, ChevronUp, ChevronDown, Factory, BarChart3 } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { readCsrfCookie, CSRF_HEADER_NAME } from "@/lib/csrf";
import { BatchActionToolbar, ApplyBatchDueDateDialog } from "./components/BatchActionToolbar";

function csrfHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const csrf = readCsrfCookie();
  if (csrf) h[CSRF_HEADER_NAME] = csrf;
  return h;
}

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
  // Migration 0064 — CO linkage. POs from a CO have empty SO ids.
  consignmentOrderId?: string; companyCOId?: string;
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
  { name: "Foam Cutting", code: "FOAM_CUTTING", color: "#A78BFA" },
  { name: "Foam Bonding", code: "FOAM", color: "#8B5CF6" },
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
  const { toast } = useToast();
  // ?fields=minimal&include=jobCards — slim PO fields; keep JCs (per-dept JC lookup uses them).
  const { data: ordersResp, loading, refresh } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>("/api/production-orders?fields=minimal&include=jobCards");
  const fetchedOrders: ProductionOrder[] = useMemo(
    () => (ordersResp?.success ? ordersResp.data ?? [] : Array.isArray(ordersResp) ? ordersResp : []),
    [ordersResp]
  );
  // Local copy so an optimistic batch-due-date edit survives the background
  // cached-fetch revalidation (which serves a STALE snapshot for ~1-3 min after
  // a write). Pin each just-patched job card until the refetched row matches
  // what we wrote (caught up) or a 5-min ceiling lapses — the same protection
  // department.tsx and index.tsx already have, extended here so the WHOLE
  // production module is flicker-proof. (Wei Siang 2026-06-10.)
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const recentlyPatchedRef = useRef<
    Map<string, { expect: Record<string, unknown> }>
  >(new Map());
  const PATCH_PIN_MS = 300_000; // 5-min ceiling; releases EARLY on catch-up.
  const pinJc = (jcId: string, fields: Record<string, unknown>) => {
    recentlyPatchedRef.current.set(jcId, { expect: fields });
    // Pin-expiry ceiling fired from a save event handler (applyBatchDueDate),
    // not a render-time timer — plain setTimeout is correct here.
    // eslint-disable-next-line no-restricted-syntax
    setTimeout(() => recentlyPatchedRef.current.delete(jcId), PATCH_PIN_MS);
  };
  /* eslint-disable react-hooks/set-state-in-effect -- cache-merge sync: hold the
     operator's just-saved due date over a stale background refetch until the
     server catches up; mirrors department.tsx / index.tsx. */
  useEffect(() => {
    if (!fetchedOrders) return;
    const freshJcMap = new Map<string, JobCard>();
    for (const po of fetchedOrders)
      for (const jc of po.jobCards) freshJcMap.set(jc.id, jc);
    const blankVal = (v: unknown) => v === null || v === undefined || v === "";
    const caughtUp = (jc: JobCard, expect: Record<string, unknown>) => {
      const row = jc as unknown as Record<string, unknown>;
      for (const k of Object.keys(expect)) {
        if (!((blankVal(row[k]) && blankVal(expect[k])) || row[k] === expect[k]))
          return false;
      }
      return true;
    };
    const pinnedIds = new Set<string>();
    for (const [jcId, pin] of Array.from(recentlyPatchedRef.current.entries())) {
      const freshJc = freshJcMap.get(jcId);
      if (freshJc && caughtUp(freshJc, pin.expect)) {
        recentlyPatchedRef.current.delete(jcId);
        continue;
      }
      pinnedIds.add(jcId);
    }
    if (pinnedIds.size === 0) {
      setOrders(fetchedOrders);
      return;
    }
    setOrders((prev) => {
      const prevJcMap = new Map<string, JobCard>();
      for (const po of prev)
        for (const jc of po.jobCards)
          if (pinnedIds.has(jc.id)) prevJcMap.set(jc.id, jc);
      if (prevJcMap.size === 0) return fetchedOrders;
      return fetchedOrders.map((po) => ({
        ...po,
        jobCards: po.jobCards.map((jc) =>
          prevJcMap.has(jc.id) ? (prevJcMap.get(jc.id) as JobCard) : jc,
        ),
      }));
    });
  }, [fetchedOrders]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Filters
  const [categoryTab, setCategoryTab] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Sorting
  const [sortField, setSortField] = useState<SortField>("poNo");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Multi-select + batch Due Date. Each tracker row is a whole production
  // order (one PO spans up to 8 department job cards), so the batch action
  // also needs a department scope: which department's job card gets the new
  // due date. "ALL" writes the date to every department job card on each
  // selected order. Mirrors index.tsx / folder-detail.tsx: same
  // ApplyBatchDueDateDialog, same /api/production-orders/bulk-patch endpoint,
  // same toast + optimistic refetch behaviour. The only addition the tracker
  // needs is this department scope, because its rows are orders not job cards.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDept, setBatchDept] = useState<string>("ALL");
  const [batchDueDateOpen, setBatchDueDateOpen] = useState(false);

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

  // The currently-selected orders (intersect the id set with the live list so
  // a row that was filtered out / removed can't linger in the selection).
  const selectedOrders = useMemo(
    () => orders.filter((o) => selectedIds.has(o.id)),
    [orders, selectedIds],
  );

  const allFilteredSelected =
    filteredOrders.length > 0 && filteredOrders.every((o) => selectedIds.has(o.id));

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (filteredOrders.every((o) => prev.has(o.id))) {
        // All visible already selected → clear just the visible ones.
        const next = new Set(prev);
        for (const o of filteredOrders) next.delete(o.id);
        return next;
      }
      const next = new Set(prev);
      for (const o of filteredOrders) next.add(o.id);
      return next;
    });
  };

  // Batch Due Date apply — reuses the EXACT endpoint + patch shape from
  // index.tsx (L6199-6210) and folder-detail.tsx (L615-626):
  // POST /api/production-orders/bulk-patch { patches: [{ poId, jobCardId, dueDate }] }.
  // Builds one patch per (selected order × matching department job card),
  // scoped to batchDept ("ALL" → every dept job card on the order). dueDate
  // only — status is intentionally untouched (schedule vs progress).
  const applyBatchDueDate = async (date: string) => {
    setBatchDueDateOpen(false);
    const patches: Array<{ poId: string; jobCardId: string; dueDate: string }> = [];
    for (const order of selectedOrders) {
      for (const jc of order.jobCards) {
        if (batchDept !== "ALL" && jc.departmentCode !== batchDept) continue;
        patches.push({ poId: order.id, jobCardId: jc.id, dueDate: date });
      }
    }
    if (patches.length === 0) {
      toast.error(
        batchDept === "ALL"
          ? "Selected orders have no job cards to update."
          : `No ${DEPARTMENTS.find((d) => d.code === batchDept)?.name ?? batchDept} job cards on the selected orders.`,
      );
      return;
    }
    try {
      const res = await fetch("/api/production-orders/bulk-patch", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ patches }),
        credentials: "include",
      });
      const j = (await res.json()) as { results?: Array<{ success: boolean; error?: string }>; error?: string; missingPermission?: string };
      if (!res.ok) {
        toast.error(
          j.missingPermission
            ? "Save failed — you don't have permission to make this change. Nothing was saved."
            : `Save failed — ${j.error ?? `error ${res.status}`}. Nothing was saved.`,
        );
        return;
      }
      const failed = (j.results || []).filter((x) => !x.success);
      if (failed.length > 0) {
        toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
      } else {
        const scope = batchDept === "ALL" ? "all departments" : (DEPARTMENTS.find((d) => d.code === batchDept)?.name ?? batchDept);
        const verb = date ? "Set due date" : "Cleared due date";
        toast.success(`${verb} (${scope}) on ${selectedOrders.length} order${selectedOrders.length === 1 ? "" : "s"}.`);
        // All patched OK — optimistically apply the new date locally + pin each
        // job card so the background refetch (stale ~1-3 min) can't pop the old
        // date back (the flicker). The pin releases the instant the server agrees.
        const patchedJcIds = new Set(patches.map((p) => p.jobCardId));
        setOrders((prev) =>
          prev.map((o) => ({
            ...o,
            jobCards: o.jobCards.map((jc) =>
              patchedJcIds.has(jc.id) ? { ...jc, dueDate: date } : jc,
            ),
          })),
        );
        for (const p of patches) pinJc(p.jobCardId, { dueDate: date });
      }
      // Drop the cached matrix + force this page's hook to refetch so the new
      // dates show. Same invalidate prefix the production page uses.
      invalidateCachePrefix("/api/production-orders");
      refresh();
      setSelectedIds(new Set());
    } catch (err) {
      toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
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
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <div className="flex flex-wrap gap-2">
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
            <div className="flex flex-wrap items-center gap-2">
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
                  <th className="h-9 w-9 px-2 text-center font-medium text-[#374151] sticky left-0 bg-[#F0ECE9] z-20">
                    <input
                      type="checkbox"
                      aria-label="Select all visible orders"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      className="cursor-pointer align-middle"
                    />
                  </th>
                  <th className="h-9 px-2 text-left font-medium text-[#374151] sticky left-9 bg-[#F0ECE9] z-10 cursor-pointer" onClick={() => toggleSort("poNo")}>
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
                    <td colSpan={28} className="py-12 text-center text-[#9CA3AF] text-sm">
                      No production orders match the current filters.
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((order) => {
                    const overdue = getOverdueDisplay(order);
                    const isSelected = selectedIds.has(order.id);
                    return (
                      <tr
                        key={order.id}
                        className={`border-b border-[#E2DDD8] cursor-pointer ${isSelected ? "bg-[#FFF8E6] hover:bg-[#FBEFC9]" : "hover:bg-[#FAF9F7]"}`}
                        onClick={() => {
                          if (order.salesOrderId) navigate(`/sales/${order.salesOrderId}`);
                          else if (order.consignmentOrderId)
                            navigate(`/consignment/${order.consignmentOrderId}`);
                        }}
                      >
                        <td
                          className={`px-2 py-1.5 text-center sticky left-0 z-10 ${isSelected ? "bg-[#FFF8E6]" : "bg-white"}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select order ${order.poNo}`}
                            checked={isSelected}
                            onChange={() => toggleRow(order.id)}
                            className="cursor-pointer align-middle"
                          />
                        </td>
                        <td className={`px-2 py-1.5 font-medium doc-number sticky left-9 z-10 ${isSelected ? "bg-[#FFF8E6]" : "bg-white"}`}>
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

      {/* Batch Due Date — multi-select rows, pick a department scope + a date,
          Apply. Reuses the production page's BatchActionToolbar +
          ApplyBatchDueDateDialog + /api/production-orders/bulk-patch endpoint.
          The department scope picker is tracker-specific: each row is a whole
          order spanning up to 8 dept job cards, so the operator chooses which
          department's due date to set (or all). */}
      {selectedOrders.length > 0 && (
        <div className="sticky bottom-[68px] left-3 right-3 z-30 flex items-center gap-2 rounded-md border border-[#C9A227] bg-[#FFF8E6] px-3 py-2 shadow-md">
          <span className="text-[12px] font-semibold text-[#5A4500]">Due Date department:</span>
          <select
            value={batchDept}
            onChange={(e) => setBatchDept(e.target.value)}
            className="h-8 rounded border border-[#D4CFC7] bg-white px-2 text-[12px] text-[#3A2E22] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
          >
            <option value="ALL">All departments</option>
            {DEPARTMENTS.map((dept) => (
              <option key={dept.code} value={dept.code}>{dept.name}</option>
            ))}
          </select>
          <span className="text-[11px] text-[#9C7A1E]">
            {batchDept === "ALL"
              ? "Sets the date on every department job card of the selected orders."
              : `Sets the date on the ${DEPARTMENTS.find((d) => d.code === batchDept)?.name} job card of the selected orders.`}
          </span>
        </div>
      )}

      <BatchActionToolbar
        count={selectedOrders.length}
        onClear={() => setSelectedIds(new Set())}
        onApplyDueDate={() => setBatchDueDateOpen(true)}
        // The tracker only exposes the batch Due Date action — completion
        // date, PIC, and folder archiving live on the Production page where
        // rows are individual job cards. These no-op handlers are required by
        // the shared toolbar's prop contract; their buttons stay but inform
        // the operator where to go.
        onApplyDate={() => toast.error("Apply Completion is on the Production page (per-job-card). Use Apply Due Date here.")}
        onApplyPic={() => toast.error("Apply PIC is on the Production page (per-job-card).")}
        onSaveToFolder={() => toast.error("Save to Folder is on the Production page (per-job-card).")}
      />

      <ApplyBatchDueDateDialog
        open={batchDueDateOpen}
        count={selectedOrders.length}
        onCancel={() => setBatchDueDateOpen(false)}
        onApply={applyBatchDueDate}
      />
    </div>
  );
}
