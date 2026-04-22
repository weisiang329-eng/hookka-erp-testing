// ============================================================
// /worker/pay — Salary view + attendance audit trail (mobile)
//
// This page answers two money-related questions for the worker:
//   1. How much am I earning this month? (estimate card)
//   2. How did I earn it? (clock-in/out + OT records for any date
//      range, so they can cross-check against the estimate or any
//      past payslip)
//
// Performance-oriented data (Production time, Efficiency, completed
// products) stays on /worker — this page is money + raw attendance
// only.
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch } from "@/layouts/WorkerLayout";

// ---------- helpers ----------
function rm(sen: number | undefined): string {
  const n = sen ?? 0;
  return `RM ${(n / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

// ---------- types ----------
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
  attendance: AttendanceRow[];
  totals: {
    days: number;
    workedMinutes: number;
    overtimeMinutes: number;
  };
};
type PayData = {
  current: {
    period: string;
    workedDays: number;
    otMinutes: number;
    basicEarnedSen: number;
    otSen: number;
    pieceBonusSen: number;
    estimatedGrossSen: number;
  };
  history: Array<{
    id: string;
    period: string;
    basicSen?: number;
    grossSen?: number;
    netSen?: number;
    allowancesSen?: number;
    overtimeSen?: number;
    epfEeSen?: number;
    socsoEeSen?: number;
    eisEeSen?: number;
    taxSen?: number;
  }>;
};

// ============================================================
export default function WorkerPayPage() {
  const t = useT();
  const [pay, setPay] = useState<PayData | null>(null);
  const [hist, setHist] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Attendance range — default to current month (1st → today)
  const [from, setFrom] = useState<string>(() => {
    const n = new Date();
    return ymd(new Date(n.getFullYear(), n.getMonth(), 1));
  });
  const [to, setTo] = useState<string>(() => ymd(new Date()));

  // Individual loaders swallow their own errors — a failed /history
  // must NOT take down the page or block the /payslips response.
  const loadPay = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/payslips");
      const j = await res.json();
      if (j.success) setPay(j.data);
    } catch {
      /* network error — leave pay null, UI will show error card */
    }
  }, []);

  const loadHist = useCallback(async (f: string, tto: string) => {
    try {
      const res = await workerFetch(
        `/api/worker/history?from=${encodeURIComponent(f)}&to=${encodeURIComponent(tto)}`,
      );
      const j = await res.json();
      if (j.success) setHist(j.data);
    } catch {
      /* leave hist null — attendance section just won't render */
    }
  }, []);

  useEffect(() => {
    // Wrap in try/finally so a thrown fetch NEVER strands us on the
    // loading screen — we always release the loading flag.
    (async () => {
      try {
        await Promise.all([loadPay(), loadHist(from, to)]);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadPay, loadHist, from, to]);

  function setPreset(kind: "month" | "lastMonth" | "30d") {
    const now = new Date();
    if (kind === "month") {
      setFrom(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
      setTo(ymd(now));
    } else if (kind === "lastMonth") {
      setFrom(ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
      setTo(ymd(new Date(now.getFullYear(), now.getMonth(), 0)));
    } else {
      setFrom(ymd(addDays(now, -29)));
      setTo(ymd(now));
    }
  }

  if (loading) {
    return (
      <div className="pt-8 text-center text-[#5A5550]">{t("common.loading")}</div>
    );
  }
  if (!pay) {
    return (
      <div className="pt-8 text-center text-[#9A3A2D]">{t("common.error")}</div>
    );
  }

  const otHours = (pay.current.otMinutes / 60).toFixed(1);

  return (
    <div className="space-y-4 pt-2">
      <h1 className="text-xl font-bold">{t("pay.title")}</h1>

      {/* ========== Current month pay estimate ========== */}
      <div className="bg-[#1F1D1B] text-white rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-[#B0AAA3]">{t("pay.thisMonth")}</p>
          <p className="text-xs font-mono">{pay.current.period}</p>
        </div>
        <p className="text-4xl font-bold tracking-tight">
          {rm(pay.current.estimatedGrossSen)}
        </p>
        <p className="text-[11px] text-[#B0AAA3] mt-1">{t("pay.estimate")}</p>

        <div className="mt-4 pt-4 border-t border-white/10 space-y-2 text-sm">
          <Row
            label={`${t("pay.basicEarned")} · ${pay.current.workedDays}d`}
            value={rm(pay.current.basicEarnedSen)}
          />
          <Row
            label={`${t("pay.ot")} · ${otHours}h`}
            value={rm(pay.current.otSen)}
          />
          <Row
            label={t("pay.pieceBonus")}
            value={rm(pay.current.pieceBonusSen)}
          />
          <div className="pt-2 mt-2 border-t border-white/10">
            <Row
              label={t("pay.gross")}
              value={rm(pay.current.estimatedGrossSen)}
              bold
            />
          </div>
        </div>
      </div>

      {/* ========== Attendance (clock-in/out + OT) ========== */}
      {/* Shows raw clock records for any range the worker picks, so they
          can reconcile their RM estimate with actual days/OT. */}
      <div className="bg-[#1B2B44] text-white rounded-xl p-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/70">
          Attendance & OT
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
          <Chip onClick={() => setPreset("month")}>This month</Chip>
          <Chip onClick={() => setPreset("lastMonth")}>Last month</Chip>
          <Chip onClick={() => setPreset("30d")}>Last 30d</Chip>
        </div>
      </div>

      {/* Mini KPIs for the picked range */}
      {hist && (
        <div className="grid grid-cols-3 gap-2">
          <Mini label="Days" value={String(hist.totals.days)} />
          <Mini label="Hours" value={mins2hrs(hist.totals.workedMinutes)} />
          <Mini
            label="OT hrs"
            value={mins2hrs(hist.totals.overtimeMinutes)}
            accent
          />
        </div>
      )}

      {/* Attendance table */}
      {hist && (
        <TableSection title="Clock records">
          <TableHeader
            cols={["Date", "In → Out", "Hrs", "OT"]}
            align={["left", "left", "right", "right"]}
          />
          {hist.attendance.length === 0 ? (
            <EmptyRow />
          ) : (
            hist.attendance.map((a) => {
              const inOut =
                a.clockIn || a.clockOut
                  ? `${a.clockIn || "—"} → ${a.clockOut || "—"}`
                  : "—";
              return (
                <div
                  key={a.date}
                  className="grid grid-cols-[auto_1fr_auto_auto] gap-2 py-2 text-sm border-t border-[#F0ECE9] items-center"
                >
                  <span className="font-mono text-xs text-[#5A5550]">
                    {fmtDay(a.date)}
                  </span>
                  <span className="font-mono text-xs text-[#5A5550] truncate">
                    {inOut}
                  </span>
                  <span className="font-mono text-right font-semibold">
                    {mins2hrs(a.workingMinutes)}
                  </span>
                  <span
                    className={`font-mono text-right font-semibold ${
                      a.overtimeMinutes > 0 ? "text-[#9C6F1E]" : "text-[#8A8680]"
                    }`}
                  >
                    {a.overtimeMinutes > 0 ? mins2hrs(a.overtimeMinutes) : "—"}
                  </span>
                </div>
              );
            })
          )}
        </TableSection>
      )}

      {/* ========== Payslip history ========== */}
      <div>
        <p className="text-sm font-semibold text-[#5A5550] mb-2">
          {t("pay.history")}
        </p>
        {pay.history.length === 0 ? (
          <div className="bg-white rounded-xl p-6 text-center text-sm text-[#8A8680] border border-[#D8D2CC]">
            —
          </div>
        ) : (
          <div className="space-y-2">
            {pay.history.map((p) => {
              const open = expanded === p.id;
              return (
                <div
                  key={p.id}
                  className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : p.id)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#FAF9F7]"
                  >
                    <div className="text-left">
                      <p className="text-sm font-mono text-[#5A5550]">
                        {p.period}
                      </p>
                      <p className="text-lg font-bold mt-0.5">
                        {rm(p.netSen ?? p.grossSen)}
                      </p>
                    </div>
                    {open ? (
                      <ChevronUp className="h-4 w-4 text-[#8A8680]" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-[#8A8680]" />
                    )}
                  </button>
                  {open && (
                    <div className="px-4 pb-4 pt-1 space-y-1.5 text-sm border-t border-[#F0ECE9]">
                      <Row
                        label={t("pay.basicEarned")}
                        value={rm(p.basicSen)}
                      />
                      {p.allowancesSen ? (
                        <Row label="Allowances" value={rm(p.allowancesSen)} />
                      ) : null}
                      {p.overtimeSen ? (
                        <Row label={t("pay.ot")} value={rm(p.overtimeSen)} />
                      ) : null}
                      <div className="pt-1.5 border-t border-[#F0ECE9]">
                        <Row
                          label={t("pay.gross")}
                          value={rm(p.grossSen)}
                          bold
                        />
                      </div>
                      {p.epfEeSen ? (
                        <Row label="EPF" value={`- ${rm(p.epfEeSen)}`} muted />
                      ) : null}
                      {p.socsoEeSen ? (
                        <Row
                          label="SOCSO"
                          value={`- ${rm(p.socsoEeSen)}`}
                          muted
                        />
                      ) : null}
                      {p.eisEeSen ? (
                        <Row label="EIS" value={`- ${rm(p.eisEeSen)}`} muted />
                      ) : null}
                      {p.taxSen ? (
                        <Row label="Tax" value={`- ${rm(p.taxSen)}`} muted />
                      ) : null}
                      <div className="pt-1.5 border-t border-[#F0ECE9]">
                        <Row label="Net" value={rm(p.netSen)} bold />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- tiny UI helpers ----------
function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        muted ? "text-[#8A8680]" : ""
      }`}
    >
      <span>{label}</span>
      <span className={bold ? "font-bold" : ""}>{value}</span>
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

function Mini({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl p-3 border border-[#D8D2CC] text-center">
      <p className="text-[10px] uppercase tracking-wide text-[#8A8680] font-semibold">
        {label}
      </p>
      <p
        className={`text-2xl font-bold mt-1 ${
          accent ? "text-[#9C6F1E]" : "text-[#1F1D1B]"
        }`}
      >
        {value}
      </p>
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
