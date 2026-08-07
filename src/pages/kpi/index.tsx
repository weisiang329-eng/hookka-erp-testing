// ---------------------------------------------------------------------------
// KPI — library, people, and one person's monthly card.
//
// Owner 2026-08-06, after using the first version: "我一定要先选他的名字、点
// assign KPI 才能看到现有的 KPI 吗？" No. That order was backwards — a target
// is decided by looking at the current number, so the current number has to be
// on the list before anyone is picked.
//
// Three tabs, and a Super Admin lands on Library:
//   Library — every KPI, its live company value, who holds it. Tick several,
//             assign them to several people in one go.
//   People  — everyone's score this month against last month.
//   My KPI  — the card the person being measured sees, read-only, with the
//             formula spelled out and any checklist items tickable.
//
// An ordinary user has only the third, so they never see the strip.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";

type Scoring = "AUTO" | "CHECKLIST" | "SURVEY" | "MANUAL";

type Line = {
  key: string; label: string; detail: string;
  scoring?: Scoring; formula?: string; checklistItems?: string[]; surveyQuestions?: string[];
  ratingGuide?: string[]; surveyScale?: string[];
  purpose?: string; definition?: string; measurement?: string[];
  shape: "GATE" | "RATIO"; unit: "%" | "count" | "score";
  available: boolean; blockedBy?: string; drillPath?: string;
  target: number; weight: number;
  actual: number | null; attainment: number | null; points: number | null;
  evidence: string;
};
type CardData = {
  period: string; locked: boolean; lines: Line[];
  rawScore: number | null; score: number | null;
  gateFailed: boolean; gateCap: number;
  weightMeasured: number; weightUnbuilt: number;
  payout?: {
    mode: "MONTHLY_CASH" | "SCORE_ONLY";
    amountSen: number;
    earnedSen: number;
    bands: Array<{ minScore: number; payPct: number; payAmountSen?: number | null }>;
    band: { minScore: number; payPct: number; payAmountSen?: number | null } | null;
    nextBand: { minScore: number; payPct: number; payAmountSen?: number | null } | null;
  };
};
type LibItem = {
  key: string; label: string; detail: string; shape: "GATE" | "RATIO"; unit: string;
  scoring: Scoring; formula: string; checklistItems?: string[]; surveyQuestions?: string[];
  ratingGuide?: string[]; surveyScale?: string[];
  purpose?: string; definition?: string; measurement?: string[];
  defaultTarget: number; defaultWeight: number; available: boolean;
  current: number | null; evidence: string;
  assignedTo: Array<{ userId: string; name: string; role: string }>;
};
type PersonRow = {
  userId: string; name: string; email: string; role: string;
  kpiCount: number; score: number | null; gateFailed: boolean;
  prevPeriod: string; prevScore: number | null; delta: number | null;
};

const fmt = (v: number | null, unit: string): string => {
  if (v === null || !Number.isFinite(v)) return "—";
  if (unit === "%") return `${v}%`;
  if (unit === "score") return v.toFixed(1);
  return String(v);
};
const scoreColour = (v: number | null) =>
  v == null ? "#9CA3AF" : v >= 90 ? "#3B6D11" : v >= 70 ? "#B5701A" : "#9A3A2D";

function monthsBack(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

const BADGE: Record<string, string> = {
  AUTO: "border-[#BFD9AE] bg-[#F2F7EE] text-[#3B6D11]",
  CHECKLIST: "border-[#AECBD9] bg-[#EEF4F7] text-[#11566D]",
  SURVEY: "border-[#C9B8D9] bg-[#F4F0F7] text-[#553D6D]",
  MANUAL: "border-[#E0C79A] bg-[#FBF5EA] text-[#7A5410]",
  GATE: "border-[#E7B8B0] bg-[#FDF3F1] text-[#9A3A2D]",
};
const SCORING_LABEL: Record<string, string> = {
  AUTO: "auto",
  CHECKLIST: "checklist",
  SURVEY: "survey",
  MANUAL: "rated by supervisor",
};
const Badge = ({ kind, children }: { kind: string; children: React.ReactNode }) => (
  <span className={`rounded border px-1.5 text-[10px] font-semibold ${BADGE[kind] ?? ""}`}>
    {children}
  </span>
);

export default function KpiPage() {
  const me = getCurrentUser();
  const isSuperAdmin = (me?.role ?? "").toUpperCase() === "SUPER_ADMIN";
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const months = useMemo(() => monthsBack(12), []);

  type Tab = "library" | "people" | "mine";
  const [tab, setTab] = useState<Tab>(isSuperAdmin ? "library" : "mine");
  const [viewUserId, setViewUserId] = useState("");

  const { data: usersResp } = useCachedJson<{
    data?: Array<{ id: string; email: string; displayName?: string; role?: string }>;
  }>(isSuperAdmin ? "/api/users" : "");

  const { data: libResp, loading: libLoading } = useCachedJson<{ data?: LibItem[] }>(
    isSuperAdmin && tab === "library" ? `/api/kpi/library?period=${period}` : "",
  );
  const { data: peopleResp, loading: peopleLoading } = useCachedJson<{ data?: PersonRow[] }>(
    isSuperAdmin && tab === "people" ? `/api/kpi/people?period=${period}` : "",
  );

  const cardUrl =
    tab === "mine"
      ? viewUserId
        ? `/api/kpi/users/${viewUserId}?period=${period}`
        : `/api/kpi/me?period=${period}`
      : "";
  const { data: cardResp, loading: cardLoading } = useCachedJson<{ data?: CardData }>(cardUrl);
  const card = cardResp?.data;

  // ---- Library multi-select ------------------------------------------------
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** Which KPI's explanation is open. One at a time keeps the list scannable. */
  const [expanded, setExpanded] = useState<string | null>(null);
  // Weight belongs to the KPI, not the person. Owner 2026-08-06: "当我选择了
  // 四五个东西，我怎么给那个我筛选的 KPI 设置一个权重呢?" — the first version
  // had one box per PERSON, which applied the same weight to every selected
  // KPI. Five KPIs sharing one number is not a weighting.
  const [kpiWeights, setKpiWeights] = useState<Record<string, number>>({});
  const [chosenPeople, setChosenPeople] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const lib = libResp?.data ?? [];
  const pickedDefs = lib.filter((k) => picked.has(k.key));
  const togglePick = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
    setMsg(null);
  };

  const weightOf = (k: LibItem) => kpiWeights[k.key] ?? k.defaultWeight;
  const weightTotal = pickedDefs.reduce((sum, k) => sum + weightOf(k), 0);

  const saveBulk = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const people = [...chosenPeople];
      if (!people.length) throw new Error("Pick at least one person");
      for (const def of pickedDefs) {
        const r = await fetch(`/api/kpi/kpi/${def.key}/assignees`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            assignees: people.map((userId) => ({
              userId,
              target: def.defaultTarget,
              weight: weightOf(def),
              isActive: true,
            })),
          }),
        });
        const j = (await r.json()) as { success?: boolean; error?: string };
        if (!r.ok || !j.success) throw new Error(j.error || `Failed on ${def.label}`);
      }
      setMsg(`Assigned ${pickedDefs.length} KPI(s) to ${people.length} person(s).`);
      setPicked(new Set());
      invalidateCachePrefix("/api/kpi");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // ---- Payout settings, per person ----------------------------------------
  // Lives on the person's own card rather than in a separate screen: the pot
  // is decided while looking at what they actually score, and the ladder is
  // meaningless without the score beside it.
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState<{
    mode: "MONTHLY_CASH" | "SCORE_ONLY";
    amountRM: number;
    bands: Array<{ minScore: number; payPct: number; payAmountSen?: number | null }>;
    /** Whole-ladder toggle: rungs as a share of the pot, or as flat sums. */
    byAmount: boolean;
  } | null>(null);
  const [paySaving, setPaySaving] = useState(false);
  const [payMsg, setPayMsg] = useState<string | null>(null);

  const openPayout = () => {
    const cur = card?.payout;
    setPayForm({
      mode: cur?.mode ?? "SCORE_ONLY",
      amountRM: cur ? cur.amountSen / 100 : 0,
      bands: cur?.bands?.length
        ? [...cur.bands].sort((a, b) => b.minScore - a.minScore)
        : [
            { minScore: 90, payPct: 100 },
            { minScore: 80, payPct: 80 },
            { minScore: 70, payPct: 60 },
            { minScore: 60, payPct: 40 },
          ],
      byAmount: (cur?.bands ?? []).some((b) => b.payAmountSen != null),
    });
    setPayMsg(null);
    setPayOpen(true);
  };

  const savePayout = async () => {
    if (!payForm) return;
    setPaySaving(true);
    setPayMsg(null);
    try {
      const target = viewUserId || me?.id;
      if (!target) throw new Error("No person selected");
      const r = await fetch(`/api/kpi/payout/${target}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: payForm.mode,
          amountSen: Math.round(payForm.amountRM * 100),
          // Strip the unused half so the stored ladder says which kind it is.
          bands: payForm.bands.map((b) =>
            payForm.byAmount
              ? { minScore: b.minScore, payPct: 0, payAmountSen: Math.round(b.payAmountSen ?? 0) }
              : { minScore: b.minScore, payPct: b.payPct, payAmountSen: null },
          ),
        }),
      });
      const j = (await r.json()) as { success?: boolean; error?: string };
      if (!r.ok || !j.success) throw new Error(j.error || `Save failed (${r.status})`);
      setPayMsg("Saved.");
      setPayOpen(false);
      invalidateCachePrefix("/api/kpi");
    } catch (e) {
      setPayMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setPaySaving(false);
    }
  };

  const tickItem = async (kpiKey: string, itemIndex: number, done: boolean) => {
    await fetch(`/api/kpi/checklist/${kpiKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period, itemIndex, done, userId: viewUserId || undefined }),
    });
    invalidateCachePrefix("/api/kpi");
  };

  const saveRating = async (kpiKey: string, score: number, note: string) => {
    const res = await fetch(`/api/kpi/rating/${kpiKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period, score, note, userId: viewUserId || undefined }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(j.error || "Could not save the rating");
    invalidateCachePrefix("/api/kpi");
  };

  const openPerson = (userId: string) => {
    setViewUserId(userId);
    setTab("mine");
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550]">Performance</p>
          <h1 className="text-2xl font-bold text-[#1F1D1B]">KPI</h1>
          <p className="text-xs text-[#9CA3AF] mt-0.5">Settled monthly · targets set by Super Admin</p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs"
        >
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {isSuperAdmin && (
        <div className="flex gap-1 flex-wrap">
          {([["library", "Library"], ["people", "People"], ["mine", viewUserId ? "Card" : "My KPI"]] as const).map(
            ([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-md border px-3.5 py-1.5 text-xs ${
                  tab === id
                    ? "bg-[#6B5C32] text-white border-[#6B5C32] font-semibold"
                    : "border-[#E2DDD8] bg-[#FAF9F7]"
                }`}
              >
                {label}
              </button>
            ),
          )}
        </div>
      )}

      {/* ---------------- Library ---------------- */}
      {isSuperAdmin && tab === "library" && (
        <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-3 items-start">
          <Card className="bg-white rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#E2DDD8] flex justify-between items-center gap-2 flex-wrap">
              <div>
                <p className="text-sm font-bold">All KPIs</p>
                <p className="text-[11px] text-[#9CA3AF]">
                  {lib.length} defined · tick several, then assign in one go
                </p>
              </div>
            </div>
            {libLoading && !lib.length ? (
              <Skeleton height={200} />
            ) : (
              lib.map((k) => {
                const open = expanded === k.key;
                return (
                  <div
                    key={k.key}
                    className={`border-b border-[#EFEBE4] last:border-0 ${
                      picked.has(k.key) ? "bg-[#FBF8F2]" : ""
                    }`}
                  >
                    {/* Compact row: tick, name, value. The definition used to
                        sit here in full and turned every row into a wall of
                        text — the list has to be scannable first, explained
                        second. */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={picked.has(k.key)}
                        onChange={() => togglePick(k.key)}
                        className="shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[13px] font-semibold text-[#1F1D1B]">{k.label}</span>
                          <Badge kind={k.scoring}>{SCORING_LABEL[k.scoring] ?? "auto"}</Badge>
                        </div>
                        <div className="text-[11.5px] text-[#6B6560] mt-0.5 truncate">{k.detail}</div>
                      </div>
                      <div className="text-right shrink-0 w-28">
                        <div className="text-[15px] font-bold tabular-nums text-[#1F1D1B]">
                          {k.current === null ? "—" : fmt(k.current, k.unit)}
                        </div>
                        <div className="text-[10.5px] text-[#9CA3AF] truncate">{k.evidence || "no data"}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 px-4 pb-2.5 pl-11 flex-wrap">
                      {k.assignedTo.length === 0 ? (
                        <span className="rounded-full bg-[#F2EFE9] px-2 py-0.5 text-[10px] text-[#9CA3AF]">
                          not assigned
                        </span>
                      ) : (
                        k.assignedTo.map((a) => (
                          <span key={a.userId} className="rounded-full bg-[#EDE7DA] px-2 py-0.5 text-[10px] text-[#5A5550]">
                            {a.name}
                          </span>
                        ))
                      )}
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : k.key)}
                        className="ml-auto text-[11px] text-[#6B5C32] underline decoration-dotted"
                      >
                        {open ? "Hide detail" : "How it works"}
                      </button>
                    </div>

                    {open && (
                      <div className="px-4 pb-3.5 pl-11 space-y-2 bg-[#FCFBF8] border-t border-[#F2EFE9] pt-3">
                        <p className="text-[12px] text-[#1F1D1B] leading-relaxed">
                          <span className="font-semibold">Why: </span>{k.purpose}
                        </p>
                        <p className="text-[12px] text-[#3A3733] leading-relaxed">
                          <span className="font-semibold">What is counted: </span>{k.definition}
                        </p>
                        {(k.measurement?.length ?? 0) > 0 && (
                          <ol className="ml-4 list-decimal space-y-1">
                            {k.measurement!.map((m) => (
                              <li key={m} className="text-[11.5px] text-[#3A3733] leading-relaxed">{m}</li>
                            ))}
                          </ol>
                        )}
                        {(k.surveyQuestions?.length ?? 0) > 0 && (
                          <div>
                            <p className="text-[11.5px] font-semibold text-[#1F1D1B] mb-1">
                              The {k.surveyQuestions!.length} questions — each answered 1–5, worth 20 points
                            </p>
                            <ol className="ml-4 list-decimal space-y-0.5">
                              {k.surveyQuestions!.map((q) => (
                                <li key={q} className="text-[11.5px] text-[#3A3733] leading-relaxed">{q}</li>
                              ))}
                            </ol>
                            {(k.surveyScale?.length ?? 0) > 0 && (
                              <div className="mt-2">
                                <p className="text-[11.5px] font-semibold text-[#1F1D1B] mb-1">
                                  What each answer means
                                </p>
                                {/* Best first — the customer reads it that way. */}
                                <ul className="space-y-0.5">
                                  {k.surveyScale!.map((label, i) => ({ label, star: i + 1 }))
                                    .reverse()
                                    .map(({ label, star }) => (
                                      <li key={label} className="text-[11.5px] text-[#3A3733]">
                                        <span className="font-semibold">{star}</span> — {label}{" "}
                                        <span className="text-[#9CA3AF]">({star * 4} pts)</span>
                                      </li>
                                    ))}
                                </ul>
                              </div>
                            )}
                            {/* The link that removes the need to key replies in
                                by hand. Super Admin only — the mint endpoint is
                                gated server-side regardless. */}
                            {isSuperAdmin && (
                              <div className="mt-2">
                                <SurveyLinkMaker
                                  kpiKey={k.key}
                                  period={period}
                                  assignedTo={k.assignedTo}
                                />
                              </div>
                            )}
                          </div>
                        )}
                        {(k.checklistItems?.length ?? 0) > 0 && (
                          <div>
                            <p className="text-[11.5px] font-semibold text-[#1F1D1B] mb-1">
                              The {k.checklistItems!.length} items
                            </p>
                            <ul className="ml-4 list-disc space-y-0.5">
                              {k.checklistItems!.map((it) => (
                                <li key={it} className="text-[11.5px] text-[#3A3733]">{it}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {(k.ratingGuide?.length ?? 0) > 0 && (
                          <div>
                            <p className="text-[11.5px] font-semibold text-[#1F1D1B] mb-1">
                              What the supervisor is scoring against
                            </p>
                            <ul className="ml-4 list-disc space-y-0.5">
                              {k.ratingGuide!.map((g) => (
                                <li key={g} className="text-[11.5px] text-[#3A3733]">{g}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </Card>

          <Card className="bg-white rounded-xl overflow-hidden">
            <CardContent className="p-4">
              <p className="text-sm font-bold">
                {pickedDefs.length ? `Assign ${pickedDefs.length} KPI(s)` : "Pick a KPI"}
              </p>
              <p className="text-[11px] text-[#9CA3AF]">
                {pickedDefs.length
                  ? "Targets come from the catalogue — you set the weight"
                  : "Tick one or more on the left to assign them"}
              </p>
              {/* Weight per KPI — a target belongs to the KPI, so the weight
                  it carries does too. */}
              {pickedDefs.map((k) => (
                <div key={k.key} className="flex items-center gap-2 mt-2 text-[11.5px]">
                  <span className="flex-1 min-w-0">
                    <b>{k.label}</b>
                    <span className="block text-[#9CA3AF]">
                      target {fmt(k.defaultTarget, k.unit)} · now{" "}
                      {k.current === null ? "—" : fmt(k.current, k.unit)}
                    </span>
                  </span>
                  <input
                    type="number"
                    value={kpiWeights[k.key] ?? k.defaultWeight}
                    onChange={(e) => setKpiWeights({ ...kpiWeights, [k.key]: Number(e.target.value) })}
                    className="w-14 rounded border border-[#E2DDD8] px-2 py-0.5 text-right text-[11px] tabular-nums"
                  />
                  <span className="text-[10px] text-[#9CA3AF]">wt</span>
                </div>
              ))}
            </CardContent>
            {pickedDefs.length > 0 && (
              <div className="border-t border-[#E2DDD8] bg-[#FAF9F7] px-4 py-3">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-[11px] font-bold">Who carries them</span>
                  <span
                    className="text-[11px] font-semibold"
                    style={{ color: Math.round(weightTotal) === 100 ? "#3B6D11" : "#B5701A" }}
                  >
                    Weights {Math.round(weightTotal * 10) / 10}
                    {Math.round(weightTotal) === 100 ? " ✓" : " / 100"}
                  </span>
                </div>
                {(usersResp?.data ?? []).map((u) => (
                  <label key={u.id} className="flex items-center gap-2 py-1 text-[11.5px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={chosenPeople.has(u.id)}
                      onChange={() => {
                        const next = new Set(chosenPeople);
                        if (next.has(u.id)) next.delete(u.id);
                        else next.add(u.id);
                        setChosenPeople(next);
                      }}
                    />
                    <span className="flex-1 truncate">
                      {u.displayName || u.email} <span className="text-[#9CA3AF]">· {u.role}</span>
                    </span>
                  </label>
                ))}
                <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={saveBulk}
                    disabled={saving}
                    className="rounded-md bg-[#6B5C32] px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-50"
                  >
                    {saving ? "Assigning…" : "Assign"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPicked(new Set()); setMsg(null); }}
                    className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-[11.5px]"
                  >
                    Clear
                  </button>
                  {msg && <span className="text-[11px] text-[#5A5550]">{msg}</span>}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ---------------- People ---------------- */}
      {isSuperAdmin && tab === "people" && (
        <Card className="bg-white rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E2DDD8]">
            <p className="text-sm font-bold">People</p>
            <p className="text-[11px] text-[#9CA3AF]">click a row to open their card</p>
          </div>
          {peopleLoading && !peopleResp ? (
            <Skeleton height={180} />
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-[10px] uppercase tracking-wide text-[#9CA3AF]">
                  <th className="text-left px-4 py-2 font-semibold">Person</th>
                  <th className="text-right px-3 py-2 font-semibold">KPIs</th>
                  <th className="text-left px-3 py-2 font-semibold">Attainment</th>
                  <th className="text-right px-3 py-2 font-semibold">Last month</th>
                  <th className="text-right px-4 py-2 font-semibold">Score</th>
                </tr>
              </thead>
              <tbody>
                {(peopleResp?.data ?? []).map((p) => (
                  <tr
                    key={p.userId}
                    onClick={() => openPerson(p.userId)}
                    className="border-b border-[#F0ECE6] last:border-0 cursor-pointer hover:bg-[#FBF8F2]"
                  >
                    <td className="px-4 py-2.5">
                      <b>{p.name}</b> <span className="text-[#9CA3AF]">· {p.role}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-[#9CA3AF] tabular-nums">{p.kpiCount}</td>
                    <td className="px-3 py-2.5">
                      <div className="h-1.5 rounded bg-[#F0ECE6] overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${Math.max(0, Math.min(100, p.score ?? 0))}%`,
                            background: scoreColour(p.score),
                          }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[#9CA3AF]">
                      {p.prevScore == null ? "—" : p.prevScore}
                      {p.delta != null && (
                        <span style={{ color: p.delta >= 0 ? "#3B6D11" : "#9A3A2D" }}>
                          {" "}{p.delta >= 0 ? "↑" : "↓"}{Math.abs(p.delta)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums" style={{ color: scoreColour(p.score) }}>
                      {p.score ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* ---------------- One card ---------------- */}
      {tab === "mine" && (
        <>
          {isSuperAdmin && (
            <select
              value={viewUserId}
              onChange={(e) => setViewUserId(e.target.value)}
              className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs"
            >
              <option value="">My own card</option>
              {(usersResp?.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.displayName || u.email} · {u.role}</option>
              ))}
            </select>
          )}

          {isSuperAdmin && (
            <button
              type="button"
              onClick={openPayout}
              className="ml-2 h-8 rounded-md border border-[#E2DDD8] bg-white px-3 text-xs font-semibold"
            >
              Set bonus &amp; bands
            </button>
          )}

          {isSuperAdmin && payOpen && payForm && (
            <Card className="bg-white rounded-xl">
              <CardContent className="p-4 space-y-3">
                <div>
                  <p className="text-sm font-bold">
                    Bonus for {(usersResp?.data ?? []).find((u) => u.id === viewUserId)?.displayName ?? "this person"}
                  </p>
                  <p className="text-[11px] text-[#5A5550]">
                    The score is weighted across their KPIs; the ladder turns that one score into money.
                  </p>
                </div>

                <div className="flex gap-4 flex-wrap items-end">
                  <label className="text-[12px]">
                    <span className="block text-[11px] text-[#5A5550] mb-1">How it pays</span>
                    <select
                      value={payForm.mode}
                      onChange={(e) => setPayForm({ ...payForm, mode: e.target.value as "MONTHLY_CASH" | "SCORE_ONLY" })}
                      className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs"
                    >
                      <option value="SCORE_ONLY">Score only — settled at year end</option>
                      <option value="MONTHLY_CASH">Monthly cash</option>
                    </select>
                  </label>
                  {payForm.mode === "MONTHLY_CASH" && !payForm.byAmount && (
                    <label className="text-[12px]">
                      <span className="block text-[11px] text-[#5A5550] mb-1">Pot at the top band (RM)</span>
                      <input
                        type="number"
                        value={payForm.amountRM}
                        onChange={(e) => setPayForm({ ...payForm, amountRM: Number(e.target.value) })}
                        className="h-8 w-32 rounded-md border border-[#E2DDD8] px-2 text-right text-xs tabular-nums"
                      />
                    </label>
                  )}
                </div>

                {payForm.mode === "MONTHLY_CASH" && (
                  <div>
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                      <p className="text-[11px] font-semibold text-[#1F1D1B]">Ladder</p>
                      <label className="text-[11px] flex items-center gap-1.5">
                        <input
                          type="radio"
                          checked={!payForm.byAmount}
                          onChange={() => setPayForm({ ...payForm, byAmount: false })}
                        />
                        by % of the pot
                      </label>
                      <label className="text-[11px] flex items-center gap-1.5">
                        <input
                          type="radio"
                          checked={payForm.byAmount}
                          onChange={() => setPayForm({ ...payForm, byAmount: true })}
                        />
                        by fixed amount
                      </label>
                    </div>
                    <p className="text-[11px] text-[#5A5550] mb-2">
                      Below the lowest rung nothing is paid. The jump between rungs is what makes
                      the last few points worth chasing.
                    </p>
                    {payForm.bands.map((b, i) => (
                      <div key={i} className="flex items-center gap-2 py-1 text-[12px]">
                        <input
                          type="number"
                          value={b.minScore}
                          onChange={(e) => {
                            const bands = [...payForm.bands];
                            bands[i] = { ...b, minScore: Number(e.target.value) };
                            setPayForm({ ...payForm, bands });
                          }}
                          className="w-16 rounded border border-[#E2DDD8] px-2 py-0.5 text-right tabular-nums"
                        />
                        <span className="text-[#5A5550]">points and above pays</span>
                        {payForm.byAmount ? (
                          <>
                            <span className="text-[#5A5550]">RM</span>
                            <input
                              type="number"
                              value={(b.payAmountSen ?? 0) / 100}
                              onChange={(e) => {
                                const bands = [...payForm.bands];
                                bands[i] = { ...b, payAmountSen: Math.round(Number(e.target.value) * 100) };
                                setPayForm({ ...payForm, bands });
                              }}
                              className="w-24 rounded border border-[#E2DDD8] px-2 py-0.5 text-right tabular-nums"
                            />
                          </>
                        ) : (
                          <>
                            <input
                              type="number"
                              value={b.payPct}
                              onChange={(e) => {
                                const bands = [...payForm.bands];
                                bands[i] = { ...b, payPct: Number(e.target.value) };
                                setPayForm({ ...payForm, bands });
                              }}
                              className="w-16 rounded border border-[#E2DDD8] px-2 py-0.5 text-right tabular-nums"
                            />
                            <span className="text-[#5A5550]">%</span>
                            <span className="text-[#9CA3AF] tabular-nums">
                              = RM {((payForm.amountRM * b.payPct) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}
                            </span>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => setPayForm({ ...payForm, bands: payForm.bands.filter((_, j) => j !== i) })}
                          className="text-[#9A3A2D] text-[11px]"
                        >
                          remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setPayForm({
                          ...payForm,
                          bands: [...payForm.bands, { minScore: 50, payPct: 20, payAmountSen: 0 }],
                        })
                      }
                      className="mt-1 text-[11px] underline decoration-dotted text-[#6B5C32]"
                    >
                      + add a rung
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={savePayout}
                    disabled={paySaving}
                    className="rounded-md bg-[#6B5C32] px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-50"
                  >
                    {paySaving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayOpen(false)}
                    className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-[11.5px]"
                  >
                    Cancel
                  </button>
                  {payMsg && <span className="text-[11px] text-[#5A5550]">{payMsg}</span>}
                </div>
              </CardContent>
            </Card>
          )}

          {cardLoading && !card ? (
            <Skeleton height={200} />
          ) : !card || card.lines.length === 0 ? (
            <Card className="bg-white rounded-xl">
              <CardContent className="p-6 text-sm text-[#5A5550]">
                No KPIs are assigned{viewUserId ? " to this person" : " to you"} yet.
                {isSuperAdmin && <> Use the <b>Library</b> tab to assign some.</>}
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="bg-white rounded-xl">
                <CardContent className="p-5 flex items-center gap-6 flex-wrap">
                  <div>
                    <p className="text-xs text-[#9CA3AF] mb-1">
                      Score · {card.period}
                      {card.locked && (
                        <span className="ml-2 rounded border border-[#E2DDD8] bg-[#F7F4EF] px-1.5 py-0.5 text-[10px]">settled</span>
                      )}
                    </p>
                    <p className="text-4xl font-extrabold tabular-nums leading-none" style={{ color: scoreColour(card.score) }}>
                      {card.score ?? "—"}<span className="text-lg text-[#9CA3AF] font-semibold"> / 100</span>
                    </p>
                  </div>
                  {card.payout?.mode === "MONTHLY_CASH" && (
                    <div className="border-l border-[#E2DDD8] pl-6">
                      <p className="text-xs text-[#9CA3AF] mb-1">Earns this month</p>
                      <p className="text-3xl font-extrabold tabular-nums leading-none text-[#1F1D1B]">
                        RM {(card.payout.earnedSen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}
                      </p>
                      {/* Say which rung, and what the next one is worth. 75
                          paying 60% is otherwise unexplained, and "why didn't
                          I get 75%" is the first question. */}
                      {/* A rung pays a share of the pot OR a flat sum, so the
                          wording follows whichever this ladder uses. */}
                      <p className="text-[11px] text-[#5A5550] mt-1">
                        {card.payout.band
                          ? card.payout.band.payAmountSen != null
                            ? `${card.payout.band.minScore}+ band`
                            : `${card.payout.band.payPct}% band (${card.payout.band.minScore}+) of RM ${(card.payout.amountSen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`
                          : "Below the lowest band — nothing is paid"}
                      </p>
                      {card.payout.nextBand && (
                        <p className="text-[11px] text-[#B5701A] mt-0.5">
                          {card.payout.nextBand.minScore} points pays RM{" "}
                          {(
                            (card.payout.nextBand.payAmountSen != null
                              ? card.payout.nextBand.payAmountSen
                              : (card.payout.amountSen * card.payout.nextBand.payPct) / 100) / 100
                          ).toLocaleString("en-MY", { minimumFractionDigits: 2 })}
                        </p>
                      )}
                      <div className="mt-2 flex gap-1 flex-wrap">
                        {[...card.payout.bands].sort((a, b) => b.minScore - a.minScore).map((b) => (
                          <span
                            key={b.minScore}
                            className="rounded border px-1.5 py-0.5 text-[10px] tabular-nums"
                            style={
                              card.payout?.band?.minScore === b.minScore
                                ? { borderColor: "#6B5C32", background: "#F5EFE2", fontWeight: 700 }
                                : { borderColor: "#E2DDD8", color: "#9CA3AF" }
                            }
                          >
                            {b.minScore}+ → {b.payAmountSen != null
                              ? `RM ${(b.payAmountSen / 100).toLocaleString("en-MY")}`
                              : `${b.payPct}%`}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {card.payout?.mode === "SCORE_ONLY" && (
                    <div className="border-l border-[#E2DDD8] pl-6">
                      <p className="text-xs text-[#9CA3AF] mb-1">Payout</p>
                      <p className="text-sm font-semibold text-[#5A5550]">Score only</p>
                      <p className="text-[11px] text-[#9CA3AF] mt-0.5">Settled at year end</p>
                    </div>
                  )}
                  <div className="flex-1 min-w-[220px] text-xs leading-relaxed">
                    <p className="text-[#5A5550]">Weighted across {card.weightMeasured} points.</p>
                  </div>
                </CardContent>
              </Card>

              {card.lines.map((l) => (
                <Card key={l.key} className="bg-white rounded-xl">
                  <CardContent className="p-4">
                    <div className="flex justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-bold flex items-center gap-1.5 flex-wrap">
                          {l.label}
                          {l.scoring && (
                            <Badge kind={l.scoring}>
                              {SCORING_LABEL[l.scoring] ?? "auto"}
                            </Badge>
                          )}
                        </div>
                        {l.purpose && (
                          <p className="text-[12px] text-[#1F1D1B] mt-1.5 leading-relaxed">
                            <span className="font-semibold">Why: </span>{l.purpose}
                          </p>
                        )}
                        {l.definition && (
                          <p className="text-[12px] text-[#3A3733] mt-1 leading-relaxed">
                            <span className="font-semibold">What is counted: </span>{l.definition}
                          </p>
                        )}
                        {(l.measurement?.length ?? 0) > 0 && (
                          <ol className="mt-1.5 ml-4 list-decimal space-y-0.5">
                            {l.measurement!.map((m) => (
                              <li key={m} className="text-[11.5px] text-[#3A3733] leading-relaxed">{m}</li>
                            ))}
                          </ol>
                        )}
                        <p className="text-[12px] text-[#5A5550] mt-1.5 font-medium">{l.evidence}</p>
                        {l.drillPath && (
                          <Link to={l.drillPath} className="text-[11px] underline decoration-dotted text-[#6B5C32]">
                            See the list →
                          </Link>
                        )}
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <p className="text-lg font-bold tabular-nums">{fmt(l.actual, l.unit)}</p>
                        <p className="text-[10.5px] text-[#9CA3AF]">
                          target {fmt(l.target, l.unit)}
                          {l.shape !== "GATE" && <> · wt {l.weight}</>}
                        </p>
                        {l.points !== null && (
                          <p className="text-[11px] font-semibold">{l.points} pts</p>
                        )}
                      </div>
                    </div>

                    {l.scoring === "CHECKLIST" && (l.checklistItems?.length ?? 0) > 0 && (
                      <ChecklistBlock
                        kpiKey={l.key}
                        items={l.checklistItems!}
                        period={period}
                        userId={viewUserId}
                        locked={card.locked}
                        onTick={tickItem}
                      />
                    )}

                    {l.scoring === "MANUAL" && (
                      <RatingBlock
                        line={l}
                        canRate={isSuperAdmin && !card.locked}
                        onSave={saveRating}
                      />
                    )}
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The link the office actually sends a customer.
 *
 * Owner 2026-08-07: "这些是发顾客一个类似 google form submit 选择的，直接评分."
 * Pick who is being measured and who is being asked, generate, copy, send. The
 * customer opens it on their phone, rates five questions and is done — no
 * login, no ERP.
 *
 * One link, one reply, and it expires — so a link belongs to ONE customer for
 * ONE month. Generate a fresh one per customer rather than forwarding the same
 * URL around, or the first person to open it spends everyone's.
 */
function SurveyLinkMaker({
  kpiKey, period, assignedTo,
}: {
  kpiKey: string;
  period: string;
  assignedTo: Array<{ userId: string; name: string }>;
}) {
  const [userId, setUserId] = useState<string>(assignedTo[0]?.userId ?? "");
  const [customerName, setCustomerName] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (!userId || busy) return;
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const r = await fetch(`/api/kpi/survey/${kpiKey}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId, period, customerName: customerName.trim() || undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean; data?: { url?: string }; error?: string;
      };
      if (!r.ok || !j.success || !j.data?.url) {
        setErr(j.error || "Could not generate a link.");
        return;
      }
      setUrl(j.data.url);
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (assignedTo.length === 0) {
    return (
      <p className="text-[11.5px] text-[#9CA3AF]">
        Assign this KPI to someone before generating a customer link.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-[#E2DDD8] bg-white p-2.5 space-y-2">
      <p className="text-[11.5px] font-semibold text-[#1F1D1B]">
        Send a customer this survey
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={userId}
          onChange={(e) => { setUserId(e.target.value); setUrl(null); }}
          aria-label="Who is being measured"
          className="h-7 rounded-md border border-[#E2DDD8] bg-white px-2 text-[11.5px]"
        >
          {assignedTo.map((a) => (
            <option key={a.userId} value={a.userId}>{a.name}</option>
          ))}
        </select>
        <input
          value={customerName}
          onChange={(e) => { setCustomerName(e.target.value); setUrl(null); }}
          placeholder="Customer name (optional)"
          aria-label="Customer name"
          className="h-7 min-w-[11rem] flex-1 rounded-md border border-[#E2DDD8] bg-white px-2 text-[11.5px]"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="h-7 rounded-md bg-[#6B5C32] px-3 text-[11.5px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Generating..." : "Generate link"}
        </button>
      </div>
      {err && <p className="text-[11px] text-[#9A3A2D]">{err}</p>}
      {url && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-[#F6F2EC] px-2 py-1 text-[11px] text-[#3A3733]">
            {url}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
            className="h-7 rounded-md border border-[#E2DDD8] px-2.5 text-[11px] font-semibold text-[#6B5C32]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {url && (
        <p className="text-[11px] text-[#9CA3AF]">
          One customer, one link, {period}. It can be answered once and expires
          in 30 days — generate a new one for the next customer.
        </p>
      )}
    </div>
  );
}

/**
 * A supervisor-rated KPI: the guide everyone can read, and — for Super Admin —
 * the box to score it in.
 *
 * The employee sees the guide whether or not they have been rated, because the
 * point of writing the bands down is that the score is not a surprise at month
 * end. When no rating exists yet the card says so; it does not show a zero.
 */
function RatingBlock({
  line, canRate, onSave,
}: {
  line: Line;
  canRate: boolean;
  onSave: (kpiKey: string, score: number, note: string) => Promise<void>;
}) {
  const [score, setScore] = useState<string>(
    line.actual === null ? "" : String(line.actual),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    const n = Number(score);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setErr("Score must be between 0 and 100");
      return;
    }
    if (!note.trim()) {
      setErr("Write the reason — the employee sees it");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await onSave(line.key, n, note.trim());
      setNote("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the rating");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-[#F0ECE6] pt-2.5 space-y-2">
      {(line.ratingGuide?.length ?? 0) > 0 && (
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
            How this is scored
          </p>
          <ul className="mt-1 space-y-0.5">
            {line.ratingGuide!.map((g) => (
              <li key={g} className="text-[11.5px] text-[#5A5550]">
                {g}
              </li>
            ))}
          </ul>
        </div>
      )}

      {line.actual === null && !canRate && (
        <p className="text-[11.5px] text-[#9CA3AF]">
          Not yet rated for this month.
        </p>
      )}

      {canRate && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              value={score}
              onChange={(e) => setScore(e.target.value)}
              placeholder="0–100"
              className="w-20 rounded border border-[#E5E0D8] px-2 py-1 text-[12px]"
            />
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason — the employee sees this"
              className="flex-1 min-w-0 rounded border border-[#E5E0D8] px-2 py-1 text-[12px]"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-[#1F1D1B] px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {err && <p className="text-[11px] text-[#9A3A2D]">{err}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The tickable items behind a checklist KPI.
 *
 * The list itself comes from the code catalogue, so the denominator cannot be
 * changed by anyone being measured against it; only the ticks are data.
 */
function ChecklistBlock({
  kpiKey, items, period, userId, locked, onTick,
}: {
  kpiKey: string; items: string[]; period: string; userId: string; locked: boolean;
  onTick: (kpiKey: string, itemIndex: number, done: boolean) => Promise<void>;
}) {
  const url = `/api/kpi/checklist/${kpiKey}?period=${period}${userId ? `&userId=${userId}` : ""}`;
  const { data } = useCachedJson<{ data?: Array<{ itemIndex: number; done: boolean }> }>(url);
  const done = new Set((data?.data ?? []).filter((t) => t.done).map((t) => t.itemIndex));

  return (
    <div className="mt-3 border-t border-[#F0ECE6] pt-2.5 space-y-1">
      {items.map((it, i) => (
        <label key={it} className="flex items-start gap-2 text-[11.5px]">
          <input
            type="checkbox"
            checked={done.has(i)}
            disabled={locked}
            onChange={(e) => void onTick(kpiKey, i, e.target.checked)}
            className="mt-0.5"
          />
          <span className={done.has(i) ? "text-[#5A5550]" : ""}>{it}</span>
        </label>
      ))}
      {locked && <p className="text-[10.5px] text-[#9CA3AF]">This month is settled — items are locked.</p>}
    </div>
  );
}
