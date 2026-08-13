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
import { ArrowLeft, Ban, FileText, Package, Pencil, Plus, Printer, Trash2, Undo2 } from "lucide-react";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import { PurchaseLineageBar } from "@/components/ui/purchase-lineage-bar";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";
import { useNavGuard } from "@/lib/use-nav-guard";
import { formatCurrency, formatDate } from "@/lib/utils";
import { MaterialPicker, type MaterialOption } from "@/components/material-picker";
import { MoneyInput } from "@/components/ui/money-input";
import { DiscountInput } from "@/components/ui/discount-input";
import { isPiEditable } from "@/lib/purchase-edit-rules";
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
  // Per-line SST in RM as a string for the input (owner 2026-06-30). Blank or
  // "0" = non-taxable. Converted to sen on save.
  taxRm: string;
  lineType: LineType;
  // Convert-chain link: when a line was sourced from a GRN line, carry its
  // grn_items id so saving keeps grn_items.invoiced_qty in sync (the backend
  // restores the old consumption then re-increments off this id). Dropping it
  // would silently free the GRN line's invoiced qty on every edit.
  grnItemId: string | null;
};

// Status lifecycle (post-simplification, owner 2026-06-29):
//   DRAFT → CONFIRMED → PAID
// Legacy PENDING_APPROVAL / APPROVED rows still in the wild are normalized
// to CONFIRMED on render so the operator sees the new vocabulary; their
// action sets mirror CONFIRMED so the buttons keep working until the
// backend has migrated.
const PI_STATUS_ACTIONS: Record<string, Array<{ label: string; next: string }>> = {
  DRAFT: [{ label: "Confirm", next: "CONFIRMED" }],
  CONFIRMED: [{ label: "Mark Paid", next: "PAID" }],
  PENDING_APPROVAL: [{ label: "Confirm", next: "CONFIRMED" }],
  APPROVED: [{ label: "Mark Paid", next: "PAID" }],
  PAID: [],
};

// Same read-side normalization as the list page.
function normalizePiStatus(s: string): string {
  if (s === "PENDING_APPROVAL" || s === "APPROVED") return "CONFIRMED";
  return s;
}

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
  // Per-line SST in sen (owner 2026-06-30). Backend projects this from
  // purchase_invoice_items.tax_sen; 0 for legacy / non-taxable lines.
  taxSen?: number;
  lineType: LineType;
  notes: string | null;
  grnItemId?: string | number | null;
};

// Linked documents, returned by GET /api/purchase-invoices/:id alongside the
// PI itself. No list download — both are keyed lookups server-side.
type LinkedGrn = {
  id: string;
  grnNumber: string;
  status: string;
  receiveDate: string | null;
  totalAmount: number;
};
type LinkedSupplierPayment = {
  id: string;
  paymentNo: string;
  date: string;
  amountSen: number;
  method: string;
  reference: string;
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
  // Supplier reference numbers (dual-keyed on read by the backend).
  supplierInvoiceNo?: string | null;
  supplierDoNo?: string | null;
  // Source supplier document — file_assets row id (set only when the PI
  // was created from a scan-queue auto-split chunk). Owner 2026-06-30.
  sourceDocumentFileId?: string | null;
  // Purchase company on this PI (HOOKKA / OHANA / sister co). Read-only here.
  purchaseOrgCode?: string | null;
  // SST breakdown (owner 2026-06-30). Backend projects header subtotal_sen /
  // tax_sen; falls back to a synthesized breakdown when legacy TAX-line PIs
  // never recorded them. amountSen stays the grand total.
  subtotalSen?: number;
  taxSen?: number;
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
  const { confirm } = useConfirm();
  // Void is a finance-desk action (owner 2026-08-05); the server gates it too.
  const canVoid = (() => {
    const role = (getCurrentUser()?.role || "").toUpperCase();
    return role === "FINANCE" || role === "SUPER_ADMIN" || role === "ADMIN";
  })();
  const [busy, setBusy] = useState(false);
  // GET /api/purchase-invoices/:id now returns the linked documents with the PI
  // itself: linkedGRNs (the GRN this PI was raised from, resolved from the PI's
  // own grn_id) and linkedPayments (supplier_payments.purchaseInvoiceId — the
  // cash-out that settles it, previously invisible from this page entirely).
  // The whole-/api/grn-list download this page used to do is gone.
  const { data: resp, loading, error: fetchError, refresh } = useCachedJson<{
    success?: boolean;
    data?: PurchaseInvoiceDetail;
    error?: string;
    linkedGRNs?: LinkedGrn[];
    linkedPayments?: LinkedSupplierPayment[];
  }>(id ? `/api/purchase-invoices/${id}` : null);

  // Purchase Company letterhead — print the PI under the supplier's buying
  // company (HOOKKA / OHANA / any sister co in the registry) while the
  // accounting entity stays HOOKKA ("borrow the letterhead"). Lightweight JSON.
  const { data: supResp } = useCachedJson<{ data?: Array<{ id: string; purchaseOrgCode?: string; address?: string; contactPerson?: string; phone?: string; email?: string }> }>("/api/suppliers");
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");

  // Raw-materials catalog — powers the line-editor's Material Code picker so
  // an editing operator picks from the catalog instead of free-typing.
  // Off-catalog text stays allowed.
  // perf 2026-08-13 (BUG-2026-08-13-021, audit finding D12): `?buckets=` — only
  // `rawMaterials` is read here. (The "same /api/inventory cache the PO pages
  // warm" half of the old comment was already wishful: `useCachedJson` ALWAYS
  // re-fetches on mount — cached-fetch.ts:478 `void ttlSec` — so the warm cache
  // only ever served the first paint, never suppressed the request.)
  const { data: invResp } = useCachedJson<{
    success?: boolean;
    data?: { rawMaterials?: RawMaterial[] };
  }>("/api/inventory?buckets=rawMaterials");
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
  // SST breakdown (owner 2026-06-30): header subtotal/tax come from the
  // backend; for legacy rows the backend already synthesizes them from the
  // TAX line. We still derive client-side fallbacks so the table footer reads
  // correctly even if the header values arrive 0.
  const goodsLineAmount = items
    .filter((it) => it.lineType !== "TAX")
    .reduce((s, it) => s + (Number(it.lineTotalSen) || 0), 0);
  const perLineTax = items.reduce((s, it) => s + (Number(it.taxSen) || 0), 0);
  const legacyTaxLineAmount = items
    .filter((it) => it.lineType === "TAX")
    .reduce((s, it) => s + (Number(it.lineTotalSen) || 0), 0);
  const headerSubtotal = pi?.subtotalSen ?? 0;
  const headerTax = pi?.taxSen ?? 0;
  const subtotalDisplay = headerSubtotal || goodsLineAmount;
  const taxDisplay = headerTax || (perLineTax + legacyTaxLineAmount);
  const totalAmount = subtotalDisplay + taxDisplay;

  // The GRN this PI was raised from + the supplier payments that settle it —
  // both resolved server-side off the PI's own keys.
  const relatedGrns: LinkedGrn[] = useMemo(() => resp?.linkedGRNs ?? [], [resp]);
  const relatedPayments: LinkedSupplierPayment[] = useMemo(
    () => resp?.linkedPayments ?? [],
    [resp],
  );
  const paidToDateSen = relatedPayments.reduce((s, p) => s + (p.amountSen || 0), 0);

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
      generatePurchaseInvoicePdf(
        {
          ...pi,
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
  }

  // Delete (DRAFT-only; backend 409s otherwise — surfaced).
  async function deletePI() {
    if (!pi) return;
    if (!(await confirm({ title: "Delete draft invoice?", message: `Delete draft invoice ${pi.piNo}? This cannot be undone.`, danger: true }))) return;
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

  // Void — the finance desk's way out of a POSTED invoice (owner 2026-08-05).
  // The confirm spells out what it undoes, because this one moves the ledger.
  async function voidPI() {
    if (!pi) return;
    const ok = await confirm({
      title: `Void ${pi.piNo}?`,
      message:
        `This reverses its ledger entry, gives the goods-receipt quantity back, and drops it out of the creditor aging. ` +
        `The invoice stays on file as CANCELLED. It cannot be voided if any payment has been applied.`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/purchase-invoices/${pi.id}/void`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Void failed (${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-invoices");
      invalidateCachePrefix("/api/accounting");
      toast.success(`${pi.piNo} voided`);
      refresh();
    } catch {
      toast.error("Void failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // Unvoid — the way back. Owner 2026-08-05 voided the wrong half of a
  // duplicate pair and had no undo; re-keying the invoice would have lost its
  // number and its history.
  async function unvoidPI() {
    if (!pi) return;
    const ok = await confirm({
      title: `Restore ${pi.piNo}?`,
      message:
        `This puts its ledger entry back, re-claims the goods-receipt quantity, and returns the invoice to the creditor aging. ` +
        `It is refused if another invoice has billed those goods-receipt lines in the meantime.`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/purchase-invoices/${pi.id}/unvoid`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Restore failed (${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-invoices");
      invalidateCachePrefix("/api/accounting");
      toast.success(`${pi.piNo} restored`);
      refresh();
    } catch {
      toast.error("Restore failed — network error");
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
  const [dSupplierInvoiceNo, setDSupplierInvoiceNo] = useState("");
  const [dSupplierDoNo, setDSupplierDoNo] = useState("");
  const [dLines, setDLines] = useState<DraftLine[]>([]);
  useNavGuard(editing && dirty, "You have unsaved invoice edits. Leave without saving?");

  function startEdit() {
    if (!pi) return;
    setDInvoiceDate((pi.invoiceDate || "").split("T")[0]);
    setDDueDate((pi.dueDate || "").split("T")[0]);
    setDRemarks(pi.remarks || "");
    setDSupplierInvoiceNo(pi.supplierInvoiceNo || "");
    setDSupplierDoNo(pi.supplierDoNo || "");
    setDLines(
      (pi.items ?? []).map((it) => ({
        materialCode: it.materialCode || "",
        materialName: it.materialName || "",
        supplierSku: it.supplierSku || "",
        qty: String(it.qty ?? 0),
        unitPriceRm: (Number(it.unitPriceSen || 0) / 100).toFixed(2),
        taxRm: (Number(it.taxSen || 0) / 100).toFixed(2),
        lineType: it.lineType,
        grnItemId: it.grnItemId == null ? null : String(it.grnItemId),
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
      { materialCode: "", materialName: "", supplierSku: "", qty: "1", unitPriceRm: "0.00", taxRm: "0.00", lineType: "STOCKED", grnItemId: null },
    ]);
    setDirty(true);
  }
  function removeLine(i: number) {
    setDLines((p) => p.filter((_, idx) => idx !== i));
    setDirty(true);
  }

  // SST breakdown (owner 2026-06-30): subtotal = sum of GOODS line amounts
  // (lt !== 'TAX'); tax = sum of per-line tax + any legacy TAX-line amount;
  // grand total = subtotal + tax. Live-updates as the operator edits.
  const draftSubtotalSen = dLines.reduce(
    (s, l) =>
      l.lineType === "TAX"
        ? s
        : s + Math.round((parseFloat(l.unitPriceRm) || 0) * 100) * (parseFloat(l.qty) || 0),
    0,
  );
  const draftTaxSen = dLines.reduce(
    (s, l) =>
      s +
      Math.round((parseFloat(l.taxRm) || 0) * 100) +
      (l.lineType === "TAX"
        ? Math.round((parseFloat(l.unitPriceRm) || 0) * 100) * (parseFloat(l.qty) || 0)
        : 0),
    0,
  );
  const draftTotalSen = draftSubtotalSen + draftTaxSen;

  // Base for %-discount: sum of non-DISCOUNT line totals (what the operator is discounting off).
  const discountBaseAmountSen = dLines.reduce(
    (s, l) =>
      l.lineType === "DISCOUNT"
        ? s
        : s + Math.round((parseFloat(l.unitPriceRm) || 0) * 100) * (parseFloat(l.qty) || 0),
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
    // Editing a CONFIRMED invoice moves the books: the AP total + GL re-sync to
    // the new amount (the backend reverses the original posting and writes a
    // delta correction). Confirm with the operator in plain words before saving
    // (DRAFT invoices haven't posted to the GL, so they save without a prompt).
    const confirmedStatuses = new Set(["CONFIRMED", "APPROVED"]);
    if (confirmedStatuses.has(pi.status) && draftTotalSen !== pi.amountSen) {
      const ok = await confirm({
        title: "Save changes to a confirmed invoice?",
        message: `This invoice is already confirmed. Saving changes the amount payable from ${formatCurrency(pi.amountSen)} to ${formatCurrency(draftTotalSen)}, and posts a matching accounting correction. Continue?`,
        danger: false,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const items = dLines.map((l) => ({
        materialCode: l.materialCode.trim() || null,
        materialName: l.materialName.trim(),
        supplierSku: l.supplierSku.trim() || null,
        qty: parseFloat(l.qty) || 0,
        unitPriceSen: Math.round((parseFloat(l.unitPriceRm) || 0) * 100),
        // Per-line SST (owner 2026-06-30). 0 for non-taxable lines; backend
        // rolls them into header tax_sen on save.
        taxSen: Math.max(0, Math.round((parseFloat(l.taxRm) || 0) * 100)),
        lineType: l.lineType,
        // Preserve the GRN-source link so the backend keeps invoiced_qty in sync.
        grnItemId: l.grnItemId,
      }));
      const res = await fetch(`/api/purchase-invoices/${pi.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceDate: dInvoiceDate || undefined,
          dueDate: dDueDate || undefined,
          remarks: dRemarks,
          supplierInvoiceNo: dSupplierInvoiceNo.trim() || null,
          supplierDoNo: dSupplierDoNo.trim() || null,
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
      {/* Header */}
      <ObjectPageHeader
        backTo="/procurement/pi"
        title={pi.piNo}
        subtitle={`Supplier: ${pi.supplierName}${pi.poRef ? ` · PO ${pi.poRef}` : ""}`}
        badges={(() => {
          const shown = normalizePiStatus(pi.status);
          return <Badge variant="status" status={shown}>{shown.replace(/_/g, " ")}</Badge>;
        })()}
        actions={
          <>
            {!editing && pi.sourceDocumentFileId && (
              // Owner 2026-06-30: when the PI was created from a scan, link to
              // the SPECIFIC source PDF chunk (not the original bundle if the
              // upload was auto-split). Opens /api/files/:id/download in a
              // new tab — that endpoint 302s to a short-lived presigned URL.
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const url = `/api/files/${encodeURIComponent(
                    pi.sourceDocumentFileId as string,
                  )}/download`;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
                disabled={busy}
              >
                <FileText className="h-3.5 w-3.5" /> View source document
              </Button>
            )}
            {!editing && (
              <Button type="button" variant="outline" size="sm" onClick={printPdf} disabled={busy}>
                <Printer className="h-3.5 w-3.5" /> Print
              </Button>
            )}
            {!editing && pi.status !== "DRAFT" && (
              // Create a supplier Purchase Return straight from this PI — jumps
              // to the Purchase Returns page with this PI preselected + its
              // returnable lines loaded (slice 4).
              <Button type="button" variant="outline" size="sm" onClick={() => navigate(`/purchase-returns?pi=${encodeURIComponent(pi.id)}`)} disabled={busy}>
                <Undo2 className="h-3.5 w-3.5" /> Create Purchase Return
              </Button>
            )}
            {!editing && isPiEditable(pi.status) && (
              <Button type="button" variant="outline" size="sm" onClick={startEdit} disabled={busy}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
            {/* Void — finance desk only (owner 2026-08-05). Shown once posted
                and while nothing has been paid against it; the server gates it
                again by role and refuses a part-paid invoice. */}
            {!editing && pi.status !== "DRAFT" && pi.status !== "CANCELLED" && canVoid && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={voidPI}
                disabled={busy}
                className="text-[#9A3A2D] hover:bg-[#9A3A2D]/5"
              >
                <Ban className="h-3.5 w-3.5" /> Void
              </Button>
            )}
            {/* Restore — the mirror of Void, same role gate. */}
            {!editing && pi.status === "CANCELLED" && canVoid && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={unvoidPI}
                disabled={busy}
                className="text-[#3E6570] hover:bg-[#3E6570]/5"
              >
                <Undo2 className="h-3.5 w-3.5" /> Restore
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
          </>
        }
      />

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
              <span>
                {(() => {
                  const shown = normalizePiStatus(pi.status);
                  return <Badge variant="status" status={shown}>{shown.replace(/_/g, " ")}</Badge>;
                })()}
              </span>

              <span className="text-[#6B7280]">Purchase company</span>
              <span className="text-[#4B5563]">
                {(() => {
                  const code = pi.purchaseOrgCode || "HOOKKA";
                  const name = (orgsResp?.organisations ?? []).find((o) => o.code === code)?.name || code;
                  return name;
                })()}
              </span>

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

              <span className="text-[#6B7280]">Supplier Invoice No.</span>
              <span className="text-[#4B5563]">{pi.supplierInvoiceNo || "—"}</span>

              <span className="text-[#6B7280]">Supplier DO No.</span>
              <span className="text-[#4B5563]">{pi.supplierDoNo || "—"}</span>
            </div>

            {pi.remarks && (
              <div className="pt-3 border-t border-[#E2DDD8]">
                <p className="text-xs font-medium text-[#6B7280] mb-1">Remarks</p>
                <p className="text-sm text-[#4B5563] whitespace-pre-wrap">{pi.remarks}</p>
              </div>
            )}

            <div className="pt-3 border-t border-[#E2DDD8] space-y-1">
              {/* SST breakdown (owner 2026-06-30) — Subtotal / SST / Total.
                  Legacy PIs read header values as 0; backend synthesizes from
                  the TAX line so this still renders sensibly. */}
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">Subtotal</span>
                <span className="text-[#4B5563]">{formatCurrency(subtotalDisplay)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">SST</span>
                <span className="text-[#4B5563]">{formatCurrency(taxDisplay)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold pt-1 border-t border-[#E2DDD8]">
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
              <div className="rounded-md border border-[#E2DDD8] overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">#</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Description</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Internal Code</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Supplier SKU</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Qty</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">SST</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Line Total</th>
                      <th className="h-10 px-3 text-center font-medium text-[#374151]">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      const isStocked = it.lineType === "STOCKED";
                      // PI STOCKED lines sourced from a PO may have a blank
                      // materialCode while materialName stores "CODE - DESCRIPTION".
                      // Recover the code by splitting on the first " - " separator
                      // (codes use "-" without spaces, so the spaced separator is
                      // unambiguous) — mirrors the splitCodeName helper used in the
                      // PI PDF (generate-purchase-invoice-pdf.ts).
                      const dashIdx = isStocked ? (it.materialName ?? "").indexOf(" - ") : -1;
                      const resolvedCode = isStocked
                        ? (it.materialCode?.trim() || (dashIdx > 0 ? it.materialName.slice(0, dashIdx).trim() : ""))
                        : "";
                      const resolvedDescription = (isStocked && !it.materialCode?.trim() && dashIdx > 0)
                        ? it.materialName.slice(dashIdx + 3).trim()
                        : it.materialName;
                      return (
                        <tr
                          key={it.id}
                          className={`border-b border-[#E2DDD8] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}
                        >
                          <td className="h-12 px-3 text-[#6B7280]">{idx + 1}</td>
                          <td className="h-12 px-3 text-[#1F1D1B]">{resolvedDescription}</td>
                          <td className="h-12 px-3 font-medium text-[#6B5C32]">
                            {isStocked && resolvedCode ? resolvedCode : (
                              <span className="text-[#9CA3AF]">—</span>
                            )}
                          </td>
                          <td className="h-12 px-3 text-[#4B5563]">{it.supplierSku || "-"}</td>
                          <td className="h-12 px-3 text-right text-[#4B5563]">{it.qty}</td>
                          <td className="h-12 px-3 text-right text-[#4B5563]">{formatCurrency(it.unitPriceSen)}</td>
                          <td className="h-12 px-3 text-right text-[#4B5563]">{formatCurrency(Number(it.taxSen) || 0)}</td>
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
                    {/* SST breakdown (owner 2026-06-30): 3-row Subtotal / SST /
                        Total footer. Subtotal = goods-line sum (pre-tax); SST
                        = per-line tax + any legacy TAX-line amount; Total =
                        Subtotal + SST. */}
                    <tr className="bg-[#FAF9F7]">
                      <td colSpan={4} className="h-9 px-3 text-right text-xs font-medium text-[#6B7280]">Subtotal</td>
                      <td className="h-9 px-3 text-right text-sm text-[#6B7280]">{totalQty}</td>
                      <td className="h-9 px-3"></td>
                      <td className="h-9 px-3"></td>
                      <td className="h-9 px-3 text-right text-sm text-[#1F1D1B]">{formatCurrency(subtotalDisplay)}</td>
                      <td className="h-9 px-3"></td>
                    </tr>
                    <tr className="bg-[#FAF9F7]">
                      <td colSpan={7} className="h-9 px-3 text-right text-xs font-medium text-[#6B7280]">SST</td>
                      <td className="h-9 px-3 text-right text-sm text-[#1F1D1B]">{formatCurrency(taxDisplay)}</td>
                      <td className="h-9 px-3"></td>
                    </tr>
                    <tr className="bg-[#F0ECE9] border-t border-[#E2DDD8]">
                      <td colSpan={7} className="h-10 px-3 text-right font-semibold text-[#374151]">Total</td>
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
            {/* Amber banner: editing a CONFIRMED PI reverses GL and reposts. */}
            {(pi.status === "CONFIRMED" || pi.status === "APPROVED") && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Editing a confirmed PI will reverse the old GL entry and post a new one.
              </div>
            )}
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
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Supplier Invoice No.</label>
                <Input
                  value={dSupplierInvoiceNo}
                  onChange={(e) => { setDSupplierInvoiceNo(e.target.value); setDirty(true); }}
                  placeholder="Supplier's invoice number"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Supplier DO No.</label>
                <Input
                  value={dSupplierDoNo}
                  onChange={(e) => { setDSupplierDoNo(e.target.value); setDirty(true); }}
                  placeholder="Supplier's delivery order number"
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
                    <th className="h-10 px-2 text-left font-medium text-[#374151]">Internal Code</th>
                    <th className="h-10 px-2 text-left font-medium text-[#374151]">Supplier SKU</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] w-20">Qty</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] w-28">Unit Price (RM)</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] w-24" title="Per-line SST in RM">SST (RM)</th>
                    <th className="h-10 px-2 text-left font-medium text-[#374151] w-32">Type</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151] w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {dLines.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="h-16 px-3 text-center text-sm text-[#9CA3AF]">
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
                          {l.lineType === "DISCOUNT" ? (
                            <DiscountInput
                              baseAmountSen={discountBaseAmountSen}
                              valueSen={Math.round((parseFloat(l.unitPriceRm) || 0) * 100) || null}
                              onChange={(sen) =>
                                patchLine(i, { unitPriceRm: sen === null ? "0" : (sen / 100).toFixed(2) })
                              }
                            />
                          ) : (
                            <MoneyInput
                              value={parseFloat(l.unitPriceRm) || null}
                              onChange={(rm) =>
                                patchLine(i, { unitPriceRm: rm === null ? "0" : String(rm) })
                              }
                              className="text-right"
                            />
                          )}
                        </td>
                        {/* Per-line SST (owner 2026-06-30). Skipped for TAX
                            line type — the line amount itself IS the tax. */}
                        <td className="px-2 py-1.5">
                          {l.lineType === "TAX" ? (
                            <span className="text-xs text-[#9CA3AF] italic">n/a</span>
                          ) : (
                            <MoneyInput
                              value={parseFloat(l.taxRm) || null}
                              onChange={(rm) =>
                                patchLine(i, { taxRm: rm === null ? "0" : String(rm) })
                              }
                              className="text-right"
                            />
                          )}
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
                  {/* SST breakdown (owner 2026-06-30) — Subtotal / SST / Total
                      live-updates as the operator edits per-line tax. */}
                  <tr className="bg-[#FAF9F7]">
                    <td colSpan={6} className="h-8 px-2 text-right text-xs font-medium text-[#6B7280]">
                      Subtotal
                    </td>
                    <td colSpan={3} className="h-8 px-2 text-right text-sm text-[#1F1D1B]">
                      {formatCurrency(draftSubtotalSen)}
                    </td>
                  </tr>
                  <tr className="bg-[#FAF9F7]">
                    <td colSpan={6} className="h-8 px-2 text-right text-xs font-medium text-[#6B7280]">
                      SST
                    </td>
                    <td colSpan={3} className="h-8 px-2 text-right text-sm text-[#1F1D1B]">
                      {formatCurrency(draftTaxSen)}
                    </td>
                  </tr>
                  <tr className="bg-[#F0ECE9] border-t border-[#E2DDD8]">
                    <td colSpan={5} className="h-10 px-2">
                      <Button type="button" variant="outline" size="sm" onClick={addLine}>
                        <Plus className="h-3.5 w-3.5" /> Add Line
                      </Button>
                    </td>
                    <td colSpan={4} className="h-10 px-2 text-right font-bold text-[#6B5C32]">
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

      {/* Document lineage: parent PO + GRNs from the same PO */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[#6B7280]">Document Lineage</CardTitle>
        </CardHeader>
        <CardContent>
          <PurchaseLineageBar
            parent={
              pi.purchaseOrderId
                ? { type: "PO", docNo: pi.poRef || pi.purchaseOrderId, href: `/procurement/${pi.purchaseOrderId}` }
                : null
            }
            links={[
              {
                type: "GRN",
                label: relatedGrns.length === 1 ? (relatedGrns[0].grnNumber || "GRN") : "GRNs",
                count: relatedGrns.length,
                items: relatedGrns.map((g) => ({
                  id: g.id,
                  docNo: g.grnNumber || g.id,
                  href: `/procurement/grn/${g.id}`,
                  status: g.status ?? null,
                })),
              },
            ]}
          />
        </CardContent>
      </Card>

      {/* Supplier payments settling this PI. supplier_payments.purchaseInvoiceId
          only pointed one way, so a PI could be fully paid and this page gave
          no indication a payment existed — AP had to open the Supplier Payments
          screen to find out. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[#6B7280]">
            Supplier Payments ({relatedPayments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {relatedPayments.length === 0 ? (
            <p className="text-sm text-[#9CA3AF]">No payments recorded against this invoice yet.</p>
          ) : (
            <div className="space-y-2">
              {relatedPayments.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 border border-[#E2DDD8] rounded-md px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Link
                      to="/invoices/supplier-payments"
                      className="text-sm font-medium text-[#6B5C32] hover:underline"
                    >
                      {p.paymentNo || p.id}
                    </Link>
                    <span className="text-xs text-[#6B7280]">{formatDate(p.date)}</span>
                    {p.method && (
                      <Badge className="bg-[#F0ECE9] text-[#6B5C32]">
                        {p.method.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {p.reference && (
                      <span className="text-xs text-[#9CA3AF] truncate">Ref: {p.reference}</span>
                    )}
                  </div>
                  <span className="text-sm font-medium tabular-nums">
                    {formatCurrency(p.amountSen)}
                  </span>
                </div>
              ))}
              <div className="flex justify-between pt-1 text-sm font-semibold">
                <span>Paid to date</span>
                <span className="tabular-nums">{formatCurrency(paidToDateSen)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audit trail for this PI */}
      <AuditHistoryPanel resource="purchase-invoices" resourceId={pi.id} />
    </div>
  );
}
