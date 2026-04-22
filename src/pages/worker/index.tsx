// ============================================================
// /worker — Worker home screen
//
// First thing a worker sees after login. Goals:
//   • One-tap clock-in / clock-out at the top
//   • Pretty big readable counters: pending / in-progress / done
//   • Giant "SCAN JOB CARD" button (most-used action)
//   • Today's estimated piece-rate earnings
//   • "Report problem" secondary button
//   • Employee Detail Dashboard — working hrs vs production time vs
//     efficiency, with a date range picker and day-by-day breakdown.
//     This lives here (not on /pay) because /pay is money-only.
//
// /today powers the fast top section; /history powers the bottom
// dashboard and refetches whenever the range changes.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ScanLine, AlertTriangle, Clock, CheckCircle2 } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch, WORKER_ME_KEY } from "@/layouts/WorkerLayout";
import { deriveWipName } from "@/lib/wip-name";

// ---------- types ----------
type TodayData = {
  date: string;
  worker: {
    id: string;
    empNo: string;
    name: string;
    departmentCode: string;
  };
  attendance: {
    clockIn: string | null;
    clockOut: string | null;
    workingMinutes: number;
    status: string;
  } | null;
  pending: number;
  inProgress: number;
  doneToday: number;
  doneByDept: Record<string, number>;
  earningsSen: number;
};

type DailyRow = {
  date: string;
  departmentName: string;
  workingMinutes: number;
  productionMinutes: number;
};
type CompletedRow = {
  jobCardId: string;
  orderPoNo: string;
  productCode: string;
  productName: string;
  departmentCode: string;
  estMinutes: number;
  actualMinutes: number | null;
  // This worker's credit for the JC — pro-rated by pieces-worked and halved
  // when a co-PIC shared a piece. Drives the "Mins" column so a shared
  // piece shows the worker's ACTUAL share (not the full JC estMinutes).
  myMinutes: number;
  piecesWorked: number;
  piecesShared: number;
  totalPieces: number;
  completedDate: string | null;
  // WIP metadata — when present, lets us render the piece name (e.g.
  // `8" Divan- 5FT (WD)`) instead of the generic productCode. Critical
  // for bedframe POs where Divan and HB share the same productCode.
  wipLabel?: string;
  wipCode?: string;
  itemCategory?: string;
  sizeLabel?: string;
};
type AttendanceRow = {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  workingMinutes: number;
  productionTimeMinutes: number;
  efficiencyPct: number;
  overtimeMinutes: number;
  status: string;
};
type HistoryData = {
  range: { from: string; to: string };
  daily: DailyRow[];
  attendance: AttendanceRow[];
  completed: CompletedRow[];
  totals: {
    days: number;
    workedMinutes: number;
    productionMinutes: number;
    overtimeMinutes: number;
    completedCount: number;
    efficiencyPct: number;
  };
};

// ---------- helpers ----------
function fmtHM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function mins2hrs(mins: number): string {
  return (mins / 60).toFixed(1);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}
function fmtDay(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
}

// ============================================================
export default function WorkerHomePage() {
  const t = useT();
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [clocking, setClocking] = useState(false);

  // Dashboard date range — default to last 7 days
  const [from, setFrom] = useState<string>(() => ymd(addDays(new Date(), -6)));
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [hist, setHist] = useState<HistoryData | null>(null);

  // ---- fetches ----
  const refreshToday = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/today");
      const j = await res.json();
      if (j.success) setData(j.data);
    } finally {
      setLoading(false);
    }
  }, []);

  // Swallow errors — a failing /history must NOT strand us on the
  // page-level loading state (that's driven by refreshToday above).
  // Worst case: the Performance dashboard just doesn't render.
  const refreshHistory = useCallback(async (f: string, tto: string) => {
    try {
      const res = await workerFetch(
        `/api/worker/history?from=${encodeURIComponent(f)}&to=${encodeURIComponent(tto)}`,
      );
      const j = await res.json();
      if (j.success) setHist(j.data);
    } catch {
      /* leave hist as-is */
    }
  }, []);

  useEffect(() => {
    refreshToday();
  }, [refreshToday]);

  useEffect(() => {
    refreshHistory(from, to);
  }, [refreshHistory, from, to]);

  async function handleClock(action: "CLOCK_IN" | "CLOCK_OUT") {
    setClocking(true);
    try {
      await workerFetch("/api/worker/clock", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      // Re-fetch both — a fresh clock event shifts daily/attendance too
      await Promise.all([refreshToday(), refreshHistory(from, to)]);
    } finally {
      setClocking(false);
    }
  }

  // Quick preset chips for the range picker
  function setPreset(kind: "7d" | "30d" | "month" | "lastMonth") {
    const now = new Date();
    if (kind === "7d") {
      setFrom(ymd(addDays(now, -6)));
      setTo(ymd(now));
    } else if (kind === "30d") {
      setFrom(ymd(addDays(now, -29)));
      setTo(ymd(now));
    } else if (kind === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      setFrom(ymd(start));
      setTo(ymd(now));
    } else {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      setFrom(ymd(start));
      setTo(ymd(end));
    }
  }

  // Greeting uses cached /me for instant paint (fallback to fetched data)
  const cachedName = useMemo(() => {
    try {
      const raw = localStorage.getItem(WORKER_ME_KEY);
      if (raw) return (JSON.parse(raw) as { name?: string }).name || "";
    } catch {
      /* ignore */
    }
    return "";
  }, []);

  if (loading) {
    return (
      <div className="pt-8 text-center text-[#5A5550]">{t("common.loading")}</div>
    );
  }
  if (!data) {
    return (
      <div className="pt-8 text-center text-[#9A3A2D]">{t("common.error")}</div>
    );
  }

  const displayName = cachedName || data.worker.name;
  const clockedIn = !!data.attendance?.clockIn;
  const clockedOut = !!data.attendance?.clockOut;

  return (
    <div className="space-y-4 pt-2">
      {/* Greeting */}
      <div>
        <p className="text-sm text-[#5A5550]">{t("home.hello")},</p>
        <h1 className="text-xl font-bold leading-tight">{displayName}</h1>
        <p className="text-xs text-[#8A8680]">
          {data.worker.empNo} · {data.worker.departmentCode}
        </p>
      </div>

      {/* Clock card */}
      <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] shadow-sm">
        {!clockedIn ? (
          <button
            type="button"
            onClick={() => handleClock("CLOCK_IN")}
            disabled={clocking}
            className="w-full h-14 rounded-lg bg-[#3E6570] hover:bg-[#355863] text-white text-lg font-semibold disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            <Clock className="h-5 w-5" />
            {t("home.clockIn")}
          </button>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs text-[#8A8680]">
                  {clockedOut ? t("home.clockedOutAt") : t("home.clockedInAt")}
                </p>
                <p className="text-xl font-bold">
                  {clockedOut ? data.attendance!.clockOut : data.attendance!.clockIn}
                </p>
              </div>
              {data.attendance!.workingMinutes > 0 && (
                <div className="text-right">
                  <p className="text-xs text-[#8A8680]">
                    {t("home.workedHours")}
                  </p>
                  <p className="text-xl font-bold">
                    {fmtHM(data.attendance!.workingMinutes)}
                  </p>
                </div>
              )}
            </div>
            {!clockedOut && (
              <button
                type="button"
                onClick={() => handleClock("CLOCK_OUT")}
                disabled={clocking}
                className="w-full h-11 rounded-lg bg-[#F0ECE9] hover:bg-[#E5E0DB] text-[#1F1D1B] text-sm font-semibold disabled:opacity-60 transition-colors"
              >
                {t("home.clockOut")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Stat grid — today's job cards */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label={t("home.pending")}
          value={data.pending}
          tone="neutral"
        />
        <StatCard
          label={t("home.inProgress")}
          value={data.inProgress}
          tone="active"
        />
        <StatCard
          label={t("home.piecesDone")}
          value={data.doneToday}
          tone="done"
        />
      </div>

      {/* Big scan button */}
      <Link
        to="/worker/scan"
        className="block w-full h-20 rounded-xl bg-[#6B5C32] hover:bg-[#5a4d2a] text-white text-xl font-bold tracking-wide shadow-md active:shadow-sm active:translate-y-[1px] transition-all"
      >
        <span className="h-full w-full flex items-center justify-center gap-3">
          <ScanLine className="h-7 w-7" />
          {t("home.scanBig")}
        </span>
      </Link>

      {/* Report problem secondary */}
      <Link
        to="/worker/issue"
        className="block w-full h-12 rounded-lg bg-white border border-[#D8D2CC] text-[#9A3A2D] font-semibold text-sm hover:bg-[#FDF6F4] transition-colors"
      >
        <span className="h-full w-full flex items-center justify-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {t("home.reportIssue")}
        </span>
      </Link>

      {/* Breakdown by dept (only if any work done today) */}
      {Object.keys(data.doneByDept).length > 0 && (
        <div className="bg-white rounded-xl p-4 border border-[#D8D2CC]">
          <p className="text-xs text-[#8A8680] mb-2 font-medium">
            {t("home.piecesDone")}
          </p>
          <div className="space-y-1.5">
            {Object.entries(data.doneByDept).map(([code, n]) => (
              <div
                key={code}
                className="flex items-center justify-between text-sm"
              >
                <span className="flex items-center gap-1.5 text-[#1F1D1B]">
                  <CheckCircle2 className="h-4 w-4 text-[#3E6570]" />
                  {code}
                </span>
                <span className="font-semibold">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ==================== */}
      {/*  Performance block   */}
      {/* ==================== */}
      {/* Matches the Google Sheet "Employee Detail Dashboard" layout.
          From/To pickers drive both the KPI tiles and the per-day /
          per-product tables. */}
      <div className="bg-[#1B2B44] text-white rounded-xl p-4 mt-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/70">
          Employee Detail Dashboard
        </p>

        <div className="grid grid-cols-2 gap-2 mt-3">
          <label className="block">
            <span className="text-[11px] text-white/60">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full h-10 px-2 rounded bg-white/10 text-white text-sm border border-white/20 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              style={{ colorScheme: "dark" }}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-white/60">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full h-10 px-2 rounded bg-white/10 text-white text-sm border border-white/20 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              style={{ colorScheme: "dark" }}
            />
          </label>
        </div>

        <div className="flex gap-1.5 mt-2 overflow-x-auto -mx-1 px-1">
          <Chip onClick={() => setPreset("7d")}>7d</Chip>
          <Chip onClick={() => setPreset("30d")}>30d</Chip>
          <Chip onClick={() => setPreset("month")}>This month</Chip>
          <Chip onClick={() => setPreset("lastMonth")}>Last month</Chip>
        </div>
      </div>

      {/* KPI row */}
      {hist && (
        <div className="grid grid-cols-3 gap-2">
          <Kpi
            label="Working Hours"
            value={mins2hrs(hist.totals.workedMinutes)}
          />
          <Kpi
            label="Production Time"
            value={mins2hrs(hist.totals.productionMinutes)}
          />
          <Kpi
            label="Efficiency %"
            value={`${hist.totals.efficiencyPct}%`}
            tone={
              hist.totals.efficiencyPct >= 80
                ? "good"
                : hist.totals.efficiencyPct >= 60
                  ? "warn"
                  : "bad"
            }
          />
        </div>
      )}

      {/* Daily attendance — shows clock In/Out per day alongside Work/Prod hours */}
      {hist && (() => {
        // Index attendance by date so we can pull clock times into the daily rows.
        // Using the `daily` rollup as the source-of-truth for row set (it already
        // merges days with production but no attendance, and vice versa).
        const clockByDate = new Map(
          hist.attendance.map((a) => [a.date, a]),
        );
        return (
          <TableSection title="Daily attendance">
            <TableHeader
              cols={["Date", "In → Out", "Work hrs", "Prod hrs"]}
              align={["left", "left", "right", "right"]}
            />
            {hist.daily.length === 0 ? (
              <EmptyRow />
            ) : (
              hist.daily.map((r) => {
                const att = clockByDate.get(r.date);
                const inOut =
                  att && (att.clockIn || att.clockOut)
                    ? `${att.clockIn || "—"} → ${att.clockOut || "—"}`
                    : "—";
                return (
                  <div
                    key={r.date}
                    className="grid grid-cols-[auto_1fr_auto_auto] gap-2 py-2 text-sm border-t border-[#F0ECE9] items-center"
                  >
                    <span className="font-mono text-xs text-[#5A5550]">
                      {fmtDay(r.date)}
                    </span>
                    <span className="font-mono text-xs text-[#5A5550] truncate">
                      {inOut}
                    </span>
                    <span className="font-mono text-right font-semibold">
                      {mins2hrs(r.workingMinutes)}
                    </span>
                    <span className="font-mono text-right font-semibold text-[#3E6570]">
                      {mins2hrs(r.productionMinutes)}
                    </span>
                  </div>
                );
              })
            )}
          </TableSection>
        );
      })()}

      {/* Completed products */}
      {hist && (
        <TableSection title={`Completed products (${hist.completed.length})`}>
          <TableHeader
            cols={["Date", "Department", "Product", "Mins"]}
            align={["left", "left", "left", "right"]}
          />
          {hist.completed.length === 0 ? (
            <EmptyRow />
          ) : (
            hist.completed.map((c) => {
              const label = deriveWipName({
                wipLabel: c.wipLabel,
                departmentCode: c.departmentCode,
                productName: c.productName,
                productCode: c.productCode,
                itemCategory: c.itemCategory,
                sizeLabel: c.sizeLabel,
              });
              return (
                <div
                  key={c.jobCardId}
                  className="grid grid-cols-[auto_auto_1fr_auto] gap-2 py-2 text-sm border-t border-[#F0ECE9] items-center"
                >
                  <span className="font-mono text-xs text-[#5A5550] whitespace-nowrap">
                    {fmtDay(c.completedDate || "")}
                  </span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#5A5550] font-semibold whitespace-nowrap">
                    {c.departmentCode}
                  </span>
                  <span
                    className="text-xs truncate"
                    title={`${label} · ${c.productCode}${c.totalPieces > 1 ? ` · ${c.piecesWorked}/${c.totalPieces} pcs` : ""}${c.piecesShared > 0 ? ` · ${c.piecesShared} shared` : ""}`}
                  >
                    {label}
                    {c.totalPieces > 1 && (
                      <span className="ml-1 text-[10px] text-[#8A8680]">
                        ({c.piecesWorked}/{c.totalPieces})
                      </span>
                    )}
                    {c.piecesShared > 0 && (
                      <span className="ml-1 text-[10px] text-[#6B5C32]">
                        · share
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-right font-semibold">
                    {c.myMinutes}
                  </span>
                </div>
              );
            })
          )}
        </TableSection>
      )}
    </div>
  );
}

// ---------- tiny UI helpers ----------
function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "active" | "done";
}) {
  const color =
    tone === "done"
      ? "text-[#3E6570]"
      : tone === "active"
        ? "text-[#9C6F1E]"
        : "text-[#5A5550]";
  return (
    <div className="bg-white rounded-xl p-3 border border-[#D8D2CC] text-center">
      <p className={`text-3xl font-bold leading-tight ${color}`}>{value}</p>
      <p className="text-[11px] text-[#8A8680] mt-0.5 leading-tight">
        {label}
      </p>
    </div>
  );
}

function Chip({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-white/10 border border-white/20 hover:bg-white/20 font-medium"
    >
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-[#2A6B4A]"
      : tone === "warn"
        ? "text-[#9C6F1E]"
        : tone === "bad"
          ? "text-[#9A3A2D]"
          : "text-[#1F1D1B]";
  return (
    <div className="bg-white rounded-xl p-3 border border-[#D8D2CC] text-center">
      <p className="text-[10px] uppercase tracking-wide text-[#8A8680] font-semibold">
        {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}

function TableSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
      <div className="px-3 py-2 bg-[#1B2B44] text-white">
        <p className="text-xs font-bold uppercase tracking-wide">{title}</p>
      </div>
      <div className="px-3 pb-2">{children}</div>
    </div>
  );
}

function TableHeader({
  cols,
  align,
}: {
  cols: string[];
  align?: Array<"left" | "right">;
}) {
  const gridCols =
    cols.length === 4 ? "grid-cols-[auto_1fr_auto_auto]" : "grid-cols-4";
  return (
    <div
      className={`grid ${gridCols} gap-2 py-2 text-[10px] font-bold uppercase tracking-wide text-[#8A8680] bg-[#EAF3E5] -mx-3 px-3`}
    >
      {cols.map((c, i) => (
        <span
          key={c}
          className={align?.[i] === "right" ? "text-right" : "text-left"}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function EmptyRow() {
  return <div className="py-4 text-center text-xs text-[#8A8680]">—</div>;
}
