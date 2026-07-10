import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { humanizeError } from "@/lib/humanize-error";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { countElapsedWorkingDays } from "@/lib/labor-engine";
import { computeAttendanceDay, hhmmToMinutes, type AttendanceRules } from "@/lib/attendance-rules";
import { getQRCodeDataURL } from "@/lib/qr-utils";
import { appOrigin } from "@/lib/app-origin";
import {
  resolvePayRulesAsOf,
  toAttendanceRules,
  payrollDayRateSen,
  payrollHourDivisor,
  DEFAULT_PAY_RULES,
  minToHhmm,
  type PayRuleVersion,
  type PayRulesConfig,
} from "@/lib/pay-rules";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDate, formatDateDMY, formatHours, formatRM, roundSen, distributeRoundSen, todayYmdMY } from "@/lib/utils";
import { printReport, type PrintColumn, type PrintCard, type PrintSection } from "@/lib/print-report";
import { asArray } from "@/lib/safe-json";
import {
  Users,
  UserCheck,
  Clock,
  Activity,
  Plus,
  Pencil,
  Trash2,
  Save,
  X,
  Search,
  CalendarDays,
  DollarSign,
  FileText,
  Check,
  XCircle,
  Filter,
  Download,
  Printer,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Eye,
  KeyRound,
  Copy,
} from "lucide-react";

// --------------- TYPES ---------------

type AttendanceStatus =
  | "PRESENT"
  | "ABSENT"
  | "HALF_DAY"
  | "MEDICAL_LEAVE"
  | "ANNUAL_LEAVE"
  | "REST_DAY";

type AttendanceRecord = {
  id: string;
  employeeId: string;
  employeeName: string;
  departmentCode: string;
  departmentName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: AttendanceStatus;
  workingMinutes: number;
  productionTimeMinutes: number;
  efficiencyPct: number;
  overtimeMinutes: number;
  deptBreakdown: { deptCode: string; minutes: number; productCode: string }[];
  notes: string;
};

type Worker = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string;
  departmentCode: string;
  /** Multi-dept support — full set of department codes assigned to this worker. */
  departmentCodes?: string[];
  /** Production categories the worker covers ("SOFA" / "BEDFRAME"). Empty = all. */
  categories?: string[];
  position: string;
  phone: string;
  status: string;
  /** Resignation date (YYYY-MM-DD); "" when not resigned. */
  resignedAt?: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier?: number;
  /** Per-worker statutory toggles (migration 0131). Default true — when
   *  false the matching deduction is zeroed on the payslip. */
  epfEnabled?: boolean;
  socsoEnabled?: boolean;
  eisEnabled?: boolean;
  pcbEnabled?: boolean;
  joinDate: string;
  icNumber: string;
  passportNumber: string;
  nationality: string;
  /** Per-worker efficiency bonus config (migration 0151). efficiencyAllowanceSen
   *  = bonus in sen paid when efficiency over the period >= threshold. */
  efficiencyAllowanceSen?: number;
  efficiencyThresholdPct?: number;
};

// Day-typed OT for the COST side — mirrors the engine so logged labor cost
// values Sunday / public-holiday OT the SAME way payroll pays it. Multipliers
// come from the EFFECTIVE-DATED pay rules (owner 2026-06-11): the rules in
// force ON the logged date; no versions → defaults (2× / 3×).
// Classify a logged day → its OT hours + multiplier:
//   • Sunday         → every logged hour is OT (rest-day premium).
//   • public holiday → every logged hour is OT.
//   • weekday        → only hours above the standard day, at the worker's mult.
// A holiday that falls on a Sunday is treated as a Sunday (Sunday checked first).
function dayTypedOt(
  date: string,
  holidays: readonly string[],
  totalH: number,
  stdHours: number,
  weekdayMult: number,
  payRuleVersions?: PayRuleVersion[],
): { otHours: number; mult: number } {
  const [yy, mm, dd] = date.split("-").map(Number);
  const dow = new Date(yy, (mm || 1) - 1, dd || 1).getDay();
  const cfg = resolvePayRulesAsOf(payRuleVersions, date);
  if (dow === 0) return { otHours: totalH, mult: cfg.sundayOtMultiplier };
  if (holidays.includes(date))
    return { otHours: totalH, mult: cfg.holidayOtMultiplier };
  return { otHours: Math.max(0, totalH - stdHours), mult: weekdayMult };
}
// Hourly-rate divisor: imported `payrollHourDivisor` from pay-rules — the
// SAME implementation the engine uses, so the recon bridges price docks
// exactly like pay (mode-aware: hours+lunch / hours-only / fixed).
// Shared fetch of the effective-dated pay-rule versions (cached).
function usePayRuleVersions(): PayRuleVersion[] {
  const { data } = useCachedJson<{ data?: { versions?: PayRuleVersion[] } }>(
    "/api/pay-rules",
  );
  return useMemo(() => data?.data?.versions ?? [], [data]);
}
type PayslipData = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  departmentCode: string;
  period: string;
  basicSalary: number;
  workingDays: number;
  absentDays: number;
  absenceDeductionSen: number;
  otWeekdayHours: number;
  otSundayHours: number;
  otPHHours: number;
  hourlyRate: number;
  otWeekdayAmount: number;
  otSundayAmount: number;
  otPHAmount: number;
  totalOT: number;
  allowances: number;
  grossPay: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  totalDeductions: number;
  netPay: number;
  bankAccount: string;
  status: "DRAFT" | "APPROVED" | "PAID";
  // Additive per-day detail surfaced by the payslips API (display only — no
  // amount math). Lets the expanded Payroll row list WHICH days were absent and
  // which had overtime. Optional so a stale response shape stays safe.
  absentDates?: string[];
  otDays?: Array<{ date: string; hours: number }>;
  shortHourDeductionSen?: number;
  lateDays?: Array<{ date: string; hours: number }>;
};

type LeaveRecord = {
  id: string;
  workerId: string;
  workerName: string;
  type: "ANNUAL" | "MEDICAL" | "UNPAID" | "EMERGENCY" | "PUBLIC_HOLIDAY";
  startDate: string;
  endDate: string;
  days: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string;
  approvedBy?: string;
};

// --------------- HELPERS ---------------

// formatHours moved to src/lib/utils.ts so other pages (Planning's
// Efficiency Overview etc.) can share the same "8h 30m" canonical
// display without re-implementing.

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// Local (Malaysia, UTC+8) calendar date "YYYY-MM-DD". toISOString() above is in
// UTC, which can name "yesterday" between 00:00–08:00 MYT. The Today quick-preset
// must land on the operator's actual local date, so build it from local parts.
function todayLocalStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Inclusive [from, to] for the last `days` calendar days ending today (local).
// last 7 days = today−6 .. today.
function lastNDaysRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(from), to: fmt(to) };
}

// First/last day of the current (offset 0) or previous (offset -1) calendar
// month, local. Used by the This-month / Last-month quick presets.
function calendarMonthRange(offsetMonths: number): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + offsetMonths; // JS handles negative / overflow
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(first), to: fmt(last) };
}

// Full month names, module-scope so references stay stable across renders
// (used by the Payroll month label + its Print Report filter line).
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

// Compact "DD MMM" date label (e.g. "03 Jun") for the Payroll day-detail list.
// Parses the ISO date as local — these are calendar dates with no time/zone
// meaning, so building from the Y/M/D parts avoids any UTC off-by-one.
function formatDayMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const monthShort = MONTH_NAMES[Number(m[2]) - 1]?.slice(0, 3) ?? m[2];
  return `${m[3]} ${monthShort}`;
}

// Each tab on this page has its own from/to date filter. Persisting the
// operator's last selection in localStorage — keyed per tab — means they can
// flip between tabs without re-picking the same range, AND when they reopen
// the page the date <input/> calendar pops open on the month they actually
// care about (instead of jumping 30 days back into the previous month).
// Returns null/undefined fields when nothing is stored or the JSON is
// malformed so the caller can fall back to today.
function readPersistedDateRange(key: string): { from?: string; to?: string } {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown };
    return {
      from: typeof parsed.from === "string" ? parsed.from : undefined,
      to: typeof parsed.to === "string" ? parsed.to : undefined,
    };
  } catch {
    return {};
  }
}

// Per-tab persisted date-range localStorage keys. The top summary follows the
// ACTIVE tab's range by reading its key on tab switch — keep in sync with each
// tab's writePersistedDateRange(...) key.
const SUMMARY_TAB_DATE_KEYS: Record<string, string> = {
  "working-hours": "employees:working-hours:dateRange",
  efficiency: "employees:efficiency-overview:dateRange",
  "department-labor": "employees:department-labor:dateRange",
  detail: "employees:employee-detail:dateRange",
  "department-performance": "employees:dept-perf:dateRange",
  "labor-cost": "employees:labor-cost:dateRange",
};

function writePersistedDateRange(key: string, from: string, to: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ from, to }));
  } catch {
    /* localStorage full / blocked — non-fatal, just lose persistence */
  }
}

// Human date-range label for the "Print Report" filter line. Single-day ranges
// collapse to one date; otherwise "DD/MM/YYYY – DD/MM/YYYY". Reuses the canonical
// DD/MM/YYYY formatter so the printed report matches the on-screen date pickers.
function dateRangeLabel(from: string, to: string): string {
  if (!from && !to) return "All dates";
  if (from === to) return formatDateDMY(from);
  return `${formatDateDMY(from)} – ${formatDateDMY(to)}`;
}

// Quote a CSV cell when it contains a comma, double-quote or newline. Empty /
// safe cells render as-is. Internal quotes are escaped by doubling per RFC
// 4180.
function csvCell(value: string): string {
  if (value == null) return "";
  const needsQuote = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}


// Lightweight projection of /api/departments for in-page use. Full Department
// type lives in src/types/index.ts; we only need these fields for dropdowns
// and the production/non-production routing logic.
type DepartmentLite = {
  id: string;
  code: string;
  name: string;
  shortName?: string;
  sequence?: number;
  color?: string;
  workingHoursPerDay?: number;
  isProduction: boolean;
};

// Fallback list — used while /api/departments hasn't loaded yet, so empty
// dropdowns don't flash on first render. Source of truth at runtime is the
// API; these match the migration 0061 + 0062 seed.
const SEED_DEPARTMENTS: DepartmentLite[] = [
  { id: "dept-1",  code: "FAB_CUT",              name: "Fabric Cutting",       isProduction: true },
  { id: "dept-2",  code: "FAB_SEW",              name: "Fabric Sewing",        isProduction: true },
  { id: "dept-3",  code: "WOOD_CUT",             name: "Wood Cutting",         isProduction: true },
  { id: "dept-4",  code: "FOAM",                 name: "Foam Bonding",         isProduction: true },
  { id: "dept-5",  code: "FRAMING",              name: "Framing",              isProduction: true },
  { id: "dept-6",  code: "WEBBING",              name: "Webbing",              isProduction: true },
  { id: "dept-7",  code: "UPHOLSTERY",           name: "Upholstery",           isProduction: true },
  { id: "dept-8",  code: "PACKING",              name: "Packing",              isProduction: true },
  { id: "dept-9",  code: "WAREHOUSING",          name: "Warehousing",          isProduction: false },
  { id: "dept-10", code: "REPAIR",               name: "Repair",               isProduction: false },
  { id: "dept-11", code: "MAINTENANCE",          name: "Maintenance",          isProduction: false },
  { id: "dept-12", code: "PRODUCTION_SHORTFALL", name: "Production Shortfall", isProduction: false },
  { id: "dept-13", code: "R_AND_D",              name: "R&D",                  isProduction: false },
];

// Legacy constants — kept for module-level references that don't have access
// to the dynamic departments prop yet (mostly inside tab components that
// haven't been wired through). Sized & shaped against SEED_DEPARTMENTS so
// the runtime defaults match the migration seed exactly.
const DEPARTMENTS = SEED_DEPARTMENTS.filter((d) => d.isProduction);
const ALL_DEPARTMENTS = SEED_DEPARTMENTS;
const PRODUCTION_DEPT_CODES = new Set(SEED_DEPARTMENTS.filter((d) => d.isProduction).map((d) => d.code));

const CATEGORIES = ["SOFA", "BEDFRAME", "ACCESSORY"] as const;
type Category = (typeof CATEGORIES)[number] | "";

type WorkingHourEntry = {
  id: string;
  attendanceId: string;
  workerId: string;
  date: string;
  departmentCode: string;
  category: Category;
  hours: number;
  notes: string;
};


// --------------- TAB COMPONENTS ---------------

// ========== TAB 1: WORKING HOURS — flat grid (Google Sheet style) ==========
//
// Each row is one working_hour_entries record: a single (date × worker × dept
// × category × hours × notes) tuple. The same worker can appear on any date
// any number of times — supervisor adds rows as the day's segments are
// recorded. Backend auto-creates the parent attendance_records row on first
// POST per (worker, date), so there's no separate clock-in step in this UI.

// Clickable column header used by the Working Hours table — shows the
// active sort indicator (↑ / ↓) when the column matches sortColumn,
// otherwise a faint dotted ↕ to advertise that the column is sortable.
function SortableHeader({
  label,
  column,
  sortColumn,
  sortDir,
  onClick,
  width,
}: {
  label: string;
  column: SortColumn;
  sortColumn: SortColumn | null;
  sortDir: SortDir;
  onClick: (col: SortColumn) => void;
  width?: string;
}) {
  const active = sortColumn === column;
  const arrow = !active ? "↕" : sortDir === "asc" ? "↑" : "↓";
  return (
    <th
      onClick={() => onClick(column)}
      className={`h-10 px-3 text-left font-medium cursor-pointer select-none transition-colors ${
        active ? "text-[#1F1D1B] bg-[#E5DED4]" : "text-[#374151] hover:bg-[#E5DED4]"
      } ${width ?? ""}`}
      title={`Sort by ${label}`}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        <span className={active ? "text-[#6B5C32]" : "text-[#9CA3AF]"}>{arrow}</span>
      </span>
    </th>
  );
}

type EntryDraft = {
  id?: string;                 // undefined = new draft; defined = persisted
  workerId: string;
  date: string;                // ISO YYYY-MM-DD; defaults to dateFrom for new rows
  departmentCode: string;
  category: Category;
  // number while editing; "" lets the operator CLEAR the cell so it stays blank
  // instead of snapping back to 0. Coerced to 0 on save and when summed.
  hours: number | "";
  notes: string;
  saving: boolean;
  saved: boolean;
  saveError?: string;
  // Optional punch times (HH:MM). When BOTH are set, the day's payable hours
  // (regular + OT) auto-fill `hours` via the confirmed attendance rules — so the
  // operator can key clock-in/out instead of computing hours by hand. Client-only
  // (not persisted): they recompute `hours`, which is what gets saved.
  clockIn?: string;
  clockOut?: string;
};

// Payable hours (regular + OT) from a clock-in/out pair, rounded to 2 dp; null
// when a time is missing / invalid / out-of-order (so we never clobber a
// hand-typed Hours value). The late/short SHORTFALL from these same punch times
// is auto-docked on save (saveRow → /auto-from-punch), guarded server-side; the
// owner can still Undo any AUTO dock in the under-recorded review.
function hoursFromPunch(
  clockIn?: string,
  clockOut?: string,
  rules?: AttendanceRules,
): number | null {
  const inM = hhmmToMinutes(clockIn ?? null);
  const outM = hhmmToMinutes(clockOut ?? null);
  if (inM === null || outM === null || outM <= inM) return null;
  const d = rules
    ? computeAttendanceDay(inM, outM, rules)
    : computeAttendanceDay(inM, outM);
  return Math.round(((d.regularWorkMin + d.otMin) / 60) * 100) / 100;
}

// Sortable columns. We keep the column key list small and tied to actual
// table columns — no kitchen-sink sort menu.
type SortColumn = "date" | "employee" | "department" | "category" | "hours";
type SortDir = "asc" | "desc";

// ===== Non-production hours: pending-approvals card (owner 2026-06-26) =====
//
// Workers apply for non-production hours from the phone (POST
// /api/worker/nonprod-requests). The office reviews PENDING requests here and
// Approves / Rejects them. On APPROVE the backend writes a normal
// working_hour_entries row for that worker / date / non-prod dept — which the
// efficiency denominator excludes (it counts only isProduction depts), so the
// worker's efficiency rises with NO formula change. Lives at the top of the
// Working Hours tab so the office sees pending requests right where it edits
// the hours grid.
type NonprodReq = {
  id: string;
  workerId: string;
  workerName: string;
  date: string;
  departmentCode: string;
  hours: number;
  note: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REMOVED";
  // Time-adjustment kind (owner 2026-06-26):
  //   NONPROD  — non-production hours; approving writes a non-prod hours row
  //              (excluded from the efficiency denominator).
  //   ADD_PROD — extra production time on a production dept; approving credits
  //              the hours to the efficiency numerator (no hours row written).
  kind?: "NONPROD" | "ADD_PROD";
  jobCardId?: string;
};

function NonprodApprovalsCard({
  departments,
  onApproved,
}: {
  departments: DepartmentLite[];
  onApproved: () => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [reqs, setReqs] = useState<NonprodReq[]>([]);
  const [approvedReqs, setApprovedReqs] = useState<NonprodReq[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const deptName = useCallback(
    (code: string) =>
      departments.find((d) => d.code === code)?.shortName ||
      departments.find((d) => d.code === code)?.name ||
      code,
    [departments],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // PENDING (Approve/Reject) + APPROVED (Remove) in one refresh so the
      // office can both decide new claims and delete a bad approved one.
      const [pRes, aRes] = await Promise.all([
        fetch("/api/working-hour-entries/nonprod-requests?status=PENDING"),
        fetch("/api/working-hour-entries/nonprod-requests?status=APPROVED"),
      ]);
      const pj = (await pRes.json()) as { success?: boolean; data?: NonprodReq[] };
      const aj = (await aRes.json()) as { success?: boolean; data?: NonprodReq[] };
      setReqs(Array.isArray(pj?.data) ? pj.data : []);
      setApprovedReqs(Array.isArray(aj?.data) ? aj.data : []);
    } catch {
      setReqs([]);
      setApprovedReqs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot mount fetch; setState lives inside the async refresh callback (stable useCallback) */
  useEffect(() => {
    void refresh();
  }, [refresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const decide = useCallback(
    async (id: string, action: "approve" | "reject" | "remove") => {
      setBusyId(id);
      try {
        const res = await fetch(
          `/api/working-hour-entries/nonprod-requests/${id}/${action}`,
          { method: "POST" },
        );
        const j = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !j?.success) {
          toast.error(j?.error || "Could not update the request");
          return;
        }
        toast.success(
          action === "approve"
            ? "Approved — hours added"
            : action === "remove"
              ? "Removed — adjustment reversed"
              : "Rejected",
        );
        await refresh();
        // Both approve and remove change the efficiency figures → recompute.
        if (action === "approve" || action === "remove") onApproved();
      } catch {
        toast.error("Could not update the request");
      } finally {
        setBusyId(null);
      }
    },
    [refresh, onApproved, toast],
  );

  // Owner 2026-06-27: delete a bad APPROVED adjustment (confirm first). The
  // backend reverses the split / un-credits the numerator before marking it
  // REMOVED.
  const removeApproved = useCallback(
    async (r: NonprodReq) => {
      const ok = await confirm({
        title: "Remove this approved adjustment?",
        message:
          r.kind === "ADD_PROD"
            ? "This un-credits the extra production time from efficiency. This cannot be undone."
            : "This deletes the approved non-production hours and adds the time back to that day's production hours. This cannot be undone.",
        confirmLabel: "Remove",
        tone: "danger",
      });
      if (!ok) return;
      await decide(r.id, "remove");
    },
    [confirm, decide],
  );

  // Hide the card entirely when there's nothing pending AND nothing approved
  // to manage (keeps the tab clean).
  if (!loading && reqs.length === 0 && approvedReqs.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-5 w-5 text-[#9C6F1E]" />
          Time adjustment requests
          {reqs.length > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#9C6F1E] px-1.5 text-[11px] font-bold text-white">
              {reqs.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {confirmDialog}
        {loading ? (
          <p className="text-sm text-[#8A8680]">Loading…</p>
        ) : (
          <div className="space-y-2">
            {reqs.map((r) => {
              // Owner 2026-06-27: workers enter/read MINUTES. Stored `hours`
              // × 60 = minutes; show "X min" under an hour, else "Xh Ym".
              const totalMin = Math.round((r.hours ?? 0) * 60);
              const hh = Math.floor(totalMin / 60);
              const mm = totalMin % 60;
              const durLabel =
                totalMin < 60
                  ? `${totalMin} min`
                  : mm === 0
                    ? `${hh}h`
                    : `${hh}h ${mm}min`;
              return (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {r.workerName} · {durLabel} · {deptName(r.departmentCode)}
                    <span
                      className={`ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                        r.kind === "ADD_PROD"
                          ? "bg-[#E4ECF5] text-[#2A5A8A]"
                          : "bg-[#F0ECE9] text-[#6B5C32]"
                      }`}
                    >
                      {r.kind === "ADD_PROD"
                        ? "Extra production time"
                        : "Non-production"}
                    </span>
                  </p>
                  <p className="text-xs text-[#8A8680]">
                    {r.date}
                    {r.kind === "ADD_PROD" && r.jobCardId
                      ? ` · Job: ${r.jobCardId}`
                      : ""}
                    {r.note ? ` — ${r.note}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void decide(r.id, "reject")}
                    disabled={busyId === r.id}
                    title="Reject this request"
                  >
                    <XCircle className="h-4 w-4 mr-1" /> Reject
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void decide(r.id, "approve")}
                    disabled={busyId === r.id}
                    title={
                      r.kind === "ADD_PROD"
                        ? "Approve — credits the extra production time to efficiency"
                        : "Approve — adds the non-production hours so efficiency stays fair"
                    }
                  >
                    <Check className="h-4 w-4 mr-1" />
                    {busyId === r.id ? "…" : "Approve"}
                  </Button>
                </div>
              </div>
              );
            })}

            {/* Approved adjustments — the office can REMOVE a bad one
                (e.g. a 20h ADD_PROD entered before the minutes fix). */}
            {approvedReqs.length > 0 && (
              <>
                <p className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-[#8A8680]">
                  Approved adjustments
                </p>
                {approvedReqs.map((r) => {
                  const totalMin = Math.round((r.hours ?? 0) * 60);
                  const hh = Math.floor(totalMin / 60);
                  const mm = totalMin % 60;
                  const durLabel =
                    totalMin < 60
                      ? `${totalMin} min`
                      : mm === 0
                        ? `${hh}h`
                        : `${hh}h ${mm}min`;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[#E2DDD8] bg-white px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {r.workerName} · {durLabel} · {deptName(r.departmentCode)}
                          <span
                            className={`ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                              r.kind === "ADD_PROD"
                                ? "bg-[#E4ECF5] text-[#2A5A8A]"
                                : "bg-[#F0ECE9] text-[#6B5C32]"
                            }`}
                          >
                            {r.kind === "ADD_PROD"
                              ? "Extra production time"
                              : "Non-production"}
                          </span>
                        </p>
                        <p className="text-xs text-[#8A8680]">
                          {r.date}
                          {r.kind === "ADD_PROD" && r.jobCardId
                            ? ` · Job: ${r.jobCardId}`
                            : ""}
                          {r.note ? ` — ${r.note}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void removeApproved(r)}
                          disabled={busyId === r.id}
                          title="Remove this approved adjustment (reverses it)"
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          {busyId === r.id ? "…" : "Remove"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkingHoursTab({
  workers,
  refreshAttendance,
  departments,
  productionDeptCodes,
  onDateChange,
}: {
  workers: Worker[];
  refreshAttendance: (date: string) => void;
  departments: DepartmentLite[];
  productionDeptCodes: Set<string>;
  // Reports this tab's selected date range up to EmployeesPage so the
  // page-level summary cards follow the operator's date pick.
  onDateChange?: (from: string, to: string) => void;
}) {
  // Fall back to seed if API hasn't loaded — avoids dropdown flash on first
  // render. After /api/departments resolves, the prop wins and any new
  // dept added via the Manage Departments UI on Labor Cost shows up here too.
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const prodCodes = productionDeptCodes.size > 0 ? productionDeptCodes : PRODUCTION_DEPT_CODES;
  const { confirm, confirmDialog } = useConfirm();
  // Each worker's "home" department from the Employee Master, used to DEFAULT
  // the attendance dept when a row has none — e.g. a phone punch that didn't
  // scan a department lands here with an empty dept. Wei Siang 2026-06-24:
  // "没有 scan 那个部门的话, 就根据他 Employee Master 那边 part under 什么部门的放进去".
  const homeDeptByWorker = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workers) m.set(w.id, w.departmentCode || "");
    return m;
  }, [workers]);
  // Effective-dated pay rules — punch→Hours uses the shift/grace/blocks in
  // force ON each row's date (no versions → built-in defaults).
  const payRuleVersions = usePayRuleVersions();
  const attRulesFor = useCallback(
    (d: string) => toAttendanceRules(resolvePayRulesAsOf(payRuleVersions, d)),
    [payRuleVersions],
  );
  // Date range — both default to today, so the page opens in single-day
  // mode (same view as before the range refactor). When dateFrom < dateTo
  // the table fetches every entry in the range, the table grows a Date
  // column, and new rows default their date to dateFrom (operator can
  // change per row). When dateFrom > dateTo we silently swap. Last
  // selection persists in localStorage so the operator returns to the
  // window they were last working on instead of being snapped back to
  // today every visit.
  const [dateFrom, setDateFrom] = useState<string>(() =>
    readPersistedDateRange("employees:working-hours:dateRange").from ?? todayStr()
  );
  const [dateTo, setDateTo] = useState<string>(() =>
    readPersistedDateRange("employees:working-hours:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("employees:working-hours:dateRange", dateFrom, dateTo);
    onDateChange?.(dateFrom, dateTo);
  }, [dateFrom, dateTo, onDateChange]);
  const isMultiDay = dateFrom !== dateTo;
  const [rows, setRows] = useState<EntryDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  // "Copy from" workflow — operator picks a source date, hits Copy, and
  // every entry from that date becomes a fresh DRAFT row on dateFrom. No
  // backend write yet — the rows land unsaved so the operator can
  // micro-adjust hours/notes and click Save All. Bulk-day copy mirrors
  // how a 100-worker payroll table would otherwise demand 100 individual
  // Add Row clicks.
  const [copyFromDate, setCopyFromDate] = useState<string>("");
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string>("");
  // Sort state — null sortColumn means "preserve insertion order" (new
  // rows added via Add Row / Copy from stay at the bottom). Click a
  // column header to set a sort; click again to flip direction; click a
  // third time to clear.
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Always use ?from=...&to=... — when from===to the route returns the
      // same single-day result it would've returned for ?date=. Cuts a
      // branch on the client and keeps multi-day fetch trivial.
      const lo = dateFrom <= dateTo ? dateFrom : dateTo;
      const hi = dateFrom <= dateTo ? dateTo : dateFrom;
      const res = await fetch(`/api/working-hour-entries?from=${lo}&to=${hi}`);
      const j = (await res.json()) as { success?: boolean; data?: WorkingHourEntry[] };
      const entries = j?.data ?? [];

      // Pull the same range's WORKER PHONE PUNCHES (attendance_records) so a
      // punch flows into this grid: it pre-fills the Punch (in/out) cell + lets
      // Hours auto-compute, and anyone who punched but has no Working Hours entry
      // yet is auto-added below. Best-effort — the grid still loads if this fails.
      const punchByKey = new Map<string, { clockIn?: string; clockOut?: string }>();
      try {
        const aRes = await fetch(`/api/attendance?from=${lo}&to=${hi}`);
        const aj = (await aRes.json()) as {
          data?: Array<{ employeeId?: string; date?: string; clockIn?: string | null; clockOut?: string | null }>;
        };
        for (const a of aj?.data ?? []) {
          if (!a.employeeId || !a.date) continue;
          if (a.clockIn || a.clockOut) {
            punchByKey.set(`${a.employeeId}|${a.date}`, {
              clockIn: a.clockIn ?? undefined,
              clockOut: a.clockOut ?? undefined,
            });
          }
        }
      } catch {
        /* attendance unavailable — grid works without the punch pre-fill */
      }

      const drafts: EntryDraft[] = entries.map((e) => {
        const punch = punchByKey.get(`${e.workerId}|${e.date}`);
        return {
          id: e.id,
          workerId: e.workerId,
          date: e.date,
          departmentCode: e.departmentCode,
          category: e.category,
          hours: e.hours, // keep the saved hours — do NOT overwrite a split from a punch
          notes: e.notes,
          saving: false,
          saved: true,
          clockIn: punch?.clockIn,
          clockOut: punch?.clockOut,
        };
      });

      // Auto-add a draft for each worker who PUNCHED but has no Working Hours
      // entry that day, so the punch shows up here with its in/out + computed
      // hours; the office just picks the department/category and saves.
      const haveEntry = new Set(entries.map((e) => `${e.workerId}|${e.date}`));
      for (const [key, punch] of punchByKey) {
        if (haveEntry.has(key)) continue;
        const sep = key.lastIndexOf("|");
        const wid = key.slice(0, sep);
        const date = key.slice(sep + 1);
        const h = hoursFromPunch(punch.clockIn, punch.clockOut, attRulesFor(date));
        drafts.push({
          workerId: wid,
          date,
          departmentCode: "",
          category: "",
          hours: h ?? 0,
          notes: "",
          saving: false,
          saved: false,
          clockIn: punch.clockIn,
          clockOut: punch.clockOut,
        });
      }

      setRows(drafts);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, attRulesFor]);

  // One-shot sync of server entries into local EntryDraft rows on date
  // change. setState here is intentional — the source is external (fetch).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);

  const patchRow = useCallback((idx: number, patch: Partial<EntryDraft>) => {
    setRows((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...patch };
      return copy;
    });
  }, []);

  const updateField = useCallback((idx: number, patch: Partial<EntryDraft>) => {
    setRows((prev) => {
      const copy = [...prev];
      const merged = { ...copy[idx], ...patch, saved: false, saveError: undefined };
      // Switching to non-production dept clears category.
      if (patch.departmentCode !== undefined && !prodCodes.has(patch.departmentCode)) {
        merged.category = "";
      }
      copy[idx] = merged;
      return copy;
    });
  }, [prodCodes]);

  const addRow = useCallback(() => {
    setRows((prev) => [
      ...prev,
      {
        workerId: "",
        date: dateFrom,
        departmentCode: "",
        category: "",
        hours: 0,
        notes: "",
        saving: false,
        saved: false,
      },
    ]);
  }, [dateFrom]);

  // Copy every entry from `copyFromDate` and append them as fresh DRAFT
  // rows on the currently-selected date. Skips workers that already have
  // a saved row on the current date so the operator doesn't end up with
  // duplicate entries per (worker, dept, date) tuple. Falls through with
  // a toast-equivalent error message into copyError state on failure.
  const copyFromSource = useCallback(async (sourceDate: string) => {
    setCopyError("");
    if (!sourceDate) {
      setCopyError("Pick a source date first");
      return;
    }
    if (sourceDate === dateFrom) {
      setCopyError("Source date can't equal target date");
      return;
    }
    setCopying(true);
    try {
      const res = await fetch(`/api/working-hour-entries?date=${sourceDate}`);
      const j = (await res.json()) as { success?: boolean; data?: WorkingHourEntry[] };
      const src = j?.data ?? [];
      if (src.length === 0) {
        setCopyError(`No entries on ${sourceDate} to copy`);
        setCopying(false);
        return;
      }
      // Dedup: skip a source row if the same (workerId, departmentCode,
      // category) tuple already exists on the target date (dateFrom) —
      // saved or not. Multiple segments per worker are allowed (operator
      // might legitimately have a saved Fab Cut row but want a copied
      // Upholstery row added).
      const existingKeys = new Set(
        rows
          .filter((r) => r.workerId && r.date === dateFrom)
          .map((r) => `${r.workerId}|${r.departmentCode}|${r.category}`),
      );
      const newDrafts: EntryDraft[] = src
        .filter((e) => !existingKeys.has(`${e.workerId}|${e.departmentCode}|${e.category}`))
        .map((e) => ({
          // No id — these are unsaved on the target date and will POST
          // when the operator clicks Save All. New rows always land on
          // dateFrom (the "left" of the range).
          workerId: e.workerId,
          date: dateFrom,
          departmentCode: e.departmentCode,
          category: e.category,
          hours: e.hours,
          notes: e.notes,
          saving: false,
          saved: false,
        }));
      if (newDrafts.length === 0) {
        setCopyError("All matching entries already exist on this date");
        setCopying(false);
        return;
      }
      setRows((prev) => [...prev, ...newDrafts]);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setCopying(false);
    }
  }, [dateFrom, rows]);

  // One-click "copy yesterday" — sets the source to the day before the working
  // date and runs the same copy. Saves the operator from picking a date every
  // morning (the #1 daily chore: re-entering each worker's dept/category/hours).
  const copyYesterday = useCallback(() => {
    const d = new Date(`${dateFrom}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    void copyFromSource(iso);
  }, [dateFrom, copyFromSource]);

  const duplicateRow = useCallback((idx: number) => {
    setRows((prev) => {
      const src = prev[idx];
      if (!src) return prev;
      const copy = [...prev];
      // Insert a new draft right after the source row, pre-filled with the
      // same worker AND date — common case is "same person on the same
      // day, different segment".
      copy.splice(idx + 1, 0, {
        workerId: src.workerId,
        date: src.date,
        departmentCode: "",
        category: "",
        hours: 0,
        notes: "",
        saving: false,
        saved: false,
      });
      return copy;
    });
  }, []);

  const removeRow = useCallback(async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    if (row.id) {
      // Persisted entry — ask before the destructive server DELETE.
      if (
        !(await confirm({
          title: "Delete this working-hour entry?",
          message: "This permanently removes the saved working-hour entry. This cannot be undone.",
          confirmLabel: "Delete",
          tone: "danger",
        }))
      ) {
        return;
      }
      // Persisted — DELETE on server first; pop from local state on success.
      try {
        const res = await fetch(`/api/working-hour-entries/${row.id}`, { method: "DELETE" });
        if (!res.ok) {
          patchRow(idx, { saveError: humanizeError({ status: res.status }, "Couldn't delete. Please try again.") });
          return;
        }
      } catch (e) {
        patchRow(idx, { saveError: humanizeError(e, "Couldn't delete. Please try again.") });
        return;
      }
    }
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }, [rows, patchRow, confirm]);

  const saveRow = useCallback(async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    // Effective dept: the picked dept, else the worker's Employee-Master home
    // dept. A phone punch with no dept scan lands here with an empty dept, so
    // we fall back to where the worker is "part under" instead of forcing a
    // manual pick (Wei Siang 2026-06-24).
    const effDept =
      row.departmentCode || homeDeptByWorker.get(row.workerId) || "";
    if (!row.workerId || !effDept) {
      patchRow(idx, { saveError: "Employee and department are required" });
      return;
    }
    if (prodCodes.has(effDept) && !row.category) {
      patchRow(idx, { saveError: "Production dept requires a category" });
      return;
    }
    patchRow(idx, { saving: true, saveError: undefined });
    try {
      const url = row.id
        ? `/api/working-hour-entries/${row.id}`
        : "/api/working-hour-entries";
      const method = row.id ? "PUT" : "POST";
      const body = row.id
        ? { departmentCode: effDept, category: row.category, hours: Number(row.hours) || 0, notes: row.notes }
        : {
            workerId: row.workerId,
            // Each row carries its own date — multi-day mode lets the
            // operator log e.g. Mon for one row and Tue for the next.
            date: row.date,
            departmentCode: effDept,
            category: row.category,
            hours: Number(row.hours) || 0,
            notes: row.notes,
          };
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { success?: boolean; data?: WorkingHourEntry; error?: string };
      if (!res.ok || !j.success || !j.data) {
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      patchRow(idx, {
        id: j.data.id,
        saving: false,
        saved: true,
      });
      // Auto-create on POST may have created an attendance row; refresh
      // the parent attendance list so any clock-in/out summary stays in sync.
      if (!row.id) refreshAttendance(row.date);
      // Office-keyed punch → auto short-hour dock (the SAME guarded rule the
      // worker phone punch uses). Only when BOTH clock times were keyed.
      // Fire-and-forget: docking is a separate concern from saving the hours,
      // and the server guards it (no clock-out → skip, finalised month → skip,
      // never overrides a manual dock). It must never block the hours save.
      if (row.clockIn && row.clockOut) {
        void fetch("/api/payroll-hour-deductions/auto-from-punch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workerId: row.workerId,
            date: row.date,
            clockIn: row.clockIn,
            clockOut: row.clockOut,
          }),
        })
          .then(() => {
            invalidateCachePrefix("/api/payroll-hour-deductions");
            invalidateCachePrefix("/api/payslips");
          })
          .catch(() => {
            /* best-effort — the hours are saved; a dock hiccup is non-fatal */
          });
      }
    } catch (e) {
      patchRow(idx, {
        saving: false,
        saveError: humanizeError(e, "Couldn't save. Please try again."),
      });
    }
  }, [rows, patchRow, refreshAttendance, prodCodes, homeDeptByWorker]);

  const saveAll = useCallback(async () => {
    setBulkSaving(true);
    const indices = rows
      .map((r, i) => ({ r, i }))
      .filter((x) => !x.r.saved && x.r.workerId && x.r.departmentCode)
      .map((x) => x.i);
    for (const i of indices) {
      // sequential; bulk parallel POSTs would race the auto-create
      // attendance helper for the same (worker, date) pair.
      await saveRow(i);
    }
    setBulkSaving(false);
  }, [rows, saveRow]);

  // Per-worker totals on this date — surfaces over/under for the day at a
  // glance so the supervisor can spot mis-attributed hours before saving.
  const workerTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.workerId) continue;
      m.set(r.workerId, (m.get(r.workerId) ?? 0) + (Number(r.hours) || 0));
    }
    return m;
  }, [rows]);

  const dirtyCount = rows.filter((r) => !r.saved && r.workerId).length;

  // Click a column header to sort the table by that column. The first
  // click sets ascending; clicking the same column again flips to
  // descending; a third click clears the sort and goes back to insertion
  // order (so newly-added rows stay at the bottom). Indices for editing
  // run through the sorted view — see displayRows below.
  const cycleSort = useCallback((col: SortColumn) => {
    if (sortColumn !== col) {
      setSortColumn(col);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    setSortColumn(null);
    setSortDir("asc");
  }, [sortColumn, sortDir]);

  // Pre-resolve worker names so the Employee sort is alphabetical by
  // displayed name rather than internal worker id.
  const workerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workers) m.set(w.id, w.name);
    return m;
  }, [workers]);

  // Sorted view: each item carries its original index so input handlers
  // patch the right row in `rows` even after a sort scrambles display
  // order. When sortColumn is null we keep insertion order.
  const displayRows = useMemo(() => {
    const indexed = rows.map((row, originalIdx) => ({ row, originalIdx }));
    if (!sortColumn) return indexed;
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: { row: EntryDraft }, b: { row: EntryDraft }) => {
      switch (sortColumn) {
        case "date":
          return (a.row.date || "").localeCompare(b.row.date || "") * dir;
        case "employee": {
          const an = workerNameById.get(a.row.workerId) ?? "";
          const bn = workerNameById.get(b.row.workerId) ?? "";
          return an.localeCompare(bn) * dir;
        }
        case "department":
          return (a.row.departmentCode || "").localeCompare(b.row.departmentCode || "") * dir;
        case "category":
          return (a.row.category || "").localeCompare(b.row.category || "") * dir;
        case "hours":
          return ((Number(a.row.hours) || 0) - (Number(b.row.hours) || 0)) * dir;
        default:
          return 0;
      }
    };
    return [...indexed].sort(cmp);
  }, [rows, sortColumn, sortDir, workerNameById]);

  // ── Column filters (Date / Employee / Department) ─────────────────────────
  // A busy daily grid is hard to fill when you can't find the row you want.
  // These filters narrow the VIEW only — they never change what's saved. An
  // empty, unsaved draft always stays visible so a freshly added row isn't
  // hidden while you're typing into it.
  const [fltEmployee, setFltEmployee] = useState("");
  const [fltDept, setFltDept] = useState("");
  const [fltDate, setFltDate] = useState("");
  const filtersActive = !!(fltEmployee.trim() || fltDept || fltDate);
  const clearFilters = useCallback(() => {
    setFltEmployee("");
    setFltDept("");
    setFltDate("");
  }, []);

  const filteredRows = useMemo(() => {
    if (!filtersActive) return displayRows;
    const fe = fltEmployee.trim().toLowerCase();
    return displayRows.filter(({ row }) => {
      if (!row.workerId && !row.id) return true; // keep blank drafts visible
      if (fe) {
        const name = (workerNameById.get(row.workerId) ?? "").toLowerCase();
        if (!name.includes(fe)) return false;
      }
      if (fltDept && row.departmentCode !== fltDept) return false;
      if (fltDate && row.date !== fltDate) return false;
      return true;
    });
  }, [displayRows, filtersActive, fltEmployee, fltDept, fltDate, workerNameById]);

  // Group the (filtered, sorted) rows by worker+date so a worker's several
  // department / category segments render under ONE employee cell — the name
  // shows once; dept / category / hours are the sub-rows beneath it. Empty
  // drafts each stand alone. Render-only: the flat `rows` array and every edit
  // handler (addressed by originalIdx) are unchanged, so pay math is untouched.
  const groupedRows = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { row: EntryDraft; originalIdx: number }[]>();
    for (const item of filteredRows) {
      const key = item.row.workerId
        ? `${item.row.workerId}||${item.row.date}`
        : `__new-${item.originalIdx}`;
      let g = map.get(key);
      if (!g) {
        g = [];
        map.set(key, g);
        order.push(key);
      }
      g.push(item);
    }
    return order.map((k) => ({ key: k, items: map.get(k)! }));
  }, [filteredRows]);

  // Print Report — prints exactly the on-screen rows (in current sort order)
  // for the selected working-date range. Mirrors the grid's columns; the Date
  // column is included only in multi-day mode, matching the table.
  const handlePrint = useCallback(() => {
    const deptNameById = new Map(allDepts.map((d) => [d.code, d.name] as const));
    const columns: PrintColumn[] = [];
    if (isMultiDay) {
      columns.push({ header: "Date", value: (r) => formatDateDMY((r as EntryDraft).date) });
    }
    columns.push(
      { header: "Employee", value: (r) => workerNameById.get((r as EntryDraft).workerId) ?? "—" },
      { header: "Department", value: (r) => deptNameById.get((r as EntryDraft).departmentCode) ?? (r as EntryDraft).departmentCode ?? "—" },
      { header: "Category", value: (r) => (r as EntryDraft).category || "—" },
      { header: "Hours", align: "right", value: (r) => `${(Number((r as EntryDraft).hours) || 0).toFixed(1)}h` },
      { header: "Notes", value: (r) => (r as EntryDraft).notes || "" },
    );
    const printableRows = filteredRows.filter((d) => d.row.workerId).map((d) => d.row);
    const totalHrs = printableRows.reduce((s, row) => s + (Number(row.hours) || 0), 0);
    const distinctWorkers = new Set(printableRows.map((row) => row.workerId)).size;
    const cards: PrintCard[] = [
      { label: "Total Hours", value: `${totalHrs.toFixed(1)}h` },
      { label: "Workers", value: String(distinctWorkers) },
      { label: "Entries", value: String(printableRows.length) },
    ];
    printReport({
      title: "Working Hours",
      filterSummary: dateRangeLabel(dateFrom, dateTo),
      orientation: "portrait",
      cards,
      sections: [{ columns, rows: printableRows }],
    });
  }, [allDepts, isMultiDay, workerNameById, dateFrom, dateTo, filteredRows]);

  return (
    <div className="space-y-4">
      {confirmDialog}
      <PublicHolidaysCard />
      <NonprodApprovalsCard departments={allDepts} onApproved={() => void refresh()} />
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-[#6B5C32]" /> Daily Working Hours
          </CardTitle>
          {/* Toolbar grouped into clusters (date range │ copy │ row actions)
              with subtle dividers, so the controls read at a glance instead of
              one long crowded row. */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Date range */}
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-[#6B7280]">
                <span>From</span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-36"
                  title="Start of working-date range — new rows default to this date"
                />
              </label>
              <span className="text-[#C9C2BA]">–</span>
              <label className="flex items-center gap-1.5 text-xs text-[#6B7280]">
                <span>To</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-36"
                  title="End of working-date range (inclusive). Set equal to From for single-day mode."
                />
              </label>
            </div>
            {/* Copy workflow — pull a source date's rows as editable drafts. */}
            <div className="flex items-center gap-2 border-l border-[#E2DDD8] pl-3">
              <label className="flex items-center gap-1.5 text-xs text-[#6B7280]">
                <span>Copy from</span>
                <Input
                  type="date"
                  value={copyFromDate}
                  onChange={(e) => setCopyFromDate(e.target.value)}
                  className="w-36"
                  title="Copy from — pick a source date whose entries will be cloned as drafts on the working date"
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyFromSource(copyFromDate)}
                disabled={copying || !copyFromDate}
                title="Copy every entry from the source date as drafts on the working date"
              >
                {copying ? "Copying…" : "Copy"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={copyYesterday}
                disabled={copying}
                title="One click: copy yesterday's department / category / hours for every worker as editable drafts"
              >
                {copying ? "Copying…" : "Copy yesterday"}
              </Button>
            </div>
            {/* Row actions */}
            <div className="flex items-center gap-2 border-l border-[#E2DDD8] pl-3">
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-4 w-4" /> Add Row
              </Button>
              <Button variant="primary" size="sm" onClick={saveAll} disabled={bulkSaving || dirtyCount === 0}>
                <Save className="h-4 w-4" />
                {bulkSaving ? "Saving…" : dirtyCount > 0 ? `Save All (${dirtyCount})` : "Saved"}
              </Button>
              <Button variant="outline" size="sm" onClick={handlePrint} title="Print the on-screen working hours for the selected date range">
                <Printer className="h-4 w-4 mr-1" /> Print
              </Button>
            </div>
          </div>
        </div>
        {copyError && (
          <div className="mt-2 text-xs text-[#9A3A2D]">{copyError}</div>
        )}
      </CardHeader>
      <CardContent>
        {/* Per-worker total chip strip — over 9h shows amber (OT zone). */}
        {workerTotals.size > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {Array.from(workerTotals.entries()).map(([wid, total]) => {
              const w = workers.find((x) => x.id === wid);
              if (!w) return null;
              const over = total > 9;
              return (
                <span
                  key={wid}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${
                    over ? "bg-[#FAEFCB] text-[#9C6F1E]" : "bg-[#EEF3E4] text-[#4F7C3A]"
                  }`}
                  title={over ? `${total.toFixed(1)}h — OT (>9h)` : `${total.toFixed(1)}h`}
                >
                  <span className="font-medium">{w.name}</span>
                  <span className="tabular-nums">{total.toFixed(1)}h</span>
                </span>
              );
            })}
          </div>
        )}
        {/* Column filters — narrow the grid to the rows you're filling. View
            only; nothing saved changes. */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[#6B7280]">Filter</span>
          {isMultiDay && (
            <Input
              type="date"
              value={fltDate}
              onChange={(e) => setFltDate(e.target.value)}
              className="h-8 w-36"
              title="Show only this working date"
            />
          )}
          <Input
            value={fltEmployee}
            onChange={(e) => setFltEmployee(e.target.value)}
            placeholder="Employee name…"
            className="h-8 w-44"
          />
          <select
            value={fltDept}
            onChange={(e) => setFltDept(e.target.value)}
            className="h-8 rounded border border-[#E2DDD8] bg-white px-2 text-xs"
            title="Show only this department"
          >
            <option value="">All departments</option>
            {allDepts.map((d) => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </select>
          {filtersActive && (
            <>
              <button
                type="button"
                onClick={clearFilters}
                className="rounded border border-[#D8D2CC] px-2 py-1 text-[#9A3A2D] hover:bg-[#F9E1DA]"
              >
                Clear
              </button>
              <span className="text-[#6B7280]">
                {groupedRows.length} {groupedRows.length === 1 ? "worker" : "workers"} shown
              </span>
            </>
          )}
        </div>
        <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                {/* Date column only renders in multi-day mode — single-day
                    keeps the original 6-column layout to avoid wasted width. */}
                {isMultiDay && (
                  <SortableHeader
                    label="Date"
                    column="date"
                    sortColumn={sortColumn}
                    sortDir={sortDir}
                    onClick={cycleSort}
                    width="w-32"
                  />
                )}
                <SortableHeader
                  label="Employee"
                  column="employee"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onClick={cycleSort}
                />
                <SortableHeader
                  label="Department"
                  column="department"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onClick={cycleSort}
                />
                <SortableHeader
                  label="Category"
                  column="category"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onClick={cycleSort}
                />
                <th
                  className="h-10 px-3 text-left font-medium text-[#374151] w-44"
                  title="Optional: key clock-in / clock-out and Hours auto-fills (regular + OT, Malaysia rules). Late past the 10-min grace / short of 9h is auto-deducted on save; you can Undo it in the under-recorded review."
                >
                  Punch (in / out)
                </th>
                <SortableHeader
                  label="Hours"
                  column="hours"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onClick={cycleSort}
                  width="w-24"
                />
                <th className="h-10 px-3 text-left font-medium text-[#374151]">Notes</th>
                <th className="h-10 px-3 text-left font-medium text-[#374151] w-44">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={isMultiDay ? 8 : 7} className="h-20 text-center text-[#9CA3AF]">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={isMultiDay ? 8 : 7} className="h-20 text-center text-[#9CA3AF]">
                    No entries for {isMultiDay ? `${dateFrom} → ${dateTo}` : dateFrom}. Click <span className="font-medium">+ Add Row</span> to start.
                  </td>
                </tr>
              )}
              {rows.length > 0 && groupedRows.length === 0 && (
                <tr>
                  <td colSpan={isMultiDay ? 8 : 7} className="h-16 text-center text-[#9CA3AF]">
                    No rows match the filter.{" "}
                    <button type="button" onClick={clearFilters} className="text-[#9A3A2D] underline">
                      Clear filter
                    </button>
                  </td>
                </tr>
              )}
              {groupedRows.flatMap((group) => {
                const first = group.items[0];
                const gWorkerId = first.row.workerId;
                const gWorker = gWorkerId ? workers.find((w) => w.id === gWorkerId) : undefined;
                // Standard payable day (this worker's, else 9h) — the yardstick
                // the daily total is flagged against.
                const std = gWorker && gWorker.workingHoursPerDay > 0 ? gWorker.workingHoursPerDay : 9;
                const gTotal = group.items.reduce((s, it) => s + (Number(it.row.hours) || 0), 0);
                const over = gTotal > std + 0.01;
                const short = !!gWorkerId && gTotal > 0.01 && gTotal < std - 0.01;
                const totalCls = over
                  ? "bg-[#FAEFCB] text-[#9C6F1E]"
                  : short
                    ? "bg-[#F6E0D3] text-[#9A5B2D]"
                    : "bg-[#EEF3E4] text-[#4F7C3A]";
                const span = group.items.length;
                return group.items.map((item, segIdx) => {
                  const { row, originalIdx } = item;
                  // Default the dept to the worker's Employee-Master home dept
                  // when the row has none (e.g. a phone punch with no dept
                  // scan). The dropdown shows it and Save persists it.
                  const effDept =
                    row.departmentCode ||
                    homeDeptByWorker.get(row.workerId) ||
                    "";
                  const isProd = prodCodes.has(effDept);
                  const firstSeg = segIdx === 0;
                  return (
                  <tr
                    key={row.id ?? `new-${originalIdx}`}
                    className={`hover:bg-[#FAF9F7] transition-colors ${
                      firstSeg ? "border-t-2 border-[#E2DDD8]" : "border-t border-[#F0ECE9]"
                    }`}
                  >
                    {/* Date + Employee render ONCE per worker-day group, spanning
                        the group's department/category sub-rows (the name shows
                        once; segments nest beneath it). */}
                    {isMultiDay && firstSeg && (
                      <td rowSpan={span} className="px-3 py-1.5 align-top border-r border-[#E2DDD8]">
                        <Input
                          type="date"
                          value={row.date}
                          onChange={(e) => {
                            const v = e.target.value;
                            group.items.forEach((it) => updateField(it.originalIdx, { date: v }));
                          }}
                          className="h-8 w-32 text-xs"
                        />
                      </td>
                    )}
                    {firstSeg && (
                      <td rowSpan={span} className="px-3 py-1.5 align-top border-r border-[#E2DDD8] min-w-[10rem]">
                        <select
                          value={row.workerId}
                          onChange={(e) => {
                            // Re-assign the WHOLE group (all of this worker's
                            // segments that day) to the picked worker.
                            const v = e.target.value;
                            group.items.forEach((it) => updateField(it.originalIdx, { workerId: v }));
                          }}
                          className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                        >
                          <option value="">— select worker —</option>
                          {workers
                            .filter((w) => w.status === "ACTIVE")
                            .map((w) => (
                              <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                        </select>
                        {gWorkerId && (
                          <div className="mt-1">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] tabular-nums ${totalCls}`}
                              title={
                                over
                                  ? `${gTotal.toFixed(1)}h total — over the ${std}h day (overtime)`
                                  : short
                                    ? `${gTotal.toFixed(1)}h total — UNDER the ${std}h day. Check this is right (e.g. after Copy yesterday onto a different day).`
                                    : `${gTotal.toFixed(1)}h total`
                              }
                            >
                              {gTotal.toFixed(1)}h{over ? " · OT" : short ? " · short" : ""}
                            </span>
                          </div>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-1.5">
                      <select
                        value={effDept}
                        onChange={(e) => updateField(originalIdx, { departmentCode: e.target.value })}
                        className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                      >
                        <option value="">— select dept —</option>
                        {allDepts.map((d) => (
                          <option key={d.code} value={d.code}>{d.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        value={row.category}
                        onChange={(e) => updateField(originalIdx, { category: e.target.value as Category })}
                        disabled={!isProd}
                        className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF]"
                        title={isProd ? "Production category" : "Non-production dept — no category"}
                      >
                        <option value="">{isProd ? "— select —" : "n/a"}</option>
                        {CATEGORIES.map((cat) => (
                          <option key={cat} value={cat}>{cat[0] + cat.slice(1).toLowerCase()}</option>
                        ))}
                      </select>
                    </td>
                    {/* Punch ONCE per worker/day — a person punches in/out once,
                        no matter how many departments their day splits across, so it
                        spans the group like Employee/Date (NOT repeated per dept row).
                        Drives the auto short-hour dock on save; auto-fills Hours only
                        for a single-department day (multi-dept → split hours yourself). */}
                    {firstSeg && (
                      <td rowSpan={span} className="px-3 py-1.5 align-top">
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="time"
                            value={first.row.clockIn ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              const single = group.items.length === 1;
                              const h = single ? hoursFromPunch(v, first.row.clockOut, attRulesFor(first.row.date)) : null;
                              group.items.forEach((it) =>
                                updateField(
                                  it.originalIdx,
                                  h !== null ? { clockIn: v, hours: h } : { clockIn: v },
                                ),
                              );
                            }}
                            className="h-8 w-[5rem] text-xs"
                            title="Clock in (HH:MM) — one punch per worker per day"
                          />
                          <span className="text-[#9CA3AF]">→</span>
                          <Input
                            type="time"
                            value={first.row.clockOut ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              const single = group.items.length === 1;
                              const h = single ? hoursFromPunch(first.row.clockIn, v, attRulesFor(first.row.date)) : null;
                              group.items.forEach((it) =>
                                updateField(
                                  it.originalIdx,
                                  h !== null ? { clockOut: v, hours: h } : { clockOut: v },
                                ),
                              );
                            }}
                            className="h-8 w-[5rem] text-xs"
                            title="Clock out — Hours auto-fills for a single-department day; for multiple depts, split the hours yourself"
                          />
                        </div>
                        {group.items.length > 1 && (
                          <p className="mt-1 text-[10px] leading-tight text-[#9CA3AF]">
                            Split the day&rsquo;s hours across the departments
                          </p>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-1.5">
                      <Input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        min={0}
                        step="any"
                        value={row.hours}
                        onChange={(e) => {
                          const v = e.target.value;
                          // Empty stays empty (no snap-to-0); otherwise parse it.
                          updateField(originalIdx, { hours: v === "" ? "" : Number(v) });
                        }}
                        className="h-8 w-20 text-xs"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        value={row.notes}
                        onChange={(e) => updateField(originalIdx, { notes: e.target.value })}
                        placeholder="e.g. PO-1234"
                        className="h-8 text-xs"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => saveRow(originalIdx)}
                          disabled={row.saving}
                          className={row.saved ? "border-[#C6DBA8] text-[#4F7C3A]" : ""}
                        >
                          {row.saving ? "…" : row.saved ? "Saved" : "Save"}
                        </Button>
                        <button
                          type="button"
                          onClick={() => duplicateRow(originalIdx)}
                          className="inline-flex items-center justify-center h-7 w-7 rounded text-[#6B5C32] hover:bg-[#F0ECE9]"
                          title="Duplicate (same worker, new segment)"
                          aria-label="Duplicate row"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeRow(originalIdx)}
                          className="inline-flex items-center justify-center h-7 w-7 rounded text-[#9A3A2D] hover:bg-[#F9E1DA]"
                          title={row.id ? "Delete entry" : "Discard draft"}
                          aria-label="Remove row"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {row.saveError && (
                        <div className="mt-1 text-xs text-[#9A3A2D]">{row.saveError}</div>
                      )}
                    </td>
                  </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}

// ========== Public Holidays panel ==========
//
// Stored in kv_config['public_holidays'] as a JSON array of YYYY-MM-DD
// strings. /api/worker/payslips reads this list and excludes the dates
// from the elapsed-workdays count, so a worker isn't charged an absent
// day for not coming on a public holiday. — Wei Siang 2026-05-10
function PublicHolidaysCard() {
  const [dates, setDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/kv-config/public_holidays");
      const j = (await r.json()) as { data?: unknown };
      const data = j?.data;
      if (Array.isArray(data)) {
        setDates(
          data
            .filter((d): d is string => typeof d === "string")
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
            .sort(),
        );
      } else {
        setDates([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot load on mount; the setState happens inside `load`'s try/finally, not a tight render loop */
  useEffect(() => {
    load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const save = useCallback(async (next: string[]) => {
    setSaving(true);
    try {
      const r = await fetch("/api/kv-config/public_holidays", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDates(next);
    } catch (e) {
      alert(humanizeError(e, "Couldn't save. Please try again."));
    } finally {
      setSaving(false);
    }
  }, []);

  const addOne = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(adding)) return;
    if (dates.includes(adding)) {
      setAdding("");
      return;
    }
    save([...dates, adding].sort()).then(() => setAdding(""));
  };

  const removeOne = async (d: string) => {
    if (
      !(await confirm({
        title: "Remove public holiday?",
        message: `Remove ${d} from public holidays? Workers may then be deducted for not working that day.`,
        confirmLabel: "Remove",
        tone: "danger",
      }))
    ) {
      return;
    }
    save(dates.filter((x) => x !== d));
  };

  return (
    <Card>
      {confirmDialog}
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          Public Holidays
        </CardTitle>
        <p className="text-xs text-[#6B7280] mt-1">
          Mark dates so workers aren't deducted for not working that day.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 mb-3">
          <Input
            type="date"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="w-44"
          />
          <Button
            variant="primary"
            onClick={addOne}
            disabled={!adding || saving}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {loading ? (
          <p className="text-sm text-[#6B7280]">Loading…</p>
        ) : dates.length === 0 ? (
          <p className="text-sm text-[#6B7280]">No public holidays set.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {dates.map((d) => (
              <span
                key={d}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#F0ECE9] border border-[#D8D2CC] text-sm"
              >
                <span className="tabular-nums">{d}</span>
                <button
                  type="button"
                  onClick={() => removeOne(d)}
                  disabled={saving}
                  className="text-[#9A3A2D] hover:text-[#7A2E24] font-bold leading-none"
                  title="Remove this date"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ========== TAB 2: EMPLOYEE MASTER ==========

type WorkerFormData = {
  empNo: string;
  name: string;
  departmentId: string;
  // Multi-department support — Wei Siang 2026-05-10. Operator Leaders (and
  // any worker who covers more than one production department) are tracked
  // here as the full set; departmentId stays as the worker's "primary" so
  // legacy single-dept lookups keep working.
  departmentCodes: string[];
  // Production categories — "SOFA" / "BEDFRAME". Empty array = no filter
  // (worker handles whatever). For Operator Leaders this scopes the Team
  // dashboard so a SOFA-only leader doesn't see BEDFRAME rows.
  categories: string[];
  position: string;
  phone: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number;
  // Statutory enable flags — POSTed/PUTed as booleans. Backend defaults
  // each to TRUE for new workers, so the form ships TRUE here too.
  epfEnabled: boolean;
  socsoEnabled: boolean;
  eisEnabled: boolean;
  pcbEnabled: boolean;
  joinDate: string;
  nationality: string;
  status: string;
  /** Resignation date (YYYY-MM-DD); "" when not resigned. */
  resignedAt: string;
  /** Efficiency bonus config — allowance in sen, threshold percent (0–100). */
  efficiencyAllowanceSen: number;
  efficiencyThresholdPct: number;
};

// Next Emp No = the highest existing EMP-### + 1, same prefix + zero-padding.
// "max of existing" means it adapts to changes — remove the last worker and it
// drops back, add one and it climbs. Non-conforming codes are ignored so a stray
// hand-typed value can't poison the sequence. The operator can still overtype it.
function nextEmpNo(workers: { empNo?: string | null }[]): string {
  const max = workers.reduce((m, w) => {
    const match = /^EMP-(\d+)$/.exec((w.empNo ?? "").trim());
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `EMP-${String(max + 1).padStart(3, "0")}`;
}

const emptyForm: WorkerFormData = {
  empNo: "",
  name: "",
  departmentId: "dept-1",
  departmentCodes: [],
  categories: [],
  position: "Operator",
  phone: "",
  basicSalarySen: 180000,
  workingHoursPerDay: 9,
  workingDaysPerMonth: 26,
  otMultiplier: 1.5,
  // New-worker default: statutory OFF (matches the prod reality where most
  // workers are not registered with EPF/SOCSO/EIS/PCB). Operator ticks the
  // Statutory column on the row of the workers who ARE registered.
  epfEnabled: false,
  socsoEnabled: false,
  eisEnabled: false,
  pcbEnabled: false,
  joinDate: todayStr(),
  nationality: "",
  status: "ACTIVE",
  resignedAt: "",
  efficiencyAllowanceSen: 0,
  efficiencyThresholdPct: 0,
};

// PIN-modal state. The single-worker dialog has two phases:
//   1. "configure"  — pick generate-random vs set-custom, then submit
//   2. "reveal"     — show the cleartext PIN once with a copy button
// The cleartext PIN is wiped from React state when the modal closes; the
// backend never returns it again on subsequent reads.
type PinModalPhase = "configure" | "reveal";

type PinModalState = {
  worker: Worker;
  phase: PinModalPhase;
  mode: "random" | "custom";
  customPin: string;
  submitting: boolean;
  error: string | null;
  revealedPin: string | null;
};

// Bulk-modal state — three phases:
//   1. "preview"    — show how many ACTIVE workers don't have a PIN yet
//   2. "submitting" — POST in flight
//   3. "reveal"     — render the generated PIN list + CSV download
type BulkModalPhase = "preview" | "submitting" | "reveal";

type BulkPinResult = {
  workerId: string;
  empNo: string;
  name: string;
  pin: string;
};

type BulkModalState = {
  phase: BulkModalPhase;
  pendingCount: number; // active workers without a PIN
  generated: BulkPinResult[];
  skipped: number;
  error: string | null;
};

// Self-contained Departments multi-select dropdown for the inline edit row.
// Owns its own open/close state so DataGrid cell memoization (which keys on
// row data only) doesn't strand the popover JSX un-mounted. Previously the
// open boolean lived in the parent EmployeeMasterTab, which meant clicking
// the button re-rendered the parent but NOT the memoized cell — operator
// had to click twice to open the popover (Wei Siang 2026-05-10: "很卡，要
// 点两下才开"). Keeping state inside this component forces the cell to
// re-render via React's normal child-state path.
function DepartmentMultiSelect({
  selectedCodes,
  allDepts,
  onChange,
}: {
  selectedCodes: string[];
  allDepts: DepartmentLite[];
  onChange: (codes: string[], primaryDept: DepartmentLite | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside detector. Document-level mousedown (not a backdrop div)
  // because the edit row scrolls horizontally — an opaque shield would
  // block reaching the Save button on narrow screens.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const deptNamesOf = (codes: string[]) =>
    codes
      .map((code) => allDepts.find((d) => d.code === code)?.name ?? code)
      .join(", ");

  const summary =
    selectedCodes.length === 0
      ? "— Select —"
      : selectedCodes.length <= 2
        ? deptNamesOf(selectedCodes)
        : `${selectedCodes.length} departments`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="h-8 w-44 text-xs border border-[#E2DDD8] rounded-md bg-white px-2 pr-2 text-left flex items-center justify-between gap-1 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
        title={selectedCodes.length > 0 ? deptNamesOf(selectedCodes) : ""}
      >
        <span className="truncate flex-1">{summary}</span>
        <svg className="h-3 w-3 text-[#6B7280] shrink-0" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-56 bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-64 overflow-y-auto">
          {allDepts.map((d) => {
            const checked = selectedCodes.includes(d.code);
            return (
              <label
                key={d.id}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[#FAF9F7] ${
                  checked ? "bg-[#FAF7EE]" : ""
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#6B5C32]"
                  checked={checked}
                  onChange={() => {
                    const set = new Set(selectedCodes);
                    if (set.has(d.code)) set.delete(d.code);
                    else set.add(d.code);
                    const codes = Array.from(set);
                    const primaryDept = allDepts.find((x) => x.code === codes[0]);
                    onChange(codes, primaryDept);
                  }}
                />
                <span className="text-[#374151]">{d.name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmployeeMasterTab({
  workers,
  refreshWorkers,
  departments,
}: {
  workers: Worker[];
  refreshWorkers: () => void;
  departments: DepartmentLite[];
}) {
  // Primary-dept dropdown can pick any of the 13 (and counting) depts —
  // workers can have R&D / Maintenance as their primary too, not just
  // production. Falls back to seed if API hasn't loaded.
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<WorkerFormData>({ ...emptyForm });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<WorkerFormData>({ ...emptyForm });
  // After a salary edit, ask WHEN it takes effect (a raise can be back/post-dated)
  // — recorded as a worker_salary_history row rather than a silent overwrite.
  const [salaryChangePrompt, setSalaryChangePrompt] = useState<{
    workerId: string;
    workerName: string;
    newSalarySen: number;
    oldSalarySen: number;
    effectiveFrom: string;
    submitting: boolean;
    error: string | null;
  } | null>(null);
  // Per-row Departments multi-select popover state lives inside
  // DepartmentMultiSelect (rendered in the column below) so DataGrid cell
  // memoization can't strand it un-rendered. (Categories is a native select,
  // no state needed for it.)
  const [saving, setSaving] = useState(false);
  const [pinModal, setPinModal] = useState<PinModalState | null>(null);
  const [bulkModal, setBulkModal] = useState<BulkModalState | null>(null);

  const openPinModal = (w: Worker) => {
    setPinModal({
      worker: w,
      phase: "configure",
      mode: "random",
      customPin: "",
      submitting: false,
      error: null,
      revealedPin: null,
    });
  };
  const closePinModal = () => setPinModal(null);

  const submitPin = async () => {
    if (!pinModal) return;
    if (pinModal.mode === "custom" && !/^\d{6}$/.test(pinModal.customPin)) {
      setPinModal({ ...pinModal, error: "PIN must be exactly 6 digits" });
      return;
    }
    setPinModal({ ...pinModal, submitting: true, error: null });
    try {
      const body =
        pinModal.mode === "custom" ? { pin: pinModal.customPin } : {};
      const res = await fetch(
        `/api/workers/${pinModal.worker.id}/set-pin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { pin?: string };
      };
      if (!res.ok || !json?.success) {
        setPinModal({
          ...pinModal,
          submitting: false,
          error: humanizeError({ status: res.status, message: json?.error }, "That didn't work. Please try again."),
        });
        return;
      }
      const pin = json.data?.pin;
      if (!pin) {
        setPinModal({
          ...pinModal,
          submitting: false,
          error: "Server did not return a PIN",
        });
        return;
      }
      setPinModal({
        ...pinModal,
        phase: "reveal",
        submitting: false,
        revealedPin: pin,
        error: null,
      });
    } catch (e) {
      setPinModal({
        ...pinModal,
        submitting: false,
        error: humanizeError(e, "That didn't work. Please try again."),
      });
    }
  };

  const openBulkModal = () => {
    // Pending count is computed locally from the loaded worker list — workers
    // are flagged as "needs PIN" iff status === ACTIVE. The server is the
    // source of truth (its query also LEFT JOINs worker_pins to skip workers
    // who already have one), but we don't want to leak that join here on
    // every page load, so the preview is approximate and the server's
    // response (skipped count + actual generated count) is the truth shown
    // on the reveal screen.
    const activeCount = workers.filter((w) => w.status === "ACTIVE").length;
    setBulkModal({
      phase: "preview",
      pendingCount: activeCount,
      generated: [],
      skipped: 0,
      error: null,
    });
  };
  const closeBulkModal = () => setBulkModal(null);

  const submitBulk = async () => {
    if (!bulkModal) return;
    setBulkModal({ ...bulkModal, phase: "submitting", error: null });
    try {
      const res = await fetch("/api/workers/bulk-generate-pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { generated?: BulkPinResult[]; skipped?: number };
      };
      if (!res.ok || !json?.success) {
        setBulkModal({
          ...bulkModal,
          phase: "preview",
          error: humanizeError({ status: res.status, message: json?.error }, "That didn't work. Please try again."),
        });
        return;
      }
      const generated = json.data?.generated ?? [];
      setBulkModal({
        phase: "reveal",
        pendingCount: bulkModal.pendingCount,
        generated,
        skipped: json.data?.skipped ?? 0,
        error: null,
      });
    } catch (e) {
      setBulkModal({
        ...bulkModal,
        phase: "preview",
        error: humanizeError(e, "That didn't work. Please try again."),
      });
    }
  };

  const downloadBulkCsv = () => {
    if (!bulkModal || bulkModal.generated.length === 0) return;
    const header = "empNo,name,pin\n";
    const rows = bulkModal.generated
      .map(
        (r) =>
          `${csvCell(r.empNo)},${csvCell(r.name)},${csvCell(r.pin)}`,
      )
      .join("\n");
    const blob = new Blob([header + rows], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `worker-pins-${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (text: string) => {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard?.writeText
    ) {
      navigator.clipboard.writeText(text).then(
        () => toast.success("Copied to clipboard"),
        () => toast.error("Could not copy — copy manually"),
      );
    } else {
      toast.error("Clipboard not available — copy the value manually");
    }
  };

  const handleAdd = async () => {
    setSaving(true);
    try {
      // Categories only meaningful for Operator Leaders — strip on the way
      // out for everyone else so we never persist stale values.
      const payload =
        form.position === "Operator Leader"
          ? form
          : { ...form, categories: [] };
      await fetch("/api/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setShowAddForm(false);
      setForm({ ...emptyForm });
      refreshWorkers();
    } catch {
      // handle error
    }
    setSaving(false);
  };

  const startEdit = (w: Worker) => {
    setEditingId(w.id);
    setEditForm({
      empNo: w.empNo,
      name: w.name,
      departmentId: w.departmentId,
      departmentCodes:
        Array.isArray(w.departmentCodes) && w.departmentCodes.length > 0
          ? w.departmentCodes
          : w.departmentCode
            ? [w.departmentCode]
            : [],
      categories: Array.isArray(w.categories) ? w.categories : [],
      position: w.position,
      phone: w.phone,
      basicSalarySen: w.basicSalarySen,
      workingHoursPerDay: w.workingHoursPerDay,
      workingDaysPerMonth: w.workingDaysPerMonth,
      otMultiplier: w.otMultiplier ?? 1.5,
      epfEnabled: w.epfEnabled !== false,
      socsoEnabled: w.socsoEnabled !== false,
      eisEnabled: w.eisEnabled !== false,
      pcbEnabled: w.pcbEnabled !== false,
      joinDate: w.joinDate,
      nationality: w.nationality,
      status: w.status,
      resignedAt: w.resignedAt ?? "",
      efficiencyAllowanceSen: w.efficiencyAllowanceSen ?? 0,
      efficiencyThresholdPct: w.efficiencyThresholdPct ?? 0,
    });
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    // Resignation date is required when status is Resigned. Mirror the
    // backend rule on the frontend so the operator gets an instant reject
    // instead of a delayed 400.
    const isResigned = editForm.status === "RESIGNED";
    if (isResigned && !/^\d{4}-\d{2}-\d{2}$/.test(editForm.resignedAt || "")) {
      toast.error("A resignation date is required when status is Resigned.");
      return;
    }
    // Efficiency bonus config — reject out-of-range with the SAME message the
    // backend PUT returns, so the operator gets an instant identical reject
    // instead of a delayed 400 (frontend+backend unified validation).
    const effAllowanceSen = editForm.efficiencyAllowanceSen ?? 0;
    const effThresholdPct = editForm.efficiencyThresholdPct ?? 0;
    if (!Number.isFinite(effAllowanceSen) || effAllowanceSen < 0) {
      toast.error("Efficiency allowance must be 0 or more.");
      return;
    }
    if (
      !Number.isFinite(effThresholdPct) ||
      effThresholdPct < 0 ||
      effThresholdPct > 100
    ) {
      toast.error("Efficiency threshold must be between 0 and 100.");
      return;
    }
    // Backend rejects a non-empty resignedAt unless status is RESIGNED, so
    // send "" whenever the worker is not resigned.
    const resignedAt = isResigned ? (editForm.resignedAt || "") : "";
    // A salary change is recorded with an EFFECTIVE DATE via a follow-up prompt,
    // not silently overwritten — so keep the salary scalar untouched in THIS PUT
    // and open the prompt once the rest of the row has saved.
    const originalWorker = workers.find((w) => w.id === editingId);
    const newSalarySen = editForm.basicSalarySen;
    const salaryChanged =
      !!originalWorker && newSalarySen !== originalWorker.basicSalarySen;
    const keptSalarySen = salaryChanged
      ? originalWorker!.basicSalarySen
      : editForm.basicSalarySen;
    setSaving(true);
    const payload =
      editForm.position === "Operator Leader"
        ? { ...editForm, resignedAt, basicSalarySen: keptSalarySen }
        : { ...editForm, resignedAt, categories: [], basicSalarySen: keptSalarySen };
    // 2026-05-27 verifiedSave migration. Worker master-data drives
    // payroll, statutory toggles, and OT — a stale-cache silent
    // overwrite would mis-pay workers. Read back and confirm.
    const result = await verifiedSave<Worker>({
      endpoint: `/api/workers/${editingId}`,
      method: "PUT",
      body: payload,
      readback: async () => {
        const r = await fetch(`/api/workers/${editingId}?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: Worker } | Worker;
        return (j as { data?: Worker })?.data ?? (j as Worker) ?? null;
      },
      expect: {
        empNo: editForm.empNo,
        name: editForm.name,
        position: editForm.position,
        phone: editForm.phone,
        status: editForm.status,
      },
    });
    if (result.ok) {
      setEditingId(null);
      if (salaryChanged && originalWorker) {
        // Other fields saved; now ask WHEN the new salary takes effect.
        setSalaryChangePrompt({
          workerId: originalWorker.id,
          workerName: editForm.name || originalWorker.name,
          newSalarySen,
          oldSalarySen: originalWorker.basicSalarySen,
          effectiveFrom: todayYmdMY(),
          submitting: false,
          error: null,
        });
      } else {
        refreshWorkers();
      }
    } else if (result.reason === "mismatch") {
      toast.error(formatMismatchError(result.diffs));
    } else if (result.reason === "http") {
      let parsedErr = result.body;
      try {
        const j = JSON.parse(result.body) as { error?: string };
        if (j.error) parsedErr = j.error;
      } catch { /* keep raw body */ }
      toast.error(parsedErr || `Failed to update worker (HTTP ${result.status})`);
    } else {
      toast.error(`Save failed: ${result.details}`);
    }
    setSaving(false);
  };

  // Record the salary change at the chosen effective date (a worker_salary_history
  // row). The backend re-syncs the current scalar, so payroll picks it up.
  const confirmSalaryChange = async () => {
    if (!salaryChangePrompt) return;
    const { workerId, newSalarySen, effectiveFrom } = salaryChangePrompt;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setSalaryChangePrompt({
        ...salaryChangePrompt,
        error: "Pick an effective date.",
      });
      return;
    }
    setSalaryChangePrompt({ ...salaryChangePrompt, submitting: true, error: null });
    try {
      const r = await fetch(`/api/workers/${workerId}/salary-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveFrom, basicSalarySen: newSalarySen }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSalaryChangePrompt(null);
      refreshWorkers();
      toast.success("Salary change recorded.");
    } catch {
      setSalaryChangePrompt((p) =>
        p ? { ...p, submitting: false, error: "Failed to record — please try again." } : p,
      );
    }
  };

  // Cancel the prompt — the new amount is discarded; the row's other edits
  // already saved and the salary stays at its previous value.
  const cancelSalaryChange = () => {
    setSalaryChangePrompt(null);
    refreshWorkers();
  };

  const handleDelete = async (id: string) => {
    const name = workers.find((w) => w.id === id)?.name;
    if (
      !(await confirm({
        title: "Delete this employee?",
        message: name
          ? `Delete employee "${name}"? This cannot be undone.`
          : "Are you sure you want to delete this employee? This cannot be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      }))
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/workers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        toast.error(body?.error || `Failed to delete employee (HTTP ${res.status})`);
        return;
      }
      refreshWorkers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error — employee not deleted");
    }
  };

  const columns: Column<Worker>[] = useMemo(
    () => [
      {
        key: "empNo",
        label: "Emp No",
        width: "120px",
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              value={editForm.empNo}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, empNo: e.target.value }))
              }
              className="h-8 w-24 text-xs"
            />
          ) : (
            <span className="font-medium text-[#6B5C32]">{row.empNo}</span>
          ),
      },
      {
        key: "name",
        label: "Name",
        sortable: true,
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              value={editForm.name}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, name: e.target.value }))
              }
              className="h-8 w-36 text-xs"
            />
          ) : (
            <span className="font-medium text-[#1F1D1B]">{row.name}</span>
          ),
      },
      {
        key: "departmentCode",
        label: "Departments",
        sortable: true,
        // The inline-edit DepartmentMultiSelect popover is an absolute-positioned
        // <div>. Without noClip the DataGrid wraps every cell in an overflow:hidden
        // "truncate" box (data-grid.tsx ~2786) that clips the panel to invisibility
        // — the operator clicks the Department dropdown and "nothing happens".
        // Position/Category are native <select> so the browser paints them above
        // the clip; this custom dropdown is the only one affected. Wei Siang 2026-06-05.
        noClip: true,
        render: (_value, row) => {
          const deptNamesOf = (codes: string[]) =>
            codes
              .map(
                (code) => allDepts.find((d) => d.code === code)?.name ?? code,
              )
              .join(", ");
          if (editingId === row.id) {
            // Multi-select disguised as a dropdown — looks like the Position
            // <select> but the panel has tickable checkboxes. Wei Siang
            // 2026-05-10: the chip wall was too tall and ugly inline.
            // State lives inside DepartmentMultiSelect to bypass DataGrid
            // cell memoization (parent state changes wouldn't re-render the
            // memoized cell, so the popover never mounted on first click).
            return (
              <DepartmentMultiSelect
                selectedCodes={editForm.departmentCodes}
                allDepts={allDepts}
                onChange={(codes, primaryDept) => {
                  setEditForm((f) => ({
                    ...f,
                    departmentCodes: codes,
                    departmentId: primaryDept?.id ?? f.departmentId,
                  }));
                }}
              />
            );
          }
          const codes =
            Array.isArray(row.departmentCodes) && row.departmentCodes.length > 0
              ? row.departmentCodes
              : row.departmentCode
                ? [row.departmentCode]
                : [];
          if (codes.length === 0) {
            return <span className="text-[#9CA3AF]">—</span>;
          }
          return (
            <span className="text-[#4B5563]" title={deptNamesOf(codes)}>
              {deptNamesOf(codes)}
              {codes.length > 1 && (
                <span className="ml-1 text-[10px] text-[#9CA3AF]">
                  ({codes.length})
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "position",
        label: "Position",
        render: (_value, row) =>
          editingId === row.id ? (
            <select
              value={editForm.position}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, position: e.target.value }))
              }
              className="h-8 w-36 text-xs border border-[#E2DDD8] rounded-md bg-white px-2 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            >
              <option value="Operator">Operator</option>
              <option value="Operator Leader">Operator Leader</option>
            </select>
          ) : (
            <span className="text-[#4B5563]">{row.position}</span>
          ),
      },
      {
        key: "categories",
        label: "Category",
        render: (_value, row) => {
          // Categories only apply to Operator Leaders. Single-select native
          // dropdown to match the Position cell visually — Wei Siang
          // 2026-05-10. "All" stores [] (no filter), the named choices store
          // a single-element array. A leader who covers both SOFA + BEDFRAME
          // picks "All".
          if (editingId === row.id) {
            if (editForm.position !== "Operator Leader") {
              return <span className="text-[#9CA3AF] text-xs">—</span>;
            }
            const current =
              editForm.categories.length === 0
                ? ""
                : editForm.categories[0];
            return (
              <select
                value={current}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    categories: e.target.value ? [e.target.value] : [],
                  }))
                }
                className="h-8 w-32 text-xs border border-[#E2DDD8] rounded-md bg-white px-2 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">All</option>
                <option value="SOFA">SOFA</option>
                <option value="BEDFRAME">BEDFRAME</option>
              </select>
            );
          }
          if (row.position !== "Operator Leader") {
            return <span className="text-[#9CA3AF] text-xs">—</span>;
          }
          const cats = Array.isArray(row.categories) ? row.categories : [];
          if (cats.length === 0) {
            return <span className="text-[#9CA3AF] text-xs">All</span>;
          }
          return <span className="text-[#4B5563] text-xs">{cats[0]}</span>;
        },
      },
      {
        key: "phone",
        label: "Phone",
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              value={editForm.phone}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, phone: e.target.value }))
              }
              className="h-8 w-36 text-xs"
            />
          ) : (
            <span className="text-[#4B5563]">{row.phone}</span>
          ),
      },
      {
        key: "basicSalarySen",
        label: "Basic Salary (RM)",
        align: "right",
        sortable: true,
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              type="number" onFocus={(e) => e.currentTarget.select()}
              value={editForm.basicSalarySen / 100}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  basicSalarySen: Math.round(parseFloat(e.target.value) * 100),
                }))
              }
              className="h-8 w-24 text-xs"
            />
          ) : (
            <span className="font-medium">{formatRM(row.basicSalarySen)}</span>
          ),
      },
      {
        key: "workingHoursPerDay",
        label: "Hrs/Day",
        align: "center",
        width: "80px",
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              type="number" step="any" min="0" max="24" onFocus={(e) => e.currentTarget.select()}
              value={editForm.workingHoursPerDay}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  workingHoursPerDay: parseFloat(e.target.value) || 0,
                }))
              }
              className="h-8 w-16 text-xs"
            />
          ) : (
            <span>{row.workingHoursPerDay}</span>
          ),
      },
      {
        key: "workingDaysPerMonth",
        label: "Days/Mo",
        align: "center",
        width: "80px",
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              type="number" onFocus={(e) => e.currentTarget.select()}
              value={editForm.workingDaysPerMonth}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  workingDaysPerMonth: parseInt(e.target.value) || 0,
                }))
              }
              className="h-8 w-16 text-xs"
            />
          ) : (
            <span>{row.workingDaysPerMonth}</span>
          ),
      },
      {
        key: "otMultiplier",
        label: "OT ×",
        align: "center",
        width: "70px",
        render: (_value, row) => {
          const mult = row.otMultiplier ?? 1.5;
          return editingId === row.id ? (
            <Input
              type="number" onFocus={(e) => e.currentTarget.select()}
              min={1}
              step={0.1}
              value={editForm.otMultiplier}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  otMultiplier: parseFloat(e.target.value) || 1,
                }))
              }
              className="h-8 w-16 text-xs"
              title="OT premium multiplier — 1.5 = OT pays 1.5× hourly rate; 1.0 = no premium"
            />
          ) : (
            <span title="OT premium multiplier (hourly rate × this for OT hours)">
              {mult.toFixed(1)}×
            </span>
          );
        },
      },
      {
        // Efficiency Allowance amount (sen, shown as RM). Flat bonus paid when
        // the worker's efficiency over the payroll period reaches the threshold
        // below. Stored in sen like basicSalarySen. Phase-1 config column; the
        // Payroll entitlement engine (Phase 2) decides pay/no-pay.
        key: "efficiencyAllowanceSen",
        label: "Eff. Allowance (RM)",
        align: "right",
        sortable: true,
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              type="number" onFocus={(e) => e.currentTarget.select()}
              min={0}
              value={(editForm.efficiencyAllowanceSen ?? 0) / 100}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  efficiencyAllowanceSen: Math.round(parseFloat(e.target.value) * 100) || 0,
                }))
              }
              className="h-8 w-24 text-xs"
              title="Flat bonus paid when this worker's efficiency over the payroll period reaches the threshold %"
            />
          ) : (
            <span className="font-medium">
              {row.efficiencyAllowanceSen ? formatRM(row.efficiencyAllowanceSen) : "—"}
            </span>
          ),
      },
      {
        // Efficiency Threshold % — the efficiency the worker must reach over the
        // payroll period to earn the allowance above. 0–100; rejected out of
        // range at Save AND on the backend (same message). 0 shows as "—".
        key: "efficiencyThresholdPct",
        label: "Eff. Threshold %",
        align: "center",
        width: "110px",
        render: (_value, row) => {
          const pct = row.efficiencyThresholdPct ?? 0;
          return editingId === row.id ? (
            <Input
              type="number" onFocus={(e) => e.currentTarget.select()}
              min={0}
              max={100}
              step={1}
              value={editForm.efficiencyThresholdPct}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  efficiencyThresholdPct: parseFloat(e.target.value) || 0,
                }))
              }
              className="h-8 w-16 text-xs"
              title="Efficiency % this worker must reach over the payroll period to earn the allowance"
            />
          ) : (
            <span title="Efficiency % required to earn the allowance">
              {pct ? `${pct}%` : "—"}
            </span>
          );
        },
      },
      {
        // Statutory toggle — single tick for the four-flag bundle (EPF +
        // SOCSO + EIS + PCB). Wei Siang 2026-05-23: per-flag granularity
        // isn't needed in practice — a worker either is registered for the
        // four Malaysian statutory schemes (ticked) or isn't (unticked, in
        // which case Net Pay = Gross Pay). The DB still has four columns
        // (forward-compat) but the operator writes the same boolean to all
        // four. View mode = ticked green / dash grey; Edit mode = checkbox.
        key: "statutory",
        label: "Statutory",
        align: "center",
        width: "90px",
        render: (_value, row) => {
          const allOn =
            row.epfEnabled !== false &&
            row.socsoEnabled !== false &&
            row.eisEnabled !== false &&
            row.pcbEnabled !== false;
          if (editingId === row.id) {
            const editAllOn =
              editForm.epfEnabled &&
              editForm.socsoEnabled &&
              editForm.eisEnabled &&
              editForm.pcbEnabled;
            return (
              <label
                className="flex items-center justify-center cursor-pointer"
                title="When ticked: EPF + SOCSO + EIS + PCB will all be deducted on this worker's payslip. Unticked: no statutory deductions — Net Pay = Gross Pay."
              >
                <input
                  type="checkbox"
                  checked={editAllOn}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setEditForm((f) => ({
                      ...f,
                      epfEnabled: v,
                      socsoEnabled: v,
                      eisEnabled: v,
                      pcbEnabled: v,
                    }));
                  }}
                  className="h-4 w-4 cursor-pointer"
                />
              </label>
            );
          }
          return (
            <span
              className="inline-block text-base font-semibold"
              title={
                allOn
                  ? "Statutory ON — EPF / SOCSO / EIS / PCB will deduct on next payslip"
                  : "Statutory OFF — no deductions; Net Pay = Gross Pay"
              }
            >
              {allOn ? (
                <span className="text-[#4F7C3A]">✓</span>
              ) : (
                <span className="text-[#9CA3AF]">—</span>
              )}
            </span>
          );
        },
      },
      {
        key: "joinDate",
        label: "Join Date",
        sortable: true,
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              type="date"
              value={editForm.joinDate}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, joinDate: e.target.value }))
              }
              className="h-8 w-36 text-xs"
            />
          ) : (
            <span className="text-[#4B5563]">{formatDateDMY(row.joinDate)}</span>
          ),
      },
      {
        key: "nationality",
        label: "Nationality",
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              value={editForm.nationality}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, nationality: e.target.value }))
              }
              className="h-8 w-24 text-xs"
            />
          ) : (
            <span className="text-[#4B5563]">{row.nationality || "-"}</span>
          ),
      },
      {
        key: "status",
        label: "Status",
        width: "110px",
        render: (_value, row) =>
          editingId === row.id ? (
            <div className="flex flex-col gap-1">
              <select
                value={editForm.status}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, status: e.target.value }))
                }
                className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
                <option value="RESIGNED">Resigned</option>
              </select>
              {editForm.status === "RESIGNED" && (
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-[#6B7280]">Resigned on</span>
                  <input
                    type="date"
                    value={editForm.resignedAt ?? ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, resignedAt: e.target.value }))
                    }
                    className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Badge variant="status" status={row.status} />
              {row.status === "RESIGNED" && row.resignedAt && (
                <span className="text-[11px] text-[#9CA3AF]">
                  · left {formatDateDMY(row.resignedAt)}
                </span>
              )}
            </span>
          ),
      },
      {
        key: "_actions",
        label: "Actions",
        width: "120px",
        align: "center",
        render: (_value, row) =>
          editingId === row.id ? (
            <div className="flex items-center gap-1">
              <Button
                variant="primary"
                size="sm"
                onClick={handleUpdate}
                disabled={saving}
              >
                <Save className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingId(null)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startEdit(row)}
                title="Edit employee"
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openPinModal(row)}
                title="Set / Reset PIN"
              >
                <KeyRound className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(row.id)}
                className="text-[#9A3A2D] hover:text-[#7A2E24]"
                title="Delete employee"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editingId, editForm, saving]
  );

  const contextMenuItems: ContextMenuItem[] = useMemo(
    () => [
      {
        label: "View Details",
        icon: <Eye className="h-4 w-4" />,
        action: (row: Worker) => {
          toast.info(`Viewing details for ${row.name}`);
        },
      },
      {
        label: "Edit",
        icon: <Pencil className="h-4 w-4" />,
        action: (row: Worker) => {
          startEdit(row);
        },
      },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-4 w-4" />,
        action: () => {
          refreshWorkers();
        },
        separator: true,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <Card>
      {confirmDialog}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[#6B5C32]" /> Employee Master
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={openBulkModal}
              title="Generate 6-digit PINs for every active worker who doesn't have one yet"
            >
              <KeyRound className="h-4 w-4" />
              Generate PINs for new workers
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                // Opening a fresh form → pre-fill the next Emp No (editable).
                if (!showAddForm)
                  setForm((f) => ({ ...f, empNo: f.empNo || nextEmpNo(workers) }));
                setShowAddForm(!showAddForm);
              }}
            >
              <Plus className="h-4 w-4" />
              {showAddForm ? "Cancel" : "Add Employee"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Inline Add Form */}
        {showAddForm && (
          <div className="mb-6 rounded-lg border border-[#6B5C32]/30 bg-[#F0ECE9] p-4">
            <h4 className="mb-3 text-sm font-semibold text-[#1F1D1B]">
              New Employee
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-md:grid-cols-1">
              <div>
                <label className="text-xs text-[#6B7280]">Emp No</label>
                <Input
                  value={form.empNo}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, empNo: e.target.value }))
                  }
                  placeholder="EMP-XXX"
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-[#6B7280]">Name</label>
                <Input
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Full name"
                  className="h-8 text-xs"
                />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-[#6B7280]">
                  Departments <span className="text-[10px] text-[#9CA3AF]">(tick all that apply)</span>
                </label>
                <div className="mt-1 flex flex-wrap gap-1.5 p-2 border border-[#E2DDD8] rounded-md bg-white max-h-32 overflow-y-auto">
                  {allDepts.map((d) => {
                    const checked = form.departmentCodes.includes(d.code);
                    return (
                      <label
                        key={d.id}
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] cursor-pointer ${
                          checked
                            ? "bg-[#F0ECE9] border-[#6B5C32] text-[#1F1D1B]"
                            : "bg-white border-[#E2DDD8] text-[#6B7280] hover:bg-[#FAF9F7]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-3 w-3"
                          checked={checked}
                          onChange={(e) => {
                            setForm((f) => {
                              const set = new Set(f.departmentCodes);
                              if (e.target.checked) set.add(d.code);
                              else set.delete(d.code);
                              const codes = Array.from(set);
                              // Primary departmentId follows the first
                              // ticked department (so back-compat lookups
                              // by departmentId still resolve sensibly).
                              const primaryDept = allDepts.find((x) => x.code === codes[0]);
                              return {
                                ...f,
                                departmentCodes: codes,
                                departmentId: primaryDept?.id ?? f.departmentId,
                              };
                            });
                          }}
                        />
                        {d.name}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#6B7280]">Position</label>
                <select
                  value={form.position}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, position: e.target.value }))
                  }
                  className="h-8 text-xs w-full border border-[#D1D5DB] rounded-md px-2 bg-white"
                >
                  <option value="Operator">Operator</option>
                  <option value="Operator Leader">Operator Leader</option>
                </select>
              </div>
              {/* Category only applies to Operator Leaders — gates which
                  (dept × category) cells the Team dashboard surfaces. Hidden
                  entirely for plain Operators. — Wei Siang 2026-05-10 */}
              {form.position === "Operator Leader" && (
                <div>
                  <label className="text-xs text-[#6B7280]">Category</label>
                  <select
                    value={form.categories[0] ?? ""}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        categories: e.target.value ? [e.target.value] : [],
                      }))
                    }
                    className="h-8 text-xs w-full border border-[#D1D5DB] rounded-md px-2 bg-white"
                  >
                    <option value="">All</option>
                    <option value="SOFA">SOFA</option>
                    <option value="BEDFRAME">BEDFRAME</option>
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs text-[#6B7280]">Phone</label>
                <Input
                  value={form.phone}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, phone: e.target.value }))
                  }
                  placeholder="+60 12-XXX XXXX"
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-[#6B7280]">
                  Basic Salary (RM)
                </label>
                <Input
                  type="number" onFocus={(e) => e.currentTarget.select()}
                  value={form.basicSalarySen / 100}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      basicSalarySen: Math.round(
                        parseFloat(e.target.value) * 100
                      ),
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-[#6B7280]">Hrs/Day</label>
                <Input
                  type="number" step="any" min="0" max="24" onFocus={(e) => e.currentTarget.select()}
                  value={form.workingHoursPerDay}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      workingHoursPerDay: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-[#6B7280]" title="OT premium multiplier — 1.5 = OT pays 1.5× hourly rate; 1.0 = no premium">
                  OT ×
                </label>
                <Input
                  type="number" onFocus={(e) => e.currentTarget.select()}
                  min={1}
                  step={0.1}
                  value={form.otMultiplier}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      otMultiplier: parseFloat(e.target.value) || 1,
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-[#6B7280]">Nationality</label>
                <Input
                  value={form.nationality}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, nationality: e.target.value }))
                  }
                  placeholder="e.g. Myanmar"
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={handleAdd}
                disabled={saving || !form.name || !form.empNo}
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save Employee"}
              </Button>
            </div>
          </div>
        )}

        <DataGrid
          columns={columns}
          data={workers}
          keyField="id"
          gridId="employees-master"
          contextMenuItems={contextMenuItems}
          onDoubleClick={(row) => startEdit(row)}
          emptyMessage="No employees found."
        />
      </CardContent>

      {/* Per-worker PIN modal — two phases: configure then reveal. */}
      {salaryChangePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={salaryChangePrompt.submitting ? undefined : cancelSalaryChange}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-[#1F1D1B]">
                  Salary change — effective from?
                </h3>
                <div className="mt-1 text-xs text-[#6B7280]">
                  {salaryChangePrompt.workerName}
                </div>
              </div>
              <button
                type="button"
                onClick={cancelSalaryChange}
                disabled={salaryChangePrompt.submitting}
                className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-40"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-[#6B7280]">Basic salary</span>
                <span className="tabular-nums">
                  <span className="text-[#9CA3AF] line-through">
                    {formatRM(salaryChangePrompt.oldSalarySen)}
                  </span>
                  <span className="mx-1.5 text-[#9CA3AF]">→</span>
                  <span className="font-semibold text-[#1F1D1B]">
                    {formatRM(salaryChangePrompt.newSalarySen)}
                  </span>
                </span>
              </div>
            </div>

            <label className="block text-xs font-medium text-[#4B5563] mb-1">
              Effective from
            </label>
            <Input
              type="date"
              value={salaryChangePrompt.effectiveFrom}
              onChange={(e) =>
                setSalaryChangePrompt((p) =>
                  p ? { ...p, effectiveFrom: e.target.value, error: null } : p,
                )
              }
              className="w-full"
            />
            <p className="mt-1.5 text-[11px] text-[#6B7280] leading-relaxed">
              The new salary applies from this date. Payroll day-weights a mid-month
              change; earlier months are unaffected. You can back- or post-date it.
            </p>

            {salaryChangePrompt.error && (
              <p className="mt-2 text-xs text-[#9A3A2D]">{salaryChangePrompt.error}</p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelSalaryChange}
                disabled={salaryChangePrompt.submitting}
                className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm text-[#4B5563] hover:bg-[#F3F4F6] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSalaryChange}
                disabled={salaryChangePrompt.submitting}
                className="rounded-md bg-[#6B5C32] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#5A4D2A] disabled:opacity-50"
              >
                {salaryChangePrompt.submitting ? "Saving…" : "Confirm change"}
              </button>
            </div>
          </div>
        </div>
      )}
      {pinModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closePinModal}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-[#1F1D1B]">
                  {pinModal.phase === "reveal"
                    ? "PIN Set"
                    : "Set / Reset PIN"}
                </h3>
                <div className="mt-1 text-xs text-[#6B7280]">
                  {pinModal.worker.name}
                  <span className="mx-1">·</span>
                  {pinModal.worker.empNo}
                </div>
              </div>
              <button
                type="button"
                onClick={closePinModal}
                className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {pinModal.phase === "configure" && (
              <>
                <div className="space-y-3">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={pinModal.mode === "random"}
                      onChange={() =>
                        setPinModal({
                          ...pinModal,
                          mode: "random",
                          customPin: "",
                          error: null,
                        })
                      }
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm font-medium text-[#1F1D1B]">
                        Generate random PIN
                      </div>
                      <div className="text-xs text-[#6B7280]">
                        Server picks a random 6-digit PIN.
                      </div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={pinModal.mode === "custom"}
                      onChange={() =>
                        setPinModal({
                          ...pinModal,
                          mode: "custom",
                          error: null,
                        })
                      }
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-[#1F1D1B]">
                        Set custom PIN
                      </div>
                      <Input
                        value={pinModal.customPin}
                        onChange={(e) =>
                          setPinModal({
                            ...pinModal,
                            mode: "custom",
                            customPin: e.target.value
                              .replace(/\D/g, "")
                              .slice(0, 6),
                            error: null,
                          })
                        }
                        onFocus={() =>
                          setPinModal({
                            ...pinModal,
                            mode: "custom",
                            error: null,
                          })
                        }
                        placeholder="6 digits"
                        inputMode="numeric"
                        pattern="\d{6}"
                        maxLength={6}
                        className="mt-1 h-8 w-32 text-xs"
                        disabled={pinModal.mode !== "custom"}
                      />
                    </div>
                  </label>
                </div>
                {pinModal.error && (
                  <div className="mt-3 rounded border border-[#9A3A2D]/30 bg-[#F9E1DA] px-3 py-2 text-xs text-[#9A3A2D]">
                    {pinModal.error}
                  </div>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={closePinModal}
                    disabled={pinModal.submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={submitPin}
                    disabled={
                      pinModal.submitting ||
                      (pinModal.mode === "custom" &&
                        !/^\d{6}$/.test(pinModal.customPin))
                    }
                  >
                    {pinModal.submitting
                      ? "Saving..."
                      : "Set PIN"}
                  </Button>
                </div>
              </>
            )}

            {pinModal.phase === "reveal" && pinModal.revealedPin && (
              <>
                <div className="rounded-lg border border-[#C6DBA8] bg-[#F0F7E6] p-4 text-center">
                  <div className="text-xs uppercase tracking-wide text-[#4F7C3A]">
                    PIN
                  </div>
                  <div className="mt-1 font-mono text-3xl tracking-[0.4em] text-[#1F1D1B]">
                    {pinModal.revealedPin}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() =>
                      copyToClipboard(pinModal.revealedPin || "")
                    }
                  >
                    <Copy className="h-3 w-3" />
                    Copy
                  </Button>
                </div>
                <div className="mt-3 rounded border border-[#E0B770]/40 bg-[#FBF3DF] px-3 py-2 text-xs text-[#7A5C1A]">
                  This PIN won&apos;t be shown again. Record it now and hand it
                  to the worker. Any open mobile session for this worker has
                  been forced to re-login.
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="primary" onClick={closePinModal}>
                    Done
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Bulk-PIN modal — preview, then reveal with CSV download. */}
      {bulkModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={
            bulkModal.phase === "submitting" ? undefined : closeBulkModal
          }
        >
          <div
            className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-[#1F1D1B]">
                  {bulkModal.phase === "reveal"
                    ? "Generated PINs"
                    : "Generate PINs for new workers"}
                </h3>
                <div className="mt-1 text-xs text-[#6B7280]">
                  {bulkModal.phase === "reveal"
                    ? `${bulkModal.generated.length} PINs created`
                    : "Active workers without an existing PIN will be assigned a random 6-digit PIN."}
                </div>
              </div>
              {bulkModal.phase !== "submitting" && (
                <button
                  type="button"
                  onClick={closeBulkModal}
                  className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {bulkModal.phase === "preview" && (
              <>
                <div className="rounded border border-[#E2DDD8] bg-[#FAF7F4] p-3 text-sm text-[#4B5563]">
                  Up to{" "}
                  <span className="font-semibold text-[#1F1D1B]">
                    {bulkModal.pendingCount}
                  </span>{" "}
                  active worker(s) may need a PIN. The server will skip any
                  who already have one set and report the actual count below.
                </div>
                <div className="mt-3 rounded border border-[#E0B770]/40 bg-[#FBF3DF] px-3 py-2 text-xs text-[#7A5C1A]">
                  PINs are revealed exactly once. Make sure to download the
                  CSV before closing the dialog — the cleartext PIN cannot be
                  recovered later.
                </div>
                {bulkModal.error && (
                  <div className="mt-3 rounded border border-[#9A3A2D]/30 bg-[#F9E1DA] px-3 py-2 text-xs text-[#9A3A2D]">
                    {bulkModal.error}
                  </div>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="ghost" onClick={closeBulkModal}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={submitBulk}>
                    Generate PINs
                  </Button>
                </div>
              </>
            )}

            {bulkModal.phase === "submitting" && (
              <div className="py-8 text-center text-sm text-[#6B7280]">
                Generating PINs...
              </div>
            )}

            {bulkModal.phase === "reveal" && (
              <>
                {bulkModal.generated.length === 0 ? (
                  <div className="rounded border border-[#E2DDD8] bg-[#FAF7F4] p-4 text-sm text-[#4B5563]">
                    No PINs needed to be generated — every active worker
                    already has one.
                  </div>
                ) : (
                  <>
                    <div className="rounded border border-[#E0B770]/40 bg-[#FBF3DF] px-3 py-2 text-xs text-[#7A5C1A]">
                      These PINs won&apos;t be shown again. Download the CSV
                      now and distribute to the workers.
                    </div>
                    <div className="mt-3 max-h-80 overflow-auto rounded border border-[#E2DDD8]">
                      <table className="w-full text-sm">
                        <thead className="bg-[#F3F4F6] text-xs uppercase tracking-wide text-[#6B7280]">
                          <tr>
                            <th className="px-3 py-2 text-left">Emp No</th>
                            <th className="px-3 py-2 text-left">Name</th>
                            <th className="px-3 py-2 text-left">PIN</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bulkModal.generated.map((g) => (
                            <tr
                              key={g.workerId}
                              className="border-t border-[#E2DDD8]"
                            >
                              <td className="px-3 py-1.5 font-medium text-[#6B5C32]">
                                {g.empNo}
                              </td>
                              <td className="px-3 py-1.5">{g.name}</td>
                              <td className="px-3 py-1.5 font-mono tracking-widest">
                                {g.pin}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {bulkModal.skipped > 0 && (
                      <div className="mt-2 text-xs text-[#6B7280]">
                        {bulkModal.skipped} worker(s) skipped (inactive or
                        not found).
                      </div>
                    )}
                  </>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  {bulkModal.generated.length > 0 && (
                    <Button variant="outline" onClick={downloadBulkCsv}>
                      <Download className="h-4 w-4" />
                      Download CSV
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={() => {
                      closeBulkModal();
                      refreshWorkers();
                    }}
                  >
                    Done
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ========== TAB 3: EFFICIENCY OVERVIEW ==========

// Hours-summary endpoint shape (mirrors GET /api/working-hour-entries/summary).
type WorkerHoursSummary = {
  workerId: string;
  totalHours: number;
  byDept: Record<string, number>;
  daysWithEntries: number;
};

function EfficiencyOverviewTab({
  workers,
  departments,
  onJumpToEmployeeDetail,
  onDateChange,
}: {
  workers: Worker[];
  departments: DepartmentLite[];
  // Double-clicking a row jumps to the Employee Performance tab with the
  // chosen worker preselected. Wired up at the EmployeesPage level — here we
  // just call back with the workerId.
  onJumpToEmployeeDetail?: (workerId: string) => void;
  onDateChange?: (from: string, to: string) => void;
}) {
  const { toast } = useToast();
  // Tablet/narrow-viewport breakpoint — used to default-hide the informational
  // Non-Prod Hrs column (Prod Hrs is the load-bearing one, the denominator of
  // Efficiency %; Non-Prod Hrs is the leftover that the operator can opt back
  // in via the Columns picker).
  const isTablet = useMediaQuery("(max-width: 1280px)");
  // Date range — defaults to single-day (today) so the date picker pops open
  // on the current month instead of jumping back 30 days. Last selection is
  // persisted in localStorage so revisiting the tab keeps the operator's
  // chosen window. Per-tab key avoids cross-tab interference.
  const [dateFrom, setDateFrom] = useState<string>(() =>
    readPersistedDateRange("employees:efficiency-overview:dateRange").from ?? todayStr()
  );
  const [dateTo, setDateTo] = useState<string>(() =>
    readPersistedDateRange("employees:efficiency-overview:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("employees:efficiency-overview:dateRange", dateFrom, dateTo);
    onDateChange?.(dateFrom, dateTo);
  }, [dateFrom, dateTo, onDateChange]);

  // Per-worker × per-dept hours pivot — mirrors the Google Sheet HOURS
  // DASHBOARD layout. Aggregation lives server-side (one SQL GROUP BY) so
  // this tab is just a thin renderer. Falls back to seed depts on first
  // render so the column layout doesn't reflow once /api/departments lands.
  const summaryUrl = `/api/working-hour-entries/summary?from=${dateFrom}&to=${dateTo}`;
  const { data: summaryResp, loading: summaryLoading } = useCachedJson<{ data?: WorkerHoursSummary[] }>(summaryUrl);
  const summary: WorkerHoursSummary[] = useMemo(
    () => summaryResp?.data ?? [],
    [summaryResp]
  );

  // Per-worker production-time aggregator — sum of job_cards.productionTimeMinutes
  // halved when both PIC slots are filled. Lets us render the Production Time
  // + Efficiency % columns alongside the existing working-hours pivot without
  // pulling every JC row to the client.
  const jcSummaryUrl = `/api/job-cards/summary?from=${dateFrom}&to=${dateTo}`;
  const { data: jcSummaryResp } = useCachedJson<{ data?: { workerId: string; productionMinutes: number; jcCount: number }[] }>(jcSummaryUrl);
  const prodMinsByWorker = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of jcSummaryResp?.data ?? []) {
      m.set(r.workerId, r.productionMinutes || 0);
    }
    return m;
  }, [jcSummaryResp]);

  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  // Render order: production depts first (in `sequence` order), then
  // non-production. Stable secondary sort by code keeps undefined sequences
  // from jumping around.
  const orderedDepts = useMemo(() => {
    const copy = [...allDepts];
    copy.sort((a, b) => {
      if (a.isProduction !== b.isProduction) return a.isProduction ? -1 : 1;
      const sa = a.sequence ?? 999;
      const sb = b.sequence ?? 999;
      if (sa !== sb) return sa - sb;
      return a.code.localeCompare(b.code);
    });
    return copy;
  }, [allDepts]);

  // Set of dept codes that count toward Efficiency % denominator. Per user
  // 2026-04-28: only time spent in PRODUCTION depts should count - hours
  // logged to Warehousing / Repair / Maintenance / Production Shortfall
  // are not "available production time" and shouldn't drag down the ratio.
  const productionDeptCodes = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDepts) if (d.isProduction) s.add(d.code);
    return s;
  }, [allDepts]);

  // Workers without any entries in the period are NOT in the summary
  // response — join client-side to enrich names, drop unknown ids.
  const workerById = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  type EffRow = WorkerHoursSummary & { employeeName: string; empNo: string };
  // Build the row list from the UNION of {workers in working_hour_entries
  // summary} and {workers with completed JCs}. Without the JC-only branch,
  // a worker who got marked PIC on a JC but never had hours entered on
  // the flat Working Hours grid was invisible here even though they had
  // production time - reported by user 2026-04-28.
  const rows: EffRow[] = useMemo(() => {
    const byWorker = new Map<string, EffRow>();
    for (const s of summary) {
      const w = workerById.get(s.workerId);
      byWorker.set(s.workerId, {
        ...s,
        employeeName: w?.name ?? s.workerId,
        empNo: w?.empNo ?? "",
      });
    }
    // Stub rows for JC-only workers (no working hour entries in range).
    // totalHours stays 0 and byDept stays empty so the dept columns just
    // render as em-dash; Production Time / Efficiency % populate via
    // prodMinsByWorker which already has them.
    for (const [wid] of prodMinsByWorker) {
      if (byWorker.has(wid)) continue;
      const w = workerById.get(wid);
      byWorker.set(wid, {
        workerId: wid,
        totalHours: 0,
        byDept: {},
        daysWithEntries: 0,
        employeeName: w?.name ?? wid,
        empNo: w?.empNo ?? "",
      });
    }
    // Default order = employee number ascending (EMP-001, EMP-002, …) so the
    // report opens in roster order; empNo is zero-padded so string sort is
    // numeric, blanks last. (Wei Siang 2026-06-08; was totalHours desc.)
    return Array.from(byWorker.values()).sort((a, b) =>
      (a.empNo || "~").localeCompare(b.empNo || "~"),
    );
  }, [summary, workerById, prodMinsByWorker]);

  const columns: Column<EffRow>[] = useMemo(() => {
    const cols: Column<EffRow>[] = [
      {
        key: "employeeName",
        label: "Employee",
        sortable: true,
        // Sort by employee NUMBER (EMP-001, EMP-002, …), not the display name —
        // Wei Siang 2026-06-08. empNo is zero-padded so a plain string sort is
        // already numeric order; blanks sort last. Cell still shows "EMP-NNN — Name".
        sortAccessor: (row) => row.empNo || "~",
        render: (_value, row) => (
          <span className="font-medium text-[#1F1D1B]">
            {row.empNo ? `${row.empNo} — ` : ""}
            {row.employeeName}
          </span>
        ),
      },
      {
        key: "totalHours",
        label: "Total",
        align: "right",
        sortable: true,
        // Inline `(<n>d)` subscript shows daysWithEntries alongside the
        // headline hours number. Operators were getting confused when the
        // selected range spans 5 weeks but Total reads ~70h - the subscript
        // makes the coverage visible at a glance ("73h / 7d entered out of
        // 38 calendar days"), which keeps Efficiency % readable when the
        // working_hour_entries grid hasn't been backfilled for the full range.
        render: (_value, row) =>
          row.totalHours > 0 ? (
            <span className="tabular-nums text-[#1F1D1B]">
              <span className="font-semibold">{row.totalHours.toFixed(1)}h</span>
              <span
                className="ml-1 text-[10px] text-[#9CA3AF]"
                title={`${row.daysWithEntries} day${row.daysWithEntries === 1 ? "" : "s"} with working_hour_entries in the selected range`}
              >
                ({row.daysWithEntries}d)
              </span>
            </span>
          ) : (
            <span className="text-[#D1D5DB] tabular-nums">—</span>
          ),
      },
      // Production Time — per-worker JC contribution sum (already halved
      // server-side when both PIC slots filled). Mirrors the Google Sheet
      // HOURS DASHBOARD column between "Total" and "Efficient".
      {
        key: "productionMinutes",
        label: "Production Time",
        align: "right",
        sortable: true,
        sortAccessor: (row) => prodMinsByWorker.get(row.workerId) ?? 0,
        render: (_value, row) => {
          const mins = prodMinsByWorker.get(row.workerId) ?? 0;
          if (mins <= 0) {
            return <span className="text-[#D1D5DB] tabular-nums">—</span>;
          }
          return (
            <span className="tabular-nums text-[#1F1D1B]">{formatHours(mins)}</span>
          );
        },
      },
      // Prod Hrs / Non-Prod Hrs — make the Efficiency % denominator visible.
      // The ratio formula is `prodMins / (prodHours * 60)`, where prodHours
      // counts ONLY production-dept hours (Fab Cut / Fab Sew / Foam / Wood
      // Cut / Framing / Webbing / Upholstery / Packing). Without these two
      // columns operators can't reconcile "Total Working Hrs 38h 30m" with
      // an efficiency ratio computed against 34h 30m — the 4h gap (Warehousing
      // / Repair / Maintenance / Production Shortfall) is invisible. Now the
      // math shows its work: Total = Prod Hrs + Non-Prod Hrs, and
      // Efficiency % = Production Time ÷ (Prod Hrs × 60).
      {
        key: "prodHours",
        label: "Prod Hrs",
        align: "right",
        sortable: true,
        sortAccessor: (row) =>
          Object.entries(row.byDept).reduce(
            (s, [code, h]) => (productionDeptCodes.has(code) ? s + h : s),
            0,
          ),
        render: (_value, row) => {
          const prodHours = Object.entries(row.byDept).reduce(
            (s, [code, h]) => (productionDeptCodes.has(code) ? s + h : s),
            0,
          );
          if (prodHours <= 0) {
            return <span className="text-[#D1D5DB] tabular-nums">—</span>;
          }
          return (
            <span
              className="tabular-nums text-[#1F1D1B]"
              title="Hours worked in production depts only — used as the denominator for Efficiency %"
            >
              {formatHours(Math.round(prodHours * 60))}
            </span>
          );
        },
      },
      {
        key: "nonProdHours",
        label: "Non-Prod Hrs",
        align: "right",
        sortable: true,
        defaultHidden: isTablet,
        sortAccessor: (row) =>
          Object.entries(row.byDept).reduce(
            (s, [code, h]) => (productionDeptCodes.has(code) ? s : s + h),
            0,
          ),
        render: (_value, row) => {
          const nonProdHours = Object.entries(row.byDept).reduce(
            (s, [code, h]) => (productionDeptCodes.has(code) ? s : s + h),
            0,
          );
          if (nonProdHours <= 0) {
            return <span className="text-[#D1D5DB] tabular-nums">—</span>;
          }
          return (
            <span
              className="tabular-nums text-[#9CA3AF]"
              title="Hours in Warehousing / Repair / Maintenance / Shortfall — not counted in Efficiency %"
            >
              {formatHours(Math.round(nonProdHours * 60))}
            </span>
          );
        },
      },
      // Efficiency % — Production output / Production-dept hours. Same
      // green/amber/red thresholds the Employee Performance KPI card uses
      // (>=85 green, >=70 amber, else red). Bug fix 2026-04-28: denominator
      // used to be row.totalHours (ALL depts), so a worker who spent 5h in
      // Warehousing + 4h in Upholstery had their efficiency divided by 9h
      // - now only the 4h Upholstery counts (production-dept time only).
      {
        key: "efficiencyPct",
        label: "Efficiency %",
        align: "right",
        sortable: true,
        sortAccessor: (row) => {
          // Mirror the render: production-dept hours only / 60 = denominator,
          // numerator = JC production minutes for this worker. When the
          // denominator is 0 (no production-dept hours OR no entries at all),
          // sort treats the row as -1 so they pile at the bottom in asc /
          // top in desc — distinct from real 0% efficiency rows.
          const prodHours = Object.entries(row.byDept).reduce(
            (s, [code, h]) => (productionDeptCodes.has(code) ? s + h : s),
            0,
          );
          if (prodHours <= 0 || row.daysWithEntries === 0) return -1;
          const prodMins = prodMinsByWorker.get(row.workerId) ?? 0;
          return (prodMins / (prodHours * 60)) * 100;
        },
        // Numerator vs denominator coverage is the killer caveat here:
        //   - prodMins  = sum of job_cards.completedDate within [from,to]
        //                 with the worker as PIC1/PIC2
        //   - prodHours = sum of working_hour_entries.date within [from,to]
        //                 in production depts only
        // The two come from DIFFERENT tables. If the operator picks a 5-week
        // range but has only entered working hours for the last 7 days, the
        // numerator covers 5 weeks while the denominator covers 1 week and
        // the ratio explodes (e.g. 30h prod / 7h working = 428% - reported
        // 2026-05-08). We can't intersect the two at the per-day level
        // without per-worker activity windows, but we CAN:
        //   1. show "—" when the worker has zero working_hour_entries in
        //      ANY dept in the range (was already there - keep), AND
        //   2. spell out both sides in the tooltip with the daysWithEntries
        //      coverage so the operator can spot the skew at a glance.
        render: (_value, row) => {
          const prodHours = Object.entries(row.byDept).reduce(
            (s, [code, h]) => (productionDeptCodes.has(code) ? s + h : s),
            0,
          );
          const totalMins = prodHours * 60;
          // Show em-dash when the denominator is zero - either because the
          // worker has no working_hour_entries at all in the range, or
          // because all their hours were in non-production depts.
          if (totalMins <= 0 || row.daysWithEntries === 0) {
            return (
              <span
                className="text-[#D1D5DB] tabular-nums"
                title={
                  row.daysWithEntries === 0
                    ? "No working_hour_entries logged for this worker in the selected range"
                    : "All hours in non-production depts (Warehousing / Repair / Maintenance / Shortfall)"
                }
              >
                —
              </span>
            );
          }
          const prodMins = prodMinsByWorker.get(row.workerId) ?? 0;
          const pct = (prodMins / totalMins) * 100;
          const cls =
            pct >= 85
              ? "text-[#4F7C3A]"
              : pct >= 70
              ? "text-[#9C6F1E]"
              : "text-[#9A3A2D]";
          return (
            <span
              className={`font-semibold tabular-nums ${cls}`}
              title={`${formatHours(prodMins)} production (job_cards) / ${prodHours.toFixed(1)}h in production depts (working_hour_entries, ${row.daysWithEntries}d entered)`}
            >
              {pct.toFixed(1)}%
            </span>
          );
        },
      },
    ];

    for (const d of orderedDepts) {
      cols.push({
        key: `dept_${d.code}`,
        label: d.shortName || d.name,
        align: "right",
        sortable: true,
        sortAccessor: (row) => row.byDept[d.code] ?? 0,
        render: (_value, row) => {
          const h = row.byDept[d.code] ?? 0;
          if (h <= 0) {
            return <span className="text-[#D1D5DB] tabular-nums">—</span>;
          }
          // Light green for production, light amber for non-prod —
          // makes the dept-mix visible at a glance, matching the
          // googlesheet HOURS DASHBOARD highlighting convention.
          const cls = d.isProduction
            ? "bg-[#EEF3E4] text-[#4F7C3A]"
            : "bg-[#FAEFCB] text-[#9C6F1E]";
          return (
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${cls}`}>
              {h.toFixed(1)}h
            </span>
          );
        },
      });
    }

    cols.push({
      key: "daysWithEntries",
      label: "Days",
      align: "center",
      sortable: true,
      render: (_value, row) => (
        <span className="tabular-nums text-[#4B5563]">{row.daysWithEntries}</span>
      ),
    });

    return cols;
  }, [orderedDepts, prodMinsByWorker, productionDeptCodes, isTablet]);

  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "View Details",
      icon: <Eye className="h-4 w-4" />,
      action: (row: EffRow) => {
        toast.info(`Viewing details for ${row.employeeName}`);
      },
    },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-4 w-4" />,
      action: () => { window.location.reload(); },
      separator: true,
    },
  ];

  // The DataGrid sorts/filters/searches its own internal copy; mirror that
  // result back here (via <DataGrid onFilteredDataChange>) so "Print Report"
  // prints EXACTLY what's on screen — the current sort + filter + search — not
  // the unsorted source rows.
  const [printRows, setPrintRows] = useState<EffRow[]>([]);

  // Print Report — mirrors the on-screen columns (Employee, Total, Production
  // Time, Prod Hrs, Non-Prod Hrs, Efficiency %, then each department's hours)
  // for the selected date range, computing the same derived values the grid
  // renders.
  const handlePrint = useCallback(() => {
    const prodHoursOf = (row: EffRow) =>
      Object.entries(row.byDept).reduce(
        (s, [code, h]) => (productionDeptCodes.has(code) ? s + h : s),
        0,
      );
    const nonProdHoursOf = (row: EffRow) =>
      Object.entries(row.byDept).reduce(
        (s, [code, h]) => (productionDeptCodes.has(code) ? s : s + h),
        0,
      );
    const columns: PrintColumn[] = [
      { header: "Employee", value: (r) => { const row = r as EffRow; return `${row.empNo ? `${row.empNo} — ` : ""}${row.employeeName}`; } },
      { header: "Total", align: "right", value: (r) => { const row = r as EffRow; return row.totalHours > 0 ? `${row.totalHours.toFixed(1)}h (${row.daysWithEntries}d)` : "—"; } },
      { header: "Production Time", align: "right", value: (r) => { const m = prodMinsByWorker.get((r as EffRow).workerId) ?? 0; return m > 0 ? formatHours(m) : "—"; } },
      { header: "Prod Hrs", align: "right", value: (r) => { const h = prodHoursOf(r as EffRow); return h > 0 ? formatHours(Math.round(h * 60)) : "—"; } },
      { header: "Non-Prod Hrs", align: "right", value: (r) => { const h = nonProdHoursOf(r as EffRow); return h > 0 ? formatHours(Math.round(h * 60)) : "—"; } },
      {
        header: "Efficiency %",
        align: "right",
        value: (r) => {
          const row = r as EffRow;
          const prodHours = prodHoursOf(row);
          if (prodHours <= 0 || row.daysWithEntries === 0) return "—";
          const prodMins = prodMinsByWorker.get(row.workerId) ?? 0;
          const pct = (prodMins / (prodHours * 60)) * 100;
          return { text: `${pct.toFixed(1)}%`, bold: true, color: pct >= 100 ? "#15803D" : pct >= 60 ? "#9C6F1E" : "#9A3A2D" };
        },
      },
    ];
    // Per-department hour columns are intentionally NOT printed — they make the
    // report extremely wide and are mostly blank. The on-screen grid still shows
    // them; the printed report keeps just the core efficiency columns + Days.
    columns.push({ header: "Days", align: "center", value: (r) => (r as EffRow).daysWithEntries });
    // Print the grid's CURRENT sorted + filtered rows (WYSIWYG); fall back to the
    // source rows on the first paint before the grid has echoed them.
    const printableRows = printRows.length ? printRows : rows;
    // KPI dashboard cards — computed over the visible rows.
    const present = printableRows.filter((r) => r.totalHours > 0).length;
    const totalHrs = printableRows.reduce((s, r) => s + r.totalHours, 0);
    const effVals = printableRows
      .map((r) => {
        const ph = prodHoursOf(r);
        if (ph <= 0 || r.daysWithEntries === 0) return null;
        const pm = prodMinsByWorker.get(r.workerId) ?? 0;
        return (pm / (ph * 60)) * 100;
      })
      .filter((v): v is number => v != null);
    const avgEff = effVals.length ? effVals.reduce((s, v) => s + v, 0) / effVals.length : 0;
    const cards: PrintCard[] = [
      { label: "Workers", value: String(printableRows.length) },
      { label: "Present", value: `${present} / ${printableRows.length}` },
      { label: "Total Working Hours", value: `${totalHrs.toFixed(1)}h` },
      { label: "Avg Efficiency", value: `${avgEff.toFixed(1)}%`, color: avgEff >= 100 ? "#15803D" : avgEff >= 60 ? "#9C6F1E" : "#9A3A2D" },
    ];
    printReport({
      title: "Efficiency Overview",
      filterSummary: dateRangeLabel(dateFrom, dateTo),
      orientation: "portrait",
      cards,
      sections: [{ columns, rows: printableRows }],
    });
  }, [rows, printRows, prodMinsByWorker, productionDeptCodes, dateFrom, dateTo]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-[#6B5C32]" /> Efficiency Overview
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">From</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">To</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <Button variant="outline" size="sm" onClick={handlePrint} title="Print the efficiency overview for the selected date range">
              <Printer className="h-4 w-4 mr-1" /> Print Report
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DataGrid
          columns={columns}
          data={rows}
          keyField="workerId"
          gridId="employees-efficiency"
          onFilteredDataChange={setPrintRows}
          contextMenuItems={contextMenuItems}
          onDoubleClick={(row) => {
            // Jump straight to the Employee Performance tab with this worker
            // preselected — saves a click vs. switching tabs + searching the
            // dropdown. Falls back to the previous toast if the parent didn't
            // wire the callback (defensive — shouldn't happen in practice).
            if (onJumpToEmployeeDetail) {
              onJumpToEmployeeDetail(row.workerId);
            } else {
              toast.info(`Viewing details for ${row.employeeName}`);
            }
          }}
          emptyMessage={summaryLoading ? "Loading…" : "No working hours recorded for the selected date range."}
        />
      </CardContent>
    </Card>
  );
}

// ========== TAB: DEPARTMENT LABOR ==========
//
// Per-department roll-up of working_hour_entries for a date range. Same
// math as the Labor Cost tab (pro-rata OT split per (worker x date),
// regularRate using calendar working days, OT base anchored at /26/9 x
// otMultiplier) - just collapses the category dimension so each dept is
// one row. Numbers reconcile exactly with Labor Cost: sum of all rows
// here for a category-unfiltered range = sum of all dept x category
// rows on Labor Cost for the same range.

type DepartmentLaborRow = {
  deptCode: string;
  deptName: string;
  isProduction: boolean;
  totalHours: number;
  workerCount: number;
  estCostSen: number;
  // Fully-loaded total (estCostSen) split into the part backed by logged work +
  // statutory + ÷-rate adjustment, and the under-recorded part (pay issued for
  // hours not yet logged). laborInclEpfSen + underRecordedSen = estCostSen.
  laborInclEpfSen: number;
  underRecordedSen: number;
  // Logged production labour cost split by product category (Sofa / Bedframe /
  // Accessory). These are the same per-(dept,category) figure the Labor Cost
  // tab's Production Breakdown shows; they sum to a bit LESS than laborInclEpfSen
  // because EPF/SOCSO/EIS isn't tied to a category. catTotalSen = the three summed.
  sofaSen: number;
  bedframeSen: number;
  accessorySen: number;
  catTotalSen: number;
};

function DepartmentLaborTab({
  workers,
  departments,
  refreshDepartments,
  onDateChange,
}: {
  workers: Worker[];
  departments: DepartmentLite[];
  refreshDepartments: () => void;
  onDateChange?: (from: string, to: string) => void;
}) {
  // Department CRUD - moved here from Labor Cost so departments live with
  // the dept-cost view. Toggle reveals the existing DepartmentsManager
  // component (create / edit / delete + worker-count guard).
  const [manageOpen, setManageOpen] = useState(false);
  // Same period model as Labor Cost: a Month dropdown is the quick-jump
  // preset; the From/To inputs allow custom ranges. Dropdown -> sets
  // dateFrom/dateTo to that month's bounds; touching the date inputs
  // drops period back to "" (Custom range). Last selection (period +
  // explicit from/to) is persisted in localStorage so the operator
  // resumes the same window when they revisit the tab — no more
  // calendar popups jumping back to a month they don't care about.
  const periodOptions = useMemo(() => buildPeriodOptions(), []);
  const persistedDeptLabor = useMemo(
    () => readPersistedDateRange("employees:department-labor:dateRange"),
    [],
  );
  const persistedDeptLaborPeriod = useMemo(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("employees:department-labor:period");
      return typeof raw === "string" ? raw : null;
    } catch {
      return null;
    }
  }, []);
  const [period, setPeriod] = useState<string>(
    () => persistedDeptLaborPeriod ?? (periodOptions[0]?.value ?? ""),
  );
  const initialRange = useMemo(
    () => periodToDateRange(periodOptions[0]?.value ?? ""),
    [periodOptions],
  );
  const [dateFrom, setDateFrom] = useState<string>(
    () => persistedDeptLabor.from ?? initialRange.from,
  );
  const [dateTo, setDateTo] = useState<string>(
    () => persistedDeptLabor.to ?? initialRange.to,
  );
  useEffect(() => {
    writePersistedDateRange("employees:department-labor:dateRange", dateFrom, dateTo);
    onDateChange?.(dateFrom, dateTo);
  }, [dateFrom, dateTo, onDateChange]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("employees:department-labor:period", period);
    } catch {
      /* non-fatal */
    }
  }, [period]);
  // Category filter mirrors Labor Cost: when set, only entries tagged with
  // that product category count toward dept totals. Non-production buckets
  // (Warehousing / Repair / Maintenance / Production Shortfall) carry an
  // empty category and ALWAYS show through so borrowed / idle hours stay
  // visible regardless of filter.
  const [categoryFilter, setCategoryFilter] = useState<"" | "SOFA" | "BEDFRAME" | "ACCESSORY">("");

  const onPickPeriod = (p: string) => {
    setPeriod(p);
    if (p) {
      const r = periodToDateRange(p);
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  };
  const onPickFrom = (v: string) => {
    setDateFrom(v);
    setPeriod("");
  };
  const onPickTo = (v: string) => {
    setDateTo(v);
    setPeriod("");
  };

  // Pull raw entries (same source as Labor Cost tab) so we can apply the
  // pro-rata OT split per (worker x date). The /summary endpoint groups
  // away the date dimension and would force an inaccurate flat hourly
  // rate - using the raw rows keeps the math identical to Labor Cost.
  const entriesUrl = `/api/working-hour-entries?from=${dateFrom}&to=${dateTo}`;
  const { data: entriesResp, loading } = useCachedJson<{ data?: WorkingHourEntry[] }>(entriesUrl);
  const entries: WorkingHourEntry[] = useMemo(
    () => entriesResp?.data ?? [],
    [entriesResp]
  );

  // Public holidays — drive the holiday-adjusted production-cost day rate.
  const { data: holidaysResp } = useCachedJson<{ data?: string[] }>(
    "/api/kv-config/public_holidays",
  );
  const holidayList = useMemo(
    () => (Array.isArray(holidaysResp?.data) ? holidaysResp.data : []),
    [holidaysResp],
  );

  const workerById = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  // Each worker's day-weighted EFFECTIVE salary for the period (same figure as
  // the Labor Cost tab + the payslips), so a mid-month raise costs each dept
  // correctly. With no salary change this equals the current scalar — a no-op.
  const deptSalaryPeriod = (period || dateFrom || "").slice(0, 7);
  const { data: effSalaryResp } = useCachedJson<{ data?: Record<string, number> }>(
    deptSalaryPeriod ? `/api/workers/salary/effective?period=${deptSalaryPeriod}` : null,
  );
  const effSalaryOf = useCallback(
    (w: { id: string; basicSalarySen: number }) => {
      const v = (effSalaryResp?.data ?? {})[w.id];
      return typeof v === "number" ? v : w.basicSalarySen;
    },
    [effSalaryResp],
  );

  // Payslips for the period — to FULLY-LOAD each department with its workers'
  // employer statutory + paid-but-not-logged (under-recorded) + the ÷26-vs-
  // ÷working-days absent-day gap, so Department Labor totals the FULL payroll
  // (= Payroll = Labor Cost). The clean trick: each worker's
  //   extra = (gross + employer statutory) − their logged-hours value
  // is added to their department; summed it equals total payroll − total logged
  // labor. Only for a full single month (payslips are monthly) with no category
  // filter (these extras aren't category- or partial-range-specific).
  const deptPayslipPeriod = (period || dateFrom || "").slice(0, 7);
  const { data: deptPayslipResp } = useCachedJson<unknown>(
    deptPayslipPeriod ? `/api/payslips?period=${deptPayslipPeriod}` : null,
  );
  const deptPayslips: PayslipData[] = useMemo(
    () => asArray(deptPayslipResp) as PayslipData[],
    [deptPayslipResp],
  );
  // Period late/short docks (Deduct / AUTO punch) — feeds the dock bridge in
  // the under-recorded gap, mirroring the Labor Cost tab.
  const { data: deptDeductionsResp } = useCachedJson<{
    data?: Array<{ workerId: string; hours: number }>;
  }>(deptPayslipPeriod ? `/api/payroll-hour-deductions?period=${deptPayslipPeriod}` : null);
  const deptDockHoursByWorker = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of deptDeductionsResp?.data ?? []) {
      m.set(r.workerId, (m.get(r.workerId) ?? 0) + (Number(r.hours) || 0));
    }
    return m;
  }, [deptDeductionsResp]);
  // Effective-dated pay rules (multipliers / hour divisor per date).
  const payRuleVersions = usePayRuleVersions();
  const deptFullMonth = isFullSingleMonth(dateFrom, dateTo);
  // Only fully-load (add statutory + under-recorded to tie to full payroll) once
  // the month is OVER. An in-progress month is still being logged, so it shows
  // the accumulating logged labor — it must NOT jump to the whole month's payroll.
  const deptMonthFinished = monthIsFinished(dateFrom.slice(0, 7));

  // Project onto the canonical departments list so non-production depts
  // (R&D, Warehousing, ...) show up even when they have zero hours, and
  // the row order matches Efficiency Overview (production first, in
  // sequence order).
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const orderedDepts = useMemo(() => {
    const copy = [...allDepts];
    copy.sort((a, b) => {
      if (a.isProduction !== b.isProduction) return a.isProduction ? -1 : 1;
      const sa = a.sequence ?? 999;
      const sb = b.sequence ?? 999;
      if (sa !== sb) return sa - sb;
      return a.code.localeCompare(b.code);
    });
    return copy;
  }, [allDepts]);

  const rows: DepartmentLaborRow[] = useMemo(() => {
    // Production-cost divisor = the ACTUAL Mon-Sat working days in this month
    // minus public holidays (mirrors labor-engine costingDivisor), NOT a fixed
    // 26. A holiday/short month costs each productive hour proportionally more.
    const [hYear, hMonth] = (period || dateFrom).slice(0, 7).split("-").map(Number);
    const actualWorkingDays =
      hYear && hMonth
        ? Math.max(
            1,
            countElapsedWorkingDays(hYear, hMonth, new Date(hYear, hMonth, 0).getDate(), holidayList),
          )
        : 26;

    // Group raw entries by (worker, date) so we can apply OT pro-rata
    // within each workday. Same shape as Labor Cost's segsByWorkerDate.
    const segsByWorkerDate = new Map<string, WorkingHourEntry[]>();
    for (const e of entries) {
      const k = `${e.workerId}|${e.date}`;
      const arr = segsByWorkerDate.get(k) ?? [];
      arr.push(e);
      segsByWorkerDate.set(k, arr);
    }

    const acc = new Map<string, { totalHours: number; workerIds: Set<string>; costSen: number; catSen: { SOFA: number; BEDFRAME: number; ACCESSORY: number } }>();
    // Per-worker logged-hours value (across all their depts) — drives each
    // worker's fully-loaded extra below.
    const loggedByWorker = new Map<string, number>();

    for (const [k, segs] of segsByWorkerDate.entries()) {
      const [workerId] = k.split("|");
      const w = workerById.get(workerId);
      if (!w || !w.basicSalarySen) continue;
      // Per-worker rates — OT threshold, hours/day and days/month all come
      // from this worker's own Employee Master figures (no hard-coded 9 h).
      // Regular day rate divides by (days − public holidays); the OT base
      // rate stays on the full ÷26 so OT pay matches payroll.
      const stdHours = w.workingHoursPerDay > 0 ? w.workingHoursPerDay : 9;
      const monthDays = w.workingDaysPerMonth > 0 ? w.workingDaysPerMonth : 26;
      const regularDays = actualWorkingDays;
      const effSalarySen = effSalaryOf(w);
      const regularRateSen = effSalarySen / regularDays / stdHours;
      const otBaseRateSen = effSalarySen / monthDays / stdHours;
      const otMult = w.otMultiplier ?? 1.5;
      const totalH = segs.reduce((s, e) => s + (Number(e.hours) || 0), 0);
      // Day-typed OT (owner spec 2026-06-10): Sunday → all hours at 2×, public
      // holiday → all hours at 3×, weekday → hours above the standard day at the
      // worker's multiplier — mirrors labor-engine.ts so cost ties to paid OT.
      const otDay = dayTypedOt(k.split("|")[1], holidayList, totalH, stdHours, otMult, payRuleVersions);
      const otShare = totalH > 0 ? otDay.otHours / totalH : 0;

      for (const e of segs) {
        const hours = Number(e.hours) || 0;
        const otH = hours * otShare;
        const regularH = hours - otH;
        const cost = regularH * regularRateSen + otH * otBaseRateSen * otDay.mult;
        // Same branch as Labor Cost: when a category filter is on, only
        // count entries tagged with that category; entries with empty
        // category (non-production depts) always pass through.
        const cat = (typeof e.category === "string" ? e.category.trim().toUpperCase() : "") as "" | "SOFA" | "BEDFRAME" | "ACCESSORY";
        if (categoryFilter && cat !== categoryFilter && cat !== "") continue;
        let cell = acc.get(e.departmentCode);
        if (!cell) {
          cell = { totalHours: 0, workerIds: new Set(), costSen: 0, catSen: { SOFA: 0, BEDFRAME: 0, ACCESSORY: 0 } };
          acc.set(e.departmentCode, cell);
        }
        cell.totalHours += hours;
        cell.workerIds.add(workerId);
        cell.costSen += cost;
        // Split the same logged production cost by product category so the
        // table can show Sofa / Bedframe / Accessory columns (entries with no
        // category — non-production depts — aren't attributed to any of them).
        if (cat === "SOFA" || cat === "BEDFRAME" || cat === "ACCESSORY") {
          cell.catSen[cat] += cost;
        }
        loggedByWorker.set(workerId, (loggedByWorker.get(workerId) ?? 0) + cost);
      }
    }

    // Fully-load each department: add every worker's (gross + employer statutory)
    // − their logged value to their department, so the column total ties to the
    // full payroll (= Payroll = Labor Cost's Total Payroll Cost). Σ extras =
    // total gross + total employer − total logged labor = the non-logged-labor
    // remainder (under-recorded + ÷-rate gap + statutory). Full month, no filter.
    //
    // We also split each department's loaded cost into its UNDER-RECORDED part
    // (pay issued for hours not yet logged) and the rest, using the SAME
    // per-worker gap the Labor Cost tab itemises: gap = gross − logged − absent-
    // day adjustment, counted only for factory-department workers with a
    // material gap (> RM0.50). This is the figure the owner can close by
    // recording hours (or deducting) — so it matches Labor Cost's Under-recorded.
    const underByDept = new Map<string, number>();
    if (deptFullMonth && !categoryFilter && deptMonthFinished) {
      // "Factory dept" = any known department (office / sales etc. that log no
      // hours are excluded as a data gap — mirrors the Labor Cost tab).
      const factoryCodes = new Set(allDepts.map((d) => d.code));
      for (const p of deptPayslips) {
        const wid = p.employeeId;
        if (!wid) continue;
        const gross = Number(p.grossPay) || 0;
        const statutory =
          (Number(p.epfEmployer) || 0) +
          (Number(p.socsoEmployer) || 0) +
          (Number(p.eisEmployer) || 0);
        const extra = gross + statutory - (loggedByWorker.get(wid) ?? 0);
        const deptCode =
          p.departmentCode || workerById.get(wid)?.departmentCode || "UNASSIGNED";
        if (extra !== 0) {
          let cell = acc.get(deptCode);
          if (!cell) {
            cell = { totalHours: 0, workerIds: new Set(), costSen: 0, catSen: { SOFA: 0, BEDFRAME: 0, ACCESSORY: 0 } };
            acc.set(deptCode, cell);
          }
          // The fully-loaded extra (gross + employer statutory − logged) is NOT
          // category-specific, so it lifts costSen only — never catSen.
          cell.costSen += extra;
          cell.workerIds.add(wid);
        }
        // Under-recorded gap for this worker — factory depts only. Resolve the
        // department EXACTLY as the Labor Cost tab does (payslip's own code, no
        // worker fallback) so both tabs' Under-recorded totals tie out: a payslip
        // with no department is treated as non-production there, so we skip it
        // here too rather than attributing a gap via the worker's home dept.
        const reconCode = p.departmentCode || "UNASSIGNED";
        if (gross > 0 && factoryCodes.has(reconCode)) {
          const absent = Number(p.absentDays) || 0;
          // UNIFIED ÷26 model (owner 2026-06-11) — same signed bridge as the
          // Labor Cost tab: absence docks ÷26 (the stored deduction), cost
          // loses ÷working-days; the difference goes to the dept line.
          const costEquivalent =
            absent > 0
              ? Math.round(
                  (absent * (Number(p.basicSalary) || 0)) / actualWorkingDays,
                )
              : 0;
          const leniency = costEquivalent - (Number(p.absenceDeductionSen) || 0);
          // OT pay-vs-cost adjustment (same as the Labor Cost tab): OT is COSTED at
          // ÷26÷9 but PAID at the stored payslip OT (÷10). Remove that difference
          // from the gap so it stays pure under-recorded hours. (The dept TOTAL
          // already reflects the paid OT via the gross+statutory `extra` above.)
          const ow = workerById.get(wid);
          // Day-typed OT cost at ÷stdHours (weekday×mult + Sunday×2 + holiday×3),
          // matching the logged bucket; otAdj bridges to the day-typed paid OT so
          // the gap stays pure under-recorded hours.
          const owMult = ow && ow.otMultiplier && ow.otMultiplier > 0 ? ow.otMultiplier : 1.5;
          const owStd = ow && ow.workingHoursPerDay > 0 ? ow.workingHoursPerDay : 9;
          const owDays = ow && ow.workingDaysPerMonth > 0 ? ow.workingDaysPerMonth : 26;
          // Effective-dated Sunday/holiday multipliers — as of this payslip's
          // period end (the rules that produced the stored OT).
          const [bdY, bdM] = (p.period || "").split("-").map(Number);
          const cfgDeptEnd = resolvePayRulesAsOf(
            payRuleVersions,
            bdY && bdM
              ? `${p.period}-${String(new Date(bdY, bdM, 0).getDate()).padStart(2, "0")}`
              : "9999-12-31",
          );
          const otCostSen = Math.round(
            ((Number(p.otWeekdayHours) || 0) * owMult +
              (Number(p.otSundayHours) || 0) * cfgDeptEnd.sundayOtMultiplier +
              (Number(p.otPHHours) || 0) * cfgDeptEnd.holidayOtMultiplier) *
              ((Number(p.basicSalary) || 0) / owDays / owStd),
          );
          const otAdj = (Number(p.totalOT) || 0) - otCostSen;
          // Round each worker's gap to whole sen BEFORE summing — identical to
          // the Labor Cost tab — so per-dept rows add up to the same grand total
          // both tabs show (no per-department rounding drift).
          // Late/short dock bridge — mirrors the Labor Cost tab: a docked hour
          // shrinks gross at the UNIFIED pay rate (S ÷ 26 ÷ 10) while the gap
          // measures it at the costing rate (S ÷ working days ÷ std); without
          // the bridge a Deduct leaves ~RM5/h flagged as under-recorded.
          const dockH = deptDockHoursByWorker.get(wid) ?? 0;
          let lateAdj = 0;
          if (dockH > 0) {
            const S = Number(p.basicSalary) || 0;
            // Same DAY rate + hour divisor the engine docks with (mode-aware).
            const dockDayRate = payrollDayRateSen(
              S,
              {
                workingDaysPerMonth: owDays,
                calendarDays: bdY && bdM ? new Date(bdY, bdM, 0).getDate() : 30,
                workingDaysInMonth: actualWorkingDays,
              },
              cfgDeptEnd,
            );
            lateAdj = Math.max(
              0,
              Math.round((dockH * S) / actualWorkingDays / owStd) -
                Math.round(
                  (dockH * dockDayRate) / payrollHourDivisor(ow?.workingHoursPerDay, cfgDeptEnd),
                ),
            );
          }
          // Exclude the efficiency allowance (a flat bonus, not logged hours) so
          // it doesn't show as a spurious "under-recorded" gap — same as the
          // Labor Cost tab. The dept's `extra` above still carries the bonus cost.
          const gap = Math.round(gross - (loggedByWorker.get(wid) ?? 0) - leniency - otAdj - lateAdj - (Number(p.allowances) || 0));
          if (gap > 50) underByDept.set(reconCode, (underByDept.get(reconCode) ?? 0) + gap);
        }
      }
    }

    const shownCodes = new Set(orderedDepts.map((d) => d.code));
    const orderedRows = orderedDepts.map((d) => {
      const cell = acc.get(d.code);
      const estCostSen = roundSen(cell?.costSen ?? 0);
      const underRecordedSen = roundSen(underByDept.get(d.code) ?? 0);
      const sofaSen = roundSen(cell?.catSen.SOFA ?? 0);
      const bedframeSen = roundSen(cell?.catSen.BEDFRAME ?? 0);
      const accessorySen = roundSen(cell?.catSen.ACCESSORY ?? 0);
      return {
        deptCode: d.code,
        deptName: d.shortName || d.name,
        isProduction: d.isProduction,
        totalHours: cell?.totalHours ?? 0,
        workerCount: cell?.workerIds.size ?? 0,
        estCostSen,
        underRecordedSen,
        laborInclEpfSen: estCostSen - underRecordedSen,
        sofaSen,
        bedframeSen,
        accessorySen,
        catTotalSen: sofaSen + bedframeSen + accessorySen,
      };
    });
    // Any cost parked on a dept not in the canonical list (e.g. an unassigned
    // worker's loaded extra) — append so the total still ties to full payroll.
    const extraRows = [...acc.entries()]
      .filter(([code, cell]) => !shownCodes.has(code) && roundSen(cell.costSen) !== 0)
      .map(([code, cell]) => {
        const estCostSen = roundSen(cell.costSen);
        const underRecordedSen = roundSen(underByDept.get(code) ?? 0);
        const sofaSen = roundSen(cell.catSen.SOFA);
        const bedframeSen = roundSen(cell.catSen.BEDFRAME);
        const accessorySen = roundSen(cell.catSen.ACCESSORY);
        return {
          deptCode: code,
          deptName: code || "Unassigned",
          isProduction: false,
          totalHours: cell.totalHours,
          workerCount: cell.workerIds.size,
          estCostSen,
          underRecordedSen,
          laborInclEpfSen: estCostSen - underRecordedSen,
          sofaSen,
          bedframeSen,
          accessorySen,
          catTotalSen: sofaSen + bedframeSen + accessorySen,
        };
      });
    const allRows = [...orderedRows, ...extraRows];

    // Make the rows add up EXACTLY to the integer Total Payroll Cost (Σ gross +
    // employer EPF/SOCSO/EIS) the Payroll + Labor Cost tabs show — using the
    // shared largest-remainder distributor (distributeRoundSen), the SAME
    // rounding convention used across the app, NOT an ad-hoc plug. Each dept's
    // fractional-sen cost is rounded so the leftover sen land on the largest-
    // fraction departments and the column ties to Payroll to the sen. Only when
    // fully loaded (full finished month, no category filter); otherwise the
    // per-dept nearest-sen values stand (no payroll total to tie to).
    // Under-recorded is already tied per-worker and is left untouched.
    const fullyLoaded = deptFullMonth && !categoryFilter && deptMonthFinished;
    if (fullyLoaded && allRows.length) {
      let payrollTotalSen = 0;
      for (const p of deptPayslips) {
        payrollTotalSen +=
          roundSen(Number(p.grossPay) || 0) +
          roundSen(Number(p.epfEmployer) || 0) +
          roundSen(Number(p.socsoEmployer) || 0) +
          roundSen(Number(p.eisEmployer) || 0);
      }
      const tied = distributeRoundSen(
        allRows.map((r) => acc.get(r.deptCode)?.costSen ?? 0),
        payrollTotalSen,
      );
      allRows.forEach((r, i) => {
        r.estCostSen = tied[i];
        r.laborInclEpfSen = r.estCostSen - r.underRecordedSen;
      });
    }
    return allRows;
  }, [entries, workerById, orderedDepts, allDepts, period, dateFrom, dateTo, categoryFilter, holidayList, effSalaryOf, deptPayslips, deptFullMonth, deptMonthFinished, deptDockHoursByWorker, deptPayslipPeriod, payRuleVersions]);

  const totals = useMemo(() => {
    return rows.reduce(
      (a, r) => ({
        hours: a.hours + r.totalHours,
        cost: a.cost + r.estCostSen,
        labor: a.labor + r.laborInclEpfSen,
        under: a.under + r.underRecordedSen,
        depts: a.depts + (r.totalHours > 0 ? 1 : 0),
      }),
      { hours: 0, cost: 0, labor: 0, under: 0, depts: 0 },
    );
  }, [rows]);

  // The fully-loaded total only splits into Labor / Under-recorded for a full
  // single month with no category filter (same guard as the loading itself).
  const splitVisible = deptFullMonth && !categoryFilter && deptMonthFinished;
  const columns: Column<DepartmentLaborRow>[] = [
    {
      key: "deptName",
      label: "Department",
      sortable: true,
      render: (_v, row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-[#1F1D1B]">{row.deptName}</span>
          {row.isProduction ? (
            <span className="inline-flex items-center rounded bg-[#EEF3E4] px-1.5 py-0.5 text-[10px] font-medium text-[#4F7C3A]">
              Prod
            </span>
          ) : (
            <span className="inline-flex items-center rounded bg-[#FAEFCB] px-1.5 py-0.5 text-[10px] font-medium text-[#9C6F1E]">
              Non-prod
            </span>
          )}
        </div>
      ),
    },
    {
      key: "totalHours",
      label: "Total Hours",
      align: "right",
      sortable: true,
      render: (_v, row) =>
        row.totalHours > 0 ? (
          <span className="font-semibold tabular-nums text-[#1F1D1B]">
            {row.totalHours.toFixed(1)}h
          </span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "workerCount",
      label: "Workers",
      align: "center",
      sortable: true,
      render: (_v, row) =>
        row.workerCount > 0 ? (
          <span className="tabular-nums text-[#4B5563]">{row.workerCount}</span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "sofaSen",
      label: "Sofa",
      align: "right",
      sortable: true,
      render: (_v, row) =>
        row.sofaSen > 0 ? (
          <span className="tabular-nums text-[#4B5563]">{formatRM(row.sofaSen)}</span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "bedframeSen",
      label: "Bedframe",
      align: "right",
      sortable: true,
      render: (_v, row) =>
        row.bedframeSen > 0 ? (
          <span className="tabular-nums text-[#4B5563]">{formatRM(row.bedframeSen)}</span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "accessorySen",
      label: "Accessory",
      align: "right",
      sortable: true,
      render: (_v, row) =>
        row.accessorySen > 0 ? (
          <span className="tabular-nums text-[#4B5563]">{formatRM(row.accessorySen)}</span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "catTotalSen",
      label: "Category Total",
      align: "right",
      sortable: true,
      render: (_v, row) =>
        row.catTotalSen > 0 ? (
          <span className="font-medium tabular-nums text-[#1F1D1B]">{formatRM(row.catTotalSen)}</span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "laborInclEpfSen",
      label: "Labor (incl. EPF)",
      align: "right",
      sortable: true,
      hidden: !splitVisible,
      render: (_v, row) =>
        row.laborInclEpfSen > 0 ? (
          <span className="font-medium tabular-nums text-[#1F1D1B]">
            {formatRM(row.laborInclEpfSen)}
          </span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "underRecordedSen",
      label: "Under-recorded",
      align: "right",
      sortable: true,
      hidden: !splitVisible,
      render: (_v, row) =>
        row.underRecordedSen > 0 ? (
          <span
            className="font-medium tabular-nums text-[#9A3A2D]"
            title="Pay already issued to this department's workers for hours not yet entered in Working Hours. Record (or deduct) those hours on the Labor Cost tab to clear it."
          >
            {formatRM(row.underRecordedSen)}
          </span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
    {
      key: "estCostSen",
      label: splitVisible ? "Total" : "Estimated Labor Cost",
      align: "right",
      sortable: true,
      render: (_v, row) =>
        row.estCostSen > 0 ? (
          <span className="font-semibold tabular-nums text-[#1F1D1B]">
            {formatRM(row.estCostSen)}
          </span>
        ) : (
          <span className="text-[#D1D5DB] tabular-nums">—</span>
        ),
    },
  ];

  // The DataGrid sorts/filters/searches its own copy; mirror that result back
  // here (via <DataGrid onFilteredDataChange>) so "Print Report" prints EXACTLY
  // what's on screen — the current sort + filter — not the unsorted source rows.
  const [printRows, setPrintRows] = useState<DepartmentLaborRow[]>([]);

  // Print Report — mirrors the on-screen department-labor columns for the
  // selected period + category, including the Sofa / Bedframe / Accessory split.
  // The Labor (incl. EPF) / Under-recorded columns print only when they're
  // visible on screen (a full finished month, no category filter).
  const handlePrint = useCallback(() => {
    const columns: PrintColumn[] = [
      { header: "Department", value: (r) => { const row = r as DepartmentLaborRow; return `${row.deptName} (${row.isProduction ? "Prod" : "Non-prod"})`; } },
      { header: "Total Hours", align: "right", value: (r) => { const h = (r as DepartmentLaborRow).totalHours; return h > 0 ? `${h.toFixed(1)}h` : "—"; } },
      { header: "Workers", align: "center", value: (r) => { const n = (r as DepartmentLaborRow).workerCount; return n > 0 ? n : "—"; } },
      { header: "Sofa", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).sofaSen; return v > 0 ? formatRM(v) : "—"; } },
      { header: "Bedframe", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).bedframeSen; return v > 0 ? formatRM(v) : "—"; } },
      { header: "Accessory", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).accessorySen; return v > 0 ? formatRM(v) : "—"; } },
      { header: "Category Total", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).catTotalSen; return v > 0 ? formatRM(v) : "—"; } },
    ];
    if (splitVisible) {
      columns.push(
        { header: "Labor (incl. EPF)", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).laborInclEpfSen; return v > 0 ? formatRM(v) : "—"; } },
        { header: "Under-recorded", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).underRecordedSen; return v > 0 ? formatRM(v) : "—"; } },
      );
    }
    columns.push({ header: splitVisible ? "Total" : "Estimated Labor Cost", align: "right", value: (r) => { const v = (r as DepartmentLaborRow).estCostSen; return v > 0 ? formatRM(v) : "—"; } });
    const catLabel = categoryFilter
      ? categoryFilter[0] + categoryFilter.slice(1).toLowerCase()
      : "All categories";
    printReport({
      title: "Department Labor",
      filterSummary: `${dateRangeLabel(dateFrom, dateTo)} · ${catLabel}`,
      columns,
      // Print the grid's CURRENT sorted + filtered rows (WYSIWYG); fall back to
      // the source rows before the grid has echoed them.
      rows: printRows.length ? printRows : rows,
      orientation: "landscape",
    });
  }, [rows, printRows, splitVisible, categoryFilter, dateFrom, dateTo]);

  // Printable department QR poster (owner 2026-06-11 v2): production
  // departments get ONE CARD PER LINE (Sofa / Bedframe / Accessory) so the
  // scan captures the line, not just the department — per-person labor and
  // efficiency attribution. Non-production departments (Warehousing / Repair
  // / Maintenance / R&D) get a single card. Workers scan when they start
  // work and whenever they switch line or department; punch-out ends it.
  // PRODUCTION_SHORTFALL is a virtual bucket, not a place, so it's skipped.
  const printDeptQrPoster = useCallback(async () => {
    try {
      const res = await fetch("/api/departments");
      const j = (await res.json().catch(() => ({}))) as {
        data?: Array<{ code?: string; name?: string; shortName?: string; isProduction?: boolean | number }>;
      };
      const depts = (j?.data ?? []).filter(
        (d) => d.code && d.code !== "PRODUCTION_SHORTFALL",
      );
      if (depts.length === 0) return;
      // Canonical origin so printed dept-QR cards show erp.hookka.com on prod.
      const origin = appOrigin();
      const CATS = ["SOFA", "BEDFRAME", "ACCESSORY"] as const;
      const wanted: Array<{ code: string; label: string; cat: string | null }> = [];
      for (const d of depts) {
        const base = { code: d.code as string, label: d.shortName || d.name || (d.code as string) };
        if (d.isProduction) {
          for (const cat of CATS) wanted.push({ ...base, cat });
        } else {
          wanted.push({ ...base, cat: null });
        }
      }
      const cards = await Promise.all(
        wanted.map(async (cdef) => ({
          ...cdef,
          // 1000px → crisp at the full-page 130mm print size.
          qr: await getQRCodeDataURL(
            `${origin}/worker/scan?deptscan=${encodeURIComponent(cdef.code)}${cdef.cat ? `&deptcat=${encodeURIComponent(cdef.cat)}` : ""}`,
            1000,
          ),
        })),
      );
      const catLabel = (cat: string | null) =>
        cat ? cat.charAt(0) + cat.slice(1).toLowerCase() : "";
      const cardsHtml = cards
        .map(
          (cd) => `
        <div class="card">
          <div class="dept">${cd.label}</div>
          ${cd.cat ? `<div class="cat cat-${cd.cat.toLowerCase()}">${catLabel(cd.cat)}</div>` : ""}
          <div class="code">${cd.code}${cd.cat ? ` · ${cd.cat}` : ""}</div>
          <img src="${cd.qr}" alt="${cd.code}${cd.cat ? "-" + cd.cat : ""}" />
          <div class="hint">Scan with the Worker Portal when you START working ${cd.cat ? `on the <b>${catLabel(cd.cat)}</b> line here` : "in this department"}.<br/>Scan again when you switch line or department · punching out ends it.</div>
        </div>`,
        )
        .join("");
      const w = window.open("", "_blank");
      if (!w) return;
      // One card per FULL A4 page (owner 2026-06-12: "每一个都是 A4 size") —
      // poster-sized name + ~13cm QR, scannable from arm's length on the wall.
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Department QR Codes - Hookka</title>
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #1F1D1B; }
          .card { border: 2px solid #1F1D1B; border-radius: 6mm; padding: 12mm; text-align: center;
                  min-height: 270mm; display: flex; flex-direction: column; align-items: center;
                  justify-content: center; gap: 6mm; page-break-after: always; }
          .card:last-child { page-break-after: auto; }
          .dept { font-size: 48pt; font-weight: 800; line-height: 1.1; }
          .cat { display: inline-block; padding: 2mm 10mm; border: 2px solid #1F1D1B; border-radius: 10mm; font-size: 26pt; font-weight: 800; letter-spacing: 2px; }
          .cat-sofa { background: #E8EEF0; }
          .cat-bedframe { background: #F0EAE0; }
          .cat-accessory { background: #ECECEC; }
          .code { font-size: 14pt; color: #6B7280; letter-spacing: 2px; }
          img { width: 130mm; height: 130mm; }
          .hint { font-size: 13pt; color: #4B5563; line-height: 1.5; max-width: 150mm; }
        </style></head><body>
        ${cardsHtml}
        <script>window.onload = () => setTimeout(() => window.print(), 250);</script>
        </body></html>`);
      w.document.close();
    } catch {
      /* poster is a convenience — never crash the tab */
    }
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-[#6B5C32]" /> Department Labor
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setManageOpen((v) => !v)}
              title="Create / edit / delete departments"
            >
              <Users className="h-4 w-4" />
              {manageOpen ? "Close Manage Departments" : "Manage Departments"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={printDeptQrPoster}
              title="Print one QR per department — workers scan it when they start working there; hours auto-split by department"
            >
              <Printer className="h-4 w-4" />
              Dept QR Codes
            </Button>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">Month</label>
              <select
                value={period}
                onChange={(e) => onPickPeriod(e.target.value)}
                className="h-8 rounded border border-[#E2DDD8] bg-white px-2 text-xs"
              >
                <option value="">Custom range</option>
                {periodOptions.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">From</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => onPickFrom(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">To</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => onPickTo(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">Category</label>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as "" | "SOFA" | "BEDFRAME" | "ACCESSORY")}
                className="h-8 rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                title="Slice every dept's hours / cost by item category"
              >
                <option value="">All categories</option>
                <option value="SOFA">Sofa</option>
                <option value="BEDFRAME">Bedframe</option>
                <option value="ACCESSORY">Accessory</option>
              </select>
            </div>
            <Button variant="outline" size="sm" onClick={handlePrint} title="Print the department labor breakdown for the selected period">
              <Printer className="h-4 w-4 mr-1" /> Print Report
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {manageOpen && (
          <DepartmentsManager
            departments={allDepts}
            refresh={refreshDepartments}
          />
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-[#E2DDD8] bg-[#FAF9F7] p-3">
            <div className="text-xs text-[#6B7280]">Departments with activity</div>
            <div className="mt-1 text-lg font-semibold text-[#1F1D1B]">{totals.depts}</div>
          </div>
          <div className="rounded-lg border border-[#E2DDD8] bg-[#FAF9F7] p-3">
            <div className="text-xs text-[#6B7280]">Total hours</div>
            <div className="mt-1 text-lg font-semibold text-[#1F1D1B]">
              {totals.hours.toFixed(1)}h
            </div>
          </div>
          <div className="rounded-lg border border-[#E2DDD8] bg-[#FAF9F7] p-3">
            <div className="text-xs text-[#6B7280]">Estimated labor cost</div>
            <div className="mt-1 text-lg font-semibold text-[#1F1D1B]">
              {formatRM(totals.cost)}
            </div>
            {splitVisible && (
              <div className="mt-0.5 text-[10px] text-[#6B7280]">
                Fully loaded (incl. EPF) — matches Payroll
                {totals.under > 0 && (
                  <>
                    {" · "}
                    <span className="text-[#9A3A2D]">
                      {formatRM(totals.under)} under-recorded
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <DataGrid
          columns={columns}
          data={rows}
          keyField="deptCode"
          gridId="department-labor"
          onFilteredDataChange={setPrintRows}
          emptyMessage={loading ? "Loading..." : "No working hours in the selected date range."}
        />
        {/* TOTAL row mirrors the top metric cards — added 2026-05-06 per
            user request "添加 total labor 让我看到数额". Appears below the
            grid as a prominent strip so the labor cost grand total is
            visible alongside the per-department breakdown without forcing
            the operator to scroll back to the top metric tiles. */}
        {rows.length > 0 && (
          <div className="mt-2 grid grid-cols-12 items-center rounded-lg border border-[#6B5C32]/30 bg-[#FAF7F0] px-4 py-3 text-sm font-semibold text-[#1F1D1B]">
            {splitVisible ? (
              <>
                <div className="col-span-4 flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-[#6B5C32]" />
                  <span>TOTAL</span>
                  <span className="text-xs font-normal text-[#6B7280]">
                    ({totals.depts} dept{totals.depts === 1 ? "" : "s"} with activity)
                  </span>
                </div>
                <div className="col-span-2 text-right tabular-nums">
                  {totals.hours.toFixed(1)}h
                </div>
                <div className="col-span-2 text-right tabular-nums text-[#1F1D1B]">
                  {formatRM(totals.labor)}
                </div>
                <div className="col-span-2 text-right tabular-nums text-[#9A3A2D]">
                  {totals.under > 0 ? formatRM(totals.under) : "—"}
                </div>
                <div className="col-span-2 text-right tabular-nums text-[#6B5C32]">
                  {formatRM(totals.cost)}
                </div>
              </>
            ) : (
              <>
                <div className="col-span-5 flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-[#6B5C32]" />
                  <span>TOTAL</span>
                  <span className="text-xs font-normal text-[#6B7280]">
                    ({totals.depts} dept{totals.depts === 1 ? "" : "s"} with activity)
                  </span>
                </div>
                <div className="col-span-3 text-right tabular-nums">
                  {totals.hours.toFixed(1)}h
                </div>
                <div className="col-span-1 text-center text-[#6B7280]">—</div>
                <div className="col-span-3 text-right tabular-nums text-[#6B5C32]">
                  {formatRM(totals.cost)}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ========== TAB 4: EMPLOYEE DETAIL ==========

type WorkerJobCardRow = {
  id: string;
  productionOrderId: string;
  poNo: string;
  productCode: string;
  departmentCode: string;
  wipCode: string;
  wipLabel: string;
  wipQty?: number;
  completedDate: string | null;
  // productionTimeMinutes = perUnit x wipQty (the actual time the worker
  // spent on this JC). perUnitMinutes is the BOM-defined per-unit value
  // alongside it so the Daily Breakdown can show "15 min x 2 = 30 min".
  productionTimeMinutes: number;
  perUnitMinutes?: number;
  status: string;
  picSlot: "PIC1" | "PIC2" | "";
  // True when both PIC1 and PIC2 are filled on this JC. Halve the
  // worker's contribution to total Production Hrs only in that case;
  // a solo PIC (either slot, no partner) gets the full minutes.
  hasBothPics?: boolean;
};

function EmployeeDetailTab({
  workers,
  departments,
  initialWorkerId,
  onDateChange,
}: {
  workers: Worker[];
  departments: DepartmentLite[];
  // When the operator double-clicks a row on the Efficiency Overview tab the
  // page passes the chosen workerId in here so the dropdown lands on that
  // worker on first render. The parent gates this tab with
  // {activeTab === "detail" && <EmployeeDetailTab ... />}, so switching away
  // and back unmounts + remounts us — meaning a fresh initialWorkerId is
  // always honored as the starting selection.
  initialWorkerId?: string;
  onDateChange?: (from: string, to: string) => void;
}) {
  // Production dept codes for the Avg Efficiency denominator. Per user
  // 2026-04-28: only time spent in PRODUCTION depts counts as "available
  // for production" - hours in Warehousing / Repair / Maintenance get
  // excluded so the ratio doesn't dilute. Falls back to the seed set if
  // /api/departments hasn't loaded yet so the KPI doesn't flash 0%.
  const productionDeptCodes = useMemo(() => {
    if (departments.length === 0) return PRODUCTION_DEPT_CODES;
    const s = new Set<string>();
    for (const d of departments) if (d.isProduction) s.add(d.code);
    return s;
  }, [departments]);
  const { toast } = useToast();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(
    initialWorkerId || workers[0]?.id || ""
  );
  // Date range — defaults to single-day (today) so the picker lands on the
  // current month. Persisted per-tab in localStorage so reopening the tab
  // restores the operator's last window without forcing them to re-pick.
  const [dateFrom, setDateFrom] = useState<string>(() =>
    readPersistedDateRange("employees:employee-detail:dateRange").from ?? todayStr()
  );
  const [dateTo, setDateTo] = useState<string>(() =>
    readPersistedDateRange("employees:employee-detail:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("employees:employee-detail:dateRange", dateFrom, dateTo);
    onDateChange?.(dateFrom, dateTo);
  }, [dateFrom, dateTo, onDateChange]);

  const selectedWorker = workers.find((w) => w.id === selectedEmployeeId);

  // SECOND data source — completed job_cards where the worker is PIC1 or PIC2.
  // Workers who do real production work but never get explicit attendance
  // punches (operator forgets to log clock-in/out) used to show up as zero on
  // this page even when they were on dozens of completed JCs. This pulls
  // those rows so the Daily Breakdown table merges both signals.
  const jcUrl = selectedEmployeeId
    ? `/api/job-cards?picId=${encodeURIComponent(selectedEmployeeId)}&from=${dateFrom}&to=${dateTo}`
    : "";
  const { data: jcResp } = useCachedJson<{ data?: WorkerJobCardRow[] }>(jcUrl);
  const workerJcs: WorkerJobCardRow[] = useMemo(
    () => (jcResp?.data ?? []),
    [jcResp]
  );

  // THIRD data source — working_hour_entries for this worker. The Working
  // Hrs and Days Present KPIs read from here (not attendance_records.
  // workingMinutes), because the new flat Working Hours grid writes hours
  // here while only stub-creating a PRESENT attendance row with
  // workingMinutes=0. Without this, supervisors entering 9h on the new
  // grid saw "0h working" on the worker's detail page.
  const wheUrl = selectedEmployeeId
    ? `/api/working-hour-entries?workerId=${encodeURIComponent(selectedEmployeeId)}&from=${dateFrom}&to=${dateTo}`
    : "";
  const { data: wheResp } = useCachedJson<{ data?: WorkingHourEntry[] }>(wheUrl);
  const workerEntries: WorkingHourEntry[] = useMemo(
    () => (wheResp?.data ?? []),
    [wheResp]
  );

  // FIFTH data source — approved EXTRA PRODUCTION TIME claims (kind='ADD_PROD').
  // These are the SAME claims the Efficiency Overview adds to the numerator
  // (computeApprovedAddProdMinutesByWorker): a worker's approved over-standard
  // time on a job, credited as production output (hours × 60 minutes) and NOT
  // as a working-hour row. The endpoint returns all APPROVED requests across
  // workers (LIMIT 200), so filter client-side to this worker, kind=ADD_PROD,
  // and the selected date window. Without this the tab's efficiency disagreed
  // with the Overview (and could never exceed the JC numerator). Bug fix
  // 2026-06-27: align Employee Performance to the canonical formula.
  const { data: addProdResp } = useCachedJson<{ data?: NonprodReq[] }>(
    "/api/working-hour-entries/nonprod-requests?status=APPROVED",
  );
  const addProdMins = useMemo(() => {
    const rows = addProdResp?.data ?? [];
    let mins = 0;
    for (const r of rows) {
      if (r.workerId !== selectedEmployeeId) continue;
      if (r.kind !== "ADD_PROD") continue;
      if (r.status !== "APPROVED") continue;
      if (!r.date || r.date < dateFrom || r.date > dateTo) continue;
      mins += Math.round((Number(r.hours) || 0) * 60);
    }
    return mins;
  }, [addProdResp, selectedEmployeeId, dateFrom, dateTo]);

  // FOURTH data source — attendance_records scoped to this tab's date range.
  // Self-fetches the same dateFrom/dateTo window the jobs and working-hours
  // sources use, rather than reading a page-wide all-attendance prop. Still
  // needed for the Daily Breakdown table and for OT.
  const attUrl = `/api/attendance?from=${dateFrom}&to=${dateTo}`;
  const { data: attResp } = useCachedJson<{ data?: AttendanceRecord[] }>(attUrl);
  const rangeAttendance: AttendanceRecord[] = useMemo(
    () => (attResp?.data ?? []),
    [attResp]
  );

  // Filter the range attendance down to this employee (client-side) — the
  // fetch already scoped it to dateFrom..dateTo.
  const empRecords = useMemo(
    () =>
      rangeAttendance
        .filter((a) => a.employeeId === selectedEmployeeId)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [rangeAttendance, selectedEmployeeId]
  );

  // Total working hours from the new entries source. Sum decimal hours,
  // convert to minutes once. KPI display shows ALL hours (incl. non-prod
  // like Warehousing) - that's the user's "Total Working Hrs" headline.
  const totalWorkMins = Math.round(
    workerEntries.reduce((s, e) => s + (e.hours || 0), 0) * 60
  );
  // Avg Efficiency denominator: PRODUCTION-DEPT-ONLY hours. Time spent in
  // Warehousing / Repair / Maintenance / Production Shortfall is real
  // working time but not "available production capacity" - including it
  // would unfairly drag efficiency ratios down. Bug fix 2026-04-28.
  const productionWorkMins = Math.round(
    workerEntries.reduce(
      (s, e) =>
        productionDeptCodes.has(e.departmentCode) ? s + (e.hours || 0) : s,
      0,
    ) * 60,
  );
  // Job-card production minutes - halve only when BOTH PIC slots are
  // filled (worker shared the JC with a partner). Solo PIC (either slot,
  // no partner) gets the full minutes. Bug fix 2026-04-28: previously
  // the rule was "PIC2 always halves", which (a) double-counted when
  // both slots were filled (PIC1 got full + PIC2 got half = 1.5x total)
  // and (b) under-counted solo PIC2 (got half instead of full). Backend
  // /api/job-cards now exposes hasBothPics for this exact decision.
  const totalProdMinsJc = useMemo(() => {
    return workerJcs.reduce((s, r) => {
      const m = r.productionTimeMinutes || 0;
      return s + (r.hasBothPics ? m / 2 : m);
    }, 0);
  }, [workerJcs]);
  // CANONICAL Efficiency numerator (matches the Efficiency Overview +
  // computeMonthlyEfficiencyByWorker EXACTLY): completed job-card production
  // minutes (per-JC standard minutes, halved when shared with a partner) PLUS
  // approved EXTRA PRODUCTION TIME (kind='ADD_PROD'). Bug fix 2026-06-27: the
  // old numerator was "attendance prod time + JC time", which (a) double-credited
  // attendance clock-minutes on top of the JC standard and (b) never fetched the
  // approved ADD_PROD claims — producing >100% figures (e.g. 129%) that
  // disagreed with the Overview. Attendance minutes are dropped entirely.
  const numeratorProdMins = totalProdMinsJc + addProdMins;
  // Avg Efficiency denominator = production-dept hours only (see
  // productionWorkMins comment above). When the worker has zero hours
  // in any production dept, ratio stays null so the KPI shows em-dash.
  // efficiency% = numerator minutes / (prod-dept hours × 60) × 100, and since
  // productionWorkMins is already (prod-dept hours × 60) the ratio is direct.
  const avgEff =
    productionWorkMins > 0
      ? ((numeratorProdMins / productionWorkMins) * 100).toFixed(1)
      : null;
  // Non-production hours = total working hours - production-dept hours.
  // Surfaced as a subtitle on the Total Working Hrs card so the operator
  // can reconcile the headline (incl. Warehousing / Repair / Maintenance /
  // Production Shortfall) with the production-only denominator that drives
  // Avg Efficiency. Mirrors the Prod Hrs / Non-Prod Hrs columns added on
  // the Efficiency Overview tab in 93c3017.
  const nonProductionWorkMins = Math.max(0, totalWorkMins - productionWorkMins);
  const totalOT = empRecords.reduce((s, r) => s + r.overtimeMinutes, 0);
  // Days Present — distinct dates the worker has any working_hour_entries
  // row for. Falls through attendance status entirely so workers entered
  // via the flat grid (whose auto-created attendance row is PRESENT but
  // with 0 minutes) count correctly.
  const daysPresent = useMemo(() => {
    const dates = new Set<string>();
    for (const e of workerEntries) dates.add(e.date);
    return dates.size;
  }, [workerEntries]);

  // Flatten every deptBreakdown entry into a per-item row so the Daily
  // Breakdown shows every product this worker touched within the date range
  // (matching the googlesheet Employee Detail Dashboard layout). Each row
  // also carries a `source` tag so the table can distinguish attendance-
  // sourced rows ("ATT") from job-card-sourced rows ("JC").
  type ItemRow = {
    id: string;
    date: string;
    productCode: string;
    wipLabel: string;            // human-readable piece label (e.g. "5531 RIGHT ARM"); blank for ATT rows
    completedDate: string | null; // JC completion date (separate from `date` which is the entry date)
    deptCode: string;
    // The worker's CONTRIBUTION on this row - halved when both PICs are
    // filled (shared with a partner). Sum of all rows' `minutes` matches
    // the Total Production Hrs KPI exactly.
    minutes: number;
    // Total JC time before halving (perUnit x qty). Surfaced in tooltip
    // when shared so the user can see "30m total, 15m to me".
    totalMinutes?: number;
    perUnitMinutes?: number;     // BOM-defined per-unit time (JC rows only)
    qty?: number;                // wipQty (JC rows only)
    status: string;
    source: "ATT" | "JC";
    picSlot?: "PIC1" | "PIC2" | "";
    hasBothPics?: boolean;       // shared with a partner -> minutes halved
  };
  const itemRows: ItemRow[] = useMemo(() => {
    const out: ItemRow[] = [];
    // Operator rule (2026-05-08): Daily Breakdown should only show
    // job-card-sourced rows. PRESENT-only attendance rows (no JC
    // completed) add noise — the per-day attendance signal is already
    // visible in the "Days Present" KPI above.
    for (const jc of workerJcs) {
      if (!jc.completedDate) continue;
      const totalJcMin = jc.productionTimeMinutes || 0;
      // Worker's contribution = total / 2 when both PICs filled (shared);
      // full minutes when solo. Mirrors the totalProdMinsJc reduce above
      // so the per-row column sums to the Total Production Hrs KPI.
      const myShare = jc.hasBothPics ? totalJcMin / 2 : totalJcMin;
      out.push({
        id: `jc-${jc.id}`,
        date: jc.completedDate,
        productCode: jc.productCode || jc.wipCode || "—",
        wipLabel: jc.wipLabel || "",
        completedDate: jc.completedDate,
        deptCode: jc.departmentCode || "—",
        minutes: myShare,
        totalMinutes: totalJcMin,
        perUnitMinutes: jc.perUnitMinutes,
        qty: jc.wipQty,
        status: jc.status,
        source: "JC",
        picSlot: jc.picSlot,
        hasBothPics: jc.hasBothPics,
      });
    }
    out.sort((a, b) => b.date.localeCompare(a.date));
    return out;
  }, [empRecords, workerJcs]);

  const itemColumns: Column<ItemRow>[] = [
    {
      key: "date",
      label: "Date",
      sortable: true,
      render: (_v, row) => <span className="font-medium">{formatDateDMY(row.date)}</span>,
    },
    {
      key: "productCode",
      label: "Product / Item",
      sortable: true,
      render: (_v, row) => {
        // wipLabel is always the most specific identifier the JC carries —
        // it tells the operator which physical piece this JC covers
        // (e.g. "5530 -Right Arm BO315-25" for a FAB_SEW armrest cover,
        // "1013-(Q) | (5FT) | (20") | (DV 8") | PC151-01 | (FC)" for a
        // bedframe FC, or the merged set
        // "5535-1A(LHF)+1NA+1A(RHF)+1A(LHF)+1A(RHF)+1S" for a sofa
        // cross-PO FAB_CUT). The productCode alone (e.g. "5530-1A(RHF)")
        // is just the parent PO's product code, which hides what specific
        // work the JC covered. Prefer wipLabel as the primary label
        // whenever the JC carries one (every dept does); fall back to
        // productCode only when wipLabel is empty (legacy rows). Show
        // productCode as a small secondary line when both exist and differ
        // so the parent product is still discoverable.
        const primary = row.wipLabel || row.productCode;
        const secondary =
          row.wipLabel &&
          row.productCode &&
          row.productCode !== "—" &&
          primary !== row.productCode
            ? row.productCode
            : "";
        return (
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <span className="font-medium text-[#1F1D1B]">{primary}</span>
              {row.source === "JC" && (
                <span
                  className="inline-flex items-center rounded-sm bg-[#E0EDF0] px-1 text-[10px] font-semibold text-[#3E6570]"
                  title={`From job card${row.picSlot ? ` (${row.picSlot})` : ""}`}
                >
                  JC
                </span>
              )}
            </span>
            {secondary && (
              <span className="text-[10px] text-[#6B7280]">{secondary}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "completedDate",
      label: "Completion Date",
      sortable: true,
      render: (_v, row) => (
        <span className="text-[#4B5563]">
          {row.completedDate ? formatDateDMY(row.completedDate) : <span className="text-[#9CA3AF]">—</span>}
        </span>
      ),
    },
    {
      key: "deptCode",
      label: "Department",
      sortable: true,
      render: (_v, row) => (
        <span className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-xs font-medium text-[#6B5C32]">
          {row.deptCode}
        </span>
      ),
    },
    {
      key: "qty",
      label: "Qty",
      align: "center",
      sortable: true,
      render: (_v, row) =>
        row.qty && row.qty > 0 ? (
          <span className="tabular-nums text-[#1F1D1B]">{row.qty}</span>
        ) : (
          <span className="text-[#9CA3AF] tabular-nums">—</span>
        ),
    },
    {
      key: "minutes",
      label: "Total JC Time",
      align: "right",
      sortable: true,
      render: (_v, row) => {
        // Show this WORKER's contribution (already halved server-side when
        // both PICs filled). Sum of this column matches Total Production
        // Hrs KPI. When shared, badge "shared" + tooltip exposes the full
        // JC time so the user knows where the half came from.
        const display = formatHours(row.minutes);
        const tooltipParts: string[] = [];
        if (row.source === "JC" && row.perUnitMinutes && row.qty && row.qty > 1) {
          tooltipParts.push(`${row.perUnitMinutes}m x ${row.qty} = ${formatHours(row.totalMinutes ?? row.minutes)}`);
        }
        if (row.hasBothPics) {
          tooltipParts.push(`Shared with partner -> ${formatHours(row.minutes)}`);
        }
        const title = tooltipParts.join(" | ");
        return (
          <span className="inline-flex items-center gap-1.5 justify-end">
            <span className="font-medium tabular-nums" title={title || undefined}>{display}</span>
            {row.hasBothPics && (
              <span
                className="inline-flex items-center rounded-sm bg-[#FAEFCB] px-1 text-[9px] font-semibold text-[#9C6F1E]"
                title={`Total ${formatHours(row.totalMinutes ?? row.minutes * 2)} shared with partner`}
              >
                ½
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      width: "130px",
      render: (_v, row) => <Badge variant="status" status={row.status} />,
    },
  ];

  const jcCount = workerJcs.length;

  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "View Details",
      icon: <Eye className="h-4 w-4" />,
      action: (row: ItemRow) => {
        toast.info(`${row.productCode} — ${row.deptCode} — ${formatHours(row.minutes)}`);
      },
    },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-4 w-4" />,
      action: () => { window.location.reload(); },
      separator: true,
    },
  ];

  // Print Report — single-employee drill-down. The KPI summary goes on the
  // filter line (Days Present / Working Hrs / Production Hrs / Avg Efficiency /
  // OT), and the Daily Breakdown rows (the same job-card rows the grid shows)
  // form the table, mirroring its columns.
  const handlePrint = useCallback(() => {
    const empLabel = selectedWorker
      ? `${selectedWorker.empNo} — ${selectedWorker.name}`
      : "Employee";
    const cards: PrintCard[] = [
      { label: "Production Hrs", value: productionWorkMins > 0 ? formatHours(productionWorkMins) : "—" },
      { label: "Non-Production Hrs", value: nonProductionWorkMins > 0 ? formatHours(nonProductionWorkMins) : "—" },
      { label: "Extra Production Time", value: addProdMins > 0 ? formatHours(addProdMins) : "—" },
      { label: "Efficiency", value: avgEff !== null ? `${avgEff}%` : "—", color: avgEff !== null ? (Number(avgEff) >= 100 ? "#15803D" : Number(avgEff) >= 60 ? "#9C6F1E" : "#9A3A2D") : undefined },
      { label: "Days Present", value: String(daysPresent) },
      { label: "Total OT", value: totalOT > 0 ? formatHours(totalOT) : "—" },
    ];
    const columns: PrintColumn[] = [
      { header: "Date", value: (r) => formatDateDMY((r as ItemRow).date) },
      { header: "Product / Item", value: (r) => { const row = r as ItemRow; return row.wipLabel || row.productCode; } },
      { header: "Completion Date", value: (r) => { const d = (r as ItemRow).completedDate; return d ? formatDateDMY(d) : "—"; } },
      { header: "Department", value: (r) => (r as ItemRow).deptCode },
      { header: "Qty", align: "center", value: (r) => { const q = (r as ItemRow).qty; return q && q > 0 ? q : "—"; } },
      { header: "Total JC Time", align: "right", value: (r) => formatHours((r as ItemRow).minutes) },
      { header: "Status", value: (r) => { const s = (r as ItemRow).status; return s === "COMPLETED" ? { text: s, color: "#15803D", bold: true } : s; } },
    ];
    printReport({
      title: "Employee Performance",
      subtitle: empLabel,
      filterSummary: dateRangeLabel(dateFrom, dateTo),
      orientation: "portrait",
      cards,
      sections: [{ columns, rows: itemRows }],
    });
  }, [selectedWorker, daysPresent, productionWorkMins, nonProductionWorkMins, addProdMins, avgEff, totalOT, dateFrom, dateTo, itemRows]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[#1F1D1B]">
                Employee
              </label>
              <select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.empNo} - {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">From</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">To</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            {/* Quick-range presets. "Today" sets from=to=today (local MY date);
                the others mirror the rest of the page's range shortcuts. */}
            <div className="flex items-center gap-1">
              {([
                { label: "Today", range: () => { const t = todayLocalStr(); return { from: t, to: t }; } },
                { label: "7d", range: () => lastNDaysRange(7) },
                { label: "30d", range: () => lastNDaysRange(30) },
                { label: "This month", range: () => calendarMonthRange(0) },
                { label: "Last month", range: () => calendarMonthRange(-1) },
              ] as const).map((p) => {
                const r = p.range();
                const active = dateFrom === r.from && dateTo === r.to;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { setDateFrom(r.from); setDateTo(r.to); }}
                    className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                      active
                        ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                        : "border-[#E2DDD8] bg-white text-[#4B5563] hover:bg-[#F0ECE9]"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <Button variant="outline" size="sm" onClick={handlePrint} className="ml-auto" title="Print this employee's KPI summary and daily breakdown for the selected date range">
              <Printer className="h-4 w-4 mr-1" /> Print Report
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Employee Info Card */}
      {selectedWorker && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 max-md:grid-cols-1">
              <div>
                <p className="text-xs text-[#6B7280]">Name</p>
                <p className="font-semibold text-[#1F1D1B]">
                  {selectedWorker.name}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B7280]">Department</p>
                <p className="font-medium text-[#4B5563]">
                  {DEPARTMENTS.find((d) => d.id === selectedWorker.departmentId)
                    ?.name || selectedWorker.departmentCode}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B7280]">Position</p>
                <p className="font-medium text-[#4B5563]">
                  {selectedWorker.position}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B7280]">Join Date</p>
                <p className="font-medium text-[#4B5563]">
                  {formatDate(selectedWorker.joinDate)}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B7280]">Status</p>
                <Badge variant="status" status={selectedWorker.status} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Stats — the canonical Efficiency breakdown. Numerator =
          completed JC production minutes + approved extra production time;
          denominator = production-dept working hours. These cards agree with
          the Efficiency Overview tab for the same worker + range. */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 max-sm:grid-cols-1">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#4F7C3A]">
              {productionWorkMins > 0 ? formatHours(productionWorkMins) : "-"}
            </p>
            <p className="text-xs text-[#6B7280]">Production Hours</p>
            <p className="mt-0.5 text-[10px] text-[#3E6570]">Efficiency denominator</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#6B5C32]">
              {nonProductionWorkMins > 0 ? formatHours(nonProductionWorkMins) : "-"}
            </p>
            <p className="text-xs text-[#6B7280]">Non-Production Hours</p>
            <p className="mt-0.5 text-[10px] text-[#3E6570]">Warehouse / repair / etc.</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#3E6570]">
              {addProdMins > 0 ? formatHours(addProdMins) : "-"}
            </p>
            <p className="text-xs text-[#6B7280]">Extra Production Time</p>
            <p className="mt-0.5 text-[10px] text-[#3E6570]">Approved (added to output)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            {avgEff !== null ? (
              <p
                className={`text-2xl font-bold ${Number(avgEff) >= 85 ? "text-[#4F7C3A]" : Number(avgEff) >= 70 ? "text-[#9C6F1E]" : "text-[#9A3A2D]"}`}
              >
                {avgEff}%
              </p>
            ) : (
              <p className="text-2xl font-bold text-[#9CA3AF]" title="No production-dept working hours recorded in range — efficiency requires hours to compare against.">
                —
              </p>
            )}
            <p className="text-xs text-[#6B7280]">Efficiency</p>
            {avgEff !== null && (
              <p className="mt-0.5 text-[10px] text-[#3E6570]">
                {formatHours(numeratorProdMins) === "-" ? "0h" : formatHours(numeratorProdMins)} ÷ {formatHours(productionWorkMins)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#1F1D1B]">{daysPresent}</p>
            <p className="text-xs text-[#6B7280]">Days Present</p>
            {jcCount > 0 && (
              <p className="mt-0.5 text-[10px] text-[#3E6570]">{jcCount} JC completions</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#6B5C32]">
              {totalOT > 0 ? formatHours(totalOT) : "-"}
            </p>
            <p className="text-xs text-[#6B7280]">Total OT</p>
          </CardContent>
        </Card>
      </div>

      {/* Daily Breakdown Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[#6B5C32]" /> Daily Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            columns={itemColumns}
            data={itemRows}
            keyField="id"
            gridId="employees-detail-breakdown"
            contextMenuItems={contextMenuItems}
            emptyMessage="No completed items found for this worker in the selected period."
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ========== TAB 4b: DEPARTMENT PERFORMANCE ==========
//
// Sibling of EmployeeDetailTab — same KPI strip + daily breakdown layout, but
// the slice is (department, category, dateRange) instead of (worker,
// dateRange). Backend GET /api/department-performance returns pre-aggregated
// totals + per-day rows so this tab is a thin renderer.

type DrillDownWorker = {
  workerId: string;
  workerName: string;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  jobs: Array<{
    jobCardId: string;
    productCode: string;
    productName: string;
    wipLabel: string | null;
    poNo: string | null;
    productionMinutes: number;
  }>;
};

type DeptPerfDailyRow = {
  date: string;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  // Drill-down array — backend extension. Optional on the type so the
  // renderer doesn't crash if an older response shape is served (e.g.
  // a stale browser tab hitting a freshly deployed backend before its own
  // bundle reload). Empty array is treated identically to "missing".
  workers?: DrillDownWorker[];
};

type DeptPerfResponse = {
  success?: boolean;
  data?: {
    range: { from: string; to: string };
    departmentCode: string | null;
    category: string | null;
    totals: {
      workingMinutes: number;
      productionMinutes: number;
      efficiencyPct: number;
      workerCount: number;
    };
    daily: DeptPerfDailyRow[];
  };
};

// Default range = last 7 days inclusive (today − 6 .. today). Computed once
// at module scope so the localStorage fallback below stays cheap and the
// per-render call sites stay readable.
function sevenDaysAgoStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().split("T")[0];
}

function DepartmentPerformanceTab({
  departments,
  onDateChange,
}: {
  departments: DepartmentLite[];
  onDateChange?: (from: string, to: string) => void;
}) {
  // Fall back to seed depts so the dropdown doesn't flash empty on first
  // render before /api/departments resolves. Sorted: production first
  // (in sequence order), then non-production — same convention as the
  // Efficiency Overview tab.
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const orderedDepts = useMemo(() => {
    const copy = [...allDepts];
    copy.sort((a, b) => {
      if (a.isProduction !== b.isProduction) return a.isProduction ? -1 : 1;
      const sa = a.sequence ?? 999;
      const sb = b.sequence ?? 999;
      if (sa !== sb) return sa - sb;
      return a.code.localeCompare(b.code);
    });
    return copy;
  }, [allDepts]);

  const [departmentCode, setDepartmentCode] = useState<string>("");
  const [category, setCategory] = useState<string>("");

  // Date range — last 7 days inclusive by default, persisted per-tab so
  // reopening the page restores the operator's window. Mirrors the pattern
  // every other tab on this page uses.
  const [dateFrom, setDateFrom] = useState<string>(() =>
    readPersistedDateRange("employees:dept-perf:dateRange").from ?? sevenDaysAgoStr()
  );
  const [dateTo, setDateTo] = useState<string>(() =>
    readPersistedDateRange("employees:dept-perf:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("employees:dept-perf:dateRange", dateFrom, dateTo);
    onDateChange?.(dateFrom, dateTo);
  }, [dateFrom, dateTo, onDateChange]);

  const url = `/api/department-performance?from=${dateFrom}&to=${dateTo}&departmentCode=${encodeURIComponent(departmentCode)}&category=${encodeURIComponent(category)}`;
  const { data: resp, loading } = useCachedJson<DeptPerfResponse>(url);
  const payload = resp?.data;
  const totals = payload?.totals;
  const daily: DeptPerfDailyRow[] = useMemo(() => payload?.daily ?? [], [payload]);

  const avgEff = totals && totals.workingMinutes > 0
    ? totals.efficiencyPct.toFixed(1)
    : null;

  // Expanded-row state per date. Set<string> so flipping one row doesn't
  // collapse another — operator can fan out multiple days side-by-side. Cleared
  // implicitly on filter change because each filter swap remounts the rows
  // with new keys; if a date persists across a refresh we keep its state,
  // which is the right behaviour (operator's drill-down survives a poll).
  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set());
  const toggleDate = useCallback((date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }, []);

  // Print Report — prints EXACTLY this tab's on-screen filtered view (date
  // range + department + category), NOT the generic single-day all-departments
  // Daily Efficiency Report the old button opened. Mirrors every other report
  // tab on this page (Department Labor / Employee Performance / Efficiency
  // Overview): the four KPI cards from `totals` + the Daily Breakdown table.
  const handlePrint = useCallback(() => {
    const deptLabel =
      orderedDepts.find((d) => d.code === departmentCode)?.name ??
      (departmentCode || "All departments");
    const catLabel = category
      ? category[0] + category.slice(1).toLowerCase()
      : "All categories";
    const cards: PrintCard[] = [
      { label: "Workers", value: String(totals?.workerCount ?? 0) },
      {
        label: "Total Working Hrs",
        value: totals && totals.workingMinutes > 0 ? formatHours(totals.workingMinutes) : "—",
      },
      {
        label: "Total Production Hrs",
        value: totals && totals.productionMinutes > 0 ? formatHours(totals.productionMinutes) : "—",
      },
      {
        label: "Avg Efficiency",
        value: avgEff !== null ? `${avgEff}%` : "—",
        color:
          avgEff !== null
            ? Number(avgEff) >= 80
              ? "#4F7C3A"
              : Number(avgEff) >= 60
                ? "#9C6F1E"
                : "#9A3A2D"
            : undefined,
      },
    ];
    // Flatten each day + its per-worker drill-down into one printable table,
    // mirroring the on-screen Daily Breakdown where every day expands to show
    // its workers. Day rows print bold; worker rows are indented beneath them.
    type DeptPerfPrintRow = {
      isWorker: boolean;
      label: string;
      workingMinutes: number;
      productionMinutes: number;
      efficiencyPct: number;
    };
    const printRows: DeptPerfPrintRow[] = [];
    for (const d of daily) {
      printRows.push({
        isWorker: false,
        label: formatDateDMY(d.date),
        workingMinutes: d.workingMinutes,
        productionMinutes: d.productionMinutes,
        efficiencyPct: d.efficiencyPct,
      });
      for (const w of d.workers ?? []) {
        printRows.push({
          isWorker: true,
          label: w.workerName,
          workingMinutes: w.workingMinutes,
          productionMinutes: w.productionMinutes,
          efficiencyPct: w.efficiencyPct,
        });
      }
    }
    const hrsCell = (mins: number, bold: boolean) =>
      mins > 0 ? { text: formatHours(mins), bold } : { text: "—", bold };
    const columns: PrintColumn[] = [
      {
        header: "Date / Worker",
        value: (r) => {
          const row = r as DeptPerfPrintRow;
          return row.isWorker
            ? { text: `    ↳ ${row.label}` }
            : { text: row.label, bold: true };
        },
      },
      {
        header: "Working Hrs",
        align: "right",
        value: (r) => hrsCell((r as DeptPerfPrintRow).workingMinutes, !(r as DeptPerfPrintRow).isWorker),
      },
      {
        header: "Production Hrs",
        align: "right",
        value: (r) => hrsCell((r as DeptPerfPrintRow).productionMinutes, !(r as DeptPerfPrintRow).isWorker),
      },
      {
        header: "Efficiency %",
        align: "right",
        value: (r) => {
          const row = r as DeptPerfPrintRow;
          const bold = !row.isWorker;
          if (row.workingMinutes <= 0) return { text: "—", bold };
          const pct = row.efficiencyPct;
          const color = pct >= 80 ? "#4F7C3A" : pct >= 60 ? "#9C6F1E" : "#9A3A2D";
          return { text: `${pct.toFixed(1)}%`, color, align: "right", bold };
        },
      },
    ];
    printReport({
      title: "Department Performance",
      filterSummary: `${dateRangeLabel(dateFrom, dateTo)} · ${deptLabel} · ${catLabel}`,
      orientation: "portrait",
      cards,
      sections: [{ columns, rows: printRows }],
    });
  }, [orderedDepts, departmentCode, category, totals, avgEff, dateFrom, dateTo, daily]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[#1F1D1B]">Department</label>
              <select
                value={departmentCode}
                onChange={(e) => setDepartmentCode(e.target.value)}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">All departments</option>
                {orderedDepts.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[#1F1D1B]">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">All categories</option>
                <option value="SOFA">SOFA</option>
                <option value="BEDFRAME">BEDFRAME</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">From</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-[#6B7280]">To</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-36 h-8 text-xs"
              />
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Primary Print Report — prints EXACTLY this tab's filtered
                  view (date range + department + category): the 4 KPI cards +
                  the Daily Breakdown table, consistent with every other report
                  tab. Was wrongly wired to /api/reports/efficiency, which only
                  shows ONE day, ALL departments, ALL categories. */}
              <Button
                variant="default"
                size="sm"
                onClick={handlePrint}
                title="Print this tab's filtered Department Performance view (date range + department + category)"
              >
                <Printer className="h-4 w-4 mr-1" />
                Print Report
              </Button>
              {/* Secondary — the generic single-day, all-departments Daily
                  Efficiency Report (the same A4 view the noon cron mails out).
                  Kept as a separate link because it ignores this tab's filters
                  by design; uses the "To" date. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const ymd = dateTo || todayStr();
                  window.open(
                    `/api/reports/efficiency?date=${encodeURIComponent(ymd)}`,
                    "_blank",
                    "noopener",
                  );
                }}
                title="Open the generic single-day, all-departments Daily Efficiency Report (A4) in a new tab"
              >
                <Printer className="h-4 w-4 mr-1" />
                Daily Efficiency (A4)
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary Stats — mirrors EmployeeDetailTab strip, minus Total OT
          (backend doesn't surface OT for dept aggregates). "Workers" replaces
          "Days Present" because the response gives us workerCount, not a
          per-worker presence count. */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 max-sm:grid-cols-1">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#1F1D1B]">{totals?.workerCount ?? 0}</p>
            <p className="text-xs text-[#6B7280]">Workers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {totals && totals.workingMinutes > 0 ? formatHours(totals.workingMinutes) : "-"}
            </p>
            <p className="text-xs text-[#6B7280]">Total Working Hrs</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {totals && totals.productionMinutes > 0 ? formatHours(totals.productionMinutes) : "-"}
            </p>
            <p className="text-xs text-[#6B7280]">Total Production Hrs</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            {avgEff !== null ? (
              <p
                className={`text-2xl font-bold ${Number(avgEff) >= 80 ? "text-[#4F7C3A]" : Number(avgEff) >= 60 ? "text-[#9C6F1E]" : "text-[#9A3A2D]"}`}
              >
                {avgEff}%
              </p>
            ) : (
              <p className="text-2xl font-bold text-[#9CA3AF]" title="No working hours recorded in range — efficiency requires hours to compare against.">
                —
              </p>
            )}
            <p className="text-xs text-[#6B7280]">Avg Efficiency</p>
          </CardContent>
        </Card>
      </div>

      {/* Daily Breakdown Table — expandable rows. Click row OR caret to drill
          into who logged hours and which job cards completed on that date.
          Custom <table> instead of DataGrid because DataGrid has no expansion
          slot; the column count here is small enough that we don't lose the
          DataGrid features (sort/filter) the operator actually uses on this
          short range view. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[#6B5C32]" /> Daily Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[#6B7280]">
              {loading ? "Loading..." : "No working hours in the selected period."}
            </div>
          ) : (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-2 text-left font-medium text-[#374151] w-8"></th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Date</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Working hrs</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Production hrs</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Efficiency %</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.map((row) => {
                    const isOpen = expandedDates.has(row.date);
                    const pct = row.efficiencyPct;
                    const effColor =
                      row.workingMinutes <= 0
                        ? "text-[#9CA3AF]"
                        : pct >= 80
                          ? "text-[#4F7C3A]"
                          : pct >= 60
                            ? "text-[#9C6F1E]"
                            : "text-[#9A3A2D]";
                    return (
                      <Fragment key={row.date}>
                        <tr
                          className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors cursor-pointer"
                          onClick={() => toggleDate(row.date)}
                        >
                          <td className="h-10 px-2 text-center text-[#6B7280]">
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4 inline" />
                            ) : (
                              <ChevronRight className="h-4 w-4 inline" />
                            )}
                          </td>
                          <td className="h-10 px-3 font-medium text-[#1F1D1B]">
                            {formatDateDMY(row.date)}
                          </td>
                          <td className="h-10 px-3 text-right tabular-nums">
                            {row.workingMinutes > 0 ? formatHours(row.workingMinutes) : "-"}
                          </td>
                          <td className="h-10 px-3 text-right tabular-nums">
                            {row.productionMinutes > 0 ? formatHours(row.productionMinutes) : "-"}
                          </td>
                          <td className={`h-10 px-3 text-right tabular-nums font-semibold ${effColor}`}>
                            {row.workingMinutes <= 0 ? "—" : `${pct.toFixed(1)}%`}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-[#FDFCFB]">
                            <td colSpan={5} className="px-6 py-4">
                              <DailyDrillDown
                                date={row.date}
                                workers={row.workers ?? []}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Per-date drill-down panel rendered inside the expanded row. Single-column
// vertical stack of worker rows; each row is itself expandable to reveal
// THAT worker's completed JCs for the date. Multiple workers can be open
// at once — tracked in a Set<string> of "${date}::${workerId}" keys so
// expansion state survives re-renders without colliding across dates.
//
// Sort: workers by working minutes desc (matches backend), jobs by
// production minutes desc per worker.
function DailyDrillDown({
  date,
  workers,
}: {
  date: string;
  workers: DrillDownWorker[];
}) {
  const sortedWorkers = useMemo(
    () => [...workers].sort((a, b) => b.workingMinutes - a.workingMinutes),
    [workers],
  );

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const toggleWorker = useCallback(
    (workerId: string) => {
      const key = `${date}::${workerId}`;
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [date],
  );

  if (sortedWorkers.length === 0) {
    return (
      <div className="rounded-lg bg-white border border-[#E2DDD8] px-3 py-3 text-xs text-[#9CA3AF]">
        No working hours logged on this date.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide">
        Workers
      </h4>
      <div className="rounded-lg bg-white border border-[#E2DDD8] overflow-hidden">
        {/* Column header — mirrors the parent Daily Breakdown table so the
            operator's eye traces the same column meaning from outer to inner. */}
        <div className="flex items-center gap-3 px-3 py-2 bg-[#F0ECE9] border-b border-[#E2DDD8] text-[10px] font-medium text-[#374151] uppercase tracking-wide">
          <span className="w-4 flex-shrink-0" />
          <span className="flex-1 min-w-0">Worker</span>
          <span className="w-24 text-right">Working hrs</span>
          <span className="w-24 text-right">Production hrs</span>
          <span className="w-14 text-right">Efficiency</span>
        </div>
        <div className="divide-y divide-[#F0ECE9]">
        {sortedWorkers.map((w) => {
          const key = `${date}::${w.workerId}`;
          const isOpen = expandedKeys.has(key);
          const pct = w.efficiencyPct;
          const effColor =
            w.workingMinutes <= 0
              ? "text-[#9CA3AF]"
              : pct >= 80
                ? "text-[#4F7C3A]"
                : pct >= 60
                  ? "text-[#9C6F1E]"
                  : "text-[#9A3A2D]";
          const sortedJobs = [...w.jobs].sort(
            (a, b) => b.productionMinutes - a.productionMinutes,
          );
          return (
            <Fragment key={w.workerId}>
              <button
                type="button"
                onClick={() => toggleWorker(w.workerId)}
                className="w-full flex items-center gap-3 px-3 py-2 text-xs hover:bg-[#FAF9F7] transition-colors text-left"
                aria-expanded={isOpen}
              >
                <span className="text-[#6B7280] flex-shrink-0 w-4">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </span>
                <span className="font-medium text-[#1F1D1B] flex-1 min-w-0 truncate">
                  {w.workerName}
                </span>
                <span className="tabular-nums text-[#374151] whitespace-nowrap w-24 text-right">
                  {w.workingMinutes > 0 ? formatHours(w.workingMinutes) : "-"}
                </span>
                <span
                  className="tabular-nums text-[#374151] whitespace-nowrap w-24 text-right"
                  title="Production hours (pro-rated share of completed JCs)"
                >
                  {w.productionMinutes > 0 ? formatHours(w.productionMinutes) : "-"}
                </span>
                <span
                  className={`tabular-nums font-semibold whitespace-nowrap w-14 text-right ${effColor}`}
                >
                  {w.workingMinutes <= 0 ? "—" : `${pct.toFixed(0)}%`}
                </span>
              </button>
              {isOpen && (
                <div className="bg-[#FDFCFB] px-3 py-3">
                  {sortedJobs.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF]">
                      No completed job cards on this date.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {sortedJobs.map((j) => {
                        const title = j.wipLabel || j.productName || j.productCode;
                        return (
                          <li
                            key={j.jobCardId}
                            className="flex items-start justify-between gap-3 rounded border border-[#F0ECE9] bg-white px-3 py-2 text-xs"
                          >
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="font-medium text-[#1F1D1B] truncate">
                                {title}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap text-[10px] text-[#6B7280]">
                                <span>{j.productCode}</span>
                                {j.poNo ? (
                                  <span className="inline-flex items-center rounded bg-[#F0ECE9] px-1.5 py-0.5 font-medium text-[#6B5C32]">
                                    {j.poNo}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <span className="tabular-nums text-[#374151] font-medium whitespace-nowrap">
                              {formatHours(j.productionMinutes)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
        </div>
      </div>
    </div>
  );
}

// ========== TAB 5: PAYROLL ==========

// Live explanation for the Pay Rules editor (owner 2026-06-11: "当我填写了
// 内容之后,那个 explanation 会直接变换"). Recomputes a worked example
// (RM2,050 · 9h worker · the CURRENT month) from the draft values on every
// keystroke, so the admin sees exactly what each setting does before saving.
function RuleDraftExplainer({ d }: { d: Record<string, string> }) {
  const S = 2050; // example salary, RM
  const now = new Date();
  const calDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  let monSat = 0;
  for (let i = 1; i <= calDays; i++) {
    if (new Date(now.getFullYear(), now.getMonth(), i).getDay() !== 0) monSat++;
  }
  const lunchH = (Number(d.lunchMin) || 0) / 60;
  const dayMode = d.dayRateDivisorMode || "fixed26";
  const dayDiv = dayMode === "calendarDays" ? calDays : dayMode === "workingDays" ? monSat : 26;
  const dayLabel =
    dayMode === "calendarDays"
      ? `${calDays} calendar days (this month — changes every month)`
      : dayMode === "workingDays"
        ? `${monSat} working days (this month's Mon–Sat, before public holidays — changes every month)`
        : "26 (the worker's Working days/month — the same every month)";
  const dayRate = S / Math.max(1, dayDiv);
  const hourMode = d.hourRateDivisorMode || "hoursPlusLunch";
  const fixedDiv = Number(d.rateHoursPerDay) || 10;
  const hourDiv = hourMode === "fixed" ? fixedDiv : hourMode === "hoursOnly" ? 9 : 9 + lunchH;
  const hourLabel =
    hourMode === "fixed"
      ? `${fixedDiv} (the same fixed number for everyone)`
      : hourMode === "hoursOnly"
        ? "the worker's daily hours (9h worker → ÷9)"
        : `the worker's daily hours + ${lunchH}h lunch (9h worker → ÷${9 + lunchH})`;
  const hourRate = dayRate / Math.max(1, hourDiv);
  const grace = Number(d.lateGraceMin) || 0;
  const block = Math.max(1, Number(d.lateBlockMin) || 15);
  const sun = Number(d.sundayOtMultiplier) || 2;
  const ph = Number(d.holidayOtMultiplier) || 3;
  const absGrace = Number(d.absenceGraceWorkingDays) || 2;
  const startMin = (() => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((d.shiftStart || "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : 480;
  })();
  const lateInMin = startMin + grace + 1;
  const lateIn = `${String(Math.floor(lateInMin / 60)).padStart(2, "0")}:${String(lateInMin % 60).padStart(2, "0")}`;
  const rm = (v: number) => `RM${v.toFixed(2)}`;
  return (
    <div className="rounded-md border border-[#E8E2DC] bg-[#FBF9F7] p-3 text-[11px] leading-relaxed text-[#4B5563]">
      <p className="mb-1 font-semibold text-[#6B5C32]">What these settings mean (live example: RM2,050 salary · 9h/day worker)</p>
      <p>
        <b>Day rate</b> = 2,050 ÷ {dayLabel} = <b>{rm(dayRate)}/day</b> — each
        confirmed absent day deducts this (confirmed after {absGrace} working
        day{absGrace === 1 ? "" : "s"}; backfilling hours removes it).
      </p>
      <p className="mt-1">
        <b>Hour rate</b> = {rm(dayRate)} ÷ {hourLabel} = <b>{rm(hourRate)}/hour</b> —
        prices lateness, short hours and the OT base.
      </p>
      <p className="mt-1">
        <b>Lateness</b>: arrive {lateIn} (1 min past the {grace}-min grace) →
        charged {block} min = <b>−{rm((block / 60) * hourRate)}</b> · same-day OT
        offsets the gap first.
      </p>
      <p className="mt-1">
        <b>Overtime</b>: weekday ×1.5 → <b>{rm(hourRate * 1.5)}/h</b> · Sunday ×{sun} →{" "}
        <b>{rm(hourRate * sun)}/h</b> · Public holiday ×{ph} → <b>{rm(hourRate * ph)}/h</b>{" "}
        (Sunday/holiday count EVERY hour of the day).
      </p>
      <p className="mt-1 text-[#9CA3AF]">
        Each worker&rsquo;s own salary, Working days/month and Hours/day come from
        Employee Master — this example just shows the formulas.
      </p>
    </div>
  );
}

function PayrollTab({ workers: _workers }: { workers: Worker[] }) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Pay Rules maintenance panel (collapsed by default) — effective-dated
  // rule versions (owner 2026-06-11): the panel shows the rules in force
  // TODAY and lets the admin schedule a change from a chosen date.
  const [showPayRules, setShowPayRules] = useState(false);
  const { data: payRulesResp, refresh: refreshPayRules } = useCachedJson<{
    data?: { versions?: PayRuleVersion[]; effectiveToday?: PayRulesConfig };
  }>("/api/pay-rules");
  const payRulesToday: PayRulesConfig =
    payRulesResp?.data?.effectiveToday ?? DEFAULT_PAY_RULES;
  const payRuleVersionList: PayRuleVersion[] = useMemo(
    () => payRulesResp?.data?.versions ?? [],
    [payRulesResp],
  );
  const [ruleDraftOpen, setRuleDraftOpen] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<Record<string, string>>({});
  const openRuleDraft = () => {
    const c = payRulesToday;
    setRuleDraft({
      effectiveFrom: "",
      dayRateDivisorMode: c.dayRateDivisorMode,
      hourRateDivisorMode: c.hourRateDivisorMode,
      shiftStart: minToHhmm(c.shiftStartMin),
      shiftEnd: minToHhmm(c.shiftEndMin),
      lunchMin: String(c.lunchMin),
      lateGraceMin: String(c.lateGraceMin),
      lateBlockMin: String(c.lateBlockMin),
      rateHoursPerDay: String(c.rateHoursPerDay),
      sundayOtMultiplier: String(c.sundayOtMultiplier),
      holidayOtMultiplier: String(c.holidayOtMultiplier),
      absenceGraceWorkingDays: String(c.absenceGraceWorkingDays),
      epfEmployeePct: String(c.epfEmployeePct),
      epfEmployerPct: String(c.epfEmployerPct),
      socsoEmployee: (c.socsoEmployeeSen / 100).toFixed(2),
      socsoEmployer: (c.socsoEmployerSen / 100).toFixed(2),
      eisEmployee: (c.eisEmployeeSen / 100).toFixed(2),
      eisEmployer: (c.eisEmployerSen / 100).toFixed(2),
      note: "",
    });
    setRuleDraftOpen(true);
  };
  const ruleDraftField = (k: string, v: string) =>
    setRuleDraft((d) => ({ ...d, [k]: v }));
  const hhmmToMinLocal = (s: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const ruleDraftValid =
    /^\d{4}-\d{2}-\d{2}$/.test(ruleDraft.effectiveFrom || "") &&
    Number.isFinite(hhmmToMinLocal(ruleDraft.shiftStart || "")) &&
    Number.isFinite(hhmmToMinLocal(ruleDraft.shiftEnd || ""));
  const saveRuleDraft = async () => {
    if (!ruleDraftValid) return;
    setSavingRules(true);
    try {
      const d = ruleDraft;
      const r = await fetch("/api/pay-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effectiveFrom: d.effectiveFrom,
          note: d.note || undefined,
          rules: {
            dayRateDivisorMode: d.dayRateDivisorMode,
            hourRateDivisorMode: d.hourRateDivisorMode,
            shiftStartMin: hhmmToMinLocal(d.shiftStart),
            shiftEndMin: hhmmToMinLocal(d.shiftEnd),
            lunchMin: Number(d.lunchMin),
            lateGraceMin: Number(d.lateGraceMin),
            lateBlockMin: Number(d.lateBlockMin),
            rateHoursPerDay: Number(d.rateHoursPerDay),
            sundayOtMultiplier: Number(d.sundayOtMultiplier),
            holidayOtMultiplier: Number(d.holidayOtMultiplier),
            absenceGraceWorkingDays: Number(d.absenceGraceWorkingDays),
            epfEmployeePct: Number(d.epfEmployeePct),
            epfEmployerPct: Number(d.epfEmployerPct),
            socsoEmployeeSen: Math.round(Number(d.socsoEmployee) * 100),
            socsoEmployerSen: Math.round(Number(d.socsoEmployer) * 100),
            eisEmployeeSen: Math.round(Number(d.eisEmployee) * 100),
            eisEmployerSen: Math.round(Number(d.eisEmployer) * 100),
          },
        }),
      });
      if (r.ok) {
        setRuleDraftOpen(false);
        invalidateCachePrefix("/api/pay-rules");
        refreshPayRules?.();
      }
    } finally {
      setSavingRules(false);
    }
  };
  const deleteRuleVersion = async (id: string) => {
    if (
      !(await confirm({
        title: "Delete this pay-rule version?",
        message:
          "Already-generated payslips are unaffected. Future payroll runs and any re-generation will fall back to the previous version in effect on each date.",
        confirmLabel: "Delete",
        tone: "danger",
      }))
    ) {
      return;
    }
    await fetch(`/api/pay-rules/${id}`, { method: "DELETE" });
    invalidateCachePrefix("/api/pay-rules");
    refreshPayRules?.();
  };

  const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;

  const { data: payslipResp, loading: loadingPayroll, refresh: refreshPayslipsHook } = useCachedJson<unknown>(`/api/payslips?period=${period}`);
  const storedPayslips: PayslipData[] = useMemo(() => asArray(payslipResp) as PayslipData[], [payslipResp]);
  // In-progress month with nothing generated yet → show the LIVE projected
  // estimate (same engine as month-end Generate, no DB write) so the month isn't
  // blank — matches what the worker phone already shows. Fetched only when there
  // are no stored rows AND the month isn't over. Once Generate runs, stored rows
  // take over. monthIsFinished is the same gate Labor Cost / Dept Labor use.
  const monthOver = monthIsFinished(period);
  const { data: projectedResp, loading: loadingProjected } = useCachedJson<unknown>(
    storedPayslips.length === 0 && !monthOver
      ? `/api/payslips/projected?period=${period}`
      : null,
  );
  const projectedPayslips: PayslipData[] = useMemo(
    () => asArray(projectedResp) as PayslipData[],
    [projectedResp],
  );
  // Showing the live estimate (no stored rows yet). The table + totals use this;
  // the Approve / Regenerate actions are gated on `storedPayslips` so a preview
  // can't be approved.
  const isProjected = storedPayslips.length === 0 && projectedPayslips.length > 0;
  const payslipData: PayslipData[] =
    storedPayslips.length > 0 ? storedPayslips : projectedPayslips;
  const fetchPayslips = useCallback(() => {
    invalidateCachePrefix("/api/payslips");
    refreshPayslipsHook();
  }, [refreshPayslipsHook]);

  const generatePayslips = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/payslips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `Failed to generate payslips (HTTP ${res.status})`);
      } else if (data.success) {
        fetchPayslips();
      } else {
        toast.error(data.error || "Failed to generate payslips");
      }
    } catch {
      toast.error("Error generating payslips");
    }
    setGenerating(false);
  };

  // 2026-05-24 — operator path to re-apply current worker master-data
  // (statutory toggle, OT multiplier, salary) onto an already-generated
  // period. Wipes DRAFTs and recomputes; APPROVED rows refuse (backend
  // enforces). Confirm dialog because operator loses any per-row tweaks.
  const regeneratePayslips = async () => {
    if (
      !(await confirm({
        title: `Re-generate payslips for ${months[selectedMonth - 1]} ${selectedYear}?`,
        message:
          "All current DRAFT rows for this period will be deleted and recomputed from the latest worker master-data (statutory toggles, salary, OT multiplier). APPROVED rows stay untouched.",
        confirmLabel: "Re-generate",
        tone: "danger",
      }))
    ) {
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/payslips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, regenerate: true }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `Failed to regenerate payslips (HTTP ${res.status})`);
      } else if (data.success) {
        toast.success("Payslips regenerated with current worker data.");
        fetchPayslips();
      } else {
        toast.error(data.error || "Failed to regenerate payslips");
      }
    } catch {
      toast.error("Error regenerating payslips");
    }
    setGenerating(false);
  };

  const approveAll = async () => {
    setApproving(true);
    try {
      const res = await fetch("/api/payslips", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, status: "APPROVED" }),
      });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await res.json().catch(() => ({}));
        toast.error(data?.error || `Failed to approve payslips (HTTP ${res.status})`);
      } else {
        fetchPayslips();
      }
    } catch {
      toast.error("Error approving payslips");
    }
    setApproving(false);
  };

  const totals = useMemo(() => {
    return payslipData.reduce(
      (acc, r) => ({
        basicSalary: acc.basicSalary + r.basicSalary,
        absenceDeductionSen: acc.absenceDeductionSen + (r.absenceDeductionSen || 0),
        otWeekdayHours: acc.otWeekdayHours + r.otWeekdayHours,
        otSundayHours: acc.otSundayHours + r.otSundayHours,
        otPHHours: acc.otPHHours + r.otPHHours,
        totalOT: acc.totalOT + r.totalOT,
        allowances: acc.allowances + r.allowances,
        grossPay: acc.grossPay + r.grossPay,
        epfEmployee: acc.epfEmployee + r.epfEmployee,
        epfEmployer: acc.epfEmployer + r.epfEmployer,
        socsoEmployee: acc.socsoEmployee + r.socsoEmployee,
        socsoEmployer: acc.socsoEmployer + r.socsoEmployer,
        eisEmployee: acc.eisEmployee + r.eisEmployee,
        eisEmployer: acc.eisEmployer + r.eisEmployer,
        pcb: acc.pcb + r.pcb,
        totalDeductions: acc.totalDeductions + r.totalDeductions,
        netPay: acc.netPay + r.netPay,
      }),
      {
        basicSalary: 0, absenceDeductionSen: 0, otWeekdayHours: 0, otSundayHours: 0, otPHHours: 0,
        totalOT: 0, allowances: 0, grossPay: 0, epfEmployee: 0, epfEmployer: 0,
        socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0,
        pcb: 0, totalDeductions: 0, netPay: 0,
      }
    );
  }, [payslipData]);

  const totalPayrollCost = useMemo(() => {
    return totals.grossPay + totals.epfEmployer + totals.socsoEmployer + totals.eisEmployer;
  }, [totals]);

  // "Part-month" column — LEGACY display reconciliation. Under the UNIFIED ÷26
  // model (owner 2026-06-11) the engine never prorates: join/resign months are
  // plain absences, so for newly generated payslips this derives to RM0 and the
  // column shows "-". Payslips STORED under the old window model still carry a
  // proration baked into their gross; this surfaces it so those historical rows
  // keep reading Basic − Absence − Part-month − Late/short + OT = Gross.
  // proration = Basic − Absence − short-hour dock − (Gross − OT − allowances).
  // Display only — no pay math here.
  const prorationSenOf = useCallback(
    (r: PayslipData) =>
      Math.max(
        0,
        r.basicSalary - (r.absenceDeductionSen || 0) - (r.shortHourDeductionSen || 0) -
          (r.grossPay - r.totalOT - (r.allowances || 0)),
      ),
    [],
  );
  const totalProrationSen = useMemo(
    () =>
      payslipData.reduce(
        (s, r) =>
          s +
          Math.max(
            0,
            r.basicSalary - (r.absenceDeductionSen || 0) - (r.shortHourDeductionSen || 0) -
              (r.grossPay - r.totalOT - (r.allowances || 0)),
          ),
        0,
      ),
    [payslipData],
  );

  const months = MONTH_NAMES;

  const getStatusStyle = (status: string) => {
    switch (status) {
      case "DRAFT": return "bg-gray-100 text-gray-700";
      case "APPROVED": return "bg-[#E0EDF0] text-[#3E6570]";
      case "PAID": return "bg-[#EEF3E4] text-[#4F7C3A]";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  const exportCSV = () => {
    if (payslipData.length === 0) return;
    const headers = [
      "Employee No", "Employee Name", "Department", "Basic Salary", "Working Days",
      "Absent Days", "Absence Deduction",
      "OT Weekday Hrs", "OT Sunday Hrs", "OT PH Hrs", "Hourly Rate",
      "OT Weekday Amt", "OT Sunday Amt", "OT PH Amt", "Total OT", "Allowances",
      "Gross Pay", "EPF EE (11%)", "EPF ER (13%)", "SOCSO EE", "SOCSO ER",
      "EIS EE", "EIS ER", "PCB", "Total Deductions", "Net Pay", "Bank Account", "Status",
    ];
    const rows = payslipData.map((r) => [
      r.employeeNo, r.employeeName, r.departmentCode, (r.basicSalary / 100).toFixed(2),
      r.workingDays, r.absentDays ?? 0, ((r.absenceDeductionSen ?? 0) / 100).toFixed(2),
      r.otWeekdayHours, r.otSundayHours, r.otPHHours,
      (r.hourlyRate / 100).toFixed(2), (r.otWeekdayAmount / 100).toFixed(2),
      (r.otSundayAmount / 100).toFixed(2), (r.otPHAmount / 100).toFixed(2),
      (r.totalOT / 100).toFixed(2), (r.allowances / 100).toFixed(2),
      (r.grossPay / 100).toFixed(2), (r.epfEmployee / 100).toFixed(2),
      (r.epfEmployer / 100).toFixed(2), (r.socsoEmployee / 100).toFixed(2),
      (r.socsoEmployer / 100).toFixed(2), (r.eisEmployee / 100).toFixed(2),
      (r.eisEmployer / 100).toFixed(2), (r.pcb / 100).toFixed(2),
      (r.totalDeductions / 100).toFixed(2), (r.netPay / 100).toFixed(2),
      r.bankAccount, r.status,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printPayslipForEmployee = async (payslip: PayslipData) => {
    try {
      const res = await fetch(`/api/payslips/${payslip.id}`);
      const data = (await res.json()) as { data: PayslipData; ytd: unknown };
      const { generatePayslipHTML } = await import("@/lib/generate-payslip-pdf");
      const html = generatePayslipHTML(data.data, data.ytd as Parameters<typeof generatePayslipHTML>[1]);
      const printWindow = window.open("", "_blank");
      if (printWindow) {
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
        // Wait for the new window to lay out the payslip HTML before
        // invoking print(). Runs from a print-button click handler.
        // eslint-disable-next-line no-restricted-syntax -- one-shot delay inside print-button event handler
        setTimeout(() => printWindow.print(), 500);
      }
    } catch {
      toast.error("Error generating payslip");
    }
  };

  const fmtSen = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

  // Print Report — mirrors the on-screen payroll columns (Employee, Basic,
  // Days, Absence, Part-month, OT hours, OT Amt, Gross, statutory, Net Pay,
  // Status) for the selected period. Estimate vs finalised is noted on the
  // filter line so a printed estimate is never mistaken for an approved run.
  const handlePrint = useCallback(() => {
    const columns: PrintColumn[] = [
      { header: "Employee", value: (r) => { const p = r as PayslipData; return `${p.employeeNo} — ${p.employeeName} (${p.departmentCode.replace(/_/g, " ")})`; } },
      { header: "Basic (RM)", align: "right", value: (r) => formatCurrency((r as PayslipData).basicSalary) },
      { header: "Days", align: "center", value: (r) => (r as PayslipData).workingDays },
      { header: "Absence", align: "right", value: (r) => { const p = r as PayslipData; return p.absenceDeductionSen > 0 ? `−${formatCurrency(p.absenceDeductionSen)} (${p.absentDays}d)` : "-"; } },
      { header: "Part-month", align: "right", value: (r) => { const v = prorationSenOf(r as PayslipData); return v > 1 ? `−${formatCurrency(v)}` : "-"; } },
      { header: "OT Wk", align: "right", value: (r) => `${(r as PayslipData).otWeekdayHours}h` },
      { header: "OT Sun", align: "right", value: (r) => { const h = (r as PayslipData).otSundayHours; return h > 0 ? `${h}h` : "-"; } },
      { header: "OT PH", align: "right", value: (r) => { const h = (r as PayslipData).otPHHours; return h > 0 ? `${h}h` : "-"; } },
      { header: "OT Amt", align: "right", value: (r) => formatCurrency((r as PayslipData).totalOT) },
      { header: "Allowance", align: "right", value: (r) => { const v = (r as PayslipData).allowances || 0; return v > 0 ? formatCurrency(v) : "-"; } },
      { header: "Gross", align: "right", value: (r) => formatCurrency((r as PayslipData).grossPay) },
      { header: "EPF EE", align: "right", value: (r) => formatCurrency((r as PayslipData).epfEmployee) },
      { header: "EPF ER", align: "right", value: (r) => formatCurrency((r as PayslipData).epfEmployer) },
      { header: "SOCSO", align: "right", value: (r) => formatCurrency((r as PayslipData).socsoEmployee) },
      { header: "EIS", align: "right", value: (r) => formatCurrency((r as PayslipData).eisEmployee) },
      { header: "PCB", align: "right", value: (r) => { const p = r as PayslipData; return p.pcb > 0 ? formatCurrency(p.pcb) : "-"; } },
      { header: "Net Pay", align: "right", value: (r) => ({ text: formatCurrency((r as PayslipData).netPay), bold: true }) },
      { header: "Status", value: (r) => (r as PayslipData).status },
    ];
    const cards: PrintCard[] = [
      { label: "Total Payroll Cost", value: formatCurrency(totalPayrollCost) },
      { label: "Total EPF (EE+ER)", value: formatCurrency(totals.epfEmployee + totals.epfEmployer) },
      { label: "Total SOCSO", value: formatCurrency(totals.socsoEmployee + totals.socsoEmployer) },
      { label: "Total EIS", value: formatCurrency(totals.eisEmployee + totals.eisEmployer) },
      { label: "Total PCB", value: formatCurrency(totals.pcb) },
    ];
    printReport({
      title: "Payroll",
      filterSummary: `${months[selectedMonth - 1]} ${selectedYear}${isProjected ? " · Estimate (month in progress)" : ""}`,
      orientation: "landscape",
      cards,
      sections: [{ columns, rows: payslipData }],
    });
  }, [payslipData, isProjected, selectedMonth, selectedYear, months, prorationSenOf, totalPayrollCost, totals]);

  // Printable salary-calculation guide (owner 2026-06-11): a worked example of
  // EVERY pay rule, in plain English, to hand to workers. GENERATED from the
  // rules in force TODAY (divisor modes, shift, grace, multipliers, statutory)
  // so it can never go stale — change a rule, reprint, the guide follows.
  // Worked example fixed at RM2,050 · 9h/day so the arithmetic is concrete.
  const printCalcGuide = useCallback(() => {
    const cfg = payRulesToday;
    const S = 2050; // example salary (RM)
    const now = new Date();
    const monthName = now.toLocaleDateString("en-MY", { month: "long", year: "numeric" });
    const calDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    let monSat = 0;
    for (let i = 1; i <= calDays; i++) {
      if (new Date(now.getFullYear(), now.getMonth(), i).getDay() !== 0) monSat++;
    }
    const lunchH = cfg.lunchMin / 60;
    const lunchTxt = `${cfg.lunchMin % 60 === 0 ? lunchH.toFixed(0) : lunchH.toFixed(1)}h`;
    const stdH = (cfg.shiftEndMin - cfg.shiftStartMin - cfg.lunchMin) / 60;
    const shiftTxt = `${minToHhmm(cfg.shiftStartMin)}-${minToHhmm(cfg.shiftEndMin)}`;
    // Day rate per the configured divisor mode.
    const dayDiv = cfg.dayRateDivisorMode === "calendarDays" ? calDays : cfg.dayRateDivisorMode === "workingDays" ? monSat : 26;
    const dayDivTxt =
      cfg.dayRateDivisorMode === "calendarDays"
        ? `the month's calendar days (${monthName}: ${calDays})`
        : cfg.dayRateDivisorMode === "workingDays"
          ? `the month's working days (${monthName}: ${monSat}, Mon-Sat before public holidays)`
          : "26 — the same every month";
    const dayRate = S / dayDiv;
    // Hour rate per the configured mode (example worker = 9h/day).
    const hourDiv = cfg.hourRateDivisorMode === "fixed" ? cfg.rateHoursPerDay : cfg.hourRateDivisorMode === "hoursOnly" ? 9 : 9 + lunchH;
    const hourDivTxt =
      cfg.hourRateDivisorMode === "fixed"
        ? `${cfg.rateHoursPerDay} (the same fixed number for everyone)`
        : cfg.hourRateDivisorMode === "hoursOnly"
          ? "the worker's daily hours (9h worker → ÷9)"
          : `the worker's daily hours + ${lunchTxt} lunch (9h worker → ÷${9 + lunchH})`;
    const hourRate = dayRate / Math.max(1, hourDiv);
    const rm = (v: number) => `RM${v.toFixed(2)}`;
    const grace = cfg.lateGraceMin;
    const block = cfg.lateBlockMin;
    const lateIn = minToHhmm(cfg.shiftStartMin + grace + 1);
    const onTimeIn = minToHhmm(cfg.shiftStartMin + Math.max(0, grace - 2));
    const sun = cfg.sundayOtMultiplier;
    const ph = cfg.holidayOtMultiplier;
    type GuideRow = { item: string; rule: string; example: string };
    // Item bold + Example in the house gold, so the three columns read as
    // name / explanation / number instead of one grey block (owner 2026-06-11).
    // Same widths in every section so the three columns line up down the
    // whole page (owner: sections must align, not each table auto-sizing).
    const col = [
      { header: "Item", width: "19%", value: (r: unknown) => ({ text: (r as GuideRow).item, bold: true }) },
      { header: "How it is calculated", width: "53%", value: (r: unknown) => (r as GuideRow).rule },
      { header: "Example", width: "28%", value: (r: unknown) => ({ text: (r as GuideRow).example, color: "#6B5C32", bold: true }) },
    ];
    const s = (title: string, rows: GuideRow[]) => ({ title, columns: col, rows });
    printReport({
      title: "Salary Calculation Guide",
      filterSummary: `Worked example: RM2,050/month · 9h/day worker · ${monthName} · Shift ${shiftTxt}, ${lunchTxt} unpaid lunch = ${stdH}h standard day · printed from the rules in force today`,
      cards: [
        { label: "Example salary", value: "RM2,050 / month" },
        { label: "Day rate", value: `2,050 ÷ ${dayDiv} = ${rm(dayRate)}` },
        { label: "Hour rate", value: `${rm(dayRate)} ÷ ${hourDiv} = ${rm(hourRate)}` },
        { label: "OT rates", value: `Weekday 1.5x · Sunday ${sun}x · Holiday ${ph}x` },
      ],
      sections: [
        s("1. Daily & hourly rates", [
          { item: "Day rate", rule: `Monthly salary ÷ ${dayDivTxt} · used for absences and join/resign`, example: `2,050 ÷ ${dayDiv} = ${rm(dayRate)} / day` },
          { item: "Hour rate", rule: `Day rate ÷ ${hourDivTxt} · used for lateness, short hours AND the overtime base`, example: `${rm(dayRate)} ÷ ${hourDiv} = ${rm(hourRate)} / hour` },
          { item: "Production cost day rate", rule: "Monthly salary ÷ working days of the month (internal costing only — never changes pay)", example: `2,050 ÷ ${monSat} ≈ ${rm(S / Math.max(1, monSat))} / day` },
        ]),
        s("2. Working hours from the punch clock", [
          { item: "Standard day", rule: `Punch in to punch out, minus the ${lunchTxt} unpaid lunch`, example: `${shiftTxt} − ${lunchTxt} = ${stdH}h` },
          { item: "Late grace", rule: `Up to ${grace} minutes late is forgiven`, example: `${onTimeIn} in → counted as on time` },
          { item: "Lateness rounding", rule: `Beyond grace, lateness rounds UP in ${block}-min blocks`, example: `${lateIn} → ${block} min late` },
          { item: "Overtime counting", rule: `Only after ${minToHhmm(cfg.shiftEndMin)}, in 15-min blocks (a block must be filled)`, example: "16-29 min → 15 min; 14 min → 0" },
        ]),
        s("3. Lateness / short hours deduction", [
          { item: "Deduction", rule: `Short hours × the hour rate (${rm(hourRate)}/h)`, example: `30 min late, no OT → 0.5h × ${hourRate.toFixed(2)} = −${rm(hourRate / 2)}` },
          { item: "Same-day OT offsets first", rule: "Evening OT covers the morning gap 1:1; only the remainder is deducted", example: "30 min late + 2h OT → deduction RM0, paid OT 1.5h" },
          { item: "Review", rule: "The office can Keep pay (no deduction) or Deduct each short day; every deduction can be undone", example: "Shown in the worker app under 'Late / short hours'" },
        ]),
        s("4. Overtime pay", [
          { item: "Weekday OT", rule: `Hours above the ${stdH}h standard × hour rate × the worker's multiplier (usually 1.5)`, example: `2h → 2 × ${hourRate.toFixed(2)} × 1.5 = ${rm(2 * hourRate * 1.5)}` },
          { item: "Sunday work", rule: `EVERY hour that day × hour rate × ${sun} (Sundays are non-working)`, example: `8h Sunday → ${rm(8 * hourRate * sun)}` },
          { item: "Public holiday work", rule: `EVERY hour that day × hour rate × ${ph}`, example: `8h holiday → ${rm(8 * hourRate * ph)}` },
        ]),
        s("5. Absence", [
          { item: "Absent working day", rule: "Each confirmed absent day deducts the day rate", example: `1 day → −${rm(dayRate)}` },
          { item: "Grace before confirming", rule: `A blank day only becomes an absence after ${cfg.absenceGraceWorkingDays} working days (it may just not be keyed yet)`, example: "Shown as 'Pending' until confirmed" },
          { item: "Backfilling hours", rule: "Keying the hours later removes the absence automatically", example: "No button needed; regenerate if the month was finalised" },
        ]),
        s("6. Joining / resigning mid-month", [
          { item: "One rule for everyone", rule: "No separate part-month formula — every working day of the month not worked counts as an absent day at the day rate", example: `Same −${rm(dayRate)} per day` },
          { item: "Join mid-month", rule: "Full salary − the working days before the join date (they count as absences)", example: `3 working days before joining → 2,050 − 3 × ${dayRate.toFixed(2)} = ${rm(S - 3 * dayRate)}` },
          { item: "Resign mid-month", rule: "Working days after the last day also count as absent days", example: `Each later working day deducts ${rm(dayRate)}` },
        ]),
        s("7. Allowance, statutory & net pay", [
          { item: "Efficiency allowance", rule: "Flat bonus when the month's cumulative efficiency reaches the worker's target, else RM0 (no proration)", example: "RM150 at 100%" },
          { item: "Statutory (per-worker toggle)", rule: `EPF ${cfg.epfEmployeePct}% employee / ${cfg.epfEmployerPct}% employer on basic · SOCSO RM${(cfg.socsoEmployeeSen / 100).toFixed(2)}/${(cfg.socsoEmployerSen / 100).toFixed(2)} · EIS RM${(cfg.eisEmployeeSen / 100).toFixed(2)}/${(cfg.eisEmployerSen / 100).toFixed(2)}`, example: "Deducted only when enabled" },
          { item: "Net pay", rule: "Basic − absence − late/short + OT + allowance − employee statutory", example: "What the worker receives" },
        ]),
      ],
    });
  }, [payRulesToday]);

  return (
    <div className="space-y-4">
      {confirmDialog}
      {/* Summary Cards */}
      {payslipData.length > 0 && (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280] uppercase tracking-wide">Total Payroll Cost</p>
              <p className="text-xl font-bold text-[#1F1D1B] mt-1">{formatCurrency(totalPayrollCost)}</p>
              <p className="text-[10px] text-[#9CA3AF] mt-0.5">Gross + Employer contributions</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280] uppercase tracking-wide">Total EPF (EE+ER)</p>
              <p className="text-xl font-bold text-[#3E6570] mt-1">{formatCurrency(totals.epfEmployee + totals.epfEmployer)}</p>
              <p className="text-[10px] text-[#9CA3AF] mt-0.5">EE: {formatCurrency(totals.epfEmployee)} | ER: {formatCurrency(totals.epfEmployer)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280] uppercase tracking-wide">Total SOCSO</p>
              <p className="text-xl font-bold text-[#6B4A6D] mt-1">{formatCurrency(totals.socsoEmployee + totals.socsoEmployer)}</p>
              <p className="text-[10px] text-[#9CA3AF] mt-0.5">EE: {formatCurrency(totals.socsoEmployee)} | ER: {formatCurrency(totals.socsoEmployer)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280] uppercase tracking-wide">Total EIS</p>
              <p className="text-xl font-bold text-[#3E6570] mt-1">{formatCurrency(totals.eisEmployee + totals.eisEmployer)}</p>
              <p className="text-[10px] text-[#9CA3AF] mt-0.5">EE: {formatCurrency(totals.eisEmployee)} | ER: {formatCurrency(totals.eisEmployer)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280] uppercase tracking-wide">Total PCB</p>
              <p className="text-xl font-bold text-[#9C6F1E] mt-1">{totals.pcb > 0 ? formatCurrency(totals.pcb) : "RM 0.00"}</p>
              <p className="text-[10px] text-[#9CA3AF] mt-0.5">Monthly tax deduction</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Main Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-[#6B5C32]" /> Payroll Processing - {months[selectedMonth - 1]} {selectedYear}
              </CardTitle>
              {payslipData.length > 0 && (
                <p className="mt-1 text-xs text-[#6B7280]">
                  <span className="font-semibold text-[#1F1D1B]">{payslipData.length}</span> active worker{payslipData.length === 1 ? "" : "s"}
                  {" · total salary "}<span className="font-semibold text-[#1F1D1B]">{formatCurrency(totals.basicSalary)}</span>
                  {" · total pay "}<span className="font-semibold text-[#6B5C32]">{formatCurrency(totalPayrollCost)}</span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                {months.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                {[2025, 2026, 2027].map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              {storedPayslips.length === 0 && (
                <Button variant="primary" onClick={generatePayslips} disabled={generating}>
                  <DollarSign className="h-4 w-4" />
                  {generating ? "Generating..." : isProjected ? "Generate (finalise)" : "Generate Payslips"}
                </Button>
              )}
              {storedPayslips.length > 0 && storedPayslips.some((r) => r.status === "DRAFT") && (
                <Button variant="primary" onClick={approveAll} disabled={approving}>
                  <Check className="h-4 w-4" />
                  {approving ? "Approving..." : "Approve All"}
                </Button>
              )}
              {storedPayslips.length > 0 && storedPayslips.some((r) => r.status === "DRAFT") && (
                <Button
                  variant="outline"
                  onClick={regeneratePayslips}
                  disabled={generating}
                  title="Wipe this period's DRAFT rows and recompute from current worker master-data (statutory toggles, salary, OT multiplier). APPROVED rows are protected."
                >
                  <DollarSign className="h-4 w-4" />
                  {generating ? "Regenerating..." : "Regenerate"}
                </Button>
              )}
              {payslipData.length > 0 && (
                <Button variant="outline" onClick={exportCSV}>
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
              )}
              {payslipData.length > 0 && (
                <Button variant="outline" size="sm" onClick={handlePrint} title="Print the payroll table for the selected period">
                  <Printer className="h-4 w-4 mr-1" /> Print Report
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={printCalcGuide}
                title="Print the salary calculation guide — a worked example of every pay rule, to hand to workers"
              >
                <Printer className="h-4 w-4 mr-1" /> Calculation Guide
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isProjected && (
            <div className="mb-3 rounded-md border border-[#E2D9C3] bg-[#FBF7EC] px-3 py-2 text-xs text-[#6B5C32]">
              <span className="font-semibold">Estimate · month in progress.</span> Same engine the worker app shows — payslips aren&rsquo;t generated yet. The figures update as Working Hours are entered; click &ldquo;Generate (finalise)&rdquo; at month-end to lock them in (the numbers will match).
            </div>
          )}
          {(loadingPayroll || loadingProjected) ? (
            <div className="flex items-center justify-center h-32 text-[#6B7280]">Loading payroll data...</div>
          ) : payslipData.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[#6B7280]">
              <p>No payslip records for {months[selectedMonth - 1]} {selectedYear}.</p>
              <p className="text-xs mt-1">Click &quot;Generate Payslips&quot; to calculate payroll with Malaysian statutory deductions.</p>
            </div>
          ) : (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              {/* 2026-05-24 layout fix: 17 columns under w-full squeezed
                  every cell into too little width — employee names wrapped
                  to two lines (EI PHOO / WEI), OT headers stacked vertical.
                  Switch to min-w-max so columns size to content, all
                  cells/headers use whitespace-nowrap, Employee gets a hard
                  min-w-[180px] so abbreviations stay on one line. The
                  parent overflow-x-auto already handles horizontal scroll
                  on narrow screens (tablet portrait). */}
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-2 text-left font-medium text-[#374151] w-8 whitespace-nowrap"></th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] min-w-[180px] whitespace-nowrap">Employee</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">Basic (RM)</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151] whitespace-nowrap">Days</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">Absence</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">Part-month</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">OT Wk</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">OT Sun</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">OT PH</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">OT Amt</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap" title="Efficiency allowance — paid when the worker hits their monthly efficiency target">Allowance</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">Gross</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">EPF EE</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">EPF ER</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">SOCSO</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">EIS</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151] whitespace-nowrap">PCB</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">Net Pay</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap" title="Real company outlay for this worker — Net Pay plus every statutory contribution (employee + employer EPF / SOCSO / EIS + PCB). Equals Gross + employer EPF / SOCSO / EIS.">Total Pay</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151] whitespace-nowrap">Status</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151] whitespace-nowrap">Print</th>
                  </tr>
                </thead>
                <tbody>
                  {payslipData.map((r) => (
                    <Fragment key={r.id}>
                      <tr
                        className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors cursor-pointer"
                        onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                      >
                        <td className="h-10 px-2 text-center text-[#6B7280]">
                          {expandedRow === r.id ? <ChevronDown className="h-4 w-4 inline" /> : <ChevronRight className="h-4 w-4 inline" />}
                        </td>
                        <td className="h-10 px-3 whitespace-nowrap">
                          <div className="font-medium text-[#1F1D1B]">{r.employeeName}</div>
                          <div className="text-[10px] text-[#9CA3AF]">{r.employeeNo} - {r.departmentCode.replace(/_/g, " ")}</div>
                        </td>
                        <td className="h-10 px-3 text-right whitespace-nowrap">{formatCurrency(r.basicSalary)}</td>
                        <td className="h-10 px-2 text-center whitespace-nowrap">{r.workingDays}</td>
                        <td className="h-10 px-3 text-right whitespace-nowrap text-[#9A3A2D]">
                          {r.absenceDeductionSen > 0
                            ? <span>−{formatCurrency(r.absenceDeductionSen)}<span className="text-[10px] text-[#9CA3AF]"> ({r.absentDays}d)</span></span>
                            : "-"}
                        </td>
                        <td className="h-10 px-3 text-right whitespace-nowrap text-[#9A3A2D]" title="Part-month (legacy months only): payslips stored before the unified rule, paid for days served">
                          {prorationSenOf(r) > 1 ? `−${formatCurrency(prorationSenOf(r))}` : "-"}
                        </td>
                        <td className="h-10 px-2 text-right whitespace-nowrap">{r.otWeekdayHours}h</td>
                        <td className="h-10 px-2 text-right whitespace-nowrap">{r.otSundayHours > 0 ? `${r.otSundayHours}h` : "-"}</td>
                        <td className="h-10 px-2 text-right whitespace-nowrap">{r.otPHHours > 0 ? `${r.otPHHours}h` : "-"}</td>
                        <td className="h-10 px-3 text-right font-medium text-[#6B5C32] whitespace-nowrap">{formatCurrency(r.totalOT)}</td>
                        <td className="h-10 px-3 text-right whitespace-nowrap text-[#4F7C3A]">{r.allowances > 0 ? formatCurrency(r.allowances) : "-"}</td>
                        <td className="h-10 px-3 text-right font-semibold whitespace-nowrap">{formatCurrency(r.grossPay)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs whitespace-nowrap">{formatCurrency(r.epfEmployee)}</td>
                        <td className="h-10 px-2 text-right text-[#3E6570] text-xs whitespace-nowrap">{formatCurrency(r.epfEmployer)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs whitespace-nowrap">{formatCurrency(r.socsoEmployee)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs whitespace-nowrap">{formatCurrency(r.eisEmployee)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs whitespace-nowrap">{r.pcb > 0 ? formatCurrency(r.pcb) : "-"}</td>
                        <td className="h-10 px-3 text-right font-bold text-[#1F1D1B] whitespace-nowrap">{formatCurrency(r.netPay)}</td>
                        <td className="h-10 px-3 text-right font-bold text-[#6B5C32] whitespace-nowrap" title="Net Pay + all EPF / SOCSO / EIS / PCB = real company outlay for this worker">{formatCurrency(r.grossPay + r.epfEmployer + r.socsoEmployer + r.eisEmployer)}</td>
                        <td className="h-10 px-2 text-center">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${getStatusStyle(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="h-10 px-2 text-center">
                          <button
                            onClick={(e) => { e.stopPropagation(); printPayslipForEmployee(r); }}
                            className="p-1 rounded hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#6B5C32] transition-colors"
                            title="Print Payslip"
                          >
                            <Printer className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                      {/* Expanded Detail Row */}
                      {expandedRow === r.id && (
                        <tr className="bg-[#FDFCFB]">
                          <td colSpan={21} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                              {/* OT Calculation Breakdown */}
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide">OT Calculation</h4>
                                <div className="text-xs space-y-1 text-[#374151] bg-white rounded-lg p-3 border border-[#E2DDD8]">
                                  <p className="text-[#6B7280]">
                                    Hourly Rate: {fmtSen(r.basicSalary)} / (26 x 9) = <span className="font-semibold text-[#1F1D1B]">{fmtSen(r.hourlyRate)}/hr</span>
                                  </p>
                                  <hr className="border-[#E2DDD8]" />
                                  <p>
                                    Weekday OT: {r.otWeekdayHours} hrs x {fmtSen(r.hourlyRate)} x 1.5 = <span className="font-semibold">{fmtSen(r.otWeekdayAmount)}</span>
                                  </p>
                                  <p>
                                    Sunday OT: {r.otSundayHours} hrs x {fmtSen(r.hourlyRate)} x 2.0 = <span className="font-semibold">{fmtSen(r.otSundayAmount)}</span>
                                  </p>
                                  <p>
                                    PH OT: {r.otPHHours} hrs x {fmtSen(r.hourlyRate)} x 3.0 = <span className="font-semibold">{fmtSen(r.otPHAmount)}</span>
                                  </p>
                                  <hr className="border-[#E2DDD8]" />
                                  <p className="font-semibold">
                                    Total OT: <span className="text-[#6B5C32]">{fmtSen(r.totalOT)}</span>
                                  </p>
                                </div>
                              </div>

                              {/* Statutory Deductions */}
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide">Statutory Deductions</h4>
                                <div className="text-xs space-y-1 text-[#374151] bg-white rounded-lg p-3 border border-[#E2DDD8]">
                                  <div className="flex justify-between">
                                    <span>EPF Employee (11%)</span>
                                    <span className="font-semibold text-[#9A3A2D]">{fmtSen(r.epfEmployee)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>EPF Employer (13%)</span>
                                    <span className="font-semibold text-[#3E6570]">{fmtSen(r.epfEmployer)}</span>
                                  </div>
                                  <hr className="border-[#E2DDD8]" />
                                  <div className="flex justify-between">
                                    <span>SOCSO Employee</span>
                                    <span className="font-semibold text-[#9A3A2D]">{fmtSen(r.socsoEmployee)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>SOCSO Employer</span>
                                    <span className="font-semibold text-[#3E6570]">{fmtSen(r.socsoEmployer)}</span>
                                  </div>
                                  <hr className="border-[#E2DDD8]" />
                                  <div className="flex justify-between">
                                    <span>EIS Employee</span>
                                    <span className="font-semibold text-[#9A3A2D]">{fmtSen(r.eisEmployee)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>EIS Employer</span>
                                    <span className="font-semibold text-[#3E6570]">{fmtSen(r.eisEmployer)}</span>
                                  </div>
                                  <hr className="border-[#E2DDD8]" />
                                  <div className="flex justify-between">
                                    <span>PCB (Tax)</span>
                                    <span className="font-semibold">{r.pcb > 0 ? fmtSen(r.pcb) : "-"}</span>
                                  </div>
                                </div>
                              </div>

                              {/* Pay Summary */}
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide">Pay Summary</h4>
                                <div className="text-xs space-y-1 text-[#374151] bg-white rounded-lg p-3 border border-[#E2DDD8]">
                                  <div className="flex justify-between">
                                    <span>Basic Salary</span>
                                    <span className="font-semibold">{fmtSen(r.basicSalary)}</span>
                                  </div>
                                  {r.absenceDeductionSen > 0 && (
                                    <div className="flex justify-between text-[#9A3A2D]">
                                      <span>Less: Absence ({r.absentDays}d)</span>
                                      <span className="font-semibold">({fmtSen(r.absenceDeductionSen)})</span>
                                    </div>
                                  )}
                                  {(r.shortHourDeductionSen ?? 0) > 0 && (
                                    <div className="flex justify-between text-[#9A3A2D]">
                                      <span>Less: Late / short hours</span>
                                      <span className="font-semibold">({fmtSen(r.shortHourDeductionSen ?? 0)})</span>
                                    </div>
                                  )}
                                  {prorationSenOf(r) > 1 && (
                                    <div className="flex justify-between text-[#9A3A2D]">
                                      <span>Less: Part-month (joined / resigned mid-month)</span>
                                      <span className="font-semibold">({fmtSen(prorationSenOf(r))})</span>
                                    </div>
                                  )}
                                  <div className="flex justify-between">
                                    <span>Total OT</span>
                                    <span className="font-semibold text-[#6B5C32]">{fmtSen(r.totalOT)}</span>
                                  </div>
                                  {r.allowances > 0 && (
                                    <div className="flex justify-between">
                                      <span>Allowances</span>
                                      <span className="font-semibold">{fmtSen(r.allowances)}</span>
                                    </div>
                                  )}
                                  <hr className="border-[#E2DDD8]" />
                                  <div className="flex justify-between font-semibold">
                                    <span>Gross Pay</span>
                                    <span>{fmtSen(r.grossPay)}</span>
                                  </div>
                                  <div className="flex justify-between text-[#9A3A2D]">
                                    <span>Less: Deductions</span>
                                    <span className="font-semibold">({fmtSen(r.totalDeductions)})</span>
                                  </div>
                                  <hr className="border-[#E2DDD8]" />
                                  <div className="flex justify-between font-bold text-base text-[#1F1D1B]">
                                    <span>Net Pay</span>
                                    <span>{fmtSen(r.netPay)}</span>
                                  </div>
                                  <hr className="border-[#E2DDD8]" />
                                  <div className="flex justify-between text-[#9CA3AF]">
                                    <span>Bank Account</span>
                                    <span>{r.bankAccount}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                            {/* Day Detail — WHICH days were absent / had OT.
                                Display-only: the dates come from the same
                                attendance the amount math reads, surfaced here
                                so the absence (Nd) + OT hours above are
                                attributable to specific dates. */}
                            <div className="mt-4 space-y-2">
                              <h4 className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide">Day Detail</h4>
                              <div className="text-xs space-y-2 text-[#374151] bg-white rounded-lg p-3 border border-[#E2DDD8]">
                                <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                                  <span className="font-semibold text-[#9A3A2D] shrink-0">Absent:</span>
                                  {r.absentDates && r.absentDates.length > 0 ? (
                                    <span className="flex flex-wrap gap-1.5">
                                      {r.absentDates.map((d) => (
                                        <span key={d} className="inline-flex items-center rounded bg-[#F9E1DA] px-1.5 py-0.5 font-medium text-[#9A3A2D] tabular-nums">
                                          {formatDayMonth(d)}
                                        </span>
                                      ))}
                                    </span>
                                  ) : (
                                    <span className="text-[#9CA3AF]">No absent days</span>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                                  <span className="font-semibold text-[#6B5C32] shrink-0">OT:</span>
                                  {r.otDays && r.otDays.length > 0 ? (
                                    <span className="flex flex-wrap gap-1.5">
                                      {r.otDays.map((d) => (
                                        <span key={d.date} className="inline-flex items-center rounded bg-[#FAEFCB] px-1.5 py-0.5 font-medium text-[#9C6F1E] tabular-nums">
                                          {formatDayMonth(d.date)} — {Number.isInteger(d.hours) ? d.hours : d.hours.toFixed(1)}h
                                        </span>
                                      ))}
                                    </span>
                                  ) : (
                                    <span className="text-[#9CA3AF]">No overtime days</span>
                                  )}
                                </div>
                                {r.lateDays && r.lateDays.length > 0 && (
                                  <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                                    <span className="font-semibold text-[#9A3A2D] shrink-0">Late / short:</span>
                                    <span className="flex flex-wrap gap-1.5">
                                      {r.lateDays.map((d) => (
                                        <span key={d.date} className="inline-flex items-center rounded bg-[#F9E1DA] px-1.5 py-0.5 font-medium text-[#9A3A2D] tabular-nums">
                                          {formatDayMonth(d.date)} — {Number.isInteger(d.hours) ? d.hours : d.hours.toFixed(1)}h
                                        </span>
                                      ))}
                                    </span>
                                  </div>
                                )}
                                {(!r.absentDates && !r.otDays) && (
                                  <p className="text-[10px] text-[#9CA3AF]">
                                    Per-day detail isn&rsquo;t available for this row.
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {/* Totals Row */}
                  <tr className="bg-[#F0ECE9] font-semibold">
                    <td className="h-10 px-2"></td>
                    <td className="h-10 px-3 text-[#1F1D1B]">TOTAL ({payslipData.length} workers)</td>
                    <td className="h-10 px-3 text-right">{formatCurrency(totals.basicSalary)}</td>
                    <td className="h-10 px-2"></td>
                    <td className="h-10 px-3 text-right text-[#9A3A2D]">{totals.absenceDeductionSen > 0 ? `−${formatCurrency(totals.absenceDeductionSen)}` : "-"}</td>
                    <td className="h-10 px-3 text-right text-[#9A3A2D]">{totalProrationSen > 0 ? `−${formatCurrency(totalProrationSen)}` : "-"}</td>
                    <td className="h-10 px-2 text-right">{totals.otWeekdayHours}h</td>
                    <td className="h-10 px-2 text-right">{totals.otSundayHours > 0 ? `${totals.otSundayHours}h` : "-"}</td>
                    <td className="h-10 px-2 text-right">{totals.otPHHours > 0 ? `${totals.otPHHours}h` : "-"}</td>
                    <td className="h-10 px-3 text-right text-[#6B5C32]">{formatCurrency(totals.totalOT)}</td>
                    {/* Allowance total — was MISSING, which shifted every column
                        from here right (Gross landed under Allowance, … Net Pay
                        under PCB). Restores 20 cells = 20 header columns. */}
                    <td className="h-10 px-3 text-right text-[#4F7C3A]">{totals.allowances > 0 ? formatCurrency(totals.allowances) : "-"}</td>
                    <td className="h-10 px-3 text-right">{formatCurrency(totals.grossPay)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(totals.epfEmployee)}</td>
                    <td className="h-10 px-2 text-right text-[#3E6570] text-xs">{formatCurrency(totals.epfEmployer)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(totals.socsoEmployee)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(totals.eisEmployee)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{totals.pcb > 0 ? formatCurrency(totals.pcb) : "-"}</td>
                    <td className="h-10 px-3 text-right font-bold">{formatCurrency(totals.netPay)}</td>
                    <td className="h-10 px-3 text-right font-bold text-[#6B5C32]" title="Real company outlay = Net Pay + all EPF / SOCSO / EIS / PCB = Total Payroll Cost">{formatCurrency(totalPayrollCost)}</td>
                    <td className="h-10 px-2"></td>
                    <td className="h-10 px-2"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Pay Rules — maintenance panel. Single reference for every live pay
              rule (matches the engine + the printable Calculation Guide), with
              pointers to where the editable pieces are maintained. */}
          <div className="mt-4 rounded-lg bg-[#F0ECE9]">
            <button
              type="button"
              onClick={() => setShowPayRules((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold text-[#1F1D1B] hover:opacity-80"
              title={showPayRules ? "Hide the pay rules" : "Show every pay rule the system applies"}
            >
              {showPayRules ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Pay Rules (Maintenance)
              <span className="text-xs font-normal text-[#6B7280]">— every rule the payroll engine applies · use the Calculation Guide button above to print a worked example for workers</span>
            </button>
            {showPayRules && (
            <div className="px-3 pb-3">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 text-xs leading-relaxed text-[#4B5563] md:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="font-semibold text-[#1F1D1B] mb-1">Daily & hourly rate</p>
                <p>
                  <b>Daily = salary ÷ {payRulesToday.dayRateDivisorMode === "calendarDays"
                    ? "calendar days (30/31)"
                    : payRulesToday.dayRateDivisorMode === "workingDays"
                      ? "the month's working days"
                      : "26"}</b>{" "}
                  · <b>Hourly = daily ÷ {payRulesToday.hourRateDivisorMode === "fixed"
                    ? `${payRulesToday.rateHoursPerDay} (fixed)`
                    : payRulesToday.hourRateDivisorMode === "hoursOnly"
                      ? "the worker's hours"
                      : `(hours + ${(payRulesToday.lunchMin / 60).toFixed(payRulesToday.lunchMin % 60 === 0 ? 0 : 1)}h lunch)`}</b>.
                  {payRulesToday.dayRateDivisorMode === "fixed26" && payRulesToday.hourRateDivisorMode === "hoursPlusLunch"
                    ? <> RM2,050 · 9h: <b>RM78.85/day · RM7.88/hour</b> (9h → ÷10, 7.5h → ÷8.5).</>
                    : null}{" "}
                  Absence uses the daily rate; lateness and OT use the hourly rate.
                </p>
              </div>
              <div>
                <p className="font-semibold text-[#1F1D1B] mb-1">Shift & working hours</p>
                <p>Shift {minToHhmm(payRulesToday.shiftStartMin)}–{minToHhmm(payRulesToday.shiftEndMin)} · {payRulesToday.lunchMin} min unpaid lunch = <b>{((payRulesToday.shiftEndMin - payRulesToday.shiftStartMin - payRulesToday.lunchMin) / 60).toFixed(1)}h standard day</b> · Working days Mon–Sat (excluding public holidays). Hours auto-fill from the punch clock.</p>
              </div>
              <div>
                <p className="font-semibold text-[#1F1D1B] mb-1">Lateness</p>
                <p>≤{payRulesToday.lateGraceMin} min forgiven · beyond that, lateness rounds <b>UP</b> in {payRulesToday.lateBlockMin}-min blocks · deducted at <b>the hourly rate</b> (see Daily & hourly rate) · <b>same-day OT offsets the gap first</b>, only the remainder is deducted.</p>
              </div>
              <div>
                <p className="font-semibold text-[#1F1D1B] mb-1">Overtime</p>
                <p>After {minToHhmm(payRulesToday.shiftEndMin)} only, 15-min blocks (floors) · base = <b>the hourly rate</b> · <b>Weekday ×worker&rsquo;s multiplier</b> (Employee Master) · <b>Sunday {payRulesToday.sundayOtMultiplier}×</b> / <b>Public Holiday {payRulesToday.holidayOtMultiplier}×</b> on every hour of the day.</p>
              </div>
              <div>
                <p className="font-semibold text-[#1F1D1B] mb-1">Absence & join/resign</p>
                <p>Absent working day = − salary ÷ 26 · confirmed after a {payRulesToday.absenceGraceWorkingDays}-working-day grace (backfilling hours removes it) · join/resign: no proration — unworked working days simply count as absences.</p>
              </div>
              <div>
                <p className="font-semibold text-[#1F1D1B] mb-1">Allowance & statutory</p>
                <p>Efficiency allowance: flat amount on target (per worker, Employee Master) · EPF {payRulesToday.epfEmployeePct}%/{payRulesToday.epfEmployerPct}% · SOCSO RM{(payRulesToday.socsoEmployeeSen / 100).toFixed(2)}/{(payRulesToday.socsoEmployerSen / 100).toFixed(2)} · EIS RM{(payRulesToday.eisEmployeeSen / 100).toFixed(2)}/{(payRulesToday.eisEmployerSen / 100).toFixed(2)} (per-worker toggle).</p>
              </div>
            </div>
            {/* One tidy "where to adjust" strip instead of a 7th box hanging
                under the grid (owner 2026-06-11: the panel read messy). */}
            <div className="mt-3 border-t border-[#E2DDD8] pt-2 text-xs text-[#4B5563]">
              <p><b className="text-[#1F1D1B]">Where to adjust</b> — <b>per worker</b> (salary with effective date · Working days/month · Hours/day · OT multiplier · statutory toggles · allowance): Employee Master · <b>public holidays</b>: the Public Holidays panel · <b>everything else</b> (divisor choices, shift, lunch, grace, OT ×, statutory rates): schedule a change below — it takes effect ON its date.</p>
            </div>
            <div className="mt-3 border-t border-[#E2DDD8] pt-2 text-xs text-[#4B5563]">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="font-semibold text-[#1F1D1B]">Scheduled rule changes (effective-dated)</p>
                {!ruleDraftOpen && (
                  <Button variant="outline" size="sm" onClick={openRuleDraft}>
                    Schedule a change
                  </Button>
                )}
              </div>
              {payRuleVersionList.length === 0 && !ruleDraftOpen && (
                <p className="mt-1 text-[#9CA3AF]">No changes scheduled — the built-in defaults above apply.</p>
              )}
              {payRuleVersionList.length > 0 && (
                <div className="mt-1 space-y-1">
                  {payRuleVersionList.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1">
                      <span>
                        <b>From {v.effectiveFrom}</b> — day ÷{v.rules.dayRateDivisorMode === "calendarDays" ? "cal" : v.rules.dayRateDivisorMode === "workingDays" ? "work-days" : "26"} · hour ÷{v.rules.hourRateDivisorMode === "fixed" ? v.rules.rateHoursPerDay : v.rules.hourRateDivisorMode === "hoursOnly" ? "hours" : "hours+lunch"} · Sun {v.rules.sundayOtMultiplier}× · PH {v.rules.holidayOtMultiplier}× · grace {v.rules.lateGraceMin}m · block {v.rules.lateBlockMin}m · lunch {v.rules.lunchMin}m · {minToHhmm(v.rules.shiftStartMin)}–{minToHhmm(v.rules.shiftEndMin)}
                        {v.note ? <span className="text-[#9CA3AF]"> · {v.note}</span> : null}
                      </span>
                      {v.effectiveFrom > todayYmdMY() && (
                        <button
                          type="button"
                          onClick={() => deleteRuleVersion(v.id)}
                          className="rounded border border-[#E2B8AE] px-1.5 py-0.5 text-[10px] text-[#9A3A2D] hover:bg-[#FBEAE6]"
                          title="Remove this future-dated change (history in force cannot be deleted)"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {ruleDraftOpen && (
                <div className="mt-2 rounded-md border border-[#E2DDD8] bg-white p-3">
                  {/* Two columns (owner 2026-06-11 "左右排列"): settings on the
                      left, a LIVE worked example on the right that recomputes
                      as you type — explanation first, then adjust. */}
                  <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
                    <div className="space-y-3">
                      <label className="block text-[11px] text-[#6B7280] max-w-[220px]">
                        Effective from
                        <Input
                          type="date"
                          value={ruleDraft.effectiveFrom ?? ""}
                          onChange={(e) => ruleDraftField("effectiveFrom", e.target.value)}
                          className="mt-0.5 h-8 text-xs"
                        />
                      </label>

                      <div>
                        <p className="text-[11px] font-semibold text-[#6B5C32] uppercase tracking-wide mb-1">1 · Day & hour rate</p>
                        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 max-md:grid-cols-1">
                          <label className="text-[11px] text-[#6B7280]">
                            Day rate = salary ÷ …
                            <select
                              value={ruleDraft.dayRateDivisorMode ?? "fixed26"}
                              onChange={(e) => ruleDraftField("dayRateDivisorMode", e.target.value)}
                              className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                            >
                              <option value="fixed26">26 — Working days/month (fixed)</option>
                              <option value="calendarDays">Calendar days (30/31)</option>
                              <option value="workingDays">Actual working days of the month</option>
                            </select>
                          </label>
                          <label className="text-[11px] text-[#6B7280]">
                            Hour rate = day rate ÷ …
                            <select
                              value={ruleDraft.hourRateDivisorMode ?? "hoursPlusLunch"}
                              onChange={(e) => ruleDraftField("hourRateDivisorMode", e.target.value)}
                              className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                            >
                              <option value="hoursPlusLunch">Worker&rsquo;s hours + lunch (9+1 = ÷10)</option>
                              <option value="hoursOnly">Worker&rsquo;s hours only (÷9)</option>
                              <option value="fixed">Fixed number (below)</option>
                            </select>
                          </label>
                          <label className="text-[11px] text-[#6B7280]">
                            Fixed ÷ / fallback
                            <Input
                              type="number"
                              value={ruleDraft.rateHoursPerDay ?? ""}
                              onChange={(e) => ruleDraftField("rateHoursPerDay", e.target.value)}
                              className="mt-0.5 h-8 text-xs"
                            />
                          </label>
                        </div>
                      </div>

                      <div>
                        <p className="text-[11px] font-semibold text-[#6B5C32] uppercase tracking-wide mb-1">2 · Shift & lateness</p>
                        <div className="grid grid-cols-2 gap-2 md:grid-cols-5 max-md:grid-cols-2 max-sm:grid-cols-1">
                          {([
                            ["shiftStart", "Shift start (HH:MM)", "text"],
                            ["shiftEnd", "Shift end (HH:MM)", "text"],
                            ["lunchMin", "Lunch (min)", "number"],
                            ["lateGraceMin", "Late grace (min)", "number"],
                            ["lateBlockMin", "Late block (min)", "number"],
                          ] as Array<[string, string, string]>).map(([k, label, type]) => (
                            <label key={k} className="text-[11px] text-[#6B7280]">
                              {label}
                              <Input
                                type={type}
                                value={ruleDraft[k] ?? ""}
                                onChange={(e) => ruleDraftField(k, e.target.value)}
                                className="mt-0.5 h-8 text-xs"
                              />
                            </label>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-[11px] font-semibold text-[#6B5C32] uppercase tracking-wide mb-1">3 · Overtime & absence</p>
                        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 max-md:grid-cols-1">
                          {([
                            ["sundayOtMultiplier", "Sunday OT ×", "number"],
                            ["holidayOtMultiplier", "Holiday OT ×", "number"],
                            ["absenceGraceWorkingDays", "Absence grace (working days)", "number"],
                          ] as Array<[string, string, string]>).map(([k, label, type]) => (
                            <label key={k} className="text-[11px] text-[#6B7280]">
                              {label}
                              <Input
                                type={type}
                                value={ruleDraft[k] ?? ""}
                                onChange={(e) => ruleDraftField(k, e.target.value)}
                                className="mt-0.5 h-8 text-xs"
                              />
                            </label>
                          ))}
                        </div>
                      </div>

                      {/* Statutory follows the law (owner: "Statutory 是跟着
                          我们的,基本上不用填写") — tucked away, opened only
                          when the law actually changes. */}
                      <details className="rounded border border-[#E8E2DC] bg-[#FBF9F7] px-2 py-1.5">
                        <summary className="cursor-pointer text-[11px] font-semibold text-[#6B7280]">
                          4 · Statutory (EPF / SOCSO / EIS) — follows the law, usually leave as-is
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 max-md:grid-cols-1">
                          {([
                            ["epfEmployeePct", "EPF employee %", "number"],
                            ["epfEmployerPct", "EPF employer %", "number"],
                            ["socsoEmployee", "SOCSO employee (RM)", "number"],
                            ["socsoEmployer", "SOCSO employer (RM)", "number"],
                            ["eisEmployee", "EIS employee (RM)", "number"],
                            ["eisEmployer", "EIS employer (RM)", "number"],
                          ] as Array<[string, string, string]>).map(([k, label, type]) => (
                            <label key={k} className="text-[11px] text-[#6B7280]">
                              {label}
                              <Input
                                type={type}
                                value={ruleDraft[k] ?? ""}
                                onChange={(e) => ruleDraftField(k, e.target.value)}
                                className="mt-0.5 h-8 text-xs"
                              />
                            </label>
                          ))}
                        </div>
                      </details>

                      <label className="block text-[11px] text-[#6B7280]">
                        Note (optional)
                        <Input
                          value={ruleDraft.note ?? ""}
                          onChange={(e) => ruleDraftField("note", e.target.value)}
                          className="mt-0.5 h-8 text-xs"
                        />
                      </label>
                    </div>

                    <RuleDraftExplainer d={ruleDraft} />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={saveRuleDraft} disabled={!ruleDraftValid || savingRules}>
                      {savingRules ? "Saving…" : "Save scheduled change"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setRuleDraftOpen(false)} disabled={savingRules}>
                      Cancel
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-[#9CA3AF]">
                    Takes effect ON the chosen date: punches, payroll, labor cost and the worker app all switch that day. Months already finalised are untouched (regenerate to re-price a draft month).
                  </p>
                </div>
              )}
            </div>
            </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ========== TAB 5b: LABOR COST ==========
//
// Per (department × category) labor cost vs same-period category revenue.
// Cost is computed in the browser by summing working_hour_entries.hours
// scaled by each worker's hourly rate (basicSalarySen ÷ 26 ÷ 9, with OT
// hours above 9/day getting × otMultiplier). Revenue is "Production Revenue"
// from /api/working-hour-entries/production-revenue — recognized the day
// each item completes UPHOLSTERY (the final assembly stage), not at SO
// creation. This lines revenue up against the period the labor was actually
// burned, instead of months earlier when the SO was first opened.
//
// Production Shortfall + Warehousing rows are visually highlighted as the
// "burning money" buckets. Per spec, Production Shortfall is shown ONLY at
// the dept-total level (no per-employee drill) so the metric stays
// blame-free.

type LaborCostRow = {
  id: string;
  departmentCode: string;
  departmentName: string;
  category: Category;
  hours: number;
  laborCostSen: number;
  revenueSen: number;          // category revenue (same value across all rows of the same category)
  isProduction: boolean;
  isShortfall: boolean;
  isWarehousing: boolean;
};

function periodToDateRange(period: string): { from: string; to: string } {
  // period format: YYYY-MM
  const [yStr, mStr] = period.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) {
    const today = todayStr();
    return { from: today, to: today };
  }
  const from = `${yStr}-${mStr}-01`;
  // last day of month — use day 0 of next month
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${yStr}-${mStr}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

// True only when the selected From→To window is exactly one whole calendar
// month — i.e. From is the 1st of a month AND To is the last day of that SAME
// month. A partial week (25–31 May), a multi-month span, or any other window
// returns false. The Payroll Reconciliation panel (which reconciles to a
// MONTHLY payroll total) only makes sense for a full single month; every other
// range gets the payslip-independent hours-gap list instead.
function isFullSingleMonth(from: string, to: string): boolean {
  if (!from || !to) return false;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return false;
  // From must be the 1st, and From/To must be the same calendar month.
  if (fd !== 1 || fy !== ty || fm !== tm) return false;
  // To must be the last day of that month.
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return td === lastDay;
}

// True only once a calendar month is fully OVER (we're in a later month).
// Payroll is final only at month-end, so the full Payroll-tally views (Labor
// Cost reconciliation, Department Labor fully-loaded) are gated on this: an
// in-progress month is still being logged, so those views ACCUMULATE rather
// than jump to the whole month's payroll. `period` is "YYYY-MM". String compare
// of YYYY-MM is chronological and handles year boundaries.
function monthIsFinished(period: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(period)) return false;
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return period < current;
}

function buildPeriodOptions(): { value: string; label: string }[] {
  // Roll back 12 months from today so users can compare against the prior year.
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    out.push({ value: `${y}-${m}`, label: `${monthName} ${y}` });
  }
  return out;
}

// Inline panel — create / edit / delete departments. Lives under LaborCostTab
// but operates on the same /api/departments source-of-truth that every dept
// dropdown across the page reads from. New depts appear immediately in
// Working Hours / Employee Master / Labor Cost dropdowns via the shared
// useCachedJson cache invalidation triggered by `refresh`.
function DepartmentsManager({
  departments,
  refresh,
}: {
  departments: DepartmentLite[];
  refresh: () => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [creating, setCreating] = useState(false);
  // Hrs/Day is a legacy schema column kept at default 9 — not surfaced in
  // this UI because the runtime never reads it (worker-level
  // workers.workingHoursPerDay is the source for any per-worker hours, and
  // hourly-rate / OT calc uses a fixed 9-hour standard day).
  const [draft, setDraft] = useState<{ code: string; name: string; shortName: string; sequence: number; color: string; isProduction: boolean }>({
    code: "",
    name: "",
    shortName: "",
    sequence: (departments.reduce((m, d) => Math.max(m, d.sequence ?? 0), 0) || 0) + 1,
    color: "#6B7280",
    isProduction: false,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DepartmentLite | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(draft.code)) {
      toast.error("Code must be UPPERCASE letters / digits / underscore, starting with a letter");
      return;
    }
    if (!draft.name.trim()) { toast.error("Name required"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      toast.success(`Created ${draft.code}`);
      setCreating(false);
      setDraft({ code: "", name: "", shortName: "", sequence: draft.sequence + 1, color: "#6B7280", isProduction: false });
      invalidateCachePrefix("/api/departments");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (d: DepartmentLite) => {
    setEditingId(d.id);
    setEditDraft({ ...d });
  };

  const saveEdit = async () => {
    if (!editDraft || !editingId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/departments/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editDraft.name,
          shortName: editDraft.shortName,
          sequence: editDraft.sequence,
          color: editDraft.color,
          isProduction: editDraft.isProduction,
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      toast.success(`Updated ${editDraft.code}`);
      setEditingId(null);
      setEditDraft(null);
      invalidateCachePrefix("/api/departments");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: DepartmentLite) => {
    if (
      !(await confirm({
        title: `Delete department "${d.name}" (${d.code})?`,
        message: "This only succeeds if no worker is assigned to it. Cannot be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/departments/${d.id}`, { method: "DELETE" });
      const j = (await res.json()) as { success?: boolean; error?: string; workerCount?: number };
      if (res.status === 409) {
        toast.error(`${d.code} still has ${j.workerCount ?? "some"} worker(s) assigned — reassign them first`);
        return;
      }
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      toast.success(`Deleted ${d.code}`);
      invalidateCachePrefix("/api/departments");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 rounded-md border border-[#E2DDD8] bg-[#FAF7F1] p-3">
      {confirmDialog}
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-[#1F1D1B]">Manage Departments</h4>
        <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-3.5 w-3.5" /> {creating ? "Cancel" : "Add Department"}
        </Button>
      </div>
      {creating && (
        <div className="mb-3 rounded border border-[#6B5C32]/30 bg-white p-3 grid grid-cols-2 md:grid-cols-7 gap-2 max-md:grid-cols-2 max-sm:grid-cols-1">
          <div>
            <label className="text-xs text-[#6B7280]">Code</label>
            <Input value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value.toUpperCase() }))} placeholder="QC" className="h-8 text-xs" />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-[#6B7280]">Name</label>
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Quality Control" className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-xs text-[#6B7280]">Short</label>
            <Input value={draft.shortName} onChange={(e) => setDraft((d) => ({ ...d, shortName: e.target.value }))} placeholder="QC" className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-xs text-[#6B7280]">Seq</label>
            <Input type="number" onFocus={(e) => e.currentTarget.select()} value={draft.sequence} onChange={(e) => setDraft((d) => ({ ...d, sequence: parseInt(e.target.value) || 0 }))} className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-xs text-[#6B7280]">Color</label>
            <Input type="color" value={draft.color} onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))} className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-xs text-[#6B7280] flex items-center gap-1" title="Production depts require a Sofa/Bedframe/Accessory category on each working_hour_entries row">
              <input type="checkbox" checked={draft.isProduction} onChange={(e) => setDraft((d) => ({ ...d, isProduction: e.target.checked }))} />
              Production
            </label>
            <Button variant="primary" size="sm" onClick={() => void create()} disabled={busy} className="mt-1 w-full">
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#F0ECE9] text-[#374151]">
              <th className="h-8 px-2 text-left">Code</th>
              <th className="h-8 px-2 text-left">Name</th>
              <th className="h-8 px-2 text-left">Short</th>
              <th className="h-8 px-2 text-left w-12">Seq</th>
              <th className="h-8 px-2 text-left w-12">Color</th>
              <th className="h-8 px-2 text-left w-20">Production</th>
              <th className="h-8 px-2 text-left w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => {
              const editing = editingId === d.id && editDraft;
              return (
                <tr key={d.id} className="border-t border-[#E2DDD8]">
                  <td className="px-2 py-1 font-mono text-[#6B5C32]">{d.code}</td>
                  <td className="px-2 py-1">
                    {editing
                      ? <Input value={editDraft.name} onChange={(e) => setEditDraft((p) => p ? { ...p, name: e.target.value } : p)} className="h-7 text-xs" />
                      : d.name}
                  </td>
                  <td className="px-2 py-1">
                    {editing
                      ? <Input value={editDraft.shortName ?? ""} onChange={(e) => setEditDraft((p) => p ? { ...p, shortName: e.target.value } : p)} className="h-7 text-xs" />
                      : (d.shortName ?? "")}
                  </td>
                  <td className="px-2 py-1">
                    {editing
                      ? <Input type="number" onFocus={(e) => e.currentTarget.select()} value={editDraft.sequence ?? 0} onChange={(e) => setEditDraft((p) => p ? { ...p, sequence: parseInt(e.target.value) || 0 } : p)} className="h-7 w-12 text-xs" />
                      : (d.sequence ?? "")}
                  </td>
                  <td className="px-2 py-1">
                    {editing
                      ? <Input type="color" value={editDraft.color ?? "#6B7280"} onChange={(e) => setEditDraft((p) => p ? { ...p, color: e.target.value } : p)} className="h-7 w-12" />
                      : <span className="inline-block h-4 w-8 rounded border border-[#E2DDD8]" style={{ background: d.color ?? "#6B7280" }} />}
                  </td>
                  <td className="px-2 py-1">
                    {editing
                      ? <input type="checkbox" checked={editDraft.isProduction} onChange={(e) => setEditDraft((p) => p ? { ...p, isProduction: e.target.checked } : p)} />
                      : (d.isProduction ? <span className="text-[#4F7C3A]">✓</span> : <span className="text-[#9CA3AF]">—</span>)}
                  </td>
                  <td className="px-2 py-1">
                    {editing ? (
                      <div className="flex gap-1">
                        <Button variant="primary" size="sm" onClick={() => void saveEdit()} disabled={busy}>
                          <Save className="h-3.5 w-3.5" /> Save
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setEditingId(null); setEditDraft(null); }}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(d)}
                          className="inline-flex items-center justify-center h-7 w-7 rounded text-[#6B5C32] hover:bg-[#F0ECE9]"
                          aria-label="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(d)}
                          className="inline-flex items-center justify-center h-7 w-7 rounded text-[#9A3A2D] hover:bg-[#F9E1DA]"
                          aria-label="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[#6B7280]">
        Code is immutable after creation (it's used as a soft FK by workers / working_hour_entries). Delete is blocked if any worker is still assigned to the dept — reassign them first.
      </p>
    </div>
  );
}

function LaborCostTab({
  workers,
  departments,
  productionDeptCodes,
  onDateChange,
}: {
  workers: Worker[];
  departments: DepartmentLite[];
  productionDeptCodes: Set<string>;
  onDateChange?: (from: string, to: string) => void;
}) {
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const prodCodes = productionDeptCodes.size > 0 ? productionDeptCodes : PRODUCTION_DEPT_CODES;
  const { confirm, confirmDialog } = useConfirm();
  // Department CRUD lives on the Department Labor tab now (per user request -
  // a "Department Cost" management view). Labor Cost just consumes the
  // department list.
  // Collapse state for the three tables - by default Production stays open
  // (the headline view), Overhead + Revenue Raw Data collapse so the
  // page doesn't scroll forever. Persisted across renders only; resets
  // when the tab unmounts.
  const [showProduction, setShowProduction] = useState(true);
  const [showOverhead, setShowOverhead] = useState(false);
  const [showRevenueRaw, setShowRevenueRaw] = useState(false);
  const periodOptions = useMemo(() => buildPeriodOptions(), []);
  // `period` keeps the existing month dropdown working as a quick-jump preset.
  // When the user picks a month, we re-derive from/to. When they tweak the
  // date inputs directly, `period` stays in sync only if their range matches
  // an exact calendar month — otherwise it drops to "" (Custom). Last
  // selection (period + explicit from/to) is persisted in localStorage so
  // tab-switching keeps the operator's chosen window.
  const persistedLaborCost = useMemo(
    () => readPersistedDateRange("employees:labor-cost:dateRange"),
    [],
  );
  const persistedLaborCostPeriod = useMemo(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("employees:labor-cost:period");
      return typeof raw === "string" ? raw : null;
    } catch {
      return null;
    }
  }, []);
  const [period, setPeriod] = useState<string>(
    () => persistedLaborCostPeriod ?? (periodOptions[0]?.value ?? ""),
  );
  const initialRange = useMemo(
    () => periodToDateRange(periodOptions[0]?.value ?? ""),
    [periodOptions],
  );
  const [fromDate, setFromDate] = useState<string>(
    () => persistedLaborCost.from ?? initialRange.from,
  );
  const [toDate, setToDate] = useState<string>(
    () => persistedLaborCost.to ?? initialRange.to,
  );
  useEffect(() => {
    writePersistedDateRange("employees:labor-cost:dateRange", fromDate, toDate);
    onDateChange?.(fromDate, toDate);
  }, [fromDate, toDate, onDateChange]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("employees:labor-cost:period", period);
    } catch {
      /* non-fatal */
    }
  }, [period]);
  const from = fromDate;
  const to = toDate;
  // Optional category slice ("" = All). When non-empty, EVERY metric on this
  // tab — KPI cards, per-dept rollup — narrows to just the chosen product
  // category so an operator can answer "what did
  // {Sofa|Bedframe|Accessory} cost / earn / produce on this date range".
  // Borrowed (Warehousing) and Shortfall are NOT category-tagged
  // labor — they show their per-period totals regardless of filter so
  // operators don't lose sight of them.
  const [categoryFilter, setCategoryFilter] = useState<"" | "SOFA" | "BEDFRAME" | "ACCESSORY">("");


  const handlePeriodChange = useCallback((p: string) => {
    setPeriod(p);
    if (p) {
      const r = periodToDateRange(p);
      setFromDate(r.from);
      setToDate(r.to);
    }
  }, []);
  const handleFromChange = useCallback((v: string) => {
    setFromDate(v);
    setPeriod(""); // dropping to Custom — the dropdown shows "Custom range"
  }, []);
  const handleToChange = useCallback((v: string) => {
    setToDate(v);
    setPeriod("");
  }, []);

  // Working hour entries for the selected month.
  const entriesUrl = useMemo(
    () => `/api/working-hour-entries?from=${from}&to=${to}`,
    [from, to],
  );
  const { data: entriesResp, loading: entriesLoading } = useCachedJson<{
    success?: boolean;
    data?: WorkingHourEntry[];
  }>(entriesUrl);

  // Same-period revenue, bucketed by product category. "Production Revenue"
  // is realized the day each item completes UPHOLSTERY, not at SO creation —
  // see /api/working-hour-entries/production-revenue.
  const prodRevUrl = useMemo(
    () => `/api/working-hour-entries/production-revenue?from=${from}&to=${to}`,
    [from, to],
  );
  const { data: plResp, loading: plLoading } = useCachedJson<{
    success?: boolean;
    data?: {
      SOFA?: number;
      BEDFRAME?: number;
      ACCESSORY?: number;
      totalSen?: number;
      rows?: Array<{
        date: string;
        productCode: string;
        productName: string;
        category: "SOFA" | "BEDFRAME" | "ACCESSORY";
        qty: number;
        unitPriceSen: number;
        totalPriceSen: number;
        customerName: string;
        soNo: string;
      }>;
      // Per-(deptCode, category) attributed revenue, keyed "DEPT|CATEGORY".
      // Each dept gets a share of every recognized PO's revenue proportional
      // to that dept's job-card minutes within the PO. Summed across all
      // recognized POs in the period. Rolls up to the same SOFA/BEDFRAME/
      // ACCESSORY totals so the breakdown table reconciles with KPI cards.
      byDeptCategory?: Record<string, number>;
    };
  }>(prodRevUrl);

  const workersById = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  // Public holidays — drive the holiday-adjusted production-cost day rate.
  const { data: holidaysResp } = useCachedJson<{ data?: string[] }>(
    "/api/kv-config/public_holidays",
  );
  const holidayList = useMemo(
    () => (Array.isArray(holidaysResp?.data) ? holidaysResp.data : []),
    [holidaysResp],
  );

  // Payroll reconciliation — pull the SAME period's payslips so the Labor
  // Cost buckets (logged factory hours × rate) can be reconciled against the
  // full Total Payroll Cost. Labor Cost only counts workers who logged
  // production-dept hours; office / sales / admin / drivers and the company's
  // employer statutory contributions (EPF/SOCSO/EIS ER) never appear in
  // working_hour_entries, so the buckets always undershoot payroll. We add two
  // residual buckets below so the breakdown tallies EXACTLY to payroll.
  //
  // Derive YYYY-MM the same way the labor-cost day-rate does: prefer the
  // month dropdown (`period`), else the From date. If From/To straddle two
  // calendar months we still use the From month — the reconciliation note
  // tells the operator the payroll figure is for a single calendar month.
  const payrollPeriod = (period || from || "").slice(0, 7);
  const payrollMonthLabel = useMemo(() => {
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const y = payrollPeriod.slice(0, 4);
    const mIdx = (Number(payrollPeriod.slice(5, 7)) || 1) - 1;
    return `${monthNames[Math.min(11, Math.max(0, mIdx))]} ${y}`;
  }, [payrollPeriod]);
  const { data: reconPayslipResp, refresh: refreshRecon } = useCachedJson<unknown>(
    payrollPeriod ? `/api/payslips?period=${payrollPeriod}` : null,
  );
  const reconPayslips: PayslipData[] = useMemo(
    () => asArray(reconPayslipResp) as PayslipData[],
    [reconPayslipResp],
  );

  // Each worker's day-weighted EFFECTIVE salary for the period (handles a
  // mid-month / past raise) so the reconciliation rates match the payslips. With
  // no salary changes this equals the current scalar, so it's a no-op until a
  // raise is recorded. Falls back to the worker's scalar on miss.
  const { data: effSalaryResp } = useCachedJson<{ data?: Record<string, number> }>(
    payrollPeriod ? `/api/workers/salary/effective?period=${payrollPeriod}` : null,
  );
  const effSalaryByWorker = useMemo(() => {
    const m = new Map<string, number>();
    const d = effSalaryResp?.data ?? {};
    for (const k of Object.keys(d)) m.set(k, Number(d[k]) || 0);
    return m;
  }, [effSalaryResp]);
  const effSalaryOf = useCallback(
    (w: { id: string; basicSalarySen: number }) =>
      effSalaryByWorker.get(w.id) ?? w.basicSalarySen,
    [effSalaryByWorker],
  );

  // ---- Under-recorded review: docks + actions -----------------------------
  // Owner-applied short-hour docks for the month (the same table payslip
  // generation reads). Drives the "Docked this month" undo list below.
  const { data: deductionsResp, refresh: refreshDeductions } = useCachedJson<{
    // source: 'MANUAL' (owner, from this review) vs 'AUTO' (from a late/short
    // punch). Older rows omit it → treated as MANUAL.
    data?: Array<{ id: string; workerId: string; date: string; hours: number; source?: string }>;
  }>(payrollPeriod ? `/api/payroll-hour-deductions?period=${payrollPeriod}` : null);
  // Effective-dated pay rules (multipliers / hour divisor / grace per date).
  const payRuleVersions = usePayRuleVersions();

  // Owner 2026-07-04 (FULL auto): the manual Keep-pay / Deduct choice is retired.
  // Every under-settled day auto-docks its shortfall (POST /settle-period, run
  // live on punch-out and on demand via "Settle from punches"). The drill-in
  // panels are now READ-ONLY summaries of what the system settled; the only
  // remaining action is Undo on a stored dock (handleUndoDeduction below), which
  // still restores pay for a wrong auto-dock.
  const [undoBusy, setUndoBusy] = useState<string | null>(null);

  // Undo a dock → delete it + regenerate so the worker's pay is restored.
  const handleUndoDeduction = useCallback(
    async (id: string) => {
      if (
        !(await confirm({
          title: "Undo this deduction?",
          message: "Delete this short-hour dock and regenerate the payslip? This restores the worker's pay for the period.",
          confirmLabel: "Undo deduction",
          tone: "danger",
        }))
      ) {
        return;
      }
      setUndoBusy(`undo|${id}`);
      try {
        const r = await fetch(`/api/payroll-hour-deductions/${id}`, {
          method: "DELETE",
        });
        if (!r.ok) throw new Error(`undo ${r.status}`);
        await fetch("/api/payslips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ period: payrollPeriod, regenerate: true }),
        });
        invalidateCachePrefix("/api/payslips");
        invalidateCachePrefix("/api/payroll-hour-deductions");
        refreshDeductions?.();
        refreshRecon?.();
      } catch (e) {
        console.error("[undo-deduction]", e);
      } finally {
        setUndoBusy(null);
      }
    },
    [payrollPeriod, refreshRecon, refreshDeductions, confirm],
  );

  // FULL-AUTO settle the whole month (owner 2026-07-04, A). Docks every
  // under-settled day — from the punch shift rules AND from under-logged
  // Working Hours (expected − logged) — then regenerates once so pay reflects
  // the docks. Idempotent and heavily guarded server-side (finalised month →
  // skip, a MANUAL dock is never overridden, full day clears stale AUTO). Live
  // punch-out already settles day by day; this catches up a whole month at once.
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleResult, setSettleResult] = useState<string | null>(null);
  const handleSettleFromPunches = useCallback(async () => {
    if (!payrollPeriod) return;
    if (
      !(await confirm({
        title: "Auto-settle this month?",
        message: `Apply the shift rules (≥9h, late past grace, OT from 30 min past 18:00) to every punch AND auto-dock under-logged (To-fill) days in ${payrollMonthLabel}, then regenerate payslips? Every under-settled day docks its shortfall at the ÷26 hourly rate — no manual pick. Your own MANUAL Keep-pay / Deduct decisions are never overridden, and an already-approved month is not touched.`,
        confirmLabel: "Settle now",
      }))
    ) {
      return;
    }
    setSettleBusy(true);
    setSettleResult(null);
    try {
      const r = await fetch("/api/payroll-hour-deductions/settle-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: payrollPeriod }),
      });
      const j = (await r.json()) as {
        success?: boolean;
        data?: {
          applied: number;
          "no-shortfall": number;
          "period-locked": number;
          "manual-exists": number;
          "punch-source": number;
          "logged-source": number;
          dockedHours: number;
          periodLocked: boolean;
        };
        error?: string;
      };
      if (!r.ok || !j.success) throw new Error(j.error || `settle ${r.status}`);
      const d = j.data;
      if (d) {
        setSettleResult(
          d.periodLocked
            ? "Month already finalised — nothing changed (un-approve first to re-settle)."
            : `${d.applied} day(s) auto-docked (${d.dockedHours}h — ${d["punch-source"]} from punches, ${d["logged-source"]} from under-logged hours), ${d["no-shortfall"]} full day(s), ${d["manual-exists"]} left on your manual pick.`,
        );
      }
      // Regenerate once so the docks land in pay (same as a single dock).
      await fetch("/api/payslips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: payrollPeriod, regenerate: true }),
      });
      invalidateCachePrefix("/api/payslips");
      invalidateCachePrefix("/api/payroll-hour-deductions");
      refreshDeductions?.();
      refreshRecon?.();
    } catch (e) {
      console.error("[settle-from-punches]", e);
      setSettleResult("Could not settle — please try again.");
    } finally {
      setSettleBusy(false);
    }
  }, [payrollPeriod, payrollMonthLabel, confirm, refreshDeductions, refreshRecon]);

  // Index departments by code once so the per-row / per-worker reconciliation
  // loops below do O(1) lookups instead of allDepts.find() on every iteration.
  const deptByCode = useMemo(
    () => new Map(allDepts.map((d) => [d.code, d] as const)),
    [allDepts],
  );

  const rows: LaborCostRow[] = useMemo(() => {
    const entries = (entriesResp?.success ? entriesResp.data ?? [] : []) as WorkingHourEntry[];
    const revData = plResp?.success ? plResp.data ?? {} : {};
    // Per-(dept, category) attributed revenue from /production-revenue.
    // Each PO recognized in the period splits its revenue across its depts
    // weighted by job-card minutes — see endpoint comments. Falls back to
    // an empty map when the API hasn't returned the new field yet (older
    // deployments) so the table still renders with zeroes rather than NaN.
    const byDeptCategory: Record<string, number> = revData.byDeptCategory ?? {};

    // Production-cost divisor = the ACTUAL Mon-Sat working days in this month
    // minus public holidays (mirrors labor-engine costingDivisor), NOT a fixed
    // 26. The OT base rate stays on the nominal 26 so OT pay matches payroll.
    const [hYear, hMonth] = (period || from).slice(0, 7).split("-").map(Number);
    const actualWorkingDays =
      hYear && hMonth
        ? Math.max(
            1,
            countElapsedWorkingDays(hYear, hMonth, new Date(hYear, hMonth, 0).getDate(), holidayList),
          )
        : 26;

    // Group by (departmentCode, category). Hours summed; cost = sum over each
    // entry of regular_hours × regular_rate + ot_hours × ot_base_rate × multiplier.
    type Bucket = { hours: number; laborCostSen: number };
    const buckets = new Map<string, Bucket>();

    // Pro-rata OT split per (worker, date): if a worker did 11h split as
    // 5h Webbing + 6h Framing, the 2h OT is distributed proportionally
    // (Webbing 5/11, Framing 6/11) — NOT given to whichever segment
    // happens to push cumulative hours past 9 in DB-row order. Order-
    // dependent split was the v1 implementation; user flagged it as unfair
    // since the same total workday could attribute different OT to the
    // same dept depending on data-entry sequence.
    const segsByWorkerDate = new Map<string, WorkingHourEntry[]>();
    for (const e of entries) {
      const k = `${e.workerId}|${e.date}`;
      const arr = segsByWorkerDate.get(k) ?? [];
      arr.push(e);
      segsByWorkerDate.set(k, arr);
    }

    for (const [k, segs] of segsByWorkerDate.entries()) {
      const [workerId] = k.split("|");
      const w = workersById.get(workerId);
      if (!w || !w.basicSalarySen) continue;
      // Per-worker rates — OT threshold, hours/day and days/month all come
      // from this worker's own Employee Master figures (no hard-coded 9 h).
      // Salary = the month's EFFECTIVE (day-weighted) figure so the rate matches
      // the payslip after a raise (no-op when the salary never changed).
      const effSalarySen = effSalaryOf(w);
      const stdHours = w.workingHoursPerDay > 0 ? w.workingHoursPerDay : 9;
      const monthDays = w.workingDaysPerMonth > 0 ? w.workingDaysPerMonth : 26;
      const regularDays = actualWorkingDays;
      const regularRateSen = effSalarySen / regularDays / stdHours;
      const otBaseRateSen = effSalarySen / monthDays / stdHours;
      const otMult = w.otMultiplier ?? 1.5;
      const totalH = segs.reduce((s, e) => s + (Number(e.hours) || 0), 0);
      // Day-typed OT (owner spec 2026-06-10): Sunday → all hours at 2×, public
      // holiday → all hours at 3×, weekday → hours above the standard day at the
      // worker's multiplier — mirrors labor-engine.ts so cost ties to paid OT.
      const otDay = dayTypedOt(k.split("|")[1], holidayList, totalH, stdHours, otMult, payRuleVersions);
      const otShare = totalH > 0 ? otDay.otHours / totalH : 0;

      for (const e of segs) {
        const hours = Number(e.hours) || 0;
        const otH = hours * otShare;
        const regularH = hours - otH;
        const cost = regularH * regularRateSen + otH * otBaseRateSen * otDay.mult;
        // Defensive uppercase normalize so any pre-migration lower-case
        // rows in working_hour_entries.category still compare correctly.
        const cat = (typeof e.category === "string" ? e.category.trim().toUpperCase() : "") as Category;
        // When a category filter is active, only count entries tagged with
        // that category. Non-production buckets (Warehousing/Shortfall etc.)
        // have empty cat and fall through into the "always-show" branch
        // below - they are not category-tagged labor and stay visible so
        // operators don't lose sight of borrowed / idle hours.
        if (categoryFilter && cat !== categoryFilter && cat !== "") continue;
        const bucketKey = `${e.departmentCode}|${cat}`;
        const cur = buckets.get(bucketKey) ?? { hours: 0, laborCostSen: 0 };
        cur.hours += hours;
        cur.laborCostSen += cost;
        buckets.set(bucketKey, cur);
      }
    }

    // Materialise rows. Sort production depts first by sequence, then non-
    // production. Within a dept, order categories SOFA → BEDFRAME → ACCESSORY
    // → "" (non-production has only the empty bucket).
    const catOrder: Record<string, number> = { SOFA: 0, BEDFRAME: 1, ACCESSORY: 2, "": 3 };
    const out: LaborCostRow[] = [];
    for (const [key, b] of buckets.entries()) {
      const [departmentCode, category] = key.split("|") as [string, Category];
      const dept = deptByCode.get(departmentCode);
      const isProduction = prodCodes.has(departmentCode);
      out.push({
        id: key,
        departmentCode,
        departmentName: dept?.name ?? departmentCode,
        category,
        hours: Math.round(b.hours * 100) / 100,
        laborCostSen: roundSen(b.laborCostSen),
        revenueSen: isProduction && category
          ? (byDeptCategory[`${departmentCode}|${category}`] ?? 0)
          : 0,
        isProduction,
        isShortfall: departmentCode === "PRODUCTION_SHORTFALL",
        isWarehousing: departmentCode === "WAREHOUSING",
      });
    }
    out.sort((a, b) => {
      const seqA = allDepts.findIndex((d) => d.code === a.departmentCode);
      const seqB = allDepts.findIndex((d) => d.code === b.departmentCode);
      if (seqA !== seqB) return seqA - seqB;
      return (catOrder[a.category] ?? 99) - (catOrder[b.category] ?? 99);
    });
    return out;
  }, [entriesResp, plResp, workersById, period, from, to, allDepts, prodCodes, categoryFilter, holidayList, effSalaryOf, payRuleVersions]);

  // KPIs across the full table.
  const totalLaborCostSen = rows.reduce((s, r) => s + r.laborCostSen, 0);
  const productionLaborCostSen = rows
    .filter((r) => r.isProduction)
    .reduce((s, r) => s + r.laborCostSen, 0);
  const shortfallLaborCostSen = rows
    .filter((r) => r.isShortfall)
    .reduce((s, r) => s + r.laborCostSen, 0);
  const warehousingLaborCostSen = rows
    .filter((r) => r.isWarehousing)
    .reduce((s, r) => s + r.laborCostSen, 0);
  const totalRevenueSen = useMemo(() => {
    const rev = plResp?.success ? plResp.data ?? {} : {};
    // With a category filter, narrow Total Revenue to that bucket only.
    // production-revenue already returns per-category totals, so we just
    // pick the matching slice instead of summing all three.
    if (categoryFilter) {
      return Number(rev[categoryFilter]) || 0;
    }
    if (typeof rev.totalSen === "number") return rev.totalSen;
    return (Number(rev.SOFA) || 0) + (Number(rev.BEDFRAME) || 0) + (Number(rev.ACCESSORY) || 0);
  }, [plResp, categoryFilter]);
  // Top KPI used to show a Cost/Revenue percentage built from
  // productionLaborCostSen / totalRevenueSen (overhead buckets excluded
  // so Repair/Maintenance didn't pull the ratio). Replaced 2026-05-03 by
  // a "Remain" absolute RM value (Total Revenue − Production Labor Cost),
  // computed inline at the render site — see the Remain card below.
  // Repair + Maintenance + other overhead = total - production - shortfall - warehousing
  // Surfaced as a separate "Overhead" KPI so they're still visible but
  // don't muddy the production-only headline.
  const overheadLaborCostSen =
    totalLaborCostSen - productionLaborCostSen - shortfallLaborCostSen - warehousingLaborCostSen;

  // ---- Payroll reconciliation ----------------------------------------
  // Total Payroll Cost = Σ gross pay + Σ employer statutory contributions,
  // over every payslip in the same calendar month. This is the SAME formula
  // the Payroll tab shows as "Total Payroll Cost" so the two screens agree.
  // The category filter does NOT slice payroll (a worker's salary isn't
  // category-tagged), so reconciliation only renders when no category filter
  // is active — otherwise the buckets are a category subset and can't tally
  // to the full payroll.
  const payrollTotals = useMemo(() => {
    let grossSen = 0;
    let employerContribSen = 0;
    for (const p of reconPayslips) {
      grossSen += Number(p.grossPay) || 0;
      employerContribSen +=
        (Number(p.epfEmployer) || 0) +
        (Number(p.socsoEmployer) || 0) +
        (Number(p.eisEmployer) || 0);
    }
    return { grossSen, employerContribSen };
  }, [reconPayslips]);

  const totalGrossSen = payrollTotals.grossSen;
  const employerContribSen = payrollTotals.employerContribSen;
  // Full payroll cost the breakdown must reconcile to.
  const totalPayrollCostSen = totalGrossSen + employerContribSen;
  // Absence "non-productive paid": absent days are docked at the nominal ÷26
  // ordinary rate, but production loses the higher ÷working-days rate for the
  // same unworked day. This per-payslip difference (paid above production value
  // on absent days) is folded into each worker's HOME department bucket (see
  // `reconBurden`), and excluded from the under-recorded gap so that gap stays
  // pure. Holidays are already absorbed into the ÷working-days rate, so a
  // fully-attended worker contributes 0 here.
  const absenceLeniencyByPayslip = useMemo(() => {
    const m = new Map<string, number>();
    const [hY, hM] = (period || from).slice(0, 7).split("-").map(Number);
    const actualWorkingDays =
      hY && hM
        ? Math.max(1, countElapsedWorkingDays(hY, hM, new Date(hY, hM, 0).getDate(), holidayList))
        : 26;
    for (const p of reconPayslips) {
      const absent = Number(p.absentDays) || 0;
      if (absent <= 0) continue;
      // UNIFIED ÷26 model (owner 2026-06-11): everyone — full-month, joiner,
      // resigner — docks absence at ÷26 (the stored deduction); production
      // loses the ÷working-days rate. The bridge is the SIGNED difference (a
      // month with 27+ working days makes it negative — still attributed to
      // the dept line, not lost in the plug).
      const costEquivalentSen = Math.round(
        (absent * (Number(p.basicSalary) || 0)) / actualWorkingDays,
      );
      const leniency = costEquivalentSen - (Number(p.absenceDeductionSen) || 0);
      if (leniency !== 0) m.set(p.id, leniency);
    }
    return m;
  }, [reconPayslips, period, from, holidayList, workersById]);
  // OT pay-vs-cost adjustment — the SAME idea as the absence line, for overtime.
  // The labor buckets + loggedValue value OT at the production-cost rate
  // (÷ workingDaysPerMonth(26) ÷ workingHoursPerDay(9)); payroll now PAYS OT at the
  // spec's ÷26÷10. We read the difference from the payslip's STORED OT amount
  // (`totalOT`), so it auto-matches every month (old months stored at ÷9, new at
  // ÷10) with no date logic. (paid − cost) is folded onto the worker's HOME
  // department (reconBurden) and removed from the under-recorded gap, so the OT
  // difference lands on the department line instead of silently in the Overhead plug.
  const otAdjustmentByPayslip = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of reconPayslips) {
      // Day-typed OT cost at the ÷stdHours production rate — the SAME weighting
      // the logged cost buckets now use (weekday×mult + Sunday×2 + holiday×3).
      // The adjustment then bridges this to the day-typed PAID OT (p.totalOT, at
      // ÷10), so the Sunday/holiday premium lands on the worker's department line
      // instead of silently in the Overhead plug.
      const wkH = Number(p.otWeekdayHours) || 0;
      const sunH = Number(p.otSundayHours) || 0;
      const phH = Number(p.otPHHours) || 0;
      if (wkH + sunH + phH <= 0) continue;
      const w = p.employeeId ? workersById.get(p.employeeId) : undefined;
      const mult = w && w.otMultiplier && w.otMultiplier > 0 ? w.otMultiplier : 1.5;
      const stdHours = w && w.workingHoursPerDay > 0 ? w.workingHoursPerDay : 9;
      const monthDays = w && w.workingDaysPerMonth > 0 ? w.workingDaysPerMonth : 26;
      const otBaseSen = (Number(p.basicSalary) || 0) / monthDays / stdHours;
      // Effective-dated Sunday/holiday multipliers — as of this payslip's
      // period end (the rules that produced the stored OT).
      const [bY, bM] = (p.period || "").split("-").map(Number);
      const cfgEnd = resolvePayRulesAsOf(
        payRuleVersions,
        bY && bM
          ? `${p.period}-${String(new Date(bY, bM, 0).getDate()).padStart(2, "0")}`
          : "9999-12-31",
      );
      const costOtSen = Math.round(
        (wkH * mult + sunH * cfgEnd.sundayOtMultiplier + phH * cfgEnd.holidayOtMultiplier) *
          otBaseSen,
      );
      const paidOtSen = Number(p.totalOT) || 0;
      const adj = paidOtSen - costOtSen;
      if (adj !== 0) m.set(p.id, adj);
    }
    return m;
  }, [reconPayslips, workersById, payRuleVersions]);
  // Late/short-hour dock bridge — same idea as the absence leniency, for the
  // Deduct action (and AUTO punch docks). The dock reduces gross at the
  // UNIFIED pay rate (salary ÷ 26 ÷ 10 — RM7.88/h on RM2,050) but the
  // under-recorded gap measures the missing hours at the costing rate
  // (salary ÷ working days ÷ std hours). Bridge = docked hours ×
  // (costing hourly − dock hourly), folded onto the worker's department like
  // the absence bridge — so after a Deduct the worker's gap closes to RM0
  // (owner: "choose Deduct and the books tie") instead of leaving a ~RM5/h
  // residual flagged.
  const lateDockAdjByPayslip = useMemo(() => {
    const m = new Map<string, number>();
    const rows = deductionsResp?.data ?? [];
    if (!rows.length) return m;
    const [hY, hM] = (period || from).slice(0, 7).split("-").map(Number);
    if (!hY || !hM) return m;
    const aWD = Math.max(
      1,
      countElapsedWorkingDays(hY, hM, new Date(hY, hM, 0).getDate(), holidayList),
    );
    const calDays = new Date(hY, hM, 0).getDate();
    const dockHoursByWorker = new Map<string, number>();
    for (const r of rows) {
      dockHoursByWorker.set(
        r.workerId,
        (dockHoursByWorker.get(r.workerId) ?? 0) + (Number(r.hours) || 0),
      );
    }
    for (const p of reconPayslips) {
      const wid = p.employeeId;
      if (!wid) continue;
      const h = dockHoursByWorker.get(wid) ?? 0;
      if (h <= 0) continue;
      const w = workersById.get(wid);
      const std = w && w.workingHoursPerDay > 0 ? w.workingHoursPerDay : 9;
      const S = Number(p.basicSalary) || 0;
      const costEquivalentSen = Math.round((h * S) / aWD / std);
      // Same DAY rate + hour divisor the engine docks with (mode-aware:
      // ÷26 / ÷calendar / ÷working days, then ÷ the worker's span).
      const wDays = w && w.workingDaysPerMonth > 0 ? w.workingDaysPerMonth : 26;
      const cfgDock = resolvePayRulesAsOf(
        payRuleVersions,
        `${(period || from).slice(0, 7)}-${String(calDays).padStart(2, "0")}`,
      );
      const dockDayRate = payrollDayRateSen(
        S,
        { workingDaysPerMonth: wDays, calendarDays: calDays, workingDaysInMonth: aWD },
        cfgDock,
      );
      const dockSen = Math.round((h * dockDayRate) / payrollHourDivisor(w?.workingHoursPerDay, cfgDock));
      const adj = Math.max(0, costEquivalentSen - dockSen);
      if (adj > 0) m.set(p.id, adj);
    }
    return m;
  }, [deductionsResp, reconPayslips, period, from, holidayList, workersById, payRuleVersions]);
  // We only have payroll figures once payslips exist for the period. Hide the
  // reconciliation panel (rather than show a misleading negative residual)
  // when there are none or when a category filter is narrowing the buckets.
  const hasPayroll = reconPayslips.length > 0;
  // The payroll figure is a MONTHLY total (/api/payslips?period=YYYY-MM), so the
  // bucket-vs-payroll reconciliation only balances when the selected window is a
  // full single calendar month. For any other range (a single week, a partial
  // month, a multi-month span) the labor buckets cover only the selected days
  // while payroll is still the whole month — the residual and per-worker gaps
  // would be bogus. So we render the payroll reconciliation ONLY for a full
  // month, and fall back to a payslip-independent hours-gap list otherwise.
  const fullSingleMonth = isFullSingleMonth(from, to);
  // Only reconcile/tally a month that is OVER. While the current month is still
  // being logged, even if draft payslips exist, we DON'T jump to the full-month
  // payroll — the range-gap (accumulating) view shows instead, so Labor Cost
  // grows day by day and only ties out to Payroll once the month closes.
  const periodFinished = monthIsFinished(fullSingleMonth ? from.slice(0, 7) : (period || from).slice(0, 7));
  const showReconciliation =
    hasPayroll && !categoryFilter && fullSingleMonth && periodFinished;
  // The fully-burdened bucket display (each department's labor carries its own
  // workers' EPF + ÷-rate adjustment, leaving ONLY the under-recorded gap on its
  // own line) is computed AFTER the per-employee itemisation below, so it can
  // reuse the same per-worker under-logged figure. See `loadedBuckets` /
  // `reconciledSumSen` further down.

  // [REMOVED] nonProductionByDept — the old "residual by department" used
  // gross_dept − bucketed_dept and filtered to residual > 50, which surfaced
  // only the positive-residual departments and dropped the negative ones
  // (cross-department borrowing / OT make a dept's bucketed labor exceed its own
  // payroll). The visible rows therefore summed to far more than the net
  // residual line — a confusing mismatch. The clean per-department under-logged
  // figure is now `underLoggedByDept` (aggregated from the per-worker gaps).

  // ---- Per-employee itemisation of the Non-production salary residual ------
  // Finance can't accept a department-level residual — they need WHO and WHY.
  // The residual mixes two very different things that must be separated:
  //   1. Genuine non-production staff (admin / sales / management / drivers /
  //      QC) — they legitimately log no factory hours, so their whole salary
  //      belongs to admin / overhead. EXPECTED.
  //   2. Production-department workers who were PAID but whose Working Hours
  //      weren't fully logged (gross > logged-hours value). This is a DATA GAP
  //      (someone forgot to record their hours), NOT something to park — it
  //      must be flagged so the operator goes and records the missing hours.
  //
  // We compute each worker's logged labor-cost value with the SAME per-row
  // formula the labor buckets use (regularH × regularRate + otH × otBaseRate ×
  // multiplier, pro-rata OT split per worker/day), but aggregated per WORKER
  // instead of per (dept, category). No category filter is applied — the panel
  // only renders when no category filter is active.
  const loggedValueByWorker = useMemo(() => {
    const out = new Map<string, number>();
    const entries = (entriesResp?.success ? entriesResp.data ?? [] : []) as WorkingHourEntry[];
    const [hYear, hMonth] = (period || from).slice(0, 7).split("-").map(Number);
    const actualWorkingDays =
      hYear && hMonth
        ? Math.max(1, countElapsedWorkingDays(hYear, hMonth, new Date(hYear, hMonth, 0).getDate(), holidayList))
        : 26;

    // Group segments per (worker, date) so the OT threshold + pro-rata OT split
    // are applied against the worker's whole workday — identical to the bucket
    // calc above.
    const segsByWorkerDate = new Map<string, WorkingHourEntry[]>();
    for (const e of entries) {
      const k = `${e.workerId}|${e.date}`;
      const arr = segsByWorkerDate.get(k) ?? [];
      arr.push(e);
      segsByWorkerDate.set(k, arr);
    }
    for (const [k, segs] of segsByWorkerDate.entries()) {
      const [workerId] = k.split("|");
      const w = workersById.get(workerId);
      if (!w || !w.basicSalarySen) continue;
      const stdHours = w.workingHoursPerDay > 0 ? w.workingHoursPerDay : 9;
      const monthDays = w.workingDaysPerMonth > 0 ? w.workingDaysPerMonth : 26;
      const regularDays = actualWorkingDays;
      const effSalarySen = effSalaryOf(w);
      const regularRateSen = effSalarySen / regularDays / stdHours;
      const otBaseRateSen = effSalarySen / monthDays / stdHours;
      const otMult = w.otMultiplier ?? 1.5;
      const totalH = segs.reduce((s, e) => s + (Number(e.hours) || 0), 0);
      // Day-typed OT (owner spec 2026-06-10): Sunday → all hours at 2×, public
      // holiday → all hours at 3×, weekday → hours above the standard day at the
      // worker's multiplier — mirrors labor-engine.ts so cost ties to paid OT.
      const otDay = dayTypedOt(k.split("|")[1], holidayList, totalH, stdHours, otMult, payRuleVersions);
      const otShare = totalH > 0 ? otDay.otHours / totalH : 0;
      let dayValue = 0;
      for (const e of segs) {
        const hours = Number(e.hours) || 0;
        const otH = hours * otShare;
        const regularH = hours - otH;
        dayValue += regularH * regularRateSen + otH * otBaseRateSen * otDay.mult;
      }
      out.set(workerId, (out.get(workerId) ?? 0) + dayValue);
    }
    return out;
  }, [entriesResp, workersById, period, from, holidayList, effSalaryOf, payRuleVersions]);



  // Set of department codes the labor buckets cover (the 8 production depts +
  // WAREHOUSING + PRODUCTION_SHORTFALL + REPAIR + MAINTENANCE + R_AND_D). A
  // worker whose department is NOT in this set logs no factory hours by
  // design — that's genuine non-production staff.
  const factoryDeptCodes = useMemo(
    () => new Set(allDepts.map((d) => d.code)),
    [allDepts],
  );


  // Classify every active worker with a payslip into one of the two lists.
  const employeeResidual = useMemo(() => {
    const nonProductionStaff: Array<{
      id: string;
      name: string;
      deptCode: string;
      deptName: string;
      grossSen: number;
    }> = [];
    const underLoggedFactory: Array<{
      id: string;
      workerId: string | undefined;
      name: string;
      deptCode: string;
      deptName: string;
      grossSen: number;
      loggedValueSen: number;
      gapSen: number;
    }> = [];
    if (!showReconciliation) {
      return { nonProductionStaff, underLoggedFactory, nonProdSubtotalSen: 0, underLoggedSubtotalSen: 0 };
    }
    for (const p of reconPayslips) {
      const grossSen = Number(p.grossPay) || 0;
      if (grossSen <= 0) continue;
      const code = p.departmentCode || "UNASSIGNED";
      const dept = deptByCode.get(code);
      const w = p.employeeId ? workersById.get(p.employeeId) : undefined;
      const deptName = dept?.name ?? w?.name ?? (code === "UNASSIGNED" ? "Unassigned" : code);
      const name = p.employeeName || w?.name || p.employeeNo || "—";
      const isFactoryDept = factoryDeptCodes.has(code);
      if (!isFactoryDept) {
        // Genuine non-production staff — whole salary is the residual.
        nonProductionStaff.push({ id: p.id, name, deptCode: code, deptName, grossSen });
        continue;
      }
      // Factory-department worker: residual = paid − logged-hours value, less the
      // absence adjustment (which is folded into the department buckets), so this
      // gap is PURE under-recorded hours (came but logged < a full day). Round to
      // whole sen per worker so the Labor Cost total and the Department Labor tab
      // (which sums the same rounded per-worker gaps) show the identical figure.
      const loggedValueSen = p.employeeId ? loggedValueByWorker.get(p.employeeId) ?? 0 : 0;
      const gapSen = Math.round(
        grossSen -
          loggedValueSen -
          (absenceLeniencyByPayslip.get(p.id) ?? 0) -
          (otAdjustmentByPayslip.get(p.id) ?? 0) -
          // Docked late/short hours bridge — after a Deduct the gap closes to 0.
          (lateDockAdjByPayslip.get(p.id) ?? 0) -
          // Efficiency allowance is a flat bonus, not logged hours — it has its
          // OWN reconciliation line, so exclude it here or a fully-logged earner
          // shows a spurious ~RM150 "under-recorded" gap.
          (Number(p.allowances) || 0),
      );
      // A production worker fully reconciled (gap ≈ 0) is not a data gap. Use a
      // small tolerance so rounding noise doesn't flag a fully-logged worker.
      if (gapSen > 50) {
        underLoggedFactory.push({
          id: p.id,
          workerId: p.employeeId || undefined,
          name,
          deptCode: code,
          deptName,
          grossSen,
          loggedValueSen,
          gapSen,
        });
      }
    }
    nonProductionStaff.sort((a, b) => b.grossSen - a.grossSen);
    underLoggedFactory.sort((a, b) => b.gapSen - a.gapSen);
    const nonProdSubtotalSen = nonProductionStaff.reduce((s, r) => s + r.grossSen, 0);
    const underLoggedSubtotalSen = underLoggedFactory.reduce((s, r) => s + r.gapSen, 0);
    return { nonProductionStaff, underLoggedFactory, nonProdSubtotalSen, underLoggedSubtotalSen };
  }, [showReconciliation, reconPayslips, allDepts, workersById, factoryDeptCodes, loggedValueByWorker, absenceLeniencyByPayslip, otAdjustmentByPayslip, lateDockAdjByPayslip]);

  // (The per-department under-logged roll-up that used to live here was removed
  // with the under-logged worker panel — owner 2026-07-04, now fully auto-docked.)

  // ---- Fully-burdened department buckets --------------------------------
  // The owner wants each department's labor line to carry the FULL cost of its
  // own people — their EPF / SOCSO / EIS and the ÷26-vs-÷working-days absent-day
  // adjustment baked in — so the only thing left on its own line is the genuine
  // under-recorded hours (paid but not yet logged). We therefore drop the two
  // separate "Employer contributions" and "Working-day rate adjustment" lines
  // and spread those amounts back onto Production / Warehousing / Shortfall /
  // Overhead by each worker's HOME department. Office / sales / admin staff (no
  // known factory department) fold into Overhead with their whole salary.
  const reconBurden = useMemo(() => {
    const stat = { production: 0, warehousing: 0, shortfall: 0, overhead: 0 };
    const adj = { production: 0, warehousing: 0, shortfall: 0, overhead: 0 };
    let nonProdGrossSen = 0; // office / sales / admin (no factory dept) → Overhead
    const bucketOf = (
      code: string,
    ): "production" | "warehousing" | "shortfall" | "overhead" => {
      if (code === "PRODUCTION_SHORTFALL") return "shortfall";
      if (code === "WAREHOUSING") return "warehousing";
      if (prodCodes.has(code)) return "production";
      return "overhead";
    };
    for (const p of reconPayslips) {
      const code = p.departmentCode || "UNASSIGNED";
      const statutorySen =
        (Number(p.epfEmployer) || 0) +
        (Number(p.socsoEmployer) || 0) +
        (Number(p.eisEmployer) || 0);
      if (!factoryDeptCodes.has(code)) {
        // Unknown / unassigned department — the whole salary (which already
        // contains any absent-day adjustment) plus statutory sits in Overhead.
        stat.overhead += statutorySen;
        nonProdGrossSen += Number(p.grossPay) || 0;
        continue;
      }
      const b = bucketOf(code);
      stat[b] += statutorySen;
      adj[b] +=
        (absenceLeniencyByPayslip.get(p.id) ?? 0) +
        (otAdjustmentByPayslip.get(p.id) ?? 0) +
        // Docked late/short hours: the cost-vs-dock rate difference belongs on
        // the worker's department line (same treatment as the absence bridge).
        (lateDockAdjByPayslip.get(p.id) ?? 0) +
        // Efficiency allowance — folded into the worker's department line
        // (owner 2026-06-11: "平摊进去就不用单独 show"), matching the
        // Department Labor tab exactly, so both tabs' production lines agree.
        (Number(p.allowances) || 0);
    }
    return { stat, adj, nonProdGrossSen };
  }, [reconPayslips, absenceLeniencyByPayslip, otAdjustmentByPayslip, lateDockAdjByPayslip, prodCodes, factoryDeptCodes]);

  // Loaded department buckets = logged labor + that department's own statutory
  // + its absent-day adjustment. Production / Warehousing / Shortfall computed
  // directly; Overhead is the closing plug so the column ALWAYS totals exactly
  // to Total Payroll Cost (it absorbs its own overhead labor + statutory + adj +
  // any office/sales salaries + sub-ringgit rounding).
  const loadedProductionSen =
    productionLaborCostSen + reconBurden.stat.production + reconBurden.adj.production;
  const loadedWarehousingSen =
    warehousingLaborCostSen + reconBurden.stat.warehousing + reconBurden.adj.warehousing;
  const loadedShortfallSen =
    shortfallLaborCostSen + reconBurden.stat.shortfall + reconBurden.adj.shortfall;
  // Under-recorded hours — the genuine paid-but-not-logged gap. Same per-worker
  // figure the "who & why" panel itemises, so both lines (and Department Labor's
  // Under-recorded column) show the identical number.
  const underRecordedReconSen = employeeResidual.underLoggedSubtotalSen;
  // Efficiency allowance is folded into each worker's department line via
  // reconBurden.adj (owner 2026-06-11) — matching the Department Labor tab —
  // so there is no separate allowance line; it is still excluded from the
  // under-recorded gaps so it can't show as a fake data gap.
  const loadedOverheadSen =
    totalPayrollCostSen -
    underRecordedReconSen -
    loadedProductionSen -
    loadedWarehousingSen -
    loadedShortfallSen;
  // Display sum — equals totalPayrollCostSen by construction (Overhead is the
  // plug), so the "Reconciled · 0 difference" badge stays green.
  const reconciledSumSen =
    loadedProductionSen +
    loadedWarehousingSen +
    loadedShortfallSen +
    loadedOverheadSen +
    underRecordedReconSen;
  const reconcileDiffSen = reconciledSumSen - totalPayrollCostSen;

  const loading = entriesLoading || plLoading;

  // Print Report — prints the Production Breakdown rows (the headline view) for
  // the selected period + category, mirroring its columns (Department,
  // Category, Hours, Labor Cost, Category Revenue, Category Cost / Revenue).
  const handlePrint = useCallback(() => {
    const catLabel = categoryFilter
      ? categoryFilter[0] + categoryFilter.slice(1).toLowerCase()
      : "All categories";

    // ── KPI dashboard cards — mirror the on-screen strip. ──
    const cards: PrintCard[] = [
      { label: "Production Labor Cost", value: formatCurrency(productionLaborCostSen) },
      { label: "Total Revenue", value: formatCurrency(totalRevenueSen) },
      { label: "Remain", value: formatCurrency(totalRevenueSen - productionLaborCostSen), color: "#15803D" },
      { label: "Borrowed (Warehousing)", value: formatCurrency(warehousingLaborCostSen), color: "#9C6F1E" },
      { label: "Shortfall", value: formatCurrency(shortfallLaborCostSen), color: "#9A3A2D" },
    ];

    const sections: PrintSection[] = [];

    // ── Payroll Reconciliation (full finished month only). ──
    if (showReconciliation) {
      const reconRows = [
        { line: "Production Labor (incl. EPF)", amt: loadedProductionSen },
        { line: "Borrowed (Warehousing) (incl. EPF)", amt: loadedWarehousingSen },
        { line: "Shortfall (incl. EPF)", amt: loadedShortfallSen },
        { line: "Overhead & non-production (incl. EPF)", amt: loadedOverheadSen },
        { line: "Under-recorded hours (paid, not yet logged)", amt: underRecordedReconSen },
      ];
      const reconciled = Math.abs(reconcileDiffSen) <= 1;
      sections.push({
        title: "Payroll Reconciliation",
        columns: [
          { header: "Line", value: (r) => (r as { line: string }).line },
          { header: "Amount", align: "right", value: (r) => formatCurrency((r as { amt: number }).amt) },
        ],
        rows: reconRows,
        totalRow: [
          {
            text: "Total Payroll Cost",
            bold: true,
            badge: reconciled
              ? { text: "Reconciled · 0 difference", color: "#15803D", bg: "#DCFCE7" }
              : { text: "Off by " + formatCurrency(Math.abs(reconcileDiffSen)), color: "#9A3A2D", bg: "#FEE2E2" },
          },
          { text: formatCurrency(totalPayrollCostSen), bold: true, align: "right" },
        ],
      });
    }

    // ── Production Breakdown (department × category). ──
    sections.push({
      title: "Production Breakdown",
      columns: [
        { header: "Department", value: (r) => (r as LaborCostRow).departmentName },
        { header: "Category", value: (r) => { const c = (r as LaborCostRow).category; return c ? c[0] + c.slice(1).toLowerCase() : "—"; } },
        { header: "Hours", align: "right", value: (r) => `${(r as LaborCostRow).hours.toFixed(1)}h` },
        { header: "Labor Cost", align: "right", value: (r) => formatCurrency((r as LaborCostRow).laborCostSen) },
        { header: "Category Revenue", align: "right", value: (r) => { const row = r as LaborCostRow; return row.category ? formatCurrency(row.revenueSen) : "n/a"; } },
        {
          header: "Cost / Revenue",
          align: "right",
          value: (r) => {
            const row = r as LaborCostRow;
            if (!row.category || row.revenueSen <= 0) return "—";
            const pct = (row.laborCostSen / row.revenueSen) * 100;
            // Red when labour eats a high share of the category's revenue.
            return { text: `${pct.toFixed(1)}%`, color: pct >= 35 ? "#9A3A2D" : "#15803D", bold: true };
          },
        },
      ],
      rows: rows.filter((r) => r.isProduction),
      emptyText: "No production labour in the selected period.",
    });

    // ── Under-recorded hours — who & why (full finished month only). ──
    if (showReconciliation && employeeResidual.underLoggedFactory.length > 0) {
      sections.push({
        title: "Under-recorded Hours — Who & Why",
        note: "Pay issued to factory workers above their logged Working Hours — a data gap to close by recording the missing hours.",
        columns: [
          { header: "Employee", value: (r) => (r as { name: string }).name },
          { header: "Department", value: (r) => (r as { deptName: string }).deptName },
          { header: "Paid", align: "right", value: (r) => formatCurrency((r as { grossSen: number }).grossSen) },
          { header: "Logged", align: "right", value: (r) => formatCurrency((r as { loggedValueSen: number }).loggedValueSen) },
          { header: "Gap", align: "right", value: (r) => ({ text: formatCurrency((r as { gapSen: number }).gapSen), color: "#9A3A2D", bold: true }) },
        ],
        rows: employeeResidual.underLoggedFactory,
        totalRow: [
          "Subtotal (under-recorded)",
          "",
          "",
          "",
          { text: formatCurrency(employeeResidual.underLoggedSubtotalSen), color: "#9A3A2D", bold: true, align: "right" },
        ],
      });
    }

    printReport({
      title: "Labor Cost vs Revenue",
      filterSummary: `${dateRangeLabel(from, to)} · ${catLabel}`,
      orientation: "landscape",
      cards,
      sections,
    });
  }, [
    rows,
    categoryFilter,
    from,
    to,
    productionLaborCostSen,
    totalRevenueSen,
    warehousingLaborCostSen,
    shortfallLaborCostSen,
    showReconciliation,
    loadedProductionSen,
    loadedWarehousingSen,
    loadedShortfallSen,
    loadedOverheadSen,
    underRecordedReconSen,
    totalPayrollCostSen,
    reconcileDiffSen,
    employeeResidual,
  ]);

  return (
    <Card>
      {confirmDialog}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-[#6B5C32]" /> Labor Cost vs Revenue
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[#6B7280]">From</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => handleFromChange(e.target.value)}
                className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
              <span className="text-[#6B7280]">To</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => handleToChange(e.target.value)}
                className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
            <select
              value={period}
              onChange={(e) => handlePeriodChange(e.target.value)}
              className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              title="Quick-jump to a calendar month"
            >
              <option value="">Custom range</option>
              {periodOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as "" | "SOFA" | "BEDFRAME" | "ACCESSORY")}
              className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              title="Slice every metric on this tab by item category"
            >
              <option value="">All categories</option>
              <option value="SOFA">Sofa</option>
              <option value="BEDFRAME">Bedframe</option>
              <option value="ACCESSORY">Accessory</option>
            </select>
            {showReconciliation && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSettleFromPunches}
                disabled={settleBusy || !payrollPeriod}
                title="Auto-settle this month: apply the shift rules to every punch AND auto-dock under-logged (To-fill) days, then regenerate payslips. Every under-settled day docks its shortfall — no manual pick. Your manual Keep-pay / Deduct picks are never overridden."
              >
                <Clock className="h-4 w-4 mr-1" /> {settleBusy ? "Settling…" : "Settle month"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handlePrint} title="Print the production labor breakdown for the selected period">
              <Printer className="h-4 w-4 mr-1" /> Print Report
            </Button>
          </div>
        </div>
        {settleResult && (
          <p className="mt-2 text-xs text-[#3F6B4A]">{settleResult}</p>
        )}
      </CardHeader>
      <CardContent>
        {/* KPI strip */}
        <div className="grid gap-3 grid-cols-2 md:grid-cols-5 mb-4 max-md:grid-cols-2 max-sm:grid-cols-1">
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-[#6B7280]">Production Labor Cost</p>
              <p
                className="text-lg font-bold text-[#1F1D1B]"
                title={`Production-only (excl. Warehousing / Repair / Maintenance / Shortfall). Total incl. overhead = ${formatCurrency(totalLaborCostSen)}`}
              >
                {formatCurrency(productionLaborCostSen)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3" title="Labor for the non-production depts — Warehousing / Repair / Maintenance / Production Shortfall / R&D — plus any office / sales / admin salaries. These don't earn revenue directly.">
              <p className="text-xs text-[#6B7280]">Non-Production Labor Cost</p>
              <p className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(totalLaborCostSen - productionLaborCostSen)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3" title="Production + Non-Production — the full labor bill for the period.">
              <p className="text-xs text-[#6B7280]">Total Labor Cost</p>
              <p className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(totalLaborCostSen)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-[#6B7280]">Total Revenue</p>
              <p className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(totalRevenueSen)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent
              className="p-3"
              title="Remain = Total Revenue − Production Labor Cost. Positive = labor came in under booked revenue this period; negative = labor outpaced bookings (e.g. workshop did a lot of in-progress work whose POs haven't completed UPHOLSTERY yet, so Total Revenue hasn't recognized it)."
            >
              <p className="text-xs text-[#6B7280]">Remain</p>
              <p className={`text-lg font-bold ${(totalRevenueSen - productionLaborCostSen) >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                {totalRevenueSen > 0 || productionLaborCostSen > 0
                  ? formatCurrency(totalRevenueSen - productionLaborCostSen)
                  : "—"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Payroll reconciliation — proves the labor breakdown tallies to the
            full Total Payroll Cost. Only shown for an un-filtered single month
            (a worker's salary isn't category-tagged, so a category filter can't
            reconcile to full payroll). */}
        {showReconciliation && (
          <div className="mb-4 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-4">
            <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-sm font-semibold text-[#1F1D1B] flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-[#6B5C32]" />
                Payroll Reconciliation
                <span className="text-xs font-normal text-[#6B7280]">
                  ({payrollMonthLabel})
                </span>
              </h3>
              {Math.abs(reconcileDiffSen) <= 1 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EEF3E4] px-3 py-1 text-xs font-semibold text-[#4F7C3A]">
                  <Check className="h-3.5 w-3.5" /> Reconciled · 0 difference
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F9E1DA] px-3 py-1 text-xs font-semibold text-[#9A3A2D]">
                  Difference {formatCurrency(reconcileDiffSen)}
                </span>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-[#E2DDD8]">
                    <td
                      className="py-1.5 pr-3 text-[#4B5563]"
                      title="Logged production hours plus these workers' own EPF / SOCSO / EIS and the small ÷26-vs-÷working-days adjustment on their absent days."
                    >
                      Production Labor <span className="text-[#9CA3AF]">(incl. EPF)</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-[#1F1D1B]">{formatCurrency(loadedProductionSen)}</td>
                  </tr>
                  <tr className="border-b border-[#E2DDD8]">
                    <td className="py-1.5 pr-3 text-[#4B5563]">Borrowed (Warehousing) <span className="text-[#9CA3AF]">(incl. EPF)</span></td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-[#1F1D1B]">{formatCurrency(loadedWarehousingSen)}</td>
                  </tr>
                  <tr className="border-b border-[#E2DDD8]">
                    <td className="py-1.5 pr-3 text-[#4B5563]">Shortfall <span className="text-[#9CA3AF]">(incl. EPF)</span></td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-[#1F1D1B]">{formatCurrency(loadedShortfallSen)}</td>
                  </tr>
                  <tr className="border-b border-[#E2DDD8]">
                    <td
                      className="py-1.5 pr-3 text-[#4B5563]"
                      title="Repair / Maintenance / etc. labor, plus EPF and any office / sales / admin salaries (staff who don't clock factory hours)."
                    >
                      Overhead &amp; non-production <span className="text-[#9CA3AF]">(incl. EPF)</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-[#1F1D1B]">{formatCurrency(loadedOverheadSen)}</td>
                  </tr>
                  <tr className="border-b border-[#E2DDD8]">
                    <td
                      className="py-1.5 pr-3 text-[#4B5563]"
                      title="Hours short on days the worker DID work — auto-docked at the ÷26 hourly rate. Key the real hours in the Working Hours grid to restore pay."
                    >
                      Under-recorded hours <span className="text-[#9CA3AF]">(auto-docked)</span>
                    </td>
                    <td className={`py-1.5 text-right tabular-nums font-medium ${underRecordedReconSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                      {formatCurrency(underRecordedReconSen)}
                    </td>
                  </tr>
                  <tr className="border-t-2 border-[#6B5C32]">
                    <td className="py-2 pr-3 font-semibold text-[#1F1D1B]">Total Payroll Cost</td>
                    <td className="py-2 text-right tabular-nums font-bold text-[#1F1D1B]">{formatCurrency(totalPayrollCostSen)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-[#6B7280] leading-relaxed">
              Each department&rsquo;s line carries the full cost of its own people &mdash; their logged Working Hours plus their
              EPF / SOCSO / EIS and the small ÷26-vs-÷working-days adjustment on absent days &mdash; so no separate statutory line is
              needed. The only amount left on its own line is <span className="font-medium text-[#4B5563]">Under-recorded hours</span>:
              pay already issued for hours not yet entered. It auto-docks at the ÷26 rate and clears once the real hours are keyed in
              the Working Hours grid. Total Payroll Cost matches the Payroll tab for {payrollMonthLabel}.
            </p>
          </div>
        )}

        {/* Docked this month — owner-applied short-hour deductions, with undo.
            Each dock lowers a worker's gross; deleting one restores their pay on
            the next regenerate (triggered automatically). Shown only when at
            least one dock exists for the month. */}
        {showReconciliation && (deductionsResp?.data?.length ?? 0) > 0 && (
          <div className="mb-4 rounded-md border border-[#E2B8AE] bg-[#FBF3F1] p-4">
            <h3 className="text-sm font-semibold text-[#9A3A2D] mb-1">
              Docked this month — unworked hours removed from pay
            </h3>
            <p className="text-xs text-[#6B7280] leading-relaxed mb-2">
              Short-hour docks for {payrollMonthLabel} — hours removed from pay.
              An <span className="font-semibold text-[#8A6D2F]">Auto</span> tag means it came
              from a late / short punch; the rest you set here. Each lowers that
              worker&rsquo;s pay; click Undo to restore it.
            </p>
            <div className="overflow-x-auto rounded-md border border-[#E7C9C1] bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#E7C9C1] text-[#9A3A2D]">
                    <th className="py-1.5 px-3 text-left font-medium">Employee</th>
                    <th className="py-1.5 px-3 text-left font-medium">Date</th>
                    <th className="py-1.5 px-3 text-right font-medium">Hours docked</th>
                    <th className="py-1.5 px-3 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {(deductionsResp?.data ?? [])
                    .slice()
                    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
                    .map((d) => (
                      <tr key={d.id} className="border-b border-[#F1DDD7]">
                        <td className="py-1.5 px-3 text-[#1F1D1B]">
                          {workersById.get(d.workerId)?.name ?? d.workerId}
                          {d.source === "AUTO" && (
                            <span
                              title="Created automatically from a late / short punch. Click Undo to keep the pay."
                              className="ml-1.5 inline-block rounded bg-[#EADFC9] px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#8A6D2F]"
                            >
                              Auto
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-[#4B5563]">{d.date}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-[#9A3A2D]">
                          −{(Number(d.hours) || 0).toFixed(1)} h
                        </td>
                        <td className="py-1.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleUndoDeduction(d.id)}
                            disabled={!!undoBusy}
                            className="rounded border border-[#D8D2CC] px-1.5 py-0.5 text-[10px] text-[#4B5563] hover:bg-[#F0EDE9] disabled:opacity-40"
                          >
                            {undoBusy === `undo|${d.id}` ? "…" : "Undo"}
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}



        {/* Production-vs-overhead ratio note */}
        <div className="mb-3 text-xs text-[#6B7280]">
          Production Labor = production-dept work only (Fab Cut / Fab Sew / Wood Cut / Foam / Framing / Webbing / Upholstery / Packing).
          {overheadLaborCostSen > 0 && (
            <>
              {" "}Overhead this period (Repair / Maintenance / etc.):{" "}
              <span className="font-medium text-[#1F1D1B]">{formatCurrency(overheadLaborCostSen)}</span>
              {" · "}
            </>
          )}
          {" "}Total incl. overhead = {formatCurrency(totalLaborCostSen)}.
          {" · "}
          Revenue is recognized when items complete UPHOLSTERY (production-completion bucket); labor at the day work happens.
          Per-row Category Revenue is each dept's minute-weighted slice of the PO selling price
          (po_price × dept_minutes ÷ total_PO_minutes), summed across every PO recognized in the period —
          dept slices add back up to the category total. Treat any single-month ratio as a leading indicator, not a closed P&amp;L.
        </div>

        {loading ? (
          <div className="rounded-md border border-[#E2DDD8] p-8 text-center text-sm text-[#9CA3AF]">
            Loading labor cost data…
          </div>
        ) : (
          <>
            {/* Production rows - the part that earns revenue. Cost / Revenue
                ratio + Category Revenue only make sense here. Non-production
                rows live in the Overhead table below so they don't pollute
                the production breakdown. */}
            <button
              type="button"
              onClick={() => setShowProduction((v) => !v)}
              className="mb-2 flex w-full items-center justify-between rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm font-semibold text-[#1F1D1B] hover:bg-[#F0ECE9]"
            >
              <span className="flex items-center gap-2">
                {showProduction ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Production Breakdown
                <span className="text-xs font-normal text-[#6B7280]">
                  ({rows.filter((r) => r.isProduction).length} dept{rows.filter((r) => r.isProduction).length === 1 ? "" : "s"} - {formatCurrency(productionLaborCostSen)})
                </span>
              </span>
            </button>
            {showProduction && (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Department</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Category</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Hours</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Labor Cost</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Category Revenue</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]" title="Per-row ratio = this dept's Labor Cost ÷ this dept's Category Revenue slice. Different denominator from the top KPI's Cost/Revenue (which uses Total Revenue), so per-row ratios won't average up to the KPI.">Category Cost / Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.filter((r) => r.isProduction).map((r) => {
                    const ratio = r.revenueSen > 0 ? (r.laborCostSen / r.revenueSen) * 100 : 0;
                    return (
                      <tr key={r.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                        <td className="h-10 px-3 font-medium text-[#1F1D1B]">{r.departmentName}</td>
                        <td className="h-10 px-3 text-[#4B5563]">
                          {r.category ? r.category[0] + r.category.slice(1).toLowerCase() : <span className="text-[#9CA3AF]">—</span>}
                        </td>
                        <td className="h-10 px-3 text-right font-medium tabular-nums">{r.hours.toFixed(1)}h</td>
                        <td className="h-10 px-3 text-right font-medium tabular-nums">{formatCurrency(r.laborCostSen)}</td>
                        <td className="h-10 px-3 text-right tabular-nums text-[#4B5563]">
                          {r.category ? formatCurrency(r.revenueSen) : <span className="text-[#9CA3AF]">n/a</span>}
                        </td>
                        <td className="h-10 px-3 text-right tabular-nums">
                          {r.category && r.revenueSen > 0 ? (
                            <span className={ratio > 30 ? "font-medium text-[#9A3A2D]" : ratio > 20 ? "font-medium text-[#9C6F1E]" : "font-medium text-[#4F7C3A]"}>
                              {ratio.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-[#9CA3AF]">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.filter((r) => r.isProduction).length === 0 && (
                    <tr>
                      <td colSpan={6} className="h-24 text-center text-[#9CA3AF]">
                        No production hours for this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            )}

            {/* Overhead breakdown - non-production cost (Repair, Maintenance,
                Warehousing, Production Shortfall). These don't have a
                Category Revenue mapping so we drop the Cost / Revenue
                columns; just show where the overhead dollars went. */}
            {rows.some((r) => !r.isProduction && r.laborCostSen > 0) && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setShowOverhead((v) => !v)}
                  className="mb-2 flex w-full items-center justify-between rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm font-semibold text-[#1F1D1B] hover:bg-[#F0ECE9]"
                >
                  <span className="flex items-center gap-2">
                    {showOverhead ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    Overhead Breakdown
                    <span className="text-xs font-normal text-[#6B7280]">
                      ({rows.filter((r) => !r.isProduction).length} - {formatCurrency(overheadLaborCostSen + warehousingLaborCostSen + shortfallLaborCostSen)} - not in Production Labor Cost)
                    </span>
                  </span>
                </button>
                {showOverhead && (
                <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                        <th className="h-10 px-3 text-left font-medium text-[#374151]">Department</th>
                        <th className="h-10 px-3 text-right font-medium text-[#374151]">Hours</th>
                        <th className="h-10 px-3 text-right font-medium text-[#374151]">Labor Cost</th>
                        <th className="h-10 px-3 text-left font-medium text-[#374151]">Bucket</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.filter((r) => !r.isProduction).map((r) => {
                        const rowClass = r.isShortfall
                          ? "bg-[#F9E1DA]/30 border-l-4 border-l-[#9A3A2D]"
                          : r.isWarehousing
                            ? "bg-[#FAEFCB]/40 border-l-4 border-l-[#9C6F1E]"
                            : "bg-[#F3F4F6]/40";
                        const bucketLabel = r.isShortfall
                          ? "Shortfall"
                          : r.isWarehousing
                            ? "Borrowed (Warehousing)"
                            : "Overhead";
                        return (
                          <tr key={r.id} className={`border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors ${rowClass}`}>
                            <td className="h-10 px-3 font-medium text-[#1F1D1B]">{r.departmentName}</td>
                            <td className="h-10 px-3 text-right font-medium tabular-nums">{r.hours.toFixed(1)}h</td>
                            <td className="h-10 px-3 text-right font-medium tabular-nums">{formatCurrency(r.laborCostSen)}</td>
                            <td className="h-10 px-3 text-[#6B7280] text-xs">{bucketLabel}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Revenue Raw Data — one row per (poId, unitNo) recognized in
            the period. Lets operators audit which physical units actually
            contributed to the revenue figure shown above. Per spec, each
            unit is recognized ONCE on the date its LAST piece (HB/Divan/
            Cushion/…) completes UPHOLSTERY. Filtered by the Category
            dropdown so a Sofa filter strips Bedframe + Accessory rows
            (and the unit count in the header). Same .trim().toUpperCase()
            normalize as the per-dept rollup in case any pre-migration
            row has a lower-case category. */}
        {!loading && (() => {
          const allRawRows = plResp?.data?.rows ?? [];
          const filteredRawRows = categoryFilter
            ? allRawRows.filter(
                (rr) =>
                  (typeof rr.category === "string" ? rr.category.trim().toUpperCase() : "") ===
                  categoryFilter,
              )
            : allRawRows;
          return (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowRevenueRaw((v) => !v)}
              className="mb-2 flex w-full items-center justify-between rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm font-semibold text-[#1F1D1B] hover:bg-[#F0ECE9]"
            >
              <span className="flex items-center gap-2">
                {showRevenueRaw ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Revenue Raw Data
                <span className="text-xs font-normal text-[#6B7280]">
                  ({filteredRawRows.length} unit{filteredRawRows.length === 1 ? "" : "s"})
                </span>
              </span>
            </button>
            {showRevenueRaw && (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Date</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Product</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Category</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Customer</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">SO</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Qty</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRawRows.map((rr, idx) => (
                    <tr
                      key={`${rr.date}-${rr.soNo}-${rr.productCode}-${idx}`}
                      className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors"
                    >
                      <td className="h-10 px-3 text-[#4B5563] tabular-nums">
                        {rr.date ? formatDateDMY(rr.date) : <span className="text-[#9CA3AF]">—</span>}
                      </td>
                      <td className="h-10 px-3 text-[#1F1D1B]">
                        <div className="font-medium">{rr.productCode || "—"}</div>
                        {rr.productName && (
                          <div className="text-xs text-[#6B7280]">{rr.productName}</div>
                        )}
                      </td>
                      <td className="h-10 px-3 text-[#4B5563]">
                        {rr.category ? rr.category[0] + rr.category.slice(1).toLowerCase() : "—"}
                      </td>
                      <td className="h-10 px-3 text-[#4B5563]">
                        {rr.customerName || <span className="text-[#9CA3AF]">—</span>}
                      </td>
                      <td className="h-10 px-3 text-[#4B5563] tabular-nums">
                        {rr.soNo || <span className="text-[#9CA3AF]">—</span>}
                      </td>
                      <td className="h-10 px-3 text-right tabular-nums">{rr.qty}</td>
                      <td className="h-10 px-3 text-right tabular-nums text-[#4B5563]">
                        {formatCurrency(rr.unitPriceSen)}
                      </td>
                      <td className="h-10 px-3 text-right font-medium tabular-nums">
                        {formatCurrency(rr.totalPriceSen)}
                      </td>
                    </tr>
                  ))}
                  {filteredRawRows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="h-24 text-center text-[#9CA3AF]">
                        No production completions in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
          </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}

// ========== TAB 6: LEAVE MANAGEMENT ==========

const LEAVE_TYPES: LeaveRecord["type"][] = ["ANNUAL", "MEDICAL", "UNPAID", "EMERGENCY", "PUBLIC_HOLIDAY"];
const LEAVE_STATUSES: LeaveRecord["status"][] = ["PENDING", "APPROVED", "REJECTED"];
const LEAVE_ENTITLEMENTS = { ANNUAL: 8, MEDICAL: 14 };

function LeaveManagementTab({ workers }: { workers: Worker[] }) {
  const { toast } = useToast();
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [filterWorker, setFilterWorker] = useState<string>("ALL");
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [newLeave, setNewLeave] = useState({
    workerId: workers[0]?.id || "",
    type: "ANNUAL" as LeaveRecord["type"],
    startDate: todayStr(),
    endDate: todayStr(),
    reason: "",
  });

  const { data: leavesResp, loading: loadingLeaves, refresh: refreshLeavesHook } = useCachedJson<unknown>("/api/leaves");
  const leaveData: LeaveRecord[] = useMemo(() => asArray(leavesResp) as LeaveRecord[], [leavesResp]);
  const fetchLeaves = useCallback(() => {
    invalidateCachePrefix("/api/leaves");
    invalidateCachePrefix("/api/workers");
    refreshLeavesHook();
  }, [refreshLeavesHook]);

  const filteredLeaves = useMemo(() => {
    let result = leaveData;
    if (filterStatus !== "ALL") {
      result = result.filter((r) => r.status === filterStatus);
    }
    if (filterWorker !== "ALL") {
      result = result.filter((r) => r.workerId === filterWorker);
    }
    return result;
  }, [leaveData, filterStatus, filterWorker]);

  // Calculate leave balances per worker
  const leaveBalances = useMemo(() => {
    const activeWorkers = workers.filter((w) => w.status === "ACTIVE");
    return activeWorkers.map((w) => {
      const workerLeaves = leaveData.filter((l) => l.workerId === w.id && l.status === "APPROVED");
      const annualUsed = workerLeaves.filter((l) => l.type === "ANNUAL").reduce((s, l) => s + l.days, 0);
      const medicalUsed = workerLeaves.filter((l) => l.type === "MEDICAL").reduce((s, l) => s + l.days, 0);
      return {
        workerId: w.id,
        workerName: w.name,
        annualUsed,
        annualRemaining: LEAVE_ENTITLEMENTS.ANNUAL - annualUsed,
        medicalUsed,
        medicalRemaining: LEAVE_ENTITLEMENTS.MEDICAL - medicalUsed,
      };
    });
  }, [workers, leaveData]);

  const calculateDays = (start: string, end: string): number => {
    const s = new Date(start);
    const e = new Date(end);
    const diff = Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return Math.max(1, diff);
  };

  const handleAddLeave = async () => {
    setSaving(true);
    const days = calculateDays(newLeave.startDate, newLeave.endDate);
    try {
      await fetch("/api/leaves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newLeave, days }),
      });
      setShowAddForm(false);
      setNewLeave({ workerId: workers[0]?.id || "", type: "ANNUAL", startDate: todayStr(), endDate: todayStr(), reason: "" });
      fetchLeaves();
    } catch {
      toast.error("Error creating leave request");
    }
    setSaving(false);
  };

  const handleLeaveAction = async (id: string, status: "APPROVED" | "REJECTED") => {
    try {
      await fetch("/api/leaves", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status, approvedBy: "Admin" }),
      });
      fetchLeaves();
    } catch {
      toast.error("Error updating leave request");
    }
  };

  const getLeaveStatusStyle = (status: string) => {
    switch (status) {
      case "PENDING": return "bg-[#FAEFCB] text-[#9C6F1E]";
      case "APPROVED": return "bg-[#EEF3E4] text-[#4F7C3A]";
      case "REJECTED": return "bg-[#F9E1DA] text-[#9A3A2D]";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  const getLeaveTypeStyle = (type: string) => {
    switch (type) {
      case "ANNUAL": return "bg-[#E0EDF0] text-[#3E6570]";
      case "MEDICAL": return "bg-[#F1E6F0] text-[#6B4A6D]";
      case "UNPAID": return "bg-gray-100 text-gray-700";
      case "EMERGENCY": return "bg-[#F9E1DA] text-[#9A3A2D]";
      case "PUBLIC_HOLIDAY": return "bg-[#EEF3E4] text-[#4F7C3A]";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  return (
    <div className="space-y-4">
      {/* Leave Requests */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#6B5C32]" /> Leave Requests
            </CardTitle>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Filter className="h-4 w-4 text-[#6B7280]" />
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="ALL">All Status</option>
                  {LEAVE_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select
                  value={filterWorker}
                  onChange={(e) => setFilterWorker(e.target.value)}
                  className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="ALL">All Workers</option>
                  {workers.filter((w) => w.status === "ACTIVE").map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <Button variant="primary" onClick={() => setShowAddForm(!showAddForm)}>
                <Plus className="h-4 w-4" />
                {showAddForm ? "Cancel" : "New Leave Request"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Inline Add Leave Form */}
          {showAddForm && (
            <div className="mb-6 rounded-lg border border-[#6B5C32]/30 bg-[#F0ECE9] p-4">
              <h4 className="mb-3 text-sm font-semibold text-[#1F1D1B]">New Leave Request</h4>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 max-md:grid-cols-2 max-sm:grid-cols-1">
                <div>
                  <label className="text-xs text-[#6B7280]">Worker</label>
                  <select
                    value={newLeave.workerId}
                    onChange={(e) => setNewLeave((f) => ({ ...f, workerId: e.target.value }))}
                    className="flex h-8 w-full rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  >
                    {workers.filter((w) => w.status === "ACTIVE").map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#6B7280]">Leave Type</label>
                  <select
                    value={newLeave.type}
                    onChange={(e) => setNewLeave((f) => ({ ...f, type: e.target.value as LeaveRecord["type"] }))}
                    className="flex h-8 w-full rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  >
                    {LEAVE_TYPES.map((t) => (
                      <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#6B7280]">Start Date</label>
                  <Input
                    type="date"
                    value={newLeave.startDate}
                    onChange={(e) => setNewLeave((f) => ({ ...f, startDate: e.target.value }))}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-[#6B7280]">End Date</label>
                  <Input
                    type="date"
                    value={newLeave.endDate}
                    onChange={(e) => setNewLeave((f) => ({ ...f, endDate: e.target.value }))}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-[#6B7280]">Reason</label>
                  <Input
                    value={newLeave.reason}
                    onChange={(e) => setNewLeave((f) => ({ ...f, reason: e.target.value }))}
                    placeholder="Reason for leave..."
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-[#6B7280]">
                  Duration: {calculateDays(newLeave.startDate, newLeave.endDate)} day(s)
                </span>
                <Button variant="primary" size="sm" onClick={handleAddLeave} disabled={saving || !newLeave.reason}>
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Submit Request"}
                </Button>
              </div>
            </div>
          )}

          {loadingLeaves ? (
            <div className="flex items-center justify-center h-32 text-[#6B7280]">Loading leave data...</div>
          ) : (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Worker</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Type</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Start Date</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">End Date</th>
                    <th className="h-10 px-3 text-center font-medium text-[#374151]">Days</th>
                    <th className="h-10 px-3 text-center font-medium text-[#374151]">Status</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Reason</th>
                    <th className="h-10 px-3 text-center font-medium text-[#374151]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLeaves.map((r) => (
                    <tr key={r.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                      <td className="h-10 px-3 font-medium text-[#1F1D1B]">{r.workerName}</td>
                      <td className="h-10 px-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${getLeaveTypeStyle(r.type)}`}>
                          {r.type.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="h-10 px-3 text-[#4B5563]">{formatDateDMY(r.startDate)}</td>
                      <td className="h-10 px-3 text-[#4B5563]">{formatDateDMY(r.endDate)}</td>
                      <td className="h-10 px-3 text-center font-medium">{r.days}</td>
                      <td className="h-10 px-3 text-center">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${getLeaveStatusStyle(r.status)}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="h-10 px-3 text-[#4B5563] max-w-[200px] truncate">{r.reason}</td>
                      <td className="h-10 px-3 text-center">
                        {r.status === "PENDING" ? (
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleLeaveAction(r.id, "APPROVED")}
                              className="text-[#4F7C3A] hover:text-[#3D6329] hover:bg-[#EEF3E4]"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleLeaveAction(r.id, "REJECTED")}
                              className="text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA]"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-[#9CA3AF]">
                            {r.approvedBy ? `by ${r.approvedBy}` : "-"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filteredLeaves.length === 0 && (
                    <tr>
                      <td colSpan={8} className="h-24 text-center text-[#9CA3AF]">
                        No leave records found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leave Balance Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[#6B5C32]" /> Leave Balance Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Worker</th>
                  <th className="h-10 px-3 text-center font-medium text-[#374151]" colSpan={3}>Annual Leave (8 days)</th>
                  <th className="h-10 px-3 text-center font-medium text-[#374151]" colSpan={3}>Medical Leave (14 days)</th>
                </tr>
                <tr className="border-b border-[#E2DDD8] bg-[#FAF9F7]">
                  <th className="h-8 px-4"></th>
                  <th className="h-8 px-3 text-center text-xs font-medium text-[#6B7280]">Used</th>
                  <th className="h-8 px-3 text-center text-xs font-medium text-[#6B7280]">Remaining</th>
                  <th className="h-8 px-3 text-center text-xs font-medium text-[#6B7280]">Bar</th>
                  <th className="h-8 px-3 text-center text-xs font-medium text-[#6B7280]">Used</th>
                  <th className="h-8 px-3 text-center text-xs font-medium text-[#6B7280]">Remaining</th>
                  <th className="h-8 px-3 text-center text-xs font-medium text-[#6B7280]">Bar</th>
                </tr>
              </thead>
              <tbody>
                {leaveBalances.map((b) => (
                  <tr key={b.workerId} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                    <td className="h-10 px-4 font-medium text-[#1F1D1B]">{b.workerName}</td>
                    <td className="h-10 px-3 text-center">{b.annualUsed}</td>
                    <td className="h-10 px-3 text-center font-medium">
                      <span className={b.annualRemaining <= 2 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}>
                        {b.annualRemaining}
                      </span>
                    </td>
                    <td className="h-10 px-3">
                      <div className="w-20 h-2 bg-gray-200 rounded-full mx-auto">
                        <div
                          className="h-2 bg-[#3E6570] rounded-full"
                          style={{ width: `${Math.min(100, (b.annualUsed / LEAVE_ENTITLEMENTS.ANNUAL) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className="h-10 px-3 text-center">{b.medicalUsed}</td>
                    <td className="h-10 px-3 text-center font-medium">
                      <span className={b.medicalRemaining <= 3 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}>
                        {b.medicalRemaining}
                      </span>
                    </td>
                    <td className="h-10 px-3">
                      <div className="w-20 h-2 bg-gray-200 rounded-full mx-auto">
                        <div
                          className="h-2 bg-[#6B4A6D] rounded-full"
                          style={{ width: `${Math.min(100, (b.medicalUsed / LEAVE_ENTITLEMENTS.MEDICAL) * 100)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ========== MAIN PAGE ==========

type TabKey = "working-hours" | "attendance" | "labor-cost" | "employee-master" | "efficiency" | "department-labor" | "detail" | "department-performance" | "payroll" | "leave";

// Labor Cost tab is wedged between Working Hours and Payroll per spec — the
// flow goes "what hours did people work" → "what did those hours cost vs the
// revenue they produced" → "what do we pay them out".
const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "working-hours",
    label: "Working Hours",
    icon: <Clock className="h-4 w-4" />,
  },
  {
    key: "attendance",
    label: "Attendance",
    icon: <UserCheck className="h-4 w-4" />,
  },
  {
    key: "labor-cost",
    label: "Labor Cost",
    icon: <DollarSign className="h-4 w-4" />,
  },
  {
    key: "efficiency",
    label: "Efficiency Overview",
    icon: <Activity className="h-4 w-4" />,
  },
  {
    key: "department-labor",
    label: "Department Labor",
    icon: <DollarSign className="h-4 w-4" />,
  },
  {
    key: "detail",
    label: "Employee Performance",
    icon: <Search className="h-4 w-4" />,
  },
  {
    key: "department-performance",
    label: "Department Performance",
    icon: <Activity className="h-4 w-4" />,
  },
  {
    key: "payroll",
    label: "Payroll",
    icon: <DollarSign className="h-4 w-4" />,
  },
  // Wei Siang 2026-05-10: Leave Management hidden until rollout.
  // {
  //   key: "leave",
  //   label: "Leave Management",
  //   icon: <FileText className="h-4 w-4" />,
  // },
  {
    key: "employee-master",
    label: "Employee Master",
    icon: <Users className="h-4 w-4" />,
  },
];

// ============================================================
// Attendance tab — worker PHONE punches (clock in/out) for a day, with a soft
// geofence badge (At factory ✓ / Off-site ⚠ / No GPS —) against the 200 m
// factory fence, so the owner can spot home- / proxy-punching. Photos land here
// next. Location is judged client-side from the punch's stored GPS — soft only,
// never blocks a punch (matches the worker-side behaviour).
// ============================================================
const ATT_FENCE = { lat: 3.187681, lng: 101.570928, radiusM: 200 };
function attMetersFromFactory(lat: number, lng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(ATT_FENCE.lat - lat);
  const dLng = toRad(ATT_FENCE.lng - lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat)) * Math.cos(toRad(ATT_FENCE.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function attPunchLoc(lat: unknown, lng: unknown): "in" | "out" | "none" {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "none";
  }
  return attMetersFromFactory(lat, lng) <= ATT_FENCE.radiusM ? "in" : "out";
}
function AttLocBadge({ status }: { status: "in" | "out" | "none" }) {
  if (status === "in")
    return <span className="inline-flex items-center rounded-full bg-[#EEF3E4] px-2 py-0.5 text-xs font-medium text-[#4F7C3A]">✓ At factory</span>;
  if (status === "out")
    return <span className="inline-flex items-center rounded-full bg-[#F9E1DA] px-2 py-0.5 text-xs font-medium text-[#9A3A2D]">⚠ Off-site</span>;
  return <span className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-xs text-[#8A8680]">— No GPS</span>;
}
type AttPunchRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  clockInLat: number | null;
  clockInLng: number | null;
  clockOutLat: number | null;
  clockOutLng: number | null;
  hasClockInPhoto?: boolean;
  hasClockOutPhoto?: boolean;
};
// A small punch-selfie thumbnail. The image streams from the on-demand photo
// endpoint (browser lazy-loads + caches it) so the attendance list stays light.
// Click to open the full-size view.
function PunchThumb({
  show,
  src,
  label,
  onOpen,
}: {
  show: boolean;
  src: string;
  label: string;
  onOpen: (src: string) => void;
}) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(src)}
      className="group relative shrink-0"
      title={`View ${label} photo`}
    >
      <img
        src={src}
        alt={`${label} punch`}
        loading="lazy"
        className="h-10 w-10 rounded object-cover border border-[#E2DDD8] group-hover:ring-2 group-hover:ring-[#3E6570]"
      />
      <span className="absolute -bottom-1 -right-1 rounded bg-[#1F1D1B]/70 px-1 text-[9px] leading-none py-px text-white">
        {label}
      </span>
    </button>
  );
}
function AttendanceTab({
  workers,
  productionDeptCodes,
}: {
  workers: Worker[];
  productionDeptCodes: Set<string>;
}) {
  const [date, setDate] = useState<string>(() => {
    // Malaysia (UTC+8) "today" so the default matches the worker's punch date.
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  // Full-size punch selfie shown in an overlay when a thumbnail is clicked.
  const [photoView, setPhotoView] = useState<{ src: string; title: string } | null>(null);
  const { data } = useCachedJson<{ data?: AttPunchRow[] }>(
    `/api/attendance?date=${date}`,
  );
  const rows = (data?.data ?? []).filter((r) => r.clockIn || r.clockOut);
  const offSiteCount = rows.filter(
    (r) =>
      attPunchLoc(r.clockInLat, r.clockInLng) === "out" ||
      attPunchLoc(r.clockOutLat, r.clockOutLng) === "out",
  ).length;

  // ---- Whole-month KPI dashboard (owner 2026-07-04) --------------------------
  // The Attendance tab now opens on a month dashboard (not just the day's
  // punches). Metrics cover the calendar month that contains the selected date:
  // # active workers, this-month avg efficiency, avg salary/worker, avg working
  // hours, avg production hours. Same two summary endpoints the Efficiency tab
  // uses (server-side GROUP BY), so it's a thin client aggregate.
  const monthStr = date.slice(0, 7); // YYYY-MM
  const monthFrom = `${monthStr}-01`;
  const monthTo = (() => {
    const [my, mm] = monthStr.split("-").map(Number);
    const last = my && mm ? new Date(my, mm, 0).getDate() : 28;
    return `${monthStr}-${String(last).padStart(2, "0")}`;
  })();
  const { data: hoursSummaryResp } = useCachedJson<{ data?: WorkerHoursSummary[] }>(
    `/api/working-hour-entries/summary?from=${monthFrom}&to=${monthTo}`,
  );
  const { data: jcSummaryResp } = useCachedJson<{ data?: { workerId: string; productionMinutes: number }[] }>(
    `/api/job-cards/summary?from=${monthFrom}&to=${monthTo}`,
  );
  const monthKpis = useMemo(() => {
    const prodCodes = productionDeptCodes.size > 0 ? productionDeptCodes : PRODUCTION_DEPT_CODES;
    // Active, non-TEST workers only — mirrors the Payroll active-only rule.
    const activeWorkers = workers.filter(
      (w) => w.status === "ACTIVE" && !/^TEST/i.test(w.empNo || ""),
    );
    const activeCount = activeWorkers.length;
    const avgSalarySen = activeCount
      ? Math.round(activeWorkers.reduce((s, w) => s + (w.basicSalarySen || 0), 0) / activeCount)
      : 0;
    const prodMinsByWorker = new Map<string, number>();
    for (const r of jcSummaryResp?.data ?? []) prodMinsByWorker.set(r.workerId, r.productionMinutes || 0);
    let totalHours = 0;
    let totalProdHours = 0;
    let present = 0;
    const effVals: number[] = [];
    for (const row of hoursSummaryResp?.data ?? []) {
      totalHours += row.totalHours;
      const prodHours = Object.entries(row.byDept).reduce(
        (s, [code, h]) => (prodCodes.has(code) ? s + h : s),
        0,
      );
      totalProdHours += prodHours;
      if (row.totalHours > 0) present++;
      if (prodHours > 0 && row.daysWithEntries > 0) {
        const pm = prodMinsByWorker.get(row.workerId) ?? 0;
        effVals.push((pm / (prodHours * 60)) * 100);
      }
    }
    const avgEff = effVals.length ? effVals.reduce((s, v) => s + v, 0) / effVals.length : 0;
    return {
      activeCount,
      avgEff,
      avgSalarySen,
      avgWorkingHours: present ? totalHours / present : 0,
      avgProdHours: present ? totalProdHours / present : 0,
    };
  }, [workers, productionDeptCodes, hoursSummaryResp, jcSummaryResp]);

  return (
    <>
    {/* Whole-month KPI dashboard (owner 2026-07-04) */}
    <div className="grid gap-3 grid-cols-2 md:grid-cols-5 mb-4 max-sm:grid-cols-2">
      <Card>
        <CardContent className="p-3" title="Workers with an ACTIVE status (test accounts excluded).">
          <p className="text-xs text-[#6B7280]">Active Workers</p>
          <p className="text-lg font-bold text-[#1F1D1B]">{monthKpis.activeCount}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3" title="Production minutes ÷ production-dept clocked hours, averaged across workers — this calendar month to date.">
          <p className="text-xs text-[#6B7280]">Avg Efficiency <span className="text-[#9CA3AF]">(this month)</span></p>
          <p className={`text-lg font-bold ${monthKpis.avgEff >= 100 ? "text-[#15803D]" : monthKpis.avgEff >= 60 ? "text-[#9C6F1E]" : "text-[#9A3A2D]"}`}>{monthKpis.avgEff.toFixed(1)}%</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3" title="Average basic monthly salary across active workers.">
          <p className="text-xs text-[#6B7280]">Avg Salary / Worker</p>
          <p className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(monthKpis.avgSalarySen)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3" title="Average working hours logged per worker who has entries this month.">
          <p className="text-xs text-[#6B7280]">Avg Working Hours</p>
          <p className="text-lg font-bold text-[#1F1D1B]">{monthKpis.avgWorkingHours.toFixed(1)}h</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3" title="Average production-dept hours per worker who has entries this month (the efficiency denominator).">
          <p className="text-xs text-[#6B7280]">Avg Production Hours</p>
          <p className="text-lg font-bold text-[#1F1D1B]">{monthKpis.avgProdHours.toFixed(1)}h</p>
        </CardContent>
      </Card>
    </div>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-[#6B5C32]" /> Attendance — Phone Punches
          </CardTitle>
          <label className="flex items-center gap-1.5 text-xs text-[#6B7280]">
            <span>Date</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          </label>
        </div>
        <p className="mt-1 text-xs text-[#6B7280]">
          When a worker punches in / out on their phone it lands here, with their location vs the 200&nbsp;m factory fence.{" "}
          <span className="font-medium text-[#9A3A2D]">Off-site</span> = punched away from the factory;{" "}
          <span className="text-[#8A8680]">No GPS</span> = the phone gave no location.
          {offSiteCount > 0 && (
            <span className="ml-1 font-medium text-[#9A3A2D]">{offSiteCount} off-site today.</span>
          )}
        </p>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9] text-[#374151]">
                <th className="h-10 px-3 text-left font-medium">Employee</th>
                <th className="h-10 px-3 text-left font-medium">Clock In</th>
                <th className="h-10 px-3 text-left font-medium">Clock Out</th>
                <th className="h-10 px-3 text-left font-medium">Location</th>
                <th className="h-10 px-3 text-left font-medium">Photo</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="h-20 text-center text-[#9CA3AF]">
                    No phone punches on {date}.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const inLoc = attPunchLoc(r.clockInLat, r.clockInLng);
                const outLoc = attPunchLoc(r.clockOutLat, r.clockOutLng);
                const loc = inLoc !== "none" ? inLoc : outLoc;
                return (
                  <tr key={r.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                    <td className="px-3 py-2 text-[#1F1D1B]">{r.employeeName}</td>
                    <td className="px-3 py-2 tabular-nums text-[#4B5563]">{r.clockIn ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-[#4B5563]">{r.clockOut ?? "—"}</td>
                    <td className="px-3 py-2"><AttLocBadge status={loc} /></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PunchThumb
                          show={!!r.hasClockInPhoto}
                          src={`/api/attendance/${r.id}/photo?which=in`}
                          label="In"
                          onOpen={(src) =>
                            setPhotoView({ src, title: `${r.employeeName} · Clock In ${r.clockIn ?? ""}` })
                          }
                        />
                        <PunchThumb
                          show={!!r.hasClockOutPhoto}
                          src={`/api/attendance/${r.id}/photo?which=out`}
                          label="Out"
                          onOpen={(src) =>
                            setPhotoView({ src, title: `${r.employeeName} · Clock Out ${r.clockOut ?? ""}` })
                          }
                        />
                        {!r.hasClockInPhoto && !r.hasClockOutPhoto && (
                          <span className="text-xs text-[#9CA3AF]">No photo</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
    {photoView && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        onClick={() => setPhotoView(null)}
      >
        <div className="max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
          <img
            src={photoView.src}
            alt="Punch selfie"
            className="w-full rounded-lg shadow-2xl"
          />
          <p className="mt-2 text-center text-sm text-white">{photoView.title}</p>
          <button
            type="button"
            onClick={() => setPhotoView(null)}
            className="mt-2 mx-auto block rounded bg-white/90 px-4 py-1.5 text-sm font-medium text-[#1F1D1B] hover:bg-white"
          >
            Close
          </button>
        </div>
      </div>
    )}
    </>
  );
}

export default function EmployeesPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("working-hours");
  const [, setDateAttendance] = useState<AttendanceRecord[]>([]);
  // When the operator double-clicks a row on Efficiency Overview we stash the
  // workerId here and flip to the "detail" (Employee Performance) tab. The
  // detail tab is guarded by {activeTab === "detail" && ...} so it unmounts
  // when we leave it; on next entry the new initialWorkerId is honored as the
  // dropdown's starting selection. No clear needed.
  const [pendingDetailWorkerId, setPendingDetailWorkerId] = useState<string | undefined>(undefined);

  const { data: workersResp, loading: workersLoading, refresh: refreshWorkersHook } = useCachedJson<{ data?: Worker[] }>("/api/workers");
  // Page-level attendance is only used for the four today-summary cards, so it
  // only fetches TODAY. The Working Hours and Employee Detail tabs each
  // self-fetch the date range they actually display.
  const { data: attendanceResp, loading: attendanceLoading, refresh: refreshAttendanceHook } = useCachedJson<{ data?: AttendanceRecord[] }>(`/api/attendance?date=${todayStr()}`);
  // /api/departments is the source of truth for which dept codes exist + which
  // are production. Replaces the formerly-hardcoded ALL_DEPARTMENTS and
  // PRODUCTION_DEPT_CODES constants — new depts added via the Manage UI on the
  // Labor Cost tab show up automatically in every dept-aware dropdown.
  const { data: deptsResp, refresh: refreshDeptsHook } = useCachedJson<{ data?: DepartmentLite[] }>("/api/departments");

  const workers: Worker[] = useMemo(
    () => ((workersResp as { data?: Worker[] } | Worker[] | null)
      ? ((workersResp as { data?: Worker[] }).data ?? (Array.isArray(workersResp) ? (workersResp as Worker[]) : []))
      : []),
    [workersResp]
  );
  const departments: DepartmentLite[] = useMemo(
    () => deptsResp?.data ?? [],
    [deptsResp]
  );
  const productionDeptCodes = useMemo(
    () => new Set(departments.filter((d) => d.isProduction).map((d) => d.code)),
    [departments]
  );
  const todayAttendance: AttendanceRecord[] = useMemo(
    () => ((attendanceResp as { data?: AttendanceRecord[] } | AttendanceRecord[] | null)
      ? ((attendanceResp as { data?: AttendanceRecord[] }).data ?? (Array.isArray(attendanceResp) ? (attendanceResp as AttendanceRecord[]) : []))
      : []),
    [attendanceResp]
  );
  const loading = workersLoading || attendanceLoading;

  // ── Summary-card date — mirrors the Working Hours tab's date picker so the
  //    four cards at the top reflect the day the operator selected, instead
  //    of a hard-coded "today". Seeded from the same persisted range.
  const [summaryRange, setSummaryRange] = useState<{ from: string; to: string }>(
    () => {
      const persisted = readPersistedDateRange("employees:working-hours:dateRange");
      const today = todayStr();
      return { from: persisted.from ?? today, to: persisted.to ?? today };
    },
  );
  const handleSummaryDateChange = useCallback(
    (from: string, to: string) => {
      setSummaryRange((prev) =>
        prev.from === from && prev.to === to ? prev : { from, to },
      );
    },
    [],
  );
  // Switching tabs makes the top summary follow THAT tab's own date range (each
  // date-bearing tab persists its range under its key; on mount that === what
  // the tab shows). Working Hours also live-updates via the callback above. Tabs
  // with no range (Payroll month / Employee Master / Leave) keep the last range.
  useEffect(() => {
    const key = SUMMARY_TAB_DATE_KEYS[activeTab];
    if (!key) return;
    const r = readPersistedDateRange(key);
    if (r.from && r.to) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSummaryRange((prev) =>
        prev.from === r.from && prev.to === r.to
          ? prev
          : { from: r.from as string, to: r.to as string },
      );
    }
  }, [activeTab]);
  // The summary cards read real working_hour_entries + job-card figures for
  // the selected day via /api/department-performance — Present, Working
  // Hours, Avg Efficiency — instead of the near-empty attendance table.
  const { data: summaryPerfResp } = useCachedJson<DeptPerfResponse>(
    `/api/department-performance?from=${summaryRange.from}&to=${summaryRange.to}`,
  );
  const summaryTotals = summaryPerfResp?.data?.totals;

  const fetchWorkers = useCallback(() => {
    invalidateCachePrefix("/api/workers");
    invalidateCachePrefix("/api/payslips");
    invalidateCachePrefix("/api/attendance");
    refreshWorkersHook();
  }, [refreshWorkersHook]);

  const fetchTodayAttendance = useCallback(() => {
    invalidateCachePrefix("/api/attendance");
    invalidateCachePrefix("/api/workers");
    refreshAttendanceHook();
  }, [refreshAttendanceHook]);

  const fetchDateAttendance = useCallback((date: string) => {
    fetch(`/api/attendance?date=${date}`)
      .then((r) => r.json() as Promise<{ data?: AttendanceRecord[] } | AttendanceRecord[]>)
      .then((res) => setDateAttendance(Array.isArray(res) ? res : (res.data ?? [])))
      .catch(() => {});
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- derived: today's rows for the working hours tab */
  useEffect(() => {
    // Page-level attendance is already scoped to today, so this is just a copy.
    setDateAttendance(todayAttendance);
  }, [todayAttendance]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const refreshAttendance = useCallback(
    (date: string) => {
      fetchDateAttendance(date);
      fetchTodayAttendance();
    },
    [fetchDateAttendance, fetchTodayAttendance]
  );

  // Summary stats — driven by `summaryRange` (the Working Hours date pick).
  // Headcount counts only currently-employed staff: resigned (and otherwise
  // inactive) workers are excluded so the "Total Workers" / "Present" KPIs drop
  // the moment someone is marked Resigned.
  const totalWorkers = workers.filter((w) => w.status === "ACTIVE").length;
  const presentCount = summaryTotals?.workerCount ?? 0;
  const summaryWorkingMinutes = summaryTotals?.workingMinutes ?? 0;
  const avgEfficiency =
    summaryTotals && summaryTotals.workingMinutes > 0
      ? summaryTotals.efficiencyPct.toFixed(1)
      : "0";
  const summaryDateLabel =
    summaryRange.from === summaryRange.to
      ? formatDateDMY(summaryRange.from)
      : `${formatDateDMY(summaryRange.from)} – ${formatDateDMY(summaryRange.to)}`;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6B7280]">
        Loading employee data...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">
          Employees &amp; Attendance
        </h1>
        <p className="text-xs text-[#6B7280]">
          Worker attendance, production hours, and efficiency tracking
        </p>
      </div>

      {/* Summary Cards — follow the Working Hours tab's selected date. */}
      <div>
        <p className="mb-2 text-xs text-[#6B7280]">
          Summary for{" "}
          <span className="font-medium text-[#1F1D1B]">{summaryDateLabel}</span>
        </p>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-4 max-xl:grid-cols-2 max-sm:grid-cols-1">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="rounded-lg bg-[#E0EDF0] p-2.5">
                <Users className="h-5 w-5 text-[#3E6570]" />
              </div>
              <div>
                <p className="text-2xl font-bold leading-none">{totalWorkers}</p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-[#8A8680]">Total Workers</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="rounded-lg bg-[#EEF3E4] p-2.5">
                <UserCheck className="h-5 w-5 text-[#4F7C3A]" />
              </div>
              <div>
                <p className="text-2xl font-bold leading-none text-[#4F7C3A]">
                  {presentCount}/{totalWorkers}
                </p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-[#8A8680]">Present</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="rounded-lg bg-[#FAEFCB] p-2.5">
                <Clock className="h-5 w-5 text-[#9C6F1E]" />
              </div>
              <div>
                <p className="text-2xl font-bold leading-none">
                  {(summaryWorkingMinutes / 60).toFixed(1)}h
                </p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-[#8A8680]">Working Hours</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="rounded-lg bg-[#F1E6F0] p-2.5">
                <Activity className="h-5 w-5 text-[#6B4A6D]" />
              </div>
              <div>
                <p
                  className={`text-2xl font-bold ${Number(avgEfficiency) >= 85 ? "text-[#4F7C3A]" : Number(avgEfficiency) >= 70 ? "text-[#9C6F1E]" : "text-[#9A3A2D]"}`}
                >
                  {avgEfficiency}%
                </p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-[#8A8680]">Avg Efficiency</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tab Navigation — 2026-05-24: tighter font + whitespace-nowrap so
          the 8 multi-word labels stay on ONE line. Was text-sm + px-5 py-3
          which wrapped "Working Hours" / "Labor Cost" / "Efficiency
          Overview" etc. into two lines on a 1366-px viewport. Now
          text-[11px] + px-2.5 py-2 + gap-1 fits all 9 tabs single-line
          with room to spare (owner 2026-06-23: no scroll, smaller font). */}
      <div className="border-b border-[#E2DDD8] overflow-x-auto">
        <nav className="flex gap-0 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1 px-2.5 py-2 text-[11px] font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === "working-hours" && (
        <WorkingHoursTab
          workers={workers}
          refreshAttendance={refreshAttendance}
          departments={departments}
          productionDeptCodes={productionDeptCodes}
          onDateChange={handleSummaryDateChange}
        />
      )}

      {activeTab === "attendance" && (
        <AttendanceTab workers={workers} productionDeptCodes={productionDeptCodes} />
      )}

      {activeTab === "employee-master" && (
        <EmployeeMasterTab workers={workers} refreshWorkers={fetchWorkers} departments={departments} />
      )}

      {activeTab === "efficiency" && (
        <EfficiencyOverviewTab
          workers={workers}
          departments={departments}
          onJumpToEmployeeDetail={(workerId) => {
            setPendingDetailWorkerId(workerId);
            setActiveTab("detail");
          }}
          onDateChange={handleSummaryDateChange}
        />
      )}

      {activeTab === "department-labor" && (
        <DepartmentLaborTab
          workers={workers}
          departments={departments}
          refreshDepartments={refreshDeptsHook}
          onDateChange={handleSummaryDateChange}
        />
      )}

      {activeTab === "detail" && (
        <EmployeeDetailTab
          workers={workers}
          departments={departments}
          initialWorkerId={pendingDetailWorkerId}
          onDateChange={handleSummaryDateChange}
        />
      )}

      {activeTab === "department-performance" && (
        <DepartmentPerformanceTab departments={departments} onDateChange={handleSummaryDateChange} />
      )}

      {activeTab === "labor-cost" && (
        <LaborCostTab
          workers={workers}
          departments={departments}
          productionDeptCodes={productionDeptCodes}
          onDateChange={handleSummaryDateChange}
        />
      )}

      {activeTab === "payroll" && (
        <PayrollTab workers={workers} />
      )}

      {activeTab === "leave" && (
        <LeaveManagementTab workers={workers} />
      )}
    </div>
  );
}
