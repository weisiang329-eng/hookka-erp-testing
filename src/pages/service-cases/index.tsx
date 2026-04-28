// ---------------------------------------------------------------------------
// Service Cases — top-level list page (parent of Service Orders).
//
// Per design 2026-04-28: every customer-facing service interaction lives
// here. A Case is just a record (issue + photos + RCA + customer); a Case
// can spawn 0..N Service Orders for the heavy resolution work
// (REPRODUCE / STOCK_SWAP / REPAIR).
//
// Navigation flow:
//   Sidebar "Service Cases" → this page → click row → /service-cases/:id
//   On the detail page, you see the case info + any spawned orders, and
//   can spawn more orders or close the case.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";
import { Plus, X, AlertCircle } from "lucide-react";

type CaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
type SourceType = "SO" | "CO" | "EXTERNAL";

const STATUS_COLOR: Record<CaseStatus, string> = {
  OPEN: "bg-[#F4EFE3] text-[#6B5C32]",
  IN_PROGRESS: "bg-[#E0EAF4] text-[#3A5670]",
  CLOSED: "bg-[#E2DDD8] text-[#5A5550]",
  CANCELLED: "bg-[#F5DCDC] text-[#7A2E24]",
};

const SHIPPED_STATUSES_SO = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED"];
const SHIPPED_STATUSES_CO = [
  "SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "PARTIALLY_SOLD", "FULLY_SOLD",
];

type ServiceCaseListItem = {
  id: string;
  caseNo: string;
  sourceType: SourceType;
  sourceNo: string;
  customerName: string;
  status: CaseStatus;
  createdAt: string;
  orders: { id: string; serviceOrderNo: string; status: string; mode: string | null }[];
};

type SourceOrderOption = {
  id: string;
  customerName: string;
  status: string;
  companyOrderId: string;
};

function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "2-digit" });
}

export default function ServiceCasesListPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: resp, refresh } = useCachedJson<{ data?: ServiceCaseListItem[] }>(
    "/api/service-cases",
  );
  const cases = useMemo(() => resp?.data ?? [], [resp]);
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "ALL">("ALL");

  const filtered = useMemo(
    () => (statusFilter === "ALL" ? cases : cases.filter((c) => c.status === statusFilter)),
    [cases, statusFilter],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Service Cases</h1>
          <p className="text-xs text-[#6B7280] mt-1">
            All customer-facing service interactions. Each case can spawn 0+ Service Orders
            (REPRODUCE / STOCK_SWAP / REPAIR) for actual rework, or stay record-only for
            log-only complaints / on-site fixes.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
        >
          <Plus className="h-4 w-4" /> New Service Case
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(["ALL", "OPEN", "IN_PROGRESS", "CLOSED", "CANCELLED"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-1 rounded border ${
              statusFilter === s
                ? "border-[#6B5C32] bg-[#F4EFE3] text-[#6B5C32]"
                : "border-[#E2DDD8] hover:bg-[#FAF9F7]"
            }`}
          >
            {s} {s !== "ALL" ? `(${cases.filter((c) => c.status === s).length})` : `(${cases.length})`}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left text-xs uppercase text-[#6B7280] bg-[#FAF9F7]">
                  <th className="py-2 px-3">Case No</th>
                  <th className="py-2 px-3">Customer</th>
                  <th className="py-2 px-3">Source</th>
                  <th className="py-2 px-3">Orders</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 px-3 text-center text-[#9CA3AF] text-xs">
                      {cases.length === 0
                        ? "No service cases yet — click 'New Service Case' to log the first one."
                        : "No cases in this status."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`/service-cases/${c.id}`)}
                      className="border-b border-[#F0ECE9] cursor-pointer hover:bg-[#FAF9F7]"
                    >
                      <td className="py-2 px-3 font-mono text-xs font-medium">{c.caseNo}</td>
                      <td className="py-2 px-3 text-xs">{c.customerName}</td>
                      <td className="py-2 px-3 text-xs text-[#6B7280]">
                        {c.sourceType} {c.sourceNo}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {c.orders.length === 0 ? (
                          <span className="text-[#9CA3AF]">none</span>
                        ) : (
                          <span className="font-mono text-[10px] text-[#6B5C32]">
                            {c.orders.length} order{c.orders.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        <span
                          className={`text-[10px] uppercase px-2 py-0.5 rounded ${STATUS_COLOR[c.status] ?? "bg-[#F4EFE3]"}`}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-xs text-[#6B7280]">
                        {dateLabel(c.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {createOpen && (
        <CreateServiceCaseModal
          onClose={() => setCreateOpen(false)}
          onCreated={(newId) => {
            setCreateOpen(false);
            invalidateCachePrefix("/api/service-cases");
            refresh();
            toast.success("Service case opened");
            navigate(`/service-cases/${newId}`);
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// CreateServiceCaseModal — minimal form to log a new case.
// ===========================================================================
type SalesOrderApi = {
  id: string;
  customerName: string;
  status: string;
  companySOId?: string;
};
type ConsignmentOrderApi = {
  id: string;
  customerName: string;
  status: string;
  companyCOId?: string;
};

export function CreateServiceCaseModal({
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

  const [sourceType, setSourceType] = useState<"SO" | "CO" | "EXTERNAL">(
    presetSourceType ?? "SO",
  );
  const [sourceId, setSourceId] = useState<string>(presetSourceId ?? "");
  const [sourceQuery, setSourceQuery] = useState("");
  const [externalCustomerName, setExternalCustomerName] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [rootCauseCategory, setRootCauseCategory] = useState<string>("");
  const [rootCauseNotes, setRootCauseNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: soResp } = useCachedJson<{ data?: SalesOrderApi[] }>("/api/sales-orders");
  const { data: coResp } = useCachedJson<{ data?: ConsignmentOrderApi[] }>("/api/consignment-orders");

  const sourceOptions: SourceOrderOption[] = useMemo(() => {
    if (sourceType === "SO") {
      return (soResp?.data ?? [])
        .filter((s) => SHIPPED_STATUSES_SO.includes(s.status))
        .map((s) => ({
          id: s.id,
          customerName: s.customerName,
          status: s.status,
          companyOrderId: s.companySOId ?? "",
        }));
    }
    if (sourceType === "CO") {
      return (coResp?.data ?? [])
        .filter((s) => SHIPPED_STATUSES_CO.includes(s.status))
        .map((s) => ({
          id: s.id,
          customerName: s.customerName,
          status: s.status,
          companyOrderId: s.companyCOId ?? "",
        }));
    }
    return [];
  }, [sourceType, soResp, coResp]);

  const selectedSource = sourceOptions.find((s) => s.id === sourceId);

  const sourceOk =
    sourceType === "EXTERNAL"
      ? externalCustomerName.trim().length > 0
      : !!sourceId;

  // ---- Photo helpers (resize → base64) ----
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
        results.push(await resizeImageToBase64(f));
      } catch {
        toast.error(`Couldn't read ${f.name}`);
      }
    }
    setPhotos((prev) => [...prev, ...results]);
  }

  async function handleSubmit() {
    if (!sourceOk) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/service-cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceId: sourceType === "EXTERNAL" ? null : sourceId,
          customerName: sourceType === "EXTERNAL" ? externalCustomerName : undefined,
          externalRef: sourceType === "EXTERNAL" ? externalRef || null : undefined,
          issueDescription: issueDescription || null,
          issuePhotos: photos,
          rootCauseCategory: rootCauseCategory || null,
          rootCauseNotes: rootCauseNotes || null,
          createdBy: user?.id ?? null,
          createdByName: user?.displayName ?? user?.email ?? null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { id: string } };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
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
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-[#E2DDD8]">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">New Service Case</h3>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Source picker */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">Source Order Type</label>
              <select
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value as "SO" | "CO" | "EXTERNAL");
                  setSourceId("");
                  setSourceQuery("");
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
                    }}
                    disabled={!!presetSourceId}
                    className="ml-2 text-xs text-[#6B5C32] hover:underline disabled:text-[#9CA3AF]"
                  >
                    Change
                  </button>
                </div>
              ) : sourceType === "EXTERNAL" ? (
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
                  onPick={(id) => setSourceId(id)}
                />
              )}
            </div>
          </div>

          {/* Issue */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">Issue Description</label>
            <textarea
              rows={3}
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
              placeholder="What did the customer report?"
              className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            />
          </div>

          {/* Photos */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">Photos ({photos.length})</label>
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
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Optional RCA */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Root Cause <span className="text-[#9CA3AF]">(optional — fill later if you're still gathering info)</span>
            </label>
            <select
              value={rootCauseCategory}
              onChange={(e) => setRootCauseCategory(e.target.value)}
              className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-sm"
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
            <textarea
              rows={2}
              value={rootCauseNotes}
              onChange={(e) => setRootCauseNotes(e.target.value)}
              placeholder="Why did this happen?"
              className="mt-2 w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            />
          </div>

          <div className="flex items-start gap-2 text-xs text-[#3A5670] bg-[#E0EAF4] border border-[#C9D6E4] rounded p-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p>
              Opening a case logs the customer issue. If it needs rework / swap / repair, spawn
              a Service Order from the case detail page after this. Cases close on their own
              timeline — you don't need a Service Order for every case.
            </p>
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
            disabled={!sourceOk || submitting}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {submitting ? "Opening…" : "Open Case"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceSearchPicker({
  query, onQueryChange, options, onPick,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  options: SourceOrderOption[];
  onPick: (id: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return [];
    return options
      .filter(
        (o) =>
          o.companyOrderId.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q),
      )
      .slice(0, 15);
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
            <div className="p-2 text-xs text-[#9CA3AF]">No matches for "{q}".</div>
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
        </div>
      )}
    </div>
  );
}

// Re-export the link helper consumers expect.
export { Link };
