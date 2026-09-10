import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Factory, AlertOctagon, AlertTriangle, CheckCircle2 } from "lucide-react";
import { TAUPE, RED, MUTED, BORDER, fmtN } from "./dashboard-shared-lib";
import { Kpi, LiveBadge } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype — the `production` +
// `availability.production` slices (production_orders + job_cards,
// src/api/routes/dashboard-prototype.ts). Stage order, backlog and risk
// banding are all computed there off departments.sequence; `onTime` reuses
// the SAME OTIF figure the Delivery tab shows — one definition, two screens.
type Feed = {
  success?: boolean;
  availability?: { production?: { live: boolean; reason?: string; rows: number } };
  production?: {
    backlog: { dept: string; seq: number; cards: number; orders: number }[];
    bottleneck: { dept: string; cards: number; orders: number } | null;
    orders: {
      id: string; poNo: string | null; soNo: string | null; customer: string | null;
      productName: string | null; qty: number; pctDone: number; daysToDD: number | null;
      currentDept: string | null; risk: "critical" | "atrisk" | "ontrack" | "unknown";
    }[];
    totals: { active: number; critical: number; atRisk: number; onTrack: number; unknownDue: number; backlogCards: number };
  };
};

const RISK_STYLE: Record<string, { label: string; text: string; bg: string }> = {
  critical: { label: "Critical", text: "text-[#9A3A2D]", bg: "bg-[#F9E1DA]" },
  atrisk: { label: "At Risk", text: "text-[#9C6F1E]", bg: "bg-[#FAEFCB]" },
  ontrack: { label: "On Track", text: "text-[#4F7C3A]", bg: "bg-[#EEF3E4]" },
  unknown: { label: "Unknown", text: "text-[#6B7280]", bg: "bg-[#F5F2ED]" },
};

const RISK_ORDER: Record<string, number> = { critical: 0, atrisk: 1, unknown: 2, ontrack: 3 };

export function ProductionTrackingView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const production = data?.production;
  const live = data?.availability?.production?.live ?? false;

  const backlogChart = useMemo(
    () => [...(production?.backlog ?? [])].sort((a, b) => a.seq - b.seq),
    [production?.backlog],
  );

  const orders = useMemo(
    () =>
      [...(production?.orders ?? [])]
        .sort((a, b) => (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9) || (a.daysToDD ?? 999) - (b.daysToDD ?? 999))
        .slice(0, 40),
    [production?.orders],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Production Tracking: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const bottleneckDept = production?.bottleneck?.dept;

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Production Tracking</h2>
        <LiveBadge live={live} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Kpi
          label="Active Orders"
          value={fmtN(production?.totals.active ?? 0)}
          icon={Factory}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
        <Kpi
          label="Critical"
          value={fmtN(production?.totals.critical ?? 0)}
          sub="past customer date"
          icon={AlertOctagon}
          iconBgClass="bg-[#F9E1DA]"
          iconColorClass="text-[#9A3A2D]"
          valueColorClass="text-[#9A3A2D]"
        />
        <Kpi
          label="At Risk"
          value={fmtN(production?.totals.atRisk ?? 0)}
          sub="due ≤7d, <60% done"
          icon={AlertTriangle}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
        />
        <Kpi
          label="On Track"
          value={fmtN(production?.totals.onTrack ?? 0)}
          icon={CheckCircle2}
          iconBgClass="bg-[#EEF3E4]"
          iconColorClass="text-[#4F7C3A]"
          valueColorClass="text-[#4F7C3A]"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Backlog by department</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 200 }}>
            {backlogChart.every((b) => b.cards === 0) ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No open job cards.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={backlogChart} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <XAxis dataKey="dept" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={30} />
                  <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="cards" radius={[4, 4, 0, 0]} maxBarSize={50}>
                    {backlogChart.map((b) => (
                      <Cell key={b.dept} fill={b.dept === bottleneckDept ? RED : TAUPE} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          {production?.bottleneck && (
            <p className="mt-2 text-xs text-[#6B7280]">
              Bottleneck: <span className="font-semibold text-[#9A3A2D]">{production.bottleneck.dept}</span> — {fmtN(production.bottleneck.cards)} cards across {fmtN(production.bottleneck.orders)} orders.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Open production orders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["SO", "Customer", "Product", "Qty", "Progress", "Days to DD", "Current Dept", "Risk"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const risk = RISK_STYLE[o.risk] ?? RISK_STYLE.unknown;
                  return (
                    <tr key={o.id} className="border-b border-[#E2DDD8]">
                      <td className="px-4 py-2 font-mono text-[#1F1D1B]">{o.soNo ?? "—"}</td>
                      <td className="px-4 py-2 text-[#1F1D1B]">{o.customer ?? "—"}</td>
                      <td className="px-4 py-2 text-[#1F1D1B]">{o.productName ?? "—"}</td>
                      <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{fmtN(o.qty)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2 w-24">
                          <div className="h-1.5 flex-1 rounded-full bg-[#F0ECE9] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-[#6B5C32]"
                              style={{ width: `${Math.min(100, Math.max(0, o.pctDone))}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-[#6B7280] text-[11px]">{Math.round(o.pctDone)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 tabular-nums text-[#6B7280]">
                        {o.daysToDD == null ? "—" : o.daysToDD < 0 ? `${-o.daysToDD}d overdue` : `${o.daysToDD}d`}
                      </td>
                      <td className="px-4 py-2 text-[#6B7280]">{o.currentDept ?? "—"}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${risk.bg} ${risk.text}`}>
                          {risk.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {orders.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-[#6B7280]">No open production orders.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
