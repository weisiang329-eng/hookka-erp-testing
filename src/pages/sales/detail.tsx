import { useState, useMemo, useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import {
  ArrowLeft, Trash2, Download, Edit, Copy,
  CheckCircle2, Truck, FileText, XCircle, PauseCircle, PlayCircle, X,
  Factory, Clock, DollarSign, AlertTriangle, ChevronDown, ChevronUp,
} from "lucide-react";
import { generateSOPdf } from "@/lib/generate-so-pdf";
import DocumentFlowDiagram, { type DocNode } from "@/components/ui/document-flow-diagram";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import type { SalesOrder, SOStatus, Customer } from "@/lib/mock-data";

type LinkedPO = {
  id: string;
  poNo: string;
  productName: string;
  productCode: string;
  itemCategory: string;
  quantity: number;
  status: string;
  progress: number;
  currentDepartment: string;
};

// SO ID display rule (mirrors src/pages/production/index.tsx):
//   SOFA   → strip the trailing -NN line suffix from poNo because a sofa
//           set spans multiple variant-POs and no single -01/-02 suffix
//           belongs to the whole set. All sofa rows on the same SO will
//           display the same SO ID — operators distinguish by product /
//           variant / fabric columns.
//   BF/ACC → keep poNo as-is (e.g. SO-2604-293-01) because qty>1 already
//           fans out into per-piece POs and the suffix genuinely identifies
//           one physical piece.
function displaySoId(po: { poNo: string; itemCategory: string }): string {
  if ((po.itemCategory || "").toUpperCase() === "SOFA") {
    return po.poNo.replace(/-\d+$/, "");
  }
  return po.poNo;
}

type StatusChange = {
  id: string;
  soId: string;
  fromStatus: string;
  toStatus: string;
  changedBy: string;
  timestamp: string;
  notes: string;
  autoActions: string[];
};

type PriceOverrideRecord = {
  id: string;
  soId: string;
  soNumber: string;
  lineIndex: number;
  originalPrice: number;
  overridePrice: number;
  reason: string;
  approvedBy: string;
  timestamp: string;
};

// --- Confirmation Modal ---
function ConfirmModal({
  open, title, message, confirmLabel, confirmVariant, onConfirm, onCancel, children,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: "primary" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
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
        <p className="text-xs text-[#6B7280]">{message}</p>
        {children}
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

// --- Status Timeline Component ---
function StatusTimeline({ history }: { history: StatusChange[] }) {
  if (history.length === 0) return null;

  const sorted = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-[#6B5C32]" />
          Status Timeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {sorted.map((change, i) => (
            <div key={change.id} className="flex gap-4 pb-4 last:pb-0">
              {/* Timeline connector */}
              <div className="flex flex-col items-center">
                <div className={`w-3 h-3 rounded-full border-2 ${
                  i === sorted.length - 1 ? "border-[#6B5C32] bg-[#6B5C32]" : "border-[#C6DBA8] bg-[#4F7C3A]"
                }`} />
                {i < sorted.length - 1 && <div className="w-0.5 flex-1 bg-[#E2DDD8] mt-1" />}
              </div>
              {/* Content */}
              <div className="flex-1 pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="status" status={change.fromStatus} />
                  <span className="text-xs text-[#9CA3AF]">-&gt;</span>
                  <Badge variant="status" status={change.toStatus} />
                  <span className="text-xs text-[#9CA3AF] ml-auto">{formatDateTime(change.timestamp)}</span>
                </div>
                <p className="text-xs text-[#6B7280] mt-1">by {change.changedBy}</p>
                {change.notes && <p className="text-xs text-[#4B5563] mt-0.5">{change.notes}</p>}
                {change.autoActions.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {change.autoActions.map((action, j) => (
                      <span key={j} className="text-xs bg-[#E0EDF0] text-[#3E6570] px-2 py-0.5 rounded">
                        {action}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SalesOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: orderResp, loading, refresh: refreshOrder } = useCachedJson<{ success?: boolean; data?: SalesOrder; linkedPOs?: LinkedPO[]; statusHistory?: StatusChange[]; priceOverrides?: PriceOverrideRecord[] }>(id ? `/api/sales-orders/${id}` : null);
  const [updating, setUpdating] = useState(false);
  const [confirmSuccess, setConfirmSuccess] = useState<string | null>(null);
  const [showOverrides, setShowOverrides] = useState(false);

  // Confirmation modal state
  const [modal, setModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    confirmVariant?: "primary" | "destructive";
    action: () => void;
  }>({ open: false, title: "", message: "", confirmLabel: "", action: () => {} });

  // BOM-incomplete error modal — shown when /confirm returns 422.
  const [bomError, setBomError] = useState<{
    open: boolean;
    incompleteProducts: Array<{ productCode: string; productName: string; reason: string }>;
  }>({ open: false, incompleteProducts: [] });

  // Blocked-cancel modal — shown when PUT /:id (status=CANCELLED) returns 409
  // because some job_card under this SO has a completedDate stamped. The
  // server returns up to 5 blocking items so the operator can locate them
  // on the Production page and clear/reassign before retrying the cancel.
  const [cancelBlocked, setCancelBlocked] = useState<{
    open: boolean;
    items: Array<{ poNo: string; departmentCode: string; departmentName: string; completedDate: string }>;
  }>({ open: false, items: [] });

  const fetchOrder = useCallback(() => {
    // Only this SO changed — per-id invalidation, not list prefix.
    if (id) invalidateCache(`/api/sales-orders/${id}`);
    refreshOrder();
  }, [id, refreshOrder]);

  // Pure derive — orderResp comes from useCachedJson. Mutation handlers call
  // fetchOrder() which refreshes the cache; the next render then projects
  // the new data through these memos. No useEffect+setState shadow copy.
  const order: SalesOrder | null = useMemo(
    () => (orderResp?.success ? (orderResp.data as SalesOrder) : null),
    [orderResp],
  );
  const linkedPOs: LinkedPO[] = useMemo(
    () => (orderResp?.success ? orderResp.linkedPOs ?? [] : []),
    [orderResp],
  );
  const statusHistory: StatusChange[] = useMemo(
    () => (orderResp?.success ? orderResp.statusHistory ?? [] : []),
    [orderResp],
  );
  const overrideHistory: PriceOverrideRecord[] = useMemo(
    () => (orderResp?.success ? orderResp.priceOverrides ?? [] : []),
    [orderResp],
  );

  // Fetch customer so we can resolve the hub shortName for the Delivery Hub field
  const { data: customerResp } = useCachedJson<{ success?: boolean; data?: Customer }>(order?.customerId ? `/api/customers/${order.customerId}` : null);
  const customer: Customer | null = useMemo(
    () => (customerResp?.success ? (customerResp.data as Customer) : null),
    [customerResp],
  );

  // Cancel-eligibility — reuses /edit-eligibility because the server-side
  // dept_completed reason is the same lock condition that blocks cancel:
  // any job_card with a completedDate stamped under this SO's POs strands
  // inventory if the SO flips to CANCELLED. We surface the same lock here
  // as a disabled Cancel button + tooltip BEFORE the user clicks; the
  // backend 409 still hard-blocks on click as a defense-in-depth.
  const { data: eligibilityResp } = useCachedJson<{
    editable: boolean;
    reason?: "status" | "production_window" | "dept_completed";
    completedDept?: string;
    completedAt?: string;
  }>(id ? `/api/sales-orders/${id}/edit-eligibility` : null);
  const cancelLocked = eligibilityResp?.reason === "dept_completed";
  const cancelLockTooltip = cancelLocked
    ? `Cannot cancel — ${eligibilityResp?.completedDept || "A department"} completed on ${formatDate(eligibilityResp?.completedAt || "")}`
    : "";

  const updateStatus = useCallback(async (newStatus: SOStatus) => {
    if (!order) return;
    setUpdating(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res: Response; let data: any;
    try {
      res = await fetch(`/api/sales-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      setUpdating(false);
      setModal(prev => ({ ...prev, open: false }));
      toast.error(e instanceof Error ? e.message : "Network error — status not updated");
      return;
    }
    // res.ok guard — prevents a 500/401 from falling into the success
    // branch just because the error body happens to lack {success:false}.
    if (!res.ok) {
      setUpdating(false);
      setModal(prev => ({ ...prev, open: false }));
      // 409 Conflict from CANCELLED transition = completed work blocks cancel.
      // Pop the dedicated blocked-cancel modal listing the offending items
      // instead of a bare toast; the order remains in its current status.
      if (res.status === 409 && Array.isArray(data?.blockingItems)) {
        setCancelBlocked({ open: true, items: data.blockingItems });
        return;
      }
      toast.error(data?.error || `Failed to update status (HTTP ${res.status})`);
      return;
    }
    if (data.success) {
      // Only this SO changed — per-id invalidate. Status cascade below may
      // touch many POs so the PO list prefix invalidation is retained.
      // fetchOrder() at the end of this branch refreshes the cache, which
      // re-derives `order` and `linkedPOs` via useMemo — no optimistic
      // setOrder needed.
      if (id) invalidateCache(`/api/sales-orders/${id}`);
      invalidateCachePrefix("/api/production-orders");
      // Surface the ON_HOLD / CANCELLED / RESUME cascade summary as a toast so
      // the user sees how many POs + job cards were touched by the transition.
      // `cascade` is only populated when the server-side helper fired.
      const cascade = data.cascade as
        | { affectedPoCount: number; affectedJcCount: number; actions: string[] }
        | null
        | undefined;
      if (cascade && (cascade.affectedPoCount > 0 || cascade.affectedJcCount > 0)) {
        const parts: string[] = [];
        if (cascade.affectedPoCount > 0) {
          parts.push(`${cascade.affectedPoCount} production order${cascade.affectedPoCount === 1 ? "" : "s"}`);
        }
        if (cascade.affectedJcCount > 0) {
          parts.push(`${cascade.affectedJcCount} job card${cascade.affectedJcCount === 1 ? "" : "s"}`);
        }
        toast.success(`Status → ${newStatus}. ${parts.join(" + ")} updated.`);
      } else {
        toast.success(`Status updated to ${newStatus}.`);
      }
      fetchOrder(); // Refresh all data including status history
    } else {
      toast.error(data.error || `Failed to update status.`);
    }
    setUpdating(false);
    setModal(prev => ({ ...prev, open: false }));
  }, [order, id, fetchOrder, toast]);

  const confirmOrder = useCallback(async () => {
    if (!order) return;
    setUpdating(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res: Response; let data: any;
    try {
      res = await fetch(`/api/sales-orders/${id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changedBy: "Admin" }),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      setUpdating(false);
      setModal(prev => ({ ...prev, open: false }));
      toast.error(e instanceof Error ? e.message : "Network error — order not confirmed");
      return;
    }
    // Confirm is critical — on failure production orders do NOT get created,
    // and without this guard the UI would claim success while the backend
    // never fired createProductionOrdersForSO, leaving the SO in limbo.
    if (!res.ok) {
      setUpdating(false);
      setModal(prev => ({ ...prev, open: false }));
      // 422 = BOM incomplete. Pop the dedicated modal with the SKU list
      // instead of a bare toast — server has already left SO in DRAFT.
      if (res.status === 422 && data?.details?.incompleteProducts) {
        setBomError({ open: true, incompleteProducts: data.details.incompleteProducts });
      } else {
        toast.error(data?.error || `Failed to confirm order (HTTP ${res.status})`);
      }
      return;
    }
    if (data.success) {
      // Confirming an SO can create many new POs — keep the PO prefix
      // invalidation. Only this one SO changed, so per-id for the SO.
      // fetchOrder() refreshes; useMemo projects the new server response.
      if (id) invalidateCache(`/api/sales-orders/${id}`);
      invalidateCachePrefix("/api/production-orders");
      setConfirmSuccess(data.message);
      fetchOrder();
      // Fire-and-forget banner clear scheduled from confirm action callback.
      // eslint-disable-next-line no-restricted-syntax -- one-shot banner timer from event handler
      setTimeout(() => setConfirmSuccess(null), 5000);
    } else {
      toast.error(data.error || "Failed to confirm order");
    }
    setUpdating(false);
    setModal(prev => ({ ...prev, open: false }));
  }, [order, id, fetchOrder, toast]);

  const openConfirm = (title: string, message: string, confirmLabel: string, action: () => void, confirmVariant?: "primary" | "destructive") => {
    setModal({ open: true, title, message, confirmLabel, confirmVariant, action });
  };

  const deleteOrder = async () => {
    if (!confirm("Delete this order?")) return;
    await fetch(`/api/sales-orders/${id}`, { method: "DELETE" });
    // Deleting an SO also cascades to its linked POs on the server. Invalidate
    // the SO list (one row gone) and the PO list (linked POs gone), plus the
    // per-id SO entry so any stale detail fetch doesn't resurrect a 404.
    invalidateCachePrefix("/api/sales-orders");
    invalidateCachePrefix("/api/production-orders");
    if (id) invalidateCache(`/api/sales-orders/${id}`);
    navigate("/sales");
  };

  const handleClone = () => {
    if (!order) return;
    const cloneData = {
      customerId: order.customerId,
      customerPOId: "",
      customerSOId: "",
      reference: `Clone of ${order.companySOId}`,
      companySODate: new Date().toISOString().split("T")[0],
      customerDeliveryDate: order.customerDeliveryDate ? order.customerDeliveryDate.split("T")[0] : "",
      hookkaExpectedDD: order.hookkaExpectedDD ? order.hookkaExpectedDD.split("T")[0] : "",
      notes: order.notes || "",
      items: order.items.map(item => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        itemCategory: item.itemCategory,
        sizeCode: item.sizeCode,
        sizeLabel: item.sizeLabel,
        fabricId: item.fabricId,
        fabricCode: item.fabricCode,
        quantity: item.quantity,
        basePriceSen: item.basePriceSen,
        gapInches: item.gapInches,
        divanHeightInches: item.divanHeightInches,
        divanPriceSen: item.divanPriceSen,
        legHeightInches: item.legHeightInches,
        legPriceSen: item.legPriceSen,
        specialOrder: item.specialOrder || "",
        specialOrderPriceSen: item.specialOrderPriceSen,
        notes: item.notes || "",
      })),
    };
    localStorage.setItem("so-clone-data", JSON.stringify(cloneData));
    navigate("/sales/create?clone=1");
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-[#6B7280]">Loading...</div>;
  if (!order) return <div className="flex flex-col items-center justify-center h-64 gap-4"><div className="text-[#6B7280]">Order not found</div><Button variant="outline" onClick={() => navigate("/sales")}>Back</Button></div>;

  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
  const canEdit = ["DRAFT", "CONFIRMED"].includes(order.status);
  const canCancel = ["DRAFT", "CONFIRMED", "IN_PRODUCTION"].includes(order.status);
  const canHold = ["CONFIRMED", "IN_PRODUCTION"].includes(order.status);
  const isOnHold = order.status === "ON_HOLD";

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
        onCancel={() => setModal(prev => ({ ...prev, open: false }))}
      />

      {/* BOM Incomplete Modal — shown on 422 from /confirm. */}
      {bomError.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setBomError({ open: false, incompleteProducts: [] })} />
          <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
                <h3 className="text-lg font-semibold text-[#1F1D1B]">Cannot Confirm — BOM Incomplete</h3>
              </div>
              <button onClick={() => setBomError({ open: false, incompleteProducts: [] })} className="text-[#9CA3AF] hover:text-[#374151]"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-sm text-[#374151]">
              Cannot confirm — the following products have no BOM yet:
            </p>
            <ul className="space-y-1 text-sm bg-[#FBF3F1] border border-[#E8B2A1] rounded-md p-3 max-h-64 overflow-y-auto">
              {bomError.incompleteProducts.map((p) => (
                <li key={p.productCode} className="font-mono text-[#7A2E24]">
                  {p.productCode}: {p.productName}
                </li>
              ))}
            </ul>
            <p className="text-xs text-[#6B7280]">
              Please complete their BOM in Products &rarr; BOM first, then retry. The order remains in DRAFT status.
            </p>
            <div className="flex justify-end gap-3">
              {bomError.incompleteProducts.length === 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const code = bomError.incompleteProducts[0].productCode;
                    navigate(`/products/bom?sku=${encodeURIComponent(code)}`);
                  }}
                >
                  Open BOM for {bomError.incompleteProducts[0].productCode}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={() => setBomError({ open: false, incompleteProducts: [] })}
              >
                OK
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Blocked-Cancel Modal — shown on 409 from PUT /:id when any
          job_card under this SO already has a completedDate stamped.
          Operators must clear / reassign the completed work on the
          Production page before this SO can be cancelled. */}
      {cancelBlocked.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setCancelBlocked({ open: false, items: [] })} />
          <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
                <h3 className="text-lg font-semibold text-[#1F1D1B]">Cannot cancel order — completed work in production</h3>
              </div>
              <button onClick={() => setCancelBlocked({ open: false, items: [] })} className="text-[#9CA3AF] hover:text-[#374151]"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-sm text-[#374151]">
              The following items have completion dates that block cancellation:
            </p>
            <ul className="space-y-1 text-sm bg-[#FBF3F1] border border-[#E8B2A1] rounded-md p-3 max-h-64 overflow-y-auto">
              {cancelBlocked.items.map((b, i) => (
                <li key={`${b.poNo}-${b.departmentCode}-${i}`} className="text-[#7A2E24]">
                  <span className="font-mono">{b.poNo}</span>
                  <span className="text-[#9A3A2D]"> &middot; {b.departmentName} &middot; </span>
                  <span>{formatDate(b.completedDate)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-[#6B7280]">
              Clear these completion dates from the Production page first, OR reassign
              the completed units to another order. Only then can this SO be cancelled.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCancelBlocked({ open: false, items: [] });
                  navigate(`/production?soId=${encodeURIComponent(id || "")}`);
                }}
              >
                Open Production Page
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCancelBlocked({ open: false, items: [] })}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Success Banner */}
      {confirmSuccess && (
        <div className="bg-[#EEF3E4] border border-[#C6DBA8] text-[#4F7C3A] px-4 py-3 rounded-lg flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-[#4F7C3A] shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{confirmSuccess}</p>
            {linkedPOs.length > 0 && (
              <p className="text-sm mt-1">
                Production Orders: {linkedPOs.map(displaySoId).join(", ")}
              </p>
            )}
          </div>
          <button onClick={() => setConfirmSuccess(null)} className="text-[#4F7C3A] hover:text-[#3D6329]">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/sales")}><ArrowLeft className="h-5 w-5" /></Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B] doc-number">{order.companySOId}</h1>
            <Badge variant="status" status={order.status} />
          </div>
          <p className="text-xs text-[#6B7280]">{order.customerName} &middot; {order.customerState}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button variant="outline" size="sm" onClick={() => order && generateSOPdf(order, customer)}><Download className="h-4 w-4" /> PDF</Button>
          <Button variant="outline" size="sm" onClick={handleClone}><Copy className="h-4 w-4" /> Clone</Button>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/sales/${id}/edit`)}><Edit className="h-4 w-4" /> Edit</Button>
          )}
          {order.status === "DRAFT" && (
            <Button variant="outline" size="sm" className="text-[#9A3A2D] hover:text-[#7A2E24]" onClick={deleteOrder}><Trash2 className="h-4 w-4" /> Delete</Button>
          )}
        </div>
      </div>

      {/* Status Action Buttons */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-[#374151]">Actions:</span>

            {/* DRAFT -> Confirm (auto-creates POs) */}
            {order.status === "DRAFT" && (
              <Button
                variant="primary" size="sm" disabled={updating}
                onClick={() => openConfirm(
                  "Confirm Sales Order",
                  "This will create Production Orders for all line items and change the status to CONFIRMED. Proceed?",
                  "Confirm & Create POs",
                  confirmOrder,
                )}
              >
                <CheckCircle2 className="h-4 w-4" /> Confirm Order
              </Button>
            )}

            {/* READY_TO_SHIP -> Create Delivery */}
            {order.status === "READY_TO_SHIP" && (
              <Button variant="primary" size="sm" onClick={() => navigate("/delivery")}>
                <Truck className="h-4 w-4" /> Create Delivery
              </Button>
            )}

            {/* DELIVERED -> Generate Invoice */}
            {order.status === "DELIVERED" && (
              <Button variant="primary" size="sm" onClick={() => navigate("/invoices")}>
                <FileText className="h-4 w-4" /> Generate Invoice
              </Button>
            )}

            {/* Put On Hold */}
            {canHold && (
              <Button
                variant="outline" size="sm" disabled={updating}
                onClick={() => openConfirm(
                  "Put On Hold",
                  "Are you sure you want to put this order on hold? Production will be paused until the order is resumed.",
                  "Put On Hold",
                  () => updateStatus("ON_HOLD"),
                )}
              >
                <PauseCircle className="h-4 w-4" /> Put On Hold
              </Button>
            )}

            {/* Resume from ON_HOLD */}
            {isOnHold && (
              <Button
                variant="primary" size="sm" disabled={updating}
                onClick={() => {
                  const resumeTarget = (order.preHoldStatus as SOStatus) || "CONFIRMED";
                  openConfirm(
                    "Resume Order",
                    `Are you sure you want to resume this order? The order will return to ${resumeTarget} status.`,
                    "Resume Order",
                    () => updateStatus(resumeTarget),
                  );
                }}
              >
                <PlayCircle className="h-4 w-4" /> Resume Order
              </Button>
            )}

            {/* Cancel — disabled when any dept JC has a completedDate
                (cancelLocked, derived from /edit-eligibility). The backend
                also returns 409 if a stale client retries; both paths funnel
                into the same blocked-cancel modal. */}
            {canCancel && (
              <Button
                variant="outline" size="sm" disabled={updating || cancelLocked}
                className="text-[#9A3A2D] hover:text-[#7A2E24]"
                title={cancelLockTooltip || undefined}
                onClick={() => openConfirm(
                  "Cancel Order",
                  "Are you sure you want to cancel this order? This action cannot be easily undone.",
                  "Cancel Order",
                  () => updateStatus("CANCELLED"),
                  "destructive",
                )}
              >
                <XCircle className="h-4 w-4" /> Cancel Order
              </Button>
            )}

            {["SHIPPED", "INVOICED", "CLOSED", "CANCELLED"].includes(order.status) && (
              <span className="text-sm text-[#9CA3AF]">No actions available for this status.</span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Order Information</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div><p className="text-xs text-[#9CA3AF]">Customer</p><p className="font-medium">{order.customerName}</p></div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Delivery Hub</p>
                <p className="font-medium">
                  {customer?.deliveryHubs?.find(h => h.id === (order as SalesOrder & { hubId?: string }).hubId)?.shortName
                    || ((order as SalesOrder & { hubId?: string }).hubId ? "Hub assigned" : "—")}
                </p>
                <p className="text-xs text-[#9CA3AF]">{order.customerState || "—"}</p>
              </div>
              <div><p className="text-xs text-[#9CA3AF]">Customer PO</p><p className="font-medium doc-number">{order.customerPOId || "-"}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Customer SO</p><p className="font-medium doc-number">{order.customerSOId || "-"}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Reference</p><p className="font-medium">{order.reference || "-"}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Company SO Date</p><p className="font-medium">{formatDate(order.companySODate)}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Customer DD</p><p className="font-medium">{order.customerDeliveryDate ? formatDate(order.customerDeliveryDate) : "-"}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Hookka Expected DD</p><p className="font-medium">{order.hookkaExpectedDD ? formatDate(order.hookkaExpectedDD) : "-"}</p></div>
              <div><p className="text-xs text-[#9CA3AF]">Delivery Order</p><p className="font-medium doc-number">{order.hookkaDeliveryOrder || "-"}</p></div>
            </div>
            {order.notes && (
              <div className="mt-4 rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3">
                <p className="text-xs text-[#9CA3AF] mb-1">Notes</p>
                <p className="text-sm text-[#4B5563]">{order.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle>Summary</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Total Qty</span><span className="font-medium">{totalQty}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Line Items</span><span className="font-medium">{order.items.length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Subtotal</span><span className="font-medium amount">{formatCurrency(order.subtotalSen)}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-lg font-bold">
              <span>Grand Total</span>
              <span className="text-[#6B5C32]">{formatCurrency(order.totalSen)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Linked Production Orders */}
      {linkedPOs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Factory className="h-5 w-5 text-[#6B5C32]" />
              Linked Production Orders ({linkedPOs.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">SO ID</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Product</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Qty</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Current Dept</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Progress</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedPOs.map((po) => (
                    <tr key={po.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                      <td className="px-3 py-3 doc-number font-medium">{displaySoId(po)}</td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-[#1F1D1B]">{po.productName}</p>
                        <p className="text-xs text-[#9CA3AF]">{po.productCode}</p>
                      </td>
                      <td className="px-3 py-3 text-right font-medium">{po.quantity}</td>
                      <td className="px-3 py-3 text-[#4B5563]">{(po.currentDepartment || "—").replace(/_/g, " ")}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-[#E2DDD8] rounded-full h-2 max-w-[120px]">
                            <div
                              className="h-2 rounded-full bg-[#6B5C32] transition-all"
                              style={{ width: `${po.progress}%` }}
                            />
                          </div>
                          <span className="text-xs text-[#6B7280]">{po.progress}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-3"><Badge variant="status" status={po.status} /></td>
                      <td className="px-3 py-3">
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => navigate(`/production/${po.id}`)}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Line Items */}
      <Card>
        <CardHeader className="pb-3"><CardTitle>Items ({order.items.length} lines, {totalQty} qty)</CardTitle></CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-10 px-3 text-left font-medium text-[#374151] w-8">#</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">PO Line</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Product</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Category</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Size</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Fabric</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Qty</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Customization</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Base Price</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => {
                  const hasOverride = overrideHistory.some(o => o.lineIndex === item.lineNo - 1);
                  return (
                    <tr key={item.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                      <td className="px-3 py-3 text-[#9CA3AF]">{item.lineNo}</td>
                      <td className="px-3 py-3 doc-number font-medium">{order.companySOId}{item.lineSuffix}</td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-[#1F1D1B]">{item.productName}</p>
                        <p className="text-xs text-[#9CA3AF] doc-number">{item.productCode}</p>
                      </td>
                      <td className="px-3 py-3"><Badge>{item.itemCategory}</Badge></td>
                      <td className="px-3 py-3 text-[#4B5563]">{item.sizeLabel}</td>
                      <td className="px-3 py-3 doc-number text-[#4B5563]">{item.fabricCode}</td>
                      <td className="px-3 py-3 text-right font-medium">{item.quantity}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {item.gapInches && <span className="text-xs bg-[#E0EDF0] text-[#3E6570] px-1.5 py-0.5 rounded">Gap {item.gapInches}&quot;</span>}
                          {item.divanHeightInches && <span className="text-xs bg-[#F1E6F0] text-[#6B4A6D] px-1.5 py-0.5 rounded">Divan {item.divanHeightInches}&quot;</span>}
                          {item.legHeightInches && <span className="text-xs bg-[#FAEFCB] text-[#9C6F1E] px-1.5 py-0.5 rounded">Leg {item.legHeightInches}&quot;</span>}
                          {item.specialOrder && <span className="text-xs bg-[#F9E1DA] text-[#9A3A2D] px-1.5 py-0.5 rounded">{item.specialOrder.replace(/_/g, " ")}</span>}
                          {!item.gapInches && !item.divanHeightInches && !item.legHeightInches && !item.specialOrder && <span className="text-xs text-[#9CA3AF]">-</span>}
                        </div>
                        {/* Surcharge price annotations */}
                        {(item.divanPriceSen > 0 || item.legPriceSen > 0 || item.specialOrderPriceSen > 0) && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {item.divanPriceSen > 0 && (
                              <span className="text-xs text-[#6B4A6D]">Divan {item.divanHeightInches}&quot;: +RM {(item.divanPriceSen / 100).toFixed(2)}</span>
                            )}
                            {item.legPriceSen > 0 && (
                              <span className="text-xs text-[#9C6F1E]">{item.divanPriceSen > 0 && "· "}Leg {item.legHeightInches}&quot;: +RM {(item.legPriceSen / 100).toFixed(2)}</span>
                            )}
                            {item.specialOrderPriceSen > 0 && (
                              <span className="text-xs text-[#9A3A2D]">{(item.divanPriceSen > 0 || item.legPriceSen > 0) && "· "}{item.specialOrder?.replace(/_/g, " ")}: +RM {(item.specialOrderPriceSen / 100).toFixed(2)}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right amount text-[#6B7280]">
                        RM {(item.basePriceSen / 100).toFixed(2)}
                      </td>
                      <td className="px-3 py-3 text-right amount">
                        <div className="flex items-center justify-end gap-1">
                          {hasOverride && <AlertTriangle className="h-3 w-3 text-[#9C6F1E]" />}
                          {formatCurrency(item.unitPriceSen)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium amount">{formatCurrency(item.lineTotalSen)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]">
                  <td colSpan={10} className="px-3 py-3 text-right font-semibold text-[#374151]">Grand Total</td>
                  <td className="px-3 py-3 text-right font-bold text-lg text-[#6B5C32]">{formatCurrency(order.totalSen)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Price Override History */}
      {overrideHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-[#9C6F1E]" />
                Price Override History ({overrideHistory.length})
              </CardTitle>
              <Button
                variant="ghost" size="sm"
                onClick={() => setShowOverrides(!showOverrides)}
              >
                {showOverrides ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </CardHeader>
          {showOverrides && (
            <CardContent>
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#FAEFCB]">
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Line</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Original Price</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Override Price</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Diff</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Reason</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Approved By</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overrideHistory.map((ov) => {
                      const diffSen = ov.overridePrice - ov.originalPrice;
                      const diffPct = ov.originalPrice > 0 ? ((diffSen / ov.originalPrice) * 100).toFixed(1) : "0";
                      return (
                        <tr key={ov.id} className="border-b border-[#E2DDD8]">
                          <td className="px-3 py-2">{ov.lineIndex + 1}</td>
                          <td className="px-3 py-2 text-right amount">{formatCurrency(ov.originalPrice)}</td>
                          <td className="px-3 py-2 text-right amount font-medium">{formatCurrency(ov.overridePrice)}</td>
                          <td className={`px-3 py-2 text-right ${diffSen < 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                            {diffSen > 0 ? "+" : ""}{formatCurrency(diffSen)} ({diffPct}%)
                          </td>
                          <td className="px-3 py-2 text-[#4B5563]">{ov.reason}</td>
                          <td className="px-3 py-2">{ov.approvedBy}</td>
                          <td className="px-3 py-2 text-[#9CA3AF]">{formatDateTime(ov.timestamp)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Status Timeline */}
      <StatusTimeline history={statusHistory} />

      {/* Document Relationship Diagram */}
      <DocumentFlowDiagram
        title={`Document Relationship — ${order.companySOId}`}
        salesFlow={(() => {
          const nodes: DocNode[] = [
            {
              type: "SO",
              label: "Sales Order",
              docNo: order.companySOId,
              status: order.status,
              isCurrent: true,
              href: `/sales/${order.id}`,
            },
          ];
          // If DO exists
          if (order.hookkaDeliveryOrder) {
            nodes.push({
              type: "DO",
              label: "Delivery Order",
              docNo: order.hookkaDeliveryOrder,
              status: ["DELIVERED", "INVOICED", "CLOSED"].includes(order.status) ? "DELIVERED" : "PENDING",
              href: `/delivery`,
            });
          }
          // Invoice (generated after delivery)
          if (["INVOICED", "CLOSED"].includes(order.status)) {
            nodes.push({
              type: "INVOICE",
              label: "Invoice",
              docNo: `INV-${order.companySOId.replace("SO-", "")}`,
              status: order.status === "CLOSED" ? "PAID" : "UNPAID",
              href: `/invoices`,
            });
          }
          // AR Payment (when closed)
          if (order.status === "CLOSED") {
            nodes.push({
              type: "AR_PAYMENT",
              label: "AR Payment",
              docNo: `AR-${order.companySOId.replace("SO-", "")}`,
              status: "RECEIVED",
              href: `/accounting`,
            });
          }
          return nodes;
        })()}
        purchaseFlow={linkedPOs.length > 0 ? (() => {
          // Show first linked PO as representative
          const po = linkedPOs[0];
          // Production-detail page is gone; node is informational only.
          // docNo follows the same display rule as the linked-PO table
          // (sofa drops -NN suffix, BF/ACC keep it).
          const nodes: DocNode[] = [
            {
              type: "PRODUCTION",
              label: "Production Order",
              docNo: displaySoId(po),
              status: po.status,
            },
          ];
          return nodes;
        })() : undefined}
        crossLinks={linkedPOs.length > 0 ? [
          { fromRow: "sales", fromIdx: 0, toRow: "purchase", toIdx: 0, type: "full" },
        ] : undefined}
      />
    </div>
  );
}
