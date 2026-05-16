import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  DollarSign,
  Package,
  Factory,
  Truck,
  Users,
  ClipboardCheck,
  ShoppingCart,
  CheckCircle2,
  Clock,
  Loader2,
  Scissors,
} from "lucide-react";

// ---------- API response types ----------

type SoStats = {
  success?: boolean;
  byStatus?: Record<string, number>;
  total?: number;
  csRevenueSen?: number;
  deliveredItemsSen?: number;
  outstandingItemsSen?: number;
};
type DoStats = {
  success?: boolean;
  byStatus?: Record<string, number>;
  valueByStatus?: Record<string, number>;
  total?: number;
};
type RevenueResp = {
  success?: boolean;
  data?: { month: string; revenueSen: number; orderCount: number }[];
};
type Overview = {
  success?: boolean;
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    completedToday: number;
    activeJobs: number;
  };
  purchasing?: {
    openPOCount: number;
    spendThisMonthSen: number;
    outstandingPOValueSen: number;
    itemsPendingReceipt: number;
    grnsPendingQC: number;
    topSuppliers: { name: string; spendSen: number }[];
  };
  fabricCostPerMeterSen?: { total: number; exclBedframeSofa: number };
  aovByCustomer?: {
    customerName: string;
    bedframeAvgSen: number;
    bedframeOrders: number;
    sofaAvgSen: number;
    sofaOrders: number;
    totalSen: number;
  }[];
  topSellers?: Record<
    string,
    { productCode: string; productName: string; qtySold: number; valueSen: number }[]
  >;
  employee?: {
    activeHeadcount: number;
    byDept: { dept: string; count: number }[];
  };
};

// ---------- helpers ----------

const rm = (sen: number | undefined) => formatCurrency(sen ?? 0);
const hrs = (min: number | undefined) =>
  `${Math.round((min ?? 0) / 60).toLocaleString()}h`;

function KPICard({
  title,
  value,
  subtitle,
  icon: Icon,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
}) {
  return (
    <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-[#5A5550] font-medium mb-1">{title}</p>
            <p className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B]">
              {value}
            </p>
            {subtitle && (
              <p className="text-xs text-[#9CA3AF] mt-1">{subtitle}</p>
            )}
          </div>
          <div className="rounded-lg bg-[#F5F2ED] p-2.5">
            <Icon className="h-5 w-5 text-[#6B5C32]" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h2 className="text-xs font-bold text-[#5A5550] uppercase tracking-wider mb-3">
      {label}
    </h2>
  );
}

// ---------- Dashboard ----------

export default function DashboardPage() {
  const { data: soRaw, loading: soL } =
    useCachedJson<SoStats>("/api/sales-orders/stats");
  const { data: doRaw, loading: doL } =
    useCachedJson<DoStats>("/api/delivery-orders/stats");
  const { data: ovRaw, loading: ovL } =
    useCachedJson<Overview>("/api/dashboard/overview");
  const { data: revRaw, loading: revL } = useCachedJson<RevenueResp>(
    "/api/dashboard/revenue?months=12",
  );

  const loading = soL || doL || ovL || revL;

  const so = soRaw ?? {};
  const doS = doRaw ?? {};
  const ov = ovRaw ?? {};
  const prod = ov.production;
  const pur = ov.purchasing;
  const fab = ov.fabricCostPerMeterSen;
  const emp = ov.employee;

  const pendingDeliveryValueSen = useMemo(() => {
    const v = doS.valueByStatus ?? {};
    return (v.DRAFT ?? 0) + (v.LOADED ?? 0) + (v.IN_TRANSIT ?? 0);
  }, [doS]);

  const revMax = useMemo(
    () => Math.max(1, ...((revRaw?.data ?? []).map((r) => r.revenueSen))),
    [revRaw],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
          <p className="text-xs text-[#6B7280]">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B]">
          {(() => {
            const h = new Date().getHours();
            const g =
              h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
            const n = getCurrentUser()?.displayName?.split(/\s+/)[0] || "there";
            return `${g}, ${n}`;
          })()}
        </h1>
        <p className="text-sm text-[#5A5550] mt-0.5">
          {new Date().toLocaleDateString("en-MY", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* Sales & Delivery */}
      <div>
        <SectionHeader label="Sales & Delivery" />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Confirmed Sales"
            value={rm(so.csRevenueSen)}
            subtitle={`${so.total ?? 0} orders`}
            icon={DollarSign}
          />
          <KPICard
            title="Delivered"
            value={rm(so.deliveredItemsSen)}
            subtitle="Goods actually shipped (item-level)"
            icon={Truck}
          />
          <KPICard
            title="Outstanding"
            value={rm(so.outstandingItemsSen)}
            subtitle="Confirmed but not yet delivered"
            icon={Clock}
          />
          <KPICard
            title="Pending Delivery"
            value={rm(pendingDeliveryValueSen)}
            subtitle="On a DO, not yet delivered"
            icon={Package}
          />
        </div>
      </div>

      {/* Production */}
      <div>
        <SectionHeader label="Production" />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Daily Capacity"
            value={hrs(prod?.dailyCapacityMin)}
            subtitle="7-working-day actual avg"
            icon={Factory}
          />
          <KPICard
            title="Backlog"
            value={`${(prod?.backlogDays ?? 0).toLocaleString()} days`}
            subtitle={`${hrs(prod?.backlogMin)} of work queued`}
            icon={Clock}
          />
          <KPICard
            title="Active Jobs"
            value={(prod?.activeJobs ?? 0).toLocaleString()}
            subtitle="In production / pending"
            icon={Package}
          />
          <KPICard
            title="Completed Today"
            value={(prod?.completedToday ?? 0).toLocaleString()}
            subtitle="Job cards finished today"
            icon={CheckCircle2}
          />
        </div>
      </div>

      {/* Employees + Purchasing */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-[#6B5C32]" /> Workforce —{" "}
              {emp?.activeHeadcount ?? 0} active
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {(emp?.byDept ?? []).length === 0 && (
              <p className="text-xs text-[#9CA3AF]">No active workers.</p>
            )}
            {(emp?.byDept ?? []).map((d) => (
              <div
                key={d.dept}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-[#5A5550]">{d.dept}</span>
                <span className="font-semibold text-[#1F1D1B] tabular-nums">
                  {d.count}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShoppingCart className="h-4 w-4 text-[#6B5C32]" /> Purchasing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div>
                <p className="text-xs text-[#5A5550]">Open POs</p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {pur?.openPOCount ?? 0}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#5A5550]">Outstanding Value</p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {rm(pur?.outstandingPOValueSen)}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#5A5550]">Spend This Month</p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {rm(pur?.spendThisMonthSen)}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#5A5550]">Pending Receipt</p>
                <p className="text-xl font-bold text-[#1F1D1B]">
                  {pur?.itemsPendingReceipt ?? 0}
                  <span className="text-xs text-[#9CA3AF] font-normal">
                    {" "}
                    · {pur?.grnsPendingQC ?? 0} GRN QC
                  </span>
                </p>
              </div>
            </div>
            {(pur?.topSuppliers ?? []).length > 0 && (
              <div className="border-t border-[#E2DDD8] pt-3">
                <p className="text-xs font-semibold text-[#5A5550] mb-1.5">
                  Top suppliers by spend
                </p>
                {(pur?.topSuppliers ?? []).map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center justify-between text-sm py-0.5"
                  >
                    <span className="text-[#5A5550] truncate pr-2">
                      {s.name}
                    </span>
                    <span className="font-semibold text-[#1F1D1B] tabular-nums">
                      {rm(s.spendSen)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Fabric cost + Monthly revenue trend */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Scissors className="h-4 w-4 text-[#6B5C32]" /> Fabric Cost / Meter
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-[#5A5550]">Overall (all issued)</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {rm(fab?.total)}
              </p>
            </div>
            <div className="border-t border-[#E2DDD8] pt-3">
              <p className="text-xs text-[#5A5550]">
                Excl. Bedframe &amp; Sofa
              </p>
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {rm(fab?.exclBedframeSofa)}
              </p>
            </div>
            <p className="text-[10px] text-[#9CA3AF]">
              Weighted avg of fabric actually issued to production.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Monthly Revenue — last 12 months
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(revRaw?.data ?? []).length === 0 ? (
              <p className="text-xs text-[#9CA3AF]">No revenue data.</p>
            ) : (
              <div className="space-y-1.5">
                {(revRaw?.data ?? []).map((r) => (
                  <div key={r.month} className="flex items-center gap-2">
                    <span className="text-[11px] text-[#9CA3AF] w-16 shrink-0 tabular-nums">
                      {r.month}
                    </span>
                    <div className="flex-1 bg-[#F5F2ED] rounded h-4 overflow-hidden">
                      <div
                        className="h-full bg-[#6B5C32]/70 rounded"
                        style={{
                          width: `${Math.max(2, (r.revenueSen / revMax) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-[11px] font-semibold text-[#1F1D1B] w-24 text-right tabular-nums">
                      {rm(r.revenueSen)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AOV by customer × category */}
      <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Avg Order Value by Customer — Bedframe vs Sofa
          </CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                <th className="py-1.5 font-medium">Customer</th>
                <th className="py-1.5 font-medium text-right">
                  Bedframe AOV
                </th>
                <th className="py-1.5 font-medium text-right">Orders</th>
                <th className="py-1.5 font-medium text-right">Sofa AOV</th>
                <th className="py-1.5 font-medium text-right">Orders</th>
              </tr>
            </thead>
            <tbody>
              {(ov.aovByCustomer ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="py-3 text-center text-xs text-[#9CA3AF]"
                  >
                    No confirmed orders.
                  </td>
                </tr>
              )}
              {(ov.aovByCustomer ?? []).map((r) => (
                <tr
                  key={r.customerName}
                  className="border-b border-[#F0ECE6]"
                >
                  <td className="py-1.5 text-[#1F1D1B]">{r.customerName}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.bedframeOrders ? rm(r.bedframeAvgSen) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                    {r.bedframeOrders || "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.sofaOrders ? rm(r.sofaAvgSen) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                    {r.sofaOrders || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Top sellers by category */}
      <div>
        <SectionHeader label="Top Sellers by Category" />
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
          {(["BEDFRAME", "SOFA", "ACCESSORY"] as const).map((cat) => (
            <Card
              key={cat}
              className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ClipboardCheck className="h-4 w-4 text-[#6B5C32]" /> {cat}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {(ov.topSellers?.[cat] ?? []).length === 0 && (
                  <p className="text-xs text-[#9CA3AF]">No sales.</p>
                )}
                {(ov.topSellers?.[cat] ?? []).map((p) => (
                  <div
                    key={p.productCode}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-[#5A5550] truncate pr-2">
                      <span className="font-medium text-[#1F1D1B]">
                        {p.productCode}
                      </span>{" "}
                      <span className="text-xs text-[#9CA3AF]">
                        ×{p.qtySold}
                      </span>
                    </span>
                    <span className="font-semibold text-[#1F1D1B] tabular-nums">
                      {rm(p.valueSen)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
