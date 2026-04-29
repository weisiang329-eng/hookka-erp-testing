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
import { compressImage } from "@/lib/image-compress";
import {
  ArrowLeft, CheckCircle2, XCircle, Plus, X, Wrench, AlertCircle, Loader2,
} from "lucide-react";

type CaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
type SourceType = "SO" | "CO" | "EXTERNAL";
type RootCauseCategory =
  | "PRODUCTION" | "DESIGN" | "MATERIAL" | "PROCESS"
  | "CUSTOMER" | "TRANSPORT" | "SALES" | "PICKING" | "OTHER";
type PreventionStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "NOT_NEEDED";
type Mode = "REPRODUCE" | "STOCK_SWAP" | "REPAIR";

type ActionLogEntry = {
  id: string;
  date: string;
  description: string;
  createdAt?: string;
  createdByName?: string;
};

// Per-category structured details. Each category has its own shape; the
// frontend renders different sub-form fields based on the chosen category.
// Persisted as JSON on service_cases.root_cause_details (migration 0076).
type RootCauseDetails = Record<string, unknown>;

const ROOT_CAUSE_LABELS: Record<string, string> = {
  PRODUCTION: "Production / workmanship",
  DESIGN: "Design / R&D",
  MATERIAL: "Material / supplier",
  PROCESS: "Process / SOP gap",
  CUSTOMER: "Customer (not our fault)",
  TRANSPORT: "Transport / 3PL",
  SALES: "Sales / order-taking error",
  PICKING: "Picking / packing error",
  OTHER: "Other",
};

// 8 production-line departments (from src/lib/mock-data.ts seed). Hardcoded
// here because the dept master is mock-data, not a /api/* endpoint, and
// these don't change often. WAREHOUSING / REPAIR / MAINTENANCE / etc.
// non-production depts are appended for the PROCESS / PICKING categories.
const PRODUCTION_DEPTS = [
  { code: "FAB_CUT", name: "Fabric Cutting" },
  { code: "FAB_SEW", name: "Fabric Sewing" },
  { code: "WOOD_CUT", name: "Wood Cutting" },
  { code: "FOAM", name: "Foam" },
  { code: "FRAMING", name: "Framing" },
  { code: "WEBBING", name: "Webbing" },
  { code: "UPHOLSTERY", name: "Upholstery" },
  { code: "PACKING", name: "Packing" },
];
const ALL_DEPTS = [
  ...PRODUCTION_DEPTS,
  { code: "WAREHOUSING", name: "Warehousing" },
  { code: "REPAIR", name: "Repair" },
  { code: "MAINTENANCE", name: "Maintenance" },
];

// Affected product on the case — operator can attach 0..N product SKUs.
// Optional: SO/CO-sourced cases pre-fill from order lines; EXTERNAL cases
// add manually. Stored as JSON on service_cases.affected_product_ids
// (migration 0077).
type AffectedProduct = {
  productId: string;
  code: string;
  name: string;
  qty?: number | null;
};

type ServiceCaseDetail = {
  id: string;
  caseNo: string;
  sourceType: SourceType;
  sourceId: string;
  sourceNo: string;
  customerId: string;
  customerName: string;
  customerState: string;
  // Issue Description carries the 5W story (what / when / who / where /
  // result). Editable from the case detail page; auto-saves on blur.
  issueDescription: string;
  issuePhotos: string[];
  affectedProducts: AffectedProduct[];
  // Root cause + prevention. category/action/owner live here; the actual
  // status tracking moves to a future Prevention Tracker portal — the
  // case detail just OPENS the prevention task.
  rootCauseCategory: RootCauseCategory | null;
  rootCauseNotes: string;
  rootCauseDetails: RootCauseDetails;
  preventionAction: string;
  preventionStatus: PreventionStatus;
  preventionOwner: string;
  // Action log — chronological entries the agent logs over the case's
  // lifetime (called the customer, scheduled inspection, sent parts).
  actionLog: ActionLogEntry[];
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

// ROOT_CAUSE_LABELS now defined at the top of the file (next to the type
// definitions) since it's referenced by the dynamic CategoryDetailsForm
// component too — keep it co-located with the data sources.

// PREVENTION_STATUS_COLOR removed 2026-04-28 — status pill no longer
// shown on the case detail; tracking moves to a future Prevention Tracker
// portal. The DB column still defaults to 'PENDING'.

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

  // Customer lookup — surface the actual name + phone from the customer
  // master, so the header doesn't only show the customer code (operators
  // complained the bare code wasn't useful at-a-glance, 2026-04-29).
  const { data: custResp } = useCachedJson<{
    data?: Array<{ id: string; code?: string; name: string; phone?: string; mobile?: string }>;
  }>("/api/customers");
  const customerRecord = useMemo(() => {
    if (!caseDetail || !custResp?.data) return null;
    return (
      custResp.data.find((c) => c.id === caseDetail.customerId) ?? null
    );
  }, [caseDetail, custResp]);

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
          {/* Header customer row — includes name + phone from the customer
              master if we can match it by id, otherwise just falls back to
              the snapshot name stored on the case (covers older cases and
              EXTERNAL cases keyed by name only). */}
          <p className="text-xs text-[#6B7280] mt-1">
            Customer:{" "}
            <span className="font-medium">
              {customerRecord?.code ?? ""}
              {customerRecord?.code && customerRecord?.name ? " — " : ""}
              {customerRecord?.name ?? caseDetail.customerName}
            </span>
            {(() => {
              const phone = customerRecord?.phone || customerRecord?.mobile;
              return phone ? <span className="text-[#9CA3AF]"> ({phone})</span> : null;
            })()}
            {" · "}
            Source:{" "}
            {sourceHref ? (
              <Link to={sourceHref} className="text-[#6B5C32] hover:underline">
                {caseDetail.sourceType} {caseDetail.sourceNo || caseDetail.sourceId}
              </Link>
            ) : (
              <span>
                EXTERNAL
                {caseDetail.externalRef ? ` (${caseDetail.externalRef})` : ""}
                <span className="text-[#9CA3AF]"> — customer reported directly</span>
              </span>
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

      {/* Issue (editable) + photos.
          Issue Description carries the 5W story (what / when / who / where /
          result). It used to coexist with a separate "Why did this happen?"
          textarea on the RCA panel; operators flagged that as redundant on
          2026-04-28 so it's now one editable field, auto-saves on blur. */}
      <IssueDescriptionPanel
        caseDetail={caseDetail}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />
      <PhotosPanel
        caseDetail={caseDetail}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

      {/* Affected products — operator can attach 0..N SKUs the issue
          relates to. Optional (case might be a service complaint with no
          specific product). For SO/CO-sourced cases the operator can
          quickly add lines that match the source order's products. */}
      <AffectedProductsPanel
        caseDetail={caseDetail}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

      {/* Service-agent action log — chronological entries the agent logs
          over the case's lifetime (called customer, scheduled inspection,
          sent missing parts, etc.). */}
      <ActionLogPanel
        caseDetail={caseDetail}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

      {/* Root cause + prevention (open here; track elsewhere) */}
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
  const [details, setDetails] = useState<RootCauseDetails>(caseDetail.rootCauseDetails ?? {});
  const [action, setAction] = useState(caseDetail.preventionAction);
  // status no longer edited from this panel — see Prevention Tracker portal.
  const [owner, setOwner] = useState(caseDetail.preventionOwner);
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
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Root Cause &amp; Prevention</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Category — drives reporting / categorisation of recurrence.
            Changing the category resets the details JSON since the per-
            category fields are different shapes. */}
        <select
          value={category}
          onChange={(e) => {
            const next = e.target.value;
            setCategory(next);
            // Reset details when category changes — old fields don't apply.
            setDetails({});
            save({ rootCauseCategory: next || null, rootCauseDetails: {} });
          }}
          disabled={saving}
          className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-sm"
        >
          <option value="">Category — not yet assigned</option>
          {Object.entries(ROOT_CAUSE_LABELS).map(([v, t]) => (
            <option key={v} value={v}>{t}</option>
          ))}
        </select>

        {/* Per-category structured detail fields. Renders different inputs
            based on the category — depts for PRODUCTION, supplier+RM for
            MATERIAL, 3PL company for TRANSPORT, etc. */}
        {category && (
          <CategoryDetailsForm
            category={category as RootCauseCategory}
            value={details}
            onChange={(next) => {
              setDetails(next);
            }}
            onPersist={(next) => save({ rootCauseDetails: next })}
            disabled={saving}
          />
        )}
        {/* rootCauseNotes textarea removed 2026-04-28 — duplicate of Issue
            Description (the 5W story lives there now). */}
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
        {/* Per design 2026-04-28: case detail OPENS the prevention task; the
            actual progress tracking lives in a dedicated Prevention Tracker
            portal (not yet built). prevention_status defaults to 'PENDING'
            on the DB row so it shows up in the future portal automatically. */}
        <p className="text-[10px] text-[#9CA3AF]">
          Once the action + owner are set, the prevention task is opened. Progress
          tracking will live in the Prevention Tracker portal (coming soon).
        </p>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// IssueDescriptionPanel — editable issue description with the 5W template.
// ===========================================================================
// Inline edit on the case detail page. Auto-saves on blur. The previous
// design had this as a read-only display + a separate "Why did this happen?"
// textarea on the RCA panel; operators flagged that as redundant on
// 2026-04-28 so it's now one editable field.
function IssueDescriptionPanel({
  caseDetail,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [description, setDescription] = useState(caseDetail.issueDescription);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (description === caseDetail.issueDescription) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueDescription: description || null }),
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
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Issue Description{" "}
          <span className="text-[10px] font-normal text-[#9CA3AF]">
            (5W: when / who / where / what / result)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <textarea
          rows={6}
          value={description}
          onBlur={save}
          onChange={(e) => setDescription(e.target.value)}
          disabled={saving}
          placeholder={[
            "What happened? Use the 5W template:",
            "  When  — date / time of incident (e.g. 2026-04-29 10:30)",
            "  Who   — name (e.g. 3PL driver Ahmad / sales agent Wong)",
            "  Where — location (e.g. customer's living room, KL)",
            "  What  — what they did (e.g. dropped the sofa during unloading)",
            "  Result — what problem was caused (e.g. frame cracked at left armrest)",
          ].join("\n")}
          className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm font-mono"
        />
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// CategoryDetailsForm — per-category structured second-level inputs.
// ===========================================================================
// Renders different fields based on the selected root_cause_category.
//
// Design principle (2026-04-29 operator feedback): "种类太多了" — instead
// of forcing every variant into a rigid enum, each category has a small
// number of structured dropdowns (dept / product / supplier / 3PL — things
// that map to other masters) plus a free-text **issue notes** field with
// example placeholders. The placeholder lists examples in light grey so
// the operator sees the kind of detail to capture without being boxed in.
//
// Lazy fetches: only the active category's data source is loaded. Worker
// dropdowns also depend on the chosen department, so they re-fetch when
// dept changes.
//
// onChange fires on every keystroke / select change (so the field shows
// the latest value); onPersist fires on blur of free-text inputs and on
// every dropdown change (so saved state matches what the user sees).
function CategoryDetailsForm({
  category,
  value,
  onChange,
  onPersist,
  disabled,
}: {
  category: RootCauseCategory;
  value: RootCauseDetails;
  onChange: (next: RootCauseDetails) => void;
  onPersist: (next: RootCauseDetails) => void;
  disabled?: boolean;
}) {
  // Currently-selected department (used to filter the worker list for
  // PRODUCTION / PROCESS / PICKING). String "" → no dept yet.
  const deptCode = (value.departmentCode as string) ?? "";

  // Lazy fetches — only the active category's data source is loaded.
  const needsWorkers =
    (category === "PRODUCTION" || category === "PROCESS" || category === "PICKING") &&
    !!deptCode;
  const { data: workersResp } = useCachedJson<{
    data?: Array<{ id: string; name: string; empNo?: string; departmentCode?: string }>;
  }>(needsWorkers ? `/api/workers?departmentCode=${encodeURIComponent(deptCode)}` : null);

  const { data: prodResp } = useCachedJson<{
    data?: Array<{ id: string; code: string; name: string }>;
  }>(category === "DESIGN" ? "/api/products" : null);

  const { data: rmResp } = useCachedJson<{
    data?: Array<{
      id: string;
      itemCode: string;
      description?: string;
      itemGroup?: string;
      mainSupplierCode?: string;
    }>;
  }>(category === "MATERIAL" ? "/api/raw-materials" : null);

  const { data: supplierResp } = useCachedJson<{
    data?: Array<{ id: string; code?: string; name: string }>;
  }>(category === "MATERIAL" ? "/api/suppliers" : null);

  // When an RM is picked, look up suppliers bound to it via supplier-materials.
  // If none, the UI falls back to the full /api/suppliers list.
  const rmCode = (value.rawMaterialCode as string) ?? "";
  const { data: smResp } = useCachedJson<{
    data?: Array<{ supplierId: string; isMainSupplier?: boolean }>;
  }>(category === "MATERIAL" && rmCode ? `/api/supplier-materials?materialCode=${encodeURIComponent(rmCode)}` : null);

  const { data: vehResp } = useCachedJson<{
    data?: Array<{ id: string; companyName?: string; threePlCompany?: string }>;
  }>(category === "TRANSPORT" ? "/api/three-pl-vehicles" : null);

  // Wrap each derived list in useMemo so the empty-array fallback doesn't
  // create a new identity every render (would invalidate downstream useMemos).
  const workers = useMemo(() => workersResp?.data ?? [], [workersResp]);
  const products = useMemo(() => prodResp?.data ?? [], [prodResp]);
  const rawMaterials = useMemo(() => rmResp?.data ?? [], [rmResp]);
  const suppliers = useMemo(() => supplierResp?.data ?? [], [supplierResp]);

  // Distinct item groups derived from the RM master (so the operator only
  // sees groups that actually have RMs in the system, not a hardcoded list).
  const itemGroups = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawMaterials) {
      if (r.itemGroup) set.add(r.itemGroup);
    }
    return Array.from(set).sort();
  }, [rawMaterials]);

  // RMs filtered by the chosen item group (so picking "FABRIC" narrows
  // the next dropdown to fabric SKUs only). If no group chosen, show all.
  const selectedGroup = (value.itemGroup as string) ?? "";
  const rmsForGroup = useMemo(() => {
    if (!selectedGroup) return rawMaterials;
    return rawMaterials.filter((r) => r.itemGroup === selectedGroup);
  }, [rawMaterials, selectedGroup]);

  // Suppliers filtered by the picked RM (via supplier-materials). Falls
  // back to the full supplier list when no RM picked or no bindings exist.
  const suppliersForRm = useMemo(() => {
    if (!rmCode) return suppliers;
    const bound = smResp?.data ?? [];
    if (bound.length === 0) return suppliers;
    const ids = new Set(bound.map((b) => b.supplierId));
    return suppliers.filter((s) => ids.has(s.id));
  }, [rmCode, smResp, suppliers]);

  // Distinct 3PL company names from the vehicle list (vehicles share
  // company; same company may have multiple lorries).
  const threePlCompanies = useMemo(() => {
    const set = new Set<string>();
    for (const v of vehResp?.data ?? []) {
      const name = v.companyName || v.threePlCompany || "";
      if (name) set.add(name);
    }
    return Array.from(set).sort();
  }, [vehResp]);

  // Product search box state for DESIGN — empty query shows nothing
  // (avoids dumping the full SKU list).
  const [productSearch, setProductSearch] = useState("");
  const productMatches = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .slice(0, 10);
  }, [productSearch, products]);

  function patch(partial: RootCauseDetails) {
    const next = { ...value, ...partial };
    onChange(next);
    onPersist(next);
  }
  function patchOnly(partial: RootCauseDetails) {
    onChange({ ...value, ...partial });
  }
  function persistAll() {
    onPersist(value);
  }

  // Reusable worker dropdown — depends on dept being set. Lower-case
  // function returning JSX (called as `{renderWorkerDropdown()}`) instead
  // of a component, to satisfy react-hooks/static-components.
  function renderWorkerDropdown() {
    if (!deptCode) {
      return (
        <select
          disabled
          className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs text-[#9CA3AF]"
        >
          <option>Worker / PIC — pick department first</option>
        </select>
      );
    }
    return (
      <select
        value={(value.workerId as string) ?? ""}
        onChange={(e) => {
          const w = workers.find((x) => x.id === e.target.value);
          patch({
            workerId: e.target.value || null,
            workerName: w?.name ?? null,
            workerEmpNo: w?.empNo ?? null,
          });
        }}
        disabled={disabled}
        className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
      >
        <option value="">Worker / PIC — pick one (optional)</option>
        {workers.map((w) => (
          <option key={w.id} value={w.id}>
            {w.empNo ? `${w.empNo} — ` : ""}{w.name}
          </option>
        ))}
      </select>
    );
  }

  switch (category) {
    case "PRODUCTION":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          <select
            value={deptCode}
            onChange={(e) => {
              const dept = PRODUCTION_DEPTS.find((d) => d.code === e.target.value);
              // Resetting dept also clears worker (worker filtered by dept).
              patch({
                departmentCode: e.target.value || null,
                departmentName: dept?.name ?? null,
                workerId: null,
                workerName: null,
                workerEmpNo: null,
              });
            }}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">Department — pick one</option>
            {PRODUCTION_DEPTS.map((d) => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </select>
          {renderWorkerDropdown()}
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="Where in the process? e.g. left armrest sewing seam, leg joinery glue gap, foam wrapping uneven, framing nail spacing wrong…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
        </div>
      );

    case "DESIGN":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          {/* Product search-then-pick. Once picked, shows the chosen
              product as a chip with × to clear. */}
          {value.productId ? (
            <div className="flex items-center justify-between rounded border border-[#E2DDD8] bg-white px-2 py-1 text-xs">
              <span>
                <span className="font-mono text-[#6B5C32]">{(value.productCode as string) ?? ""}</span>
                <span className="text-[#9CA3AF]"> — </span>
                <span>{(value.productName as string) ?? ""}</span>
              </span>
              <button
                type="button"
                onClick={() =>
                  patch({ productId: null, productCode: null, productName: null })
                }
                disabled={disabled}
                className="text-[#9A3A2D] hover:text-[#7A2E24]"
                title="Clear product"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                disabled={disabled}
                placeholder="Search product by code or name (e.g. SOFA-3S, BED-Q)"
                className="h-8 text-xs"
              />
              {productMatches.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded border border-[#E2DDD8] bg-white shadow-sm max-h-48 overflow-auto">
                  {productMatches.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProductSearch("");
                        patch({
                          productId: p.id,
                          productCode: p.code,
                          productName: p.name,
                        });
                      }}
                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-[#FAF7F0]"
                    >
                      <span className="font-mono text-[#6B5C32]">{p.code}</span>
                      <span className="text-[#9CA3AF]"> — </span>
                      <span>{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Department — which dept can't fulfill this design (so R&D
              knows who to talk to about the spec change). */}
          <select
            value={(value.designDeptCode as string) ?? ""}
            onChange={(e) => {
              const dept = ALL_DEPTS.find((d) => d.code === e.target.value);
              patch({
                designDeptCode: e.target.value || null,
                designDeptName: dept?.name ?? null,
              });
            }}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">Which department can't follow the design? — pick one</option>
            {ALL_DEPTS.map((d) => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </select>
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={3}
            placeholder="What's wrong with the design? e.g. fabric size off by 2cm, wood template nailed at wrong position, foam density too soft, cardboard too thin, hardware mismatch, dimensions wrong, assembly instructions unclear…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
          <Input
            type="text"
            value={(value.suggestedFix as string) ?? ""}
            onChange={(e) => patchOnly({ suggestedFix: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            placeholder="Suggested fix (one line, optional)"
            className="h-8 text-xs"
          />
        </div>
      );

    case "MATERIAL":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          {/* Cascade: Item group → RM (filtered) → Supplier (filtered) */}
          <select
            value={selectedGroup}
            onChange={(e) => {
              // Changing group resets the RM + supplier (they were tied
              // to the previous group).
              patch({
                itemGroup: e.target.value || null,
                rawMaterialId: null,
                rawMaterialCode: null,
                supplierId: null,
                supplierName: null,
              });
            }}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">Item group — pick one</option>
            {itemGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          <select
            value={(value.rawMaterialId as string) ?? ""}
            onChange={(e) => {
              const rm = rawMaterials.find((x) => x.id === e.target.value);
              patch({
                rawMaterialId: e.target.value || null,
                rawMaterialCode: rm?.itemCode ?? null,
                // Auto-fill group when RM is picked (in case operator picked RM first without group).
                itemGroup: rm?.itemGroup ?? selectedGroup ?? null,
                // Reset supplier so they pick a supplier bound to the new RM.
                supplierId: null,
                supplierName: null,
              });
            }}
            disabled={disabled || rmsForGroup.length === 0}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">
              {selectedGroup
                ? `Raw material in ${selectedGroup} — pick one`
                : "Raw material — pick one (or pick group above first)"}
            </option>
            {rmsForGroup.map((r) => (
              <option key={r.id} value={r.id}>
                {r.itemCode}{r.description ? ` — ${r.description}` : ""}
              </option>
            ))}
          </select>
          <select
            value={(value.supplierId as string) ?? ""}
            onChange={(e) => {
              const s = suppliers.find((x) => x.id === e.target.value);
              patch({ supplierId: e.target.value || null, supplierName: s?.name ?? null });
            }}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">
              {rmCode
                ? `Supplier of ${rmCode} — pick one`
                : "Supplier — pick one"}
            </option>
            {suppliersForRm.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code ? `${s.code} — ` : ""}{s.name}
              </option>
            ))}
          </select>
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="GRN # / batch / specifics — e.g. fabric color faded after wash, foam crumbling within 6 months, wood warped, hardware threads stripped, GRN-2604-013 batch was off-spec…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
        </div>
      );

    case "PROCESS":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          <select
            value={deptCode}
            onChange={(e) => {
              const dept = ALL_DEPTS.find((d) => d.code === e.target.value);
              patch({
                departmentCode: e.target.value || null,
                departmentName: dept?.name ?? null,
                workerId: null,
                workerName: null,
                workerEmpNo: null,
              });
            }}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">Department — pick one</option>
            {ALL_DEPTS.map((d) => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </select>
          {renderWorkerDropdown()}
          <Input
            type="text"
            value={(value.sopName as string) ?? ""}
            onChange={(e) => patchOnly({ sopName: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            placeholder="SOP name (e.g. 'pre-shipment dust-cover check')"
            className="h-8 text-xs"
          />
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="Gap details — e.g. SOP missing entirely, outdated wording, skipped under time pressure, worker not trained, jig/tool missing, SOP wording too ambiguous, only senior knows it…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
        </div>
      );

    case "CUSTOMER":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="Sub-reason — e.g. misuse, wrong measurement (door / space), pet damage, wrong cleaning chemical, buyer's remorse, wrong setup at home…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
          <p className="text-[10px] text-[#9CA3AF]">
            The 5W story stays in the Issue Description above. This sub-reason is for category
            roll-ups only — keep it short.
          </p>
        </div>
      );

    case "TRANSPORT":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          <select
            value={(value.threePlCompany as string) ?? ""}
            onChange={(e) => patch({ threePlCompany: e.target.value || null })}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">3PL Company — pick one</option>
            {threePlCompanies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="Issue — e.g. dropped during unloading, scraped against wall, water damage from open truck, wrong route / address, late delivery, customer not contacted before arrival…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
          <Input
            type="text"
            value={(value.doNo as string) ?? ""}
            onChange={(e) => patchOnly({ doNo: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            placeholder="DO# (optional, helps reconcile to a specific delivery)"
            className="h-8 text-xs"
          />
          <Input
            type="text"
            value={(value.driverName as string) ?? ""}
            onChange={(e) => patchOnly({ driverName: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            placeholder="Driver name (optional)"
            className="h-8 text-xs"
          />
        </div>
      );

    case "SALES":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          <Input
            type="text"
            value={(value.salesPerson as string) ?? ""}
            onChange={(e) => patchOnly({ salesPerson: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            placeholder="Sales person name"
            className="h-8 text-xs"
          />
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="Order error — e.g. size wrong, color wrong, fabric spec off, leg / divan height off, price / discount entered wrong, missing add-on, wrong delivery address…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
        </div>
      );

    case "PICKING":
      return (
        <div className="space-y-2 rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          <select
            value={deptCode}
            onChange={(e) => {
              const dept = ALL_DEPTS.find((d) => d.code === e.target.value);
              patch({
                departmentCode: e.target.value || null,
                departmentName: dept?.name ?? null,
                workerId: null,
                workerName: null,
                workerEmpNo: null,
              });
            }}
            disabled={disabled}
            className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            <option value="">Department — pick one</option>
            <option value="PACKING">Packing</option>
            <option value="WAREHOUSING">Warehousing</option>
          </select>
          {renderWorkerDropdown()}
          <textarea
            value={(value.notes as string) ?? ""}
            onChange={(e) => patchOnly({ notes: e.target.value })}
            onBlur={persistAll}
            disabled={disabled}
            rows={2}
            placeholder="Issue — e.g. legs missing, hardware bag missing, manual missing, wrong product shipped, manifest says X but actual Y, mislabeled box, packaging damaged before shipment, quantity off, accessory missing…"
            className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-xs placeholder:text-[#C4B59A]"
          />
        </div>
      );

    case "OTHER":
      return (
        <p className="text-[10px] text-[#9CA3AF] rounded border border-[#E8D8B2] bg-[#FAF7F0] p-2">
          No structured fields for "Other". The Issue Description above (5W) carries the detail.
        </p>
      );

    default:
      return null;
  }
}

// ===========================================================================
// AffectedProductsPanel — attach 0..N product SKUs to the case.
// ===========================================================================
// Optional: a case might be about a single product, a multi-product order,
// or zero products (a customer service complaint about delivery, billing,
// etc.). Operator can search-add and remove SKUs; persisted as JSON on
// service_cases.affected_product_ids (migration 0077).
function AffectedProductsPanel({
  caseDetail,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const { data: prodResp } = useCachedJson<{
    data?: Array<{ id: string; code: string; name: string }>;
  }>("/api/products");
  const products = useMemo(() => prodResp?.data ?? [], [prodResp]);

  // Filter products that are NOT already attached, and match the search
  // term (operator types a few chars; no result dump until they search).
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const already = new Set(caseDetail.affectedProducts.map((p) => p.productId));
    return products
      .filter((p) => !already.has(p.id))
      .filter(
        (p) =>
          p.code.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [search, products, caseDetail.affectedProducts]);

  async function persist(next: AffectedProduct[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affectedProducts: next }),
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

  function addProduct(p: { id: string; code: string; name: string }) {
    const next = [
      ...caseDetail.affectedProducts,
      { productId: p.id, code: p.code, name: p.name, qty: null },
    ];
    setSearch("");
    void persist(next);
  }

  function removeProduct(productId: string) {
    void persist(caseDetail.affectedProducts.filter((p) => p.productId !== productId));
  }

  function setQty(productId: string, qty: number | null) {
    const next = caseDetail.affectedProducts.map((p) =>
      p.productId === productId ? { ...p, qty } : p,
    );
    void persist(next);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Affected Products ({caseDetail.affectedProducts.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Search-then-add. Empty query shows no list (avoids dropdown
            of 1000+ SKUs). Click a result to add. */}
        <div className="relative">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={saving}
            placeholder="Search product by code or name to add (optional — leave empty if no specific SKU)"
            className="h-8 text-xs"
          />
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded border border-[#E2DDD8] bg-white shadow-sm max-h-48 overflow-auto">
              {matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addProduct(p)}
                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-[#FAF7F0]"
                >
                  <span className="font-mono text-[#6B5C32]">{p.code}</span>
                  <span className="text-[#9CA3AF]"> — </span>
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {caseDetail.affectedProducts.length === 0 ? (
          <p className="text-[10px] text-[#9CA3AF]">
            No products attached. Optional — only add if the issue is tied to
            specific SKUs. SO/CO-sourced cases can also reference the source
            order's lines without re-attaching them here.
          </p>
        ) : (
          <ul className="divide-y divide-[#E2DDD8] border border-[#E2DDD8] rounded">
            {caseDetail.affectedProducts.map((p) => (
              <li
                key={p.productId}
                className="flex items-center justify-between px-2 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[#6B5C32]">{p.code}</span>
                  <span className="text-[#9CA3AF]"> — </span>
                  <span className="text-[#1F1D1B]">{p.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    value={p.qty ?? ""}
                    onChange={(e) => {
                      const n = e.target.value === "" ? null : Number(e.target.value);
                      setQty(p.productId, Number.isFinite(n as number) ? n : null);
                    }}
                    disabled={saving}
                    placeholder="Qty"
                    className="h-7 w-16 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeProduct(p.productId)}
                    disabled={saving}
                    className="text-[#9A3A2D] hover:text-[#7A2E24]"
                    title="Remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// PhotosPanel — view + add + remove photos on a case after creation.
// ===========================================================================
// Always rendered (even when zero photos) so the operator can see where to
// upload more photos that came in via WhatsApp / customer follow-up. Same
// resize-to-base64 pipeline as the create modal.
function PhotosPanel({
  caseDetail,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  // Per-batch upload progress for the off-main-thread compressor — null when idle.
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  async function persist(next: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issuePhotos: next }),
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

  // Image compression delegated to @/lib/image-compress (off-main-thread on
  // browsers that support OffscreenCanvas, fallback elsewhere).

  async function handleAdd(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploadProgress({ done: 0, total: list.length });
    const added: string[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        try {
          added.push(await compressImage(f, { maxDim: 1280, quality: 0.85 }));
        } catch {
          toast.error(`Couldn't read ${f.name}`);
        }
        setUploadProgress({ done: i + 1, total: list.length });
      }
    } finally {
      setUploadProgress(null);
    }
    if (added.length === 0) return;
    void persist([...caseDetail.issuePhotos, ...added]);
  }

  function handleRemove(idx: number) {
    void persist(caseDetail.issuePhotos.filter((_, i) => i !== idx));
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Photos ({caseDetail.issuePhotos.length})</CardTitle>
        <label className="inline-flex items-center gap-2 cursor-pointer rounded border border-[#E2DDD8] bg-white hover:bg-[#FAF9F7] px-3 py-1.5 text-xs">
          <Plus className="h-3.5 w-3.5" />
          {caseDetail.issuePhotos.length === 0 ? "Add photos" : "Add more photos"}
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={saving}
            onChange={(e) => {
              handleAdd(e.target.files);
              e.target.value = "";
            }}
            className="hidden"
          />
        </label>
      </CardHeader>
      <CardContent>
        {uploadProgress && (
          <div className="mb-2 inline-flex items-center gap-2 rounded-md bg-[#FAF9F7] border border-[#E2DDD8] px-3 py-1.5 text-xs text-[#6B7280]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Compressing photos {Math.min(uploadProgress.done + 1, uploadProgress.total)} / {uploadProgress.total}...
          </div>
        )}
        {caseDetail.issuePhotos.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">
            No photos yet. Click "Add photos" to attach customer-supplied images
            of the issue. They'll show as thumbnails — click any to open full-size.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {caseDetail.issuePhotos.map((p, i) => (
              <div key={i} className="relative group">
                <a href={p} target="_blank" rel="noopener noreferrer">
                  <img
                    src={p}
                    alt={`Photo ${i + 1}`}
                    className="h-24 w-24 rounded border border-[#E2DDD8] object-cover hover:border-[#6B5C32]"
                  />
                </a>
                <button
                  type="button"
                  onClick={() => handleRemove(i)}
                  disabled={saving}
                  className="absolute -top-1 -right-1 rounded-full bg-white border border-[#E2DDD8] p-0.5 text-[#9A3A2D] hover:text-[#7A2E24] shadow-sm"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// ActionLogPanel — Service-agent log of actions taken over the case lifetime.
// ===========================================================================
// Stored as JSON array on service_cases.action_log. Each entry: { id, date,
// description, createdAt, createdByName? }. Auto-saves on blur of any field
// or when entries are added/removed.
function ActionLogPanel({
  caseDetail,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const user = getCurrentUser();
  const [entries, setEntries] = useState<ActionLogEntry[]>(caseDetail.actionLog ?? []);
  const [saving, setSaving] = useState(false);

  async function persist(next: ActionLogEntry[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionLog: next }),
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

  function addEntry() {
    const next = [
      ...entries,
      {
        id: `act-${Math.random().toString(36).slice(2, 8)}`,
        date: new Date().toISOString().slice(0, 10),
        description: "",
        createdAt: new Date().toISOString(),
        createdByName: user?.displayName ?? user?.email ?? "",
      },
    ];
    setEntries(next);
    // Don't persist yet — operator will fill in the description first.
    // Save fires on blur of the description field.
  }
  function patchEntry(id: string, patch: Partial<ActionLogEntry>) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function removeEntry(id: string) {
    const next = entries.filter((e) => e.id !== id);
    setEntries(next);
    void persist(next);
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Action Taken (Service Agent Log)</CardTitle>
        <Button size="sm" variant="outline" onClick={addEntry} disabled={saving}>
          <Plus className="mr-1 h-3 w-3" /> Add Entry
        </Button>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">
            Log each action you take on this case (called customer, scheduled
            inspection, sent missing part, etc.). Click "Add Entry" to start.
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-2">
                <Input
                  type="date"
                  value={e.date}
                  onChange={(ev) => patchEntry(e.id, { date: ev.target.value })}
                  onBlur={() => void persist(entries)}
                  className="h-8 w-[150px] text-xs"
                />
                <Input
                  type="text"
                  value={e.description}
                  onChange={(ev) => patchEntry(e.id, { description: ev.target.value })}
                  onBlur={() => void persist(entries)}
                  placeholder="What did you do? (e.g. Called customer, scheduled on-site inspection)"
                  className="h-8 flex-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => removeEntry(e.id)}
                  className="text-[#9A3A2D] hover:text-[#7A2E24] p-1"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
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
  // Mode must be picked at spawn time — the "Decide later" option was
  // dropped from the picker because it doesn't make sense once you've
  // chosen to spawn an order.
  const canSubmit = linesOk && mode !== null;

  async function handleSubmit() {
    if (!canSubmit) return;
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

          {/* Mode — required at spawn time. "Decide later" only makes sense
              at the CASE level (case stays open without an order); by the
              time you're spawning the order itself, you've decided how
              you're going to resolve. */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">Resolution Mode</label>
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
            disabled={!canSubmit || submitting}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {submitting ? "Spawning…" : "Spawn Order"}
          </Button>
        </div>
      </div>
    </div>
  );
}
