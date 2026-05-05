// ---------------------------------------------------------------------------
// Purchase Invoice detail page.
//
// Shows a single PI with its line breakdown. Mirrors the structure of
// procurement/detail.tsx (the PO detail page) — back link, header card,
// details + items grid, audit history. No status-transition buttons yet —
// the PAID flow is a separate AP-module change. Display-only for now.
//
// Line items come from purchase_invoice_items (migration 0107). Each line
// has a line_type tag: STOCKED items show their material code; non-stocked
// lines (FEE / TAX / REBATE / DISCOUNT / OTHER) show "—" plus a small
// badge so users can see at a glance what kind of charge it is.
// ---------------------------------------------------------------------------
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileText, Package } from "lucide-react";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency, formatDate } from "@/lib/utils";

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
  const { data: resp, loading, error: fetchError } = useCachedJson<{
    success?: boolean;
    data?: PurchaseInvoiceDetail;
    error?: string;
  }>(id ? `/api/purchase-invoices/${id}` : null);

  const pi: PurchaseInvoiceDetail | null = useMemo(
    () => (resp?.success ? resp.data ?? null : null),
    [resp],
  );
  const error: string | null = fetchError
    ?? (resp && resp.success === false ? resp.error || "Purchase invoice not found" : null);

  const items = pi?.items ?? [];
  const totalQty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
  const totalAmount = items.reduce((s, it) => s + (Number(it.lineTotalSen) || 0), 0);

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
      </div>

      {/* PI Details + Items */}
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

      {/* Audit trail for this PI */}
      <AuditHistoryPanel resource="purchase-invoices" resourceId={pi.id} />
    </div>
  );
}
