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
import { useCachedJson } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";

type Line = {
  key: string;
  label: string;
  detail: string;
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

      {loading && !card ? (
        <Skeleton height={220} />
      ) : !card || card.lines.length === 0 ? (
        <Card className="bg-white rounded-xl">
          <CardContent className="p-6 text-sm text-[#5A5550]">
            No KPIs are assigned{viewUserId ? " to this person" : " to you"} yet.
            {isSuperAdmin && (
              <> Assign them under <b>Settings → KPI</b>.</>
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
