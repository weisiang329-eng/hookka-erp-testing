import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, PackageOpen, Ban, AlertTriangle } from "lucide-react";
import { TAUPE, GREEN, AMBER, RED, MUTED, BORDER, fmtN, Kpi, LiveBadge, MissingNote } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype — the `purchase` +
// `availability.purchase` slices (purchase_orders + purchase_order_items,
// src/api/routes/dashboard-prototype.ts). Overdue tiers, supplier on-time
// rate and the register are all pre-computed there; this just renders them.
type Feed = {
  success?: boolean;
  availability?: { purchase?: { live: boolean; reason?: string; rows: number; missing?: string[] } };
  purchase?: {
    totals: { all: number; cancelled: number; active: number };
    tiers: { key: string; label: string; count: number; valueSen: number }[];
    suppliers: { name: string; pos: number; valueSen: number; judged: number; onTime: number; otrPct: number | null }[];
    register: {
      id: string; no: string | null; supplier: string; status: string;
      orderDate: string | null; expectedDate: string | null; receivedDate: string | null;
      totalSen: number; daysLate: number | null; tier: string; cancelled: boolean;
    }[];
  };
};

const TIER_COLOR: Record<string, string> = {
  received: MUTED,
  ontrack: GREEN,
  minor: AMBER,
  moderate: "#B8601A",
  critical: RED,
  undated: MUTED,
  cancelled: MUTED,
};

export function PurchaseOrdersView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const purchase = data?.purchase;
  const live = data?.availability?.purchase?.live ?? false;
  const missing = data?.availability?.purchase?.missing ?? [];

  const overdueCount = useMemo(
    () =>
      (purchase?.tiers ?? [])
        .filter((t) => t.key === "minor" || t.key === "moderate" || t.key === "critical")
        .reduce((s, t) => s + t.count, 0),
    [purchase?.tiers],
  );

  const tierChart = useMemo(
    () => (purchase?.tiers ?? []).map((t) => ({ key: t.key, label: t.label, count: t.count })),
    [purchase?.tiers],
  );

  const topSuppliers = useMemo(
    () => [...(purchase?.suppliers ?? [])].slice(0, 15),
    [purchase?.suppliers],
  );

  const recentPOs = useMemo(
    () =>
      [...(purchase?.register ?? [])]
        .sort((a, b) => ((a.orderDate ?? "") < (b.orderDate ?? "") ? 1 : -1))
        .slice(0, 30),
    [purchase?.register],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Purchase Orders: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Purchase Orders</h2>
        <LiveBadge live={live} />
      </div>
      <MissingNote fields={missing} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Kpi
          label="Total POs"
          value={fmtN(purchase?.totals.all ?? 0)}
          icon={ClipboardList}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
        <Kpi
          label="Active"
          value={fmtN(purchase?.totals.active ?? 0)}
          icon={PackageOpen}
          iconBgClass="bg-[#E6F0F3]"
          iconColorClass="text-[#3E6570]"
          valueColorClass="text-[#3E6570]"
        />
        <Kpi
          label="Overdue"
          value={fmtN(overdueCount)}
          sub="1+ days past expected date"
          icon={AlertTriangle}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
        />
        <Kpi
          label="Cancelled"
          value={fmtN(purchase?.totals.cancelled ?? 0)}
          icon={Ban}
          iconBgClass="bg-[#F9E1DA]"
          iconColorClass="text-[#9A3A2D]"
          valueColorClass="text-[#9A3A2D]"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>PO ageing</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tierChart} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={50}>
                  {tierChart.map((t) => (
                    <Cell key={t.key} fill={TIER_COLOR[t.key] ?? TAUPE} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Top suppliers by spend</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                    {["Supplier", "POs", "Spend", "On-Time"].map((h) => (
                      <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topSuppliers.map((s) => (
                    <tr key={s.name} className="border-b border-[#E2DDD8]">
                      <td className="px-4 py-2 text-[#1F1D1B]">{s.name}</td>
                      <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{fmtN(s.pos)}</td>
                      <td className="px-4 py-2 amount text-[#1F1D1B]">{formatCurrency(s.valueSen)}</td>
                      <td className="px-4 py-2 tabular-nums text-[#6B7280]">
                        {s.otrPct == null ? "—" : `${s.otrPct.toFixed(0)}%`}
                      </td>
                    </tr>
                  ))}
                  {topSuppliers.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-6 text-center text-[#6B7280]">No suppliers.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Recent purchase orders</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                    {["No", "Supplier", "Status", "Expected", "Days Late", "Total"].map((h) => (
                      <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentPOs.map((po) => (
                    <tr key={po.id} className="border-b border-[#E2DDD8]">
                      <td className="px-4 py-2 font-mono text-[#1F1D1B]">{po.no ?? po.id}</td>
                      <td className="px-4 py-2 text-[#1F1D1B]">{po.supplier}</td>
                      <td className="px-4 py-2"><Badge variant="status" status={po.status} /></td>
                      <td className="px-4 py-2 text-[#6B7280]">{po.expectedDate ?? "—"}</td>
                      <td className="px-4 py-2 tabular-nums text-[#6B7280]">
                        {po.daysLate == null ? "—" : po.daysLate > 0 ? `${po.daysLate}d late` : "on time"}
                      </td>
                      <td className="px-4 py-2 amount text-[#1F1D1B]">{formatCurrency(po.totalSen)}</td>
                    </tr>
                  ))}
                  {recentPOs.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-[#6B7280]">No purchase orders.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
