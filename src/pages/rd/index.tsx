import { useState, useCallback, useMemo } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
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
  ImageOff,
  Pencil,
} from "lucide-react";
import type { RDProject, RDProjectStage, RDProjectType } from "@/types";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { RdProjectSchema } from "@/lib/schemas/rd-project";

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

const STAGE_LABELS: Record<RDProjectStage, string> = {
  CONCEPT: "Concept",
  DESIGN: "Design",
  PROTOTYPE: "Prototype",
  TESTING: "Testing",
  APPROVED: "Approved",
  PRODUCTION_READY: "Production Ready",
};

const CATEGORY_COLORS: Record<string, string> = {
  SOFA: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  BEDFRAME: "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]",
  ACCESSORY: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
};

type TabId = "drafts" | "projects" | "pipeline" | "reports";

function StageProgressBar({ currentStage }: { currentStage: RDProjectStage }) {
  const currentIndex = STAGES.indexOf(currentStage);
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
            {STAGE_LABELS[stage].slice(0, 4)}
          </span>
        </div>
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
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-gray-400">{project.code}</p>
              <CardTitle className="text-base mt-0.5 truncate">{project.name}</CardTitle>
            </div>
            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              {cover ? (
                <img
                  src={cover}
                  alt={`${project.name} cover`}
                  className="h-12 w-12 rounded-md object-cover border border-[#E2DDD8]"
                />
              ) : (
                <div
                  className="h-12 w-12 rounded-md border border-dashed border-[#D0C9C0] bg-[#F0ECE9] flex items-center justify-center text-gray-300"
                  title="No photo yet"
                  aria-label="No cover photo"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
              )}
              <Badge variant="status" status="DRAFT">DRAFT</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
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
            <p className="text-xs text-gray-500 line-clamp-2">{project.description}</p>
          )}

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
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full overflow-hidden relative">
        {/* Edit affordance — sits above the cover banner in the top-right
            corner of the card. Routes to detail page with ?edit=1 so the
            detail view can auto-open its edit modal. We use a <button> +
            programmatic navigate() because nesting <Link>/<a> inside the
            outer card <Link> would be invalid HTML. */}
        <button
          type="button"
          onClick={handleEditClick}
          aria-label={`Edit ${project.name}`}
          className="absolute top-2 right-2 z-10 inline-flex items-center justify-center h-7 w-7 rounded-md bg-white/90 backdrop-blur-sm border border-[#E2DDD8] text-gray-500 hover:bg-white hover:text-[#6B5C32] hover:border-[#6B5C32] transition-colors shadow-sm"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {/* Cover photo thumbnail — full-width banner. Falls back to a neutral
            placeholder when the project has no cover photo, no milestone
            photos, or when the image source fails to load. */}
        {showCover ? (
          <img
            src={cover}
            alt={`${project.name} cover`}
            onError={() => setCoverFailed(true)}
            className="w-full h-24 object-cover bg-[#FAF9F8] border-b border-[#E2DDD8]"
          />
        ) : (
          <div className="w-full h-24 flex items-center justify-center bg-[#FAF9F8] border-b border-[#E2DDD8] text-gray-300">
            <ImageOff className="h-6 w-6" />
          </div>
        )}
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-gray-400">{project.code}</p>
              <CardTitle className="text-base mt-0.5 truncate">{project.name}</CardTitle>
            </div>
            {/* Status badge — the full-width cover banner sits above the
                CardHeader (added by the cover-photo feature), so we drop
                the tiny top-right thumbnail that landed in 3e8dbf0 to
                avoid showing the same image twice in one card. */}
            <Badge variant="status" status={project.status}>{project.status.replace(/_/g, " ")}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
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
              {STAGE_LABELS[project.currentStage]}
            </span>
          </div>

          <StageProgressBar currentStage={project.currentStage} />

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
        </CardContent>
      </Card>
    </Link>
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
                    {/* Cover photo thumbnail — neutral placeholder when missing. */}
                    {cover ? (
                      <img
                        src={cover}
                        alt=""
                        className="w-full h-16 object-cover bg-[#FAF9F8] border-b border-[#E2DDD8]"
                      />
                    ) : (
                      <div className="w-full h-16 flex items-center justify-center bg-[#FAF9F8] border-b border-[#E2DDD8] text-gray-300">
                        <ImageOff className="h-4 w-4" />
                      </div>
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
                          {STAGE_LABELS[p.currentStage]}
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
      if (form.totalBudgetRM) body.totalBudget = Math.round(parseFloat(form.totalBudgetRM) * 100);
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
          // Stored in sen for consistency with totalBudget + every other
          // money column. parseFloat handles "1,200.50" minus the comma —
          // we strip thousands separators so the user can type either form.
          const rm = parseFloat(form.sourcePriceRM.replace(/,/g, ""));
          if (Number.isFinite(rm) && rm >= 0) {
            body.sourcePriceSen = Math.round(rm * 100);
          }
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
                    type="number"
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
                type="number"
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
  const [activeTab, setActiveTab] = useState<TabId>("drafts");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { toast } = useToast();

  const { data: rdResp, loading, refresh: refreshRdHook } = useCachedJson<{ data?: RDProject[] }>("/api/rd-projects");
  const projects: RDProject[] = useMemo(() => rdResp?.data ?? [], [rdResp]);
  const fetchProjects = useCallback(() => {
    invalidateCachePrefix("/api/rd-projects");
    refreshRdHook();
  }, [refreshRdHook]);

  const draftProjects = useMemo(() => projects.filter((p) => p.status === "DRAFT"), [projects]);
  const nonDraftProjects = useMemo(() => projects.filter((p) => p.status !== "DRAFT"), [projects]);
  const draftCount = draftProjects.length;

  const handleStartProject = useCallback(
    async (project: RDProject) => {
      const ok = window.confirm(
        "Start this project? It will enter the production pipeline.",
      );
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
    [fetchProjects, toast],
  );

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "drafts", label: `Drafts (${draftCount})`, icon: <Archive className="h-4 w-4" /> },
    { id: "projects", label: "Projects", icon: <Lightbulb className="h-4 w-4" /> },
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
      ) : (
        <>
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
              {nonDraftProjects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
              {nonDraftProjects.length === 0 && (
                <div className="col-span-3 text-center py-16 text-gray-400">
                  No R&D projects found.
                </div>
              )}
            </div>
          )}
          {activeTab === "pipeline" && <PipelineView projects={nonDraftProjects} />}
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
