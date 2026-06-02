// ===========================================================================
// Daily Report — newspaper-style process / SOP exceptions page.
//
// Reads /api/reports/compliance.json (see src/api/lib/compliance-report.ts)
// and lays out a top count strip + one section card per exception group, each
// with a compact table of the offending records linking back to the source.
// Plain tables / lists (NOT the DataGrid component). English only.
// ===========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
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
  counts: {
    total: number;
    doPendingDispatch: number;
    doNotDelivered: number;
    doNotInvoiced: number;
    soNoDo: number;
    soNoInvoice: number;
    overdueOrders: number;
    poNotReceived: number;
    lowEfficiencyWorkers: number;
    processSkips: number;
    missingWipTimes: number;
    incompleteBoms: number;
    rdStalled: number;
  };
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
  value: number;
  icon: React.ElementType;
  highlight?: boolean;
  // True when this tile's detail is the one currently open — draws a ring so
  // the operator can see which category is expanded.
  active?: boolean;
  // When provided AND value > 0 the tile becomes a drill-in button that
  // reveals its detail section. Zero-count tiles are inert.
  onClick?: () => void;
}) {
  const clear = value === 0;
  const interactive = !highlight && !clear && !!onClick;

  // Severity escalation for non-zero, non-total tiles: the bigger the backlog,
  // the louder the tile. Keeps "needs attention" weighting obvious at a glance.
  const sev = highlight
    ? null
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
      : clear
        ? "text-[#15803D]"
        : sev === "red"
          ? "text-[#B91C1C]"
          : sev === "orange"
            ? "text-[#C2410C]"
            : "text-[#A16207]";

  const iconColor = highlight
    ? "text-[#C9A24B]"
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
          {value}
        </p>
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
  count: number;
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
        {count > 0 ? (
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

export default function DailyReportPage() {
  const { data: raw, loading, refresh } =
    useCachedJson<ComplianceResp>("/api/reports/compliance.json");

  const data = useMemo<ComplianceData | null>(() => {
    if (!raw) return null;
    return raw.data ?? null;
  }, [raw]);

  // Drill-in: which one category's detail is open (null = cards-only overview).
  const [openKey, setOpenKey] = useState<SectionKey | null>(null);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Daily Report</h1>
          <p className="text-xs text-[#6B7280]">
            Process &amp; SOP exceptions — what needs attention today
          </p>
          <p className="text-[11px] text-[#9CA3AF] mt-1">
            {formatDateLong(data.today)} · Hookka Manufacturing ERP
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSettingsOpen(true)}
          className="shrink-0"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Button>
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
