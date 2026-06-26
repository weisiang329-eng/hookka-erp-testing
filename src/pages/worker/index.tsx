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
import {
  ScanLine,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Camera,
  Megaphone,
  MapPin,
  ChevronDown,
} from "lucide-react";
import { useT, useWorkerLang } from "@/lib/worker-i18n";
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
const AnnouncementsEnvelope = TodayEnvelope;

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
// Office → worker announcement. The office types ONE language; the backend
// auto-translates title+body into all four worker-portal languages on POST and
// returns them here. Each worker sees the version matching their chosen portal
// language, falling back to the original posted title/body.
type Announcement = {
  id: string;
  title: string;
  body: string;
  createdAt: string | null;
  translations?: Record<
    "en" | "ms" | "zh" | "my",
    { title: string; body: string }
  > | null;
};

// Pick the worker-language version of a notice, falling back to the original
// posted text whenever the translation is missing/empty (Claude outage, or a
// row posted before auto-translation shipped).
function localizeAnnouncement(
  a: Announcement,
  lang: "en" | "ms" | "zh" | "my",
): { title: string; body: string } {
  const t = a.translations?.[lang];
  return {
    title: t?.title?.trim() ? t.title : a.title,
    body: t?.body?.trim() ? t.body : a.body,
  };
}
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

// ---------- announcements "seen" tracking (localStorage, v1) ----------
// We don't keep a per-worker read table server-side; the unread dot is purely
// a phone-local memory of which announcement ids this device has opened.
const SEEN_ANN_KEY = "hookka.worker.seenAnnouncements";
function readSeenAnnouncements(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_ANN_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}
function writeSeenAnnouncements(ids: Set<string>): void {
  try {
    // Cap the stored set so it can't grow unbounded over months of posts.
    const arr = Array.from(ids).slice(-200);
    localStorage.setItem(SEEN_ANN_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

// ---------- announcements "acknowledged" tracking (localStorage) ----------
// A passive banner is too easy to miss, so on app-open we POP any active
// announcement this device has NOT yet acknowledged as a modal the worker must
// tap to dismiss. We track acknowledgement separately from the "seen" dot above
// so the two never interfere: tapping the banner clears the dot but should NOT
// silently suppress the must-acknowledge popup, and vice-versa. Per-device only
// (no server table) — a NEW announcement id is absent from this set, so it pops
// the next time the worker opens the app; an expired one is already filtered out
// by the GET, so it never reaches the popup.
const ACK_ANN_KEY = "hookka.worker.ackAnnouncements";
function readAckAnnouncements(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_ANN_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}
function writeAckAnnouncements(ids: Set<string>): void {
  try {
    // Cap the stored set so it can't grow unbounded over months of posts.
    const arr = Array.from(ids).slice(-200);
    localStorage.setItem(ACK_ANN_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

// ---------- proactive location permission (Feature B) ----------
// On app open we PROACTIVELY ask for location. This pops the browser
// permission prompt for a worker who hasn't decided yet (so their next punch
// stamps "At factory" instead of "No GPS"). Browsers REMEMBER a hard deny and
// won't re-prompt, so the realistic UX is: request on open + a persistent nudge
// banner when not granted. We NEVER block clock-in — the punch still works
// unstamped (the existing getPunchLocation handles that).
type LocationState = "unknown" | "granted" | "denied" | "unavailable";

// Request a position once. Resolves the resulting permission state. A success
// means the worker granted (or had already granted) location; a failure with
// PERMISSION_DENIED means denied; anything else (no geolocation API, timeout,
// position unavailable) is "unavailable" — both surface the same nudge.
function requestLocationPermission(): Promise<LocationState> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve("unavailable");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => resolve("granted"),
      (err) => {
        // 1 === PERMISSION_DENIED across browsers.
        resolve(err && err.code === 1 ? "denied" : "unavailable");
      },
      // Same low-accuracy/indoor-friendly settings the punch uses, so a grant
      // here matches what the punch will actually get on the factory floor.
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
  // Worker's chosen portal language — drives which translation of each
  // announcement we show (localizeAnnouncement falls back to the original).
  const lang = useWorkerLang();
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [clocking, setClocking] = useState(false);
  // Inline punch feedback (e.g. "take a photo first"). Cleared on next attempt.
  const [clockErr, setClockErr] = useState<string | null>(null);

  // Dashboard date range — defaults to THIS MONTH (owner 2026-06-12), so the
  // stat cards read as the month-to-date the worker's pay estimate covers.
  const [from, setFrom] = useState<string>(() => {
    const n = new Date();
    return ymd(new Date(n.getFullYear(), n.getMonth(), 1));
  });
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [hist, setHist] = useState<HistoryData | null>(null);
  // Tap-to-expand share roster on Completed Products.
  const [openShare, setOpenShare] = useState<string | null>(null);

  // ---- Announcements (Feature A) ----
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  // Per-announcement collapse (owner 2026-06-26: long announcements eat the
  // screen — tap the header to fold/unfold, same as the Standard Times card).
  // Holds the COLLAPSED ids; default is expanded (id absent → open).
  const [collapsedAnn, setCollapsedAnn] = useState<Set<string>>(new Set());
  const toggleAnnCollapsed = useCallback((id: string) => {
    setCollapsedAnn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Which announcement ids this device has already opened (drives the dot).
  const [seenAnn, setSeenAnn] = useState<Set<string>>(() =>
    readSeenAnnouncements(),
  );
  // Which announcement ids this device has tapped "Got it" on (suppresses the
  // must-acknowledge popup; the re-readable banner below stays regardless).
  const [ackAnn, setAckAnn] = useState<Set<string>>(() =>
    readAckAnnouncements(),
  );
  // ---- Past announcements (archive) ----
  // Expired/hidden notices that have dropped out of the live list above. They
  // are NOT loaded with the page — the section starts collapsed and lazy-loads
  // the archive on the first tap (owner 2026-06-26: re-readable history).
  const [pastOpen, setPastOpen] = useState(false);
  const [pastAnn, setPastAnn] = useState<Announcement[] | null>(null);
  const [pastLoading, setPastLoading] = useState(false);
  // Per-row collapse for the archive (same fold pattern as the live list; holds
  // the COLLAPSED ids, default expanded). Kept separate from collapsedAnn so the
  // two lists never share/clobber each other's open state.
  const [collapsedPast, setCollapsedPast] = useState<Set<string>>(new Set());
  const togglePastCollapsed = useCallback((id: string) => {
    setCollapsedPast((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- Location permission (Feature B) ----
  const [locState, setLocState] = useState<LocationState>("unknown");

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

  // Active announcements — best-effort; a failure just leaves the banner empty
  // and never strands the page (same posture as /history).
  //
  // The popup gate is now SERVER-driven: the GET also returns `ackedIds` — the
  // active notices THIS worker has already acknowledged on the server (and
  // hasn't been reminded about since). We seed the popup-suppress set (ackAnn)
  // from that so a fresh device re-pops every un-acked notice until the server
  // confirms the ack, and a "Remind" re-pops it. We MERGE rather than replace
  // so the optimistic localStorage cache still suppresses a just-tapped notice
  // if the server round-trip is mid-flight (no flicker on a flaky network).
  const refreshAnnouncements = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/announcements");
      const raw = await res.json();
      const j = AnnouncementsEnvelope.parse(raw);
      if (j.success && Array.isArray(j.data)) {
        const list = j.data as Announcement[];
        setAnnouncements(list);
        const serverAcked = (j as { ackedIds?: unknown }).ackedIds;
        if (Array.isArray(serverAcked)) {
          const serverSet = new Set(
            serverAcked.filter((x): x is string => typeof x === "string"),
          );
          // Reconcile to the server truth for the CURRENTLY-active notices:
          // keep a notice suppressed only if the server says acked. This is
          // what makes "Remind" re-pop — the server drops the id from ackedIds,
          // so we drop it from ackAnn here. Notices not in the active list keep
          // their cached state (offline resilience for older ids).
          setAckAnn((prev) => {
            const next = new Set(prev);
            const activeIds = new Set(list.map((a) => a.id));
            for (const id of activeIds) {
              if (serverSet.has(id)) next.add(id);
              else next.delete(id);
            }
            writeAckAnnouncements(next);
            return next;
          });
        }
      }
    } catch {
      /* leave announcements as-is */
    }
  }, []);

  // Lazy-load the archive (expired/hidden notices) the FIRST time the worker
  // expands the "Past announcements" section. Read-only, best-effort: a failure
  // leaves an empty list, never strands the page. Re-fetch on every open so a
  // notice that just expired shows up without a hard refresh.
  const loadPastAnnouncements = useCallback(async () => {
    setPastLoading(true);
    try {
      const res = await workerFetch(
        "/api/worker/announcements?include=past",
      );
      const raw = await res.json();
      const j = AnnouncementsEnvelope.parse(raw);
      if (j.success && Array.isArray(j.data)) {
        setPastAnn(j.data as Announcement[]);
      } else {
        setPastAnn([]);
      }
    } catch {
      setPastAnn((prev) => prev ?? []);
    } finally {
      setPastLoading(false);
    }
  }, []);

  const togglePastOpen = useCallback(() => {
    setPastOpen((wasOpen) => {
      const nextOpen = !wasOpen;
      // Lazy-load (or refresh) on open.
      if (nextOpen) void loadPastAnnouncements();
      return nextOpen;
    });
  }, [loadPastAnnouncements]);

  useEffect(() => {
    refreshToday();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount data load; refresh* are stable useCallbacks
    refreshAnnouncements();
  }, [refreshToday, refreshAnnouncements]);

  // Feature B — proactively request location ONCE on app open. This prompts a
  // worker who hasn't decided yet (so their punch stamps "At factory"); a
  // worker who already granted resolves "granted" silently (no banner); a hard
  // deny resolves "denied" and surfaces the nudge. Never blocks anything.
  /* eslint-disable react-hooks/set-state-in-effect -- async permission probe; setState lives inside the resolved promise */
  useEffect(() => {
    let alive = true;
    requestLocationPermission().then((s) => {
      if (alive) setLocState(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // Mark all currently-shown announcements as seen (clears the unread dots).
  // Called when the worker expands/taps the Announcements card.
  function markAnnouncementsSeen() {
    setSeenAnn((prev) => {
      const next = new Set(prev);
      for (const a of announcements) next.add(a.id);
      writeSeenAnnouncements(next);
      return next;
    });
  }

  // Tap "Got it" on the popup → acknowledge exactly the announcements that were
  // shown. This now does TWO things:
  //   1. Records a real per-worker ack on the SERVER (POST /:id/ack, idempotent)
  //      so the office read-receipt shows this worker, and the popup stays
  //      suppressed even on a fresh device once the server confirms it.
  //   2. Optimistically updates the localStorage cache (ackAnn + seenAnn) so the
  //      popup closes instantly and never re-flashes while the POST is in
  //      flight or if the network is flaky.
  // The re-readable banner stays in place for later reference.
  function acknowledgeAnnouncements(shown: Announcement[]) {
    const shownIds = shown.map((a) => a.id);
    // Optimistic local suppress (offline cache) — closes the popup immediately.
    setAckAnn((prev) => {
      const next = new Set(prev);
      for (const id of shownIds) next.add(id);
      writeAckAnnouncements(next);
      return next;
    });
    setSeenAnn((prev) => {
      const next = new Set(prev);
      for (const id of shownIds) next.add(id);
      writeSeenAnnouncements(next);
      return next;
    });
    // Fire the server ack for each shown id (fire-and-forget; the optimistic
    // local cache already closed the popup). Idempotent on the backend — a
    // double-tap or a retry is a no-op. Failures are swallowed: the local cache
    // still suppresses the popup, and the next app open re-tries via the gate.
    void Promise.all(
      shownIds.map((id) =>
        workerFetch(
          `/api/worker/announcements/${encodeURIComponent(id)}/ack`,
          { method: "POST" },
        ).catch(() => undefined),
      ),
    );
  }

  // Re-request location after a worker has (hopefully) flipped the browser
  // setting. If they're still denied the browser resolves immediately without
  // a prompt, so this is safe to tap repeatedly.
  async function retryLocation() {
    const s = await requestLocationPermission();
    setLocState(s);
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

  // Announcements the worker hasn't opened on this device yet → unread dot.
  const unreadAnnouncements = announcements.filter((a) => !seenAnn.has(a.id)).length;
  // Must-acknowledge popup: every ACTIVE announcement this device hasn't tapped
  // "Got it" on yet. `announcements` already only contains active (non-expired)
  // posts — the GET applies the auto-hide/expiry filter — so an expired one
  // never reaches here. Most recent first (mirrors the banner order). If there
  // are several, we show them together in one popup and acknowledge them all on
  // dismiss (kept deliberately simple — no per-item queue).
  const popupAnnouncements = announcements.filter((a) => !ackAnn.has(a.id));
  // Show the location nudge whenever we did NOT end up granted (denied OR the
  // device couldn't get a fix). Never shown while "unknown" (the probe is still
  // running / the worker hasn't answered the prompt yet) so it can't flash.
  const showLocNudge = locState === "denied" || locState === "unavailable";

  return (
    <div className="space-y-4 pt-2">
      {/* Must-acknowledge announcement popup. A passive banner is too easy to
          miss, so any ACTIVE announcement this device hasn't tapped "Got it" on
          pops as a centered modal the moment the worker lands on the home screen
          (past PIN login). It is fully dismissable — tapping "Got it" records the
          shown ids in localStorage so it never re-pops here, while the banner
          below stays for re-reading. It only renders once `data` has loaded, so
          it can never overlay the login / clock-in flow. A NEW post (new id) is
          absent from the ack set, so it pops on the next open. */}
      {popupAnnouncements.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center gap-2 bg-[#6B5C32] px-4 py-3 text-white">
              <Megaphone className="h-5 w-5 shrink-0" />
              <span className="text-base font-bold">
                {t("home.announcementPopupTitle")}
              </span>
            </div>
            <div className="max-h-[60vh] divide-y divide-[#F0ECE9] overflow-y-auto px-4 py-1">
              {popupAnnouncements.map((a) => {
                const { title, body } = localizeAnnouncement(a, lang);
                return (
                  <div key={a.id} className="py-3">
                    <p className="text-base font-bold text-[#1F1D1B] break-words">
                      {title}
                    </p>
                    {body && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[#5A5550]">
                        {body}
                      </p>
                    )}
                    {a.createdAt && (
                      <p className="mt-1.5 text-[11px] text-[#9CA3AF]">
                        {fmtDay(a.createdAt)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="px-4 pb-4 pt-2">
              <button
                type="button"
                onClick={() => acknowledgeAnnouncements(popupAnnouncements)}
                className="h-12 w-full rounded-xl bg-[#6B5C32] text-base font-bold text-white transition-colors hover:bg-[#5a4d2a] active:translate-y-[1px]"
              >
                {t("home.announcementGotIt")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Greeting */}
      <div>
        <p className="text-sm text-[#5A5550]">{t("home.hello")},</p>
        <h1 className="text-xl font-bold leading-tight">{displayName}</h1>
        <p className="text-xs text-[#8A8680]">
          {data.worker.empNo} · {data.worker.departmentCode}
        </p>
      </div>

      {/* Announcements (Feature A) — office posts, newest first. Tapping the
          card marks everything seen (clears the unread dots). */}
      {announcements.length > 0 && (
        <div className="bg-white rounded-xl border border-[#D8D2CC] shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-[#6B5C32] text-white">
            <Megaphone className="h-4 w-4" />
            <span className="text-sm font-semibold">{t("home.announcements")}</span>
            {unreadAnnouncements > 0 && (
              <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#9A3A2D] px-1.5 text-[11px] font-bold">
                {unreadAnnouncements}
              </span>
            )}
          </div>
          <ul
            onClick={markAnnouncementsSeen}
            className="divide-y divide-[#F0ECE9]"
          >
            {announcements.map((a) => {
              const unread = !seenAnn.has(a.id);
              const collapsed = collapsedAnn.has(a.id);
              const { title, body } = localizeAnnouncement(a, lang);
              return (
                <li key={a.id} className="px-4 py-3">
                  {/* Header row — tap to fold/unfold (owner 2026-06-26). The
                      click still bubbles to the <ul> so it also marks seen. */}
                  <button
                    type="button"
                    onClick={() => toggleAnnCollapsed(a.id)}
                    className="flex w-full items-start gap-2 text-left"
                  >
                    {unread && (
                      <span
                        aria-hidden
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#9A3A2D]"
                      />
                    )}
                    <p className="min-w-0 flex-1 text-sm font-semibold text-[#1F1D1B] break-words">
                      {title}
                      {unread && (
                        <span className="ml-1.5 align-middle text-[10px] font-bold uppercase tracking-wide text-[#9A3A2D]">
                          {t("home.newBadge")}
                        </span>
                      )}
                    </p>
                    <ChevronDown
                      className={`mt-0.5 h-4 w-4 shrink-0 text-[#8A8680] transition-transform ${collapsed ? "" : "rotate-180"}`}
                    />
                  </button>
                  {!collapsed && (
                    <div className="mt-0.5 pl-0">
                      {body && (
                        <p className="whitespace-pre-wrap break-words text-xs text-[#5A5550]">
                          {body}
                        </p>
                      )}
                      {a.createdAt && (
                        <p className="mt-1 text-[10px] text-[#9CA3AF]">
                          {fmtDay(a.createdAt)}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Past announcements (archive) — expired/hidden notices that dropped out
          of the live list above. Collapsed by default; tapping the header
          lazy-loads the archive (read-only). Each past row is itself
          foldable, mirroring the live list. */}
      <div className="bg-white rounded-xl border border-[#D8D2CC] shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={togglePastOpen}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[#5A5550]"
          aria-expanded={pastOpen}
        >
          <Megaphone className="h-4 w-4 text-[#8A8680]" />
          <span className="text-sm font-semibold">
            {t("home.pastAnnouncements")}
          </span>
          <ChevronDown
            className={`ml-auto h-4 w-4 shrink-0 text-[#8A8680] transition-transform ${pastOpen ? "rotate-180" : ""}`}
          />
        </button>
        {pastOpen && (
          <div className="border-t border-[#F0ECE9]">
            {pastLoading && pastAnn === null ? (
              <p className="px-4 py-3 text-xs text-[#9CA3AF]">
                {t("common.loading")}
              </p>
            ) : pastAnn && pastAnn.length > 0 ? (
              <ul className="divide-y divide-[#F0ECE9]">
                {pastAnn.map((a) => {
                  const collapsed = collapsedPast.has(a.id);
                  const { title, body } = localizeAnnouncement(a, lang);
                  return (
                    <li key={a.id} className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => togglePastCollapsed(a.id)}
                        className="flex w-full items-start gap-2 text-left"
                      >
                        <p className="min-w-0 flex-1 text-sm font-semibold text-[#5A5550] break-words">
                          {title}
                        </p>
                        <ChevronDown
                          className={`mt-0.5 h-4 w-4 shrink-0 text-[#8A8680] transition-transform ${collapsed ? "" : "rotate-180"}`}
                        />
                      </button>
                      {!collapsed && (
                        <div className="mt-0.5 pl-0">
                          {body && (
                            <p className="whitespace-pre-wrap break-words text-xs text-[#5A5550]">
                              {body}
                            </p>
                          )}
                          {a.createdAt && (
                            <p className="mt-1 text-[10px] text-[#9CA3AF]">
                              {fmtDay(a.createdAt)}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-xs text-[#9CA3AF]">
                {t("home.noPastAnnouncements")}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Location nudge (Feature B) — shown when location is denied/unavailable
          so the worker's punch can stamp "At factory". Never blocks clock-in. */}
      {showLocNudge && (
        <div className="bg-[#FFF6E9] border border-[#E5C98A] rounded-xl p-3.5">
          <div className="flex items-start gap-2.5">
            <MapPin className="h-5 w-5 shrink-0 text-[#9C6F1E]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#7A5512]">
                {t("home.locationNeededTitle")}
              </p>
              <p className="mt-0.5 text-xs text-[#7A5512]">
                {t("home.locationNeededBody")}
              </p>
              <p className="mt-1 text-[11px] text-[#9C6F1E]">
                {t("home.locationHowTo")}
              </p>
              <button
                type="button"
                onClick={retryLocation}
                className="mt-2 h-9 rounded-lg bg-[#9C6F1E] px-4 text-sm font-semibold text-white hover:bg-[#86601a] transition-colors"
              >
                {t("home.locationRetry")}
              </button>
            </div>
          </div>
        </div>
      )}

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
            // Under 30 logged minutes the ratio is meaningless noise (a 1-min
            // test punch against real production minutes printed 16000%) —
            // show a dash until there's a real base.
            value={hist.totals.workedMinutes < 30 ? "—" : `${hist.totals.efficiencyPct}%`}
            tone={
              hist.totals.workedMinutes < 30
                ? "warn"
                : hist.totals.efficiencyPct >= 80
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

