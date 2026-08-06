// ---------------------------------------------------------------------------
// KPI — one person's monthly scorecard.
//
// Owner 2026-08-06. Two things this page is built around:
//
//  1. Every number opens the list behind it. A figure nobody can click is a
//     figure nobody trusts, and the first question is always "which ones?".
//  2. A KPI that cannot be computed yet is SHOWN, greyed, contributing
//     nothing. Hiding it would make a half-built scorecard look complete.
//
// Self-service by default: the page asks /api/kpi/me and never sends a user
// id. Super Admin gets a picker, which switches to /api/kpi/users/:id — the
// server re-checks, so the picker is a convenience, not the gate.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";

type Line = {
  key: string;
  label: string;
  detail: string;
  scoring?: "AUTO" | "CHECKLIST";
  formula?: string;
  checklistItems?: string[];
  shape: "GATE" | "RATIO";
  unit: "%" | "count" | "score";
  available: boolean;
  blockedBy?: string;
  drillPath?: string;
  target: number;
  weight: number;
  actual: number | null;
  attainment: number | null;
  points: number | null;
  evidence: string;
};
type Card = {
  period: string;
  locked: boolean;
  lines: Line[];
  rawScore: number | null;
  score: number | null;
  gateFailed: boolean;
  gateCap: number;
  weightMeasured: number;
  weightUnbuilt: number;
};

const fmt = (v: number | null, unit: Line["unit"]): string => {
  if (v === null || !Number.isFinite(v)) return "—";
  if (unit === "%") return `${v}%`;
  if (unit === "score") return v.toFixed(1);
  return String(v);
};

function monthsBack(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function KpiPage() {
  const me = getCurrentUser();
  const isSuperAdmin = (me?.role ?? "").toUpperCase() === "SUPER_ADMIN";
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [viewUserId, setViewUserId] = useState<string>("");

  const { data: usersResp } = useCachedJson<{
    data?: Array<{ id: string; email: string; displayName?: string; role?: string }>;
  }>(isSuperAdmin ? "/api/users" : "");

  // ---- Assignment panel (Super Admin) ------------------------------------
  // Lives on this page rather than in Settings: whoever is deciding a target
  // is looking at the card the target produces, and making them navigate away
  // to change it is how targets stop being revisited.
  const [assignOpen, setAssignOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, { target: number; weight: number; on: boolean }>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const viewedUser = (usersResp?.data ?? []).find((u) => u.id === viewUserId);
  const viewedRole = (viewedUser?.role ?? me?.role ?? "").toUpperCase();

  const { data: catalogResp } = useCachedJson<{
    data?: Array<{
      key: string; label: string; detail: string; shape: string; unit: string;
      defaultTarget: number; defaultWeight: number; available: boolean; blockedBy?: string;
    }>;
  }>(isSuperAdmin && assignOpen && viewedRole ? `/api/kpi/catalog?role=${viewedRole}` : "");

  const { data: currentResp } = useCachedJson<{
    data?: Array<{ kpiKey: string; target: number; weight: number; isActive: boolean }>;
  }>(isSuperAdmin && assignOpen && viewUserId ? `/api/kpi/assignments/${viewUserId}` : "");

  const openAssign = () => {
    setSaveMsg(null);
    setAssignOpen(true);
  };

  // Seed the form from what is already assigned, falling back to the
  // catalogue's suggestion for anything not yet set.
  const seeded = useMemo(() => {
    const cat = catalogResp?.data ?? [];
    const cur = new Map((currentResp?.data ?? []).map((r) => [r.kpiKey, r]));
    const out: Record<string, { target: number; weight: number; on: boolean }> = {};
    for (const k of cat) {
      const c = cur.get(k.key);
      out[k.key] = c
        ? { target: Number(c.target), weight: Number(c.weight), on: c.isActive !== false }
        : { target: k.defaultTarget, weight: k.defaultWeight, on: false };
    }
    return out;
  }, [catalogResp, currentResp]);

  const form = Object.keys(draft).length ? draft : seeded;
  const patch = (key: string, v: Partial<{ target: number; weight: number; on: boolean }>) =>
    setDraft({ ...form, [key]: { ...form[key], ...v } });

  const save = async () => {
    if (!viewUserId) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const assignments = Object.entries(form).map(([kpiKey, v]) => ({
        kpiKey, target: Number(v.target), weight: Number(v.weight), isActive: v.on,
      }));
      const r = await fetch(`/api/kpi/assignments/${viewUserId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      const j = (await r.json()) as { success?: boolean; error?: string };
      if (!r.ok || !j.success) throw new Error(j.error || `Save failed (${r.status})`);
      setSaveMsg("Saved. Reopen the month to see the card.");
      setDraft({});
      invalidateCachePrefix("/api/kpi");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const url = viewUserId
    ? `/api/kpi/users/${viewUserId}?period=${period}`
    : `/api/kpi/me?period=${period}`;
  const { data, loading } = useCachedJson<{ success?: boolean; data?: Card }>(url);
  const card = data?.data;

  const months = useMemo(() => monthsBack(12), []);
  const scoreColour =
    card?.score == null ? "#9CA3AF" : card.score >= 90 ? "#3B6D11" : card.score >= 70 ? "#B5701A" : "#9A3A2D";

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550]">
            Performance
          </p>
          <h1 className="text-2xl font-bold text-[#1F1D1B]">
            {viewUserId ? "KPI" : "My KPI"}
          </h1>
          <p className="text-xs text-[#9CA3AF] mt-0.5">
            Settled monthly · targets are set by Super Admin
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <select
              value={viewUserId}
              onChange={(e) => setViewUserId(e.target.value)}
              className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs"
            >
              <option value="">My own card</option>
              {(usersResp?.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.email} · {u.role}
                </option>
              ))}
            </select>
          )}
          {isSuperAdmin && viewUserId && (
            <button
              type="button"
              onClick={openAssign}
              className="h-8 rounded-md bg-[#6B5C32] px-3 text-xs font-semibold text-white hover:bg-[#4D4224]"
            >
              Assign KPIs
            </button>
          )}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs"
          >
            {months.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      {isSuperAdmin && assignOpen && viewUserId && (
        <Card className="bg-white rounded-xl">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#E2DDD8] flex-wrap">
              <div>
                <p className="text-sm font-bold">
                  Assign KPIs — {viewedUser?.displayName || viewedUser?.email}
                </p>
                <p className="text-[11px] text-[#9CA3AF]">
                  {viewedRole} · they see this read-only on their own KPI page
                </p>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  // Weights should total 100 across the RATIO rows. Shown, not
                  // enforced — a half-finished assignment is a normal thing to
                  // save, and blocking it would mean juggling the last two rows
                  // just to close the dialog.
                  const total = Object.entries(form).reduce((sum, [key, v]) => {
                    if (!v.on) return sum;
                    const def = (catalogResp?.data ?? []).find((k) => k.key === key);
                    if (!def || def.shape === "GATE") return sum;
                    return sum + (Number(v.weight) || 0);
                  }, 0);
                  const ok = Math.round(total) === 100;
                  return (
                    <span className="text-[11px] font-semibold" style={{ color: ok ? "#3B6D11" : "#B5701A" }}>
                      Weights {Math.round(total * 10) / 10}{ok ? " ✓" : " / 100"}
                    </span>
                  );
                })()}
                {saveMsg && <span className="text-[11px] text-[#5A5550]">{saveMsg}</span>}
                <button
                  type="button"
                  onClick={() => { setAssignOpen(false); setDraft({}); }}
                  className="h-8 rounded-md border border-[#E2DDD8] px-3 text-xs"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="h-8 rounded-md bg-[#6B5C32] px-3 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            {(catalogResp?.data ?? []).length === 0 ? (
              <p className="p-4 text-xs text-[#5A5550]">
                No KPIs are defined for the {viewedRole} role yet.
              </p>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left px-4 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Assign</th>
                    <th className="text-left px-3 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">KPI</th>
                    <th className="text-right px-3 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Target</th>
                    <th className="text-right px-4 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {(catalogResp?.data ?? []).map((k) => {
                    const row = form[k.key] ?? { target: k.defaultTarget, weight: k.defaultWeight, on: false };
                    const isGate = k.shape === "GATE";
                    return (
                      <tr key={k.key} className="border-b border-[#F0ECE6] last:border-0">
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={row.on}
                            onChange={(e) => patch(k.key, { on: e.target.checked })}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-semibold flex items-center gap-1.5 flex-wrap">
                            {k.label}
                            {isGate && (
                              <span className="rounded border border-[#E7B8B0] bg-[#FDF3F1] px-1.5 text-[10px] text-[#9A3A2D]">
                                gate · caps the score
                              </span>
                            )}
                            {!k.available && (
                              <span className="rounded border border-[#D9C6A0] bg-[#FBF4E6] px-1.5 text-[10px] text-[#7A5C18]">
                                needs build
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[#9CA3AF]">
                            {k.available ? k.detail : k.blockedBy}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <input
                            type="number"
                            value={row.target}
                            onChange={(e) => patch(k.key, { target: Number(e.target.value) })}
                            className="w-20 rounded border border-[#E2DDD8] px-2 py-1 text-right text-xs tabular-nums"
                          />
                          <span className="ml-1 text-[11px] text-[#9CA3AF]">{k.unit === "count" ? "" : k.unit}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {isGate ? (
                            <span className="text-[11px] text-[#9CA3AF]">—</span>
                          ) : (
                            <input
                              type="number"
                              value={row.weight}
                              onChange={(e) => patch(k.key, { weight: Number(e.target.value) })}
                              className="w-16 rounded border border-[#E2DDD8] px-2 py-1 text-right text-xs tabular-nums"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {loading && !card ? (
        <Skeleton height={220} />
      ) : !card || card.lines.length === 0 ? (
        <Card className="bg-white rounded-xl">
          <CardContent className="p-6 text-sm text-[#5A5550]">
            No KPIs are assigned{viewUserId ? " to this person" : " to you"} yet.
            {isSuperAdmin && viewUserId && (
              <> Use <b>Assign KPIs</b> above.</>
            )}
            {isSuperAdmin && !viewUserId && (
              <> Pick a person above, then <b>Assign KPIs</b>.</>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="bg-white rounded-xl">
            <CardContent className="p-5">
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <p className="text-xs text-[#9CA3AF] mb-1">
                    Score · {card.period}
                    {card.locked && (
                      <span className="ml-2 rounded border border-[#E2DDD8] bg-[#F7F4EF] px-1.5 py-0.5 text-[10px]">
                        settled
                      </span>
                    )}
                  </p>
                  <p className="text-4xl font-extrabold tabular-nums leading-none" style={{ color: scoreColour }}>
                    {card.score == null ? "—" : card.score}
                    <span className="text-lg text-[#9CA3AF] font-semibold"> / 100</span>
                  </p>
                </div>
                <div className="flex-1 min-w-[220px] text-xs leading-relaxed">
                  {card.gateFailed ? (
                    <>
                      <p className="font-semibold text-[#9A3A2D]">
                        Capped at {card.gateCap} — a gate was not met.
                      </p>
                      <p className="text-[#9CA3AF] mt-0.5">
                        Weighted total would have been {card.rawScore}.
                      </p>
                    </>
                  ) : (
                    <p className="text-[#5A5550]">
                      Weighted across {card.weightMeasured} points of measurable KPIs.
                    </p>
                  )}
                  {card.weightUnbuilt > 0 && (
                    <p className="text-[#9CA3AF] mt-1">
                      {card.weightUnbuilt} points of assigned KPIs cannot be
                      measured yet and are excluded from the score.
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {card.lines
            .filter((l) => l.shape === "GATE")
            .map((g) => {
              const failed = g.actual !== null && g.actual > g.target;
              return (
                <Card key={g.key} className="rounded-xl" style={{
                  background: failed ? "#FDF3F1" : "#F2F7EE",
                  borderColor: failed ? "#E7B8B0" : "#BFD9AE",
                }}>
                  <CardContent className="p-4">
                    <div className="flex justify-between items-baseline gap-3 flex-wrap">
                      <span className="text-sm font-bold">🚩 Gate · {g.label}</span>
                      <span className="text-sm font-bold tabular-nums" style={{ color: failed ? "#9A3A2D" : "#3B6D11" }}>
                        {g.actual === null ? "—" : failed ? `${g.actual} late — not met` : "met"}
                      </span>
                    </div>
                    <p className="text-[11px] text-[#5A5550] mt-1.5 leading-relaxed">
                      Target <b>{g.target} late</b>. {g.evidence}
                      {g.drillPath && (
                        <Link to={g.drillPath} className="ml-2 underline decoration-dotted text-[#6B5C32]">
                          See them →
                        </Link>
                      )}
                    </p>
                  </CardContent>
                </Card>
              );
            })}

          <Card className="bg-white rounded-xl overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left px-4 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">KPI</th>
                  <th className="text-right px-3 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Target</th>
                  <th className="text-right px-3 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Actual</th>
                  <th className="text-right px-3 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Attain</th>
                  <th className="text-right px-3 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Weight</th>
                  <th className="text-right px-4 py-2 text-[10.5px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Points</th>
                </tr>
              </thead>
              <tbody>
                {card.lines.filter((l) => l.shape !== "GATE").map((l) => (
                  <tr key={l.key} className="border-b border-[#F0ECE6] last:border-0" style={{ opacity: l.available ? 1 : 0.55 }}>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold flex items-center gap-1.5 flex-wrap">
                        {l.label}
                        {!l.available && (
                          <span className="rounded border border-[#D9C6A0] bg-[#FBF4E6] px-1.5 text-[10px] text-[#7A5C18]">
                            needs build
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#9CA3AF]">{l.evidence || l.detail}</div>
                      {/* The derivation, in words. Owner 2026-08-06: the person
                          being measured has to be able to see exactly how the
                          number was reached, or the score gets argued with
                          instead of worked on. */}
                      {l.formula && (
                        <div className="text-[10.5px] text-[#9CA3AF] mt-0.5 leading-snug">
                          <span className="font-semibold">How it is calculated: </span>
                          {l.formula}
                        </div>
                      )}
                      {l.scoring === "CHECKLIST" && (l.checklistItems?.length ?? 0) > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {l.checklistItems!.map((it) => (
                            <li key={it} className="text-[10.5px] text-[#5A5550] flex gap-1.5">
                              <span className="text-[#9CA3AF]">•</span>
                              <span>{it}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {l.drillPath && l.available && (
                        <Link to={l.drillPath} className="text-[11px] underline decoration-dotted text-[#6B5C32]">
                          See the list →
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmt(l.target, l.unit)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmt(l.actual, l.unit)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{l.attainment === null ? "—" : `${l.attainment}%`}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[#9CA3AF]">{l.weight}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{l.points === null ? "—" : l.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
