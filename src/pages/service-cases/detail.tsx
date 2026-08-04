// ---------------------------------------------------------------------------
// Service Case detail — case info + nested orders + spawn-order modal.
//
// This is the operator's primary screen for working a service case. It
// shows the customer issue + photos + RCA at the top; below, the list of
// any service orders spawned for this case, plus a "Spawn Service Order"
// button to open a new resolution flow (REPRODUCE / STOCK_SWAP / REPAIR).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavGuard } from "@/lib/use-nav-guard";
import { todayYmdMY } from "@/lib/utils";
import {
  computeCasePipeline,
  CASE_PIPELINE_STEPS,
  type CasePipelineResult,
} from "@/lib/case-pipeline";
import { parseRepairScope, repairScopeBadgeLabel } from "@/lib/repair-scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import { DocumentChainMap } from "@/components/ui/document-chain-map";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { getCurrentUser } from "@/lib/auth";
import { compressImage } from "@/lib/image-compress";
import {
  ArrowLeft, CheckCircle2, XCircle, RotateCcw, Plus, X, Wrench, AlertCircle, Loader2,
  Pencil, Check, Download,
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
  { code: "FOAM_CUTTING", name: "Foam Cutting" },
  { code: "FOAM", name: "Foam Bonding" },
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
  // Damaged-part picks captured in the create modal (keys from
  // GET /api/sales-orders/repair-components). Read-only chips here —
  // absent = all parts.
  components?: Array<{ key: string; label: string; qty: number }>;
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
  // Responsible Unit — owner-level attribution of which business unit
  // caused the issue. NULL until assigned (migration 0166).
  responsibleUnit: string | null;
  rootCauseNotes: string;
  rootCauseDetails: RootCauseDetails;
  // Multi root causes (migration 0169) — a case can have several. Always
  // provided by the GET (synthesized from the legacy single category/details
  // for old cases). The legacy rootCauseCategory / rootCauseDetails above stay
  // as a mirror of the first entry for the list "Category" column.
  rootCauses: Array<{ category: string; details: RootCauseDetails }>;
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
  // ISO timestamp the case first hit IN_PROGRESS (migration 0168). Dates the
  // Investigating stage of the Case Pipeline. "" / null until first marked.
  investigatingAt?: string | null;
  notes: string;
  orders: Array<{
    id: string;
    serviceOrderNo: string;
    mode: Mode | null;
    status: string;
    createdAt: string;
    // true = SV Service Order (sales_orders row linked via caseid) —
    // detail lives at /service-order/:id, not /service-orders/:id.
    isSv?: boolean;
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
  // Mirrors the backend STATUS_TRANSITIONS — the PUT re-validates.
  CANCELLED: ["OPEN", "IN_PROGRESS"],
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
  const { confirm, confirmDialog } = useConfirm();
  const navigate = useNavigate();
  const user = getCurrentUser();

  const { data: resp, refresh } = useCachedJson<{ data?: ServiceCaseDetail }>(
    `/api/service-cases/${id}`,
  );
  const caseDetail = resp?.data;

  // Customer lookup — surface the actual name + phone from the customer
  // master, so the header doesn't only show the customer code (operators
  // complained the bare code wasn't useful at-a-glance, 2026-04-29).
  const { data: custResp } = useCachedJson<{
    data?: Array<{
      id: string;
      code?: string;
      name: string;
      phone?: string;
      mobile?: string;
      contactName?: string;
      email?: string;
      companyAddress?: string;
      deliveryHubs?: Array<{
        state?: string;
        address?: string;
        isDefault?: boolean;
      }>;
    }>;
  }>("/api/customers");
  const customerRecord = useMemo(() => {
    if (!caseDetail || !custResp?.data) return null;
    return (
      custResp.data.find((c) => c.id === caseDetail.customerId) ?? null
    );
  }, [caseDetail, custResp]);

  // Default delivery hub (or the first one) — used for the "Delivery To"
  // line on the printed report.
  const deliveryHub = useMemo(() => {
    const hubs = customerRecord?.deliveryHubs ?? [];
    if (hubs.length === 0) return null;
    return hubs.find((h) => h.isDefault) ?? hubs[0];
  }, [customerRecord]);

  // ── Pipeline + production-order inputs, lifted to the page level ────────
  // The Case Pipeline stepper and the Download-PDF handler both need the
  // case's delivery orders + production orders (matched by salesOrderId
  // against the case's SV order ids). Lift the two cached fetches here so
  // both consumers share one fetch (no double round-trip) and the PDF can
  // derive the timeline + repair scope without re-fetching inside the lib.
  const svOrderIds = useMemo(
    () => (caseDetail?.orders ?? []).filter((o) => o.isSv).map((o) => o.id),
    [caseDetail],
  );
  const { data: doResp } = useCachedJson<{
    data?: Array<{
      id: string;
      salesOrderId?: string;
      status?: string;
      createdAt?: string | null;
      dispatchedAt?: string | null;
      deliveredAt?: string | null;
    }>;
  }>(svOrderIds.length > 0 ? "/api/delivery-orders" : null);
  const { data: poResp } = useCachedJson<{
    data?: Array<{
      id: string;
      salesOrderId?: string | null;
      companySOId?: string | null;
      customerPOId?: string | null;
      customerReference?: string | null;
      repairScope?: string | null;
      repairscope?: string | null;
      jobCards?: Array<{ completedDate?: string | null }>;
    }>;
  }>(
    svOrderIds.length > 0
      ? "/api/production-orders?fields=minimal&include=jobCards"
      : null,
  );

  // Computed pipeline (single source — same helper the stepper uses).
  const pipe = useMemo(() => {
    if (!caseDetail) return null;
    return computeCasePipeline({
      caseStatus: caseDetail.status,
      createdAt: caseDetail.createdAt,
      investigatingAt: caseDetail.investigatingAt ?? null,
      closedAt: caseDetail.closedAt || null,
      orders: caseDetail.orders.map((o) => ({
        isSv: o.isSv,
        status: o.status,
        createdAt: o.createdAt,
      })),
      dos: doResp?.data ?? [],
      pos: poResp?.data ?? [],
      svOrderIds,
    });
  }, [caseDetail, doResp, poResp, svOrderIds]);

  // The case's production orders (matched by salesOrderId to its SV orders).
  const casePos = useMemo(() => {
    const ids = new Set(svOrderIds);
    return (poResp?.data ?? []).filter(
      (p) => !!p.salesOrderId && ids.has(p.salesOrderId),
    );
  }, [poResp, svOrderIds]);

  // Repair scope per spawned service order — derived from each SV order's
  // production-order repairscope (one scope per SO; presets/components share
  // the line scope, so the first PO carrying a scope is representative).
  const repairScopes = useMemo(() => {
    const out: Array<{ orderNo: string; label: string }> = [];
    const seen = new Set<string>();
    for (const p of casePos) {
      const soId = p.salesOrderId ?? "";
      if (!soId || seen.has(soId)) continue;
      seen.add(soId);
      const scope = parseRepairScope(p.repairScope ?? p.repairscope ?? null);
      out.push({
        orderNo: p.companySOId || p.salesOrderId || "Service Order",
        label: repairScopeBadgeLabel(scope),
      });
    }
    return out;
  }, [casePos]);

  // Customer-side references on the source order, snapshotted onto the case's
  // SV production orders (copied through the spawn flow). First non-empty wins.
  const customerRefs = useMemo(() => {
    let po = "";
    let ref = "";
    for (const p of casePos) {
      if (!po && p.customerPOId) po = p.customerPOId;
      if (!ref && p.customerReference) ref = p.customerReference;
    }
    return { po, ref };
  }, [casePos]);

  // Which SO anchors the relationship map. A case is not itself a document in
  // the sales chain, so it borrows one: the first spawned SV order (a
  // sales_orders row — the LIVE repair, whose production/delivery the case is
  // actually chasing), falling back to the source SO when nothing has been
  // spawned yet. CO-sourced and EXTERNAL cases have no sales_orders row to
  // anchor on, so they render no map.
  const chainAnchorSoId = useMemo(() => {
    const sv = (caseDetail?.orders ?? []).find((o) => o.isSv);
    if (sv?.id) return sv.id;
    if (caseDetail?.sourceType === "SO" && caseDetail.sourceId)
      return caseDetail.sourceId;
    return "";
  }, [caseDetail]);

  const [advancing, setAdvancing] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  // The whole case is READ-ONLY until "Edit" is clicked (no silent auto-save /
  // "裸奔"; owner wants an explicit edit function like the SO detail).
  const [editing, setEditing] = useState(false);

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
      {/* Header */}
      <ObjectPageHeader
        backTo="/service-cases"
        title={caseDetail.caseNo}
        badges={
          <span
            className={`text-[10px] uppercase px-2 py-0.5 rounded ${STATUS_COLOR[caseDetail.status] ?? "bg-[#F4EFE3]"}`}
          >
            {caseDetail.status}
          </span>
        }
        subtitle={
          /* Header customer row — includes name + phone from the customer
             master if we can match it by id, otherwise just falls back to
             the snapshot name stored on the case (covers older cases and
             EXTERNAL cases keyed by name only). */
          <>
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
                {/* sourceNo already carries its SO-/CO- prefix — don't prepend
                    the type again (was "SO SO-2605-198"). */}
                {caseDetail.sourceNo || caseDetail.sourceId}
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
          </>
        }
        actions={
          <>
          {/* Download a one-page Service Case report (info + issue + photos +
              affected products + root cause + action log). Always available. */}
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { generateServiceCasePdf } = await import(
                "@/lib/generate-service-case-pdf"
              );
              const firstCat =
                caseDetail.rootCauses?.[0]?.category ||
                caseDetail.rootCauseCategory ||
                "";
              generateServiceCasePdf({
                caseNo: caseDetail.caseNo,
                status: caseDetail.status,
                customerName: customerRecord?.name ?? caseDetail.customerName,
                customerCode: customerRecord?.code ?? null,
                customerPhone:
                  customerRecord?.phone ?? customerRecord?.mobile ?? null,
                customerContact: customerRecord?.contactName ?? null,
                customerEmail: customerRecord?.email ?? null,
                customerAddress: customerRecord?.companyAddress ?? null,
                deliveryAddress: deliveryHub?.address ?? null,
                deliveryState: deliveryHub?.state ?? null,
                sourceType: caseDetail.sourceType,
                sourceNo: caseDetail.sourceNo,
                customerPO: customerRefs.po || null,
                customerRef: customerRefs.ref || null,
                externalRef: caseDetail.externalRef,
                category: firstCat
                  ? ROOT_CAUSE_LABELS[firstCat] ?? firstCat
                  : null,
                createdByName: caseDetail.createdByName,
                createdAt: caseDetail.createdAt,
                investigatingAt: caseDetail.investigatingAt,
                closedAt: caseDetail.closedAt,
                customerState: caseDetail.customerState,
                responsibleUnit: caseDetail.responsibleUnit,
                issueDescription: caseDetail.issueDescription,
                notes: caseDetail.notes,
                issuePhotos: caseDetail.issuePhotos,
                affectedProducts: caseDetail.affectedProducts?.map((p) => ({
                  code: p.code,
                  name: p.name,
                  qty: p.qty,
                  components: p.components,
                })),
                rootCauses: caseDetail.rootCauses,
                preventionAction: caseDetail.preventionAction,
                preventionOwner: caseDetail.preventionOwner,
                actionLog: caseDetail.actionLog?.map((a) => ({
                  date: a.date,
                  description: a.description,
                  createdByName: a.createdByName,
                })),
                orders: caseDetail.orders?.map((o) => ({
                  serviceOrderNo: o.serviceOrderNo,
                  mode: o.mode,
                  status: o.status,
                  isSv: o.isSv,
                  createdAt: o.createdAt,
                })),
                repairScopes,
                // Status timeline — one row per pipeline stage with its
                // completion + a date where the case carries one. The shared
                // computeCasePipeline only returns enteredAt for the CURRENT
                // stage, so show that against the last done step; the three
                // stages with their own stored timestamps (Opened / Investigating
                // / Closed) fill from the case row directly.
                timeline: pipe
                  ? CASE_PIPELINE_STEPS.map((step, i) => {
                      let date: string | null = null;
                      if (i === 0) date = caseDetail.createdAt || null;
                      else if (i === 1)
                        date =
                          caseDetail.investigatingAt ??
                          caseDetail.createdAt ??
                          null;
                      else if (i === CASE_PIPELINE_STEPS.length - 1)
                        date = caseDetail.closedAt || null;
                      if (i === pipe.index && !date) date = pipe.enteredAt;
                      return { step, done: pipe.doneFlags[i], date };
                    })
                  : undefined,
              });
            }}
          >
            <Download className="h-4 w-4" /> Download PDF
          </Button>
          {/* Edit ⇄ Done — the case info below is locked until you click Edit
              (no silent auto-save). Shown for every status except a cancelled
              case (closed cases can still be corrected / have RCA added). */}
          {caseDetail.status !== "CANCELLED" && (
            <Button
              variant={editing ? "primary" : "outline"}
              size="sm"
              onClick={() => setEditing((v) => !v)}
              className={
                editing ? "bg-[#6B5C32] text-white hover:bg-[#5a4d2a]" : undefined
              }
            >
              {editing ? (
                <>
                  <Check className="h-4 w-4" /> Done Editing
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4" /> Edit
                </>
              )}
            </Button>
          )}
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
              onClick={async () => {
                if (
                  await confirm({
                    title: "Close this case?",
                    message: `Mark ${caseDetail.caseNo} as CLOSED. A closed case can't be reopened or have new service orders spawned.`,
                    confirmLabel: "Close Case",
                  })
                )
                  advanceStatus("CLOSED");
              }}
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
              onClick={async () => {
                if (
                  await confirm({
                    title: "Cancel this case?",
                    message: `Mark ${caseDetail.caseNo} as CANCELLED. You can undo this from this page afterwards.`,
                    confirmLabel: "Cancel Case",
                    cancelLabel: "Keep Open",
                    tone: "danger",
                  })
                )
                  advanceStatus("CANCELLED");
              }}
            >
              <XCircle className="h-4 w-4" /> Cancel
            </Button>
          )}
          {/* Undo Cancel — a case is an operator record, so cancelling it
              spawns nothing to unwind and the reverse is just the status plus
              a cleared closedAt. Returns to the state the cancel interrupted;
              cases cancelled before pre_cancel_status existed fall back to
              OPEN. Owner 2026-08-04: "我要怎么 uncancel 回来呢？" */}
          {caseDetail.status === "CANCELLED" && (
            <Button
              variant="primary"
              size="sm"
              disabled={advancing}
              onClick={async () => {
                const target =
                  ((caseDetail as { preCancelStatus?: string }).preCancelStatus as CaseStatus) ||
                  "OPEN";
                if (
                  await confirm({
                    title: "Undo the cancel?",
                    message: `Restore ${caseDetail.caseNo} to ${target}. Any service orders under it are unaffected — they were never cancelled by this.`,
                    confirmLabel: "Undo Cancel",
                    cancelLabel: "Leave Cancelled",
                  })
                )
                  advanceStatus(target);
              }}
            >
              <RotateCcw className="h-4 w-4" /> Undo Cancel
            </Button>
          )}
          </>
        }
      />

      {/* Edit-mode banner — makes it obvious the case info below is now
          unlocked (so the explicit edit function is never "看不到"). */}
      {editing && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[#E8D8B2] bg-[#FAF7F0] px-3 py-2 text-xs text-[#6B5232]">
          <span className="inline-flex items-center gap-1.5">
            <Pencil className="h-3.5 w-3.5" />
            Editing — the case info below is unlocked. Each section has its own
            Save; click <span className="font-semibold">Done Editing</span> when finished.
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setEditing(false)}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            <Check className="h-4 w-4" /> Done Editing
          </Button>
        </div>
      )}

      {/* Case pipeline — auto-computed progress stepper, display-only.
          Derived from the case status + attached orders + their delivery
          orders; nothing here writes. The derivation (computeCasePipeline) is
          lifted to the page level so the Download-PDF handler shares it. */}
      {pipe && <CasePipeline pipe={pipe} />}

      {/* Issue (editable) + photos.
          Issue Description carries the 5W story (what / when / who / where /
          result). It used to coexist with a separate "Why did this happen?"
          textarea on the RCA panel; operators flagged that as redundant on
          2026-04-28 so it's now one editable field, auto-saves on blur. */}
      <IssueDescriptionPanel
        caseDetail={caseDetail}
        editing={editing}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />
      <PhotosPanel
        caseDetail={caseDetail}
        editing={editing}
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
        editing={editing}
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
              onClick={() => {
                // SO/CO cases hand off to the service-order create page,
                // pre-filled from the case (source lines narrowed to the
                // affected products + their damaged-part picks). EXTERNAL
                // cases keep the legacy modal — no source order to copy.
                if (caseDetail.sourceType === "SO" || caseDetail.sourceType === "CO") {
                  navigate(`/service-order/create?fromCase=${caseDetail.id}`);
                } else {
                  setSpawnOpen(true);
                }
              }}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              {/* Re-spawn (#10): once a service order exists, this pre-fills only
                  the affected products NOT yet on a service order. */}
              <Plus className="h-4 w-4" />{" "}
              {caseDetail.orders.length > 0
                ? "Spawn for New Items"
                : "Spawn Service Order"}
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
                    <td className="py-2 px-3 text-xs">
                      {/* SV orders (spawned via the create-page hand-off) are
                          sales_orders rows — their detail lives under
                          /service-order/:id. */}
                      <Link
                        to={o.isSv ? `/service-order/${o.id}` : `/service-orders/${o.id}`}
                        className="text-[#6B5C32] hover:underline"
                      >
                        {o.serviceOrderNo}
                      </Link>
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {o.isSv ? "SV" : (o.mode ?? <span className="text-[#9CA3AF]">pending</span>)}
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

      {/* Relationship map for the order this case is chasing. No currentDocNo:
          the case itself is not a node in the sales chain, so nothing here is
          "the document you're looking at" — every node just shows its own
          state, and the production strip answers "which part isn't produced
          yet and whose hands is it in". */}
      <DocumentChainMap soId={chainAnchorSoId} />

      {/* Stock top-up — short-shipped or missing parts (legs, woven fabric
          etc.); deducts stock via the standard stock-adjustments path, no
          production order. */}
      <StockTopUpPanel
        caseDetail={caseDetail}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

      {/* Root cause + prevention (open here; track elsewhere) */}
      <RootCausePanel
        caseDetail={caseDetail}
        editing={editing}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

      {/* Service-agent action log — chronological entries the agent logs
          over the case's lifetime (called customer, scheduled inspection,
          sent missing parts, etc.). Keyed by entry count so an append from
          the Stock Top-Up panel re-seeds this panel's local state
          (it captures caseDetail.actionLog once on mount). */}
      <ActionLogPanel
        key={`actions-${caseDetail.actionLog.length}`}
        caseDetail={caseDetail}
        editing={editing}
        onSaved={() => {
          invalidateCachePrefix("/api/service-cases");
          refresh();
        }}
      />

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
      {confirmDialog}
    </div>
  );
}

// ===========================================================================
// CasePipeline — auto-computed, display-only progress stepper.
// ===========================================================================
// Eight fixed steps: Opened → Investigating → Service Order → Repair in
// progress → Repair done → Delivery arranged → Delivered → Closed.
// Completion is DERIVED from data already on the page plus cached fetches of
// /api/delivery-orders and /api/production-orders (matched by salesOrderId
// against the case's SV order ids) — no new endpoints, no writes, no stored
// step state. Only Investigating (Mark In Progress) and Closed (Close Case)
// are manual clicks; everything else lights itself (owner 2026-06-12).
//
// The derivation itself lives in the shared, pure src/lib/case-pipeline.ts
// (computeCasePipeline) so the list page and this stepper never drift. The
// page lifts the bulk DO / PO fetches + the computeCasePipeline call up so the
// Download-PDF handler reuses the same result; this component only renders the
// doneFlags it's handed.
function CasePipeline({ pipe }: { pipe: CasePipelineResult }) {
  const stepsDone = pipe.doneFlags;

  // "Current" = the step right after the last done one (outlined dot);
  // everything after it renders muted. index+1 past the end = all eight done.
  const currentIdx = pipe.index + 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Case Pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        {pipe.cancelled && (
          // The stepper is derived from the case's service orders, so a
          // cancelled case whose SV order had already been delivered rendered
          // as a fully-ticked chain — reading as progress when the case was
          // stopped. Say so above the steps; what is drawn below is the state
          // the case was in WHEN it was cancelled.
          <div className="mb-3 rounded-md bg-[#F5DCDC] px-3 py-2 text-[12px] text-[#7A2E24]">
            This case was cancelled. The steps below show where it had reached
            at that point — no further progress is being tracked.
          </div>
        )}
        {/* Full-width stepper: each step is an equal flex-1 column, the
            connector lines stretch to fill the row left-to-right. */}
        <div className="overflow-x-auto">
        <div className="flex w-full items-start min-w-[640px]">
          {CASE_PIPELINE_STEPS.map((label, i) => {
            const done = stepsDone[i];
            const current = i === currentIdx;
            const prevDone = i > 0 && stepsDone[i - 1];
            return (
              <div key={label} className="flex flex-1 flex-col items-center">
                {/* dot + the two half-connectors on either side */}
                <div className="flex w-full items-center">
                  <span
                    className={`h-0.5 flex-1 ${i === 0 ? "bg-transparent" : prevDone ? "bg-[#6B5C32]" : "bg-[#E2DDD8]"}`}
                  />
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                      done
                        ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                        : current
                          ? "border-[#6B5C32] bg-white text-[#6B5C32]"
                          : "border-[#E2DDD8] bg-white text-[#9CA3AF]"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span
                    className={`h-0.5 flex-1 ${i === CASE_PIPELINE_STEPS.length - 1 ? "bg-transparent" : done ? "bg-[#6B5C32]" : "bg-[#E2DDD8]"}`}
                  />
                </div>
                <span
                  className={`mt-1.5 px-1 text-center text-[11px] leading-tight ${
                    done
                      ? "text-[#1F1D1B]"
                      : current
                        ? "font-semibold text-[#6B5C32]"
                        : "text-[#9CA3AF]"
                  }`}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// RootCausePanel — multi root cause editor with explicit Add / Save.
// ===========================================================================
// A case can have several root causes (owner 2026-06-12) — e.g. Design AND
// Material AND Transport. Each is a bordered block: a category <select> + the
// per-category CategoryDetailsForm. "+ Add root cause" appends a blank block;
// each block has a Remove (×). Edits no longer auto-save per keystroke — they
// set a dirty flag and the Save button at the bottom persists the whole panel
// (root causes + prevention action + owner) in one PUT. The first block is
// mirrored into the legacy category column by the backend.
type RootCauseBlock = { category: string; details: RootCauseDetails };

function RootCausePanel({
  caseDetail,
  editing,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  editing: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  // Seed from the GET's rootCauses (always present — synthesized from the
  // legacy single column for old cases).
  const [blocks, setBlocks] = useState<RootCauseBlock[]>(
    () =>
      (caseDetail.rootCauses ?? []).map((rc) => ({
        category: rc.category ?? "",
        details: rc.details ?? {},
      })),
  );
  const [action, setAction] = useState(caseDetail.preventionAction);
  // status no longer edited from this panel — see Prevention Tracker portal.
  const [owner, setOwner] = useState(caseDetail.preventionOwner);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed from the SERVER snapshot whenever the saved value changes (e.g.
  // after a successful save refetches the parent), but NEVER clobber an
  // in-progress edit. Before this, `blocks` was a one-time init that never
  // re-seeded — so a failed/un-clicked save kept showing the operator's pick
  // (looked saved) while the server still held the old value (and the PDF
  // printed the old value). Now a non-persisted edit visibly reconciles.
  const savedKey = JSON.stringify([
    caseDetail.rootCauses,
    caseDetail.preventionAction,
    caseDetail.preventionOwner,
  ]);
  /* eslint-disable react-hooks/set-state-in-effect -- reconcile local panel to fresh server snapshot when not mid-edit */
  useEffect(() => {
    if (dirty) return;
    setBlocks(
      (caseDetail.rootCauses ?? []).map((rc) => ({
        category: rc.category ?? "",
        details: rc.details ?? {},
      })),
    );
    setAction(caseDetail.preventionAction);
    setOwner(caseDetail.preventionOwner);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the server snapshot only; dirty guard handles edits
  }, [savedKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Warn before leaving (tab close / refresh / in-app page switch) with
  // unsaved Root Cause edits — the panel does not auto-save.
  useNavGuard(dirty, "You have unsaved Root Cause edits. Leave without saving?");

  // Cancel = discard local edits, revert to the last saved server value.
  function cancelEdits() {
    setBlocks(
      (caseDetail.rootCauses ?? []).map((rc) => ({
        category: rc.category ?? "",
        details: rc.details ?? {},
      })),
    );
    setAction(caseDetail.preventionAction);
    setOwner(caseDetail.preventionOwner);
    setDirty(false);
  }

  function addBlock() {
    setBlocks((prev) => [...prev, { category: "", details: {} }]);
    setDirty(true);
  }
  function removeBlock(idx: number) {
    setBlocks((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }
  function setBlockCategory(idx: number, category: string) {
    // Changing the category resets that block's details — the per-category
    // fields are different shapes.
    setBlocks((prev) =>
      prev.map((b, i) => (i === idx ? { category, details: {} } : b)),
    );
    setDirty(true);
  }
  function setBlockDetails(idx: number, details: RootCauseDetails) {
    setBlocks((prev) => prev.map((b, i) => (i === idx ? { ...b, details } : b)));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Drop blank (category-less) blocks before sending; the backend
          // sanitizer also rejects them, this just keeps the payload clean.
          rootCauses: blocks.filter((b) => b.category),
          preventionAction: action || null,
          preventionOwner: owner || null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      setDirty(false);
      toast.success("Saved");
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
        {/* Responsible Unit dropdown removed (owner 2026-06-12) — the
            per-category department picker covers the responsible department
            in finer detail. */}

        {/* One bordered block per root cause. A case can have several. */}
        {blocks.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">No root cause assigned yet.</p>
        ) : (
          blocks.map((block, idx) => (
            <div
              key={idx}
              className="space-y-2 rounded border border-[#E2DDD8] bg-[#FCFBF9] p-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase text-[#6B7280]">
                  Root cause #{idx + 1}
                </span>
                {editing && (
                  <button
                    type="button"
                    onClick={() => removeBlock(idx)}
                    disabled={saving}
                    className="text-[#9A3A2D] hover:text-[#7A2E24]"
                    title="Remove this root cause"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {/* Category — drives reporting / categorisation of recurrence. */}
              <select
                value={block.category}
                onChange={(e) => setBlockCategory(idx, e.target.value)}
                disabled={saving || !editing}
                className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-sm disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
              >
                <option value="">Category — not yet assigned</option>
                {Object.entries(ROOT_CAUSE_LABELS).map(([v, t]) => (
                  <option key={v} value={v}>{t}</option>
                ))}
              </select>
              {/* Per-category structured detail fields. Renders different
                  inputs based on the category — depts for PRODUCTION,
                  supplier+RM for MATERIAL, 3PL company for TRANSPORT, etc.
                  No longer auto-saves; onChange + onPersist both just update
                  this block's local details (the Save button persists). */}
              {block.category && (
                <CategoryDetailsForm
                  category={block.category as RootCauseCategory}
                  value={block.details}
                  onChange={(next) => setBlockDetails(idx, next)}
                  onPersist={(next) => setBlockDetails(idx, next)}
                  disabled={saving || !editing}
                />
              )}
            </div>
          ))
        )}

        {/* Add another root cause — edit mode only. */}
        {editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addBlock}
            disabled={saving}
            className="w-full border-dashed"
          >
            <Plus className="h-4 w-4" /> Add root cause
          </Button>
        )}

        {/* Prevention action + owner — route through the same dirty/Save flow
            (no auto-save on blur anymore). rootCauseNotes textarea removed
            2026-04-28 — duplicate of Issue Description (the 5W story lives
            there now). */}
        <textarea
          rows={2}
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setDirty(true);
          }}
          disabled={saving || !editing}
          placeholder="What's the action so the next batch doesn't repeat this?"
          className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
        />
        <Input
          type="text"
          value={owner}
          onChange={(e) => {
            setOwner(e.target.value);
            setDirty(true);
          }}
          disabled={saving || !editing}
          placeholder="Owner of follow-up (name)"
          className="h-8 text-sm disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
        />
        {/* Per design 2026-04-28: case detail OPENS the prevention task; the
            actual progress tracking lives in a dedicated Prevention Tracker
            portal (not yet built). prevention_status defaults to 'PENDING'
            on the DB row so it shows up in the future portal automatically. */}
        <p className="text-[10px] text-[#9CA3AF]">
          Once the action + owner are set, the prevention task is opened. Progress
          tracking will live in the Prevention Tracker portal (coming soon).
        </p>

        {/* Save bar — explicit persist (the panel no longer auto-saves).
            Edit mode only. Cancel discards edits + reverts to the saved value;
            leaving the page with unsaved edits is guarded by useNavGuard. */}
        {editing && (
          <div className="flex items-center justify-between gap-2 border-t border-[#F0ECE9] pt-3">
            <span
              className={`text-[11px] ${dirty ? "text-[#8A6D1E]" : "text-[#9CA3AF]"}`}
            >
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancelEdits}
                disabled={!dirty || saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={!dirty || saving}
                className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
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
  editing,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  editing: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [description, setDescription] = useState(caseDetail.issueDescription);
  const [saving, setSaving] = useState(false);
  // Explicit Edit→Save (no more auto-save on blur — [[feedback_no_naked_edits]]).
  const dirty = description !== caseDetail.issueDescription;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/service-cases/${caseDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueDescription: description || null }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      toast.success("Saved");
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
          onChange={(e) => setDescription(e.target.value)}
          disabled={saving || !editing}
          placeholder={[
            "What happened? Use the 5W template:",
            "  When  — date / time of incident (e.g. 2026-04-29 10:30)",
            "  Who   — name (e.g. 3PL driver Ahmad / sales agent Wong)",
            "  Where — location (e.g. customer's living room, KL)",
            "  What  — what they did (e.g. dropped the sofa during unloading)",
            "  Result — what problem was caused (e.g. frame cracked at left armrest)",
          ].join("\n")}
          className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
        />
        {editing && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span
              className={`text-[11px] ${dirty ? "text-[#8A6D1E]" : "text-[#9CA3AF]"}`}
            >
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <div className="flex items-center gap-2">
              {dirty && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDescription(caseDetail.issueDescription)}
                  disabled={saving}
                >
                  Discard
                </Button>
              )}
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={save}
                disabled={!dirty || saving}
                className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// CategoryDetailsForm — per-category structured second-level inputs.
// ===========================================================================
// Renders different fields based on the selected root_cause_category.
//
// Design principle (2026-04-29 operator feedback: "too many variants") —
// instead of forcing every variant into a rigid enum, each category has a small
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
  // Currently-selected department. Treated as a non-binding referral —
  // workers can move between depts, so the worker picker is NOT scoped to
  // it. Operator picks a dept as context, then independently searches a
  // worker by name/emp #.
  const deptCode = (value.departmentCode as string) ?? "";

  // Lazy fetches — only the active category's data source is loaded.
  // Workers: pull the full list (no dept filter) so the typeahead below
  // can find any of the ~100-200 employees by name regardless of which
  // dept they're currently rostered to.
  const needsWorkers =
    category === "PRODUCTION" || category === "PROCESS" || category === "PICKING";
  const { data: workersResp } = useCachedJson<{
    data?: Array<{ id: string; name: string; empNo?: string; departmentCode?: string }>;
  }>(needsWorkers ? "/api/workers" : null);

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

  // 3PL company list. The `drivers` table is the 3PL provider master
  // (each row = one 3PL company, with `name` as the company name); the
  // `three_pl_vehicles` table only stores plate numbers and references
  // a provider via providerId, so vehicles can't surface a company name
  // on their own.
  const { data: providersResp } = useCachedJson<{
    data?: Array<{ id: string; name: string }>;
  }>(category === "TRANSPORT" ? "/api/drivers" : null);

  // Wrap each derived list in useMemo so the empty-array fallback doesn't
  // create a new identity every render (would invalidate downstream useMemos).
  const workers = useMemo(() => workersResp?.data ?? [], [workersResp]);
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

  const threePlCompanies = useMemo(() => {
    const names = (providersResp?.data ?? [])
      .map((p) => p.name)
      .filter((n): n is string => !!n);
    return Array.from(new Set(names)).sort();
  }, [providersResp]);

  // Worker typeahead — empty query shows nothing so the operator gets a
  // clean input rather than a 200-row scroll. Match on name OR empNo so
  // either reading habit works ("EMP-025" or "Aung Thein Win").
  const [workerSearch, setWorkerSearch] = useState("");
  const workerMatches = useMemo(() => {
    const q = workerSearch.trim().toLowerCase();
    if (!q) return [];
    return workers
      .filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          (w.empNo ?? "").toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [workerSearch, workers]);

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

  // Reusable worker picker — search-as-you-type across the full worker
  // list (workers aren't strictly bound to the chosen dept, since people
  // move between lines). Lower-case function returning JSX (called as
  // `{renderWorkerDropdown()}`) instead of a component, to satisfy
  // react-hooks/static-components.
  function renderWorkerDropdown() {
    if (value.workerId) {
      return (
        <div className="flex items-center justify-between rounded border border-[#E2DDD8] bg-white px-2 py-1 text-xs">
          <span>
            {value.workerEmpNo ? (
              <>
                <span className="text-[#6B5C32]">{String(value.workerEmpNo)}</span>
                <span className="text-[#9CA3AF]"> — </span>
              </>
            ) : null}
            <span>{(value.workerName as string) ?? ""}</span>
          </span>
          <button
            type="button"
            onClick={() =>
              patch({ workerId: null, workerName: null, workerEmpNo: null })
            }
            disabled={disabled}
            className="text-[#9A3A2D] hover:text-[#7A2E24]"
            title="Clear worker"
          >
            ×
          </button>
        </div>
      );
    }
    return (
      <div className="relative">
        <Input
          type="text"
          value={workerSearch}
          onChange={(e) => setWorkerSearch(e.target.value)}
          disabled={disabled}
          placeholder="Worker / PIC — type name or emp # to search (optional)"
          className="h-8 text-xs"
        />
        {workerMatches.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded border border-[#E2DDD8] bg-white shadow-sm max-h-60 overflow-y-auto">
            {workerMatches.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  setWorkerSearch("");
                  patch({
                    workerId: w.id,
                    workerName: w.name,
                    workerEmpNo: w.empNo ?? null,
                  });
                }}
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-[#FAF7F0]"
              >
                {w.empNo ? (
                  <>
                    <span className="text-[#6B5C32]">{w.empNo}</span>
                    <span className="text-[#9CA3AF]"> — </span>
                  </>
                ) : null}
                <span>{w.name}</span>
                {w.departmentCode ? (
                  <span className="text-[#9CA3AF]"> · {w.departmentCode}</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
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
              patch({
                departmentCode: e.target.value || null,
                departmentName: dept?.name ?? null,
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
          {/* Product picker removed (owner 2026-06-12) — the case's Affected
              Products section above already records which SKUs are involved. */}
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
// CaseDamagedPartsEditor — pick which BOM pieces of an affected product are
// damaged, editable right on the case detail (Wei Siang 2026-06-15: "不能在
// Service Case 改损坏部件吗" — previously these were read-only chips set only at
// case-create). Fetches the product's top-level WIP pieces from the SAME
// endpoint the create modal + the SO Repair Scope picker use, so the options
// match. Default tick = qty 1 (usually only one piece is damaged), clamped to
// the per-FG max. No picks = "all parts" (parent stores components: undefined).
// ===========================================================================
type DamagedPartOption = { key: string; label: string; qty: number };

function CaseDamagedPartsEditor({
  productCode,
  picks,
  editing,
  onChange,
}: {
  productCode: string;
  picks: DamagedPartOption[];
  editing: boolean;
  onChange: (next: DamagedPartOption[]) => void;
}) {
  const [options, setOptions] = useState<DamagedPartOption[] | null>(null);
  useEffect(() => {
    if (!productCode) return;
    let cancelled = false;
    fetch(
      `/api/sales-orders/repair-components?productCode=${encodeURIComponent(productCode)}`,
    )
      .then((res): Promise<{ success?: boolean; data?: DamagedPartOption[] } | null> =>
        res.ok ? res.json() : Promise.resolve(null),
      )
      .then((data) => {
        if (cancelled) return;
        if (data?.success && Array.isArray(data.data)) setOptions(data.data);
      })
      .catch(() => {
        /* endpoint unreachable — hide the picker (= whole product) */
      });
    return () => {
      cancelled = true;
    };
  }, [productCode]);

  // Flat / legacy product with no top-level pieces → nothing to pick (the
  // whole product is the unit), same as the create modal.
  if (!options || options.length === 0) return null;
  // View mode with nothing picked = "all parts" — don't show an empty picker.
  if (!editing && picks.length === 0) return null;
  // View mode shows only the damaged parts (read-only); edit mode shows the
  // full pick list.
  const rows = editing
    ? options
    : options.filter((opt) => picks.some((p) => p.key === opt.key));

  const toggle = (opt: DamagedPartOption) => {
    const has = picks.some((p) => p.key === opt.key);
    onChange(
      has
        ? picks.filter((p) => p.key !== opt.key)
        : [...picks, { key: opt.key, label: opt.label, qty: 1 }],
    );
  };
  const setQty = (opt: DamagedPartOption, raw: string) => {
    const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
    const n = Math.floor(Number(raw));
    const qty = Number.isFinite(n) ? Math.min(Math.max(1, n), maxQty) : maxQty;
    onChange(picks.map((p) => (p.key === opt.key ? { ...p, qty } : p)));
  };

  return (
    <div className="mt-1.5 rounded border border-[#E8D8B2] bg-[#FAF7F0] px-2 py-1.5">
      <div className="text-[10px] text-[#6B5C32] mb-1">
        {editing ? "Damaged parts (optional — all if none picked)" : "Damaged parts"}
      </div>
      <div className="space-y-1">
        {rows.map((opt) => {
          const pick = picks.find((p) => p.key === opt.key);
          const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
          return (
            <div key={opt.key} className="flex items-center gap-2 text-[11px]">
              <label
                className={`flex items-center gap-1.5 flex-1 min-w-0 ${editing ? "cursor-pointer" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={!!pick}
                  onChange={() => toggle(opt)}
                  disabled={!editing}
                  className="h-3 w-3"
                />
                <span className="truncate">{opt.label}</span>
                <span className="text-[#9CA3AF]">×{maxQty}</span>
              </label>
              {pick ? (
                <Input
                  type="number"
                  min={1}
                  max={maxQty}
                  value={pick.qty}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setQty(opt, e.target.value)}
                  disabled={!editing}
                  className="h-6 w-14 text-[11px] px-1.5 disabled:bg-white disabled:text-[#4B5563]"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
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
  editing,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  editing: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const { data: prodResp } = useCachedJson<{
    data?: Array<{ id: string; code: string; name: string }>;
  }>("/api/products");
  const products = useMemo(() => prodResp?.data ?? [], [prodResp]);

  // Pull-from-source-order: a case spawned off a SO/CO can attach the order's
  // own lines directly instead of searching the whole catalog (owner
  // 2026-06-12). Fetch the source order's items; show the ones not already
  // attached as one-tap adds.
  const sourceDetailUrl =
    (caseDetail.sourceType === "SO" || caseDetail.sourceType === "CO") && caseDetail.sourceId
      ? caseDetail.sourceType === "SO"
        ? `/api/sales-orders/${caseDetail.sourceId}`
        : `/api/consignment-orders/${caseDetail.sourceId}`
      : null;
  const { data: srcResp } = useCachedJson<{
    data?: { items?: Array<{ productId?: string; productCode?: string; productName?: string; quantity?: number }> };
  }>(sourceDetailUrl);
  const sourceItems = useMemo(() => {
    const already = new Set(caseDetail.affectedProducts.map((p) => p.productId));
    const seen = new Set<string>();
    return (srcResp?.data?.items ?? [])
      .filter((it) => !!it.productId && !already.has(it.productId!))
      .filter((it) => {
        // De-dup multi-line orders by product so the chooser stays clean.
        if (seen.has(it.productId!)) return false;
        seen.add(it.productId!);
        return true;
      });
  }, [srcResp, caseDetail.affectedProducts]);

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

  // Add a line straight from the source order (carries its qty).
  function addFromSource(it: { productId?: string; productCode?: string; productName?: string; quantity?: number }) {
    if (!it.productId) return;
    const next = [
      ...caseDetail.affectedProducts,
      { productId: it.productId, code: it.productCode ?? "", name: it.productName ?? "", qty: it.quantity ?? null },
    ];
    void persist(next);
  }

  function addAllFromSource() {
    const next = [
      ...caseDetail.affectedProducts,
      ...sourceItems.map((it) => ({
        productId: it.productId!,
        code: it.productCode ?? "",
        name: it.productName ?? "",
        qty: it.quantity ?? null,
      })),
    ];
    void persist(next);
  }

  async function removeProduct(productId: string) {
    const p = caseDetail.affectedProducts.find((x) => x.productId === productId);
    if (
      !(await confirm({
        title: "Remove this product?",
        message: (
          <>
            Remove{" "}
            <span className="font-semibold text-[#6B5C32]">
              {p?.code}
              {p?.name ? ` — ${p.name}` : ""}
            </span>{" "}
            from this case's affected products?
          </>
        ),
        confirmLabel: "Remove",
        tone: "danger",
      }))
    )
      return;
    void persist(caseDetail.affectedProducts.filter((x) => x.productId !== productId));
  }

  function setQty(productId: string, qty: number | null) {
    const next = caseDetail.affectedProducts.map((p) =>
      p.productId === productId ? { ...p, qty } : p,
    );
    void persist(next);
  }

  // Edit which BOM pieces are damaged, right here on the case (#16). Empty =
  // "all parts" → drop the field so it stays the canonical "whole product".
  function updateComponents(
    productId: string,
    components: Array<{ key: string; label: string; qty: number }>,
  ) {
    const next = caseDetail.affectedProducts.map((p) =>
      p.productId === productId
        ? { ...p, components: components.length > 0 ? components : undefined }
        : p,
    );
    void persist(next);
  }

  return (
    <>
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Affected Products ({caseDetail.affectedProducts.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Search-then-add. Empty query shows no list (avoids dropdown
            of 1000+ SKUs). Click a result to add. Edit mode only. */}
        {editing && (
        <div className="relative">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={saving}
            placeholder="Search product by code or name to add (optional — leave empty if no specific SKU)"
            className="h-9 text-sm"
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
                  <span className="text-[#6B5C32]">{p.code}</span>
                  <span className="text-[#9CA3AF]"> — </span>
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        )}

        {/* Pull from the source order — one tap to attach a line the order
            already has, instead of searching the whole catalog. Edit mode only. */}
        {editing && sourceItems.length > 0 && (
          <div className="rounded-lg border border-dashed border-[#C9B98A] bg-[#FCFBF7] p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-[#9C6F1E]">
                Suggestions from {caseDetail.sourceNo || "the source order"} — tap to add
                <span className="ml-1 font-normal text-[#9CA3AF]">(not added yet)</span>
              </span>
              <button
                type="button"
                onClick={addAllFromSource}
                disabled={saving}
                className="text-[11px] rounded border border-[#6B5C32] px-2 py-0.5 text-[#6B5C32] hover:bg-[#F4EFE3] disabled:opacity-50"
              >
                + Add all
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sourceItems.map((it) => (
                <button
                  key={it.productId}
                  type="button"
                  onClick={() => addFromSource(it)}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-full border border-[#E2DDD8] bg-white px-2 py-1 text-[11px] text-[#1F1D1B] hover:bg-[#F4EFE3] disabled:opacity-50"
                  title={it.productName ?? ""}
                >
                  <Plus className="h-3 w-3 text-[#6B5C32]" />
                  {it.productCode}
                  {it.quantity ? <span className="text-[#9CA3AF]">×{it.quantity}</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}

        {caseDetail.affectedProducts.length === 0 ? (
          <p className="text-[10px] text-[#9CA3AF]">
            No products attached. Optional — only add if the issue is tied to
            specific SKUs. SO/CO-sourced cases can also reference the source
            order's lines without re-attaching them here.
          </p>
        ) : (
          <ul className="space-y-2">
            {caseDetail.affectedProducts.map((p) => (
              <li
                key={p.productId}
                className="flex items-start justify-between gap-3 rounded-lg border border-[#E2DDD8] bg-[#FBFAF8] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-semibold text-[#6B5C32]">{p.code}</span>
                    <span className="text-[#C9C3BC]"> — </span>
                    <span className="text-[#1F1D1B]">{p.name}</span>
                  </div>
                  {/* Damaged parts — now EDITABLE here (#16), not just at
                      case-create. Tick which pieces are damaged + how many;
                      changes save immediately like the qty field. */}
                  <CaseDamagedPartsEditor
                    productCode={p.code}
                    picks={p.components ?? []}
                    editing={editing}
                    onChange={(next) => updateComponents(p.productId, next)}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Input
                    type="number" onFocus={(e) => e.currentTarget.select()}
                    min={1}
                    value={p.qty ?? ""}
                    onChange={(e) => {
                      // Whole units, at least 1 (empty clears). Prevents 0 /
                      // negative / fractional affected quantities.
                      const raw = e.target.value;
                      if (raw === "") return setQty(p.productId, null);
                      const n = Math.floor(Number(raw));
                      setQty(p.productId, Number.isFinite(n) && n >= 1 ? n : 1);
                    }}
                    disabled={saving || !editing}
                    placeholder="Qty"
                    className="h-8 w-16 text-sm disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
                  />
                  {editing && (
                    <button
                      type="button"
                      onClick={() => removeProduct(p.productId)}
                      disabled={saving}
                      className="text-[#9A3A2D] hover:text-[#7A2E24]"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
    {confirmDialog}
    </>
  );
}

// ===========================================================================
// StockTopUpPanel — stock-only part top-ups recorded against the case.
// ===========================================================================
// The owner's "stock top-up" concept: short-shipped or missing parts (legs,
// woven fabric, etc.). Deducts RM / WIP / FG stock through the standard
// POST /api/stock-adjustments write path (reason SERVICE_REPLACEMENT,
// tagged with this case's id — migration 0164) and lists this case's
// issues below. No production order, no service order.
// Item sources mirror the Stock Adjustments page (inventory/adjustments.tsx):
// RM = /api/raw-materials, WIP = /api/inventory/wip, FG = /api/inventory
// finishedProducts; unit cost prefill mirrors the same page (RM unitCostSen,
// FG basePriceSen, WIP unknown → 0).
type ReplacementType = "RM" | "WIP" | "FG";
type ReplacementItemOpt = {
  id: string;
  code: string;
  name: string;
  onHand: number;
  unitCostSen: number;
};
type ReplacementAdjRow = {
  id: string;
  adjNo: string;
  type: string;
  itemCode: string;
  itemName: string;
  qtyDelta: number;
  adjustedAt: string;
  adjustedByName: string;
  notes: string;
};

function StockTopUpPanel({
  caseDetail,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const user = getCurrentUser();
  const [type, setType] = useState<ReplacementType>("RM");
  const [itemId, setItemId] = useState("");
  const [search, setSearch] = useState("");
  const [qty, setQtyInput] = useState("1");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // Focus drives the browsable dropdown — clicking the box shows the stock
  // list (first N) so the operator can browse without blind-typing.
  const [focused, setFocused] = useState(false);

  // Only the active type's list is fetched (null URL = skip).
  const { data: rmResp } = useCachedJson<{
    data?: Array<{ id: string; itemCode: string; itemName?: string; balanceQty: number; unitCostSen?: number }>;
  }>(type === "RM" ? "/api/raw-materials" : null);
  const { data: wipResp } = useCachedJson<{
    data?: Array<{ id: string; code: string; type: string; stockQty: number }>;
  }>(type === "WIP" ? "/api/inventory/wip" : null);
  const { data: invResp } = useCachedJson<{
    data?: { finishedProducts?: Array<{ id: string; code: string; name: string; stockQty?: number; basePriceSen?: number }> };
  }>(type === "FG" ? "/api/inventory" : null);

  const itemOptions: ReplacementItemOpt[] = useMemo(() => {
    if (type === "RM") {
      return (rmResp?.data ?? []).map((r) => ({
        id: r.id,
        code: r.itemCode,
        name: r.itemName ?? "",
        onHand: r.balanceQty,
        unitCostSen: r.unitCostSen ?? 0,
      }));
    }
    if (type === "WIP") {
      return (wipResp?.data ?? []).map((w) => ({
        id: w.id,
        code: w.code,
        name: w.type ?? "",
        onHand: w.stockQty,
        unitCostSen: 0,
      }));
    }
    return (invResp?.data?.finishedProducts ?? []).map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name ?? "",
      onHand: p.stockQty ?? 0,
      unitCostSen: p.basePriceSen ?? 0,
    }));
  }, [type, rmResp, wipResp, invResp]);

  // Browse-then-pick — an EMPTY query shows the first chunk of the stock list
  // (so clicking the box reveals what's in stock to pick from); typing filters.
  // Capped so a huge RM list can't render thousands of rows at once.
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return itemOptions.slice(0, 30);
    return itemOptions
      .filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
      .slice(0, 30);
  }, [search, itemOptions]);

  const selected = itemOptions.find((o) => o.id === itemId) ?? null;
  const qtyNum = Number(qty);
  const canIssue = !!selected && Number.isFinite(qtyNum) && qtyNum > 0 && !saving;

  // This case's issued parts — GET filtered by caseid (migration 0164).
  const { data: adjResp, refresh: refreshAdj } = useCachedJson<{ data?: ReplacementAdjRow[] }>(
    `/api/stock-adjustments?caseId=${encodeURIComponent(caseDetail.id)}`,
  );
  const issued = useMemo(() => adjResp?.data ?? [], [adjResp]);

  async function handleIssue() {
    if (!selected || !Number.isFinite(qtyNum) || qtyNum <= 0) return;
    // Posting to live inventory — confirm first ([[feedback_no_naked_edits]]:
    // a "post" that moves real stock must not fire on a single click).
    if (
      !(await confirm({
        title: "Deduct from live stock?",
        message: (
          <>
            Issue{" "}
            <span className="font-semibold text-[#6B5C32]">
              {selected.code} × {Math.abs(qtyNum)}
            </span>{" "}
            and deduct it from <span className="font-semibold">{type}</span> stock
            (currently {selected.onHand} on hand). This writes a stock adjustment
            against {caseDetail.caseNo} and can't be auto-undone.
          </>
        ),
        confirmLabel: "Issue & deduct",
        tone: "danger",
      }))
    )
      return;
    setSaving(true);
    try {
      const res = await fetch("/api/stock-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          itemId: selected.id,
          qtyDelta: -Math.abs(qtyNum),
          unitCostSen: selected.unitCostSen,
          reason: "SERVICE_REPLACEMENT",
          notes: `${caseDetail.caseNo}${note.trim() ? " — " + note.trim() : ""}`,
          caseId: caseDetail.id,
          adjustedBy: user?.id ?? null,
          adjustedByName: user?.displayName ?? user?.email ?? null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      // Append to the case's agent action log (same PUT shape the
      // ActionLogPanel persists) so the timeline shows the part went out.
      // Best-effort — the stock deduction above already committed.
      try {
        await fetch(`/api/service-cases/${caseDetail.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionLog: [
              ...(caseDetail.actionLog ?? []),
              {
                id: `act-${Math.random().toString(36).slice(2, 8)}`,
                date: todayYmdMY(),
                description: `Issued replacement part: ${selected.code} × ${Math.abs(qtyNum)} (${type} stock deducted${note.trim() ? " — " + note.trim() : ""})`,
                createdAt: new Date().toISOString(),
                createdByName: user?.displayName ?? user?.email ?? "",
              },
            ],
          }),
        });
      } catch {
        /* tolerate — log entry is a nicety */
      }
      toast.success(`Deducted ${Math.abs(qtyNum)} × ${selected.code} from ${type} stock`);
      setItemId("");
      setSearch("");
      setQtyInput("1");
      setNote("");
      invalidateCachePrefix("/api/stock-adjustments");
      invalidateCachePrefix("/api/raw-materials");
      invalidateCachePrefix("/api/inventory");
      refreshAdj();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  const sel =
    "h-8 rounded border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20";

  return (
    <>
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Issue Replacement Parts
          {issued.length > 0 ? ` (${issued.length})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-[#4B5563]">
          Customer is missing or short-shipped a part (legs, woven fabric, a
          damaged divan base, etc.). Issue it from stock here — it deducts
          <span className="font-medium"> RM / WIP / FG</span> inventory and logs
          it against this case. No production order is created.
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <select
            value={type}
            onChange={(e) => {
              // Type change invalidates the picked item — option lists are
              // scoped per type (mirrors the Stock Adjustments page).
              setType(e.target.value as ReplacementType);
              setItemId("");
              setSearch("");
            }}
            disabled={saving}
            className={`${sel} w-[70px]`}
          >
            <option value="RM">RM</option>
            <option value="WIP">WIP</option>
            <option value="FG">FG</option>
          </select>
          <div className="relative flex-1 min-w-[220px]">
            {selected ? (
              <div className="flex items-center justify-between rounded border border-[#E2DDD8] bg-[#FAF9F7] px-2 py-1.5 text-xs">
                <div className="truncate">
                  <span className="text-[#6B5C32]">{selected.code}</span>
                  {selected.name ? (
                    <span className="text-[#9CA3AF]"> — {selected.name}</span>
                  ) : null}
                  <span className="text-[#9CA3AF]"> · {selected.onHand} on hand</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setItemId("");
                    setSearch("");
                  }}
                  disabled={saving}
                  className="ml-2 text-xs text-[#6B5C32] hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onFocus={() => setFocused(true)}
                  // Hide on blur so a click outside closes it; the options use
                  // onMouseDown-preventDefault so selecting still fires first.
                  onBlur={() => setFocused(false)}
                  disabled={saving}
                  placeholder={`Click to browse ${type} stock, or type to filter…`}
                  className="h-8 text-xs"
                />
                {focused && matches.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded border border-[#E2DDD8] bg-white shadow-sm max-h-48 overflow-auto">
                    {matches.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setItemId(o.id);
                          setSearch("");
                          setFocused(false);
                        }}
                        className="w-full text-left px-2 py-1.5 text-xs hover:bg-[#FAF7F0]"
                      >
                        <span className="text-[#6B5C32]">{o.code}</span>
                        {o.name ? <span className="text-[#9CA3AF]"> — {o.name}</span> : null}
                        <span className="text-[#9CA3AF]"> · {o.onHand} on hand</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <Input
            type="number"
            onFocus={(e) => e.currentTarget.select()}
            min={1}
            value={qty}
            onChange={(e) => setQtyInput(e.target.value)}
            disabled={saving}
            placeholder="Qty"
            className="h-8 w-20 text-xs"
          />
          <Input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={saving}
            placeholder="Note (optional)"
            className="h-8 flex-1 min-w-[160px] text-xs"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={handleIssue}
            disabled={!canIssue}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {saving ? "Issuing…" : "Issue & deduct"}
          </Button>
        </div>

        {issued.length > 0 && (
          <table className="w-full text-xs border border-[#E2DDD8] rounded">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-left text-[10px] uppercase text-[#6B7280] bg-[#FAF9F7]">
                <th className="py-1.5 px-2">Date</th>
                <th className="py-1.5 px-2">Item</th>
                <th className="py-1.5 px-2 text-right">Qty</th>
                <th className="py-1.5 px-2">By</th>
                <th className="py-1.5 px-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((r) => (
                <tr key={r.id} className="border-b border-[#F0ECE9] last:border-b-0">
                  <td className="py-1.5 px-2 whitespace-nowrap text-[#6B7280]">
                    {dateLabel(r.adjustedAt)}
                  </td>
                  <td className="py-1.5 px-2">
                    <span className="text-[#6B5C32]">{r.itemCode}</span>
                    {r.itemName ? <span className="text-[#9CA3AF]"> — {r.itemName}</span> : null}
                    <span className="text-[10px] text-[#9CA3AF]"> ({r.type})</span>
                  </td>
                  <td className="py-1.5 px-2 text-right text-[#9A3A2D]">{r.qtyDelta}</td>
                  <td className="py-1.5 px-2 text-[#6B7280]">{r.adjustedByName || "—"}</td>
                  <td className="py-1.5 px-2 text-[#6B7280]">{r.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
    {confirmDialog}
    </>
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
  editing,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  editing: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
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

  async function handleRemove(idx: number) {
    if (
      !(await confirm({
        title: "Remove this photo?",
        message: "The photo will be detached from this case. This can't be undone.",
        confirmLabel: "Remove",
        tone: "danger",
      }))
    )
      return;
    void persist(caseDetail.issuePhotos.filter((_, i) => i !== idx));
  }

  return (
    <>
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Photos ({caseDetail.issuePhotos.length})</CardTitle>
        {editing && (
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
        )}
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
                {editing && (
                  <button
                    type="button"
                    onClick={() => handleRemove(i)}
                    disabled={saving}
                    className="absolute -top-1 -right-1 rounded-full bg-white border border-[#E2DDD8] p-0.5 text-[#9A3A2D] hover:text-[#7A2E24] shadow-sm"
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
    {confirmDialog}
    </>
  );
}

// ===========================================================================
// ActionLogPanel — Service-agent log of actions taken over the case lifetime.
// ===========================================================================
// Stored as JSON array on service_cases.action_log. Each entry: { id, date,
// description, createdAt, createdByName? }. Explicit Edit→Save (no auto-save
// on blur — [[feedback_no_naked_edits]]); the Save bar persists the whole log.
function ActionLogPanel({
  caseDetail,
  editing,
  onSaved,
}: {
  caseDetail: ServiceCaseDetail;
  editing: boolean;
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
        date: todayYmdMY(),
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
    // Local removal only — the Save bar commits, so a stray click doesn't wipe
    // a logged action straight off the record ([[feedback_no_naked_edits]]).
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  const dirty =
    JSON.stringify(entries) !== JSON.stringify(caseDetail.actionLog ?? []);
  async function handleSave() {
    if (!dirty) return;
    // Drop fully-blank rows (no date AND no description) before persisting.
    const cleaned = entries.filter(
      (e) => (e.date || "").trim() || (e.description || "").trim(),
    );
    setEntries(cleaned);
    await persist(cleaned);
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Action Taken (Service Agent Log)</CardTitle>
        {editing && (
          <Button size="sm" variant="outline" onClick={addEntry} disabled={saving}>
            <Plus className="mr-1 h-3 w-3" /> Add Entry
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">
            {editing
              ? 'Log each action you take on this case (called customer, scheduled inspection, sent missing part, etc.). Click "Add Entry" to start.'
              : "No actions logged yet. Click Edit to add one."}
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-2">
                <Input
                  type="date"
                  value={e.date}
                  onChange={(ev) => patchEntry(e.id, { date: ev.target.value })}
                  disabled={!editing}
                  className="h-8 w-[150px] text-xs disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
                />
                <Input
                  type="text"
                  value={e.description}
                  onChange={(ev) => patchEntry(e.id, { description: ev.target.value })}
                  placeholder="What did you do? (e.g. Called customer, scheduled on-site inspection)"
                  disabled={!editing}
                  className="h-8 flex-1 text-xs disabled:bg-[#FAF9F7] disabled:text-[#4B5563]"
                />
                {editing && (
                  <button
                    type="button"
                    onClick={() => removeEntry(e.id)}
                    className="text-[#9A3A2D] hover:text-[#7A2E24] p-1"
                    title="Remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* Save bar — the log no longer auto-saves on blur. Edit mode only. */}
        {editing && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#F0ECE9] pt-3">
            <span
              className={`text-[11px] ${dirty ? "text-[#8A6D1E]" : "text-[#9CA3AF]"}`}
            >
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
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
            <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
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
                            <Input type="number" onFocus={(e) => e.currentTarget.select()} min="1" value={l.qty} onChange={(e) => patchFreeLine(l.id, { qty: e.target.value })} className="h-7 text-xs px-2" />
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
                              <div className="text-xs">{it.productCode}</div>
                              <div className="text-[10px] text-[#6B7280]">{it.productName}</div>
                            </td>
                            <td className="p-2 text-right">{it.quantity}</td>
                            <td className="p-2">
                              <Input
                                type="number" onFocus={(e) => e.currentTarget.select()} min="1" max={it.quantity}
                                value={pick?.qty ?? ""}
                                onChange={(e) => {
                                  // Clamp to [1, ordered qty]. The max attribute alone
                                  // doesn't stop typing/pasting a bigger number, which
                                  // then submitted (Wei Siang 2026-06-15: "设定只有 2 却
                                  // 能上到 3"). Empty is allowed mid-edit.
                                  const raw = e.target.value;
                                  if (raw === "") return patchPick(it.id, { qty: "" });
                                  const n = Math.floor(Number(raw));
                                  const clamped = Number.isFinite(n)
                                    ? Math.min(Math.max(1, n), it.quantity)
                                    : 1;
                                  patchPick(it.id, { qty: String(clamped) });
                                }}
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
