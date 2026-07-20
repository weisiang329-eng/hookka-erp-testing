// ============================================================
// /worker/team — Operator Leader's Department Performance view
//
// Mobile-optimized port of the desktop /employees → "Department Performance"
// tab (src/pages/employees.tsx:3794+). Same KPI strip + Daily Breakdown
// list, same expandable per-worker → per-JC drilldown, but laid out for a
// narrow viewport: 2x2 KPI grid instead of 1x4, vertical row list instead
// of a wide table, accordion-style nested expansion.
//
// Backend: GET /api/worker/department-performance — worker-token auth,
// auto-scoped to the leader's departments + categories.
//
// Defense in depth: backend returns isLeader:false for non-leaders, in
// which case the page shows a "Operator Leader access only" banner. The
// bottom-nav Team tab is also hidden for non-leaders so this page is only
// reachable by manual URL.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, BarChart3 } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { humanizeError } from "@/lib/humanize-error";
import { workerFetch } from "@/lib/worker-session";

// ---- Response shape (mirrors backend) ----
type DrillJob = {
  jobCardId: string;
  productCode: string;
  productName: string;
  wipLabel: string | null;
  poNo: string | null;
  productionMinutes: number;
};
type DrillWorker = {
  workerId: string;
  workerName: string;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  jobs: DrillJob[];
};
type DailyRow = {
  date: string;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  workers?: DrillWorker[];
};
type DeptPerfData = {
  isLeader: boolean;
  range: { from: string; to: string };
  departmentCode: string | null;
  category: string | null;
  availableDepartments: string[];
  availableCategories: Array<"SOFA" | "BEDFRAME">;
  totals: {
    workingMinutes: number;
    productionMinutes: number;
    // Working-hour split for the KPI subtitle. productionWorkingMinutes is
    // the denominator behind Avg Efficiency; non-prod is the leftover
    // (Warehousing / Repair / Maintenance / Production Shortfall) shown so
    // the operator can reconcile the headline Working Hrs with the ratio.
    productionWorkingMinutes: number;
    nonProductionWorkingMinutes: number;
    efficiencyPct: number;
    workerCount: number;
  };
  daily: DailyRow[];
};
type DeptPerfResponse =
  | { success: true; data: DeptPerfData }
  | { success: false; error?: string };

// ---- Helpers ----
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}
function fmtHours(mins: number): string {
  if (mins <= 0) return "-";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function fmtDayShort(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
}
function effTone(pct: number, hasHours: boolean): string {
  if (!hasHours) return "text-[#9CA3AF]";
  if (pct >= 80) return "text-[#2A6B4A]";
  if (pct >= 60) return "text-[#9C6F1E]";
  return "text-[#9A3A2D]";
}

// ============================================================
export default function WorkerTeamPage() {
  const t = useT();

  // Filters — defaults match desktop tab: last 7 days inclusive of today,
  // no dept / cat filter (= leader's full scope).
  const [from, setFrom] = useState<string>(() => ymd(addDays(new Date(), -6)));
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [departmentCode, setDepartmentCode] = useState<string>("");
  const [category, setCategory] = useState<string>("");

  const [data, setData] = useState<DeptPerfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Expanded date rows. Set keyed by ISO date so multiple days can be open
  // at once (operator wants to compare two days' worker breakdowns side by
  // side without re-tapping).
  const [expandedDates, setExpandedDates] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleDate = useCallback((date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }, []);

  // Fetch on filter change. workerFetch handles 401 by redirecting to login.
  /* eslint-disable react-hooks/set-state-in-effect -- loading flag flips synchronously to mask the prev result while the new filter set fetches; setData/setError land inside the async callback */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ from, to });
    if (departmentCode) params.set("departmentCode", departmentCode);
    if (category) params.set("category", category);

    workerFetch(`/api/worker/department-performance?${params.toString()}`)
      .then((r) => r.json() as Promise<DeptPerfResponse>)
      .then((j) => {
        if (cancelled) return;
        if (j.success) {
          setData(j.data);
        } else {
          setError(j.error ?? "Failed to load");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(humanizeError(e, "Network problem — please try again."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [from, to, departmentCode, category]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const totals = data?.totals;
  const daily = useMemo(() => data?.daily ?? [], [data]);
  const avgEff =
    totals && totals.workingMinutes > 0
      ? totals.efficiencyPct.toFixed(1)
      : null;

  // Subtitle helpers — keep parity with desktop /employees commit 0a41a95.
  // fmtHours returns "-" for ≤ 0; map that to "0h" inside subtitles so the
  // operator sees a real number ("0h prod + 4h non-prod" beats "- prod +
  // 4h non-prod"). Only render the prod-split subtitle when there ARE
  // non-production minutes — otherwise the headline Working Hrs already
  // equals prod hours and the extra line is just clutter.
  const fmtHoursOrZero = (mins: number): string =>
    mins > 0 ? fmtHours(mins) : "0h";
  const prodMins = totals?.productionWorkingMinutes ?? 0;
  const nonProdMins = totals?.nonProductionWorkingMinutes ?? 0;
  const totalProdMins = totals?.productionMinutes ?? 0;
  const workingHrsSubtitle =
    totals && totals.workingMinutes > 0 && nonProdMins > 0
      ? `${fmtHoursOrZero(prodMins)} prod + ${fmtHoursOrZero(nonProdMins)} non-prod`
      : null;
  const avgEffSubtitle =
    avgEff !== null
      ? `${fmtHoursOrZero(totalProdMins)} ÷ ${fmtHoursOrZero(prodMins)}`
      : null;

  // Defense-in-depth: backend can flip isLeader:false even if the tab leaks.
  if (data && data.isLeader === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-bold text-[#1F1D1B]">{t("team.title")}</h1>
        <div className="rounded-lg bg-[#F0E5E1] border border-[#D5BFB7] px-4 py-3 text-sm text-[#7A4A3A]">
          {t("team.notLeader")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-[#1F1D1B] flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
        {t("team.title")}
      </h1>

      {/* Filter card. Dropdowns scoped to leader's depts + cats — backend
          clamps anyway, but the UI shouldn't even surface options the
          leader can't pick. */}
      <div className="rounded-lg bg-white border border-[#D8D2CC] p-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] font-medium text-[#5A5550] flex flex-col gap-1">
            {t("team.dept")}
            <select
              value={departmentCode}
              onChange={(e) => setDepartmentCode(e.target.value)}
              className="h-9 rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
            >
              <option value="">{t("team.allDepts")}</option>
              {(data?.availableDepartments ?? []).map((dc) => (
                <option key={dc} value={dc}>
                  {dc}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] font-medium text-[#5A5550] flex flex-col gap-1">
            {t("team.category")}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
            >
              <option value="">{t("team.allCats")}</option>
              {(data?.availableCategories ?? ["SOFA", "BEDFRAME"]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] font-medium text-[#5A5550] flex flex-col gap-1">
            {t("team.from")}
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
            />
          </label>
          <label className="text-[11px] font-medium text-[#5A5550] flex flex-col gap-1">
            {t("team.to")}
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
            />
          </label>
        </div>
      </div>

      {/* KPI 2x2 grid — same 4 metrics as desktop. Workers + working +
          production share a uniform tile, efficiency gets the colour-coded
          tone (green/amber/red). */}
      <div className="grid grid-cols-2 gap-2">
        <Kpi
          label={t("team.workers")}
          value={String(totals?.workerCount ?? 0)}
        />
        <Kpi
          label={t("team.totalWorkingHrs")}
          value={fmtHours(totals?.workingMinutes ?? 0)}
          subtitle={workingHrsSubtitle}
        />
        <Kpi
          label={t("team.totalProductionHrs")}
          value={fmtHours(totals?.productionMinutes ?? 0)}
        />
        <Kpi
          label={t("team.avgEfficiency")}
          value={avgEff !== null ? `${avgEff}%` : "—"}
          tone={
            avgEff !== null
              ? Number(avgEff) >= 80
                ? "good"
                : Number(avgEff) >= 60
                  ? "warn"
                  : "bad"
              : null
          }
          subtitle={avgEffSubtitle}
        />
      </div>

      {/* Daily Breakdown list. Vertical row list instead of a table —
          tighter on mobile and lets each row have its own tap-to-expand
          drilldown beneath it without horizontal scrolling.

          Column layout (fixed across header + every data row so values
          line up under their labels):
            [chevron 16px] [date 64px] [3-col grid: working / production / eff%]
          The header row mirrors the same flex template; the chevron slot
          stays empty + the date slot holds "Date" so the column titles
          land at the same x-coordinate as the values below. */}
      <div className="rounded-lg bg-white border border-[#D8D2CC] overflow-hidden">
        <div className="px-3 py-2 bg-[#F0ECE9] border-b border-[#D8D2CC]">
          <span className="text-xs font-bold uppercase tracking-wide text-[#1F1D1B]">
            {t("team.dailyBreakdown")}
          </span>
        </div>
        {loading ? (
          <div className="px-3 py-6 text-center text-sm text-[#5A5550]">
            {t("team.loading")}
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-sm text-[#9A3A2D]">
            {error}
          </div>
        ) : daily.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-[#9CA3AF]">
            {t("team.empty")}
          </div>
        ) : (
          <>
            {/* Column header — same flex / grid template as data rows so
                the values below land directly under their label. */}
            <div className="px-3 py-1.5 flex items-center gap-3 border-b border-[#E5DEC6] bg-[#FAF7EE] text-[10px] uppercase tracking-wide text-[#8A8680] font-semibold">
              <span className="w-4 flex-shrink-0" aria-hidden />
              <span className="w-16 flex-shrink-0">{t("team.colDate")}</span>
              <span className="flex-1 grid grid-cols-3 gap-1 text-right">
                <span>{t("team.colWorkingHrs")}</span>
                <span>{t("team.colProductionHrs")}</span>
                <span>{t("team.colEfficiency")}</span>
              </span>
            </div>
            <ul className="divide-y divide-[#F0ECE9]">
              {daily.map((row) => {
                const isOpen = expandedDates.has(row.date);
                const hasHours = row.workingMinutes > 0;
                const tone = effTone(row.efficiencyPct, hasHours);
                return (
                  <li key={row.date}>
                    <button
                      type="button"
                      onClick={() => toggleDate(row.date)}
                      className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-[#FAF7EE] active:bg-[#F0ECE9]"
                    >
                      <span className="w-4 flex-shrink-0 text-[#5A5550]">
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </span>
                      <span className="font-medium text-sm text-[#1F1D1B] flex-shrink-0 w-16 tabular-nums">
                        {fmtDayShort(row.date)}
                      </span>
                      <span className="flex-1 grid grid-cols-3 gap-1 text-xs tabular-nums text-right">
                        <span className="text-[#1F1D1B]">
                          {fmtHours(row.workingMinutes)}
                        </span>
                        <span className="text-[#1F1D1B]">
                          {fmtHours(row.productionMinutes)}
                        </span>
                        <span className={`font-semibold ${tone}`}>
                          {hasHours ? `${row.efficiencyPct}%` : "—"}
                        </span>
                      </span>
                    </button>
                    {isOpen && (
                      <DailyDrillDown
                        date={row.date}
                        workers={row.workers ?? []}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Sub-components ----
// `subtitle` (optional): a third line under the label, shown in a dim
// secondary tone. Used by the Total Working Hrs / Avg Efficiency cards to
// surface the prod / non-prod split + efficiency denominator — same
// information the desktop /employees Employee Performance tab shows
// (commit 0a41a95). Wraps + breaks-words so a long "34h 30m prod + 4h
// non-prod" string still fits a 2-col KPI tile at 320px width.
function Kpi({
  label,
  value,
  tone,
  subtitle,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | null;
  subtitle?: string | null;
}) {
  const valueClass =
    tone === "good"
      ? "text-[#2A6B4A]"
      : tone === "warn"
        ? "text-[#9C6F1E]"
        : tone === "bad"
          ? "text-[#9A3A2D]"
          : "text-[#1F1D1B]";
  return (
    <div className="rounded-lg bg-white border border-[#D8D2CC] px-3 py-2.5 text-center">
      <p className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
      <p className="text-[10px] text-[#8A8680] mt-0.5 leading-tight">
        {label}
      </p>
      {subtitle && (
        <p className="text-[10px] text-[#3E6570] mt-0.5 leading-tight tabular-nums break-words">
          {subtitle}
        </p>
      )}
    </div>
  );
}

// Per-date drilldown panel — vertical list of workers (sorted by working
// minutes desc), each tappable to reveal that worker's JCs for the date.
// Multiple workers can be open simultaneously; expansion keyed by
// `${date}::${workerId}` so opening the same worker on two different dates
// doesn't collide.
function DailyDrillDown({
  date,
  workers,
}: {
  date: string;
  workers: DrillWorker[];
}) {
  const t = useT();
  const sorted = useMemo(
    () => [...workers].sort((a, b) => b.workingMinutes - a.workingMinutes),
    [workers],
  );
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const toggle = useCallback(
    (workerId: string) => {
      const key = `${date}::${workerId}`;
      setOpenKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [date],
  );

  if (sorted.length === 0) {
    return (
      <div className="px-3 pb-3 pt-1 text-xs text-[#9CA3AF]">
        {t("team.empty")}
      </div>
    );
  }

  return (
    <div className="px-3 pb-3 pt-1 bg-[#FDFCFB] border-t border-[#F0ECE9]">
      <p className="text-[10px] uppercase tracking-wide text-[#8A8680] mb-1.5">
        {t("team.workerProductionShare")}
      </p>
      <ul className="space-y-1">
        {sorted.map((w) => {
          const key = `${date}::${w.workerId}`;
          const isOpen = openKeys.has(key);
          const hasHours = w.workingMinutes > 0;
          const tone = effTone(w.efficiencyPct, hasHours);
          return (
            <li
              key={w.workerId}
              className="rounded border border-[#E5DEC6] bg-white"
            >
              <button
                type="button"
                onClick={() => toggle(w.workerId)}
                className="w-full px-2.5 py-2 flex items-center gap-2 text-left"
              >
                <span className="text-[#5A5550] flex-shrink-0">
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="flex-1 text-xs font-medium text-[#1F1D1B] truncate">
                  {w.workerName || w.workerId}
                </span>
                <span className="text-[10px] text-[#5A5550] tabular-nums whitespace-nowrap">
                  {fmtHours(w.workingMinutes)} / {fmtHours(w.productionMinutes)}
                </span>
                <span
                  className={`text-[10px] font-semibold tabular-nums w-10 text-right ${tone}`}
                >
                  {hasHours ? `${w.efficiencyPct}%` : "—"}
                </span>
              </button>
              {isOpen && w.jobs.length > 0 && (
                <div className="px-2.5 pb-2 pt-1 border-t border-[#F0ECE9]">
                  <p className="text-[10px] uppercase tracking-wide text-[#8A8680] mb-1">
                    {t("team.jobs")}
                  </p>
                  <ul className="space-y-0.5">
                    {w.jobs.map((j) => (
                      <li
                        key={j.jobCardId}
                        className="text-[11px] flex items-baseline gap-2"
                      >
                        <span className="font-medium text-[#1F1D1B] truncate flex-1">
                          {j.wipLabel || j.productName || j.productCode}
                        </span>
                        {j.poNo && (
                          <span className="text-[10px] text-[#8A8680] flex-shrink-0">
                            {j.poNo}
                          </span>
                        )}
                        <span className="tabular-nums text-[#5A5550] flex-shrink-0">
                          {fmtHours(j.productionMinutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
