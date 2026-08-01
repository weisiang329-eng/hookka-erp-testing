import { useState, useMemo, useCallback, useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useNavigate, useParams } from "react-router-dom";
import { useSOMode, soBasePath } from "@/lib/so-mode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import {
  Trash2, Download, Edit, Copy,
  CheckCircle2, Truck, FileText, XCircle, PauseCircle, PlayCircle, X,
  Factory, Clock, DollarSign, AlertTriangle, ChevronDown, ChevronUp,
  Wrench, Pencil,
} from "lucide-react";
// Phase 3 — Service Orders. Opens a modal pre-filled with this SO's
// header info so the user can spawn a Service Case directly from the SO
// detail page when a customer reports a defect.
// 0074 refactor: top-level entry is now Service Cases (parent). Cases can
// spawn 0+ Service Orders for the rework/swap/repair flow.
import { CreateServiceCaseModal } from "@/pages/service-cases";
import { HubEditModal } from "@/components/orders/HubEditModal";
// generateSOPdf is dynamic-imported at the click handler so the 1MB jspdf
// vendor chunk only ships when the user actually prints.
import { DocumentChainMap } from "@/components/ui/document-chain-map";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { LockBanner } from "@/components/ui/lock-banner";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";
import type { SalesOrder, SOStatus, Customer } from "@/types";

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
  completedDate?: string | null;
  completedBy?: string | null;
  // Per-line delivery: the DO this PO shipped on + that DO's raw status.
  deliveryDoNo?: string;
  deliveryStatus?: string;
};

type LinkedDO = {
  id: string;
  doNo: string;
  status: string;
  driverName?: string | null;
  scheduledDate?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
};

// Operator-facing words for a DO's raw status, matching the Delivery module
// tabs (LOADED reads as "Dispatched", DRAFT as "Pending Dispatch").
const DO_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Pending Dispatch",
  LOADED: "Dispatched",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
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

// EDIT_LOCK_OVERRIDDEN rows are shoehorned into so_status_changes (because
// CO has no status-changes table and we want both modules to share the same
// FE shape). The backend marks these by prefixing the notes column with
// "EDIT_LOCK_OVERRIDDEN: ". The UI strips that prefix and renders a distinct
// "Override" badge instead of the default fromStatus → toStatus arrow, so
// operators can spot at a glance which timeline rows are admin escape-hatch
// invocations vs regular status transitions.
const OVERRIDE_NOTE_PREFIX = "EDIT_LOCK_OVERRIDDEN: ";
function isOverrideRow(c: StatusChange): boolean {
  return typeof c.notes === "string" && c.notes.startsWith(OVERRIDE_NOTE_PREFIX);
}
function overrideReason(c: StatusChange): string {
  return c.notes.slice(OVERRIDE_NOTE_PREFIX.length);
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
          {sorted.map((change, i) => {
            const override = isOverrideRow(change);
            return (
              <div key={change.id} className="flex gap-4 pb-4 last:pb-0">
                {/* Timeline connector — override rows render an amber dot
                    so they're visually distinct from green status hops. */}
                <div className="flex flex-col items-center">
                  <div className={`w-3 h-3 rounded-full border-2 ${
                    override
                      ? "border-[#B8860B] bg-[#D4A017]"
                      : i === sorted.length - 1
                        ? "border-[#6B5C32] bg-[#6B5C32]"
                        : "border-[#C6DBA8] bg-[#4F7C3A]"
                  }`} />
                  {i < sorted.length - 1 && <div className="w-0.5 flex-1 bg-[#E2DDD8] mt-1" />}
                </div>
                {/* Content */}
                <div className="flex-1 pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {override ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded bg-[#FBF1D6] text-[#8A6D1B] border border-[#E8D38A]">
                        Override
                      </span>
                    ) : (
                      <>
                        <Badge variant="status" status={change.fromStatus} />
                        <span className="text-xs text-[#9CA3AF]">-&gt;</span>
                        <Badge variant="status" status={change.toStatus} />
                      </>
                    )}
                    <span className="text-xs text-[#9CA3AF] ml-auto">{formatDateTime(change.timestamp)}</span>
                  </div>
                  <p className="text-xs text-[#6B7280] mt-1">by {change.changedBy}</p>
                  {/* For override rows the "reason" is the meaningful payload
                      (notes is just the OVERRIDE: prefix + reason). Render it
                      stripped of the prefix so the operator sees plain text. */}
                  {change.notes && (
                    <p className="text-xs text-[#4B5563] mt-0.5">
                      {override ? overrideReason(change) : change.notes}
                    </p>
                  )}
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
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Order Progress Card ---
// Mobile-first summary of production + delivery state at a glance.
// Single column on narrow screens; rows wrap; no horizontal overflow at 360px.
function OrderProgressCard({
  linkedPOs,
  linkedDOs,
}: {
  linkedPOs: LinkedPO[];
  linkedDOs: LinkedDO[];
}) {
  if (linkedPOs.length === 0 && linkedDOs.length === 0) return null;

  // Derive a simple production summary label.
  function productionLabel(po: LinkedPO): string {
    if (po.status === "COMPLETED") {
      const parts: string[] = [];
      if (po.completedDate) parts.push(formatDate(po.completedDate));
      if (po.completedBy) parts.push(`by ${po.completedBy}`);
      return parts.length ? `Completed ${parts.join(" ")}` : "Completed";
    }
    if (po.status === "PENDING") return "Not started";
    if (po.status === "ON_HOLD") return "On hold";
    if (po.status === "CANCELLED") return "Cancelled";
    // IN_PROGRESS (or any other active state)
    const dept = (po.currentDepartment || "").replace(/_/g, " ");
    return dept ? `In production — ${dept}` : "In production";
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Order Progress</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Production section */}
        {linkedPOs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide mb-2">Production</p>
            <div className="space-y-2">
              {linkedPOs.map((po) => (
                <div key={po.id} className="flex flex-wrap items-center gap-2 min-w-0">
                  <Badge variant="status" status={po.status} />
                  <span className="text-xs font-medium doc-number text-[#6B5C32] shrink-0">
                    {po.poNo.replace(/-\d+$/, po.itemCategory?.toUpperCase() === "SOFA" ? "" : po.poNo.slice(po.poNo.lastIndexOf("-")))}
                  </span>
                  <span className="text-xs text-[#4B5563] min-w-0 break-words">{productionLabel(po)}</span>
                  {po.status !== "COMPLETED" && po.status !== "PENDING" && po.status !== "CANCELLED" && (
                    <span className="text-xs text-[#9CA3AF] shrink-0">{po.progress}%</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Delivery section */}
        {linkedDOs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide mb-2">Delivery</p>
            <div className="space-y-3">
              {linkedDOs.map((d) => (
                <div key={d.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href="/delivery"
                      className="text-xs font-medium doc-number text-[#6B5C32] underline underline-offset-2 hover:text-[#4a3f22]"
                    >
                      {d.doNo}
                    </a>
                    <Badge variant="status" status={d.status} />
                    {d.driverName && (
                      <span className="text-xs text-[#4B5563]">{d.driverName}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[#6B7280]">
                    {d.scheduledDate && (
                      <span>Scheduled: {formatDate(d.scheduledDate)}</span>
                    )}
                    {d.dispatchedAt && (
                      <span>Dispatched: {formatDate(d.dispatchedAt)}</span>
                    )}
                    {d.deliveredAt && (
                      <span>Delivered: {formatDate(d.deliveredAt)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SalesOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  // 0134 — flips this detail page between regular Sales Order and
  // Service Order modes (route-derived). Only navigates + header copy
  // differ.
  const mode = useSOMode();
  const basePath = soBasePath(mode);
  const { data: orderResp, loading, refresh: refreshOrder } = useCachedJson<{
    success?: boolean;
    data?: SalesOrder;
    lockReason?: string | null;
    linkedPOs?: LinkedPO[];
    statusHistory?: StatusChange[];
    priceOverrides?: PriceOverrideRecord[];
    // Real downstream documents resolved server-side (handles consolidated DOs).
    linkedDOs?: LinkedDO[];
    linkedInvoices?: { id: string; invoiceNo: string; status: string; totalSen: number; paidAmount: number; paymentDate: string | null }[];
    linkedPayments?: { id: string; receiptNumber: string; date: string; amount: number; status: string }[];
  }>(id ? `/api/sales-orders/${id}` : null);
  const [updating, setUpdating] = useState(false);
  const [confirmSuccess, setConfirmSuccess] = useState<string | null>(null);
  const [showOverrides, setShowOverrides] = useState(false);
  // Phase 3 — opens the Service Order create modal pre-filled with this SO.
  const [serviceModalOpen, setServiceModalOpen] = useState(false);

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

  // Put-On-Hold modal (0185). Holding an order REQUIRES a non-empty reason —
  // the Confirm button stays disabled until the operator types one, and an
  // inline error fires if they somehow submit blank. The reason rides to the
  // backend (which also rejects blank) and is shown on the production grid.
  const [holdModal, setHoldModal] = useState<{ open: boolean; reason: string; error: string }>(
    { open: false, reason: "", error: "" },
  );

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
  // Source PO scan kept as a durable SO attachment (owner 2026-07-15) so
  // "View original" works even when the inline customerPOImageB64 render is
  // absent (every scan after the 2026-06 OCR-queue rewrite lost that render).
  const [poOriginalUrl, setPoOriginalUrl] = useState<string | null>(null);
  useEffect(() => {
    const soId = order?.id;
    if (!soId) {
      setPoOriginalUrl(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(
          `/api/files?resourceType=SO&resourceId=${encodeURIComponent(soId)}`,
        );
        const j = (await r.json().catch(() => null)) as {
          data?: Array<{ id: string; filename?: string; contentType?: string }>;
        } | null;
        const files = j?.data ?? [];
        const orig =
          files.find((f) =>
            (f.filename ?? "").toLowerCase().includes("po-original"),
          ) ??
          files.find((f) => /pdf|image/.test(f.contentType ?? "")) ??
          null;
        if (alive) setPoOriginalUrl(orig ? `/api/files/${orig.id}/stream` : null);
      } catch {
        /* no attachment — falls back to customerPOImageB64 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [order?.id]);
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
  // Real delivery orders — still needed by OrderProgressCard. The invoice /
  // payment legs of the chain are no longer derived here: DocumentChainMap
  // reads them off the same (cached) /api/sales-orders/:id response itself.
  const linkedDOs = useMemo(
    () => (orderResp?.success ? orderResp.linkedDOs ?? [] : []),
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
  const { data: eligibilityResp, refresh: refreshEligibility } = useCachedJson<{
    editable: boolean;
    reason?: "status" | "production_window" | "dept_completed";
    completedDept?: string;
    completedAt?: string;
    // Rule-3 fields: only present when reason="production_window".
    earliestJcDueDate?: string;
    cutoffDate?: string;
  }>(id ? `/api/sales-orders/${id}/edit-eligibility` : null);
  const cancelLocked = eligibilityResp?.reason === "dept_completed";
  const cancelLockTooltip = cancelLocked
    ? `Cannot cancel — ${eligibilityResp?.completedDept || "A department"} completed on ${formatDate(eligibilityResp?.completedAt || "")}`
    : "";
  const productionWindowLocked = eligibilityResp?.reason === "production_window";

  // Override-Lock modal state. Only ADMIN / SUPER_ADMIN see the trigger
  // button — the role gate is below near `canOverride`. The modal collects a
  // mandatory reason (>= 5 chars after trim, matched server-side), POSTs
  // /override-edit-lock, then navigates to /sales/:id/edit with the returned
  // overrideToken in router state so the edit page can forward it on PUT.
  const authUser = getCurrentUser();
  const userRole = (authUser?.role || "").toUpperCase();
  const canOverride =
    productionWindowLocked &&
    (userRole === "ADMIN" || userRole === "SUPER_ADMIN");
  const [overrideModal, setOverrideModal] = useState<{
    open: boolean;
    reason: string;
    submitting: boolean;
    error: string | null;
  }>({ open: false, reason: "", submitting: false, error: null });

  // Hub-edit modal state. Wei Siang's rule: hub is editable until any
  // linked DO has been LOADED (or beyond). Operators (e.g. Violet) often
  // pick the wrong hub (PG vs KL on Houzs Century) — this lets them fix
  // it in-place without raw SQL. The shipment lock is computed below.
  const [hubModalOpen, setHubModalOpen] = useState(false);

  // SHIPPED-DO set must match the backend guard in
  // src/api/routes/sales-orders.ts PATCH /:id/hub. DRAFT is the only
  // pre-shipment state; everything past it means goods left the warehouse.
  const shippedDo = useMemo(() => {
    return linkedDOs.find((d) =>
      ["LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"].includes(
        (d.status || "").toUpperCase(),
      ),
    );
  }, [linkedDOs]);
  const shipmentLocked = !!shippedDo;
  const shipmentLockReason = shippedDo
    ? `Hub locked: DO ${shippedDo.doNo} already ${shippedDo.status}.`
    : "";

  const submitOverride = useCallback(async () => {
    if (!id) return;
    const reason = overrideModal.reason.trim();
    if (reason.length < 5) {
      setOverrideModal((prev) => ({
        ...prev,
        error: "Please enter a reason of at least 5 characters.",
      }));
      return;
    }
    setOverrideModal((prev) => ({ ...prev, submitting: true, error: null }));
    try {
      const res = await fetch(
        `/api/sales-orders/${id}/override-edit-lock`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        overrideToken?: string;
        expiresAt?: string;
      };
      if (!res.ok || !data.success || !data.overrideToken) {
        setOverrideModal((prev) => ({
          ...prev,
          submitting: false,
          error: data.error || `Failed (HTTP ${res.status})`,
        }));
        return;
      }
      // Refresh eligibility cache so the SO timeline reflects the audit
      // row immediately on return from edit. Not strictly necessary for
      // navigation correctness but avoids stale "still locked" hints.
      if (id) invalidateCache(`/api/sales-orders/${id}`);
      refreshEligibility();
      setOverrideModal({
        open: false,
        reason: "",
        submitting: false,
        error: null,
      });
      toast.success("Override granted — opening edit page.");
      // Pass the token via location.state. Survives a single navigation,
      // which is exactly the lifetime we want — refresh / back-button
      // doesn't accidentally re-use a token. The edit page reads it via
      // useLocation() and forwards on the PUT body.
      navigate(`${basePath}/${id}/edit`, {
        state: { overrideToken: data.overrideToken, overrideReason: reason },
      });
    } catch (e) {
      setOverrideModal((prev) => ({
        ...prev,
        submitting: false,
        error: e instanceof Error ? e.message : "Network error",
      }));
    }
  }, [id, overrideModal.reason, navigate, toast, refreshEligibility, basePath]);

  // Per-PO Hold / Resume / Cancel — operator action on a single Linked
  // Production Order. Used to handle the "duplicate items" case where some
  // POs in an SO are completed but the customer changes their mind on the
  // rest. Completed POs are untouchable (server returns 409); only
  // PENDING / IN_PROGRESS / ON_HOLD POs accept an action.
  const [poActionBusyId, setPoActionBusyId] = useState<string | null>(null);
  const handlePoAction = useCallback(
    async (poId: string, action: "hold" | "resume" | "cancel") => {
      let reason = "";
      // Cancel + Hold ask for a reason. Resume doesn't (it's a recovery action).
      if (action === "cancel" || action === "hold") {
        const promptMsg =
          action === "cancel"
            ? "Reason for cancelling this production order? (will be logged)"
            : "Reason for holding this production order? (will be logged)";
        const input = window.prompt(promptMsg, "");
        if (input == null) return; // operator hit Cancel on the prompt
        reason = input.trim();
        if (reason.length < 3) {
          toast.warning("Please provide a reason (3+ characters).");
          return;
        }
        if (action === "cancel") {
          const ok = await confirm({
            title: "Cancel PO?",
            message:
              "Cancel this PO?\n\nAll non-completed job cards under it will also be cancelled. Completed work stays intact (it's already real product).\n\nProceed?",
            danger: true,
          });
          if (!ok) return;
        }
      }
      setPoActionBusyId(poId);
      try {
        const res = await fetch(`/api/production-orders/${poId}/${action}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          status?: string;
          jcCascadeCount?: number;
        };
        if (!res.ok || !j.success) {
          toast.error(j.error ?? `Failed to ${action} (HTTP ${res.status})`);
          return;
        }
        const cascadeNote =
          action === "cancel" && (j.jcCascadeCount ?? 0) > 0
            ? ` · ${j.jcCascadeCount} job card(s) cancelled too`
            : "";
        toast.success(`PO ${action}d → ${j.status}${cascadeNote}`);
        fetchOrder();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : `Network error — PO ${action} failed`,
        );
      } finally {
        setPoActionBusyId(null);
      }
    },
    [fetchOrder, toast, confirm],
  );

  // `holdReason` is REQUIRED when newStatus === "ON_HOLD" — the hold modal
  // enforces a non-empty value before calling here, and the backend rejects a
  // blank reason with a 400 (unified FE+BE input rejection). For every other
  // transition holdReason is undefined and omitted from the body.
  const updateStatus = useCallback(async (newStatus: SOStatus, holdReason?: string) => {
    if (!order) return;
    setUpdating(true);
    // Stamp who performed the transition from the logged-in user (falls back
    // to "Admin" for an unauthenticated/legacy session) so the audit row and
    // the production "held by" line name a real person, not the literal "Admin".
    const actor = getCurrentUser()?.displayName?.trim() || "Admin";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res: Response; let data: any;
    try {
      res = await fetch(`/api/sales-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          newStatus === "ON_HOLD"
            ? { status: newStatus, holdReason: (holdReason || "").trim(), changedBy: actor }
            : { status: newStatus, changedBy: actor },
        ),
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
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
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
    if (!(await confirm({ title: "Delete order?", message: "Delete this order?", danger: true }))) return;
    try {
      const res = await fetch(`/api/sales-orders/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      // Deleting an SO also cascades to its linked POs on the server. Invalidate
      // the SO list (one row gone) and the PO list (linked POs gone), plus the
      // per-id SO entry so any stale detail fetch doesn't resurrect a 404.
      invalidateCachePrefix("/api/sales-orders");
      invalidateCachePrefix("/api/production-orders");
      if (id) invalidateCache(`/api/sales-orders/${id}`);
      navigate(basePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "try again";
      toast.error(`Failed to delete order: ${detail}`);
      console.error(err);
    }
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
    navigate(`${basePath}/create?clone=1`);
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-[#6B7280]">Loading...</div>;
  if (!order) return <div className="flex flex-col items-center justify-center h-64 gap-4"><div className="text-[#6B7280]">Order not found</div><Button variant="outline" onClick={() => navigate(basePath)}>Back</Button></div>;

  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
  // Cascade lock — surfaced from the API; if non-null the SO has a downstream
  // PO that's already COMPLETED so item/header edits are blocked. Status
  // transitions still go through (CONFIRM, ON_HOLD, CANCEL pass the
  // lock-guard's `isStatusOnly` check on the backend).
  const lockReason = orderResp?.lockReason ?? null;
  const isLocked = !!lockReason;
  // canEdit honors the server-side /edit-eligibility verdict for in-flight
  // statuses. Bug fix 2026-04-28: previously the FE hardcoded ["DRAFT",
  // "CONFIRMED"] which silently dropped Edit for every IN_PRODUCTION SO -
  // since the state machine was changed to land Create Order at
  // IN_PRODUCTION directly (skipping CONFIRMED), every newly created SO
  // could never be edited. The eligibility endpoint already returns the
  // right answer (false when production_window > 2 days OR any dept
  // completed). Trust it for IN_PRODUCTION; DRAFT bypasses since there's
  // nothing to lock yet.
  const eligibilityEditable = eligibilityResp?.editable ?? true;
  const canEdit =
    !isLocked &&
    (order.status === "DRAFT" ||
      order.status === "CONFIRMED" ||
      (order.status === "IN_PRODUCTION" && eligibilityEditable));
  const canCancel = ["DRAFT", "CONFIRMED", "IN_PRODUCTION"].includes(order.status);
  const canHold = ["CONFIRMED", "IN_PRODUCTION"].includes(order.status);
  const isOnHold = order.status === "ON_HOLD";

  return (
    <div className="space-y-6 max-md:space-y-4">
      <LockBanner reason={lockReason} />

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

      {/* Put-On-Hold Modal (0185) — a reason is REQUIRED. The Confirm button
          stays disabled until a non-empty reason is typed; the same rule is
          enforced on the backend. The reason flows to the production grid. */}
      {holdModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setHoldModal({ open: false, reason: "", error: "" })} />
          <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PauseCircle className="h-5 w-5 text-[#9C6F1E]" />
                <h3 className="text-lg font-semibold text-[#1F1D1B]">Put On Hold</h3>
              </div>
              <button onClick={() => setHoldModal({ open: false, reason: "", error: "" })} className="text-[#9CA3AF] hover:text-[#374151]"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-xs text-[#6B7280]">
              Production will be paused until the order is resumed. A reason is
              required — it is shown on the production grid so the shop floor
              knows why this job is on hold.
            </p>
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Reason <span className="text-[#9A3A2D]">*</span>
              </label>
              <textarea
                autoFocus
                rows={3}
                value={holdModal.reason}
                onChange={(e) => setHoldModal(prev => ({ ...prev, reason: e.target.value, error: "" }))}
                placeholder="e.g. Waiting on customer fabric confirmation"
                className="w-full rounded-md border border-[#D9D4CE] px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#E2C66B] resize-none"
              />
              {holdModal.error && (
                <p className="text-xs text-[#9A3A2D] mt-1">{holdModal.error}</p>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="outline" size="sm" onClick={() => setHoldModal({ open: false, reason: "", error: "" })}>Cancel</Button>
              <Button
                variant="primary" size="sm"
                disabled={updating || holdModal.reason.trim().length === 0}
                onClick={() => {
                  const reason = holdModal.reason.trim();
                  if (!reason) {
                    setHoldModal(prev => ({ ...prev, error: "A reason is required to put this order on hold." }));
                    return;
                  }
                  setHoldModal({ open: false, reason: "", error: "" });
                  updateStatus("ON_HOLD", reason);
                }}
              >
                <PauseCircle className="h-4 w-4" /> Put On Hold
              </Button>
            </div>
          </div>
        </div>
      )}

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

      <ObjectPageHeader
        backTo={basePath}
        title={order.companySOId}
        subtitle={`${order.customerName} · ${order.customerState}`}
        badges={<Badge variant="status" status={order.status} />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={async () => {
              if (!order) return;
              const { generateSOPdf } = await import("@/lib/generate-so-pdf");
              generateSOPdf(order, customer);
            }}><Download className="h-4 w-4" /> PDF</Button>
            <Button variant="outline" size="sm" onClick={handleClone}><Copy className="h-4 w-4" /> Clone</Button>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => navigate(`${basePath}/${id}/edit`)}><Edit className="h-4 w-4" /> Edit</Button>
            )}
            {/* Rule-3 production_window lock surface. Non-admins see a
                disabled "Edit (locked)" with a tooltip explaining the cutoff;
                ADMIN / SUPER_ADMIN see the same disabled chip PLUS an amber
                "Override Lock" button that opens the reason-capture modal. */}
            {!canEdit && productionWindowLocked && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title={
                    eligibilityResp?.earliestJcDueDate && eligibilityResp?.cutoffDate
                      ? `Locked — first JC dueDate ${eligibilityResp.earliestJcDueDate} is within the 2-day cutoff (${eligibilityResp.cutoffDate}).`
                      : "Locked — within production window."
                  }
                >
                  <Edit className="h-4 w-4" /> Edit (locked)
                </Button>
                {canOverride && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[#8A6D1B] border-[#E8D38A] hover:bg-[#FBF1D6]"
                    onClick={() =>
                      setOverrideModal({
                        open: true,
                        reason: "",
                        submitting: false,
                        error: null,
                      })
                    }
                  >
                    <AlertTriangle className="h-4 w-4" /> Override Lock
                  </Button>
                )}
              </>
            )}
            {order.status === "DRAFT" && (
              <Button variant="outline" size="sm" className="text-[#9A3A2D] hover:text-[#7A2E24]" onClick={deleteOrder}><Trash2 className="h-4 w-4" /> Delete</Button>
            )}
          </>
        }
      />

      {/* Override-Lock Modal — admin-only escape hatch for Rule 3 (the
          production_window soft-lock). Required reason text is captured
          here, sent to POST /:id/override-edit-lock, the returned token
          is forwarded to the edit page via router state. */}
      {overrideModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => {
              if (!overrideModal.submitting) {
                setOverrideModal({ open: false, reason: "", submitting: false, error: null });
              }
            }}
          />
          <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-[#B8860B]" />
                <h3 className="text-lg font-semibold text-[#1F1D1B]">Override Edit Lock</h3>
              </div>
              <button
                onClick={() =>
                  !overrideModal.submitting &&
                  setOverrideModal({ open: false, reason: "", submitting: false, error: null })
                }
                className="text-[#9CA3AF] hover:text-[#374151]"
                disabled={overrideModal.submitting}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-[#374151]">
              Earliest JC dueDate is{" "}
              <span className="font-mono">{eligibilityResp?.earliestJcDueDate || "—"}</span>
              , within the 2-day cutoff (
              <span className="font-mono">{eligibilityResp?.cutoffDate || "—"}</span>
              ). Editing past this point may cause material orders or cutting
              plans to drift out of sync with live job cards. Reason for
              override:
            </p>
            <textarea
              value={overrideModal.reason}
              onChange={(e) =>
                setOverrideModal((prev) => ({
                  ...prev,
                  reason: e.target.value,
                  error: null,
                }))
              }
              placeholder="Explain why this edit is necessary (min 5 chars)..."
              className="w-full min-h-[100px] rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#B8860B] focus:border-transparent"
              disabled={overrideModal.submitting}
            />
            {overrideModal.error && (
              <p className="text-sm text-[#9A3A2D]">{overrideModal.error}</p>
            )}
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverrideModal({ open: false, reason: "", submitting: false, error: null })
                }
                disabled={overrideModal.submitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitOverride}
                disabled={overrideModal.submitting || overrideModal.reason.trim().length < 5}
                className="bg-[#B8860B] hover:bg-[#8A6D1B] text-white"
              >
                {overrideModal.submitting ? "Submitting..." : "Override and Edit"}
              </Button>
            </div>
          </div>
        </div>
      )}

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

            {/* Put On Hold — opens a modal that REQUIRES a reason (0185). */}
            {canHold && (
              <Button
                variant="outline" size="sm" disabled={updating}
                onClick={() => setHoldModal({ open: true, reason: "", error: "" })}
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

            {/* Phase 3 — Service Order: only shipped (or beyond) orders can
                trigger a customer-defect claim. Backend re-validates. */}
            {["SHIPPED", "DELIVERED", "INVOICED", "CLOSED"].includes(order.status) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setServiceModalOpen(true)}
                title="Log a Service Case for a customer issue / complaint"
              >
                <Wrench className="h-4 w-4" /> Open Service Case
              </Button>
            )}

            {["SHIPPED", "INVOICED", "CLOSED", "CANCELLED"].includes(order.status) && (
              <span className="text-sm text-[#9CA3AF]">No further status actions for this state.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {serviceModalOpen && (
        <CreateServiceCaseModal
          presetSourceType="SO"
          presetSourceId={order.id}
          onClose={() => setServiceModalOpen(false)}
          onCreated={(svcId) => {
            setServiceModalOpen(false);
            toast.success("Service case opened");
            navigate(`/service-cases/${svcId}`);
          }}
        />
      )}

      <HubEditModal
        open={hubModalOpen}
        endpoint={`/api/sales-orders/${order.id}/hub`}
        currentHubId={(order as SalesOrder & { hubId?: string }).hubId}
        hubs={customer?.deliveryHubs ?? []}
        onClose={() => setHubModalOpen(false)}
        onSaved={(newHubName, cascade) => {
          setHubModalOpen(false);
          // Compose a single toast that includes the cascade summary so
          // the operator sees at a glance which downstream documents were
          // refreshed (DRAFT DOs, DRAFT invoices). Production sheets are
          // NOT cascaded — production_orders has no hub columns, the
          // sheet reads hub via JOIN at print time. We mention them
          // separately as "auto-update via join" so the operator knows
          // reprinting will pick up the new hub.
          const cascadedParts: string[] = [];
          if (cascade) {
            if ((cascade.deliveryOrdersUpdated ?? 0) > 0) {
              cascadedParts.push(
                `${cascade.deliveryOrdersUpdated} draft DO${cascade.deliveryOrdersUpdated === 1 ? "" : "s"}`,
              );
            }
            if ((cascade.invoicesUpdated ?? 0) > 0) {
              cascadedParts.push(
                `${cascade.invoicesUpdated} draft invoice${cascade.invoicesUpdated === 1 ? "" : "s"}`,
              );
            }
          }
          let msg = `Hub updated to ${newHubName}.`;
          if (cascadedParts.length) {
            msg += ` Cascaded to: ${cascadedParts.join(", ")}.`;
          }
          if (cascade && cascade.productionOrdersUpdated > 0) {
            const n = cascade.productionOrdersUpdated;
            msg += ` ${n} production sheet${n === 1 ? "" : "s"} will auto-update via join on next print.`;
          }
          toast.success(msg);
          // Surface multi-SO DOs we deliberately skipped so the operator
          // can fix those by hand. These are NOT errors — the parent SO
          // change succeeded; we just refused to silently corrupt a DO
          // that also carries items for a sibling SO on a different hub.
          if (cascade?.warningDOs && cascade.warningDOs.length > 0) {
            for (const w of cascade.warningDOs) {
              toast.warning(
                `Did not update ${w.doNo} (${w.reason}). Please review manually.`,
              );
            }
          }
          fetchOrder();
        }}
      />

      {/* Order Progress — production + delivery glance card, mobile-first */}
      <OrderProgressCard linkedPOs={linkedPOs} linkedDOs={linkedDOs} />

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Order Information</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm max-[360px]:grid-cols-1">
              <div><p className="text-xs text-[#9CA3AF]">Customer</p><p className="font-medium">{order.customerName}</p></div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Delivery Hub</p>
                <div className="flex items-center gap-2">
                  <p className="font-medium">
                    {customer?.deliveryHubs?.find(h => h.id === (order as SalesOrder & { hubId?: string }).hubId)?.shortName
                      || ((order as SalesOrder & { hubId?: string }).hubId ? "Hub assigned" : "—")}
                  </p>
                  <button
                    type="button"
                    onClick={() => setHubModalOpen(true)}
                    disabled={shipmentLocked}
                    title={shipmentLocked ? shipmentLockReason : "Change delivery hub"}
                    className="text-[#9CA3AF] hover:text-[#6B5C32] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-xs text-[#9CA3AF]">{order.customerState || "—"}</p>
                <p className="text-[10px] text-[#9CA3AF] mt-1">
                  {shipmentLocked
                    ? shipmentLockReason
                    : "Editable until goods leave the warehouse."}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Customer PO</p>
                <p className="font-medium doc-number">
                  {order.customerPOId || "-"}
                  {(order.customerPOImageB64 || poOriginalUrl) && (
                    <button
                      type="button"
                      className="ml-2 text-xs text-[#6B5C32] underline hover:text-[#4a3f22]"
                      onClick={() => {
                        // Prefer the durable source attachment (PDF/image kept
                        // on the SO); fall back to the legacy inline render.
                        if (poOriginalUrl) {
                          window.open(poOriginalUrl, "_blank", "noopener");
                          return;
                        }
                        const img = order.customerPOImageB64!;
                        const w = window.open();
                        if (w) {
                          w.document.write(
                            `<html><head><title>Original PO — ${order.customerPOId || order.companySOId}</title></head><body style="margin:0;background:#222;text-align:center"><img src="${img}" style="max-width:100%;height:auto"/></body></html>`,
                          );
                        }
                      }}
                      title="Open the original customer PO in a new tab"
                    >
                      View original
                    </button>
                  )}
                </p>
              </div>
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
              <span>TOTAL</span>
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
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Completed</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Delivery</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Actions</th>
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
                      <td className="px-3 py-3 text-[#4B5563]">{po.status === "COMPLETED" ? "Done" : (po.currentDepartment || "—").replace(/_/g, " ")}</td>
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
                      <td className="px-3 py-3 doc-number whitespace-nowrap text-[#4B5563]">
                        {po.completedDate ? formatDate(po.completedDate) : <span className="text-[#9CA3AF]">—</span>}
                      </td>
                      <td className="px-3 py-3">
                        {po.deliveryDoNo ? (
                          <div className="flex flex-col leading-tight">
                            <span className="doc-number text-[#1F1D1B]">{po.deliveryDoNo}</span>
                            <span className="text-xs text-[#6B7280]">
                              {DO_STATUS_LABEL[po.deliveryStatus ?? ""] ?? po.deliveryStatus}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-[#9CA3AF]">Not on a DO</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {/* Hold — only PENDING / IN_PROGRESS. ON_HOLD POs
                              show Resume instead. COMPLETED / CANCELLED show
                              nothing actionable. */}
                          {(po.status === "PENDING" || po.status === "IN_PROGRESS") && (
                            <Button
                              variant="ghost" size="sm"
                              disabled={poActionBusyId === po.id}
                              onClick={() => handlePoAction(po.id, "hold")}
                              title="Pause this PO (production stops; can resume later)"
                            >
                              <PauseCircle className="h-4 w-4 text-[#A16207]" />
                            </Button>
                          )}
                          {po.status === "ON_HOLD" && (
                            <Button
                              variant="ghost" size="sm"
                              disabled={poActionBusyId === po.id}
                              onClick={() => handlePoAction(po.id, "resume")}
                              title="Resume this PO back to PENDING"
                            >
                              <PlayCircle className="h-4 w-4 text-[#15803D]" />
                            </Button>
                          )}
                          {(po.status === "PENDING" || po.status === "IN_PROGRESS" || po.status === "ON_HOLD") && (
                            <Button
                              variant="ghost" size="sm"
                              disabled={poActionBusyId === po.id}
                              onClick={() => handlePoAction(po.id, "cancel")}
                              title="Cancel this PO (also cancels its non-completed job cards)"
                            >
                              <XCircle className="h-4 w-4 text-[#B91C1C]" />
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => navigate(`/production/${po.id}`)}
                          >
                            View
                          </Button>
                        </div>
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
                          {/* Numeric guards use > 0 (not &&) — `0 && <span>` */}
                          {/* short-circuits to the number 0, which React renders */}
                          {/* as literal text "0" in the DOM. */}
                          {(item.gapInches ?? 0) > 0 && <span className="text-xs bg-[#E0EDF0] text-[#3E6570] px-1.5 py-0.5 rounded">Gap {item.gapInches}&quot;</span>}
                          {(item.divanHeightInches ?? 0) > 0 && <span className="text-xs bg-[#F1E6F0] text-[#6B4A6D] px-1.5 py-0.5 rounded">Divan {item.divanHeightInches}&quot;</span>}
                          {(item.legHeightInches ?? 0) > 0 && <span className="text-xs bg-[#FAEFCB] text-[#9C6F1E] px-1.5 py-0.5 rounded">Leg {item.legHeightInches}&quot;</span>}
                          {item.specialOrder && <span className="text-xs bg-[#F9E1DA] text-[#9A3A2D] px-1.5 py-0.5 rounded">{item.specialOrder.replace(/_/g, " ")}</span>}
                          {!(item.gapInches && item.gapInches > 0) && !(item.divanHeightInches && item.divanHeightInches > 0) && !(item.legHeightInches && item.legHeightInches > 0) && !item.specialOrder && <span className="text-xs text-[#9CA3AF]">-</span>}
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
                  <td colSpan={10} className="px-3 py-3 text-right font-semibold text-[#374151]">TOTAL</td>
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

      {/* Relationship map — replaces the old flow diagram. Same chain, but
          grey-vs-colour says what does NOT exist yet, and the production strip
          says which station each part is sitting at and whose hands it's in. */}
      <DocumentChainMap soId={order.id} currentDocNo={order.companySOId} />

      {/* Per-record audit trail — feeds off audit_events. Status flips,
          field edits, item-list changes all show up here with the actor,
          a timestamp, and an expandable field-level diff. */}
      <AuditHistoryPanel
        resource="sales-orders"
        resourceId={order.id}
        fieldLabels={{
          companySOId: "SO Number",
          customerId: "Customer",
          customerPO: "Customer PO",
          poDate: "PO Date",
          deliveryDate: "Delivery Date",
          processingDate: "Processing Date",
          totalSen: "Total (sen)",
          balanceSen: "Balance (sen)",
          depositSen: "Deposit (sen)",
          status: "Status",
          remarks: "Remarks",
          items: "Items",
          shippingAddress: "Shipping Address",
        }}
        ignoredFields={["lastSyncedAt", "syncedAt", "updatedBy"]}
      />
    </div>
  );
}
