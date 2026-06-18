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
  FileText,
  ScanLine,
} from "lucide-react";
import {
  ScanSupplierModal,
  type SupplierExtraction,
} from "@/components/scan-supplier-modal";

function readErrorMessage(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const err = (v as { error?: unknown }).error;
  return typeof err === "string" ? err : null;
}

// ============================================================
// GRN FORM DIALOG (Transfer from PO)
//
// Exported so detail.tsx (3.2 — Receive Goods button on the PO detail page)
// can mount the same dialog inline, scoped to the current PO via the optional
// `lockedPoId` prop. When lockedPoId is set, the PO dropdown is hidden +
// pre-selected, removing the "pick the PO from the list" friction step.
// ============================================================
export function GRNFormDialog({
  purchaseOrders,
  onSave,
  onClose,
  lockedPoId,
}: {
  purchaseOrders: PurchaseOrder[];
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
  /** When provided, the PO selector is hidden and this PO is pre-selected. */
  lockedPoId?: string;
}) {
  const [selectedPO, setSelectedPO] = useState(lockedPoId ?? "");
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
  const [scanOpen, setScanOpen] = useState(false);

  const po = purchaseOrders.find((p) => p.id === selectedPO);

  /* eslint-disable react-hooks/set-state-in-effect -- seed item entries from the selected PO when the user picks one */
  useEffect(() => {
    if (po) {
      setItemEntries(
        po.items.map((item, idx) => {
          // Seed with REMAINING qty (ordered − already-received), not the full
          // ordered qty. PARTIAL_RECEIVED POs come back through this dialog for
          // the second/third receipt; pre-filling the original quantity forced
          // the operator to subtract by hand on every line.
          const remaining = Math.max(0, item.quantity - (item.receivedQty || 0));
          return {
            poItemIndex: idx,
            receivedQty: remaining,
            acceptedQty: remaining,
            rejectedQty: 0,
            rejectionReason: "",
          };
        }),
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

  // OCR apply — match each scanned supplier line to a PO item (by supplier SKU
  // or material name, normalized + fuzzy) and pre-fill its received qty. The
  // operator still reviews every line and submits the form (no naked edit).
  const applyOcr = (ex: SupplierExtraction) => {
    if (!po) return;
    const norm = (s: string | null | undefined) =>
      String(s ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    setItemEntries((prev) => {
      const next = prev.map((e) => ({ ...e }));
      for (const line of ex.lines ?? []) {
        const qty = Number(line.qty) || 0;
        if (qty <= 0) continue;
        const codeN = norm(line.supplierCode);
        const descN = norm(line.description);
        const idx = po.items.findIndex((it) => {
          const sku = norm(it.supplierSKU);
          const nm = norm(it.materialName);
          const codeHit =
            !!codeN &&
            !!sku &&
            (sku === codeN || sku.includes(codeN) || codeN.includes(sku));
          const nameHit =
            !!descN && !!nm && (nm.includes(descN) || descN.includes(nm));
          return codeHit || nameHit;
        });
        if (idx >= 0 && next[idx]) {
          const remaining = Math.max(
            0,
            po.items[idx].quantity - (po.items[idx].receivedQty || 0),
          );
          const recv = remaining > 0 ? Math.min(qty, remaining) : qty;
          next[idx] = { ...next[idx], receivedQty: recv, acceptedQty: recv };
        }
      }
      return next;
    });
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
              {lockedPoId ? (
                <div className="flex h-10 w-full items-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-[#374151]">
                  {po ? `${po.poNo} - ${po.supplierName}` : "Loading PO…"}
                </div>
              ) : (
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
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Received By *</label>
              <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="e.g. Ahmad bin Ismail" required />
            </div>
          </div>

          {po && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-[#1F1D1B]">Items - Enter Received Quantities</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setScanOpen(true)}
                  title="Snap/upload a supplier delivery note or invoice to auto-fill received quantities"
                >
                  <ScanLine className="h-4 w-4" /> Scan supplier document
                </Button>
              </div>
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
                      // Cumulative receipt comparison — the over-receipt flag
                      // should look at (already-received + this-batch), not
                      // just this batch, otherwise PARTIAL_RECEIVED top-ups
                      // never trip the 110% guard.
                      const alreadyReceived = poItem.receivedQty || 0;
                      const cumulative = alreadyReceived + entry.receivedQty;
                      const overReceipt = cumulative > poItem.quantity * 1.1;
                      return (
                        <tr key={idx} className="border-t border-[#E2DDD8]">
                          <td className="px-3 py-2">
                            <div className="font-medium">{poItem.materialName}</div>
                            <div className="text-xs text-gray-500">{poItem.supplierSKU}</div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div>{poItem.quantity} {poItem.unit}</div>
                            {alreadyReceived > 0 && (
                              <div className="text-[10px] text-[#6B5C32]">
                                {alreadyReceived} already received
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input type="number" onFocus={(e) => e.currentTarget.select()} min={0} className={`w-20 text-right ml-auto ${overReceipt ? "border-[#9A3A2D]" : ""}`}
                              value={entry.receivedQty} onChange={(e) => updateItem(idx, "receivedQty", Number(e.target.value))} />
                            {overReceipt && <div className="text-[10px] text-[#9A3A2D] mt-0.5">Exceeds 110%</div>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input type="number" onFocus={(e) => e.currentTarget.select()} min={0} max={entry.receivedQty} className="w-20 text-right ml-auto"
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
        <ScanSupplierModal
          open={scanOpen}
          onClose={() => setScanOpen(false)}
          supplierId={po?.supplierId ?? null}
          supplierName={po?.supplierName ?? null}
          poContext={
            po
              ? po.items
                  .map((it) =>
                    `${it.supplierSKU || ""} ${it.materialName || ""}`.trim(),
                  )
                  .filter(Boolean)
                  .join("\n")
              : undefined
          }
          onApply={applyOcr}
        />
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

  // Bulk "Download PDF" — merge every selected GRN into one file. Rows come
  // back from the DataGrid via `onSelectionChange`.
  const [selectedGrns, setSelectedGrns] = useState<GoodsReceiptNote[]>([]);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

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
        invalidateCachePrefix("/api/grn");
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

  // ---- Bulk Download PDF ----
  // Render every selected GRN into one merged PDF. The list rows already carry
  // the full GRN (items + quantities), so map each row to the generator's
  // field shape (grnNo / supplierName / poRef / per-item received-accepted-
  // rejected qty) and hand the batch to generateCombinedGRNPdf.
  const downloadSelectedPdf = async () => {
    if (selectedGrns.length === 0 || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const ordered = [...selectedGrns].sort((a, b) =>
        String(a.grnNumber || "").localeCompare(String(b.grnNumber || "")),
      );
      const items = ordered.map((grn) => ({
        data: {
          grnNo: grn.grnNumber,
          date: grn.receiveDate,
          poRef: grn.poNumber,
          supplierName: grn.supplierName,
          remarks: grn.notes,
          items: grn.items.map((it) => ({
            itemCode: it.materialCode,
            description: it.materialName,
            poQty: it.orderedQty,
            receivedQty: it.receivedQty,
            rejectedQty: it.rejectedQty,
            acceptedQty: it.acceptedQty,
          })),
        },
      }));
      const { generateCombinedGRNPdf } = await import("@/lib/generate-grn-pdf");
      await generateCombinedGRNPdf(items, `GRNs-${items.length}.pdf`);
    } catch {
      /* best-effort; the button returns to idle on failure */
    } finally {
      setDownloadingPdf(false);
    }
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
            invalidateCachePrefix("/api/grn");
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
      {
        // Post to Stock — the move to POSTED that actually commits inventory
        // (rm_batches / cost_ledger / balanceQty) and cascades the PO. Was
        // previously only reachable via the PO-list bulk convert, so GRNs made
        // here got stuck at CONFIRMED and could never be invoiced.
        label: "Post to Stock",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            const res = await fetch(`/api/grn/${row.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "POSTED" }),
            });
            const j = (await res.json().catch(() => null)) as
              | { success?: boolean; error?: string; data?: { costing?: { unresolvedLines?: number } } }
              | null;
            if (!res.ok || !j?.success) {
              toast.error(j?.error || `Post to Stock failed (${res.status})`);
              return;
            }
            const unresolved = j.data?.costing?.unresolvedLines ?? 0;
            if (unresolved > 0) {
              toast.error(`Posted, but ${unresolved} line(s) had no matching raw material — that stock did NOT land.`);
            } else {
              toast.success(`GRN ${row.grnNumber} posted to stock`);
            }
            invalidateCachePrefix("/api/grn");
            invalidateCachePrefix("/api/purchase-orders");
            invalidateCachePrefix("/api/inventory");
            invalidateCachePrefix("/api/raw-materials");
            fetchData();
          } catch {
            toast.error("Post to Stock failed — network error");
          }
        },
        disabled: row.status === "POSTED",
      },
      {
        // POSTED-only: a non-POSTED GRN hasn't yet committed inventory and
        // shouldn't be billed. Mirrors the manual flow on the PI list which
        // pulls amount from the GRN's totalAmount and reuses the GRN items
        // (acceptedQty × unitPrice) so the PI pre-matches the GRN exactly.
        // Status defaults to DRAFT — operator reviews + finalizes from the
        // PI page; we don't auto-approve.
        label: "Convert to Invoice",
        icon: <FileText className="h-3.5 w-3.5" />,
        action: async () => {
          const grnTotalRM = (row.totalAmount / 100).toFixed(2);
          const ok = window.confirm(
            `Create Purchase Invoice from GRN ${row.grnNumber}? Total: ${grnTotalRM}`,
          );
          if (!ok) return;
          // Phase 3.6 multi-currency (rate keyed per document): an import
          // supplier's GRN was keyed in the supplier's currency — declare
          // it here and the PI books everything in MYR at this rate.
          const currency = (window.prompt(
            "Invoice currency — keep MYR, or type USD / CNY for a foreign supplier invoice:",
            "MYR",
          ) || "").trim().toUpperCase();
          if (!currency) return;
          let fxRate: number | undefined;
          if (currency !== "MYR") {
            const r = parseFloat(window.prompt(`Booking exchange rate — MYR per 1 ${currency} (invoice-date rate):`, "") || "");
            if (!Number.isFinite(r) || r <= 0) {
              toast.error("A positive exchange rate is required for a foreign invoice");
              return;
            }
            fxRate = r;
          }
          try {
            const today = new Date().toISOString().split("T")[0];
            const items = row.items
              .filter((it) => it.acceptedQty > 0)
              .map((it) => ({
                materialCode: it.materialCode,
                materialName: it.materialName,
                qty: it.acceptedQty,
                unitPriceSen: it.unitPrice,
                lineType: "STOCKED" as const,
              }));
            const res = await fetch("/api/purchase-invoices", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                purchaseOrderId: row.poId,
                supplierId: row.supplierId,
                supplierName: row.supplierName,
                invoiceDate: today,
                amountSen: row.totalAmount,
                remarks: `Auto-created from GRN ${row.grnNumber}`,
                items,
                currency,
                fxRate,
              }),
            });
            const j = (await res.json().catch(() => null)) as
              | { success?: boolean; error?: string; data?: { id: string; piNo: string } }
              | null;
            if (!res.ok || !j?.success || !j.data) {
              toast.error(j?.error || "Failed to create invoice");
              return;
            }
            invalidateCachePrefix("/api/grn");
            invalidateCachePrefix("/api/purchase-invoices");
            fetchData();
            toast.success(`Invoice ${j.data.piNo} created from GRN ${row.grnNumber}`);
            navigate(`/procurement/pi/${j.data.id}`);
          } catch {
            toast.error("Failed to create invoice");
          }
        },
        disabled: row.status !== "POSTED",
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
            <div className="flex items-center gap-2">
              {selectedGrns.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={downloadingPdf}
                  onClick={downloadSelectedPdf}
                >
                  <Download className="h-4 w-4" />{" "}
                  {downloadingPdf
                    ? "Preparing…"
                    : `Download PDF (${selectedGrns.length})`}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={exportCSV}>
                <Download className="h-4 w-4" /> Export CSV
              </Button>
            </div>
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
            virtualize
            loading={loading}
            stickyHeader={true}
            selectable
            onSelectionChange={setSelectedGrns}
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
