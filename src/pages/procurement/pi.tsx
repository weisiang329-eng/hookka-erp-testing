import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  FileText,
  Clock,
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  X,
  Eye,
  Printer,
  RefreshCw,
  ArrowRight,
  Filter,
  Download,
} from "lucide-react";

// ============================================================
// Types
// ============================================================
type PIStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "PAID";

type PurchaseInvoice = {
  id: string;
  piNo: string;
  poRef: string;
  supplierId: string;
  supplier: string;
  invoiceDate: string;
  dueDate: string;
  amountSen: number;
  status: PIStatus;
  remarks: string;
};

// ============================================================
// STATUS OPTIONS
// ============================================================
const ALL_PI_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending Approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "PAID", label: "Paid" },
];

// ============================================================
// MAIN PAGE
// ============================================================
export default function PurchaseInvoicesPage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Wired to /api/purchase-invoices 2026-04-26 — replaces the previous
  // generateMockPIs + invoiceOverrides client-side state. Status changes
  // (Approve / Mark Paid) now PUT through the real backend so refreshes
  // and other tabs see the same data.
  const { data: piResp, loading, refresh: fetchData } = useCachedJson<{
    success?: boolean;
    data?: PurchaseInvoice[];
  }>("/api/purchase-invoices");
  const invoices: PurchaseInvoice[] = useMemo(
    () => piResp?.data ?? [],
    [piResp],
  );

  const updateStatus = useCallback(
    async (id: string, nextStatus: PIStatus) => {
      try {
        const res = await fetch(`/api/purchase-invoices/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        const j = (await res.json().catch(() => null)) as
          | { success?: boolean; error?: string }
          | null;
        if (!res.ok || !j?.success) {
          toast.error(j?.error || `Failed to update PI to ${nextStatus}`);
          return;
        }
        invalidateCachePrefix("/api/purchase-invoices");
        fetchData();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update PI");
      }
    },
    [toast, fetchData],
  );

  // ---- Filters ----
  const hasActiveFilters = filterStatus || filterSupplier || filterDateFrom || filterDateTo;

  const clearFilters = () => {
    setFilterStatus("");
    setFilterSupplier("");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const filteredInvoices = useMemo(() => {
    return invoices.filter(pi => {
      if (filterStatus && pi.status !== filterStatus) return false;
      if (filterSupplier && pi.supplierId !== filterSupplier) return false;
      if (filterDateFrom && pi.invoiceDate < filterDateFrom) return false;
      if (filterDateTo && pi.invoiceDate > filterDateTo) return false;
      return true;
    });
  }, [invoices, filterStatus, filterSupplier, filterDateFrom, filterDateTo]);

  // ---- Export CSV ----
  const exportCSV = () => {
    const headers = ["PI No.", "PO Ref", "Supplier", "Invoice Date", "Due Date", "Amount (RM)", "Status"];
    const rows = filteredInvoices.map(pi => [
      pi.piNo,
      pi.poRef,
      pi.supplier,
      pi.invoiceDate,
      pi.dueDate,
      (pi.amountSen / 100).toFixed(2),
      pi.status,
    ]);
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `purchase-invoices-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- Summary stats ----
  const totalPIs = invoices.length;
  const pendingPayment = invoices.filter(pi => pi.status === "PENDING_APPROVAL" || pi.status === "DRAFT").length;
  const today = new Date().toISOString().split("T")[0];
  const overdue = invoices.filter(pi => pi.status !== "PAID" && pi.dueDate < today).length;
  const totalValueSen = invoices.reduce((sum, pi) => sum + pi.amountSen, 0);

  // ---- Status pipeline ----
  const statusCounts = [
    { label: "Draft", status: "DRAFT", count: invoices.filter(pi => pi.status === "DRAFT").length },
    { label: "Pending Approval", status: "PENDING_APPROVAL", count: invoices.filter(pi => pi.status === "PENDING_APPROVAL").length },
    { label: "Approved", status: "APPROVED", count: invoices.filter(pi => pi.status === "APPROVED").length },
    { label: "Paid", status: "PAID", count: invoices.filter(pi => pi.status === "PAID").length },
  ];

  // ---- Unique suppliers ----
  const uniqueSuppliers = useMemo(() => {
    const map = new Map<string, string>();
    for (const pi of invoices) {
      if (pi.supplierId && pi.supplier) {
        map.set(pi.supplierId, pi.supplier);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [invoices]);

  // ---- Columns ----
  const piGridColumns: Column<PurchaseInvoice>[] = useMemo(() => [
    { key: "piNo", label: "PI No.", type: "docno", width: "130px", sortable: true },
    { key: "poRef", label: "PO Ref", type: "docno", width: "130px", sortable: true },
    { key: "supplier", label: "Supplier", type: "text", sortable: true },
    { key: "invoiceDate", label: "Invoice Date", type: "date", width: "120px", sortable: true },
    { key: "dueDate", label: "Due Date", type: "date", width: "120px", sortable: true },
    { key: "amountSen", label: "Amount", type: "currency", width: "130px", sortable: true },
    { key: "status", label: "Status", type: "status", width: "140px", sortable: true },
  ], []);

  const piGridContextMenu = useCallback((row: PurchaseInvoice): ContextMenuItem[] => {
    return [
      {
        label: "View",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => navigate(`/procurement/pi/${row.id}`),
      },
      {
        label: "Print PI",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => toast.info(`Print PI ${row.piNo} — coming soon`),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Submit for Approval",
        icon: <ArrowRight className="h-3.5 w-3.5" />,
        action: () => updateStatus(row.id, "PENDING_APPROVAL"),
        disabled: row.status !== "DRAFT",
      },
      {
        label: "Approve",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: () => updateStatus(row.id, "APPROVED"),
        // Backend transitions allow both DRAFT→APPROVED and PENDING_APPROVAL
        // →APPROVED. Match here so the menu doesn't ghost the option for an
        // operator who skipped the review step.
        disabled: row.status !== "PENDING_APPROVAL" && row.status !== "DRAFT",
      },
      {
        label: "Mark Paid",
        icon: <DollarSign className="h-3.5 w-3.5" />,
        action: () => updateStatus(row.id, "PAID"),
        disabled: row.status !== "APPROVED",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ];
  }, [navigate, toast, fetchData, updateStatus]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Purchase Invoices</h1>
          <p className="text-xs text-[#6B7280]">Track supplier invoices and payment status</p>
        </div>
      </div>

      {/* Status Pipeline */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between overflow-x-auto gap-2">
            {statusCounts.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <div
                  className="text-center min-w-[80px] cursor-pointer"
                  onClick={() => { setFilterStatus(filterStatus === s.status ? "" : s.status); setShowFilters(true); }}
                >
                  <Badge variant="status" status={s.status}>{s.count}</Badge>
                  <p className={`text-xs mt-1 ${filterStatus === s.status ? "text-[#6B5C32] font-medium" : "text-[#6B7280]"}`}>{s.label}</p>
                </div>
                {i < statusCounts.length - 1 && <ArrowRight className="h-4 w-4 text-[#D1CBC5] shrink-0" />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total PIs</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{totalPIs}</p>
            </div>
            <FileText className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Pending Payment</p>
              <p className="text-xl font-bold text-amber-600">{pendingPayment}</p>
            </div>
            <Clock className="h-5 w-5 text-amber-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Overdue</p>
              <p className={`text-xl font-bold ${overdue > 0 ? "text-red-600" : "text-[#1F1D1B]"}`}>{overdue}</p>
            </div>
            <AlertTriangle className={`h-5 w-5 ${overdue > 0 ? "text-red-500" : "text-[#E2DDD8]"}`} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Value</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{formatCurrency(totalValueSen)}</p>
            </div>
            <DollarSign className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
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
                  Showing {filteredInvoices.length} of {invoices.length} invoices
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </div>

          {showFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-3 border-t border-[#E2DDD8]">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  {ALL_PI_STATUSES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Supplier</label>
                <select
                  value={filterSupplier}
                  onChange={(e) => setFilterSupplier(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Suppliers</option>
                  {uniqueSuppliers.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date From</label>
                <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date To</label>
                <Input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PI DataGrid */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-[#6B5C32]" />
            Purchase Invoices
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<PurchaseInvoice>
            columns={piGridColumns}
            data={filteredInvoices}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            onDoubleClick={(row) => navigate(`/procurement/pi/${row.id}`)}
            contextMenuItems={piGridContextMenu}
            maxHeight="calc(100vh - 300px)"
            emptyMessage="No purchase invoices found."
          />
        </CardContent>
      </Card>
    </div>
  );
}
