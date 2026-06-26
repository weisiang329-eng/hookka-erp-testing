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
import { LogOut, Plus, Clock, Search, ChevronDown } from "lucide-react";
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
} from "@/layouts/WorkerLayout";

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
    setStdLoading(true);
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
      if (j?.success && Array.isArray(j.data?.rows)) {
        setStdRows(j.data.rows);
      }
      if (j?.success && Array.isArray(j.data?.departmentCodes)) {
        setStdDepts(j.data.departmentCodes);
      }
      if (j?.success && typeof j.data?.department === "string") {
        setStdDept(j.data.department);
      }
      setStdLoaded(true);
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
  }, [loadLeaves]);

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
