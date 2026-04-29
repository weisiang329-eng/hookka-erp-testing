import { useState, useEffect, useCallback, useMemo } from "react";
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
import type { GoodsReceiptNote, PurchaseOrder } from "@/types";
import {
  Plus,
  Package,
  ClipboardCheck,
  CheckCircle2,
  X,
  Eye,
  Printer,
  RefreshCw,
  ArrowRight,
  Filter,
  Download,
  DollarSign,
} from "lucide-react";

function readErrorMessage(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const err = (v as { error?: unknown }).error;
  return typeof err === "string" ? err : null;
}

// ============================================================
// GRN FORM DIALOG (Transfer from PO)
// ============================================================
function GRNFormDialog({
  purchaseOrders,
  onSave,
  onClose,
}: {
  purchaseOrders: PurchaseOrder[];
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [selectedPO, setSelectedPO] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [itemEntries, setItemEntries] = useState<
    {
      poItemIndex: number;
      receivedQty: number;
      acceptedQty: number;
      rejectedQty: number;
      rejectionReason: string;
    }[]
  >([]);

  const po = purchaseOrders.find((p) => p.id === selectedPO);

  /* eslint-disable react-hooks/set-state-in-effect -- seed item entries from the selected PO when the user picks one */
  useEffect(() => {
    if (po) {
      setItemEntries(
        po.items.map((item, idx) => ({
          poItemIndex: idx,
          receivedQty: item.quantity,
          acceptedQty: item.quantity,
          rejectedQty: 0,
          rejectionReason: "",
        }))
      );
    } else {
      setItemEntries([]);
    }
  }, [selectedPO, po]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateItem = (idx: number, field: string, value: number | string) => {
    const updated = [...itemEntries];
    updated[idx] = { ...updated[idx], [field]: value };
    if (field === "receivedQty" || field === "rejectedQty") {
      const recv = field === "receivedQty" ? (value as number) : updated[idx].receivedQty;
      const rej = field === "rejectedQty" ? (value as number) : updated[idx].rejectedQty;
      updated[idx].acceptedQty = Math.max(0, recv - rej);
    }
    setItemEntries(updated);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!po) return;
    onSave({
      poId: po.id,
      receivedBy,
      notes,
      items: itemEntries.filter((ie) => ie.receivedQty > 0),
    });
  };

  const eligiblePOs = purchaseOrders.filter(
    (p) => p.status === "CONFIRMED" || p.status === "PARTIAL_RECEIVED" || p.status === "SUBMITTED"
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Create Goods Receipt Note</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Purchase Order *</label>
              <select
                className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                value={selectedPO}
                onChange={(e) => setSelectedPO(e.target.value)}
                required
              >
                <option value="">Select PO...</option>
                {eligiblePOs.map((p) => (
                  <option key={p.id} value={p.id}>{p.poNo} - {p.supplierName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Received By *</label>
              <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="e.g. Ahmad bin Ismail" required />
            </div>
          </div>

          {po && (
            <div>
              <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Items - Enter Received Quantities</h3>
              <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#F0ECE9]">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-[#374151]">Material</th>
                      <th className="text-right px-3 py-2 font-medium text-[#374151]">Ordered</th>
                      <th className="text-right px-3 py-2 font-medium text-[#374151]">Received</th>
                      <th className="text-right px-3 py-2 font-medium text-[#374151]">Rejected</th>
                      <th className="text-right px-3 py-2 font-medium text-[#374151]">Accepted</th>
                      <th className="text-left px-3 py-2 font-medium text-[#374151]">Rejection Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((poItem, idx) => {
                      const entry = itemEntries[idx];
                      if (!entry) return null;
                      const overReceipt = entry.receivedQty > poItem.quantity * 1.1;
                      return (
                        <tr key={idx} className="border-t border-[#E2DDD8]">
                          <td className="px-3 py-2">
                            <div className="font-medium">{poItem.materialName}</div>
                            <div className="text-xs text-gray-500">{poItem.supplierSKU}</div>
                          </td>
                          <td className="px-3 py-2 text-right">{poItem.quantity} {poItem.unit}</td>
                          <td className="px-3 py-2 text-right">
                            <Input type="number" min={0} className={`w-20 text-right ml-auto ${overReceipt ? "border-[#9A3A2D]" : ""}`}
                              value={entry.receivedQty} onChange={(e) => updateItem(idx, "receivedQty", Number(e.target.value))} />
                            {overReceipt && <div className="text-[10px] text-[#9A3A2D] mt-0.5">Exceeds 110%</div>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input type="number" min={0} max={entry.receivedQty} className="w-20 text-right ml-auto"
                              value={entry.rejectedQty} onChange={(e) => updateItem(idx, "rejectedQty", Number(e.target.value))} />
                          </td>
                          <td className="px-3 py-2 text-right font-medium">{entry.acceptedQty}</td>
                          <td className="px-3 py-2">
                            {entry.rejectedQty > 0 && (
                              <Input placeholder="Reason..." className="text-xs" value={entry.rejectionReason}
                                onChange={(e) => updateItem(idx, "rejectionReason", e.target.value)} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">Notes</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes..." />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-[#E2DDD8]">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!po || itemEntries.every((ie) => ie.receivedQty === 0)}>
              Create GRN
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// STATUS OPTIONS
// ============================================================
const ALL_GRN_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING", label: "QC Pending" },
  { value: "CONFIRMED", label: "Approved" },
  { value: "POSTED", label: "Posted" },
];

// ============================================================
// MAIN GRN PAGE
// ============================================================
export default function GRNPage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Dialog
  const [showForm, setShowForm] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const { data: grnResp, loading: grnLoading, refresh: refreshGrns } = useCachedJson<{ success?: boolean; data?: GoodsReceiptNote[] } | GoodsReceiptNote[]>("/api/grn");
  const { data: poResp, loading: poLoading, refresh: refreshPOs } = useCachedJson<{ success?: boolean; data?: PurchaseOrder[] } | PurchaseOrder[]>("/api/purchase-orders");

  const grns: GoodsReceiptNote[] = useMemo(
    () => ((grnResp as { data?: GoodsReceiptNote[] } | undefined)?.data ?? (Array.isArray(grnResp) ? grnResp : [])),
    [grnResp]
  );
  const purchaseOrders: PurchaseOrder[] = useMemo(
    () => ((poResp as { data?: PurchaseOrder[] } | undefined)?.data ?? (Array.isArray(poResp) ? poResp : [])),
    [poResp]
  );

  const loading = grnLoading || poLoading;

  const fetchData = useCallback(() => {
    refreshGrns();
    refreshPOs();
  }, [refreshGrns, refreshPOs]);

  const handleCreateGRN = async (data: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/grn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        invalidateCachePrefix("/api/grns");
        invalidateCachePrefix("/api/purchase-orders");
        invalidateCachePrefix("/api/inventory");
        invalidateCachePrefix("/api/raw-materials");
        refreshGrns();
        refreshPOs();
        setShowForm(false);
      } else {
        const err = await res.json();
        toast.error(readErrorMessage(err) || "Failed to create GRN");
      }
    } catch {
      toast.error("Failed to create GRN");
    }
  };

  // ---- Filters ----
  const hasActiveFilters = filterStatus || filterSupplier || filterDateFrom || filterDateTo;

  const clearFilters = () => {
    setFilterStatus("");
    setFilterSupplier("");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const filteredGRNs = useMemo(() => {
    return grns.filter(grn => {
      if (filterStatus) {
        // Map QC status filter
        if (filterStatus === "PENDING" && grn.qcStatus !== "PENDING") return false;
        if (filterStatus !== "PENDING" && grn.status !== filterStatus) return false;
      }
      if (filterSupplier && grn.supplierId !== filterSupplier) return false;
      if (filterDateFrom) {
        const rd = grn.receiveDate?.split("T")[0] ?? "";
        if (rd < filterDateFrom) return false;
      }
      if (filterDateTo) {
        const rd = grn.receiveDate?.split("T")[0] ?? "";
        if (rd > filterDateTo) return false;
      }
      return true;
    });
  }, [grns, filterStatus, filterSupplier, filterDateFrom, filterDateTo]);

  // ---- Export CSV ----
  const exportCSV = () => {
    const headers = ["GRN No.", "PO No.", "Supplier", "Receive Date", "Items", "Total (RM)", "QC Status", "Status"];
    const rows = filteredGRNs.map(grn => [
      grn.grnNumber,
      grn.poNumber,
      grn.supplierName,
      grn.receiveDate?.split("T")[0] ?? "",
      grn.items.length.toString(),
      (grn.totalAmount / 100).toFixed(2),
      grn.qcStatus,
      grn.status,
    ]);
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `grn-list-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- Summary stats ----
  const totalGRNs = grns.length;
  const pendingQC = grns.filter((g) => g.qcStatus === "PENDING").length;
  const now = new Date();
  const mtdStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const approvedMTD = grns.filter((g) => g.status === "CONFIRMED" && (g.receiveDate ?? "") >= mtdStart).length;
  const totalValueSen = grns.reduce((sum, g) => sum + g.totalAmount, 0);

  // ---- Status pipeline ----
  const statusCounts = [
    { label: "Draft", status: "DRAFT", count: grns.filter(g => g.status === "DRAFT").length },
    { label: "QC Pending", status: "PENDING", count: grns.filter(g => g.qcStatus === "PENDING").length },
    { label: "Approved", status: "CONFIRMED", count: grns.filter(g => g.status === "CONFIRMED").length },
    { label: "Posted", status: "POSTED", count: grns.filter(g => g.status === "POSTED").length },
  ];

  // ---- Unique suppliers ----
  const uniqueSuppliers = useMemo(() => {
    const map = new Map<string, string>();
    for (const grn of grns) {
      if (grn.supplierId && grn.supplierName) {
        map.set(grn.supplierId, grn.supplierName);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [grns]);

  // ---- Columns ----
  const grnGridColumns: Column<GoodsReceiptNote>[] = useMemo(() => [
    { key: "grnNumber", label: "GRN No.", type: "docno", width: "130px", sortable: true },
    { key: "poNumber", label: "PO No.", type: "docno", width: "130px", sortable: true },
    { key: "supplierName", label: "Supplier", type: "text", sortable: true },
    { key: "receiveDate", label: "Receive Date", type: "date", width: "120px", sortable: true },
    { key: "items.length", label: "Items", type: "number", width: "70px", align: "right", sortable: true,
      render: (_v: unknown, row: GoodsReceiptNote) => <span>{row.items.length}</span>,
    },
    { key: "totalAmount", label: "Total", type: "currency", width: "120px", sortable: true },
    { key: "qcStatus", label: "QC Status", type: "status", width: "110px", sortable: true },
    { key: "status", label: "Status", type: "status", width: "110px", sortable: true },
  ], []);

  const grnGridContextMenu = useCallback((row: GoodsReceiptNote): ContextMenuItem[] => {
    return [
      {
        label: "View",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => navigate(`/procurement/grn/${row.id}`),
      },
      {
        label: "Print GRN",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => toast.info(`Print GRN ${row.grnNumber} — coming soon`),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Approve",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            await fetch(`/api/grn/${row.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "CONFIRMED" }),
            });
            invalidateCachePrefix("/api/grns");
            invalidateCachePrefix("/api/purchase-orders");
            invalidateCachePrefix("/api/inventory");
            invalidateCachePrefix("/api/raw-materials");
            fetchData();
          } catch {
            toast.error("Failed to approve GRN");
          }
        },
        disabled: row.status === "CONFIRMED" || row.status === "POSTED",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ];
  }, [navigate, toast, fetchData]);

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
          <h1 className="text-xl font-bold text-[#1F1D1B]">Goods Receipt Notes</h1>
          <p className="text-xs text-[#6B7280]">Receive and verify incoming goods against purchase orders</p>
        </div>
        <Button variant="primary" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" /> Create GRN
        </Button>
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
              <p className="text-xs text-[#6B7280]">Total GRNs</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{totalGRNs}</p>
            </div>
            <Package className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Pending QC</p>
              <p className="text-xl font-bold text-[#9C6F1E]">{pendingQC}</p>
            </div>
            <ClipboardCheck className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Approved (MTD)</p>
              <p className="text-xl font-bold text-[#4F7C3A]">{approvedMTD}</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" />
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
                  Showing {filteredGRNs.length} of {grns.length} GRNs
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
                  {ALL_GRN_STATUSES.map(s => (
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

      {/* GRN DataGrid */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-[#6B5C32]" />
            Goods Receipt Notes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<GoodsReceiptNote>
            columns={grnGridColumns}
            data={filteredGRNs}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            onDoubleClick={(row) => navigate(`/procurement/grn/${row.id}`)}
            contextMenuItems={grnGridContextMenu}
            maxHeight="calc(100vh - 300px)"
            emptyMessage="No GRNs found."
          />
        </CardContent>
      </Card>

      {/* GRN Form Dialog */}
      {showForm && (
        <GRNFormDialog
          purchaseOrders={purchaseOrders}
          onSave={handleCreateGRN}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
