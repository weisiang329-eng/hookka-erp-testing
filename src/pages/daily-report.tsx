// ===========================================================================
// Daily Report — newspaper-style process / SOP exceptions page.
//
// Reads /api/reports/compliance.json (see src/api/lib/compliance-report.ts)
// and lays out a top count strip + one section card per exception group, each
// with a compact table of the offending records linking back to the source.
// Plain tables / lists (NOT the DataGrid component). English only.
// ===========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import {
  OperationsEdition,
  EditionToggle,
  type Edition,
} from "./hookka-report-editions";
import {
  Loader2,
  ClipboardCheck,
  Truck,
  PackageCheck,
  FileText,
  ShoppingCart,
  Receipt,
  CalendarClock,
  PackageX,
  Users,
  CheckCircle2,
  ArrowUpRight,
  ArrowLeft,
  GitBranch,
  Timer,
  Layers,
  FlaskConical,
  Settings,
  Printer,
  X,
} from "lucide-react";

// ── API response types (mirror src/api/lib/compliance-report.ts) ────────────

interface DoPendingDispatchRow {
  id: string;
  doNo: string;
  customerName: string;
  createdAt: string;
  daysWaiting: number;
}
interface DoNotDeliveredRow {
  id: string;
  doNo: string;
  customerName: string;
  dispatchedAt: string;
  daysSinceDispatch: number;
}
interface DoNotInvoicedRow {
  id: string;
  doNo: string;
  customerName: string;
  deliveredAt: string;
  daysSinceDelivered: number;
}
interface SoNoDoRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
  // Newer payloads carry whole-days-since-confirmation so we can age the row.
  days?: number;
}
interface SoNoInvoiceRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
  // Newer payloads carry whole-days-since-delivery/close.
  days?: number;
}
interface OverdueRow {
  salesOrderId: string;
  companySOId: string;
  customerName: string;
  customerDeliveryDate: string;
  daysOverdue: number;
  status: string;
  totalQty: number;
  totalSen: number;
  productSummary: string;
}
interface PoNotReceivedRow {
  id: string;
  poNo: string;
  supplierName: string;
  status: string;
  orderDate: string;
  daysOpen: number;
  // Present only when the PO is past its Expected Delivery Date — how many
  // days past the promised arrival it now is.
  expectedOverdueDays?: number;
}
interface WorkerRow {
  name: string;
  empNo: string;
  departmentName: string;
  efficiencyPct: number;
  jobsCompleted: number;
  workingMinutes: number;
  productionMinutes: number;
}
interface ProcessSkipRow {
  productionOrderId: string;
  poNo: string;
  companySOId: string;
  salesOrderId: string;
  productName: string;
  doneDept: string;
  doneDeptCompletedDate: string;
  blockedByDept: string;
  blockedByStatus: string;
  // Newer payloads carry whole-days the earlier step has been idle / waiting.
  days?: number;
}
interface MissingWipTimeRow {
  productCode: string;
  productName: string;
  departmentCode: string;
  examplePoNo: string;
}
interface IncompleteBomRow {
  productCode: string;
  productName: string;
  reason: string;
}
interface RdStalledRow {
  id: string;
  name: string;
  status: string;
  currentStage: string;
  targetLaunchDate: string;
  daysOverdue: number;
}

interface ComplianceData {
  generatedAtIso: string;
  today: string;
  // BUG-2026-08-13-141 — every per-check count is `number | null`, and `null`
  // means the check could not RUN. `0` is now only ever an observed clean
  // result. `checksRun`/`checksTotal` are the coverage the headline must state.
  counts: {
    total: number;
    checksRun?: number;
    checksTotal?: number;
    doPendingDispatch: number | null;
    doNotDelivered: number | null;
    doNotInvoiced: number | null;
    soNoDo: number | null;
    soNoInvoice: number | null;
    overdueOrders: number | null;
    poNotReceived: number | null;
    lowEfficiencyWorkers: number | null;
    processSkips: number | null;
    missingWipTimes: number | null;
    incompleteBoms: number | null;
    rdStalled: number | null;
    pendingTimeAdjustments?: number | null;
    pricingIssues?: number | null;
    cogsIssues?: number | null;
  };
  /** Checks that threw. Empty ⇒ the sweep is complete. */
  unavailable?: { check: string; message: string }[];
  groups: {
    doPendingDispatch: DoPendingDispatchRow[];
    doNotDelivered: DoNotDeliveredRow[];
    doNotInvoiced: DoNotInvoicedRow[];
    soNoDo: SoNoDoRow[];
    soNoInvoice: SoNoInvoiceRow[];
    overdueOrders: OverdueRow[];
    poNotReceived: PoNotReceivedRow[];
    lowEfficiencyWorkers: WorkerRow[];
    processSkips: ProcessSkipRow[];
    missingWipTimes: MissingWipTimeRow[];
    incompleteBoms: IncompleteBomRow[];
    rdStalled: RdStalledRow[];
  };
}
type ComplianceResp = { success?: boolean; data?: ComplianceData };

// ── SOP grace-threshold config (kv_config: daily-report-config) ─────────────
// The editable per-category grace windows. The backend independently falls
// back to the same defaults, so an empty/unset config still renders.

interface GraceDays {
  doPendingDispatch: number;
  doNotDelivered: number;
  doNotInvoiced: number;
  soWithoutDo: number;
  soWithoutInvoice: number;
  poNotReceived: number;
  processSkips: number;
}

const DAILY_REPORT_CONFIG_KEY = "daily-report-config";

const DEFAULT_GRACE_DAYS: GraceDays = {
  doPendingDispatch: 1,
  doNotDelivered: 1,
  doNotInvoiced: 1,
  soWithoutDo: 2,
  soWithoutInvoice: 3,
  poNotReceived: 14,
  processSkips: 1,
};

// Field order + labels + helper copy for the settings panel. Driven off this
// list so the panel and the defaults can never drift.
const GRACE_FIELDS: {
  key: keyof GraceDays;
  label: string;
  help: string;
}[] = [
  {
    key: "doPendingDispatch",
    label: "DO Pending Dispatch",
    help: "Only flag a draft DO after N days.",
  },
  {
    key: "doNotDelivered",
    label: "DO Not Delivered",
    help: "Only flag a dispatched DO after N days on the road.",
  },
  {
    key: "doNotInvoiced",
    label: "DO Not Invoiced",
    help: "Only flag a delivered DO after N days uninvoiced.",
  },
  {
    key: "soWithoutDo",
    label: "SO Without DO",
    help: "Only flag a confirmed SO after N days with no delivery order.",
  },
  {
    key: "soWithoutInvoice",
    label: "SO Without Invoice",
    help: "Only flag a closed SO after N days with no invoice.",
  },
  {
    key: "poNotReceived",
    label: "PO Not Received",
    help: "Only flag an open PO after N days with no goods receipt.",
  },
  {
    key: "processSkips",
    label: "Process Skips",
    help: "Only flag an out-of-sequence step after N days idle.",
  },
];

// Section anchor ids — referenced by both the count tiles (drill-in target)
// and the rendered <Section> wrappers.
const SECTION_IDS = {
  doPendingDispatch: "sec-do-pending-dispatch",
  doNotDelivered: "sec-do-not-delivered",
  doNotInvoiced: "sec-do-not-invoiced",
  soNoDo: "sec-so-no-do",
  soNoInvoice: "sec-so-no-invoice",
  overdueOrders: "sec-overdue-orders",
  poNotReceived: "sec-po-not-received",
  lowEfficiencyWorkers: "sec-low-efficiency-workers",
  processSkips: "sec-process-skips",
  missingWipTimes: "sec-missing-wip-times",
  incompleteBoms: "sec-incomplete-boms",
  rdStalled: "sec-rd-stalled",
} as const;
type SectionKey = keyof typeof SECTION_IDS;

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDateLong(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDate(ymd: string): string {
  if (!ymd) return "—";
  const d = new Date(ymd.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRM(sen: number): string {
  if (!sen) return "—";
  return "RM " + (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Day-count badge — escalates from neutral to red as the wait grows.
function DaysBadge({ days, suffix = "d" }: { days: number; suffix?: string }) {
  const color =
    days >= 14
      ? "bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5]"
      : days >= 7
        ? "bg-[#FFEDD5] text-[#C2410C] border-[#FED7AA]"
        : days >= 3
          ? "bg-[#FEF3C7] text-[#A16207] border-[#FDE68A]"
          : "bg-[#F0ECE9] text-[#6B5C32] border-[#E2DDD8]";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${color}`}
    >
      {days}
      {suffix}
    </span>
  );
}

// Efficiency badge — always red here (only sub-threshold workers are listed).
function EffBadge({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#FCA5A5] bg-[#FEE2E2] px-2 py-0.5 text-[11px] font-semibold text-[#B91C1C] tabular-nums">
      {pct}%
    </span>
  );
}

// ── Count strip tile ────────────────────────────────────────────────────

function CountTile({
  label,
  value,
  icon: Icon,
  highlight = false,
  active = false,
  onClick,
}: {
  label: string;
  /** `null` = this check could not run. Renders "—", never a green 0. */
  value: number | null;
  icon: React.ElementType;
  highlight?: boolean;
  // True when this tile's detail is the one currently open — draws a ring so
  // the operator can see which category is expanded.
  active?: boolean;
  // When provided AND value > 0 the tile becomes a drill-in button that
  // reveals its detail section. Zero-count tiles are inert.
  onClick?: () => void;
}) {
  // BUG-2026-08-13-141: an unavailable check is NOT a clear one. `value === 0`
  // used to be reached by both, painting the tile green either way.
  const unknown = value == null;
  const clear = value === 0;
  const interactive = !highlight && !clear && !unknown && !!onClick;

  // Severity escalation for non-zero, non-total tiles: the bigger the backlog,
  // the louder the tile. Keeps "needs attention" weighting obvious at a glance.
  const sev = highlight
    ? null
    : unknown
      ? "unknown"
      : clear
        ? "clear"
        : value >= 10
          ? "red"
          : value >= 5
            ? "orange"
            : "amber";

  const tone =
    highlight
      ? "bg-[#1F1D1B] text-white border-[#1F1D1B]"
      : sev === "unknown"
        ? "bg-[#F4F4F5] border-[#D4D4D8] border-dashed"
        : sev === "red"
          ? "bg-[#FEF2F2] border-[#FCA5A5]"
          : sev === "orange"
            ? "bg-[#FFF7ED] border-[#FED7AA]"
            : sev === "amber"
              ? "bg-[#FFFBEB] border-[#FDE68A]"
              : "bg-white";

  const valueColor =
    highlight
      ? "text-white"
      : sev === "unknown"
        ? "text-[#71717A]"
        : clear
          ? "text-[#15803D]"
          : sev === "red"
            ? "text-[#B91C1C]"
            : sev === "orange"
              ? "text-[#C2410C]"
              : "text-[#A16207]";

  const iconColor = highlight
    ? "text-[#C9A24B]"
    : sev === "unknown"
      ? "text-[#71717A]"
      : sev === "red"
        ? "text-[#B91C1C]"
        : sev === "orange"
          ? "text-[#C2410C]"
          : sev === "amber"
            ? "text-[#A16207]"
            : "text-[#6B5C32]";

  const card = (
    <Card
      className={`rounded-xl transition-all ${tone} ${
        active
          ? "shadow-[0_0_0_2px_#C9A24B,0_8px_20px_rgba(201,162,75,0.25)]"
          : "shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
      } ${
        interactive
          ? "cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)]"
          : ""
      }`}
    >
      <CardContent className="p-3.5">
        <div className="flex items-start justify-between">
          <p
            className={`text-[10px] font-semibold uppercase tracking-wider ${
              highlight ? "text-[#D8D2C6]" : "text-[#5A5550]"
            }`}
          >
            {label}
          </p>
          <Icon className={`h-4 w-4 ${iconColor}`} />
        </div>
        <p
          className={`mt-1.5 text-2xl font-[800] tabular-nums leading-none ${valueColor}`}
        >
          {unknown ? "—" : value}
        </p>
        {unknown && (
          <p className="mt-1 text-[10px] leading-tight text-[#71717A]">
            Couldn&apos;t check — this is not a clear result, it is an unknown
            one.
          </p>
        )}
      </CardContent>
    </Card>
  );

  if (!interactive) return card;

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A24B] focus-visible:ring-offset-1 rounded-xl"
      aria-label={`${label}: ${value} — ${active ? "hide details" : "show details"}`}
      aria-pressed={active}
    >
      {card}
    </button>
  );
}

// ── Section card ──────────────────────────────────────────────────────────

function Section({
  id,
  title,
  subtitle,
  count,
  icon: Icon,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  /** `null` = the check could not run; the badge says so instead of "Clear". */
  count: number | null;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <Card
      id={id}
      className="rounded-xl bg-white scroll-mt-24 shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[#F5F2ED] p-2 mt-0.5">
            <Icon className="h-4 w-4 text-[#6B5C32]" />
          </div>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="text-xs text-[#9CA3AF] mt-0.5">{subtitle}</p>
          </div>
        </div>
        {count == null ? (
          <Badge className="bg-[#F4F4F5] text-[#71717A] border-[#D4D4D8]">
            Couldn&apos;t check
          </Badge>
        ) : count > 0 ? (
          <Badge className="bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5] tabular-nums">
            {count}
          </Badge>
        ) : (
          <Badge className="bg-[#DCFCE7] text-[#15803D] border-[#BBF7D0]">
            Clear
          </Badge>
        )}
      </CardHeader>
      <CardContent className="p-5 pt-0">{children}</CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-[#F7FBF8] border border-[#DCF1E3] px-4 py-3">
      <CheckCircle2 className="h-4 w-4 text-[#15803D] shrink-0" />
      <span className="text-sm text-[#15803D]">
        All clear — nothing flagged.
      </span>
    </div>
  );
}

// Shared table chrome — thin head, hairline rows, link on first column.
function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`py-2 px-2 font-medium text-[11px] uppercase tracking-wide text-[#9CA3AF] ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  right = false,
  strong = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={`py-2 px-2 align-middle ${right ? "text-right" : "text-left"} ${
        strong ? "font-semibold text-[#1F1D1B]" : "text-[#5A5550]"
      }`}
    >
      {children}
    </td>
  );
}

function RecordLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-0.5 font-semibold text-[#6B5C32] hover:text-[#4D4224] hover:underline"
    >
      {label}
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  );
}

// ── SOP threshold settings panel ───────────────────────────────────────────
// Reads + writes kv_config('daily-report-config'). Edits the graceDays object;
// merges back any other keys the config blob may carry so we never clobber
// fields the UI doesn't surface.

function SettingsPanel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [grace, setGrace] = useState<GraceDays>(DEFAULT_GRACE_DAYS);
  // Whatever else lived in the config blob — preserved on save.
  const otherKeys = useRef<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/kv-config/${DAILY_REPORT_CONFIG_KEY}`)
      .then(
        (r) =>
          r.json() as Promise<{
            data?: { graceDays?: Partial<GraceDays> } & Record<string, unknown>;
          }>,
      )
      .then((j) => {
        if (!alive) return;
        const blob = j?.data ?? null;
        if (blob && typeof blob === "object") {
          const { graceDays, ...rest } = blob;
          otherKeys.current = rest;
          setGrace({ ...DEFAULT_GRACE_DAYS, ...(graceDays ?? {}) });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setField = (key: keyof GraceDays, raw: string) => {
    const n = Math.max(0, Math.round(Number(raw)));
    setGrace((g) => ({ ...g, [key]: Number.isFinite(n) ? n : 0 }));
  };

  const save = async () => {
    // Reject any non-finite / negative value before persisting.
    for (const f of GRACE_FIELDS) {
      const v = grace[f.key];
      if (!Number.isFinite(v) || v < 0) {
        toast.error(`${f.label}: enter a valid number of days (0 or more)`);
        return;
      }
    }
    setSaving(true);
    try {
      const merged = { ...otherKeys.current, graceDays: grace };
      const res = await fetch(`/api/kv-config/${DAILY_REPORT_CONFIG_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) {
        toast.success("Thresholds saved — refreshing report");
        onSaved();
        onClose();
      } else {
        toast.error(j?.error || "Failed to save thresholds");
      }
    } catch {
      toast.error("Failed to save thresholds");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Daily Report thresholds"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-[#F5F2ED] p-2 mt-0.5">
              <Settings className="h-4 w-4 text-[#6B5C32]" />
            </div>
            <div>
              <CardTitle className="text-base">Report Thresholds</CardTitle>
              <p className="text-xs text-[#9CA3AF] mt-0.5">
                Grace period before each category is flagged.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[#9CA3AF] hover:bg-[#F5F2ED] hover:text-[#1F1D1B]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          {!loaded ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
            </div>
          ) : (
            <>
              <div className="divide-y divide-[#F0ECE6]">
                {GRACE_FIELDS.map((f) => (
                  <div
                    key={f.key}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#1F1D1B]">
                        {f.label}
                      </p>
                      <p className="text-[11px] text-[#9CA3AF]">{f.help}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={grace[f.key]}
                        onChange={(e) => setField(f.key, e.target.value)}
                        className="w-20 rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-right text-sm tabular-nums text-[#1F1D1B] focus:border-[#C9A24B] focus:outline-none focus:ring-1 focus:ring-[#C9A24B]"
                      />
                      <span className="text-xs text-[#9CA3AF] w-8">days</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setGrace(DEFAULT_GRACE_DAYS)}
                  disabled={saving}
                >
                  Reset to defaults
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onClose}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={save}
                    disabled={saving}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

// ===========================================================================
// Hookka Report — the "news" layer.
//
// Wei Siang 2026-06-04: re-skin the Daily Report so each day's data reads like
// a newspaper — a masthead, a lead story, and one headline article per active
// exception group. The underlying compliance data + the detailed tables ("The
// Full Record") are unchanged; this only adds the front-page presentation.
// English only (UI rule).
// ===========================================================================
type NewsRecord = { primary: string; secondary?: string; to?: string; tag?: string };
type NewsArticle = {
  key: SectionKey;
  desk: string;
  headline: string;
  lead: string;
  count: number;
  score: number; // ranking weight — the highest becomes the lead story
  records: NewsRecord[];
  total: number;
  moreTo: string;
};

const plS = (n: number) => (n === 1 ? "" : "s");

// Turn the day's compliance groups into ranked news articles. Pure function —
// no data fetching. Severity weights put money + delivery stories up top and
// data-hygiene stories at the bottom; ties break on count.
function buildHookkaArticles(
  rawCounts: ComplianceData["counts"],
  groups: ComplianceData["groups"],
): NewsArticle[] {
  // Every article below is gated on `groups.X.length`, and a group only has
  // rows when its check RAN — so inside those branches the count is never null.
  // Normalising here keeps each headline byte-identical while letting
  // ComplianceCounts carry the `null` that BUG-2026-08-13-141 needs. An
  // unavailable check produces no article at all, which is correct: there is no
  // story to tell, and the coverage banner above the fold says why.
  const counts = Object.fromEntries(
    Object.entries(rawCounts).map(([k, v]) => [k, v ?? 0]),
  ) as { [K in keyof ComplianceData["counts"]]-?: number };
  const arts: NewsArticle[] = [];

  if (groups.overdueOrders.length) {
    const rows = [...groups.overdueOrders].sort((a, b) => b.daysOverdue - a.daysOverdue);
    const w = rows[0];
    arts.push({
      // Production Desk, not Delivery: this counts orders still IN PRODUCTION
      // (DRAFT/CONFIRMED/IN_PRODUCTION/ON_HOLD) past the customer-promised date.
      // Once READY_TO_SHIP it leaves this list — shipping lateness is a
      // different (delivery-side) measure. Relabeled owner audit 2026-07-11.
      key: "overdueOrders", desk: "Production Desk",
      headline: `${counts.overdueOrders} Order${plS(counts.overdueOrders)} Now Past Due (still in production)`,
      lead: `${w.customerName} has waited longest — ${w.daysOverdue} day${plS(w.daysOverdue)} beyond the promised date.${rows.length > 1 ? ` ${counts.overdueOrders} orders sit late across the book.` : ""}`,
      count: counts.overdueOrders, score: 950 + counts.overdueOrders,
      records: rows.slice(0, 4).map((r) => ({ primary: r.companySOId, secondary: `${r.customerName}${r.productSummary ? ` · ${r.productSummary}` : ""}`, to: `/sales/${r.salesOrderId}`, tag: `${r.daysOverdue}d late` })),
      total: rows.length, moreTo: "/sales",
    });
  }
  if (groups.doNotInvoiced.length) {
    const rows = [...groups.doNotInvoiced].sort((a, b) => b.daysSinceDelivered - a.daysSinceDelivered);
    arts.push({
      key: "doNotInvoiced", desk: "Billing Desk",
      headline: `Billing Backlog: ${counts.doNotInvoiced} Delivered Order${plS(counts.doNotInvoiced)} Unbilled`,
      lead: `Goods are out the door but the invoices haven't followed — the oldest has gone ${rows[0].daysSinceDelivered} day${plS(rows[0].daysSinceDelivered)} since delivery.`,
      count: counts.doNotInvoiced, score: 880 + counts.doNotInvoiced,
      records: rows.slice(0, 4).map((r) => ({ primary: r.doNo, secondary: r.customerName, tag: `${r.daysSinceDelivered}d` })),
      total: rows.length, moreTo: "/delivery",
    });
  }
  if (groups.soNoInvoice.length) {
    const rows = groups.soNoInvoice;
    arts.push({
      key: "soNoInvoice", desk: "Billing Desk",
      headline: `${counts.soNoInvoice} Delivered Sale${plS(counts.soNoInvoice)} Still Awaiting an Invoice`,
      lead: `Delivered orders that haven't been billed yet — revenue waiting to be booked. (RM0 service orders excluded.)`,
      count: counts.soNoInvoice, score: 820 + counts.soNoInvoice,
      records: rows.slice(0, 4).map((r) => ({ primary: r.companySOId, secondary: `${r.customerName} · ${r.status}`, to: `/sales/${r.id}`, tag: r.days ? `${r.days}d` : undefined })),
      total: rows.length, moreTo: "/sales",
    });
  }
  if (groups.doPendingDispatch.length) {
    const rows = [...groups.doPendingDispatch].sort((a, b) => b.daysWaiting - a.daysWaiting);
    arts.push({
      key: "doPendingDispatch", desk: "Dispatch Dock",
      headline: `${counts.doPendingDispatch} Delivery Order${plS(counts.doPendingDispatch)} Idle on the Dock`,
      lead: `Drafted but not yet sent out — the longest has sat ${rows[0].daysWaiting} day${plS(rows[0].daysWaiting)} waiting for a truck.`,
      count: counts.doPendingDispatch, score: 760 + counts.doPendingDispatch,
      records: rows.slice(0, 4).map((r) => ({ primary: r.doNo, secondary: r.customerName, tag: `${r.daysWaiting}d` })),
      total: rows.length, moreTo: "/delivery",
    });
  }
  if (groups.doNotDelivered.length) {
    const rows = [...groups.doNotDelivered].sort((a, b) => b.daysSinceDispatch - a.daysSinceDispatch);
    arts.push({
      key: "doNotDelivered", desk: "Delivery Desk",
      headline: `${counts.doNotDelivered} Shipment${plS(counts.doNotDelivered)} Out, Delivery Unconfirmed`,
      lead: `On the road but no delivery has been logged back — the oldest left ${rows[0].daysSinceDispatch} day${plS(rows[0].daysSinceDispatch)} ago.`,
      count: counts.doNotDelivered, score: 700 + counts.doNotDelivered,
      records: rows.slice(0, 4).map((r) => ({ primary: r.doNo, secondary: r.customerName, tag: `${r.daysSinceDispatch}d` })),
      total: rows.length, moreTo: "/delivery",
    });
  }
  if (groups.soNoDo.length) {
    const rows = groups.soNoDo;
    arts.push({
      key: "soNoDo", desk: "Sales Desk",
      headline: `${counts.soNoDo} Sales Order${plS(counts.soNoDo)} Without a Delivery Order`,
      lead: `Confirmed sales that haven't been turned into a delivery order yet.`,
      count: counts.soNoDo, score: 640 + counts.soNoDo,
      records: rows.slice(0, 4).map((r) => ({ primary: r.companySOId, secondary: `${r.customerName} · ${r.status}`, to: `/sales/${r.id}`, tag: r.days ? `${r.days}d` : undefined })),
      total: rows.length, moreTo: "/sales",
    });
  }
  if (groups.processSkips.length) {
    const rows = groups.processSkips;
    arts.push({
      key: "processSkips", desk: "Production Desk",
      headline: `Out of Sequence: ${counts.processSkips} Order${plS(counts.processSkips)} Skipped a Step`,
      lead: `A later department finished before an earlier one — ${rows[0].doneDept} ran ahead of ${rows[0].blockedByDept} on ${rows[0].poNo}.`,
      count: counts.processSkips, score: 560 + counts.processSkips,
      records: rows.slice(0, 4).map((r) => ({ primary: r.poNo, secondary: `${r.doneDept} ahead of ${r.blockedByDept}`, to: r.salesOrderId ? `/sales/${r.salesOrderId}` : "/production", tag: r.days ? `${r.days}d` : undefined })),
      total: rows.length, moreTo: "/production",
    });
  }
  if (groups.poNotReceived.length) {
    const rows = [...groups.poNotReceived].sort((a, b) => (b.expectedOverdueDays || 0) - (a.expectedOverdueDays || 0) || b.daysOpen - a.daysOpen);
    const w = rows[0];
    arts.push({
      key: "poNotReceived", desk: "Procurement Desk",
      headline: `Supply Watch: ${counts.poNotReceived} Purchase Order${plS(counts.poNotReceived)} Yet to Arrive`,
      lead: `${w.supplierName}'s order has been open ${w.daysOpen} day${plS(w.daysOpen)}${w.expectedOverdueDays ? `, now ${w.expectedOverdueDays} day${plS(w.expectedOverdueDays)} past its promised arrival` : ""}.`,
      count: counts.poNotReceived, score: 500 + counts.poNotReceived,
      records: rows.slice(0, 4).map((r) => ({ primary: r.poNo, secondary: r.supplierName, to: `/procurement/${r.id}`, tag: r.expectedOverdueDays ? `${r.expectedOverdueDays}d late` : `${r.daysOpen}d` })),
      total: rows.length, moreTo: "/procurement",
    });
  }
  if (groups.lowEfficiencyWorkers.length) {
    const rows = [...groups.lowEfficiencyWorkers].sort((a, b) => a.efficiencyPct - b.efficiencyPct);
    arts.push({
      key: "lowEfficiencyWorkers", desk: "The Floor",
      headline: `${counts.lowEfficiencyWorkers} on the Floor Below Pace Yesterday`,
      lead: `${rows[0].name} (${rows[0].departmentName}) came in lowest at ${rows[0].efficiencyPct}% of standard.`,
      count: counts.lowEfficiencyWorkers, score: 440 + counts.lowEfficiencyWorkers,
      records: rows.slice(0, 4).map((r) => ({ primary: r.name, secondary: r.departmentName, tag: `${r.efficiencyPct}%` })),
      total: rows.length, moreTo: "/daily-report",
    });
  }
  if (groups.incompleteBoms.length) {
    const rows = groups.incompleteBoms;
    arts.push({
      key: "incompleteBoms", desk: "Data Desk",
      headline: `${counts.incompleteBoms} Bill${plS(counts.incompleteBoms)} of Materials Left Incomplete`,
      lead: `Products that can't cost or plan cleanly until their BOM is finished — starting with ${rows[0].productCode}.`,
      count: counts.incompleteBoms, score: 300 + counts.incompleteBoms,
      records: rows.slice(0, 4).map((r) => ({ primary: r.productCode, secondary: r.reason })),
      total: rows.length, moreTo: "/products",
    });
  }
  if (groups.missingWipTimes.length) {
    const rows = groups.missingWipTimes;
    arts.push({
      key: "missingWipTimes", desk: "Data Desk",
      headline: `Data Gap: ${counts.missingWipTimes} Product${plS(counts.missingWipTimes)} Missing WIP Times`,
      lead: `No standard minutes set for these jobs, so efficiency can't be measured — e.g. ${rows[0].productCode} at ${rows[0].departmentCode}.`,
      count: counts.missingWipTimes, score: 250 + counts.missingWipTimes,
      records: rows.slice(0, 4).map((r) => ({ primary: r.productCode, secondary: `${r.departmentCode} · ${r.examplePoNo}` })),
      total: rows.length, moreTo: "/products",
    });
  }
  if (groups.rdStalled.length) {
    const rows = groups.rdStalled;
    arts.push({
      key: "rdStalled", desk: "R&D Desk",
      headline: `R&D Desk: ${counts.rdStalled} Project${plS(counts.rdStalled)} Stalled`,
      lead: `Development work that hasn't moved and may be holding up new products.`,
      count: counts.rdStalled, score: 200 + counts.rdStalled,
      records: rows.slice(0, 4).map((r) => ({ primary: r.name || "—", to: `/rd/${r.id}` })),
      total: rows.length, moreTo: "/rd",
    });
  }

  return arts.sort((a, b) => b.score - a.score);
}

// Compact news-style record list shown inside each article.
function ArticleRecords({ records, total, moreTo }: { records: NewsRecord[]; total: number; moreTo: string }) {
  return (
    <ul className="mt-2 border-t border-[#E2DDD8] divide-y divide-[#EDE8E2]">
      {records.map((rec, i) => {
        const inner = (
          <div className="flex items-baseline justify-between gap-2 py-1">
            <span className="min-w-0">
              <span className="font-semibold text-[#1F1D1B] doc-number">{rec.primary}</span>
              {rec.secondary && <span className="block truncate text-[11px] text-[#6B7280]">{rec.secondary}</span>}
            </span>
            {rec.tag && <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-[#9A3A2D] tabular-nums">{rec.tag}</span>}
          </div>
        );
        return rec.to ? (
          <li key={i}>
            <Link to={rec.to} className="-mx-1 block rounded px-1 hover:bg-[#FAF8F4]">{inner}</Link>
          </li>
        ) : (
          <li key={i} className="-mx-1 px-1">{inner}</li>
        );
      })}
      {total > records.length && (
        <li className="pt-1.5">
          <Link to={moreTo} className="text-[11px] font-semibold text-[#6B5C32] hover:underline">
            + {total - records.length} more →
          </Link>
        </li>
      )}
    </ul>
  );
}

// Period navigation helpers for the Weekly/Monthly editions (Daily is always
// "today" — its SOP exceptions are live state, not a historical snapshot).
function ymdToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function shiftMonth(ymd: string, months: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export default function DailyReportPage() {
  // ── KPI drill-down ────────────────────────────────────────────────────
  // Two KPI cards link here and both were landing on the wrong thing:
  //
  //  • `documents_not_stuck` linked to a bare /daily-report, which opens the
  //    tile overview — the operator then had to guess which of twelve
  //    exception categories the invoicing half was scored on. `?section=` now
  //    opens that category's list directly.
  //
  //  • `production_efficiency` linked to /reports/operations, a route that has
  //    never existed — no `operations` tab on /reports, no /reports/:tab route,
  //    so the link rendered a BLANK page. It now opens the Monthly Operations
  //    edition below for the card's own month, which reads the per-worker
  //    efficiency the metric aggregates.
  //
  // Read once, at mount, as the INITIAL value of the existing state: these are
  // an entry point, not a controlled binding, so the operator's own toggling
  // afterwards must not be fought by the URL.
  const [searchParams] = useSearchParams();
  const { data: raw, loading, refresh } =
    useCachedJson<ComplianceResp>("/api/reports/compliance.json");

  const data = useMemo<ComplianceData | null>(() => {
    if (!raw) return null;
    return raw.data ?? null;
  }, [raw]);

  // Drill-in: which one category's detail is open (null = cards-only overview).
  const [openKey, setOpenKey] = useState<SectionKey | null>(() => {
    const s = searchParams.get("section");
    return s && s in SECTION_IDS ? (s as SectionKey) : null;
  });
  const detailRef = useRef<HTMLDivElement | null>(null);

  // Toggle a tile: open its detail, or close it if it's already the open one.
  const toggleKey = useCallback((key: SectionKey) => {
    setOpenKey((cur) => (cur === key ? null : key));
  }, []);

  // Smooth-scroll the freshly-opened detail into view.
  useEffect(() => {
    if (openKey && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [openKey]);

  // Settings panel open/closed.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Daily / Weekly / Monthly edition toggle. Daily = this page's existing
  // SOP-exception newspaper; Weekly/Monthly = the operations editions.
  const [edition, setEdition] = useState<Edition>(() => {
    const e = searchParams.get("edition");
    return e === "weekly" || e === "monthly" ? e : "daily";
  });
  // Anchor date for the Weekly/Monthly editions — lets you page back to an
  // older week/month and print it. Any day in the target period works.
  //
  // `?period=YYYY-MM` is the KPI card's month. Any day inside it anchors the
  // Monthly edition, so the first of the month is used. Without this the link
  // would open the CURRENT month's operations report next to a card showing
  // June's efficiency — the exact class of disagreement this whole change is
  // about.
  const [anchorYmd, setAnchorYmd] = useState(() => {
    const p = searchParams.get("period") ?? "";
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) return `${p}-01`;
    const d = searchParams.get("date") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= ymdToday()) return d;
    return ymdToday();
  });

  if (edition !== "daily") {
    const today = ymdToday();
    const stepBack = () =>
      setAnchorYmd(
        edition === "monthly" ? shiftMonth(anchorYmd, -1) : shiftYmd(anchorYmd, -7),
      );
    const stepFwd = () => {
      const next =
        edition === "monthly" ? shiftMonth(anchorYmd, 1) : shiftYmd(anchorYmd, 7);
      if (next <= today) setAnchorYmd(next);
    };
    const atToday =
      edition === "monthly"
        ? anchorYmd.slice(0, 7) >= today.slice(0, 7)
        : anchorYmd >= today;
    return (
      <div className="space-y-6">
        <EditionToggle edition={edition} onChange={setEdition} />
        <div className="flex items-center justify-center gap-2 print:hidden">
          <button
            type="button"
            onClick={stepBack}
            className="rounded border border-[#1F1D1B] px-2.5 py-1 font-serif text-sm hover:bg-[#F0ECE9]"
            title="Previous period"
          >
            ◀
          </button>
          {edition === "monthly" ? (
            <input
              type="month"
              value={anchorYmd.slice(0, 7)}
              max={today.slice(0, 7)}
              onChange={(e) => e.target.value && setAnchorYmd(e.target.value + "-01")}
              className="rounded border border-[#E2DDD8] px-2 py-1 text-sm focus:border-[#6B5C32] focus:outline-none"
            />
          ) : (
            <input
              type="date"
              value={anchorYmd}
              max={today}
              onChange={(e) => e.target.value && setAnchorYmd(e.target.value)}
              className="rounded border border-[#E2DDD8] px-2 py-1 text-sm focus:border-[#6B5C32] focus:outline-none"
            />
          )}
          <button
            type="button"
            onClick={stepFwd}
            disabled={atToday}
            className="rounded border border-[#1F1D1B] px-2.5 py-1 font-serif text-sm hover:bg-[#F0ECE9] disabled:opacity-30"
            title="Next period"
          >
            ▶
          </button>
        </div>
        <OperationsEdition edition={edition} anchorYmd={anchorYmd} />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Daily Report</h1>
          <p className="text-xs text-[#6B7280]">
            Process &amp; SOP exceptions — what needs attention today
          </p>
        </div>
        <Card>
          <CardContent className="p-12 text-center">
            <ClipboardCheck className="h-10 w-10 text-[#E2DDD8] mx-auto mb-3" />
            <p className="text-sm text-[#6B7280]">
              Could not load the report. Please try again.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { counts, groups } = data;
  const articles = buildHookkaArticles(counts, groups);
  // Coverage of the sweep itself. Falls back to counting the null counts when
  // the payload predates `unavailable` (a cached pre-fix snapshot), so an old
  // body still cannot claim completeness it never had.
  const unavailableCount =
    data.unavailable?.length ??
    Object.values(counts).filter((v) => v === null).length;
  const checksTotal = counts.checksTotal ?? 15;

  return (
    <div className="space-y-6">
      <EditionToggle edition={edition} onChange={setEdition} />
      {/* ── Masthead ─────────────────────────────────────────────── */}
      <header className="border-y-[3px] border-double border-[#1F1D1B] py-3">
        <div className="flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B7280]">
          <span>Hookka Manufacturing</span>
          <span className="hidden sm:inline">Daily Factory Edition</span>
          <span className="inline-flex items-center gap-3">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1 hover:text-[#1F1D1B] print:hidden"
            >
              <Printer className="h-3 w-3" /> Print
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-1 hover:text-[#1F1D1B] print:hidden"
            >
              <Settings className="h-3 w-3" /> Settings
            </button>
          </span>
        </div>
        <h1 className="mt-1 text-center font-serif text-4xl font-black tracking-tight text-[#1F1D1B] sm:text-5xl">
          The Hookka Report
        </h1>
        <div className="mt-1 flex items-center justify-center gap-3 border-t border-[#1F1D1B] pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B7280]">
          <span>{formatDateLong(data.today)}</span>
          <span className="text-[#C9A24B]">◆</span>
          <span>
            {counts.total}
            {unavailableCount > 0 ? "+" : ""}{" "}
            {counts.total === 1 ? "Story" : "Stories"} on the Floor
          </span>
          {unavailableCount > 0 && (
            <>
              <span className="text-[#C9A24B]">◆</span>
              <span className="text-[#9A3A2D]">
                {unavailableCount} of {checksTotal} checks could not run
              </span>
            </>
          )}
        </div>
      </header>

      {/* Coverage banner — a report that only partly ran says so at the top,
          above every figure it produced. BUG-2026-08-13-141. */}
      {unavailableCount > 0 && (
        <div className="border border-[#D4D4D8] bg-[#F4F4F5] p-4">
          <p className="font-serif text-sm font-bold text-[#3F3F46]">
            This report is incomplete: {unavailableCount} of {checksTotal} checks
            could not run.
          </p>
          <p className="mt-1 text-xs text-[#52525B]">
            The count above is a floor, not a total, and the affected sections
            below show &ldquo;Couldn&apos;t check&rdquo; rather than
            &ldquo;Clear&rdquo;. A check that failed has found nothing because it
            did not look.
          </p>
          <ul className="mt-2 space-y-0.5 text-[11px] text-[#52525B]">
            {(data.unavailable ?? []).map((u) => (
              <li key={u.check}>
                <span className="font-semibold">{u.check}</span> — {u.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Front page ───────────────────────────────────────────── */}
      {/* "A Quiet Day" requires BOTH nothing found AND every check having run —
          a silent zero off a half-finished sweep is the exact defect. */}
      {counts.total === 0 && unavailableCount === 0 ? (
        <div className="border border-[#DCF1E3] bg-[#F7FBF8] p-8 text-center">
          <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-[#15803D]" />
          <h2 className="font-serif text-2xl font-bold text-[#15803D]">A Quiet Day on the Floor</h2>
          <p className="mt-1 text-sm text-[#4B7A58]">
            Nothing flagged across delivery, billing, production or the supply line. The presses are quiet.
          </p>
        </div>
      ) : counts.total === 0 ? (
        <div className="border border-[#D4D4D8] bg-[#FAFAFA] p-8 text-center">
          <h2 className="font-serif text-2xl font-bold text-[#3F3F46]">
            An Unknown Day on the Floor
          </h2>
          <p className="mt-1 text-sm text-[#52525B]">
            The checks that ran found nothing — but {unavailableCount} of{" "}
            {checksTotal} did not run, so this is not a quiet day. It is a day we
            cannot see.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {articles[0] && (
            <article className="border-b-2 border-[#1F1D1B] pb-5 lg:col-span-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#9A3A2D]">
                {articles[0].desk} · Lead Story
              </p>
              <h2 className="mt-1 font-serif text-3xl font-black leading-[1.1] text-[#1F1D1B] sm:text-4xl">
                {articles[0].headline}
              </h2>
              <p className="mt-2 font-serif text-[15px] leading-relaxed text-[#3A352F]">
                <span className="float-left mr-2 font-serif text-5xl font-black leading-[0.8] text-[#1F1D1B]">
                  {articles[0].lead.charAt(0)}
                </span>
                {articles[0].lead.slice(1)}
              </p>
              <ArticleRecords records={articles[0].records} total={articles[0].total} moreTo={articles[0].moreTo} />
            </article>
          )}
          <aside className="h-fit border border-[#1F1D1B] bg-[#FAF8F4] p-4">
            <p className="border-b border-[#1F1D1B] pb-1 text-center font-serif text-sm font-bold uppercase tracking-wide text-[#1F1D1B]">
              By the Numbers
            </p>
            <dl className="mt-2 space-y-1">
              {articles.map((a) => (
                <div key={a.key} className="flex items-baseline justify-between gap-2 text-[12px]">
                  <dt className="truncate text-[#6B7280]">{a.desk}</dt>
                  <dd className="shrink-0 font-bold tabular-nums text-[#1F1D1B]">{a.count}</dd>
                </div>
              ))}
              <div className="mt-1 flex items-baseline justify-between border-t border-[#1F1D1B] pt-1 text-[13px]">
                <dt className="font-serif font-bold text-[#1F1D1B]">Total Stories</dt>
                <dd className="font-black tabular-nums text-[#9A3A2D]">{counts.total}</dd>
              </div>
            </dl>
          </aside>
        </div>
      )}

      {/* Secondary articles — newspaper columns */}
      {articles.length > 1 && (
        <div className="columns-1 gap-6 sm:columns-2 lg:columns-3 [&>*]:mb-6 [&>*]:break-inside-avoid">
          {articles.slice(1).map((a) => (
            <article key={a.key} className="break-inside-avoid border-t-2 border-[#1F1D1B] pt-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#9A3A2D]">{a.desk}</p>
              <h3 className="mt-0.5 font-serif text-lg font-bold leading-tight text-[#1F1D1B]">{a.headline}</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-[#4B463F]">{a.lead}</p>
              <ArticleRecords records={a.records} total={a.total} moreTo={a.moreTo} />
            </article>
          ))}
        </div>
      )}

      {/* ── The full record (original detailed tables below) ──────── */}
      <div className="flex items-center gap-3 pt-2">
        <div className="h-px flex-1 bg-[#1F1D1B]" />
        <span className="font-serif text-xs font-bold uppercase tracking-[0.18em] text-[#6B7280]">
          The Full Record
        </span>
        <div className="h-px flex-1 bg-[#1F1D1B]" />
      </div>

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSaved={() => refresh()}
        />
      )}

      {/* Count strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <CountTile
          label="Total Issues"
          value={counts.total}
          icon={ClipboardCheck}
          highlight
        />
        <CountTile
          label="DO Pending Dispatch"
          value={counts.doPendingDispatch}
          icon={Truck}
          active={openKey === "doPendingDispatch"}
          onClick={() => toggleKey("doPendingDispatch")}
        />
        <CountTile
          label="DO Not Delivered"
          value={counts.doNotDelivered}
          icon={PackageCheck}
          active={openKey === "doNotDelivered"}
          onClick={() => toggleKey("doNotDelivered")}
        />
        <CountTile
          label="DO Not Invoiced"
          value={counts.doNotInvoiced}
          icon={FileText}
          active={openKey === "doNotInvoiced"}
          onClick={() => toggleKey("doNotInvoiced")}
        />
        <CountTile
          label="SO Without DO"
          value={counts.soNoDo}
          icon={ShoppingCart}
          active={openKey === "soNoDo"}
          onClick={() => toggleKey("soNoDo")}
        />
        <CountTile
          label="SO Without Invoice"
          value={counts.soNoInvoice}
          icon={Receipt}
          active={openKey === "soNoInvoice"}
          onClick={() => toggleKey("soNoInvoice")}
        />
        <CountTile
          label="Overdue Orders"
          value={counts.overdueOrders}
          icon={CalendarClock}
          active={openKey === "overdueOrders"}
          onClick={() => toggleKey("overdueOrders")}
        />
        <CountTile
          label="PO Not Received"
          value={counts.poNotReceived}
          icon={PackageX}
          active={openKey === "poNotReceived"}
          onClick={() => toggleKey("poNotReceived")}
        />
        <CountTile
          label="Low-Efficiency Workers"
          value={counts.lowEfficiencyWorkers}
          icon={Users}
          active={openKey === "lowEfficiencyWorkers"}
          onClick={() => toggleKey("lowEfficiencyWorkers")}
        />
        <CountTile
          label="Process Skips"
          value={counts.processSkips}
          icon={GitBranch}
          active={openKey === "processSkips"}
          onClick={() => toggleKey("processSkips")}
        />
        <CountTile
          label="Missing WIP Times"
          value={counts.missingWipTimes}
          icon={Timer}
          active={openKey === "missingWipTimes"}
          onClick={() => toggleKey("missingWipTimes")}
        />
        <CountTile
          label="Incomplete BOMs"
          value={counts.incompleteBoms}
          icon={Layers}
          active={openKey === "incompleteBoms"}
          onClick={() => toggleKey("incompleteBoms")}
        />
        <CountTile
          label="R&D Stalled"
          value={counts.rdStalled}
          icon={FlaskConical}
          active={openKey === "rdStalled"}
          onClick={() => toggleKey("rdStalled")}
        />
      </div>

      {/* All-clear banner */}
      {counts.total === 0 && (
        <Card className="rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] bg-[#F7FBF8] border-[#DCF1E3]">
          <CardContent className="p-6 flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-[#15803D] shrink-0" />
            <div>
              <p className="text-sm font-semibold text-[#15803D]">
                All clear — nothing flagged today.
              </p>
              <p className="text-xs text-[#15803D]/80">
                Every delivery, invoice, and purchase order is on track.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Drilled-in detail — only the one open category renders here. The cards
          grid above stays visible as the navigation. */}
      {openKey && (
        <div ref={detailRef} className="space-y-4 scroll-mt-24">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpenKey(null)}
            className="shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to overview
          </Button>

        {/* DO pending dispatch */}
        {openKey === "doPendingDispatch" && (
        <Section
          id={SECTION_IDS.doPendingDispatch}
          title="Deliveries Pending Dispatch"
          subtitle="DOs still in draft for more than 1 day — load them onto a truck."
          count={counts.doPendingDispatch}
          icon={Truck}
        >
          {groups.doPendingDispatch.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>DO No.</Th>
                    <Th>Customer</Th>
                    <Th>Created</Th>
                    <Th right>Waiting</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.doPendingDispatch.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/delivery" label={r.doNo || "—"} />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{formatDate(r.createdAt)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysWaiting} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* DO not delivered */}
        {openKey === "doNotDelivered" && (
        <Section
          id={SECTION_IDS.doNotDelivered}
          title="Dispatched But Not Delivered"
          subtitle="On the road for more than 1 day with no delivery confirmation."
          count={counts.doNotDelivered}
          icon={PackageCheck}
        >
          {groups.doNotDelivered.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>DO No.</Th>
                    <Th>Customer</Th>
                    <Th>Dispatched</Th>
                    <Th right>Since</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.doNotDelivered.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/delivery" label={r.doNo || "—"} />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{formatDate(r.dispatchedAt)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysSinceDispatch} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* DO not invoiced */}
        {openKey === "doNotInvoiced" && (
        <Section
          id={SECTION_IDS.doNotInvoiced}
          title="Delivered But Not Invoiced"
          subtitle="Delivered more than 1 day ago with no invoice raised — bill the customer."
          count={counts.doNotInvoiced}
          icon={FileText}
        >
          {groups.doNotInvoiced.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>DO No.</Th>
                    <Th>Customer</Th>
                    <Th>Delivered</Th>
                    <Th right>Since</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.doNotInvoiced.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/delivery" label={r.doNo || "—"} />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{formatDate(r.deliveredAt)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysSinceDelivered} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* SO without DO */}
        {openKey === "soNoDo" && (
        <Section
          id={SECTION_IDS.soNoDo}
          title="Sales Orders Without a Delivery Order"
          subtitle="Confirmed / ready-to-ship orders that have no delivery order yet."
          count={counts.soNoDo}
          icon={ShoppingCart}
        >
          {groups.soNoDo.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO No.</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                    <Th right>Waiting</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.soNoDo.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/sales/${r.id}`}
                          label={r.companySOId || "—"}
                        />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                      <Td right>
                        {typeof r.days === "number" ? (
                          <DaysBadge days={r.days} />
                        ) : (
                          "—"
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* SO without invoice */}
        {openKey === "soNoInvoice" && (
        <Section
          id={SECTION_IDS.soNoInvoice}
          title="Sales Orders Without an Invoice"
          subtitle="Delivered / closed orders with no invoice on record."
          count={counts.soNoInvoice}
          icon={Receipt}
        >
          {groups.soNoInvoice.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO No.</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                    <Th right>Since</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.soNoInvoice.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/sales/${r.id}`}
                          label={r.companySOId || "—"}
                        />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                      <Td right>
                        {typeof r.days === "number" ? (
                          <DaysBadge days={r.days} />
                        ) : (
                          "—"
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* Overdue orders */}
        {openKey === "overdueOrders" && (
        <Section
          id={SECTION_IDS.overdueOrders}
          title="Overdue Orders"
          subtitle="Sales orders past their customer delivery date and not yet finished."
          count={counts.overdueOrders}
          icon={CalendarClock}
        >
          {groups.overdueOrders.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO No.</Th>
                    <Th>Customer</Th>
                    <Th>Products</Th>
                    <Th right>Qty</Th>
                    <Th>Customer DD</Th>
                    <Th right>Value</Th>
                    <Th right>Overdue</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.overdueOrders.map((r) => (
                    <tr key={r.salesOrderId} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/sales/${r.salesOrderId}`}
                          label={r.companySOId || "—"}
                        />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{r.productSummary || "—"}</Td>
                      <Td right>{r.totalQty || "—"}</Td>
                      <Td>{formatDate(r.customerDeliveryDate)}</Td>
                      <Td right>{formatRM(r.totalSen)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysOverdue} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* PO not received */}
        {openKey === "poNotReceived" && (
        <Section
          id={SECTION_IDS.poNotReceived}
          title="Purchase Orders Not Received"
          subtitle="Open for more than 14 days with no goods receipt or purchase invoice."
          count={counts.poNotReceived}
          icon={PackageX}
        >
          {groups.poNotReceived.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>PO No.</Th>
                    <Th>Supplier</Th>
                    <Th>Status</Th>
                    <Th>Ordered</Th>
                    <Th right>Open</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.poNotReceived.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/procurement/${r.id}`}
                          label={r.poNo || "—"}
                        />
                      </Td>
                      <Td>{r.supplierName || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                      <Td>{formatDate(r.orderDate)}</Td>
                      <Td right>
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <DaysBadge days={r.daysOpen} />
                          {typeof r.expectedOverdueDays === "number" &&
                          r.expectedOverdueDays > 0 ? (
                            <span
                              className="inline-flex items-center rounded-full border border-[#FCA5A5] bg-[#FEE2E2] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[#B91C1C]"
                              title="Days past the expected delivery date"
                            >
                              Overdue {r.expectedOverdueDays}d
                            </span>
                          ) : null}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* Low-efficiency workers */}
        {openKey === "lowEfficiencyWorkers" && (
        <Section
          id={SECTION_IDS.lowEfficiencyWorkers}
          title="Low-Efficiency Workers"
          subtitle="Below 60% efficiency yesterday (production time ÷ clocked time)."
          count={counts.lowEfficiencyWorkers}
          icon={Users}
        >
          {groups.lowEfficiencyWorkers.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>Emp No.</Th>
                    <Th>Name</Th>
                    <Th>Department</Th>
                    <Th right>Jobs</Th>
                    <Th right>Efficiency</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.lowEfficiencyWorkers.map((r) => (
                    <tr key={r.empNo + r.name} className="border-b border-[#F0ECE6]">
                      <Td>{r.empNo || "—"}</Td>
                      <Td strong>
                        <RecordLink to="/employees" label={r.name || "—"} />
                      </Td>
                      <Td>{r.departmentName || "—"}</Td>
                      <Td right>{r.jobsCompleted}</Td>
                      <Td right>
                        <EffBadge pct={r.efficiencyPct} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* Process skips — production out-of-sequence */}
        {openKey === "processSkips" && (
        <Section
          id={SECTION_IDS.processSkips}
          title="Production Out of Sequence"
          subtitle="A later step is finished while an earlier step in the same branch is not — check the order of work."
          count={counts.processSkips}
          icon={GitBranch}
        >
          {groups.processSkips.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO / PO No.</Th>
                    <Th>Product</Th>
                    <Th>Finished Step</Th>
                    <Th>Finished On</Th>
                    <Th>Still Waiting On</Th>
                    <Th right>Idle</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.processSkips.map((r) => (
                    <tr
                      key={r.productionOrderId + r.doneDept}
                      className="border-b border-[#F0ECE6]"
                    >
                      <Td strong>
                        <RecordLink
                          to={r.salesOrderId ? `/sales/${r.salesOrderId}` : "/production"}
                          label={r.companySOId || r.poNo || "—"}
                        />
                      </Td>
                      <Td>{r.productName || "—"}</Td>
                      <Td>{r.doneDept || "—"}</Td>
                      <Td>{formatDate(r.doneDeptCompletedDate)}</Td>
                      <Td>
                        {r.blockedByDept || "—"}
                        {r.blockedByStatus ? (
                          <span className="ml-1 text-[11px] text-[#9CA3AF]">
                            ({r.blockedByStatus})
                          </span>
                        ) : null}
                      </Td>
                      <Td right>
                        {typeof r.days === "number" ? (
                          <DaysBadge days={r.days} />
                        ) : (
                          "—"
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* BOM / WIP gaps — missing WIP times + incomplete BOMs */}
        {openKey === "missingWipTimes" && (
        <Section
          id={SECTION_IDS.missingWipTimes}
          title="Missing WIP Times"
          subtitle="Products in production with no standard time set for a step — workers and scheduling have nothing to plan against."
          count={counts.missingWipTimes}
          icon={Timer}
        >
          {groups.missingWipTimes.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>Product Code</Th>
                    <Th>Product</Th>
                    <Th>Step</Th>
                    <Th>Example PO</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.missingWipTimes.map((r) => (
                    <tr
                      key={r.productCode + r.departmentCode}
                      className="border-b border-[#F0ECE6]"
                    >
                      <Td strong>
                        <RecordLink to="/products" label={r.productCode || "—"} />
                      </Td>
                      <Td>{r.productName || "—"}</Td>
                      <Td>{r.departmentCode || "—"}</Td>
                      <Td>{r.examplePoNo || "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {openKey === "incompleteBoms" && (
        <Section
          id={SECTION_IDS.incompleteBoms}
          title="Incomplete BOMs"
          subtitle="Products in production with no active bill of materials — costing and material planning cannot run."
          count={counts.incompleteBoms}
          icon={Layers}
        >
          {groups.incompleteBoms.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>Product Code</Th>
                    <Th>Product</Th>
                    <Th>Issue</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.incompleteBoms.map((r) => (
                    <tr key={r.productCode} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/products" label={r.productCode || "—"} />
                      </Td>
                      <Td>{r.productName || "—"}</Td>
                      <Td>{r.reason || "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}

        {/* R&D stalled */}
        {openKey === "rdStalled" && (
        <Section
          id={SECTION_IDS.rdStalled}
          title="R&D Projects Stalled"
          subtitle="Active projects past their target launch date, or projects on hold — they need a push or a decision."
          count={counts.rdStalled}
          icon={FlaskConical}
        >
          {groups.rdStalled.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>Project</Th>
                    <Th>Stage</Th>
                    <Th>Status</Th>
                    <Th>Target Launch</Th>
                    <Th right>Overdue</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.rdStalled.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to={`/rd/${r.id}`} label={r.name || "—"} />
                      </Td>
                      <Td>{r.currentStage || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                      <Td>
                        {r.targetLaunchDate ? formatDate(r.targetLaunchDate) : "—"}
                      </Td>
                      <Td right>
                        {r.daysOverdue > 0 ? <DaysBadge days={r.daysOverdue} /> : "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        )}
        </div>
      )}

      <div className="flex justify-end">
        <Link to="/dashboard">
          <Button variant="outline" size="sm">
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
