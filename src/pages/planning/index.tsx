import { useEffect, useState, useCallback, useMemo } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import {
  Factory,
  TrendingUp,
  Clock,
  ChevronUp,
  ChevronDown,
  Users,
  BarChart3,
  Loader2,
  Gauge,
  CheckCircle2,
  AlertTriangle,
  Search,
  ClipboardList,
  Calendar,
} from "lucide-react";
import { LeadTimeHistoryDialog } from "./LeadTimeHistoryDialog";
import { EffectiveDateConfirmModal } from "../products/MaintenanceConfigHistoryDialog";

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

type CapacityDept = {
  deptCode: string;
  deptName: string;
  color: string;
  workerCount: number;
  dailyCapacityMinutes: number;
  dailyLoading: {
    date: string;
    loadedMinutes: number;
    capacityMinutes: number;
    utilization: number;
    level: string;
  }[];
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

// HOURS_PER_DAY: fallback for workers whose workingHoursPerDay is
// missing. Surfaced as "Hours/day" on each dept card.
//
// EFFICIENCY (0.85) was used by the old theoretical-capacity formula
// (workers × HOURS_PER_DAY × 60 × EFFICIENCY). Phase 1 spec rewrite
// replaced that with the rolling 14-day actual-production average,
// so the EFFICIENCY constant is no longer referenced. Preserved
// here as a comment for archaeological context.
const HOURS_PER_DAY = 9;

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

function getDeptEfficiency(orders: ProductionOrder[]) {
  return TRACKER_DEPARTMENTS.map((dept) => {
    let active = 0;
    let completed = 0;
    let totalEstHours = 0;
    let totalActualHours = 0;

    for (const order of orders) {
      const jc = order.jobCards.find((j) => j.departmentCode === dept.code);
      if (!jc) continue;
      if (jc.status === "IN_PROGRESS" || jc.status === "PAUSED") active++;
      if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") {
        completed++;
        totalEstHours += jc.estMinutes / 60;
        totalActualHours += (jc.actualMinutes ?? jc.estMinutes) / 60;
      }
    }

    const efficiency = totalActualHours > 0 ? Math.round((totalEstHours / totalActualHours) * 100) : 0;
    let statusLabel: string;
    let statusColor: string;
    if (efficiency >= 95)      { statusLabel = "Excellent";          statusColor = "text-[#4F7C3A] bg-[#EEF3E4]"; }
    else if (efficiency >= 80) { statusLabel = "Good";               statusColor = "text-[#3E6570] bg-[#E0EDF0]"; }
    else if (efficiency >= 60) { statusLabel = "Fair";               statusColor = "text-[#9C6F1E] bg-[#FAEFCB]"; }
    else if (efficiency > 0)   { statusLabel = "Needs Improvement";  statusColor = "text-[#9A3A2D] bg-[#F9E1DA]"; }
    else                       { statusLabel = "No Data";            statusColor = "text-gray-500 bg-gray-50"; }

    return { ...dept, active, completed, totalEstHours, totalActualHours, efficiency, statusLabel, statusColor };
  });
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

function utilizationColor(pct: number): { bar: string; text: string; bg: string } {
  if (pct > 90) return { bar: "bg-[#9A3A2D]", text: "text-[#9A3A2D]", bg: "bg-[#F9E1DA]" };
  if (pct >= 70) return { bar: "bg-[#9C6F1E]", text: "text-[#9C6F1E]", bg: "bg-[#FAEFCB]" };
  return { bar: "bg-[#4F7C3A]", text: "text-[#4F7C3A]", bg: "bg-[#EEF3E4]" };
}


// ── Main Component ──

export default function PlanningPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabId>("capacity");
  const { data: ordersResp, loading: ordersLoading, refresh: refreshOrders } = useCachedJson<{ data?: ProductionOrder[] }>("/api/production-orders");
  const { data: workersResp, loading: workersLoading, refresh: refreshWorkers } = useCachedJson<{ data?: Worker[] }>("/api/workers");
  const { data: schedResp, refresh: refreshSched } = useCachedJson<{ data?: ScheduleEntry[] }>("/api/scheduling");
  const { data: capResp, loading: capLoading, refresh: refreshCap } = useCachedJson<{ data?: CapacityDept[]; days?: string[] }>("/api/scheduling/capacity");
  const orders: ProductionOrder[] = useMemo(() => ordersResp?.data ?? [], [ordersResp]);
  const workers: Worker[] = useMemo(() => workersResp?.data ?? [], [workersResp]);
  const capacityDepts: CapacityDept[] = useMemo(() => capResp?.data ?? [], [capResp]);
  // Wei Siang 2026-05-15 audit: schedules feed the Master Tracker's
  // Hookka DD column (was previously voided, leaving the column
  // duplicating Target End).
  const schedules: ScheduleEntry[] = useMemo(() => schedResp?.data ?? [], [schedResp]);
  const loading = ordersLoading || workersLoading || capLoading;

  // ── Master Tracker state ──
  const [trackerCategoryTab, setTrackerCategoryTab] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");
  const [trackerSearch, setTrackerSearch] = useState("");
  const [trackerStatusFilter, setTrackerStatusFilter] = useState("ALL");
  const [trackerDateFrom, setTrackerDateFrom] = useState("");
  const [trackerDateTo, setTrackerDateTo] = useState("");
  const [trackerSortField, setTrackerSortField] = useState<TrackerSortField>("poNo");
  const [trackerSortDir, setTrackerSortDir] = useState<TrackerSortDir>("asc");

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
      };
      setLeadTimes({
        BEDFRAME: dd.BEDFRAME ?? {},
        SOFA: dd.SOFA ?? {},
      });
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
      await fetch("/api/production/leadtimes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...leadTimes,
          hookkaDDBuffer,
          effectiveFrom,
          notes: notes || null,
        }),
      });
      invalidateCachePrefix("/api/production/leadtimes");
      refreshLeadTimes();
      setLtSavedAt(new Date().toLocaleTimeString());
    } finally {
      setLtSaving(false);
    }
  };

  // Rewrites dueDate on every existing production order's job_cards using the
  // current lead-time config. Destructive for old orders, so we confirm first
  // and then invalidate the production cache so the tracker picks up new
  // dates immediately.
  const recalcAllDueDates = async () => {
    const ok = window.confirm(
      "Recalculate due dates on ALL existing production orders?\n\n" +
        "This will rewrite every job card's dueDate using the current lead " +
        "times. Orders mid-production will see their department targets shift.",
    );
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
    refreshCap();
  }, [refreshOrders, refreshWorkers, refreshSched, refreshCap]);

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
      return { from: fmtISO(monday), to: fmtISO(saturday), workingDays: 6, label: "This Week" };
    }
    // Monthly: 1st → end of current calendar month.
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    // Count working days (Mon-Sat) in the month.
    let wd = 0;
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) wd++;
    }
    return { from: fmtISO(first), to: fmtISO(last), workingDays: wd, label: "This Month" };
  }, [capacityScope, today]);

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
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const fourteenDaysAgoISO = fmtISO(fourteenDaysAgo);
    const scopeFrom = scopeRange.from;
    const scopeTo = scopeRange.to;
    const scopeDays = Math.max(scopeRange.workingDays, 1);

    return DEPARTMENTS.map((dept) => {
      const deptWorkers = workers.filter((w) => w.departmentCode === dept.code && w.status === "ACTIVE");
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

      // 14-day rolling actual production — sum actualMinutes (fall
      // back to estMinutes if actual not recorded) on JCs completed
      // in last 14 calendar days, ÷ 14 → daily average.
      let last14DayActual = 0;
      for (const order of orders) {
        for (const jc of order.jobCards) {
          if (jc.departmentCode !== dept.code) continue;
          if (jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") continue;
          if (!jc.completedDate) continue;
          if (jc.completedDate < fourteenDaysAgoISO) continue;
          if (jc.completedDate > today) continue;
          last14DayActual += jc.actualMinutes ?? jc.estMinutes ?? 0;
        }
      }
      const dailyCapacity = Math.round(last14DayActual / 14);

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

      const sofaBacklog = sofaActive.reduce((s, jc) => s + (jc.estMinutes || 0), 0);
      const bfBacklog = bfActive.reduce((s, jc) => s + (jc.estMinutes || 0), 0);
      const totalBacklog = sofaBacklog + bfBacklog;
      const denomCapacity = dailyCapacity > 0 ? dailyCapacity : 1;
      const sofaBacklogDays = Math.round((sofaBacklog / denomCapacity) * 10) / 10;
      const bfBacklogDays = Math.round((bfBacklog / denomCapacity) * 10) / 10;
      const totalBacklogDays = Math.round((totalBacklog / denomCapacity) * 10) / 10;

      // Today's / scope's Load — JCs with dueDate in [from, to].
      const sofaScopeLoad = sofaActive
        .filter((jc) => jc.dueDate && jc.dueDate >= scopeFrom && jc.dueDate <= scopeTo)
        .reduce((s, jc) => s + (jc.estMinutes || 0), 0);
      const bfScopeLoad = bfActive
        .filter((jc) => jc.dueDate && jc.dueDate >= scopeFrom && jc.dueDate <= scopeTo)
        .reduce((s, jc) => s + (jc.estMinutes || 0), 0);
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
        last14DayActual,
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
  }, [orders, workers, today, scopeRange]);

  const totalCapacity = capacityData.reduce((s, d) => s + d.dailyCapacity, 0);
  const totalScopeCapacity = capacityData.reduce((s, d) => s + d.scopeCapacity, 0);
  const totalSofaBacklog = capacityData.reduce((s, d) => s + d.sofaBacklog, 0);
  const totalBfBacklog = capacityData.reduce((s, d) => s + d.bfBacklog, 0);
  const totalBacklog = totalSofaBacklog + totalBfBacklog;
  const totalSofaBacklogDays =
    totalCapacity > 0 ? Math.round((totalSofaBacklog / totalCapacity) * 10) / 10 : 0;
  const totalBfBacklogDays =
    totalCapacity > 0 ? Math.round((totalBfBacklog / totalCapacity) * 10) / 10 : 0;
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

  // ── Master Tracker computed values ──
  const deptEfficiency = useMemo(() => getDeptEfficiency(orders), [orders]);

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

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
        <span className="ml-3 text-[#6B7280]">Loading production planning data...</span>
      </div>
    );
  }

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

          {/* Top summary — 4 cards. Daily Capacity is rolling
              14-day avg of actual completed minutes (per Wei Siang
              spec). Load / Utilization / Backlog scoped to the
              selected Daily/Weekly/Monthly window. */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>Daily Capacity</span>
                  <Factory className="h-4 w-4 text-[#6B5C32]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {totalCapacity.toLocaleString()} <span className="text-xs font-medium text-[#6B7280]">min/day</span>
                </p>
                <p className="text-[10px] text-[#9CA3AF] mt-0.5">14-day rolling actual avg</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>{scopeRange.label}&apos;s Load</span>
                  <TrendingUp className="h-4 w-4 text-[#3E6570]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {totalScopeLoad.toLocaleString()} <span className="text-xs font-medium text-[#6B7280]">min</span>
                </p>
                <div className="text-[10px] text-[#9CA3AF] mt-0.5 flex gap-3">
                  <span><span className="font-semibold text-[#9A3A2D]">SOFA</span> {totalSofaScopeLoad.toLocaleString()}</span>
                  <span><span className="font-semibold text-[#3E6570]">BF</span> {totalBfScopeLoad.toLocaleString()}</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>{scopeRange.label}&apos;s Utilization</span>
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
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-[#6B7280] mb-1 flex items-center justify-between">
                  <span>Total Backlog</span>
                  <ClipboardList className="h-4 w-4 text-[#9C6F1E]" />
                </p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {totalBacklogDays} <span className="text-xs font-medium text-[#6B7280]">days</span>
                </p>
                <div className="text-[10px] text-[#9CA3AF] mt-0.5 flex gap-3">
                  <span><span className="font-semibold text-[#9A3A2D]">SOFA</span> {totalSofaBacklogDays}d</span>
                  <span><span className="font-semibold text-[#3E6570]">BF</span> {totalBfBacklogDays}d</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Department capacity cards — each card stacks SOFA + BF
              rows so the operator sees per-category load & backlog
              at a glance. */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {capacityData.map((dept) => {
              const uc = utilizationColor(dept.totalScopeUtilization);
              const backlogColor =
                dept.totalBacklogDays > 7 ? "text-[#9A3A2D]" : dept.totalBacklogDays > 3 ? "text-[#9C6F1E]" : "text-[#4F7C3A]";
              return (
                <Card key={dept.code} className="overflow-hidden">
                  <div className="h-1.5" style={{ backgroundColor: dept.color }} />
                  <CardHeader className="pb-2 pt-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block"
                        style={{ backgroundColor: dept.color }}
                      />
                      {dept.name}
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
                        <p className="font-semibold text-[#1F1D1B]" title="14-day rolling actual avg">
                          {dept.dailyCapacity.toLocaleString()}
                        </p>
                      </div>
                    </div>

                    {/* SOFA row */}
                    <div className="grid grid-cols-3 gap-2 items-baseline">
                      <span className="text-[10px] font-semibold text-[#9A3A2D]">SOFA</span>
                      <div>
                        <span className="text-[9px] text-[#6B7280]">Load · Util</span>
                        <p className="font-medium text-[#1F1D1B]">
                          {dept.sofaScopeLoad.toLocaleString()}
                          <span className={`ml-1.5 ${utilizationColor(dept.sofaScopeUtilization).text}`}>
                            ({dept.sofaScopeUtilization}%)
                          </span>
                        </p>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#6B7280]">Backlog</span>
                        <p className="font-medium text-[#1F1D1B]">{dept.sofaBacklogDays} <span className="text-[9px] text-[#9CA3AF]">d</span></p>
                      </div>
                    </div>

                    {/* BEDFRAME row */}
                    <div className="grid grid-cols-3 gap-2 items-baseline">
                      <span className="text-[10px] font-semibold text-[#3E6570]">BEDFRAME</span>
                      <div>
                        <span className="text-[9px] text-[#6B7280]">Load · Util</span>
                        <p className="font-medium text-[#1F1D1B]">
                          {dept.bfScopeLoad.toLocaleString()}
                          <span className={`ml-1.5 ${utilizationColor(dept.bfScopeUtilization).text}`}>
                            ({dept.bfScopeUtilization}%)
                          </span>
                        </p>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#6B7280]">Backlog</span>
                        <p className="font-medium text-[#1F1D1B]">{dept.bfBacklogDays} <span className="text-[9px] text-[#9CA3AF]">d</span></p>
                      </div>
                    </div>

                    {/* Combined totals + bar */}
                    <div className="pt-2 border-t border-[#E2DDD8]">
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-[10px] text-[#6B7280]">Total Util / Backlog</span>
                        <span className="text-[10px]">
                          <span className={`font-semibold ${uc.text}`}>{dept.totalScopeUtilization}%</span>
                          <span className="mx-1.5 text-[#D1CBC5]">|</span>
                          <span className={`font-semibold ${backlogColor}`}>{dept.totalBacklogDays}d</span>
                        </span>
                      </div>
                      <div className="w-full bg-[#F0ECE9] rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${uc.bar}`}
                          style={{ width: `${Math.min(dept.totalScopeUtilization, 100)}%` }}
                        />
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
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
                All Departments Efficiency Overview
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-9 px-3 text-left font-medium text-[#374151]">Department</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Active</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Completed</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Est Hours</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Actual Hours</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Efficiency %</th>
                      <th className="h-9 px-3 text-left font-medium text-[#374151]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deptEfficiency.map((dept) => (
                      <tr key={dept.code} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dept.color }} />
                            <span className="font-medium text-[#1F1D1B]">{dept.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-[#3E6570]">{dept.active}</td>
                        <td className="px-3 py-2 text-right font-medium text-[#4F7C3A]">{dept.completed}</td>
                        <td className="px-3 py-2 text-right text-[#4B5563]">{dept.totalEstHours.toFixed(1)}h</td>
                        <td className="px-3 py-2 text-right text-[#4B5563]">{dept.totalActualHours.toFixed(1)}h</td>
                        <td className="px-3 py-2 text-right font-bold">{dept.efficiency > 0 ? `${dept.efficiency}%` : "-"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${dept.statusColor}`}>
                            {dept.statusLabel}
                          </span>
                        </td>
                      </tr>
                    ))}
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
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-[#6B5C32]" />
            <span className="text-sm font-medium text-[#1F1D1B]">
              Daily Capacity Loading - Next 4 Weeks
            </span>
            <span className="text-xs text-[#6B7280]">(Mon-Sat, excl. Sundays)</span>
          </div>

          {/* Per-department capacity loading */}
          {capacityDepts.map((dept) => (
            <Card key={dept.deptCode} className="overflow-hidden">
              <div className="h-1" style={{ backgroundColor: dept.color }} />
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: dept.color }} />
                    {dept.deptName}
                  </div>
                  <div className="flex items-center gap-4 text-xs font-normal text-[#6B7280]">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {dept.workerCount} workers
                    </span>
                    <span>{dept.dailyCapacityMinutes.toLocaleString()} min/day capacity</span>
                    <span>({Math.round(dept.dailyCapacityMinutes / 60 * 10) / 10} hrs)</span>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="overflow-x-auto">
                  <div className="flex gap-1" style={{ minWidth: `${dept.dailyLoading.length * 44}px` }}>
                    {dept.dailyLoading.map((day) => {
                      const d = parseDate(day.date);
                      const isSat = d.getDay() === 6;
                      const isToday = day.date === today;

                      let barColor = "bg-[#4F7C3A]";
                      let textColor = "text-[#4F7C3A]";
                      if (day.utilization > 90) { barColor = "bg-[#9A3A2D]"; textColor = "text-[#9A3A2D]"; }
                      else if (day.utilization > 70) { barColor = "bg-[#9C6F1E]"; textColor = "text-[#9C6F1E]"; }

                      // Wei Siang 2026-05-15 audit: bar height now scales
                      // linearly with utilization, capped at 100% of the
                      // 80px container. Critical days (>100%) get the red
                      // colour + the AlertTriangle icon already; no need
                      // to fake a taller bar with the old `* 0.8` fudge.
                      const barHeightPct = Math.min(Math.max(day.utilization, 1), 100);

                      return (
                        <div
                          key={day.date}
                          className={`flex flex-col items-center w-10 min-w-[40px] ${isToday ? "bg-[#6B5C32]/5 rounded" : ""}`}
                          title={`${day.date}\nLoaded: ${day.loadedMinutes} min\nCapacity: ${day.capacityMinutes} min\nUtilization: ${day.utilization}%`}
                        >
                          {/* Bar */}
                          <div className="h-20 w-6 bg-[#F0ECE9] rounded-t-sm relative flex items-end mb-1">
                            <div
                              className={`w-full rounded-t-sm transition-all ${barColor}`}
                              style={{ height: `${barHeightPct}%` }}
                            />
                            {day.utilization > 90 && (
                              <AlertTriangle className="h-2.5 w-2.5 text-[#9A3A2D] absolute -top-3 left-1/2 -translate-x-1/2" />
                            )}
                          </div>
                          {/* Percentage */}
                          <span className={`text-[9px] font-semibold ${textColor}`}>{day.utilization}%</span>
                          {/* Date label */}
                          <span className={`text-[8px] mt-0.5 ${isToday ? "font-bold text-[#6B5C32]" : isSat ? "text-[#6B7280]" : "text-[#9CA3AF]"}`}>
                            {["S","M","T","W","T","F","S"][d.getDay()]}{d.getDate()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Summary stats */}
                <div className="flex items-center gap-6 mt-3 text-xs text-[#6B7280] border-t border-[#E2DDD8] pt-2">
                  <span>
                    Avg Utilization:{" "}
                    <strong className={
                      (dept.dailyLoading.reduce((s, d) => s + d.utilization, 0) / Math.max(dept.dailyLoading.length, 1)) > 90
                        ? "text-[#9A3A2D]"
                        : (dept.dailyLoading.reduce((s, d) => s + d.utilization, 0) / Math.max(dept.dailyLoading.length, 1)) > 70
                          ? "text-[#9C6F1E]"
                          : "text-[#4F7C3A]"
                    }>
                      {Math.round(dept.dailyLoading.reduce((s, d) => s + d.utilization, 0) / Math.max(dept.dailyLoading.length, 1))}%
                    </strong>
                  </span>
                  <span>
                    Peak:{" "}
                    <strong className="text-[#1F1D1B]">
                      {Math.max(...dept.dailyLoading.map((d) => d.utilization))}%
                    </strong>
                  </span>
                  <span>
                    Warning Days:{" "}
                    <strong className="text-[#9C6F1E]">
                      {dept.dailyLoading.filter((d) => d.utilization > 90 && d.utilization <= 100).length}
                    </strong>
                  </span>
                  <span>
                    Critical Days:{" "}
                    <strong className="text-[#9A3A2D]">
                      {dept.dailyLoading.filter((d) => d.utilization > 100).length}
                    </strong>
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}

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
              <span>Formula: Workers x 9hrs x 60min x 0.85 efficiency</span>
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
                      <th className="h-9 px-2 text-left font-medium text-[#374151] sticky left-0 bg-[#F0ECE9] z-10 cursor-pointer" onClick={() => toggleTrackerSort("poNo")}>
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
                        <td colSpan={27} className="py-12 text-center text-[#9CA3AF] text-sm">
                          No production orders match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredTrackerOrders.map((order) => {
                        const overdue = getOverdueDisplay(order);
                        return (
                          <tr
                            key={order.id}
                            className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                            onDoubleClick={() => {
                              if (order.salesOrderId) navigate(`/sales/${order.salesOrderId}`);
                            }}
                          >
                            <td className="px-2 py-1.5 font-medium doc-number sticky left-0 bg-white z-10">
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
                </div>
                <div className="flex items-center gap-3">
                  {ltSavedAt && (
                    <span className="text-xs text-[#6B5C32]">Saved {ltSavedAt}</span>
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
                    disabled={ltSaving || recalcRunning}
                    title="Rewrite every existing production order's job-card dueDates using the saved lead times"
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
    </div>
  );
}
