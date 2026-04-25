import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  ArrowLeft,
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
import { generateInvoicePdf } from "@/lib/generate-invoice-pdf";
import type { Invoice } from "@/lib/mock-data";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { InvoiceSchema } from "@/lib/schemas/invoice";

const InvoiceMutationSchema = mutationWithData(InvoiceSchema);

const PAYMENT_METHODS = [
  { value: "BANK_TRANSFER", label: "Bank Transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CASH", label: "Cash" },
  { value: "CREDIT_CARD", label: "Credit Card" },
  { value: "E_WALLET", label: "E-Wallet" },
];

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: invResp, loading: invLoading, refresh: refreshInvoice } = useCachedJson<{ success?: boolean; data?: Invoice }>(id ? `/api/invoices/${id}` : null);
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

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const sendInvoice = async () => {
    if (!invoice) return;
    setUpdating(true);
    try {
      const data = await fetchJson(`/api/invoices/${id}`, InvoiceMutationSchema, {
        method: "PUT",
        body: { status: "SENT" },
      });
      if (data.success) {
        // Only this invoice changed. Refresh the list too (status badge).
        if (id) invalidateCache(`/api/invoices/${id}`);
        refreshInvoice();
        refreshAllInvoices();
        setToast("Invoice sent successfully");
      }
    } catch {
      // ignore — UI stays in current state
    }
    setUpdating(false);
  };

  const recordPayment = async () => {
    if (!invoice) return;
    const amountSen = Math.round(parseFloat(paymentAmount) * 100);
    if (isNaN(amountSen) || amountSen <= 0) return;

    setUpdating(true);
    const totalPaid = invoice.paidAmount + amountSen;
    try {
      const data = await fetchJson(`/api/invoices/${id}`, InvoiceMutationSchema, {
        method: "PUT",
        body: {
          paidAmount: totalPaid,
          paymentMethod,
          paymentDate,
          paymentReference,
        },
      });
      if (data.success) {
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
      }
    } catch {
      // ignore
    }
    setUpdating(false);
  };

  const deleteInvoice = async () => {
    if (!confirm("Delete this invoice?")) return;
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        setToast(body?.error || `Failed to delete invoice (HTTP ${res.status})`);
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
      setToast(e instanceof Error ? e.message : "Network error — invoice not deleted");
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

  const balanceSen = invoice.totalSen - invoice.paidAmount;
  const totalQty = invoice.items.reduce((s, i) => s + i.quantity, 0);
  const payments = invoice.payments || [];

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-[#4F7C3A] text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-top-2">
          <CheckCircle2 className="h-5 w-5" />
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/invoices")}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B] doc-number">
              {invoice.invoiceNo}
            </h1>
            <Badge variant="status" status={invoice.status} />
          </div>
          <p className="text-xs text-[#6B7280]">
            {invoice.customerName} &middot; {invoice.customerState}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => invoice && generateInvoicePdf(invoice)}
          >
            <Download className="h-4 w-4" /> PDF
          </Button>
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
        </div>
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        {/* Left Column: Invoice Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Company & Customer Info */}
          <Card>
            <CardContent className="p-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {/* From */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Building2 className="h-4 w-4 text-[#6B5C32]" />
                    <h3 className="text-sm font-bold text-[#6B5C32] uppercase">
                      From
                    </h3>
                  </div>
                  <p className="font-bold text-[#1F1D1B]">
                    HOOKKA INDUSTRIES SDN BHD
                  </p>
                  <p className="text-xs text-[#6B7280]">
                    Manufacturer of Premium Upholstered Furniture
                  </p>
                  <p className="text-xs text-[#6B7280]">
                    Tel: +60X-XXXXXXX
                  </p>
                </div>

                {/* Bill To */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Building2 className="h-4 w-4 text-[#6B5C32]" />
                    <h3 className="text-sm font-bold text-[#6B5C32] uppercase">
                      Bill To
                    </h3>
                  </div>
                  <p className="font-bold text-[#1F1D1B]">
                    {invoice.customerName}
                  </p>
                  <p className="text-xs text-[#6B7280]">
                    State: {invoice.customerState}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Invoice Dates & References */}
          <Card>
            <CardContent className="p-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Calendar className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">Invoice Date</p>
                  </div>
                  <p className="font-medium text-[#1F1D1B]">
                    {formatDate(invoice.invoiceDate)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Calendar className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">Due Date</p>
                  </div>
                  <p
                    className={`font-medium ${
                      new Date(invoice.dueDate) < new Date() &&
                      !["PAID", "CANCELLED"].includes(invoice.status)
                        ? "text-[#9A3A2D]"
                        : "text-[#1F1D1B]"
                    }`}
                  >
                    {formatDate(invoice.dueDate)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <FileText className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">SO Ref</p>
                  </div>
                  <p className="font-medium text-[#1F1D1B] doc-number">
                    {invoice.companySOId}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Package className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    <p className="text-xs text-[#9CA3AF] uppercase">DO Ref</p>
                  </div>
                  <p className="font-medium text-[#1F1D1B] doc-number">
                    {invoice.doNo}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Items Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-5 w-5 text-[#6B5C32]" />
                Items ({invoice.items.length} lines, {totalQty} qty)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                        #
                      </th>
                      <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                        Product
                      </th>
                      <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                        Size
                      </th>
                      <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                        Fabric
                      </th>
                      <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
                        Qty
                      </th>
                      <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
                        Unit Price
                      </th>
                      <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.items.map((item, idx) => (
                      <tr
                        key={item.id}
                        className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
                      >
                        <td className="py-2.5 px-3 text-[#9CA3AF]">{idx + 1}</td>
                        <td className="py-2.5 px-3">
                          <p className="font-medium text-[#1F1D1B]">
                            {item.productName}
                          </p>
                          <p className="text-xs text-[#9CA3AF]">{item.productCode}</p>
                        </td>
                        <td className="py-2.5 px-3 text-[#4B5563]">
                          {item.sizeLabel}
                        </td>
                        <td className="py-2.5 px-3 text-[#4B5563]">
                          {item.fabricCode}
                        </td>
                        <td className="py-2.5 px-3 text-right font-medium text-[#1F1D1B]">
                          {item.quantity}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#4B5563]">
                          {formatCurrency(item.unitPriceSen)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-medium text-[#1F1D1B]">
                          {formatCurrency(item.totalSen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[#E2DDD8]">
                      <td colSpan={6} className="py-2.5 px-3 text-right font-medium text-[#6B7280]">
                        Subtotal
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium text-[#1F1D1B]">
                        {formatCurrency(invoice.subtotalSen)}
                      </td>
                    </tr>
                    <tr className="bg-[#F0ECE9]">
                      <td colSpan={6} className="py-3 px-3 text-right font-bold text-[#6B5C32]">
                        TOTAL
                      </td>
                      <td className="py-3 px-3 text-right font-bold text-[#6B5C32] text-lg">
                        {formatCurrency(invoice.totalSen)}
                      </td>
                    </tr>
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
                Payment History ({payments.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {payments.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] text-center py-6">
                  No payments recorded yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          #
                        </th>
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Date
                        </th>
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Method
                        </th>
                        <th className="text-left py-2 px-3 text-xs font-bold text-[#4B5563]">
                          Reference
                        </th>
                        <th className="text-right py-2 px-3 text-xs font-bold text-[#4B5563]">
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
                          <td className="py-2.5 px-3 text-[#9CA3AF]">{idx + 1}</td>
                          <td className="py-2.5 px-3 text-[#4B5563]">
                            {formatDate(payment.date)}
                          </td>
                          <td className="py-2.5 px-3 text-[#4B5563]">
                            {payment.method.replace(/_/g, " ")}
                          </td>
                          <td className="py-2.5 px-3 text-[#4B5563] font-mono text-xs">
                            {payment.reference || "-"}
                          </td>
                          <td className="py-2.5 px-3 text-right font-medium text-[#4F7C3A]">
                            {formatCurrency(payment.amountSen)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[#E2DDD8]">
                        <td colSpan={4} className="py-2.5 px-3 text-right font-bold text-[#6B7280]">
                          Total Paid
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-[#4F7C3A]">
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

        {/* Right Column: Payment Summary */}
        <div className="space-y-6">
          {/* Payment Summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <DollarSign className="h-5 w-5 text-[#6B5C32]" />
                Payment Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-[#6B7280]">Total Amount</span>
                <span className="font-bold text-[#1F1D1B]">
                  {formatCurrency(invoice.totalSen)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-[#6B7280]">Paid</span>
                <span className="font-bold text-[#4F7C3A]">
                  {invoice.paidAmount > 0
                    ? formatCurrency(invoice.paidAmount)
                    : "-"}
                </span>
              </div>
              <div className="border-t border-[#E2DDD8] pt-3 flex justify-between items-center">
                <span className="text-sm font-bold text-[#1F1D1B]">Balance Due</span>
                <span
                  className={`text-lg font-bold ${
                    balanceSen > 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"
                  }`}
                >
                  {balanceSen > 0 ? formatCurrency(balanceSen) : "PAID"}
                </span>
              </div>

              {invoice.paymentDate && (
                <div className="border-t border-[#E2DDD8] pt-3 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-xs text-[#9CA3AF]">Last Payment Date</span>
                    <span className="text-sm text-[#4B5563]">
                      {formatDate(invoice.paymentDate)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-[#9CA3AF]">Payment Method</span>
                    <span className="text-sm text-[#4B5563]">
                      {invoice.paymentMethod.replace(/_/g, " ")}
                    </span>
                  </div>
                </div>
              )}

              {/* Record Payment Button */}
              {(invoice.status === "SENT" || invoice.status === "PARTIAL_PAID") && (
                <Button
                  variant="primary"
                  className="w-full mt-2"
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
            </CardContent>
          </Card>

          {/* Status Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
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
                        className={`h-3 w-3 rounded-full border-2 ${
                          isPast || (isCurrent && st === "PAID")
                            ? "bg-[#4F7C3A] border-[#C6DBA8]"
                            : isCurrent || isPartial
                            ? "bg-[#6B5C32] border-[#6B5C32]"
                            : "bg-white border-[#E2DDD8]"
                        }`}
                      />
                      <span
                        className={`text-sm ${
                          isPast || isCurrent || isPartial
                            ? "font-medium text-[#1F1D1B]"
                            : "text-[#9CA3AF]"
                        }`}
                      >
                        {st === "PAID" && isPartial
                          ? "PARTIAL PAID"
                          : st.replace(/_/g, " ")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Quick Info */}
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-[#9CA3AF]">Created</span>
                <span className="text-xs text-[#6B7280]">
                  {formatDate(invoice.createdAt)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-[#9CA3AF]">Last Updated</span>
                <span className="text-xs text-[#6B7280]">
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
    </div>
  );
}
