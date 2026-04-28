import { useState, useMemo, useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useUrlState, useUrlStateNumber } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, cn } from "@/lib/utils";
import { getPrimarySoCategory } from "@/lib/so-category";
import { Plus, ShoppingCart, Download, Filter, X, Eye, Pencil, Printer, Truck, FileText, ClipboardList, RefreshCw, Package, CheckCircle, ScanLine } from "lucide-react";
import { generateSOPdf } from "@/lib/generate-so-pdf";
import { ScanPOModal } from "@/components/scan-po-modal";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import type { ConsignmentOrder as SalesOrder } from "@/types";
import type { Customer, DeliveryOrder } from "@/lib/mock-data";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { DeliveryOrderSchema } from "@/lib/schemas/delivery-order";
import { InvoiceSchema } from "@/lib/schemas/invoice";
import { z } from "zod";

const DOListSchema = z
  .object({
    success: z.boolean().optional(),
    data: z.array(DeliveryOrderSchema).optional(),
  })
  .passthrough();
const DOMutationSchema = mutationWithData(DeliveryOrderSchema);
const InvoiceMutationSchema = mutationWithData(InvoiceSchema);

type LinkedPOSummary = {
  soId: string;
  poNo: string;
  status: string;
};

type SOStatusChangeEntry = {
  id: string;
  soId: string;
  fromStatus: string;
  toStatus: string;
  changedBy: string;
  timestamp: string;
  notes: string;
  autoActions: string[];
};

const ALL_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "IN_PRODUCTION", label: "In Production" },
  { value: "READY_TO_SHIP", label: "Ready to Ship" },
  { value: "SHIPPED", label: "Shipped" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "INVOICED", label: "Invoiced" },
  { value: "CLOSED", label: "Closed" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "CANCELLED", label: "Cancelled" },
];

// Page size 200 — enough to fit the entire current SO list on one page
// so search/filter work normally (client-side search can't see other
// pages). Pagination still kicks in past 200 rows, but day-to-day users
// stay on page 1.
const PAGE_SIZE = 200;

export default function SalesPage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Pagination — server-side. Filter/tab changes reset to page 1.
  // URL-synced so refresh / share-link land back on the same page.
  const [page, setPage] = useUrlStateNumber("page", 1);

  const { data: ordersResp, loading, refresh: refreshOrders } = useCachedJson<{
    success?: boolean;
    data?: SalesOrder[];
    page?: number;
    limit?: number;
    total?: number;
  }>(`/api/consignment-orders?page=${page}&limit=${PAGE_SIZE}`);
  // Whole-dataset status bucket counts — tab badges read from this so
  // "Draft (N)" / "Confirmed (N)" reflect the full table, not just the
  // current page of rows.
  const { data: statsResp, refresh: refreshStats } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    total?: number;
  }>("/api/consignment-orders/stats");
  const { data: customersResp, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  const { data: productionOrdersResp, refresh: refreshProductionOrders } = useCachedJson<{ success?: boolean; data?: { salesOrderId: string; poNo: string; status: string }[] }>("/api/production-orders");
  const { data: statusChangesResp, refresh: refreshStatusChanges } = useCachedJson<{ success?: boolean; data?: SOStatusChangeEntry[] }>("/api/consignment-orders/status-changes");
  const orders: SalesOrder[] = useMemo(
    () => (ordersResp?.success ? ordersResp.data ?? [] : Array.isArray(ordersResp) ? ordersResp : []),
    [ordersResp]
  );
  const totalOrdersServer = ordersResp?.total ?? orders.length;
  const totalPages = Math.max(1, Math.ceil(totalOrdersServer / PAGE_SIZE));
  // Tab badge counts come from the server-side /stats aggregate so they
  // reflect the whole dataset, not just the current paginated page.
  // "Confirmed" is anything that isn't DRAFT.
  const statsByStatus = statsResp?.byStatus ?? {};
  const statsTotal = statsResp?.total ?? totalOrdersServer;
  const sumStatuses = (statuses: string[]): number =>
    statuses.reduce((n, s) => n + (statsByStatus[s] ?? 0), 0);
  const draftCount = statsByStatus.DRAFT ?? 0;
  const confirmedCount = Math.max(0, statsTotal - draftCount);
  const outstandingCount = sumStatuses(["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED"]);
  const pendingDeliveryCount = sumStatuses(["READY_TO_SHIP", "SHIPPED"]);
  const completedCount = sumStatuses(["DELIVERED", "INVOICED", "CLOSED"]);
  const customers: Customer[] = useMemo(
    () => (customersResp?.data ? customersResp.data : Array.isArray(customersResp) ? customersResp : []),
    [customersResp]
  );
  const linkedPOMap = useMemo<Record<string, LinkedPOSummary[]>>(() => {
    const map: Record<string, LinkedPOSummary[]> = {};
    if (productionOrdersResp?.success && productionOrdersResp.data) {
      for (const po of productionOrdersResp.data) {
        if (!map[po.salesOrderId]) map[po.salesOrderId] = [];
        map[po.salesOrderId].push({ soId: po.salesOrderId, poNo: po.poNo, status: po.status });
      }
    }
    return map;
  }, [productionOrdersResp]);
  // Keep referencing the status-changes envelope so the hook stays subscribed,
  // even though we don't render from it directly (matches the previous behaviour).
  useMemo(() => statusChangesResp?.success ? statusChangesResp.data || [] : [], [statusChangesResp]);
  const [selectedRows, setSelectedRows] = useState<SalesOrder[]>([]);
  const [bulkConverting, setBulkConverting] = useState(false);
  const [bulkPrinting, setBulkPrinting] = useState(false);
  // Tab + filter state lives in the URL so refresh, back/forward, and
  // shared links all land the user on exactly the view they had open.
  const [tab, setTab] = useUrlState<"DRAFT" | "CONFIRMED">("tab", "CONFIRMED");
  const [scanPOOpen, setScanPOOpen] = useState(false);

  // Transfer to DO / Invoice states
  const [transferDORow, setTransferDORow] = useState<SalesOrder | null>(null);
  const [transferInvRow, setTransferInvRow] = useState<SalesOrder | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [doDeliveryDate, setDoDeliveryDate] = useState("");
  const [doDriverName, setDoDriverName] = useState("");
  const [doVehicleNo, setDoVehicleNo] = useState("");
  const [transferSuccess, setTransferSuccess] = useState<{ type: "do" | "inv"; docNo: string } | null>(null);
  const [matchedDO, setMatchedDO] = useState<DeliveryOrder | null>(null);

  // Filters — URL-synced so refresh / shared link / back-forward keeps
  // the user's exact view. Default values are stripped from the URL so
  // empty filters don't litter the address bar.
  const [filterStatus, setFilterStatus] = useUrlState<string>("status", "");
  const [filterCustomer, setFilterCustomer] = useUrlState<string>("customer", "");
  const [filterDateFrom, setFilterDateFrom] = useUrlState<string>("from", "");
  const [filterDateTo, setFilterDateTo] = useUrlState<string>("to", "");
  // Category matches if ANY line on the SO is the chosen category. DD axis
  // = customerDeliveryDate (sales staff filter on the date the customer
  // expects delivery, not SO entry date / internal expected DD).
  const [filterCategory, setFilterCategory] = useUrlState<"" | "BEDFRAME" | "SOFA" | "ACCESSORY">("cat", "");
  const [filterDDFrom, setFilterDDFrom] = useUrlState<string>("ddFrom", "");
  const [filterDDTo, setFilterDDTo] = useUrlState<string>("ddTo", "");
  // Show/hide filter panel — sessionStorage so closing the tab forgets,
  // but a refresh keeps the panel open if user had it open.
  const [showFilters, setShowFilters] = useSessionState<boolean>("sales:showFilters", false);

  // Restore scroll position after navigating back to this page.
  const [savedScroll, setSavedScroll] = useSessionState<number>("sales:scrollY", 0);
  useEffect(() => {
    if (savedScroll > 0 && window.scrollY === 0) {
      window.scrollTo(0, savedScroll);
    }
    const onScroll = () => {
      setSavedScroll(window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
    // savedScroll is read on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to page 1 when any filter or tab changes. setPage is stable
  // (memoized inside useUrlStateNumber), so omitting it from deps is safe
  // and intentional — including it would re-fire whenever any URL param
  // changed, which would itself recurse into the setPage call below.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterCustomer, filterDateFrom, filterDateTo, filterCategory, filterDDFrom, filterDDTo, tab]);

  const fetchAll = () => {
    invalidateCachePrefix("/api/consignment-orders");
    invalidateCachePrefix("/api/customers");
    invalidateCachePrefix("/api/production-orders");
    refreshOrders();
    refreshStats();
    refreshCustomers();
    refreshProductionOrders();
    refreshStatusChanges();
  };

  const hasActiveFilters = filterStatus || filterCustomer || filterDateFrom || filterDateTo || filterCategory || filterDDFrom || filterDDTo;

  // Atomic clear — one setSearchParams call, not seven. Each useUrlState
  // setter calls navigate() under the hood; firing seven in a row races on
  // react-router-dom v7 (later setters can read pre-clear state and re-add
  // the keys we just deleted). Build the new URL once and replace.
  const [, setSearchParams] = useSearchParams();
  const clearFilters = () => {
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete("status");
        out.delete("customer");
        out.delete("from");
        out.delete("to");
        out.delete("cat");
        out.delete("ddFrom");
        out.delete("ddTo");
        return out;
      },
      { replace: true },
    );
  };

  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      if (tab === "DRAFT" && o.status !== "DRAFT") return false;
      if (tab === "CONFIRMED" && o.status === "DRAFT") return false;
      if (filterStatus && o.status !== filterStatus) return false;
      if (filterCustomer && o.customerId !== filterCustomer) return false;
      if (filterDateFrom) {
        const orderDate = o.companyCODate.split("T")[0];
        if (orderDate < filterDateFrom) return false;
      }
      if (filterDateTo) {
        const orderDate = o.companyCODate.split("T")[0];
        if (orderDate > filterDateTo) return false;
      }
      // Category: derive ONE primary category per SO (SOFA > BEDFRAME >
      // ACCESSORY) instead of "any line matches". Each SO is now exactly
      // one of the three buckets — no double-counting a sofa+pillows order
      // under both filters. SOFA / BEDFRAME mixing is blocked at create.
      if (filterCategory && getPrimarySoCategory(o.items) !== filterCategory) return false;
      // Customer delivery date range — what sales staff actually filter on.
      if (filterDDFrom || filterDDTo) {
        const dd = o.customerDeliveryDate ? o.customerDeliveryDate.split("T")[0] : "";
        if (!dd) return false;
        if (filterDDFrom && dd < filterDDFrom) return false;
        if (filterDDTo && dd > filterDDTo) return false;
      }
      return true;
    });
  }, [orders, tab, filterStatus, filterCustomer, filterDateFrom, filterDateTo, filterCategory, filterDDFrom, filterDDTo]);

  const exportCSV = () => {
    const headers = [
      "SO No.", "Customer", "State", "Customer PO", "Order Date", "Expected DD",
      "Items", "Total Qty", "Total (RM)", "Status",
    ];
    const rows = filteredOrders.map(o => {
      const totalQty = o.items.reduce((s, i) => s + i.quantity, 0);
      return [
        o.companyCOId,
        o.customerName,
        o.customerState,
        o.customerPOId || "",
        o.companyCODate.split("T")[0],
        o.hookkaExpectedDD ? o.hookkaExpectedDD.split("T")[0] : "",
        o.items.length.toString(),
        totalQty.toString(),
        (o.totalSen / 100).toFixed(2),
        o.status,
      ];
    });

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sales-orders-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const columns: Column<SalesOrder>[] = [
    { key: "companyCOId", label: "Company SO", type: "docno", width: "130px", sortable: true },
    { key: "customerCOId", label: "Customer SO", type: "docno", width: "120px", sortable: true },
    { key: "customerPOId", label: "Customer PO", type: "docno", width: "120px", sortable: true },
    { key: "customerName", label: "Customer", type: "text", width: "100px", sortable: true },
    { key: "customerDeliveryDate", label: "Customer Delivery", type: "date", width: "110px", sortable: true },
    { key: "customerState", label: "State", type: "text", width: "50px", sortable: true },
    { key: "reference", label: "Reference", type: "text", width: "100px", sortable: true },
    { key: "companyCODate", label: "Order Date", type: "date", width: "90px", sortable: true },
    { key: "hookkaExpectedDD", label: "Expected DD", type: "date", width: "90px", sortable: true },
    {
      key: "items",
      label: "Items",
      type: "number",
      width: "50px",
      sortable: true,
      render: (_value, row) => <span>{row.items.length}</span>,
    },
    {
      key: "totalQty",
      label: "Qty",
      type: "number",
      width: "55px",
      align: "right" as const,
      sortable: true,
      render: (_value: unknown, row: SalesOrder) => {
        const totalQty = row.items.reduce((s, i) => s + i.quantity, 0);
        return <span>{totalQty}</span>;
      },
    },
    {
      key: "outstanding",
      label: "Outstanding",
      type: "text",
      width: "100px",
      sortable: true,
      render: (_value: unknown, row: SalesOrder) => {
        // Completed statuses - no outstanding
        if (["DELIVERED", "INVOICED", "CLOSED", "CANCELLED", "DRAFT"].includes(row.status)) {
          return <span className="text-[#9CA3AF]">—</span>;
        }
        const totalQty = row.items.reduce((s, i) => s + i.quantity, 0);
        const linkedPOs = linkedPOMap[row.id] || [];
        const completedPOs = linkedPOs.filter(p => p.status === "COMPLETED").length;
        const totalPOs = linkedPOs.length;

        if (totalPOs === 0) {
          // CONFIRMED but no production orders yet
          return <span className="font-semibold text-[#9A3A2D]">{totalQty} pcs</span>;
        }

        const outstandingPOs = totalPOs - completedPOs;
        if (outstandingPOs > 0) {
          return (
            <span className="font-semibold text-[#9C6F1E]">
              {outstandingPOs}/{totalPOs}
            </span>
          );
        }

        // All production done but not yet delivered
        if (row.status === "READY_TO_SHIP") {
          return <span className="font-semibold text-[#3E6570]">Ship</span>;
        }
        if (row.status === "SHIPPED") {
          return <span className="font-semibold text-[#3E6570]">Deliver</span>;
        }
        return <span className="text-[#4F7C3A]">Done</span>;
      },
    },
    { key: "totalSen", label: "Total", type: "currency", width: "100px", sortable: true },
    { key: "status", label: "Status", type: "status", width: "100px", sortable: true },
  ];

  const getContextMenuItems = (row: SalesOrder): ContextMenuItem[] => [
    {
      label: "View",
      icon: <Eye className="h-3.5 w-3.5" />,
      action: () => navigate(`/consignment/${row.id}`),
    },
    {
      label: "Edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: () => navigate(`/consignment/${row.id}/edit`),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Print / Preview",
      icon: <Printer className="h-3.5 w-3.5" />,
      action: () => generateSOPdf(row as unknown as Parameters<typeof generateSOPdf>[0], customers.find(c => c.id === row.customerId) ?? null),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Transfer to Delivery Order",
      icon: <Truck className="h-3.5 w-3.5" />,
      action: () => {
        setDoDeliveryDate("");
        setDoDriverName("");
        setDoVehicleNo("");
        setTransferSuccess(null);
        setTransferDORow(row);
      },
    },
    {
      label: "Transfer to Invoice",
      icon: <FileText className="h-3.5 w-3.5" />,
      action: async () => {
        setTransferLoading(true);
        try {
          const d = await fetchJson("/api/delivery-orders", DOListSchema);
          if (d.success && d.data) {
            const found = d.data.find((dord) => dord.salesOrderId === row.id);
            if (found) {
              setMatchedDO(found as unknown as DeliveryOrder);
              setTransferSuccess(null);
              setTransferInvRow(row);
            } else {
              toast.warning("Please create a Delivery Order first before generating an invoice.");
            }
          } else {
            toast.warning("Please create a Delivery Order first before generating an invoice.");
          }
        } catch {
          toast.error("Failed to check delivery orders. Please try again.");
        } finally {
          setTransferLoading(false);
        }
      },
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "View Document Status Change Log",
      icon: <ClipboardList className="h-3.5 w-3.5" />,
      action: () => navigate(`/consignment/${row.id}?tab=status-log`),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      action: () => fetchAll(),
    },
  ];

  const totalRevenue = orders.reduce((sum, o) => sum + o.totalSen, 0);
  // When any filter is active, show the sum of the currently-visible rows
  // so users can ask "sofa this month — how much?" and read it off the
  // same Revenue card. Falls back to the page-level totalRevenue when no
  // filter is active.
  const filteredRevenue = useMemo(
    () => filteredOrders.reduce((sum, o) => sum + o.totalSen, 0),
    [filteredOrders]
  );

  // Quick date presets for filterDateFrom / filterDateTo. Sales staff
  // usually want "this month / last month / this year" at a glance.
  const applyDatePreset = (preset: "this-month" | "last-month" | "this-year") => {
    const now = new Date();
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    if (preset === "this-month") {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setFilterDateFrom(fmt(from));
      setFilterDateTo(fmt(to));
    } else if (preset === "last-month") {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0);
      setFilterDateFrom(fmt(from));
      setFilterDateTo(fmt(to));
    } else {
      const from = new Date(now.getFullYear(), 0, 1);
      const to = new Date(now.getFullYear(), 11, 31);
      setFilterDateFrom(fmt(from));
      setFilterDateTo(fmt(to));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Sales Orders</h1>
          <p className="text-xs text-[#6B7280]">Manage customer orders from creation to delivery</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setScanPOOpen(true)}>
            <ScanLine className="h-4 w-4" /> Scan PO
          </Button>
          <Button variant="primary" onClick={() => navigate("/consignment/create")}>
            <Plus className="h-4 w-4" /> New Sales Order
          </Button>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-5">
        <Card><CardContent className="p-2.5"><p className="text-xs text-[#6B7280]">Total Orders</p><p className="text-2xl font-bold">{statsTotal}</p></CardContent></Card>
        <Card>
          <CardContent className="p-2.5">
            <p className="text-xs text-[#6B7280]">
              {hasActiveFilters ? "Revenue (filtered)" : "Revenue"}
            </p>
            <p className={cn(
              "text-xl font-bold",
              hasActiveFilters && "text-[#6B5C32]"
            )}>
              {formatCurrency(hasActiveFilters ? filteredRevenue : totalRevenue)}
            </p>
          </CardContent>
        </Card>
        <Card><CardContent className="p-2.5"><p className="text-xs text-[#6B7280]">Outstanding</p><p className="text-xl font-bold text-[#9C6F1E]">{outstandingCount}</p></CardContent></Card>
        <Card><CardContent className="p-2.5"><p className="text-xs text-[#6B7280]">Pending Delivery</p><p className="text-xl font-bold text-[#3E6570]">{pendingDeliveryCount}</p></CardContent></Card>
        <Card><CardContent className="p-2.5"><p className="text-xs text-[#6B7280]">Completed</p><p className="text-xl font-bold text-[#4F7C3A]">{completedCount}</p></CardContent></Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Button
                variant={showFilters ? "primary" : "outline"}
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4" /> Filters
                {hasActiveFilters && <span className="ml-1 bg-white text-[#6B5C32] text-xs rounded-full h-5 w-5 flex items-center justify-center font-bold">!</span>}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-[#9CA3AF] hover:text-[#374151]">
                  <X className="h-4 w-4" /> Clear
                </Button>
              )}
              {hasActiveFilters && (
                <span className="text-sm text-[#6B7280]">
                  Showing {filteredOrders.length} of {orders.length} orders ·{" "}
                  <span className="font-semibold text-[#6B5C32]">
                    {formatCurrency(filteredRevenue)}
                  </span>
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </div>

          {showFilters && (
            <>
              <div className="flex flex-wrap items-center gap-2 pt-3 pb-1 border-t border-[#E2DDD8]">
                <span className="text-xs text-[#9CA3AF]">Quick:</span>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("this-month")}>
                  This Month
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("last-month")}>
                  Last Month
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("this-year")}>
                  This Year
                </Button>
                <Button variant="outline" size="sm" onClick={() => setFilterCategory("SOFA")}>
                  Sofa
                </Button>
                <Button variant="outline" size="sm" onClick={() => setFilterCategory("BEDFRAME")}>
                  Bedframe
                </Button>
              </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  {ALL_STATUSES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Customer</label>
                <select
                  value={filterCustomer}
                  onChange={(e) => setFilterCustomer(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Customers</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.code} - {c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date From</label>
                <Input
                  type="date"
                  value={filterDateFrom}
                  onChange={(e) => setFilterDateFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date To</label>
                <Input
                  type="date"
                  value={filterDateTo}
                  onChange={(e) => setFilterDateTo(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Category</label>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value as "" | "BEDFRAME" | "SOFA" | "ACCESSORY")}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Categories</option>
                  <option value="BEDFRAME">Bedframe</option>
                  <option value="SOFA">Sofa</option>
                  <option value="ACCESSORY">Accessories</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">DD from</label>
                <Input
                  type="date"
                  value={filterDDFrom}
                  onChange={(e) => setFilterDDFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">DD to</label>
                <Input
                  type="date"
                  value={filterDDTo}
                  onChange={(e) => setFilterDDTo(e.target.value)}
                />
              </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2"><ShoppingCart className="h-5 w-5 text-[#6B5C32]" /> Sales Orders</CardTitle>
            <div className="inline-flex rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-0.5">
              <button
                onClick={() => { setTab("DRAFT"); setSelectedRows([]); }}
                className={cn(
                  "px-4 py-1.5 text-sm rounded transition-colors",
                  tab === "DRAFT"
                    ? "bg-[#FAEFCB] text-[#9C6F1E] font-medium shadow-sm"
                    : "text-[#6B7280] hover:text-[#1F1D1B]"
                )}
              >
                Draft ({draftCount})
              </button>
              <button
                onClick={() => { setTab("CONFIRMED"); setSelectedRows([]); }}
                className={cn(
                  "px-4 py-1.5 text-sm rounded transition-colors",
                  tab === "CONFIRMED"
                    ? "bg-[#E0EDF0] text-[#3E6570] font-medium shadow-sm"
                    : "text-[#6B7280] hover:text-[#1F1D1B]"
                )}
              >
                Confirmed ({confirmedCount})
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tab === "DRAFT" && selectedRows.length > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-sm">
              <span className="text-[#9C6F1E]">
                {selectedRows.length} draft order(s) selected
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={bulkConverting}
                onClick={async () => {
                  const drafts = selectedRows.filter(s => s.status === "DRAFT");
                  if (drafts.length === 0) return;
                  if (!confirm(`Convert ${drafts.length} draft order(s) to CONFIRMED? This will auto-create production orders.`)) return;
                  setBulkConverting(true);
                  let ok = 0, fail = 0;
                  const errors: string[] = [];
                  for (const so of drafts) {
                    try {
                      const res = await fetch(`/api/consignment-orders/${so.id}/confirm`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ changedBy: "Admin", notes: "Bulk confirm" }),
                      });
                      const text = await res.text();
                      let d: { success?: boolean; error?: string } = {};
                      try { d = JSON.parse(text); } catch { d = { error: text.slice(0, 200) }; }
                      if (d.success) ok++;
                      else {
                        fail++;
                        if (errors.length < 3) errors.push(`${so.companyCOId}: ${d.error || `HTTP ${res.status}`}`);
                      }
                    } catch (e) {
                      fail++;
                      if (errors.length < 3) errors.push(`${so.companyCOId}: ${(e as Error).message}`);
                    }
                  }
                  setBulkConverting(false);
                  setSelectedRows([]);
                  if (fail > 0) {
                    toast.error(`Converted: ${ok} · Failed: ${fail}${errors.length ? " — " + errors[0] : ""}`);
                  } else {
                    toast.success(`Converted ${ok} order${ok !== 1 ? "s" : ""} successfully.`);
                  }
                  // Jump to Confirmed tab if anything actually converted so
                  // the user can immediately see the new confirmed orders.
                  if (ok > 0) setTab("CONFIRMED");
                  invalidateCachePrefix("/api/consignment-orders");
                  invalidateCachePrefix("/api/production-orders");
                  fetchAll();
                }}
              >
                <CheckCircle className="h-4 w-4" /> {bulkConverting ? "Converting..." : "Convert to Confirmed"}
              </Button>
            </div>
          )}
          {tab === "CONFIRMED" && selectedRows.length > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-md border border-[#A8CAD2] bg-[#E0EDF0] px-3 py-2 text-sm">
              <span className="text-[#3E6570]">
                {selectedRows.length} order(s) selected
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkPrinting}
                  onClick={async () => {
                    setBulkPrinting(true);
                    try {
                      for (const so of selectedRows) {
                        generateSOPdf(so as unknown as Parameters<typeof generateSOPdf>[0], customers.find(c => c.id === so.customerId) ?? null);
                        // Tiny pacing delay between PDFs so the browser doesn't
                        // queue all download dialogs in the same tick. Inside
                        // an async event handler, not a React effect.
                        // eslint-disable-next-line no-restricted-syntax -- pacing delay inside async event handler loop
                        await new Promise(r => setTimeout(r, 120));
                      }
                    } finally {
                      setBulkPrinting(false);
                    }
                  }}
                >
                  <Printer className="h-4 w-4" /> {bulkPrinting ? "Printing..." : "Bulk Print PDF"}
                </Button>
              </div>
            </div>
          )}
          <DataGrid<SalesOrder>
            columns={columns}
            data={filteredOrders}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            maxHeight="calc(100vh - 320px)"
            emptyMessage={tab === "DRAFT" ? "No draft orders." : "No confirmed orders."}
            onDoubleClick={(row) => navigate(`/consignment/${row.id}`)}
            contextMenuItems={getContextMenuItems}
            selectable
            onSelectionChange={setSelectedRows}
            rowClassName={(row) =>
              row.status === "DRAFT"
                ? "!bg-[#FAEFCB]/60 border-l-2 border-l-amber-400"
                : ""
            }
          />

          {/* Pagination footer */}
          <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280]">
            <span>
              {totalOrdersServer.toLocaleString()} sales order
              {totalOrdersServer === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1 || loading}
              >
                ← Prev
              </Button>
              <span className="tabular-nums text-[#1F1D1B]">
                Page {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages || loading}
              >
                Next →
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Transfer to Delivery Order Dialog */}
      {transferDORow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!transferLoading) setTransferDORow(null); }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-[#6B5C32]/10 flex items-center justify-center">
                  <Truck className="h-5 w-5 text-[#6B5C32]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#1F1D1B]">Transfer to Delivery Order</h2>
                  <p className="text-xs text-[#6B7280]">Create a DO from {transferDORow.companyCOId}</p>
                </div>
              </div>
              <button
                onClick={() => { if (!transferLoading) setTransferDORow(null); }}
                className="text-[#9CA3AF] hover:text-[#374151] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {transferSuccess?.type === "do" ? (
              <div className="p-6 text-center space-y-4">
                <div className="mx-auto h-16 w-16 rounded-full bg-[#EEF3E4] flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-[#4F7C3A]" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-[#1F1D1B]">Delivery Order Created</h3>
                  <p className="text-xs text-[#6B7280] mt-0.5">DO No: <span className="font-mono font-semibold text-[#6B5C32]">{transferSuccess.docNo}</span></p>
                </div>
                <div className="flex justify-center gap-3 pt-2">
                  <Button variant="outline" onClick={() => { setTransferDORow(null); setTransferSuccess(null); }}>Close</Button>
                  <Button variant="primary" onClick={() => { setTransferDORow(null); setTransferSuccess(null); navigate("/delivery"); }}>
                    Go to Delivery Orders
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* SO Info */}
                <div className="px-6 py-4 bg-[#FAF9F7] border-b border-[#E2DDD8]">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-[#9CA3AF]">SO No.</span>
                      <p className="font-semibold text-[#1F1D1B]">{transferDORow.companyCOId}</p>
                    </div>
                    <div>
                      <span className="text-[#9CA3AF]">Customer</span>
                      <p className="font-semibold text-[#1F1D1B]">{transferDORow.customerName}</p>
                    </div>
                    <div>
                      <span className="text-[#9CA3AF]">Items</span>
                      <p className="font-semibold text-[#1F1D1B]">{transferDORow.items.length} item(s)</p>
                    </div>
                    <div>
                      <span className="text-[#9CA3AF]">Total</span>
                      <p className="font-semibold text-[#1F1D1B]">{formatCurrency(transferDORow.totalSen)}</p>
                    </div>
                  </div>
                </div>

                {/* Delivery fields */}
                <div className="px-6 py-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Delivery Date (optional)</label>
                      <Input
                        type="date"
                        value={doDeliveryDate}
                        onChange={(e) => setDoDeliveryDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Driver Name (optional)</label>
                      <Input
                        type="text"
                        placeholder="e.g. Ahmad"
                        value={doDriverName}
                        onChange={(e) => setDoDriverName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Vehicle No. (optional)</label>
                      <Input
                        type="text"
                        placeholder="e.g. WA1234B"
                        value={doVehicleNo}
                        onChange={(e) => setDoVehicleNo(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Items table */}
                  <div>
                    <h3 className="text-sm font-medium text-[#1F1D1B] mb-2 flex items-center gap-2">
                      <Package className="h-4 w-4 text-[#6B5C32]" /> Items to Transfer
                    </h3>
                    <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-[#FAF9F7] border-b border-[#E2DDD8]">
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Product Code</th>
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Product Name</th>
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Size</th>
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Fabric</th>
                            <th className="text-right px-3 py-2 text-[#9CA3AF] font-medium">Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {transferDORow.items.map((item, idx) => (
                            <tr key={idx} className="border-b border-[#E2DDD8] last:border-b-0">
                              <td className="px-3 py-2 font-mono text-xs">{item.productCode}</td>
                              <td className="px-3 py-2">{item.productName}</td>
                              <td className="px-3 py-2">{item.sizeLabel}</td>
                              <td className="px-3 py-2">{item.fabricCode}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-3">
                  <Button variant="outline" onClick={() => setTransferDORow(null)} disabled={transferLoading}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={transferLoading}
                    onClick={async () => {
                      setTransferLoading(true);
                      try {
                        const mappedItems = transferDORow.items.map(item => ({
                          productCode: item.productCode,
                          productName: item.productName,
                          sizeLabel: item.sizeLabel,
                          fabricCode: item.fabricCode,
                          quantity: item.quantity,
                          itemM3: 0,
                          rackingNumber: "",
                          packingStatus: "PENDING",
                        }));
                        const d = await fetchJson("/api/delivery-orders", DOMutationSchema, {
                          method: "POST",
                          body: {
                            salesOrderId: transferDORow.id,
                            items: mappedItems,
                            ...(doDeliveryDate && { deliveryDate: doDeliveryDate }),
                            ...(doDriverName && { driverName: doDriverName }),
                            ...(doVehicleNo && { vehicleNo: doVehicleNo }),
                          },
                        });
                        if (d.success) {
                          invalidateCachePrefix("/api/delivery-orders");
                          invalidateCachePrefix("/api/consignment-orders");
                          setTransferSuccess({ type: "do", docNo: (d.data?.doNo as string) || "Created" });
                          fetchAll();
                        } else {
                          toast.error(d.error || "Failed to create Delivery Order.");
                        }
                      } catch {
                        toast.error("Failed to create Delivery Order. Please try again.");
                      } finally {
                        setTransferLoading(false);
                      }
                    }}
                  >
                    {transferLoading ? "Creating..." : "Create DO"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Transfer to Invoice Dialog */}
      {transferInvRow && matchedDO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!transferLoading) { setTransferInvRow(null); setMatchedDO(null); } }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-[#6B5C32]/10 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-[#6B5C32]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#1F1D1B]">Transfer to Invoice</h2>
                  <p className="text-xs text-[#6B7280]">Generate invoice from {transferInvRow.companyCOId}</p>
                </div>
              </div>
              <button
                onClick={() => { if (!transferLoading) { setTransferInvRow(null); setMatchedDO(null); } }}
                className="text-[#9CA3AF] hover:text-[#374151] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {transferSuccess?.type === "inv" ? (
              <div className="p-6 text-center space-y-4">
                <div className="mx-auto h-16 w-16 rounded-full bg-[#EEF3E4] flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-[#4F7C3A]" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-[#1F1D1B]">Invoice Created</h3>
                  <p className="text-xs text-[#6B7280] mt-0.5">Invoice No: <span className="font-mono font-semibold text-[#6B5C32]">{transferSuccess.docNo}</span></p>
                </div>
                <div className="flex justify-center gap-3 pt-2">
                  <Button variant="outline" onClick={() => { setTransferInvRow(null); setMatchedDO(null); setTransferSuccess(null); }}>Close</Button>
                  <Button variant="primary" onClick={() => { setTransferInvRow(null); setMatchedDO(null); setTransferSuccess(null); navigate("/invoices"); }}>
                    Go to Invoices
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* DO Info */}
                <div className="px-6 py-4 space-y-4">
                  <div className="bg-[#FAF9F7] rounded-lg p-4 border border-[#E2DDD8]">
                    <p className="text-xs text-[#9CA3AF] mb-2">Linked Delivery Order</p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-[#9CA3AF]">DO No.</span>
                        <p className="font-semibold text-[#1F1D1B]">{matchedDO.doNo}</p>
                      </div>
                      <div>
                        <span className="text-[#9CA3AF]">Status</span>
                        <p><Badge variant="status" status={matchedDO.status}>{matchedDO.status}</Badge></p>
                      </div>
                      <div>
                        <span className="text-[#9CA3AF]">Customer</span>
                        <p className="font-semibold text-[#1F1D1B]">{matchedDO.customerName}</p>
                      </div>
                      <div>
                        <span className="text-[#9CA3AF]">Items</span>
                        <p className="font-semibold text-[#1F1D1B]">{matchedDO.items.length} item(s)</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-[#6B7280]">
                    This will generate an invoice based on the delivery order above. All items and pricing will be auto-populated from the sales order.
                  </p>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-3">
                  <Button variant="outline" onClick={() => { setTransferInvRow(null); setMatchedDO(null); }} disabled={transferLoading}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={transferLoading}
                    onClick={async () => {
                      setTransferLoading(true);
                      try {
                        const d = await fetchJson("/api/invoices", InvoiceMutationSchema, {
                          method: "POST",
                          body: { deliveryOrderId: matchedDO.id },
                        });
                        if (d.success) {
                          invalidateCachePrefix("/api/invoices");
                          invalidateCachePrefix("/api/delivery-orders");
                          setTransferSuccess({ type: "inv", docNo: (d.data?.invoiceNo as string) || "Created" });
                          fetchAll();
                        } else {
                          toast.error(d.error || "Failed to create Invoice.");
                        }
                      } catch {
                        toast.error("Failed to create Invoice. Please try again.");
                      } finally {
                        setTransferLoading(false);
                      }
                    }}
                  >
                    {transferLoading ? "Creating..." : "Create Invoice"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* Scan PO Modal */}
      <ScanPOModal
        open={scanPOOpen}
        onClose={() => setScanPOOpen(false)}
        onCreated={(soIds) => {
          toast.success(`Created ${soIds.length} Sales Order(s) from PO scan`);
          fetchAll();
        }}
      />
    </div>
  );
}
