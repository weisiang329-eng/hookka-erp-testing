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
import type { Supplier } from "@/types";
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
  Download,
  Plus,
  ScanLine,
  FolderInput,
  List,
} from "lucide-react";
import {
  FromSourceModal,
  type SourceSelection,
} from "@/components/from-source-modal";

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

  // Tabs — single "Purchase Invoices" tab, same skeleton as Sales Invoice list
  const [activeTab] = useState<"list">("list");

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // From PO / GRN picker
  const [fromSourceOpen, setFromSourceOpen] = useState(false);
  const handleFromSource = (sel: SourceSelection) => {
    const param =
      sel.type === "po" ? `poId=${sel.id}` : `grnId=${sel.id}`;
    navigate(`/procurement/pi/create?${param}`);
  };

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

  // Suppliers populate the create dialog's supplier picker. Lazy-loaded the
  // same way procurement/create.tsx does — the cache is shared so the PO
  // create page warms it too.
  const { data: supResp } = useCachedJson<{
    success?: boolean;
    data?: Supplier[];
  }>("/api/suppliers");
  const suppliers: Supplier[] = useMemo(
    () => supResp?.data ?? [],
    [supResp],
  );
  // Purchase Company letterhead registry — print each PI under its supplier's
  // buying company (accounting stays HOOKKA).
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");

  const updateStatus = useCallback(
    async (id: string, nextStatus: PIStatus, extra?: Record<string, unknown>) => {
      try {
        const res = await fetch(`/api/purchase-invoices/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...extra, status: nextStatus }),
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
        // List rows are lean (no items[]), so fetch the full PI before printing.
        action: async () => {
          try {
            const res = await fetch(`/api/purchase-invoices/${row.id}`);
            const j = (await res.json().catch(() => null)) as
              | { success?: boolean; data?: Record<string, unknown> }
              | null;
            if (!res.ok || !j?.success || !j.data) {
              toast.error("Could not load the invoice to print.");
              return;
            }
            const [{ generatePurchaseInvoicePdf }, { letterheadForPurchaseOrg }] = await Promise.all([
              import("@/lib/generate-purchase-invoice-pdf"),
              import("@/lib/generate-purchase-order-pdf"),
            ]);
            const supId = (j.data as { supplierId?: string }).supplierId;
            const sup = suppliers.find((s) => s.id === supId);
            const lh = letterheadForPurchaseOrg(sup?.purchaseOrgCode || "HOOKKA", orgsResp?.organisations);
            generatePurchaseInvoicePdf(
              {
                ...(j.data as unknown as Parameters<typeof generatePurchaseInvoicePdf>[0]),
                supplierAddress: sup?.address,
                supplierContact: sup?.contactPerson,
                supplierPhone: sup?.phone,
                supplierEmail: sup?.email,
              },
              lh,
            );
          } catch {
            toast.error("Could not generate the PDF.");
          }
        },
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
        action: () => {
          // Phase 3.6 — a foreign PI settles at the PAYMENT-DAY rate; the
          // realised difference vs the booking rate posts to 530-0000.
          const fx = row as unknown as { currency?: string; fxRate?: number | null };
          if (fx.currency && fx.currency !== "MYR") {
            const r = parseFloat(window.prompt(
              `${fx.currency} invoice — payment-day rate (MYR per 1 ${fx.currency}; booked at ${fx.fxRate ?? "?"}):`,
              String(fx.fxRate ?? ""),
            ) || "");
            if (!Number.isFinite(r) || r <= 0) return;
            updateStatus(row.id, "PAID", { payFxRate: r });
          } else {
            updateStatus(row.id, "PAID");
          }
        },
        disabled: row.status !== "APPROVED",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ];
  }, [navigate, toast, fetchData, updateStatus, suppliers, orgsResp]);

  // Shell renders immediately — grid shows skeleton rows (loading prop) until
  // data lands. Mirrors the Sales Invoice list (no full-page loading gate).
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Purchase Invoices</h1>
          <p className="text-xs text-[#6B7280]">Track supplier invoices and payment status</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => navigate("/procurement/pi/create?scan=1")}
          >
            <ScanLine className="h-4 w-4" /> Scan PI
          </Button>
          <Button
            variant="outline"
            onClick={() => setFromSourceOpen(true)}
            title="Import from a Purchase Order or Goods Receipt"
          >
            <FolderInput className="h-4 w-4" /> From PO / GRN
          </Button>
          <Button variant="primary" onClick={() => navigate("/procurement/pi/create")}>
            <Plus className="h-4 w-4" /> Create Invoice
          </Button>
        </div>
      </div>

      {/* KPI Cards — gold card style: p-4 flex items-center gap-3, colored icon-box left, text-2xl font-bold */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <FileText className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">{totalPIs}</p>
              <p className="text-xs text-[#6B7280]">Total PIs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0">
              <Clock className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9C6F1E]">{pendingPayment}</p>
              <p className="text-xs text-[#6B7280]">Pending Payment</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FDECEA] p-2.5 shrink-0">
              <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9A3A2D]">{overdue}</p>
              <p className="text-xs text-[#6B7280]">Overdue</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <DollarSign className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-bold text-[#1F1D1B] truncate">{formatCurrency(totalValueSen)}</p>
              <p className="text-xs text-[#6B7280]">Total Value</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs — single tab bar matching Sales Invoice list skeleton */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        <button
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "list"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
        >
          <List className="h-4 w-4" />
          Purchase Invoices
        </button>
      </div>

      {activeTab === "list" && (
        <>
          {/* Status Pipeline */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between overflow-x-auto gap-2">
                {statusCounts.map((s, i) => (
                  <div key={s.label} className="flex items-center gap-2">
                    <div
                      className="text-center min-w-[80px] cursor-pointer"
                      onClick={() => setFilterStatus(filterStatus === s.status ? "" : s.status)}
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

          {/* Filters — always-visible, matching Sales Invoice list style */}
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
                    {ALL_PI_STATUSES.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    Supplier
                  </label>
                  <select
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterSupplier}
                    onChange={(e) => setFilterSupplier(e.target.value)}
                  >
                    <option value="">All Suppliers</option>
                    {uniqueSuppliers.map(([id, name]) => (
                      <option key={id} value={id}>{name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    From Date
                  </label>
                  <Input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    To Date
                  </label>
                  <Input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                  />
                </div>
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[#6B7280]"
                    onClick={clearFilters}
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* PI DataGrid */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-[#6B5C32]" />
                  All Purchase Invoices
                  {hasActiveFilters && (
                    <span className="text-sm font-normal text-[#6B7280]">
                      ({filteredInvoices.length} of {invoices.length})
                    </span>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={exportCSV}>
                  <Download className="h-4 w-4" /> Export CSV
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DataGrid<PurchaseInvoice>
                columns={piGridColumns}
                data={filteredInvoices}
                keyField="id"
                virtualize
                loading={loading}
                stickyHeader={true}
                onDoubleClick={(row) => navigate(`/procurement/pi/${row.id}`)}
                contextMenuItems={piGridContextMenu}
                maxHeight="calc(100vh - 300px)"
                emptyMessage="No purchase invoices found."
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* From PO / GRN picker — navigates to PI create with pre-fill param */}
      <FromSourceModal
        open={fromSourceOpen}
        onClose={() => setFromSourceOpen(false)}
        onSelect={handleFromSource}
      />
    </div>
  );
}
