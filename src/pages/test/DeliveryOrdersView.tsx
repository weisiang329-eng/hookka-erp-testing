import { useMemo } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Truck, PackageCheck, Split, Clock } from "lucide-react";
import { TEAL, GREEN, RED, MUTED, BORDER, fmtN, Kpi, LiveBadge, MissingNote } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype — the `delivery` +
// `availability.delivery`/`deliveryStatus` slices (src/api/routes/
// dashboard-prototype.ts). OTIF, the DO-status funnel and fleet performance
// all come straight off that payload; nothing here recomputes them.
type Feed = {
  success?: boolean;
  availability?: {
    delivery?: { live: boolean; rows: number; reason?: string; missing?: string[] };
    deliveryStatus?: { live: boolean; reason?: string };
  };
  delivery?: {
    otif: {
      onTimePct: number | null;
      judged: number;
      onTime: number;
      late: number;
      coveragePct: number | null;
      population: number;
    };
    byDay: { date: string; created: number; dispatched: number; delivered: number }[];
    velocity: { n: number; medianDays: number | null; p90Days: number | null; maxDays: number | null };
    split: { orders: number; splitOrders: number; singleOrders: number; ratePct: number | null };
    fleet: {
      name: string; dos: number; items: number; delivered: number;
      firstTimeOk: number; attemptsJudged: number;
    }[];
    statusBreakdown: { key: string; label: string; count: number; valueSen: number }[];
  };
};

// Dot colours for the 6-bucket status strip. Planning/Pending Delivery are
// production-order stages (no DO exists yet), so they can't borrow
// DELIVERY_STATUS_COLOR — this is its own small progression instead.
const BUCKET_COLOR: Record<string, string> = {
  planning: MUTED,
  pendingDelivery: MUTED,
  pendingDispatch: TEAL,
  dispatched: TEAL,
  delivered: GREEN,
  cancelled: RED,
};

export function DeliveryOrdersView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const delivery = data?.delivery;
  const live = data?.availability?.delivery?.live ?? false;
  const missing = data?.availability?.delivery?.missing ?? [];

  const chartData = useMemo(
    () =>
      [...(delivery?.byDay ?? [])]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((d) => ({
          date: d.date.slice(5),
          Created: d.created,
          Dispatched: d.dispatched,
          Delivered: d.delivered,
        })),
    [delivery?.byDay],
  );

  const totalDos = useMemo(
    () => (delivery?.statusBreakdown ?? []).reduce((s, b) => s + b.count, 0),
    [delivery?.statusBreakdown],
  );

  const fleet = useMemo(
    () => [...(delivery?.fleet ?? [])].sort((a, b) => b.dos - a.dos).slice(0, 15),
    [delivery?.fleet],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Delivery Orders: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const otif = delivery?.otif;

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Delivery Orders</h2>
        <LiveBadge live={live} />
      </div>
      <MissingNote fields={missing} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Kpi
          label="Total DOs"
          value={fmtN(totalDos)}
          icon={Truck}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
        <Kpi
          label="On-Time Delivery"
          value={otif?.onTimePct == null ? "—" : `${otif.onTimePct}%`}
          sub={otif ? `${fmtN(otif.judged)} judged, ${fmtN(otif.population)} total` : undefined}
          icon={PackageCheck}
          iconBgClass="bg-[#EEF3E4]"
          iconColorClass="text-[#4F7C3A]"
          valueColorClass="text-[#4F7C3A]"
        />
        <Kpi
          label="Split Orders"
          value={delivery?.split.ratePct == null ? "—" : `${delivery.split.ratePct.toFixed(1)}%`}
          sub={delivery ? `${fmtN(delivery.split.splitOrders)} of ${fmtN(delivery.split.orders)} SOs` : undefined}
          icon={Split}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
        />
        <Kpi
          label="Median Transit"
          value={delivery?.velocity.medianDays == null ? "—" : `${delivery.velocity.medianDays.toFixed(1)}d`}
          sub={delivery?.velocity.p90Days != null ? `p90 ${delivery.velocity.p90Days.toFixed(1)}d` : undefined}
          icon={Clock}
          iconBgClass="bg-[#E6F0F3]"
          iconColorClass="text-[#3E6570]"
          valueColorClass="text-[#3E6570]"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Where DOs are sitting</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {(delivery?.statusBreakdown ?? []).map((b) => (
              <div key={b.key} className="rounded-lg border border-[#E2DDD8] p-3">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#6B7280]">
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: BUCKET_COLOR[b.key] ?? MUTED }}
                  />
                  {b.label}
                </span>
                <p className="mt-2 text-xl font-bold tabular-nums text-[#1F1D1B]">{fmtN(b.count)}</p>
                <p className="text-xs text-[#6B7280]">{formatCurrency(b.valueSen)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>DO activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 220 }}>
            {chartData.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No delivery orders in range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: MUTED }}
                    axisLine={{ stroke: BORDER }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: MUTED }}
                    axisLine={false}
                    tickLine={false}
                    width={32}
                  />
                  <Tooltip
                    contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="Created" stroke={MUTED} strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="Dispatched" stroke={TEAL} strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="Delivered" stroke={GREEN} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Fleet performance</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["Driver", "DOs", "Items", "Delivered", "First-Time OK"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fleet.map((f) => (
                  <tr key={f.name} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 text-[#1F1D1B]">{f.name}</td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{fmtN(f.dos)}</td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{fmtN(f.items)}</td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{fmtN(f.delivered)}</td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">
                      {f.attemptsJudged ? `${((f.firstTimeOk / f.attemptsJudged) * 100).toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
                {fleet.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[#6B7280]">
                      No delivery orders.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
