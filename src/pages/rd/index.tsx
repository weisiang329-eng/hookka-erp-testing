import { useState, useCallback, useEffect, useMemo } from "react";
import { useCachedJson, invalidateCachePrefix, isUnknownOutcome } from "@/lib/cached-fetch";
import { RecordLoadError } from "@/components/ui/record-load-error";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Lightbulb,
  Users,
  Calendar,
  TrendingUp,
  Download,
  Layers,
  BarChart3,
  ArrowRight,
  Plus,
  X,
  Archive,
  Play,
  Pencil,
  CheckCircle2,
  AlertTriangle,
  Activity,
  DollarSign,
  Clock,
} from "lucide-react";
import type { RDProject, RDProjectStage, RDProjectType } from "@/types";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { RdProjectSchema } from "@/lib/schemas/rd-project";
import { moneyFieldToRinggit, firstMoneyFieldError } from "@/lib/money-field";
import {
  getProjectHealth,
  getMilestoneHealth,
  PROJECT_SCHEDULE_CHIP,
  PROJECT_BUDGET_CHIP,
  type ProjectHealth,
} from "./health";

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

// Per-type stage labels — see notes on the parallel helper in detail.tsx.
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

type TabId = "summary" | "drafts" | "projects" | "completed" | "pipeline" | "reports";

function StageProgressBar({
  currentStage,
  projectType,
}: {
  currentStage: RDProjectStage;
  projectType?: RDProjectType;
}) {
  const currentIndex = STAGES.indexOf(currentStage);
  const labels = getStageLabels(projectType);
  return (
    <div className="flex items-center gap-1 w-full">
      {STAGES.map((stage, i) => (
        <div key={stage} className="flex-1 flex flex-col items-center gap-0.5">
          <div
            className="h-2 w-full rounded-full transition-all"
            style={{
              backgroundColor: i <= currentIndex ? STAGE_COLORS[stage] : "#E2DDD8",
              opacity: i <= currentIndex ? 1 : 0.4,
            }}
          />
          <span className="text-[9px] text-gray-400 truncate w-full text-center">
            {labels[stage].slice(0, 4)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Compact chip strip showing schedule + budget alerts. Used by both
// project cards (Drafts / Projects tabs) and the Summary tab's project
// rows. We hide chips when there's nothing alarming to say (On Track +
// budget OK) so the card stays uncluttered for the healthy majority.
function ProjectHealthChips({
  health,
  alwaysShow,
}: {
  health: ProjectHealth;
  // alwaysShow=true forces an "On Track" / "OK Budget" chip to render too —
  // used in the Summary tab where a project landing in the "needs attention"
  // list deserves an explicit reason.
  alwaysShow?: boolean;
}) {
  const chips: Array<{ key: string; label: string; cls: string; title?: string }> = [];
  if (health.schedule && (health.schedule !== "on-track" || alwaysShow)) {
    const def = PROJECT_SCHEDULE_CHIP[health.schedule];
    let label = def.label;
    if (health.schedule === "overdue" && health.daysToTarget !== null) {
      label = `Overdue ${Math.abs(health.daysToTarget)}d`;
    } else if (health.schedule === "at-risk" && health.daysToTarget !== null) {
      label = `Due in ${health.daysToTarget}d`;
    }
    chips.push({ key: "schedule", label, cls: def.cls });
  }
  if (health.budget !== "ok") {
    const def = PROJECT_BUDGET_CHIP[health.budget];
    chips.push({
      key: "budget",
      label: `${def.label} (${Math.round(health.budgetPct)}%)`,
      cls: def.cls,
    });
  } else if (alwaysShow && health.budgetPct > 0) {
    chips.push({
      key: "budget",
      label: `Budget ${Math.round(health.budgetPct)}%`,
      cls: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span
          key={c.key}
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${c.cls}`}
          title={c.title}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

// Resolve cover photo at render time. The explicit `coverPhotoUrl` field
// (uploaded via the detail page's dedicated cover-photo block) wins; if the
// project hasn't set one, fall back to the first photo across milestones in
// storage order so older projects still show something useful.
function getCoverPhoto(project: RDProject): string | undefined {
  if (project.coverPhotoUrl) return project.coverPhotoUrl;
  for (const m of project.milestones) {
    if (m.photos && m.photos.length > 0) return m.photos[0];
  }
  return undefined;
}

// DraftCard — design choice (judgment call):
// We DO wrap the card body in <Link> like ProjectCard for consistent navigation
// behaviour. The "Start Project" button stops propagation + prevents default so
// clicking it doesn't navigate to /rd/:id. This is simpler than a separate
// "Edit details" button and keeps the whole card clickable for editing.
function DraftCard({
  project,
  onStart,
}: {
  project: RDProject;
  onStart: (project: RDProject) => void;
}) {
  const cover = getCoverPhoto(project);

  const handleStartClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onStart(project);
  };

  return (
    <Link to={`/rd/${project.id}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full border-dashed border-[#D0C9C0] bg-[#FBF9F6]">
        <CardHeader className="pb-3">
          {/* Left column packs all the textual meta (code, title, type
              chips, description) so its visual height matches the
              128×128 photo on the right — eliminates the dead-space gap
              that appeared when the photo was bigger than the title-only
              left column. DRAFT badge moved to an absolute overlay on
              the photo so it costs zero column height. */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <div>
                <p className="text-xs font-mono text-gray-400">{project.code}</p>
                <CardTitle className="text-base mt-0.5 truncate">{project.name}</CardTitle>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${CATEGORY_COLORS[project.productCategory]}`}>
                  {project.productCategory}
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
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
                    ? "Clone"
                    : "Research"}
                </span>
              </div>
              {project.description && (
                <p className="text-xs text-gray-500 line-clamp-3">{project.description}</p>
              )}
            </div>
            {/* Thumbnail box hugs the image's natural aspect: max 128 high
                and max 176 wide, the image fills whichever dimension is
                tighter, the OTHER side shrinks to whatever the natural
                aspect produces. Wide phone shots render as a horizontal
                strip; portrait posters as a tall column; squares stay
                128×128. The relative wrapper uses `w-fit` so the DRAFT
                badge anchors to the image's actual top-right, not a
                phantom 128×128 box. */}
            <div className="relative flex-shrink-0 w-fit">
              {cover ? (
                <img
                  src={cover}
                  alt={`${project.name} cover`}
                  className="block max-h-32 max-w-44 rounded-md bg-[#FAF9F8] border border-[#E2DDD8]"
                />
              ) : (
                <div
                  className="h-32 w-32 rounded-md border border-dashed border-[#D0C9C0] bg-[#F0ECE9] flex items-center justify-center text-gray-300"
                  title="No photo yet"
                  aria-label="No cover photo"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-10 w-10">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
              )}
              <span className="absolute top-1.5 right-1.5">
                <Badge variant="status" status="DRAFT">DRAFT</Badge>
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-1 text-gray-500">
              <Calendar className="h-3 w-3" />
              <span>Launch: {formatDate(project.targetLaunchDate)}</span>
            </div>
            <div className="flex items-center gap-1 text-gray-500">
              <Users className="h-3 w-3" />
              <span>{project.assignedTeam.length} members</span>
            </div>
          </div>

          <Button
            type="button"
            variant="primary"
            onClick={handleStartClick}
            className="w-full"
          >
            <Play className="h-4 w-4" /> Start Project
          </Button>
        </CardContent>
      </Card>
    </Link>
  );
}

function ProjectCard({ project }: { project: RDProject }) {
  const budgetPct = project.totalBudget > 0 ? Math.round((project.actualCost / project.totalBudget) * 100) : 0;
  const budgetColor = budgetPct > 90 ? "text-[#9A3A2D]" : budgetPct > 70 ? "text-[#9C6F1E]" : "text-[#4F7C3A]";
  const health = getProjectHealth(project);
  const cover = getCoverPhoto(project);
  // If the cover URL resolves but the browser can't render it (404, truncated
  // base64, decode failure), swap to the neutral placeholder instead of
  // showing the broken-image alt text overlaid on the card. Same image works
  // on the detail page + Pipeline card, so we don't fix the data — we just
  // degrade gracefully here.
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = cover && !coverFailed;

  // Edit button: navigate to detail page with ?edit=1 so the detail page can
  // auto-open its existing edit modal. We stop event propagation + prevent
  // default so the click doesn't fall through to the outer <Link> nav, then
  // navigate programmatically (a nested <a> inside <a> would be invalid HTML).
  const navigate = useNavigate();
  const handleEditClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/rd/${project.id}?edit=1`);
  };

  return (
    <Link to={`/rd/${project.id}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        {/* Compact layout mirrors DraftCard so Drafts / Projects /
            Completed all read at the same density: photo lives as a
            top-right thumbnail (sized to the photo's natural aspect)
            instead of a full-width banner, and every textual meta sits
            in the CardHeader left column. Status badge + Edit button
            both anchor to the photo's top edge as absolute overlays. */}
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <div>
                <p className="text-xs font-mono text-gray-400">{project.code}</p>
                <CardTitle className="text-base mt-0.5 truncate">{project.name}</CardTitle>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${CATEGORY_COLORS[project.productCategory]}`}>
                  {project.productCategory}
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
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
                    ? "Clone"
                    : "Research"}
                </span>
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                  style={{ backgroundColor: STAGE_COLORS[project.currentStage] }}
                >
                  {getStageLabels(project.projectType)[project.currentStage]}
                </span>
              </div>
              {/* Health chips — schedule + budget. Hidden when nothing's
                  alarming so the card stays uncluttered for healthy projects. */}
              <ProjectHealthChips health={health} />
            </div>
            <div className="relative flex-shrink-0 w-fit">
              {showCover ? (
                <img
                  src={cover}
                  alt={`${project.name} cover`}
                  onError={() => setCoverFailed(true)}
                  className="block max-h-32 max-w-44 rounded-md bg-[#FAF9F8] border border-[#E2DDD8]"
                />
              ) : (
                <div
                  className="h-32 w-32 rounded-md border border-dashed border-[#D0C9C0] bg-[#F0ECE9] flex items-center justify-center text-gray-300"
                  aria-label="No cover photo"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-10 w-10">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
              )}
              {/* Status badge in top-right of photo (mirrors DraftCard's
                  DRAFT placement). Edit pencil floats top-LEFT so it
                  doesn't crash into the badge — tiny target but the
                  photo is also clickable through to the detail page. */}
              <span className="absolute top-1.5 right-1.5">
                <Badge variant="status" status={project.status}>{project.status.replace(/_/g, " ")}</Badge>
              </span>
              <button
                type="button"
                onClick={handleEditClick}
                aria-label={`Edit ${project.name}`}
                className="absolute top-1.5 left-1.5 inline-flex items-center justify-center h-6 w-6 rounded-md bg-white/95 backdrop-blur-sm border border-[#E2DDD8] text-gray-500 hover:bg-white hover:text-[#6B5C32] hover:border-[#6B5C32] transition-colors shadow-sm"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <StageProgressBar currentStage={project.currentStage} projectType={project.projectType} />

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-1 text-gray-500">
              <Calendar className="h-3 w-3" />
              <span>Launch: {formatDate(project.targetLaunchDate)}</span>
            </div>
            <div className="flex items-center gap-1 text-gray-500">
              <Users className="h-3 w-3" />
              <span>{project.assignedTeam.length} members</span>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Budget</span>
              <span className={`font-medium ${budgetColor}`}>{budgetPct}% used</span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(budgetPct, 100)}%`,
                  backgroundColor: budgetPct > 90 ? "#DC2626" : budgetPct > 70 ? "#D97706" : "#16A34A",
                }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400">
              <span>{formatCurrency(project.actualCost)}</span>
              <span>{formatCurrency(project.totalBudget)}</span>
            </div>
          </div>

          {project.assignedTeam.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {project.assignedTeam.slice(0, 3).map((name) => (
                <span key={name} className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[10px] text-[#6B5C32]">
                  {name.split(" ")[0]}
                </span>
              ))}
              {project.assignedTeam.length > 3 && (
                <span className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[10px] text-[#6B5C32]">
                  +{project.assignedTeam.length - 3}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

// SummaryView — top-level health dashboard the operator opens to answer
// "what needs attention right now?" in one glance. Three sections, zero
// scrolling on a 1080p laptop:
//
// 1. KPI strip — Overdue / At Risk / Over Budget / Total Spend.
// 2. "Needs attention" project list, sorted by urgency.
// 3. Per-milestone overdue list, scoped to active projects.
//
// Everything is computed client-side from the existing /api/rd-projects
// payload — no extra network calls.
function SummaryView({ projects }: { projects: RDProject[] }) {
  // Compute health once per project; reuse below for the lists.
  const enriched = useMemo(
    () => projects.map((p) => ({ project: p, health: getProjectHealth(p) })),
    [projects],
  );

  const overdueProjects = enriched.filter((x) => x.health.schedule === "overdue");
  const atRiskProjects = enriched.filter((x) => x.health.schedule === "at-risk");
  const overBudgetProjects = enriched.filter((x) => x.health.budget === "over-budget");

  // Total budget + spend across active projects. We compute % util on the
  // sum (not the average) so a single big project's overrun doesn't get
  // diluted by ten smaller ones still under budget.
  const totalBudgetSen = projects.reduce((s, p) => s + (p.totalBudget || 0), 0);
  const totalSpendSen = projects.reduce((s, p) => s + (p.actualCost || 0), 0);
  const totalUtilPct = totalBudgetSen > 0 ? (totalSpendSen / totalBudgetSen) * 100 : 0;

  // Needs-attention: union of (overdue ∪ at-risk ∪ over-budget ∪
  // near-budget) sorted so the most-urgent (most-overdue, then highest
  // budget %) bubbles to the top. A single project can land here for
  // multiple reasons — render its full chip set so the operator sees
  // every concern at once.
  const needsAttention = useMemo(() => {
    const flagged = enriched.filter(
      (x) =>
        x.health.schedule === "overdue" ||
        x.health.schedule === "at-risk" ||
        x.health.budget !== "ok",
    );
    return [...flagged].sort((a, b) => {
      // 1. Overdue projects first, sorted by most overdue.
      const aOver = a.health.schedule === "overdue" ? Math.abs(a.health.daysToTarget ?? 0) : -1;
      const bOver = b.health.schedule === "overdue" ? Math.abs(b.health.daysToTarget ?? 0) : -1;
      if (aOver !== bOver) return bOver - aOver;
      // 2. Over-budget next (descending util).
      const aOB = a.health.budget === "over-budget" ? a.health.budgetPct : -1;
      const bOB = b.health.budget === "over-budget" ? b.health.budgetPct : -1;
      if (aOB !== bOB) return bOB - aOB;
      // 3. At-risk by closest target.
      const aDays = a.health.schedule === "at-risk" ? a.health.daysToTarget ?? Infinity : Infinity;
      const bDays = b.health.schedule === "at-risk" ? b.health.daysToTarget ?? Infinity : Infinity;
      return aDays - bDays;
    });
  }, [enriched]);

  // Per-milestone overdue list — flatten across projects so the operator
  // can see exactly which checkpoints have slipped, without drilling into
  // individual project pages.
  const overdueMilestones = useMemo(() => {
    const items: { project: RDProject; stage: string; targetDate: string; daysOverdue: number }[] = [];
    for (const p of projects) {
      for (const m of p.milestones) {
        const h = getMilestoneHealth({ targetDate: m.targetDate, actualDate: m.actualDate });
        if (h.state === "overdue") {
          items.push({
            project: p,
            stage: m.stage,
            targetDate: m.targetDate ?? "",
            daysOverdue: Math.abs(h.daysToTarget ?? 0),
          });
        }
      }
    }
    return items.sort((a, b) => b.daysOverdue - a.daysOverdue);
  }, [projects]);

  return (
    <div className="space-y-6">
      {/* KPI strip — 4 stat cards. Each one is colour-coded so the eye
          jumps to a non-zero red number immediately. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Overdue"
          value={overdueProjects.length}
          tone={overdueProjects.length > 0 ? "danger" : "ok"}
          icon={<AlertTriangle className="h-5 w-5" />}
          sub={overdueProjects.length === 1 ? "project past target" : "projects past target"}
        />
        <KpiCard
          label="At Risk"
          value={atRiskProjects.length}
          tone={atRiskProjects.length > 0 ? "warning" : "ok"}
          icon={<Clock className="h-5 w-5" />}
          sub="≤ 7 days to target"
        />
        <KpiCard
          label="Over Budget"
          value={overBudgetProjects.length}
          tone={overBudgetProjects.length > 0 ? "danger" : "ok"}
          icon={<DollarSign className="h-5 w-5" />}
          sub={`${formatCurrency(totalSpendSen)} / ${formatCurrency(totalBudgetSen)}`}
        />
        <KpiCard
          label="Budget Utilization"
          value={`${Math.round(totalUtilPct)}%`}
          tone={totalUtilPct >= 100 ? "danger" : totalUtilPct >= 80 ? "warning" : "ok"}
          icon={<TrendingUp className="h-5 w-5" />}
          sub="aggregate spend / budget"
        />
      </div>

      {/* Needs Attention list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[#9C6F1E]" />
            Needs Attention ({needsAttention.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {needsAttention.length === 0 ? (
            <div className="text-center py-8 text-sm text-[#4F7C3A]">
              All active projects are on track and within budget. ✓
            </div>
          ) : (
            <div className="divide-y divide-[#E2DDD8]">
              {needsAttention.map(({ project, health }) => (
                <Link
                  key={project.id}
                  to={`/rd/${project.id}`}
                  className="flex items-center justify-between gap-3 py-3 hover:bg-[#FAF9F7] -mx-2 px-2 rounded transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-400">{project.code}</span>
                      <span className="text-sm font-medium text-[#1F1D1B] truncate">{project.name}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <ProjectHealthChips health={health} />
                      <span className="text-xs text-gray-500">
                        Target: {formatDate(project.targetLaunchDate)} · {getStageLabels(project.projectType)[project.currentStage]}
                      </span>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-gray-300 shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-milestone overdue list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-[#9A3A2D]" />
            Overdue Milestones ({overdueMilestones.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {overdueMilestones.length === 0 ? (
            <div className="text-center py-8 text-sm text-[#4F7C3A]">
              No milestones are past their target date. ✓
            </div>
          ) : (
            <div className="divide-y divide-[#E2DDD8]">
              {overdueMilestones.map((item, i) => (
                <Link
                  key={`${item.project.id}-${item.stage}-${i}`}
                  to={`/rd/${item.project.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-[#FAF9F7] -mx-2 px-2 rounded transition-colors text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-gray-400">{item.project.code}</span>
                    <span className="font-medium text-[#1F1D1B] truncate">{item.project.name}</span>
                    <span
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                      style={{ backgroundColor: STAGE_COLORS[item.stage as RDProjectStage] ?? "#6B7280" }}
                    >
                      {getStageLabels(item.project.projectType)[item.stage as RDProjectStage] ?? item.stage}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-gray-500">target {formatDate(item.targetDate)}</span>
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border bg-[#FAE5E0] text-[#9A3A2D] border-[#E8B5AB]">
                      Overdue {item.daysOverdue}d
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Reusable stat card for the Summary KPI strip. tone drives both the
// number colour and the icon background tint.
function KpiCard({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone: "ok" | "warning" | "danger";
  icon: React.ReactNode;
}) {
  const numCls =
    tone === "danger" ? "text-[#9A3A2D]" : tone === "warning" ? "text-[#9C6F1E]" : "text-[#1F1D1B]";
  const iconWrap =
    tone === "danger"
      ? "bg-[#FAE5E0] text-[#9A3A2D]"
      : tone === "warning"
        ? "bg-[#FAEFCB] text-[#9C6F1E]"
        : "bg-[#EEF3E4] text-[#4F7C3A]";
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-3">
          <div className={`shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-lg ${iconWrap}`}>
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-gray-500">{label}</p>
            <p className={`text-2xl font-bold mt-0.5 ${numCls}`}>{value}</p>
            {sub && <p className="text-[10px] text-gray-400 mt-0.5 truncate">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PipelineView({ projects }: { projects: RDProject[] }) {
  return (
    <div className="grid grid-cols-6 gap-3 min-h-[500px]">
      {STAGES.map((stage) => {
        const stageProjects = projects.filter((p) => p.currentStage === stage);
        return (
          <div key={stage} className="flex flex-col">
            <div
              className="rounded-t-lg px-3 py-2 text-white text-xs font-semibold flex items-center justify-between"
              style={{ backgroundColor: STAGE_COLORS[stage] }}
            >
              <span>{STAGE_LABELS[stage]}</span>
              <span className="bg-white/20 rounded-full px-1.5 py-0.5 text-[10px]">{stageProjects.length}</span>
            </div>
            <div className="flex-1 bg-gray-50 border border-t-0 border-[#E2DDD8] rounded-b-lg p-2 space-y-2">
              {stageProjects.map((project) => {
                const cover = getCoverPhoto(project);
                return (
                <Link key={project.id} to={`/rd/${project.id}`}>
                  <div className="bg-white rounded-md border border-[#E2DDD8] hover:shadow-md transition-shadow cursor-pointer overflow-hidden">
                    {/* Cover photo thumbnail — banner is hidden entirely when
                        there's no photo, keeping the kanban card compact.
                        Uses aspect-[16/9] (matches the Projects-tab card)
                        so the photo is a wider strip rather than dominating
                        the narrow kanban column. */}
                    {cover && (
                      <img
                        src={cover}
                        alt=""
                        className="w-full aspect-[16/9] object-cover bg-[#FAF9F8] border-b border-[#E2DDD8]"
                      />
                    )}
                    <div className="p-2.5 space-y-2">
                      <p className="text-[10px] font-mono text-gray-400">{project.code}</p>
                      <p className="text-xs font-medium text-[#1F1D1B] leading-snug">{project.name}</p>
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium border ${CATEGORY_COLORS[project.productCategory]}`}>
                        {project.productCategory}
                      </span>
                      <div className="flex items-center justify-between text-[10px] text-gray-400">
                        <span>{formatDate(project.targetLaunchDate)}</span>
                        <ArrowRight className="h-3 w-3" />
                      </div>
                    </div>
                  </div>
                </Link>
                );
              })}
              {stageProjects.length === 0 && (
                <div className="flex items-center justify-center h-24 text-xs text-gray-300">
                  No projects
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReportsView({ projects }: { projects: RDProject[] }) {
  const totalProjects = projects.length;
  const activeProjects = projects.filter((p) => p.status === "ACTIVE").length;
  const totalBudget = projects.reduce((sum, p) => sum + p.totalBudget, 0);
  const totalSpend = projects.reduce((sum, p) => sum + p.actualCost, 0);

  const byStage = STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    color: STAGE_COLORS[stage],
    count: projects.filter((p) => p.currentStage === stage).length,
  }));

  const byCategory = ["SOFA", "BEDFRAME", "ACCESSORY"].map((cat) => ({
    category: cat,
    count: projects.filter((p) => p.productCategory === cat).length,
  }));

  const handleExportCSV = () => {
    const headers = ["Code", "Name", "Category", "Stage", "Status", "Target Launch", "Budget (MYR)", "Actual Cost (MYR)", "Budget Used %", "Team Size", "Prototypes"];
    const rows = projects.map((p) => [
      p.code,
      p.name,
      p.productCategory,
      p.currentStage,
      p.status,
      p.targetLaunchDate,
      (p.totalBudget / 100).toFixed(2),
      (p.actualCost / 100).toFixed(2),
      p.totalBudget > 0 ? ((p.actualCost / p.totalBudget) * 100).toFixed(1) : "0",
      String(p.assignedTeam.length),
      String(p.prototypes.length),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rd-projects-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-[#E0EDF0] flex items-center justify-center">
                <Lightbulb className="h-5 w-5 text-[#3E6570]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#1F1D1B]">{totalProjects}</p>
                <p className="text-xs text-gray-500">Total Projects</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-[#EEF3E4] flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-[#4F7C3A]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#1F1D1B]">{activeProjects}</p>
                <p className="text-xs text-gray-500">Active Projects</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-[#E0EDF0] flex items-center justify-center">
                <BarChart3 className="h-5 w-5 text-[#3E6570]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#1F1D1B]">{formatCurrency(totalBudget)}</p>
                <p className="text-xs text-gray-500">Total Budget</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-[#FAEFCB] flex items-center justify-center">
                <Layers className="h-5 w-5 text-[#9C6F1E]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#1F1D1B]">{formatCurrency(totalSpend)}</p>
                <p className="text-xs text-gray-500">Total R&D Spend</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* By Stage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Projects by Stage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-6 gap-3">
            {byStage.map((s) => (
              <div key={s.stage} className="text-center">
                <div
                  className="h-20 rounded-lg flex items-center justify-center mb-1"
                  style={{ backgroundColor: s.color + "18" }}
                >
                  <span className="text-3xl font-bold" style={{ color: s.color }}>{s.count}</span>
                </div>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* By Category */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Projects by Category</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {byCategory.map((c) => (
              <div key={c.category} className="flex items-center gap-3 p-3 rounded-lg border border-[#E2DDD8]">
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border ${CATEGORY_COLORS[c.category]}`}>
                  {c.category}
                </span>
                <span className="text-lg font-bold text-[#1F1D1B]">{c.count}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Detailed Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">All Projects - Cost & Timeline</CardTitle>
          <Button variant="outline" size="sm" onClick={handleExportCSV}>
            <Download className="h-3.5 w-3.5 mr-1" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Code</th>
                  <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Name</th>
                  <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Category</th>
                  <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Stage</th>
                  <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Budget</th>
                  <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Actual</th>
                  <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Used %</th>
                  <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Launch Date</th>
                  <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500">Prototypes</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const pct = p.totalBudget > 0 ? Math.round((p.actualCost / p.totalBudget) * 100) : 0;
                  return (
                    <tr key={p.id} className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50">
                      <td className="py-2 px-2 font-mono text-xs text-gray-400">{p.code}</td>
                      <td className="py-2 px-2 font-medium text-[#1F1D1B]">
                        <Link to={`/rd/${p.id}`} className="hover:text-[#6B5C32]">{p.name}</Link>
                      </td>
                      <td className="py-2 px-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${CATEGORY_COLORS[p.productCategory]}`}>
                          {p.productCategory}
                        </span>
                      </td>
                      <td className="py-2 px-2">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                          style={{ backgroundColor: STAGE_COLORS[p.currentStage] }}
                        >
                          {getStageLabels(p.projectType)[p.currentStage]}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right text-xs">{formatCurrency(p.totalBudget)}</td>
                      <td className="py-2 px-2 text-right text-xs">{formatCurrency(p.actualCost)}</td>
                      <td className="py-2 px-2 text-right text-xs font-medium" style={{ color: pct > 90 ? "#DC2626" : pct > 70 ? "#D97706" : "#16A34A" }}>
                        {pct}%
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-500">{formatDate(p.targetLaunchDate)}</td>
                      <td className="py-2 px-2 text-center text-xs">{p.prototypes.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    projectType: "DEVELOPMENT" as RDProjectType,
    productCategory: "BEDFRAME" as "BEDFRAME" | "SOFA" | "ACCESSORY",
    serviceId: "",
    description: "",
    targetLaunchDate: "",
    totalBudgetRM: "",
    teamMembers: "",
    sourceProductName: "",
    sourceBrand: "",
    sourcePurchaseRef: "",
    sourcePriceRM: "",
    sourceNotes: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Project name is required");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        projectType: form.projectType,
        productCategory: form.productCategory,
      };
      if (form.serviceId.trim()) body.serviceId = form.serviceId.trim();
      if (form.description.trim()) body.description = form.description.trim();
      if (form.targetLaunchDate) body.targetLaunchDate = form.targetLaunchDate;
      // BUG-2026-08-13-095 - one parser. A budget typed "1,200,000" used to be
      // created as RM 1.00; a source price that failed to parse was silently
      // dropped from the body altogether, so the field just came back blank.
      const rdCreateMoneyError = firstMoneyFieldError([
        { label: "Total budget (RM)", value: form.totalBudgetRM },
        ...(form.projectType === "CLONE"
          ? [{ label: "Source price (RM)", value: form.sourcePriceRM }]
          : []),
      ]);
      if (rdCreateMoneyError) { toast.error(rdCreateMoneyError); return; }
      if (form.totalBudgetRM) body.totalBudget = Math.round((moneyFieldToRinggit(form.totalBudgetRM) as number) * 100);
      if (form.teamMembers.trim()) {
        body.assignedTeam = form.teamMembers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      // Clone-source fields are only sent when projectType === 'CLONE'.
      // Server stores nulls for non-CLONE types, so we just skip empty strings.
      if (form.projectType === "CLONE") {
        if (form.sourceProductName.trim()) body.sourceProductName = form.sourceProductName.trim();
        if (form.sourceBrand.trim()) body.sourceBrand = form.sourceBrand.trim();
        if (form.sourcePurchaseRef.trim()) body.sourcePurchaseRef = form.sourcePurchaseRef.trim();
        if (form.sourcePriceRM.trim()) {
          // Stored in sen for consistency with totalBudget + every other money
          // column. Grouping separators are handled by the shared parser.
          const rm = moneyFieldToRinggit(form.sourcePriceRM) as number;
          if (rm >= 0) body.sourcePriceSen = Math.round(rm * 100);
        }
        if (form.sourceNotes.trim()) body.sourceNotes = form.sourceNotes.trim();
      }

      try {
        await fetchJson("/api/rd-projects", RDMutationSchema, {
          method: "POST",
          body,
        });
        toast.success("Project created successfully");
        onCreated();
      } catch (err) {
        if (err instanceof FetchJsonError) {
          const errBody = err.body as { error?: string } | undefined;
          throw new Error(errBody?.error ?? "Failed to create project");
        }
        throw err;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — sticky at top of the modal so user always sees it. */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8] flex-shrink-0">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">New R&D Project</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form — scrollable middle. The Source Product fieldset can push
            content past the viewport on shorter screens (and the laptop
            taskbar steals ~60px), so the body has its own overflow region
            and the footer below stays pinned. */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
          {/* Project Name */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-[#1F1D1B]">
              Project Name <span className="text-[#9A3A2D]">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
              placeholder="e.g. Premium Sofa V2"
              autoFocus
            />
          </div>

          {/* Project Type */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-[#1F1D1B]">
              Project Type <span className="text-[#9A3A2D]">*</span>
            </label>
            <select
              value={form.projectType}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  projectType: e.target.value as RDProjectType,
                }))
              }
              className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32] bg-white"
            >
              <option value="DEVELOPMENT">New Product Research</option>
              <option value="IMPROVEMENT">Improvement / Repair</option>
              <option value="CLONE">Clone / Replicate Competitor</option>
            </select>
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-[#1F1D1B]">
              Category <span className="text-[#9A3A2D]">*</span>
            </label>
            <select
              value={form.productCategory}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  productCategory: e.target.value as "BEDFRAME" | "SOFA" | "ACCESSORY",
                }))
              }
              className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32] bg-white"
            >
              <option value="BEDFRAME">Bedframe</option>
              <option value="SOFA">Sofa</option>
              <option value="ACCESSORY">Accessory</option>
            </select>
          </div>

          {/* Service ID — only for IMPROVEMENT type */}
          {form.projectType === "IMPROVEMENT" && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-[#1F1D1B]">Service ID</label>
              <input
                type="text"
                value={form.serviceId}
                onChange={(e) => setForm((f) => ({ ...f, serviceId: e.target.value }))}
                className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                placeholder="e.g. RC-2604-001"
              />
            </div>
          )}

          {/* Clone-source fields — only for CLONE type */}
          {form.projectType === "CLONE" && (
            <div className="rounded-lg border border-dashed border-[#E2DDD8] bg-[#FBF9F6] p-3 space-y-3">
              <p className="text-xs text-gray-500">
                Source product info — what we bought to reverse-engineer.
              </p>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-[#1F1D1B]">
                  Source Product / Model Name
                </label>
                <input
                  type="text"
                  value={form.sourceProductName}
                  onChange={(e) => setForm((f) => ({ ...f, sourceProductName: e.target.value }))}
                  className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                  placeholder="e.g. Comfy Recliner Pro"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-[#1F1D1B]">
                  Source Brand / Supplier
                </label>
                <input
                  type="text"
                  value={form.sourceBrand}
                  onChange={(e) => setForm((f) => ({ ...f, sourceBrand: e.target.value }))}
                  className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                  placeholder="e.g. ABC Furniture Sdn Bhd"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-[#1F1D1B]">
                    Purchase Reference
                  </label>
                  <input
                    type="text"
                    value={form.sourcePurchaseRef}
                    onChange={(e) => setForm((f) => ({ ...f, sourcePurchaseRef: e.target.value }))}
                    className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                    placeholder="INV-2026-0421"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-[#1F1D1B]">
                    Purchase Price (RM)
                  </label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()}
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={form.sourcePriceRM}
                    onChange={(e) => setForm((f) => ({ ...f, sourcePriceRM: e.target.value }))}
                    className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-[#1F1D1B]">Source Notes</label>
                <textarea
                  value={form.sourceNotes}
                  onChange={(e) => setForm((f) => ({ ...f, sourceNotes: e.target.value }))}
                  rows={3}
                  className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32] resize-none"
                  placeholder="Dimensions, key specs, why we want to copy..."
                />
              </div>
            </div>
          )}

          {/* Description */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-[#1F1D1B]">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={3}
              className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32] resize-none"
              placeholder="Brief description of the project..."
            />
          </div>

          {/* Target Launch Date & Budget */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-[#1F1D1B]">Target Launch Date</label>
              <input
                type="date"
                value={form.targetLaunchDate}
                onChange={(e) => setForm((f) => ({ ...f, targetLaunchDate: e.target.value }))}
                className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-[#1F1D1B]">Budget (RM)</label>
              <input
                type="number" onFocus={(e) => e.currentTarget.select()}
                min="0"
                step="0.01"
                value={form.totalBudgetRM}
                onChange={(e) => setForm((f) => ({ ...f, totalBudgetRM: e.target.value }))}
                className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                placeholder="0.00"
              />
            </div>
          </div>

          {/* Team Members */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-[#1F1D1B]">Team Members</label>
            <input
              type="text"
              value={form.teamMembers}
              onChange={(e) => setForm((f) => ({ ...f, teamMembers: e.target.value }))}
              className="w-full rounded-lg border border-[#E2DDD8] px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
              placeholder="Comma-separated names, e.g. Ali, Siti, Ahmad"
            />
            <p className="text-xs text-gray-400">Separate names with commas</p>
          </div>

          {/* Footer — sticky at the bottom of the scrollable form so
              the action buttons stay reachable even when the form is
              tall enough to need scrolling (Clone fieldset + Description
              + Date + Budget + Team can overflow on laptops). */}
          <div className="sticky bottom-0 bg-white -mx-6 px-6 pt-3 pb-1 border-t border-[#E2DDD8] flex items-center justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Creating..." : "Create Project"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function RDPage() {
  // Land on Projects (the live pipeline) by default — most operators come
  // here to look at in-flight work, not to triage drafts.
  const [activeTab, setActiveTab] = useState<TabId>("projects");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // Page-level category filter. "ALL" shows every project across all
  // categories; otherwise only that productCategory. Persists in
  // localStorage so the operator's last filter survives a refresh —
  // most shops live in either Sofa or Bedframe, not both day-to-day.
  type CatFilter = "ALL" | "SOFA" | "BEDFRAME" | "ACCESSORY";
  const [categoryFilter, setCategoryFilter] = useState<CatFilter>(() => {
    if (typeof localStorage === "undefined") return "ALL";
    const saved = localStorage.getItem("rd_category_filter");
    if (saved === "SOFA" || saved === "BEDFRAME" || saved === "ACCESSORY" || saved === "ALL") return saved;
    return "ALL";
  });
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("rd_category_filter", categoryFilter);
    }
  }, [categoryFilter]);

  const { data: rdResp, loading, failure: rdFailure, refresh: refreshRdHook } = useCachedJson<{ data?: RDProject[] }>("/api/rd-projects");
  const allProjects: RDProject[] = useMemo(() => rdResp?.data ?? [], [rdResp]);
  // Only blank the page when there is genuinely NOTHING to show — a page still
  // holding cached rows keeps showing them (the 2026-06-04 blank-page guard).
  const loadFailed = !rdResp && isUnknownOutcome(rdFailure);
  // Apply the page-level category filter once at the top — every
  // downstream list (drafts / active / completed / KPIs) reads from
  // here so the filter is consistent across tabs without repeating
  // the predicate.
  const projects = useMemo(
    () =>
      categoryFilter === "ALL"
        ? allProjects
        : allProjects.filter((p) => p.productCategory === categoryFilter),
    [allProjects, categoryFilter],
  );
  const fetchProjects = useCallback(() => {
    invalidateCachePrefix("/api/rd-projects");
    refreshRdHook();
  }, [refreshRdHook]);

  const draftProjects = useMemo(() => projects.filter((p) => p.status === "DRAFT"), [projects]);
  const nonDraftProjects = useMemo(() => projects.filter((p) => p.status !== "DRAFT"), [projects]);
  // Active = non-draft and non-completed. The Projects tab shows the live
  // pipeline of in-flight work; Completed gets its own tab below so finished
  // projects don't crowd the Projects grid.
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status !== "DRAFT" && p.status !== "COMPLETED"),
    [projects],
  );
  const completedProjects = useMemo(
    () => projects.filter((p) => p.status === "COMPLETED"),
    [projects],
  );
  const draftCount = draftProjects.length;
  const completedCount = completedProjects.length;

  // Category-tab counts run off allProjects (NOT the filtered set), so
  // the All / Sofa / Bedframe / Accessory pills show "real" totals
  // regardless of which one is active.
  const categoryCounts = useMemo(() => {
    const m: Record<CatFilter, number> = { ALL: allProjects.length, SOFA: 0, BEDFRAME: 0, ACCESSORY: 0 };
    for (const p of allProjects) {
      if (p.productCategory === "SOFA") m.SOFA++;
      else if (p.productCategory === "BEDFRAME") m.BEDFRAME++;
      else if (p.productCategory === "ACCESSORY") m.ACCESSORY++;
    }
    return m;
  }, [allProjects]);

  const handleStartProject = useCallback(
    async (project: RDProject) => {
      const ok = await confirm({
        title: "Start project?",
        message: "Start this project? It will enter the production pipeline.",
        danger: false,
      });
      if (!ok) return;
      try {
        const res = await fetch(`/api/rd-projects/${project.id}/start`, {
          method: "POST",
        });
        if (!res.ok) {
          let errMsg = `Failed to start project (HTTP ${res.status})`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) errMsg = body.error;
          } catch {
            // ignore JSON parse errors, fall back to default message
          }
          throw new Error(errMsg);
        }
        toast.success("Project started");
        fetchProjects();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to start project");
      }
    },
    [fetchProjects, toast, confirm],
  );

  // Compute aggregate health for the Summary tab badge — show a count of
  // projects that need attention (overdue OR over-budget OR near-budget OR
  // at-risk in next 7 days). One number, eyeballable.
  const attentionCount = useMemo(() => {
    let n = 0;
    for (const p of activeProjects) {
      const h = getProjectHealth(p);
      if (h.schedule === "overdue" || h.schedule === "at-risk") n++;
      else if (h.budget !== "ok") n++;
    }
    return n;
  }, [activeProjects]);

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    {
      id: "summary",
      label: attentionCount > 0 ? `Summary (${attentionCount})` : "Summary",
      icon: <Activity className="h-4 w-4" />,
    },
    { id: "drafts", label: `Drafts (${draftCount})`, icon: <Archive className="h-4 w-4" /> },
    { id: "projects", label: "Projects", icon: <Lightbulb className="h-4 w-4" /> },
    { id: "completed", label: `Completed (${completedCount})`, icon: <CheckCircle2 className="h-4 w-4" /> },
    { id: "pipeline", label: "Pipeline", icon: <Layers className="h-4 w-4" /> },
    { id: "reports", label: "Reports", icon: <BarChart3 className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">R&D Projects</h1>
          <p className="text-sm text-gray-500 mt-1">Research & Development pipeline and project management</p>
        </div>
        <Button variant="primary" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" /> New Project
        </Button>
      </div>

      {/* Category filter pills — applies to every tab below. We put them
          above the tab strip so the filter persists when the operator
          jumps between Drafts / Projects / Pipeline / Summary. The
          counts come from allProjects (unfiltered) so each pill reads
          like "what would I see if I clicked this". */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(["ALL", "SOFA", "BEDFRAME", "ACCESSORY"] as const).map((cat) => {
          const active = categoryFilter === cat;
          const label = cat === "ALL"
            ? "All"
            : cat === "SOFA" ? "Sofa" : cat === "BEDFRAME" ? "Bedframe" : "Accessory";
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors " +
                (active
                  ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                  : "bg-white text-[#1F1D1B] border-[#E2DDD8] hover:bg-[#F0ECE9]")
              }
              aria-pressed={active}
            >
              {label}
              <span
                className={`rounded-full px-1.5 py-0 text-[10px] ${
                  active ? "bg-white/25 text-white" : "bg-[#F0ECE9] text-gray-500"
                }`}
              >
                {categoryCounts[cat]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
        </div>
      ) : loadFailed ? (
        // C15 — a dead /api/rd-projects used to land here as an EMPTY list,
        // and every tab below then stated that emptiness as a fact about the
        // business: the Summary tab printed "All active projects are on track
        // and within budget. ✓", the Pipeline showed six empty stages, the
        // Reports tab offered a CSV export of nothing. A green tick over a
        // request that never answered is the worst version of this bug, so
        // the whole tab body is replaced by the honest card. `isUnknownOutcome`
        // keeps a real HTTP 404 out of here.
        <RecordLoadError
          subject="R&D project list"
          failure={rdFailure!}
          onRetry={fetchProjects}
        />
      ) : (
        <>
          {activeTab === "summary" && <SummaryView projects={activeProjects} />}
          {activeTab === "drafts" && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {draftProjects.map((project) => (
                <DraftCard key={project.id} project={project} onStart={handleStartProject} />
              ))}
              {draftProjects.length === 0 && (
                <div className="col-span-3 text-center py-16 text-gray-400 text-sm">
                  No drafts yet — newly created projects land here first
                </div>
              )}
            </div>
          )}
          {activeTab === "projects" && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeProjects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
              {activeProjects.length === 0 && (
                <div className="col-span-3 text-center py-16 text-gray-400">
                  No R&D projects found.
                </div>
              )}
            </div>
          )}
          {activeTab === "completed" && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {completedProjects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
              {completedProjects.length === 0 && (
                <div className="col-span-3 text-center py-16 text-gray-400 text-sm">
                  No completed projects yet — projects show up here after they're marked Complete on the detail page.
                </div>
              )}
            </div>
          )}
          {/* Pipeline shows in-flight work only — exclude DRAFT (not started)
              and COMPLETED (already shipped). A completed project's
              currentStage is still PRODUCTION_READY in the row, so without
              this filter the kanban kept showing the same card in the
              right-most column even after the user marked it Complete. */}
          {activeTab === "pipeline" && <PipelineView projects={activeProjects} />}
          {activeTab === "reports" && <ReportsView projects={nonDraftProjects} />}
        </>
      )}

      {showCreateDialog && (
        <CreateProjectDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => {
            setShowCreateDialog(false);
            fetchProjects();
          }}
        />
      )}
    </div>
  );
}
