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
import { ScanLine, AlertTriangle, Clock, CheckCircle2, Camera } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch, WORKER_ME_KEY } from "@/layouts/WorkerLayout";
import { deriveWipName } from "@/lib/wip-name";
import { compressImage } from "@/lib/image-compress";
import { z } from "zod";

// workerFetch handles auth + 401 redirect, but we still want runtime-typed
// JSON parsing on top — cast through a passthrough envelope schema.
const TodayEnvelope = z
  .object({ success: z.boolean().optional(), data: z.unknown().optional(), error: z.string().optional() })
  .passthrough();
const HistoryEnvelope = TodayEnvelope;

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
  // Co-PICs the worker shared this JC with — used to surface "shared with X"
  // when the worker taps the share badge.
  sharedWith?: Array<{ id: string; name: string }>;
};
type AttendanceRow = {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  workingMinutes: number;
  productionTimeMinutes: number;
  efficiencyPct: number;
  overtimeMinutes: number;
  /** Raw lateness past the grace, minutes (server-computed with the
   *  effective-dated rules — same figure the office sees). Optional so an
   *  older cached payload without it still renders. */
  lateMinutes?: number;
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
  // Local-tz YYYY-MM-DD. toISOString() would convert to UTC, which for
  // Malaysia (UTC+8) shifts midnight-local back to the previous day —
  // "this month" preset would land on 30 Apr instead of 1 May.
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
function fmtDay(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
}
// Best-effort punch location for the soft geofence. Resolves to null when the
// device has no geolocation, the worker denies permission, or it times out — the
// punch still goes through (soft: location only flags out-of-area, never blocks).
function getPunchLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    // enableHighAccuracy:false → uses wifi/cell, not just GPS satellites, so a
    // fix arrives INDOORS (high-accuracy GPS often times out on a factory floor
    // and left every punch with null location). ±50-100m is plenty for a 200m
    // factory fence. Longer timeout so a slow first fix still lands.
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
    );
  });
}

// Snap a punch selfie (anti-buddy-punching). Opens the front camera, compresses
// the shot to a small JPEG data URL, and resolves it. Resolves null if the
// worker cancels / no file / the camera isn't available — three independent
// cancel signals (the native 'cancel' event, a focus-return check, and a hard
// safety timeout) guarantee the punch flow never hangs waiting on the camera.
function capturePunchPhoto(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      try {
        input.remove();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    // capture="user" → front (selfie) camera on phones; ignored on desktop.
    input.setAttribute("capture", "user");
    input.style.display = "none";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) {
        done(null);
        return;
      }
      try {
        done(await compressImage(file, { maxDim: 640, quality: 0.6 }));
      } catch {
        done(null);
      }
    };
    // Modern browsers fire 'cancel' when the picker is dismissed with no file.
    input.addEventListener("cancel", () => done(null));
    // Fallback for browsers without 'cancel': when the window regains focus
    // after the camera closes, give onchange a beat; if still no file, cancel.
    // 3s (was 1s): slow phones can take over a second to hand the photo file
    // back after the camera app closes — a 1s window misread a REAL photo as
    // a cancel and told the worker "please take a photo" again.
    window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) done(null);
        }, 3000);
      },
      { once: true },
    );
    // Hard safety net: never leave the punch hanging on a stuck camera.
    setTimeout(() => done(null), 90000);
    document.body.appendChild(input);
    input.click();
  });
}

// ============================================================
export default function WorkerHomePage() {
  const t = useT();
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [clocking, setClocking] = useState(false);
  // Inline punch feedback (e.g. "take a photo first"). Cleared on next attempt.
  const [clockErr, setClockErr] = useState<string | null>(null);

  // Dashboard date range — default to last 7 days
  const [from, setFrom] = useState<string>(() => ymd(addDays(new Date(), -6)));
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [hist, setHist] = useState<HistoryData | null>(null);
  // Tap-to-expand share roster on Completed Products.
  const [openShare, setOpenShare] = useState<string | null>(null);

  // ---- fetches ----
  const refreshToday = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/today");
      const raw = await res.json();
      const j = TodayEnvelope.parse(raw);
      if (j.success) setData(j.data as TodayData);
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
      const raw = await res.json();
      const j = HistoryEnvelope.parse(raw);
      if (j.success) setHist(j.data as HistoryData);
    } catch {
      /* leave hist as-is */
    }
  }, []);

  useEffect(() => {
    refreshToday();
  }, [refreshToday]);

  /* eslint-disable react-hooks/set-state-in-effect -- refresh history when date range changes; setState lives inside the async callback */
  useEffect(() => {
    refreshHistory(from, to);
  }, [refreshHistory, from, to]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleClock(action: "CLOCK_IN" | "CLOCK_OUT") {
    setClocking(true);
    setClockErr(null);
    try {
      // Anti-buddy-punching: a selfie is REQUIRED to punch. The camera opens
      // first; if the worker cancels it, we abort with a clear message (they
      // just tap again). This is what stops one phone punching for someone else.
      const photo = await capturePunchPhoto();
      if (!photo) {
        setClockErr(t("home.photoRequired"));
        return;
      }
      // Soft geofence: attach the worker's location if we can get it. Denied /
      // unavailable / timeout → null → the punch still goes through unstamped.
      const loc = await getPunchLocation();
      const payload: Record<string, unknown> = { action, photo };
      if (loc) {
        payload.lat = loc.lat;
        payload.lng = loc.lng;
      }
      await workerFetch("/api/worker/clock", {
        method: "POST",
        body: JSON.stringify(payload),
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
  // Wei Siang 2026-06-09: self-punch is now LIVE — the clock card (Punch In /
  // Punch Out) shows for every worker. Punch records attendance only; it does
  // NOT yet drive payroll hours (that wiring comes with the owner's pay spec).
  const SHOW_CLOCK = true;
  // The stat grid (Pending / In Progress / Pieces done) + report-issue card are
  // still hidden — they read the JC/scan counters that aren't surfaced yet
  // (always 0). Keep them gated until their own rollout.
  const SHOW_CLOCK_AND_SCAN = false;
  // Wei Siang 2026-06-05: the shop-floor scan is NOT locked to a worker's own
  // department — anyone can scan the Fab Cut / Fab Sew (and soon Packing)
  // stickers. The completion endpoints enforce which sticker depts are allowed
  // and bind the scan to whoever scanned, so the entry point can be open to
  // every worker (the bottom-nav Scan tab is shown to all too). Clock-in, the
  // stat grid and report-issue stay hidden until their own rollout.
  const SHOW_SCAN = true;

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
      {SHOW_CLOCK && (
      <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] shadow-sm">
        {!clockedIn ? (
          <button
            type="button"
            onClick={() => handleClock("CLOCK_IN")}
            disabled={clocking}
            className="w-full h-14 rounded-lg bg-[#3E6570] hover:bg-[#355863] text-white text-lg font-semibold disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            {clocking ? (
              <>
                <Camera className="h-5 w-5" />
                {t("home.openingCamera")}
              </>
            ) : (
              <>
                <Clock className="h-5 w-5" />
                {t("home.clockIn")}
              </>
            )}
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
                className="w-full h-11 rounded-lg bg-[#F0ECE9] hover:bg-[#E5E0DB] text-[#1F1D1B] text-sm font-semibold disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
              >
                {clocking ? (
                  <>
                    <Camera className="h-4 w-4" />
                    {t("home.openingCamera")}
                  </>
                ) : (
                  t("home.clockOut")
                )}
              </button>
            )}
          </div>
        )}
        {clockErr && (
          <div className="mt-2 text-center">
            <p className="text-sm font-medium text-[#9A3A2D]">{clockErr}</p>
            {/* The selfie uses the phone's native camera: if the OS has camera
                blocked for the browser app, the picker opens with no camera and
                the worker only sees "photo required" forever. Tell them the fix
                — every new tap retries, so once allowed it just works. */}
            <p className="mt-1 text-xs text-[#8A8680]">
              {t("home.cameraBlockedHint")}
            </p>
          </div>
        )}
      </div>
      )}

      {/* Stat grid — Pending / In Progress / Pieces done today.
          Wei Siang 2026-05-10: tied to scan/JC flow which is hidden for now,
          so the numbers are always 0 — gate behind SHOW_CLOCK_AND_SCAN too. */}
      {SHOW_CLOCK_AND_SCAN && (
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
      )}

      {/* Big scan button — Fab Cut / Fab Sew only (see SHOW_SCAN). */}
      {SHOW_SCAN && (
      <Link
        to="/worker/scan"
        className="block w-full h-20 rounded-xl bg-[#6B5C32] hover:bg-[#5a4d2a] text-white text-xl font-bold tracking-wide shadow-md active:shadow-sm active:translate-y-[1px] transition-all"
      >
        <span className="h-full w-full flex items-center justify-center gap-3">
          <ScanLine className="h-7 w-7" />
          {t("home.scanBig")}
        </span>
      </Link>
      )}

      {/* Report problem secondary — Wei Siang 2026-05-10: not yet live. */}
      {SHOW_CLOCK_AND_SCAN && (
      <Link
        to="/worker/issue"
        className="block w-full h-12 rounded-lg bg-white border border-[#D8D2CC] text-[#9A3A2D] font-semibold text-sm hover:bg-[#FDF6F4] transition-colors"
      >
        <span className="h-full w-full flex items-center justify-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {t("home.reportIssue")}
        </span>
      </Link>
      )}

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
          {t("home.dashboardTitle")}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <label className="block">
            <span className="text-[11px] text-white/60">{t("pay.from")}</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full h-11 px-3 pr-2 rounded bg-white/10 text-white text-sm border border-white/20 focus:outline-none focus:ring-2 focus:ring-[#6B5C32] appearance-none"
              style={{ colorScheme: "dark" }}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-white/60">{t("pay.to")}</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full h-11 px-3 pr-2 rounded bg-white/10 text-white text-sm border border-white/20 focus:outline-none focus:ring-2 focus:ring-[#6B5C32] appearance-none"
              style={{ colorScheme: "dark" }}
            />
          </label>
        </div>

        <div className="flex gap-1.5 mt-2 overflow-x-auto -mx-1 px-1">
          <Chip onClick={() => setPreset("7d")}>{t("home.last7d")}</Chip>
          <Chip onClick={() => setPreset("30d")}>{t("home.last30d")}</Chip>
          <Chip onClick={() => setPreset("month")}>{t("pay.thisMonthChip")}</Chip>
          <Chip onClick={() => setPreset("lastMonth")}>{t("pay.lastMonth")}</Chip>
        </div>
      </div>

      {/* KPI row */}
      {hist && (
        <div className="grid grid-cols-3 gap-2">
          <Kpi
            label={t("home.workingHours")}
            value={mins2hrs(hist.totals.workedMinutes)}
          />
          <Kpi
            label={t("home.productionTime")}
            value={mins2hrs(hist.totals.productionMinutes)}
          />
          <Kpi
            label={t("home.efficiencyPct")}
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

      {/* Daily attendance MOVED to the Pay page (owner 2026-06-12: the per-day
          punch records belong under the pay breakdown, following its month
          picker). Home stays focused on today + completed pieces. */}

      {/* Team summary lived here pre-2026-05-10. Moved to /worker/team
          (dedicated tab on the bottom nav) so the leader gets the full
          Department Performance view — KPI strip + daily breakdown +
          per-worker drilldown — instead of a cramped at-a-glance card on
          the Home page. Home stays focused on the worker's own day. */}

      {/* Completed products */}
      {hist && (
        <TableSection title={`${t("home.completedProducts")} (${hist.completed.length})`}>
          <TableHeader
            cols={[t("home.colDateDept"), t("home.colMins")]}
            align={["left", "right"]}
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
              // Two-line row: top has Date | Dept badge | Mins; bottom is the
              // product label, allowed to wrap so long WIP names don't get
              // clipped on narrow mobile viewports.
              return (
                <div
                  key={c.jobCardId}
                  className="py-2.5 text-sm border-t border-[#F0ECE9]"
                >
                  <div className="flex items-center gap-2">
                    <span className="tabular-nums text-xs text-[#5A5550] whitespace-nowrap">
                      {fmtDay(c.completedDate || "")}
                    </span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#5A5550] font-semibold whitespace-nowrap">
                      {c.departmentCode}
                    </span>
                    <span className="flex-1" />
                    <span className="tabular-nums text-right font-semibold">
                      {c.myMinutes} min
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[#1F1D1B] break-words">
                    {label}
                    {c.totalPieces > 1 && (
                      <span className="ml-1 text-[10px] text-[#8A8680]">
                        ({c.piecesWorked}/{c.totalPieces})
                      </span>
                    )}
                    {c.piecesShared > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setOpenShare((prev) =>
                            prev === c.jobCardId ? null : c.jobCardId,
                          )
                        }
                        className="ml-1 text-[10px] text-[#6B5C32] underline decoration-dotted underline-offset-2 hover:text-[#5a4d2a]"
                      >
                        · share
                      </button>
                    )}
                  </div>
                  {openShare === c.jobCardId && c.piecesShared > 0 && (
                    <div className="mt-1.5 ml-0 px-2.5 py-1.5 rounded bg-[#FAF7EE] border border-[#E5DEC6] text-[11px] text-[#5A5550]">
                      {c.sharedWith && c.sharedWith.length > 0
                        ? `${t("home.shareWith")}: ${c.sharedWith.map((w) => w.name).join(", ")}`
                        : t("home.shareWith")}
                    </div>
                  )}
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
  // Match the row templates exactly so headers sit above their column.
  // - 4 cols → Daily breakdown rows use [auto_1fr_1fr_1fr]
  // - 2 cols → Completed products header (rows are flex)
  // - other → equal split
  const gridCols =
    cols.length === 4
      ? "grid-cols-[auto_1fr_1fr_1fr]"
      : cols.length === 2
        ? "grid-cols-[1fr_auto]"
        : `grid-cols-${cols.length}`;
  return (
    <div
      className={`grid ${gridCols} gap-3 py-2 text-[10px] font-bold uppercase tracking-wide text-[#8A8680] bg-[#EAF3E5] -mx-3 px-3`}
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

