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

function getEfficiencyColor(pct: number): string {
  if (pct >= 85) return "text-[#4F7C3A] bg-[#EEF3E4]";
  if (pct >= 70) return "text-[#9C6F1E] bg-[#FAEFCB]";
  return "text-[#9A3A2D] bg-[#F9E1DA]";
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function calcWorkingMinutes(clockIn: string, clockOut: string): number {
  const [inH, inM] = clockIn.split(":").map(Number);
  const [outH, outM] = clockOut.split(":").map(Number);
  return Math.max(0, outH * 60 + outM - (inH * 60 + inM));
}

const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  "PRESENT",
  "ABSENT",
  "HALF_DAY",
  "MEDICAL_LEAVE",
  "ANNUAL_LEAVE",
  "REST_DAY",
];

const DEPARTMENTS = [
  { id: "dept-1", code: "FAB_CUT", name: "Fabric Cutting" },
  { id: "dept-2", code: "FAB_SEW", name: "Fabric Sewing" },
  { id: "dept-3", code: "WOOD_CUT", name: "Wood Cutting" },
  { id: "dept-4", code: "FOAM", name: "Foam Bonding" },
  { id: "dept-5", code: "FRAMING", name: "Framing" },
  { id: "dept-6", code: "WEBBING", name: "Webbing" },
  { id: "dept-7", code: "UPHOLSTERY", name: "Upholstery" },
  { id: "dept-8", code: "PACKING", name: "Packing" },
];

// --------------- TAB COMPONENTS ---------------

// ========== TAB 1: WORKING HOURS ==========

type AttendanceRowDraft = {
  employeeId: string;
  employeeName: string;
  departmentName: string;
  clockIn: string;
  clockOut: string;
  status: AttendanceStatus;
  notes: string;
  productType: string;
  saving: boolean;
  saved: boolean;
  saveError?: string;
  existing: AttendanceRecord | null;
};

const PRODUCT_TYPE_STORAGE_KEY = "hookka-attendance-product-type";

function loadProductTypeMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PRODUCT_TYPE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveProductTypeMap(map: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PRODUCT_TYPE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function WorkingHoursTab({
  workers,
  attendance,
  refreshAttendance,
}: {
  workers: Worker[];
  attendance: AttendanceRecord[];
  refreshAttendance: (date: string) => void;
}) {
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [rows, setRows] = useState<AttendanceRowDraft[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);

  // Build rows whenever workers/attendance/date change
  useEffect(() => {
    const dayRecords = attendance.filter((a) => a.date === selectedDate);
    const ptMap = loadProductTypeMap();
    const newRows: AttendanceRowDraft[] = workers
      .filter((w) => w.status === "ACTIVE")
      .map((w) => {
        const existing = dayRecords.find((r) => r.employeeId === w.id) || null;
        const dept = DEPARTMENTS.find((d) => d.id === w.departmentId);
        return {
          employeeId: w.id,
          employeeName: w.name,
          departmentName: dept?.name || w.departmentCode,
          clockIn: existing?.clockIn || "",
          clockOut: existing?.clockOut || "",
          status: existing?.status || "PRESENT",
          notes: existing?.notes || "",
          productType: ptMap[`${selectedDate}:${w.id}`] || "",
          saving: false,
          saved: false,
          existing,
        };
      });
    setRows(newRows);
  }, [workers, attendance, selectedDate]);

  const updateRow = (idx: number, field: string, value: string) => {
    setRows((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value, saved: false };
      if (field === "productType") {
        const map = loadProductTypeMap();
        const key = `${selectedDate}:${copy[idx].employeeId}`;
        if (value) map[key] = value;
        else delete map[key];
        saveProductTypeMap(map);
      }
      return copy;
    });
  };

  // Attendance writes used to swallow HTTP errors silently — a 500 on the
  // clock-in POST would leave the row marked "saved" in the UI while the
  // server never recorded it, then payroll would compute incorrect hours
  // for that worker. Keep the row in an unsaved state + mark it failed
  // when any step of the save fails so the operator knows to retry.
  const postAttendanceOrThrow = async (body: Record<string, unknown>): Promise<void> => {
    const res = await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
  };

  const saveRow = async (idx: number) => {
    const row = rows[idx];
    setRows((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], saving: true };
      return copy;
    });

    try {
      if (row.clockIn) {
        await postAttendanceOrThrow({
          employeeId: row.employeeId,
          action: "CLOCK_IN",
          date: selectedDate,
          time: row.clockIn,
        });
      }
      if (row.clockOut && row.clockIn) {
        await postAttendanceOrThrow({
          employeeId: row.employeeId,
          action: "CLOCK_OUT",
          date: selectedDate,
          time: row.clockOut,
        });
      }
      setRows((prev) => {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], saving: false, saved: true };
        return copy;
      });
      refreshAttendance(selectedDate);
    } catch (e) {
      setRows((prev) => {
        const copy = [...prev];
        copy[idx] = {
          ...copy[idx],
          saving: false,
          saveError: e instanceof Error ? e.message : "Save failed",
        };
        return copy;
      });
    }
  };

  const bulkSave = async () => {
    setBulkSaving(true);
    const unsaved = rows
      .map((r, i) => ({ ...r, idx: i }))
      .filter((r) => !r.saved && r.clockIn);
    for (const row of unsaved) {
      await saveRow(row.idx);
    }
    setBulkSaving(false);
    refreshAttendance(selectedDate);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-[#6B5C32]" /> Daily Working Hours
          </CardTitle>
          <div className="flex items-center gap-3">
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                setSelectedDate(e.target.value);
                refreshAttendance(e.target.value);
              }}
              className="w-44"
            />
            <Button variant="primary" onClick={bulkSave} disabled={bulkSaving}>
              <Save className="h-4 w-4" />
              {bulkSaving ? "Saving..." : "Save All"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                <th className="h-12 px-4 text-left font-medium text-[#374151]">
                  Employee Name
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Department
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Product Type
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Clock In
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Clock Out
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Working Hrs
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Production
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  OT Hrs
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Status
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Notes
                </th>
                <th className="h-12 px-3 text-left font-medium text-[#374151]">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const workMins =
                  row.clockIn && row.clockOut
                    ? calcWorkingMinutes(row.clockIn, row.clockOut)
                    : 0;
                const prodMins = Math.round(workMins * 0.85);
                const standardMins = 9 * 60;
                const otMins = Math.max(0, workMins - standardMins);

                return (
                  <tr
                    key={row.employeeId}
                    className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors"
                  >
                    <td className="h-12 px-4 font-medium text-[#1F1D1B]">
                      {row.employeeName}
                    </td>
                    <td className="h-12 px-3 text-[#4B5563]">
                      {row.departmentName}
                    </td>
                    <td className="h-12 px-3">
                      <select
                        value={row.productType}
                        onChange={(e) => updateRow(idx, "productType", e.target.value)}
                        className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      >
                        <option value="">—</option>
                        <option value="SOFA">Sofa</option>
                        <option value="BEDFRAME">Bedframe</option>
                      </select>
                    </td>
                    <td className="h-12 px-3">
                      <Input
                        type="time"
                        value={row.clockIn}
                        onChange={(e) =>
                          updateRow(idx, "clockIn", e.target.value)
                        }
                        className="w-28 h-8 text-xs"
                      />
                    </td>
                    <td className="h-12 px-3">
                      <Input
                        type="time"
                        value={row.clockOut}
                        onChange={(e) =>
                          updateRow(idx, "clockOut", e.target.value)
                        }
                        className="w-28 h-8 text-xs"
                      />
                    </td>
                    <td className="h-12 px-3 font-medium">
                      {workMins > 0 ? formatHours(workMins) : "-"}
                    </td>
                    <td className="h-12 px-3 font-medium">
                      {prodMins > 0 ? formatHours(prodMins) : "-"}
                    </td>
                    <td className="h-12 px-3">
                      <span
                        className={
                          otMins > 0
                            ? "font-medium text-[#6B5C32]"
                            : "text-[#9CA3AF]"
                        }
                      >
                        {otMins > 0 ? formatHours(otMins) : "-"}
                      </span>
                    </td>
                    <td className="h-12 px-3">
                      <select
                        value={row.status}
                        onChange={(e) =>
                          updateRow(
                            idx,
                            "status",
                            e.target.value
                          )
                        }
                        className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      >
                        {ATTENDANCE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="h-12 px-3">
                      <Input
                        value={row.notes}
                        onChange={(e) =>
                          updateRow(idx, "notes", e.target.value)
                        }
                        placeholder="Notes..."
                        className="w-28 h-8 text-xs"
                      />
                    </td>
                    <td className="h-12 px-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => saveRow(idx)}
                        disabled={row.saving}
                        className={row.saved ? "border-[#C6DBA8] text-[#4F7C3A]" : ""}
                      >
                        {row.saving ? "..." : row.saved ? "Saved" : "Save"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="h-24 text-center text-[#9CA3AF]"
                  >
                    No active workers found.
                  </td>
                </tr>
              )}
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
  joinDate: todayStr(),
  nationality: "",
  status: "ACTIVE",
};

function EmployeeMasterTab({
  workers,
  refreshWorkers,
}: {
  workers: Worker[];
  refreshWorkers: () => void;
}) {
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
              {DEPARTMENTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[#4B5563]">
              {DEPARTMENTS.find((d) => d.id === row.departmentId)?.name ||
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
                  {DEPARTMENTS.map((d) => (
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

function EfficiencyOverviewTab({
  workers: _workers,
  allAttendance,
}: {
  workers: Worker[];
  allAttendance: AttendanceRecord[];
}) {
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState(todayStr());

  // Filter attendance by date range
  const filtered = useMemo(
    () =>
      allAttendance.filter((a) => a.date >= dateFrom && a.date <= dateTo),
    [allAttendance, dateFrom, dateTo]
  );

  // Aggregate per employee
  const employeeStats = useMemo(() => {
    const map = new Map<
      string,
      {
        employeeId: string;
        employeeName: string;
        departmentName: string;
        totalWorkingMins: number;
        totalProductionMins: number;
        totalItems: number;
        recordCount: number;
      }
    >();

    for (const record of filtered) {
      const existing = map.get(record.employeeId);
      const items = record.deptBreakdown?.reduce(
        (sum, b) => sum + (b.productCode ? 1 : 0),
        0
      ) || 0;

      if (existing) {
        existing.totalWorkingMins += record.workingMinutes;
        existing.totalProductionMins += record.productionTimeMinutes;
        existing.totalItems += items;
        existing.recordCount++;
      } else {
        map.set(record.employeeId, {
          employeeId: record.employeeId,
          employeeName: record.employeeName,
          departmentName: record.departmentName,
          totalWorkingMins: record.workingMinutes,
          totalProductionMins: record.productionTimeMinutes,
          totalItems: items,
          recordCount: 1,
        });
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => {
        const effA = a.totalWorkingMins > 0 ? (a.totalProductionMins / a.totalWorkingMins) * 100 : 0;
        const effB = b.totalWorkingMins > 0 ? (b.totalProductionMins / b.totalWorkingMins) * 100 : 0;
        return effB - effA;
      }
    );
  }, [filtered]);

  type EffRow = (typeof employeeStats)[number];

  const columns: Column<EffRow>[] = [
    {
      key: "employeeName",
      label: "Employee",
      sortable: true,
      render: (_value, row) => (
        <span className="font-medium text-[#1F1D1B]">{row.employeeName}</span>
      ),
    },
    {
      key: "departmentName",
      label: "Department",
      sortable: true,
      render: (_value, row) => (
        <span className="text-[#4B5563]">{row.departmentName}</span>
      ),
    },
    {
      key: "totalWorkingMins",
      label: "Total Working Hrs",
      align: "right",
      sortable: true,
      render: (_value, row) => (
        <span className="font-medium">
          {(row.totalWorkingMins / 60).toFixed(1)}h
        </span>
      ),
    },
    {
      key: "totalProductionMins",
      label: "Total Production Hrs",
      align: "right",
      sortable: true,
      render: (_value, row) => (
        <span className="font-medium">
          {(row.totalProductionMins / 60).toFixed(1)}h
        </span>
      ),
    },
    {
      key: "_efficiencyPct",
      label: "Efficiency %",
      align: "center",
      render: (_value, row) => {
        const pct =
          row.totalWorkingMins > 0
            ? (row.totalProductionMins / row.totalWorkingMins) * 100
            : 0;
        return (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${getEfficiencyColor(pct)}`}
          >
            {pct.toFixed(1)}%
          </span>
        );
      },
    },
    {
      key: "totalItems",
      label: "Items Completed",
      align: "center",
      sortable: true,
      render: (_value, row) => <span>{row.totalItems || "-"}</span>,
    },
    {
      key: "_avgTimePerItem",
      label: "Avg Time/Item",
      align: "right",
      render: (_value, row) => {
        if (row.totalItems === 0) return <span>-</span>;
        const avg = row.totalProductionMins / row.totalItems;
        return <span>{formatHours(Math.round(avg))}</span>;
      },
    },
  ];

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
          data={employeeStats}
          keyField="employeeId"
          gridId="employees-efficiency"
          contextMenuItems={contextMenuItems}
          onDoubleClick={(row) => toast.info(`Viewing details for ${row.employeeName}`)}
          emptyMessage="No efficiency data found for the selected date range."
        />
      </CardContent>
    </Card>
  );
}

// ========== TAB 4: EMPLOYEE DETAIL ==========

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

  // Filter attendance for this employee and date range (client-side)
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

  const totalWorkMins = empRecords.reduce(
    (s, r) => s + r.workingMinutes,
    0
  );
  const totalProdMins = empRecords.reduce(
    (s, r) => s + r.productionTimeMinutes,
    0
  );
  const avgEff =
    totalWorkMins > 0
      ? ((totalProdMins / totalWorkMins) * 100).toFixed(1)
      : "0";
  const totalOT = empRecords.reduce((s, r) => s + r.overtimeMinutes, 0);
  const daysPresent = empRecords.filter(
    (r) => r.status === "PRESENT" || r.status === "HALF_DAY"
  ).length;

  // Flatten every deptBreakdown entry into a per-item row so the Daily
  // Breakdown shows every product this worker touched within the date range
  // (matching the googlesheet Employee Detail Dashboard layout).
  type ItemRow = {
    id: string;
    date: string;
    productCode: string;
    deptCode: string;
    minutes: number;
    status: string;
  };
  const itemRows: ItemRow[] = useMemo(() => {
    const out: ItemRow[] = [];
    for (const r of empRecords) {
      if (!r.deptBreakdown || r.deptBreakdown.length === 0) continue;
      r.deptBreakdown.forEach((b, i) => {
        out.push({
          id: `${r.id}-${i}`,
          date: r.date,
          productCode: b.productCode || "—",
          deptCode: b.deptCode,
          minutes: b.minutes,
          status: r.status,
        });
      });
    }
    return out;
  }, [empRecords]);

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
        <span className="font-medium text-[#1F1D1B]">{row.productCode}</span>
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
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">
              {(totalProdMins / 60).toFixed(1)}h
            </p>
            <p className="text-xs text-[#6B7280]">Total Production Hrs</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p
              className={`text-2xl font-bold ${Number(avgEff) >= 85 ? "text-[#4F7C3A]" : Number(avgEff) >= 70 ? "text-[#9C6F1E]" : "text-[#9A3A2D]"}`}
            >
              {avgEff}%
            </p>
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
      const data = await res.json();
      const { generatePayslipHTML } = await import("@/lib/generate-payslip-pdf");
      const html = generatePayslipHTML(data.data, data.ytd);
      const printWindow = window.open("", "_blank");
      if (printWindow) {
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
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

type TabKey = "working-hours" | "employee-master" | "efficiency" | "detail" | "payroll" | "leave";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "working-hours",
    label: "Working Hours",
    icon: <Clock className="h-4 w-4" />,
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

  const workers: Worker[] = useMemo(
    () => ((workersResp as { data?: Worker[] } | Worker[] | null)
      ? ((workersResp as { data?: Worker[] }).data ?? (Array.isArray(workersResp) ? (workersResp as Worker[]) : []))
      : []),
    [workersResp]
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
      .then((r) => r.json())
      .then((res) => setDateAttendance(res.data ?? res ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Also set today's attendance for the working hours tab
    const today = todayStr();
    setDateAttendance(allAttendance.filter((r: AttendanceRecord) => r.date === today));
  }, [allAttendance]);

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
        />
      )}

      {activeTab === "employee-master" && (
        <EmployeeMasterTab workers={workers} refreshWorkers={fetchWorkers} />
      )}

      {activeTab === "efficiency" && (
        <EfficiencyOverviewTab
          workers={workers}
          allAttendance={allAttendance}
        />
      )}

      {activeTab === "detail" && (
        <EmployeeDetailTab
          workers={workers}
          allAttendance={allAttendance}
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
