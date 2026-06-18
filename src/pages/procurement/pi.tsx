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
  Filter,
  Download,
  Plus,
  Trash2,
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
// PI FORM DIALOG (Create supplier invoice)
//
// The supplier-invoice twin of GRNFormDialog. The PI list previously had no
// create entry point — PIs only appeared via the GRN "Convert to Invoice"
// action. This dialog lets AP key a standalone supplier invoice (no GRN/PO
// required: the backend POST /api/purchase-invoices accepts items[] with just
// supplierId + supplierName) AND scan the supplier's invoice photo to auto-fill
// the lines, giving OCR parity with GRN ("OCR 在 GRN 还有 PI 的").
//
// Line items mirror the backend PurchaseInvoiceItemInput shape: materialName +
// supplierSku + qty + unitPrice (entered in RM, converted to sen on submit) +
// lineType. All lines created here are STOCKED — fee/tax/rebate lines stay an
// API-only concern for the GRN-conversion path.
// ============================================================
type PILineDraft = {
  materialCode: string;
  materialName: string;
  supplierSku: string;
  qty: number;
  unitPriceRM: number;
};

function emptyPILine(): PILineDraft {
  return {
    materialCode: "",
    materialName: "",
    supplierSku: "",
    qty: 1,
    unitPriceRM: 0,
  };
}

function PIFormDialog({
  suppliers,
  onSave,
  onClose,
}: {
  suppliers: Supplier[];
  onSave: (data: Record<string, unknown>) => Promise<void> | void;
  onClose: () => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<PILineDraft[]>([emptyPILine()]);
  const [scanOpen, setScanOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const supplier = suppliers.find((s) => s.id === supplierId);

  const updateLine = (
    idx: number,
    field: keyof PILineDraft,
    value: string | number,
  ) => {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };
  const addLine = () => setLines((prev) => [...prev, emptyPILine()]);
  const removeLine = (idx: number) =>
    setLines((prev) =>
      prev.length === 1 ? [emptyPILine()] : prev.filter((_, i) => i !== idx),
    );

  // OCR apply — fill the PI lines from a scanned supplier invoice. A manually
  // created PI starts with one blank row and no PO to match against, so the
  // strategy is: for each scanned line, first try to fuzz-match an existing
  // row the operator already typed (by supplier SKU / material name, same
  // normalize-and-include rule as GRN) and fill its qty + unit price; if no row
  // matches, APPEND it as a new line carrying description + code + qty + price.
  // The operator still reviews every line and submits (no naked write).
  const applyOcr = (ex: SupplierExtraction) => {
    const norm = (s: string | null | undefined) =>
      String(s ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    setLines((prev) => {
      // Drop a single pristine blank starter row so the first scanned line
      // doesn't leave an empty row above it.
      const seed = prev.filter(
        (l) =>
          l.materialName.trim() !== "" ||
          l.supplierSku.trim() !== "" ||
          l.materialCode.trim() !== "" ||
          l.qty !== 1 ||
          l.unitPriceRM !== 0,
      );
      const next = seed.map((l) => ({ ...l }));
      for (const sl of ex.lines ?? []) {
        const qty = Number(sl.qty) || 0;
        const priceRM =
          sl.unitPrice == null || Number.isNaN(Number(sl.unitPrice))
            ? null
            : Number(sl.unitPrice);
        const codeN = norm(sl.supplierCode);
        const descN = norm(sl.description);
        const hitIdx = next.findIndex((l) => {
          const sku = norm(l.supplierSku || l.materialCode);
          const nm = norm(l.materialName);
          const codeHit =
            !!codeN &&
            !!sku &&
            (sku === codeN || sku.includes(codeN) || codeN.includes(sku));
          const nameHit =
            !!descN && !!nm && (nm.includes(descN) || descN.includes(nm));
          return codeHit || nameHit;
        });
        if (hitIdx >= 0) {
          next[hitIdx] = {
            ...next[hitIdx],
            qty: qty > 0 ? qty : next[hitIdx].qty,
            unitPriceRM: priceRM != null ? priceRM : next[hitIdx].unitPriceRM,
          };
        } else {
          // When the scanned line has neither a description nor a supplier
          // code we still APPEND it (with qty/price) so the operator sees the
          // row — but an empty materialName would be silently dropped by the
          // validLines filter at submit (operator saw the row, PI omits it).
          // Seed a visible placeholder name instead: it passes the non-empty
          // filter AND prompts the operator to fill in the real name before
          // submit. No data loss.
          next.push({
            materialCode: "",
            materialName:
              sl.description?.trim() ||
              sl.supplierCode?.trim() ||
              "(Scanned item - add name)",
            supplierSku: sl.supplierCode?.trim() || "",
            qty: qty > 0 ? qty : 1,
            unitPriceRM: priceRM != null ? priceRM : 0,
          });
        }
      }
      return next.length > 0 ? next : [emptyPILine()];
    });
  };

  const validLines = lines.filter((l) => l.materialName.trim() !== "");
  const totalRM = validLines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPriceRM) || 0),
    0,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supplier || validLines.length === 0 || saving) return;
    setSaving(true);
    try {
      await onSave({
        supplierId: supplier.id,
        supplierName: supplier.name,
        invoiceDate,
        remarks,
        items: validLines.map((l) => ({
          materialCode: l.materialCode.trim() || null,
          materialName: l.materialName.trim(),
          supplierSku: l.supplierSku.trim() || null,
          qty: Number(l.qty) || 0,
          // Backend stores unit price in sen; the form keys RM.
          unitPriceSen: Math.round((Number(l.unitPriceRM) || 0) * 100),
          lineType: "STOCKED" as const,
        })),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            Create Purchase Invoice
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">
                Supplier *
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                required
              >
                <option value="">Select supplier...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">
                Invoice Date *
              </label>
              <Input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#1F1D1B]">
                Items - Enter Quantities & Unit Prices
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setScanOpen(true)}
                title="Snap/upload a supplier invoice to auto-fill code, qty, and unit price"
              >
                <ScanLine className="h-4 w-4" /> Scan supplier document
              </Button>
            </div>
            <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#F0ECE9]">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-[#374151]">
                      Description
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-[#374151] w-32">
                      Supplier SKU
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-[#374151] w-24">
                      Qty
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-[#374151] w-28">
                      Unit Price (RM)
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-[#374151] w-28">
                      Line Total
                    </th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const lineTotal =
                      (Number(line.qty) || 0) * (Number(line.unitPriceRM) || 0);
                    return (
                      <tr key={idx} className="border-t border-[#E2DDD8]">
                        <td className="px-2 py-1.5">
                          <Input
                            className="h-8"
                            placeholder="Material / description"
                            value={line.materialName}
                            onChange={(e) =>
                              updateLine(idx, "materialName", e.target.value)
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            className="h-8"
                            placeholder="SKU"
                            value={line.supplierSku}
                            onChange={(e) =>
                              updateLine(idx, "supplierSku", e.target.value)
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min={0}
                            onFocus={(e) => e.currentTarget.select()}
                            className="h-8 w-20 text-right ml-auto"
                            value={line.qty}
                            onChange={(e) =>
                              updateLine(idx, "qty", Number(e.target.value))
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            onFocus={(e) => e.currentTarget.select()}
                            className="h-8 w-24 text-right ml-auto"
                            value={line.unitPriceRM}
                            onChange={(e) =>
                              updateLine(
                                idx,
                                "unitPriceRM",
                                Number(e.target.value),
                              )
                            }
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium text-[#1F1D1B]">
                          {lineTotal.toLocaleString("en-MY", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          <button
                            type="button"
                            className="text-[#9CA3AF] hover:text-[#9A3A2D]"
                            onClick={() => removeLine(idx)}
                            title="Delete this line"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-[#F0ECE9]">
                    <td colSpan={4} className="px-3 py-2 font-semibold text-[#374151]">
                      Total
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-[#6B5C32]">
                      {totalRM.toLocaleString("en-MY", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={addLine}
            >
              <Plus className="h-4 w-4" /> Add line
            </Button>
          </div>

          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">
              Remarks
            </label>
            <Input
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Optional notes..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-[#E2DDD8]">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!supplier || validLines.length === 0 || saving}
            >
              {saving ? "Creating…" : "Create Invoice"}
            </Button>
          </div>
        </form>
        <ScanSupplierModal
          open={scanOpen}
          onClose={() => setScanOpen(false)}
          supplierId={supplier?.id ?? null}
          supplierName={supplier?.name ?? null}
          poContext={
            validLines.length > 0
              ? validLines
                  .map((l) => `${l.supplierSku || ""} ${l.materialName || ""}`.trim())
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

  // Create dialog
  const [showForm, setShowForm] = useState(false);

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

  const handleCreatePI = useCallback(
    async (data: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/purchase-invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const j = (await res.json().catch(() => null)) as
          | { success?: boolean; error?: string; data?: { piNo?: string } }
          | null;
        if (!res.ok || !j?.success) {
          toast.error(readErrorMessage(j) || "Failed to create invoice");
          return;
        }
        invalidateCachePrefix("/api/purchase-invoices");
        fetchData();
        setShowForm(false);
        toast.success(
          j.data?.piNo
            ? `Invoice ${j.data.piNo} created`
            : "Purchase invoice created",
        );
      } catch {
        toast.error("Failed to create invoice");
      }
    },
    [toast, fetchData],
  );

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
        <Button variant="primary" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" /> Create Invoice
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

      {/* Create PI Dialog */}
      {showForm && (
        <PIFormDialog
          suppliers={suppliers}
          onSave={handleCreatePI}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
