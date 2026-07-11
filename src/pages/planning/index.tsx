import { useEffect, useState, useCallback, useMemo } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatHours } from "@/lib/utils";
import {
  Factory,
  TrendingUp,
  Clock,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Users,
  BarChart3,
  Loader2,
  Gauge,
  CheckCircle2,
  AlertTriangle,
  Search,
  ClipboardList,
  Calendar,
  X,
  ArrowLeft,
} from "lucide-react";
import { LeadTimeHistoryDialog } from "./LeadTimeHistoryDialog";
import { EffectiveDateConfirmModal } from "../products/MaintenanceConfigHistoryDialog";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { csrfHeaders } from "@/lib/csrf";
import { jcMinutesTotal } from "@/lib/job-card-minutes";
import { BatchActionToolbar, ApplyBatchDueDateDialog } from "../production/components/BatchActionToolbar";

// ── Types matching mock-data ──

type JobCard = {
  id: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  sequence: number;
  status: string;
  dueDate: string;
  prerequisiteMet: boolean;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string;
  productionTimeMinutes: number;
  overdue: string;
  wipLabel?: string | null;
  // wipQty: piece multiplier — JC's actual production minutes are
  // (estMinutes / actualMinutes) × wipQty per the per-unit-storage
  // convention documented in /api/department-performance. Optional
  // because older cached payloads pre-date the field.
  wipQty?: number;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  lineNo: number;
  customerPOId: string;
  customerReference: string;
  customerName: string;
  customerState: string;
  companySOId: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  notes: string;
  status: string;
  currentDepartment: string;
  progress: number;
  jobCards: JobCard[];
  startDate: string;
  targetEndDate: string;
  completedDate: string | null;
  rackingNumber: string;
  stockedIn: boolean;
  createdAt: string;
  updatedAt: string;
};

type Worker = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string;
  departmentCode: string;
  position: string;
  phone: string;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  joinDate: string;
};

type ScheduleEntry = {
  id: string;
  productionOrderId: string;
  soNumber: string;
  productCode: string;
  category: "BEDFRAME" | "SOFA";
  customerDeliveryDate: string;
  customerName: string;
  deptSchedule: {
    deptCode: string;
    deptName: string;
    startDate: string;
    endDate: string;
    minutes: number;
    status: string;
  }[];
  hookkaExpectedDD: string;
};


// ── Constants ──

const DEPARTMENTS = [
  { id: "dept-1", code: "FAB_CUT", name: "Fabric Cutting", shortName: "Fab Cut", color: "#3B82F6" },
  { id: "dept-2", code: "FAB_SEW", name: "Fabric Sewing", shortName: "Fab Sew", color: "#6366F1" },
  { id: "dept-3", code: "WOOD_CUT", name: "Wood Cutting", shortName: "Wood Cut", color: "#F59E0B" },
  { id: "dept-4", code: "FOAM", name: "Foam Bonding", shortName: "Foam", color: "#8B5CF6" },
  { id: "dept-5", code: "FRAMING", name: "Framing", shortName: "Framing", color: "#F97316" },
  { id: "dept-6", code: "WEBBING", name: "Webbing", shortName: "Webbing", color: "#10B981" },
  { id: "dept-7", code: "UPHOLSTERY", name: "Upholstery", shortName: "Upholstery", color: "#F43F5E" },
  { id: "dept-8", code: "PACKING", name: "Packing", shortName: "Packing", color: "#06B6D4" },
];

// Department code → drill-in route. A department appears as a clickable name
// on Capacity Overview + Capacity Loading only when it has a built schedule
// page; depts not in this map (Foam, Webbing, Upholstery, Packing) stay plain
// text. Keeps the click affordance in one place instead of four if-branches.
const DEPT_DRILL_ROUTE: Record<string, string> = {
  FAB_CUT: "/planning/dept/fabric-cutting",
  FAB_SEW: "/planning/dept/fabric-sewing",
  WOOD_CUT: "/planning/dept/wood-cutting",
  FOAM: "/planning/dept/foam-bonding",
  FRAMING: "/planning/dept/framing",
  WEBBING: "/planning/dept/webbing",
  UPHOLSTERY: "/planning/dept/upholstery",
  PACKING: "/planning/dept/packing",
};

// HOURS_PER_DAY: fallback for workers whose workingHoursPerDay is
// missing. Surfaced as "Hours/day" on each dept card.
//
// EFFICIENCY (0.85) was used by the old theoretical-capacity formula
// (workers × HOURS_PER_DAY × 60 × EFFICIENCY). Phase 1 spec rewrite
// replaced that with the rolling N-day actual-production average,
// so the EFFICIENCY constant is no longer referenced. Preserved
// here as a comment for archaeological context.
const HOURS_PER_DAY = 9;

// Wei Siang 2026-05-15: rolling window size for Daily Capacity +
// Daily Capacity drilldown. Started at 14 (two weeks of working
// days, Mon-Sat); shortened to 7 so the average reflects more
// recent production reality. Pull out as a single constant so a
// future "make this configurable per-dept" lands in one place.
const ROLLING_WINDOW_DAYS = 7;

// Wei Siang 2026-05-15: Capacity Loading chart window. Operator
// asked for ~21 days total split as "past production" + "future
// planned" — past matches the rolling-avg window so the operator
// sees variance vs the same baseline shown elsewhere; future runs
// out far enough that the chart still answers "when is the next
// crunch coming?" without going so far it becomes noise.
//
// Wei Siang 2026-06-02: widened the window — Past Production now
// covers 14 WORKING days (Mon-Sat, Sundays excluded) and Planned
// Capacity now covers 21 WORKING days. Both counts are working
// days only, so the chart spans more wall-clock time. The chart is
// horizontally scrollable to fit the wider span.
const LOADING_CHART_PAST_DAYS = 14;
const LOADING_CHART_FUTURE_DAYS = 21;

const TABS = [
  { id: "capacity", label: "Capacity Overview", icon: BarChart3 },
  { id: "loading", label: "Capacity Loading", icon: Gauge },
  { id: "leadtimes", label: "Lead Times", icon: Clock },
  { id: "tracker", label: "Master Tracker", icon: ClipboardList },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ── Master Tracker helpers ──

type TrackerSortField = "poNo" | "customerName" | "productCode" | "targetEndDate" | "progress" | "status";

// Hoisted out of PlanningPage so the parent's render doesn't reset its
// identity. State is passed in via props.
function TrackerSortIcon({
  field,
  activeField,
  direction,
}: {
  field: TrackerSortField;
  activeField: TrackerSortField;
  direction: "asc" | "desc";
}) {
  if (activeField !== field) return <ChevronUp className="h-3 w-3 text-[#D1CBC5]" />;
  return direction === "asc" ? (
    <ChevronUp className="h-3 w-3 text-[#6B5C32]" />
  ) : (
    <ChevronDown className="h-3 w-3 text-[#6B5C32]" />
  );
}
type TrackerSortDir = "asc" | "desc";

function getOverdueDisplay(order: ProductionOrder): { label: string; icon: string; className: string } {
  if (order.status === "COMPLETED") {
    return { label: "COMPLETED", icon: "\u2705", className: "text-[#4F7C3A] bg-[#EEF3E4]" };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(order.targetEndDate);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return { label: `${Math.abs(diffDays)}d overdue`, icon: "\u274C", className: "text-[#9A3A2D] bg-[#F9E1DA]" };
  }
  return { label: `${diffDays}d left`, icon: "\u23F3", className: "text-[#9C6F1E] bg-[#FAEFCB]" };
}

// Dept codes/names/colors for the tracker — matches the DEPARTMENTS array above
const TRACKER_DEPARTMENTS = [
  { name: "Fab Cut",    code: "FAB_CUT",    color: "#3B82F6" },
  { name: "Fab Sew",   code: "FAB_SEW",    color: "#6366F1" },
  { name: "Wood Cut",  code: "WOOD_CUT",   color: "#F59E0B" },
  { name: "Foam",      code: "FOAM",       color: "#8B5CF6" },
  { name: "Framing",   code: "FRAMING",    color: "#F97316" },
  { name: "Webbing",   code: "WEBBING",    color: "#10B981" },
  { name: "Upholstery",code: "UPHOLSTERY", color: "#F43F5E" },
  { name: "Packing",   code: "PACKING",    color: "#06B6D4" },
];

// Wei Siang 2026-05-15: Efficiency Overview rebuilt against the
// canonical Production Minutes vs Working Hours pattern used by
// /api/department-performance.
//
//  - Active count is a current snapshot (no date filter applied).
//  - Production Hours  = sum of (actualMinutes ?? estMinutes) × max(1,wipQty)
//                        for COMPLETED / TRANSFERRED JCs in [dateFrom, dateTo],
//                        ÷ 60. This is the "spec time we produced" — same
//                        formula the dept-performance endpoint uses.
//  - Working Hours     = sum of working_hour_entries.hours for the same
//                        (dept × category × date range), looked up in
//                        workingHoursByDeptCategory. This is what the
//                        supervisor entered in the flat Working Hours
//                        grid on /employees.
//  - Efficiency %      = Production Hours ÷ Working Hours × 100.
//
// Why the rename: the old "Est Hours / Actual Hours / Efficiency"
// columns both summed JC fields and fell back actual → est, making
// efficiency 100% for every dept that didn't have actualMinutes
// recorded. Operator (Wei Siang) confirmed Production = "the spec time
// we produced" and Working = "the time we paid for".
//
// Category split = order.itemCategory; ACCESSORY rows are skipped
// because the table only has SOFA + BEDFRAME columns.
function getDeptEfficiency(
  orders: ProductionOrder[],
  dateFrom: string,
  dateTo: string,
  workingHoursByDeptCategory: Map<string, number>,
) {
  const CATEGORIES = ["SOFA", "BEDFRAME"] as const;
  return TRACKER_DEPARTMENTS.flatMap((dept) =>
    CATEGORIES.map((cat) => {
      let active = 0;
      let completed = 0;
      let totalProductionMinutes = 0;

      // Wei Siang 2026-05-15 (parity fix): iterate ALL JCs per order,
      // not just the first one matching this dept. A PO can have
      // multiple JCs at the same dept (e.g. SOFA with sub-WIPs base/
      // HB/DV/ARM each landing as its own JC at Fab Cut), and the old
      // `.find()` only credited the first. Mirrors how
      // /api/department-performance iterates the candidate JC rows
      // directly — Employees > Department Performance and Planning >
      // Efficiency Overview now read off the same total per
      // (dept × category × date range).
      for (const order of orders) {
        if (order.itemCategory !== cat) continue;
        for (const jc of order.jobCards) {
          if (jc.departmentCode !== dept.code) continue;
          // Active = "in the pipeline, not done" = WAITING +
          // IN_PROGRESS + PAUSED + BLOCKED.
          if (
            jc.status === "WAITING" ||
            jc.status === "IN_PROGRESS" ||
            jc.status === "PAUSED" ||
            jc.status === "BLOCKED"
          ) {
            active++;
          }
          if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") {
            if (!jc.completedDate) continue;
            if (dateFrom && jc.completedDate < dateFrom) continue;
            if (dateTo && jc.completedDate > dateTo) continue;
            completed++;
            // FAB_CUT stores the per-SET total (wipQty = piece count); the
            // helper skips the ×wipQty there so Production Hours isn't 3× high.
            totalProductionMinutes += jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
          }
        }
      }

      // Keep raw minutes for the formatHours display ("8h 30m") and
      // for the efficiency ratio. Hours-form (decimal) dropped — the
      // canonical Hookka format is hours + minutes per utils.formatHours.
      const totalWorkingMinutes = Math.round(
        (workingHoursByDeptCategory.get(`${dept.code}|${cat}`) ?? 0) * 60,
      );
      const efficiency =
        totalWorkingMinutes > 0
          ? Math.round((totalProductionMinutes / totalWorkingMinutes) * 100)
          : 0;

      let statusLabel: string;
      let statusColor: string;
      // No-data heuristic: if either side is zero, we genuinely don't have
      // enough information — don't penalise the dept with "Needs Improvement".
      if (totalWorkingMinutes === 0 || totalProductionMinutes === 0) {
        statusLabel = "No Data";
        statusColor = "text-gray-500 bg-gray-50";
      } else if (efficiency >= 95)      { statusLabel = "Excellent";          statusColor = "text-[#4F7C3A] bg-[#EEF3E4]"; }
      else if (efficiency >= 80) { statusLabel = "Good";               statusColor = "text-[#3E6570] bg-[#E0EDF0]"; }
      else if (efficiency >= 60) { statusLabel = "Fair";               statusColor = "text-[#9C6F1E] bg-[#FAEFCB]"; }
      else                       { statusLabel = "Needs Improvement";  statusColor = "text-[#9A3A2D] bg-[#F9E1DA]"; }

      return {
        ...dept,
        category: cat,
        active,
        completed,
        totalProductionMinutes,
        totalWorkingMinutes,
        efficiency,
        statusLabel,
        statusColor,
      };
    }),
  );
}

// ── Helpers ──

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Working-day helpers — a "working day" is Mon–Sat AND not a public
// holiday. Public holidays come from kv_config['public_holidays']
// (the list maintained on the Employees → Public Holidays panel).
// Sundays were already excluded everywhere; Wei Siang 2026-05-29 asked
// that public holidays (e.g. 2026-05-27 Wesak) also drop out of the
// capacity averages so a 0-production holiday doesn't deflate the
// daily-capacity number. Centralised here so every capacity window
// (rolling avg, drilldown, loading chart, scope) shares one rule.
// `guard` caps the walk-back so a malformed holiday list can never spin.
function recentWorkingDays(count: number, holidays: Set<string>): string[] {
  const days: string[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 1); // exclude today (completions logged after the fact)
  let guard = 0;
  while (days.length < count && guard < count * 10 + 60) {
    guard++;
    const iso = fmtISO(cursor);
    if (cursor.getDay() !== 0 && !holidays.has(iso)) days.unshift(iso);
    cursor.setDate(cursor.getDate() - 1);
  }
  return days;
}

function upcomingWorkingDays(count: number, holidays: Set<string>): string[] {
  const days: string[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0); // include today (its bar is the plan, not production)
  let guard = 0;
  while (days.length < count && guard < count * 10 + 60) {
    guard++;
    const iso = fmtISO(cursor);
    if (cursor.getDay() !== 0 && !holidays.has(iso)) days.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function countWorkingDays(from: Date, to: Date, holidays: Set<string>): number {
  let n = 0;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    if (d.getDay() !== 0 && !holidays.has(fmtISO(d))) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

function utilizationColor(pct: number): { bar: string; text: string; bg: string } {
  if (pct > 90) return { bar: "bg-[#9A3A2D]", text: "text-[#9A3A2D]", bg: "bg-[#F9E1DA]" };
  if (pct >= 70) return { bar: "bg-[#9C6F1E]", text: "text-[#9C6F1E]", bg: "bg-[#FAEFCB]" };
  return { bar: "bg-[#4F7C3A]", text: "text-[#4F7C3A]", bg: "bg-[#EEF3E4]" };
}


// ── Main Component ──

export default function PlanningPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  // In-app confirm (owner rule [[feedback_no_naked_edits]]: no naked toggle —
  // flipping auto-schedule globally re-routes how every future SO confirm sets
  // job-card due dates, so it must ask before applying, via the in-app dialog
  // rather than window.confirm).
  const { confirm, confirmDialog } = useConfirm();
  const [activeTab, setActiveTab] = useState<TabId>("capacity");
  // ?fields=minimal&include=jobCards → drops ~20 unused PO fields and the
  // piece_pics tree. jobCards still arrive (planning iterates order.jobCards
  // throughout for capacity / scheduling math).
  //
  // 2026-05-25: added &excludeCompleted=true so completed / transferred /
  // cancelled POs don't load. Planning is about FUTURE work — finished
  // POs don't need scheduling. Cuts wire payload ~60% + parse cost on
  // the page-load spinner. Mirrors the Phase 4 fix on the Production
  // dept page. Server-side snapshot cache (Phase 6) also applies for
  // free since this hits the same /api/production-orders endpoint.
  const { data: ordersResp, loading: ordersLoading, refresh: refreshOrders } = useCachedJson<{ data?: ProductionOrder[] }>("/api/production-orders?fields=minimal&include=jobCards&excludeCompleted=true");
  const { data: workersResp, loading: workersLoading, refresh: refreshWorkers } = useCachedJson<{ data?: Worker[] }>("/api/workers");
  const { data: schedResp, refresh: refreshSched } = useCachedJson<{ data?: ScheduleEntry[] }>("/api/scheduling");
  // Wei Siang 2026-05-15: Capacity Loading lists only production depts.
  // Drive the list from /api/departments + isProduction flag (matches
  // the employees.tsx canonical pattern) so non-production depts
  // (WAREHOUSING, REPAIR, MAINTENANCE, PRODUCTION_SHORTFALL, R_AND_D)
  // can't sneak in and any new prod dept added via the admin UI
  // appears automatically — no code change required.
  const { data: deptsResp } = useCachedJson<{
    data?: { id: string; code: string; name: string; color: string; sequence: number; isProduction: boolean }[];
  }>("/api/departments");
  const orders: ProductionOrder[] = useMemo(() => ordersResp?.data ?? [], [ordersResp]);
  const workers: Worker[] = useMemo(() => workersResp?.data ?? [], [workersResp]);

  // Public holidays (kv_config['public_holidays'], maintained on the
  // Employees → Public Holidays panel). Excluded from every capacity
  // working-day window below so a 0-production holiday doesn't deflate
  // the daily-capacity average. — Wei Siang 2026-05-29
  const { data: holidaysResp } = useCachedJson<{ data?: unknown }>("/api/kv-config/public_holidays");
  const publicHolidaySet = useMemo(() => {
    const s = new Set<string>();
    const arr = holidaysResp?.data;
    if (Array.isArray(arr)) {
      for (const d of arr) {
        if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) s.add(d);
      }
    }
    return s;
  }, [holidaysResp]);
  // Production-only dept list, sorted by sequence. Falls back to the
  // hardcoded DEPARTMENTS list while /api/departments is still loading
  // so first paint doesn't flash an empty Capacity Loading tab.
  const productionDepartments = useMemo(() => {
    const live = deptsResp?.data;
    if (!live || live.length === 0) {
      return DEPARTMENTS.map((d) => ({ code: d.code, name: d.name, color: d.color }));
    }
    return live
      .filter((d) => d.isProduction)
      .sort((a, b) => a.sequence - b.sequence)
      .map((d) => ({ code: d.code, name: d.name, color: d.color }));
  }, [deptsResp]);
  // Wei Siang 2026-05-15 audit: schedules feed the Master Tracker's
  // Hookka DD column (was previously voided, leaving the column
  // duplicating Target End).
  const schedules: ScheduleEntry[] = useMemo(() => schedResp?.data ?? [], [schedResp]);
  const loading = ordersLoading || workersLoading;
  // Wei Siang 2026-05-15 Phase 1: /api/scheduling/capacity is no
  // longer consumed — Capacity Overview + Capacity Loading both
  // compute client-side from orders + workers with the new 14-day
  // rolling actual-capacity baseline. The endpoint may still be
  // useful as a backend cross-check later; for now it's quiet.

  // ── Capacity Overview > Efficiency Overview filter ──
  // Wei Siang 2026-05-15 Phase 2: filter completed JCs by completion
  // date. Default = past 30 days ending today. Format YYYY-MM-DD so
  // string compare works against jc.completedDate.
  const [effDateFrom, setEffDateFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return fmtISO(d);
  });
  const [effDateTo, setEffDateTo] = useState<string>(() => fmtISO(new Date()));
  // Wei Siang 2026-05-15: split-vs-combined toggle. Default split
  // (one row per (dept × SOFA|BEDFRAME)). Combined collapses each
  // dept's two rows into one row that sums Active / Completed /
  // Production Time / Working Hrs across categories, then recomputes
  // Efficiency % + Status from the combined totals. Category column
  // hides when combined.
  const [effShowCombined, setEffShowCombined] = useState(false);

  // Wei Siang 2026-05-15: Working Hours come from working_hour_entries
  // (per-dept × per-category hour totals for the date range), NOT from
  // jc.actualMinutes. The old "Actual Hours" column was falling back to
  // jc.estMinutes when actualMinutes wasn't recorded, which made every
  // row read 100% Excellent. Real working time is what supervisors
  // entered in the Working Hours grid on /employees.
  const { data: workingHoursResp } = useCachedJson<{
    data?: {
      range: { from: string; to: string };
      buckets: { departmentCode: string; category: string; hours: number }[];
    };
  }>(`/api/working-hour-entries/dept-category-summary?from=${effDateFrom}&to=${effDateTo}`);
  const workingHoursByDeptCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of workingHoursResp?.data?.buckets ?? []) {
      m.set(`${b.departmentCode}|${b.category}`, b.hours);
    }
    return m;
  }, [workingHoursResp]);

  // ── Capacity Loading filter (2026-05-26): operator can split the
  //    Past/Future bars by item category. Default ALL so the chart shows
  //    the whole picture; SOFA / BEDFRAME isolate the line to see if one
  //    side alone is overloading the dept. ──
  const [loadingCategoryFilter, setLoadingCategoryFilter] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");

  // ── Master Tracker state ──
  const [trackerCategoryTab, setTrackerCategoryTab] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");
  const [trackerSearch, setTrackerSearch] = useState("");
  const [trackerStatusFilter, setTrackerStatusFilter] = useState("ALL");
  const [trackerDateFrom, setTrackerDateFrom] = useState("");
  const [trackerDateTo, setTrackerDateTo] = useState("");
  const [trackerSortField, setTrackerSortField] = useState<TrackerSortField>("poNo");
  const [trackerSortDir, setTrackerSortDir] = useState<TrackerSortDir>("asc");

  // ── Master Tracker batch Due Date (multi-select) ──
  // Each tracker row is a whole production order (one PO spans up to 8
  // department job cards), so the batch action also needs a department scope:
  // which department's job card gets the new due date. "ALL" writes the date
  // to every department job card on each selected order. Mirrors the
  // production page: same ApplyBatchDueDateDialog, same
  // /api/production-orders/bulk-patch endpoint, same toast + refetch. The
  // department scope is the only tracker-specific addition, because its rows
  // are orders not individual job cards.
  const [selectedTrackerIds, setSelectedTrackerIds] = useState<Set<string>>(new Set());
  const [trackerBatchDept, setTrackerBatchDept] = useState<string>("ALL");
  const [trackerBatchDueDateOpen, setTrackerBatchDueDateOpen] = useState(false);

  // Lead times config state (editable table)
  type LeadTimeCat = "BEDFRAME" | "SOFA";
  const [leadTimes, setLeadTimes] = useState<Record<LeadTimeCat, Record<string, number>>>({
    BEDFRAME: {},
    SOFA: {},
  });
  // Hookka Expected DD buffer (days between customer DD and internal target).
  // Stored separately from per-dept leadTimes because it lives in its own
  // table (hookka_dd_buffer) and shifts the reverse-schedule anchor rather
  // than contributing to any dept chain.
  const [hookkaDDBuffer, setHookkaDDBuffer] = useState<Record<LeadTimeCat, number>>({
    BEDFRAME: 2,
    SOFA: 1,
  });
  const [ltSaving, setLtSaving] = useState(false);
  const [ltSavedAt, setLtSavedAt] = useState<string | null>(null);
  const [showLtSaveModal, setShowLtSaveModal] = useState(false);
  const [recalcRunning, setRecalcRunning] = useState(false);
  const [recalcResult, setRecalcResult] = useState<string | null>(null);
  // Global ON/OFF toggle for lead-time auto-scheduling of due dates. Sourced
  // from the GET /api/production/leadtimes payload (default TRUE). When OFF,
  // SO confirm leaves job-card due dates blank for manual entry and the
  // Recalculate Existing POs action is disabled.
  const [autoScheduleEnabled, setAutoScheduleEnabled] = useState(true);
  const [autoScheduleSaving, setAutoScheduleSaving] = useState(false);
  // History dialog (scheduled future-dated changes). Mirrors the products
  // MasterPriceHistoryDialog pattern. `pendingSummary` is sourced from the
  // GET /api/production/leadtimes response so the trigger button can show
  // a "X pending" badge without an extra round-trip.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingSummary, setPendingSummary] = useState<{
    count: number;
    nearestEffectiveFrom: string | null;
  }>({ count: 0, nearestEffectiveFrom: null });

  const { data: leadTimesJson, refresh: refreshLeadTimes } = useCachedJson<{ success?: boolean; data?: unknown }>("/api/production/leadtimes");

  /* eslint-disable react-hooks/set-state-in-effect -- mirror server lead-time config into editable local state */
  useEffect(() => {
    const json = leadTimesJson;
    const d = json?.data as Record<string, unknown> | undefined;
    if (
      json?.success &&
      d &&
      typeof d === "object" &&
      !Array.isArray(d) &&
      ((d as { BEDFRAME?: unknown }).BEDFRAME || (d as { SOFA?: unknown }).SOFA)
    ) {
      const dd = d as {
        BEDFRAME?: Record<string, number>;
        SOFA?: Record<string, number>;
        hookkaDDBuffer?: unknown;
        pending?: { count?: number; nearestEffectiveFrom?: string | null };
        autoScheduleEnabled?: boolean;
      };
      setLeadTimes({
        BEDFRAME: dd.BEDFRAME ?? {},
        SOFA: dd.SOFA ?? {},
      });
      // Default TRUE when the field is absent (older payload / fresh org).
      setAutoScheduleEnabled(dd.autoScheduleEnabled !== false);
      if (dd.hookkaDDBuffer && typeof dd.hookkaDDBuffer === "object") {
        const b = dd.hookkaDDBuffer as { BEDFRAME?: number; SOFA?: number };
        setHookkaDDBuffer({
          BEDFRAME: typeof b.BEDFRAME === "number" && b.BEDFRAME >= 0 ? b.BEDFRAME : 2,
          SOFA: typeof b.SOFA === "number" && b.SOFA >= 0 ? b.SOFA : 1,
        });
      }
      setPendingSummary({
        count: typeof dd.pending?.count === "number" ? dd.pending.count : 0,
        nearestEffectiveFrom: dd.pending?.nearestEffectiveFrom ?? null,
      });
    }
  }, [leadTimesJson]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateLeadTime = (cat: LeadTimeCat, deptCode: string, value: string) => {
    const n = Number(value);
    const v = Number.isFinite(n) && n >= 0 ? n : 0;
    if (deptCode === "HOOKKA_DD") {
      setHookkaDDBuffer((prev) => ({ ...prev, [cat]: v }));
      return;
    }
    setLeadTimes((prev) => ({
      ...prev,
      [cat]: { ...prev[cat], [deptCode]: v },
    }));
  };

  const persistLeadTimes = async (effectiveFrom: string, notes: string) => {
    setLtSaving(true);
    try {
      const res = await fetch("/api/production/leadtimes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...leadTimes,
          hookkaDDBuffer,
          effectiveFrom,
          notes: notes || null,
        }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      // Don't show "Saved {time}" on a failed PUT — that was the silent-failure
      // bug (lead times drive due-date scheduling factory-wide).
      if (!res.ok || (j && j.success === false)) {
        toast.error(j?.error || `Save failed (${res.status}) — lead times NOT saved.`);
        return;
      }
      invalidateCachePrefix("/api/production/leadtimes");
      refreshLeadTimes();
      setLtSavedAt(new Date().toLocaleTimeString());
    } catch {
      toast.error("Save failed — network error. Lead times NOT saved.");
    } finally {
      setLtSaving(false);
    }
  };

  // Flip the global lead-time auto-schedule toggle. When turned OFF, new SO
  // confirms leave job-card due dates blank for staff to fill manually, and
  // the Recalculate Existing POs action becomes a no-op so manual dates are
  // preserved. Optimistic local update with rollback on failure.
  // Ask before flipping the global auto-schedule switch (owner rule: no naked
  // toggle). Confirmed → apply; cancelled → leave the switch untouched.
  const requestToggleAutoSchedule = async (next: boolean) => {
    if (autoScheduleSaving) return;
    const ok = await confirm({
      title: next ? "Turn auto-schedule ON?" : "Turn auto-schedule OFF?",
      message: next
        ? "New SO confirms will auto-compute job-card due dates from the lead times below. Existing orders are not changed until you Recalculate."
        : "New SO confirms will leave job-card due dates blank for staff to fill in manually. Existing due dates are left untouched.",
      confirmLabel: next ? "Turn ON" : "Turn OFF",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    await toggleAutoSchedule(next);
  };

  const toggleAutoSchedule = async (next: boolean) => {
    setAutoScheduleSaving(true);
    setAutoScheduleEnabled(next);
    try {
      const res = await fetch("/api/production/leadtimes/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoScheduleEnabled: next }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
      } | null;
      if (!json?.success) {
        setAutoScheduleEnabled(!next); // rollback
      } else {
        invalidateCachePrefix("/api/production/leadtimes");
        refreshLeadTimes();
      }
    } catch {
      setAutoScheduleEnabled(!next); // rollback
    } finally {
      setAutoScheduleSaving(false);
    }
  };

  // Rewrites dueDate on every existing production order's job_cards using the
  // current lead-time config. Destructive for old orders, so we confirm first
  // and then invalidate the production cache so the tracker picks up new
  // dates immediately.
  const recalcAllDueDates = async () => {
    const ok = await confirm({
      title: "Recalculate all due dates?",
      message:
        "Recalculate due dates on ALL existing production orders?\n\n" +
        "This will rewrite every job card's dueDate using the current lead " +
        "times. Orders mid-production will see their department targets shift.",
      danger: true,
    });
    if (!ok) return;
    setRecalcRunning(true);
    setRecalcResult(null);
    try {
      const res = await fetch("/api/production/leadtimes/recalc-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        updatedPOs?: number;
        updatedJCs?: number;
        skipped?: number;
        error?: string;
      } | null;
      if (json?.success) {
        setRecalcResult(
          `Updated ${json.updatedPOs ?? 0} POs / ${json.updatedJCs ?? 0} job cards` +
            (json.skipped ? ` (${json.skipped} skipped)` : ""),
        );
        invalidateCachePrefix("/api/production-orders");
        refreshOrders();
      } else {
        setRecalcResult(`Failed: ${json?.error || "unknown error"}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRecalcResult(`Failed: ${msg}`);
    } finally {
      setRecalcRunning(false);
    }
  };

  // Canonical row order for the leadtimes editor
  const LEADTIME_ROWS: { code: string; label: string }[] = [
    { code: "FAB_CUT",    label: "Fabric Cutting" },
    { code: "FAB_SEW",    label: "Fabric Sewing" },
    { code: "FOAM",       label: "Foam Bonding" },
    { code: "WOOD_CUT",   label: "Wood Cutting" },
    { code: "FRAMING",    label: "Framing" },
    { code: "UPHOLSTERY", label: "Upholstery" },
    { code: "PACKING",    label: "Packing" },
    { code: "WEBBING",    label: "Webbing" },
    { code: "HOOKKA_DD",  label: "Hookka Expected DD" },
  ];

  // ── Fetch data ──
  const _fetchData = useCallback(() => {
    invalidateCachePrefix("/api/production-orders");
    invalidateCachePrefix("/api/workers");
    invalidateCachePrefix("/api/scheduling");
    refreshOrders();
    refreshWorkers();
    refreshSched();
  }, [refreshOrders, refreshWorkers, refreshSched]);

  // today (also used by Gantt + capacity calc below)
  const today = fmtISO(new Date());

  // Wei Siang 2026-05-15 audit: scheduling API carries hookkaExpectedDD
  // per production order — the Master Tracker's "Hookka DD" column was
  // previously rendering targetEndDate as a stand-in (identical to the
  // adjacent "Target End" column, making it a confusing duplicate).
  // Build an id → hookkaExpectedDD lookup so the column shows the real
  // customer-DD-minus-buffer date that calculateHookkaDD() computes.
  const hookkaDDByPoId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of schedules) {
      if (s.productionOrderId && s.hookkaExpectedDD) {
        m.set(s.productionOrderId, s.hookkaExpectedDD);
      }
    }
    return m;
  }, [schedules]);

  // ── Capacity Overview time scope ──
  // Wei Siang 2026-05-15 (Phase 1): top-of-page toggle drives every
  // card. Daily = today only; Weekly = current Mon-Sat; Monthly =
  // current calendar month. Capacity is always the rolling 14-day
  // daily average of actually-completed minutes (see capacityData
  // below) — for Weekly we scale to working days in week, Monthly
  // to working days in month.
  type CapacityScope = "daily" | "weekly" | "monthly";
  const [capacityScope, setCapacityScope] = useState<CapacityScope>("daily");

  // ── Capacity Overview KPI drilldown ──
  // Wei Siang 2026-05-15 spec: clicking "Daily Capacity" KPI opens a
  // 14-day breakdown; clicking a day opens the per-dept split for
  // that day; clicking a dept opens the per-worker + per-JC list.
  // Same idea for "{Scope}'s Load" KPI but starts at per-dept (only
  // one date involved). We model this as a stack of levels so each
  // drilldown gets its own back button without prop-drilling state.
  // Wei Siang 2026-05-15: drilldown shape
  //   capacity-14d              → 14-day list (one row per day)
  //   capacity-day              → per-dept production on a date
  //   capacity-day-dept         → per-worker on that date × dept
  //   capacity-day-dept-worker  → per-JC for that worker
  //   load-by-dept              → per-dept scheduled load in current scope
  //   load-dept                 → per-worker for that dept (active JCs)
  //   load-dept-worker          → per-JC for that worker
  //   backlog-by-dept           → per-dept backlog days table
  type DrilldownLevel =
    | { kind: "capacity-14d" }
    | { kind: "capacity-day"; date: string }
    | { kind: "capacity-day-dept"; date: string; deptCode: string }
    | { kind: "capacity-day-dept-worker"; date: string; deptCode: string; workerId: string; workerName: string }
    | { kind: "load-by-dept" }
    | { kind: "load-dept"; deptCode: string }
    | { kind: "load-dept-worker"; deptCode: string; workerId: string; workerName: string }
    | { kind: "backlog-by-dept" };
  const [drilldownStack, setDrilldownStack] = useState<DrilldownLevel[]>([]);
  const pushDrilldown = useCallback((level: DrilldownLevel) => {
    setDrilldownStack((s) => [...s, level]);
  }, []);
  const popDrilldown = useCallback(() => {
    setDrilldownStack((s) => s.slice(0, -1));
  }, []);
  const closeDrilldown = useCallback(() => {
    setDrilldownStack([]);
  }, []);

  // Range covered by the scope toggle (used as the "Today's load"
  // bucket — JCs whose dueDate falls inside this range).
  const scopeRange = useMemo(() => {
    const now = new Date();
    if (capacityScope === "daily") {
      return { from: today, to: today, workingDays: 1, label: "Today" };
    }
    if (capacityScope === "weekly") {
      // Mon-Sat (Hookka working week per memory).
      const day = now.getDay(); // Sun=0..Sat=6
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setDate(now.getDate() + mondayOffset);
      const saturday = new Date(monday);
      saturday.setDate(monday.getDate() + 5);
      // Working days = Mon-Sat minus any public holiday in the week.
      return { from: fmtISO(monday), to: fmtISO(saturday), workingDays: countWorkingDays(monday, saturday, publicHolidaySet), label: "This Week" };
    }
    // Monthly: 1st → end of current calendar month.
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    // Count working days (Mon-Sat, minus public holidays) in the month.
    const wd = countWorkingDays(first, last, publicHolidaySet);
    return { from: fmtISO(first), to: fmtISO(last), workingDays: wd, label: "This Month" };
  }, [capacityScope, today, publicHolidaySet]);

  // ── Capacity data ──
  // Wei Siang 2026-05-15 spec rewrite:
  //   Daily Capacity = rolling 14-calendar-day average of ACTUAL
  //   completed minutes per dept (was: theoretical workers × hours
  //   × 0.85). Reflects what the floor actually produces.
  //
  //   Today's Load = sum of estMinutes on job cards whose dueDate
  //   falls in the active scope (today / this week / this month).
  //   Split SOFA vs BEDFRAME per Wei Siang's "三层全部分" rule.
  //
  //   Backlog = active job cards' estMinutes ÷ Daily Capacity,
  //   surfaced as days. Also split SOFA/BEDFRAME.
  //
  //   TRANSFERRED counts as completed-here (consistent with
  //   getDeptEfficiency()) so it's excluded from active load and
  //   included in the 14-day actual-production rolling avg.
  const capacityData = useMemo(() => {
    // Rolling window = the N most-recent working days (Mon-Sat, EXCLUDING
    // Sundays AND public holidays), ending YESTERDAY. Today is excluded
    // because completions are recorded after the fact (today reads ~0 and
    // would deflate the average). Public-holiday exclusion (Wei Siang
    // 2026-05-29) stops a 0-production holiday from dragging the average
    // down. Shared with the drilldown + loading chart via recentWorkingDays.
    const rollingWindowDays = recentWorkingDays(ROLLING_WINDOW_DAYS, publicHolidaySet);
    const rollingWindowSet = new Set(rollingWindowDays);
    const scopeTo = scopeRange.to;
    const scopeDays = Math.max(scopeRange.workingDays, 1);
    // Wei Siang 2026-05-15: helper for the per-UNIT → per-JC multiplier.
    // jc.estMinutes / jc.actualMinutes are stored per-piece (see
    // import-completion.ts:538 + job-cards.ts:219 comments). Total
    // production time for the JC = per-unit × wipQty. Missing this
    // factor under-counts every multi-piece JC. EXCEPTION: merged FAB_CUT
    // JCs store the per-SET total already (wipQty = piece count), so
    // jcMinutesTotal skips the ×wipQty there — see helper.
    const jcMinutes = (jc: JobCard, useActual: boolean): number => {
      const perUnit = useActual ? jc.actualMinutes ?? jc.estMinutes ?? 0 : jc.estMinutes ?? 0;
      return jcMinutesTotal(perUnit, jc);
    };

    return DEPARTMENTS.map((dept) => {
      // TEST accounts excluded (owner 2026-07-11) — same rule as Payroll.
      const deptWorkers = workers.filter(
        (w) =>
          w.departmentCode === dept.code &&
          w.status === "ACTIVE" &&
          !/^TEST/i.test(w.empNo || ""),
      );
      const workerCount = deptWorkers.length;
      // Average working hours per day across this dept's active
      // workers (some may be part-time). Used for the per-card
      // "Working Hours" surface — purely informational, doesn't
      // feed Daily Capacity (which is now actual-based).
      const avgWorkingHours =
        workerCount > 0
          ? Math.round(
              (deptWorkers.reduce((s, w) => s + (w.workingHoursPerDay || HOURS_PER_DAY), 0) /
                workerCount) *
                10,
            ) / 10
          : HOURS_PER_DAY;

      // N-day rolling actual production — sum (actualMinutes ?? estMinutes)
      // × wipQty on JCs completed in the rolling window, ÷ N → daily
      // average. wipQty fix lifted from /api/department-performance
      // pattern; previously a multi-piece JC counted as one piece's worth.
      let windowTotalMinutes = 0;
      for (const order of orders) {
        for (const jc of order.jobCards) {
          if (jc.departmentCode !== dept.code) continue;
          if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
          if (!jc.completedDate) continue;
          if (!rollingWindowSet.has(jc.completedDate)) continue;
          windowTotalMinutes += jcMinutes(jc, true);
        }
      }
      const dailyCapacity = Math.round(windowTotalMinutes / ROLLING_WINDOW_DAYS);

      // Active job cards split by SOFA / BEDFRAME / OTHER.
      // TRANSFERRED excluded (already handed to next dept).
      const sofaActive: JobCard[] = [];
      const bfActive: JobCard[] = [];
      for (const order of orders) {
        if (order.status !== "IN_PROGRESS" && order.status !== "PENDING") continue;
        for (const jc of order.jobCards) {
          if (jc.departmentCode !== dept.code) continue;
          if (jc.status === "COMPLETED" || jc.status === "CANCELLED" || jc.status === "TRANSFERRED") continue;
          if (order.itemCategory === "SOFA") sofaActive.push(jc);
          else if (order.itemCategory === "BEDFRAME") bfActive.push(jc);
        }
      }

      const sofaBacklog = sofaActive.reduce((s, jc) => s + jcMinutes(jc, false), 0);
      const bfBacklog = bfActive.reduce((s, jc) => s + jcMinutes(jc, false), 0);
      const totalBacklog = sofaBacklog + bfBacklog;
      // Div-zero guard (owner audit 2026-07-11): a dept with zero completions
      // in the rolling window used to divide by 1 MINUTE → thousands of fake
      // "days". With no capacity to measure against, show 0 days — the dept's
      // backlog HOURS stay visible and truthful on the same card.
      const safeDays = (mins: number) =>
        dailyCapacity > 0 ? Math.round((mins / dailyCapacity) * 10) / 10 : 0;
      const sofaBacklogDays = safeDays(sofaBacklog);
      const bfBacklogDays = safeDays(bfBacklog);
      const totalBacklogDays = safeDays(totalBacklog);

      // Wei Siang 2026-05-15: {Scope}'s Load = JCs with dueDate
      // <= scopeTo, still active. Includes overdue (dueDate before
      // scopeFrom) because that work is "pressing on us today" —
      // operator should see it on the Load card, not just hidden in
      // Backlog. Util % exceeding 100% on Daily scope means "we have
      // more pressure than one day's capacity can clear".
      const sofaScopeLoad = sofaActive
        .filter((jc) => jc.dueDate && jc.dueDate <= scopeTo)
        .reduce((s, jc) => s + jcMinutes(jc, false), 0);
      const bfScopeLoad = bfActive
        .filter((jc) => jc.dueDate && jc.dueDate <= scopeTo)
        .reduce((s, jc) => s + jcMinutes(jc, false), 0);
      const totalScopeLoad = sofaScopeLoad + bfScopeLoad;

      // Utilization denominator scales with scope: daily uses 1×
      // capacity, weekly uses (workingDays × capacity), etc.
      const scopeCapacity = dailyCapacity * scopeDays;
      const denomScope = scopeCapacity > 0 ? scopeCapacity : 1;
      const sofaScopeUtilization = Math.round((sofaScopeLoad / denomScope) * 100);
      const bfScopeUtilization = Math.round((bfScopeLoad / denomScope) * 100);
      const totalScopeUtilization = Math.round((totalScopeLoad / denomScope) * 100);

      return {
        ...dept,
        workerCount,
        avgWorkingHours,
        dailyCapacity,
        windowTotalMinutes,
        sofaBacklog,
        bfBacklog,
        totalBacklog,
        sofaBacklogDays,
        bfBacklogDays,
        totalBacklogDays,
        sofaScopeLoad,
        bfScopeLoad,
        totalScopeLoad,
        sofaScopeUtilization,
        bfScopeUtilization,
        totalScopeUtilization,
        scopeCapacity,
      };
    });
  }, [orders, workers, scopeRange, publicHolidaySet]);

  const totalCapacity = capacityData.reduce((s, d) => s + d.dailyCapacity, 0);
  const totalScopeCapacity = capacityData.reduce((s, d) => s + d.scopeCapacity, 0);
  const totalSofaBacklog = capacityData.reduce((s, d) => s + d.sofaBacklog, 0);
  const totalBfBacklog = capacityData.reduce((s, d) => s + d.bfBacklog, 0);
  const totalBacklog = totalSofaBacklog + totalBfBacklog;
  // Wei Siang 2026-05-15: totalSofaBacklogDays / totalBfBacklogDays
  // dropped — per-category Backlog now renders in raw hours, so the
  // days-form of those two splits has no remaining consumer. Total
  // Backlog (across both categories) still renders in days because
  // that IS the real wall-clock to clear the queue.
  const totalBacklogDays =
    totalCapacity > 0 ? Math.round((totalBacklog / totalCapacity) * 10) / 10 : 0;
  const totalSofaScopeLoad = capacityData.reduce((s, d) => s + d.sofaScopeLoad, 0);
  const totalBfScopeLoad = capacityData.reduce((s, d) => s + d.bfScopeLoad, 0);
  const totalScopeLoad = totalSofaScopeLoad + totalBfScopeLoad;
  const sofaScopeUtilization =
    totalScopeCapacity > 0 ? Math.round((totalSofaScopeLoad / totalScopeCapacity) * 100) : 0;
  const bfScopeUtilization =
    totalScopeCapacity > 0 ? Math.round((totalBfScopeLoad / totalScopeCapacity) * 100) : 0;
  const totalScopeUtilization =
    totalScopeCapacity > 0 ? Math.round((totalScopeLoad / totalScopeCapacity) * 100) : 0;

  // ── Capacity Loading (two views: past production + future load) ──
  // Wei Siang 2026-05-15: refactored from a single-future-chart to a
  // two-view layout per dept:
  //   Past N days    → completedDate-bucketed actual production
  //   Future M days  → dueDate-bucketed planned load
  // Both use the same dailyCapacity denominator (the rolling daily
  // avg from capacityData, ROLLING_WINDOW_DAYS wide) so the % is
  // directly comparable between the two surfaces — past variance vs
  // the avg, future pressure vs the same avg.
  //
  // Renders are in /loading tab; the dailyCapacityMinutes is kept on
  // the dept object for internal % math but no longer shown on the
  // card title (operator asked to drop it from the display).
  const dailyLoadingByDept = useMemo(() => {
    // Wei Siang 2026-05-16 cut-off rule: TODAY belongs to the PLAN
    // side, not Past Production. Today's completion isn't recorded
    // until the floor reports at end of day, so a "today" bar in the
    // Past section is permanently 0% and misleading. Instead:
    //   Past Production = N working days ending YESTERDAY
    //   Planned Capacity = TODAY + next (M-1) working days
    // So today's bar shows today's dueDate-scheduled plan.
    // Both windows skip Sundays AND public holidays (no production /
    // no capacity on those days). — Wei Siang 2026-05-29
    const pastDays = recentWorkingDays(LOADING_CHART_PAST_DAYS, publicHolidaySet);
    const pastDayIndex = new Set(pastDays);

    // Future M working days starting TODAY (today included — its bar
    // is the plan, not the not-yet-recorded production).
    const futureDays = upcomingWorkingDays(LOADING_CHART_FUTURE_DAYS, publicHolidaySet);
    const futureDayIndex = new Set(futureDays);

    // Pre-bucket two ways: (dept, dueDate) for future load, and
    // (dept, completedDate) for past production. Avoids O(days × jcs)
    // loops in the per-dept map below.
    const futureBucket = new Map<string, Map<string, number>>();
    const pastBucket = new Map<string, Map<string, number>>();
    // 2026-05-26: ALSO tally per-dept-per-category past minutes (regardless
    // of the visible filter) so we can compute each category's "share" of
    // the dept's capacity. Wei Siang's ask: when filter = Bedframe, the
    // 100% reference line should be BEDFRAME's slice of dept capacity,
    // not the whole dept. The ratio comes from the past 7d production
    // mix — bedframe vs sofa minutes — and acts as the multiplier on
    // dailyCap to get the effective denominator under the filter.
    const pastByDeptByCategory = new Map<string, { bedframe: number; sofa: number }>();

    for (const order of orders) {
      const isBedframe = order.itemCategory === "BEDFRAME";
      const isSofa = order.itemCategory === "SOFA";
      const passesFilter =
        loadingCategoryFilter === "ALL" ||
        order.itemCategory === loadingCategoryFilter;
      for (const jc of order.jobCards) {
        // Future = active JC, dueDate in future window. Filter applies
        // here so the planned-load bar only sums the visible category.
        if (
          passesFilter &&
          (order.status === "IN_PROGRESS" || order.status === "PENDING") &&
          jc.dueDate &&
          futureDayIndex.has(jc.dueDate) &&
          jc.status !== "COMPLETED" &&
          jc.status !== "CANCELLED" &&
          jc.status !== "TRANSFERRED"
        ) {
          const mins = jcMinutesTotal(jc.estMinutes || 0, jc);
          if (!futureBucket.has(jc.departmentCode)) futureBucket.set(jc.departmentCode, new Map());
          const deptMap = futureBucket.get(jc.departmentCode) as Map<string, number>;
          deptMap.set(jc.dueDate, (deptMap.get(jc.dueDate) ?? 0) + mins);
        }
        // Past = completed JC, completedDate in past window.
        if (
          (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") &&
          jc.completedDate &&
          pastDayIndex.has(jc.completedDate)
        ) {
          const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
          // (a) Bucket for the visible filter — drives the chart bar.
          if (passesFilter) {
            if (!pastBucket.has(jc.departmentCode)) pastBucket.set(jc.departmentCode, new Map());
            const deptMap = pastBucket.get(jc.departmentCode) as Map<string, number>;
            deptMap.set(jc.completedDate, (deptMap.get(jc.completedDate) ?? 0) + mins);
          }
          // (b) Always tally by category (ignoring filter) so the
          //     effective-capacity ratio is stable across filter changes.
          if (isBedframe || isSofa) {
            const e = pastByDeptByCategory.get(jc.departmentCode) ?? { bedframe: 0, sofa: 0 };
            if (isBedframe) e.bedframe += mins;
            else e.sofa += mins;
            pastByDeptByCategory.set(jc.departmentCode, e);
          }
        }
      }
    }

    return productionDepartments.map((dept) => {
      const capDept = capacityData.find((d) => d.code === dept.code);
      const fullDailyCap = capDept?.dailyCapacity ?? 0;

      // 2026-05-26: derive the EFFECTIVE daily capacity under the active
      // filter. ALL → use the dept's full capacity. BEDFRAME/SOFA → scale
      // the full capacity down by that category's share of past 7d work
      // (e.g. if past mix was 60% bedframe / 40% sofa and full cap is
      // 50h, Bedframe filter sees effective cap = 30h). This makes the
      // bar % read as "how full is this category's slice of the dept",
      // not "how much of the WHOLE dept is bedframe alone consuming"
      // (which would always look small under a single-category filter
      // and falsely read as "under-planned"). Edge case: if past 7d has
      // zero of the active category for this dept (brand new line),
      // fall back to full capacity so the bar still renders sensibly
      // — operator can then visually compare against the dashed 100%
      // line without a divide-by-zero.
      const catPast = pastByDeptByCategory.get(dept.code) ?? { bedframe: 0, sofa: 0 };
      const totalCatPast = catPast.bedframe + catPast.sofa;
      let categoryShare = 1;
      if (loadingCategoryFilter === "BEDFRAME") {
        categoryShare = totalCatPast > 0 ? catPast.bedframe / totalCatPast : 1;
      } else if (loadingCategoryFilter === "SOFA") {
        categoryShare = totalCatPast > 0 ? catPast.sofa / totalCatPast : 1;
      }
      const dailyCap = fullDailyCap * categoryShare;
      const denom = dailyCap > 0 ? dailyCap : 1;

      const futureDeptBucket = futureBucket.get(dept.code);
      const pastDeptBucket = pastBucket.get(dept.code);

      const futureLoad = futureDays.map((date) => {
        const loadedMinutes = futureDeptBucket?.get(date) ?? 0;
        const utilization = dailyCap > 0 ? Math.round((loadedMinutes / denom) * 100) : 0;
        let level = "low";
        if (utilization > 100) level = "critical";
        else if (utilization > 90) level = "high";
        else if (utilization > 70) level = "medium";
        return { date, loadedMinutes, capacityMinutes: dailyCap, utilization, level };
      });
      const pastProduction = pastDays.map((date) => {
        const producedMinutes = pastDeptBucket?.get(date) ?? 0;
        const utilization = dailyCap > 0 ? Math.round((producedMinutes / denom) * 100) : 0;
        // Past uses the same banding but the "level" semantics are
        // different — high = "good day, exceeded avg"; low = "slow
        // day". Color choice flipped in the render below.
        let level = "low";
        if (utilization > 100) level = "critical";
        else if (utilization > 90) level = "high";
        else if (utilization > 70) level = "medium";
        return { date, producedMinutes, capacityMinutes: dailyCap, utilization, level };
      });

      // Wei Siang 2026-05-16: surface the actual-hours averages so the
      // operator reads Production Time, not just %. Past avg = mean
      // produced minutes across the past window; Plan avg = mean
      // dueDate-loaded minutes across the future window.
      const pastAvgMinutes = pastProduction.length
        ? Math.round(pastProduction.reduce((s, d) => s + d.producedMinutes, 0) / pastProduction.length)
        : 0;
      const pastAvgPct = pastProduction.length
        ? Math.round(pastProduction.reduce((s, d) => s + d.utilization, 0) / pastProduction.length)
        : 0;
      const futureAvgMinutes = futureLoad.length
        ? Math.round(futureLoad.reduce((s, d) => s + d.loadedMinutes, 0) / futureLoad.length)
        : 0;
      const futureAvgPct = futureLoad.length
        ? Math.round(futureLoad.reduce((s, d) => s + d.utilization, 0) / futureLoad.length)
        : 0;

      return {
        deptCode: dept.code,
        deptName: dept.name,
        color: dept.color,
        workerCount: capDept?.workerCount ?? 0,
        dailyCapacityMinutes: dailyCap,
        pastProduction,
        futureLoad,
        pastAvgMinutes,
        pastAvgPct,
        futureAvgMinutes,
        futureAvgPct,
      };
    });
  }, [orders, capacityData, productionDepartments, loadingCategoryFilter, publicHolidaySet]);

  // ── Master Tracker computed values ──
  const deptEfficiency = useMemo(
    () => getDeptEfficiency(orders, effDateFrom, effDateTo, workingHoursByDeptCategory),
    [orders, effDateFrom, effDateTo, workingHoursByDeptCategory],
  );

  // Wei Siang 2026-05-15: combined view — one row per dept, sums of
  // both categories' Active / Completed / Production / Working, with
  // Efficiency % + Status recomputed from the combined totals (NOT
  // averaged — efficiency is a ratio, must come from the summed
  // numerator ÷ summed denominator to stay accurate).
  const deptEfficiencyCombined = useMemo(() => {
    const byCode = new Map<string, {
      code: string;
      name: string;
      color: string;
      active: number;
      completed: number;
      totalProductionMinutes: number;
      totalWorkingMinutes: number;
    }>();
    for (const row of deptEfficiency) {
      const existing = byCode.get(row.code);
      if (existing) {
        existing.active += row.active;
        existing.completed += row.completed;
        existing.totalProductionMinutes += row.totalProductionMinutes;
        existing.totalWorkingMinutes += row.totalWorkingMinutes;
      } else {
        byCode.set(row.code, {
          code: row.code,
          name: row.name,
          color: row.color,
          active: row.active,
          completed: row.completed,
          totalProductionMinutes: row.totalProductionMinutes,
          totalWorkingMinutes: row.totalWorkingMinutes,
        });
      }
    }
    return TRACKER_DEPARTMENTS.map((dept) => {
      const cell = byCode.get(dept.code) ?? {
        code: dept.code,
        name: dept.name,
        color: dept.color,
        active: 0,
        completed: 0,
        totalProductionMinutes: 0,
        totalWorkingMinutes: 0,
      };
      const efficiency =
        cell.totalWorkingMinutes > 0
          ? Math.round((cell.totalProductionMinutes / cell.totalWorkingMinutes) * 100)
          : 0;
      let statusLabel: string;
      let statusColor: string;
      if (cell.totalWorkingMinutes === 0 || cell.totalProductionMinutes === 0) {
        statusLabel = "No Data";
        statusColor = "text-gray-500 bg-gray-50";
      } else if (efficiency >= 95) { statusLabel = "Excellent"; statusColor = "text-[#4F7C3A] bg-[#EEF3E4]"; }
      else if (efficiency >= 80) { statusLabel = "Good"; statusColor = "text-[#3E6570] bg-[#E0EDF0]"; }
      else if (efficiency >= 60) { statusLabel = "Fair"; statusColor = "text-[#9C6F1E] bg-[#FAEFCB]"; }
      else { statusLabel = "Needs Improvement"; statusColor = "text-[#9A3A2D] bg-[#F9E1DA]"; }
      return { ...cell, efficiency, statusLabel, statusColor };
    });
  }, [deptEfficiency]);

  const filteredTrackerOrders = useMemo(() => {
    let result = [...orders];

    if (trackerCategoryTab !== "ALL") {
      result = result.filter((o) => o.itemCategory === trackerCategoryTab);
    }
    if (trackerSearch.trim()) {
      const q = trackerSearch.toLowerCase();
      result = result.filter(
        (o) =>
          o.poNo.toLowerCase().includes(q) ||
          o.salesOrderNo.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.productCode.toLowerCase().includes(q) ||
          o.customerPOId.toLowerCase().includes(q)
      );
    }
    if (trackerStatusFilter !== "ALL") {
      result = result.filter((o) => o.status === trackerStatusFilter);
    }
    if (trackerDateFrom) {
      result = result.filter((o) => o.targetEndDate >= trackerDateFrom);
    }
    if (trackerDateTo) {
      result = result.filter((o) => o.targetEndDate <= trackerDateTo);
    }

    result.sort((a, b) => {
      let cmp = 0;
      switch (trackerSortField) {
        case "poNo":         cmp = a.poNo.localeCompare(b.poNo); break;
        case "customerName": cmp = a.customerName.localeCompare(b.customerName); break;
        case "productCode":  cmp = a.productCode.localeCompare(b.productCode); break;
        case "targetEndDate":cmp = a.targetEndDate.localeCompare(b.targetEndDate); break;
        case "progress":     cmp = a.progress - b.progress; break;
        case "status":       cmp = a.status.localeCompare(b.status); break;
      }
      return trackerSortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [orders, trackerCategoryTab, trackerSearch, trackerStatusFilter, trackerDateFrom, trackerDateTo, trackerSortField, trackerSortDir]);

  const toggleTrackerSort = (field: TrackerSortField) => {
    if (trackerSortField === field) {
      setTrackerSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setTrackerSortField(field);
      setTrackerSortDir("asc");
    }
  };

  // The currently-selected tracker orders (intersect the id set with the live
  // list so a row that was filtered out / removed can't linger in the
  // selection).
  const selectedTrackerOrders = useMemo(
    () => orders.filter((o) => selectedTrackerIds.has(o.id)),
    [orders, selectedTrackerIds],
  );

  const allTrackerFilteredSelected =
    filteredTrackerOrders.length > 0 &&
    filteredTrackerOrders.every((o) => selectedTrackerIds.has(o.id));

  const toggleTrackerRow = (id: string) => {
    setSelectedTrackerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTrackerSelectAll = () => {
    setSelectedTrackerIds((prev) => {
      if (filteredTrackerOrders.every((o) => prev.has(o.id))) {
        // All visible already selected → clear just the visible ones.
        const next = new Set(prev);
        for (const o of filteredTrackerOrders) next.delete(o.id);
        return next;
      }
      const next = new Set(prev);
      for (const o of filteredTrackerOrders) next.add(o.id);
      return next;
    });
  };

  // Batch Due Date apply — reuses the EXACT endpoint + patch shape the
  // production page + folder detail page use:
  // POST /api/production-orders/bulk-patch { patches: [{ poId, jobCardId, dueDate }] }.
  // Builds one patch per (selected order × matching department job card),
  // scoped to trackerBatchDept ("ALL" → every dept job card on the order).
  // dueDate only — status is intentionally untouched (schedule vs progress).
  const applyTrackerBatchDueDate = async (date: string) => {
    setTrackerBatchDueDateOpen(false);
    const patches: Array<{ poId: string; jobCardId: string; dueDate: string }> = [];
    for (const order of selectedTrackerOrders) {
      for (const jc of order.jobCards) {
        if (trackerBatchDept !== "ALL" && jc.departmentCode !== trackerBatchDept) continue;
        patches.push({ poId: order.id, jobCardId: jc.id, dueDate: date });
      }
    }
    if (patches.length === 0) {
      toast.error(
        trackerBatchDept === "ALL"
          ? "Selected orders have no job cards to update."
          : `No ${TRACKER_DEPARTMENTS.find((d) => d.code === trackerBatchDept)?.name ?? trackerBatchDept} job cards on the selected orders.`,
      );
      return;
    }
    try {
      const res = await fetch("/api/production-orders/bulk-patch", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ patches }),
        credentials: "include",
      });
      const j = (await res.json()) as { results?: Array<{ success: boolean; error?: string }>; error?: string; missingPermission?: string };
      if (!res.ok) {
        toast.error(
          j.missingPermission
            ? "Save failed — you don't have permission to make this change. Nothing was saved."
            : `Save failed — ${j.error ?? `error ${res.status}`}. Nothing was saved.`,
        );
        return;
      }
      const failed = (j.results || []).filter((x) => !x.success);
      if (failed.length > 0) {
        toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
      } else {
        const scope = trackerBatchDept === "ALL"
          ? "all departments"
          : (TRACKER_DEPARTMENTS.find((d) => d.code === trackerBatchDept)?.name ?? trackerBatchDept);
        const verb = date ? "Set due date" : "Cleared due date";
        toast.success(`${verb} (${scope}) on ${selectedTrackerOrders.length} order${selectedTrackerOrders.length === 1 ? "" : "s"}.`);
      }
      // Drop the cached matrix + force this page's hook to refetch so the new
      // dates show. Same invalidate prefix the production page uses.
      invalidateCachePrefix("/api/production-orders");
      refreshOrders();
      setSelectedTrackerIds(new Set());
    } catch (err) {
      toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ── Drilldown data builders (memoized so reopening a level on the
  // same render doesn't recompute). All read from `orders` already in
  // memory — no extra API hits. ──

  // N most-recent COMPLETE working days (Mon-Sat, skip Sundays),
  // ending YESTERDAY — today is excluded because completions aren't
  // recorded same-day (would read ~0 and deflate the average). Window
  // size driven by ROLLING_WINDOW_DAYS so this matches capacityData's
  // rolling-window set exactly.
  const rollingWindowDates = useMemo(
    () => recentWorkingDays(ROLLING_WINDOW_DAYS, publicHolidaySet),
    [publicHolidaySet],
  );

  // Per-day total completed minutes (sum across all production depts,
  // both categories). Matches the same formula capacityData uses for
  // the rolling daily-avg.
  // Wei Siang 2026-05-15: × wipQty so multi-piece JCs aren't
  // under-counted (jc.estMinutes / actualMinutes are per-UNIT).
  const capacityByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of rollingWindowDates) m.set(d, 0);
    for (const order of orders) {
      for (const jc of order.jobCards) {
        if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
        if (!jc.completedDate) continue;
        if (!m.has(jc.completedDate)) continue;
        const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
        m.set(jc.completedDate, (m.get(jc.completedDate) ?? 0) + mins);
      }
    }
    return m;
  }, [orders, rollingWindowDates]);

  // For a specific date, return per-dept total completed minutes.
  const capacityForDate = useCallback(
    (date: string) => {
      const byDept = new Map<string, { sofa: number; bf: number; other: number; total: number }>();
      for (const order of orders) {
        for (const jc of order.jobCards) {
          if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
          if (jc.completedDate !== date) continue;
          const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
          const existing = byDept.get(jc.departmentCode) ?? { sofa: 0, bf: 0, other: 0, total: 0 };
          if (order.itemCategory === "SOFA") existing.sofa += mins;
          else if (order.itemCategory === "BEDFRAME") existing.bf += mins;
          else existing.other += mins;
          existing.total += mins;
          byDept.set(jc.departmentCode, existing);
        }
      }
      return byDept;
    },
    [orders],
  );

  // For "{Scope}'s Load" → JCs with dueDate inside scopeRange and
  // active (not completed/cancelled/transferred). Returns per-dept
  // SOFA/BF/total split — mirrors capacityData's sofaScopeLoad / bfScopeLoad
  // but exposes the raw counts side-by-side.
  // Wei Siang 2026-05-15: Load filter is "dueDate <= scopeTo, still
  // active" — includes overdue JCs so the Load card reflects total
  // pressure on the dept, not just the strict scope bucket.
  const loadByDept = useMemo(() => {
    const byDept = new Map<string, { sofa: number; bf: number; total: number }>();
    for (const order of orders) {
      if (order.status !== "IN_PROGRESS" && order.status !== "PENDING") continue;
      for (const jc of order.jobCards) {
        if (jc.status === "COMPLETED" || jc.status === "CANCELLED" || jc.status === "TRANSFERRED") continue;
        if (!jc.dueDate) continue;
        if (jc.dueDate > scopeRange.to) continue;
        const existing = byDept.get(jc.departmentCode) ?? { sofa: 0, bf: 0, total: 0 };
        const mins = jcMinutesTotal(jc.estMinutes ?? 0, jc);
        if (order.itemCategory === "SOFA") existing.sofa += mins;
        else if (order.itemCategory === "BEDFRAME") existing.bf += mins;
        existing.total += mins;
        byDept.set(jc.departmentCode, existing);
      }
    }
    return byDept;
  }, [orders, scopeRange]);

  // For a specific dept → list of JCs in the scope range, with assignee
  // + product info.
  const loadJCsForDept = useCallback(
    (deptCode: string) => {
      const rows: {
        jcId: string;
        dueDate: string;
        pic1Name: string;
        pic2Name: string;
        productCode: string;
        productName: string;
        wipLabel: string | null;
        poNo: string;
        category: string;
        customerName: string;
        minutes: number;
        status: string;
      }[] = [];
      for (const order of orders) {
        if (order.status !== "IN_PROGRESS" && order.status !== "PENDING") continue;
        for (const jc of order.jobCards) {
          if (jc.departmentCode !== deptCode) continue;
          if (jc.status === "COMPLETED" || jc.status === "CANCELLED" || jc.status === "TRANSFERRED") continue;
          if (!jc.dueDate) continue;
          if (jc.dueDate > scopeRange.to) continue;
          rows.push({
            jcId: jc.id,
            dueDate: jc.dueDate,
            pic1Name: jc.pic1Name || "",
            pic2Name: jc.pic2Name || "",
            productCode: order.productCode,
            productName: order.productName,
            wipLabel: jc.wipLabel ?? null,
            poNo: order.poNo,
            category: order.itemCategory,
            customerName: order.customerName,
            minutes: jcMinutesTotal(jc.estMinutes ?? 0, jc),
            status: jc.status,
          });
        }
      }
      rows.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : b.minutes - a.minutes));
      return rows;
    },
    [orders, scopeRange],
  );

  const deptNameByCode = useMemo(() => {
    const m = new Map<string, { name: string; color: string }>();
    for (const d of productionDepartments) {
      m.set(d.code, { name: d.name, color: d.color });
    }
    return m;
  }, [productionDepartments]);

  // Wei Siang 2026-05-15: per-worker aggregation slots in between dept
  // and per-JC, so the operator sees "who contributed what" before
  // drilling into the specific JCs. A JC with 2 PICs (pic1 + pic2)
  // splits its minutes evenly between them — keeps the per-worker sum
  // exactly equal to the dept total without double-counting.

  // For a (date × dept), return per-worker aggregation. workerKey
  // encodes pic1Id or pic2Id (treated symmetrically). Unassigned JCs
  // collapse under a single "(unassigned)" pseudo-worker so they're
  // not dropped from view.
  const capacityWorkersForDateDept = useCallback(
    (date: string, deptCode: string) => {
      const byWorker = new Map<string, { workerId: string; workerName: string; totalMinutes: number; jcCount: number }>();
      const credit = (id: string, name: string, mins: number) => {
        const key = id || "__unassigned__";
        const display = id ? name : "(unassigned)";
        const cell = byWorker.get(key) ?? { workerId: key, workerName: display, totalMinutes: 0, jcCount: 0 };
        cell.totalMinutes += mins;
        cell.jcCount += 1;
        byWorker.set(key, cell);
      };
      for (const order of orders) {
        for (const jc of order.jobCards) {
          if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
          if (jc.completedDate !== date) continue;
          if (jc.departmentCode !== deptCode) continue;
          const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
          const picCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
          if (picCount === 0) {
            credit("", "", mins);
          } else {
            const share = mins / picCount;
            if (jc.pic1Id) credit(jc.pic1Id, jc.pic1Name || "", share);
            if (jc.pic2Id) credit(jc.pic2Id, jc.pic2Name || "", share);
          }
        }
      }
      return Array.from(byWorker.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
    },
    [orders],
  );

  // For a (date × dept × worker) → list of that worker's specific JCs.
  // Reuses the same per-JC shape as capacityJCsForDateDept; the worker
  // filter is a string id match against pic1Id / pic2Id.
  const capacityJCsForDateDeptWorker = useCallback(
    (date: string, deptCode: string, workerId: string) => {
      const rows: {
        jcId: string;
        pic1Name: string;
        pic2Name: string;
        productCode: string;
        productName: string;
        wipLabel: string | null;
        wipQty: number;
        poNo: string;
        category: string;
        customerName: string;
        minutes: number;
      }[] = [];
      const isUnassigned = workerId === "__unassigned__";
      for (const order of orders) {
        for (const jc of order.jobCards) {
          if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
          if (jc.completedDate !== date) continue;
          if (jc.departmentCode !== deptCode) continue;
          const matches = isUnassigned
            ? !jc.pic1Id && !jc.pic2Id
            : jc.pic1Id === workerId || jc.pic2Id === workerId;
          if (!matches) continue;
          const wipQty = Math.max(1, jc.wipQty ?? 1);
          rows.push({
            jcId: jc.id,
            pic1Name: jc.pic1Name || "",
            pic2Name: jc.pic2Name || "",
            productCode: order.productCode,
            productName: order.productName,
            wipLabel: jc.wipLabel ?? null,
            wipQty,
            poNo: order.poNo,
            category: order.itemCategory,
            customerName: order.customerName,
            minutes: jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc),
          });
        }
      }
      rows.sort((a, b) => b.minutes - a.minutes);
      return rows;
    },
    [orders],
  );

  // Same per-worker aggregation for the Load drilldown — looks at
  // ACTIVE JCs (dueDate in scopeRange, status not done) instead of
  // completed ones, and uses estMinutes as the work-content number.
  const loadWorkersForDept = useCallback(
    (deptCode: string) => {
      const byWorker = new Map<string, { workerId: string; workerName: string; totalMinutes: number; jcCount: number }>();
      const credit = (id: string, name: string, mins: number) => {
        const key = id || "__unassigned__";
        const display = id ? name : "(unassigned)";
        const cell = byWorker.get(key) ?? { workerId: key, workerName: display, totalMinutes: 0, jcCount: 0 };
        cell.totalMinutes += mins;
        cell.jcCount += 1;
        byWorker.set(key, cell);
      };
      for (const order of orders) {
        if (order.status !== "IN_PROGRESS" && order.status !== "PENDING") continue;
        for (const jc of order.jobCards) {
          if (jc.departmentCode !== deptCode) continue;
          if (jc.status === "COMPLETED" || jc.status === "CANCELLED" || jc.status === "TRANSFERRED") continue;
          if (!jc.dueDate) continue;
          if (jc.dueDate > scopeRange.to) continue;
          const mins = jcMinutesTotal(jc.estMinutes ?? 0, jc);
          const picCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
          if (picCount === 0) {
            credit("", "", mins);
          } else {
            const share = mins / picCount;
            if (jc.pic1Id) credit(jc.pic1Id, jc.pic1Name || "", share);
            if (jc.pic2Id) credit(jc.pic2Id, jc.pic2Name || "", share);
          }
        }
      }
      return Array.from(byWorker.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
    },
    [orders, scopeRange],
  );

  const loadJCsForDeptWorker = useCallback(
    (deptCode: string, workerId: string) => {
      const isUnassigned = workerId === "__unassigned__";
      return loadJCsForDept(deptCode).filter((r) => {
        // r.pic1Name / pic2Name are display strings, not ids — we need
        // to re-check against pic1Id / pic2Id via the source orders.
        // Cheaper: duplicate the filter against orders directly.
        return isUnassigned ? r.pic1Name === "" && r.pic2Name === "" : true;
      }).filter((r) => {
        if (isUnassigned) return true;
        // Find the source JC to compare ids.
        for (const order of orders) {
          for (const jc of order.jobCards) {
            if (jc.id === r.jcId) {
              return jc.pic1Id === workerId || jc.pic2Id === workerId;
            }
          }
        }
        return false;
      });
    },
    [orders, loadJCsForDept],
  );

  // Wei Siang 2026-05-15: scope-aware completion — total production
  // minutes for JCs whose completedDate falls inside the current
  // scopeRange. Compared against {Scope}'s Load to show progress.
  // For Daily scope this is "today's actual production"; Weekly is
  // "this week's so-far"; Monthly is "this month's so-far".
  const scopeCompletedMinutes = useMemo(() => {
    let total = 0;
    for (const order of orders) {
      for (const jc of order.jobCards) {
        if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
        if (!jc.completedDate) continue;
        if (jc.completedDate < scopeRange.from || jc.completedDate > scopeRange.to) continue;
        total += jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
      }
    }
    return total;
  }, [orders, scopeRange]);
  // Progress % = how much of the scope's scheduled load is already done.
  // Capped at 999 so an overshoot scope (workers ate into the next
  // bucket early) doesn't blow the bar layout.
  const scopeProgressPct = totalScopeLoad > 0
    ? Math.min(999, Math.round((scopeCompletedMinutes / totalScopeLoad) * 100))
    : 0;

  // Wei Siang 2026-05-15: Total Backlog drilldown — per-dept backlog
  // days table. Reads capacityData (already memoised) which has each
  // dept's totalBacklog (minutes), totalBacklogDays, sofa/bf splits.
  const backlogByDept = useMemo(() => {
    return capacityData
      .map((d) => ({
        deptCode: d.code,
        deptName: d.name,
        color: d.color,
        sofaBacklog: d.sofaBacklog,
        bfBacklog: d.bfBacklog,
        totalBacklog: d.totalBacklog,
        totalBacklogDays: d.totalBacklogDays,
        dailyCapacity: d.dailyCapacity,
      }))
      .sort((a, b) => b.totalBacklogDays - a.totalBacklogDays);
  }, [capacityData]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
        <span className="ml-3 text-[#6B7280]">Loading production planning data...</span>
      </div>
    );
  }

  // Current drilldown level (top of stack); null = no modal open.
  const topDrilldown = drilldownStack[drilldownStack.length - 1] ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Production Planning</h1>
          <p className="text-xs text-[#6B7280]">
            Capacity management, scheduling & backward planning
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* A4-printable reports — open in new tab so the operator can hit
              Cmd-P / Print to save PDF or send to paper. The cron sends the
              same HTML at 8am SGT (schedule) and on-demand (overdue). */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.open("/api/reports/schedule", "_blank", "noopener");
            }}
            title="Open today's production schedule (A4 printable)"
          >
            <Calendar className="h-4 w-4 mr-1" />
            Today's Schedule
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.open("/api/reports/overdue", "_blank", "noopener");
            }}
            title="Open overdue report (A4 printable)"
          >
            <AlertTriangle className="h-4 w-4 mr-1" />
            Overdue Report
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8] overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                isActive
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ═══════════════════════════════════════════ */}
      {/* TAB 1: CAPACITY OVERVIEW                   */}
      {/* ═══════════════════════════════════════════ */}
      {activeTab === "capacity" && (
        <div className="space-y-6">
          {/* Scope toggle — Daily / Weekly / Monthly. Drives every
              card on the page. Daily = today only; Weekly = current
              Mon-Sat; Monthly = current calendar month. Capacity
              denominator scales proportionally (×1 / ×6 / ×N working
              days). */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="inline-flex rounded-md border border-[#E2DDD8] bg-white p-0.5">
              {(["daily", "weekly", "monthly"] as const).map((scope) => {
                const isActive = capacityScope === scope;
                return (
                  <button
                    key={scope}
                    onClick={() => setCapacityScope(scope)}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                      isActive
                        ? "bg-[#6B5C32] text-white"
                        : "text-[#6B7280] hover:bg-[#F0ECE9]"
                    }`}
                  >
                    {scope === "daily" ? "Daily" : scope === "weekly" ? "Weekly" : "Monthly"}
                  </button>
                );
              })}
            </div>
            <span className="text-xs text-[#9CA3AF]">
              {scopeRange.label} · {scopeRange.from}
              {scopeRange.from !== scopeRange.to ? ` → ${scopeRange.to}` : ""}
              {" · "}
              {scopeRange.workingDays} working day{scopeRange.workingDays === 1 ? "" : "s"}
            </span>
          </div>

          {/* Top summary — 5 cards. Daily Capacity is rolling
              N-day avg of actual completed minutes (per Wei Siang
              spec, N = ROLLING_WINDOW_DAYS). Load / Utilization /
              Backlog scoped to the selected Daily/Weekly/Monthly
              window. */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
            {/* Wei Siang 2026-05-15: Daily Capacity is the entry
                point to the drilldown — click it to open the 14-day
                breakdown modal. Click → day modal → per-dept → per-JC. */}
            <Card
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => pushDrilldown({ kind: "capacity-14d" })}
            >
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>Daily Capacity</span>
                  <Factory className="h-4 w-4 text-[#6B5C32]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                  {formatHours(totalCapacity)} <span className="text-xs font-medium text-[#6B7280]">/day</span>
                </p>
                <p className="text-[10px] text-[#9CA3AF] mt-0.5">{ROLLING_WINDOW_DAYS}-day rolling actual avg · click for breakdown</p>
              </CardContent>
            </Card>
            {/* Wei Siang 2026-05-15: {Scope}'s Load → per-dept drilldown
                → per-JC list. Honours the active Daily/Weekly/Monthly
                scope toggle. Now includes a "Done" progress bar
                showing how much of today's plan has actually been
                completed (real-time relative to the orders payload). */}
            <Card
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => pushDrilldown({ kind: "load-by-dept" })}
            >
              <CardContent
                className="p-3"
                title="Work QUEUED for this scope — every active job due in (or before) the window, overdue included. This is demand, not capacity: compare it against the Daily Capacity card on the left."
              >
                {/* Relabeled (owner audit 2026-07-11): this figure is the
                    queued LOAD (demand incl. overdue), not capacity — the old
                    "…'s Capacity" title sat next to the real capacity card
                    and read as a contradiction. */}
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>{scopeRange.label}&apos;s Queued Work</span>
                  <TrendingUp className="h-4 w-4 text-[#3E6570]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                  {formatHours(totalScopeLoad)}
                </p>
                <div className="text-[10px] text-[#9CA3AF] mt-0.5 flex gap-3">
                  <span><span className="font-semibold text-[#9A3A2D]">SOFA</span> {formatHours(totalSofaScopeLoad)}</span>
                  <span><span className="font-semibold text-[#3E6570]">BF</span> {formatHours(totalBfScopeLoad)}</span>
                </div>
              </CardContent>
            </Card>
            {/* Wei Siang 2026-05-15: NEW — {Scope}'s Completed. Real
                production output for the active scope. Click reuses
                the capacity-day drilldown (for Daily) so operator can
                see per-dept → per-worker → per-JC names contributing
                to today's progress. For Weekly/Monthly we drop to the
                14-day list since there's no single-day modal to land
                on. */}
            <Card
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() =>
                capacityScope === "daily"
                  ? pushDrilldown({ kind: "capacity-day", date: today })
                  : pushDrilldown({ kind: "capacity-14d" })
              }
            >
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>{scopeRange.label}&apos;s Completed</span>
                  <CheckCircle2 className="h-4 w-4 text-[#4F7C3A]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                  {formatHours(scopeCompletedMinutes)}
                </p>
                {/* Progress bar: completed / load. Bar fills the card
                    width up to 100% and turns red on overshoot
                    (>100%). Helps the operator see at a glance "are
                    we ahead, on track, or behind?". */}
                <div className="mt-1">
                  <div className="h-1.5 rounded-full bg-[#F0ECE9] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        scopeProgressPct >= 100
                          ? "bg-[#4F7C3A]"
                          : scopeProgressPct >= 70
                            ? "bg-[#9C6F1E]"
                            : "bg-[#9A3A2D]"
                      }`}
                      style={{ width: `${Math.min(100, scopeProgressPct)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-[#9CA3AF] mt-0.5">
                    {scopeProgressPct}% of {scopeRange.label.toLowerCase()}&apos;s capacity · click for names
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent
                className="p-3"
                title="Backlog pressure = queued work (incl. overdue) ÷ one scope of rolling capacity. Over 100% simply means more than one scope's worth of work is queued — it is NOT a worker-utilization figure. SOFA/BF share the same factory-wide denominator (they partition the total)."
              >
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>{scopeRange.label}&apos;s Backlog Pressure</span>
                  <Clock className="h-4 w-4 text-[#6B5C32]" />
                </p>
                <p className={`text-xl font-bold ${utilizationColor(totalScopeUtilization).text}`}>
                  {totalScopeUtilization}%
                </p>
                <div className="text-[10px] text-[#9CA3AF] mt-0.5 flex gap-3">
                  <span><span className="font-semibold text-[#9A3A2D]">SOFA</span> {sofaScopeUtilization}%</span>
                  <span><span className="font-semibold text-[#3E6570]">BF</span> {bfScopeUtilization}%</span>
                </div>
              </CardContent>
            </Card>
            {/* Wei Siang 2026-05-15: Total Backlog click → per-dept
                breakdown showing each dept's backlog days. */}
            <Card
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => pushDrilldown({ kind: "backlog-by-dept" })}
            >
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>Total Backlog</span>
                  <ClipboardList className="h-4 w-4 text-[#9C6F1E]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {totalBacklogDays} <span className="text-xs font-medium text-[#6B7280]">days</span>
                </p>
                <div className="text-[10px] text-[#9CA3AF] mt-0.5 flex gap-3">
                  {/* Wei Siang 2026-05-15: per-category breakdown shows
                      hours (raw quantity), not days. Days would imply
                      each side runs full-cap alone, which double-counts
                      against the wall-clock days on the line above. */}
                  <span><span className="font-semibold text-[#9A3A2D]">SOFA</span> {formatHours(totalSofaBacklog)}</span>
                  <span><span className="font-semibold text-[#3E6570]">BF</span> {formatHours(totalBfBacklog)}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Department capacity cards — each card stacks SOFA + BF
              rows so the operator sees per-category load & backlog
              at a glance. */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {capacityData.map((dept) => {
              // Backlog-days colour: ≤7 healthy, ≤14 watch, >14 backed
              // up. Matches the bar fill + the Total Backlog drilldown.
              const backlogColor =
                dept.totalBacklogDays > 14 ? "text-[#9A3A2D]" : dept.totalBacklogDays > 7 ? "text-[#9C6F1E]" : "text-[#4F7C3A]";
              return (
                <Card key={dept.code} className="overflow-hidden">
                  <div className="h-1.5" style={{ backgroundColor: dept.color }} />
                  <CardHeader className="pb-2 pt-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block"
                        style={{ backgroundColor: dept.color }}
                      />
                      {/* Departments with a built schedule page open a
                          drill-in (Fab Cut / Fab Sew / Wood Cut / Framing);
                          the rest stay plain text. Route lookup keeps all
                          four affordances identical. */}
                      {DEPT_DRILL_ROUTE[dept.code] ? (
                        <button
                          type="button"
                          onClick={() => navigate(DEPT_DRILL_ROUTE[dept.code])}
                          className="inline-flex items-center gap-1 font-semibold text-[#6B5C32] hover:text-[#574B28] hover:underline underline-offset-2 transition-colors"
                          title={`Open the ${dept.name} department schedule`}
                        >
                          {dept.name}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        dept.name
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 pb-3 text-xs">
                    {/* Shared header row: workers + daily capacity */}
                    <div className="grid grid-cols-3 gap-2 pb-2 border-b border-[#E2DDD8]">
                      <div>
                        <span className="text-[10px] text-[#6B7280]">Workers</span>
                        <p className="font-semibold text-[#1F1D1B] flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {dept.workerCount}
                        </p>
                      </div>
                      <div>
                        <span className="text-[10px] text-[#6B7280]">Hours/day</span>
                        <p className="font-semibold text-[#1F1D1B]">{dept.avgWorkingHours}h</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-[#6B7280]">Daily Cap</span>
                        <p className="font-semibold text-[#1F1D1B] tabular-nums" title={`${ROLLING_WINDOW_DAYS}-day rolling actual avg`}>
                          {formatHours(dept.dailyCapacity)}
                        </p>
                      </div>
                    </div>

                    {/* SOFA row */}
                    <div className="grid grid-cols-3 gap-2 items-baseline">
                      <span className="text-[10px] font-semibold text-[#9A3A2D]">SOFA</span>
                      <div>
                        <span className="text-[9px] text-[#6B7280]" title="Queued work for this category · backlog pressure vs the dept's one-day rolling capacity (whole-dept denominator — >100% = more than a day queued, not overwork)">Queued · Pressure %</span>
                        <p className="font-medium text-[#1F1D1B] tabular-nums">
                          {formatHours(dept.sofaScopeLoad)}
                          <span className={`ml-1.5 ${utilizationColor(dept.sofaScopeUtilization).text}`}>
                            ({dept.sofaScopeUtilization}%)
                          </span>
                        </p>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#6B7280]">Backlog</span>
                        <p className="font-medium text-[#1F1D1B] tabular-nums">{formatHours(dept.sofaBacklog)}</p>
                      </div>
                    </div>

                    {/* BEDFRAME row */}
                    <div className="grid grid-cols-3 gap-2 items-baseline">
                      <span className="text-[10px] font-semibold text-[#3E6570]">BEDFRAME</span>
                      <div>
                        <span className="text-[9px] text-[#6B7280]" title="Queued work for this category · backlog pressure vs the dept's one-day rolling capacity (whole-dept denominator — >100% = more than a day queued, not overwork)">Queued · Pressure %</span>
                        <p className="font-medium text-[#1F1D1B] tabular-nums">
                          {formatHours(dept.bfScopeLoad)}
                          <span className={`ml-1.5 ${utilizationColor(dept.bfScopeUtilization).text}`}>
                            ({dept.bfScopeUtilization}%)
                          </span>
                        </p>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#6B7280]">Backlog</span>
                        <p className="font-medium text-[#1F1D1B] tabular-nums">{formatHours(dept.bfBacklog)}</p>
                      </div>
                    </div>

                    {/* Wei Siang 2026-05-16: was "Total Util / Backlog"
                        with a util% bar — but util% is now always
                        hundreds-of-% (lenient Load includes all
                        overdue), so the bar was permanently maxed and
                        useless. Replaced with a Backlog-Days bar on a
                        fixed 0–21 day scale: short = healthy queue,
                        long = backed up. Colour matches the ≤7 / ≤14 /
                        >14 day thresholds used in the Total Backlog
                        drilldown. */}
                    <div className="pt-2 border-t border-[#E2DDD8]">
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-[10px] text-[#6B7280]">Backlog (days of work queued)</span>
                        <span className={`text-[10px] font-semibold ${backlogColor}`}>
                          {dept.totalBacklogDays}d
                        </span>
                      </div>
                      <div className="w-full bg-[#F0ECE9] rounded-full h-2 overflow-hidden relative">
                        <div
                          className={`h-full rounded-full transition-all ${
                            dept.totalBacklogDays > 14
                              ? "bg-[#9A3A2D]"
                              : dept.totalBacklogDays > 7
                                ? "bg-[#9C6F1E]"
                                : "bg-[#4F7C3A]"
                          }`}
                          style={{ width: `${Math.min((dept.totalBacklogDays / 21) * 100, 100)}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[8px] text-[#9CA3AF] mt-0.5">
                        <span>0d</span>
                        <span>7d</span>
                        <span>14d</span>
                        <span>21d+</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-6 text-xs text-[#6B7280]">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#4F7C3A]" />
              <span>&lt; 70% utilization</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#9C6F1E]" />
              <span>70-90% utilization</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#9A3A2D]" />
              <span>&gt; 90% utilization</span>
            </div>
          </div>

          {/* Department Efficiency Overview */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
                  All Departments Efficiency Overview
                </CardTitle>
                {/* Wei Siang 2026-05-15 Phase 2: completion-date filter. */}
                <div className="flex items-center gap-2 text-xs text-[#6B7280]">
                  <span>Completed between</span>
                  <input
                    type="date"
                    value={effDateFrom}
                    onChange={(e) => setEffDateFrom(e.target.value)}
                    className="h-7 rounded border border-[#E2DDD8] bg-white px-2 text-xs text-[#1F1D1B] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                  />
                  <span>and</span>
                  <input
                    type="date"
                    value={effDateTo}
                    onChange={(e) => setEffDateTo(e.target.value)}
                    className="h-7 rounded border border-[#E2DDD8] bg-white px-2 text-xs text-[#1F1D1B] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const d = new Date();
                      setEffDateTo(fmtISO(d));
                      d.setDate(d.getDate() - 30);
                      setEffDateFrom(fmtISO(d));
                    }}
                    className="ml-1 h-7 rounded border border-[#E2DDD8] bg-[#F0ECE9] px-2 text-xs text-[#6B5C32] hover:bg-[#E8E3DE]"
                    title="Reset to past 30 days"
                  >
                    Past 30d
                  </button>
                  {/* Wei Siang 2026-05-15: SOFA / BEDFRAME split toggle.
                      Click → combine rows (1 per dept); click again →
                      split back (2 per dept). Combined re-runs the
                      ratio on summed totals — correct, not just an
                      average of the two efficiency %s. */}
                  <button
                    type="button"
                    onClick={() => setEffShowCombined((v) => !v)}
                    className={`ml-1 h-7 rounded border px-2 text-xs ${
                      effShowCombined
                        ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                        : "border-[#E2DDD8] bg-[#F0ECE9] text-[#6B5C32] hover:bg-[#E8E3DE]"
                    }`}
                    title={effShowCombined ? "Show SOFA + BEDFRAME separately" : "Combine SOFA + BEDFRAME into one row per dept"}
                  >
                    {effShowCombined ? "Combined" : "Combine SOFA + BF"}
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-9 px-3 text-left font-medium text-[#374151]">Department</th>
                      {!effShowCombined && <th className="h-9 px-3 text-left font-medium text-[#374151]">Category</th>}
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Active</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Completed</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]" title="Spec time of completed JCs in the date range — sum of (actualMinutes ?? estMinutes) × wipQty.">Production Time</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]" title="Hours entered in the Working Hours grid (Employees page) for this dept × category × date range.">Working Hrs</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]" title="Production Time ÷ Working Hrs × 100. 100% = produced as much spec time as workers were clocked in for.">Efficiency %</th>
                      <th className="h-9 px-3 text-left font-medium text-[#374151]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {effShowCombined
                      ? deptEfficiencyCombined.map((row) => (
                          <tr
                            key={row.code}
                            className="hover:bg-[#FAF9F7] border-b border-[#E2DDD8]"
                          >
                            <td className="px-3 py-2 border-r border-[#E2DDD8] bg-[#FAF9F7]">
                              <div className="flex items-center gap-2">
                                <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                                <span className="font-medium text-[#1F1D1B]">{row.name}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-medium text-[#3E6570]">{row.active}</td>
                            <td className="px-3 py-2 text-right font-medium text-[#4F7C3A]">{row.completed}</td>
                            <td className="px-3 py-2 text-right text-[#4B5563] tabular-nums">{row.totalProductionMinutes > 0 ? formatHours(row.totalProductionMinutes) : <span className="text-[#9CA3AF]">—</span>}</td>
                            <td className="px-3 py-2 text-right text-[#4B5563] tabular-nums">{row.totalWorkingMinutes > 0 ? formatHours(row.totalWorkingMinutes) : <span className="text-[#9CA3AF]">—</span>}</td>
                            <td className="px-3 py-2 text-right font-bold">{row.efficiency > 0 ? `${row.efficiency}%` : "-"}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${row.statusColor}`}>
                                {row.statusLabel}
                              </span>
                            </td>
                          </tr>
                        ))
                      : TRACKER_DEPARTMENTS.map((dept) => {
                          const rows = deptEfficiency.filter((r) => r.code === dept.code);
                          return rows.map((row, idx) => {
                            const isLastInGroup = idx === rows.length - 1;
                            return (
                              <tr
                                key={`${dept.code}-${row.category}`}
                                className={`hover:bg-[#FAF9F7] ${
                                  isLastInGroup ? "border-b border-[#E2DDD8]" : ""
                                }`}
                              >
                                {idx === 0 && (
                                  <td
                                    rowSpan={rows.length}
                                    className="px-3 py-2 align-top border-r border-[#E2DDD8] bg-[#FAF9F7]"
                                  >
                                    <div className="flex items-center gap-2">
                                      <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dept.color }} />
                                      <span className="font-medium text-[#1F1D1B]">{dept.name}</span>
                                    </div>
                                  </td>
                                )}
                                <td className="px-3 py-2">
                                  <span
                                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                                      row.category === "SOFA"
                                        ? "text-[#3E6570] bg-[#E0EDF0]"
                                        : "text-[#6B5C32] bg-[#F0ECE9]"
                                    }`}
                                  >
                                    {row.category}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right font-medium text-[#3E6570]">{row.active}</td>
                                <td className="px-3 py-2 text-right font-medium text-[#4F7C3A]">{row.completed}</td>
                                <td className="px-3 py-2 text-right text-[#4B5563] tabular-nums">{row.totalProductionMinutes > 0 ? formatHours(row.totalProductionMinutes) : <span className="text-[#9CA3AF]">—</span>}</td>
                                <td className="px-3 py-2 text-right text-[#4B5563] tabular-nums">{row.totalWorkingMinutes > 0 ? formatHours(row.totalWorkingMinutes) : <span className="text-[#9CA3AF]">—</span>}</td>
                                <td className="px-3 py-2 text-right font-bold">{row.efficiency > 0 ? `${row.efficiency}%` : "-"}</td>
                                <td className="px-3 py-2">
                                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${row.statusColor}`}>
                                    {row.statusLabel}
                                  </span>
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
      )}


      {/* ═══════════════════════════════════════════ */}
      {/* TAB 6: CAPACITY LOADING                    */}
      {/* ═══════════════════════════════════════════ */}
      {activeTab === "loading" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Gauge className="h-5 w-5 text-[#6B5C32]" />
              <span className="text-sm font-medium text-[#1F1D1B]">
                Daily Capacity Loading — Past {LOADING_CHART_PAST_DAYS} working days · Next {LOADING_CHART_FUTURE_DAYS} working days
              </span>
              <span className="text-xs text-[#6B7280]">(Mon-Sat working days, Sundays excluded · scroll left/right ↔ · % vs rolling daily capacity)</span>
            </div>
            {/* 2026-05-26: Category toggle. Default ALL; SOFA / BEDFRAME
                isolate the chart to a single product line. State lives on
                the page (loadingCategoryFilter) and feeds dailyLoadingByDept's
                filter loop — see "if (loadingCategoryFilter !== 'ALL'…)"
                in the useMemo body around L955. */}
            <div className="inline-flex rounded-md border border-[#E2DDD8] bg-white overflow-hidden text-xs">
              {(["ALL", "BEDFRAME", "SOFA"] as const).map((opt) => {
                const label = opt === "ALL" ? "All" : opt === "BEDFRAME" ? "Bedframe" : "Sofa";
                const active = loadingCategoryFilter === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setLoadingCategoryFilter(opt)}
                    className={`px-3 py-1.5 font-medium transition-colors ${
                      active
                        ? "bg-[#6B5C32] text-white"
                        : "text-[#6B7280] hover:bg-[#F0ECE9]"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Wei Siang 2026-05-16: ONE continuous chart per dept —
              past production bars + a vertical dashed divider at the
              past/future boundary + future planned-load bars. Bar
              heights scale to the dept's own max value across all
              days so every % gets a visibly distinct height (lively),
              and a horizontal dashed line marks the 100% (= rolling
              daily capacity) reference at its proportional spot.
              Wei Siang 2026-06-02: window widened to 14 past + 21
              future working days, so the chart body is wrapped in an
              overflow-x-auto container and scrolls left/right. */}
          {dailyLoadingByDept.map((dept) => {
            const combined = [
              ...dept.pastProduction.map((d) => ({ ...d, phase: "past" as const, minutes: d.producedMinutes })),
              ...dept.futureLoad.map((d) => ({ ...d, phase: "future" as const, minutes: d.loadedMinutes })),
            ];
            // Scale to the dept's own peak so the tallest bar fills
            // the chart. Floor at 100 so the dashed reference line
            // stays on-screen even when nothing exceeds capacity.
            const scaleMax = Math.max(100, ...combined.map((d) => d.utilization));
            const refLineBottomPct = (100 / scaleMax) * 100;
            return (
              <Card key={dept.deptCode} className="overflow-hidden">
                <div className="h-1" style={{ backgroundColor: dept.color }} />
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: dept.color }} />
                      {/* Departments with a built schedule page open a
                          drill-in (Fab Cut / Fab Sew / Wood Cut / Framing);
                          the rest stay plain text. Route lookup keeps all
                          four affordances identical. */}
                      {DEPT_DRILL_ROUTE[dept.deptCode] ? (
                        <button
                          type="button"
                          onClick={() => navigate(DEPT_DRILL_ROUTE[dept.deptCode])}
                          className="inline-flex items-center gap-1 font-semibold text-[#6B5C32] hover:text-[#574B28] hover:underline underline-offset-2 transition-colors"
                          title={`Open the ${dept.deptName} department schedule`}
                        >
                          {dept.deptName}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        dept.deptName
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs font-normal text-[#6B7280]">
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {dept.workerCount} workers
                      </span>
                      <span>
                        <span className="text-[#4F7C3A] font-medium">Past avg</span>{" "}
                        <strong className="text-[#1F1D1B] tabular-nums">{formatHours(dept.pastAvgMinutes)}</strong>
                        <span className="text-[#9CA3AF]"> ({dept.pastAvgPct}%)</span>
                      </span>
                      <span>
                        <span className="text-[#3E6570] font-medium">Plan avg</span>{" "}
                        <strong className="text-[#1F1D1B] tabular-nums">{formatHours(dept.futureAvgMinutes)}</strong>
                        <span className="text-[#9CA3AF]"> ({dept.futureAvgPct}%)</span>
                      </span>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                  <div className="overflow-x-auto">
                    {/* Wei Siang 2026-05-16: section labels now sit
                        directly ABOVE their own bars — past label over
                        the past block, "Planned Capacity" over the
                        future block — instead of both crammed onto one
                        line. Widths match the bar columns (44px each)
                        and the header scrolls with the chart. */}
                    <div
                      className="flex text-[10px] text-[#6B7280] mb-1"
                      style={{ minWidth: `${combined.length * 44}px` }}
                    >
                      <div
                        className="font-medium text-[#4F7C3A]"
                        style={{ width: `${dept.pastProduction.length * 44}px` }}
                      >
                        ◂ Past {LOADING_CHART_PAST_DAYS}d Production (working days)
                      </div>
                      <div
                        className="font-medium text-[#3E6570] pl-2 border-l border-dashed border-[#6B5C32]/50"
                        style={{ width: `${dept.futureLoad.length * 44}px` }}
                      >
                        Planned Capacity · Next {LOADING_CHART_FUTURE_DAYS}d (working days) ▸
                      </div>
                    </div>
                    <div
                      className="flex gap-1"
                      style={{ minWidth: `${combined.length * 44}px` }}
                    >
                      {combined.map((day, idx) => {
                        const d = parseDate(day.date);
                        const isSat = d.getDay() === 6;
                        const isToday = day.date === today;
                        const isPast = day.phase === "past";
                        const isFirstFuture =
                          day.phase === "future" &&
                          (idx === 0 || combined[idx - 1].phase === "past");

                        let barColor: string;
                        let textColor: string;
                        if (isPast) {
                          // Past: green = met / nearly met capacity, red = much slower.
                          // 2026-05-25 — Wei Siang asked to relax: 89% was
                          // flagged amber under the prior ≥90 cut, which
                          // misrepresented a near-target day as a miss.
                          if (day.utilization >= 80) { barColor = "bg-[#4F7C3A]"; textColor = "text-[#4F7C3A]"; }
                          else if (day.utilization >= 50) { barColor = "bg-[#9C6F1E]"; textColor = "text-[#9C6F1E]"; }
                          else { barColor = "bg-[#9A3A2D]"; textColor = "text-[#9A3A2D]"; }
                        } else {
                          // Future: green = breathing room, amber = at / near
                          // capacity, red = real overload.
                          // 2026-05-25 — Wei Siang: "100% 不可以红". The prior
                          // >100 cut alarmed at 101-110% which is normal
                          // operational headroom. Red now only fires when
                          // a day is materially over (>120%) so the colour
                          // means something the operator must act on.
                          if (day.utilization > 120) { barColor = "bg-[#9A3A2D]"; textColor = "text-[#9A3A2D]"; }
                          else if (day.utilization >= 90) { barColor = "bg-[#9C6F1E]"; textColor = "text-[#9C6F1E]"; }
                          else { barColor = "bg-[#4F7C3A]"; textColor = "text-[#4F7C3A]"; }
                        }
                        // Lively scaling — relative to the dept's own
                        // peak. Min 2% so a non-zero day is always a
                        // visible sliver, 0% stays flat.
                        const barHeightPct = day.utilization > 0
                          ? Math.max(2, (day.utilization / scaleMax) * 100)
                          : 0;
                        return (
                          <div
                            key={`${day.phase}-${day.date}`}
                            className={`flex flex-col items-center w-10 min-w-[40px] relative ${isToday ? "bg-[#6B5C32]/5 rounded" : ""}`}
                            title={`${day.date}\n${isPast ? "Produced" : "Loaded"}: ${formatHours(day.minutes)}\nCapacity: ${formatHours(Math.round(day.capacityMinutes))}\nUtilization: ${day.utilization}%`}
                          >
                            {/* Vertical dashed divider before the first
                                future bar = the past/future boundary. */}
                            {isFirstFuture && (
                              <div className="absolute left-[-2px] top-0 bottom-0 border-l border-dashed border-[#6B5C32]/50 pointer-events-none z-20" />
                            )}
                            <div className="h-20 w-6 bg-[#F0ECE9] rounded-t-sm relative flex items-end mb-1">
                              <div
                                className={`w-full rounded-t-sm transition-all ${barColor}`}
                                style={{ height: `${barHeightPct}%` }}
                              />
                              {/* 100% reference: a tick at the height
                                  that = 7-day capacity on this dept's
                                  own scale. Adjacent ticks line up into
                                  a continuous dashed rule across the
                                  whole chart. */}
                              <div
                                className="absolute left-0 right-0 border-t border-dashed border-[#9CA3AF]/70 pointer-events-none"
                                style={{ bottom: `${refLineBottomPct}%` }}
                              />
                              {!isPast && day.utilization > 120 && (
                                <AlertTriangle className="h-2.5 w-2.5 text-[#9A3A2D] absolute -top-3 left-1/2 -translate-x-1/2" />
                              )}
                            </div>
                            <span className={`text-[9px] font-semibold ${textColor} tabular-nums`}>{day.utilization}%</span>
                            <span className={`text-[8px] mt-0.5 ${isToday ? "font-bold text-[#6B5C32]" : isSat ? "text-[#9C6F1E]" : "text-[#9CA3AF]"}`}>
                              {d.getDate()}/{d.getMonth() + 1}
                            </span>
                            {/* Wei Siang 2026-06-03: per-day PRODUCTION
                                hours — the actual work for THIS day, not the
                                flat daily capacity. Past side = hours produced
                                (completion); plan side = hours loaded by due
                                date. `day.minutes` already carries the right
                                figure per side (produced vs loaded), so it
                                varies day to day instead of showing the same
                                capacity number on every bar. Rounded before
                                formatting because under the Bedframe / Sofa
                                filter the value is fractional (full × category
                                share) and would otherwise wrap as "19h 4.58m";
                                nowrap keeps each label on one line. The flat
                                capacity baseline is still the dashed line +
                                the "/day" total above the chart. */}
                            <span className="text-[8px] mt-0.5 text-[#6B7280] tabular-nums whitespace-nowrap">
                              {formatHours(Math.round(day.minutes))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {/* Legend */}
          <div className="flex items-center gap-6 text-xs text-[#6B7280]">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#4F7C3A]" />
              <span>&lt; 70% Normal</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#9C6F1E]" />
              <span>70-90% Moderate</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#9A3A2D]" />
              <span>90-100% Warning</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-[#9A3A2D]" />
              <span>&gt; 100% Critical</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-[#6B5C32]" />
              {/* Legend updated (owner audit 2026-07-11): the theoretical
                  workers×9h×0.85 formula was retired — capacity is the
                  rolling actual average now. */}
              <span>Capacity = rolling {ROLLING_WINDOW_DAYS}-working-day actual output average</span>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════ */}
      {/* TAB: MASTER TRACKER                        */}
      {/* ═══════════════════════════════════════════ */}
      {activeTab === "tracker" && (
        <div className="space-y-6">
          {/* Filters */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                {/* Category Tabs */}
                <div className="flex rounded-lg border border-[#E2DDD8] overflow-hidden">
                  {(["ALL", "BEDFRAME", "SOFA"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setTrackerCategoryTab(tab)}
                      className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                        trackerCategoryTab === tab
                          ? "bg-[#6B5C32] text-white"
                          : "bg-white text-[#4B5563] hover:bg-[#F0ECE9]"
                      }`}
                    >
                      {tab === "ALL" ? "All" : tab === "BEDFRAME" ? "Bedframe" : "Sofa"}
                    </button>
                  ))}
                </div>

                {/* Search */}
                <div className="relative flex-1 min-w-[200px] max-w-[320px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
                  <Input
                    placeholder="Search PO, SO, customer, product..."
                    value={trackerSearch}
                    onChange={(e) => setTrackerSearch(e.target.value)}
                    className="pl-9 h-9 text-sm"
                  />
                </div>

                {/* Status Filter */}
                <select
                  value={trackerStatusFilter}
                  onChange={(e) => setTrackerStatusFilter(e.target.value)}
                  className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-[#4B5563] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                >
                  <option value="ALL">All Status</option>
                  <option value="PENDING">Pending</option>
                  <option value="IN_PROGRESS">In Progress</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                  {/* Wei Siang 2026-05-15 audit: removed "On Hold" —
                      ProductionOrder.status never takes ON_HOLD, so the
                      filter was silently returning zero results. */}
                </select>

                {/* Date Range */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#6B7280]">From</span>
                  <Input
                    type="date"
                    value={trackerDateFrom}
                    onChange={(e) => setTrackerDateFrom(e.target.value)}
                    className="h-9 w-36 text-sm"
                  />
                  <span className="text-xs text-[#6B7280]">To</span>
                  <Input
                    type="date"
                    value={trackerDateTo}
                    onChange={(e) => setTrackerDateTo(e.target.value)}
                    className="h-9 w-36 text-sm"
                  />
                </div>

                <span className="text-xs text-[#9CA3AF]">
                  {filteredTrackerOrders.length} of {orders.length} orders
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Master Tracker Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Factory className="h-5 w-5 text-[#6B5C32]" />
                {trackerCategoryTab === "BEDFRAME" ? "BF" : trackerCategoryTab === "SOFA" ? "SF" : "BF & SF"} Master Tracker ({filteredTrackerOrders.length} items)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-xs whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-9 w-9 px-2 text-center font-medium text-[#374151] sticky left-0 bg-[#F0ECE9] z-20">
                        <input
                          type="checkbox"
                          aria-label="Select all visible orders"
                          checked={allTrackerFilteredSelected}
                          onChange={toggleTrackerSelectAll}
                          className="cursor-pointer align-middle"
                        />
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151] sticky left-9 bg-[#F0ECE9] z-10 cursor-pointer" onClick={() => toggleTrackerSort("poNo")}>
                        <div className="flex items-center gap-1">SO ID <TrackerSortIcon field="poNo" activeField={trackerSortField} direction={trackerSortDir} /></div>
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Sales Order</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Cust PO ID</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("customerName")}>
                        <div className="flex items-center gap-1">Customer <TrackerSortIcon field="customerName" activeField={trackerSortField} direction={trackerSortDir} /></div>
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">State</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("productCode")}>
                        <div className="flex items-center gap-1">Product <TrackerSortIcon field="productCode" activeField={trackerSortField} direction={trackerSortDir} /></div>
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Category</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Size</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Fabric</th>
                      <th className="h-9 px-2 text-right font-medium text-[#374151]">Gap</th>
                      <th className="h-9 px-2 text-right font-medium text-[#374151]">Divan</th>
                      <th className="h-9 px-2 text-right font-medium text-[#374151]">Leg</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Special</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Notes</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("targetEndDate")}>
                        <div className="flex items-center gap-1">Target End <TrackerSortIcon field="targetEndDate" activeField={trackerSortField} direction={trackerSortDir} /></div>
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Hookka DD</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Overdue</th>
                      {/* Department Completion Date columns */}
                      {TRACKER_DEPARTMENTS.map((dept) => (
                        <th
                          key={dept.code}
                          className="h-9 px-2 text-center font-medium text-white"
                          style={{ backgroundColor: dept.color }}
                        >
                          {dept.name} CD
                        </th>
                      ))}
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Racking #</th>
                      <th className="h-9 px-2 text-right font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("progress")}>
                        <div className="flex items-center gap-1 justify-end">Progress <TrackerSortIcon field="progress" activeField={trackerSortField} direction={trackerSortDir} /></div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrackerOrders.length === 0 ? (
                      <tr>
                        <td colSpan={28} className="py-12 text-center text-[#9CA3AF] text-sm">
                          No production orders match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredTrackerOrders.map((order) => {
                        const overdue = getOverdueDisplay(order);
                        const isSelected = selectedTrackerIds.has(order.id);
                        return (
                          <tr
                            key={order.id}
                            className={`border-b border-[#E2DDD8] cursor-pointer ${isSelected ? "bg-[#FFF8E6] hover:bg-[#FBEFC9]" : "hover:bg-[#FAF9F7]"}`}
                            onDoubleClick={() => {
                              if (order.salesOrderId) navigate(`/sales/${order.salesOrderId}`);
                            }}
                          >
                            <td
                              className={`px-2 py-1.5 text-center sticky left-0 z-10 ${isSelected ? "bg-[#FFF8E6]" : "bg-white"}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                aria-label={`Select order ${order.poNo}`}
                                checked={isSelected}
                                onChange={() => toggleTrackerRow(order.id)}
                                className="cursor-pointer align-middle"
                              />
                            </td>
                            <td className={`px-2 py-1.5 font-medium doc-number sticky left-9 z-10 ${isSelected ? "bg-[#FFF8E6]" : "bg-white"}`}>
                              {order.poNo}
                            </td>
                            <td className="px-2 py-1.5 doc-number text-[#4B5563]">{order.salesOrderNo}</td>
                            <td className="px-2 py-1.5 doc-number text-[#4B5563]">{order.customerPOId}</td>
                            <td className="px-2 py-1.5 font-medium text-[#1F1D1B] max-w-[120px] truncate">{order.customerName}</td>
                            <td className="px-2 py-1.5 text-[#4B5563]">{order.customerState}</td>
                            <td className="px-2 py-1.5 doc-number">{order.productCode}</td>
                            <td className="px-2 py-1.5">
                              <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                order.itemCategory === "BEDFRAME" ? "bg-[#E0EDF0] text-[#3E6570]" :
                                order.itemCategory === "SOFA" ? "bg-[#F9E1DA] text-[#9A3A2D]" :
                                "bg-gray-50 text-gray-600"
                              }`}>
                                {order.itemCategory}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-[#4B5563]">{order.sizeLabel}</td>
                            <td className="px-2 py-1.5 doc-number text-[#4B5563]">{order.fabricCode}</td>
                            <td className="px-2 py-1.5 text-right text-[#4B5563]">{order.gapInches ?? "-"}</td>
                            <td className="px-2 py-1.5 text-right text-[#4B5563]">{order.divanHeightInches ?? "-"}</td>
                            <td className="px-2 py-1.5 text-right text-[#4B5563]">{order.legHeightInches ?? "-"}</td>
                            <td className="px-2 py-1.5">
                              {order.specialOrder ? (
                                <span className="text-[10px] bg-[#F9E1DA] text-[#9A3A2D] px-1 py-0.5 rounded">{order.specialOrder.replace(/_/g, " ")}</span>
                              ) : "-"}
                            </td>
                            <td className="px-2 py-1.5 text-[#6B7280] max-w-[80px] truncate" title={order.notes}>{order.notes || "-"}</td>
                            <td className="px-2 py-1.5 text-[#4B5563]">{formatDate(order.targetEndDate)}</td>
                            <td className="px-2 py-1.5 text-[#4B5563]">
                              {hookkaDDByPoId.has(order.id)
                                ? formatDate(hookkaDDByPoId.get(order.id) as string)
                                : "-"}
                            </td>
                            <td className="px-2 py-1.5">
                              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${overdue.className}`}>
                                {overdue.icon} {overdue.label}
                              </span>
                            </td>
                            {/* Department Completion Dates */}
                            {TRACKER_DEPARTMENTS.map((dept) => {
                              const jc = order.jobCards.find((j) => j.departmentCode === dept.code);
                              const isCompleted = jc?.status === "COMPLETED" || jc?.status === "TRANSFERRED";
                              const isCurrent = order.currentDepartment === dept.code && !isCompleted;
                              return (
                                <td
                                  key={dept.code}
                                  className="px-2 py-1.5 text-center"
                                  style={{
                                    backgroundColor: isCompleted
                                      ? "#DCFCE7"
                                      : isCurrent
                                      ? "#FEF9C3"
                                      : "transparent",
                                  }}
                                >
                                  {isCompleted && jc?.completedDate ? (
                                    <span className="text-[#4F7C3A] font-medium">{formatDate(jc.completedDate)}</span>
                                  ) : isCurrent ? (
                                    <span className="text-[#9C6F1E] font-medium text-[10px]">IN PROGRESS</span>
                                  ) : jc?.dueDate ? (
                                    <span className="text-[#9CA3AF] text-[10px]">{formatDate(jc.dueDate)}</span>
                                  ) : (
                                    <span className="text-[#D1CBC5]">-</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="px-2 py-1.5 text-[#4B5563]">{order.rackingNumber || "-"}</td>
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5 justify-end">
                                <div className="h-1.5 w-14 rounded-full bg-[#E2DDD8]">
                                  <div
                                    className="h-1.5 rounded-full bg-[#6B5C32] transition-all"
                                    style={{ width: `${order.progress}%` }}
                                  />
                                </div>
                                <span className="text-[10px] font-medium text-[#6B7280] w-7 text-right">{order.progress}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Batch Due Date — multi-select rows, pick a department scope + a
              date, Apply. Reuses the production page's BatchActionToolbar +
              ApplyBatchDueDateDialog + /api/production-orders/bulk-patch
              endpoint. The department scope picker is tracker-specific: each
              row is a whole order spanning up to 8 dept job cards, so the
              operator chooses which department's due date to set (or all). */}
          {selectedTrackerOrders.length > 0 && (
            <div className="sticky bottom-[68px] left-3 right-3 z-30 flex items-center gap-2 rounded-md border border-[#C9A227] bg-[#FFF8E6] px-3 py-2 shadow-md">
              <span className="text-[12px] font-semibold text-[#5A4500]">Due Date department:</span>
              <select
                value={trackerBatchDept}
                onChange={(e) => setTrackerBatchDept(e.target.value)}
                className="h-8 rounded border border-[#D4CFC7] bg-white px-2 text-[12px] text-[#3A2E22] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
              >
                <option value="ALL">All departments</option>
                {TRACKER_DEPARTMENTS.map((dept) => (
                  <option key={dept.code} value={dept.code}>{dept.name}</option>
                ))}
              </select>
              <span className="text-[11px] text-[#9C7A1E]">
                {trackerBatchDept === "ALL"
                  ? "Sets the date on every department job card of the selected orders."
                  : `Sets the date on the ${TRACKER_DEPARTMENTS.find((d) => d.code === trackerBatchDept)?.name} job card of the selected orders.`}
              </span>
            </div>
          )}

          <BatchActionToolbar
            count={selectedTrackerOrders.length}
            onClear={() => setSelectedTrackerIds(new Set())}
            onApplyDueDate={() => setTrackerBatchDueDateOpen(true)}
            // The tracker only exposes the batch Due Date action — completion
            // date, PIC, and folder archiving live on the Production page where
            // rows are individual job cards. These no-op handlers are required
            // by the shared toolbar's prop contract; their buttons stay but
            // inform the operator where to go.
            onApplyDate={() => toast.error("Apply Completion is on the Production page (per-job-card). Use Apply Due Date here.")}
            onApplyPic={() => toast.error("Apply PIC is on the Production page (per-job-card).")}
            onSaveToFolder={() => toast.error("Save to Folder is on the Production page (per-job-card).")}
          />

          <ApplyBatchDueDateDialog
            open={trackerBatchDueDateOpen}
            count={selectedTrackerOrders.length}
            onCancel={() => setTrackerBatchDueDateOpen(false)}
            onApply={applyTrackerBatchDueDate}
          />
        </div>
      )}

      {activeTab === "leadtimes" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-[#1F1D1B]">
                    <Clock className="h-5 w-5" />
                    Production Lead Times
                  </CardTitle>
                  <p className="mt-1 text-xs text-[#6B5C32]">
                    Days before customer delivery date. Hookka Expected DD is the
                    offset from customer DD; other depts are offsets from Hookka
                    Expected DD. Used by SO confirm to auto-schedule job cards.
                  </p>
                  {!autoScheduleEnabled && (
                    <p className="mt-1 text-xs font-medium text-[#B8601A]">
                      Auto-schedule is OFF — new SO confirms leave job-card due
                      dates blank for staff to fill in manually.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* Global ON/OFF toggle for lead-time auto-scheduling.
                    * OFF => SO confirm leaves job-card due dates blank for
                    * staff to fill manually. Default ON = current behaviour. */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[#1F1D1B]">
                      Auto-schedule due dates
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoScheduleEnabled}
                      aria-label="Auto-schedule due dates"
                      disabled={autoScheduleSaving}
                      onClick={() => requestToggleAutoSchedule(!autoScheduleEnabled)}
                      title={
                        autoScheduleEnabled
                          ? "ON — new SO confirms auto-compute job-card due dates from lead times"
                          : "OFF — new SO confirms leave job-card due dates blank for manual entry"
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                        autoScheduleEnabled ? "bg-[#6B5C32]" : "bg-[#D6CDB8]"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                          autoScheduleEnabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                    <span
                      className={`text-xs font-semibold ${
                        autoScheduleEnabled ? "text-[#6B5C32]" : "text-[#B8601A]"
                      }`}
                    >
                      {autoScheduleEnabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  {ltSavedAt && (
                    <span className="text-xs text-[#6B5C32]">Saved {formatDate(ltSavedAt)}</span>
                  )}
                  {recalcResult && (
                    <span className="text-xs text-[#6B5C32]">{recalcResult}</span>
                  )}
                  {/* History dialog trigger — mirrors the 📅 icon button next
                    * to product codes on /products. Highlights orange when
                    * any future-dated change is queued so the user notices
                    * pending state at a glance. */}
                  <Button
                    variant="outline"
                    onClick={() => setHistoryOpen(true)}
                    title={
                      pendingSummary.count > 0 && pendingSummary.nearestEffectiveFrom
                        ? `${pendingSummary.count} pending · next on ${pendingSummary.nearestEffectiveFrom}`
                        : "Schedule future-dated lead-time changes"
                    }
                    className={
                      pendingSummary.count > 0
                        ? "border-[#E8B786] text-[#B8601A] hover:bg-[#FBE4CE]"
                        : undefined
                    }
                  >
                    <Calendar className="mr-2 h-4 w-4" />
                    History
                    {pendingSummary.count > 0 && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#FBE4CE] text-[#B8601A] border border-[#E8B786]">
                        {pendingSummary.count} pending
                      </span>
                    )}
                  </Button>
                  <Button
                    onClick={() => setShowLtSaveModal(true)}
                    disabled={ltSaving || recalcRunning}
                    className="bg-[#6B5C32] text-white hover:bg-[#5a4d29]"
                  >
                    {ltSaving ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save Lead Times"
                    )}
                  </Button>
                  {/* Save only persists the new lead-time map for FUTURE SO
                    * confirms; existing PO job_cards still hold dueDates
                    * computed under the OLD lead times. Recalculate All
                    * sweeps every active PO and rewrites its job_cards
                    * via /api/production/leadtimes/recalc-all so the
                    * Production grid actually reflects the new config. */}
                  <Button
                    variant="outline"
                    onClick={recalcAllDueDates}
                    disabled={ltSaving || recalcRunning || !autoScheduleEnabled}
                    title={
                      autoScheduleEnabled
                        ? "Rewrite every existing production order's job-card dueDates using the saved lead times"
                        : "Auto-schedule is OFF — existing due dates are left untouched"
                    }
                  >
                    {recalcRunning ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Recalculating...
                      </>
                    ) : (
                      "Recalculate Existing POs"
                    )}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b-2 border-[#E5DFD1] bg-[#FAF7EF] text-left">
                      <th className="px-3 py-2 font-semibold text-[#1F1D1B]">Process</th>
                      <th className="px-3 py-2 text-center font-semibold text-[#1F1D1B]">
                        Bedframe (days)
                      </th>
                      <th className="px-3 py-2 text-center font-semibold text-[#1F1D1B]">
                        Sofa (days)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {LEADTIME_ROWS.map((row) => {
                      const isBuffer = row.code === "HOOKKA_DD";
                      const bedframeVal = isBuffer
                        ? hookkaDDBuffer.BEDFRAME
                        : leadTimes.BEDFRAME[row.code] ?? 0;
                      const sofaVal = isBuffer
                        ? hookkaDDBuffer.SOFA
                        : leadTimes.SOFA[row.code] ?? 0;
                      return (
                        <tr
                          key={row.code}
                          className={
                            isBuffer
                              ? "border-b-2 border-[#6B5C32] bg-[#FAF7EF]"
                              : "border-b border-[#E5DFD1]"
                          }
                        >
                          <td className="px-3 py-2 font-medium text-[#1F1D1B]">
                            {row.label}
                            <span className="ml-2 text-xs text-[#6B5C32]">{row.code}</span>
                            {isBuffer && (
                              <span className="ml-2 rounded bg-[#E5DFD1] px-1.5 py-0.5 text-[10px] font-semibold text-[#6B5C32]">
                                Buffer
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              min="0"
                              value={bedframeVal}
                              onChange={(e) =>
                                updateLeadTime("BEDFRAME", row.code, e.target.value)
                              }
                              className="h-8 w-20 rounded border border-[#E5DFD1] px-2 text-center text-sm"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              min="0"
                              value={sofaVal}
                              onChange={(e) =>
                                updateLeadTime("SOFA", row.code, e.target.value)
                              }
                              className="h-8 w-20 rounded border border-[#E5DFD1] px-2 text-center text-sm"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 rounded-md border border-[#E5DFD1] bg-[#FAF7EF] p-3 text-xs text-[#6B5C32]">
                <div className="mb-1 font-semibold text-[#1F1D1B]">Example</div>
                Customer wants delivery on 25 Apr. With Hookka Expected DD = 2 and
                Upholstery = 2, Framing = 3 (bedframe): Hookka DD → 23 Apr,
                Upholstery → 21 Apr, Framing → 20 Apr.
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <LeadTimeHistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSaved={() => {
          // Refresh the GET /api/production/leadtimes payload so the inline
          // table picks up new effective values + the pending badge updates.
          invalidateCachePrefix("/api/production/leadtimes");
          refreshLeadTimes();
        }}
      />

      {/* Effective-date confirmation for the inline Save Lead Times button.
          The PUT /api/production/leadtimes endpoint accepts an optional
          effectiveFrom (defaults to today) so the operator can either save
          immediately or queue a future-dated change without leaving this
          screen. The "Recalculate Existing POs" action remains separate
          and explicitly opt-in for orders mid-production. */}
      <EffectiveDateConfirmModal
        open={showLtSaveModal}
        title="Save lead times"
        summary="New SO confirms after this date use the saved lead times. Existing POs keep their job-card dueDates unless you click Recalculate Existing POs."
        ctaLabel="Save Lead Times"
        notesPlaceholder="e.g. Q3 plant capacity update"
        onClose={() => setShowLtSaveModal(false)}
        onConfirm={async ({ effectiveFrom, notes }) => {
          await persistLeadTimes(effectiveFrom, notes);
          setShowLtSaveModal(false);
        }}
      />

      {/* Wei Siang 2026-05-15: KPI drilldown modals. Stacked so each
          level has its own back button. Only the top of the stack
          renders; popping returns the operator to the previous level. */}
      {topDrilldown && (
        <DrilldownModal
          level={topDrilldown}
          stackDepth={drilldownStack.length}
          onBack={drilldownStack.length > 1 ? popDrilldown : undefined}
          onClose={closeDrilldown}
          onPush={pushDrilldown}
          orders={orders}
          rollingWindowDates={rollingWindowDates}
          capacityByDay={capacityByDay}
          capacityForDate={capacityForDate}
          capacityWorkersForDateDept={capacityWorkersForDateDept}
          capacityJCsForDateDeptWorker={capacityJCsForDateDeptWorker}
          loadByDept={loadByDept}
          loadWorkersForDept={loadWorkersForDept}
          loadJCsForDeptWorker={loadJCsForDeptWorker}
          backlogByDept={backlogByDept}
          deptNameByCode={deptNameByCode}
          scopeRange={scopeRange}
          totalCapacity={totalCapacity}
        />
      )}

      {/* In-app confirm for the auto-schedule toggle (owner rule: no naked
          toggle). Rendered once; awaited by requestToggleAutoSchedule. */}
      {confirmDialog}
    </div>
  );
}

// ── Drilldown modal ──
// Wei Siang 2026-05-15: separate component (still in this file because
// the level types + data closures live with the parent). Renders
// whichever level is on top of the stack. Back button only shown when
// there's a parent level to return to (stackDepth > 1).
type DrilldownLevel =
  | { kind: "capacity-14d" }
  | { kind: "capacity-day"; date: string }
  | { kind: "capacity-day-dept"; date: string; deptCode: string }
  | { kind: "capacity-day-dept-worker"; date: string; deptCode: string; workerId: string; workerName: string }
  | { kind: "load-by-dept" }
  | { kind: "load-dept"; deptCode: string }
  | { kind: "load-dept-worker"; deptCode: string; workerId: string; workerName: string }
  | { kind: "backlog-by-dept" };

type WorkerAgg = { workerId: string; workerName: string; totalMinutes: number; jcCount: number };
type CapacityJCRow = {
  jcId: string;
  pic1Name: string;
  pic2Name: string;
  productCode: string;
  productName: string;
  wipLabel: string | null;
  poNo: string;
  category: string;
  customerName: string;
  minutes: number;
};
type LoadJCRow = CapacityJCRow & { dueDate: string; status: string };

function DrilldownModal(props: {
  level: DrilldownLevel;
  stackDepth: number;
  onBack?: () => void;
  onClose: () => void;
  onPush: (level: DrilldownLevel) => void;
  orders: ProductionOrder[];
  rollingWindowDates: string[];
  capacityByDay: Map<string, number>;
  capacityForDate: (date: string) => Map<string, { sofa: number; bf: number; other: number; total: number }>;
  capacityWorkersForDateDept: (date: string, deptCode: string) => WorkerAgg[];
  capacityJCsForDateDeptWorker: (date: string, deptCode: string, workerId: string) => CapacityJCRow[];
  loadByDept: Map<string, { sofa: number; bf: number; total: number }>;
  loadWorkersForDept: (deptCode: string) => WorkerAgg[];
  loadJCsForDeptWorker: (deptCode: string, workerId: string) => LoadJCRow[];
  backlogByDept: Array<{
    deptCode: string;
    deptName: string;
    color: string;
    sofaBacklog: number;
    bfBacklog: number;
    totalBacklog: number;
    totalBacklogDays: number;
    dailyCapacity: number;
  }>;
  deptNameByCode: Map<string, { name: string; color: string }>;
  scopeRange: { from: string; to: string; workingDays: number; label: string };
  totalCapacity: number;
}) {
  const {
    level,
    stackDepth,
    onBack,
    onClose,
    onPush,
    rollingWindowDates,
    capacityByDay,
    capacityForDate,
    capacityWorkersForDateDept,
    capacityJCsForDateDeptWorker,
    loadByDept,
    loadWorkersForDept,
    loadJCsForDeptWorker,
    backlogByDept,
    deptNameByCode,
    scopeRange,
    totalCapacity,
  } = props;

  let title = "";
  let subtitle = "";
  let body: React.ReactNode = null;

  if (level.kind === "capacity-14d") {
    title = `Daily Capacity — Past ${ROLLING_WINDOW_DAYS} Working Days`;
    subtitle = `Average: ${formatHours(totalCapacity)}/day across all production depts · working days only (excludes Sundays & public holidays)`;
    const maxMin = Math.max(1, ...Array.from(capacityByDay.values()));
    body = (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Date</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]" style={{ minWidth: 200 }}>vs Avg</th>
            <th className="h-9 px-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {rollingWindowDates.map((date) => {
            const mins = capacityByDay.get(date) ?? 0;
            const pctOfMax = (mins / maxMin) * 100;
            const diffFromAvg = mins - totalCapacity;
            const diffColor = diffFromAvg > 0 ? "text-[#4F7C3A]" : diffFromAvg < 0 ? "text-[#9A3A2D]" : "text-[#6B7280]";
            return (
              <tr
                key={date}
                className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                onClick={() => onPush({ kind: "capacity-day", date })}
              >
                <td className="px-4 py-2 font-medium text-[#1F1D1B]">{date}</td>
                <td className="px-4 py-2 text-right font-medium text-[#1F1D1B] tabular-nums">{formatHours(mins)}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-[#F0ECE9] overflow-hidden">
                      <div className="h-full bg-[#6B5C32]" style={{ width: `${pctOfMax}%` }} />
                    </div>
                    <span className={`text-[10px] ${diffColor} w-16 text-right tabular-nums`}>
                      {diffFromAvg === 0
                        ? "0"
                        : (diffFromAvg > 0 ? "+" : "−") + formatHours(Math.abs(diffFromAvg))}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2 text-[#9CA3AF]">
                  <ChevronRight className="h-4 w-4" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "capacity-day") {
    title = `Production on ${level.date}`;
    const byDept = capacityForDate(level.date);
    const dayTotal = Array.from(byDept.values()).reduce((s, v) => s + v.total, 0);
    subtitle = `${formatHours(dayTotal)} of production completed across ${byDept.size} dept${byDept.size === 1 ? "" : "s"}`;
    const entries = Array.from(byDept.entries()).sort((a, b) => b[1].total - a[1].total);
    body = entries.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No completed work on this date.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Department</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">SOFA</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">BEDFRAME</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
            <th className="h-9 px-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([deptCode, val]) => {
            const meta = deptNameByCode.get(deptCode);
            return (
              <tr
                key={deptCode}
                className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                onClick={() => onPush({ kind: "capacity-day-dept", date: level.date, deptCode })}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: meta?.color ?? "#9CA3AF" }} />
                    <span className="font-medium text-[#1F1D1B]">{meta?.name ?? deptCode}</span>
                  </div>
                </td>
                <td className="px-4 py-2 text-right text-[#3E6570] tabular-nums">{formatHours(val.sofa)}</td>
                <td className="px-4 py-2 text-right text-[#6B5C32] tabular-nums">{formatHours(val.bf)}</td>
                <td className="px-4 py-2 text-right font-bold text-[#1F1D1B] tabular-nums">{formatHours(val.total)}</td>
                <td className="px-2 py-2 text-[#9CA3AF]">
                  <ChevronRight className="h-4 w-4" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "capacity-day-dept") {
    // Wei Siang 2026-05-15: this level NOW shows per-worker performance
    // for the (date × dept), not a flat JC list. Click a worker → next
    // level shows just that worker's specific JCs.
    const meta = deptNameByCode.get(level.deptCode);
    title = `${meta?.name ?? level.deptCode} on ${level.date}`;
    const workers = capacityWorkersForDateDept(level.date, level.deptCode);
    const deptTotal = workers.reduce((s, w) => s + w.totalMinutes, 0);
    subtitle = `${workers.length} worker${workers.length === 1 ? "" : "s"} · ${formatHours(deptTotal)} of production`;
    body = workers.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No completed work in this dept on this date.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Worker</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Job Cards</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]" style={{ minWidth: 200 }}>Share</th>
            <th className="h-9 px-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => {
            const sharePct = deptTotal > 0 ? Math.round((w.totalMinutes / deptTotal) * 100) : 0;
            return (
              <tr
                key={w.workerId}
                className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                onClick={() => onPush({ kind: "capacity-day-dept-worker", date: level.date, deptCode: level.deptCode, workerId: w.workerId, workerName: w.workerName })}
              >
                <td className="px-4 py-2 font-medium text-[#1F1D1B]">
                  {w.workerName || <span className="text-[#9CA3AF]">(unassigned)</span>}
                </td>
                <td className="px-4 py-2 text-right text-[#4B5563] tabular-nums">{w.jcCount}</td>
                <td className="px-4 py-2 text-right font-bold text-[#1F1D1B] tabular-nums">{formatHours(Math.round(w.totalMinutes))}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-[#F0ECE9] overflow-hidden">
                      <div className="h-full bg-[#6B5C32]" style={{ width: `${sharePct}%` }} />
                    </div>
                    <span className="text-[10px] text-[#6B7280] w-10 text-right tabular-nums">{sharePct}%</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-[#9CA3AF]">
                  <ChevronRight className="h-4 w-4" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "capacity-day-dept-worker") {
    // Leaf level: per-JC list for the picked worker.
    const meta = deptNameByCode.get(level.deptCode);
    title = `${level.workerName} — ${meta?.name ?? level.deptCode} on ${level.date}`;
    const rows = capacityJCsForDateDeptWorker(level.date, level.deptCode, level.workerId);
    const workerTotal = rows.reduce((s, r) => s + r.minutes, 0);
    subtitle = `${rows.length} job card${rows.length === 1 ? "" : "s"} · ${formatHours(workerTotal)} of production`;
    body = rows.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No completed JCs for this worker on this date.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">PO</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Category</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Product</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">WIP</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Customer</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Co-worker</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // Other PIC, if any. Skip the current worker from the display.
            const coWorker = r.pic1Name && r.pic2Name && r.pic1Name !== level.workerName
              ? r.pic1Name
              : r.pic2Name && r.pic2Name !== level.workerName
                ? r.pic2Name
                : "";
            return (
              <tr key={r.jcId} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                <td className="px-4 py-2 text-[#4B5563]">{r.poNo}</td>
                <td className="px-4 py-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium ${
                    r.category === "SOFA" ? "text-[#3E6570] bg-[#E0EDF0]" : "text-[#6B5C32] bg-[#F0ECE9]"
                  }`}>
                    {r.category}
                  </span>
                </td>
                <td className="px-4 py-2 text-[#4B5563]">
                  <div className="font-medium text-[#1F1D1B]">{r.productCode}</div>
                  <div className="text-[10px] text-[#6B7280]">{r.productName}</div>
                </td>
                <td className="px-4 py-2 text-[#4B5563]">{r.wipLabel ?? "—"}</td>
                <td className="px-4 py-2 text-[#4B5563]">{r.customerName}</td>
                <td className="px-4 py-2 text-[#6B7280] text-[11px]">{coWorker || "—"}</td>
                <td className="px-4 py-2 text-right font-medium text-[#1F1D1B] tabular-nums">{formatHours(r.minutes)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "load-by-dept") {
    title = `${scopeRange.label}'s Capacity — ${scopeRange.from}${scopeRange.from !== scopeRange.to ? ` → ${scopeRange.to}` : ""}`;
    const total = Array.from(loadByDept.values()).reduce((s, v) => s + v.total, 0);
    subtitle = `${formatHours(total)} of active work scheduled across ${loadByDept.size} dept${loadByDept.size === 1 ? "" : "s"}`;
    const entries = Array.from(loadByDept.entries()).sort((a, b) => b[1].total - a[1].total);
    body = entries.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No active JCs scheduled in this range.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Department</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">SOFA</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">BEDFRAME</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
            <th className="h-9 px-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([deptCode, val]) => {
            const meta = deptNameByCode.get(deptCode);
            return (
              <tr
                key={deptCode}
                className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                onClick={() => onPush({ kind: "load-dept", deptCode })}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: meta?.color ?? "#9CA3AF" }} />
                    <span className="font-medium text-[#1F1D1B]">{meta?.name ?? deptCode}</span>
                  </div>
                </td>
                <td className="px-4 py-2 text-right text-[#3E6570] tabular-nums">{formatHours(val.sofa)}</td>
                <td className="px-4 py-2 text-right text-[#6B5C32] tabular-nums">{formatHours(val.bf)}</td>
                <td className="px-4 py-2 text-right font-bold text-[#1F1D1B] tabular-nums">{formatHours(val.total)}</td>
                <td className="px-2 py-2 text-[#9CA3AF]">
                  <ChevronRight className="h-4 w-4" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "load-dept") {
    // Per-worker scheduled load for the picked dept.
    const meta = deptNameByCode.get(level.deptCode);
    title = `${meta?.name ?? level.deptCode} — ${scopeRange.label}'s Capacity`;
    const workers = loadWorkersForDept(level.deptCode);
    const deptTotal = workers.reduce((s, w) => s + w.totalMinutes, 0);
    subtitle = `${workers.length} worker${workers.length === 1 ? "" : "s"} · ${formatHours(deptTotal)} of active work`;
    body = workers.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No active job cards in this dept for the selected range.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Worker</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Job Cards</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]" style={{ minWidth: 200 }}>Share</th>
            <th className="h-9 px-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => {
            const sharePct = deptTotal > 0 ? Math.round((w.totalMinutes / deptTotal) * 100) : 0;
            return (
              <tr
                key={w.workerId}
                className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                onClick={() => onPush({ kind: "load-dept-worker", deptCode: level.deptCode, workerId: w.workerId, workerName: w.workerName })}
              >
                <td className="px-4 py-2 font-medium text-[#1F1D1B]">
                  {w.workerName || <span className="text-[#9CA3AF]">(unassigned)</span>}
                </td>
                <td className="px-4 py-2 text-right text-[#4B5563] tabular-nums">{w.jcCount}</td>
                <td className="px-4 py-2 text-right font-bold text-[#1F1D1B] tabular-nums">{formatHours(Math.round(w.totalMinutes))}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-[#F0ECE9] overflow-hidden">
                      <div className="h-full bg-[#3E6570]" style={{ width: `${sharePct}%` }} />
                    </div>
                    <span className="text-[10px] text-[#6B7280] w-10 text-right tabular-nums">{sharePct}%</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-[#9CA3AF]">
                  <ChevronRight className="h-4 w-4" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "load-dept-worker") {
    // Leaf — per-JC list for the picked worker in this dept's scheduled load.
    const meta = deptNameByCode.get(level.deptCode);
    title = `${level.workerName} — ${meta?.name ?? level.deptCode} ${scopeRange.label}'s Capacity`;
    const rows = loadJCsForDeptWorker(level.deptCode, level.workerId);
    const workerTotal = rows.reduce((s, r) => s + r.minutes, 0);
    subtitle = `${rows.length} active job card${rows.length === 1 ? "" : "s"} · ${formatHours(workerTotal)} of scheduled work`;
    body = rows.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No active job cards for this worker in this dept.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Due Date</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">PO</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Category</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Product</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">WIP</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Customer</th>
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Status</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Production Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.jcId} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
              <td className="px-4 py-2 text-[#4B5563]">{r.dueDate}</td>
              <td className="px-4 py-2 text-[#4B5563]">{r.poNo}</td>
              <td className="px-4 py-2">
                <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium ${
                  r.category === "SOFA" ? "text-[#3E6570] bg-[#E0EDF0]" : "text-[#6B5C32] bg-[#F0ECE9]"
                }`}>
                  {r.category}
                </span>
              </td>
              <td className="px-4 py-2 text-[#4B5563]">
                <div className="font-medium text-[#1F1D1B]">{r.productCode}</div>
                <div className="text-[10px] text-[#6B7280]">{r.productName}</div>
              </td>
              <td className="px-4 py-2 text-[#4B5563]">{r.wipLabel ?? "—"}</td>
              <td className="px-4 py-2 text-[#4B5563]">{r.customerName}</td>
              <td className="px-4 py-2 text-[10px] text-[#6B7280]">{r.status}</td>
              <td className="px-4 py-2 text-right font-medium text-[#1F1D1B] tabular-nums">{formatHours(r.minutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
</div>);
  } else if (level.kind === "backlog-by-dept") {
    // Wei Siang 2026-05-15: Total Backlog click → per-dept breakdown.
    // Each row shows SOFA + BEDFRAME backlog hours, total hours, and
    // wall-clock backlog days (= total minutes ÷ that dept's
    // dailyCapacity). Sorted by days descending so the biggest
    // bottleneck floats to the top.
    title = "Total Backlog — per Department";
    const grand = backlogByDept.reduce((s, d) => s + d.totalBacklog, 0);
    subtitle = `${formatHours(grand)} of active work across ${backlogByDept.length} dept${backlogByDept.length === 1 ? "" : "s"}`;
    body = backlogByDept.length === 0 ? (
      <div className="p-8 text-center text-sm text-[#6B7280]">No active backlog.</div>
    ) : (<div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#F0ECE9]">
          <tr className="border-b border-[#E2DDD8]">
            <th className="h-9 px-4 text-left font-medium text-[#374151]">Department</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">SOFA</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">BEDFRAME</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]">Total</th>
            {/* Wei Siang 2026-05-15: Daily Capacity column inserted so
                the Backlog Days arithmetic is visible — operator can
                see "Total ÷ Daily Capacity = Backlog Days" directly. */}
            <th className="h-9 px-4 text-right font-medium text-[#374151]" title={`Dept's ${ROLLING_WINDOW_DAYS}-day rolling daily output. Backlog ÷ this = Backlog Days.`}>Daily Capacity</th>
            <th className="h-9 px-4 text-right font-medium text-[#374151]" title={`Total backlog ÷ dept's ${ROLLING_WINDOW_DAYS}-day rolling daily capacity. Wall-clock days the dept needs to clear its queue.`}>Backlog Days</th>
          </tr>
        </thead>
        <tbody>
          {backlogByDept.map((d) => {
            const daysColor =
              d.totalBacklogDays > 7
                ? "text-[#9A3A2D]"
                : d.totalBacklogDays > 3
                  ? "text-[#9C6F1E]"
                  : "text-[#4F7C3A]";
            return (
              <tr key={d.deptCode} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="font-medium text-[#1F1D1B]">{d.deptName}</span>
                  </div>
                </td>
                <td className="px-4 py-2 text-right text-[#3E6570] tabular-nums">{formatHours(d.sofaBacklog)}</td>
                <td className="px-4 py-2 text-right text-[#6B5C32] tabular-nums">{formatHours(d.bfBacklog)}</td>
                <td className="px-4 py-2 text-right font-bold text-[#1F1D1B] tabular-nums">{formatHours(d.totalBacklog)}</td>
                <td className="px-4 py-2 text-right text-[#4B5563] tabular-nums">{d.dailyCapacity > 0 ? `${formatHours(d.dailyCapacity)}/day` : <span className="text-[#9CA3AF]">—</span>}</td>
                <td className={`px-4 py-2 text-right font-bold tabular-nums ${daysColor}`}>{d.totalBacklogDays}d</td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>);
  }

  // z-index scales with stack depth so a deeper modal overlays its
  // parent. Backdrop click closes the entire stack — the operator can
  // still use Back for one level up.
  const zIndex = 50 + stackDepth * 10;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
      style={{ zIndex }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E2DDD8] bg-[#FAFAF9]">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="p-1.5 rounded hover:bg-[#F0ECE9] text-[#6B5C32]"
                title="Back to previous level"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div>
              <h2 className="text-base font-bold text-[#1F1D1B]">{title}</h2>
              {subtitle && <p className="text-xs text-[#6B7280] mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[#F0ECE9] text-[#6B7280]"
            title="Close all"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{body}</div>
      </div>
    </div>
  );
}
