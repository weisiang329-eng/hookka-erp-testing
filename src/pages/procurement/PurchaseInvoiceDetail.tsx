// ---------------------------------------------------------------------------
// Purchase Invoice detail page.
//
// Shows a single PI with its line breakdown. Mirrors the structure of
// procurement/detail.tsx (the PO detail page) — back link, header card,
// details + items grid, audit history. Phase B1: status-transition buttons
// (DRAFT→PENDING_APPROVAL→APPROVED→PAID, per backend VALID_TRANSITIONS) +
// Delete (DRAFT-only). Failures (incl. GL-posting errors on APPROVED/PAID) are
// surfaced via toast, never optimistically flipped. Line-item editing is B2.
//
// Line items come from purchase_invoice_items (migration 0107). Each line
// has a line_type tag: STOCKED items show their material code; non-stocked
// lines (FEE / TAX / REBATE / DISCOUNT / OTHER) show "—" plus a small
// badge so users can see at a glance what kind of charge it is.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, FileText, Package, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavGuard } from "@/lib/use-nav-guard";
import { formatCurrency, formatDate } from "@/lib/utils";
import { MaterialPicker, type MaterialOption } from "@/components/material-picker";
import type { RawMaterial } from "@/types";

const VALID_LINE_TYPES: LineType[] = ["STOCKED", "FEE", "TAX", "REBATE", "DISCOUNT", "OTHER"];

// Draft shape for the edit-mode line editor (unit price held as an RM string
// for the input; converted to sen on save).
type DraftLine = {
  materialCode: string;
  materialName: string;
  supplierSku: string;
  qty: string;
  unitPriceRm: string;
  lineType: LineType;
};

// Status lifecycle (matches backend VALID_TRANSITIONS in purchase-invoices.ts).
// Each current status → the action buttons it offers.
const PI_STATUS_ACTIONS: Record<string, Array<{ label: string; next: string }>> = {
  DRAFT: [
    { label: "Submit for Approval", next: "PENDING_APPROVAL" },
    { label: "Approve", next: "APPROVED" },
  ],
  PENDING_APPROVAL: [
    { label: "Approve", next: "APPROVED" },
    { label: "Back to Draft", next: "DRAFT" },
  ],
  APPROVED: [{ label: "Mark Paid", next: "PAID" }],
  PAID: [],
};

type LineType = "STOCKED" | "FEE" | "TAX" | "REBATE" | "DISCOUNT" | "OTHER";

type PurchaseInvoiceItem = {
  id: string;
  piId: string;
  materialCode: string | null;
  materialName: string;
  supplierSku: string | null;
  qty: number;
  unitPriceSen: number;
  lineTotalSen: number;
  lineType: LineType;
  notes: string | null;
};

type PurchaseInvoiceDetail = {
  id: string;
  piNo: string;
  purchaseOrderId: string;
  poRef: string;
  supplierId: string;
  supplier: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string;
  amountSen: number;
  status: string;
  remarks: string;
  items?: PurchaseInvoiceItem[];
};

// Background colour for the small line-type badge on non-stocked rows.
// STOCKED rows don't render a badge — the material code is the signal.
const LINE_TYPE_BADGE: Record<LineType, string> = {
  STOCKED: "bg-[#F0ECE9] text-[#6B5C32]",
  FEE: "bg-amber-50 text-amber-700",
  TAX: "bg-blue-50 text-blue-700",
  REBATE: "bg-green-50 text-green-700",
  DISCOUNT: "bg-purple-50 text-purple-700",
  OTHER: "bg-gray-100 text-gray-700",
};

export default function PurchaseInvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { data: resp, loading, error: fetchError, refresh } = useCachedJson<{
    success?: boolean;
    data?: PurchaseInvoiceDetail;
    error?: string;
  }>(id ? `/api/purchase-invoices/${id}` : null);

  // Purchase Company letterhead — print the PI under the supplier's buying
  // company (HOOKKA / OHANA / any sister co in the registry) while the
  // accounting entity stays HOOKKA ("borrow the letterhead"). Lightweight JSON.
  const { data: supResp } = useCachedJson<{ data?: Array<{ id: string; purchaseOrgCode?: string }> }>("/api/suppliers");
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");

  // Raw-materials catalog — powers the line-editor's Material Code picker so
  // an editing operator picks from the catalog instead of free-typing. Same
  // /api/inventory cache the PO pages warm. Off-catalog text stays allowed.
  const { data: invResp } = useCachedJson<{
    success?: boolean;
    data?: { rawMaterials?: RawMaterial[] };
  }>("/api/inventory");
  const materialOptions: MaterialOption[] = useMemo(
    () =>
      (invResp?.success ? invResp.data?.rawMaterials ?? [] : [])
        .filter((rm) => rm.isActive)
        .map((rm) => ({ itemCode: rm.itemCode, description: rm.description })),
    [invResp],
  );

  const pi: PurchaseInvoiceDetail | null = useMemo(
    () => (resp?.success ? resp.data ?? null : null),
    [resp],
  );
  const error: string | null = fetchError
    ?? (resp && resp.success === false ? resp.error || "Purchase invoice not found" : null);

  const items = pi?.items ?? [];
  const totalQty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
  const totalAmount = items.reduce((s, it) => s + (Number(it.lineTotalSen) || 0), 0);

  // Status transition (PUT {status}) — surfaces failures incl. the backend's
  // GL-posting errors on APPROVED/PAID (do NOT optimistically flip the badge).
  async function changeStatus(next: string, label: string) {
    if (!pi) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/purchase-invoices/${pi.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `${label} failed (${res.status})`);
        return;
      }
      toast.success(`${label} — done`);
      invalidateCachePrefix("/api/purchase-invoices");
      refresh();
    } catch {
      toast.error(`${label} failed — network error`);
    } finally {
      setBusy(false);
    }
  }

  // Print the PI as a PDF (jspdf dynamic-imported so the ~1MB lib isn't in the
  // initial bundle). pi already matches the PurchaseInvoicePdfData shape.
  async function printPdf() {
    if (!pi) return;
    try {
      const [{ generatePurchaseInvoicePdf }, { letterheadForPurchaseOrg }] = await Promise.all([
        import("@/lib/generate-purchase-invoice-pdf"),
        import("@/lib/generate-purchase-order-pdf"),
      ]);
      // Resolve the supplier's Purchase Company so the PI prints under that
      // company's letterhead (was always HOOKKA before — bug). Accounting
      // stays HOOKKA.
      const sup = (supResp?.data ?? []).find((s) => s.id === pi.supplierId);
      const purchaseOrgCode = sup?.purchaseOrgCode || "HOOKKA";
      const lh = letterheadForPurchaseOrg(purchaseOrgCode, orgsResp?.organisations);
      generatePurchaseInvoicePdf(pi, lh);
    } catch {
      toast.error("Could not generate the PDF.");
    }
  }

  // Delete (DRAFT-only; backend 409s otherwise — surfaced).
  async function deletePI() {
    if (!pi) return;
    if (!window.confirm(`Delete draft invoice ${pi.piNo}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/purchase-invoices/${pi.id}`, { method: "DELETE" });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Delete failed (${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-invoices");
      toast.success("Invoice deleted");
      navigate("/procurement/pi");
    } catch {
      toast.error("Delete failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // ---- Phase B2: edit mode (DRAFT-only) — editable header + line items ----
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dInvoiceDate, setDInvoiceDate] = useState("");
  const [dDueDate, setDDueDate] = useState("");
  const [dRemarks, setDRemarks] = useState("");
  const [dLines, setDLines] = useState<DraftLine[]>([]);
  useNavGuard(editing && dirty, "You have unsaved invoice edits. Leave without saving?");

  function startEdit() {
    if (!pi) return;
    setDInvoiceDate((pi.invoiceDate || "").split("T")[0]);
    setDDueDate((pi.dueDate || "").split("T")[0]);
    setDRemarks(pi.remarks || "");
    setDLines(
      (pi.items ?? []).map((it) => ({
        materialCode: it.materialCode || "",
        materialName: it.materialName || "",
        supplierSku: it.supplierSku || "",
        qty: String(it.qty ?? 0),
        unitPriceRm: (Number(it.unitPriceSen || 0) / 100).toFixed(2),
        lineType: it.lineType,
      })),
    );
    setDirty(false);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setDirty(false);
  }
  function patchLine(i: number, patch: Partial<DraftLine>) {
    setDLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
    setDirty(true);
  }
  function addLine() {
    setDLines((p) => [
      ...p,
      { materialCode: "", materialName: "", supplierSku: "", qty: "1", unitPriceRm: "0.00", lineType: "STOCKED" },
    ]);
    setDirty(true);
  }
  function removeLine(i: number) {
    setDLines((p) => p.filter((_, idx) => idx !== i));
    setDirty(true);
  }

  const draftTotalSen = dLines.reduce(
    (s, l) => s + Math.round((parseFloat(l.unitPriceRm) || 0) * 100) * (parseFloat(l.qty) || 0),
    0,
  );

  async function handleSaveEdit() {
    if (!pi) return;
    for (const l of dLines) {
      if (!l.materialName.trim()) {
        toast.error("Every line needs a description.");
        return;
      }
      if (!(parseFloat(l.qty) >= 0)) {
        toast.error("Every line needs a valid quantity.");
        return;
      }
    }
    setBusy(true);
    try {
      const items = dLines.map((l) => ({
        materialCode: l.materialCode.trim() || null,
        materialName: l.materialName.trim(),
        supplierSku: l.supplierSku.trim() || null,
        qty: parseFloat(l.qty) || 0,
        unitPriceSen: Math.round((parseFloat(l.unitPriceRm) || 0) * 100),
        lineType: l.lineType,
      }));
      const res = await fetch(`/api/purchase-invoices/${pi.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceDate: dInvoiceDate || undefined,
          dueDate: dDueDate || undefined,
          remarks: dRemarks,
          items,
        }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Save failed (${res.status})`);
        return;
      }
      toast.success("Invoice saved");
      setEditing(false);
      setDirty(false);
      invalidateCachePrefix("/api/purchase-invoices");
      refresh();
    } catch {
      toast.error("Save failed — network error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  if (error || !pi) {
    return (
      <div className="space-y-6">
        <Link
          to="/procurement/pi"
          className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Purchase Invoices
        </Link>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[#9CA3AF]">{error || "Purchase invoice not found."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/procurement/pi"
        className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Purchase Invoices
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B]">{pi.piNo}</h1>
            <Badge variant="status" status={pi.status} />
          </div>
          <p className="text-xs text-[#6B7280] mt-0.5">
            Supplier: <span className="font-medium text-[#1F1D1B]">{pi.supplierName}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!editing && (
            <Button type="button" variant="outline" size="sm" onClick={printPdf} disabled={busy}>
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
          )}
          {!editing && pi.status === "DRAFT" && (
            <Button type="button" variant="outline" size="sm" onClick={startEdit} disabled={busy}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          {!editing &&
            (PI_STATUS_ACTIONS[pi.status] ?? []).map((a) => (
              <Button
                key={a.next}
                type="button"
                variant={a.next === "DRAFT" ? "outline" : "primary"}
                size="sm"
                onClick={() => changeStatus(a.next, a.label)}
                disabled={busy}
                className={a.next === "DRAFT" ? "" : "bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"}
              >
                {a.label}
              </Button>
            ))}
          {!editing && pi.status === "DRAFT" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={deletePI}
              disabled={busy}
              className="text-[#9A3A2D] hover:bg-[#9A3A2D]/5"
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* PI Details + Items (read-only view) */}
      {!editing && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Details */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-[#6B5C32]" /> Invoice Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-y-3 text-sm">
              <span className="text-[#6B7280]">PI Number</span>
              <span className="font-medium text-[#1F1D1B]">{pi.piNo}</span>

              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-[#1F1D1B]">
                {pi.supplierName}
                {pi.supplierId ? (
                  <span className="text-[#9CA3AF] font-normal ml-1">({pi.supplierId})</span>
                ) : null}
              </span>

              <span className="text-[#6B7280]">Invoice Date</span>
              <span className="text-[#4B5563]">{pi.invoiceDate ? formatDate(pi.invoiceDate) : "-"}</span>

              <span className="text-[#6B7280]">Due Date</span>
              <span className="text-[#4B5563]">{pi.dueDate ? formatDate(pi.dueDate) : "-"}</span>

              <span className="text-[#6B7280]">Status</span>
              <span><Badge variant="status" status={pi.status} /></span>

              <span className="text-[#6B7280]">Linked PO</span>
              <span>
                {pi.purchaseOrderId ? (
                  <Link
                    to={`/procurement/${pi.purchaseOrderId}`}
                    className="text-[#6B5C32] font-medium hover:underline"
                  >
                    {pi.poRef || pi.purchaseOrderId}
                  </Link>
                ) : (
                  <span className="text-[#9CA3AF]">—</span>
                )}
              </span>
            </div>

            {pi.remarks && (
              <div className="pt-3 border-t border-[#E2DDD8]">
                <p className="text-xs font-medium text-[#6B7280] mb-1">Remarks</p>
                <p className="text-sm text-[#4B5563] whitespace-pre-wrap">{pi.remarks}</p>
              </div>
            )}

            <div className="pt-3 border-t border-[#E2DDD8] space-y-1">
              <div className="flex justify-between text-sm font-bold">
                <span className="text-[#6B5C32]">Total</span>
                <span className="text-[#6B5C32]">{formatCurrency(pi.amountSen)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right: Items Table */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-[#6B5C32]" /> Items ({items.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E2DDD8] p-6 text-center text-sm text-[#9CA3AF]">
                No line items recorded for this invoice.
              </div>
            ) : (
              <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">#</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Description</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Material Code</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Supplier SKU</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Qty</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Line Total</th>
                      <th className="h-10 px-3 text-center font-medium text-[#374151]">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      const isStocked = it.lineType === "STOCKED";
                      return (
                        <tr
                          key={it.id}
                          className={`border-b border-[#E2DDD8] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}
                        >
                          <td className="h-12 px-3 text-[#6B7280]">{idx + 1}</td>
                          <td className="h-12 px-3 text-[#1F1D1B]">{it.materialName}</td>
                          <td className="h-12 px-3 font-medium text-[#6B5C32]">
                            {isStocked && it.materialCode ? it.materialCode : (
                              <span className="text-[#9CA3AF]">—</span>
                            )}
                          </td>
                          <td className="h-12 px-3 text-[#4B5563]">{it.supplierSku || "-"}</td>
                          <td className="h-12 px-3 text-right text-[#4B5563]">{it.qty}</td>
                          <td className="h-12 px-3 text-right text-[#4B5563]">{formatCurrency(it.unitPriceSen)}</td>
                          <td className="h-12 px-3 text-right font-medium text-[#1F1D1B]">{formatCurrency(it.lineTotalSen)}</td>
                          <td className="h-12 px-3 text-center">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${LINE_TYPE_BADGE[it.lineType]}`}
                            >
                              {it.lineType}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[#F0ECE9]">
                      <td colSpan={4} className="h-10 px-3 font-semibold text-[#374151]">Total</td>
                      <td className="h-10 px-3 text-right font-semibold text-[#374151]">{totalQty}</td>
                      <td className="h-10 px-3"></td>
                      <td className="h-10 px-3 text-right font-bold text-[#6B5C32]">{formatCurrency(totalAmount)}</td>
                      <td className="h-10 px-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      )}

      {/* Edit mode (DRAFT-only): editable header + line items */}
      {editing && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Pencil className="h-4 w-4 text-[#6B5C32]" /> Edit Invoice
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Header fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Invoice Date</label>
                <Input
                  type="date"
                  value={dInvoiceDate}
                  onChange={(e) => { setDInvoiceDate(e.target.value); setDirty(true); }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Due Date</label>
                <Input
                  type="date"
                  value={dDueDate}
                  onChange={(e) => { setDDueDate(e.target.value); setDirty(true); }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Remarks</label>
                <Input
                  value={dRemarks}
                  onChange={(e) => { setDRemarks(e.target.value); setDirty(true); }}
                  placeholder="Optional notes"
                />
              </div>
            </div>

            {/* Line items editor */}
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-2 text-left font-medium text-[#374151]">#</th>
                    <th className="h-10 px-2 text-left font-medium text-[#374151]">Description</th>
                    <th className="h-10 px-2 text-left font-medium text-[#374151]">Material Code</th>
                    <th className="h-10 px-2 text-left font-medium text-[#374151]">Supplier SKU</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] w-20">Qty</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] w-28">Unit Price (RM)</th>
                    <th className="h-10 px-2 text-left font-medium text-[#374151] w-32">Type</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151] w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {dLines.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="h-16 px-3 text-center text-sm text-[#9CA3AF]">
                        No lines. Use “Add Line” to start.
                      </td>
                    </tr>
                  ) : (
                    dLines.map((l, i) => (
                      <tr key={i} className={`border-b border-[#E2DDD8] ${i % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                        <td className="px-2 py-1.5 text-[#6B7280]">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <Input
                            value={l.materialName}
                            onChange={(e) => patchLine(i, { materialName: e.target.value })}
                            placeholder="Description"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          {/* Catalog picker — suggests raw materials by code OR
                              name and fills BOTH code + description on pick.
                              Still free-text: an off-catalog supplier item is
                              kept verbatim (no hard-block, no normalize). */}
                          <MaterialPicker
                            value={l.materialCode}
                            options={materialOptions}
                            placeholder="—"
                            onPick={(o) =>
                              patchLine(i, {
                                materialCode: o.itemCode,
                                materialName: o.description,
                              })
                            }
                            onTyped={(text) => patchLine(i, { materialCode: text })}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            value={l.supplierSku}
                            onChange={(e) => patchLine(i, { supplierSku: e.target.value })}
                            placeholder="—"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            className="text-right"
                            value={l.qty}
                            onChange={(e) => patchLine(i, { qty: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="text-right"
                            value={l.unitPriceRm}
                            onChange={(e) => patchLine(i, { unitPriceRm: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={l.lineType}
                            onChange={(e) => patchLine(i, { lineType: e.target.value as LineType })}
                            className="w-full rounded-md border border-[#E2DDD8] bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                          >
                            {VALID_LINE_TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            className="text-[#9A3A2D] hover:bg-[#9A3A2D]/10 rounded p-1"
                            title="Remove line"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-[#F0ECE9]">
                    <td colSpan={5} className="h-10 px-2">
                      <Button type="button" variant="outline" size="sm" onClick={addLine}>
                        <Plus className="h-3.5 w-3.5" /> Add Line
                      </Button>
                    </td>
                    <td colSpan={3} className="h-10 px-2 text-right font-bold text-[#6B5C32]">
                      Total: {formatCurrency(draftTotalSen)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Save / Cancel bar */}
            <div className="flex items-center justify-end gap-2 pt-1">
              {dirty && <span className="text-xs text-[#9A3A2D] mr-auto">Unsaved changes</span>}
              <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveEdit}
                disabled={busy || !dirty}
                className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
              >
                Save Changes
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Audit trail for this PI */}
      <AuditHistoryPanel resource="purchase-invoices" resourceId={pi.id} />
    </div>
  );
}
