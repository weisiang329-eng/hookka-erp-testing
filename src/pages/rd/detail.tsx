import { useState, useEffect, useCallback, useRef } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatCurrency, formatDate, todayYmdMY } from "@/lib/utils";
import {
  ArrowLeft,
  Calendar,
  Beaker,
  Clock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crop,
  DollarSign,
  Pencil,
  Plus,
  X,
  Package,
  Trash2,
  ImagePlus,
  Pause,
  Play,
  Archive,
} from "lucide-react";
import type {
  RDProject,
  RDProjectStage,
  RDProjectType,
  RDPrototypeType,
  RdMaterialIssuance,
  RDTeamMember,
  RDLabourHourEntry,
} from "@/types";
import type { RawMaterial } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { RdProjectSchema } from "@/lib/schemas/rd-project";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { PhotoCropDialog } from "@/components/ui/PhotoCropDialog";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { getMilestoneHealth, MILESTONE_CHIP } from "./health";

const RDMutationSchema = mutationWithData(RdProjectSchema);

const STAGES: RDProjectStage[] = ["CONCEPT", "DESIGN", "PROTOTYPE", "TESTING", "APPROVED", "PRODUCTION_READY"];

const STAGE_COLORS: Record<RDProjectStage, string> = {
  CONCEPT: "#6366F1",
  DESIGN: "#3B82F6",
  PROTOTYPE: "#F59E0B",
  TESTING: "#F97316",
  APPROVED: "#10B981",
  PRODUCTION_READY: "#06B6D4",
};

// Default labels (DEVELOPMENT). Other project types override the early
// stages — see getStageLabels below. Stage CODES in the DB stay the same
// (CONCEPT, DESIGN, ...) regardless of type so the kanban / API stay
// stable; only the user-facing label changes.
const STAGE_LABELS: Record<RDProjectStage, string> = {
  CONCEPT: "Concept",
  DESIGN: "Design",
  PROTOTYPE: "Prototype",
  TESTING: "Testing",
  APPROVED: "Approved",
  PRODUCTION_READY: "Production Ready",
};

// Per-type stage labels. Only the first two stages change because the
// downstream physical work (build / test / approve / ship) is the same no
// matter why we're doing this project. Returning a Record keeps callers
// drop-in compatible with the static STAGE_LABELS.
function getStageLabels(
  projectType: RDProjectType | undefined,
): Record<RDProjectStage, string> {
  if (projectType === "IMPROVEMENT") {
    return {
      ...STAGE_LABELS,
      CONCEPT: "Issue Analysis",
      DESIGN: "Fix Design",
    };
  }
  if (projectType === "CLONE") {
    return {
      ...STAGE_LABELS,
      CONCEPT: "Source Analysis",
    };
  }
  return STAGE_LABELS;
}

const CATEGORY_COLORS: Record<string, string> = {
  SOFA: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  BEDFRAME: "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]",
  ACCESSORY: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
};

const STATUS_OPTIONS = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
const CATEGORY_OPTIONS = ["BEDFRAME", "SOFA", "ACCESSORY"] as const;

const PROTO_TYPE_LABELS: Record<RDPrototypeType, string> = {
  FABRIC_SEWING: "Fabric Sewing",
  FRAMING: "Framing",
};
const PROTO_TYPE_COLORS: Record<RDPrototypeType, string> = {
  FABRIC_SEWING: "bg-pink-100 text-pink-700",
  FRAMING: "bg-[#FBE4CE] text-[#B8601A]",
};

// ─── Issuance line factory ─────────────────────────────────────────────────
// Module-scope so the body of RDProjectDetailPage stays pure (the
// react-hooks/purity rule forbids calling Date.now() or Math.random() during
// render). A monotonic counter keeps the React key stable across renders;
// it doesn't need to survive page reloads.
type IssuanceLine = {
  lineKey: string;        // stable React key
  rmCategory: string;     // itemGroup filter for this line
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  balanceQty: number;
  qty: number;
};
let issuanceLineSeq = 0;
function makeBlankIssuanceLine(): IssuanceLine {
  issuanceLineSeq += 1;
  return {
    lineKey: `line-${issuanceLineSeq}`,
    rmCategory: "",
    materialId: "",
    materialCode: "",
    materialName: "",
    unit: "",
    balanceQty: 0,
    qty: 1,
  };
}

// ─── Modal Overlay ──────────────────────────────────────────────────────────

// Per-milestone status chip — Done / Overdue / Due Soon / Upcoming.
// Mirrors the project-card health chip vocabulary so operators learn one
// colour scheme (red bad / amber warning / green done / neutral upcoming).
function MilestoneStatusChip({
  targetDate,
  actualDate,
}: {
  targetDate: string | null;
  actualDate: string | null;
}) {
  const { state, daysToTarget } = getMilestoneHealth({ targetDate, actualDate });
  if (!state) return <span className="text-gray-300 text-xs">--</span>;
  const def = MILESTONE_CHIP[state];
  let label = "";
  switch (state) {
    case "done":
      label = daysToTarget === null
        ? "Done"
        : daysToTarget < 0
          ? `Done ${Math.abs(daysToTarget)}d early`
          : daysToTarget > 0
            ? `Done ${daysToTarget}d late`
            : "Done on time";
      break;
    case "overdue":
      label = `Overdue ${Math.abs(daysToTarget ?? 0)}d`;
      break;
    case "due-soon":
      label = (daysToTarget ?? 0) === 0 ? "Due today" : `Due in ${daysToTarget}d`;
      break;
    case "upcoming":
      label = `${daysToTarget}d to go`;
      break;
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${def.cls}`}>
      {label}
    </span>
  );
}

function ModalOverlay({ open, onClose, title, children, wide }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    // Backdrop click does NOT close the modal — the user has lost too much
    // half-typed work to stray clicks. Use the X icon, Cancel button, or
    // Escape (handled where applicable) to dismiss.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        className={`relative w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-xl bg-white border border-[#E2DDD8] shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between border-b border-[#E2DDD8] px-6 py-4">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Field helpers ──────────────────────────────────────────────────────────

const labelClass = "block text-xs font-semibold text-gray-500 mb-1";
const inputClass = "w-full rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]";
const selectClass = inputClass;

export default function RDProjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [project, setProject] = useState<RDProject | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [statusFlipping, setStatusFlipping] = useState<
    null | "hold" | "resume" | "move-to-draft" | "complete" | "reopen"
  >(null);

  // Edit project modal — projectType + clone-source fields are mirror-
  // for-mirror with the Create dialog (src/pages/rd/index.tsx) so users
  // can switch a project's type after creation and fill in the
  // competitor-source fields on existing rows that pre-date the CLONE
  // feature.
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    projectType: "DEVELOPMENT" as RDProject["projectType"],
    productCategory: "BEDFRAME" as RDProject["productCategory"],
    targetLaunchDate: "",
    totalBudget: 0,
    // Pricing targets — RM strings (not numbers) so an empty input shows
    // up as blank instead of "0". Converted to sen on save; empty string
    // becomes null on the server side ("not set").
    targetSellingPriceRM: "",
    targetMaterialCostRM: "",
    assignedTeamStr: "",
    status: "ACTIVE" as RDProject["status"],
    sourceProductName: "",
    sourceBrand: "",
    sourcePurchaseRef: "",
    sourcePriceRM: "", // RM string; converted to sen on save
    sourceNotes: "",
  });

  // Add / edit prototype modal. `editingProtoId` is null for Add, the
  // prototype id when editing — same modal/form is reused for both flows.
  const [protoOpen, setProtoOpen] = useState(false);
  const [protoSaving, setProtoSaving] = useState(false);
  const [editingProtoId, setEditingProtoId] = useState<string | null>(null);
  const [protoForm, setProtoForm] = useState({
    prototypeType: "FRAMING" as RDPrototypeType,
    version: "",
    description: "",
    labourHours: 0,
    testResults: "",
    feedback: "",
    improvements: "",
    defects: "",
    createdDate: todayYmdMY(),
  });

  // Production BOM section was removed in Task #8 — its modal, state, and
  // handlers used to live here. Issue dialog and the rest of the file are
  // unaffected.

  // Material Issuance modal — multi-line form. One dialog can post N
  // raw-material rows in a single batched transaction (POST
  // /:id/issuances/batch). The dialog is split into:
  //   • a common header (issuedAt + issuedBy + notes) shared by every row, and
  //   • a list of material lines, each with its own category, raw material,
  //     qty + unit. Lines can be added / removed individually.
  // Note: unit cost is no longer captured in the UI. The backend resolves it
  // per-line via FIFO over rm_batches at issue time.
  const [issuanceOpen, setIssuanceOpen] = useState(false);
  const [issuanceSaving, setIssuanceSaving] = useState(false);
  const [issuanceError, setIssuanceError] = useState<string | null>(null);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [issuanceHeader, setIssuanceHeader] = useState({
    issuedAt: todayYmdMY(),
    issuedBy: "",
    notes: "",
  });
  // Lazy initialiser keeps makeBlankIssuanceLine() (which mutates the module
  // counter) out of the render path on subsequent re-renders.
  const [issuanceLines, setIssuanceLines] = useState<IssuanceLine[]>(() => [
    makeBlankIssuanceLine(),
  ]);

  // Labour Hours modal — new table-backed flow (rd_labour_hours +
  // rd_team_members). The legacy `labourLogs` JSON column is no longer
  // written from this UI; existing rows on it stay readable via the
  // project payload but aren't surfaced in the new section.
  const [labourOpen, setLabourOpen] = useState(false);
  const [labourSaving, setLabourSaving] = useState(false);
  const [labourForm, setLabourForm] = useState({
    teamMemberId: "",
    workDate: todayYmdMY(),
    hours: 1,
    notes: "",
  });

  // Manual labour-cost override modal.
  const [manualCostOpen, setManualCostOpen] = useState(false);
  const [manualCostSaving, setManualCostSaving] = useState(false);
  const [manualCostRM, setManualCostRM] = useState("");

  // Stage photos
  const [stagePhotos, setStagePhotos] = useState<Record<string, string[]>>({});
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoUploadStage, setPhotoUploadStage] = useState<string | null>(null);

  // Cover photo upload — separate from per-stage photos. One photo per project,
  // stored as a JPEG data URL via @/lib/image-compress.
  const coverPhotoInputRef = useRef<HTMLInputElement>(null);
  const [coverPhotoSaving, setCoverPhotoSaving] = useState(false);
  // Click-to-zoom lightbox for the cover photo.
  const [coverZoomOpen, setCoverZoomOpen] = useState(false);

  // ── Photo crop dialog state ────────────────────────────────────────────
  // The dialog gates every cover-photo and milestone-photo upload (and any
  // "edit crop" re-use of an existing photo). `cropTarget` carries enough
  // info to know what to do with the cropped data URL on confirm.
  type CropTarget =
    | { kind: "cover" }
    | { kind: "milestone-add"; stage: string }
    | { kind: "milestone-replace"; stage: string; index: number };
  const [cropOpen, setCropOpen] = useState(false);
  const [cropImageUrl, setCropImageUrl] = useState<string>("");
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  // For multi-file milestone uploads we queue the remaining files and feed
  // them through the dialog one-by-one so the user can crop each.
  const [cropQueue, setCropQueue] = useState<File[]>([]);

  const rdUrl = id ? `/api/rd-projects/${id}` : null;
  // Issuances are now table-backed (rd_material_issuances). The project payload
  // no longer surfaces a materialIssuances array — we fetch the list from the
  // dedicated GET /:id/issuances endpoint and refresh it after every issuance
  // mutation. See migration 0095 for the JSON→table backfill.
  const issuancesUrl = id ? `/api/rd-projects/${id}/issuances` : null;
  const labourHoursUrl = id ? `/api/rd-projects/${id}/labour-hours` : null;
  const { data: projectResp, loading, refresh: refreshProjectHook } = useCachedJson<{ data?: RDProject }>(rdUrl);
  const { data: issuancesResp, refresh: refreshIssuancesHook } = useCachedJson<{ data?: RdMaterialIssuance[] }>(issuancesUrl);
  // perf 2026-08-13 (BUG-2026-08-13-021, audit finding D12): `?buckets=` — only
  // `rawMaterials` is read here, so the 365-row product catalogue and the WIP
  // bucket no longer ride along. `fetchRawMaterials` below still invalidates by
  // the "/api/inventory" PREFIX, which matches this URL (cached-fetch.ts:202).
  const { data: inventoryResp, refresh: refreshInventoryHook } = useCachedJson<{ data?: { rawMaterials?: RawMaterial[] } }>("/api/inventory?buckets=rawMaterials");
  const { data: labourHoursResp, refresh: refreshLabourHoursHook } = useCachedJson<{ data?: RDLabourHourEntry[] }>(labourHoursUrl);
  const { data: teamMembersResp, refresh: refreshTeamMembersHook } = useCachedJson<{ data?: RDTeamMember[] }>("/api/rd-team-members?active=true");

  const fetchProject = useCallback(() => {
    if (rdUrl) invalidateCachePrefix(rdUrl);
    invalidateCachePrefix("/api/rd-projects");
    refreshProjectHook();
  }, [rdUrl, refreshProjectHook]);

  const fetchIssuances = useCallback(() => {
    if (issuancesUrl) invalidateCachePrefix(issuancesUrl);
    refreshIssuancesHook();
  }, [issuancesUrl, refreshIssuancesHook]);

  const fetchRawMaterials = useCallback(() => {
    invalidateCachePrefix("/api/inventory");
    refreshInventoryHook();
  }, [refreshInventoryHook]);

  const fetchLabourHours = useCallback(() => {
    if (labourHoursUrl) invalidateCachePrefix(labourHoursUrl);
    refreshLabourHoursHook();
  }, [labourHoursUrl, refreshLabourHoursHook]);

  const fetchTeamMembers = useCallback(() => {
    invalidateCachePrefix("/api/rd-team-members");
    refreshTeamMembersHook();
  }, [refreshTeamMembersHook]);

  const issuances: RdMaterialIssuance[] = issuancesResp?.data ?? [];
  const labourHours: RDLabourHourEntry[] = labourHoursResp?.data ?? [];
  const teamMembers: RDTeamMember[] = teamMembersResp?.data ?? [];

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR project + inventory data into mutable local state */
  useEffect(() => {
    if (projectResp) setProject(projectResp.data ?? null);
  }, [projectResp]);

  useEffect(() => {
    setRawMaterials(inventoryResp?.data?.rawMaterials ?? []);
  }, [inventoryResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ─── Status Flips (hold / resume / move-to-draft) ─────────────────────
  // Wrap POST /api/rd-projects/:id/{hold|resume|move-to-draft} so an
  // operator can pause an active project, resume it, or send it back to
  // the Drafts backlog without going through SQL or the network tab.
  const flipStatus = async (
    action: "hold" | "resume" | "move-to-draft" | "reopen",
    confirmMsg: string,
    successMsg: string,
  ) => {
    if (!project) return;
    if (!(await confirm({ message: confirmMsg, danger: false }))) return;
    setStatusFlipping(action);
    try {
      const r = await fetch(`/api/rd-projects/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      });
      const j = (await r.json()) as { success: boolean; data?: RDProject; error?: string };
      if (!r.ok || !j.success || !j.data) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setProject(j.data);
      toast.success(successMsg);
      invalidateCachePrefix("/api/rd-projects");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Status update failed");
    } finally {
      setStatusFlipping(null);
    }
  };

  // ─── Complete (PRODUCTION_READY → COMPLETED) ───────────────────────────
  // Terminal flip — project leaves the active pipeline and lands on the
  // Completed tab in /rd. Server enforces that currentStage must be
  // PRODUCTION_READY (matches the button-disabled rule below). On success
  // we invalidate the list cache and navigate back to /rd so the user
  // immediately sees the project on the new Completed tab.
  const handleComplete = async () => {
    if (!project) return;
    if (project.currentStage !== "PRODUCTION_READY") return;
    if (
      !(await confirm({
        title: "Complete project?",
        message:
          "Mark this project as Completed? It will leave the active pipeline and move to the Completed tab.",
        danger: false,
      }))
    )
      return;
    setStatusFlipping("complete");
    try {
      const r = await fetch(`/api/rd-projects/${id}/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      });
      const j = (await r.json()) as { success: boolean; data?: RDProject; error?: string };
      if (!r.ok || !j.success || !j.data) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      invalidateCachePrefix("/api/rd-projects");
      toast.success("Project completed");
      navigate("/rd");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to complete project");
    } finally {
      setStatusFlipping(null);
    }
  };

  const handleHold = () =>
    flipStatus(
      "hold",
      "Put this project on hold? It stays on the Pipeline as ON_HOLD until resumed.",
      "Project on hold",
    );
  const handleResume = () =>
    flipStatus("resume", "Resume this project back to ACTIVE?", "Project resumed");
  const handleReopen = () =>
    flipStatus(
      "reopen",
      "Reopen this completed project? It will return to the active Pipeline at Production Ready.",
      "Project reopened",
    );
  const handleMoveToDraft = () =>
    flipStatus(
      "move-to-draft",
      "Move this project back to Drafts? It will leave the Pipeline; started_at is cleared.",
      "Project moved to Drafts",
    );

  // ─── Advance Stage ──────────────────────────────────────────────────────

  const handleAdvanceStage = async () => {
    if (!project) return;
    const currentIndex = STAGES.indexOf(project.currentStage);
    if (currentIndex >= STAGES.length - 1) return;

    const nextStage = STAGES[currentIndex + 1];
    setAdvancing(true);

    const updatedMilestones = project.milestones.map((m) => {
      if (m.stage === project.currentStage) {
        return { ...m, actualDate: todayYmdMY(), approvedBy: "Current User" };
      }
      return m;
    });

    // 2026-05-27 verifiedSave migration. Stage advance is a gated workflow
    // step — confirm the stage actually moved before reporting success.
    const result = await verifiedSave<RDProject>({
      endpoint: `/api/rd-projects/${id}`,
      method: "PUT",
      body: { currentStage: nextStage, milestones: updatedMilestones },
      readback: async () => {
        const r = await fetch(`/api/rd-projects/${id}?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: RDProject } | RDProject;
        return (j as { data?: RDProject })?.data ?? (j as RDProject) ?? null;
      },
      expect: { currentStage: nextStage },
    });
    if (result.ok) {
      setProject(result.data);
      toast.success(`Advanced to ${getStageLabels(project.projectType)[nextStage]}`);
    } else if (result.reason === "mismatch") {
      toast.error(formatMismatchError(result.diffs));
    } else if (result.reason === "http") {
      let parsedErr = result.body;
      try {
        const j = JSON.parse(result.body) as { error?: string };
        if (j.error) parsedErr = j.error;
      } catch { /* keep raw body */ }
      toast.error(parsedErr || `Failed to advance stage (HTTP ${result.status})`);
    } else {
      toast.error(`Failed to advance stage: ${result.details}`);
    }
    setAdvancing(false);
  };

  // ─── Edit Project ───────────────────────────────────────────────────────

  const openEditModal = () => {
    if (!project) return;
    setEditForm({
      name: project.name,
      description: project.description,
      projectType: project.projectType,
      productCategory: project.productCategory,
      targetLaunchDate: project.targetLaunchDate,
      totalBudget: project.totalBudget / 100, // sen to RM
      targetSellingPriceRM:
        typeof project.targetSellingPriceSen === "number"
          ? (project.targetSellingPriceSen / 100).toString()
          : "",
      targetMaterialCostRM:
        typeof project.targetMaterialCostSen === "number"
          ? (project.targetMaterialCostSen / 100).toString()
          : "",
      assignedTeamStr: project.assignedTeam.join(", "),
      status: project.status,
      sourceProductName: project.sourceProductName ?? "",
      sourceBrand: project.sourceBrand ?? "",
      sourcePurchaseRef: project.sourcePurchaseRef ?? "",
      // Stored in sen on the row; the editor field uses RM. Empty string
      // (not "0") when there's nothing recorded so the input renders
      // as an empty placeholder instead of "0.00".
      sourcePriceRM:
        typeof project.sourcePriceSen === "number"
          ? (project.sourcePriceSen / 100).toString()
          : "",
      sourceNotes: project.sourceNotes ?? "",
    });
    setEditOpen(true);
  };

  // ─── Auto-open Edit modal when ?edit=1 is in the URL ─────────────────
  // Triggered by the Pencil button on RD Projects cards (rd/index.tsx),
  // which navigates to /rd/:id?edit=1 so a single click jumps straight
  // into editing without an extra step on the detail page. The modal-open
  // setStates are deferred via queueMicrotask so React processes them in
  // the next tick rather than mid-effect — also keeps the lint rule for
  // "no synchronous setState in effects" happy.
  useEffect(() => {
    if (!project) return;
    if (searchParams.get("edit") !== "1") return;
    queueMicrotask(() => {
      openEditModal();
      const next = new URLSearchParams(searchParams);
      next.delete("edit");
      setSearchParams(next, { replace: true });
    });
    // openEditModal is defined right above; depending on it would force
    // useCallback ceremony for marginal value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const handleEditSave = async () => {
    if (!project) return;
    setEditSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: editForm.name.trim(),
        description: editForm.description.trim(),
        projectType: editForm.projectType,
        productCategory: editForm.productCategory,
        targetLaunchDate: editForm.targetLaunchDate,
        totalBudget: Math.round(editForm.totalBudget * 100), // RM to sen
        // Pricing targets — empty string → null (clears the cap on server).
        // Otherwise RM → sen with the same convention as totalBudget.
        targetSellingPriceSen: (() => {
          const t = editForm.targetSellingPriceRM.trim().replace(/,/g, "");
          if (!t) return null;
          const rm = parseFloat(t);
          return Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : null;
        })(),
        targetMaterialCostSen: (() => {
          const t = editForm.targetMaterialCostRM.trim().replace(/,/g, "");
          if (!t) return null;
          const rm = parseFloat(t);
          return Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : null;
        })(),
        assignedTeam: editForm.assignedTeamStr.split(",").map((s) => s.trim()).filter(Boolean),
        status: editForm.status,
      };
      // Clone-source fields: send when projectType === 'CLONE' (write or
      // clear). When projectType is changing AWAY from CLONE, blank them
      // so we don't carry stale data on the row. Other types just
      // ignore these columns.
      if (editForm.projectType === "CLONE") {
        payload.sourceProductName = editForm.sourceProductName.trim() || null;
        payload.sourceBrand = editForm.sourceBrand.trim() || null;
        payload.sourcePurchaseRef = editForm.sourcePurchaseRef.trim() || null;
        const priceTrimmed = editForm.sourcePriceRM.trim().replace(/,/g, "");
        if (priceTrimmed) {
          const rm = parseFloat(priceTrimmed);
          payload.sourcePriceSen =
            Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : null;
        } else {
          payload.sourcePriceSen = null;
        }
        payload.sourceNotes = editForm.sourceNotes.trim() || null;
      } else if (project.projectType === "CLONE") {
        payload.sourceProductName = null;
        payload.sourceBrand = null;
        payload.sourcePurchaseRef = null;
        payload.sourcePriceSen = null;
        payload.sourceNotes = null;
      }
      // 2026-05-27 verifiedSave migration. RD project edit is the master
      // record — confirm key header fields landed.
      const result = await verifiedSave<RDProject>({
        endpoint: `/api/rd-projects/${id}`,
        method: "PUT",
        body: payload,
        readback: async () => {
          const r = await fetch(`/api/rd-projects/${id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: RDProject } | RDProject;
          return (j as { data?: RDProject })?.data ?? (j as RDProject) ?? null;
        },
        expect: {
          name: payload.name,
          projectType: payload.projectType,
          status: payload.status,
          targetLaunchDate: payload.targetLaunchDate,
        },
      });
      if (result.ok) {
        setProject(result.data);
        setEditOpen(false);
        toast.success("Project updated successfully");
      } else if (result.reason === "mismatch") {
        toast.error(formatMismatchError(result.diffs));
      } else if (result.reason === "http") {
        let parsedErr = result.body;
        try {
          const j = JSON.parse(result.body) as { error?: string };
          if (j.error) parsedErr = j.error;
        } catch { /* keep raw body */ }
        toast.error(parsedErr || `Failed to update project (HTTP ${result.status})`);
      } else {
        toast.error(`Failed to update project: ${result.details}`);
      }
    } catch {
      toast.error("Failed to update project");
    } finally {
      setEditSaving(false);
    }
  };

  // ─── Add Prototype ──────────────────────────────────────────────────────

  const getNextVersion = (pType: RDPrototypeType): string => {
    if (!project) return "v1";
    const count = project.prototypes.filter((p) => p.prototypeType === pType).length;
    return `v${count + 1}`;
  };

  const openProtoModal = (pType: RDPrototypeType) => {
    const nextVersion = getNextVersion(pType);
    setEditingProtoId(null);
    setProtoForm({
      prototypeType: pType,
      version: nextVersion,
      description: "",
      labourHours: 0,
      testResults: "",
      feedback: "",
      improvements: "",
      defects: "",
      createdDate: todayYmdMY(),
    });
    setProtoOpen(true);
  };

  // Edit-mode entry point. Type and version are identity-ish and stay
  // disabled in the modal (same as Add mode), so we keep the version off
  // the form's editable fields but populate it for display.
  const openProtoEditModal = (proto: RDProject["prototypes"][number]) => {
    setEditingProtoId(proto.id);
    setProtoForm({
      prototypeType: proto.prototypeType,
      version: proto.version,
      description: proto.description ?? "",
      labourHours: proto.labourHours ?? 0,
      testResults: proto.testResults ?? "",
      feedback: proto.feedback ?? "",
      improvements: proto.improvements ?? "",
      defects: proto.defects ?? "",
      createdDate: (proto.createdDate ?? new Date().toISOString()).slice(0, 10),
    });
    setProtoOpen(true);
  };

  const handleProtoSave = async () => {
    if (!project) return;
    if (!protoForm.version.trim()) {
      toast.warning("Version is required");
      return;
    }
    setProtoSaving(true);
    try {
      let updatedPrototypes;
      if (editingProtoId) {
        updatedPrototypes = project.prototypes.map((p) =>
          p.id === editingProtoId
            ? {
                ...p,
                description: protoForm.description.trim(),
                labourHours: protoForm.labourHours,
                testResults: protoForm.testResults.trim(),
                feedback: protoForm.feedback.trim(),
                improvements: protoForm.improvements.trim(),
                defects: protoForm.defects.trim(),
                createdDate: protoForm.createdDate,
              }
            : p,
        );
      } else {
        const newProto = {
          id: `proto-${Date.now()}`,
          projectId: project.id,
          prototypeType: protoForm.prototypeType,
          version: protoForm.version.trim(),
          description: protoForm.description.trim(),
          materialsCost: 0,
          labourHours: protoForm.labourHours,
          testResults: protoForm.testResults.trim(),
          feedback: protoForm.feedback.trim(),
          improvements: protoForm.improvements.trim(),
          defects: protoForm.defects.trim(),
          createdDate: protoForm.createdDate,
        };
        updatedPrototypes = [...project.prototypes, newProto];
      }
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { prototypes: updatedPrototypes },
      });
      if (data.data) setProject(data.data as RDProject);
      setProtoOpen(false);
      setEditingProtoId(null);
      toast.success(editingProtoId ? "Prototype updated successfully" : "Prototype added successfully");
    } catch {
      toast.error(editingProtoId ? "Failed to update prototype" : "Failed to add prototype");
    } finally {
      setProtoSaving(false);
    }
  };

  // ─── Material Issuance ─────────────────────────────────────────────────

  const openIssuanceModal = () => {
    fetchRawMaterials();
    setIssuanceHeader({
      issuedAt: todayYmdMY(),
      issuedBy: "",
      notes: "",
    });
    setIssuanceLines([makeBlankIssuanceLine()]);
    setIssuanceError(null);
    setIssuanceOpen(true);
  };

  const closeIssuanceModal = () => {
    setIssuanceOpen(false);
    setIssuanceError(null);
  };

  // Update a single line by lineKey. Used by every row-level input. We pass
  // a partial patch so callers don't have to hand-spread every field.
  const updateIssuanceLine = (
    lineKey: string,
    patch: Partial<IssuanceLine>,
  ) => {
    setIssuanceLines((lines) =>
      lines.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)),
    );
  };

  // Pick a specific RawMaterial for a given line. Snapshots its code/name/unit
  // and the live balanceQty for inline validation. Passing materialId="" clears
  // the selection (used when the user changes category).
  const selectMaterialForLine = (lineKey: string, materialId: string) => {
    const rm = materialId
      ? rawMaterials.find((r) => r.id === materialId)
      : null;
    if (!rm) {
      updateIssuanceLine(lineKey, {
        materialId: "",
        materialCode: "",
        materialName: "",
        unit: "",
        balanceQty: 0,
      });
      return;
    }
    updateIssuanceLine(lineKey, {
      materialId: rm.id,
      materialCode: rm.itemCode,
      materialName: rm.description,
      unit: rm.baseUOM,
      balanceQty: rm.balanceQty,
    });
  };

  const addIssuanceLine = () => {
    setIssuanceLines((lines) => [...lines, makeBlankIssuanceLine()]);
  };

  const removeIssuanceLine = (lineKey: string) => {
    setIssuanceLines((lines) => {
      // Always keep at least one line — the dialog needs something to edit.
      if (lines.length <= 1) return lines;
      return lines.filter((l) => l.lineKey !== lineKey);
    });
  };

  // Per-line validation used both for inline visual feedback (red borders)
  // and the submit-time gate. Returns null when the line is valid, or a
  // short reason string otherwise.
  const validateIssuanceLine = (line: IssuanceLine): string | null => {
    if (!line.materialId) return "Pick a raw material";
    if (!Number.isFinite(line.qty) || line.qty <= 0) return "Quantity must be > 0";
    if (line.qty > line.balanceQty)
      return `Exceeds balance (${line.balanceQty} ${line.unit})`;
    return null;
  };

  const handleIssueMaterial = async () => {
    if (!project) return;
    setIssuanceError(null);

    // Block submit on any invalid line. The error message points at the
    // first offender so the user can scroll to it.
    for (let i = 0; i < issuanceLines.length; i += 1) {
      const reason = validateIssuanceLine(issuanceLines[i]);
      if (reason) {
        setIssuanceError(`Line ${i + 1}: ${reason}`);
        return;
      }
    }

    setIssuanceSaving(true);
    try {
      // unitCostSen intentionally omitted on every item — server resolves
      // it per-line via FIFO (oldest rm_batches row) at insert time.
      // See resolveFifoUnitCostSen() in src/api/routes/rd-projects.ts.
      // The batch endpoint wraps every line in a single c.var.DB.batch
      // so partial failures roll back cleanly (no orphan stock_movements).
      const res = await fetch(`/api/rd-projects/${id}/issuances/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuedAt: issuanceHeader.issuedAt,
          issuedBy: issuanceHeader.issuedBy.trim(),
          notes: issuanceHeader.notes.trim(),
          items: issuanceLines.map((l) => ({
            rawMaterialId: l.materialId,
            qty: l.qty,
            unit: l.unit,
          })),
        }),
      });
      if (res.ok) {
        const n = issuanceLines.length;
        // Re-fetch project (for actualCost) + issuances list. Inventory also
        // gets refreshed so the next dialog pull sees post-deduction balances.
        await Promise.all([
          fetchProject(),
          fetchIssuances(),
          fetchRawMaterials(),
        ]);
        setIssuanceOpen(false);
        toast.success(`Issued ${n} material${n === 1 ? "" : "s"}`);
      } else {
        let msg = "Failed to issue materials";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // ignore; fall back to generic
        }
        setIssuanceError(msg);
      }
    } catch {
      setIssuanceError("Network error — please try again");
    } finally {
      setIssuanceSaving(false);
    }
  };

  const handleRemoveIssuance = async (issuanceId: string) => {
    if (!project) return;
    try {
      const res = await fetch(
        `/api/rd-projects/${id}/issuances/${issuanceId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to remove issuance");
      await Promise.all([fetchProject(), fetchIssuances()]);
      toast.success("Issuance removed");
    } catch {
      toast.error("Failed to remove issuance");
    }
  };

  // ─── Labour Hours (rd_labour_hours table-backed) ───────────────────────

  const openLabourModal = () => {
    fetchTeamMembers();
    setLabourForm({
      teamMemberId: teamMembers.length > 0 ? teamMembers[0].id : "",
      workDate: todayYmdMY(),
      hours: 1,
      notes: "",
    });
    setLabourOpen(true);
  };

  const handleLogLabour = async () => {
    if (!project) return;
    if (!labourForm.teamMemberId) {
      toast.warning("Team member is required. Add one in R&D Maintenance.");
      return;
    }
    if (!labourForm.workDate) {
      toast.warning("Work date is required");
      return;
    }
    if (labourForm.hours <= 0) {
      toast.warning("Hours must be greater than 0");
      return;
    }
    setLabourSaving(true);
    try {
      const res = await fetch(`/api/rd-projects/${id}/labour-hours`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          teamMemberId: labourForm.teamMemberId,
          workDate: labourForm.workDate,
          hours: labourForm.hours,
          notes: labourForm.notes.trim() || null,
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await Promise.all([fetchProject(), fetchLabourHours()]);
      setLabourOpen(false);
      toast.success("Labour hours logged");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to log labour hours");
    } finally {
      setLabourSaving(false);
    }
  };

  const handleRemoveLabourHour = async (logId: string) => {
    if (!(await confirm({ title: "Remove row?", message: "Remove this labour hours row?", danger: true }))) return;
    try {
      const res = await fetch(
        `/api/rd-projects/${id}/labour-hours/${logId}`,
        { method: "DELETE", credentials: "include" },
      );
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await Promise.all([fetchProject(), fetchLabourHours()]);
      toast.success("Labour hours row removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove labour hours");
    }
  };

  // ─── Manual Labour Cost Override ───────────────────────────────────────

  const openManualCostModal = () => {
    const existing = project?.manualLabourCostSen;
    setManualCostRM(
      typeof existing === "number" ? (existing / 100).toFixed(2) : "",
    );
    setManualCostOpen(true);
  };

  const submitManualCost = async (next: number | null) => {
    setManualCostSaving(true);
    try {
      const res = await fetch(`/api/rd-projects/${id}/labour-cost`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ manualLabourCostSen: next }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await fetchProject();
      setManualCostOpen(false);
      toast.success(next === null ? "Override cleared" : "Labour cost overridden");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update labour cost");
    } finally {
      setManualCostSaving(false);
    }
  };

  const handleSaveManualCost = async () => {
    const rm = parseFloat(manualCostRM);
    if (!Number.isFinite(rm) || rm < 0) {
      toast.warning("Labour cost must be a non-negative number");
      return;
    }
    await submitManualCost(Math.round(rm * 100));
  };

  const handleClearManualCost = async () => {
    if (!(await confirm({ title: "Clear override?", message: "Clear the manual override and revert to the auto-computed labour cost?", danger: true })))
      return;
    await submitManualCost(null);
  };

  // ─── Stage Photo Upload ────────────────────────────────────────────────
  // Helper: read a File as a data URL so we can hand it to the crop dialog
  // BEFORE we compress / save. The dialog re-encodes after cropping, so
  // there's no point compressing twice — we feed the raw image in and let
  // the cropper produce the final JPEG.
  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("Failed to read file"));
      r.readAsDataURL(file);
    });

  const handlePhotoUpload = (stage: string) => {
    setPhotoUploadStage(stage);
    photoInputRef.current?.click();
  };

  // Save a single cropped milestone photo at `stage`. If `replaceIndex` is
  // provided we overwrite that slot; otherwise we append.
  const saveMilestonePhoto = async (
    stage: string,
    croppedDataUrl: string,
    replaceIndex?: number,
  ) => {
    if (!project) return;
    const milestone = project.milestones.find((m) => m.stage === stage);
    const previousPhotos = milestone?.photos ?? [];
    const nextPhotos =
      typeof replaceIndex === "number" && replaceIndex >= 0 && replaceIndex < previousPhotos.length
        ? previousPhotos.map((p, i) => (i === replaceIndex ? croppedDataUrl : p))
        : [...previousPhotos, croppedDataUrl];
    setStagePhotos((prev) => ({ ...prev, [stage]: nextPhotos }));
    const updatedMilestones = project.milestones.map((m) =>
      m.stage === stage ? { ...m, photos: nextPhotos } : m,
    );
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
    } catch {
      toast.error("Failed to save photo");
    }
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const stage = photoUploadStage;
    // Reset the input/state immediately so the user can pick again even
    // if compression / save is still running.
    setPhotoUploadStage(null);
    e.target.value = "";
    if (!files || files.length === 0 || !stage || !project) return;

    // Multi-file: queue all but the first; we open the crop dialog with
    // the first file. After the user confirms, we pop the next file off
    // the queue and re-open the dialog (see handleCropConfirm below).
    const list = Array.from(files);
    const [first, ...rest] = list;
    try {
      const dataUrl = await readFileAsDataUrl(first);
      setCropQueue(rest);
      setCropTarget({ kind: "milestone-add", stage });
      setCropImageUrl(dataUrl);
      setCropOpen(true);
    } catch {
      toast.error("Failed to load photo");
    }
  };

  const removeStagePhoto = async (stage: string, index: number) => {
    if (!project) return;
    const milestone = project.milestones.find((m) => m.stage === stage);
    const localPhotos = stagePhotos[stage];
    const sourcePhotos = (localPhotos && localPhotos.length > 0 ? localPhotos : milestone?.photos) ?? [];
    if (index < 0 || index >= sourcePhotos.length) return;
    const next = [...sourcePhotos.slice(0, index), ...sourcePhotos.slice(index + 1)];

    // Optimistic local update
    setStagePhotos((prev) => ({ ...prev, [stage]: next }));
    const previousProject = project;
    const updatedMilestones = project.milestones.map((m) =>
      m.stage === stage ? { ...m, photos: next } : m,
    );
    setProject({ ...project, milestones: updatedMilestones });

    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
    } catch {
      setProject(previousProject);
      setStagePhotos((prev) => ({ ...prev, [stage]: sourcePhotos }));
      toast.error("Failed to remove photo");
    }
  };

  // Reorder a photo within a milestone's photos[] array (swap adjacent).
  // The leftmost photo is the implicit cover (Ask 2 in the project card).
  const handleReorderPhoto = async (stage: string, index: number, direction: -1 | 1) => {
    if (!project) return;
    const milestone = project.milestones.find((m) => m.stage === stage);
    if (!milestone) return;
    const localPhotos = stagePhotos[stage];
    const sourcePhotos = (localPhotos && localPhotos.length > 0 ? localPhotos : milestone.photos) || [];
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= sourcePhotos.length) return;
    const reordered = [...sourcePhotos];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

    // Optimistic local update so the user sees the swap instantly
    setStagePhotos((prev) => ({ ...prev, [stage]: reordered }));
    const previousProject = project;
    const updatedMilestones = project.milestones.map((m) =>
      m.stage === stage ? { ...m, photos: reordered } : m,
    );
    setProject({ ...project, milestones: updatedMilestones });

    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
    } catch {
      // Rollback on error
      setProject(previousProject);
      setStagePhotos((prev) => ({ ...prev, [stage]: sourcePhotos }));
      toast.error("Failed to reorder photo");
    }
  };

  // ─── Target Date (editable in-place; same model as Target Launch Date) ────
  const handleTargetDateChange = async (stage: string, newDate: string) => {
    if (!project) return;
    const previousProject = project;
    const updatedMilestones = project.milestones.map((m) =>
      m.stage === stage ? { ...m, targetDate: newDate } : m,
    );
    // Optimistic local update
    setProject({ ...project, milestones: updatedMilestones });
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
    } catch {
      setProject(previousProject);
      toast.error("Failed to update target date");
    }
  };

  // ─── Cover Photo ────────────────────────────────────────────────────────
  // Dedicated cover photo (separate from milestone photos[]). One image per
  // project, stored as a JPEG data URL in rd_projects.cover_photo_url.

  // Persist a (already-cropped) data URL as the project's cover photo. The
  // crop dialog produces JPEG output capped at 1280px so we don't run
  // compressImage again — that would re-encode and add a generation of loss
  // for no benefit.
  const saveCoverPhoto = async (croppedDataUrl: string) => {
    if (!project) return;
    setCoverPhotoSaving(true);
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { coverPhotoUrl: croppedDataUrl },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success("Cover photo updated");
    } catch {
      toast.error("Failed to upload cover photo");
    } finally {
      setCoverPhotoSaving(false);
    }
  };

  const handleCoverPhotoUpload = async (file: File | null) => {
    if (!file || !project) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setCropQueue([]);
      setCropTarget({ kind: "cover" });
      setCropImageUrl(dataUrl);
      setCropOpen(true);
    } catch {
      toast.error("Failed to load photo");
    }
  };

  // ── Crop dialog handlers ────────────────────────────────────────────────
  const closeCropDialog = () => {
    setCropOpen(false);
    setCropImageUrl("");
    setCropTarget(null);
    setCropQueue([]);
  };

  const handleCropConfirm = async (croppedDataUrl: string) => {
    const target = cropTarget;
    if (!target) {
      closeCropDialog();
      return;
    }
    if (target.kind === "cover") {
      closeCropDialog();
      await saveCoverPhoto(croppedDataUrl);
      return;
    }
    if (target.kind === "milestone-replace") {
      closeCropDialog();
      await saveMilestonePhoto(target.stage, croppedDataUrl, target.index);
      return;
    }
    // milestone-add: save this one, then advance the queue if more files
    // are pending. We keep the dialog open while there are more.
    await saveMilestonePhoto(target.stage, croppedDataUrl);
    if (cropQueue.length > 0) {
      const [next, ...rest] = cropQueue;
      try {
        const dataUrl = await readFileAsDataUrl(next);
        setCropQueue(rest);
        setCropImageUrl(dataUrl);
        // Keep the dialog open; same target.stage.
      } catch {
        toast.error("Failed to load next photo");
        closeCropDialog();
      }
    } else {
      closeCropDialog();
    }
  };

  // Re-crop an existing photo without re-uploading. Works on both the
  // dedicated cover photo and any milestone photo — addresses the user's
  // ask: "let us pick which part to show" for any photo, fresh or saved.
  const handleEditCoverCrop = () => {
    if (!project?.coverPhotoUrl) return;
    setCropQueue([]);
    setCropTarget({ kind: "cover" });
    setCropImageUrl(project.coverPhotoUrl);
    setCropOpen(true);
  };

  const handleEditMilestoneCrop = (stage: string, index: number, dataUrl: string) => {
    setCropQueue([]);
    setCropTarget({ kind: "milestone-replace", stage, index });
    setCropImageUrl(dataUrl);
    setCropOpen(true);
  };

  const handleCoverPhotoRemove = async () => {
    if (!project) return;
    setCoverPhotoSaving(true);
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { coverPhotoUrl: null },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success("Cover photo removed");
    } catch {
      toast.error("Failed to remove cover photo");
    } finally {
      setCoverPhotoSaving(false);
    }
  };

  // ─── Computed Cost Summary ─────────────────────────────────────────────

  // Sum from the table-backed issuances list, NOT project.materialIssuances
  // (which is no longer surfaced on the project payload after the dual-write
  // cutover; the JSON column is still on the row but not read by the API).
  const materialCostSen = issuances.reduce(
    (sum, i) => sum + (typeof i.totalCostSen === "number" ? i.totalCostSen : 0),
    0,
  );
  // Labour cost summary comes from the server (computed in rd-projects.ts
  // computeLabourCostSummary). Falls back to a zeroed shape if the project
  // payload was fetched before migration 0098 landed.
  const labourSummary = project?.labourCost;
  const totalLabourHours = labourSummary?.totalLabourHours ?? 0;
  const autoLabourCostSen = labourSummary?.laborCostSen ?? 0;
  const partTimeFixedCostSen = labourSummary?.partTimeFixedCostSen ?? 0;
  const isManualLabourCost = labourSummary?.isManualLabourCost ?? false;
  const effectiveLabourCostSen =
    labourSummary?.effectiveLabourCostSen ?? autoLabourCostSen;
  const totalRDCostSen =
    materialCostSen + effectiveLabourCostSen + partTimeFixedCostSen;

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/rd")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to R&D
        </Button>
        <div className="text-center py-16 text-gray-400">Project not found.</div>
      </div>
    );
  }

  const currentStageIndex = STAGES.indexOf(project.currentStage);
  const budgetPct = project.totalBudget > 0 ? Math.round((project.actualCost / project.totalBudget) * 100) : 0;
  const remaining = project.totalBudget - project.actualCost;

  // Step 1 of the picker: distinct active itemGroups, sorted alphabetically.
  // Used by every material line in the multi-line dialog.
  const rmCategoryOptions = Array.from(
    new Set(
      rawMaterials
        .filter((rm) => rm.isActive)
        .map((rm) => rm.itemGroup)
        .filter(Boolean),
    ),
  ).sort();

  // Step 2 of the picker: materials in a given itemGroup, sorted by itemCode.
  // Multi-line dialog calls this per-row to filter the second dropdown.
  const materialsInCategory = (cat: string) =>
    cat
      ? rawMaterials
          .filter((rm) => rm.isActive && rm.itemGroup === cat)
          .sort((a, b) => a.itemCode.localeCompare(b.itemCode))
      : [];

  // The old in-line "first milestone photo" thumbnail derivation lived here;
  // removed in Task #8 along with the small header thumbnail. The dedicated
  // project.coverPhotoUrl is now the single source for the cover image
  // (rendered by coverPhotoCard below).

  // Right-rail combined cover-photo + project-info panel. Previously these
  // were two stacked cards — the user found them small and disconnected, so
  // we merge into one substantial panel: cover photo (or "Upload cover
  // photo" placeholder) at the top, Project Info content directly below in
  // the same card with no separating gap.
  //
  // The image itself drives the container height: `w-full h-auto` lets
  // every saved JPEG (1:1, 4:3, 16:9, or portrait crop) render at its
  // natural aspect with NO letterbox bars. A max-h cap of 480px prevents
  // extreme portrait shots from making the right rail absurdly tall — in
  // that rare case object-contain shows the whole photo with side bars
  // rather than cropping content.
  const coverAndInfoCard = (
    <Card className="overflow-hidden">
      {project.coverPhotoUrl ? (
        <div className="relative bg-[#FAF9F8]">
          <img
            src={project.coverPhotoUrl}
            alt={`${project.name} cover`}
            onClick={() => setCoverZoomOpen(true)}
            className="block w-full h-auto max-h-[480px] object-contain cursor-zoom-in"
          />
          <div className="absolute top-2 right-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleEditCoverCrop}
              disabled={coverPhotoSaving}
              className="inline-flex items-center justify-center rounded-lg border border-[#E2DDD8] bg-white/95 hover:bg-white p-1.5 text-gray-500 hover:text-[#6B5C32] shadow-sm disabled:opacity-50"
              title="Edit crop"
            >
              <Crop className="h-3.5 w-3.5" />
            </button>
            <label className="inline-flex items-center gap-1.5 cursor-pointer rounded-lg border border-[#E2DDD8] bg-white/95 hover:bg-white px-2.5 py-1 text-xs font-medium text-[#1F1D1B] shadow-sm">
              <ImagePlus className="h-3.5 w-3.5" />
              {coverPhotoSaving ? "Saving..." : "Replace"}
              <input
                ref={coverPhotoInputRef}
                type="file"
                accept="image/*"
                disabled={coverPhotoSaving}
                onChange={(e) => {
                  void handleCoverPhotoUpload(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
                className="hidden"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleCoverPhotoRemove()}
              disabled={coverPhotoSaving}
              className="inline-flex items-center justify-center rounded-lg border border-[#E2DDD8] bg-white/95 hover:bg-white p-1.5 text-gray-500 hover:text-[#9A3A2D] shadow-sm disabled:opacity-50"
              title="Remove cover photo"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <label className="flex flex-col items-center justify-center aspect-square cursor-pointer text-gray-400 hover:text-[#6B5C32] hover:bg-[#F0ECE9] bg-[#FAF9F8] transition-colors border-b border-[#E2DDD8]">
          <ImagePlus className="h-10 w-10 mb-2" />
          <span className="text-sm font-medium">
            {coverPhotoSaving ? "Uploading..." : "Upload cover photo"}
          </span>
          <span className="text-xs mt-1 text-gray-400 px-3 text-center">
            A glanceable thumbnail of this project
          </span>
          <input
            type="file"
            accept="image/*"
            disabled={coverPhotoSaving}
            onChange={(e) => {
              void handleCoverPhotoUpload(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
            className="hidden"
          />
        </label>
      )}

      {/* Project Info section — directly below the cover with no gap. The
          old standalone "Project Info" CardHeader is replaced with a smaller
          inline title so the merged panel reads as one unit. Brand /
          Supplier row only renders for CLONE projects. */}
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm">Project Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {project.sourceBrand && (
          <div>
            <p className="text-xs text-gray-400">Brand / Supplier</p>
            <p className="text-[#1F1D1B] font-medium">{project.sourceBrand}</p>
          </div>
        )}
        {project.targetLaunchDate && (
          <div>
            <p className="text-xs text-gray-400">Target Launch</p>
            <p className="text-[#1F1D1B] font-medium">{formatDate(project.targetLaunchDate)}</p>
          </div>
        )}
        {project.assignedTeam.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 mb-1">Team</p>
            <div className="flex flex-wrap gap-1">
              {project.assignedTeam.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-xs text-[#6B5C32]"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
        {project.serviceId && (
          <div>
            <p className="text-xs text-gray-400">Service Ref</p>
            <p className="font-mono text-[#6B5C32]">{project.serviceId}</p>
          </div>
        )}
        {!project.sourceBrand &&
          !project.targetLaunchDate &&
          project.assignedTeam.length === 0 &&
          !project.serviceId && (
            <p className="text-xs text-gray-400">No project info recorded yet.</p>
          )}
      </CardContent>
    </Card>
  );

  // Right-rail Budget card. Lives directly under coverAndInfoCard in the
  // sticky aside. The Target Launch / Team row that used to live at the
  // bottom of this card has been dropped here because that data is already
  // surfaced in the Project Info section above (no duplication).
  // Pricing-target derived figures used in the Budget card. Selling price
  // and material cost are sen on the project; margin = price - cost. A
  // null/zero target collapses the section so it doesn't shout at projects
  // that haven't been priced yet.
  const sellingPriceSen = project.targetSellingPriceSen ?? null;
  const materialTargetSen = project.targetMaterialCostSen ?? null;
  const targetedMarginSen =
    sellingPriceSen !== null && materialTargetSen !== null
      ? sellingPriceSen - materialTargetSen
      : null;
  const targetedMarginPct =
    sellingPriceSen !== null && sellingPriceSen > 0 && targetedMarginSen !== null
      ? (targetedMarginSen / sellingPriceSen) * 100
      : null;
  // Material-vs-target health: how the actual R&D material spend so far
  // (materialCostSen) compares to the production cap. If it's already
  // 100%+ during R&D the production BOM is doomed; if 80%+ it's a
  // warning to redesign before approving for production.
  const materialVsTargetPct =
    materialTargetSen !== null && materialTargetSen > 0
      ? (materialCostSen / materialTargetSen) * 100
      : null;

  const budgetCard = (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-gray-400" /> Budget
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Pricing Targets — the commercial envelope set up front by the
            operator. Drives every BOM decision the R&D team makes. Hidden
            entirely when neither target is set so the card doesn't grow
            empty rows for legacy projects. */}
        {(sellingPriceSen !== null || materialTargetSen !== null) && (
          <div className="rounded-lg bg-[#F8F4ED] border border-[#E2DDD8] p-3 space-y-2">
            <div className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide">
              Pricing Targets
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-gray-500">Selling Price</p>
                <p className="text-base font-bold text-[#1F1D1B]">
                  {sellingPriceSen !== null ? formatCurrency(sellingPriceSen) : <span className="text-gray-300">—</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Material Cap</p>
                <p className="text-base font-bold text-[#1F1D1B]">
                  {materialTargetSen !== null ? formatCurrency(materialTargetSen) : <span className="text-gray-300">—</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Margin</p>
                <p className={`text-base font-bold ${targetedMarginSen !== null && targetedMarginSen < 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                  {targetedMarginSen !== null
                    ? `${formatCurrency(targetedMarginSen)}${targetedMarginPct !== null ? ` (${Math.round(targetedMarginPct)}%)` : ""}`
                    : <span className="text-gray-300">—</span>}
                </p>
              </div>
            </div>
            {/* Material-vs-target gauge — only renders when a material
                cap is set. Shows the operator how close the R&D BOM is
                running to the production ceiling. */}
            {materialVsTargetPct !== null && (
              <div className="space-y-1 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">R&D Material vs Target</span>
                  <span
                    className="font-semibold"
                    style={{
                      color:
                        materialVsTargetPct >= 100 ? "#9A3A2D" : materialVsTargetPct >= 80 ? "#9C6F1E" : "#4F7C3A",
                    }}
                  >
                    {Math.round(materialVsTargetPct)}%
                  </span>
                </div>
                <div className="h-2 bg-white border border-[#E2DDD8] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(materialVsTargetPct, 100)}%`,
                      backgroundColor:
                        materialVsTargetPct >= 100 ? "#9A3A2D" : materialVsTargetPct >= 80 ? "#9C6F1E" : "#4F7C3A",
                    }}
                  />
                </div>
                {materialVsTargetPct >= 100 && (
                  <p className="text-xs text-[#9A3A2D] font-medium">
                    R&D material spend is at or above the production cap — redesign before approving for production.
                  </p>
                )}
                {materialVsTargetPct >= 80 && materialVsTargetPct < 100 && (
                  <p className="text-xs text-[#9C6F1E]">
                    R&D material spend is approaching the production cap. Watch the BOM.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-3 rounded-lg bg-[#F0ECE9]">
            <p className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(project.totalBudget)}</p>
            <p className="text-xs text-gray-500">Total Budget</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-[#FAEFCB]">
            <p className="text-lg font-bold text-[#9C6F1E]">{formatCurrency(project.actualCost)}</p>
            <p className="text-xs text-gray-500">Actual Cost</p>
          </div>
          <div className="text-center p-3 rounded-lg" style={{ backgroundColor: remaining >= 0 ? "#F0FDF4" : "#FEF2F2" }}>
            <p className={`text-lg font-bold ${remaining >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>{formatCurrency(Math.abs(remaining))}</p>
            <p className="text-xs text-gray-500">{remaining >= 0 ? "Remaining" : "Over Budget"}</p>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Budget Utilisation</span>
            <span className="font-medium" style={{ color: budgetPct > 90 ? "#DC2626" : budgetPct > 70 ? "#D97706" : "#16A34A" }}>
              {budgetPct}%
            </span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(budgetPct, 100)}%`,
                backgroundColor: budgetPct > 90 ? "#DC2626" : budgetPct > 70 ? "#D97706" : "#16A34A",
              }}
            />
          </div>
        </div>

        {/* R&D Cost Breakdown */}
        <div className="pt-3 border-t border-[#E2DDD8] space-y-2">
          <p className="text-xs font-semibold text-gray-500">R&D Cost Breakdown</p>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Material Cost</span>
              <span className="font-medium text-[#1F1D1B]">{formatCurrency(materialCostSen)}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500 inline-flex items-center gap-1.5">
                Labour Cost
                {isManualLabourCost ? (
                  <span className="inline-flex items-center rounded-full bg-[#FAEFCB] text-[#9C6F1E] border border-[#E8D597] px-1.5 py-0.5 text-[10px] font-semibold">
                    Manual
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">
                    ({totalLabourHours}h auto)
                  </span>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="font-medium text-[#1F1D1B]">{formatCurrency(effectiveLabourCostSen)}</span>
                <button
                  type="button"
                  onClick={openManualCostModal}
                  className="rounded p-1 text-gray-400 hover:text-[#6B5C32] hover:bg-[#F0ECE9]"
                  title="Override labour cost"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                {isManualLabourCost && (
                  <button
                    type="button"
                    onClick={handleClearManualCost}
                    disabled={manualCostSaving}
                    className="rounded p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-50"
                    title="Clear override"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            </div>
            {partTimeFixedCostSen > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Total Fixed Cost (PT)</span>
                <span className="font-medium text-[#1F1D1B]">{formatCurrency(partTimeFixedCostSen)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm pt-1 border-t border-dashed border-[#E2DDD8]">
              <span className="font-semibold text-[#1F1D1B]">Total R&D Cost</span>
              <span className="font-bold text-[#1F1D1B]">{formatCurrency(totalRDCostSen)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  // Action buttons row — extracted from the old header block so the banner
  // can lay out the title + actions on separate lines without nesting tons
  // of flex containers. Buttons wrap below the title/badges block on narrow
  // viewports thanks to flex-wrap.
  const actionButtons = (
    <div className="flex items-center justify-end flex-wrap gap-2">
      <Button variant="outline" onClick={openEditModal} className="gap-1.5">
        <Pencil className="h-4 w-4" /> Edit
      </Button>
      {project.status === "ACTIVE" && (
        <>
          <Button
            variant="outline"
            onClick={handleHold}
            disabled={statusFlipping !== null}
            className="gap-1.5"
          >
            <Pause className="h-4 w-4" />
            {statusFlipping === "hold" ? "Holding..." : "Hold"}
          </Button>
          <Button
            variant="outline"
            onClick={handleMoveToDraft}
            disabled={statusFlipping !== null}
            className="gap-1.5"
          >
            <Archive className="h-4 w-4" />
            {statusFlipping === "move-to-draft" ? "Moving..." : "Move to Drafts"}
          </Button>
          {/* Complete — only enabled once the project has reached the final
              stage (PRODUCTION_READY). Earlier stages render the button as
              disabled with a tooltip explaining the gate. The server
              enforces the same rule (POST /:id/complete returns 400 if
              stage is not PRODUCTION_READY). */}
          <Button
            variant="outline"
            onClick={handleComplete}
            disabled={
              statusFlipping !== null ||
              project.currentStage !== "PRODUCTION_READY"
            }
            className="gap-1.5"
            title={
              project.currentStage !== "PRODUCTION_READY"
                ? "Project must reach Production Ready before it can be completed"
                : "Mark this project as completed"
            }
          >
            <CheckCircle2 className="h-4 w-4" />
            {statusFlipping === "complete" ? "Completing..." : "Complete"}
          </Button>
        </>
      )}
      {project.status === "ON_HOLD" && (
        <>
          <Button
            variant="outline"
            onClick={handleResume}
            disabled={statusFlipping !== null}
            className="gap-1.5"
          >
            <Play className="h-4 w-4" />
            {statusFlipping === "resume" ? "Resuming..." : "Resume"}
          </Button>
          <Button
            variant="outline"
            onClick={handleMoveToDraft}
            disabled={statusFlipping !== null}
            className="gap-1.5"
          >
            <Archive className="h-4 w-4" />
            {statusFlipping === "move-to-draft" ? "Moving..." : "Move to Drafts"}
          </Button>
        </>
      )}
      {/* COMPLETED: only Reopen — moves the project back to ACTIVE so the
          user can record more iterations or undo an accidental complete. */}
      {project.status === "COMPLETED" && (
        <Button
          variant="outline"
          onClick={handleReopen}
          disabled={statusFlipping !== null}
          className="gap-1.5"
        >
          <Play className="h-4 w-4" />
          {statusFlipping === "reopen" ? "Reopening..." : "Reopen"}
        </Button>
      )}
      {currentStageIndex < STAGES.length - 1 && project.status === "ACTIVE" && (
        <Button variant="primary" onClick={handleAdvanceStage} disabled={advancing}>
          {advancing ? "Advancing..." : `Advance to ${getStageLabels(project.projectType)[STAGES[currentStageIndex + 1]]}`}
          {!advancing && <ChevronRight className="h-4 w-4 ml-1" />}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" onClick={() => navigate("/rd")} className="gap-2">
        <ArrowLeft className="h-4 w-4" /> Back to R&D
      </Button>

      {/* Header banner — full-width, sits ABOVE the cover panel + main grid.
          Two stacked rows: first row is the project code + badges + title +
          subtitle (left-aligned); second row is the action buttons aligned
          right. With Complete + Advance now in the row, the previous
          inline-with-title layout was wrapping awkwardly and squeezing the
          project code into a vertical strip — separating into two rows
          gives every element room to breathe. */}
      <div className="space-y-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap mb-1">
            <span className="text-sm font-mono text-gray-400">{project.code}</span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${CATEGORY_COLORS[project.productCategory]}`}>
              {project.productCategory}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                project.projectType === "IMPROVEMENT"
                  ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                  : project.projectType === "CLONE"
                  ? "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]"
                  : "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]"
              }`}
            >
              {project.projectType === "IMPROVEMENT"
                ? "Improvement"
                : project.projectType === "CLONE"
                ? "Clone / Replicate"
                : "Research"}
            </span>
            <Badge variant="status" status={project.status}>{project.status.replace(/_/g, " ")}</Badge>
          </div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">{project.name}</h1>
          {project.serviceId && (
            <p className="text-xs text-gray-400 mt-0.5">
              Service Ref: <span className="font-mono font-medium text-[#6B5C32]">{project.serviceId}</span>
            </p>
          )}
          {project.description && (
            <p className="text-sm text-gray-500 mt-1">{project.description}</p>
          )}
        </div>
        {actionButtons}
      </div>

      {/* 2-column layout: main content (lg: 2/3) + sticky right rail with
          cover photo and project info (lg: 1/3). The right rail collapses
          BELOW the main column on small screens so the cover stays visible.
          The header (code/title/badges/actions) lives ABOVE this grid in
          its own banner — don't duplicate any of that here. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <div className="lg:col-span-2 space-y-6">
      {/* Stage Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stage Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-0">
            {STAGES.map((stage, i) => {
              const isCompleted = i < currentStageIndex;
              const isCurrent = i === currentStageIndex;
              const isFuture = i > currentStageIndex;
              return (
                <div key={stage} className="flex-1 flex flex-col items-center relative">
                  {/* Connector line */}
                  {i > 0 && (
                    <div
                      className="absolute top-4 right-1/2 w-full h-0.5"
                      style={{ backgroundColor: isCompleted || isCurrent ? STAGE_COLORS[stage] : "#E2DDD8" }}
                    />
                  )}
                  {/* Circle */}
                  <div
                    className="relative z-10 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold border-2"
                    style={{
                      backgroundColor: isCompleted ? STAGE_COLORS[stage] : isCurrent ? "white" : "#F9FAFB",
                      borderColor: isFuture ? "#E2DDD8" : STAGE_COLORS[stage],
                      color: isCompleted ? "white" : isCurrent ? STAGE_COLORS[stage] : "#9CA3AF",
                    }}
                  >
                    {isCompleted ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  <p
                    className="text-[10px] font-medium mt-1 text-center"
                    style={{ color: isFuture ? "#9CA3AF" : STAGE_COLORS[stage] }}
                  >
                    {getStageLabels(project.projectType)[stage]}
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Clone source — only shown for CLONE projects with at least one field set */}
      {project.projectType === "CLONE" &&
        (project.sourceProductName ||
          project.sourceBrand ||
          project.sourcePurchaseRef ||
          (typeof project.sourcePriceSen === "number" && project.sourcePriceSen > 0) ||
          project.sourceNotes) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Package className="h-4 w-4 text-gray-400" /> Clone Source
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {project.sourceProductName && (
                  <div>
                    <dt className="text-xs text-gray-400">Product / Model</dt>
                    <dd className="text-[#1F1D1B] font-medium">{project.sourceProductName}</dd>
                  </div>
                )}
                {/* Brand/Supplier moved to the right-rail Project Info card. */}
                {project.sourcePurchaseRef && (
                  <div>
                    <dt className="text-xs text-gray-400">Purchase Ref / Invoice No.</dt>
                    <dd className="font-mono text-[#6B5C32]">{project.sourcePurchaseRef}</dd>
                  </div>
                )}
                {typeof project.sourcePriceSen === "number" && project.sourcePriceSen > 0 && (
                  <div>
                    <dt className="text-xs text-gray-400">Purchase Price</dt>
                    <dd className="text-[#1F1D1B] font-medium tabular-nums">
                      {formatCurrency(project.sourcePriceSen)}
                    </dd>
                  </div>
                )}
                {project.sourceNotes && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-gray-400">Notes</dt>
                    <dd className="text-[#1F1D1B] whitespace-pre-wrap">{project.sourceNotes}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
        )}

      {/* Milestones — full width main column. The Budget card has been moved
          to the right rail, so Milestones now spans the entire main column
          giving the date / photo cells more breathing room. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-400" /> Milestones
            </CardTitle>
          </CardHeader>
          <CardContent>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handlePhotoFileChange}
            />
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Stage</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Target</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Actual</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Status</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Approved By</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Photos</th>
                </tr>
              </thead>
              <tbody>
                {project.milestones.map((m) => {
                  const photos = stagePhotos[m.stage] || m.photos || [];
                  return (
                    <tr key={m.stage} className="border-b border-[#E2DDD8]/50 align-top">
                      <td className="py-2">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                          style={{ backgroundColor: STAGE_COLORS[m.stage] }}
                        >
                          {getStageLabels(project.projectType)[m.stage]}
                        </span>
                      </td>
                      <td className="py-2 text-xs">
                        {/* Target: editable; persisted ISO date stripped to YYYY-MM-DD, blank when unset */}
                        <input
                          type="date"
                          value={(m.targetDate || "").slice(0, 10)}
                          onChange={(e) => handleTargetDateChange(m.stage, e.target.value)}
                          className="rounded border border-[#E2DDD8] px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30 text-gray-600"
                          title="Target completion date"
                        />
                      </td>
                      <td className="py-2 text-xs">
                        {m.actualDate ? (
                          <span className="text-[#4F7C3A] font-medium">{formatDate(m.actualDate)}</span>
                        ) : (
                          <span className="text-gray-300">--</span>
                        )}
                      </td>
                      <td className="py-2">
                        <MilestoneStatusChip
                          targetDate={m.targetDate ?? null}
                          actualDate={m.actualDate ?? null}
                        />
                      </td>
                      <td className="py-2 text-xs text-gray-600">{m.approvedBy || <span className="text-gray-300">--</span>}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {photos.map((photo, idx) => {
                            const isFirst = idx === 0;
                            const isLast = idx === photos.length - 1;
                            return (
                              <div key={idx} className="relative group/photo">
                                <img
                                  src={photo}
                                  alt={`${getStageLabels(project.projectType)[m.stage]} photo ${idx + 1}`}
                                  className={`h-10 w-10 rounded-md object-cover border cursor-pointer hover:ring-2 hover:ring-[#6B5C32]/40 ${
                                    isFirst ? "border-[#6B5C32] ring-1 ring-[#6B5C32]/30" : "border-[#E2DDD8]"
                                  }`}
                                  onClick={() => window.open(photo, "_blank")}
                                  title={isFirst ? "Cover photo (shown on project card)" : `Photo ${idx + 1}`}
                                />
                                {/* Left chevron — disabled for first */}
                                <button
                                  onClick={() => handleReorderPhoto(m.stage, idx, -1)}
                                  disabled={isFirst}
                                  className="absolute top-1/2 -left-2 -translate-y-1/2 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-white border border-[#E2DDD8] shadow text-gray-500 hover:text-[#6B5C32] disabled:opacity-30 disabled:cursor-not-allowed"
                                  title="Move left"
                                >
                                  <ChevronLeft className="h-3 w-3" />
                                </button>
                                {/* Right chevron — disabled for last */}
                                <button
                                  onClick={() => handleReorderPhoto(m.stage, idx, 1)}
                                  disabled={isLast}
                                  className="absolute top-1/2 -right-2 -translate-y-1/2 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-white border border-[#E2DDD8] shadow text-gray-500 hover:text-[#6B5C32] disabled:opacity-30 disabled:cursor-not-allowed"
                                  title="Move right"
                                >
                                  <ChevronRight className="h-3 w-3" />
                                </button>
                                {/* Edit crop — opens crop dialog with the
                                    current photo so the user can re-pick
                                    the focal area without re-uploading. */}
                                <button
                                  onClick={() => handleEditMilestoneCrop(m.stage, idx, photo)}
                                  className="absolute -top-1.5 -left-1.5 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-[#6B5C32] text-white"
                                  title="Edit crop"
                                >
                                  <Crop className="h-2.5 w-2.5" />
                                </button>
                                <button
                                  onClick={() => removeStagePhoto(m.stage, idx)}
                                  className="absolute -top-1.5 -right-1.5 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-[#9A3A2D] text-white text-[8px]"
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              </div>
                            );
                          })}
                          <button
                            onClick={() => handlePhotoUpload(m.stage)}
                            className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-[#D0C9C0] text-gray-400 hover:border-[#6B5C32] hover:text-[#6B5C32] hover:bg-[#F0ECE9] transition-colors"
                            title={`Add photo for ${getStageLabels(project.projectType)[m.stage]}`}
                          >
                            <ImagePlus className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>

      {/* Prototypes — split by type */}
      {(["FABRIC_SEWING", "FRAMING"] as RDPrototypeType[]).map((pType) => {
        const typeProtos = project.prototypes.filter((p) => p.prototypeType === pType);
        return (
          <Card key={pType}>
            <CardHeader>
              <div className="flex items-center justify-between w-full">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Beaker className="h-4 w-4 text-gray-400" />
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${PROTO_TYPE_COLORS[pType]}`}>
                    {PROTO_TYPE_LABELS[pType]}
                  </span>
                  Prototypes ({typeProtos.length})
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openProtoModal(pType)}
                  className="gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" /> Add {PROTO_TYPE_LABELS[pType]}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {typeProtos.length === 0 ? (
                <div className="text-center py-6 text-gray-300 text-sm">No {PROTO_TYPE_LABELS[pType].toLowerCase()} prototypes yet.</div>
              ) : (
                <div className="space-y-4">
                  {typeProtos.map((proto) => (
                    <div key={proto.id} className="border border-[#E2DDD8] rounded-lg p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-full bg-[#6B5C32] text-white px-2.5 py-0.5 text-xs font-semibold">
                              {proto.version}
                            </span>
                            <span className="text-xs text-gray-400">{formatDate(proto.createdDate)}</span>
                          </div>
                          <p className="text-sm font-medium text-[#1F1D1B] mt-1">{proto.description}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => openProtoEditModal(proto)}
                          className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-[#E2DDD8] bg-white px-2 py-1 text-xs font-medium text-gray-500 hover:text-[#6B5C32] hover:border-[#6B5C32]"
                          title="Edit prototype"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="h-3.5 w-3.5 text-gray-400" />
                        <span className="text-gray-500">Labour Hours:</span>
                        <span className="font-medium">{proto.labourHours}h</span>
                      </div>
                      {/* Improvements section */}
                      {proto.improvements && (
                        <div className="rounded-lg bg-[#EEF3E4] border border-[#C6DBA8] p-3">
                          <p className="text-xs font-semibold text-[#4F7C3A] mb-0.5">Improvements</p>
                          <p className="text-xs text-[#4F7C3A] whitespace-pre-wrap">{proto.improvements}</p>
                        </div>
                      )}
                      {/* Defects section */}
                      {proto.defects && (
                        <div className="rounded-lg bg-[#FAEFCB] border border-[#E8D597] p-3">
                          <p className="text-xs font-semibold text-[#9C6F1E] mb-0.5">Defects</p>
                          <p className="text-xs text-[#9C6F1E] whitespace-pre-wrap">{proto.defects}</p>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <p className="text-xs text-gray-500 mb-0.5">Test Results</p>
                          <p className="text-xs text-[#1F1D1B] bg-[#F0ECE9] rounded p-2">{proto.testResults || "\u2014"}</p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500 mb-0.5">Feedback</p>
                          <p className="text-xs text-[#1F1D1B] bg-[#F0ECE9] rounded p-2">{proto.feedback || "\u2014"}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Production BOM section removed per Task #8 — production BOM
          management is no longer surfaced on the R&D detail page. */}

      {/* Material Issuance Log */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-sm flex items-center gap-2">
              <Package className="h-4 w-4 text-gray-400" />
              Material Issuance — Raw Material Usage
              <span className="text-xs font-normal font-mono text-gray-400">{project.code}</span>
            </CardTitle>
            <Button variant="outline" size="sm" onClick={openIssuanceModal} className="gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> Issue Material
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {issuances.length === 0 ? (
            <div className="text-center py-8 text-gray-300 text-sm">
              No materials issued yet. Issue raw materials to track R&D consumption.
            </div>
          ) : (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Date</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Internal Code</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Material Name</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Qty</th>
                    <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500">Unit</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Unit Cost (RM)</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Total (RM)</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Issued By</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Notes</th>
                    <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {issuances.map((iss) => (
                    <tr key={iss.id} className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50">
                      <td className="py-2 px-2 text-xs text-gray-600">{formatDate(iss.issuedAt)}</td>
                      <td className="py-2 px-2 text-xs font-mono text-gray-500">{iss.materialCode}</td>
                      <td className="py-2 px-2 text-sm text-[#1F1D1B]">{iss.materialName}</td>
                      <td className="py-2 px-2 text-right text-sm">{iss.qty}</td>
                      <td className="py-2 px-2 text-center text-xs text-gray-500">{iss.unit}</td>
                      <td className="py-2 px-2 text-right text-sm">{formatCurrency(iss.unitCostSen)}</td>
                      <td className="py-2 px-2 text-right text-sm font-semibold">{formatCurrency(iss.totalCostSen)}</td>
                      <td className="py-2 px-2 text-xs text-gray-600">{iss.issuedBy ?? ""}</td>
                      <td className="py-2 px-2 text-xs text-gray-500 max-w-[120px] truncate" title={iss.notes ?? ""}>{iss.notes || "\u2014"}</td>
                      <td className="py-2 px-2 text-center">
                        <button
                          onClick={() => handleRemoveIssuance(iss.id)}
                          className="text-gray-300 hover:text-[#7A2E24] transition-colors"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t-2 border-[#E2DDD8] pt-3 flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Total Material Issuance ({issuances.length} entries)
                </div>
                <div className="text-lg font-bold text-[#1F1D1B]">
                  {formatCurrency(materialCostSen)}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Labour Hours \u2014 table-backed (rd_labour_hours), joined to
          rd_team_members. Auto-cost shown per row uses the FT hourly rate;
          PT rows show "\u2014" since their cost is the flat per-project fixed
          line on the budget card. */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-4 w-4 text-gray-400" />
              Labour Hours
              {totalLabourHours > 0 && (
                <span className="text-xs font-normal text-gray-400">
                  ({totalLabourHours}h total)
                </span>
              )}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={openLabourModal} className="gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> Add Hours
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {labourHours.length === 0 ? (
            <div className="text-center py-8 text-gray-300 text-sm">
              No labour hours logged yet. Add hours to track R&D labour cost.
              {teamMembers.length === 0 && (
                <div className="mt-2 text-xs text-gray-400">
                  Add team members in R&D Maintenance first.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Date</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Member</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Type</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Hours</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Auto Cost</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Notes</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {labourHours.map((row) => (
                    <tr key={row.id} className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50">
                      <td className="py-2 px-2 text-xs text-gray-600">{formatDate(row.workDate)}</td>
                      <td className="py-2 px-2 text-sm font-medium text-[#1F1D1B]">{row.memberName}</td>
                      <td className="py-2 px-2 text-xs text-gray-500">
                        {row.employmentType === "FULL_TIME" ? "FT" : "PT"}
                      </td>
                      <td className="py-2 px-2 text-right text-sm font-medium">{row.hours}h</td>
                      <td className="py-2 px-2 text-right text-sm">
                        {row.employmentType === "FULL_TIME"
                          ? formatCurrency(row.autoCostSen)
                          : <span className="text-gray-400">\u2014</span>}
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-600">{row.notes || "\u2014"}</td>
                      <td className="py-2 px-1 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveLabourHour(row.id)}
                          className="rounded p-1 text-gray-300 hover:text-red-500 hover:bg-red-50"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t-2 border-[#E2DDD8] pt-3 flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Total Labour Hours ({labourHours.length} entries)
                </div>
                <div className="text-lg font-bold text-[#1F1D1B]">
                  {totalLabourHours}h
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* Right rail — sticky combined cover photo + project info panel,
          followed by the Budget card stacked beneath. Stacks below the main
          column on small screens (lg breakpoint flips to side-by-side). */}
      <aside className="lg:col-span-1 lg:sticky lg:top-4 self-start">
        {coverAndInfoCard}
        {budgetCard}
      </aside>
      </div>

      {/* Per-record audit trail — surfaces every status flip / edit / save
          on this RD project. Empty until the rd-projects route starts
          emitting audit_events; the panel handles the empty state. */}
      <AuditHistoryPanel
        resource="rd-projects"
        resourceId={project.id}
        fieldLabels={{
          name: "Name",
          description: "Description",
          projectType: "Project Type",
          productCategory: "Category",
          currentStage: "Stage",
          status: "Status",
          targetLaunchDate: "Target Launch",
          totalBudget: "R&D Budget (sen)",
          targetSellingPriceSen: "Target Selling Price (sen)",
          targetMaterialCostSen: "Target Material Cost (sen)",
          coverPhotoUrl: "Cover Photo",
          assignedTeam: "Team",
        }}
      />

      {/* ─── Edit Project Modal ──────────────────────────────────────────── */}
      <ModalOverlay open={editOpen} onClose={() => setEditOpen(false)} title="Edit Project">
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Name</label>
            <input
              className={inputClass}
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={3}
              value={editForm.description}
              onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div>
            <label className={labelClass}>Project Type</label>
            <select
              className={selectClass}
              value={editForm.projectType}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  projectType: e.target.value as RDProject["projectType"],
                }))
              }
            >
              <option value="DEVELOPMENT">New Product Research</option>
              <option value="IMPROVEMENT">Improvement / Repair</option>
              <option value="CLONE">Clone / Replicate Competitor</option>
            </select>
          </div>
          {/* Clone source fieldset — mirrors the Create dialog fieldset.
              Switching projectType AWAY from CLONE wipes these on save
              (handleEditSave nulls them) so we don't carry stale data. */}
          {editForm.projectType === "CLONE" && (
            <div className="rounded-lg border border-dashed border-[#E2DDD8] bg-[#FBF9F6] p-3 space-y-3">
              <p className="text-xs text-gray-500">
                Source product info — what we bought to reverse-engineer.
              </p>
              <div>
                <label className={labelClass}>Source Product / Model Name</label>
                <input
                  className={inputClass}
                  value={editForm.sourceProductName}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, sourceProductName: e.target.value }))
                  }
                  placeholder="e.g. Comfy Recliner Pro"
                />
              </div>
              <div>
                <label className={labelClass}>Source Brand / Supplier</label>
                <input
                  className={inputClass}
                  value={editForm.sourceBrand}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, sourceBrand: e.target.value }))
                  }
                  placeholder="e.g. ABC Furniture Sdn Bhd"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Purchase Reference</label>
                  <input
                    className={inputClass}
                    value={editForm.sourcePurchaseRef}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, sourcePurchaseRef: e.target.value }))
                    }
                    placeholder="INV-2026-0421"
                  />
                </div>
                <div>
                  <label className={labelClass}>Purchase Price (RM)</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()}
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    className={inputClass}
                    value={editForm.sourcePriceRM}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, sourcePriceRM: e.target.value }))
                    }
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Source Notes</label>
                <textarea
                  className={`${inputClass} resize-none`}
                  rows={3}
                  value={editForm.sourceNotes}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, sourceNotes: e.target.value }))
                  }
                  placeholder="Dimensions, key specs, why we want to copy..."
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Category</label>
              <select
                className={selectClass}
                value={editForm.productCategory}
                onChange={(e) => setEditForm((f) => ({ ...f, productCategory: e.target.value as RDProject["productCategory"] }))}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Status</label>
              <select
                className={selectClass}
                value={editForm.status}
                onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value as RDProject["status"] }))}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Target Launch Date</label>
              <input
                type="date"
                className={inputClass}
                value={editForm.targetLaunchDate}
                onChange={(e) => setEditForm((f) => ({ ...f, targetLaunchDate: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelClass}>R&D Budget (RM)</label>
              <input
                type="number" onFocus={(e) => e.currentTarget.select()}
                className={inputClass}
                min={0}
                step={0.01}
                value={editForm.totalBudget}
                onChange={(e) => setEditForm((f) => ({ ...f, totalBudget: parseFloat(e.target.value) || 0 }))}
                title="Total R&D project cost cap — material + labour"
              />
            </div>
          </div>
          {/* Pricing targets — set up front so R&D engineers the product to
              the commercial envelope. Selling price drives margin; the
              material cost cap is the BOM ceiling production must hit. Both
              are optional (leave blank to skip). */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Target Selling Price (RM)</label>
              <input
                type="number" onFocus={(e) => e.currentTarget.select()}
                className={inputClass}
                min={0}
                step={0.01}
                value={editForm.targetSellingPriceRM}
                onChange={(e) => setEditForm((f) => ({ ...f, targetSellingPriceRM: e.target.value }))}
                placeholder="e.g. 500.00"
                title="Planned retail / wholesale price for the finished product"
              />
            </div>
            <div>
              <label className={labelClass}>Target Material Cost (RM)</label>
              <input
                type="number" onFocus={(e) => e.currentTarget.select()}
                className={inputClass}
                min={0}
                step={0.01}
                value={editForm.targetMaterialCostRM}
                onChange={(e) => setEditForm((f) => ({ ...f, targetMaterialCostRM: e.target.value }))}
                placeholder="e.g. 200.00"
                title="Upper bound for raw-material cost in production. R&D treats this as the BOM ceiling."
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Team Members (comma-separated)</label>
            <input
              className={inputClass}
              value={editForm.assignedTeamStr}
              onChange={(e) => setEditForm((f) => ({ ...f, assignedTeamStr: e.target.value }))}
              placeholder="Ahmad Razif, Tan Mei Ling"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleEditSave} disabled={editSaving}>
              {editSaving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Add / Edit Prototype Modal ──────────────────────────────────── */}
      <ModalOverlay
        open={protoOpen}
        onClose={() => { setProtoOpen(false); setEditingProtoId(null); }}
        title={`${editingProtoId ? "Edit" : "Add"} ${PROTO_TYPE_LABELS[protoForm.prototypeType]} Prototype`}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Prototype Type</label>
              <select
                className={`${selectClass} bg-gray-50`}
                value={protoForm.prototypeType}
                disabled
              >
                <option value="FABRIC_SEWING">Fabric Sewing</option>
                <option value="FRAMING">Framing</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Version</label>
              <input
                className={`${inputClass} bg-gray-50`}
                value={protoForm.version}
                disabled
              />
            </div>
            <div>
              <label className={labelClass}>Date</label>
              <input
                type="date"
                className={inputClass}
                value={protoForm.createdDate}
                onChange={(e) => setProtoForm((f) => ({ ...f, createdDate: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={3}
              value={protoForm.description}
              onChange={(e) => setProtoForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Describe this prototype iteration..."
            />
          </div>
          <div>
            <label className={labelClass}>Labour Hours</label>
            <input
              type="number" onFocus={(e) => e.currentTarget.select()}
              className={inputClass}
              min={0}
              step={0.5}
              value={protoForm.labourHours}
              onChange={(e) => setProtoForm((f) => ({ ...f, labourHours: parseFloat(e.target.value) || 0 }))}
            />
          </div>
          {/* Improvements — only show if version > v1 */}
          {protoForm.version !== "v1" && (
            <div>
              <label className={labelClass}>Improvements (from previous version)</label>
              <textarea
                className={`${inputClass} resize-none`}
                rows={2}
                value={protoForm.improvements}
                onChange={(e) => setProtoForm((f) => ({ ...f, improvements: e.target.value }))}
                placeholder="What was improved from the previous version..."
              />
            </div>
          )}
          <div>
            <label className={labelClass}>Defects</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={2}
              value={protoForm.defects}
              onChange={(e) => setProtoForm((f) => ({ ...f, defects: e.target.value }))}
              placeholder="Known defects or shortcomings of this version..."
            />
          </div>
          <div>
            <label className={labelClass}>Test Results</label>
            <input
              className={inputClass}
              value={protoForm.testResults}
              onChange={(e) => setProtoForm((f) => ({ ...f, testResults: e.target.value }))}
              placeholder="Summary of testing outcomes..."
            />
          </div>
          <div>
            <label className={labelClass}>Feedback</label>
            <input
              className={inputClass}
              value={protoForm.feedback}
              onChange={(e) => setProtoForm((f) => ({ ...f, feedback: e.target.value }))}
              placeholder="Team / stakeholder feedback..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => { setProtoOpen(false); setEditingProtoId(null); }}>Cancel</Button>
            <Button variant="primary" onClick={handleProtoSave} disabled={protoSaving}>
              {protoSaving
                ? (editingProtoId ? "Updating..." : "Adding...")
                : (editingProtoId ? "Update Prototype" : "Add Prototype")}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* Production BOM modal removed in Task #8 (production BOM management
          no longer surfaced on the R&D detail page). */}

      {/* ─── Issue Material Modal ──────────────────────────────────────────── */}
      {/*
        Multi-line dialog: a single common header (issuedAt + issuedBy +
        notes) is shared by every row, then N material lines are submitted
        in one transaction via POST /:id/issuances/batch. Each line carries
        its own category → raw-material picker, qty, and auto-filled unit;
        red borders + helper text surface inline validation, and the dialog
        body scrolls when many lines are added.
      */}
      <ModalOverlay open={issuanceOpen} onClose={closeIssuanceModal} title="Issue Raw Material" wide>
        <div className="space-y-5 max-h-[85vh] overflow-y-auto pr-1">
          {/* Common header: Issue Date + Issued By */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Issue Date</label>
              <input
                type="date"
                className={inputClass}
                value={issuanceHeader.issuedAt}
                onChange={(e) => setIssuanceHeader((h) => ({ ...h, issuedAt: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelClass}>Issued By</label>
              <input
                className={inputClass}
                value={issuanceHeader.issuedBy}
                onChange={(e) => setIssuanceHeader((h) => ({ ...h, issuedBy: e.target.value }))}
                placeholder="R&D person name"
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Notes (optional)</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={2}
              value={issuanceHeader.notes}
              onChange={(e) => setIssuanceHeader((h) => ({ ...h, notes: e.target.value }))}
              placeholder="Optional notes for this issuance..."
            />
          </div>

          {/* Materials section header */}
          <div className="flex items-center gap-3 pt-1">
            <div className="h-px flex-1 bg-[#E2DDD8]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Materials</span>
            <div className="h-px flex-1 bg-[#E2DDD8]" />
          </div>

          {/* Per-line forms */}
          <div className="space-y-4">
            {issuanceLines.map((line, idx) => {
              const lineErr = validateIssuanceLine(line);
              const qtyOver = line.materialId && line.qty > line.balanceQty;
              const missingMaterial = !line.materialId;
              const inCat = materialsInCategory(line.rmCategory);
              return (
                <div
                  key={line.lineKey}
                  className="rounded-xl border border-[#E2DDD8] bg-[#FBFAF8] p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#6B5C32]">Line {idx + 1}</span>
                    <button
                      type="button"
                      onClick={() => removeIssuanceLine(line.lineKey)}
                      disabled={issuanceLines.length <= 1}
                      className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
                      aria-label="Remove line"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Category + Raw Material */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Category</label>
                      <select
                        className={selectClass}
                        value={line.rmCategory}
                        onChange={(e) => {
                          const next = e.target.value;
                          // Whenever category changes, drop the line's selected
                          // material so the panel below doesn't show stale info.
                          updateIssuanceLine(line.lineKey, {
                            rmCategory: next,
                            materialId: "",
                            materialCode: "",
                            materialName: "",
                            unit: "",
                            balanceQty: 0,
                          });
                        }}
                      >
                        <option value="">-- Select category --</option>
                        {rmCategoryOptions.map((g) => (
                          <option key={g} value={g}>{g}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>Raw Material</label>
                      <select
                        className={`${selectClass} ${missingMaterial ? "border-red-300 focus:border-red-400 focus:ring-red-200" : ""}`}
                        value={line.materialId}
                        onChange={(e) => selectMaterialForLine(line.lineKey, e.target.value)}
                        disabled={!line.rmCategory}
                      >
                        <option value="">{line.rmCategory ? "-- Select material --" : "-- Pick a category first --"}</option>
                        {inCat.map((rm) => (
                          <option key={rm.id} value={rm.id}>
                            {rm.itemCode} — {rm.description} (balance: {rm.balanceQty} {rm.baseUOM})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Selected info banner — only shown after a material is picked */}
                  {line.materialId && (
                    <div className="bg-[#F0ECE9] rounded-lg p-3 text-sm space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-500">Selected:</span>
                        <span className="font-medium">{line.materialCode} - {line.materialName}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Balance:</span>
                        <span className="font-medium">{line.balanceQty} {line.unit}</span>
                      </div>
                    </div>
                  )}

                  {/* Qty + Unit grouped with the material */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Quantity</label>
                      <input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        className={`${inputClass} ${qtyOver ? "border-red-400 focus:border-red-500 focus:ring-red-200" : ""}`}
                        min={0.01}
                        step={0.01}
                        placeholder="0"
                        value={line.qty === 0 ? "" : line.qty}
                        onChange={(e) =>
                          updateIssuanceLine(line.lineKey, {
                            qty: e.target.value === "" ? 0 : parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                      {qtyOver && (
                        <p className="mt-1 text-xs text-red-600">
                          Exceeds balance ({line.balanceQty} {line.unit})
                        </p>
                      )}
                    </div>
                    <div>
                      <label className={labelClass}>Unit</label>
                      <input
                        className={`${inputClass} bg-gray-50`}
                        value={line.unit}
                        disabled
                        placeholder={line.materialId ? "" : "Auto-filled"}
                      />
                    </div>
                  </div>

                  {/* Inline line-level reason text (e.g. missing material) */}
                  {lineErr && !qtyOver && missingMaterial && (
                    <p className="text-xs text-red-600">{lineErr}</p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add another line */}
          <div>
            <button
              type="button"
              onClick={addIssuanceLine}
              className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[#C7BFB6] bg-white px-3 py-2 text-sm font-medium text-[#6B5C32] hover:bg-[#FBFAF8] hover:border-[#6B5C32] transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add another material
            </button>
          </div>

          <p className="text-xs text-gray-400">
            Unit cost is resolved from the current FIFO inventory cost at the time the material is issued.
          </p>

          {/* Inline server-error banner — shown above the buttons so the
              dialog can stay open while the user fixes the underlying issue. */}
          {issuanceError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {issuanceError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={closeIssuanceModal}>Cancel</Button>
            <Button variant="primary" onClick={handleIssueMaterial} disabled={issuanceSaving}>
              {issuanceSaving
                ? "Issuing..."
                : issuanceLines.length === 1
                  ? "Issue Material"
                  : `Issue ${issuanceLines.length} Materials`}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Log Labour Hours Modal (table-backed) ─────────────────────────
          Member dropdown is sourced from /api/rd-team-members?active=true.
          When the list is empty we tell the user to add someone in
          Maintenance first rather than silently letting them post a 404. */}
      <ModalOverlay open={labourOpen} onClose={() => setLabourOpen(false)} title="Add Labour Hours">
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Team Member</label>
            {teamMembers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#E2DDD8] bg-[#FBF9F6] px-3 py-3 text-xs text-gray-500">
                No active team members. Add one in{" "}
                <a href="/rd/maintenance" className="text-[#6B5C32] underline">
                  R&D Maintenance
                </a>
                .
              </div>
            ) : (
              <select
                className={selectClass}
                value={labourForm.teamMemberId}
                onChange={(e) =>
                  setLabourForm((f) => ({ ...f, teamMemberId: e.target.value }))
                }
              >
                <option value="" disabled>
                  Select a member…
                </option>
                {teamMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.employmentType === "FULL_TIME"
                      ? `FT · ${formatCurrency(m.hourlyRateSen ?? 0)}/hr`
                      : `PT · ${formatCurrency(m.monthlyFixedCostSen ?? 0)}/mo`})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Date</label>
              <input
                type="date"
                className={inputClass}
                value={labourForm.workDate}
                onChange={(e) => setLabourForm((f) => ({ ...f, workDate: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelClass}>Hours</label>
              <input
                type="number" onFocus={(e) => e.currentTarget.select()}
                className={inputClass}
                min={0.5}
                step={0.5}
                value={labourForm.hours}
                onChange={(e) => setLabourForm((f) => ({ ...f, hours: parseFloat(e.target.value) || 0 }))}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Notes (optional)</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={3}
              value={labourForm.notes}
              onChange={(e) => setLabourForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="What work was done..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setLabourOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleLogLabour}
              disabled={labourSaving || teamMembers.length === 0}
            >
              {labourSaving ? "Saving..." : "Add Hours"}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Manual Labour Cost Override Modal ─────────────────────────────
          Sets / clears rd_projects.manualLabourCostSen via PATCH
          /api/rd-projects/:id/labour-cost. When a value is set the budget
          card shows a "Manual" badge and the auto-computed value is
          ignored until the override is cleared. */}
      <ModalOverlay
        open={manualCostOpen}
        onClose={() => (manualCostSaving ? null : setManualCostOpen(false))}
        title="Override Labour Cost"
      >
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Type a number directly to override the auto-computed labour cost.
            Useful for back-of-the-envelope estimates or one-off projects
            where you don't want to log every hour.
          </p>
          <div>
            <label className={labelClass}>Labour Cost (RM)</label>
            <input
              type="number" onFocus={(e) => e.currentTarget.select()}
              inputMode="decimal"
              min={0}
              step={0.01}
              className={inputClass}
              value={manualCostRM}
              onChange={(e) => setManualCostRM(e.target.value)}
              placeholder={
                typeof autoLabourCostSen === "number"
                  ? `Auto: ${(autoLabourCostSen / 100).toFixed(2)}`
                  : "0.00"
              }
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Auto value: {formatCurrency(autoLabourCostSen)} ({totalLabourHours}h logged).
              Hours stay logged separately for future reference.
            </p>
          </div>
          <div className="flex justify-between gap-2 pt-2 border-t border-[#E2DDD8]">
            {isManualLabourCost ? (
              <Button
                variant="ghost"
                onClick={handleClearManualCost}
                disabled={manualCostSaving}
              >
                Clear Override
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setManualCostOpen(false)} disabled={manualCostSaving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSaveManualCost} disabled={manualCostSaving}>
                {manualCostSaving ? "Saving..." : "Save Override"}
              </Button>
            </div>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Photo Crop Dialog ───────────────────────────────────────────────
          Gates every cover-photo and milestone-photo upload (and any
          "Edit crop" re-use of an existing photo). aspectRatio={null}
          opens in Free mode with the full image already selected — the
          cover photo card uses object-contain so any aspect renders fine,
          and forcing 1:1 made wide phone shots look "auto-zoomed in" with
          no obvious way to get the whole sofa back. */}
      <PhotoCropDialog
        open={cropOpen}
        imageDataUrl={cropImageUrl}
        aspectRatio={null}
        onCancel={closeCropDialog}
        onConfirm={(url) => void handleCropConfirm(url)}
      />

      {/* ─── Cover Photo Lightbox ────────────────────────────────────────────
          Click the rail cover photo to view it at full size. Click anywhere
          (including the image) or press Escape / the close button to dismiss. */}
      {coverZoomOpen && project.coverPhotoUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 cursor-zoom-out"
          onClick={() => setCoverZoomOpen(false)}
          role="dialog"
          aria-label="Cover photo"
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setCoverZoomOpen(false); }}
            className="absolute top-4 right-4 rounded-lg bg-white/10 hover:bg-white/20 text-white p-2"
            title="Close"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={project.coverPhotoUrl}
            alt={`${project.name} cover (full size)`}
            className="max-w-full max-h-full object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
