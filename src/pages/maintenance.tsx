import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Equipment, MaintenanceLog } from "@/lib/mock-data";
import {
  Wrench,
  Plus,
  CheckCircle,
  AlertTriangle,
  Clock,
  Calendar,
  Settings,
  Loader2,
  X,
  History,
  Search,
} from "lucide-react";

type TabId = "equipment" | "schedule" | "history";

const EQUIPMENT_TYPES = [
  "SEWING_MACHINE", "CUTTING_TABLE", "STAPLE_GUN", "COMPRESSOR", "SAW", "DRILL", "OTHER",
] as const;

const DEPARTMENTS = [
  "Fabric Cutting", "Fabric Sewing", "Wood Cutting", "Foam Bonding",
  "Framing", "Webbing", "Upholstery", "Packing",
];

function statusBadge(status: string) {
  const map: Record<string, { bg: string; text: string; border: string }> = {
    OPERATIONAL: { bg: "bg-[#EEF3E4]", text: "text-[#4F7C3A]", border: "border-[#C6DBA8]" },
    MAINTENANCE: { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]", border: "border-[#A8CAD2]" },
    REPAIR: { bg: "bg-[#FAEFCB]", text: "text-[#9C6F1E]", border: "border-[#E8D597]" },
    DECOMMISSIONED: { bg: "bg-gray-100", text: "text-gray-500", border: "border-gray-300" },
  };
  const c = map[status] || map.OPERATIONAL;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function maintenanceTypeBadge(type: string) {
  const map: Record<string, { bg: string; text: string; border: string }> = {
    PREVENTIVE: { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]", border: "border-[#A8CAD2]" },
    CORRECTIVE: { bg: "bg-[#FAEFCB]", text: "text-[#9C6F1E]", border: "border-[#E8D597]" },
    EMERGENCY: { bg: "bg-[#F9E1DA]", text: "text-[#9A3A2D]", border: "border-[#E8B2A1]" },
  };
  const c = map[type] || map.PREVENTIVE;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      {type}
    </span>
  );
}

function isOverdue(nextDate: string) {
  const today = new Date("2026-04-14");
  return new Date(nextDate) < today;
}

function daysUntil(nextDate: string) {
  const today = new Date("2026-04-14");
  const next = new Date(nextDate);
  return Math.ceil((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function MaintenancePage() {
  const [activeTab, setActiveTab] = useState<TabId>("equipment");
  const [loading, setLoading] = useState(true);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);

  // Forms
  const [showAddForm, setShowAddForm] = useState(false);
  const [showLogForm, setShowLogForm] = useState<string | null>(null); // equipmentId
  const [showEditForm, setShowEditForm] = useState<string | null>(null);

  // History filters
  const [historyEquipmentFilter, setHistoryEquipmentFilter] = useState("ALL");
  const [historyTypeFilter, setHistoryTypeFilter] = useState("ALL");
  const [historySearch, setHistorySearch] = useState("");

  // Fetch data
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const [eqRes, logRes] = await Promise.all([
          fetch("/api/equipment").then((r) => r.json()),
          fetch("/api/maintenance-logs").then((r) => r.json()),
        ]);
        if (eqRes.success) setEquipment(eqRes.data);
        if (logRes.success) setLogs(logRes.data);
      } catch (err) {
        console.error("Failed to fetch:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  // KPI calculations
  const operationalCount = equipment.filter((e) => e.status === "OPERATIONAL").length;
  const maintenanceCount = equipment.filter((e) => e.status === "MAINTENANCE").length;
  const repairCount = equipment.filter((e) => e.status === "REPAIR").length;
  const overdueCount = equipment.filter(
    (e) => e.status !== "DECOMMISSIONED" && isOverdue(e.nextMaintenanceDate)
  ).length;

  // Schedule tab KPIs
  const upcomingThisWeek = equipment.filter((e) => {
    if (e.status === "DECOMMISSIONED") return false;
    const d = daysUntil(e.nextMaintenanceDate);
    return d >= 0 && d <= 7;
  });
  const overdueEquipment = equipment.filter(
    (e) => e.status !== "DECOMMISSIONED" && isOverdue(e.nextMaintenanceDate)
  );
  const thisMonthLogs = logs.filter((l) => l.date.startsWith("2026-04"));
  const avgDowntime = logs.length > 0
    ? (logs.reduce((s, l) => s + l.downtimeHours, 0) / logs.length).toFixed(1)
    : "0";

  // History filtered
  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (historyEquipmentFilter !== "ALL" && l.equipmentId !== historyEquipmentFilter) return false;
      if (historyTypeFilter !== "ALL" && l.type !== historyTypeFilter) return false;
      if (historySearch) {
        const q = historySearch.toLowerCase();
        if (
          !l.equipmentName.toLowerCase().includes(q) &&
          !l.description.toLowerCase().includes(q) &&
          !l.performedBy.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [logs, historyEquipmentFilter, historyTypeFilter, historySearch]);

  // Add equipment handler
  async function handleAddEquipment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body = {
      code: fd.get("code"),
      name: fd.get("name"),
      department: fd.get("department"),
      type: fd.get("type"),
      maintenanceCycleDays: Number(fd.get("maintenanceCycleDays")) || 30,
      purchaseDate: fd.get("purchaseDate"),
      notes: fd.get("notes"),
      lastMaintenanceDate: new Date().toISOString().split("T")[0],
      nextMaintenanceDate: (() => {
        const d = new Date();
        d.setDate(d.getDate() + (Number(fd.get("maintenanceCycleDays")) || 30));
        return d.toISOString().split("T")[0];
      })(),
    };
    const res = await fetch("/api/equipment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.success) {
      setEquipment((prev) => [...prev, result.data]);
      setShowAddForm(false);
    }
  }

  // Log maintenance handler
  async function handleLogMaintenance(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!showLogForm) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body = {
      logMaintenance: {
        type: fd.get("type"),
        description: fd.get("description"),
        performedBy: fd.get("performedBy"),
        date: fd.get("date"),
        costSen: Math.round(Number(fd.get("cost")) * 100),
        downtimeHours: Number(fd.get("downtimeHours")),
      },
    };
    const res = await fetch(`/api/equipment/${showLogForm}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.success) {
      setEquipment((prev) =>
        prev.map((eq) => (eq.id === showLogForm ? result.data : eq))
      );
      if (result.log) {
        setLogs((prev) => [result.log, ...prev]);
      }
      setShowLogForm(null);
    }
  }

  // Edit equipment handler
  async function handleEditEquipment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!showEditForm) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body = {
      name: fd.get("name"),
      department: fd.get("department"),
      type: fd.get("type"),
      status: fd.get("status"),
      maintenanceCycleDays: Number(fd.get("maintenanceCycleDays")),
      notes: fd.get("notes"),
    };
    const res = await fetch(`/api/equipment/${showEditForm}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.success) {
      setEquipment((prev) =>
        prev.map((eq) => (eq.id === showEditForm ? result.data : eq))
      );
      setShowEditForm(null);
    }
  }

  const editingEquipment = showEditForm ? equipment.find((e) => e.id === showEditForm) : null;

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "equipment", label: "Equipment List", icon: <Settings className="h-4 w-4" /> },
    { id: "schedule", label: "Maintenance Schedule", icon: <Calendar className="h-4 w-4" /> },
    { id: "history", label: "Maintenance History", icon: <History className="h-4 w-4" /> },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
        <span className="ml-2 text-sm text-[#6B7280]">Loading maintenance data...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1D1B]">Maintenance</h1>
          <p className="text-sm text-[#6B7280]">
            Equipment & machine maintenance tracking for the factory
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Operational</p>
              <p className="text-2xl font-bold text-[#4F7C3A]">{operationalCount}</p>
            </div>
            <CheckCircle className="h-5 w-5 text-[#4F7C3A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Under Maintenance</p>
              <p className="text-2xl font-bold text-[#3E6570]">{maintenanceCount}</p>
            </div>
            <Wrench className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Under Repair</p>
              <p className="text-2xl font-bold text-[#9C6F1E]">{repairCount}</p>
            </div>
            <Clock className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Overdue</p>
              <p className="text-2xl font-bold text-[#9A3A2D]">{overdueCount}</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#E2DDD8]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === tab.id
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ==================== TAB 1: Equipment List ==================== */}
      {activeTab === "equipment" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setShowAddForm(!showAddForm)}>
              <Plus className="h-4 w-4" />
              Add Equipment
            </Button>
          </div>

          {/* Add Equipment Inline Form */}
          {showAddForm && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Add New Equipment</CardTitle>
                  <Button variant="ghost" size="icon" onClick={() => setShowAddForm(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleAddEquipment} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <input name="code" required placeholder="Equipment Code (e.g. EQ-SEW-005)" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="name" required placeholder="Equipment Name" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <select name="department" required className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]">
                    <option value="">Select Department</option>
                    {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <select name="type" required className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]">
                    {EQUIPMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                  <input name="maintenanceCycleDays" type="number" defaultValue={30} placeholder="Cycle (days)" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="purchaseDate" type="date" required className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="notes" placeholder="Notes (optional)" className="sm:col-span-2 h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <div className="flex items-end">
                    <Button type="submit" variant="primary" className="w-full">Save Equipment</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Edit Equipment Modal */}
          {showEditForm && editingEquipment && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Edit: {editingEquipment.code}</CardTitle>
                  <Button variant="ghost" size="icon" onClick={() => setShowEditForm(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleEditEquipment} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <input name="name" defaultValue={editingEquipment.name} required placeholder="Equipment Name" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <select name="department" defaultValue={editingEquipment.department} className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]">
                    {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <select name="type" defaultValue={editingEquipment.type} className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]">
                    {EQUIPMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                  <select name="status" defaultValue={editingEquipment.status} className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]">
                    <option value="OPERATIONAL">OPERATIONAL</option>
                    <option value="MAINTENANCE">MAINTENANCE</option>
                    <option value="REPAIR">REPAIR</option>
                    <option value="DECOMMISSIONED">DECOMMISSIONED</option>
                  </select>
                  <input name="maintenanceCycleDays" type="number" defaultValue={editingEquipment.maintenanceCycleDays} className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="notes" defaultValue={editingEquipment.notes} placeholder="Notes" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <div className="flex items-end">
                    <Button type="submit" variant="primary" className="w-full">Update</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Equipment Table */}
          <Card>
            <CardContent className="p-0">
              <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Code</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Name</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Department</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Type</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Status</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Last Maint.</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Next Maint.</th>
                      <th className="h-12 px-4 text-center font-medium text-[#374151]">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {equipment.map((eq) => {
                      const overdue = eq.status !== "DECOMMISSIONED" && isOverdue(eq.nextMaintenanceDate);
                      return (
                        <tr key={eq.id} className={`border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors ${overdue ? "bg-[#F9E1DA]/50" : ""}`}>
                          <td className="h-12 px-4 align-middle font-medium text-[#1F1D1B]">{eq.code}</td>
                          <td className="h-12 px-4 align-middle text-[#4B5563]">{eq.name}</td>
                          <td className="h-12 px-4 align-middle text-[#4B5563]">{eq.department}</td>
                          <td className="h-12 px-4 align-middle">
                            <Badge>{eq.type.replace(/_/g, " ")}</Badge>
                          </td>
                          <td className="h-12 px-4 align-middle">{statusBadge(eq.status)}</td>
                          <td className="h-12 px-4 align-middle text-[#4B5563]">{formatDate(eq.lastMaintenanceDate)}</td>
                          <td className="h-12 px-4 align-middle">
                            <span className={overdue ? "text-[#9A3A2D] font-medium" : "text-[#4B5563]"}>
                              {formatDate(eq.nextMaintenanceDate)}
                            </span>
                            {overdue && <p className="text-xs text-[#9A3A2D]">OVERDUE</p>}
                          </td>
                          <td className="h-12 px-4 align-middle text-center">
                            <div className="flex items-center justify-center gap-1">
                              <Button variant="ghost" size="sm" onClick={() => setShowEditForm(eq.id)}>
                                Edit
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowLogForm(showLogForm === eq.id ? null : eq.id)}
                              >
                                Log
                              </Button>
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

          {/* Log Maintenance Inline Form */}
          {showLogForm && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    Log Maintenance: {equipment.find((e) => e.id === showLogForm)?.name}
                  </CardTitle>
                  <Button variant="ghost" size="icon" onClick={() => setShowLogForm(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleLogMaintenance} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <select name="type" required className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]">
                    <option value="PREVENTIVE">Preventive</option>
                    <option value="CORRECTIVE">Corrective</option>
                    <option value="EMERGENCY">Emergency</option>
                  </select>
                  <input name="date" type="date" defaultValue="2026-04-14" required className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="performedBy" required placeholder="Performed By" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="description" required placeholder="Description of work done" className="sm:col-span-2 h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="cost" type="number" step="0.01" placeholder="Cost (RM)" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <input name="downtimeHours" type="number" step="0.5" placeholder="Downtime (hours)" className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]" />
                  <div className="flex items-end">
                    <Button type="submit" variant="primary" className="w-full">Submit Log</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ==================== TAB 2: Maintenance Schedule ==================== */}
      {activeTab === "schedule" && (
        <div className="space-y-6">
          {/* Schedule KPIs */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[#6B7280]">Upcoming This Week</p>
                  <p className="text-2xl font-bold text-[#3E6570]">{upcomingThisWeek.length}</p>
                </div>
                <Calendar className="h-5 w-5 text-[#3E6570]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[#6B7280]">Overdue</p>
                  <p className="text-2xl font-bold text-[#9A3A2D]">{overdueEquipment.length}</p>
                </div>
                <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[#6B7280]">Completed This Month</p>
                  <p className="text-2xl font-bold text-[#4F7C3A]">{thisMonthLogs.length}</p>
                </div>
                <CheckCircle className="h-5 w-5 text-[#4F7C3A]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[#6B7280]">Avg Downtime</p>
                  <p className="text-2xl font-bold text-[#1F1D1B]">{avgDowntime}h</p>
                </div>
                <Clock className="h-5 w-5 text-[#6B5C32]" />
              </CardContent>
            </Card>
          </div>

          {/* Overdue Section */}
          {overdueEquipment.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-[#9A3A2D]">
                  <AlertTriangle className="h-5 w-5" />
                  Overdue Maintenance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {overdueEquipment.map((eq) => (
                    <div key={eq.id} className="flex items-center justify-between p-3 rounded-lg bg-[#F9E1DA] border border-[#E8B2A1]">
                      <div className="flex items-center gap-3">
                        <Wrench className="h-4 w-4 text-[#9A3A2D]" />
                        <div>
                          <p className="text-sm font-medium text-[#1F1D1B]">{eq.name}</p>
                          <p className="text-xs text-[#9CA3AF]">{eq.code} - {eq.department}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-sm text-[#9A3A2D] font-medium">{formatDate(eq.nextMaintenanceDate)}</p>
                          <p className="text-xs text-[#9A3A2D]">{Math.abs(daysUntil(eq.nextMaintenanceDate))} day(s) overdue</p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setShowLogForm(eq.id);
                            setActiveTab("equipment");
                          }}
                        >
                          Log Maintenance
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Upcoming This Week */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-[#6B5C32]" />
                Upcoming This Week
              </CardTitle>
            </CardHeader>
            <CardContent>
              {upcomingThisWeek.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] text-center py-6">No maintenance scheduled this week</p>
              ) : (
                <div className="space-y-2">
                  {upcomingThisWeek.map((eq) => {
                    const d = daysUntil(eq.nextMaintenanceDate);
                    return (
                      <div key={eq.id} className="flex items-center justify-between p-3 rounded-lg bg-[#FAF9F7] border border-[#E2DDD8]">
                        <div className="flex items-center gap-3">
                          <Wrench className="h-4 w-4 text-[#6B5C32]" />
                          <div>
                            <p className="text-sm font-medium text-[#1F1D1B]">{eq.name}</p>
                            <p className="text-xs text-[#9CA3AF]">{eq.code} - {eq.department}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="text-sm text-[#4B5563]">{formatDate(eq.nextMaintenanceDate)}</p>
                            <p className={`text-xs ${d <= 2 ? "text-[#9A3A2D]" : "text-[#9C6F1E]"}`}>
                              {d === 0 ? "Today" : `In ${d} day${d > 1 ? "s" : ""}`}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setShowLogForm(eq.id);
                              setActiveTab("equipment");
                            }}
                          >
                            Log Maintenance
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Upcoming This Month (next 30 days) */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-[#6B5C32]" />
                Upcoming This Month
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {equipment
                  .filter((e) => {
                    if (e.status === "DECOMMISSIONED") return false;
                    const d = daysUntil(e.nextMaintenanceDate);
                    return d >= 0 && d <= 30;
                  })
                  .sort((a, b) => new Date(a.nextMaintenanceDate).getTime() - new Date(b.nextMaintenanceDate).getTime())
                  .map((eq) => {
                    const d = daysUntil(eq.nextMaintenanceDate);
                    return (
                      <div key={eq.id} className="flex items-center justify-between p-3 rounded-lg border border-[#E2DDD8]">
                        <div className="flex items-center gap-3">
                          <div className={`h-2 w-2 rounded-full ${d <= 3 ? "bg-[#9A3A2D]" : d <= 7 ? "bg-[#9C6F1E]" : "bg-[#4F7C3A]"}`} />
                          <div>
                            <p className="text-sm font-medium text-[#1F1D1B]">{eq.name}</p>
                            <p className="text-xs text-[#9CA3AF]">{eq.code} - {eq.department}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-[#4B5563]">{formatDate(eq.nextMaintenanceDate)}</p>
                          <p className="text-xs text-[#9CA3AF]">{d === 0 ? "Today" : `${d} day${d > 1 ? "s" : ""}`}</p>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ==================== TAB 3: Maintenance History ==================== */}
      {activeTab === "history" && (
        <div className="space-y-4">
          {/* Filters */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={historyEquipmentFilter}
                  onChange={(e) => setHistoryEquipmentFilter(e.target.value)}
                  className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                >
                  <option value="ALL">All Equipment</option>
                  {equipment.map((eq) => (
                    <option key={eq.id} value={eq.id}>{eq.code} - {eq.name}</option>
                  ))}
                </select>
                <select
                  value={historyTypeFilter}
                  onChange={(e) => setHistoryTypeFilter(e.target.value)}
                  className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                >
                  <option value="ALL">All Types</option>
                  <option value="PREVENTIVE">Preventive</option>
                  <option value="CORRECTIVE">Corrective</option>
                  <option value="EMERGENCY">Emergency</option>
                </select>
                <div className="relative">
                  <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
                  <input
                    placeholder="Search logs..."
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    className="h-10 pl-9 pr-3 rounded-md border border-[#E2DDD8] bg-white text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* History Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5 text-[#6B5C32]" />
                Maintenance Log
                <span className="text-sm font-normal text-[#9CA3AF]">({filteredLogs.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Date</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Equipment</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Type</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Description</th>
                      <th className="h-12 px-4 text-left font-medium text-[#374151]">Performed By</th>
                      <th className="h-12 px-4 text-right font-medium text-[#374151]">Cost</th>
                      <th className="h-12 px-4 text-right font-medium text-[#374151]">Downtime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="h-24 text-center text-[#9CA3AF]">
                          No maintenance logs found.
                        </td>
                      </tr>
                    ) : (
                      filteredLogs.map((log) => (
                        <tr key={log.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                          <td className="h-12 px-4 align-middle text-[#4B5563]">{formatDate(log.date)}</td>
                          <td className="h-12 px-4 align-middle">
                            <span className="font-medium text-[#1F1D1B]">{log.equipmentName}</span>
                          </td>
                          <td className="h-12 px-4 align-middle">{maintenanceTypeBadge(log.type)}</td>
                          <td className="h-12 px-4 align-middle text-[#4B5563] max-w-xs truncate">{log.description}</td>
                          <td className="h-12 px-4 align-middle text-[#4B5563]">{log.performedBy}</td>
                          <td className="h-12 px-4 align-middle text-right text-[#4B5563]">
                            {formatCurrency(log.costSen)}
                          </td>
                          <td className="h-12 px-4 align-middle text-right text-[#4B5563]">
                            {log.downtimeHours}h
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
