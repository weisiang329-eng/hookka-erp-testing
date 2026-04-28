import { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDate, formatDateDMY, formatRM } from "@/lib/utils";
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
  position: string;
  phone: string;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier?: number;
  joinDate: string;
  icNumber: string;
  passportNumber: string;
  nationality: string;
};

type PayslipData = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  departmentCode: string;
  period: string;
  basicSalary: number;
  workingDays: number;
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

function formatHours(minutes: number): string {
  if (minutes <= 0) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
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

type EntryDraft = {
  id?: string;                 // undefined = new draft; defined = persisted
  workerId: string;
  departmentCode: string;
  category: Category;
  hours: number;
  notes: string;
  saving: boolean;
  saved: boolean;
  saveError?: string;
};

function WorkingHoursTab({
  workers,
  refreshAttendance,
  departments,
  productionDeptCodes,
}: {
  workers: Worker[];
  attendance: AttendanceRecord[];
  refreshAttendance: (date: string) => void;
  departments: DepartmentLite[];
  productionDeptCodes: Set<string>;
}) {
  // Fall back to seed if API hasn't loaded — avoids dropdown flash on first
  // render. After /api/departments resolves, the prop wins and any new
  // dept added via the Manage Departments UI on Labor Cost shows up here too.
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const prodCodes = productionDeptCodes.size > 0 ? productionDeptCodes : PRODUCTION_DEPT_CODES;
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [rows, setRows] = useState<EntryDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/working-hour-entries?date=${selectedDate}`);
      const j = (await res.json()) as { success?: boolean; data?: WorkingHourEntry[] };
      const drafts: EntryDraft[] = (j?.data ?? []).map((e) => ({
        id: e.id,
        workerId: e.workerId,
        departmentCode: e.departmentCode,
        category: e.category,
        hours: e.hours,
        notes: e.notes,
        saving: false,
        saved: true,
      }));
      setRows(drafts);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

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
        departmentCode: "",
        category: "",
        hours: 0,
        notes: "",
        saving: false,
        saved: false,
      },
    ]);
  }, []);

  const duplicateRow = useCallback((idx: number) => {
    setRows((prev) => {
      const src = prev[idx];
      if (!src) return prev;
      const copy = [...prev];
      // Insert a new draft right after the source row, pre-filled with the
      // same worker — common case is "same person, different segment".
      copy.splice(idx + 1, 0, {
        workerId: src.workerId,
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
      // Persisted — DELETE on server first; pop from local state on success.
      try {
        const res = await fetch(`/api/working-hour-entries/${row.id}`, { method: "DELETE" });
        if (!res.ok) {
          patchRow(idx, { saveError: `Delete failed: HTTP ${res.status}` });
          return;
        }
      } catch (e) {
        patchRow(idx, { saveError: e instanceof Error ? e.message : "Delete failed" });
        return;
      }
    }
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }, [rows, patchRow]);

  const saveRow = useCallback(async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    if (!row.workerId || !row.departmentCode) {
      patchRow(idx, { saveError: "Employee and department are required" });
      return;
    }
    if (prodCodes.has(row.departmentCode) && !row.category) {
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
        ? { departmentCode: row.departmentCode, category: row.category, hours: row.hours, notes: row.notes }
        : {
            workerId: row.workerId,
            date: selectedDate,
            departmentCode: row.departmentCode,
            category: row.category,
            hours: row.hours,
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
      if (!row.id) refreshAttendance(selectedDate);
    } catch (e) {
      patchRow(idx, {
        saving: false,
        saveError: e instanceof Error ? e.message : "Save failed",
      });
    }
  }, [rows, selectedDate, patchRow, refreshAttendance, prodCodes]);

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

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-[#6B5C32]" /> Daily Working Hours
          </CardTitle>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-44"
            />
            <Button variant="outline" onClick={addRow}>
              <Plus className="h-4 w-4" /> Add Row
            </Button>
            <Button variant="primary" onClick={saveAll} disabled={bulkSaving || dirtyCount === 0}>
              <Save className="h-4 w-4" />
              {bulkSaving ? "Saving…" : dirtyCount > 0 ? `Save All (${dirtyCount})` : "Saved"}
            </Button>
          </div>
        </div>
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
        <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                <th className="h-10 px-3 text-left font-medium text-[#374151]">Employee</th>
                <th className="h-10 px-3 text-left font-medium text-[#374151]">Department</th>
                <th className="h-10 px-3 text-left font-medium text-[#374151]">Category</th>
                <th className="h-10 px-3 text-left font-medium text-[#374151] w-24">Hours</th>
                <th className="h-10 px-3 text-left font-medium text-[#374151]">Notes</th>
                <th className="h-10 px-3 text-left font-medium text-[#374151] w-44">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={6} className="h-20 text-center text-[#9CA3AF]">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="h-20 text-center text-[#9CA3AF]">
                    No entries for {selectedDate}. Click <span className="font-medium">+ Add Row</span> to start.
                  </td>
                </tr>
              )}
              {rows.map((row, idx) => {
                const isProd = prodCodes.has(row.departmentCode);
                return (
                  <tr key={row.id ?? `new-${idx}`} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                    <td className="px-3 py-1.5">
                      <select
                        value={row.workerId}
                        onChange={(e) => updateField(idx, { workerId: e.target.value })}
                        className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                      >
                        <option value="">— select worker —</option>
                        {workers
                          .filter((w) => w.status === "ACTIVE")
                          .map((w) => (
                            <option key={w.id} value={w.id}>{w.name}</option>
                          ))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        value={row.departmentCode}
                        onChange={(e) => updateField(idx, { departmentCode: e.target.value })}
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
                        onChange={(e) => updateField(idx, { category: e.target.value as Category })}
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
                    <td className="px-3 py-1.5">
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={row.hours}
                        onChange={(e) => updateField(idx, { hours: Number(e.target.value) })}
                        className="h-8 w-20 text-xs"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        value={row.notes}
                        onChange={(e) => updateField(idx, { notes: e.target.value })}
                        placeholder="e.g. PO-1234"
                        className="h-8 text-xs"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => saveRow(idx)}
                          disabled={row.saving}
                          className={row.saved ? "border-[#C6DBA8] text-[#4F7C3A]" : ""}
                        >
                          {row.saving ? "…" : row.saved ? "Saved" : "Save"}
                        </Button>
                        <button
                          type="button"
                          onClick={() => duplicateRow(idx)}
                          className="inline-flex items-center justify-center h-7 w-7 rounded text-[#6B5C32] hover:bg-[#F0ECE9]"
                          title="Duplicate (same worker, new segment)"
                          aria-label="Duplicate row"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeRow(idx)}
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
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ========== TAB 2: EMPLOYEE MASTER ==========

type WorkerFormData = {
  empNo: string;
  name: string;
  departmentId: string;
  position: string;
  phone: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number;
  joinDate: string;
  nationality: string;
  status: string;
};

const emptyForm: WorkerFormData = {
  empNo: "",
  name: "",
  departmentId: "dept-1",
  position: "Worker",
  phone: "",
  basicSalarySen: 180000,
  workingHoursPerDay: 9,
  workingDaysPerMonth: 26,
  otMultiplier: 1.5,
  joinDate: todayStr(),
  nationality: "",
  status: "ACTIVE",
};

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
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<WorkerFormData>({ ...emptyForm });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<WorkerFormData>({ ...emptyForm });
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    setSaving(true);
    try {
      await fetch("/api/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
      position: w.position,
      phone: w.phone,
      basicSalarySen: w.basicSalarySen,
      workingHoursPerDay: w.workingHoursPerDay,
      workingDaysPerMonth: w.workingDaysPerMonth,
      otMultiplier: w.otMultiplier ?? 1.5,
      joinDate: w.joinDate,
      nationality: w.nationality,
      status: w.status,
    });
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await fetch(`/api/workers/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      setEditingId(null);
      refreshWorkers();
    } catch {
      // handle error
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this employee?")) return;
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
        label: "Department",
        sortable: true,
        render: (_value, row) =>
          editingId === row.id ? (
            <select
              value={editForm.departmentId}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, departmentId: e.target.value }))
              }
              className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            >
              {allDepts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[#4B5563]">
              {allDepts.find((d) => d.id === row.departmentId)?.name ||
                row.departmentCode}
            </span>
          ),
      },
      {
        key: "position",
        label: "Position",
        render: (_value, row) =>
          editingId === row.id ? (
            <Input
              value={editForm.position}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, position: e.target.value }))
              }
              className="h-8 w-24 text-xs"
            />
          ) : (
            <span className="text-[#4B5563]">{row.position}</span>
          ),
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
              type="number"
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
              type="number"
              value={editForm.workingHoursPerDay}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  workingHoursPerDay: parseInt(e.target.value) || 0,
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
              type="number"
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
              type="number"
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
            <select
              value={editForm.status}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, status: e.target.value }))
              }
              className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            >
              <option value="ACTIVE">ACTIVE</option>
              <option value="INACTIVE">INACTIVE</option>
            </select>
          ) : (
            <Badge variant="status" status={row.status} />
          ),
      },
      {
        key: "_actions",
        label: "Actions",
        width: "90px",
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
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(row.id)}
                className="text-[#9A3A2D] hover:text-[#7A2E24]"
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
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[#6B5C32]" /> Employee Master
          </CardTitle>
          <Button
            variant="primary"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            <Plus className="h-4 w-4" />
            {showAddForm ? "Cancel" : "Add Employee"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Inline Add Form */}
        {showAddForm && (
          <div className="mb-6 rounded-lg border border-[#6B5C32]/30 bg-[#F0ECE9] p-4">
            <h4 className="mb-3 text-sm font-semibold text-[#1F1D1B]">
              New Employee
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
              <div>
                <label className="text-xs text-[#6B7280]">Department</label>
                <select
                  value={form.departmentId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, departmentId: e.target.value }))
                  }
                  className="flex h-8 w-full rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  {allDepts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-[#6B7280]">Position</label>
                <Input
                  value={form.position}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, position: e.target.value }))
                  }
                  placeholder="Worker"
                  className="h-8 text-xs"
                />
              </div>
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
                  type="number"
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
                  type="number"
                  value={form.workingHoursPerDay}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      workingHoursPerDay: parseInt(e.target.value) || 0,
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
                  type="number"
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
          onDoubleClick={(row) => toast.info(`Opening details for ${row.name}`)}
          emptyMessage="No employees found."
        />
      </CardContent>
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
}: {
  workers: Worker[];
  departments: DepartmentLite[];
}) {
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState(todayStr());

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

  // Workers without any entries in the period are NOT in the summary
  // response — join client-side to enrich names, drop unknown ids.
  const workerById = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  type EffRow = WorkerHoursSummary & { employeeName: string; empNo: string };
  const rows: EffRow[] = useMemo(() => {
    return summary
      .map((s) => {
        const w = workerById.get(s.workerId);
        return {
          ...s,
          employeeName: w?.name ?? s.workerId,
          empNo: w?.empNo ?? "",
        };
      })
      .sort((a, b) => b.totalHours - a.totalHours);
  }, [summary, workerById]);

  const columns: Column<EffRow>[] = useMemo(() => {
    const cols: Column<EffRow>[] = [
      {
        key: "employeeName",
        label: "Employee",
        sortable: true,
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
        render: (_value, row) => (
          <span className="font-semibold tabular-nums text-[#1F1D1B]">
            {row.totalHours.toFixed(1)}h
          </span>
        ),
      },
    ];

    for (const d of orderedDepts) {
      cols.push({
        key: `dept_${d.code}`,
        label: d.shortName || d.name,
        align: "right",
        sortable: true,
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
  }, [orderedDepts]);

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
      action: () => {},
      separator: true,
    },
  ];

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
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DataGrid
          columns={columns}
          data={rows}
          keyField="workerId"
          gridId="employees-efficiency"
          contextMenuItems={contextMenuItems}
          onDoubleClick={(row) => toast.info(`Viewing details for ${row.employeeName}`)}
          emptyMessage={summaryLoading ? "Loading…" : "No working hours recorded for the selected date range."}
        />
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
  completedDate: string | null;
  productionTimeMinutes: number;
  status: string;
  picSlot: "PIC1" | "PIC2" | "";
};

function EmployeeDetailTab({
  workers,
  allAttendance,
}: {
  workers: Worker[];
  allAttendance: AttendanceRecord[];
}) {
  const { toast } = useToast();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(
    workers[0]?.id || ""
  );
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState(todayStr());

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

  // Filter attendance for this employee and date range (client-side) —
  // still needed for the Daily Breakdown table and for OT.
  const empRecords = useMemo(
    () =>
      allAttendance
        .filter(
          (a) =>
            a.employeeId === selectedEmployeeId &&
            a.date >= dateFrom &&
            a.date <= dateTo
        )
        .sort((a, b) => b.date.localeCompare(a.date)),
    [allAttendance, selectedEmployeeId, dateFrom, dateTo]
  );

  // Total working hours from the new entries source. Sum decimal hours,
  // convert to minutes once for downstream math (efficiency ratio, etc).
  const totalWorkMins = Math.round(
    workerEntries.reduce((s, e) => s + (e.hours || 0), 0) * 60
  );
  const totalProdMinsAttendance = empRecords.reduce(
    (s, r) => s + r.productionTimeMinutes,
    0
  );
  // Job-card production minutes — halve PIC2 contribution to match the
  // existing convention used elsewhere (PIC2 is "assist", not solo work).
  const totalProdMinsJc = useMemo(() => {
    return workerJcs.reduce((s, r) => {
      const m = r.productionTimeMinutes || 0;
      return s + (r.picSlot === "PIC2" ? m / 2 : m);
    }, 0);
  }, [workerJcs]);
  // Production Hrs stays attendance + JC: working_hour_entries records
  // total time on a dept (incl. setup, breaks, idle), not the per-product
  // production minutes the JC + attendance pair tracks. Mixing them would
  // make Production Hrs > Working Hrs in the common new-grid case.
  const totalProdMins = totalProdMinsAttendance + totalProdMinsJc;
  const avgEff =
    totalWorkMins > 0
      ? ((totalProdMins / totalWorkMins) * 100).toFixed(1)
      : null;
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
    minutes: number;
    status: string;
    source: "ATT" | "JC";
    picSlot?: "PIC1" | "PIC2" | "";
  };
  const itemRows: ItemRow[] = useMemo(() => {
    const out: ItemRow[] = [];
    for (const r of empRecords) {
      if (!r.deptBreakdown || r.deptBreakdown.length === 0) continue;
      r.deptBreakdown.forEach((b, i) => {
        out.push({
          id: `att-${r.id}-${i}`,
          date: r.date,
          productCode: b.productCode || "—",
          wipLabel: "",
          completedDate: null,
          deptCode: b.deptCode,
          minutes: b.minutes,
          status: r.status,
          source: "ATT",
        });
      });
    }
    for (const jc of workerJcs) {
      if (!jc.completedDate) continue;
      out.push({
        id: `jc-${jc.id}`,
        date: jc.completedDate,
        productCode: jc.productCode || jc.wipCode || "—",
        wipLabel: jc.wipLabel || "",
        completedDate: jc.completedDate,
        deptCode: jc.departmentCode || "—",
        minutes: jc.productionTimeMinutes || 0,
        status: jc.status,
        source: "JC",
        picSlot: jc.picSlot,
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
      render: (_v, row) => (
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="font-medium text-[#1F1D1B]">{row.productCode}</span>
            {row.source === "JC" && (
              <span
                className="inline-flex items-center rounded-sm bg-[#E0EDF0] px-1 text-[10px] font-semibold text-[#3E6570]"
                title={`From job card${row.picSlot ? ` (${row.picSlot})` : ""}`}
              >
                JC
              </span>
            )}
          </span>
          {row.wipLabel && row.wipLabel !== row.productCode && (
            <span className="text-[10px] text-[#6B7280]">{row.wipLabel}</span>
          )}
        </div>
      ),
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
      key: "minutes",
      label: "Production Time",
      align: "right",
      sortable: true,
      render: (_v, row) => (
        <span className="font-medium tabular-nums">{formatHours(row.minutes)}</span>
      ),
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
      action: () => {},
      separator: true,
    },
  ];

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
          </div>
        </CardContent>
      </Card>

      {/* Employee Info Card */}
      {selectedWorker && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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

      {/* Summary Stats */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-5">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#1F1D1B]">{daysPresent}</p>
            <p className="text-xs text-[#6B7280]">Days Present</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {(totalWorkMins / 60).toFixed(1)}h
            </p>
            <p className="text-xs text-[#6B7280]">Total Working Hrs</p>
            {jcCount > 0 && (
              <p className="mt-0.5 text-[10px] text-[#3E6570]">+{jcCount} JC completions</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {(totalProdMins / 60).toFixed(1)}h
            </p>
            <p className="text-xs text-[#6B7280]">Total Production Hrs</p>
            {totalProdMinsJc > 0 && (
              <p className="mt-0.5 text-[10px] text-[#3E6570]">
                {(totalProdMinsAttendance / 60).toFixed(1)}h att + {(totalProdMinsJc / 60).toFixed(1)}h jc
              </p>
            )}
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
              <p className="text-2xl font-bold text-[#9CA3AF]" title="No working hours recorded in range — efficiency requires hours to compare against.">
                —
              </p>
            )}
            <p className="text-xs text-[#6B7280]">Avg Efficiency</p>
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

// ========== TAB 5: PAYROLL ==========

function PayrollTab({ workers: _workers }: { workers: Worker[] }) {
  const { toast } = useToast();
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;

  const { data: payslipResp, loading: loadingPayroll, refresh: refreshPayslipsHook } = useCachedJson<unknown>(`/api/payslips?period=${period}`);
  const payslipData: PayslipData[] = useMemo(() => asArray(payslipResp) as PayslipData[], [payslipResp]);
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
        basicSalary: 0, otWeekdayHours: 0, otSundayHours: 0, otPHHours: 0,
        totalOT: 0, allowances: 0, grossPay: 0, epfEmployee: 0, epfEmployer: 0,
        socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0,
        pcb: 0, totalDeductions: 0, netPay: 0,
      }
    );
  }, [payslipData]);

  const totalPayrollCost = useMemo(() => {
    return totals.grossPay + totals.epfEmployer + totals.socsoEmployer + totals.eisEmployer;
  }, [totals]);

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

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
      "OT Weekday Hrs", "OT Sunday Hrs", "OT PH Hrs", "Hourly Rate",
      "OT Weekday Amt", "OT Sunday Amt", "OT PH Amt", "Total OT", "Allowances",
      "Gross Pay", "EPF EE (11%)", "EPF ER (13%)", "SOCSO EE", "SOCSO ER",
      "EIS EE", "EIS ER", "PCB", "Total Deductions", "Net Pay", "Bank Account", "Status",
    ];
    const rows = payslipData.map((r) => [
      r.employeeNo, r.employeeName, r.departmentCode, (r.basicSalary / 100).toFixed(2),
      r.workingDays, r.otWeekdayHours, r.otSundayHours, r.otPHHours,
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

  return (
    <div className="space-y-4">
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
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-[#6B5C32]" /> Payroll Processing - {months[selectedMonth - 1]} {selectedYear}
            </CardTitle>
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
              {payslipData.length === 0 && (
                <Button variant="primary" onClick={generatePayslips} disabled={generating}>
                  <DollarSign className="h-4 w-4" />
                  {generating ? "Generating..." : "Generate Payslips"}
                </Button>
              )}
              {payslipData.length > 0 && payslipData.some((r) => r.status === "DRAFT") && (
                <Button variant="primary" onClick={approveAll} disabled={approving}>
                  <Check className="h-4 w-4" />
                  {approving ? "Approving..." : "Approve All"}
                </Button>
              )}
              {payslipData.length > 0 && (
                <Button variant="outline" onClick={exportCSV}>
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingPayroll ? (
            <div className="flex items-center justify-center h-32 text-[#6B7280]">Loading payroll data...</div>
          ) : payslipData.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[#6B7280]">
              <p>No payslip records for {months[selectedMonth - 1]} {selectedYear}.</p>
              <p className="text-xs mt-1">Click &quot;Generate Payslips&quot; to calculate payroll with Malaysian statutory deductions.</p>
            </div>
          ) : (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-2 text-left font-medium text-[#374151] w-8"></th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Employee</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Basic (RM)</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151]">Days</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">OT Wk</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">OT Sun</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">OT PH</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">OT Amt</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Gross</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">EPF EE</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">EPF ER</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">SOCSO</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">EIS</th>
                    <th className="h-10 px-2 text-right font-medium text-[#374151]">PCB</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Net Pay</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151]">Status</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151]">Print</th>
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
                        <td className="h-10 px-3">
                          <div className="font-medium text-[#1F1D1B]">{r.employeeName}</div>
                          <div className="text-[10px] text-[#9CA3AF]">{r.employeeNo} - {r.departmentCode.replace(/_/g, " ")}</div>
                        </td>
                        <td className="h-10 px-3 text-right">{formatCurrency(r.basicSalary)}</td>
                        <td className="h-10 px-2 text-center">{r.workingDays}</td>
                        <td className="h-10 px-2 text-right">{r.otWeekdayHours}h</td>
                        <td className="h-10 px-2 text-right">{r.otSundayHours > 0 ? `${r.otSundayHours}h` : "-"}</td>
                        <td className="h-10 px-2 text-right">{r.otPHHours > 0 ? `${r.otPHHours}h` : "-"}</td>
                        <td className="h-10 px-3 text-right font-medium text-[#6B5C32]">{formatCurrency(r.totalOT)}</td>
                        <td className="h-10 px-3 text-right font-semibold">{formatCurrency(r.grossPay)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(r.epfEmployee)}</td>
                        <td className="h-10 px-2 text-right text-[#3E6570] text-xs">{formatCurrency(r.epfEmployer)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(r.socsoEmployee)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(r.eisEmployee)}</td>
                        <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{r.pcb > 0 ? formatCurrency(r.pcb) : "-"}</td>
                        <td className="h-10 px-3 text-right font-bold text-[#1F1D1B]">{formatCurrency(r.netPay)}</td>
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
                          <td colSpan={17} className="px-6 py-4">
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
                    <td className="h-10 px-2 text-right">{totals.otWeekdayHours}h</td>
                    <td className="h-10 px-2 text-right">{totals.otSundayHours > 0 ? `${totals.otSundayHours}h` : "-"}</td>
                    <td className="h-10 px-2 text-right">{totals.otPHHours > 0 ? `${totals.otPHHours}h` : "-"}</td>
                    <td className="h-10 px-3 text-right text-[#6B5C32]">{formatCurrency(totals.totalOT)}</td>
                    <td className="h-10 px-3 text-right">{formatCurrency(totals.grossPay)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(totals.epfEmployee)}</td>
                    <td className="h-10 px-2 text-right text-[#3E6570] text-xs">{formatCurrency(totals.epfEmployer)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(totals.socsoEmployee)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{formatCurrency(totals.eisEmployee)}</td>
                    <td className="h-10 px-2 text-right text-[#9A3A2D] text-xs">{totals.pcb > 0 ? formatCurrency(totals.pcb) : "-"}</td>
                    <td className="h-10 px-3 text-right font-bold">{formatCurrency(totals.netPay)}</td>
                    <td className="h-10 px-2"></td>
                    <td className="h-10 px-2"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* OT Rate Reference */}
          <div className="mt-4 p-3 rounded-lg bg-[#F0ECE9] text-xs text-[#6B7280]">
            <span className="font-semibold text-[#1F1D1B]">Malaysian Statutory Rates:</span>{" "}
            EPF Employee 11% | EPF Employer 13% (on basic salary) &nbsp;&bull;&nbsp;
            SOCSO EE ~RM7.45 | SOCSO ER ~RM26.15 &nbsp;&bull;&nbsp;
            EIS EE ~RM3.90 | EIS ER ~RM3.90 &nbsp;&bull;&nbsp;
            <br className="sm:hidden" />
            <span className="font-semibold text-[#1F1D1B]">OT Rates:</span>{" "}
            Weekday 1.5x | Sunday 2.0x | Public Holiday 3.0x &nbsp;&bull;&nbsp;
            <span className="font-semibold text-[#1F1D1B]">Hourly Rate</span> = Monthly Salary / (26 days x 9 hrs)
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

// Calendar-based working days for the period — Mon–Sat in the actual month,
// Sundays excluded. Replaces the earlier fixed-26 baseline so months with
// extra Saturdays (27 days) or short Februarys (24 days) are reflected
// faithfully in the hourly rate. Falls back to 26 on bad input so the rate
// calc never divides by zero.
function workingDaysInMonth(period: string): number {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return 26;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0) count++;
  }
  return count;
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
    if (!confirm(`Delete department "${d.name}" (${d.code})?\n\nThis only succeeds if no worker is assigned to it. Cannot be undone.`)) return;
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
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-[#1F1D1B]">Manage Departments</h4>
        <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-3.5 w-3.5" /> {creating ? "Cancel" : "Add Department"}
        </Button>
      </div>
      {creating && (
        <div className="mb-3 rounded border border-[#6B5C32]/30 bg-white p-3 grid grid-cols-2 md:grid-cols-7 gap-2">
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
            <Input type="number" value={draft.sequence} onChange={(e) => setDraft((d) => ({ ...d, sequence: parseInt(e.target.value) || 0 }))} className="h-8 text-xs" />
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
                      ? <Input type="number" value={editDraft.sequence ?? 0} onChange={(e) => setEditDraft((p) => p ? { ...p, sequence: parseInt(e.target.value) || 0 } : p)} className="h-7 w-12 text-xs" />
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
  refreshDepartments,
}: {
  workers: Worker[];
  departments: DepartmentLite[];
  productionDeptCodes: Set<string>;
  refreshDepartments: () => void;
}) {
  const allDepts = departments.length > 0 ? departments : ALL_DEPARTMENTS;
  const prodCodes = productionDeptCodes.size > 0 ? productionDeptCodes : PRODUCTION_DEPT_CODES;
  const [manageOpen, setManageOpen] = useState(false);
  const periodOptions = useMemo(() => buildPeriodOptions(), []);
  const [period, setPeriod] = useState<string>(() => periodOptions[0]?.value ?? "");
  const { from, to } = useMemo(() => periodToDateRange(period), [period]);

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
    data?: { SOFA?: number; BEDFRAME?: number; ACCESSORY?: number; totalSen?: number };
  }>(prodRevUrl);

  const workersById = useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  const rows: LaborCostRow[] = useMemo(() => {
    const entries = (entriesResp?.success ? entriesResp.data ?? [] : []) as WorkingHourEntry[];
    const revData = plResp?.success ? plResp.data ?? {} : {};
    const revenueByCategory: Record<string, number> = {
      SOFA: Number(revData.SOFA) || 0,
      BEDFRAME: Number(revData.BEDFRAME) || 0,
      ACCESSORY: Number(revData.ACCESSORY) || 0,
    };

    // Two rates per worker, intentionally asymmetric:
    //  - Regular hourly rate uses calendar-based working days for the
    //    selected month (Mon–Sat; Sundays excluded). Feb (24 days) → higher
    //    regular rate; months with 27 working days → lower regular rate.
    //  - OT base rate stays anchored at the fixed-26 standard rate, then
    //    multiplied by otMultiplier (default 1.5×). OT premium does NOT
    //    fluctuate month-to-month — it's tied to a "standard" hourly rate
    //    so a worker doing OT in February doesn't get a windfall vs March.
    const wdInMonth = workingDaysInMonth(period);

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
      const regularRateSen = w.basicSalarySen / wdInMonth / 9;
      const otBaseRateSen = w.basicSalarySen / 26 / 9;
      const otMult = w.otMultiplier ?? 1.5;
      const totalH = segs.reduce((s, e) => s + (Number(e.hours) || 0), 0);
      const otTotalH = Math.max(0, totalH - 9);
      const otShare = totalH > 0 ? otTotalH / totalH : 0;

      for (const e of segs) {
        const hours = Number(e.hours) || 0;
        const otH = hours * otShare;
        const regularH = hours - otH;
        const cost = regularH * regularRateSen + otH * otBaseRateSen * otMult;
        const cat = (e.category || "") as Category;
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
      const dept = allDepts.find((d) => d.code === departmentCode);
      const isProduction = prodCodes.has(departmentCode);
      out.push({
        id: key,
        departmentCode,
        departmentName: dept?.name ?? departmentCode,
        category,
        hours: Math.round(b.hours * 100) / 100,
        laborCostSen: Math.round(b.laborCostSen),
        revenueSen: isProduction && category ? (revenueByCategory[category] ?? 0) : 0,
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
  }, [entriesResp, plResp, workersById, period, allDepts, prodCodes]);

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
    if (typeof rev.totalSen === "number") return rev.totalSen;
    return (Number(rev.SOFA) || 0) + (Number(rev.BEDFRAME) || 0) + (Number(rev.ACCESSORY) || 0);
  }, [plResp]);
  const overallRatio = totalRevenueSen > 0 ? (totalLaborCostSen / totalRevenueSen) * 100 : 0;

  const loading = entriesLoading || plLoading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-[#6B5C32]" /> Labor Cost vs Revenue
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setManageOpen((v) => !v)}
              title="Create / edit / delete departments"
            >
              <Users className="h-4 w-4" />
              {manageOpen ? "Close Manage Departments" : "Manage Departments"}
            </Button>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            >
              {periodOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {manageOpen && (
          <DepartmentsManager
            departments={allDepts}
            refresh={refreshDepartments}
          />
        )}
        {/* KPI strip */}
        <div className="grid gap-3 grid-cols-2 md:grid-cols-5 mb-4">
          <Card>
            <CardContent className="p-3">
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
            <CardContent className="p-3">
              <p className="text-xs text-[#6B7280]">Cost / Revenue</p>
              <p className={`text-lg font-bold ${overallRatio > 30 ? "text-[#9A3A2D]" : overallRatio > 20 ? "text-[#9C6F1E]" : "text-[#4F7C3A]"}`}>
                {totalRevenueSen > 0 ? `${overallRatio.toFixed(1)}%` : "—"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3" title="Hours billed to WAREHOUSING — workers lent to warehouse, off the production line">
              <p className="text-xs text-[#6B7280]">Borrowed (Warehousing)</p>
              <p className={`text-lg font-bold ${warehousingLaborCostSen > 0 ? "text-[#9C6F1E]" : "text-[#1F1D1B]"}`}>
                {formatCurrency(warehousingLaborCostSen)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3" title="Hours billed to PRODUCTION_SHORTFALL — paid time with no work to do">
              <p className="text-xs text-[#6B7280]">Idle (Shortfall)</p>
              <p className={`text-lg font-bold ${shortfallLaborCostSen > 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                {formatCurrency(shortfallLaborCostSen)}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Production-vs-overhead ratio note */}
        <div className="mb-3 text-xs text-[#6B7280]">
          Production-only labor cost (excl. warehousing/repair/maint/shortfall):{" "}
          <span className="font-medium text-[#1F1D1B]">{formatCurrency(productionLaborCostSen)}</span>
          {" · "}
          Revenue is recognized when items complete UPHOLSTERY (production-completion bucket); labor at the day work happens. Treat any
          single-month ratio as a leading indicator, not a closed P&amp;L.
        </div>

        {loading ? (
          <div className="rounded-md border border-[#E2DDD8] p-8 text-center text-sm text-[#9CA3AF]">
            Loading labor cost data…
          </div>
        ) : (
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Department</th>
                  <th className="h-10 px-3 text-left font-medium text-[#374151]">Category</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Hours</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Labor Cost</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Category Revenue</th>
                  <th className="h-10 px-3 text-right font-medium text-[#374151]">Cost / Revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ratio = r.revenueSen > 0 ? (r.laborCostSen / r.revenueSen) * 100 : 0;
                  const rowClass = r.isShortfall
                    ? "bg-[#F9E1DA]/30 border-l-4 border-l-[#9A3A2D]"
                    : r.isWarehousing
                      ? "bg-[#FAEFCB]/40 border-l-4 border-l-[#9C6F1E]"
                      : !r.isProduction
                        ? "bg-[#F3F4F6]/40"
                        : "";
                  return (
                    <tr key={r.id} className={`border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors ${rowClass}`}>
                      <td className="h-10 px-3 font-medium text-[#1F1D1B]">{r.departmentName}</td>
                      <td className="h-10 px-3 text-[#4B5563]">
                        {r.category ? r.category[0] + r.category.slice(1).toLowerCase() : <span className="text-[#9CA3AF]">—</span>}
                      </td>
                      <td className="h-10 px-3 text-right font-medium tabular-nums">{r.hours.toFixed(1)}h</td>
                      <td className="h-10 px-3 text-right font-medium tabular-nums">{formatCurrency(r.laborCostSen)}</td>
                      <td className="h-10 px-3 text-right tabular-nums text-[#4B5563]">
                        {r.isProduction && r.category ? formatCurrency(r.revenueSen) : <span className="text-[#9CA3AF]">n/a</span>}
                      </td>
                      <td className="h-10 px-3 text-right tabular-nums">
                        {r.isProduction && r.category && r.revenueSen > 0 ? (
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
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="h-24 text-center text-[#9CA3AF]">
                      No working hour entries for this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
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
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
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

type TabKey = "working-hours" | "labor-cost" | "employee-master" | "efficiency" | "detail" | "payroll" | "leave";

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
    key: "detail",
    label: "Employee Performance",
    icon: <Search className="h-4 w-4" />,
  },
  {
    key: "payroll",
    label: "Payroll",
    icon: <DollarSign className="h-4 w-4" />,
  },
  {
    key: "leave",
    label: "Leave Management",
    icon: <FileText className="h-4 w-4" />,
  },
  {
    key: "employee-master",
    label: "Employee Master",
    icon: <Users className="h-4 w-4" />,
  },
];

export default function EmployeesPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("working-hours");
  const [, setDateAttendance] = useState<AttendanceRecord[]>([]);

  const { data: workersResp, loading: workersLoading, refresh: refreshWorkersHook } = useCachedJson<{ data?: Worker[] }>("/api/workers");
  const { data: attendanceResp, loading: attendanceLoading, refresh: refreshAttendanceHook } = useCachedJson<{ data?: AttendanceRecord[] }>("/api/attendance");
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
  const allAttendance: AttendanceRecord[] = useMemo(
    () => ((attendanceResp as { data?: AttendanceRecord[] } | AttendanceRecord[] | null)
      ? ((attendanceResp as { data?: AttendanceRecord[] }).data ?? (Array.isArray(attendanceResp) ? (attendanceResp as AttendanceRecord[]) : []))
      : []),
    [attendanceResp]
  );
  const loading = workersLoading || attendanceLoading;

  const fetchWorkers = useCallback(() => {
    invalidateCachePrefix("/api/workers");
    invalidateCachePrefix("/api/payslips");
    invalidateCachePrefix("/api/attendance");
    refreshWorkersHook();
  }, [refreshWorkersHook]);

  const fetchAllAttendance = useCallback(() => {
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

  /* eslint-disable react-hooks/set-state-in-effect -- derived: pluck today's rows out of the all-attendance list */
  useEffect(() => {
    // Also set today's attendance for the working hours tab
    const today = todayStr();
    setDateAttendance(allAttendance.filter((r: AttendanceRecord) => r.date === today));
  }, [allAttendance]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const refreshAttendance = useCallback(
    (date: string) => {
      fetchDateAttendance(date);
      fetchAllAttendance();
    },
    [fetchDateAttendance, fetchAllAttendance]
  );

  // Summary stats
  const totalWorkers = workers.length;
  const todayRecords = allAttendance.filter((a) => a.date === todayStr());
  const presentToday = todayRecords.filter(
    (a) => a.status === "PRESENT" || a.status === "HALF_DAY"
  ).length;
  const totalProductionMinutes = todayRecords.reduce(
    (sum, a) => sum + a.productionTimeMinutes,
    0
  );
  const workingRecords = todayRecords.filter(
    (a) => a.status === "PRESENT" || a.status === "HALF_DAY"
  );
  const avgEfficiency =
    workingRecords.length > 0
      ? (
          workingRecords.reduce((sum, a) => sum + a.efficiencyPct, 0) /
          workingRecords.length
        ).toFixed(1)
      : "0";

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

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#E0EDF0] p-2.5">
              <Users className="h-5 w-5 text-[#3E6570]" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalWorkers}</p>
              <p className="text-xs text-[#6B7280]">Total Workers</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5">
              <UserCheck className="h-5 w-5 text-[#4F7C3A]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#4F7C3A]">
                {presentToday}/{totalWorkers}
              </p>
              <p className="text-xs text-[#6B7280]">Present Today</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5">
              <Clock className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {(totalProductionMinutes / 60).toFixed(1)}h
              </p>
              <p className="text-xs text-[#6B7280]">Production Hours Today</p>
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
              <p className="text-xs text-[#6B7280]">Avg Efficiency</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-0 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
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
          attendance={allAttendance}
          refreshAttendance={refreshAttendance}
          departments={departments}
          productionDeptCodes={productionDeptCodes}
        />
      )}

      {activeTab === "employee-master" && (
        <EmployeeMasterTab workers={workers} refreshWorkers={fetchWorkers} departments={departments} />
      )}

      {activeTab === "efficiency" && (
        <EfficiencyOverviewTab
          workers={workers}
          departments={departments}
        />
      )}

      {activeTab === "detail" && (
        <EmployeeDetailTab
          workers={workers}
          allAttendance={allAttendance}
        />
      )}

      {activeTab === "labor-cost" && (
        <LaborCostTab
          workers={workers}
          departments={departments}
          productionDeptCodes={productionDeptCodes}
          refreshDepartments={refreshDeptsHook}
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
