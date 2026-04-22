import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ArrowLeft, Printer, RotateCcw, XCircle, X, Package,
} from "lucide-react";
import type { ConsignmentNote } from "@/lib/mock-data";

// --- Confirmation Modal ---
function ConfirmModal({
  open, title, message, confirmLabel, confirmVariant, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: "primary" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">{title}</h3>
          <button onClick={onCancel} className="text-[#9CA3AF] hover:text-[#374151]"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm text-[#6B7280]">{message}</p>
        <div className="flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button
            variant={confirmVariant === "destructive" ? "outline" : "primary"}
            size="sm"
            onClick={onConfirm}
            className={confirmVariant === "destructive" ? "text-[#9A3A2D] border-[#E8B2A1] hover:bg-[#F9E1DA] hover:text-[#7A2E24]" : ""}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

const itemStatusBadge: Record<string, string> = {
  AT_BRANCH: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  SOLD: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
  RETURNED: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
  DAMAGED: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
};

export default function ConsignmentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [note, setNote] = useState<ConsignmentNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  // Confirmation modal state
  const [modal, setModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    confirmVariant?: "primary" | "destructive";
    action: () => void;
  }>({ open: false, title: "", message: "", confirmLabel: "", action: () => {} });

  const fetchNote = useCallback(() => {
    fetch(`/api/consignments/${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setNote(d.data);
        }
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    fetchNote();
  }, [fetchNote]);

  const updateStatus = useCallback(async (newStatus: string) => {
    if (!note) return;
    setUpdating(true);
    const res = await fetch(`/api/consignments/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    const data = await res.json();
    if (data.success) {
      setNote(data.data);
    }
    setUpdating(false);
    setModal((prev) => ({ ...prev, open: false }));
  }, [note, id]);

  const openConfirm = (title: string, message: string, confirmLabel: string, action: () => void, confirmVariant?: "primary" | "destructive") => {
    setModal({ open: true, title, message, confirmLabel, confirmVariant, action });
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-[#6B7280]">Loading...</div>;
  if (!note) return <div className="flex flex-col items-center justify-center h-64 gap-4"><div className="text-[#6B7280]">Consignment note not found</div><Button variant="outline" onClick={() => navigate("/consignment")}>Back</Button></div>;

  const totalQty = note.items.reduce((s, i) => s + i.quantity, 0);
  const canClose = ["ACTIVE", "PARTIALLY_SOLD", "FULLY_SOLD", "RETURNED"].includes(note.status);
  const canReturn = ["ACTIVE", "PARTIALLY_SOLD"].includes(note.status);

  return (
    <div className="space-y-6">
      {/* Confirmation Modal */}
      <ConfirmModal
        open={modal.open}
        title={modal.title}
        message={modal.message}
        confirmLabel={modal.confirmLabel}
        confirmVariant={modal.confirmVariant}
        onConfirm={modal.action}
        onCancel={() => setModal((prev) => ({ ...prev, open: false }))}
      />

      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/consignment")}><ArrowLeft className="h-5 w-5" /></Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-[#1F1D1B] doc-number">{note.noteNumber}</h1>
            <Badge variant="status" status={note.status} />
          </div>
          <p className="text-sm text-[#6B7280]">{note.customerName} &middot; {note.branchName}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button variant="outline" size="sm" onClick={() => toast.info(`Print ${note.noteNumber} — coming soon`)}><Printer className="h-4 w-4" /> Print</Button>
          {canReturn && (
            <Button
              variant="outline" size="sm" disabled={updating}
              onClick={() => openConfirm(
                "Process Return",
                "Are you sure you want to process a return for this consignment note? Items will be marked as RETURNED.",
                "Process Return",
                () => updateStatus("RETURNED"),
              )}
            >
              <RotateCcw className="h-4 w-4" /> Process Return
            </Button>
          )}
          {canClose && (
            <Button
              variant="outline" size="sm" disabled={updating}
              className="text-[#9A3A2D] hover:text-[#7A2E24]"
              onClick={() => openConfirm(
                "Close Consignment",
                "Are you sure you want to close this consignment note? This action cannot be easily undone.",
                "Close",
                () => updateStatus("CLOSED"),
                "destructive",
              )}
            >
              <XCircle className="h-4 w-4" /> Close
            </Button>
          )}
        </div>
      </div>

      {/* Status Action Buttons */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-[#374151]">Actions:</span>

            {canReturn && (
              <Button
                variant="primary" size="sm" disabled={updating}
                onClick={() => openConfirm(
                  "Process Return",
                  "Mark all remaining AT_BRANCH items as RETURNED and update note status.",
                  "Process Return",
                  () => updateStatus("RETURNED"),
                )}
              >
                <RotateCcw className="h-4 w-4" /> Process Return
              </Button>
            )}

            {canClose && (
              <Button
                variant="outline" size="sm" disabled={updating}
                className="text-[#9A3A2D] hover:text-[#7A2E24]"
                onClick={() => openConfirm(
                  "Close Consignment",
                  "Are you sure you want to close this consignment note?",
                  "Close",
                  () => updateStatus("CLOSED"),
                  "destructive",
                )}
              >
                <XCircle className="h-4 w-4" /> Close
              </Button>
            )}

            {note.status === "CLOSED" && (
              <span className="text-sm text-[#9CA3AF]">No actions available for this status.</span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Consignment Information</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div><p className="text-xs text-[#9CA3AF]">Note Number</p><p className="font-medium doc-number">{note.noteNumber}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Type</p><p className="font-medium">{note.type === "OUT" ? "Consignment Out" : "Return"}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Customer</p><p className="font-medium">{note.customerName}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Branch</p><p className="font-medium">{note.branchName}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Sent Date</p><p className="font-medium">{formatDate(note.sentDate)}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Status</p><div className="mt-0.5"><Badge variant="status" status={note.status} /></div></div>
              <div><p className="text-xs text-[#9CA3AF]">Total Value</p><p className="font-medium">{formatCurrency(note.totalValue)}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Total Items</p><p className="font-medium">{note.items.length}</p></div>
            </div>
            {note.notes && (
              <div className="mt-4 rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3">
                <p className="text-xs text-[#9CA3AF] mb-1">Notes</p>
                <p className="text-sm text-[#4B5563]">{note.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle>Summary</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Total Qty</span><span className="font-medium">{totalQty}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Line Items</span><span className="font-medium">{note.items.length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">At Branch</span><span className="font-medium text-[#3E6570]">{note.items.filter((i) => i.status === "AT_BRANCH").length}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Sold</span><span className="font-medium text-[#4F7C3A]">{note.items.filter((i) => i.status === "SOLD").length}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Returned</span><span className="font-medium text-[#9C6F1E]">{note.items.filter((i) => i.status === "RETURNED").length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-lg font-bold"><span>Total Value</span><span className="text-[#6B5C32]">{formatCurrency(note.totalValue)}</span></div>
          </CardContent>
        </Card>
      </div>

      {/* Items Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-[#6B5C32]" />
            Items ({note.items.length} lines, {totalQty} qty)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-10 px-3 text-left font-medium text-[#374151] w-8">#</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Product</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Code</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Qty</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Total</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Status</th>
                </tr>
              </thead>
              <tbody>
                {note.items.map((item, idx) => (
                  <tr key={item.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                    <td className="px-3 py-3 text-[#9CA3AF]">{idx + 1}</td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-[#1F1D1B]">{item.productName}</p>
                    </td>
                    <td className="px-3 py-3 doc-number text-[#4B5563]">{item.productCode}</td>
                    <td className="px-3 py-3 text-right font-medium">{item.quantity}</td>
                    <td className="px-3 py-3 text-right amount">{formatCurrency(item.unitPrice)}</td>
                    <td className="px-3 py-3 text-right font-medium amount">{formatCurrency(item.unitPrice * item.quantity)}</td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                          itemStatusBadge[item.status] || "bg-gray-100 text-gray-600 border-gray-300"
                        }`}
                      >
                        {item.status.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]">
                  <td colSpan={5} className="px-3 py-3 text-right font-semibold text-[#374151]">Grand Total</td>
                  <td className="px-3 py-3 text-right font-bold text-lg text-[#6B5C32]">{formatCurrency(note.totalValue)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Document Flow */}
      <Card>
        <CardHeader className="pb-3"><CardTitle>Document Flow</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 overflow-x-auto">
            {["ACTIVE", "PARTIALLY_SOLD", "FULLY_SOLD", "RETURNED", "CLOSED"].map((status, i, arr) => {
              const isActive = status === note.status;
              const isPast = arr.indexOf(note.status) > i;
              return (
                <div key={status} className="flex items-center gap-2">
                  <div className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                    isActive ? "bg-[#6B5C32] text-white border-[#6B5C32]" :
                    isPast ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" :
                    "bg-gray-50 text-gray-400 border-gray-200"
                  }`}>{status.replace(/_/g, " ")}</div>
                  {i < arr.length - 1 && <div className={`h-0.5 w-6 ${isPast ? "bg-[#C6DBA8]" : "bg-gray-200"}`} />}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
