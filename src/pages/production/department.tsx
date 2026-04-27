import { useState, useMemo } from "react";
import { z } from "zod";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, Download, Save, Printer, Check, X, Clock, User, Play } from "lucide-react";
import { generateJobCardPdf } from "@/lib/generate-po-pdf";
import { generateStickerPdf, generateBatchStickersPdf } from "@/lib/generate-sticker-pdf";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { fetchJson } from "@/lib/fetch-json";

const POMutationSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
}).passthrough();

type JobCard = {
  id: string; departmentCode: string; departmentName: string; sequence: number;
  status: "WAITING"|"IN_PROGRESS"|"PAUSED"|"COMPLETED"|"TRANSFERRED"|"BLOCKED";
  dueDate: string; prerequisiteMet: boolean;
  pic1Id: string|null; pic1Name: string; pic2Id: string|null; pic2Name: string;
  completedDate: string|null; estMinutes: number; actualMinutes: number|null;
  category: string; productionTimeMinutes: number; overdue: string;
  // WIP grouping (optional for legacy seed data — falls back to "FG")
  wipKey?: string; wipCode?: string; wipType?: string; wipLabel?: string;
};

type ProductionOrder = {
  id: string; poNo: string;
  customerPOId: string; customerReference: string; customerName: string; customerState: string;
  companySOId: string;
  productCode: string; productName: string; itemCategory: string;
  sizeCode: string; sizeLabel: string; fabricCode: string; quantity: number;
  gapInches: number|null; divanHeightInches: number|null; legHeightInches: number|null;
  specialOrder: string; notes: string;
  status: string; progress: number;
  rackingNumber: string;
  jobCards: JobCard[];
};

type Worker = {
  id: string; empNo: string; name: string; departmentCode: string;
};

const DEPT_INFO: Record<string, { name: string; color: string }> = {
  FAB_CUT: { name: "Fabric Cutting", color: "#3B82F6" },
  FAB_SEW: { name: "Fabric Sewing", color: "#6366F1" },
  WOOD_CUT: { name: "Wood Cutting", color: "#F59E0B" },
  FOAM: { name: "Foam Bonding", color: "#8B5CF6" },
  FRAMING: { name: "Framing", color: "#F97316" },
  WEBBING: { name: "Webbing", color: "#10B981" },
  UPHOLSTERY: { name: "Upholstery", color: "#F43F5E" },
  PACKING: { name: "Packing", color: "#06B6D4" },
};

// Due date column header per department (matches Google Sheet tab names)
const DEPT_DD_HEADER: Record<string, string> = {
  FAB_CUT: "Fab Cutting DD",
  FAB_SEW: "Fab Sewing DD",
  WOOD_CUT: "Wood Cutting DD",
  FOAM: "Foaming DD",
  FRAMING: "Framing DD",
  WEBBING: "Webbing DD",
  UPHOLSTERY: "Upholstery DD",
  PACKING: "Packing DD",
};

// Previous department completion date column headers (matching Google Sheet exactly)
const PREV_DEPT: Record<string, string[]> = {
  FAB_CUT: [],
  FAB_SEW: [],
  WOOD_CUT: [],
  FOAM: [],
  FRAMING: ["Wood Cutting CD"],
  WEBBING: ["Framing CD"],
  UPHOLSTERY: ["Fab Sewing CD", "Foaming CD", "Framing CD"],
  PACKING: ["Upholstery CD"],
};

// Previous dept codes to look up
const PREV_DEPT_CODES: Record<string, string[]> = {
  FAB_CUT: [],
  FAB_SEW: [],
  WOOD_CUT: [],
  FOAM: [],
  FRAMING: ["WOOD_CUT"],
  WEBBING: ["FRAMING"],
  UPHOLSTERY: ["FAB_SEW", "FOAM", "FRAMING"],
  PACKING: ["UPHOLSTERY"],
};

// Departments that show "Quantity" column
const SHOW_QTY = ["FRAMING", "UPHOLSTERY", "PACKING"];

// Departments that show "Raw Material Ready"
const SHOW_RAW_MATERIAL = ["FAB_CUT"];

/** Compute overdue text like Google Sheet: "3 DAYS", "ON TIME", etc. */
function computeOverdueText(jc: JobCard): { text: string; color: string } {
  if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") {
    return { text: "-", color: "#9CA3AF" };
  }
  if (!jc.dueDate) {
    return { text: "-", color: "#9CA3AF" };
  }
  const now = new Date();
  const due = new Date(jc.dueDate);
  const diffMs = now.getTime() - due.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return { text: "ON TIME", color: "#16A34A" };
  }
  return { text: `${diffDays} DAY${diffDays > 1 ? "S" : ""}`, color: "#DC2626" };
}

/** Build a rich WIP label from the job card + order so dept dashboards
 *  show something like `8" Divan 5FT` / `HB 6FT` / `Base 1NA` instead of
 *  the synthetic defaults. Falls back to the raw wipLabel then wipCode
 *  then productCode for legacy cards. */
function buildWipDisplay(jc: JobCard, order: ProductionOrder): string {
  // SO confirm (and the seed bootstrap) now resolve wipLabel from the BOM
  // Builder's codeSegments template against the real item data, so the
  // card already carries the user-designed string (e.g. `8" Divan- 6FT`).
  // Legacy fallbacks cover cards created before this wiring existed.
  return jc.wipLabel || jc.wipCode || order.productCode;
}

/** Compute Divan + Leg total display */
function getDivanLegTotal(order: ProductionOrder): string {
  const d = order.divanHeightInches ?? 0;
  const l = order.legHeightInches ?? 0;
  if (d === 0 && l === 0) return "-";
  return `${d + l}"`;
}

function DepartmentDashboard({
  deptCode: _deptCode,
  deptOrders,
  dept,
  allWorkers: _allWorkers,
}: {
  deptCode: string;
  deptOrders: { jc: JobCard; [key: string]: unknown }[];
  dept: { name: string; color: string };
  allWorkers: Worker[];
}) {
  const [dashDateFrom, setDashDateFrom] = useState("");
  const [dashDateTo, setDashDateTo] = useState("");

  // Filter orders by date range (using completedDate on the job card)
  const filteredOrders = deptOrders.filter((row) => {
    const jc = row.jc;
    if (!jc.completedDate) {
      // Include non-completed items only if no date filter is set
      if (!dashDateFrom && !dashDateTo) return true;
      return false;
    }
    const cd = jc.completedDate.slice(0, 10);
    if (dashDateFrom && cd < dashDateFrom) return false;
    if (dashDateTo && cd > dashDateTo) return false;
    return true;
  });

  // Worker performance: aggregate by worker (pic1 and pic2)
  const workerMap = new Map<string, { name: string; ordersCompleted: number; totalMinutes: number; actualMinutes: number }>();

  for (const row of filteredOrders) {
    const jc = row.jc;
    const isCompleted = jc.status === "COMPLETED" || jc.status === "TRANSFERRED";
    if (!isCompleted) continue;

    const workers = [
      { id: jc.pic1Id, name: jc.pic1Name },
      { id: jc.pic2Id, name: jc.pic2Name },
    ];

    for (const w of workers) {
      if (!w.id || !w.name) continue;
      const existing = workerMap.get(w.id) || { name: w.name, ordersCompleted: 0, totalMinutes: 0, actualMinutes: 0 };
      existing.ordersCompleted += 1;
      existing.totalMinutes += jc.estMinutes;
      existing.actualMinutes += jc.actualMinutes || jc.estMinutes;
      workerMap.set(w.id, existing);
    }
  }

  const workerPerformance = Array.from(workerMap.entries())
    .map(([id, data]) => ({
      id,
      ...data,
      efficiency: data.actualMinutes > 0 ? Math.round((data.totalMinutes / data.actualMinutes) * 100) : 0,
    }))
    .sort((a, b) => b.ordersCompleted - a.ordersCompleted);

  // Summary calculations
  const pendingItems = deptOrders.filter((r) => r.jc.status === "WAITING" || r.jc.status === "IN_PROGRESS" || r.jc.status === "PAUSED").length;
  const pendingMinutes = deptOrders
    .filter((r) => r.jc.status === "WAITING" || r.jc.status === "IN_PROGRESS" || r.jc.status === "PAUSED")
    .reduce((sum, r) => sum + r.jc.estMinutes, 0);
  const pendingHours = (pendingMinutes / 60).toFixed(1);

  // Weekly capacity: assume 9 hours/day * 5 days = 45 hours, estimate how many items can be done
  const avgMinutesPerItem = deptOrders.length > 0
    ? deptOrders.reduce((sum, r) => sum + r.jc.estMinutes, 0) / deptOrders.length
    : 60;
  const weeklyCapacityItems = avgMinutesPerItem > 0 ? Math.floor((45 * 60) / avgMinutesPerItem) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: dept.color }} />
          {dept.name} - Performance Dashboard
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Date Range Selector */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-[#6B7280]">Date Range:</span>
          <Input
            type="date"
            value={dashDateFrom}
            onChange={(e) => setDashDateFrom(e.target.value)}
            className="h-8 w-36 text-sm"
          />
          <span className="text-xs text-[#6B7280]">to</span>
          <Input
            type="date"
            value={dashDateTo}
            onChange={(e) => setDashDateTo(e.target.value)}
            className="h-8 w-36 text-sm"
          />
          {(dashDateFrom || dashDateTo) && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setDashDateFrom(""); setDashDateTo(""); }}>
              Clear
            </Button>
          )}
        </div>

        {/* Summary Cards */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div className="rounded-lg border border-[#E2DDD8] p-3 text-center">
            <p className="text-2xl font-bold text-[#9C6F1E]">{pendingItems}</p>
            <p className="text-xs text-[#6B7280]">Pending Items</p>
          </div>
          <div className="rounded-lg border border-[#E2DDD8] p-3 text-center">
            <p className="text-2xl font-bold text-[#3E6570]">{pendingHours}h</p>
            <p className="text-xs text-[#6B7280]">Pending Production Time</p>
          </div>
          <div className="rounded-lg border border-[#E2DDD8] p-3 text-center">
            <p className="text-2xl font-bold text-[#4F7C3A]">{weeklyCapacityItems}</p>
            <p className="text-xs text-[#6B7280]">Weekly Capacity (est. items)</p>
          </div>
        </div>

        {/* Worker Performance Table */}
        {workerPerformance.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Worker Performance</h3>
            <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]" style={{ backgroundColor: dept.color + "15" }}>
                    <th className="h-9 px-3 text-left font-medium text-[#374151]">Worker Name</th>
                    <th className="h-9 px-3 text-right font-medium text-[#374151]">Orders Completed</th>
                    <th className="h-9 px-3 text-right font-medium text-[#374151]">Est. Time (hrs)</th>
                    <th className="h-9 px-3 text-right font-medium text-[#374151]">Actual Time (hrs)</th>
                    <th className="h-9 px-3 text-right font-medium text-[#374151]">Efficiency %</th>
                  </tr>
                </thead>
                <tbody>
                  {workerPerformance.map((w) => (
                    <tr key={w.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                      <td className="px-3 py-2 font-medium text-[#1F1D1B]">{w.name}</td>
                      <td className="px-3 py-2 text-right font-medium">{w.ordersCompleted}</td>
                      <td className="px-3 py-2 text-right text-[#4B5563]">{(w.totalMinutes / 60).toFixed(1)}</td>
                      <td className="px-3 py-2 text-right text-[#4B5563]">{(w.actualMinutes / 60).toFixed(1)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                          w.efficiency >= 95 ? "text-[#4F7C3A] bg-[#EEF3E4]" :
                          w.efficiency >= 80 ? "text-[#3E6570] bg-[#E0EDF0]" :
                          w.efficiency >= 60 ? "text-[#9C6F1E] bg-[#FAEFCB]" :
                          "text-[#9A3A2D] bg-[#F9E1DA]"
                        }`}>
                          {w.efficiency}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {workerPerformance.length === 0 && (
          <p className="text-sm text-[#9CA3AF] text-center py-4">No completed orders with assigned workers in the selected date range.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DepartmentProductionPage() {
  const { code } = useParams();
  const deptCode = (code ?? "").toUpperCase();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: ordersResp, loading } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>("/api/production-orders");
  const { data: workersResp } = useCachedJson<{ success?: boolean; data?: Worker[] }>("/api/workers");
  const fetchedOrders: ProductionOrder[] = useMemo(
    () => (ordersResp?.success ? ordersResp.data ?? [] : Array.isArray(ordersResp) ? ordersResp : []),
    [ordersResp]
  );
  const workers: Worker[] = useMemo(
    () => (workersResp?.success ? workersResp.data ?? [] : Array.isArray(workersResp) ? workersResp : []),
    [workersResp]
  );
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  // Sync cached orders into local state so optimistic mutations keep working.
  const [lastSeenOrders, setLastSeenOrders] = useState<ProductionOrder[] | null>(null);
  if (fetchedOrders !== lastSeenOrders) {
    setLastSeenOrders(fetchedOrders);
    setOrders(fetchedOrders);
  }
  const [saving, setSaving] = useState<string | null>(null);
  const [jobCardDialog, setJobCardDialog] = useState<{ order: ProductionOrder; jc: JobCard } | null>(null);
  // Quick "Mark Done" modal — captures PIC1 (required) + optional PIC2 and
  // auto-stamps completedDate=today on submit. Workflow per the user:
  // PIC and CD are filled at completion time, never pre-assigned.
  const [doneDialog, setDoneDialog] = useState<{
    order: ProductionOrder;
    jc: JobCard;
    pic1Id: string;
    pic2Id: string;
  } | null>(null);

  // Local edits: keyed by jobCard.id
  const [edits, setEdits] = useState<Record<string, {
    pic1Id?: string; pic2Id?: string; completedDate?: string; dueDate?: string;
  }>>({});

  const dept = DEPT_INFO[deptCode] || { name: deptCode, color: "#6B7280" };
  const prevDeptHeaders = PREV_DEPT[deptCode] || [];
  const prevDeptCodes = PREV_DEPT_CODES[deptCode] || [];

  const showQty = SHOW_QTY.includes(deptCode);
  const showRawMaterial = SHOW_RAW_MATERIAL.includes(deptCode);
  const showRack = deptCode === "PACKING";
  const deptDDHeader = DEPT_DD_HEADER[deptCode] || `${dept.name} DD`;

  // List of rack location labels ("A-01", "B-17", …) pulled from warehouse.
  // Only used when showRack is true — lets the Packing user drop a packed
  // item into any rack slot without leaving the dept dashboard.
  // Load warehouse rack slots for the Packing dept dropdown.
  const { data: warehouseResp } = useCachedJson<{ success?: boolean; data?: Array<{ rack: string; position: string; status: string; productCode?: string; customerName?: string }> }>(
    showRack ? "/api/warehouse" : null
  );
  const rackOptions: { label: string; occupied: boolean; occupant?: string }[] = useMemo(() => {
    if (!showRack) return [];
    if (!warehouseResp?.success) return [];
    const locs = (warehouseResp.data || []) as Array<{
      rack: string; position: string; status: string;
      productCode?: string; customerName?: string;
    }>;
    return locs.map((l) => ({
      label: `${l.rack}-${l.position}`,
      occupied: l.status === "OCCUPIED",
      occupant: l.productCode || l.customerName || "",
    }));
  }, [showRack, warehouseResp]);

  // Save rack assignment straight to the PO (no dialog). Updates the local
  // order copy optimistically so the select snaps to the new value.
  const saveRack = async (order: ProductionOrder, rack: string) => {
    setSaving(order.id);
    try {
      const data = await fetchJson(`/api/production-orders/${order.id}`, POMutationSchema, {
        method: "PATCH",
        body: { rackingNumber: rack },
      });
      if (data.success) {
        setOrders((prev) => prev.map((o) => (o.id === order.id ? (data.data as ProductionOrder) : o)));
        invalidateCachePrefix("/api/production-orders");
        invalidateCachePrefix("/api/sales-orders");
      }
    } finally {
      setSaving(null);
    }
  };

  // One row per (PO × JobCard for this dept). A bedframe with Divan + HB
  // both touching FRAMING produces TWO rows; a sofa with arm hitting FOAM
  // produces THREE. Previous-dept lookups are scoped to the SAME WIP so the
  // "prev CD" columns reflect that WIP's chain only (legacy cards without
  // wipKey fall back to "FG").
  const deptOrders = orders
    .flatMap(o => {
      const matching = o.jobCards.filter(jc => jc.departmentCode === deptCode);
      return matching.map(jc => {
        const myKey = jc.wipKey || "FG";
        return {
          ...o,
          jc,
          // Stable per-row key — order id alone collides when one PO has
          // multiple WIP rows in this dept.
          rowKey: `${o.id}__${jc.id}`,
          prevJCs: prevDeptCodes.map(dc =>
            o.jobCards.find(j => j.departmentCode === dc && (j.wipKey || "FG") === myKey)
          ),
        };
      });
    })
    .sort((a, b) => {
      // Sort: IN_PROGRESS first, then WAITING, then COMPLETED
      const statusOrder: Record<string, number> = { IN_PROGRESS: 0, PAUSED: 1, WAITING: 2, BLOCKED: 3, COMPLETED: 4, TRANSFERRED: 5 };
      const sd = (statusOrder[a.jc.status] ?? 9) - (statusOrder[b.jc.status] ?? 9);
      if (sd !== 0) return sd;
      // Within the same status, group by PO so the multi-WIP rows of a PO sit together.
      if (a.id !== b.id) return a.id.localeCompare(b.id);
      return (a.jc.wipKey || "FG").localeCompare(b.jc.wipKey || "FG");
    });

  // PIC dropdown: prefer workers in this dept, but fall back to ALL workers
  // if the dept has no roster (mock data may not have one assigned).
  const deptWorkers = workers.filter(w => w.departmentCode === deptCode);
  const allWorkers = deptWorkers.length > 0 ? deptWorkers : workers;

  const updateEdit = (jcId: string, field: string, value: string) => {
    setEdits(prev => ({
      ...prev,
      [jcId]: { ...prev[jcId], [field]: value },
    }));
  };

  // Quick action: WAITING → IN_PROGRESS. No PIC needed at this stage —
  // PIC is captured at completion time only.
  const startJobCard = async (order: ProductionOrder, jc: JobCard) => {
    setSaving(jc.id);
    try {
      const data = await fetchJson(`/api/production-orders/${order.id}`, POMutationSchema, {
        method: "PUT",
        body: { jobCardId: jc.id, status: "IN_PROGRESS" },
      });
      if (data.success) {
        setOrders(prev => prev.map(o => o.id === order.id ? (data.data as ProductionOrder) : o));
        invalidateCachePrefix("/api/production-orders");
        invalidateCachePrefix("/api/sales-orders");
      }
    } finally {
      setSaving(null);
    }
  };

  // Quick action: any non-completed → COMPLETED. Submits PIC1/PIC2 from the
  // doneDialog state and lets the API stamp completedDate=today.
  const submitDoneDialog = async () => {
    if (!doneDialog) return;
    if (!doneDialog.pic1Id) {
      toast.warning("PIC 1 is required to mark a job card complete.");
      return;
    }
    if (doneDialog.pic2Id && doneDialog.pic2Id === doneDialog.pic1Id) {
      toast.warning("PIC 1 and PIC 2 must be different workers.");
      return;
    }
    const { order, jc, pic1Id, pic2Id } = doneDialog;
    setSaving(jc.id);
    try {
      const data = await fetchJson(`/api/production-orders/${order.id}`, POMutationSchema, {
        method: "PUT",
        body: {
          jobCardId: jc.id,
          status: "COMPLETED",
          pic1Id,
          pic2Id: pic2Id || null,
        },
      });
      if (data.success) {
        setOrders(prev => prev.map(o => o.id === order.id ? (data.data as ProductionOrder) : o));
        invalidateCachePrefix("/api/production-orders");
        invalidateCachePrefix("/api/sales-orders");
        setDoneDialog(null);
      }
    } finally {
      setSaving(null);
    }
  };

  const saveJobCard = async (order: ProductionOrder, jc: JobCard) => {
    const edit = edits[jc.id];
    if (!edit) return;
    setSaving(jc.id);

    const body: Record<string, unknown> = { jobCardId: jc.id };
    if (edit.pic1Id !== undefined) body.pic1Id = edit.pic1Id;
    if (edit.pic2Id !== undefined) body.pic2Id = edit.pic2Id;
    if (edit.dueDate !== undefined) body.dueDate = edit.dueDate;
    if (edit.completedDate) {
      body.status = "COMPLETED";
      body.completedDate = edit.completedDate;
    }

    const data = await fetchJson(`/api/production-orders/${order.id}`, POMutationSchema, {
      method: "PUT",
      body,
    });
    if (data.success) {
      setOrders(prev => prev.map(o => o.id === order.id ? (data.data as ProductionOrder) : o));
      invalidateCachePrefix("/api/production-orders");
      invalidateCachePrefix("/api/sales-orders");
      // Clear edit for this job card
      setEdits(prev => {
        const next = { ...prev };
        delete next[jc.id];
        return next;
      });
    }
    setSaving(null);
  };

  const stats = {
    total: deptOrders.length,
    active: deptOrders.filter(o => o.jc.status === "IN_PROGRESS" || o.jc.status === "PAUSED").length,
    waiting: deptOrders.filter(o => o.jc.status === "WAITING").length,
    completed: deptOrders.filter(o => o.jc.status === "COMPLETED" || o.jc.status === "TRANSFERRED").length,
    overdue: deptOrders.filter(o => {
      const od = computeOverdueText(o.jc);
      return od.color === "#DC2626";
    }).length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: dept.color, borderTopColor: "transparent" }} />
      </div>
    );
  }

  // Compute total column count for empty state
  const colCount = 14 // includes new WIP column
    + (showQty ? 1 : 0)
    + (showRawMaterial ? 1 : 0)
    + (showRack ? 1 : 0)
    + prevDeptHeaders.length
    + 7; // DD, PIC1, PIC2, Completed Date, Overdue, Actions, Production Time

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/production")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 rounded-full" style={{ backgroundColor: dept.color }} />
            <div>
              <h1 className="text-xl font-bold text-[#1F1D1B]">{dept.name}</h1>
              <p className="text-xs text-[#6B7280]">Department production listing - assign PIC & mark completion</p>
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={async () => {
            const pendingOrders = orders.filter(o =>
              o.jobCards.some(jc => jc.departmentCode === deptCode && jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED")
            );
            if (pendingOrders.length === 0) {
              toast.info(`No pending ${dept.name} stickers to print.`);
              return;
            }
            const { generated, skipped } = await generateBatchStickersPdf(pendingOrders, deptCode);
            if (generated === 0) {
              toast.warning(`No stickers generated — no orders have a ${dept.name} job card. Check BOMs.`);
            } else if (skipped > 0) {
              toast.info(`Generated ${generated} stickers, skipped ${skipped} orders without a ${dept.name} job card.`);
            }
          }}
        >
          <Printer className="h-4 w-4" />
          Print Stickers
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-5">
        <Card><CardContent className="p-3 text-center">
          <p className="text-2xl font-bold">{stats.total}</p>
          <p className="text-xs text-[#6B7280]">Total</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <p className="text-2xl font-bold text-[#3E6570]">{stats.active}</p>
          <p className="text-xs text-[#6B7280]">Active</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <p className="text-2xl font-bold text-[#9C6F1E]">{stats.waiting}</p>
          <p className="text-xs text-[#6B7280]">Waiting</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <p className="text-2xl font-bold text-[#4F7C3A]">{stats.completed}</p>
          <p className="text-xs text-[#6B7280]">Completed</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <p className="text-2xl font-bold text-[#9A3A2D]">{stats.overdue}</p>
          <p className="text-xs text-[#6B7280]">Overdue</p>
        </CardContent></Card>
      </div>

      {/* Department Dashboard */}
      <DepartmentDashboard deptCode={deptCode} deptOrders={deptOrders} dept={dept} allWorkers={allWorkers} />

      {/* Job Card Dialog */}
      {jobCardDialog && (() => {
        const { order, jc } = jobCardDialog;
        const overdueInfo = computeOverdueText(jc);
        const sizeMatch = order.sizeLabel.match(/(\d[\d.x]*(?:FT|CM))/i);
        const sizeShort = sizeMatch ? sizeMatch[1] : order.sizeLabel;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setJobCardDialog(null)}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4 p-6" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: dept.color }} />
                  Job Card — {dept.name}
                </h2>
                <Button variant="ghost" size="sm" onClick={() => setJobCardDialog(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

                {/* Order Info */}
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div>
                      <span className="text-[#6B7280]">Customer PO ID</span>
                      <p className="font-medium doc-number">{order.customerPOId || order.poNo}</p>
                    </div>
                    <div>
                      <span className="text-[#6B7280]">Company SO ID</span>
                      <p className="font-medium doc-number">{order.companySOId}</p>
                    </div>
                    <div>
                      <span className="text-[#6B7280]">Customer</span>
                      <p className="font-medium">{order.customerName} ({order.customerState})</p>
                    </div>
                    <div>
                      <span className="text-[#6B7280]">Customer Ref</span>
                      <p className="font-medium">{order.customerReference || "-"}</p>
                    </div>
                  </div>

                  <div className="border-t border-[#E2DDD8] pt-3">
                    <h4 className="text-xs font-semibold text-[#6B7280] uppercase mb-2">Product Details</h4>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                      <div>
                        <span className="text-[#6B7280]">Model</span>
                        <p className="font-medium">{order.productName}</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Category</span>
                        <p className="font-medium">{order.itemCategory}</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Size</span>
                        <p className="font-medium">{sizeShort}</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Fabric / Colour</span>
                        <p className="font-medium doc-number">{order.fabricCode}</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Quantity</span>
                        <p className="font-medium">{order.quantity}</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Racking</span>
                        <p className="font-medium">{order.rackingNumber || "-"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Divan / Leg / Gap */}
                  {(order.gapInches || order.divanHeightInches || order.legHeightInches) && (
                    <div className="border-t border-[#E2DDD8] pt-3">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase mb-2">Specifications</h4>
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div className="rounded-lg border border-[#E2DDD8] p-2 text-center">
                          <p className="text-xs text-[#6B7280]">Gap</p>
                          <p className="text-lg font-bold">{order.gapInches != null ? `${order.gapInches}"` : "-"}</p>
                        </div>
                        <div className="rounded-lg border border-[#E2DDD8] p-2 text-center">
                          <p className="text-xs text-[#6B7280]">Divan</p>
                          <p className="text-lg font-bold">{order.divanHeightInches ? `${order.divanHeightInches}"` : "-"}</p>
                        </div>
                        <div className="rounded-lg border border-[#E2DDD8] p-2 text-center">
                          <p className="text-xs text-[#6B7280]">Leg</p>
                          <p className="text-lg font-bold">{order.legHeightInches ? `${order.legHeightInches}"` : "-"}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Special Order / Notes */}
                  {(order.specialOrder || order.notes) && (
                    <div className="border-t border-[#E2DDD8] pt-3">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase mb-2">Notes</h4>
                      {order.specialOrder && (
                        <p className="text-sm"><span className="text-xs bg-[#F9E1DA] text-[#9A3A2D] px-1.5 py-0.5 rounded">{order.specialOrder.replace(/_/g, " ")}</span></p>
                      )}
                      {order.notes && <p className="text-sm text-[#4B5563] mt-1">{order.notes}</p>}
                    </div>
                  )}

                  {/* Job Card Status */}
                  <div className="border-t border-[#E2DDD8] pt-3">
                    <h4 className="text-xs font-semibold text-[#6B7280] uppercase mb-2">Job Card — {dept.name}</h4>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                      <div>
                        <span className="text-[#6B7280]">Status</span>
                        <div className="mt-0.5"><Badge variant="status" status={jc.status} /></div>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Overdue</span>
                        <p className="font-bold" style={{ color: overdueInfo.color }}>{overdueInfo.text}</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <Clock className="h-4 w-4 text-[#9CA3AF] mt-0.5" />
                        <div>
                          <span className="text-[#6B7280]">Due Date</span>
                          <p className="font-medium">{jc.dueDate ? formatDate(jc.dueDate) : "-"}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <Check className="h-4 w-4 text-[#9CA3AF] mt-0.5" />
                        <div>
                          <span className="text-[#6B7280]">Completed Date</span>
                          <p className="font-medium text-[#4F7C3A]">{jc.completedDate ? formatDate(jc.completedDate) : "-"}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <User className="h-4 w-4 text-[#9CA3AF] mt-0.5" />
                        <div>
                          <span className="text-[#6B7280]">PIC 1</span>
                          <p className="font-medium">{jc.pic1Name || "-"}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <User className="h-4 w-4 text-[#9CA3AF] mt-0.5" />
                        <div>
                          <span className="text-[#6B7280]">PIC 2</span>
                          <p className="font-medium">{jc.pic2Name || "-"}</p>
                        </div>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Est. Time</span>
                        <p className="font-medium">{jc.estMinutes} min ({(jc.estMinutes / 60).toFixed(1)}h)</p>
                      </div>
                      <div>
                        <span className="text-[#6B7280]">Actual Time</span>
                        <p className="font-medium">{jc.actualMinutes != null ? `${jc.actualMinutes} min (${(jc.actualMinutes / 60).toFixed(1)}h)` : "-"}</p>
                      </div>
                    </div>
                  </div>

                  {/* All departments progress */}
                  <div className="border-t border-[#E2DDD8] pt-3">
                    <h4 className="text-xs font-semibold text-[#6B7280] uppercase mb-2">Production Pipeline</h4>
                    <div className="space-y-1.5">
                      {order.jobCards
                        .sort((a, b) => a.sequence - b.sequence)
                        .map((card) => {
                          const cardDept = DEPT_INFO[card.departmentCode] || { name: card.departmentCode, color: "#6B7280" };
                          const isCurrent = card.departmentCode === deptCode;
                          return (
                            <div
                              key={card.id}
                              className={`flex items-center gap-3 rounded-md px-3 py-1.5 text-sm ${isCurrent ? "bg-[#FAF9F7] border border-[#E2DDD8]" : ""}`}
                            >
                              <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: cardDept.color }} />
                              <span className="font-medium w-32">{cardDept.name}</span>
                              <Badge variant="status" status={card.status} />
                              {card.completedDate && (
                                <span className="text-xs text-[#4F7C3A] ml-auto">{formatDate(card.completedDate)}</span>
                              )}
                              {!card.completedDate && card.dueDate && (
                                <span className="text-xs text-[#6B7280] ml-auto">Due: {formatDate(card.dueDate)}</span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  </div>

                  {/* Print buttons */}
                  <div className="border-t border-[#E2DDD8] pt-3 flex gap-2">
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => generateJobCardPdf(order, jc.departmentCode)}
                    >
                      <Download className="h-4 w-4" />
                      Print Job Card
                    </Button>
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => generateStickerPdf(order, jc, orders)}
                    >
                      <Printer className="h-4 w-4" />
                      Print Sticker
                    </Button>
                  </div>
                </div>
            </div>
          </div>
        );
      })()}

      {/* Department Production Table - matches Google Sheet layout */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: dept.color }} />
            {dept.name} - Production Sheet ({deptOrders.length} items)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-[#E2DDD8]" style={{ backgroundColor: dept.color + "15" }}>
                  <th className="h-10 px-3 text-left font-medium text-[#374151] sticky left-0 bg-inherit">#</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Customer PO ID</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Customer Ref</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Customer Name</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Customer State</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Company SO ID</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Model</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">WIP</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Size</th>
                  {showQty && (
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Quantity</th>
                  )}
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Colour</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Gap</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Divan</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Leg</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Total</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Special Order</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Notes</th>
                  {/* Previous department completion dates */}
                  {prevDeptHeaders.map(h => (
                    <th key={h} className="h-10 px-3 text-left font-medium text-[#374151]">{h}</th>
                  ))}
                  {/* This department's due date */}
                  <th className="h-10 px-3 text-left font-medium text-[#374151]" style={{ color: dept.color }}>{deptDDHeader}</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">PIC 1</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">PIC 2</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Completed Date</th>
                  <th className="h-10 px-3 text-center font-medium text-[#374151]">Overdue</th>
                  {showRawMaterial && (
                    <th className="h-10 px-3 text-center font-medium text-[#374151]">Raw Material Ready</th>
                  )}
                  {showRack && (
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Rack</th>
                  )}
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Status</th>
                  <th className="h-10 px-3 text-center font-medium text-[#374151]">Actions</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Production Time</th>
                </tr>
              </thead>
              <tbody>
                {deptOrders.length === 0 ? (
                  <tr><td colSpan={colCount} className="py-8 text-center text-[#9CA3AF]">No production orders for this department</td></tr>
                ) : (
                  deptOrders.map((row, idx) => {
                    const jc = row.jc;
                    const edit = edits[jc.id] || {};
                    const isCompleted = jc.status === "COMPLETED" || jc.status === "TRANSFERRED";
                    const hasEdits = !!edits[jc.id];
                    const overdueInfo = computeOverdueText(jc);
                    const isOverdue = overdueInfo.color === "#DC2626";

                    // Check raw material readiness: all prerequisite departments completed OR first dept
                    const rawMaterialReady = jc.prerequisiteMet;

                    // Divan / Leg display
                    const divanVal = row.divanHeightInches ?? 0;
                    const legVal = row.legHeightInches ?? 0;
                    const divanDisplay = divanVal ? `${divanVal}"` : "-";
                    const legDisplay = legVal ? `${legVal}"` : "-";
                    const totalDisplay = getDivanLegTotal(row);
                    // Extract size suffix (e.g. "Queen 5FT" → "5FT")
                    const sizeMatch = row.sizeLabel.match(/(\d[\d.x]*(?:FT|CM))/i);
                    const sizeShort = sizeMatch ? sizeMatch[1] : row.sizeLabel;

                    // Rich WIP label: uses divan height / size for DIVAN cards so
                    // dept dashboards show `8" Divan 5FT` instead of the synthetic
                    // default. Falls back to legacy wipLabel/wipCode/productCode.
                    const wipDisplay = buildWipDisplay(jc, row);
                    return (
                      <tr
                        key={row.rowKey}
                        className={`border-b border-[#E2DDD8] cursor-pointer ${
                          isCompleted ? "bg-[#EEF3E4]/50" : isOverdue ? "bg-[#F9E1DA]/50" : "hover:bg-[#FAF9F7]"
                        }`}
                        onDoubleClick={() => setJobCardDialog({ order: row, jc })}
                      >
                        <td className="px-3 py-2 text-[#9CA3AF]">{idx + 1}</td>
                        <td className="px-3 py-2 doc-number font-medium">{row.customerPOId || row.poNo}</td>
                        <td className="px-3 py-2 text-[#4B5563]">{row.customerReference || "-"}</td>
                        <td className="px-3 py-2 font-medium text-[#1F1D1B]">{row.customerName}</td>
                        <td className="px-3 py-2 text-[#4B5563]">{row.customerState}</td>
                        <td className="px-3 py-2 doc-number text-[#4B5563]">{row.companySOId}</td>
                        <td className="px-3 py-2 font-medium text-[#1F1D1B]">{row.productName}</td>
                        <td className="px-3 py-2">
                          <span className="inline-block rounded bg-[#E0EDF0] text-[#3E6570] px-1.5 py-0.5 text-xs font-medium">{wipDisplay}</span>
                        </td>
                        <td className="px-3 py-2 text-[#4B5563]">{sizeShort}</td>
                        {showQty && (
                          <td className="px-3 py-2 text-right font-medium">{row.quantity}</td>
                        )}
                        <td className="px-3 py-2 doc-number text-[#4B5563]">{row.fabricCode}</td>
                        <td className="px-3 py-2 text-right text-[#4B5563]">{row.gapInches != null ? `${row.gapInches}"` : "-"}</td>
                        <td className="px-3 py-2 text-right text-[#4B5563]">{divanDisplay}</td>
                        <td className="px-3 py-2 text-right text-[#4B5563]">{legDisplay}</td>
                        <td className="px-3 py-2 text-right font-medium text-[#1F1D1B]">{totalDisplay}</td>
                        <td className="px-3 py-2">
                          {row.specialOrder ? (
                            <span className="text-xs bg-[#F9E1DA] text-[#9A3A2D] px-1.5 py-0.5 rounded">{row.specialOrder.replace(/_/g, " ")}</span>
                          ) : "-"}
                        </td>
                        <td className="px-3 py-2 text-[#6B7280] max-w-[120px] truncate">{row.notes || "-"}</td>

                        {/* Previous dept completion dates */}
                        {row.prevJCs.map((prevJC, pi) => (
                          <td key={pi} className="px-3 py-2 text-[#4B5563]">
                            {prevJC?.completedDate ? (
                              <span className="text-[#4F7C3A]">{formatDate(prevJC.completedDate)}</span>
                            ) : prevJC?.status === "IN_PROGRESS" ? (
                              <span className="text-[#9C6F1E] text-xs">In Progress</span>
                            ) : (
                              <span className="text-[#D1CBC5]">-</span>
                            )}
                          </td>
                        ))}

                        {/* This dept due date (DD column) — editable */}
                        <td className="px-3 py-2">
                          {isCompleted ? (
                            <span className="text-[#4B5563]">
                              {jc.dueDate ? formatDate(jc.dueDate) : "-"}
                            </span>
                          ) : (
                            <Input
                              type="date"
                              value={edit.dueDate ?? jc.dueDate ?? ""}
                              onChange={(e) => updateEdit(jc.id, "dueDate", e.target.value)}
                              className="h-7 w-32 text-xs"
                            />
                          )}
                        </td>

                        {/* PIC 1 */}
                        <td className="px-3 py-2">
                          {isCompleted ? (
                            <span className="text-[#1F1D1B] font-medium">{jc.pic1Name || "-"}</span>
                          ) : (
                            <select
                              value={edit.pic1Id ?? jc.pic1Id ?? ""}
                              onChange={(e) => updateEdit(jc.id, "pic1Id", e.target.value)}
                              className="w-full min-w-[120px] rounded border border-[#E2DDD8] px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                            >
                              <option value="">-</option>
                              {allWorkers.map(w => (
                                <option key={w.id} value={w.id}>{w.name}</option>
                              ))}
                            </select>
                          )}
                        </td>

                        {/* PIC 2 */}
                        <td className="px-3 py-2">
                          {isCompleted ? (
                            <span className="text-[#1F1D1B]">{jc.pic2Name || "-"}</span>
                          ) : (
                            <select
                              value={edit.pic2Id ?? jc.pic2Id ?? ""}
                              onChange={(e) => updateEdit(jc.id, "pic2Id", e.target.value)}
                              className="w-full min-w-[120px] rounded border border-[#E2DDD8] px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                            >
                              <option value="">-</option>
                              {allWorkers.map(w => (
                                <option key={w.id} value={w.id}>{w.name}</option>
                              ))}
                            </select>
                          )}
                        </td>

                        {/* Completed Date */}
                        <td className="px-3 py-2">
                          {isCompleted ? (
                            <span className="text-[#4F7C3A] font-medium">{jc.completedDate ? formatDate(jc.completedDate) : "Done"}</span>
                          ) : (
                            <Input
                              type="date"
                              value={edit.completedDate || ""}
                              onChange={(e) => updateEdit(jc.id, "completedDate", e.target.value)}
                              className="h-7 w-32 text-xs"
                            />
                          )}
                        </td>

                        {/* Overdue */}
                        <td className="px-3 py-2 text-center">
                          <span
                            className="text-xs font-bold"
                            style={{ color: overdueInfo.color }}
                          >
                            {overdueInfo.text}
                          </span>
                        </td>

                        {/* Raw Material Ready (Fabric Cutting only) */}
                        {showRawMaterial && (
                          <td className="px-3 py-2 text-center">
                            {rawMaterialReady ? (
                              <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#EEF3E4]">
                                <Check className="h-4 w-4 text-[#4F7C3A]" />
                              </span>
                            ) : (
                              <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#F9E1DA]">
                                <X className="h-4 w-4 text-[#9A3A2D]" />
                              </span>
                            )}
                          </td>
                        )}

                        {/* Rack (Packing dept only) — multi-rack chip input.
                            A bedframe PO has multiple physical pieces (HB,
                            Divan, Cushion, …) and each piece can land in a
                            different rack; we store the picked racks as a
                            comma-separated string in PO.rackingNumber so
                            downstream views (DO Items, Production Tracker)
                            display the full set "Rack 3, Rack 5" instead of
                            just one rack. Schema unchanged — rackingNumber is
                            already TEXT, just longer now.
                            Click chip × to remove; click dropdown to append. */}
                        {showRack && (() => {
                          const picked = (row.rackingNumber || "")
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                          const pickedSet = new Set(picked);
                          return (
                            <td
                              className="px-3 py-2 align-top"
                              onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex flex-wrap items-center gap-1">
                                {picked.map((rackLabel) => (
                                  <span
                                    key={rackLabel}
                                    className="inline-flex items-center gap-1 rounded-full bg-[#EEF3E4] text-[#4F7C3A] px-2 py-0.5 text-xs"
                                  >
                                    {rackLabel}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const next = picked.filter((r) => r !== rackLabel).join(", ");
                                        void saveRack(row, next);
                                      }}
                                      disabled={saving === row.id}
                                      className="hover:text-[#9A3A2D] disabled:opacity-40"
                                      aria-label={`Remove ${rackLabel}`}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                                <select
                                  value=""
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (!v || pickedSet.has(v)) return;
                                    const next = [...picked, v].join(", ");
                                    void saveRack(row, next);
                                  }}
                                  disabled={saving === row.id}
                                  className="h-7 rounded border border-[#E2DDD8] bg-white px-1.5 text-xs text-[#1F1D1B] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                                >
                                  <option value="">+ Add rack</option>
                                  {rackOptions
                                    .filter((r) => !pickedSet.has(r.label))
                                    .map((r) => (
                                      <option
                                        key={r.label}
                                        value={r.label}
                                        disabled={r.occupied}
                                      >
                                        {r.label}
                                        {r.occupied ? ` (${r.occupant || "used"})` : ""}
                                      </option>
                                    ))}
                                </select>
                              </div>
                            </td>
                          );
                        })()}

                        {/* Status */}
                        <td className="px-3 py-2">
                          <Badge variant="status" status={jc.status} />
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center gap-1 justify-center">
                            {/* WAITING + prerequisite met → quick Start */}
                            {jc.status === "WAITING" && jc.prerequisiteMet && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-xs gap-1"
                                disabled={saving === jc.id}
                                onClick={() => startJobCard(row, jc)}
                                title="Mark this job as started (no PIC needed)"
                              >
                                <Play className="h-3 w-3" />
                                Start
                              </Button>
                            )}
                            {/* Any non-completed → quick Mark Done modal */}
                            {!isCompleted && (
                              <Button
                                variant="primary"
                                size="sm"
                                className="h-6 px-2 text-xs gap-1"
                                disabled={saving === jc.id}
                                onClick={() => setDoneDialog({ order: row, jc, pic1Id: "", pic2Id: "" })}
                                title="Mark as done — fill PIC and stamp today's date"
                              >
                                <Check className="h-3 w-3" />
                                Done
                              </Button>
                            )}
                            {hasEdits && (
                              <Button
                                variant="primary"
                                size="sm"
                                className="h-6 px-2 text-xs gap-1"
                                disabled={saving === jc.id}
                                onClick={() => saveJobCard(row, jc)}
                              >
                                <Save className="h-3 w-3" />
                                {saving === jc.id ? "..." : "Save"}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5"
                              onClick={() => generateJobCardPdf(row, jc.departmentCode)}
                              title="Print Job Card"
                            >
                              <Download className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5"
                              onClick={() => generateStickerPdf(row, jc, orders)}
                              title="Print Sticker"
                            >
                              <Printer className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>

                        {/* Production Time (from BOM) */}
                        <td className="px-3 py-2 text-right text-[#4B5563] doc-number">
                          {jc.productionTimeMinutes != null
                            ? `${jc.productionTimeMinutes} min`
                            : jc.estMinutes != null
                            ? `${jc.estMinutes} min`
                            : "-"}
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

      {/* Mark Done modal — captures PIC1 (required) + PIC2 (optional).
          Submit auto-stamps completedDate=today on the API side. Backdrop
          click and Cancel button both dismiss without saving. */}
      {doneDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setDoneDialog(null)}
          />
          <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-[#1F1D1B]">
                Mark Job Card Done
              </h3>
              <button
                onClick={() => setDoneDialog(null)}
                className="text-[#9CA3AF] hover:text-[#374151]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-1 text-xs text-[#6B7280]">
              <div>
                <span className="text-[#9CA3AF]">PO:</span>{" "}
                <span className="font-mono text-[#6B5C32]">{doneDialog.order.poNo}</span>
                {"  "}
                <span className="text-[#9CA3AF]">Customer:</span>{" "}
                <span className="text-[#1F1D1B]">{doneDialog.order.customerName}</span>
              </div>
              <div>
                <span className="text-[#9CA3AF]">Product:</span>{" "}
                <span className="text-[#1F1D1B]">{doneDialog.order.productName}</span>
                {"  "}
                <span className="text-[#9CA3AF]">Size:</span>{" "}
                <span className="text-[#1F1D1B]">{doneDialog.order.sizeLabel}</span>
                {"  "}
                <span className="text-[#9CA3AF]">Qty:</span>{" "}
                <span className="text-[#1F1D1B]">{doneDialog.order.quantity}</span>
              </div>
              <div className="pt-1 text-[#9C6F1E]">
                Completed Date will be stamped as today ({new Date().toISOString().slice(0, 10)}).
              </div>
            </div>
            <div className="space-y-3 pt-2">
              <div>
                <label className="text-xs font-medium text-[#374151] block mb-1">
                  PIC 1 <span className="text-[#9A3A2D]">*</span>
                </label>
                <select
                  value={doneDialog.pic1Id}
                  onChange={(e) =>
                    setDoneDialog({ ...doneDialog, pic1Id: e.target.value })
                  }
                  className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30"
                >
                  <option value="">Select worker…</option>
                  {allWorkers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] block mb-1">
                  PIC 2 <span className="text-[#9CA3AF]">(optional)</span>
                </label>
                <select
                  value={doneDialog.pic2Id}
                  onChange={(e) =>
                    setDoneDialog({ ...doneDialog, pic2Id: e.target.value })
                  }
                  className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30"
                >
                  <option value="">— none —</option>
                  {allWorkers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDoneDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitDoneDialog}
                disabled={!doneDialog.pic1Id || saving === doneDialog.jc.id}
              >
                <Check className="h-4 w-4" />
                {saving === doneDialog.jc.id ? "Saving…" : "Mark Done"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
