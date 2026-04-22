import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { generatePurchaseOrderPdf } from "@/lib/generate-purchase-order-pdf";
import { generateGRNPdf } from "@/lib/generate-grn-pdf";
import type { PurchaseOrder } from "@/lib/mock-data";
import {
  ArrowLeft, Download, Printer, ChevronRight, Package, FileText,
  CheckCircle, Send, Lock,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";

// Status timeline steps
const STATUS_STEPS = [
  { key: "DRAFT", label: "Draft", icon: FileText },
  { key: "SUBMITTED", label: "Sent", icon: Send },
  { key: "CONFIRMED", label: "Confirmed", icon: CheckCircle },
  { key: "PARTIAL_RECEIVED", label: "Partially Received", icon: Package },
  { key: "RECEIVED", label: "Fully Received", icon: CheckCircle },
  { key: "CLOSED", label: "Closed", icon: Lock },
];

function getStepIndex(status: string): number {
  // CANCELLED is special
  if (status === "CANCELLED") return -1;
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : 0;
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const [po, setPO] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPO = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/purchase-orders/${id}`);
      const data = await res.json();
      if (data.success) {
        setPO(data.data);
      } else {
        setError(data.error || "Purchase order not found");
      }
    } catch {
      setError("Failed to load purchase order");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchPO(); }, [fetchPO]);

  const handleAdvanceStatus = async (newStatus: string) => {
    if (!po) return;
    try {
      const body: Record<string, unknown> = { status: newStatus };
      if (newStatus === "RECEIVED") {
        body.receivedDate = new Date().toISOString().split("T")[0];
      }
      await fetch(`/api/purchase-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      fetchPO();
    } catch {
      console.error("Failed to update status");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  if (error || !po) {
    return (
      <div className="space-y-6">
        <Link to="/procurement" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to Procurement
        </Link>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[#9CA3AF]">{error || "Purchase order not found."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentStepIdx = getStepIndex(po.status);
  const isCancelled = po.status === "CANCELLED";

  // Determine available status advancement actions
  const statusActions: { label: string; status: string; variant: "primary" | "outline" }[] = [];
  if (po.status === "DRAFT") {
    statusActions.push({ label: "Send to Supplier", status: "SUBMITTED", variant: "primary" });
  } else if (po.status === "SUBMITTED") {
    statusActions.push({ label: "Mark Confirmed", status: "CONFIRMED", variant: "primary" });
  } else if (po.status === "CONFIRMED") {
    statusActions.push({ label: "Mark Partially Received", status: "PARTIAL_RECEIVED", variant: "outline" });
    statusActions.push({ label: "Mark Fully Received", status: "RECEIVED", variant: "primary" });
  } else if (po.status === "PARTIAL_RECEIVED") {
    statusActions.push({ label: "Mark Fully Received", status: "RECEIVED", variant: "primary" });
  } else if (po.status === "RECEIVED") {
    statusActions.push({ label: "Close PO", status: "CLOSED", variant: "outline" });
  }

  const totalOrdered = po.items.reduce((s, i) => s + i.quantity, 0);
  const totalReceived = po.items.reduce((s, i) => s + i.receivedQty, 0);
  const receivePct = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;
  const canPrintGRN = ["PARTIAL_RECEIVED", "RECEIVED"].includes(po.status);

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/procurement" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to Procurement
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B]">{po.poNo}</h1>
            <Badge variant="status" status={po.status} />
          </div>
          <p className="text-xs text-[#6B7280] mt-0.5">
            Supplier: <span className="font-medium text-[#1F1D1B]">{po.supplierName}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => generatePurchaseOrderPdf(po)}>
            <Download className="h-4 w-4" /> Download PDF
          </Button>
          {canPrintGRN && (
            <Button variant="outline" onClick={() => generateGRNPdf(po)}>
              <Printer className="h-4 w-4" /> Print GRN
            </Button>
          )}
        </div>
      </div>

      {/* Status Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-[#6B7280]">Status Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {isCancelled ? (
            <div className="flex items-center gap-2 text-red-600">
              <Lock className="h-5 w-5" />
              <span className="font-semibold">This Purchase Order has been cancelled.</span>
            </div>
          ) : (
            <div className="flex items-center gap-0 overflow-x-auto pb-2">
              {STATUS_STEPS.map((step, idx) => {
                const StepIcon = step.icon;
                const isActive = idx === currentStepIdx;
                const isCompleted = idx < currentStepIdx;
                return (
                  <div key={step.key} className="flex items-center">
                    <div className="flex flex-col items-center min-w-[80px]">
                      <div
                        className={`flex items-center justify-center w-9 h-9 rounded-full border-2 transition-colors ${
                          isActive
                            ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                            : isCompleted
                              ? "border-green-500 bg-green-50 text-green-600"
                              : "border-[#E2DDD8] bg-white text-[#D1D5DB]"
                        }`}
                      >
                        {isCompleted ? (
                          <CheckCircle className="h-4 w-4" />
                        ) : (
                          <StepIcon className="h-4 w-4" />
                        )}
                      </div>
                      <span
                        className={`text-xs mt-1.5 font-medium text-center ${
                          isActive ? "text-[#6B5C32]" : isCompleted ? "text-green-600" : "text-[#D1D5DB]"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                    {idx < STATUS_STEPS.length - 1 && (
                      <div
                        className={`w-8 h-0.5 mt-[-16px] ${
                          idx < currentStepIdx ? "bg-green-400" : "bg-[#E2DDD8]"
                        }`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* PO Details + Items */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Details */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-[#6B5C32]" /> Order Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-y-3 text-sm">
              <span className="text-[#6B7280]">PO Number</span>
              <span className="font-medium text-[#1F1D1B]">{po.poNo}</span>

              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-[#1F1D1B]">{po.supplierName}</span>

              <span className="text-[#6B7280]">Order Date</span>
              <span className="text-[#4B5563]">{formatDate(po.orderDate)}</span>

              <span className="text-[#6B7280]">Expected Date</span>
              <span className="text-[#4B5563]">{po.expectedDate ? formatDate(po.expectedDate) : "-"}</span>

              <span className="text-[#6B7280]">Received Date</span>
              <span className="text-[#4B5563]">{po.receivedDate ? formatDate(po.receivedDate) : "-"}</span>

              <span className="text-[#6B7280]">Status</span>
              <span><Badge variant="status" status={po.status} /></span>

              <span className="text-[#6B7280]">Received</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-2 bg-[#E2DDD8] rounded-full overflow-hidden">
                  <div className="h-full bg-[#6B5C32] rounded-full" style={{ width: `${receivePct}%` }} />
                </div>
                <span className="text-xs text-[#6B7280]">{receivePct}%</span>
              </div>
            </div>

            {po.notes && (
              <div className="pt-3 border-t border-[#E2DDD8]">
                <p className="text-xs font-medium text-[#6B7280] mb-1">Notes</p>
                <p className="text-sm text-[#4B5563]">{po.notes}</p>
              </div>
            )}

            {/* Amount summary */}
            <div className="pt-3 border-t border-[#E2DDD8] space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">Subtotal</span>
                <span className="text-[#1F1D1B]">{formatCurrency(po.subtotalSen)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold">
                <span className="text-[#6B5C32]">Total</span>
                <span className="text-[#6B5C32]">{formatCurrency(po.totalSen)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right: Items Table */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-[#6B5C32]" /> Items ({po.items.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-4 text-left font-medium text-[#374151]">#</th>
                    <th className="h-10 px-4 text-left font-medium text-[#374151]">Item Code</th>
                    <th className="h-10 px-4 text-left font-medium text-[#374151]">Description</th>
                    <th className="h-10 px-4 text-center font-medium text-[#374151]">Unit</th>
                    <th className="h-10 px-4 text-right font-medium text-[#374151]">Qty</th>
                    <th className="h-10 px-4 text-right font-medium text-[#374151]">Received</th>
                    <th className="h-10 px-4 text-right font-medium text-[#374151]">Unit Price</th>
                    <th className="h-10 px-4 text-right font-medium text-[#374151]">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {po.items.map((item, idx) => {
                    const isComplete = item.receivedQty >= item.quantity;
                    const hasPartial = item.receivedQty > 0 && item.receivedQty < item.quantity;
                    return (
                      <tr key={item.id} className={`border-b border-[#E2DDD8] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                        <td className="h-12 px-4 text-[#6B7280]">{idx + 1}</td>
                        <td className="h-12 px-4 font-medium text-[#6B5C32]">{item.supplierSKU}</td>
                        <td className="h-12 px-4 text-[#1F1D1B]">{item.materialName}</td>
                        <td className="h-12 px-4 text-center text-[#6B7280]">{item.unit}</td>
                        <td className="h-12 px-4 text-right text-[#4B5563]">{item.quantity}</td>
                        <td className={`h-12 px-4 text-right font-medium ${isComplete ? "text-green-600" : hasPartial ? "text-amber-600" : "text-[#6B7280]"}`}>
                          {item.receivedQty}
                        </td>
                        <td className="h-12 px-4 text-right text-[#4B5563]">{formatCurrency(item.unitPriceSen)}</td>
                        <td className="h-12 px-4 text-right font-medium text-[#1F1D1B]">{formatCurrency(item.totalSen)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-[#F0ECE9]">
                    <td colSpan={4} className="h-10 px-4 font-semibold text-[#374151]">Total</td>
                    <td className="h-10 px-4 text-right font-semibold text-[#374151]">{totalOrdered}</td>
                    <td className="h-10 px-4 text-right font-semibold text-[#374151]">{totalReceived}</td>
                    <td className="h-10 px-4"></td>
                    <td className="h-10 px-4 text-right font-bold text-[#6B5C32]">{formatCurrency(po.totalSen)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action Buttons */}
      {!isCancelled && statusActions.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <p className="text-xs text-[#6B7280]">Advance this Purchase Order to the next status:</p>
              <div className="flex items-center gap-2">
                {statusActions.map((action) => (
                  <Button
                    key={action.status}
                    variant={action.variant}
                    onClick={() => handleAdvanceStatus(action.status)}
                  >
                    <ChevronRight className="h-4 w-4" /> {action.label}
                  </Button>
                ))}
                {po.status === "DRAFT" && (
                  <Button
                    variant="outline"
                    className="text-red-600 border-red-200 hover:bg-red-50"
                    onClick={() => handleAdvanceStatus("CANCELLED")}
                  >
                    Cancel PO
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
