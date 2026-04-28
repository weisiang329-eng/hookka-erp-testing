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

  // kind discriminates Service Order (RESOLUTION — heavy rework/swap/repair
  // flow) from Service Case (RECORD — log-only, e.g., shipped one fewer leg
  // and mailed it separately, complaint logged after on-site fix).
  const [kind, setKind] = useState<"RESOLUTION" | "RECORD">("RESOLUTION");
  const [sourceType, setSourceType] = useState<"SO" | "CO" | "EXTERNAL">(
    presetSourceType ?? "SO",
  );
  const [sourceId, setSourceId] = useState<string>(presetSourceId ?? "");
  const [sourceQuery, setSourceQuery] = useState("");
  // EXTERNAL-source state — no SO/CO record in the system to pull from.
  const [externalCustomerName, setExternalCustomerName] = useState("");
  const [externalRef, setExternalRef] = useState("");
  // null = "Decide later" — open the case while the customer is on the
  // phone and pick the mode as a follow-up via PUT /:id/mode.
  const [mode, setMode] = useState<"REPRODUCE" | "STOCK_SWAP" | "REPAIR" | null>(
    null,
  );
  const [issueDescription, setIssueDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Photos: base64 data URIs after client-side resize. Stored on the
  // service_orders.issuePhotos JSON column. Small-shop-friendly — no R2
  // setup required at the cost of bloating the DB row a bit.
  const [photos, setPhotos] = useState<string[]>([]);
  // Per-line state. Two shapes coexist:
  //   • SO/CO source: linePicks keyed by sourceLineId (item's id from the
  //     source order's items array)
  //   • EXTERNAL source / RECORD-kind: freeLines (operator types product +
  //     qty + issue by hand)
  const [linePicks, setLinePicks] = useState<
    Record<string, { qty: string; issue: string; fgBatchId: string }>
  >({});
  const [freeLines, setFreeLines] = useState<
    Array<{ id: string; productCode: string; productName: string; qty: string; issue: string }>
  >([]);
  // Root-cause + prevention loop — optional at create time, editable on
  // detail page after follow-up.
  const [rootCauseCategory, setRootCauseCategory] = useState<string>("");
  const [rootCauseNotes, setRootCauseNotes] = useState("");
  const [preventionAction, setPreventionAction] = useState("");
  const [preventionOwner, setPreventionOwner] = useState("");

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

  // Source picker state-validity:
  //   - SO/CO   → must have a sourceId selected
  //   - EXTERNAL → must have a customer name
  const sourceOk =
    sourceType === "EXTERNAL"
      ? externalCustomerName.trim().length > 0
      : !!sourceId;

  // Lines validity depends on kind + sourceType.
  //   RECORD: lines are optional (can have zero — pure log entry).
  //   RESOLUTION + SO/CO: at least one picked from source items.
  //   RESOLUTION + EXTERNAL: at least one free-text line with a productName.
  const linesOk =
    kind === "RECORD"
      ? true
      : sourceType === "EXTERNAL"
        ? freeLines.length > 0 &&
          freeLines.every(
            (l) => l.productName.trim().length > 0 && Number(l.qty) > 0,
          )
        : pickedIds.length > 0 &&
          pickedIds.every((id) => {
            const pick = linePicks[id];
            const qtyOk = Number(pick.qty) > 0;
            if (mode === "STOCK_SWAP" && !pick.fgBatchId) return false;
            return qtyOk;
          });

  const canSubmit = sourceOk && linesOk;

  // ---- Photo helpers ----
  // Resize a phone-sized JPEG (typically 3000×4000, ~3MB) down to ~1280px
  // longest side @ 0.85 quality (~150-300KB). Stored as a base64 data URI
  // on service_orders.issuePhotos. For high-volume use we'd swap to R2 +
  // /api/files; this is good enough for a small shop's ~5 photos / case.
  async function resizeImageToBase64(file: File, maxDim = 1280): Promise<string> {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  async function handleAddPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const results: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const b64 = await resizeImageToBase64(f);
        results.push(b64);
      } catch {
        toast.error(`Couldn't read ${f.name}`);
      }
    }
    setPhotos((prev) => [...prev, ...results]);
  }

  // ---- Free-line helpers (EXTERNAL source) ----
  function addFreeLine() {
    setFreeLines((prev) => [
      ...prev,
      {
        id: `fl-${Math.random().toString(36).slice(2, 8)}`,
        productCode: "",
        productName: "",
        qty: "1",
        issue: "",
      },
    ]);
  }
  function patchFreeLine(
    id: string,
    p: Partial<{ productCode: string; productName: string; qty: string; issue: string }>,
  ) {
    setFreeLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...p } : l)));
  }
  function removeFreeLine(id: string) {
    setFreeLines((prev) => prev.filter((l) => l.id !== id));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // Build the lines payload from whichever entry mode is active.
      let lines: Array<Record<string, unknown>> = [];
      if (sourceType === "EXTERNAL") {
        lines = freeLines.map((l) => ({
          sourceLineId: null,
          productId: null,
          productCode: l.productCode || null,
          productName: l.productName,
          qty: Number(l.qty) || 1,
          issueSummary: l.issue || null,
        }));
      } else if (kind === "RESOLUTION") {
        lines = pickedIds.map((id) => {
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
      } else {
        // RECORD + SO/CO: still allow operator to pick lines if they want to
        // tag specific items, but it's optional.
        lines = pickedIds.map((id) => {
          const pick = linePicks[id];
          const item = sourceItems.find((x) => x.id === id);
          return {
            sourceLineId: id,
            productId: item?.productId,
            productCode: item?.productCode,
            productName: item?.productName,
            qty: Number(pick.qty) || 1,
            issueSummary: pick.issue || null,
          };
        });
      }
      const res = await fetch("/api/service-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          sourceType,
          sourceId: sourceType === "EXTERNAL" ? null : sourceId,
          // EXTERNAL fields — backend ignores when sourceType is SO/CO
          customerName: sourceType === "EXTERNAL" ? externalCustomerName : undefined,
          externalRef: sourceType === "EXTERNAL" ? externalRef || null : undefined,
          // RECORD enforces null mode server-side; we still send null explicitly
          // so an "always RECORD" form doesn't carry a stale REPRODUCE hint.
          mode: kind === "RECORD" ? null : mode,
          issueDescription,
          issuePhotos: photos,
          rootCauseCategory: rootCauseCategory || null,
          rootCauseNotes: rootCauseNotes || null,
          preventionAction: preventionAction || null,
          preventionOwner: preventionOwner || null,
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
            {kind === "RECORD" ? "New Service Case" : "New Service Order"}
          </h3>
          <button
            onClick={onClose}
            className="text-[#9CA3AF] hover:text-[#374151]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* Kind toggle */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Type of Service
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  {
                    v: "RESOLUTION",
                    t: "Service Order",
                    d: "Rework / swap / repair — has resolution flow",
                  },
                  {
                    v: "RECORD",
                    t: "Service Case (record only)",
                    d: "Log a complaint, missing parts shipout, on-site fix — no rework",
                  },
                ] as const
              ).map((k) => (
                <button
                  key={k.v}
                  type="button"
                  onClick={() => setKind(k.v)}
                  className={`text-left rounded border p-3 text-xs ${
                    kind === k.v
                      ? "border-[#6B5C32] bg-[#F4EFE3]"
                      : "border-[#E2DDD8] hover:bg-[#FAF9F7]"
                  }`}
                >
                  <div className="font-medium text-[#1F1D1B]">{k.t}</div>
                  <div className="text-[10px] text-[#6B7280]">{k.d}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Source picker */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Source Order Type
              </label>
              <select
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value as "SO" | "CO" | "EXTERNAL");
                  setSourceId("");
                  setSourceQuery("");
                  setLinePicks({});
                  setFreeLines([]);
                }}
                disabled={!!presetSourceType}
                className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
              >
                <option value="SO">Sales Order</option>
                <option value="CO">Consignment Order</option>
                <option value="EXTERNAL">External / Old order (no record in system)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Source Order {selectedSource ? "" : "(search by SO# / customer)"}
              </label>
              {selectedSource ? (
                // Already picked — show a compact summary + "Change" button.
                // Operator rarely needs to switch mid-form; the search list
                // would just be visual noise after a pick.
                <div className="flex items-center justify-between rounded border border-[#E2DDD8] bg-[#FAF9F7] px-2 py-1.5 text-sm">
                  <div className="truncate">
                    <span className="font-mono">{selectedSource.companyOrderId}</span>{" "}
                    <span className="text-[#6B7280]">— {selectedSource.customerName}</span>{" "}
                    <span className="text-[10px] text-[#9CA3AF]">({selectedSource.status})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (presetSourceId) return;
                      setSourceId("");
                      setSourceQuery("");
                      setLinePicks({});
                    }}
                    disabled={!!presetSourceId}
                    className="ml-2 text-xs text-[#6B5C32] hover:underline disabled:text-[#9CA3AF]"
                  >
                    Change
                  </button>
                </div>
              ) : sourceType === "EXTERNAL" ? (
                // EXTERNAL — no record in system; operator types customer
                // name + (optional) external reference (paper PO, manual
                // SO number, etc.). Free-text item rows live in their own
                // section below.
                <div className="space-y-1">
                  <Input
                    type="text"
                    value={externalCustomerName}
                    onChange={(e) => setExternalCustomerName(e.target.value)}
                    placeholder="Customer name (required)"
                    className="h-8 text-sm"
                  />
                  <Input
                    type="text"
                    value={externalRef}
                    onChange={(e) => setExternalRef(e.target.value)}
                    placeholder="External reference (paper SO#, etc. — optional)"
                    className="h-8 text-sm"
                  />
                </div>
              ) : (
                <SourceSearchPicker
                  query={sourceQuery}
                  onQueryChange={setSourceQuery}
                  options={sourceOptions}
                  onPick={(id) => {
                    setSourceId(id);
                    setLinePicks({});
                  }}
                />
              )}
            </div>
          </div>

          {/* Mode — RESOLUTION only. RECORD doesn't have a resolution flow. */}
          {kind === "RESOLUTION" && (
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Resolution Mode <span className="text-[#9CA3AF]">(optional — pick later if you're still gathering info)</span>
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  { v: null, t: "Decide later", d: "Open the case now; choose resolution after follow-up" },
                  { v: "REPRODUCE", t: "Reproduce", d: "Open new PO; ship when ready" },
                  { v: "STOCK_SWAP", t: "Stock Swap", d: "Pull from FG, ship now" },
                  { v: "REPAIR", t: "Repair", d: "Customer returns; we fix" },
                ] as const
              ).map((m) => (
                <button
                  key={m.v ?? "later"}
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
          )}

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

          {/* EXTERNAL — free-text item rows. No SO/CO source items to pick
              from, so the operator types productCode (optional) + name + qty +
              issue. RECORD-kind allows zero rows; RESOLUTION-kind requires
              at least one. */}
          {sourceType === "EXTERNAL" && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-[#6B7280]">
                  Affected Items{" "}
                  {kind === "RECORD" ? "(optional)" : "(required)"}
                </label>
                <Button size="sm" variant="outline" onClick={addFreeLine}>
                  <Plus className="mr-1 h-3 w-3" />
                  Add Item
                </Button>
              </div>
              {freeLines.length === 0 ? (
                <p className="text-xs text-[#9CA3AF]">
                  {kind === "RECORD"
                    ? "Add an item only if the case relates to a specific product."
                    : "Click 'Add Item' to enter at least one product the customer reported."}
                </p>
              ) : (
                <div className="border border-[#E2DDD8] rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-[#FAF9F7]">
                      <tr className="text-left text-[10px] uppercase text-[#6B7280]">
                        <th className="p-2 w-[140px]">Code</th>
                        <th className="p-2">Product Name</th>
                        <th className="p-2 w-[80px]">Qty</th>
                        <th className="p-2">Issue</th>
                        <th className="p-2 w-[40px]"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {freeLines.map((l) => (
                        <tr key={l.id} className="border-t border-[#F0ECE9]">
                          <td className="p-2">
                            <Input
                              type="text"
                              value={l.productCode}
                              onChange={(e) =>
                                patchFreeLine(l.id, { productCode: e.target.value })
                              }
                              placeholder="optional"
                              className="h-7 text-xs px-2"
                            />
                          </td>
                          <td className="p-2">
                            <Input
                              type="text"
                              value={l.productName}
                              onChange={(e) =>
                                patchFreeLine(l.id, { productName: e.target.value })
                              }
                              placeholder="e.g. Brown leather sofa"
                              className="h-7 text-xs px-2"
                            />
                          </td>
                          <td className="p-2">
                            <Input
                              type="number"
                              min="1"
                              value={l.qty}
                              onChange={(e) =>
                                patchFreeLine(l.id, { qty: e.target.value })
                              }
                              className="h-7 text-xs px-2"
                            />
                          </td>
                          <td className="p-2">
                            <Input
                              type="text"
                              value={l.issue}
                              onChange={(e) =>
                                patchFreeLine(l.id, { issue: e.target.value })
                              }
                              placeholder="optional"
                              className="h-7 text-xs px-2"
                            />
                          </td>
                          <td className="p-2 text-right">
                            <button
                              type="button"
                              onClick={() => removeFreeLine(l.id)}
                              className="text-[#9A3A2D] hover:text-[#7A2E24]"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Photos — attach customer-supplied or in-house images of the
              defect. Resized client-side to ~1280px JPEG and stored as base64
              data URIs on service_orders.issuePhotos. Good enough for ~5
              photos per case at this shop's volume. */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Photos ({photos.length})
            </label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => handleAddPhotos(e.target.files)}
              className="block w-full text-xs"
            />
            {photos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {photos.map((src, i) => (
                  <div key={i} className="relative">
                    <img
                      src={src}
                      alt={`photo ${i + 1}`}
                      className="h-20 w-20 rounded border border-[#E2DDD8] object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setPhotos((p) => p.filter((_, idx) => idx !== i))}
                      className="absolute -top-1 -right-1 rounded-full bg-white border border-[#E2DDD8] p-0.5 text-[#9A3A2D] hover:text-[#7A2E24]"
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Root-cause + prevention — optional at create time; usually
              filled in later as follow-up info comes in. Surfacing it here
              means the operator can capture an obvious cause ("3PL dropped
              it") without needing to come back to the detail page. */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Root Cause &amp; Prevention <span className="text-[#9CA3AF]">(optional)</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={rootCauseCategory}
                onChange={(e) => setRootCauseCategory(e.target.value)}
                className="h-8 rounded border border-[#E2DDD8] bg-white px-2 text-sm"
              >
                <option value="">Category — not yet assigned</option>
                <option value="PRODUCTION">Production / workmanship</option>
                <option value="DESIGN">Design / R&amp;D</option>
                <option value="MATERIAL">Material / supplier</option>
                <option value="PROCESS">Process / SOP gap</option>
                <option value="CUSTOMER">Customer (not our fault)</option>
                <option value="TRANSPORT">Transport / 3PL</option>
                <option value="OTHER">Other</option>
              </select>
              <Input
                type="text"
                value={preventionOwner}
                onChange={(e) => setPreventionOwner(e.target.value)}
                placeholder="Owner of follow-up (name)"
                className="h-8 text-sm"
              />
            </div>
            <textarea
              rows={2}
              value={rootCauseNotes}
              onChange={(e) => setRootCauseNotes(e.target.value)}
              placeholder="Why did this happen? (e.g. 'Wrong fabric loaded on cutting station, SOP missing barcode scan check')"
              className="mt-2 w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            />
            <textarea
              rows={2}
              value={preventionAction}
              onChange={(e) => setPreventionAction(e.target.value)}
              placeholder="What's the action so the next batch doesn't have this? (e.g. 'Add fabric-code scan to FAB_CUT job-card flow')"
              className="mt-2 w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            />
          </div>
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
            {submitting
              ? "Creating…"
              : kind === "RECORD"
                ? "Create Service Case"
                : "Create Service Order"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceSearchPicker — typeahead for shipped SO/CO.
// ---------------------------------------------------------------------------
// Replaces the previous <select> dropdown. With 100s of orders the dropdown
// was both unusable (long scroll) and visually broken in some browsers
// (no items appeared at all). The search box filters by company order ID
// or customer name, capped at 15 visible results so it stays performant.
// ---------------------------------------------------------------------------
function SourceSearchPicker({
  query,
  onQueryChange,
  options,
  onPick,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  options: SourceOrderOption[];
  onPick: (id: string) => void;
}) {
  const q = query.trim().toLowerCase();
  // Empty input → show NOTHING (don't dump the first 15 options as a teaser).
  // The user explicitly asked: "as I type more characters, results should
  // narrow, not the other way round." Listing options up-front looked like
  // the search was widening as you typed. Empty = empty.
  const filtered = useMemo(() => {
    if (!q) return [];
    const matches = options.filter(
      (o) =>
        o.companyOrderId.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q),
    );
    return matches.slice(0, 15);
  }, [options, q]);

  return (
    <div className="space-y-1">
      <Input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={`Type SO# or customer name… (${options.length} shipped)`}
        className="h-8 text-sm"
      />
      {q && (
        <div className="max-h-48 overflow-y-auto rounded border border-[#E2DDD8] bg-white">
          {filtered.length === 0 ? (
            <div className="p-2 text-xs text-[#9CA3AF]">
              No matches for "{q}". Try fewer characters or switch SO ↔ CO.
            </div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s.id)}
                className="block w-full text-left px-2 py-1.5 text-xs hover:bg-[#F4EFE3] border-b border-[#F0ECE9] last:border-b-0"
              >
                <span className="font-mono">{s.companyOrderId}</span>
                <span className="text-[#6B7280]"> — {s.customerName}</span>
                <span className="ml-1 text-[10px] text-[#9CA3AF]">({s.status})</span>
              </button>
            ))
          )}
          {options.length > 15 && filtered.length === 15 && (
            <div className="px-2 py-1 text-[10px] text-[#9CA3AF] border-t border-[#F0ECE9]">
              Showing first 15 — type more to narrow down.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Re-export the modal so the SO/CO detail pages can import it for their
// "Convert to Service Order" buttons. Keeping it co-located here avoids
// a circular import — the detail pages depend on this page's types
// already (status enum, sidebar entry).
export { CreateServiceOrderModal };
