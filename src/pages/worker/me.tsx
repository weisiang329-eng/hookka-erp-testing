// ============================================================
// /worker/me — Profile, language, leave, logout
//
// The "account" tab. Single scroll, three cards:
//   1. Profile card (empNo, dept, phone — editable)
//   2. Leave summary + history + inline "apply" form
//   3. Settings: language switcher (full-width, easy to tap) + logout
//
// No separate PIN-change screen here — workers already have
// self-service reset from the login page.
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Plus, Clock, Search, ChevronDown, Megaphone } from "lucide-react";
import {
  useT,
  useLangState,
  LANG_LABELS,
  type WorkerLang,
} from "@/lib/worker-i18n";
import {
  workerFetch,
  clearWorkerAuth,
  WORKER_ME_KEY,
  type WorkerMe,
} from "@/lib/worker-session";
import {
  AnnouncementMedia,
  type Announcement,
} from "./announcement-media";
import { AnnouncementCategoryBadge } from "@/components/announcement-category-badge";
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_ORDER,
  normalizeAnnouncementCategory,
  type AnnouncementCategory,
} from "@/lib/announcement-category";

type LeaveRecord = {
  id: string;
  workerId: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason?: string;
};

type LeavesData = {
  balance: {
    annualRemaining: number;
    medicalRemaining: number;
    annualEntitlement: number;
    medicalEntitlement: number;
  };
  history: LeaveRecord[];
};

type WorkerMeResponse = { success: true; worker: WorkerMe } | { success: false; error?: string };
type WorkerLeavesResponse = { success: true; data: LeavesData } | { success: false; error?: string };
type WorkerActionResponse = { success: true } | { success: false; error?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Local copies of the announcement helpers (the shared announcement-media file
// can't export non-component functions alongside the component — fast-refresh
// lint). Kept in sync with worker/index.tsx.
function localizeAnnouncement(
  a: Announcement,
  lang: WorkerLang,
): { title: string; body: string } {
  const t = a.translations?.[lang];
  return {
    title: t?.title?.trim() ? t.title : a.title,
    body: t?.body?.trim() ? t.body : a.body,
  };
}
function fmtDay(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
}

function asWorkerMe(v: unknown): WorkerMe | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const empNo = asString(v.empNo);
  const name = asString(v.name);
  const departmentCode = asString(v.departmentCode);
  if (!id || !empNo || !name || !departmentCode) return null;
  return {
    id,
    empNo,
    name,
    departmentCode,
    position: asString(v.position) ?? undefined,
    phone: asString(v.phone) ?? undefined,
    nationality: asString(v.nationality) ?? undefined,
  };
}

function asLeaveRecord(v: unknown): LeaveRecord | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const workerId = asString(v.workerId);
  const type = asString(v.type);
  const startDate = asString(v.startDate);
  const endDate = asString(v.endDate);
  const days = asNumber(v.days);
  const status = asString(v.status);
  if (!id || !workerId || !type || !startDate || !endDate || days === null) return null;
  if (status !== "PENDING" && status !== "APPROVED" && status !== "REJECTED") return null;
  return {
    id,
    workerId,
    type,
    startDate,
    endDate,
    days,
    status,
    reason: asString(v.reason) ?? undefined,
  };
}

function asLeavesData(v: unknown): LeavesData | null {
  if (!isRecord(v) || !isRecord(v.balance) || !Array.isArray(v.history)) return null;
  const annualRemaining = asNumber(v.balance.annualRemaining);
  const medicalRemaining = asNumber(v.balance.medicalRemaining);
  const annualEntitlement = asNumber(v.balance.annualEntitlement);
  const medicalEntitlement = asNumber(v.balance.medicalEntitlement);
  if (
    annualRemaining === null ||
    medicalRemaining === null ||
    annualEntitlement === null ||
    medicalEntitlement === null
  ) return null;
  const history = v.history.map(asLeaveRecord).filter((x): x is LeaveRecord => !!x);
  return {
    balance: {
      annualRemaining,
      medicalRemaining,
      annualEntitlement,
      medicalEntitlement,
    },
    history,
  };
}

function asWorkerMeResponse(v: unknown): WorkerMeResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) {
    const worker = asWorkerMe(v.worker);
    return worker ? { success: true, worker } : null;
  }
  if (v.success === false) return { success: false, error: asString(v.error) ?? undefined };
  return null;
}

function asWorkerLeavesResponse(v: unknown): WorkerLeavesResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) {
    const data = asLeavesData(v.data);
    return data ? { success: true, data } : null;
  }
  if (v.success === false) return { success: false, error: asString(v.error) ?? undefined };
  return null;
}

function asWorkerActionResponse(v: unknown): WorkerActionResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) return { success: true };
  if (v.success === false) return { success: false, error: asString(v.error) ?? undefined };
  return null;
}

// Tiny client-side SWR cache for GET /api/worker/wip-times (the Standard Times
// card). The standard minutes are effectively static between BOM edits, so a
// worker re-opening the card or flipping between their departments shouldn't pay
// for a fresh network round-trip each time. Keyed by department (""=default).
// stale-while-revalidate: the cached payload renders instantly, then a
// background fetch refreshes it. Module-scoped so it survives card collapse /
// re-expand within the session (cleared on full reload). 60s TTL bounds how
// stale a just-edited time can look.
type StdTimesPayload = {
  department: string;
  departmentCodes: string[];
  rows: Array<{
    wipLabel: string;
    wipType: string;
    itemCategory: string;
    minutes: number;
    productCount: number;
  }>;
};
const STD_TIMES_TTL_MS = 60_000;
const stdTimesCache = new Map<string, { at: number; data: StdTimesPayload }>();

export default function WorkerMePage() {
  const t = useT();
  const navigate = useNavigate();
  const [lang, setLang] = useLangState();
  const [me, setMe] = useState<WorkerMe | null>(() => {
    try {
      const raw = localStorage.getItem(WORKER_ME_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  // Wei Siang 2026-05-10: leave-application flow not yet live for workers.
  // Flip back on by setting SHOW_LEAVES = true.
  const SHOW_LEAVES = false;
  const [leaves, setLeaves] = useState<LeavesData | null>(null);
  const [leavesLoading, setLeavesLoading] = useState(true);
  const [phone, setPhone] = useState(me?.phone || "");
  const [phoneDirty, setPhoneDirty] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Leave request form state
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [leaveType, setLeaveType] = useState<string>("ANNUAL");
  const [leaveStart, setLeaveStart] = useState("");
  const [leaveEnd, setLeaveEnd] = useState("");
  const [leaveReason, setLeaveReason] = useState("");
  const [leaveSubmitting, setLeaveSubmitting] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // Non-production hours (owner 2026-06-26): a worker who spent part of the day
  // on non-production work (e.g. helping R&D) applies here. An admin approves
  // from the Working Hours screen, which writes a non-production working-hours
  // row so those hours are excluded from the efficiency denominator — keeping
  // the worker's efficiency fair. ADD-only on top of the existing portal.
  // Time adjustment (owner 2026-06-26): the worker picks a TYPE —
  //   • Non-production — existing: any NON-production dept; the approved hours
  //     land in a non-prod working-hours row, EXCLUDED from the efficiency
  //     denominator, so efficiency stays fair.
  //   • Extra production time (ADD_PROD) — a PRODUCTION dept + hours + optional
  //     job/WIP ref; the approved hours are ADDED to the efficiency numerator
  //     (extra production output) when a job ran longer than its WIP standard.
  // ADD-only on top of the existing portal — the non-prod path is unchanged.
  type NonprodDept = { code: string; name: string };
  type NonprodRequest = {
    id: string;
    date: string;
    departmentCode: string;
    hours: number;
    note: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
    kind?: "NONPROD" | "ADD_PROD";
    jobCardId?: string;
    createdAt?: string;
    decidedAt?: string;
    // Owner 2026-07-04: office decision detail shown back to the worker.
    rejectReason?: string;
    approvedHours?: number | null;
  };
  const [npDepts, setNpDepts] = useState<NonprodDept[]>([]);
  const [prodDepts, setProdDepts] = useState<NonprodDept[]>([]);
  const [npRequests, setNpRequests] = useState<NonprodRequest[]>([]);
  const [npShowForm, setNpShowForm] = useState(false);
  const [npKind, setNpKind] = useState<"NONPROD" | "ADD_PROD">("NONPROD");
  const [npDept, setNpDept] = useState("");
  const [npDate, setNpDate] = useState(() => new Date().toISOString().slice(0, 10));
  // The worker enters MINUTES (owner 2026-06-27: "20" meant 20 min, not 20h).
  // We store `npMinutes` as the raw input and convert to hours (minutes / 60)
  // only at submit time — the backend + efficiency math keep `hours` as the
  // stored unit, so nothing downstream changes.
  const [npMinutes, setNpMinutes] = useState("");
  const [npJobRef, setNpJobRef] = useState("");
  const [npNote, setNpNote] = useState("");
  const [npSubmitting, setNpSubmitting] = useState(false);
  const [npError, setNpError] = useState<string | null>(null);
  // The whole Time adjustment card folds like the Standard Times / Past
  // announcements cards below it (owner 2026-06-27). Collapsed by default;
  // tapping the header expands to reveal the apply form + My requests list.
  const [taOpen, setTaOpen] = useState(false);
  // Mount-time "now" for the My-requests 14-day retention window. Captured in a
  // lazy initializer (NOT during render — Date.now() in render is impure) so it
  // stays stable across re-renders; the page re-mounts when the worker reopens
  // the tab, so the window is fresh enough.
  const [nowMs] = useState(() => Date.now());

  const loadNonprod = useCallback(async () => {
    try {
      const [dRes, pRes, rRes] = await Promise.all([
        workerFetch("/api/worker/nonprod-departments"),
        workerFetch("/api/worker/production-departments"),
        workerFetch("/api/worker/nonprod-requests"),
      ]);
      const dj = (await dRes.json()) as { success?: boolean; data?: NonprodDept[] };
      const pj = (await pRes.json()) as { success?: boolean; data?: NonprodDept[] };
      const rj = (await rRes.json()) as { success?: boolean; data?: NonprodRequest[] };
      if (dj?.success && Array.isArray(dj.data)) setNpDepts(dj.data);
      if (pj?.success && Array.isArray(pj.data)) setProdDepts(pj.data);
      if (rj?.success && Array.isArray(rj.data)) setNpRequests(rj.data);
    } catch {
      /* leave as-is — card shows empty / retries on next open */
    }
  }, []);

  async function handleSubmitNonprod(e: React.FormEvent) {
    e.preventDefault();
    setNpError(null);
    // Worker enters MINUTES → convert to hours for the API (stored unit).
    const minutesNum = Number(npMinutes);
    if (!npDept) {
      setNpError(t("nonprod.pickDept"));
      return;
    }
    // 1 min .. 24h (1440 min). Integer minutes; fractional hours (e.g. 20/60)
    // are fine for the backend's 0 < hours <= 24 check.
    if (
      !Number.isFinite(minutesNum) ||
      minutesNum <= 0 ||
      minutesNum > 24 * 60
    ) {
      setNpError(t("nonprod.hours"));
      return;
    }
    const hoursNum = minutesNum / 60;
    setNpSubmitting(true);
    try {
      const res = await workerFetch("/api/worker/nonprod-requests", {
        method: "POST",
        body: JSON.stringify({
          date: npDate,
          departmentCode: npDept,
          hours: hoursNum,
          note: npNote,
          kind: npKind,
          jobCardId: npKind === "ADD_PROD" ? npJobRef.trim() : "",
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j?.success) {
        setNpError(j?.error || t("common.error"));
        return;
      }
      setNpShowForm(false);
      setNpDept("");
      setNpMinutes("");
      setNpJobRef("");
      setNpNote("");
      await loadNonprod();
    } catch {
      setNpError(t("common.error"));
    } finally {
      setNpSubmitting(false);
    }
  }

  // Standard Times (owner 2026-06-26): the worker's OWN department's standard
  // minutes per WIP, so they know the time limit (no more "totally don't know").
  type StdTimeRow = {
    wipLabel: string;
    wipType: string;
    itemCategory: string;
    minutes: number;
    productCount: number;
  };
  const [stdOpen, setStdOpen] = useState(false);
  const [stdLoaded, setStdLoaded] = useState(false);
  const [stdLoading, setStdLoading] = useState(false);
  const [stdRows, setStdRows] = useState<StdTimeRow[]>([]);
  const [stdSearch, setStdSearch] = useState("");
  // Multi-department (owner 2026-06-26): the worker's full department set +
  // which one is currently being viewed. The backend returns the deduped set
  // (incl. primary) on every /wip-times hit, so the selector only renders when
  // the worker genuinely belongs to >1 department.
  const [stdDepts, setStdDepts] = useState<string[]>([]);
  const [stdDept, setStdDept] = useState<string | null>(null);

  const loadStandardTimes = useCallback(async (dept?: string) => {
    const cacheKey = dept ?? "";
    const applyPayload = (p: StdTimesPayload) => {
      if (Array.isArray(p.rows)) setStdRows(p.rows);
      if (Array.isArray(p.departmentCodes)) setStdDepts(p.departmentCodes);
      if (typeof p.department === "string") setStdDept(p.department);
      setStdLoaded(true);
    };
    // stale-while-revalidate: paint the cached payload first (no spinner), then
    // refresh in the background. A fresh/cold key shows the spinner as before.
    const cached = stdTimesCache.get(cacheKey);
    const fresh = cached && Date.now() - cached.at < STD_TIMES_TTL_MS;
    if (cached) applyPayload(cached.data);
    if (fresh) return; // within TTL — no network hit at all
    setStdLoading(!cached);
    try {
      const url = dept
        ? `/api/worker/wip-times?dept=${encodeURIComponent(dept)}`
        : "/api/worker/wip-times";
      const res = await workerFetch(url);
      const j = (await res.json()) as {
        success?: boolean;
        data?: {
          department?: string;
          departmentCodes?: string[];
          rows?: StdTimeRow[];
        };
      };
      if (j?.success && j.data) {
        const payload: StdTimesPayload = {
          department: typeof j.data.department === "string" ? j.data.department : "",
          departmentCodes: Array.isArray(j.data.departmentCodes)
            ? j.data.departmentCodes
            : [],
          rows: Array.isArray(j.data.rows) ? j.data.rows : [],
        };
        stdTimesCache.set(cacheKey, { at: Date.now(), data: payload });
        applyPayload(payload);
      } else {
        setStdLoaded(true);
      }
    } catch {
      /* leave empty — the card shows a retry-on-reopen */
    } finally {
      setStdLoading(false);
    }
  }, []);

  const selectStandardDept = useCallback(
    (dept: string) => {
      if (dept === stdDept) return;
      setStdDept(dept);
      void loadStandardTimes(dept);
    },
    [stdDept, loadStandardTimes],
  );

  // Past announcements archive (relocated from /worker home, owner 2026-06-26):
  // expired/hidden notices, read-only WITH media. Collapsed by default; lazy-
  // loads on first open and re-fetches on every open so a just-expired notice
  // shows without a hard refresh. Best-effort: a failure leaves an empty list.
  const [pastOpen, setPastOpen] = useState(false);
  const [pastAnn, setPastAnn] = useState<Announcement[] | null>(null);
  const [pastLoading, setPastLoading] = useState(false);
  // Category filter for the archive (owner 2026-06-27). "ALL" default; the
  // other chips narrow the (already-fetched) list client-side. null = All.
  const [pastCatFilter, setPastCatFilter] = useState<AnnouncementCategory | null>(
    null,
  );
  // Per-row collapse (holds the COLLAPSED ids, default expanded).
  const [collapsedPast, setCollapsedPast] = useState<Set<string>>(new Set());
  const togglePastCollapsed = useCallback((id: string) => {
    setCollapsedPast((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const loadPastAnnouncements = useCallback(async () => {
    setPastLoading(true);
    try {
      const res = await workerFetch("/api/worker/announcements?include=past");
      const j = (await res.json()) as {
        success?: boolean;
        data?: unknown;
      };
      if (j?.success && Array.isArray(j.data)) {
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
      if (nextOpen) void loadPastAnnouncements();
      return nextOpen;
    });
  }, [loadPastAnnouncements]);

  const loadLeaves = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/leaves");
      const j = asWorkerLeavesResponse(await res.json());
      if (j?.success) setLeaves(j.data);
    } finally {
      setLeavesLoading(false);
    }
  }, []);

  // Refresh /me and leaves on mount
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot mount data load; setState lives inside async callbacks (loadLeaves / loadNonprod are stable useCallbacks) */
  useEffect(() => {
    workerFetch("/api/worker-auth/me")
      .then((r) => r.json())
      .then((j) => {
        const parsed = asWorkerMeResponse(j);
        if (parsed?.success) {
          setMe(parsed.worker);
          setPhone(parsed.worker.phone || "");
          try {
            localStorage.setItem(WORKER_ME_KEY, JSON.stringify(parsed.worker));
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {
        /* ignore — keep cached */
      });
    loadLeaves();
    void loadNonprod();
  }, [loadLeaves, loadNonprod]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleSavePhone() {
    setPhoneSaving(true);
    setPhoneError(null);
    try {
      const res = await workerFetch("/api/worker/profile", {
        method: "PATCH",
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const j = asWorkerActionResponse(await res.json());
      if (res.ok && j?.success) {
        setPhoneDirty(false);
        if (me) {
          const next = { ...me, phone: phone.trim() };
          setMe(next);
          try {
            localStorage.setItem(WORKER_ME_KEY, JSON.stringify(next));
          } catch {
            /* ignore */
          }
        }
      } else {
        // Was silent on failure — the Save button just stayed, looking like
        // nothing happened. Tell the worker it did NOT save.
        setPhoneError("Couldn't save — please try again.");
      }
    } catch {
      setPhoneError("Couldn't save — check your connection.");
    } finally {
      setPhoneSaving(false);
    }
  }

  async function handleSubmitLeave(e: React.FormEvent) {
    e.preventDefault();
    setLeaveError(null);
    if (!leaveStart || !leaveEnd) {
      setLeaveError(t("common.error"));
      return;
    }
    setLeaveSubmitting(true);
    try {
      const res = await workerFetch("/api/worker/leaves", {
        method: "POST",
        body: JSON.stringify({
          type: leaveType,
          startDate: leaveStart,
          endDate: leaveEnd,
          reason: leaveReason,
        }),
      });
      const j = asWorkerActionResponse(await res.json());
      if (!j?.success) {
        setLeaveError(j?.error || t("common.error"));
        return;
      }
      // Reset form + refresh
      setShowLeaveForm(false);
      setLeaveStart("");
      setLeaveEnd("");
      setLeaveReason("");
      await loadLeaves();
    } catch {
      setLeaveError(t("common.error"));
    } finally {
      setLeaveSubmitting(false);
    }
  }

  async function handleLogout() {
    try {
      await workerFetch("/api/worker-auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    clearWorkerAuth();
    window.dispatchEvent(new Event("storage"));
    navigate("/worker/login", { replace: true });
  }

  if (!me) {
    return <div className="pt-8 text-center text-[#5A5550]">{t("common.loading")}</div>;
  }

  return (
    <div className="space-y-4 pt-2">
      <h1 className="text-xl font-bold">{t("me.title")}</h1>

      {/* Profile card */}
      <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] space-y-3">
        <div>
          <p className="text-lg font-bold">{me.name}</p>
          <p className="text-xs text-[#8A8680]">
            {me.empNo} · {me.departmentCode}
          </p>
          {me.position && (
            <p className="text-xs text-[#8A8680]">{me.position}</p>
          )}
        </div>
        <label className="block">
          <span className="text-xs font-medium text-[#5A5550]">
            {t("me.phone")}
          </span>
          <div className="mt-1 flex gap-2">
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setPhoneDirty(true);
              }}
              className="flex-1 h-10 px-3 rounded border border-[#D8D2CC] bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              placeholder="+60 12-345 6789"
            />
            {phoneDirty && (
              <button
                type="button"
                onClick={handleSavePhone}
                disabled={phoneSaving}
                className="h-10 px-3 rounded bg-[#6B5C32] text-white text-sm font-semibold disabled:opacity-60"
              >
                {phoneSaving ? "…" : "Save"}
              </button>
            )}
          </div>
          {phoneError && <p className="mt-1 text-xs text-[#9A3A2D]">{phoneError}</p>}
        </label>
      </div>

      {/* Leaves card — Wei Siang 2026-05-10: hidden until rollout. */}
      {SHOW_LEAVES && (
      <div className="bg-white rounded-xl p-4 border border-[#D8D2CC]">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold">{t("me.leaves")}</p>
          <button
            type="button"
            onClick={() => setShowLeaveForm((v) => !v)}
            className="text-xs flex items-center gap-1 px-2.5 py-1 rounded bg-[#F0ECE9] hover:bg-[#E5E0DB] font-semibold"
          >
            <Plus className="h-3 w-3" />
            {t("leave.apply")}
          </button>
        </div>

        {leavesLoading ? (
          <p className="text-sm text-[#8A8680]">{t("common.loading")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-[#F0ECE9] rounded px-3 py-2 text-center">
                <p className="text-xs text-[#8A8680]">{t("leave.annualLeft")}</p>
                <p className="text-lg font-bold">
                  {leaves?.balance.annualRemaining ?? 0}
                  <span className="text-xs font-normal text-[#8A8680]">
                    /{leaves?.balance.annualEntitlement ?? 0}
                  </span>
                </p>
              </div>
              <div className="bg-[#F0ECE9] rounded px-3 py-2 text-center">
                <p className="text-xs text-[#8A8680]">{t("leave.medicalLeft")}</p>
                <p className="text-lg font-bold">
                  {leaves?.balance.medicalRemaining ?? 0}
                  <span className="text-xs font-normal text-[#8A8680]">
                    /{leaves?.balance.medicalEntitlement ?? 0}
                  </span>
                </p>
              </div>
            </div>

            {/* Leave request form */}
            {showLeaveForm && (
              <form
                onSubmit={handleSubmitLeave}
                className="space-y-2 mb-3 bg-[#FAF9F7] p-3 rounded-lg"
              >
                <div>
                  <label className="text-xs text-[#5A5550] block mb-1">
                    {t("leave.type")}
                  </label>
                  <select
                    value={leaveType}
                    onChange={(e) => setLeaveType(e.target.value)}
                    className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                  >
                    <option value="ANNUAL">Annual</option>
                    <option value="MEDICAL">Medical</option>
                    <option value="UNPAID">Unpaid</option>
                    <option value="EMERGENCY">Emergency</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-[#5A5550] block mb-1">
                      {t("leave.from")}
                    </label>
                    <input
                      type="date"
                      value={leaveStart}
                      onChange={(e) => setLeaveStart(e.target.value)}
                      className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[#5A5550] block mb-1">
                      {t("leave.to")}
                    </label>
                    <input
                      type="date"
                      value={leaveEnd}
                      onChange={(e) => setLeaveEnd(e.target.value)}
                      className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#5A5550] block mb-1">
                    {t("leave.reason")}
                  </label>
                  <input
                    type="text"
                    value={leaveReason}
                    onChange={(e) => setLeaveReason(e.target.value)}
                    className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                  />
                </div>
                {leaveError && (
                  <p className="text-xs text-[#9A3A2D]">{leaveError}</p>
                )}
                <button
                  type="submit"
                  disabled={leaveSubmitting}
                  className="w-full h-10 rounded bg-[#6B5C32] text-white text-sm font-semibold disabled:opacity-60"
                >
                  {leaveSubmitting ? t("common.loading") : t("leave.submit")}
                </button>
              </form>
            )}

            {/* History */}
            {leaves && leaves.history.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-[#8A8680] font-medium">
                  {t("leave.history")}
                </p>
                {leaves.history.slice(0, 6).map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between text-sm py-1.5 border-b border-[#F0ECE9] last:border-0"
                  >
                    <div>
                      <p className="font-medium">
                        {r.type} · {r.days} {t("common.days")}
                      </p>
                      <p className="text-xs text-[#8A8680]">
                        {r.startDate} → {r.endDate}
                      </p>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-semibold ${
                        r.status === "APPROVED"
                          ? "bg-[#E0F0E8] text-[#2A6B4A]"
                          : r.status === "REJECTED"
                            ? "bg-[#FDF6F4] text-[#9A3A2D]"
                            : "bg-[#FDF3E0] text-[#9C6F1E]"
                      }`}
                    >
                      {t(`leave.status.${r.status}`)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      )}

      {/* Language selector */}
      <div className="bg-white rounded-xl p-4 border border-[#D8D2CC]">
        <p className="text-sm font-semibold mb-2">{t("me.language")}</p>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(LANG_LABELS) as WorkerLang[]).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLang(code)}
              className={`h-11 rounded border text-sm font-semibold ${
                lang === code
                  ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                  : "bg-white text-[#1F1D1B] border-[#D8D2CC]"
              }`}
            >
              {LANG_LABELS[code]}
            </button>
          ))}
        </div>
      </div>

      {/* Time adjustment — non-production OR extra production time (owner
          2026-06-26). Worker picks the type, then dept + hours + reason.
          Collapsible (owner 2026-06-27): folds like the Standard Times / Past
          announcements cards below — collapsed by default, chevron on the
          right, expands on tap to reveal the apply form + My requests. A small
          count chip on the collapsed header flags PENDING requests. */}
      {(() => {
        const pendingCount = npRequests.filter(
          (r) => r.status === "PENDING",
        ).length;
        return (
      <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
        <button
          type="button"
          onClick={() => setTaOpen((v) => !v)}
          className="w-full px-4 py-3 flex items-center justify-between text-left"
          aria-expanded={taOpen}
        >
          <span className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-[#6B5C32]" />
            <span className="text-sm font-semibold">{t("timeadj.title")}</span>
            {pendingCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#FDF3E0] text-[#9C6F1E] text-[10px] font-bold">
                {pendingCount}
              </span>
            )}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-[#8A8680] transition-transform ${taOpen ? "rotate-180" : ""}`}
          />
        </button>

        {taOpen && (
          <div className="px-4 pb-4 border-t border-[#F0ECE9] pt-3">
        <div className="flex items-center justify-end mb-2">
          <button
            type="button"
            onClick={() => {
              setNpShowForm((v) => !v);
              setNpError(null);
            }}
            className="text-xs flex items-center gap-1 px-2.5 py-1 rounded bg-[#F0ECE9] hover:bg-[#E5E0DB] font-semibold"
          >
            <Plus className="h-3 w-3" />
            {t("nonprod.apply")}
          </button>
        </div>
        <p className="text-xs text-[#8A8680] mb-3">
          {npKind === "ADD_PROD" ? t("timeadj.introAddProd") : t("nonprod.intro")}
        </p>

        {npShowForm && (
          <form
            onSubmit={handleSubmitNonprod}
            className="space-y-2 mb-3 bg-[#FAF9F7] p-3 rounded-lg"
          >
            {/* TYPE toggle — Non-production (protects efficiency) vs Extra
                production time (counts as production output). */}
            <div>
              <label className="text-xs text-[#5A5550] block mb-1">
                {t("timeadj.type")}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["NONPROD", "ADD_PROD"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setNpKind(k);
                      setNpDept("");
                      setNpError(null);
                    }}
                    className={`h-10 rounded border text-xs font-semibold px-2 ${
                      npKind === k
                        ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                        : "border-[#D8D2CC] bg-white text-[#5A5550]"
                    }`}
                  >
                    {k === "NONPROD"
                      ? t("timeadj.typeNonprod")
                      : t("timeadj.typeAddProd")}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-[#5A5550] block mb-1">
                {t("nonprod.department")}
              </label>
              <select
                value={npDept}
                onChange={(e) => setNpDept(e.target.value)}
                className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
              >
                <option value="">{t("nonprod.pickDept")}</option>
                {(npKind === "ADD_PROD" ? prodDepts : npDepts).map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-[#5A5550] block mb-1">
                  {t("nonprod.date")}
                </label>
                <input
                  type="date"
                  value={npDate}
                  onChange={(e) => setNpDate(e.target.value)}
                  className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-[#5A5550] block mb-1">
                  {t("timeadj.minutesLabel")}
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="1440"
                  step="1"
                  value={npMinutes}
                  onChange={(e) => setNpMinutes(e.target.value)}
                  className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                  placeholder="20"
                />
              </div>
            </div>
            {npKind === "ADD_PROD" && (
              <div>
                <label className="text-xs text-[#5A5550] block mb-1">
                  {t("timeadj.jobRef")}
                </label>
                <input
                  type="text"
                  value={npJobRef}
                  onChange={(e) => setNpJobRef(e.target.value)}
                  className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
                  placeholder={t("timeadj.jobRefPlaceholder")}
                />
              </div>
            )}
            <div>
              <label className="text-xs text-[#5A5550] block mb-1">
                {npKind === "ADD_PROD" ? t("timeadj.reason") : t("nonprod.note")}
              </label>
              <input
                type="text"
                value={npNote}
                onChange={(e) => setNpNote(e.target.value)}
                className="w-full h-10 px-2 rounded border border-[#D8D2CC] bg-white text-sm"
              />
            </div>
            {npError && <p className="text-xs text-[#9A3A2D]">{npError}</p>}
            <button
              type="submit"
              disabled={npSubmitting}
              className="w-full h-10 rounded bg-[#6B5C32] text-white text-sm font-semibold disabled:opacity-60"
            >
              {npSubmitting ? t("common.loading") : t("nonprod.submit")}
            </button>
          </form>
        )}

        <p className="text-xs text-[#8A8680] font-medium mb-1.5">
          {t("nonprod.myRequests")}
        </p>
        {(() => {
          // Worker-side display rule (owner 2026-06-27) — DB rows are NEVER
          // deleted (payroll/efficiency-relevant; admin keeps the full set).
          // We only trim what the WORKER sees so the list stays short:
          //   • PENDING always shows (any age)
          //   • APPROVED / REJECTED only from the last 14 days
          //   • then hard-cap at the 10 most recent, newest first
          // Best available timestamp: decidedAt (when it was approved/rejected)
          // → createdAt (when it was applied) → date (the day it is FOR).
          const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;
          const now = nowMs;
          const tsOf = (r: NonprodRequest) => {
            const raw = r.decidedAt || r.createdAt || r.date || "";
            const ms = Date.parse(raw);
            return Number.isNaN(ms) ? 0 : ms;
          };
          const sorted = [...npRequests].sort((a, b) => tsOf(b) - tsOf(a));
          const filtered = sorted.filter((r) => {
            if (r.status === "PENDING") return true;
            const ts = tsOf(r);
            return ts > 0 && now - ts <= RETAIN_MS;
          });
          const shown = filtered.slice(0, 10);
          const anyHidden = shown.length < npRequests.length;
          if (npRequests.length === 0) {
            return (
              <p className="text-sm text-[#8A8680]">{t("nonprod.noRequests")}</p>
            );
          }
          return (
            <>
          <div className="space-y-1.5">
            {shown.map((r) => {
              const isAddProd = r.kind === "ADD_PROD";
              // Stored `hours` × 60 = minutes (owner 2026-06-27: show minutes).
              // "X min" under an hour, "Xh Ym" (or "Xh") at/over an hour.
              const totalMin = Math.round((r.hours ?? 0) * 60);
              const hh = Math.floor(totalMin / 60);
              const mm = totalMin % 60;
              const durLabel =
                totalMin < 60
                  ? `${totalMin} ${t("timeadj.minSuffix")}`
                  : mm === 0
                    ? `${hh}h`
                    : `${hh}h ${mm}${t("timeadj.minSuffix")}`;
              const deptName =
                (isAddProd ? prodDepts : npDepts).find(
                  (d) => d.code === r.departmentCode,
                )?.name ||
                npDepts.find((d) => d.code === r.departmentCode)?.name ||
                prodDepts.find((d) => d.code === r.departmentCode)?.name ||
                r.departmentCode;
              return (
                <div
                  key={r.id}
                  className="flex items-center justify-between text-sm py-1.5 border-b border-[#F0ECE9] last:border-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {deptName} · {durLabel}
                      <span
                        className={`ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          isAddProd
                            ? "bg-[#E4ECF5] text-[#2A5A8A]"
                            : "bg-[#F0ECE9] text-[#6B5C32]"
                        }`}
                      >
                        {isAddProd
                          ? t("timeadj.typeAddProd")
                          : t("timeadj.typeNonprod")}
                      </span>
                    </p>
                    <p className="text-xs text-[#8A8680]">{r.date}</p>
                    {/* Partial approval — office approved less than requested. */}
                    {r.status === "APPROVED" &&
                      r.approvedHours != null &&
                      Math.round(r.approvedHours * 60) < totalMin && (
                        <p className="text-xs text-[#2A6B4A]">
                          {t("timeadj.approvedAmount")}{" "}
                          {(() => {
                            const am = Math.round((r.approvedHours ?? 0) * 60);
                            const ah = Math.floor(am / 60);
                            const amm = am % 60;
                            return am < 60
                              ? `${am} ${t("timeadj.minSuffix")}`
                              : amm === 0
                                ? `${ah}h`
                                : `${ah}h ${amm}${t("timeadj.minSuffix")}`;
                          })()}{" "}
                          {t("timeadj.ofRequested")} {durLabel}
                        </p>
                      )}
                    {/* Rejection reason from the office. */}
                    {r.status === "REJECTED" && r.rejectReason && (
                      <p className="text-xs text-[#9A3A2D]">
                        {t("timeadj.rejectedReason")}: {r.rejectReason}
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-xs px-2 py-0.5 rounded font-semibold ${
                      r.status === "APPROVED"
                        ? "bg-[#E0F0E8] text-[#2A6B4A]"
                        : r.status === "REJECTED"
                          ? "bg-[#FDF6F4] text-[#9A3A2D]"
                          : "bg-[#FDF3E0] text-[#9C6F1E]"
                    }`}
                  >
                    {t(`nonprod.status.${r.status}`)}
                  </span>
                </div>
              );
            })}
          </div>
          {anyHidden && (
            <p className="mt-2 text-[11px] text-[#9CA3AF]">
              {t("nonprod.olderKept")}
            </p>
          )}
            </>
          );
        })()}
          </div>
        )}
      </div>
        );
      })()}

      {/* Standard Times — the worker's OWN department's minutes per WIP
          (owner 2026-06-26). Collapsed by default; loads on first open. */}
      <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
        <button
          type="button"
          onClick={() => {
            setStdOpen((v) => !v);
            if (!stdLoaded && !stdLoading) void loadStandardTimes();
          }}
          className="w-full px-4 py-3 flex items-center justify-between text-left"
        >
          <span className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-[#6B5C32]" />
            <span className="text-sm font-semibold">
              Standard Times
              {stdDept
                ? ` · ${stdDept}`
                : me.departmentCode
                  ? ` · ${me.departmentCode}`
                  : ""}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 text-[#8A8680] transition-transform ${stdOpen ? "rotate-180" : ""}`}
          />
        </button>

        {stdOpen && (
          <div className="px-4 pb-4">
            <p className="text-xs text-[#8A8680] mb-2">
              {stdDepts.length > 1
                ? "Standard minutes per WIP. Pick a department to view."
                : "Standard minutes per WIP for your department."}
            </p>
            {/* Single-department label — when the worker belongs to exactly
                one department the selector is hidden, so show that dept as a
                small static chip so they can see which one this is. */}
            {stdDepts.length === 1 && (
              <div className="mb-2">
                <span className="inline-flex h-7 items-center rounded border border-[#D8D2CC] bg-[#F3EFE9] px-2.5 text-xs font-semibold text-[#6B5C32]">
                  {stdDepts[0]}
                </span>
              </div>
            )}
            {/* Department selector — only when the worker is in >1 department.
                Segmented chips, brand olive active (matches the language
                buttons above). Default = primary (the backend's chosen dept). */}
            {stdDepts.length > 1 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {stdDepts.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => selectStandardDept(code)}
                    className={`h-9 px-3 rounded border text-xs font-semibold ${
                      stdDept === code
                        ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                        : "bg-white text-[#1F1D1B] border-[#D8D2CC]"
                    }`}
                  >
                    {code}
                  </button>
                ))}
              </div>
            )}
            <div className="relative mb-2">
              <Search className="h-4 w-4 text-[#B0AAA3] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={stdSearch}
                onChange={(e) => setStdSearch(e.target.value)}
                placeholder="Search product / WIP…"
                className="w-full h-10 pl-8 pr-3 rounded border border-[#D8D2CC] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
            {stdLoading ? (
              <p className="text-sm text-[#8A8680] py-2">{t("common.loading")}</p>
            ) : (
              (() => {
                const q = stdSearch.trim().toUpperCase();
                const shown = q
                  ? stdRows.filter((r) => r.wipLabel.toUpperCase().includes(q))
                  : stdRows;
                if (stdRows.length === 0) {
                  return (
                    <p className="text-sm text-[#8A8680] py-2">
                      No standard times found for your department.
                    </p>
                  );
                }
                if (shown.length === 0) {
                  return (
                    <p className="text-sm text-[#8A8680] py-2">No match.</p>
                  );
                }
                return (
                  <div className="max-h-80 overflow-y-auto -mx-1">
                    {shown.map((r, i) => (
                      <div
                        key={`${r.wipLabel}-${i}`}
                        className="flex items-center justify-between gap-2 px-1 py-2 border-b border-[#F0ECE9] last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{r.wipLabel}</p>
                          {r.itemCategory && (
                            <p className="text-xs text-[#8A8680]">{r.itemCategory}</p>
                          )}
                        </div>
                        <span className="shrink-0 text-xs font-semibold px-2 py-1 rounded bg-[#E0F0E8] text-[#2A6B4A]">
                          {r.minutes} min
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()
            )}
          </div>
        )}
      </div>

      {/* Past announcements (archive) — relocated from the home tab (owner
          2026-06-26). Collapsed by default; lazy-loads on first open. Read-only,
          WITH media (reuses the shared AnnouncementMedia). Each row is itself
          foldable, mirroring the live list on home. */}
      <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
        <button
          type="button"
          onClick={togglePastOpen}
          className="w-full px-4 py-3 flex items-center justify-between text-left"
          aria-expanded={pastOpen}
        >
          <span className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-[#6B5C32]" />
            <span className="text-sm font-semibold">
              {t("home.pastAnnouncements")}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 text-[#8A8680] transition-transform ${pastOpen ? "rotate-180" : ""}`}
          />
        </button>
        {pastOpen && (
          <div className="border-t border-[#F0ECE9]">
            {pastLoading && pastAnn === null ? (
              <p className="px-4 py-3 text-xs text-[#9CA3AF]">
                {t("common.loading")}
              </p>
            ) : pastAnn && pastAnn.length > 0 ? (
              (() => {
                // Per-category counts (off the full fetched list) for the chips.
                const countOf = (cat: AnnouncementCategory) =>
                  pastAnn.filter(
                    (a) => normalizeAnnouncementCategory(a.category) === cat,
                  ).length;
                // Apply the chosen filter (null = All).
                const shown = pastCatFilter
                  ? pastAnn.filter(
                      (a) =>
                        normalizeAnnouncementCategory(a.category) ===
                        pastCatFilter,
                    )
                  : pastAnn;
                return (
                  <>
                    {/* Category filter chips — All + the 4 types. Filters the
                        already-fetched list client-side; "All" is default. */}
                    <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                      <button
                        type="button"
                        onClick={() => setPastCatFilter(null)}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          pastCatFilter === null
                            ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                            : "border-[#D8D2CC] bg-white text-[#5A5550]"
                        }`}
                      >
                        All ({pastAnn.length})
                      </button>
                      {ANNOUNCEMENT_CATEGORY_ORDER.map((cat) => {
                        const meta = ANNOUNCEMENT_CATEGORIES[cat];
                        const Icon = meta.icon;
                        const n = countOf(cat);
                        const active = pastCatFilter === cat;
                        return (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => setPastCatFilter(cat)}
                            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                              active
                                ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                                : "border-[#D8D2CC] bg-white text-[#5A5550]"
                            }`}
                          >
                            <Icon className="h-3 w-3" />
                            {meta.label} ({n})
                          </button>
                        );
                      })}
                    </div>
                    {shown.length === 0 ? (
                      <p className="px-4 py-3 text-xs text-[#9CA3AF]">
                        {t("home.noPastAnnouncements")}
                      </p>
                    ) : (
                      <ul className="mt-2 divide-y divide-[#F0ECE9]">
                        {shown.map((a) => {
                          const collapsed = collapsedPast.has(a.id);
                          const { title, body } = localizeAnnouncement(a, lang);
                          return (
                            <li key={a.id} className="px-4 py-3">
                              <div className="mb-1">
                                <AnnouncementCategoryBadge
                                  category={a.category}
                                />
                              </div>
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
                                  <AnnouncementMedia
                                    attachments={a.attachments}
                                  />
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
                    )}
                  </>
                );
              })()
            ) : (
              <p className="px-4 py-3 text-xs text-[#9CA3AF]">
                {t("home.noPastAnnouncements")}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Logout */}
      <button
        type="button"
        onClick={handleLogout}
        className="w-full h-12 rounded-lg bg-white border border-[#D8D2CC] text-[#9A3A2D] font-semibold flex items-center justify-center gap-2 hover:bg-[#FDF6F4]"
      >
        <LogOut className="h-4 w-4" />
        {t("me.logout")}
      </button>
    </div>
  );
}
