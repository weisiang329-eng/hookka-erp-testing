import { useState, useMemo } from "react";
import { useTimeout } from "@/lib/scheduler";
import { humanizeError } from "@/lib/humanize-error";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { DocumentChainMap } from "@/components/ui/document-chain-map";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { LockBanner } from "@/components/ui/lock-banner";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import {
  Trash2,
  Send,
  Download,
  DollarSign,
  FileText,
  CreditCard,
  Calendar,
  Building2,
  Package,
  CheckCircle2,
  Clock,
  Users,
} from "lucide-react";
// generateInvoicePdf is dynamic-imported at the click handler so the
// 1MB jspdf vendor chunk only ships when the user actually downloads.
import type { Invoice } from "@/types";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { DiscountInput } from "@/components/ui/discount-input";
import { invoiceLineUnitSen } from "@/lib/invoice-line-price";

const PAYMENT_METHODS = [
  { value: "BANK_TRANSFER", label: "Bank Transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CASH", label: "Cash" },
  { value: "CREDIT_CARD", label: "Credit Card" },
  { value: "E_WALLET", label: "E-Wallet" },
];

// Credit / debit notes raised against this invoice, returned by
// GET /api/invoices/:id (credit_notes.invoiceId / debit_notes.invoiceId reverse
// lookups). Before this the adjustment was only visible from the notes lists,
// so an invoice could be half credited back while its own page still showed
// the original total.
type LinkedNote = {
  id: string;
  noteNumber: string;
  date: string;
  reason: string;
  totalAmount: number;
  status: string;
};

export default function InvoiceDetailPage() {
  const { confirm } = useConfirm();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: invResp, loading: invLoading, refresh: refreshInvoice } = useCachedJson<{
    success?: boolean;
    data?: Invoice;
    lockReason?: string | null;
    // Adjustments raised against this invoice — server-side reverse lookups.
    linkedCreditNotes?: LinkedNote[];
    linkedDebitNotes?: LinkedNote[];
    // Reverse CN link from GET /api/invoices/:id. Non-null only for invoices
    // produced by POST /api/consignment-notes/:id/convert-to-invoice — those
    // rows carry no doNo / salesOrderId, so this is the only provenance the
    // viewer gets.
    sourceConsignmentNote?: { id: string; noteNumber: string } | null;
  }>(id ? `/api/invoices/${id}` : null);
  const invoice: Invoice | null = useMemo(() => {
    if (!invResp) return null;
    if (invResp.success && invResp.data) return invResp.data;
    return (invResp as unknown as Invoice) ?? null;
  }, [invResp]);
  const { data: allInvResp, refresh: refreshAllInvoices } = useCachedJson<{ success?: boolean; data?: Invoice[] }>(invoice ? "/api/invoices" : null);
  const customerInvoices: Invoice[] = useMemo(() => {
    if (!invoice) return [];
    const all = allInvResp?.success ? allInvResp.data ?? [] : Array.isArray(allInvResp) ? allInvResp : [];
    return all.filter((inv) => inv.customerName === invoice.customerName && inv.id !== invoice.id);
  }, [allInvResp, invoice]);
  const loading = invLoading;
  const [updating, setUpdating] = useState(false);

  // Per-line print enrichment (customer PO / SO / our company SO + the
  // resolved price build-up) — same source the PDF uses. Drives the
  // read-only refs line AND pre-fills the price editor.
  type LineExtra = import("@/lib/generate-invoice-pdf").InvoiceLineExtra;
  const { data: exResp, refresh: refreshExtras } = useCachedJson<{
    success?: boolean;
    data?: import("@/lib/generate-invoice-pdf").InvoicePrintExtras;
  }>(id ? `/api/invoices/${id}/print-extras` : null);
  const lineExtras: Record<string, LineExtra> = useMemo(
    () => (exResp?.success && exResp.data?.items ? exResp.data.items : {}),
    [exResp],
  );

  // Price editor state. `priceDraft` holds RM strings per line+component.
  // `discountDraft` holds per-line discount in sen (integer).
  const [editingPrices, setEditingPrices] = useState(false);
  const [savingPrices, setSavingPrices] = useState(false);
  const [priceDraft, setPriceDraft] = useState<
    Record<string, { base: string; divan: string; leg: string; special: string; totalHeight: string }>
  >({});
  const [discountDraft, setDiscountDraft] = useState<Record<string, number>>({});
  const rm = (sen: number) => (Math.round(Number(sen) || 0) / 100).toFixed(2);
  const sen = (s: string) => Math.max(0, Math.round((Number(s) || 0) * 100));
  // Edit allowed only on DRAFT or unpaid SENT (no payment recorded).
  const canEditPrices =
    !!invoice &&
    (invoice.status === "DRAFT" || invoice.status === "SENT") &&
    Number(invoice.paidAmount || 0) === 0;

  const beginEditPrices = () => {
    if (!invoice) return;
    const d: Record<
      string,
      { base: string; divan: string; leg: string; special: string; totalHeight: string }
    > = {};
    const dd: Record<string, number> = {};
    for (const it of invoice.items) {
      const ex = lineExtras[it.id];
      // Pre-fill from the resolved build-up (invoice's own if already
      // edited, else the sales-order figures). Fall back to unit price
      // as Base when nothing resolved.
      const base = ex ? ex.baseSen : Number(it.unitPriceSen) || 0;
      d[it.id] = {
        base: rm(base),
        divan: rm(ex?.divanSen || 0),
        leg: rm(ex?.legSen || 0),
        special: rm(ex?.specialSen || 0),
        totalHeight: rm(ex?.totalHeightSen || 0),
      };
      // Per-line discount (migration 0179). Pre-fill from stored value.
      dd[it.id] = Number(it.discountSen) || 0;
    }
    setPriceDraft(d);
    setDiscountDraft(dd);
    setEditingPrices(true);
  };

  const saveEditPrices = async () => {
    if (!invoice) return;
    setSavingPrices(true);
    const priceEdits = invoice.items.map((it) => {
      const d = priceDraft[it.id] || {
        base: "0",
        divan: "0",
        leg: "0",
        special: "0",
        totalHeight: "0",
      };
      return {
        id: it.id,
        baseSen: sen(d.base),
        divanSen: sen(d.divan),
        legSen: sen(d.leg),
        specialSen: sen(d.special),
        totalHeightSen: sen(d.totalHeight),
        // Per-line discount (migration 0179).
        discountSen: discountDraft[it.id] ?? 0,
      };
    });
    // Expected new invoice subtotal — sum of max(0, unit×qty − discount) per line.
    // Backend recomputes identically; comparing on totalAmount catches stale reads.
    const expectedTotal = invoice.items.reduce((sum, it) => {
      const e = priceEdits.find((p) => p.id === it.id);
      const unit = invoiceLineUnitSen({
        baseSen: e?.baseSen ?? 0,
        divanSen: e?.divanSen ?? 0,
        legSen: e?.legSen ?? 0,
        specialSen: e?.specialSen ?? 0,
        totalHeightSen: e?.totalHeightSen ?? 0,
      });
      const discount = e?.discountSen ?? 0;
      return sum + Math.max(0, unit * (Number(it.quantity) || 0) - discount);
    }, 0);
    // 2026-05-27 verifiedSave migration. Money-touching write — confirm
    // the new totalAmount actually persisted.
    const result = await verifiedSave<Invoice>({
      endpoint: `/api/invoices/${id}`,
      method: "PUT",
      body: { priceEdits },
      readback: async () => {
        const r = await fetch(`/api/invoices/${id}?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: Invoice } | Invoice;
        return (j as { data?: Invoice })?.data ?? (j as Invoice) ?? null;
      },
      expect: { totalAmount: expectedTotal },
    });
    if (result.ok) {
      if (id) invalidateCache(`/api/invoices/${id}`);
      invalidateCache(`/api/invoices/${id}/print-extras`);
      setEditingPrices(false);
      refreshInvoice();
      refreshExtras();
      setToast("Invoice prices updated");
    } else if (result.reason === "mismatch") {
      setToast(formatMismatchError(result.diffs));
    } else if (result.reason === "http") {
      let parsedErr = result.body;
      try {
        const j = JSON.parse(result.body) as { error?: string };
        if (j.error) parsedErr = j.error;
      } catch { /* keep raw body */ }
      setToast(humanizeError({ status: result.status, message: parsedErr }, "Couldn't update prices. Please try again."));
    } else {
      setToast(humanizeError(result.details, "Couldn't save. Please try again."));
    }
    setSavingPrices(false);
  };

  // Payment form state
  const [showPayment, setShowPayment] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("BANK_TRANSFER");
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [paymentReference, setPaymentReference] = useState("");

  // Toast state
  const [toast, setToast] = useState<string | null>(null);

  // Auto-dismiss toast — `null` disables the timer when no toast is showing.
  useTimeout(() => setToast(null), toast ? 3000 : null);

  // Pull the read-only price build-up / customer refs, then render the
  // A4 invoice. "download" saves the file; "view" opens it on screen.
  const printInvoicePdf = async (mode: "download" | "view" = "download") => {
    if (!invoice) return;
    let extras: import("@/lib/generate-invoice-pdf").InvoicePrintExtras = {};
    try {
      const r = await fetch(
        `/api/invoices/${encodeURIComponent(String(id))}/print-extras`,
      );
      const j = (await r.json()) as {
        success?: boolean;
        data?: import("@/lib/generate-invoice-pdf").InvoicePrintExtras;
      };
      if (j?.success && j.data) extras = j.data;
    } catch {
      /* graceful — PDF still renders without extras */
    }
    const { downloadUnifiedInvoicePdf } = await import("@/lib/unified-doc-download");
    void mode; // unified generator saves the file; "view" no longer applicable
    await downloadUnifiedInvoicePdf(invoice, extras);
  };

  const sendInvoice = async () => {
    if (!invoice) return;
    setUpdating(true);
    // 2026-05-27 verifiedSave migration. Sent-status drives downstream
    // billing visibility; confirm the flip landed before showing green.
    const result = await verifiedSave<Invoice>({
      endpoint: `/api/invoices/${id}`,
      method: "PUT",
      body: { status: "SENT" },
      readback: async () => {
        const r = await fetch(`/api/invoices/${id}?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: Invoice } | Invoice;
        return (j as { data?: Invoice })?.data ?? (j as Invoice) ?? null;
      },
      expect: { status: "SENT" },
    });
    if (result.ok) {
      // Only this invoice changed. Refresh the list too (status badge).
      if (id) invalidateCache(`/api/invoices/${id}`);
      refreshInvoice();
      refreshAllInvoices();
      setToast("Invoice sent successfully");
    } else if (result.reason === "mismatch") {
      setToast(formatMismatchError(result.diffs));
    } else if (result.reason === "http") {
      let parsedErr = result.body;
      try {
        const j = JSON.parse(result.body) as { error?: string };
        if (j.error) parsedErr = j.error;
      } catch { /* keep raw body */ }
      setToast(humanizeError({ status: result.status, message: parsedErr }, "Couldn't send the invoice. Please try again."));
    } else {
      setToast(humanizeError(result.details, "Couldn't save. Please try again."));
    }
    setUpdating(false);
  };

  const recordPayment = async () => {
    if (!invoice) return;
    const amountSen = Math.round(parseFloat(paymentAmount) * 100);
    if (isNaN(amountSen) || amountSen <= 0) return;

    setUpdating(true);
    const totalPaid = invoice.paidAmount + amountSen;
    // 2026-05-27 verifiedSave migration. Payment record is money-touching
    // — a false-green from a stale cache would leave bookkeeping out of
    // sync. Read back and confirm paidAmount actually landed.
    const result = await verifiedSave<Invoice>({
      endpoint: `/api/invoices/${id}`,
      method: "PUT",
      body: {
        paidAmount: totalPaid,
        paymentMethod,
        paymentDate,
        paymentReference,
      },
      readback: async () => {
        const r = await fetch(`/api/invoices/${id}?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: Invoice } | Invoice;
        return (j as { data?: Invoice })?.data ?? (j as Invoice) ?? null;
      },
      expect: { paidAmount: totalPaid },
    });
    if (result.ok) {
      // Recording payment can cascade to SO → CLOSED when all linked invoices
      // are paid. Conservative: keep SO prefix. DO does not change on payment.
      if (id) invalidateCache(`/api/invoices/${id}`);
      invalidateCachePrefix("/api/sales-orders");
      refreshInvoice();
      refreshAllInvoices();
      setShowPayment(false);
      setPaymentAmount("");
      setPaymentReference("");
      setToast("Payment recorded successfully");
    } else if (result.reason === "mismatch") {
      setToast(formatMismatchError(result.diffs));
    } else if (result.reason === "http") {
      let parsedErr = result.body;
      try {
        const j = JSON.parse(result.body) as { error?: string };
        if (j.error) parsedErr = j.error;
      } catch { /* keep raw body */ }
      setToast(humanizeError({ status: result.status, message: parsedErr }, "Couldn't record the payment. Please try again."));
    } else {
      setToast(humanizeError(result.details, "Couldn't save. Please try again."));
    }
    setUpdating(false);
  };

  const deleteInvoice = async () => {
    if (!(await confirm({ title: "Delete invoice", message: "Delete this invoice?", danger: true }))) return;
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        setToast(humanizeError({ status: res.status, message: body?.error }, "Couldn't delete the invoice. Please try again."));
        return;
      }
      // Deletion cascades server-side: DO flips back from INVOICED, SO may
      // reopen. Invoice list needs the prefix so the row vanishes.
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/delivery-orders");
      invalidateCachePrefix("/api/sales-orders");
      if (id) invalidateCache(`/api/invoices/${id}`);
      navigate("/invoices");
    } catch (e) {
      setToast(humanizeError(e, "Couldn't delete the invoice. Please try again."));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6B7280]">
        Loading...
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-[#6B7280]">Invoice not found</div>
        <Button variant="outline" onClick={() => navigate("/invoices")}>
          Back
        </Button>
      </div>
    );
  }

  // During price-edit mode, show a live-computed total based on the draft values
  // so the operator sees the discount's impact before saving.
  const liveInvoiceTotalSen = editingPrices
    ? invoice.items.reduce((s, it) => {
        const dd = priceDraft[it.id];
        const u = dd
          ? invoiceLineUnitSen({
              baseSen: sen(dd.base),
              divanSen: sen(dd.divan),
              legSen: sen(dd.leg),
              specialSen: sen(dd.special),
              totalHeightSen: sen(dd.totalHeight),
            })
          : Number(it.unitPriceSen) || 0;
        const disc = discountDraft[it.id] ?? 0;
        return s + Math.max(0, u * (Number(it.quantity) || 0) - disc);
      }, 0)
    : invoice.totalSen;
  const balanceSen = liveInvoiceTotalSen - invoice.paidAmount;
  const totalQty = invoice.items.reduce((s, i) => s + i.quantity, 0);
  const payments = invoice.payments || [];
  // Cascade lock — surfaced from /api/invoices/:id. Non-null when payment
  // is recorded against this invoice (status=PAID or paidAmountSen > 0).
  const lockReason = (invResp as { lockReason?: string | null } | undefined)?.lockReason ?? null;
  // Adjustments raised against this invoice — server-side reverse lookups.
  const linkedCreditNotes: LinkedNote[] = invResp?.linkedCreditNotes ?? [];
  const linkedDebitNotes: LinkedNote[] = invResp?.linkedDebitNotes ?? [];
  const creditedSen = linkedCreditNotes
    .filter((n) => n.status !== "DRAFT")
    .reduce((s, n) => s + (n.totalAmount || 0), 0);
  const debitedSen = linkedDebitNotes
    .filter((n) => n.status !== "DRAFT")
    .reduce((s, n) => s + (n.totalAmount || 0), 0);
  // Provenance line for CN-origin invoices (see the type above).
  const sourceCN = invResp?.sourceConsignmentNote ?? null;

  return (
    <div className="space-y-6 max-md:space-y-4">
      <LockBanner reason={lockReason} />
      {sourceCN && (
        <p className="text-xs text-[#6B7280]">
          Created from consignment note{" "}
          <button
            type="button"
            className="doc-number underline underline-offset-2 hover:text-[#1F1D1B]"
            onClick={() => navigate(`/consignment/note?focus=${sourceCN.id}`)}
          >
            {sourceCN.noteNumber || sourceCN.id}
          </button>
        </p>
      )}
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-[#4F7C3A] text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-top-2">
          <CheckCircle2 className="h-5 w-5" />
          {toast}
        </div>
      )}

      {/* Header */}
      <ObjectPageHeader
        backTo="/invoices"
        title={invoice.invoiceNo}
        subtitle={`${invoice.customerName} · ${invoice.customerState}`}
        badges={<Badge variant="status" status={invoice.status} />}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void printInvoicePdf("view")}
            >
              <FileText className="h-4 w-4" /> View Documentation
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void printInvoicePdf("download")}
            >
              <Download className="h-4 w-4" /> PDF
            </Button>
            {canEditPrices && !editingPrices && (
              <Button
                variant="outline"
                size="sm"
                onClick={beginEditPrices}
              >
                <DollarSign className="h-4 w-4" /> Edit Prices
              </Button>
            )}
            {editingPrices && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void saveEditPrices()}
                  disabled={savingPrices}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {savingPrices ? "Saving..." : "Save Prices"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingPrices(false)}
                  disabled={savingPrices}
                >
                  Cancel
                </Button>
              </>
            )}
            {invoice.status === "DRAFT" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[#9A3A2D] hover:text-[#7A2E24]"
                  onClick={deleteInvoice}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={sendInvoice}
                  disabled={updating}
                >
                  <Send className="h-4 w-4" />
                  Send Invoice
                </Button>
              </>
            )}
            {(invoice.status === "SENT" || invoice.status === "PARTIAL_PAID") && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setPaymentAmount(String(balanceSen / 100));
                  setPaymentDate(new Date().toISOString().split("T")[0]);
                  setPaymentReference("");
                  setShowPayment(true);
                }}
              >
                <CreditCard className="h-4 w-4" />
                Record Payment
              </Button>
            )}
          </>
        }
      />

      {/* KPI Strip — Total / Paid / Balance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-[#E2DDD8]">
          <CardContent className="p-5">
            <p className="text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide mb-2">
              Invoice Total
            </p>
            <p className="text-2xl font-bold text-[#1F1D1B] tabular-nums">
              {formatCurrency(liveInvoiceTotalSen)}
            </p>
            <p className="text-xs text-[#9CA3AF] mt-1">
              {invoice.items.length} line{invoice.items.length !== 1 ? "s" : ""} · {totalQty} units
            </p>
          </CardContent>
        </Card>
        <Card className="border-[#E2DDD8]">
          <CardContent className="p-5">
            <p className="text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide mb-2">
              Amount Paid
            </p>
            <p className="text-2xl font-bold text-[#16A34A] tabular-nums">
              {invoice.paidAmount > 0 ? formatCurrency(invoice.paidAmount) : "RM 0.00"}
            </p>
            <p className="text-xs text-[#9CA3AF] mt-1">
              {payments.length > 0
                ? `${payments.length} payment${payments.length !== 1 ? "s" : ""} recorded`
                : "No payments yet"}
            </p>
          </CardContent>
        </Card>
        <Card className={`border-2 ${balanceSen > 0 ? "border-[#DC2626]/30 bg-[#FEF2F2]" : "border-[#16A34A]/30 bg-[#F0FDF4]"}`}>
          <CardContent className="p-5">
            <p className="text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide mb-2">
              Balance Due
            </p>
            <p className={`text-2xl font-bold tabular-nums ${balanceSen > 0 ? "text-[#DC2626]" : "text-[#16A34A]"}`}>
              {balanceSen > 0 ? formatCurrency(balanceSen) : "PAID"}
            </p>
            <p className="text-xs text-[#9CA3AF] mt-1">
              {balanceSen > 0
                ? `Due ${formatDate(invoice.dueDate)}`
                : "Fully settled"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        {/* Left Column: Invoice Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* From + Bill To as side-by-side cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* From */}
            <Card>
              <CardContent className="p-6 max-md:p-4 max-sm:p-3">
                <div className="flex items-center gap-2 mb-4">
                  <Building2 className="h-4 w-4 text-[#6B5C32]" />
                  <h3 className="text-xs font-bold text-[#6B5C32] uppercase tracking-wide">
                    From
                  </h3>
                </div>
                <p className="font-bold text-[#1F1D1B] text-base">
                  HOOKKA INDUSTRIES SDN BHD
                </p>
                <p className="text-sm text-[#6B7280] mt-1">
                  Manufacturer of Premium Upholstered Furniture
                </p>
                <p className="text-sm text-[#6B7280]">
                  Tel: +60X-XXXXXXX
                </p>
              </CardContent>
            </Card>

            {/* Bill To */}
            <Card>
              <CardContent className="p-6 max-md:p-4 max-sm:p-3">
                <div className="flex items-center gap-2 mb-4">
                  <Building2 className="h-4 w-4 text-[#6B5C32]" />
                  <h3 className="text-xs font-bold text-[#6B5C32] uppercase tracking-wide">
                    Bill To
                  </h3>
                </div>
                <p className="font-bold text-[#1F1D1B] text-base">
                  {invoice.customerName}
                </p>
                <p className="text-sm text-[#6B7280] mt-1">
                  {invoice.customerState}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Invoice Dates & References */}
          <Card>
            <CardContent className="p-6 max-md:p-4 max-sm:p-3">
              <h3 className="text-xs font-bold text-[#6B5C32] uppercase tracking-wide mb-4">
                Invoice Details
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 max-sm:grid-cols-1">
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Calendar className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">Invoice Date</p>
                  </div>
                  <p className="font-medium text-[#1F1D1B]">
                    {formatDate(invoice.invoiceDate)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Calendar className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">Due Date</p>
                  </div>
                  <p
                    className={`font-medium ${
                      new Date(invoice.dueDate) < new Date() &&
                      !["PAID", "CANCELLED"].includes(invoice.status)
                        ? "text-[#DC2626]"
                        : "text-[#1F1D1B]"
                    }`}
                  >
                    {formatDate(invoice.dueDate)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Package className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">DO Ref</p>
                  </div>
                  <p className="font-medium text-[#1F1D1B] doc-number">
                    {invoice.doNo}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <FileText className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">Status</p>
                  </div>
                  <Badge variant="status" status={invoice.status} />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Items Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-5 w-5 text-[#6B5C32]" />
                Line Items
                <span className="text-sm font-normal text-[#9CA3AF]">
                  — {invoice.items.length} line{invoice.items.length !== 1 ? "s" : ""}, {totalQty} units
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {/* min-w lets the table exceed a narrow container and scroll
                  instead of crushing every column into an unreadable stack
                  (owner: "整个挤在一起"). Product gets the lion's share since it
                  carries the name + the PO/SO/REF + spec sub-lines. */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b-2 border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563] w-8">
                        #
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563] whitespace-nowrap">
                        SO
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563] min-w-[240px]">
                        Product
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Size
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Fabric
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Qty
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Unit Price
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Line Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.items.map((item, idx) => {
                      const ex = lineExtras[item.id];
                      const d = priceDraft[item.id];
                      const qty = Number(item.quantity) || 0;
                      const liveUnit =
                        editingPrices && d
                          ? invoiceLineUnitSen({
                              baseSen: sen(d.base),
                              divanSen: sen(d.divan),
                              legSen: sen(d.leg),
                              specialSen: sen(d.special),
                              totalHeightSen: sen(d.totalHeight),
                            })
                          : Number(item.unitPriceSen) || 0;
                      // Per-line discount (migration 0179).
                      const liveDiscount = editingPrices
                        ? (discountDraft[item.id] ?? 0)
                        : (Number(item.discountSen) || 0);
                      const liveLineTotal = Math.max(0, liveUnit * qty - liveDiscount);
                      // Our company SO is its own column (left of Product);
                      // the customer's PO / SO / REF stay as a sub-line.
                      const companySO =
                        (ex?.companySO || "").trim() ||
                        (invoice.companySOId || "").trim() ||
                        "-";
                      const refBits = ex
                        ? [
                            `PO: ${ex.customerPOId || "-"}`,
                            `Cust SO: ${ex.customerSOLine || "-"}`,
                            `REF: ${ex.customerRefLine || "-"}`,
                          ].join("  ·  ")
                        : "";
                      const specBits = ex
                        ? [
                            ex.divanHeightInches
                              ? `DIVAN ${ex.divanHeightInches}"${ex.legHeightInches ? ` + ${ex.legHeightInches}" LEG` : ""}`
                              : "",
                            ex.gapInches ? `GAP ${ex.gapInches}"` : "",
                            // T.Heights is bedframe-only (divan + gap + leg);
                            // a sofa has no total height, so only show it when
                            // the row actually has a divan. — Wei Siang 2026-05-29
                            ex.totalHeightInches && ex.divanHeightInches
                              ? `T.Heights ${ex.totalHeightInches}"`
                              : "",
                            (ex.specialOrder || "").trim(),
                          ]
                            .filter(Boolean)
                            .join(" / ")
                        : "";
                      const setDraft = (
                        k: "base" | "divan" | "leg" | "special" | "totalHeight",
                        v: string,
                      ) =>
                        setPriceDraft((p) => ({
                          ...p,
                          [item.id]: {
                            ...(p[item.id] || {
                              base: "0",
                              divan: "0",
                              leg: "0",
                              special: "0",
                              totalHeight: "0",
                            }),
                            [k]: v,
                          },
                        }));
                      const priceInput = (
                        label: string,
                        k: "base" | "divan" | "leg" | "special" | "totalHeight",
                      ) => (
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="text-[10px] text-[#9CA3AF] w-12 text-right">
                            {label}
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={d ? d[k] : "0"}
                            onChange={(e) => setDraft(k, e.target.value)}
                            className="w-24 rounded border border-[#D8D2CC] px-2 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                          />
                        </div>
                      );
                      return (
                        <tr
                          key={item.id}
                          className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
                        >
                          <td className="py-3.5 px-4 text-[#9CA3AF] align-top">
                            {idx + 1}
                          </td>
                          <td className="py-3.5 px-4 align-top doc-number font-medium text-[#1F1D1B] whitespace-nowrap">
                            {companySO}
                          </td>
                          <td className="py-3.5 px-4 align-top min-w-[240px]">
                            <p className="font-medium text-[#1F1D1B]">
                              {item.productName}
                            </p>
                            <p className="text-xs text-[#9CA3AF] mt-0.5">
                              {item.productCode}
                            </p>
                            {refBits && (
                              <p className="text-[11px] text-[#6B7280] mt-1 tabular-nums">
                                {refBits}
                              </p>
                            )}
                            {specBits && (
                              <p className="text-[11px] text-[#9CA3AF] mt-0.5">
                                {specBits}
                              </p>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-[#4B5563] align-top whitespace-nowrap">
                            {item.sizeLabel}
                          </td>
                          <td className="py-3.5 px-4 text-[#4B5563] align-top whitespace-nowrap">
                            {item.fabricCode}
                          </td>
                          <td className="py-3.5 px-4 text-right font-medium text-[#1F1D1B] align-top tabular-nums">
                            {item.quantity}
                          </td>
                          <td className="py-3.5 px-4 text-right text-[#4B5563] align-top">
                            {editingPrices ? (
                              <div className="space-y-1.5">
                                {priceInput("Base", "base")}
                                {priceInput("Divan", "divan")}
                                {priceInput("Leg", "leg")}
                                {priceInput("T.Height", "totalHeight")}
                                {priceInput("Special", "special")}
                                <p className="text-[11px] text-[#6B5C32] font-medium pt-1">
                                  Unit {formatCurrency(liveUnit)}
                                </p>
                                {/* Per-line Discount (migration 0179) */}
                                <div className="flex items-center justify-end gap-1.5 pt-1 border-t border-[#E2DDD8]">
                                  <span className="text-[10px] text-[#9CA3AF] w-12 text-right">Discount</span>
                                  <DiscountInput
                                    baseAmountSen={liveUnit * qty}
                                    valueSen={discountDraft[item.id] ?? null}
                                    onChange={(discSen) =>
                                      setDiscountDraft((prev) => ({
                                        ...prev,
                                        [item.id]: discSen ?? 0,
                                      }))
                                    }
                                    className="h-7 w-24 text-xs"
                                  />
                                </div>
                              </div>
                            ) : ex &&
                              (ex.divanSen || ex.legSen || ex.totalHeightSen || ex.specialSen) ? (
                              <div className="text-xs leading-relaxed tabular-nums">
                                <div>Base {formatCurrency(ex.baseSen)}</div>
                                {!!ex.divanSen && (
                                  <div>+ Divan {formatCurrency(ex.divanSen)}</div>
                                )}
                                {!!ex.legSen && (
                                  <div>+ Leg {formatCurrency(ex.legSen)}</div>
                                )}
                                {!!ex.totalHeightSen && (
                                  <div>+ T.Height {formatCurrency(ex.totalHeightSen)}</div>
                                )}
                                {!!ex.specialSen && (
                                  <div>
                                    + Special {formatCurrency(ex.specialSen)}
                                  </div>
                                )}
                                <div className="font-semibold text-[#1F1D1B] border-t border-[#E2DDD8] pt-0.5 mt-0.5">
                                  = {formatCurrency(liveUnit)}
                                </div>
                              </div>
                            ) : (
                              <span className="tabular-nums">{formatCurrency(liveUnit)}</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right font-semibold text-[#1F1D1B] align-top tabular-nums">
                            {liveDiscount > 0 && !editingPrices ? (
                              <div className="text-xs space-y-0.5">
                                <div className="text-[#9CA3AF] line-through">{formatCurrency(liveUnit * qty)}</div>
                                <div className="text-[11px] text-[#9CA3AF]">- {formatCurrency(liveDiscount)}</div>
                                <div className="font-semibold text-[#1F1D1B]">{formatCurrency(liveLineTotal)}</div>
                              </div>
                            ) : (
                              formatCurrency(liveLineTotal)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {(() => {
                      const liveSubtotal = editingPrices
                        ? invoice.items.reduce((s, it) => {
                            const dd = priceDraft[it.id];
                            const u = dd
                              ? invoiceLineUnitSen({
                                  baseSen: sen(dd.base),
                                  divanSen: sen(dd.divan),
                                  legSen: sen(dd.leg),
                                  specialSen: sen(dd.special),
                                  totalHeightSen: sen(dd.totalHeight),
                                })
                              : Number(it.unitPriceSen) || 0;
                            const disc = discountDraft[it.id] ?? 0;
                            return s + Math.max(0, u * (Number(it.quantity) || 0) - disc);
                          }, 0)
                        : Number(invoice.subtotalSen) || 0;
                      return (
                        <>
                          <tr className="border-t-2 border-[#E2DDD8]">
                            <td
                              colSpan={7}
                              className="py-3 px-4 text-right font-medium text-[#6B7280]"
                            >
                              Subtotal
                            </td>
                            <td className="py-3 px-4 text-right font-medium text-[#1F1D1B] tabular-nums">
                              {formatCurrency(liveSubtotal)}
                            </td>
                          </tr>
                          <tr className="bg-[#F0ECE9]">
                            <td
                              colSpan={7}
                              className="py-4 px-4 text-right font-bold text-[#6B5C32] text-base"
                            >
                              TOTAL
                            </td>
                            <td className="py-4 px-4 text-right font-bold text-[#6B5C32] text-xl tabular-nums">
                              {formatCurrency(liveSubtotal)}
                            </td>
                          </tr>
                        </>
                      );
                    })()}
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Payment History */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-5 w-5 text-[#6B5C32]" />
                Payment History
                <span className="text-sm font-normal text-[#9CA3AF]">
                  — {payments.length} record{payments.length !== 1 ? "s" : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {payments.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] text-center py-8">
                  No payments recorded yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-[#E2DDD8] bg-[#F0ECE9]">
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          #
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Date
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Method
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Reference
                        </th>
                        <th className="text-right py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment, idx) => (
                        <tr
                          key={payment.id}
                          className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
                        >
                          <td className="py-3.5 px-4 text-[#9CA3AF]">{idx + 1}</td>
                          <td className="py-3.5 px-4 text-[#4B5563]">
                            {formatDate(payment.date)}
                          </td>
                          <td className="py-3.5 px-4 text-[#4B5563]">
                            {payment.method.replace(/_/g, " ")}
                          </td>
                          <td className="py-3.5 px-4 text-[#4B5563] font-mono text-xs">
                            {payment.reference || "-"}
                          </td>
                          <td className="py-3.5 px-4 text-right font-semibold text-[#16A34A] tabular-nums">
                            {formatCurrency(payment.amountSen)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[#E2DDD8] bg-[#F0ECE9]">
                        <td colSpan={4} className="py-3 px-4 text-right font-bold text-[#6B7280]">
                          Total Paid
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-[#16A34A] tabular-nums">
                          {formatCurrency(payments.reduce((s, p) => s + p.amountSen, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          {invoice.notes && (
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-bold text-[#9CA3AF] uppercase mb-1">
                  Notes
                </p>
                <p className="text-sm text-[#4B5563]">{invoice.notes}</p>
              </CardContent>
            </Card>
          )}

          {/* Customer Statement */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-5 w-5 text-[#6B5C32]" />
                Customer Statement - {invoice.customerName}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {customerInvoices.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] text-center py-6">
                  No other invoices for this customer.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Invoice No.
                        </th>
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Date
                        </th>
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Due Date
                        </th>
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Status
                        </th>
                        <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Total
                        </th>
                        <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Paid
                        </th>
                        <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Balance
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {customerInvoices.map((ci) => {
                        const ciBalance = ci.totalSen - ci.paidAmount;
                        return (
                          <tr
                            key={ci.id}
                            className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50 cursor-pointer"
                            onClick={() => navigate(`/invoices/${ci.id}`)}
                          >
                            <td className="py-2.5 px-3 font-medium doc-number">
                              {ci.invoiceNo}
                            </td>
                            <td className="py-2.5 px-3 text-[#4B5563]">
                              {formatDate(ci.invoiceDate)}
                            </td>
                            <td className="py-2.5 px-3 text-[#4B5563]">
                              {formatDate(ci.dueDate)}
                            </td>
                            <td className="py-2.5 px-3">
                              <Badge variant="status" status={ci.status} />
                            </td>
                            <td className="py-2.5 px-3 text-right font-medium text-[#1F1D1B]">
                              {formatCurrency(ci.totalSen)}
                            </td>
                            <td className="py-2.5 px-3 text-right text-[#4F7C3A]">
                              {ci.paidAmount > 0 ? formatCurrency(ci.paidAmount) : "-"}
                            </td>
                            <td className={`py-2.5 px-3 text-right font-medium ${ciBalance > 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                              {ciBalance > 0 ? formatCurrency(ciBalance) : "-"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[#E2DDD8] bg-[#F0ECE9]">
                        <td colSpan={4} className="py-2.5 px-3 text-right font-bold text-[#6B5C32]">
                          Customer Total
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-[#1F1D1B]">
                          {formatCurrency(customerInvoices.reduce((s, ci) => s + ci.totalSen, 0))}
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-[#4F7C3A]">
                          {formatCurrency(customerInvoices.reduce((s, ci) => s + ci.paidAmount, 0))}
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-[#9A3A2D]">
                          {formatCurrency(customerInvoices.reduce((s, ci) => s + (ci.totalSen - ci.paidAmount), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Actions + Status */}
        <div className="space-y-6">
          {/* Record Payment — shown only when there's an outstanding balance */}
          {(invoice.status === "SENT" || invoice.status === "PARTIAL_PAID") && (
            <Card className="border-[#6B5C32]/30 bg-[#FAF9F7]">
              <CardContent className="p-5">
                <p className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide mb-3">
                  Outstanding Balance
                </p>
                <p className="text-3xl font-bold text-[#DC2626] tabular-nums mb-1">
                  {formatCurrency(balanceSen)}
                </p>
                <p className="text-xs text-[#9CA3AF] mb-4">
                  Due {formatDate(invoice.dueDate)}
                </p>
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => {
                    setPaymentAmount(String(balanceSen / 100));
                    setPaymentDate(new Date().toISOString().split("T")[0]);
                    setPaymentReference("");
                    setShowPayment(true);
                  }}
                >
                  <CreditCard className="h-4 w-4" />
                  Record Payment
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Last payment details — shown when a payment has been recorded */}
          {invoice.paymentDate && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <DollarSign className="h-5 w-5 text-[#6B5C32]" />
                  Last Payment
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-[#9CA3AF]">Date</span>
                  <span className="text-sm font-medium text-[#4B5563]">
                    {formatDate(invoice.paymentDate)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-[#9CA3AF]">Method</span>
                  <span className="text-sm font-medium text-[#4B5563]">
                    {invoice.paymentMethod.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="flex justify-between items-center border-t border-[#E2DDD8] pt-3">
                  <span className="text-xs text-[#9CA3AF]">Balance</span>
                  <span className={`text-base font-bold tabular-nums ${balanceSen > 0 ? "text-[#DC2626]" : "text-[#16A34A]"}`}>
                    {balanceSen > 0 ? formatCurrency(balanceSen) : "PAID"}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Status Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Invoice Lifecycle</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {["DRAFT", "SENT", "PAID"].map((st) => {
                  const isCurrent = invoice.status === st;
                  const isPast =
                    (st === "DRAFT" &&
                      ["SENT", "PAID", "PARTIAL_PAID"].includes(invoice.status)) ||
                    (st === "SENT" &&
                      ["PAID", "PARTIAL_PAID"].includes(invoice.status));
                  const isPartial =
                    st === "PAID" && invoice.status === "PARTIAL_PAID";

                  return (
                    <div key={st} className="flex items-center gap-3">
                      <div
                        className={`h-3.5 w-3.5 rounded-full border-2 flex-shrink-0 ${
                          isPast || (isCurrent && st === "PAID")
                            ? "bg-[#16A34A] border-[#16A34A]"
                            : isCurrent || isPartial
                            ? "bg-[#6B5C32] border-[#6B5C32]"
                            : "bg-white border-[#E2DDD8]"
                        }`}
                      />
                      <span
                        className={`text-sm ${
                          isPast || isCurrent || isPartial
                            ? "font-semibold text-[#1F1D1B]"
                            : "text-[#9CA3AF]"
                        }`}
                      >
                        {st === "PAID" && isPartial
                          ? "PARTIAL PAID"
                          : st.replace(/_/g, " ")}
                      </span>
                      {isCurrent && (
                        <span className="ml-auto text-xs bg-[#6B5C32]/10 text-[#6B5C32] px-2 py-0.5 rounded-full font-medium">
                          Now
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Quick Info */}
          <Card>
            <CardContent className="p-5 space-y-3">
              <p className="text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide">
                Record
              </p>
              <div className="flex justify-between items-center">
                <span className="text-xs text-[#9CA3AF]">Created</span>
                <span className="text-sm text-[#6B7280]">
                  {formatDate(invoice.createdAt)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-[#9CA3AF]">Last Updated</span>
                <span className="text-sm text-[#6B7280]">
                  {formatDate(invoice.updatedAt)}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Payment Modal */}
      {showPayment && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-[#1F1D1B] mb-4">
              Record Payment
            </h2>
            <p className="text-sm text-[#6B7280] mb-4">
              Balance due: <span className="font-bold text-[#9A3A2D]">{formatCurrency(balanceSen)}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#4B5563] mb-1">
                  Payment Amount (RM)
                </label>
                <input
                  type="number" onFocus={(e) => e.currentTarget.select()}
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
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setShowPayment(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={recordPayment}
                disabled={
                  updating ||
                  !paymentAmount ||
                  parseFloat(paymentAmount) <= 0
                }
              >
                {updating ? "Processing..." : "Record Payment"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Adjustments raised against this invoice. Rendered only when there are
          any — a posted credit note moves the amount actually receivable, which
          this page had no way to show. */}
      {(linkedCreditNotes.length > 0 || linkedDebitNotes.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-[#6B5C32]" />
              Adjustments
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {([
              { title: "Credit Notes", notes: linkedCreditNotes, total: creditedSen, href: "/invoices/credit-notes", sign: "−" },
              { title: "Debit Notes", notes: linkedDebitNotes, total: debitedSen, href: "/invoices/debit-notes", sign: "+" },
            ] as const)
              .filter((g) => g.notes.length > 0)
              .map((g) => (
                <div key={g.title} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-[#4B5563]">
                      {g.title} ({g.notes.length})
                    </p>
                    <p className="text-sm font-semibold text-[#1F1D1B] tabular-nums">
                      {g.sign}
                      {formatCurrency(g.total)}
                    </p>
                  </div>
                  {g.notes.map((n) => (
                    <div
                      key={n.id}
                      className="flex flex-wrap items-center justify-between gap-2 border border-[#E2DDD8] rounded-md px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => navigate(g.href)}
                          className="text-sm font-medium text-[#6B5C32] hover:underline"
                        >
                          {n.noteNumber || n.id}
                        </button>
                        <Badge variant="status" status={n.status}>
                          {n.status}
                        </Badge>
                        {n.reason && (
                          <span className="text-xs text-[#9CA3AF] truncate">
                            {n.reason.replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-[#9CA3AF]">{n.date ? formatDate(n.date) : ""}</span>
                        <span className="text-sm tabular-nums">{formatCurrency(n.totalAmount)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            <p className="text-xs text-[#9CA3AF]">
              Net of posted adjustments: {formatCurrency(invoice.totalSen - creditedSen + debitedSen)}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Document Relationship — same chain graph as the SO page, so you can
          see how THIS invoice connects to its SO / DO / payments from here. */}
      {invoice && (invoice.salesOrderId || invoice.companySOId) && (
        <DocumentChainMap
          soId={invoice.salesOrderId || invoice.companySOId}
          currentDocNo={invoice.invoiceNo}
        />
      )}

      {/* Audit trail for this invoice */}
      {invoice && <AuditHistoryPanel resource="invoices" resourceId={invoice.id} />}
    </div>
  );
}
