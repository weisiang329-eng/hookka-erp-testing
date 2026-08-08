// ---------------------------------------------------------------------------
// QC / Quality Management — Phase 1 rebuild (2026-04-28), generation reworked
// per stage 2026-08-08.
//
// Flow:
//   • Generation runs at 12:00 + 16:00 (factory local) but the three stages
//     follow three different rhythms — see src/api/routes/qc-pending.ts:
//       RM  one inspection per GOODS RECEIPT, per material family on it;
//       WIP one slot per working department per run;
//       FG  a sampled share of the units produced, each bound to ONE unit and
//           the sales-order line it was built from.
//     An RM or FG slot therefore arrives with its subject ALREADY NAMED; only
//     WIP still asks the inspector to pick one. Inspectors record per-item
//     PASS / FAIL / NA and submit, or skip with a reason.
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
import { DeferredBlock } from "@/components/ui/deferred-block";
import {
  QC_WINDOW_DAYS,
  QC_DEFAULT_WINDOW_DAYS,
  qcWindowLabel,
  sliceSlotGroups,
  type QcWindowDays,
} from "@/lib/qc-slot-window";
import { formatDateDMY } from "@/lib/utils";
import { compressImage } from "@/lib/image-compress";
import {
  ShieldCheck,
  ClipboardCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Camera,
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
type SubjectType = "RAW_MATERIAL" | "RM_BATCH" | "JOB_CARD" | "FG_BATCH";

// The sales-order line a sampled finished unit is supposed to satisfy, frozen
// into the inspection at generation time. This is what "有没有做对 order" is
// checked against — not the label on the box, which is itself one of the
// things being checked.
type SoSpec = {
  soNo?: string | null;
  soLineNo?: number | null;
  productCode?: string | null;
  productName?: string | null;
  sizeCode?: string | null;
  sizeLabel?: string | null;
  fabricCode?: string | null;
  quantity?: number | null;
  legHeightInches?: number | null;
  divanHeightInches?: number | null;
  specialOrder?: string | null;
  lineNotes?: string | null;
  customerName?: string | null;
  customerHub?: string | null;
  unitNo?: number | null;
  totalUnits?: number | null;
};

// Why this finished unit was drawn out of everything packed today, frozen at
// draw time. The draw is weighted toward prior service cases, rarely-built
// product codes and hand-heavy models — see src/api/lib/qc-fg-risk.ts.
type SampleReason = {
  score?: number;
  summary?: string;
  reasons?: { code: string; label: string; weight: number }[];
};

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
  // What the slot was raised ABOUT (generation-time), as opposed to what the
  // inspector finally submitted. RM slots name the goods receipt; FG slots name
  // one finished unit and carry its sales-order line.
  sourceGrnId?: string;
  sourceGrnNo?: string;
  // An RM slot covers a whole DAY of one supplier's goods, so it commonly names
  // more than one receipt. Always populated (the singular number when the row
  // predates day-batching), so the banner can list what is on the floor.
  sourceGrnNos?: string[];
  sourceReceiptDate?: string;
  // Stage RM covers two jobs: INCOMING (did the supplier send good goods?) and
  // STORED (is the batch we are about to use still good after months in a
  // humid warehouse?). Blank on rows raised before the stored rhythm existed.
  rmCheckKind?: string;
  sourceRmBatchId?: string;
  sourceBatchAgeDays?: number | null;
  materialFamily?: string;
  sourceFgUnitId?: string;
  soSpec?: SoSpec | null;
  sampleReason?: SampleReason | null;
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
  // RM templates only: which incoming-material family this checklist covers.
  // Generation routes a goods receipt to a checklist by family, so an RM
  // template with no family is never handed to anyone.
  materialFamily?: string;
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
// Mirrors RM_FAMILIES in src/api/lib/qc-rm-families.ts, which is the source of
// truth (it is also what routes a receipt line to a checklist). Kept as a
// literal here rather than imported so a page bundle never pulls in a server
// module; the API validates the value anyway, so a drift shows up as a 400 and
// not as a silently mis-routed receipt.
const RM_FAMILY_OPTIONS = [
  "FABRIC",
  "PLYWOOD",
  "TIMBER",
  "SOFA_FOAM",
  "BED_FILLER",
  "WEBBING",
  "MECHANISM",
  "PACKING",
  "ACCESSORIES",
  "GENERAL",
] as const;

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
            IQC once per goods receipt · IPQC twice daily per working department · OQC sampled
            against the sales order · 🔶 issue tags · checklist templates
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
  // Owner decision 2026-08-02: default to the recent slots. The cron has been
  // generating ~34 inspections a day since 2026-04-28 and none were ever
  // completed, so "everything" meant scrolling four months of backlog to reach
  // today's checklist. Nothing is deleted and the badge above still counts
  // every open inspection — this only changes what is on screen first.
  const [windowDays, setWindowDays] = useState<QcWindowDays>(QC_DEFAULT_WINDOW_DAYS);

  const onGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/qc-pending/generate-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        success?: boolean; error?: string;
        created?: number; skipped?: number; skippedNoActivity?: number;
        rmCreated?: number; rmReceipts?: number; rmNoTemplate?: number;
        fgCreated?: number; fgUnits?: number; fgUnresolved?: number;
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Generate failed");
      invalidateCachePrefix("/api/qc-pending");
      refreshPending();
      // "created 0" must read as a fact about the factory, not as a button that
      // failed. So the toast says what generation actually LOOKED at: how many
      // departments were idle, how many receipts were scanned, how many units
      // were produced.
      const idle = json.skippedNoActivity ?? 0;
      const parts = [
        `Created ${json.created ?? 0} new pending, skipped ${json.skipped ?? 0} (already raised).`,
        idle > 0 ? `${idle} WIP department(s) had no work today.` : "",
        `RM: ${json.rmCreated ?? 0} from ${json.rmReceipts ?? 0} goods receipt(s) in the last 7 days.`,
        (json.rmNoTemplate ?? 0) > 0
          ? `${json.rmNoTemplate} receipt line group(s) matched NO checklist — tell QC.`
          : "",
        `FG: ${json.fgCreated ?? 0} sampled from ${json.fgUnits ?? 0} unit(s) produced today.`,
        (json.fgUnresolved ?? 0) > 0
          ? `${json.fgUnresolved} unit(s) could not be matched to a sales-order line.`
          : "",
      ].filter(Boolean);
      toast.success(parts.join(" "));
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

  // The window is measured against the NEWEST slot, not the wall clock: if
  // the cron stops, "last 7 days" must still show the most recent seven days
  // of slots rather than an empty page.
  const newestSlotDay = grouped.length > 0 ? String(grouped[0][0]).slice(0, 10) : "";
  const windowed = useMemo(
    () => sliceSlotGroups(grouped, windowDays, newestSlotDay),
    [grouped, windowDays, newestSlotDay],
  );

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
        <div className="flex items-center gap-2">
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value) as QcWindowDays)}
            className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            aria-label="Slot window"
          >
            {QC_WINDOW_DAYS.map((d) => (
              <option key={d} value={d}>{qcWindowLabel(d)}</option>
            ))}
          </select>
          <Button onClick={onGenerate} disabled={generating}>
            <RefreshCw className={`mr-2 size-4 ${generating ? "animate-spin" : ""}`} />
            Generate Today's Slot
          </Button>
        </div>
      </div>

      {windowed.hiddenGroups > 0 && (
        <div className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-muted-foreground">
          {windowed.hiddenRows} older inspection{windowed.hiddenRows === 1 ? "" : "s"} across{" "}
          {windowed.hiddenGroups} slot{windowed.hiddenGroups === 1 ? "" : "s"} are outside this
          window — switch to <strong>All slots</strong> to work through the backlog.
        </div>
      )}

      {windowed.shown.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No pending inspections. Click <strong>Generate Today's Slot</strong> to create the noon / 4pm batch
            from active templates.
          </CardContent>
        </Card>
      ) : (
        windowed.shown.map(([slot, list]) => (
          <DeferredBlock
            key={slot}
            estimatedHeight={QC_SLOT_CHROME_PX + list.length * QC_ROW_PX}
          >
          <Card>
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
          </DeferredBlock>
        ))
      )}
    </div>
  );
}

// Slot-card geometry, measured on prod 2026-08-01: one pending-inspection row
// is 85px, and a card's own chrome (title + the "N item(s)" line + borders) is
// about 90px. The QC backlog is 167 slot cards holding 2,839 rows — 30,303 DOM
// nodes and a 272,943px page, the heaviest screen in the system — so the cards
// hold their space with a placeholder until they are near the viewport.
const QC_ROW_PX = 85;
const QC_SLOT_CHROME_PX = 90;

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
        {/*
          An RM row used to say nothing about WHICH goods it was for, because
          the slot was raised for a DAY. It is now raised for a RECEIPT, and an
          FG row is raised for one UNIT — say so in the list, or the inspector
          has to open every row to find out what it is about.
        */}
        <span className="flex-1 truncate text-sm text-muted-foreground">
          {insp.subjectLabel ? (
            <>
              <span className="font-medium text-foreground">{insp.subjectLabel}</span>
              <span className="mx-2">·</span>
            </>
          ) : null}
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

// WHY this unit was drawn out of everything packed today. The draw is weighted
// toward prior complaints, rarely-built product codes and hand-heavy models
// (src/api/lib/qc-fg-risk.ts), and the reasons are frozen onto the inspection at
// draw time. Without them on screen every sampled unit looks routine, which is
// precisely what the weighting exists to prevent.
function SampleReasonPanel({ reason }: { reason: SampleReason }) {
  const reasons = reason.reasons ?? [];
  if (reasons.length === 0) return null;
  const complaint = reasons.some((r) => r.code?.startsWith("SERVICE_CASE"));
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        complaint ? "border-red-300 bg-red-50" : "border-sky-200 bg-sky-50"
      }`}
    >
      <div
        className={`text-xs font-medium uppercase tracking-wide ${
          complaint ? "text-red-800" : "text-sky-800"
        }`}
      >
        Why this unit was drawn
      </div>
      <ul className={`mt-1 space-y-0.5 text-sm ${complaint ? "text-red-900" : "text-sky-900"}`}>
        {reasons.map((r, i) => (
          <li key={`${r.code}-${i}`}>• {r.label}</li>
        ))}
      </ul>
    </div>
  );
}

// What the sales order actually asked for. The FG checklist's first seven items
// are all "does the unit match this", so the answer has to be on screen next to
// them — an inspector who has to go and look the order up will read the label
// on the box instead, and the label is one of the things being checked.
function SoSpecPanel({ spec }: { spec: SoSpec }) {
  const fields: [string, string][] = [
    ["Sales order", [spec.soNo, spec.soLineNo != null ? `line ${spec.soLineNo}` : ""].filter(Boolean).join(" · ")],
    ["Product code", spec.productCode ?? ""],
    ["Product", spec.productName ?? ""],
    ["Size", [spec.sizeCode, spec.sizeLabel].filter(Boolean).join(" · ")],
    ["Fabric code", spec.fabricCode ?? ""],
    ["Qty ordered", spec.quantity != null ? String(spec.quantity) : ""],
    ["Leg height", spec.legHeightInches != null ? `${spec.legHeightInches}"` : ""],
    ["Divan height", spec.divanHeightInches != null ? `${spec.divanHeightInches}"` : ""],
    ["Unit", spec.unitNo != null && spec.totalUnits != null ? `${spec.unitNo} of ${spec.totalUnits}` : ""],
    ["Customer", [spec.customerName, spec.customerHub].filter(Boolean).join(" · ")],
    ["Special order", spec.specialOrder ?? ""],
    ["Line notes", spec.lineNotes ?? ""],
  ];
  const shown = fields.filter(([, v]) => v !== "");
  if (shown.length === 0) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        This unit could not be matched to a sales-order line. Do not guess what it should be —
        record it and report it: a finished unit with no traceable order is itself the finding.
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-background">
      <div className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">
        What the sales order asked for
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 text-sm md:grid-cols-3">
        {shown.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DoInspectionForm({
  insp, onRefresh, onClose,
}: { insp: Inspection; onRefresh: () => void; onClose: () => void }) {
  const { toast } = useToast();
  const stage = insp.stage as Stage | null;

  // An RM slot names the GOODS RECEIPT it was raised for, and an FG slot names
  // the finished unit that was drawn for sampling — both decided at generation
  // time. When the slot already names its subject there is nothing to pick, so
  // the dropdown (and its fetch) is replaced by the assignment itself. Picking
  // "some raw material" out of a list of every material in the company was
  // never a QC record of anything.
  const assignedSubject = insp.subjectId
    ? { id: insp.subjectId, code: insp.sourceGrnNo || "", label: insp.subjectLabel || insp.subjectId }
    : null;
  // An RM slot is either INCOMING (a goods receipt) or STORED (a batch drawn
  // for production today). Same stage, different question.
  const isStoredCheck = stage === "RM" && insp.rmCheckKind === "STORED";

  // Subject picker data (lazily loaded based on stage, and only when the slot
  // did not already name its subject)
  const { data: rmResp, error: rmError, loading: rmLoading } = useCachedJson<{ data?: RawMaterialOpt[] }>(
    stage === "RM" && !assignedSubject ? "/api/raw-materials" : null,
  );
  // A card the department has OPEN right now is what an IPQC inspector can
  // actually sample. WAITING / IN_PROGRESS / PAUSED are the three live
  // statuses; BLOCKED is deliberately excluded (it is already sitting on a
  // failed inspection) and COMPLETED / TRANSFERRED are finished work.
  const { data: jcResp, error: jcError, loading: jcLoading } = useCachedJson<{ data?: JobCardOpt[] }>(
    stage === "WIP"
      ? `/api/job-cards?status=IN_PROGRESS,WAITING,PAUSED&departmentCode=${encodeURIComponent(insp.deptCode || insp.department || "")}`
      : null,
  );
  const { data: fgResp, error: fgError, loading: fgLoading } = useCachedJson<{ data?: FgBatchOpt[] }>(
    stage === "FG" && !assignedSubject ? "/api/fg-units" : null,
  );
  const subjectsError = stage === "RM" ? rmError : stage === "WIP" ? jcError : stage === "FG" ? fgError : null;
  const subjectsLoading = stage === "RM" ? rmLoading : stage === "WIP" ? jcLoading : stage === "FG" ? fgLoading : false;

  // subjectType is fixed by stage (RM→RM_BATCH for a receipt-driven slot,
  // WIP→JOB_CARD, FG→FG_BATCH). The type never changes during the form's
  // lifecycle; only WIP still asks the inspector to pick the subject.
  const subjectType: SubjectType | "" =
    (insp.subjectType as SubjectType | null) ??
    (stage === "RM" ? "RAW_MATERIAL" : stage === "WIP" ? "JOB_CARD" : stage === "FG" ? "FG_BATCH" : "");
  const [subjectId, setSubjectId] = useState(assignedSubject?.id ?? "");
  const [subjectLabel, setSubjectLabel] = useState(assignedSubject?.label ?? "");
  const [subjectCode, setSubjectCode] = useState(assignedSubject?.code ?? "");
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
  const onItemPhoto = useCallback(
    (id: string, photoUrl: string) => {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, photoUrl } : i)));
    },
    [],
  );
  // `photoUrl` was plumbed all the way through — column, write, read, submit
  // body — with nothing anywhere that could produce a value, so it was always
  // null. Same capture path as the phone (@/lib/image-compress → JPEG data
  // URL, stored in the TEXT column like service_cases.issue_photos), so both
  // surfaces write the same thing and neither needs /api/files, which the
  // worker token cannot reach.
  const onPickPhoto = useCallback(
    async (id: string, file: File | undefined) => {
      if (!file) return;
      try {
        onItemPhoto(id, await compressImage(file, { maxDim: 1280, quality: 0.7 }));
      } catch {
        toast.error("Could not read that image. Try another file.");
      }
    },
    [onItemPhoto, toast],
  );

  const allMandatoryAnswered = items.every((i) => !i.isMandatory || i.result != null);
  const failingItems = items.filter((i) => i.result === "FAIL");
  // A FAIL with no words is not a finding, it is a shrug — and it is the one
  // thing anyone reading this back in a month actually needs. The backend
  // enforces it too (completeInspection), so this is only here to say so
  // before the round-trip rather than after a 400.
  const failMissingReason = failingItems.some((i) => !i.notes.trim());
  // A FAIL with no picture is the same shrug in a different form: the words
  // are the inspector's opinion, the photo is the only part a reviewer can
  // still check once the unit has been reworked. Required on FAIL, optional
  // on PASS. Also enforced in completeInspection.
  const failMissingPhoto = failingItems.some((i) => !i.photoUrl);

  const submit = useCallback(async () => {
    if (!subjectType || !subjectId) {
      toast.error("Pick a subject (the RM batch / job card / FG batch you sampled).");
      return;
    }
    if (!allMandatoryAnswered) {
      toast.error("Every mandatory item needs PASS / FAIL / NA.");
      return;
    }
    if (failMissingReason) {
      toast.error("Every FAIL needs one line saying what was wrong.");
      return;
    }
    if (failMissingPhoto) {
      toast.error("Every FAIL needs a photo of what failed.");
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
          // The inspector is NOT sent. The server stamps it from the session
          // (qc-pending.ts sessionInspector) along with completedAt from its
          // own clock — a name and a time the client picks are a claim, not a
          // record. This used to post `me.displayName ?? me.email ?? "QC"`,
          // and that literal "QC" is exactly the problem: a quality record
          // signed by nobody.
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
  }, [subjectType, subjectId, subjectLabel, subjectCode, items, overallNotes, insp.id, allMandatoryAnswered, failMissingReason, failMissingPhoto, onRefresh, onClose, toast]);

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
      {assignedSubject ? (
        <div className="space-y-3">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-amber-800">
              {stage !== "RM"
                ? "Unit drawn for sampling"
                : isStoredCheck
                  ? "Stored material drawn for production today"
                  : `Goods receipt${(insp.sourceGrnNos?.length ?? 0) > 1 ? "s" : ""} to inspect`}
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-amber-900">
              {assignedSubject.label}
            </div>
            {isStoredCheck && (
              <div className="mt-1 text-xs text-amber-800">
                {insp.sourceBatchAgeDays != null ? (
                  <>
                    This batch has been in the store for{" "}
                    <strong>{insp.sourceBatchAgeDays} day{insp.sourceBatchAgeDays === 1 ? "" : "s"}</strong>
                    {insp.sourceGrnNo ? ` — it arrived on ${insp.sourceGrnNo}` : ""}. It passed on
                    arrival; this check asks whether it is still good now.
                  </>
                ) : (
                  <>A daily look at the store itself, not at one batch.</>
                )}
              </div>
            )}
            {stage === "RM" && !isStoredCheck && (insp.sourceGrnNos?.length ?? 0) > 1 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {insp.sourceGrnNos!.map((no) => (
                  <span
                    key={no}
                    className="rounded border border-amber-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-amber-900"
                  >
                    {no}
                  </span>
                ))}
              </div>
            )}
            {stage === "RM" && !isStoredCheck && insp.materialFamily && (
              <div className="mt-1 text-xs text-amber-800">
                Material family: <strong>{insp.materialFamily.replace(/_/g, " ")}</strong>
                {insp.sourceReceiptDate ? ` · received ${insp.sourceReceiptDate}` : ""} — one
                inspection covers everything of this family that arrived from this supplier that
                day. Goods of another family, or from another supplier, are a separate inspection.
              </div>
            )}
          </div>
          {stage === "FG" && insp.sampleReason && <SampleReasonPanel reason={insp.sampleReason} />}
          {stage === "FG" && insp.soSpec && <SoSpecPanel spec={insp.soSpec} />}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Overall notes (optional)</label>
            <Input value={overallNotes} onChange={(e) => setOverallNotes(e.target.value)} placeholder="Any general observation…" />
          </div>
        </div>
      ) : (
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
          {/*
            A FAILED subject fetch used to render as the reassuring "no
            production today" line below — a 400 from /api/job-cards looked
            exactly like a quiet factory, which is how three months and 3,009
            unsubmittable inspections went unnoticed (BUG-2026-08-07). An
            error now says ERROR, in red, with the reason. If this breaks
            again it must LOOK broken.
          */}
          {subjectsError ? (
            <p className="mt-1 text-xs font-medium text-red-600">
              Could not load the subject list: {subjectsError} — this is a fault, not an empty
              factory. Do not Skip; report it.
            </p>
          ) : subjectsLoading ? (
            <p className="mt-1 text-xs text-muted-foreground">Loading subjects…</p>
          ) : (
            stage === "WIP" && subjects.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No active job cards in this department. Use Skip if no production today.
              </p>
            )
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Overall notes (optional)</label>
          <Input value={overallNotes} onChange={(e) => setOverallNotes(e.target.value)} placeholder="Any general observation…" />
        </div>
      </div>
      )}

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
              {item.result != null && (
                <div className="mt-2 flex items-start gap-3">
                  {item.photoUrl ? (
                    <div className="relative">
                      <img
                        src={item.photoUrl}
                        alt=""
                        className={`h-24 w-32 rounded border object-cover ${
                          item.result === "FAIL" ? "border-red-400" : "border-input"
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => onItemPhoto(item.id, "")}
                        className="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold shadow"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                  <div>
                    {/*
                      `capture="environment"` is harmless on a desktop browser
                      (it falls back to the file picker) and opens the camera
                      directly on a tablet carried onto the floor, which is how
                      this screen is actually used at the goods-in bench.
                    */}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      id={`qc-photo-${item.id}`}
                      onChange={(e) => {
                        void onPickPhoto(item.id, e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <label
                      htmlFor={`qc-photo-${item.id}`}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium ${
                        item.result === "FAIL" && !item.photoUrl
                          ? "border-red-400 bg-background text-red-700"
                          : "border-input bg-background hover:bg-muted"
                      }`}
                    >
                      <Camera className="size-3.5" />
                      {item.photoUrl ? "Replace photo" : "Add photo"}
                    </label>
                    <p
                      className={`mt-1 text-[11px] ${
                        item.result === "FAIL" && !item.photoUrl
                          ? "font-medium text-red-600"
                          : "text-muted-foreground"
                      }`}
                    >
                      {item.result === "FAIL"
                        ? "Required — a failure with no picture is an argument three days later."
                        : "Optional on a pass."}
                    </p>
                  </div>
                </div>
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
        <Button onClick={submit} disabled={submitting || !subjectId || !allMandatoryAnswered || failMissingReason || failMissingPhoto}>
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
  // A photo nobody can look at afterwards is not a record. The grid is one row
  // per inspection; the per-item answers — and the pictures attached to them —
  // only exist behind a click, so there has to BE a click.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = inspections.find((i) => i.id === openId) ?? null;

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
      {
        key: "photos",
        label: "Photos",
        width: "70px",
        align: "right",
        render: (_v, row) => {
          const n = row.items.filter((i) => i.photoUrl).length;
          return n > 0 ? (
            <span className="inline-flex items-center gap-1 font-medium">
              <Camera className="size-3.5" />
              {n}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
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
          onRowClick={(row) => setOpenId((cur) => (cur === row.id ? null : row.id))}
          emptyMessage="No inspections yet. Generate today's slot from the Pending tab."
          gridId="qc-history"
          maxHeight="60vh"
        />
        {open && (
          <div className="space-y-3 border-t bg-muted/20 p-4">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="font-mono font-semibold">{open.inspectionNo}</span>
              <span className="text-muted-foreground">
                {open.inspectorName || "—"}
                {open.completedAt ? ` · ${fmtSlot(open.completedAt)}` : ""}
              </span>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="ml-auto text-xs text-muted-foreground underline"
              >
                Close
              </button>
            </div>
            {open.notes && <p className="text-sm">{open.notes}</p>}
            <div className="divide-y rounded-md border bg-background">
              {open.items.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No per-item answers were recorded on this inspection.
                </p>
              ) : (
                open.items.map((it) => (
                  <div key={it.id} className="flex items-start gap-3 px-3 py-2">
                    <Badge className={`shrink-0 text-xs ${it.result ? RESULT_COLOR[it.result] : ""}`}>
                      {it.result ?? "—"}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {it.sequence}. {it.itemName}
                      </div>
                      {it.notes && <p className="text-xs text-muted-foreground">{it.notes}</p>}
                    </div>
                    {it.photoUrl ? (
                      <a href={it.photoUrl} target="_blank" rel="noreferrer" className="shrink-0">
                        <img
                          src={it.photoUrl}
                          alt=""
                          className="h-16 w-20 rounded border object-cover"
                        />
                      </a>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted-foreground">no photo</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
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
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">Template</th>
                  <th className="px-3 py-2 text-left">Dept</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Material family</th>
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
                    <td className="px-3 py-2">
                      {t.stage !== "RM" ? (
                        <span className="text-muted-foreground">—</span>
                      ) : t.materialFamily ? (
                        t.materialFamily.replace(/_/g, " ")
                      ) : (
                        <span className="font-medium text-red-600" title="No receipt will ever be routed to this checklist.">
                          none — unreachable
                        </span>
                      )}
                    </td>
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
            </div>
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
    materialFamily: template?.materialFamily ?? "",
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
    if (form.stage === "RM" && !form.materialFamily) {
      toast.error("An incoming-material template must name the material family it covers — receipts are routed to checklists by family.");
      return;
    }
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
          {form.stage === "RM" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Material family</label>
              <select
                value={form.materialFamily}
                onChange={(e) => setForm((f) => ({ ...f, materialFamily: e.target.value }))}
                className="block w-full rounded-md border border-input bg-background p-2 text-sm"
              >
                <option value="">— choose a family —</option>
                {RM_FAMILY_OPTIONS.map((f) => (
                  <option key={f} value={f}>{f.replace(/_/g, " ")}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Goods receipts are routed here by the item group on their lines, not by department.
              </p>
            </div>
          )}
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
