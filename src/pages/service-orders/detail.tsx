// ---------------------------------------------------------------------------
// Service Order detail — header, lines, returns, and actions to advance
// the lifecycle (status transitions) or log a returned defective unit.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  PackageOpen,
  Wrench,
  Truck,
  Plus,
  X,
} from "lucide-react";

type Status =
  | "OPEN"
  | "IN_PRODUCTION"
  | "RESERVED"
  | "IN_REPAIR"
  | "READY_TO_SHIP"
  | "DELIVERED"
  | "CLOSED"
  | "CANCELLED";

type ServiceOrderDetail = {
  id: string;
  serviceOrderNo: string;
  sourceType: "SO" | "CO";
  sourceId: string;
  sourceNo: string;
  customerId: string;
  customerName: string;
  mode: "REPRODUCE" | "STOCK_SWAP" | "REPAIR";
  status: Status;
  issueDescription: string;
  issuePhotos: string[];
  createdBy: string;
  createdByName: string;
  createdAt: string;
  closedAt: string;
  notes: string;
  lines: Array<{
    id: string;
    serviceOrderId: string;
    sourceLineId: string;
    productId: string;
    productCode: string;
    productName: string;
    qty: number;
    issueSummary: string;
    resolutionProductionOrderId: string;
    resolutionFgBatchId: string;
  }>;
  returns: Array<{
    id: string;
    serviceOrderLineId: string;
    productId: string;
    productCode: string;
    receivedAt: string;
    receivedBy: string;
    receivedByName: string;
    condition: "PENDING_DECISION" | "REPAIRABLE" | "SCRAPPED";
    repairNotes: string;
    repairedAt: string;
    repairedBy: string;
    repairedByName: string;
    scrappedViaAdjustmentId: string;
    notes: string;
    createdAt: string;
  }>;
};

const STATUS_COLOR: Record<string, string> = {
  OPEN: "bg-[#F4EFE3] text-[#6B5C32]",
  IN_PRODUCTION: "bg-[#E2EFE0] text-[#3A6B47]",
  RESERVED: "bg-[#E0EAF4] text-[#3A5670]",
  IN_REPAIR: "bg-[#F4ECE0] text-[#6B5232]",
  READY_TO_SHIP: "bg-[#DCF0F4] text-[#326B6E]",
  DELIVERED: "bg-[#DCEFDA] text-[#3A7A47]",
  CLOSED: "bg-[#E2DDD8] text-[#5A5550]",
  CANCELLED: "bg-[#F5DCDC] text-[#7A2E24]",
};

// Adjacency table mirroring the backend STATUS_TRANSITIONS — used to drive
// the action buttons on this page. Backend re-validates on every PUT.
const STATUS_TRANSITIONS: Record<Status, Status[]> = {
  OPEN: ["IN_PRODUCTION", "RESERVED", "IN_REPAIR", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "CANCELLED"],
  RESERVED: ["READY_TO_SHIP", "CANCELLED"],
  IN_REPAIR: ["READY_TO_SHIP", "CANCELLED"],
  READY_TO_SHIP: ["DELIVERED"],
  DELIVERED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ServiceOrderDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { toast } = useToast();
  const user = getCurrentUser();

  const { data: resp, refresh } = useCachedJson<{ data?: ServiceOrderDetail }>(
    `/api/service-orders/${id}`,
  );
  const order = resp?.data;
  const [returnOpen, setReturnOpen] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  const allowedTransitions = useMemo(
    () => (order ? STATUS_TRANSITIONS[order.status] ?? [] : []),
    [order],
  );

  if (!order) {
    return (
      <div className="space-y-4">
        <Link
          to="/service-orders"
          className="text-sm text-[#6B5C32] hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Service Orders
        </Link>
        <p className="text-sm text-[#9CA3AF]">Loading…</p>
      </div>
    );
  }

  async function advanceStatus(next: Status) {
    setAdvancing(true);
    try {
      const res = await fetch(`/api/service-orders/${id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      invalidateCachePrefix("/api/service-orders");
      refresh();
      toast.success(`Status → ${next}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setAdvancing(false);
    }
  }

  // Source order back-link — clicking SVC source navigates to the SO/CO
  // detail page so the user can verify the original order context.
  const sourceHref =
    order.sourceType === "SO"
      ? `/sales/${order.sourceId}`
      : `/consignment/${order.sourceId}`;

  return (
    <div className="space-y-4">
      <Link
        to="/service-orders"
        className="text-sm text-[#6B5C32] hover:underline inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Service Orders
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B] font-mono">
              {order.serviceOrderNo}
            </h1>
            <span
              className={`text-[10px] uppercase px-2 py-0.5 rounded ${STATUS_COLOR[order.status] ?? "bg-[#F4EFE3]"}`}
            >
              {order.status}
            </span>
            <Badge>{order.mode}</Badge>
          </div>
          <p className="text-xs text-[#6B7280] mt-1">
            Customer: <span className="font-medium">{order.customerName}</span>{" "}
            · Source:{" "}
            <Link to={sourceHref} className="text-[#6B5C32] hover:underline">
              {order.sourceType} {order.sourceNo || order.sourceId}
            </Link>
            {order.createdAt ? ` · Created ${dateLabel(order.createdAt)}` : ""}
            {order.createdByName ? ` by ${order.createdByName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Status advancement buttons — driven by adjacency. */}
          {allowedTransitions.includes("READY_TO_SHIP") && (
            <Button
              variant="primary"
              size="sm"
              disabled={advancing}
              onClick={() => advanceStatus("READY_TO_SHIP")}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              <Truck className="h-4 w-4" /> Mark Ready to Ship
            </Button>
          )}
          {allowedTransitions.includes("DELIVERED") && (
            <Button
              variant="primary"
              size="sm"
              disabled={advancing}
              onClick={() => advanceStatus("DELIVERED")}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              <CheckCircle2 className="h-4 w-4" /> Mark Delivered
            </Button>
          )}
          {allowedTransitions.includes("CLOSED") && (
            <Button
              variant="primary"
              size="sm"
              disabled={advancing}
              onClick={() => advanceStatus("CLOSED")}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              <CheckCircle2 className="h-4 w-4" /> Close
            </Button>
          )}
          {allowedTransitions.includes("CANCELLED") && (
            <Button
              variant="outline"
              size="sm"
              disabled={advancing}
              className="text-[#9A3A2D] hover:text-[#7A2E24]"
              onClick={() => advanceStatus("CANCELLED")}
            >
              <XCircle className="h-4 w-4" /> Cancel
            </Button>
          )}
          {/* Return logging — REPAIR mode primarily, but the user can log a
              return for any mode (the customer's defective unit might come
              back even for REPRODUCE/STOCK_SWAP). */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReturnOpen(true)}
            disabled={order.status === "CANCELLED" || order.status === "CLOSED"}
          >
            <PackageOpen className="h-4 w-4" /> Log Return
          </Button>
        </div>
      </div>

      {/* Issue description */}
      {(order.issueDescription || order.issuePhotos.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Customer Issue</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[#1F1D1B]">
            {order.issueDescription && (
              <p className="whitespace-pre-line">{order.issueDescription}</p>
            )}
            {order.issuePhotos.length > 0 && (
              <ul className="mt-2 space-y-1">
                {order.issuePhotos.map((p, i) => (
                  <li key={i} className="text-xs">
                    <a
                      href={p}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#6B5C32] hover:underline"
                    >
                      Photo {i + 1}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Lines */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Affected Items ({order.lines.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left text-xs uppercase text-[#6B7280]">
                  <th className="py-2 px-2">Product</th>
                  <th className="py-2 px-2 text-right">Qty</th>
                  <th className="py-2 px-2">Issue</th>
                  <th className="py-2 px-2">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l) => (
                  <tr key={l.id} className="border-b border-[#F0ECE9]">
                    <td className="py-2 px-2">
                      <div className="font-mono text-xs font-medium text-[#1F1D1B]">
                        {l.productCode}
                      </div>
                      <div className="text-xs text-[#9CA3AF]">{l.productName}</div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-xs">
                      {l.qty}
                    </td>
                    <td className="py-2 px-2 text-xs text-[#5A5550]">
                      {l.issueSummary || "—"}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {l.resolutionProductionOrderId && (
                        <span>
                          PO:{" "}
                          <span className="font-mono">
                            {l.resolutionProductionOrderId}
                          </span>
                        </span>
                      )}
                      {l.resolutionFgBatchId && (
                        <span>
                          FG:{" "}
                          <span className="font-mono">
                            {l.resolutionFgBatchId}
                          </span>
                        </span>
                      )}
                      {!l.resolutionProductionOrderId &&
                        !l.resolutionFgBatchId &&
                        "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Returns */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">
              Defective Unit Returns ({order.returns.length})
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReturnOpen(true)}
              disabled={
                order.status === "CANCELLED" || order.status === "CLOSED"
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {order.returns.length === 0 ? (
            <p className="text-xs text-[#9CA3AF] py-4 text-center">
              No returns logged yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-left text-xs uppercase text-[#6B7280]">
                    <th className="py-2 px-2">Received</th>
                    <th className="py-2 px-2">Product</th>
                    <th className="py-2 px-2">Condition</th>
                    <th className="py-2 px-2">By</th>
                    <th className="py-2 px-2">Notes</th>
                    <th className="py-2 px-2 w-[140px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {order.returns.map((r) => (
                    <ReturnRow
                      key={r.id}
                      svcId={order.id}
                      ret={r}
                      onChanged={refresh}
                      currentUserId={user?.id ?? ""}
                      currentUserName={user?.displayName ?? user?.email ?? ""}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-[#9CA3AF] mt-2">
            For SCRAPPED units, create a Stock Adjustment (reason: WRITE_OFF)
            via{" "}
            <Link
              to="/inventory/adjustments"
              className="text-[#6B5C32] hover:underline"
            >
              Inventory &gt; Adjustments
            </Link>{" "}
            and paste the adjustment id below.
          </p>
        </CardContent>
      </Card>

      {/* Notes */}
      {order.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-line">
            {order.notes}
          </CardContent>
        </Card>
      )}

      {returnOpen && (
        <LogReturnModal
          svcId={order.id}
          lines={order.lines}
          onClose={() => setReturnOpen(false)}
          onLogged={() => {
            setReturnOpen(false);
            invalidateCachePrefix("/api/service-orders");
            refresh();
            toast.success("Return logged");
          }}
        />
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-row "Mark Repaired" / "Mark Scrapped" controls. Inline editor so the
// user doesn't need a separate page for the common case.
// ---------------------------------------------------------------------------
function ReturnRow({
  svcId,
  ret,
  onChanged,
  currentUserId,
  currentUserName,
}: {
  svcId: string;
  ret: ServiceOrderDetail["returns"][number];
  onChanged: () => void;
  currentUserId: string;
  currentUserName: string;
}) {
  const { toast } = useToast();
  const [scrapAdjId, setScrapAdjId] = useState(ret.scrappedViaAdjustmentId);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/service-orders/${svcId}/returns/${ret.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
      setEditing(false);
    }
  }

  return (
    <tr className="border-b border-[#F0ECE9]">
      <td className="py-2 px-2 text-xs whitespace-nowrap">
        {dateLabel(ret.receivedAt)}
      </td>
      <td className="py-2 px-2 text-xs">
        {ret.productCode || "—"}
      </td>
      <td className="py-2 px-2">
        <Badge>{ret.condition}</Badge>
        {ret.condition === "REPAIRABLE" && ret.repairedAt && (
          <div className="text-[10px] text-[#6B7280] mt-0.5">
            Repaired {dateLabel(ret.repairedAt)}
            {ret.repairedByName ? ` by ${ret.repairedByName}` : ""}
          </div>
        )}
        {ret.condition === "SCRAPPED" && ret.scrappedViaAdjustmentId && (
          <div className="text-[10px] text-[#6B7280] mt-0.5 font-mono">
            adj: {ret.scrappedViaAdjustmentId}
          </div>
        )}
      </td>
      <td className="py-2 px-2 text-xs text-[#6B7280]">
        {ret.receivedByName || "—"}
      </td>
      <td className="py-2 px-2 text-xs text-[#6B7280]">
        {editing && ret.condition === "PENDING_DECISION" ? (
          <Input
            type="text"
            value={scrapAdjId}
            onChange={(e) => setScrapAdjId(e.target.value)}
            placeholder="adj-xxxxxxxx (for SCRAPPED)"
            className="h-7 text-xs px-2"
          />
        ) : (
          ret.notes || "—"
        )}
      </td>
      <td className="py-2 px-2 text-right">
        {ret.condition === "PENDING_DECISION" && !editing && (
          <div className="flex gap-1 justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                patch({
                  condition: "REPAIRABLE",
                  repairedAt: new Date().toISOString(),
                  repairedBy: currentUserId,
                  repairedByName: currentUserName,
                })
              }
              className="text-xs text-[#3A6B47] hover:underline"
            >
              <Wrench className="h-3 w-3 inline" /> Repaired
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
              className="text-xs text-[#9A3A2D] hover:underline"
            >
              Scrap…
            </button>
          </div>
        )}
        {editing && (
          <div className="flex gap-1 justify-end">
            <button
              type="button"
              disabled={busy || !scrapAdjId}
              onClick={() =>
                patch({
                  condition: "SCRAPPED",
                  scrappedViaAdjustmentId: scrapAdjId,
                })
              }
              className="text-xs text-[#9A3A2D] hover:underline disabled:text-[#E2DDD8]"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-[#6B7280] hover:underline"
            >
              <X className="h-3 w-3 inline" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Modal: log a defective unit returned to the factory.
// ---------------------------------------------------------------------------
function LogReturnModal({
  svcId,
  lines,
  onClose,
  onLogged,
}: {
  svcId: string;
  lines: ServiceOrderDetail["lines"];
  onClose: () => void;
  onLogged: () => void;
}) {
  const { toast } = useToast();
  const user = getCurrentUser();
  const [serviceOrderLineId, setServiceOrderLineId] = useState(lines[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const line = lines.find((l) => l.id === serviceOrderLineId);
      const res = await fetch(`/api/service-orders/${svcId}/returns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceOrderLineId: serviceOrderLineId || null,
          productId: line?.productId ?? null,
          productCode: line?.productCode ?? null,
          condition: "PENDING_DECISION",
          notes: notes || null,
          receivedBy: user?.id ?? null,
          receivedByName: user?.displayName ?? user?.email ?? null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      onLogged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-lg mx-4 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">
            Log Defective Unit Return
          </h3>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div>
          <label className="block text-xs text-[#6B7280] mb-1">
            Which line?
          </label>
          <select
            value={serviceOrderLineId}
            onChange={(e) => setServiceOrderLineId(e.target.value)}
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
          >
            <option value="">(unspecified)</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.productCode} — {l.productName} (x{l.qty})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[#6B7280] mb-1">Notes</label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Condition observations, packaging state, etc."
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
          />
        </div>
        <div className="text-[11px] text-[#6B7280] bg-[#FAF9F7] border border-[#E2DDD8] rounded p-2">
          The unit will land as PENDING_DECISION. After inspection, mark it
          REPAIRABLE (and record the repair) or SCRAPPED (and link to a
          stock adjustment).
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {submitting ? "Logging…" : "Log Return"}
          </Button>
        </div>
      </div>
    </div>
  );
}
