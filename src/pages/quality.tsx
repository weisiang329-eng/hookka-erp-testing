// ---------------------------------------------------------------------------
// QC / Quality Management — Phase 1 rebuild (2026-04-28).
//
// New flow (per design discussion 2026-04-28):
//   • Time-triggered QC. The cron at /api/qc-pending/trigger runs at 12:00 +
//     16:00 daily (factory local time). Each run generates one PENDING
//     inspection per active qc_templates row. Inspectors pick up each slot,
//     sample (or skip "no production at this stage today"), record per-item
//     PASS / FAIL / NA, and submit.
//   • On FAIL the system creates a 🔶 soft Issue Tag against the inspection's
//     subject (RM / Job Card / FG). Tags are informational, not gating —
//     production keeps running ("继续使用，加小心" — small-shop reality).
//   • For WIP fail with a Job Card subject we ALSO reset the JC: status →
//     BLOCKED, completedDate cleared, wipQty/actualMinutes/productionTimeMinutes
//     zeroed. The worker has to redo it (per 2B in design discussion).
//
// Old tabs (Returns / Defect Tracker / Supplier NCR / Reports) were removed
// per user instruction "重做整个 QA 页面".
// ---------------------------------------------------------------------------
import { useMemo, useState, useCallback } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { formatDateDMY } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import {
  ShieldCheck,
  ClipboardCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  FileText,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
type Stage = "RM" | "WIP" | "FG";
type ItemCategory = "SOFA" | "BEDFRAME" | "ACCESSORY" | "GENERAL";
type Severity = "MINOR" | "MAJOR" | "CRITICAL";
type ItemResult = "PASS" | "FAIL" | "NA";
type SubjectType = "RAW_MATERIAL" | "JOB_CARD" | "FG_BATCH";

type InspectionItem = {
  id: string;
  sequence: number;
  itemName: string;
  criteria: string;
  severity: Severity;
  isMandatory: boolean;
  result: ItemResult | null;
  notes: string;
  photoUrl: string;
};

type Inspection = {
  id: string;
  inspectionNo: string;
  templateId: string;
  stage: Stage | null;
  itemCategory: ItemCategory | null;
  deptCode?: string;
  department?: string;
  subjectType: SubjectType | null;
  subjectId: string;
  subjectLabel: string;
  triggerType: string;
  scheduledSlotAt: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED" | "";
  result: string;
  notes: string;
  inspectorId: string;
  inspectorName: string;
  inspectionDate: string;
  skipReason: string;
  completedAt: string;
  createdAt: string;
  items: InspectionItem[];
};

type Template = {
  id: string;
  name: string;
  deptCode: string;
  deptName: string;
  itemCategory: ItemCategory;
  stage: Stage;
  active: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  items: {
    id: string;
    sequence: number;
    itemName: string;
    criteria: string;
    severity: Severity;
    isMandatory: boolean;
  }[];
};

type RawMaterialOpt = { id: string; itemCode: string; itemName: string; itemGroup?: string };
type JobCardOpt = {
  id: string;
  productionOrderId: string;
  poNo?: string;
  departmentCode?: string;
  departmentName?: string;
  wipLabel?: string;
  wipCode?: string;
  status: string;
};
type FgBatchOpt = { id: string; productCode: string; productName: string; remainingQty: number };

type Tab = "pending" | "history" | "templates";

// ─── Constants ───────────────────────────────────────────────────────────────
const STAGE_LABEL: Record<Stage, string> = { RM: "IQC (Raw Material)", WIP: "IPQC (In-Process)", FG: "OQC (Finished Goods)" };
const CATEGORY_LABEL: Record<ItemCategory, string> = { SOFA: "Sofa", BEDFRAME: "Bed Frame", ACCESSORY: "Accessory", GENERAL: "General" };
const SEVERITY_COLOR: Record<Severity, string> = {
  MINOR: "bg-yellow-100 text-yellow-800 border-yellow-200",
  MAJOR: "bg-orange-100 text-orange-800 border-orange-200",
  CRITICAL: "bg-red-100 text-red-800 border-red-200",
};
const RESULT_COLOR: Record<ItemResult, string> = {
  PASS: "bg-green-100 text-green-800 border-green-300",
  FAIL: "bg-red-100 text-red-800 border-red-300",
  NA: "bg-gray-100 text-gray-700 border-gray-300",
};

function fmtSlot(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return formatDateDMY(d.toISOString().slice(0, 10)) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function QualityPage() {
  const [tab, setTab] = useState<Tab>("pending");

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ShieldCheck className="size-7 text-amber-700" />
            QA / Quality Management
          </h1>
          <p className="text-sm text-muted-foreground">
            Time-triggered QC inspections (12:00 / 16:00 daily) · 🔶 issue tags · checklist templates
          </p>
        </div>
      </div>

      <div className="border-b border-gray-200">
        <div className="flex gap-2">
          <TabButton active={tab === "pending"} onClick={() => setTab("pending")} icon={<Clock className="size-4" />}>
            Pending Inspections
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={<ClipboardCheck className="size-4" />}>
            Inspection History
          </TabButton>
          <TabButton active={tab === "templates"} onClick={() => setTab("templates")} icon={<FileText className="size-4" />}>
            Templates
          </TabButton>
        </div>
      </div>

      {tab === "pending" && <PendingTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "templates" && <TemplatesTab />}
    </div>
  );
}

function TabButton({
  active, onClick, icon, children,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-amber-700 text-amber-700"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Tab 1: Pending Inspections ──────────────────────────────────────────────
function PendingTab() {
  const { toast } = useToast();
  const { data: pendingResp, refresh: refreshPending } = useCachedJson<{ data?: Inspection[] }>("/api/qc-pending");
  const inspections = useMemo(() => (pendingResp?.data ?? []).filter((i) => i.status !== "COMPLETED"), [pendingResp]);
  const [generating, setGenerating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const onGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/qc-pending/generate-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; created?: number; skipped?: number; sideEffects?: { tagsCreated?: number; jobCardReset?: boolean } };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Generate failed");
      invalidateCachePrefix("/api/qc-pending");
      refreshPending();
      toast.success(`Slot generated. Created ${json.created ?? 0} new pending. Skipped ${json.skipped ?? 0} (already exists).`);
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setGenerating(false);
    }
  }, [refreshPending, toast]);

  // Group by slot timestamp
  const grouped = useMemo(() => {
    const out = new Map<string, Inspection[]>();
    for (const i of inspections) {
      const key = i.scheduledSlotAt || "no-slot";
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(i);
    }
    return Array.from(out.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [inspections]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge className="text-base">
            {inspections.length} open
          </Badge>
          <span className="text-sm text-muted-foreground">
            {inspections.filter((i) => i.status === "PENDING").length} pending ·{" "}
            {inspections.filter((i) => i.status === "IN_PROGRESS").length} in progress
          </span>
        </div>
        <Button onClick={onGenerate} disabled={generating}>
          <RefreshCw className={`mr-2 size-4 ${generating ? "animate-spin" : ""}`} />
          Generate Today's Slot
        </Button>
      </div>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No pending inspections. Click <strong>Generate Today's Slot</strong> to create the noon / 4pm batch
            from active templates.
          </CardContent>
        </Card>
      ) : (
        grouped.map(([slot, list]) => (
          <Card key={slot}>
            <CardHeader>
              <CardTitle className="text-base">
                Slot: <span className="font-mono">{fmtSlot(slot)}</span>
                <span className="ml-3 text-sm font-normal text-muted-foreground">{list.length} item(s)</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-0">
              <div className="divide-y border-t">
                {list.map((insp) => (
                  <PendingRow
                    key={insp.id}
                    insp={insp}
                    expanded={expandedId === insp.id}
                    onToggle={() => setExpandedId(expandedId === insp.id ? null : insp.id)}
                    onRefresh={() => {
                      invalidateCachePrefix("/api/qc-pending");
                      refreshPending();
                    }}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function PendingRow({
  insp, expanded, onToggle, onRefresh,
}: {
  insp: Inspection;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
      >
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="w-32 font-mono text-xs">{insp.inspectionNo}</span>
        <Badge className="w-24 text-center">
          {insp.stage ? STAGE_LABEL[insp.stage as Stage].split(" ")[0] : "—"}
        </Badge>
        <span className="w-32 text-sm">{insp.deptCode || insp.department}</span>
        <span className="w-24 text-sm">
          {insp.itemCategory ? CATEGORY_LABEL[insp.itemCategory] : "—"}
        </span>
        <span className="flex-1 text-sm text-muted-foreground">
          {insp.items.length} check items
        </span>
        <Badge
          className={
            insp.status === "PENDING" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"
          }
        >
          {insp.status}
        </Badge>
      </button>
      {expanded && <DoInspectionForm insp={insp} onRefresh={onRefresh} onClose={onToggle} />}
    </div>
  );
}

function DoInspectionForm({
  insp, onRefresh, onClose,
}: { insp: Inspection; onRefresh: () => void; onClose: () => void }) {
  const { toast } = useToast();
  const me = getCurrentUser();
  const stage = insp.stage as Stage | null;

  // Subject picker data (lazily loaded based on stage)
  const { data: rmResp } = useCachedJson<{ data?: RawMaterialOpt[] }>(
    stage === "RM" ? "/api/raw-materials" : null,
  );
  const { data: jcResp } = useCachedJson<{ data?: JobCardOpt[] }>(
    stage === "WIP" ? `/api/job-cards?status=IN_PROGRESS&departmentCode=${encodeURIComponent(insp.deptCode || insp.department || "")}` : null,
  );
  const { data: fgResp } = useCachedJson<{ data?: FgBatchOpt[] }>(
    stage === "FG" ? "/api/fg-units" : null,
  );

  // subjectType is fixed by stage (RM→RAW_MATERIAL, WIP→JOB_CARD, FG→FG_BATCH).
  // The user picks a specific subject from a stage-specific dropdown; the type
  // itself never changes during the form's lifecycle.
  const subjectType: SubjectType | "" =
    stage === "RM" ? "RAW_MATERIAL" : stage === "WIP" ? "JOB_CARD" : stage === "FG" ? "FG_BATCH" : "";
  const [subjectId, setSubjectId] = useState("");
  const [subjectLabel, setSubjectLabel] = useState("");
  const [subjectCode, setSubjectCode] = useState("");
  const [overallNotes, setOverallNotes] = useState("");
  const [items, setItems] = useState<InspectionItem[]>(insp.items);
  const [submitting, setSubmitting] = useState(false);
  const [skipReason, setSkipReason] = useState("");

  // Pick subject from dropdown
  const subjects = useMemo(() => {
    if (stage === "RM") {
      return (rmResp?.data ?? []).map((r) => ({ id: r.id, code: r.itemCode, label: `${r.itemCode} — ${r.itemName}` }));
    }
    if (stage === "WIP") {
      return (jcResp?.data ?? []).map((j) => ({
        id: j.id,
        code: j.poNo ?? j.id,
        label: `${j.poNo ?? "(no PO)"} · ${j.departmentName || j.departmentCode} · ${j.wipLabel || j.wipCode || ""}`,
      }));
    }
    if (stage === "FG") {
      return (fgResp?.data ?? []).map((f) => ({
        id: f.id,
        code: f.productCode,
        label: `${f.productCode} — ${f.productName}${f.remainingQty != null ? ` (${f.remainingQty})` : ""}`,
      }));
    }
    return [];
  }, [stage, rmResp, jcResp, fgResp]);

  const onItemResult = useCallback(
    (id: string, result: ItemResult) => {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, result } : i)));
    },
    [],
  );
  const onItemNotes = useCallback(
    (id: string, notes: string) => {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, notes } : i)));
    },
    [],
  );

  const allMandatoryAnswered = items.every((i) => !i.isMandatory || i.result != null);
  const failingItems = items.filter((i) => i.result === "FAIL");

  const submit = useCallback(async () => {
    if (!subjectType || !subjectId) {
      toast.error("Pick a subject (the RM batch / job card / FG batch you sampled).");
      return;
    }
    if (!allMandatoryAnswered) {
      toast.error("Every mandatory item needs PASS / FAIL / NA.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/qc-pending/${insp.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectType,
          subjectId,
          subjectLabel,
          subjectCode,
          inspectorId: me?.id,
          inspectorName: me?.displayName ?? me?.email ?? "QC",
          overallNotes,
          items: items
            .filter((i) => i.result != null)
            .map((i) => ({ id: i.id, result: i.result, notes: i.notes, photoUrl: i.photoUrl || undefined })),
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; created?: number; skipped?: number; sideEffects?: { tagsCreated?: number; jobCardReset?: boolean } };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Submit failed");
      const tagged = json.sideEffects?.tagsCreated ?? 0;
      const jcReset = json.sideEffects?.jobCardReset;
      toast.success(
        `Submitted. ${tagged ? `${tagged} 🔶 tag(s) created.` : "All pass."}${jcReset ? " Job card reset to BLOCKED." : ""}`,
      );
      invalidateCachePrefix("/api/qc-pending");
      invalidateCachePrefix("/api/qc-inspections");
      onRefresh();
      onClose();
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }, [subjectType, subjectId, subjectLabel, subjectCode, items, overallNotes, insp.id, me, allMandatoryAnswered, onRefresh, onClose, toast]);

  const skip = useCallback(async () => {
    if (!skipReason.trim()) {
      toast.error("Please type a skip reason (e.g., 'No production at this stage today').");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/qc-pending/${insp.id}/skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: skipReason }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; created?: number; skipped?: number; sideEffects?: { tagsCreated?: number; jobCardReset?: boolean } };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Skip failed");
      toast.success("Marked as SKIPPED.");
      invalidateCachePrefix("/api/qc-pending");
      onRefresh();
      onClose();
    } catch (err) {
      toast.error(`Skip failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }, [insp.id, skipReason, onRefresh, onClose, toast]);

  return (
    <div className="space-y-4 border-t bg-muted/20 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Subject (what was sampled)</label>
          <select
            value={subjectId}
            onChange={(e) => {
              const found = subjects.find((s) => s.id === e.target.value);
              setSubjectId(e.target.value);
              setSubjectCode(found?.code ?? "");
              setSubjectLabel(found?.label ?? "");
            }}
            className="block w-full rounded-md border border-input bg-background p-2 text-sm"
          >
            <option value="">— choose {stage === "RM" ? "raw material" : stage === "WIP" ? "job card" : "FG batch"} —</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {stage === "WIP" && subjects.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              No active job cards in this department. Use Skip if no production today.
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Overall notes (optional)</label>
          <Input value={overallNotes} onChange={(e) => setOverallNotes(e.target.value)} placeholder="Any general observation…" />
        </div>
      </div>

      <div className="rounded-md border bg-background">
        <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 text-sm font-medium">
          <span>Checklist ({items.length} items)</span>
          <span className="text-xs text-muted-foreground">
            {items.filter((i) => i.result === "PASS").length} pass · {items.filter((i) => i.result === "FAIL").length} fail ·{" "}
            {items.filter((i) => i.result === "NA").length} N/A
          </span>
        </div>
        <div className="divide-y">
          {items.map((item) => (
            <div key={item.id} className="px-3 py-2">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {item.sequence}. {item.itemName}
                    </span>
                    {item.isMandatory && (
                      <Badge className="border-amber-300 text-xs text-amber-700">
                        required
                      </Badge>
                    )}
                    <Badge className={`text-xs ${SEVERITY_COLOR[item.severity]}`}>{item.severity}</Badge>
                  </div>
                  {item.criteria && (
                    <p className="mt-1 text-xs text-muted-foreground">{item.criteria}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {(["PASS", "FAIL", "NA"] as ItemResult[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => onItemResult(item.id, r)}
                      className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                        item.result === r ? RESULT_COLOR[r] : "border-input bg-background hover:bg-muted"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {item.result === "FAIL" && (
                <Input
                  className="mt-2"
                  placeholder="Detail what failed (e.g., 'Pattern misaligned at left arm')"
                  value={item.notes}
                  onChange={(e) => onItemNotes(item.id, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {failingItems.length > 0 && (
        <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900">
          <AlertTriangle className="mr-1 inline size-4" />
          On submit, {failingItems.length} 🔶 issue tag(s) will be created.
          {stage === "WIP" && subjectType === "JOB_CARD" && (
            <> The job card will also be reset to BLOCKED (status / completedDate / wipQty / actualMinutes cleared).</>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button onClick={submit} disabled={submitting || !subjectId || !allMandatoryAnswered}>
          <CheckCircle2 className="mr-2 size-4" />
          Submit ({failingItems.length > 0 ? "FAIL" : "PASS"})
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="w-72"
            placeholder="Skip reason — e.g., No production at this stage today"
            value={skipReason}
            onChange={(e) => setSkipReason(e.target.value)}
          />
          <Button variant="outline" onClick={skip} disabled={submitting}>
            <XCircle className="mr-2 size-4" />
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab 2: Inspection History ───────────────────────────────────────────────
function HistoryTab() {
  const { data: histResp, loading } = useCachedJson<{ data?: Inspection[] }>("/api/qc-inspections");
  const inspections = histResp?.data ?? [];

  const cols = useMemo<Column<Inspection>[]>(
    () => [
      { key: "inspectionNo", label: "Inspection No", width: "140px" },
      {
        key: "completedAt",
        label: "Completed",
        width: "150px",
        render: (_v, row) => row.completedAt ? fmtSlot(row.completedAt) : (row.inspectionDate ? formatDateDMY(row.inspectionDate) : "—"),
      },
      { key: "stage", label: "Stage", width: "70px", render: (v) => v ? <Badge>{v}</Badge> : "—" },
      {
        key: "itemCategory",
        label: "Category",
        width: "100px",
        render: (v) => v ? CATEGORY_LABEL[v as ItemCategory] : "—",
      },
      { key: "department", label: "Dept", width: "120px" },
      { key: "subjectLabel", label: "Subject", render: (v, row) => v || row.subjectId || "—" },
      { key: "inspectorName", label: "Inspector", width: "140px" },
      {
        key: "result",
        label: "Result",
        width: "110px",
        render: (v, row) => {
          if (row.status === "SKIPPED") return <Badge>SKIPPED</Badge>;
          if (v === "PASS") return <Badge className="bg-green-100 text-green-800">PASS</Badge>;
          if (v === "FAIL") return <Badge className="bg-red-100 text-red-800">FAIL</Badge>;
          return <Badge>{v ?? "—"}</Badge>;
        },
      },
      {
        key: "items",
        label: "Defects",
        width: "70px",
        align: "right",
        render: (_v, row) => {
          const failing = row.items.filter((i) => i.result === "FAIL").length;
          return failing > 0 ? <span className="font-semibold text-red-700">{failing}</span> : <span className="text-muted-foreground">0</span>;
        },
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inspection History</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <DataGrid
          data={inspections}
          columns={cols}
          keyField="id"
          loading={loading}
          emptyMessage="No inspections yet. Generate today's slot from the Pending tab."
          gridId="qc-history"
          maxHeight="60vh"
        />
      </CardContent>
    </Card>
  );
}

// ─── Tab 3: Templates ────────────────────────────────────────────────────────
function TemplatesTab() {
  const { toast } = useToast();
  const { data: tplResp, refresh } = useCachedJson<{ data?: Template[] }>("/api/qc-templates");
  const templates = useMemo(() => tplResp?.data ?? [], [tplResp]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  const onToggleActive = useCallback(
    async (tpl: Template) => {
      try {
        const res = await fetch(`/api/qc-templates/${tpl.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !tpl.active }),
        });
        const json = (await res.json()) as { success?: boolean; error?: string; created?: number; skipped?: number; sideEffects?: { tagsCreated?: number; jobCardReset?: boolean } };
        if (!res.ok || !json.success) throw new Error(json.error ?? "Update failed");
        invalidateCachePrefix("/api/qc-templates");
        refresh();
        toast.success(`Template ${tpl.active ? "deactivated" : "activated"}.`);
      } catch (err) {
        toast.error(`Failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    },
    [refresh, toast],
  );

  const grouped = useMemo(() => {
    const m = new Map<string, Template[]>();
    for (const t of templates) {
      const key = t.stage;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return Array.from(m.entries()).sort((a, b) => {
      const order = { RM: 0, WIP: 1, FG: 2 };
      return (order[a[0] as Stage] ?? 99) - (order[b[0] as Stage] ?? 99);
    });
  }, [templates]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {templates.length} template(s) · {templates.filter((t) => t.active).length} active
        </div>
        <Button onClick={() => { setEditing(null); setCreating(true); }}>
          <Plus className="mr-2 size-4" />
          New Template
        </Button>
      </div>

      {creating && (
        <TemplateEditor
          template={null}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            invalidateCachePrefix("/api/qc-templates");
            refresh();
          }}
        />
      )}

      {grouped.map(([stage, list]) => (
        <Card key={stage}>
          <CardHeader>
            <CardTitle className="text-base">{STAGE_LABEL[stage as Stage]}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">Template</th>
                  <th className="px-3 py-2 text-left">Dept</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Items</th>
                  <th className="px-3 py-2 text-left">Active</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.map((t) => (
                  <tr key={t.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{t.name}</td>
                    <td className="px-3 py-2">{t.deptName || t.deptCode}</td>
                    <td className="px-3 py-2">{CATEGORY_LABEL[t.itemCategory]}</td>
                    <td className="px-3 py-2">{t.items.length}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onToggleActive(t)}
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          t.active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {t.active ? "ACTIVE" : "inactive"}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" size="sm" onClick={() => { setCreating(false); setEditing(t); }}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}

      {editing && (
        <TemplateEditor
          template={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidateCachePrefix("/api/qc-templates");
            refresh();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  template, onCancel, onSaved,
}: { template: Template | null; onCancel: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const isEdit = !!template;
  const [form, setForm] = useState({
    name: template?.name ?? "",
    deptCode: template?.deptCode ?? "",
    deptName: template?.deptName ?? "",
    itemCategory: template?.itemCategory ?? "GENERAL",
    stage: template?.stage ?? "WIP",
    notes: template?.notes ?? "",
    items: template?.items ?? [],
  });
  const [saving, setSaving] = useState(false);

  const addItem = () =>
    setForm((f) => ({
      ...f,
      items: [
        ...f.items,
        {
          id: `new-${Math.random().toString(36).slice(2, 8)}`,
          sequence: f.items.length + 1,
          itemName: "",
          criteria: "",
          severity: "MAJOR",
          isMandatory: true,
        },
      ],
    }));

  const removeItem = (id: string) =>
    setForm((f) => ({ ...f, items: f.items.filter((i) => i.id !== id) }));

  const updateItem = (id: string, patch: Partial<Template["items"][number]>) =>
    setForm((f) => ({ ...f, items: f.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));

  const save = useCallback(async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (!form.deptCode.trim()) { toast.error("Department code is required"); return; }
    if (form.items.length === 0) { toast.error("At least one check item is required"); return; }
    if (form.items.some((i) => !i.itemName.trim())) { toast.error("Every item needs a name"); return; }
    setSaving(true);
    try {
      const url = isEdit ? `/api/qc-templates/${template!.id}` : "/api/qc-templates";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; created?: number; skipped?: number; sideEffects?: { tagsCreated?: number; jobCardReset?: boolean } };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Save failed");
      toast.success(isEdit ? "Template updated." : "Template created.");
      onSaved();
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }, [form, isEdit, template, onSaved, toast]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? `Edit: ${template!.name}` : "New Template"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Stage</label>
            <select
              value={form.stage}
              onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as Stage }))}
              className="block w-full rounded-md border border-input bg-background p-2 text-sm"
            >
              <option value="RM">RM (Incoming)</option>
              <option value="WIP">WIP (In-Process)</option>
              <option value="FG">FG (Outgoing)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Dept Code</label>
            <Input value={form.deptCode} onChange={(e) => setForm((f) => ({ ...f, deptCode: e.target.value }))} placeholder="e.g., FAB_CUT" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Dept Name (display)</label>
            <Input value={form.deptName} onChange={(e) => setForm((f) => ({ ...f, deptName: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
            <select
              value={form.itemCategory}
              onChange={(e) => setForm((f) => ({ ...f, itemCategory: e.target.value as ItemCategory }))}
              className="block w-full rounded-md border border-input bg-background p-2 text-sm"
            >
              <option value="GENERAL">General</option>
              <option value="SOFA">Sofa</option>
              <option value="BEDFRAME">Bed Frame</option>
              <option value="ACCESSORY">Accessory</option>
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes (optional)</label>
          <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </div>

        <div className="rounded-md border">
          <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 text-sm font-medium">
            <span>Check Items ({form.items.length})</span>
            <Button size="sm" variant="outline" onClick={addItem}>
              <Plus className="mr-1 size-3" />
              Add Item
            </Button>
          </div>
          <div className="divide-y">
            {form.items.map((item, idx) => (
              <div key={item.id} className="grid grid-cols-12 items-start gap-2 px-3 py-2">
                <div className="col-span-1 pt-2 text-xs text-muted-foreground">{idx + 1}</div>
                <div className="col-span-5">
                  <Input
                    value={item.itemName}
                    onChange={(e) => updateItem(item.id, { itemName: e.target.value })}
                    placeholder="Item name"
                  />
                  <Input
                    className="mt-1"
                    value={item.criteria}
                    onChange={(e) => updateItem(item.id, { criteria: e.target.value })}
                    placeholder="Pass criteria (optional)"
                  />
                </div>
                <div className="col-span-2">
                  <select
                    value={item.severity}
                    onChange={(e) => updateItem(item.id, { severity: e.target.value as Severity })}
                    className="block w-full rounded-md border border-input bg-background p-2 text-sm"
                  >
                    <option value="MINOR">Minor</option>
                    <option value="MAJOR">Major</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </div>
                <div className="col-span-2 pt-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={item.isMandatory}
                      onChange={(e) => updateItem(item.id, { isMandatory: e.target.checked })}
                    />
                    Mandatory
                  </label>
                </div>
                <div className="col-span-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => removeItem(item.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : isEdit ? "Save Changes" : "Create"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
