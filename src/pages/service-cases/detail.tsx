// ---------------------------------------------------------------------------
// Service Case detail — case info + nested orders + spawn-order modal.
//
// This is the operator's primary screen for working a service case. It
// shows the customer issue + photos + RCA at the top; below, the list of
// any service orders spawned for this case, plus a "Spawn Service Order"
// button to open a new resolution flow (REPRODUCE / STOCK_SWAP / REPAIR).
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";
import {
  ArrowLeft, CheckCircle2, XCircle, Plus, X, Wrench, AlertCircle,
} from "lucide-react";

type CaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
type SourceType = "SO" | "CO" | "EXTERNAL";
type RootCauseCategory =
  | "PRODUCTION" | "DESIGN" | "MATERIAL" | "PROCESS"
  | "CUSTOMER" | "TRANSPORT" | "OTHER";
type PreventionStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "NOT_NEEDED";
type Mode = "REPRODUCE" | "STOCK_SWAP" | "REPAIR";

type ServiceCaseDetail = {
  id: string;
  caseNo: string;
  sourceType: SourceType;
  sourceId: string;
  sourceNo: string;
  customerId: string;
  customerName: string;
  customerState: string;
  issueDescription: string;
  issuePhotos: string[];
  rootCauseCategory: RootCauseCategory | null;
  rootCauseNotes: string;
  preventionAction: string;
  preventionStatus: PreventionStatus;
  preventionOwner: string;
  status: CaseStatus;
  externalRef: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  closedAt: string;
  notes: string;
  orders: Array<{
    id: string;
    serviceOrderNo: string;
    mode: Mode | null;
    status: string;
    createdAt: string;
  }>;
};

const STATUS_COLOR: Record<CaseStatus, string> = {
  OPEN: "bg-[#F4EFE3] text-[#6B5C32]",
  IN_PROGRESS: "bg-[#E0EAF4] text-[#3A5670]",
  CLOSED: "bg-[#E2DDD8] text-[#5A5550]",
  CANCELLED: "bg-[#F5DCDC] text-[#7A2E24]",
};

const STATUS_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  OPEN: ["IN_PROGRESS", "CLOSED", "CANCELLED"],
  IN_PROGRESS: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

const ROOT_CAUSE_LABELS: Record<string, string> = {
  PRODUCTION: "Production / workmanship",
  DESIGN: "Design / R&D",
  MATERIAL: "Material / supplier",
  PROCESS: "Process / SOP gap",
  CUSTOMER: "Customer (not our fault)",
  TRANSPORT: "Transport / 3PL",
  OTHER: "Other",
};

const PREVENTION_STATUS_COLOR: Record<string, string> = {
  PENDING: "bg-[#F4EFE3] text-[#6B5C32] border-[#E8D8B2]",
  IN_PROGRESS: "bg-[#E0EAF4] text-[#3A5670] border-[#C9D6E4]",
  DONE: "bg-[#E2EFE0] text-[#3A6B47] border-[#C9DEC2]",
  NOT_NEEDED: "bg-[#E2DDD8] text-[#5A5550] border-[#C9C5C0]",
};

function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function ServiceCaseDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { toast } = useToast();
  const user = getCurrentUser();

  const { data: resp, refresh } = useCachedJson<{ data?: ServiceCaseDetail }>(
    `/api/service-cases/${id}`,
  );
  const caseDetail = resp?.data;
  const [advancing, setAdvancing] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);

  const allowedTransitions = useMemo(
    () => (caseDetail ? STATUS_TRANSITIONS[caseDetail.status] ?? [] : []),
    [caseDetail],
  );

  if (!caseDetail) {
    return (
      <div className="space-y-4">
        <Link
          to="/service-cases"
          className="text-sm text-[#6B5C32] hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Service Cases
        </Link>
        <p className="text-sm text-[#9CA3AF]">Loading…</p>
      </div>
    );
  }

  async function advanceStatus(next: CaseStatus) {
    setAdvancing(true);
    try {
      const res = await fetch(`/api/service-cases/${id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      invalidateCachePrefix("/api/service-cases");
      refresh();
      toast.success(`Status → ${next}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setAdvancing(false);
    }
  }

  const sourceHref =
    caseDetail.sourceType === "SO"
      ? `/sales/${caseDetail.sourceId}`
      : caseDetail.sourceType === "CO"
        ? `/consignment/${caseDetail.sourceId}`
        : null;

  return (
    <div className="space-y-4">
      <Link
        to="/service-cases"
        className="text-sm text-[#6B5C32] hover:underline inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Service Cases
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B] font-mono">
              {caseDetail.caseNo}
            </h1>
            <span
              className={`text-[10px] uppercase px-2 py-0.5 rounded ${STATUS_COLOR[caseDetail.status] ?? "bg-[#F4EFE3]"}`}
            >
              {caseDetail.status}
            </span>
          </div>
          <p className="text-xs text-[#6B7280] mt-1">
            Customer: <span className="font-medium">{caseDetail.customerName}</span>
            {" · "}
            Source:{" "}
            {sourceHref ? (
              <Link to={sourceHref} className="text-[#6B5C32] hover:underline">
                {caseDetail.sourceType} {caseDetail.sourceNo || caseDetail.sourceId}
              </Link>
            ) : (
              <span>EXTERNAL{caseDetail.externalRef ? ` (${caseDetail.externalRef})` : ""}</span>
            )}
            {caseDetail.createdAt ? ` · Opened ${dateLabel(caseDetail.createdAt)}` : ""}
            {caseDetail.createdByName ? ` by ${caseDetail.createdByName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {allowedTransitions.includes("IN_PROGRESS") && (
            <Button
              variant="outline"
              size="sm"
              disabled={advancing}
              onClick={() => advanceStatus("IN_PROGRESS")}
            >
              <Wrench className="h-4 w-4" /> Mark In Progress
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
              <CheckCircle2 className="h-4 w-4" /> Close Case
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
        </div>
      </div>

      {/* Customer issue */}
      {(caseDetail.issueDescription || caseDetail.issuePhotos.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Customer Issue</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[#1F1D1B]">
            {caseDetail.issueDescription && (
              <p className="whitespace-pre-line">{caseDetail.issueDescription}</p>
            )}
            {caseDetail.issuePhotos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {caseDetail.issuePhotos.map((p, i) => (
                  <a key={i} href={p} target="_blank" rel="noopener noreferrer">
                    <img
                      src={p}
                      alt={`Photo ${i + 1}`}
                      className="h-24 w-24 rounded border border-[#E2DDD8] object-cover hover:border-[#6B5C32]"
                    />
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Root cause + prevention */}
      <RootCausePanel
        caseDetail={caseDetail}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

      {/* Service orders attached to this case */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">
            Service Orders ({caseDetail.orders.length})
          </CardTitle>
          {caseDetail.status !== "CANCELLED" && caseDetail.status !== "CLOSED" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setSpawnOpen(true)}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              <Plus className="h-4 w-4" /> Spawn Service Order
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {caseDetail.orders.length === 0 ? (
            <p className="text-xs text-[#9CA3AF] px-4 py-3">
              No service orders spawned. If this case needs rework / stock swap / repair,
              click "Spawn Service Order".
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left text-xs uppercase text-[#6B7280] bg-[#FAF9F7]">
                  <th className="py-2 px-3">SO No</th>
                  <th className="py-2 px-3">Mode</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {caseDetail.orders.map((o) => (
                  <tr key={o.id} className="border-b border-[#F0ECE9]">
                    <td className="py-2 px-3 font-mono text-xs">
                      <Link to={`/service-orders/${o.id}`} className="text-[#6B5C32] hover:underline">
                        {o.serviceOrderNo}
                      </Link>
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {o.mode ?? <span className="text-[#9CA3AF]">pending</span>}
                    </td>
                    <td className="py-2 px-3 text-xs">{o.status}</td>
                    <td className="py-2 px-3 text-xs text-[#6B7280]">
                      {dateLabel(o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {caseDetail.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-line">{caseDetail.notes}</CardContent>
        </Card>
      )}

      {spawnOpen && (
        <SpawnServiceOrderModal
          caseId={caseDetail.id}
          sourceType={caseDetail.sourceType}
          sourceId={caseDetail.sourceId}
          customerName={caseDetail.customerName}
          onClose={() => setSpawnOpen(false)}
          onSpawned={(orderId) => {
            setSpawnOpen(false);
            invalidateCachePrefix("/api/service-cases");
            invalidateCachePrefix("/api/service-orders");
            refresh();
            toast.success("Service order spawned");
            // Navigate to the order detail so the operator can pick mode etc.
            window.location.href = `/service-orders/${orderId}`;
          }}
          createdById={user?.id ?? ""}
          createdByName={user?.displayName ?? user?.email ?? ""}
        />
      )}
    </div>
  );
}

// ===========================================================================
// RootCausePanel — inline editor, auto-saves on blur.
// ===========================================================================
function RootCausePanel({
  caseDetail,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [category, setCategory] = useState(caseDetail.rootCauseCategory ?? "");
  const [notes, setNotes] = useState(caseDetail.rootCauseNotes);
  const [action, setAction] = useState(caseDetail.preventionAction);
  const [owner, setOwner] = useState(caseDetail.preventionOwner);
  const [status, setStatus] = useState(caseDetail.preventionStatus);
  const [saving, setSaving] = useState(false);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Root Cause &amp; Prevention</CardTitle>
        <span
          className={`text-[10px] uppercase px-2 py-0.5 rounded border ${PREVENTION_STATUS_COLOR[status] ?? PREVENTION_STATUS_COLOR.PENDING}`}
        >
          {status}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              save({ rootCauseCategory: e.target.value || null });
            }}
            disabled={saving}
            className="h-8 rounded border border-[#E2DDD8] bg-white px-2 text-sm"
          >
            <option value="">Category — not yet assigned</option>
            {Object.entries(ROOT_CAUSE_LABELS).map(([v, t]) => (
              <option key={v} value={v}>{t}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => {
              const next = e.target.value as PreventionStatus;
              setStatus(next);
              save({ preventionStatus: next });
            }}
            disabled={saving}
            className="h-8 rounded border border-[#E2DDD8] bg-white px-2 text-sm"
          >
            <option value="PENDING">Prevention pending</option>
            <option value="IN_PROGRESS">Prevention in progress</option>
            <option value="DONE">Prevention done</option>
            <option value="NOT_NEEDED">No prevention needed</option>
          </select>
        </div>
        <textarea
          rows={2}
          value={notes}
          onBlur={() => save({ rootCauseNotes: notes || null })}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Why did this happen?"
          className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
        />
        <textarea
          rows={2}
          value={action}
          onBlur={() => save({ preventionAction: action || null })}
          onChange={(e) => setAction(e.target.value)}
          placeholder="What's the action so the next batch doesn't repeat this?"
          className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
        />
        <Input
          type="text"
          value={owner}
          onBlur={() => save({ preventionOwner: owner || null })}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Owner of follow-up (name)"
          className="h-8 text-sm"
        />
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// SpawnServiceOrderModal — small form to spawn an order under this case.
// ===========================================================================
type FgPickerOpt = { id: string; code: string; name: string; stockQty?: number };

function SpawnServiceOrderModal({
  caseId,
  sourceType,
  sourceId,
  customerName,
  onClose,
  onSpawned,
  createdById,
  createdByName,
}: {
  caseId: string;
  sourceType: SourceType;
  sourceId: string;
  customerName: string;
  onClose: () => void;
  onSpawned: (id: string) => void;
  createdById: string;
  createdByName: string;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode | null>(null);
  // For SO/CO source, fetch source order items so the operator can pick.
  // For EXTERNAL we collect free-text rows. Either way the result is `lines`.
  const { data: invResp } = useCachedJson<{
    data?: { finishedProducts?: FgPickerOpt[] };
  }>("/api/inventory");
  const fgList = useMemo(() => invResp?.data?.finishedProducts ?? [], [invResp]);

  type SourceItem = { id: string; productId: string; productCode: string; productName: string; quantity: number };
  const sourceUrl =
    sourceType === "EXTERNAL" || !sourceId
      ? null
      : sourceType === "SO"
        ? `/api/sales-orders/${sourceId}`
        : `/api/consignment-orders/${sourceId}`;
  const { data: srcResp } = useCachedJson<{ data?: { items?: SourceItem[] } }>(sourceUrl);
  const sourceItems: SourceItem[] = useMemo(
    () => srcResp?.data?.items ?? [],
    [srcResp],
  );

  const [linePicks, setLinePicks] = useState<
    Record<string, { qty: string; issue: string; fgBatchId: string }>
  >({});
  const [freeLines, setFreeLines] = useState<
    Array<{ id: string; productCode: string; productName: string; qty: string; issue: string }>
  >([]);
  const [submitting, setSubmitting] = useState(false);

  function togglePickLine(itemId: string, on: boolean) {
    setLinePicks((prev) => {
      const copy = { ...prev };
      if (on) copy[itemId] = copy[itemId] ?? { qty: "1", issue: "", fgBatchId: "" };
      else delete copy[itemId];
      return copy;
    });
  }
  function patchPick(itemId: string, p: Partial<{ qty: string; issue: string; fgBatchId: string }>) {
    setLinePicks((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...p } }));
  }
  function addFreeLine() {
    setFreeLines((prev) => [
      ...prev,
      {
        id: `fl-${Math.random().toString(36).slice(2, 8)}`,
        productCode: "", productName: "", qty: "1", issue: "",
      },
    ]);
  }
  function patchFreeLine(id: string, p: Partial<{ productCode: string; productName: string; qty: string; issue: string }>) {
    setFreeLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...p } : l)));
  }
  function removeFreeLine(id: string) {
    setFreeLines((prev) => prev.filter((l) => l.id !== id));
  }

  const pickedIds = Object.keys(linePicks);
  const linesOk =
    sourceType === "EXTERNAL"
      ? freeLines.length > 0 && freeLines.every((l) => l.productName.trim() && Number(l.qty) > 0)
      : pickedIds.length > 0 &&
        pickedIds.every((id) => {
          const pick = linePicks[id];
          if (Number(pick.qty) <= 0) return false;
          if (mode === "STOCK_SWAP" && !pick.fgBatchId) return false;
          return true;
        });

  async function handleSubmit() {
    if (!linesOk) return;
    setSubmitting(true);
    try {
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
      } else {
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
      }
      const res = await fetch("/api/service-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          mode,
          lines,
          createdBy: createdById || null,
          createdByName: createdByName || null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { id: string } };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      onSpawned(data.data!.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-[#E2DDD8]">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">Spawn Service Order</h3>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-xs text-[#6B7280]">
            Spawning under <span className="font-medium">{customerName}</span>'s case. Customer issue
            and root cause stay on the case (this order is just the resolution work).
          </p>

          {/* Mode */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">Resolution Mode</label>
            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  { v: null, t: "Decide later", d: "Spawn now, pick mode after follow-up" },
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

          {/* Lines */}
          {sourceType === "EXTERNAL" ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-[#6B7280]">Affected Items</label>
                <Button size="sm" variant="outline" onClick={addFreeLine}>
                  <Plus className="mr-1 h-3 w-3" /> Add Item
                </Button>
              </div>
              {freeLines.length === 0 ? (
                <p className="text-xs text-[#9CA3AF]">Click "Add Item" to enter at least one product.</p>
              ) : (
                <div className="border border-[#E2DDD8] rounded">
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
                            <Input value={l.productCode} onChange={(e) => patchFreeLine(l.id, { productCode: e.target.value })} placeholder="optional" className="h-7 text-xs px-2" />
                          </td>
                          <td className="p-2">
                            <Input value={l.productName} onChange={(e) => patchFreeLine(l.id, { productName: e.target.value })} placeholder="e.g. Brown leather sofa" className="h-7 text-xs px-2" />
                          </td>
                          <td className="p-2">
                            <Input type="number" min="1" value={l.qty} onChange={(e) => patchFreeLine(l.id, { qty: e.target.value })} className="h-7 text-xs px-2" />
                          </td>
                          <td className="p-2">
                            <Input value={l.issue} onChange={(e) => patchFreeLine(l.id, { issue: e.target.value })} placeholder="optional" className="h-7 text-xs px-2" />
                          </td>
                          <td className="p-2 text-right">
                            <button type="button" onClick={() => removeFreeLine(l.id)} className="text-[#9A3A2D]">
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
          ) : (
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Affected Items ({pickedIds.length} picked)
              </label>
              {sourceItems.length === 0 ? (
                <p className="text-xs text-[#9CA3AF]">No items found on the source order.</p>
              ) : (
                <div className="border border-[#E2DDD8] rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-[#FAF9F7]">
                      <tr className="text-left text-[10px] uppercase text-[#6B7280]">
                        <th className="p-2 w-[30px]"></th>
                        <th className="p-2">Product</th>
                        <th className="p-2 w-[60px] text-right">Orig</th>
                        <th className="p-2 w-[80px]">Defect Qty</th>
                        <th className="p-2">Issue</th>
                        {mode === "STOCK_SWAP" && <th className="p-2 w-[200px]">FG Batch</th>}
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
                                onChange={(e) => togglePickLine(it.id, e.target.checked)}
                              />
                            </td>
                            <td className="p-2">
                              <div className="font-mono text-xs">{it.productCode}</div>
                              <div className="text-[10px] text-[#6B7280]">{it.productName}</div>
                            </td>
                            <td className="p-2 text-right font-mono">{it.quantity}</td>
                            <td className="p-2">
                              <Input
                                type="number" min="1" max={it.quantity}
                                value={pick?.qty ?? ""}
                                onChange={(e) => patchPick(it.id, { qty: e.target.value })}
                                disabled={!picked}
                                className="h-7 text-xs px-2"
                              />
                            </td>
                            <td className="p-2">
                              <Input
                                value={pick?.issue ?? ""}
                                onChange={(e) => patchPick(it.id, { issue: e.target.value })}
                                disabled={!picked}
                                placeholder="optional"
                                className="h-7 text-xs px-2"
                              />
                            </td>
                            {mode === "STOCK_SWAP" && (
                              <td className="p-2">
                                <select
                                  value={pick?.fgBatchId ?? ""}
                                  onChange={(e) => patchPick(it.id, { fgBatchId: e.target.value })}
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
                Stock Swap will decrement the picked FG batch's remaining qty immediately.
                The customer keeps the defective unit; record the return separately when it
                arrives.
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
            disabled={!linesOk || submitting}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {submitting ? "Spawning…" : "Spawn Order"}
          </Button>
        </div>
      </div>
    </div>
  );
}
