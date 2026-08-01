import { useState, useMemo } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RepairPartsBadge } from "@/components/sales/repair-scope-picker";
import { formatDate, formatDateTime } from "@/lib/utils";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { LockBanner } from "@/components/ui/lock-banner";
import { SoDocumentRelationship } from "@/components/ui/so-document-relationship";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import {
  User,
  MapPin,
  Phone,
  Truck,
  CheckCircle2,
  Undo2,
  PackageCheck,
  Send,
  ReceiptText,
  Download,
  ClipboardList,
  MapPinned,
  AlertTriangle,
  Box,
  QrCode,
} from "lucide-react";
// PDF generators are dynamic-imported in the click handlers so the 1MB
// jspdf vendor chunk only ships when the user actually downloads a PDF.
import PODDialog from "@/components/delivery/POD-dialog";
import DoQrDialog from "@/components/delivery/do-qr-dialog";
import type { ProofOfDelivery } from "@/types";
import { usePresence } from "@/lib/use-presence";
import { PresenceBanner } from "@/components/presence-banner";
import { FetchJsonError } from "@/lib/fetch-json";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeliveryOrderItem = {
  id: string;
  productionOrderId: string;
  salesOrderNo?: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  rackingNumber: string;
  packingStatus: string;
  repairScope?: string | null;
};

type DeliveryOrder = {
  id: string;
  doNo: string;
  salesOrderId: string;
  companySOId: string;
  customerId: string;
  customerPOId: string;
  customerName: string;
  customerState: string;
  hubId?: string | null;
  hubName?: string;
  deliveryAddress: string;
  contactPerson: string;
  contactPhone: string;
  deliveryDate: string;
  hookkaExpectedDD: string;
  driverId: string | null;
  driverName: string;
  vehicleNo: string;
  items: DeliveryOrderItem[];
  totalM3: number;
  totalItems: number;
  status: "DRAFT" | "LOADED" | "IN_TRANSIT" | "DELIVERED" | "INVOICED" | "CANCELLED";
  overdue: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  remarks: string;
  lorryId?: string | null;
  lorryName?: string;
  proofOfDelivery?: ProofOfDelivery | null;
  // Delivered "with issues" — goods arrived but paperwork incomplete, so the
  // invoice is on hold until resolved (POST /:id/resolve-incomplete).
  deliveryIncomplete?: boolean;
};

type LorryInfo = {
  id: string;
  name: string;
  plateNumber: string;
  capacity: number;
  driverName: string;
  driverContact: string;
  status: "AVAILABLE" | "IN_USE" | "MAINTENANCE";
};

// ---------------------------------------------------------------------------
// Status flow
// ---------------------------------------------------------------------------

const STATUS_FLOW: Record<string, { next: string; label: string; icon: React.ReactNode }> = {
  DRAFT: { next: "LOADED", label: "Load & Generate DO", icon: <PackageCheck className="h-4 w-4" /> },
  LOADED: { next: "IN_TRANSIT", label: "Dispatch", icon: <Send className="h-4 w-4" /> },
  IN_TRANSIT: { next: "DELIVERED", label: "Mark Delivered", icon: <CheckCircle2 className="h-4 w-4" /> },
};

const ALL_STATUSES = ["DRAFT", "LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Packing List",
  LOADED: "Loaded",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
};

function calculateOverdueDays(deliveryDate: string, deliveredAt: string | null): number {
  if (!deliveryDate) return 0;
  const target = new Date(deliveryDate);
  const comparison = deliveredAt ? new Date(deliveredAt) : new Date();
  const diff = Math.floor((comparison.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Delivery returns raised against this DO, returned by
// GET /api/delivery-orders/:id (delivery_returns.deliveryOrderId reverse
// lookup). Before this the relationship was only visible from the Delivery
// Returns list, so the DO a return came off showed a clean delivered document.
type LinkedReturn = {
  id: string;
  returnNo: string;
  status: string;
  returnType: string;
  reason: string;
  returnedAt: string | null;
  createdAt: string | null;
};

export default function DeliveryDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const otherEditors = usePresence("delivery_order", id, Boolean(id));
  const { data: doResp, loading: doLoading } = useCachedJson<{ success?: boolean; data?: DeliveryOrder; lockReason?: string | null; linkedReturns?: LinkedReturn[] }>(id ? `/api/delivery-orders/${id}` : null);
  const { data: lorryResp, loading: lorryLoading } = useCachedJson<{ success?: boolean; data?: LorryInfo[] }>("/api/lorries");
  const [orderOverride, setOrderOverride] = useState<DeliveryOrder | null>(null);
  const order: DeliveryOrder | null = useMemo(() => {
    if (orderOverride) return orderOverride;
    if (!doResp) return null;
    if (doResp.success && doResp.data) return doResp.data;
    return (doResp as unknown as DeliveryOrder) ?? null;
  }, [doResp, orderOverride]);
  const lorries: LorryInfo[] = useMemo(
    () => (lorryResp?.success ? lorryResp.data ?? [] : Array.isArray(lorryResp) ? lorryResp : []),
    [lorryResp]
  );
  const loading = doLoading || lorryLoading;
  const [updating, setUpdating] = useState(false);
  const [podOpen, setPodOpen] = useState(false);
  // Delivery-status QR modal — drivers scan it to Mark Dispatched/Delivered
  // from their own phones (no login; see /d/:token + routes/public-do-qr.ts).
  const [qrOpen, setQrOpen] = useState(false);
  const setOrder = setOrderOverride;

  const advanceStatus = async (nextStatus?: string) => {
    if (!order) return;
    const target = nextStatus || STATUS_FLOW[order.status]?.next;
    if (!target) return;

    // Gate DELIVERED transition on proof of delivery
    if (target === "DELIVERED" && !order.proofOfDelivery) {
      setPodOpen(true);
      return;
    }

    setUpdating(true);
    try {
      // 2026-05-27 verifiedSave migration. Status advance is the highest-
      // stakes DO write (gates billing + SO cascade). Read back the DO
      // with a cache-bust and confirm the status flipped — if a stale
      // snapshot served the pre-write payload, the operator sees
      // "save did not take effect" instead of a false-green toast.
      const result = await verifiedSave<DeliveryOrder>({
        endpoint: `/api/delivery-orders/${id}`,
        method: "PUT",
        body: { status: target },
        readback: async () => {
          const r = await fetch(`/api/delivery-orders/${id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
          return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
        },
        // Delivering auto-creates the invoice and bumps the DO straight to
        // INVOICED, so a DELIVERED advance may settle on either — accept both.
        expect: {
          status: target === "DELIVERED" ? ["DELIVERED", "INVOICED"] : target,
        },
      });
      if (!result.ok) {
        if (result.reason === "mismatch") {
          toast.error(formatMismatchError(result.diffs));
        } else if (result.reason === "http") {
          let parsedErr = result.body;
          try {
            const j = JSON.parse(result.body) as { error?: string };
            if (j.error) parsedErr = j.error;
          } catch {
            /* keep raw body */
          }
          toast.error(parsedErr || `Failed to advance status (HTTP ${result.status})`);
        } else {
          toast.error(`Save failed: ${result.details}`);
        }
        return;
      }
      setOrder(result.data);
      // Only this DO changed. SO/PO prefix kept because a status
      // advance can cascade (e.g. DELIVERED → linked SO → COMPLETED).
      if (id) invalidateCache(`/api/delivery-orders/${id}`);
      invalidateCachePrefix("/api/sales-orders");
      invalidateCachePrefix("/api/production-orders");
      // Advancing to DELIVERED auto-creates the invoice — broadcast so the
      // Invoices list picks it up (2026-07-04 cache sweep; resolveIncomplete
      // already did this, this POD path was the gap).
      if (target === "DELIVERED") invalidateCachePrefix("/api/invoices");
    } catch (e) {
      if (e instanceof FetchJsonError) {
        const body = e.body as { error?: string } | undefined;
        toast.error(body?.error || e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Network error — status unchanged");
      }
    } finally {
      setUpdating(false);
    }
  };

  // Resolve a delivered-with-issues DO: clear the hold and create the invoice
  // that was withheld. Same verified-save discipline as advanceStatus (this
  // creates an invoice + flips SO/DO to INVOICED — high-stakes billing write).
  const resolveIncomplete = async () => {
    if (!order) return;
    setUpdating(true);
    try {
      const result = await verifiedSave<DeliveryOrder>({
        endpoint: `/api/delivery-orders/${id}/resolve-incomplete`,
        method: "POST",
        body: {},
        readback: async () => {
          const r = await fetch(`/api/delivery-orders/${id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
          return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
        },
        expect: { deliveryIncomplete: false },
      });
      if (!result.ok) {
        if (result.reason === "mismatch") {
          toast.error(formatMismatchError(result.diffs));
        } else if (result.reason === "http") {
          let parsedErr = result.body;
          try {
            const j = JSON.parse(result.body) as { error?: string };
            if (j.error) parsedErr = j.error;
          } catch {
            /* keep raw body */
          }
          toast.error(parsedErr || `Failed to resolve (HTTP ${result.status})`);
        } else {
          toast.error(`Save failed: ${result.details}`);
        }
        return;
      }
      setOrder(result.data);
      if (id) invalidateCache(`/api/delivery-orders/${id}`);
      invalidateCachePrefix("/api/sales-orders");
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/production-orders");
      toast.success(
        result.data.status === "INVOICED"
          ? "Documents marked complete — invoice created."
          : "Documents marked complete.",
      );
    } catch (e) {
      if (e instanceof FetchJsonError) {
        const body = e.body as { error?: string } | undefined;
        toast.error(body?.error || e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Network error");
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleSubmitPOD = async (pod: ProofOfDelivery) => {
    if (!order) return;
    setUpdating(true);
    try {
      // If order is already DELIVERED, just attach proof; otherwise transition.
      const body: Record<string, unknown> = { proofOfDelivery: pod };
      if (order.status !== "DELIVERED") body.status = "DELIVERED";
      const expectStatus = order.status !== "DELIVERED" ? "DELIVERED" : order.status;
      // 2026-05-27 verifiedSave migration. POD attach gates final
      // delivery + downstream invoicing — must confirm both the status
      // and the proof actually landed (not just a green 200).
      const result = await verifiedSave<DeliveryOrder>({
        endpoint: `/api/delivery-orders/${id}`,
        method: "PUT",
        body,
        readback: async () => {
          const r = await fetch(`/api/delivery-orders/${id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
          return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
        },
        // Delivering auto-creates the invoice and bumps the DO to INVOICED, so
        // accept either when the POD transitions the DO to DELIVERED.
        expect: {
          status:
            expectStatus === "DELIVERED"
              ? ["DELIVERED", "INVOICED"]
              : expectStatus,
        },
      });
      if (!result.ok) {
        if (result.reason === "mismatch") {
          toast.error(formatMismatchError(result.diffs));
        } else if (result.reason === "http") {
          let parsedErr = result.body;
          try {
            const j = JSON.parse(result.body) as { error?: string };
            if (j.error) parsedErr = j.error;
          } catch {
            /* keep raw body */
          }
          toast.error(parsedErr || `Failed to save proof of delivery (HTTP ${result.status})`);
        } else {
          toast.error(`Save failed: ${result.details}`);
        }
        return;
      }
      setOrder(result.data);
      // POD save may also transition to DELIVERED which cascades to SO.
      if (id) invalidateCache(`/api/delivery-orders/${id}`);
      invalidateCachePrefix("/api/sales-orders");
      invalidateCachePrefix("/api/production-orders");
      setPodOpen(false);
    } catch (e) {
      if (e instanceof FetchJsonError) {
        const errBody = e.body as { error?: string } | undefined;
        toast.error(errBody?.error || e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Network error — POD not saved");
      }
    } finally {
      setUpdating(false);
    }
  };

  const assignLorry = async (lorryId: string) => {
    if (!order) return;
    setUpdating(true);
    try {
      // 2026-05-27 verifiedSave migration. Lorry assignment is what the
      // driver sees on the route sheet — a stale-cache false-success here
      // sends the wrong driver. Read back + compare.
      const result = await verifiedSave<DeliveryOrder>({
        endpoint: `/api/delivery-orders/${id}`,
        method: "PUT",
        body: { lorryId },
        readback: async () => {
          const r = await fetch(`/api/delivery-orders/${id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
          return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
        },
        expect: { lorryId },
      });
      if (!result.ok) {
        if (result.reason === "mismatch") {
          toast.error(formatMismatchError(result.diffs));
        } else if (result.reason === "http") {
          let parsedErr = result.body;
          try {
            const j = JSON.parse(result.body) as { error?: string };
            if (j.error) parsedErr = j.error;
          } catch {
            /* keep raw body */
          }
          toast.error(parsedErr || `Failed to assign lorry (HTTP ${result.status})`);
        } else {
          toast.error(`Failed to assign lorry: ${result.details}`);
        }
        return;
      }
      setOrder(result.data);
      // Lorry assignment only affects this DO; no cascade. Per-id only.
      if (id) invalidateCache(`/api/delivery-orders/${id}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "try again";
      toast.error(`Failed to assign lorry: ${detail}`);
      console.error(err);
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[#6B7280]">Loading delivery order...</div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-[#6B7280]">Delivery order not found</div>
        <Button variant="outline" onClick={() => navigate("/delivery")}>
          Back to Deliveries
        </Button>
      </div>
    );
  }

  const flow = STATUS_FLOW[order.status];
  const overdueDays = calculateOverdueDays(order.deliveryDate, order.deliveredAt);
  const currentLorry = lorries.find((l) => l.id === order.lorryId);
  // Cascade lock — surfaced from /api/delivery-orders/:id. Non-null when
  // an Invoice has been issued referencing this DO.
  const lockReason = (doResp as { lockReason?: string | null } | undefined)?.lockReason ?? null;
  // Returns raised against this DO — server-side reverse lookup, no list fetch.
  const linkedReturns: LinkedReturn[] = doResp?.linkedReturns ?? [];

  return (
    <div className="space-y-6 max-md:space-y-4">
      <LockBanner reason={lockReason} />
      <PresenceBanner holders={otherEditors} />
      <ObjectPageHeader
        backTo="/delivery"
        title={order.doNo}
        subtitle={`${order.customerName} · ${order.companySOId}`}
        badges={
          <>
            <Badge variant="status" status={order.status}>
              {STATUS_LABEL[order.status] || order.status.replace(/_/g, " ")}
            </Badge>
            {overdueDays > 0 && order.status !== "DELIVERED" && order.status !== "INVOICED" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#F9E1DA] border border-[#E8B2A1] px-2.5 py-0.5 text-xs font-medium text-[#9A3A2D]">
                <AlertTriangle className="h-3 w-3" />
                {overdueDays}d overdue
              </span>
            )}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setQrOpen(true)}>
              <QrCode className="h-4 w-4" /> QR
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const { downloadUnifiedDoPdf } = await import("@/lib/unified-doc-download");
                // Best-effort print enrichment (customerSO / customerRef /
                // bedframe build params). Never block the download.
                let extras: import("@/lib/generate-do-pdf").DOPrintExtras = {};
                try {
                  const r = await fetch(
                    `/api/delivery-orders/${encodeURIComponent(
                      (order as { id: string }).id,
                    )}/print-extras`,
                  );
                  const j = (await r.json()) as {
                    success?: boolean;
                    data?: import("@/lib/generate-do-pdf").DOPrintExtras;
                  };
                  if (j?.success && j.data) extras = j.data;
                } catch {
                  /* graceful — PDF still renders without extras */
                }
                await downloadUnifiedDoPdf(order, extras);
              }}
            >
              <Download className="h-4 w-4" /> Download DO PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const { generatePackingListPdf } = await import("@/lib/generate-packing-pdf");
                // Fetch the per-item print-extras so the rack column can show the
                // per-piece STACKED racks (HB: Rack 19 / Divan: Rack 19, 20).
                // Best-effort — the list still prints (flat rack) without them.
                let extras: import("@/lib/generate-do-pdf").DOPrintExtras = {};
                try {
                  const r = await fetch(
                    `/api/delivery-orders/${encodeURIComponent(
                      (order as { id: string }).id,
                    )}/print-extras`,
                  );
                  const j = (await r.json()) as {
                    success?: boolean;
                    data?: import("@/lib/generate-do-pdf").DOPrintExtras;
                  };
                  if (j?.success && j.data) extras = j.data;
                } catch {
                  /* graceful — packing list still renders without extras */
                }
                generatePackingListPdf(
                  order as unknown as import("@/types").DeliveryOrder,
                  extras,
                );
              }}
            >
              <ClipboardList className="h-4 w-4" /> Print Packing List
            </Button>
            {flow && (
              <Button variant="primary" size="sm" onClick={() => advanceStatus()} disabled={updating}>
                {flow.icon} {updating ? "Updating..." : flow.label}
              </Button>
            )}
            {/* A dispatched DO (LOADED) can be marked delivered directly, without
                the intermediate "In Transit" step — parity with the driver scan,
                which delivers straight from Dispatched. */}
            {order.status === "LOADED" && (
              <Button variant="outline" size="sm" onClick={() => advanceStatus("DELIVERED")} disabled={updating}>
                <CheckCircle2 className="h-4 w-4" /> Mark Delivered
              </Button>
            )}
            {order.status === "DELIVERED" && order.deliveryIncomplete && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => resolveIncomplete()}
                disabled={updating}
              >
                <CheckCircle2 className="h-4 w-4" />
                {updating ? "Updating..." : "Mark documents complete & invoice"}
              </Button>
            )}
            {order.status === "DELIVERED" && !order.deliveryIncomplete && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => advanceStatus("INVOICED")}
                disabled={updating}
              >
                <ReceiptText className="h-4 w-4" />
                {updating ? "Updating..." : "Convert to Invoice"}
              </Button>
            )}
            {(order.status === "DELIVERED" || order.status === "INVOICED") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/delivery-returns?createFrom=${order.id}`)}
                disabled={updating}
              >
                <Undo2 className="h-4 w-4" />
                Convert to Delivery Return
              </Button>
            )}
          </>
        }
      />

      {/* Delivered-with-issues hold — goods arrived but paperwork incomplete,
          invoice withheld until an operator resolves it. */}
      {order.status === "DELIVERED" && order.deliveryIncomplete && (
        <div className="flex items-start gap-3 rounded-lg border border-[#E8D3A1] bg-[#FBF1DF] px-4 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-[#9C6F1E] mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-[#7A5612]">
              Delivered with issues — invoice on hold
            </p>
            <p className="text-[#9C6F1E] mt-0.5">
              The goods were delivered but the paperwork was marked incomplete
              (e.g. damaged or returning items). The sales order and stock are
              updated, but no invoice has been created. Once the paperwork is
              sorted, click{" "}
              <span className="font-medium">
                “Mark documents complete &amp; invoice”
              </span>{" "}
              above to bill it.
            </p>
          </div>
        </div>
      )}

      {/* Info Cards */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        {/* Customer Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-[#6B5C32]" /> Customer Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <div>
                <p className="text-xs text-[#9CA3AF]">Customer Name</p>
                <p className="font-medium text-[#1F1D1B]">{order.customerName}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">State</p>
                <p className="font-medium text-[#4B5563]">{order.customerState}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-[#9CA3AF] flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Delivery Hub
                </p>
                <p className="font-medium text-[#1F1D1B]">
                  {order.hubName || "-"}
                  {order.hubName ? (
                    <span className="text-xs text-[#9CA3AF] font-normal">
                      {" "}(from {order.customerName})
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-[#9CA3AF] flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Delivery Address
                </p>
                <p className="font-medium text-[#4B5563]">{order.deliveryAddress}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Contact Person</p>
                <p className="font-medium text-[#4B5563]">{order.contactPerson}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF] flex items-center gap-1">
                  <Phone className="h-3 w-3" /> Phone
                </p>
                <p className="font-medium text-[#4B5563]">{order.contactPhone}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Delivery Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-4 w-4 text-[#6B5C32]" /> Delivery Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <div>
                <p className="text-xs text-[#9CA3AF]">Delivery Date</p>
                <p className="font-medium">{order.deliveryDate ? formatDate(order.deliveryDate) : "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Expected DD (Hookka)</p>
                <p className="font-medium">{order.hookkaExpectedDD ? formatDate(order.hookkaExpectedDD) : "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Driver</p>
                <p className="font-medium text-[#4B5563]">{order.driverName || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Vehicle No.</p>
                <p className="font-medium doc-number">{order.vehicleNo || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Dispatched At</p>
                <p className="font-medium">
                  {order.dispatchedAt ? formatDateTime(order.dispatchedAt) : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Delivered At</p>
                <p className="font-medium">
                  {order.deliveredAt ? formatDateTime(order.deliveredAt) : "-"}
                </p>
              </div>
            </div>
            {order.remarks && (
              <div className="mt-4 rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3">
                <p className="text-xs text-[#9CA3AF] mb-1">Remarks</p>
                <p className="text-sm text-[#4B5563]">{order.remarks}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Lorry Assignment & M3 Summary */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Box className="h-4 w-4 text-[#6B5C32]" /> Loading &amp; Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4 max-sm:grid-cols-1">
              <div>
                <p className="text-xs text-[#9CA3AF]">Total M&sup3;</p>
                <p className="text-xl font-bold text-[#1F1D1B]">{order.totalM3.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Total Items</p>
                <p className="text-xl font-bold text-[#1F1D1B]">{order.totalItems}</p>
              </div>
            </div>

            {/* Current lorry assignment */}
            <div className="rounded-md border border-[#E2DDD8] p-3 mb-3">
              <p className="text-xs text-[#9CA3AF] mb-2">Assigned Lorry</p>
              {currentLorry ? (
                <div>
                  <p className="font-medium text-[#1F1D1B]">{currentLorry.name}</p>
                  <p className="text-xs text-[#6B7280] doc-number">{currentLorry.plateNumber}</p>
                  <p className="text-xs text-[#6B7280]">{currentLorry.driverName} | {currentLorry.driverContact}</p>
                  <p className="text-xs text-[#9CA3AF] mt-1">
                    Capacity: {currentLorry.capacity} M&sup3;
                  </p>
                </div>
              ) : (
                <p className="text-sm text-[#9CA3AF]">No lorry assigned</p>
              )}
            </div>

            {/* Lorry selection (only for non-delivered orders) */}
            {(order.status === "DRAFT" || order.status === "LOADED") && (
              <div>
                <p className="text-xs text-[#9CA3AF] mb-2">Assign to Lorry</p>
                <div className="flex flex-wrap gap-2">
                  {lorries.map((lorry) => (
                    <Button
                      key={lorry.id}
                      variant={order.lorryId === lorry.id ? "primary" : "outline"}
                      size="sm"
                      className="text-xs"
                      onClick={() => assignLorry(lorry.id)}
                      disabled={updating}
                    >
                      <Truck className="h-3 w-3" />
                      {lorry.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Proof of Delivery */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-[#6B5C32]" /> Proof of Delivery
          </CardTitle>
        </CardHeader>
        <CardContent>
          {order.proofOfDelivery ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
                <div>
                  <p className="text-xs text-[#9CA3AF]">Receiver Name</p>
                  <p className="font-medium text-[#111827]">
                    {order.proofOfDelivery.receiverName}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#9CA3AF]">Receiver IC / ID</p>
                  <p className="font-medium text-[#4B5563]">
                    {order.proofOfDelivery.receiverIC || "-"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#9CA3AF]">Delivered At</p>
                  <p className="font-medium text-[#4B5563]">
                    {formatDateTime(order.proofOfDelivery.deliveredAt)}
                  </p>
                </div>
                {order.proofOfDelivery.capturedBy && (
                  <div>
                    <p className="text-xs text-[#9CA3AF]">Captured By</p>
                    <p className="font-medium text-[#4B5563]">
                      {order.proofOfDelivery.capturedBy}
                    </p>
                  </div>
                )}
              </div>

              {order.proofOfDelivery.remarks && (
                <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3">
                  <p className="text-xs text-[#9CA3AF] mb-1">Remarks</p>
                  <p className="text-sm text-[#4B5563]">
                    {order.proofOfDelivery.remarks}
                  </p>
                </div>
              )}

              {order.proofOfDelivery.signatureDataUrl && (
                <div>
                  <p className="text-xs text-[#9CA3AF] mb-1">Signature</p>
                  <div className="rounded-md border border-[#E2DDD8] bg-white inline-block p-2">
                    <img
                      src={order.proofOfDelivery.signatureDataUrl}
                      alt="Receiver signature"
                      className="max-h-32"
                    />
                  </div>
                </div>
              )}

              {order.proofOfDelivery.photoDataUrls.length > 0 && (
                <div>
                  <p className="text-xs text-[#9CA3AF] mb-1">
                    Photos ({order.proofOfDelivery.photoDataUrls.length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {order.proofOfDelivery.photoDataUrls.map((src, idx) => (
                      <img
                        key={idx}
                        src={src}
                        alt={`POD photo ${idx + 1}`}
                        className="w-32 h-32 object-cover rounded-md border border-[#E2DDD8]"
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-[#9CA3AF]">No proof captured yet</p>
              {(order.status === "DELIVERED" ||
                order.status === "IN_TRANSIT" ||
                order.status === "LOADED") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPodOpen(true)}
                >
                  <CheckCircle2 className="h-4 w-4" /> Capture POD
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Items Table with M3 and Racking */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Items ({order.items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-10 px-4 text-left font-medium text-[#374151] w-8">#</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">SO ID</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Product</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Size</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Fabric</th>
                  <th className="h-10 px-4 text-right font-medium text-[#374151]">Qty</th>
                  <th className="h-10 px-4 text-right font-medium text-[#374151]">Unit M&sup3;</th>
                  <th className="h-10 px-4 text-right font-medium text-[#374151]">Total M&sup3;</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Rack #</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Packing</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item, idx) => (
                  <tr key={item.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                    <td className="h-12 px-4 text-[#9CA3AF]">{idx + 1}</td>
                    {/* SO ID = our sales-order no. for this line (a DO can span
                        several SOs). The production-order no. stays below as a
                        small secondary ref. Was showing poNo under an "SO ID"
                        header — owner: "DO 要看到我們的 SO ID". */}
                    <td className="h-12 px-4">
                      <span className="doc-number font-medium">
                        {item.salesOrderNo || "-"}
                      </span>
                      {item.poNo ? (
                        <span className="block text-xs text-[#9CA3AF] doc-number">
                          {item.poNo}
                        </span>
                      ) : null}
                    </td>
                    <td className="h-12 px-4">
                      <p className="font-medium text-[#1F1D1B]">{item.productName}</p>
                      <p className="text-xs text-[#9CA3AF] doc-number">{item.productCode}</p>
                      <RepairPartsBadge repairScope={item.repairScope} productCode={item.productCode} />
                    </td>
                    <td className="h-12 px-4 text-[#4B5563]">{item.sizeLabel}</td>
                    <td className="h-12 px-4 text-[#4B5563]">{item.fabricCode}</td>
                    <td className="h-12 px-4 text-right font-medium">{item.quantity}</td>
                    <td className="h-12 px-4 text-right">{item.itemM3.toFixed(2)}</td>
                    <td className="h-12 px-4 text-right font-medium">
                      {(item.itemM3 * item.quantity).toFixed(2)}
                    </td>
                    <td className="h-12 px-4">
                      {item.rackingNumber ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-[#FAEFCB] border border-[#E8D597] px-2 py-0.5 text-xs font-bold text-[#9C6F1E] doc-number">
                          <MapPinned className="h-3 w-3" />
                          {item.rackingNumber}
                        </span>
                      ) : (
                        <span className="text-[#9CA3AF]">-</span>
                      )}
                    </td>
                    <td className="h-12 px-4">
                      <Badge
                        variant="status"
                        status={item.packingStatus === "PACKED" ? "COMPLETED" : "PENDING"}
                      >
                        {item.packingStatus}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]">
                  <td colSpan={5} className="px-4 py-3 text-right font-semibold text-[#374151]">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-bold">
                    {order.items.reduce((s, i) => s + i.quantity, 0)}
                  </td>
                  <td className="px-4 py-3 text-right text-[#9CA3AF]">-</td>
                  <td className="px-4 py-3 text-right font-bold">
                    {order.items.reduce((s, i) => s + i.itemM3 * i.quantity, 0).toFixed(2)}
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Delivery Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Delivery Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-0 overflow-x-auto">
            {ALL_STATUSES.map((status, i, arr) => {
              const isActive = status === order.status;
              const isPast = arr.indexOf(order.status) > i;
              const statusIdx = arr.indexOf(order.status);

              let stepDate = "";
              if (status === "DRAFT" && (isPast || isActive)) {
                stepDate = order.deliveryDate ? formatDate(order.deliveryDate) : "Created";
              } else if (status === "LOADED" && (isPast || isActive) && statusIdx >= 1) {
                stepDate = order.dispatchedAt ? formatDateTime(order.dispatchedAt) : "Loaded";
              } else if (status === "IN_TRANSIT" && (isPast || isActive) && statusIdx >= 2) {
                stepDate = order.dispatchedAt ? formatDateTime(order.dispatchedAt) : "Dispatched";
              } else if (status === "DELIVERED" && (isPast || isActive) && statusIdx >= 3) {
                stepDate = order.deliveredAt ? formatDateTime(order.deliveredAt) : "Delivered";
              } else if (status === "INVOICED" && isActive) {
                stepDate = "Invoiced";
              }

              return (
                <div key={status} className="flex items-center">
                  <div className="flex flex-col items-center min-w-[100px]">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                        isActive
                          ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                          : isPast
                          ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]"
                          : "bg-gray-50 text-gray-400 border-gray-200"
                      }`}
                    >
                      {isPast ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        i + 1
                      )}
                    </div>
                    <p
                      className={`text-xs font-medium mt-1.5 whitespace-nowrap ${
                        isActive
                          ? "text-[#6B5C32]"
                          : isPast
                          ? "text-[#4F7C3A]"
                          : "text-gray-400"
                      }`}
                    >
                      {STATUS_LABEL[status] || status.replace(/_/g, " ")}
                    </p>
                    {stepDate && (
                      <p className="text-[10px] text-[#9CA3AF] mt-0.5 whitespace-nowrap">
                        {stepDate}
                      </p>
                    )}
                  </div>
                  {i < arr.length - 1 && (
                    <div
                      className={`h-0.5 w-8 mt-[-16px] ${
                        isPast ? "bg-[#4F7C3A]" : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Delivery Returns raised against this DO. Rendered only when there are
          any — a return means goods came back off this delivery (stock
          reversed, plus either a credit note or a repair service order), which
          this page previously never mentioned. */}
      {linkedReturns.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Undo2 className="h-4 w-4 text-[#9A3A2D]" />
              Delivery Returns ({linkedReturns.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {linkedReturns.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 border border-[#E2DDD8] rounded-md px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => navigate(`/delivery-returns/${r.id}`)}
                      className="text-sm font-medium text-[#6B5C32] hover:underline"
                    >
                      {r.returnNo || r.id}
                    </button>
                    <Badge variant="status" status={r.status}>
                      {r.status.replace(/_/g, " ")}
                    </Badge>
                    {r.returnType && (
                      <span className="text-xs text-[#6B7280]">
                        {r.returnType.replace(/_/g, " ")}
                      </span>
                    )}
                    {r.reason && (
                      <span className="text-xs text-[#9CA3AF] truncate">{r.reason}</span>
                    )}
                  </div>
                  <span className="text-xs text-[#9CA3AF]">
                    {r.returnedAt
                      ? formatDateTime(r.returnedAt)
                      : r.createdAt
                      ? formatDate(r.createdAt)
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Document Relationship — the same chain graph as the SO page, so you
          can see how THIS delivery order connects to its SO / invoice / payment
          right from here. */}
      {(() => {
        // Anchor the chain on this DO's SO. Many DOs are consolidated (no
        // salesOrderId/companySOId on the header) — fall back to the first
        // line's SO number, which /api/sales-orders/:id now resolves.
        const anchor =
          order?.salesOrderId ||
          order?.companySOId ||
          order?.items?.find((i) => i.salesOrderNo)?.salesOrderNo ||
          "";
        return anchor ? (
          <SoDocumentRelationship soId={anchor} currentDocNo={order.doNo} />
        ) : null;
      })()}

      {/* POD Capture Dialog */}
      <PODDialog
        open={podOpen}
        doNo={order.doNo}
        customerName={order.customerName}
        onClose={() => setPodOpen(false)}
        onSubmit={handleSubmitPOD}
      />

      {/* Delivery-status QR (driver scan → /d/<token>, no login) */}
      <DoQrDialog
        open={qrOpen}
        kind="DO"
        recordId={order.id}
        docNo={order.doNo}
        onClose={() => setQrOpen(false)}
      />
    </div>
  );
}
