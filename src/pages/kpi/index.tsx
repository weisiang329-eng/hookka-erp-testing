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

type Scoring = "AUTO" | "CHECKLIST";

type Line = {
  key: string; label: string; detail: string;
  scoring?: Scoring; formula?: string; checklistItems?: string[];
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
  scoring: Scoring; formula: string; checklistItems?: string[];
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
  GATE: "border-[#E7B8B0] bg-[#FDF3F1] text-[#9A3A2D]",
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

  const weightOf = (k: LibItem) =>
    k.shape === "GATE" ? 0 : (kpiWeights[k.key] ?? k.defaultWeight);
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
              lib.map((k) => (
                <label
                  key={k.key}
                  className={`flex gap-2.5 px-4 py-2.5 border-b border-[#F0ECE6] last:border-0 cursor-pointer ${
                    picked.has(k.key) ? "bg-[#FBF8F2]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(k.key)}
                    onChange={() => togglePick(k.key)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold flex items-center gap-1.5 flex-wrap">
                      {k.label}
                      {k.shape === "GATE" && <Badge kind="GATE">gate</Badge>}
                      <Badge kind={k.scoring}>{k.scoring === "AUTO" ? "auto" : "checklist"}</Badge>
                    </div>
                    <div className="text-[11.5px] text-[#5A5550]">{k.detail}</div>
                    <div className="text-[11px] text-[#3A3733] mt-1 leading-relaxed">{k.definition}</div>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {k.assignedTo.length === 0 ? (
                        <span className="rounded-full bg-[#F2EFE9] px-2 text-[10px] text-[#9CA3AF]">nobody</span>
                      ) : (
                        k.assignedTo.map((a) => (
                          <span key={a.userId} className="rounded-full bg-[#F2EFE9] px-2 text-[10px] text-[#5A5550]">
                            {a.name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="text-[13.5px] font-bold tabular-nums" style={{ color: scoreColour(null) }}>
                      {k.current === null ? "—" : fmt(k.current, k.unit)}
                    </div>
                    <div className="text-[10px] text-[#9CA3AF]">{k.evidence}</div>
                  </div>
                </label>
              ))
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
                  {k.shape === "GATE" ? (
                    <span className="text-[10px] text-[#9A3A2D] whitespace-nowrap">caps the score</span>
                  ) : (
                    <>
                      <input
                        type="number"
                        value={kpiWeights[k.key] ?? k.defaultWeight}
                        onChange={(e) => setKpiWeights({ ...kpiWeights, [k.key]: Number(e.target.value) })}
                        className="w-14 rounded border border-[#E2DDD8] px-2 py-0.5 text-right text-[11px] tabular-nums"
                      />
                      <span className="text-[10px] text-[#9CA3AF]">wt</span>
                    </>
                  )}
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
                      {p.gateFailed && <span className="ml-1.5 text-[10px] text-[#9A3A2D]">gate missed</span>}
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
                    {card.gateFailed ? (
                      <>
                        <p className="font-semibold text-[#9A3A2D]">Capped at {card.gateCap} — a gate was not met.</p>
                        <p className="text-[#9CA3AF] mt-0.5">Weighted total would have been {card.rawScore}.</p>
                      </>
                    ) : (
                      <p className="text-[#5A5550]">Weighted across {card.weightMeasured} points.</p>
                    )}
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
                          {l.shape === "GATE" && <Badge kind="GATE">gate · caps the score</Badge>}
                          {l.scoring && <Badge kind={l.scoring}>{l.scoring === "AUTO" ? "auto" : "checklist"}</Badge>}
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
