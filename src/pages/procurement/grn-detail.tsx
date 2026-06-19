// ---------------------------------------------------------------------------
// GRN (Goods Received Note) detail page.
//
// Phase A of the purchasing parity build. The GRN list (grn.tsx) navigated to
// /procurement/grn/:id on View / double-click, but the route was never
// registered — a dead link. This page fills it: read view (mirrors
// PurchaseInvoiceDetail) + the status-gated actions the list has, including the
// previously-missing "Post to Stock" that moves a GRN to POSTED (which commits
// rm_batches / cost_ledger / balanceQty and cascades the PO). Without it,
// standalone/CONFIRMED GRNs were stuck and could never be converted to an
// invoice.
//
// Status model (hookka's own, NOT 2990's): DRAFT → CONFIRMED → POSTED.
//   Approve:        DRAFT → CONFIRMED
//   Post to Stock:  → POSTED  (commits inventory + cascades PO; idempotent)
//   Convert to PI:  POSTED-only (reuses the GRN list's exact payload)
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, FileText, Package, CheckCircle2, PackageCheck, Receipt, Printer } from "lucide-react";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { formatCurrency, formatDate } from "@/lib/utils";

type GRNItem = {
  poItemIndex: number;
  materialCode: string;
  materialName: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  unitPrice: number; // sen
};

type GRNDetail = {
  id: string;
  grnNumber: string;
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  receiveDate: string;
  receivedBy: string;
  items: GRNItem[];
  totalAmount: number; // sen
  qcStatus: string;
  status: string;
  notes: string | null;
};

export default function GRNDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { data: resp, loading, error: fetchError, refresh } = useCachedJson<{
    success?: boolean;
    data?: GRNDetail;
    error?: string;
  }>(id ? `/api/grn/${id}` : null);

  const grn: GRNDetail | null = resp?.success ? resp.data ?? null : null;
  const error: string | null =
    fetchError ?? (resp && resp.success === false ? resp.error || "GRN not found" : null);

  const items = grn?.items ?? [];

  // PUT a status transition; surface failures (verified-save spirit), and on a
  // Post-to-Stock surface the backend's unresolved-lines warning if any.
  async function setStatus(next: "CONFIRMED" | "POSTED", label: string) {
    if (!grn) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/grn/${grn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { costing?: { unresolvedLines?: number } } }
        | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `${label} failed (${res.status})`);
        return;
      }
      const unresolved = j.data?.costing?.unresolvedLines ?? 0;
      if (next === "POSTED" && unresolved > 0) {
        toast.error(
          `Posted, but ${unresolved} line(s) had no matching raw material — that stock did NOT land. Check the item codes.`,
        );
      } else {
        toast.success(`${label} — done`);
      }
      invalidateCachePrefix("/api/grn");
      // Post-to-Stock lands inventory (raw_materials.balanceQty), so refresh the
      // inventory surfaces too — otherwise they show stale on-hand until TTL.
      if (next === "POSTED") {
        invalidateCachePrefix("/api/raw-materials");
        invalidateCachePrefix("/api/inventory");
        invalidateCachePrefix("/api/stock-value");
      }
      refresh();
    } catch {
      toast.error(`${label} failed — network error`);
    } finally {
      setBusy(false);
    }
  }

  // Convert POSTED GRN → Purchase Invoice (DRAFT). Same payload as grn.tsx list.
  async function convertToInvoice() {
    if (!grn) return;
    const ok = window.confirm(
      `Create Purchase Invoice from GRN ${grn.grnNumber}? Total: ${(grn.totalAmount / 100).toFixed(2)}`,
    );
    if (!ok) return;
    const currency = (
      window.prompt(
        "Invoice currency — keep MYR, or type USD / CNY for a foreign supplier invoice:",
        "MYR",
      ) || ""
    )
      .trim()
      .toUpperCase();
    if (!currency) return;
    let fxRate: number | undefined;
    if (currency !== "MYR") {
      const r = parseFloat(
        window.prompt(`Booking exchange rate — MYR per 1 ${currency} (invoice-date rate):`, "") || "",
      );
      if (!Number.isFinite(r) || r <= 0) {
        toast.error("A positive exchange rate is required for a foreign invoice");
        return;
      }
      fxRate = r;
    }
    setBusy(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      const piItems = items
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
          purchaseOrderId: grn.poId,
          supplierId: grn.supplierId,
          supplierName: grn.supplierName,
          invoiceDate: today,
          amountSen: grn.totalAmount,
          remarks: `Auto-created from GRN ${grn.grnNumber}`,
          items: piItems,
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
      toast.success(`Invoice ${j.data.piNo} created from GRN ${grn.grnNumber}`);
      navigate(`/procurement/pi/${j.data.id}`);
    } catch {
      toast.error("Failed to create invoice");
    } finally {
      setBusy(false);
    }
  }

  // Print the GRN as a PDF (jspdf dynamic-imported). Map this page's GRN shape
  // onto the field names generateGRNPdf reads (grnNo / date / poRef / items).
  async function printPdf() {
    if (!grn) return;
    try {
      const { generateGRNPdf } = await import("@/lib/generate-grn-pdf");
      generateGRNPdf({
        grnNo: grn.grnNumber,
        date: grn.receiveDate,
        poRef: grn.poNumber,
        supplierName: grn.supplierName,
        remarks: grn.notes ?? "",
        items: items.map((it) => ({
          itemCode: it.materialCode,
          description: it.materialName,
          poQty: it.orderedQty,
          receivedQty: it.receivedQty,
          rejectedQty: it.rejectedQty,
          acceptedQty: it.acceptedQty,
        })),
      });
    } catch {
      toast.error("Could not generate the PDF.");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  if (error || !grn) {
    return (
      <div className="space-y-6">
        <Link to="/procurement/grn" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to GRNs
        </Link>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[#9CA3AF]">{error || "GRN not found."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isPosted = grn.status === "POSTED";
  const isConfirmed = grn.status === "CONFIRMED";

  return (
    <div className="space-y-6">
      <Link to="/procurement/grn" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to GRNs
      </Link>

      {/* Header + actions */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B]">{grn.grnNumber}</h1>
            <Badge variant="status" status={grn.status} />
            {grn.qcStatus ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#F0ECE9] text-[#6B5C32]">
                QC: {grn.qcStatus}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-[#6B7280] mt-0.5">
            Supplier: <span className="font-medium text-[#1F1D1B]">{grn.supplierName}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={printPdf} disabled={busy}>
            <Printer className="h-3.5 w-3.5" /> Print
          </Button>
          {!isConfirmed && !isPosted && (
            <Button type="button" variant="outline" size="sm" onClick={() => setStatus("CONFIRMED", "Approve")} disabled={busy}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
            </Button>
          )}
          {!isPosted && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setStatus("POSTED", "Post to Stock")}
              disabled={busy}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              <PackageCheck className="h-3.5 w-3.5" /> Post to Stock
            </Button>
          )}
          {isPosted && (
            <Button type="button" variant="primary" size="sm" onClick={convertToInvoice} disabled={busy} className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]">
              <Receipt className="h-3.5 w-3.5" /> Convert to Invoice
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: details */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-[#6B5C32]" /> GRN Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-y-3 text-sm">
              <span className="text-[#6B7280]">GRN Number</span>
              <span className="font-medium text-[#1F1D1B]">{grn.grnNumber}</span>

              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-[#1F1D1B]">{grn.supplierName}</span>

              <span className="text-[#6B7280]">Linked PO</span>
              <span>
                {grn.poId ? (
                  <Link to={`/procurement/${grn.poId}`} className="text-[#6B5C32] font-medium hover:underline">
                    {grn.poNumber || grn.poId}
                  </Link>
                ) : (
                  <span className="text-[#9CA3AF]">—</span>
                )}
              </span>

              <span className="text-[#6B7280]">Receive Date</span>
              <span className="text-[#4B5563]">{grn.receiveDate ? formatDate(grn.receiveDate) : "-"}</span>

              <span className="text-[#6B7280]">Received By</span>
              <span className="text-[#4B5563]">{grn.receivedBy || "-"}</span>

              <span className="text-[#6B7280]">Status</span>
              <span><Badge variant="status" status={grn.status} /></span>
            </div>

            {grn.notes && (
              <div className="pt-3 border-t border-[#E2DDD8]">
                <p className="text-xs font-medium text-[#6B7280] mb-1">Notes</p>
                <p className="text-sm text-[#4B5563] whitespace-pre-wrap">{grn.notes}</p>
              </div>
            )}

            <div className="pt-3 border-t border-[#E2DDD8]">
              <div className="flex justify-between text-sm font-bold">
                <span className="text-[#6B5C32]">Total</span>
                <span className="text-[#6B5C32]">{formatCurrency(grn.totalAmount)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right: items */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-[#6B5C32]" /> Received Items ({items.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E2DDD8] p-6 text-center text-sm text-[#9CA3AF]">
                No line items on this GRN.
              </div>
            ) : (
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Material</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Ordered</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Received</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Accepted</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Rejected</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx} className={`border-b border-[#E2DDD8] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                        <td className="h-12 px-3">
                          <div className="font-medium text-[#1F1D1B]">{it.materialName}</div>
                          <div className="text-xs text-[#6B5C32]">{it.materialCode}</div>
                          {it.rejectedQty > 0 && it.rejectionReason ? (
                            <div className="text-xs text-[#9A3A2D]">Rejected: {it.rejectionReason}</div>
                          ) : null}
                        </td>
                        <td className="h-12 px-3 text-right text-[#4B5563]">{it.orderedQty}</td>
                        <td className="h-12 px-3 text-right text-[#4B5563]">{it.receivedQty}</td>
                        <td className="h-12 px-3 text-right font-medium text-[#1F1D1B]">{it.acceptedQty}</td>
                        <td className={`h-12 px-3 text-right ${it.rejectedQty > 0 ? "text-[#9A3A2D]" : "text-[#9CA3AF]"}`}>{it.rejectedQty}</td>
                        <td className="h-12 px-3 text-right text-[#4B5563]">{formatCurrency(it.unitPrice)}</td>
                        <td className="h-12 px-3 text-right font-medium text-[#1F1D1B]">{formatCurrency(it.acceptedQty * it.unitPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AuditHistoryPanel resource="grn" resourceId={grn.id} />
    </div>
  );
}
