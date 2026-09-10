import { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import {
  isOutstanding,
  isPendingDelivery,
  isCompleted,
} from "@/lib/so-status";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { ShoppingCart, DollarSign, Truck, CheckCircle } from "lucide-react";
import { TAUPE, TEAL, MUTED, BORDER, fmtN, Kpi, LiveBadge } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype (src/api/routes/dashboard-
// prototype.ts) — the SAME route + SQL the original HTML prototype read.
// Only the `sales` + `availability.sales` slices are used here; the route
// also computes delivery/inventory/purchase/employee/production, ready for
// when those tabs get ported.
type Feed = {
  success?: boolean;
  availability?: { sales?: { live: boolean; rows: number; reason?: string } };
  sales?: {
    byDay: { date: string; orders: number; revenueSen: number; cancelled: number }[];
    orders: {
      id: string;
      no: string | null;
      customer: string | null;
      status: string;
      totalSen: number;
      createdAt: string | null;
      deliveryDate: string | null;
      isServiceOrder: boolean;
    }[];
  };
};

export function SalesOrdersView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const orders = data?.sales?.orders ?? [];
  const byDay = data?.sales?.byDay ?? [];
  const live = data?.availability?.sales?.live ?? false;

  const kpis = useMemo(() => {
    const live = orders.filter((o) => o.status !== "CANCELLED");
    const outstanding = orders.filter((o) => isOutstanding(o.status));
    const pending = orders.filter((o) => isPendingDelivery(o.status));
    const completed = orders.filter((o) => isCompleted(o.status));
    return {
      soCount: live.length,
      revenueSen: live.reduce((s, o) => s + o.totalSen, 0),
      outstandingCount: outstanding.length,
      outstandingSen: outstanding.reduce((s, o) => s + o.totalSen, 0),
      pendingDelivery: pending.length,
      completedCount: completed.length,
    };
  }, [orders]);

  const chartData = useMemo(
    () =>
      [...byDay]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((d) => ({
          date: d.date.slice(5),
          Revenue: Math.round(d.revenueSen / 100),
          Orders: d.orders,
        })),
    [byDay],
  );

  const recentOrders = useMemo(
    () =>
      [...orders]
        .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))
        .slice(0, 30),
    [orders],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }

  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Sales Orders: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Sales Orders</h2>
        <LiveBadge live={live} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <Kpi
          label="Total Orders"
          value={fmtN(kpis.soCount)}
          icon={ShoppingCart}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
        <Kpi
          label="Revenue"
          value={formatCurrency(kpis.revenueSen)}
          icon={DollarSign}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
          valueColorClass="text-[#6B5C32]"
          valueSizeClass="text-xl"
        />
        <Kpi
          label="Outstanding"
          value={fmtN(kpis.outstandingCount)}
          sub={`${formatCurrency(kpis.outstandingSen)} value`}
          icon={DollarSign}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
        />
        <Kpi
          label="Pending Delivery"
          value={fmtN(kpis.pendingDelivery)}
          icon={Truck}
          iconBgClass="bg-[#E6F0F3]"
          iconColorClass="text-[#3E6570]"
          valueColorClass="text-[#3E6570]"
        />
        <Kpi
          label="Completed"
          value={fmtN(kpis.completedCount)}
          icon={CheckCircle}
          iconBgClass="bg-[#EEF3E4]"
          iconColorClass="text-[#4F7C3A]"
          valueColorClass="text-[#4F7C3A]"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Revenue trend</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 220 }}>
            {chartData.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No orders in range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="soRevGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={TAUPE} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={TAUPE} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: MUTED }}
                    axisLine={{ stroke: BORDER }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="rev"
                    tick={{ fontSize: 10, fill: MUTED }}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                  />
                  <YAxis
                    yAxisId="ord"
                    orientation="right"
                    tick={{ fontSize: 10, fill: MUTED }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#FFFFFF",
                      border: `1px solid ${BORDER}`,
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value, name) => {
                      const n = typeof value === "number" ? value : Number(value);
                      return name === "Revenue" ? [formatCurrency(n * 100), name] : [n, name];
                    }}
                  />
                  <Area
                    yAxisId="rev"
                    type="monotone"
                    dataKey="Revenue"
                    stroke={TAUPE}
                    fill="url(#soRevGrad)"
                    strokeWidth={2}
                  />
                  <Line
                    yAxisId="ord"
                    type="monotone"
                    dataKey="Orders"
                    stroke={TEAL}
                    strokeWidth={1.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Recent sales orders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["No", "Customer", "Status", "Total", "Created", "Delivery"].map((h) => (
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
                {recentOrders.map((o) => (
                  <tr key={o.id} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 font-mono text-[#1F1D1B]">{o.no ?? o.id}</td>
                    <td className="px-4 py-2 text-[#1F1D1B]">{o.customer ?? "—"}</td>
                    <td className="px-4 py-2">
                      <StatusBadge kind="so" value={o.status} />
                    </td>
                    <td className="px-4 py-2 amount text-[#1F1D1B]">{formatCurrency(o.totalSen)}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{o.createdAt ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{o.deliveryDate ?? "—"}</td>
                  </tr>
                ))}
                {recentOrders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-[#6B7280]">
                      No orders.
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
