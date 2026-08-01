import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, getStatusColor, cn } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useUrlState } from "@/lib/use-url-state";
import type { GoodsReceiptNote, PurchaseOrder, ArrivalState } from "@/types";
import { Ship } from "lucide-react";
import {
  Plus,
  Package,
  ClipboardCheck,
  CheckCircle2,
  X,
  Eye,
  Printer,
  RefreshCw,
  Filter,
  Download,
  DollarSign,
  FileText,
  ScanLine,
  FolderInput,
} from "lucide-react";
import {
  ScanSupplierModal,
  type SupplierExtraction,
} from "@/components/scan-supplier-modal";

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
  autoScan,
}: {
  purchaseOrders: PurchaseOrder[];
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
  /** When provided, the PO selector is hidden and this PO is pre-selected. */
  lockedPoId?: string;
  /** When true, the supplier-document scan modal opens once on mount (header Scan entry point). */
  autoScan?: boolean;
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

  // When launched from the header "Scan supplier document" button (autoScan),
  // auto-open the scan modal ONLY ONCE A PO IS SELECTED — never before. A GRN
  // receives against a specific PO, and the scanned lines are matched to that
  // PO's items; a supplier can have several open POs, so we never auto-pick one
  // (wrong PO = wrong received quantities). The operator picks the PO, then the
  // scan pops to auto-fill. When opened from the PO detail page (lockedPoId),
  // the PO is already set, so the scan opens immediately.
  const autoScanFired = useRef(false);
  useEffect(() => {
    if (autoScan && po && !autoScanFired.current) {
      autoScanFired.current = true;
      setScanOpen(true);
    }
  }, [autoScan, po]);

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
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Purchase Order *</label>
              {lockedPoId ? (
                <div className="flex h-10 w-full items-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-[#374151]">
                  {po ? `${po.poNo} - ${po.supplierName}` : "Loading PO…"}
                </div>
              ) : eligiblePOs.length === 0 ? (
                <div className="rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#6B5C32]">
                  <span className="font-medium">No purchase orders are ready to receive.</span>{" "}
                  A PO must be <b>Submitted</b> or <b>Confirmed</b> first — open the PO, submit/confirm it, then come back here to record the goods.
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
              <div className="border border-[#E2DDD8] rounded-lg overflow-x-auto">
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
  const { confirm } = useConfirm();
  const navigate = useNavigate();

  // Draft / Confirmed split — mirrors the Sales Order list. CONFIRMED tab
  // shows everything that ISN'T DRAFT (CONFIRMED + POSTED + CANCELLED);
  // DRAFT tab is only DRAFT rows. URL-synced.
  const [tab, setTab] = useUrlState<"DRAFT" | "CONFIRMED">("tab", "CONFIRMED");
  const [bulkConverting, setBulkConverting] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterArrivalState, setFilterArrivalState] = useState<ArrivalState | "">("");
  const [showFilters, setShowFilters] = useState(false);
  // Search-safe server pagination (mirrors procurement/index.tsx). The grid
  // shows one 200-row page UNLESS a filter/search is active — then it drops
  // pagination and loads the whole dataset so a search sees EVERY GRN, not just
  // the current page. Widgets read the /stats payload for whole-dataset counts.
  const GRN_PAGE_SIZE = 200;
  const [grnPage, setGrnPage] = useState(1);
  const [gridSearch, setGridSearch] = useState("");
  const grnFiltersActive = !!(
    filterStatus ||
    filterSupplier ||
    filterDateFrom ||
    filterDateTo ||
    filterArrivalState ||
    gridSearch.trim()
  );

  // Bulk "Download PDF" — merge every selected GRN into one file. Rows come
  // back from the DataGrid via `onSelectionChange`.
  const [selectedGrns, setSelectedGrns] = useState<GoodsReceiptNote[]>([]);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [bulkArrivalBusy, setBulkArrivalBusy] = useState(false);

  const { data: grnResp, loading: grnLoading, refresh: refreshGrns } = useCachedJson<{ success?: boolean; data?: GoodsReceiptNote[]; total?: number } | GoodsReceiptNote[]>(
    grnFiltersActive
      ? "/api/grn"
      : `/api/grn?page=${grnPage}&limit=${GRN_PAGE_SIZE}`,
  );
  // Whole-dataset GRN header rows (no items) — drives the summary widgets so
  // their counts never shrink to the current page.
  const { data: grnStatsResp } = useCachedJson<{ success?: boolean; data?: GoodsReceiptNote[]; total?: number }>(
    "/api/grn/stats",
  );
  const { loading: poLoading, refresh: refreshPOs } = useCachedJson<{ success?: boolean; data?: PurchaseOrder[] } | PurchaseOrder[]>("/api/purchase-orders");
  // Purchase Company letterhead — print each GRN under its supplier's buying
  // company (HOOKKA / OHANA / any sister co); accounting stays HOOKKA.
  const { data: supResp } = useCachedJson<{ data?: Array<{ id: string; purchaseOrgCode?: string }> }>("/api/suppliers");
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");

  const grns: GoodsReceiptNote[] = useMemo(
    () => ((grnResp as { data?: GoodsReceiptNote[] } | undefined)?.data ?? (Array.isArray(grnResp) ? grnResp : [])),
    [grnResp]
  );
  // Whole-dataset header rows for the summary widgets (counts + arrival tallies)
  // so a paginated grid page never shrinks the widget numbers.
  const grnStatsRows: GoodsReceiptNote[] = useMemo(
    () => (grnStatsResp?.success ? grnStatsResp.data ?? [] : grns),
    [grnStatsResp, grns],
  );
  const grnTotalCount = grnStatsResp?.total ?? grnStatsRows.length;
  const grnTotalPages = Math.max(1, Math.ceil(grnTotalCount / GRN_PAGE_SIZE));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp only; guarded so it self-terminates
    if (grnPage > grnTotalPages) setGrnPage(grnTotalPages);
  }, [grnPage, grnTotalPages]);
  const loading = grnLoading || poLoading;

  const fetchData = useCallback(() => {
    refreshGrns();
    refreshPOs();
  }, [refreshGrns, refreshPOs]);

  // ---- Filters ----
  const hasActiveFilters = filterStatus || filterSupplier || filterDateFrom || filterDateTo || filterArrivalState;

  const clearFilters = () => {
    setFilterStatus("");
    setFilterSupplier("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterArrivalState("");
  };

  const filteredGRNsByUserFilters = useMemo(() => {
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
      if (filterArrivalState && grn.arrival_state !== filterArrivalState) return false;
      return true;
    });
  }, [grns, filterStatus, filterSupplier, filterDateFrom, filterDateTo, filterArrivalState]);

  // Tab split — DRAFT tab = only DRAFT; CONFIRMED tab = everything else
  // (CONFIRMED + POSTED + CANCELLED). Mirrors the Sales Order list.
  const filteredGRNs = useMemo(() => {
    return filteredGRNsByUserFilters.filter(grn => {
      if (tab === "DRAFT" && grn.status !== "DRAFT") return false;
      if (tab === "CONFIRMED" && grn.status === "DRAFT") return false;
      return true;
    });
  }, [filteredGRNsByUserFilters, tab]);

  // Tab badge counts come from the whole list, not the current filter.
  const draftCount = useMemo(
    () => grnStatsRows.filter(g => g.status === "DRAFT").length,
    [grnStatsRows],
  );
  const tabConfirmedCount = useMemo(
    () => grnStatsRows.filter(g => g.status !== "DRAFT").length,
    [grnStatsRows],
  );

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
      const [{ generateCombinedGRNPdf }, { letterheadForPurchaseOrg }] = await Promise.all([
        import("@/lib/generate-grn-pdf"),
        import("@/lib/generate-purchase-order-pdf"),
      ]);
      const suppliersList = supResp?.data ?? [];
      const items = ordered.map((grn) => {
        const sup = suppliersList.find((s) => s.id === grn.supplierId);
        return {
          data: {
            grnNo: grn.grnNumber,
            date: grn.receiveDate,
            poRef: grn.poNumber,
            supplierName: grn.supplierName,
            remarks: grn.notes,
            items: grn.items.map((it) => ({
              itemCode: it.materialCode,
              supplierSKU: it.supplierSKU,
              description: it.materialName,
              poQty: it.orderedQty,
              receivedQty: it.receivedQty,
              rejectedQty: it.rejectedQty,
              acceptedQty: it.acceptedQty,
            })),
          },
          letterhead: letterheadForPurchaseOrg(sup?.purchaseOrgCode || "HOOKKA", orgsResp?.organisations),
        };
      });
      await generateCombinedGRNPdf(items, `GRNs-${items.length}.pdf`);
    } catch {
      /* best-effort; the button returns to idle on failure */
    } finally {
      setDownloadingPdf(false);
    }
  };

  // ---- Summary stats — reflect the user's active filters (status, supplier,
  // ---- date range, arrival state) so the cards always match the table.
  // ---- Owner ruling 2026-06-30.
  const totalGRNs = filteredGRNsByUserFilters.length;
  const pendingQC = filteredGRNsByUserFilters.filter((g) => g.qcStatus === "PENDING").length;
  const now = new Date();
  const mtdStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const approvedMTD = filteredGRNsByUserFilters.filter((g) => g.status === "CONFIRMED" && (g.receiveDate ?? "") >= mtdStart).length;
  const totalValueSen = filteredGRNsByUserFilters.reduce((sum, g) => sum + g.totalAmount, 0);

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

  // ---- Bulk arrival transition ----
  // Mirrors runBulkDoTransition from delivery/index.tsx: sequential per-row
  // PUTs to /api/grn/:id/arrival, then refresh.

  // Display labels for arrival states — DB value stays unchanged.
  // NOT_ARRIVED is shown as "Planning" to match the DO pipeline vocabulary.
  const ARRIVAL_LABELS: Record<ArrivalState, string> = {
    NOT_ARRIVED: "Planning",
    IN_TRANSIT: "In Transit",
    AT_CUSTOMS: "At Customs",
    ARRIVED: "Arrived",
  };

  // Any forward jump is allowed: local goods go straight to ARRIVED,
  // imports may skip AT_CUSTOMS if cleared informally. Mirrors grn.ts.
  const VALID_ARRIVAL_TRANSITIONS: Record<ArrivalState, ArrivalState[]> = {
    NOT_ARRIVED: ["IN_TRANSIT", "AT_CUSTOMS", "ARRIVED"],
    IN_TRANSIT: ["AT_CUSTOMS", "ARRIVED"],
    AT_CUSTOMS: ["ARRIVED"],
    ARRIVED: [],
  };

  const runBulkArrivalTransition = useCallback(async (target: ArrivalState, verb: string) => {
    if (selectedGrns.length === 0 || bulkArrivalBusy) return;
    // Only transition rows whose current state allows the target
    const eligible = selectedGrns.filter(g =>
      (VALID_ARRIVAL_TRANSITIONS[g.arrival_state] ?? []).includes(target),
    );
    if (eligible.length === 0) {
      toast.error(`No selected GRNs can be moved to ${verb} from their current arrival state.`);
      return;
    }
    setBulkArrivalBusy(true);
    let ok = 0;
    let failed = 0;
    for (const grn of eligible) {
      try {
        const res = await fetch(`/api/grn/${grn.id}/arrival`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ arrival_state: target }),
        });
        const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
        if (!res.ok || !j?.success) { failed++; } else { ok++; }
      } catch { failed++; }
    }
    setBulkArrivalBusy(false);
    invalidateCachePrefix("/api/grn");
    fetchData();
    if (failed > 0) {
      toast.error(`${ok} marked ${verb}; ${failed} failed (check arrival state transitions).`);
    } else {
      toast.success(`${ok} GRN${ok !== 1 ? "s" : ""} marked ${verb}.`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGrns, bulkArrivalBusy, toast, fetchData]);

  // Bulk DRAFT → CONFIRMED — mirrors the Sales Order bulk-confirm UX. GRNs
  // transition DRAFT → CONFIRMED via PUT /api/grn/:id; the move to POSTED
  // (which actually commits stock) stays on the per-row context menu.
  const bulkConvertDrafts = useCallback(async () => {
    const drafts = selectedGrns.filter(g => g.status === "DRAFT");
    if (drafts.length === 0) return;
    if (
      !(await confirm({
        title: "Convert drafts",
        message: `Confirm ${drafts.length} draft GRN(s)? They will move to CONFIRMED (Post to Stock stays per-row).`,
        danger: false,
      }))
    )
      return;
    setBulkConverting(true);
    const results = await Promise.all(
      drafts.map(async (g) => {
        try {
          const res = await fetch(`/api/grn/${g.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "CONFIRMED" }),
          });
          const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
          if (!res.ok || !j?.success) {
            return { ok: false, id: g.grnNumber, err: j?.error || `HTTP ${res.status}` };
          }
          return { ok: true, id: g.grnNumber };
        } catch (e) {
          return { ok: false, id: g.grnNumber, err: (e as Error).message };
        }
      }),
    );
    setBulkConverting(false);
    const failed = results.filter(r => !r.ok);
    invalidateCachePrefix("/api/grn");
    fetchData();
    setSelectedGrns([]);
    if (failed.length > 0) {
      const sample = failed.slice(0, 3).map(f => f.id).join(", ");
      toast.error(`Confirmed ${results.length - failed.length} · Failed ${failed.length} (${sample})`);
    } else {
      toast.success(`Confirmed ${results.length} GRN${results.length !== 1 ? "s" : ""} successfully.`);
    }
    if (results.length - failed.length > 0) setTab("CONFIRMED");
  }, [selectedGrns, confirm, toast, fetchData, setTab]);

  // Purchase company display map: org code → legal name. Falls back to
  // the code when no name is registered.
  const orgNameByCode = useMemo(() => {
    const out: Record<string, string> = {};
    for (const o of orgsResp?.organisations ?? []) {
      if (o.code) out[o.code] = o.name || o.code;
    }
    return out;
  }, [orgsResp]);

  // ---- Columns ----
  const grnGridColumns: Column<GoodsReceiptNote>[] = useMemo(() => [
    { key: "grnNumber", label: "GRN No.", type: "docno", width: "130px", sortable: true },
    { key: "poNumber", label: "PO No.", type: "docno", width: "130px", sortable: true },
    { key: "supplierName", label: "Supplier", type: "text", sortable: true },
    // Supplier's own DO number (their delivery-order ref). First-class
    // column per owner ruling 2026-06-29 evening — AP team matches on it.
    { key: "supplierDoNo", label: "Supplier DO No.", type: "text", width: "140px", sortable: true },
    {
      key: "purchaseOrgCode",
      label: "Purchase co",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v: unknown, row: GoodsReceiptNote) => {
        const code = row.purchaseOrgCode || "HOOKKA";
        const label = orgNameByCode[code] || code;
        return (
          <span
            className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-[#F0ECE9] text-[#6B5C32]"
            title={code}
          >
            {label}
          </span>
        );
      },
    },
    { key: "receiveDate", label: "Receive Date", type: "date", width: "120px", sortable: true },
    { key: "items.length", label: "Items", type: "number", width: "70px", align: "right", sortable: true,
      render: (_v: unknown, row: GoodsReceiptNote) => <span>{row.items.length}</span>,
    },
    { key: "totalAmount", label: "Total", type: "currency", width: "120px", sortable: true },
    { key: "arrival_state", label: "Arrival", type: "status", width: "130px", sortable: true,
      render: (_v: unknown, row: GoodsReceiptNote) => (
        <Badge variant="status" status={row.arrival_state}>
          {ARRIVAL_LABELS[row.arrival_state as ArrivalState] ?? row.arrival_state.replace(/_/g, " ")}
        </Badge>
      ),
    },
    { key: "qcStatus", label: "QC Status", type: "status", width: "110px", sortable: true },
    { key: "status", label: "Status", type: "status", width: "110px", sortable: true },
  ], [orgNameByCode]);

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
        // List rows carry the full GRN — map to the generator's field shape
        // (same as the bulk download) and print this one.
        action: async () => {
          try {
            const [{ generateGRNPdf }, { letterheadForPurchaseOrg }] = await Promise.all([
              import("@/lib/generate-grn-pdf"),
              import("@/lib/generate-purchase-order-pdf"),
            ]);
            const sup = (supResp?.data ?? []).find((s) => s.id === row.supplierId);
            const lh = letterheadForPurchaseOrg(sup?.purchaseOrgCode || "HOOKKA", orgsResp?.organisations);
            generateGRNPdf({
              grnNo: row.grnNumber,
              date: row.receiveDate,
              poRef: row.poNumber,
              supplierName: row.supplierName,
              remarks: row.notes,
              items: row.items.map((it) => ({
                itemCode: it.materialCode,
                supplierSKU: it.supplierSKU,
                description: it.materialName,
                poQty: it.orderedQty,
                receivedQty: it.receivedQty,
                rejectedQty: it.rejectedQty,
                acceptedQty: it.acceptedQty,
              })),
            }, lh);
          } catch {
            toast.error("Could not generate the PDF.");
          }
        },
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Approve",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            const res = await fetch(`/api/grn/${row.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "CONFIRMED" }),
            });
            // A non-2xx doesn't reject fetch — check res.ok or the approve
            // silently "succeeds" (matches the adjacent Post-to-Stock action).
            const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
            if (!res.ok || !j?.success) {
              toast.error(j?.error || `Failed to approve GRN (${res.status})`);
              return;
            }
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
        action: () => {
          navigate(`/procurement/pi/create?grnId=${row.id}`);
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Goods Receipt Notes</h1>
          <p className="text-xs text-[#6B7280]">Receive and verify incoming goods against purchase orders</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => navigate("/procurement/grn/create?manual=1")}
          >
            <Plus className="h-4 w-4" /> Create GRN
          </Button>
          <Button
            variant="primary"
            onClick={() => navigate("/procurement/grn/create?from=po")}
          >
            <FolderInput className="h-4 w-4" /> From PO
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/procurement/grn/create?scan=1")}
          >
            <ScanLine className="h-4 w-4" /> Scan GRN
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <Package className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B] leading-none">{totalGRNs}</p>
              <p className="text-xs text-[#6B7280] mt-1">Total GRNs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0">
              <ClipboardCheck className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9C6F1E] leading-none">{pendingQC}</p>
              <p className="text-xs text-[#6B7280] mt-1">Pending QC</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5 shrink-0">
              <CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#4F7C3A] leading-none">{approvedMTD}</p>
              <p className="text-xs text-[#6B7280] mt-1">Approved (MTD)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <DollarSign className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-bold text-[#1F1D1B] leading-none truncate">{formatCurrency(totalValueSen)}</p>
              <p className="text-xs text-[#6B7280] mt-1">Total Value</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Arrival tab bar — primary navigation, DO-style border-b-2 */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-4 overflow-x-auto" aria-label="Arrival stages">
          {/* "All" pseudo-tab to clear arrival filter */}
          <button
            onClick={() => setFilterArrivalState("")}
            className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              !filterArrivalState
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
            }`}
          >
            All GRNs
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              !filterArrivalState ? "bg-[#6B5C32] text-white" : "bg-[#F0ECE9] text-[#6B7280]"
            }`}>
              {grnTotalCount}
            </span>
          </button>
          {(["NOT_ARRIVED", "IN_TRANSIT", "AT_CUSTOMS", "ARRIVED"] as ArrivalState[]).map((state) => {
            const count = grnStatsRows.filter(g => g.arrival_state === state).length;
            const isActive = filterArrivalState === state;
            return (
              <button
                key={state}
                onClick={() => setFilterArrivalState(isActive ? "" : state)}
                className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  isActive
                    ? "border-[#6B5C32] text-[#6B5C32]"
                    : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
                }`}
              >
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: getStatusColor(state).hex }} />
                {ARRIVAL_LABELS[state]}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  isActive ? "bg-[#6B5C32] text-white" : "bg-[#F0ECE9] text-[#6B7280]"
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Search / bulk actions / filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-2 flex-wrap">
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
                  Showing {filteredGRNs.length} of {grnTotalCount} GRNs
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {selectedGrns.length > 0 && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={bulkArrivalBusy}
                    onClick={() => runBulkArrivalTransition("IN_TRANSIT", "In Transit")}
                    title="Mark selected GRNs as In Transit (only those currently Planning, In Transit eligible)"
                  >
                    <Ship className="h-4 w-4" /> Mark In Transit ({selectedGrns.length})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={bulkArrivalBusy}
                    onClick={() => runBulkArrivalTransition("AT_CUSTOMS", "At Customs")}
                    title="Mark selected GRNs as At Customs (Planning or In Transit allowed)"
                  >
                    <Ship className="h-4 w-4" /> Mark At Customs ({selectedGrns.length})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={bulkArrivalBusy}
                    onClick={() => runBulkArrivalTransition("ARRIVED", "Arrived")}
                    title="Mark selected GRNs as Arrived (any forward state allowed)"
                  >
                    <Ship className="h-4 w-4" /> Mark Arrived ({selectedGrns.length})
                  </Button>
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
                </>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-[#6B5C32]" />
              Goods Receipt Notes
            </CardTitle>
            {/* Draft / Confirmed toggle — mirrors SO list shell. */}
            <div className="inline-flex rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-0.5">
              <button
                onClick={() => { setTab("DRAFT"); setSelectedGrns([]); }}
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
                onClick={() => { setTab("CONFIRMED"); setSelectedGrns([]); }}
                className={cn(
                  "px-4 py-1.5 text-sm rounded transition-colors",
                  tab === "CONFIRMED"
                    ? "bg-[#E0EDF0] text-[#3E6570] font-medium shadow-sm"
                    : "text-[#6B7280] hover:text-[#1F1D1B]"
                )}
              >
                Confirmed ({tabConfirmedCount})
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tab === "DRAFT" && selectedGrns.length > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-sm">
              <span className="text-[#9C6F1E]">
                {selectedGrns.filter(g => g.status === "DRAFT").length} draft GRN(s) selected
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={bulkConverting}
                onClick={bulkConvertDrafts}
              >
                <CheckCircle2 className="h-4 w-4" />{" "}
                {bulkConverting
                  ? "Converting..."
                  : `Convert ${selectedGrns.filter(g => g.status === "DRAFT").length} drafts`}
              </Button>
            </div>
          )}
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
            emptyMessage={tab === "DRAFT" ? "No draft GRNs." : "No GRNs found."}
            onSearchChange={setGridSearch}
          />
          {/* Server-side page controls — only in the default (unfiltered) view.
              A filter/search loads the whole dataset, so paging is hidden. */}
          {!grnFiltersActive && grnTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 py-3 border-t border-[#F0ECE9]">
              <Button
                variant="outline"
                size="sm"
                disabled={grnPage <= 1 || grnLoading}
                onClick={() => setGrnPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </Button>
              <span className="text-sm text-[#6B7280]">
                Page {grnPage} / {grnTotalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={grnPage >= grnTotalPages || grnLoading}
                onClick={() => setGrnPage((p) => Math.min(grnTotalPages, p + 1))}
              >
                Next →
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
