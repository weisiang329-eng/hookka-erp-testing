// ---------------------------------------------------------------------------
// Service Orders (换货服务) — list + create.
//
// Phase 3 module: customer-reported defect on a SHIPPED Sales/Consignment
// order. The list view is filterable by status; the "New Service Order"
// modal lets the user pick a SHIPPED source order, choose a resolution
// mode (REPRODUCE / STOCK_SWAP / REPAIR), select line items, and submit.
//
// The backend validates the source-order shipped status — the UI mirror
// is a UX nicety; the truth lives in the API.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";
import { Plus, X, AlertCircle } from "lucide-react";

// SO-only set; CO has the additional consignment-specific terminal states.
// Kept aligned with the backend SHIPPED_STATUSES_SO / SHIPPED_STATUSES_CO
// constants in routes/service-orders.ts.
const SHIPPED_STATUSES_SO = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED"];
const SHIPPED_STATUSES_CO = [
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "PARTIALLY_SOLD",
  "FULLY_SOLD",
];

type ServiceOrderListItem = {
  id: string;
  serviceOrderNo: string;
  sourceType: "SO" | "CO";
  sourceId: string;
  sourceNo: string;
  customerId: string;
  customerName: string;
  mode: "REPRODUCE" | "STOCK_SWAP" | "REPAIR";
  status: string;
  issueDescription: string;
  createdAt: string;
  closedAt: string;
  lines: Array<{ id: string; productCode: string; productName: string; qty: number }>;
  returns: Array<{ id: string; condition: string }>;
};

type SourceOrderOption = {
  id: string;
  customerName: string;
  status: string;
  companyOrderId: string;
  items: Array<{
    id: string;
    productId: string;
    productCode: string;
    productName: string;
    quantity: number;
  }>;
};

type SalesOrderApi = {
  id: string;
  customerName: string;
  status: string;
  companySOId?: string;
  items?: Array<{ id: string; productId: string; productCode: string; productName: string; quantity: number }>;
};
type ConsignmentOrderApi = {
  id: string;
  customerName: string;
  status: string;
  companyCOId?: string;
  items?: Array<{ id: string; productId: string; productCode: string; productName: string; quantity: number }>;
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

function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export default function ServiceOrdersListPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);

  const url = statusFilter
    ? `/api/service-orders?status=${encodeURIComponent(statusFilter)}`
    : "/api/service-orders";
  const { data: listResp, refresh } = useCachedJson<{
    data?: ServiceOrderListItem[];
  }>(url);

  const orders = useMemo(() => listResp?.data ?? [], [listResp]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Service Orders</h1>
          <p className="text-xs text-[#6B7280]">
            换货服务 — customer-reported defects on shipped Sales / Consignment
            orders. Three resolution modes: REPRODUCE (new PO), STOCK_SWAP
            (pull from FG), REPAIR (fix returned unit).
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
        >
          <Plus className="h-4 w-4" /> New Service Order
        </Button>
      </div>

      {/* status tabs */}
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2 text-xs">
            {[
              "",
              "OPEN",
              "IN_PRODUCTION",
              "RESERVED",
              "IN_REPAIR",
              "READY_TO_SHIP",
              "DELIVERED",
              "CLOSED",
              "CANCELLED",
            ].map((s) => (
              <button
                key={s || "all"}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded border ${
                  statusFilter === s
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "border-[#E2DDD8] text-[#5A5550] hover:bg-[#F4EFE3]"
                }`}
              >
                {s || "All"}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>
            {orders.length} {orders.length === 1 ? "order" : "orders"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-8 text-center">
              No service orders {statusFilter ? `in status ${statusFilter}` : "yet"}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-left text-xs uppercase text-[#6B7280]">
                    <th className="py-2 px-2">SVC No</th>
                    <th className="py-2 px-2">Source</th>
                    <th className="py-2 px-2">Customer</th>
                    <th className="py-2 px-2">Mode</th>
                    <th className="py-2 px-2">Status</th>
                    <th className="py-2 px-2 text-right">Lines</th>
                    <th className="py-2 px-2 text-right">Returns</th>
                    <th className="py-2 px-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => navigate(`/service-orders/${o.id}`)}
                      className="border-b border-[#F0ECE9] hover:bg-[#FAF9F7] cursor-pointer"
                    >
                      <td className="py-2 px-2 font-mono text-xs font-medium text-[#1F1D1B]">
                        {o.serviceOrderNo}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        <Badge>{o.sourceType}</Badge>{" "}
                        <span className="text-[#5A5550]">{o.sourceNo || "—"}</span>
                      </td>
                      <td className="py-2 px-2">{o.customerName}</td>
                      <td className="py-2 px-2 text-xs">{o.mode}</td>
                      <td className="py-2 px-2">
                        <span
                          className={`text-[10px] uppercase px-2 py-0.5 rounded ${STATUS_COLOR[o.status] ?? "bg-[#F4EFE3]"}`}
                        >
                          {o.status}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {o.lines.length}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {o.returns.length}
                      </td>
                      <td className="py-2 px-2 text-xs text-[#6B7280]">
                        {dateLabel(o.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <CreateServiceOrderModal
          onClose={() => setCreateOpen(false)}
          onCreated={(newId) => {
            setCreateOpen(false);
            invalidateCachePrefix("/api/service-orders");
            refresh();
            toast.success("Service order created");
            navigate(`/service-orders/${newId}`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create modal — pick source, mode, lines, describe issue.
// ---------------------------------------------------------------------------
function CreateServiceOrderModal({
  onClose,
  onCreated,
  presetSourceType,
  presetSourceId,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  presetSourceType?: "SO" | "CO";
  presetSourceId?: string;
}) {
  const { toast } = useToast();
  const user = getCurrentUser();

  const [sourceType, setSourceType] = useState<"SO" | "CO">(
    presetSourceType ?? "SO",
  );
  const [sourceId, setSourceId] = useState<string>(presetSourceId ?? "");
  const [mode, setMode] = useState<"REPRODUCE" | "STOCK_SWAP" | "REPAIR">(
    "REPRODUCE",
  );
  const [issueDescription, setIssueDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Per-line state. Map of sourceLineId → { qty, issueSummary, fgBatchId }
  const [linePicks, setLinePicks] = useState<
    Record<string, { qty: string; issue: string; fgBatchId: string }>
  >({});

  // List of shipped SO/CO orders to choose from.
  const { data: soResp } = useCachedJson<{ data?: SalesOrderApi[] }>(
    "/api/sales-orders",
  );
  const { data: coResp } = useCachedJson<{ data?: ConsignmentOrderApi[] }>(
    "/api/consignment-orders",
  );
  const { data: invResp } = useCachedJson<{
    data?: {
      finishedProducts?: Array<{
        id: string;
        code: string;
        name: string;
        stockQty?: number;
      }>;
    };
  }>("/api/inventory");

  const sourceOptions: SourceOrderOption[] = useMemo(() => {
    if (sourceType === "SO") {
      return (soResp?.data ?? [])
        .filter((s) => SHIPPED_STATUSES_SO.includes(s.status))
        .map((s) => ({
          id: s.id,
          customerName: s.customerName,
          status: s.status,
          companyOrderId: s.companySOId ?? "",
          items: s.items ?? [],
        }));
    }
    return (coResp?.data ?? [])
      .filter((s) => SHIPPED_STATUSES_CO.includes(s.status))
      .map((s) => ({
        id: s.id,
        customerName: s.customerName,
        status: s.status,
        companyOrderId: s.companyCOId ?? "",
        items: s.items ?? [],
      }));
  }, [sourceType, soResp, coResp]);

  const fgList = useMemo(() => invResp?.data?.finishedProducts ?? [], [invResp]);

  const selectedSource = sourceOptions.find((s) => s.id === sourceId);
  const sourceItems = selectedSource?.items ?? [];

  function togglePickLine(itemId: string, on: boolean) {
    setLinePicks((prev) => {
      const copy = { ...prev };
      if (on) copy[itemId] = copy[itemId] ?? { qty: "1", issue: "", fgBatchId: "" };
      else delete copy[itemId];
      return copy;
    });
  }
  function patchPick(
    itemId: string,
    p: Partial<{ qty: string; issue: string; fgBatchId: string }>,
  ) {
    setLinePicks((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...p } }));
  }

  const pickedIds = Object.keys(linePicks);
  const canSubmit =
    !!sourceId &&
    pickedIds.length > 0 &&
    pickedIds.every((id) => {
      const pick = linePicks[id];
      const qtyOk = Number(pick.qty) > 0;
      if (mode === "STOCK_SWAP" && !pick.fgBatchId) return false;
      return qtyOk;
    });

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const lines = pickedIds.map((id) => {
        const pick = linePicks[id];
        const item = sourceItems.find((x) => x.id === id);
        return {
          sourceLineId: id,
          productId: item?.productId,
          productCode: item?.productCode,
          productName: item?.productName,
          qty: Number(pick.qty) || 1,
          issueSummary: pick.issue || null,
          ...(mode === "STOCK_SWAP" ? { resolutionFgBatchId: pick.fgBatchId } : {}),
        };
      });
      const res = await fetch("/api/service-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceId,
          mode,
          issueDescription,
          lines,
          createdBy: user?.id ?? null,
          createdByName: user?.displayName ?? user?.email ?? null,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: { id: string };
      };
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      onCreated(data.data!.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-[#E2DDD8]">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">
            New Service Order
          </h3>
          <button
            onClick={onClose}
            className="text-[#9CA3AF] hover:text-[#374151]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* Source picker */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Source Order Type
              </label>
              <select
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value as "SO" | "CO");
                  setSourceId("");
                  setLinePicks({});
                }}
                disabled={!!presetSourceType}
                className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
              >
                <option value="SO">Sales Order</option>
                <option value="CO">Consignment Order</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Source Order (only shipped shown)
              </label>
              <select
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setLinePicks({});
                }}
                disabled={!!presetSourceId}
                className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
              >
                <option value="">Select…</option>
                {sourceOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.companyOrderId} — {s.customerName} ({s.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Mode */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Resolution Mode
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { v: "REPRODUCE", t: "Reproduce", d: "Open new PO; ship when ready" },
                  { v: "STOCK_SWAP", t: "Stock Swap", d: "Pull from FG, ship now" },
                  { v: "REPAIR", t: "Repair", d: "Customer returns; we fix" },
                ] as const
              ).map((m) => (
                <button
                  key={m.v}
                  type="button"
                  onClick={() => setMode(m.v)}
                  className={`text-left rounded border p-3 text-xs ${
                    mode === m.v
                      ? "border-[#6B5C32] bg-[#F4EFE3]"
                      : "border-[#E2DDD8] hover:bg-[#FAF9F7]"
                  }`}
                >
                  <div className="font-medium text-[#1F1D1B]">{m.t}</div>
                  <div className="text-[10px] text-[#6B7280]">{m.d}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Issue description */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Issue Description
            </label>
            <textarea
              rows={3}
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
              placeholder="What did the customer report?"
              className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            />
          </div>

          {/* Line picker */}
          {selectedSource && (
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Affected Items ({pickedIds.length} picked)
              </label>
              {sourceItems.length === 0 ? (
                <p className="text-xs text-[#9CA3AF]">
                  No items found on this source order.
                </p>
              ) : (
                <div className="border border-[#E2DDD8] rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-[#FAF9F7]">
                      <tr className="text-left text-[10px] uppercase text-[#6B7280]">
                        <th className="p-2 w-[30px]"></th>
                        <th className="p-2">Product</th>
                        <th className="p-2 w-[60px] text-right">Orig Qty</th>
                        <th className="p-2 w-[80px]">Defect Qty</th>
                        <th className="p-2">Issue</th>
                        {mode === "STOCK_SWAP" && (
                          <th className="p-2 w-[200px]">FG Batch</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sourceItems.map((it) => {
                        const picked = !!linePicks[it.id];
                        const pick = linePicks[it.id];
                        return (
                          <tr key={it.id} className="border-t border-[#F0ECE9]">
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={picked}
                                onChange={(e) =>
                                  togglePickLine(it.id, e.target.checked)
                                }
                              />
                            </td>
                            <td className="p-2">
                              <div className="font-mono text-xs">
                                {it.productCode}
                              </div>
                              <div className="text-[10px] text-[#6B7280]">
                                {it.productName}
                              </div>
                            </td>
                            <td className="p-2 text-right font-mono">
                              {it.quantity}
                            </td>
                            <td className="p-2">
                              <Input
                                type="number"
                                min="1"
                                max={it.quantity}
                                value={pick?.qty ?? ""}
                                onChange={(e) =>
                                  patchPick(it.id, { qty: e.target.value })
                                }
                                disabled={!picked}
                                className="h-7 text-xs px-2"
                              />
                            </td>
                            <td className="p-2">
                              <Input
                                type="text"
                                value={pick?.issue ?? ""}
                                onChange={(e) =>
                                  patchPick(it.id, { issue: e.target.value })
                                }
                                disabled={!picked}
                                placeholder="optional"
                                className="h-7 text-xs px-2"
                              />
                            </td>
                            {mode === "STOCK_SWAP" && (
                              <td className="p-2">
                                <select
                                  value={pick?.fgBatchId ?? ""}
                                  onChange={(e) =>
                                    patchPick(it.id, { fgBatchId: e.target.value })
                                  }
                                  disabled={!picked}
                                  className="w-full rounded border border-[#E2DDD8] bg-white px-1.5 py-1 text-[11px]"
                                >
                                  <option value="">Select FG…</option>
                                  {fgList
                                    .filter((f) => f.id === it.productId || !it.productId)
                                    .map((f) => (
                                      <option key={f.id} value={f.id}>
                                        {f.code} ({f.stockQty ?? 0} on hand)
                                      </option>
                                    ))}
                                </select>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {mode === "STOCK_SWAP" && pickedIds.length > 0 && (
            <div className="flex items-start gap-2 text-xs text-[#6B5232] bg-[#F4ECE0] border border-[#E8D8B2] rounded p-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <p>
                Stock Swap will decrement the picked FG batch's remaining qty
                immediately. The customer keeps the defective unit; you'll
                record the return separately when it arrives.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[#E2DDD8] bg-[#FAF9F7]">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {submitting ? "Creating…" : "Create Service Order"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Re-export the modal so the SO/CO detail pages can import it for their
// "Convert to Service Order" buttons. Keeping it co-located here avoids
// a circular import — the detail pages depend on this page's types
// already (status enum, sidebar entry).
export { CreateServiceOrderModal };
