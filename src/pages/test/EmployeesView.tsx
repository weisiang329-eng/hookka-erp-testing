import { useMemo } from "react";
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Target, Clock, Gauge } from "lucide-react";
import { TAUPE, TEAL, MUTED, BORDER, fmtN } from "./dashboard-shared-lib";
import { Kpi, LiveBadge, MissingNote } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype — the `employee` +
// `availability.employee` slices (workers + working_hour_entries +
// job_cards, src/api/routes/dashboard-prototype.ts). `performance` is the
// house workforce metric (working_hour_entries clocked + completed job_cards
// earned) — NOT attendance_records.efficiency_pct, which is a different,
// looser number that happens to share a name (see the route's own note).
type Feed = {
  success?: boolean;
  availability?: { employee?: { live: boolean; reason?: string; workers: number; attendanceRows: number; missing?: string[] } };
  meta?: { config?: { efficiencyTargetPct?: number; workingHoursPerDay?: number } };
  employee?: {
    workers: {
      id: string; empNo: string | null; name: string | null; dept: string | null; role: string | null;
      status: string | null; targetPct: number | null; hoursPerDay: number | null; countsToHeadcount: boolean;
    }[];
    performance: {
      byDay: { date: string; workingMinutes: number; productionMinutes: number; allDeptMinutes: number }[];
      cards: number;
      measuredCards: number;
    };
  };
};

export function EmployeesView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const employee = data?.employee;
  const live = data?.availability?.employee?.live ?? false;
  const missing = data?.availability?.employee?.missing ?? [];
  const config = data?.meta?.config;

  const headcount = useMemo(
    () => (employee?.workers ?? []).filter((w) => w.countsToHeadcount).length,
    [employee?.workers],
  );

  const workers = useMemo(
    () => [...(employee?.workers ?? [])].filter((w) => w.countsToHeadcount).slice(0, 60),
    [employee?.workers],
  );

  const { chartData, workingHours, productionHours } = useMemo(() => {
    const days = [...(employee?.performance.byDay ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1));
    let w = 0, p = 0;
    const rows = days.map((d) => {
      w += d.workingMinutes;
      p += d.productionMinutes;
      return {
        date: d.date.slice(5),
        "Working Hours": Math.round((d.workingMinutes / 60) * 10) / 10,
        "Production Hours": Math.round((d.productionMinutes / 60) * 10) / 10,
      };
    });
    return { chartData: rows, workingHours: w / 60, productionHours: p / 60 };
  }, [employee?.performance.byDay]);

  const efficiencyPct = workingHours > 0 ? (productionHours / workingHours) * 100 : null;

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Employees: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Employees</h2>
        <LiveBadge live={live} />
      </div>
      <MissingNote fields={missing} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Kpi
          label="Headcount"
          value={fmtN(headcount)}
          sub="ACTIVE, excl. TEST accounts"
          icon={Users}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
        <Kpi
          label="Efficiency (Prod ÷ Working)"
          value={efficiencyPct == null ? "—" : `${efficiencyPct.toFixed(1)}%`}
          sub="earned standard time, not measured"
          icon={Gauge}
          iconBgClass="bg-[#E6F0F3]"
          iconColorClass="text-[#3E6570]"
          valueColorClass="text-[#3E6570]"
        />
        <Kpi
          label="Efficiency Target"
          value={config?.efficiencyTargetPct != null ? `${config.efficiencyTargetPct}%` : "—"}
          icon={Target}
          iconBgClass="bg-[#EEF3E4]"
          iconColorClass="text-[#4F7C3A]"
          valueColorClass="text-[#4F7C3A]"
        />
        <Kpi
          label="Working Hours / Day"
          value={config?.workingHoursPerDay != null ? `${config.workingHoursPerDay}h` : "—"}
          icon={Clock}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Working vs production hours</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 220 }}>
            {chartData.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No clocked hours in range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="empWorkGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={TAUPE} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={TAUPE} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="Working Hours" stroke={TAUPE} fill="url(#empWorkGrad)" strokeWidth={2} />
                  <Line type="monotone" dataKey="Production Hours" stroke={TEAL} strokeWidth={1.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Workers</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["Emp No", "Name", "Department", "Role", "Status", "Target %", "Hours/Day"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 font-mono text-[#1F1D1B]">{w.empNo ?? "—"}</td>
                    <td className="px-4 py-2 text-[#1F1D1B]">{w.name ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{w.dept ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{w.role ?? "—"}</td>
                    <td className="px-4 py-2">
                      {w.status && <Badge variant="status" status={w.status} />}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{w.targetPct ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{w.hoursPerDay ?? "—"}</td>
                  </tr>
                ))}
                {workers.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-[#6B7280]">No workers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
