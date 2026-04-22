import { useEffect, useState, useCallback, useMemo } from "react";
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
} from "lucide-react";

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

const EFFICIENCY = 0.85;
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
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setScheduleData] = useState<ScheduleEntry[]>([]);
  const [capacityDepts, setCapacityDepts] = useState<CapacityDept[]>([]);
  const [, setCapacityDays] = useState<string[]>([]);

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
  const [ltSaving, setLtSaving] = useState(false);
  const [ltSavedAt, setLtSavedAt] = useState<string | null>(null);

  const fetchLeadTimes = useCallback(async () => {
    try {
      const res = await fetch("/api/production/leadtimes");
      const json = await res.json();
      const d = json?.data;
      // Only hydrate when we got the expected shape — stubbed catch-all
      // returns `data: []` which would otherwise poison BEDFRAME/SOFA access.
      if (
        json?.success &&
        d &&
        typeof d === "object" &&
        !Array.isArray(d) &&
        (d.BEDFRAME || d.SOFA)
      ) {
        setLeadTimes({
          BEDFRAME: d.BEDFRAME ?? {},
          SOFA: d.SOFA ?? {},
        });
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchLeadTimes();
  }, [fetchLeadTimes]);

  const updateLeadTime = (cat: LeadTimeCat, deptCode: string, value: string) => {
    const n = Number(value);
    setLeadTimes((prev) => ({
      ...prev,
      [cat]: { ...prev[cat], [deptCode]: Number.isFinite(n) && n >= 0 ? n : 0 },
    }));
  };

  const saveLeadTimes = async () => {
    setLtSaving(true);
    try {
      await fetch("/api/production/leadtimes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leadTimes),
      });
      setLtSavedAt(new Date().toLocaleTimeString());
    } finally {
      setLtSaving(false);
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
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersRes, workersRes, schedRes, capRes] = await Promise.all([
        fetch("/api/production-orders"),
        fetch("/api/workers"),
        fetch("/api/scheduling"),
        fetch("/api/scheduling/capacity"),
      ]);
      const ordersJson = await ordersRes.json();
      const workersJson = await workersRes.json();
      const schedJson = await schedRes.json();
      const capJson = await capRes.json();

      setOrders(ordersJson.data || []);
      setWorkers(workersJson.data || []);
      setScheduleData(schedJson.data || []);
      setCapacityDepts(capJson.data || []);
      setCapacityDays(capJson.days || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Capacity data ──
  const capacityData = useMemo(() => {
    return DEPARTMENTS.map((dept) => {
      const deptWorkers = workers.filter((w) => w.departmentCode === dept.code && w.status === "ACTIVE");
      const workerCount = deptWorkers.length;
      const dailyCapacity = Math.round(workerCount * HOURS_PER_DAY * 60 * EFFICIENCY);

      // Current load: sum estMinutes from active (non-completed, non-cancelled) job cards
      const activeJobs = orders
        .filter((o) => o.status === "IN_PROGRESS" || o.status === "PENDING")
        .flatMap((o) => o.jobCards)
        .filter(
          (jc) =>
            jc.departmentCode === dept.code &&
            jc.status !== "COMPLETED" &&
            jc.status !== "CANCELLED"
        );
      const currentLoad = activeJobs.reduce((sum, jc) => sum + jc.estMinutes, 0);
      const utilization = dailyCapacity > 0 ? Math.round((currentLoad / dailyCapacity) * 100) : 0;

      return { ...dept, workerCount, dailyCapacity, currentLoad, utilization };
    });
  }, [orders, workers]);

  const totalCapacity = capacityData.reduce((s, d) => s + d.dailyCapacity, 0);
  const totalLoad = capacityData.reduce((s, d) => s + d.currentLoad, 0);
  const avgUtilization = totalCapacity > 0 ? Math.round((totalLoad / totalCapacity) * 100) : 0;

  // today (used by Gantt)
  const today = fmtISO(new Date());

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

  function TrackerSortIcon({ field }: { field: TrackerSortField }) {
    if (trackerSortField !== field) return <ChevronUp className="h-3 w-3 text-[#D1CBC5]" />;
    return trackerSortDir === "asc" ? (
      <ChevronUp className="h-3 w-3 text-[#6B5C32]" />
    ) : (
      <ChevronDown className="h-3 w-3 text-[#6B5C32]" />
    );
  }

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
          {/* Summary cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Total Daily Capacity</p>
                  <p className="text-xl font-bold text-[#1F1D1B]">
                    {totalCapacity.toLocaleString()} min
                  </p>
                </div>
                <Factory className="h-5 w-5 text-[#6B5C32]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Total Current Load</p>
                  <p className="text-xl font-bold text-[#1F1D1B]">
                    {totalLoad.toLocaleString()} min
                  </p>
                </div>
                <TrendingUp className="h-5 w-5 text-[#3E6570]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Average Utilization</p>
                  <p className={`text-xl font-bold ${utilizationColor(avgUtilization).text}`}>
                    {avgUtilization}%
                  </p>
                </div>
                <Clock className="h-5 w-5 text-[#6B5C32]" />
              </CardContent>
            </Card>
          </div>

          {/* Department capacity cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {capacityData.map((dept) => {
              const uc = utilizationColor(dept.utilization);
              return (
                <Card key={dept.code} className="overflow-hidden">
                  <div className="h-1.5" style={{ backgroundColor: dept.color }} />
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block"
                        style={{ backgroundColor: dept.color }}
                      />
                      {dept.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pb-4">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-[#6B7280]">Workers</span>
                        <p className="font-semibold text-[#1F1D1B] flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {dept.workerCount}
                        </p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Daily Capacity</span>
                        <p className="font-semibold text-[#1F1D1B]">{dept.dailyCapacity.toLocaleString()} min</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Current Load</span>
                        <p className="font-semibold text-[#1F1D1B]">{dept.currentLoad.toLocaleString()} min</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Utilization</span>
                        <p className={`font-semibold ${uc.text}`}>{dept.utilization}%</p>
                      </div>
                    </div>

                    {/* Utilization bar */}
                    <div className="w-full bg-[#F0ECE9] rounded-full h-2.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${uc.bar}`}
                        style={{ width: `${Math.min(dept.utilization, 100)}%` }}
                      />
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
                      const barHeight = Math.min(day.utilization, 120);

                      let barColor = "bg-[#4F7C3A]";
                      let textColor = "text-[#4F7C3A]";
                      if (day.utilization > 100) { barColor = "bg-[#9A3A2D]"; textColor = "text-[#9A3A2D]"; }
                      else if (day.utilization > 90) { barColor = "bg-[#9A3A2D]"; textColor = "text-[#9A3A2D]"; }
                      else if (day.utilization > 70) { barColor = "bg-[#9C6F1E]"; textColor = "text-[#9C6F1E]"; }

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
                              style={{ height: `${Math.max(barHeight * 0.8, 1)}%` }}
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
                  <option value="ON_HOLD">On Hold</option>
                  <option value="CANCELLED">Cancelled</option>
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
                        <div className="flex items-center gap-1">SO ID <TrackerSortIcon field="poNo" /></div>
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Sales Order</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Cust PO ID</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("customerName")}>
                        <div className="flex items-center gap-1">Customer <TrackerSortIcon field="customerName" /></div>
                      </th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">State</th>
                      <th className="h-9 px-2 text-left font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("productCode")}>
                        <div className="flex items-center gap-1">Product <TrackerSortIcon field="productCode" /></div>
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
                        <div className="flex items-center gap-1">Target End <TrackerSortIcon field="targetEndDate" /></div>
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
                      <th className="h-9 px-2 text-left font-medium text-[#374151]">Stocked In</th>
                      <th className="h-9 px-2 text-right font-medium text-[#374151] cursor-pointer" onClick={() => toggleTrackerSort("progress")}>
                        <div className="flex items-center gap-1 justify-end">Progress <TrackerSortIcon field="progress" /></div>
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
                            onDoubleClick={() => navigate(`/production/${order.id}`)}
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
                            <td className="px-2 py-1.5 text-[#4B5563]">{formatDate(order.targetEndDate)}</td>
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
                  <Button
                    onClick={saveLeadTimes}
                    disabled={ltSaving}
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
                    {LEADTIME_ROWS.map((row) => (
                      <tr key={row.code} className="border-b border-[#E5DFD1]">
                        <td className="px-3 py-2 font-medium text-[#1F1D1B]">
                          {row.label}
                          <span className="ml-2 text-xs text-[#6B5C32]">{row.code}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="number"
                            min="0"
                            value={leadTimes.BEDFRAME[row.code] ?? 0}
                            onChange={(e) =>
                              updateLeadTime("BEDFRAME", row.code, e.target.value)
                            }
                            className="h-8 w-20 rounded border border-[#E5DFD1] px-2 text-center text-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="number"
                            min="0"
                            value={leadTimes.SOFA[row.code] ?? 0}
                            onChange={(e) =>
                              updateLeadTime("SOFA", row.code, e.target.value)
                            }
                            className="h-8 w-20 rounded border border-[#E5DFD1] px-2 text-center text-sm"
                          />
                        </td>
                      </tr>
                    ))}
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
    </div>
  );
}
