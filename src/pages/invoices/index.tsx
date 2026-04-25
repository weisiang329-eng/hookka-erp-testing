import { useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Plus,
  FileText,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  X,
  BarChart3,
  List,
} from "lucide-react";
import type { Invoice } from "@/lib/mock-data";

type AgingRow = {
  customerName: string;
  current: number;
  days31_60: number;
  days61_90: number;
  days90plus: number;
  total: number;
};

type CreateInvoiceResponse =
  | { success: true; data: { id: string } }
  | { success: false; error?: string };
type InvoiceMutationResponse = { success: true } | { success: false; error?: string };

function asCreateInvoiceResponse(v: unknown): CreateInvoiceResponse | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.success === true && o.data && typeof o.data === "object" && typeof (o.data as { id?: unknown }).id === "string") {
    return { success: true, data: { id: (o.data as { id: string }).id } };
  }
  if (o.success === false) return { success: false, error: typeof o.error === "string" ? o.error : undefined };
  return null;
}

function asInvoiceMutationResponse(v: unknown): InvoiceMutationResponse | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.success === true) return { success: true };
  if (o.success === false) return { success: false, error: typeof o.error === "string" ? o.error : undefined };
  return null;
}

// Page size 200 — client-side search only sees the current page, so big
// enough to fit typical working set in one go.
const PAGE_SIZE = 200;

export default function InvoicesPage() {
  const navigate = useNavigate();

  // Pagination — server-side. Filter changes reset to page 1 (see effect below).
  const [page, setPage] = useState(1);

  const { data: invResp, loading, refresh: refreshInvoices } = useCachedJson<{
    success?: boolean;
    data?: Invoice[];
    page?: number;
    limit?: number;
    total?: number;
  }>(`/api/invoices?page=${page}&limit=${PAGE_SIZE}`);
  // Whole-dataset status bucket counts — KPI cards read from this so they
  // reflect the full table, not just the current paginated page.
  const { data: invStatsResp, refresh: refreshInvStats } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    total?: number;
  }>("/api/invoices/stats");
  const invoices: Invoice[] = useMemo(
    () => (invResp?.success ? invResp.data ?? [] : Array.isArray(invResp) ? invResp : []),
    [invResp]
  );
  const totalInvoicesServer = invResp?.total ?? invoices.length;
  const totalPages = Math.max(1, Math.ceil(totalInvoicesServer / PAGE_SIZE));
  const [showCreateModal, setShowCreateModal] = useState(false);
  const { data: doResp, refresh: refreshDOs } = useCachedJson<{ success?: boolean; data?: { id: string; doNo: string; customerName: string; status: string }[] }>(showCreateModal ? "/api/delivery-orders" : null);
  const deliveryOrders = useMemo(() => {
    const all = doResp?.success ? doResp.data ?? [] : Array.isArray(doResp) ? doResp : [];
    return all.filter((o) => o.status === "DELIVERED" || o.status === "LOADED");
  }, [doResp]);
  const [selectedDOId, setSelectedDOId] = useState("");
  const [creating, setCreating] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Reset to page 1 when any filter changes (stale page could be empty).
  useEffect(() => {
    setPage(1);
  }, [filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  // Tabs
  const [activeTab, setActiveTab] = useState<"list" | "aging">("list");

  // Inline payment
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("BANK_TRANSFER");
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);

  const openCreate = () => {
    refreshDOs();
    setShowCreateModal(true);
  };

  const createInvoice = async () => {
    if (!selectedDOId) return;
    setCreating(true);
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryOrderId: selectedDOId }),
    });
    const data = asCreateInvoiceResponse(await res.json());
    setCreating(false);
    if (data?.success) {
      setShowCreateModal(false);
      setSelectedDOId("");
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/delivery-orders");
      invalidateCachePrefix("/api/sales-orders");
      refreshInvoices();
      refreshInvStats();
      navigate(`/invoices/${data.data.id}`);
    }
  };

  const advanceStatus = async (inv: Invoice, newStatus: string) => {
    const res = await fetch(`/api/invoices/${inv.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    const data = asInvoiceMutationResponse(await res.json());
    if (data?.success) {
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/delivery-orders");
      invalidateCachePrefix("/api/sales-orders");
      refreshInvoices();
      refreshInvStats();
    }
  };

  const recordPayment = async (inv: Invoice) => {
    const amountSen = Math.round(parseFloat(paymentAmount) * 100);
    if (isNaN(amountSen) || amountSen <= 0) return;

    setPaymentSubmitting(true);
    const totalPaid = inv.paidAmount + amountSen;
    const res = await fetch(`/api/invoices/${inv.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paidAmount: totalPaid,
        paymentMethod,
        paymentDate,
        paymentReference,
      }),
    });
    const data = asInvoiceMutationResponse(await res.json());
    if (data?.success) {
      setPayingInvoiceId(null);
      setPaymentAmount("");
      setPaymentReference("");
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/delivery-orders");
      invalidateCachePrefix("/api/sales-orders");
      refreshInvoices();
      refreshInvStats();
    }
    setPaymentSubmitting(false);
  };

  // Unique customers for filter
  const customerNames = useMemo(
    () => [...new Set(invoices.map((inv) => inv.customerName))].sort(),
    [invoices]
  );

  // Filtered invoices
  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      if (filterStatus && inv.status !== filterStatus) return false;
      if (filterCustomer && inv.customerName !== filterCustomer) return false;
      if (filterDateFrom && inv.invoiceDate < filterDateFrom) return false;
      if (filterDateTo && inv.invoiceDate > filterDateTo) return false;
      return true;
    });
  }, [invoices, filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  // KPI calculations. Count-based KPIs (Total, Overdue) read from the
  // server /stats aggregate so they reflect the whole dataset. Dollar KPIs
  // (Outstanding, Collected MTD) still iterate the current page because
  // they need per-row totalSen/paidAmount — documented in the footer's
  // total-count badge.
  const invStatsByStatus = invStatsResp?.byStatus ?? {};
  const totalInvoices = invStatsResp?.total ?? totalInvoicesServer;
  const outstandingSen = invoices
    .filter((inv) => ["SENT", "OVERDUE", "PARTIAL_PAID"].includes(inv.status))
    .reduce((s, inv) => s + (inv.totalSen - inv.paidAmount), 0);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const paidMTDSen = invoices
    .filter((inv) => inv.status === "PAID" && inv.invoiceDate.startsWith(currentMonth))
    .reduce((s, inv) => s + inv.paidAmount, 0);
  // OVERDUE is a first-class status in the invoices table (advanced by the
  // backend when dueDate passes). Use the stats bucket rather than iterating
  // the current page, so the KPI reflects the whole dataset.
  const overdueCount = invStatsByStatus.OVERDUE ?? 0;

  // AR Aging data
  const agingData = useMemo((): AgingRow[] => {
    const today = new Date();
    const customerMap: Record<string, AgingRow> = {};

    invoices
      .filter((inv) => !["PAID", "CANCELLED", "DRAFT"].includes(inv.status))
      .forEach((inv) => {
        const balance = inv.totalSen - inv.paidAmount;
        if (balance <= 0) return;

        const dueDate = new Date(inv.dueDate);
        const daysOverdue = Math.floor(
          (today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (!customerMap[inv.customerName]) {
          customerMap[inv.customerName] = {
            customerName: inv.customerName,
            current: 0,
            days31_60: 0,
            days61_90: 0,
            days90plus: 0,
            total: 0,
          };
        }

        const row = customerMap[inv.customerName];
        if (daysOverdue <= 0) {
          row.current += balance;
        } else if (daysOverdue <= 30) {
          row.current += balance;
        } else if (daysOverdue <= 60) {
          row.days31_60 += balance;
        } else if (daysOverdue <= 90) {
          row.days61_90 += balance;
        } else {
          row.days90plus += balance;
        }
        row.total += balance;
      });

    return Object.values(customerMap).sort((a, b) => b.total - a.total);
  }, [invoices]);

  const agingTotals = useMemo(() => {
    return agingData.reduce(
      (acc, row) => ({
        current: acc.current + row.current,
        days31_60: acc.days31_60 + row.days31_60,
        days61_90: acc.days61_90 + row.days61_90,
        days90plus: acc.days90plus + row.days90plus,
        total: acc.total + row.total,
      }),
      { current: 0, days31_60: 0, days61_90: 0, days90plus: 0, total: 0 }
    );
  }, [agingData]);

  // ---------- Invoice DataGrid Columns ----------
  const invoiceGridColumns: Column<Invoice>[] = useMemo(() => [
    { key: "invoiceNo", label: "Invoice No", type: "docno", width: "120px", sortable: true },
    { key: "doNo", label: "DO No", type: "docno", width: "120px", sortable: true },
    { key: "customerName", label: "Customer", type: "text", sortable: true },
    { key: "invoiceDate", label: "Invoice Date", type: "date", width: "110px", sortable: true },
    { key: "dueDate", label: "Due Date", type: "date", width: "110px", sortable: true },
    { key: "totalSen", label: "Total", type: "currency", width: "120px", sortable: true },
    { key: "paidAmount", label: "Paid", type: "currency", width: "120px", sortable: true,
      render: (value: number) => (
        <span className="text-[#4F7C3A] tabular-nums">{value > 0 ? formatCurrency(value) : "-"}</span>
      ),
    },
    { key: "status", label: "Status", type: "status", width: "110px", sortable: true },
  ], []);

  const invoiceGridContextMenu = useCallback((row: Invoice): ContextMenuItem[] => [
    { label: "View", action: () => navigate(`/invoices/${row.id}`) },
    { label: "Print Invoice", action: () => navigate(`/invoices/${row.id}`) },
    { label: "", separator: true, action: () => {} },
    { label: "Record Payment", action: () => {
        const balance = row.totalSen - row.paidAmount;
        setPaymentAmount(String(balance / 100));
        setPaymentDate(new Date().toISOString().split("T")[0]);
        setPaymentReference("");
        setPaymentMethod("BANK_TRANSFER");
        setPayingInvoiceId(row.id);
      },
      disabled: !["SENT", "PARTIAL_PAID"].includes(row.status),
    },
    { label: "", separator: true, action: () => {} },
    { label: "Send to Customer", action: () => advanceStatus(row, "SENT"),
      disabled: row.status !== "DRAFT",
    },
    { label: "", separator: true, action: () => {} },
    { label: "Refresh", action: () => { refreshInvoices(); refreshInvStats(); } },
  ], [navigate, refreshInvoices, refreshInvStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6B7280]">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Invoices</h1>
          <p className="text-xs text-[#6B7280]">
            Invoice management, billing, and payment tracking
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New Invoice
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Invoices</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{totalInvoices}</p>
            </div>
            <FileText className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Outstanding</p>
              <p className="text-xl font-bold text-[#1F1D1B]">
                {formatCurrency(outstandingSen)}
              </p>
            </div>
            <DollarSign className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Collected (MTD)</p>
              <p className="text-xl font-bold text-[#4F7C3A]">
                {formatCurrency(paidMTDSen)}
              </p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Overdue</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{overdueCount}</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        <button
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "list"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
          onClick={() => setActiveTab("list")}
        >
          <List className="h-4 w-4" />
          Invoices
        </button>
        <button
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "aging"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
          onClick={() => setActiveTab("aging")}
        >
          <BarChart3 className="h-4 w-4" />
          AR Aging
        </button>
      </div>

      {activeTab === "list" && (
        <>
          {/* Filters */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    Status
                  </label>
                  <select
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                  >
                    <option value="">All Statuses</option>
                    <option value="DRAFT">Draft</option>
                    <option value="SENT">Sent</option>
                    <option value="PARTIAL_PAID">Partial Paid</option>
                    <option value="PAID">Paid</option>
                    <option value="OVERDUE">Overdue</option>
                    <option value="CANCELLED">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    Customer
                  </label>
                  <select
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterCustomer}
                    onChange={(e) => setFilterCustomer(e.target.value)}
                  >
                    <option value="">All Customers</option>
                    {customerNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    From Date
                  </label>
                  <input
                    type="date"
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    To Date
                  </label>
                  <input
                    type="date"
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                  />
                </div>
                {(filterStatus || filterCustomer || filterDateFrom || filterDateTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[#6B7280]"
                    onClick={() => {
                      setFilterStatus("");
                      setFilterCustomer("");
                      setFilterDateFrom("");
                      setFilterDateTo("");
                    }}
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Invoice Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-[#6B5C32]" />
                All Invoices
                {(filterStatus || filterCustomer || filterDateFrom || filterDateTo) && (
                  <span className="text-sm font-normal text-[#6B7280]">
                    ({filteredInvoices.length} of {invoices.length})
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DataGrid<Invoice>
                columns={invoiceGridColumns}
                data={filteredInvoices}
                keyField="id"
                onDoubleClick={(row) => navigate(`/invoices/${row.id}`)}
                contextMenuItems={invoiceGridContextMenu}
                maxHeight="calc(100vh - 300px)"
                emptyMessage="No invoices found."
              />

              {/* Pagination footer */}
              <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280]">
                <span>
                  {totalInvoicesServer.toLocaleString()} invoice
                  {totalInvoicesServer === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
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
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages || loading}
                  >
                    Next →
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "aging" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
              Accounts Receivable Aging Report
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agingData.length === 0 ? (
              <p className="text-sm text-[#6B7280] text-center py-8">
                No outstanding invoices found.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Customer
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#4F7C3A]">
                        Current (0-30)
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#9C6F1E]">
                        31-60 Days
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#B8601A]">
                        61-90 Days
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#9A3A2D]">
                        90+ Days
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#1F1D1B]">
                        Total Outstanding
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {agingData.map((row) => (
                      <tr
                        key={row.customerName}
                        className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
                      >
                        <td className="py-3 px-4 font-medium text-[#1F1D1B]">
                          {row.customerName}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.current > 0 ? "text-[#4F7C3A] font-medium" : "text-[#9CA3AF]"}>
                            {row.current > 0 ? formatCurrency(row.current) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.days31_60 > 0 ? "text-[#9C6F1E] font-medium" : "text-[#9CA3AF]"}>
                            {row.days31_60 > 0 ? formatCurrency(row.days31_60) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.days61_90 > 0 ? "text-[#B8601A] font-medium" : "text-[#9CA3AF]"}>
                            {row.days61_90 > 0 ? formatCurrency(row.days61_90) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.days90plus > 0 ? "text-[#9A3A2D] font-medium" : "text-[#9CA3AF]"}>
                            {row.days90plus > 0 ? formatCurrency(row.days90plus) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-[#1F1D1B]">
                          {formatCurrency(row.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[#6B5C32] bg-[#F0ECE9]">
                      <td className="py-3 px-4 font-bold text-[#6B5C32]">TOTAL</td>
                      <td className="py-3 px-4 text-right font-bold text-[#4F7C3A]">
                        {agingTotals.current > 0 ? formatCurrency(agingTotals.current) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#9C6F1E]">
                        {agingTotals.days31_60 > 0 ? formatCurrency(agingTotals.days31_60) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#B8601A]">
                        {agingTotals.days61_90 > 0 ? formatCurrency(agingTotals.days61_90) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#9A3A2D]">
                        {agingTotals.days90plus > 0 ? formatCurrency(agingTotals.days90plus) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#1F1D1B] text-base">
                        {formatCurrency(agingTotals.total)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Inline Payment Modal */}
      {payingInvoiceId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            {(() => {
              const inv = invoices.find((i) => i.id === payingInvoiceId);
              if (!inv) return null;
              const balance = inv.totalSen - inv.paidAmount;
              return (
                <>
                  <h2 className="text-lg font-bold text-[#1F1D1B] mb-1">
                    Record Payment
                  </h2>
                  <p className="text-sm text-[#6B7280] mb-4">
                    {inv.invoiceNo} - {inv.customerName}
                  </p>
                  <p className="text-sm text-[#6B7280] mb-4">
                    Balance due:{" "}
                    <span className="font-bold text-[#9A3A2D]">
                      {formatCurrency(balance)}
                    </span>
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Payment Amount (RM)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Payment Date
                      </label>
                      <input
                        type="date"
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        value={paymentDate}
                        onChange={(e) => setPaymentDate(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Reference (Cheque No / Transfer Ref)
                      </label>
                      <input
                        type="text"
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        placeholder="e.g. CHQ-001234 or TRF-20260414"
                        value={paymentReference}
                        onChange={(e) => setPaymentReference(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Payment Method
                      </label>
                      <select
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                      >
                        <option value="CASH">Cash</option>
                        <option value="CHEQUE">Cheque</option>
                        <option value="BANK_TRANSFER">Bank Transfer</option>
                        <option value="CREDIT_CARD">Credit Card</option>
                        <option value="E_WALLET">E-Wallet</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 mt-6">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setPayingInvoiceId(null);
                        setPaymentAmount("");
                        setPaymentReference("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => recordPayment(inv)}
                      disabled={
                        paymentSubmitting ||
                        !paymentAmount ||
                        parseFloat(paymentAmount) <= 0
                      }
                    >
                      {paymentSubmitting ? "Processing..." : "Record Payment"}
                    </Button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Create Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-[#1F1D1B] mb-4">
              Create Invoice from Delivery Order
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#4B5563] mb-1">
                  Select Delivery Order
                </label>
                <select
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                  value={selectedDOId}
                  onChange={(e) => setSelectedDOId(e.target.value)}
                >
                  <option value="">-- Select DO --</option>
                  {deliveryOrders.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.doNo} - {d.customerName}
                    </option>
                  ))}
                </select>
                {deliveryOrders.length === 0 && (
                  <p className="text-xs text-[#9CA3AF] mt-1">
                    No eligible delivery orders found (DELIVERED or LOADED status required)
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreateModal(false);
                  setSelectedDOId("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={createInvoice}
                disabled={!selectedDOId || creating}
              >
                {creating ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
