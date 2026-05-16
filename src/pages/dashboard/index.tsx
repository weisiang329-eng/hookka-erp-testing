import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  buildLinkedPOIds,
  poReadyForDelivery,
  type PipelinePO,
} from "@/lib/delivery-pipeline";
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
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  }[];
  topSellers?: {
    BEDFRAME: { productCode: string; productName: string; qtySold: number; valueSen: number }[];
    SOFA: { model: string; setsSold: number; valueSen: number }[];
    ACCESSORY: { productCode: string; productName: string; qtySold: number; valueSen: number }[];
  };
  topFabrics?: { fabCode: string; fabName: string; meters: number; costSen: number }[];
  monthlySales?: { month: string; bedframeUnits: number; sofaSets: number }[];
  fabricMonthly?: { month: string; meters: number }[];
  employee?: {
    activeHeadcount: number;
    byDept: { dept: string; count: number }[];
  };
};

// Pending Delivery is computed client-side from the SAME payloads the
// Delivery page uses, through the shared src/lib/delivery-pipeline.ts
// predicates — so the dashboard card and the Delivery page's "Pending
// Delivery" tab can never drift (they previously did: RM 25,218 vs RM
// 50,793 when the server replicated the gate off the raw job_cards table).
type PODeliveryShape = PipelinePO & {
  salesOrderId?: string;
  productCode?: string;
  quantity?: number;
};
type POResp = { success?: boolean; data?: PODeliveryShape[] };
type DOResp = {
  success?: boolean;
  data?: { id: string; status: string; items?: { productionOrderId?: string | null }[] }[];
};
type POValuesResp = { success?: boolean; values?: Record<string, number> };
type SOItemsResp = {
  success?: boolean;
  data?: { id: string; items?: { productCode?: string; unitPriceSen?: number }[] }[];
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
  const { data: ovRaw, loading: ovL } =
    useCachedJson<Overview>("/api/dashboard/overview");
  const { data: revRaw, loading: revL } = useCachedJson<RevenueResp>(
    "/api/dashboard/revenue?months=12",
  );
  // Same four payloads the Delivery page reads. fields=minimal&include=jobCards
  // keeps the response small while carrying the upholstery JC statuses the
  // pipeline gate needs. limit=200 covers the whole DO table (83 rows).
  const { data: poRaw, loading: poL } = useCachedJson<POResp>(
    "/api/production-orders?fields=minimal&include=jobCards",
  );
  const { data: doRaw, loading: doL } = useCachedJson<DOResp>(
    "/api/delivery-orders?page=1&limit=200",
  );
  const { data: poValRaw, loading: poValL } = useCachedJson<POValuesResp>(
    "/api/delivery-orders/po-values",
  );
  const { data: soItemsRaw, loading: soItemsL } =
    useCachedJson<SOItemsResp>("/api/sales-orders");

  const loading = soL || ovL || revL || poL || doL || poValL || soItemsL;

  const so = soRaw ?? {};
  const ov = ovRaw ?? {};
  const prod = ov.production;
  const pur = ov.purchasing;
  const fab = ov.fabricCostPerMeterSen;
  const emp = ov.employee;

  // Pending Delivery — production complete (all upholstery JCs done) but
  // not yet on a delivery order. Computed here from the exact same payloads
  // and shared predicates as the Delivery page's "Pending Delivery" tab, so
  // the two figures are guaranteed identical (target: RM 50,793 / 80 POs).
  // Per-PO value mirrors the Delivery page: server po-value first, SO unit
  // price × qty as the fallback.
  const pendingDeliveryValueSen = useMemo(() => {
    const pos = poRaw?.success ? poRaw.data ?? [] : [];
    const dos = doRaw?.success ? doRaw.data ?? [] : [];
    const linkedPOIds = buildLinkedPOIds(dos);

    const poValMap = new Map<string, number>();
    for (const [k, v] of Object.entries(poValRaw?.values ?? {})) {
      poValMap.set(k, Number(v) || 0);
    }
    const soPriceByProduct = new Map<string, Map<string, number>>();
    const sos = soItemsRaw?.success ? soItemsRaw.data ?? [] : [];
    for (const s of sos) {
      const m = new Map<string, number>();
      for (const it of s.items ?? []) {
        if (it.productCode) m.set(it.productCode, Number(it.unitPriceSen) || 0);
      }
      soPriceByProduct.set(s.id, m);
    }

    let total = 0;
    for (const po of pos) {
      if (!poReadyForDelivery(po, linkedPOIds)) continue;
      const v =
        poValMap.get(po.id) ??
        (soPriceByProduct.get(po.salesOrderId || "")?.get(po.productCode || "") ??
          0) * (po.quantity || 0);
      total += v;
    }
    return total;
  }, [poRaw, doRaw, poValRaw, soItemsRaw]);

  const revMax = useMemo(
    () => Math.max(1, ...((revRaw?.data ?? []).map((r) => r.revenueSen))),
    [revRaw],
  );
  const fabMonthMax = useMemo(
    () =>
      Math.max(1, ...((ov.fabricMonthly ?? []).map((m) => m.meters))),
    [ov.fabricMonthly],
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
            subtitle="Made, not yet on a DO — same as Delivery page"
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
            Avg Order Value by Customer — Bedframe (per unit) vs Sofa (per set)
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
                <th className="py-1.5 font-medium text-right">Units</th>
                <th className="py-1.5 font-medium text-right">Sofa AOV</th>
                <th className="py-1.5 font-medium text-right">Sets</th>
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
                    {r.bedframeUnits ? rm(r.bedframeAvgSen) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                    {r.bedframeUnits || "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.sofaSets ? rm(r.sofaAvgSen) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                    {r.sofaSets || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-[#9CA3AF] mt-2">
            Bedframe AOV = total bedframe value ÷ total bedframe units. Sofa
            AOV = total Sales-Order value ÷ number of sofa sets (1 SO = 1
            set).
          </p>
        </CardContent>
      </Card>

      {/* Monthly Bedframe units & Sofa sets + Fabric meters */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Monthly — Bedframe Units &amp; Sofa Sets
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(ov.monthlySales ?? []).length === 0 ? (
              <p className="text-xs text-[#9CA3AF]">No sales data.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                    <th className="py-1.5 font-medium">Month</th>
                    <th className="py-1.5 font-medium text-right">
                      Bedframe units
                    </th>
                    <th className="py-1.5 font-medium text-right">
                      Sofa sets
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(ov.monthlySales ?? []).map((m) => (
                    <tr
                      key={m.month}
                      className="border-b border-[#F0ECE6]"
                    >
                      <td className="py-1.5 text-[#5A5550] tabular-nums">
                        {m.month}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                        {m.bedframeUnits.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                        {m.sofaSets.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[10px] text-[#9CA3AF] mt-2">
              By SO date. Bedframe = pieces sold; Sofa = sets (1 SO = 1
              set). Confirmed orders only.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Scissors className="h-4 w-4 text-[#6B5C32]" /> Fabric Usage
              (meters) — last 12 months
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(ov.fabricMonthly ?? []).length === 0 ? (
              <p className="text-xs text-[#9CA3AF]">No fabric issued.</p>
            ) : (
              <div className="space-y-1.5">
                {(ov.fabricMonthly ?? []).map((m) => (
                  <div key={m.month} className="flex items-center gap-2">
                    <span className="text-[11px] text-[#9CA3AF] w-16 shrink-0 tabular-nums">
                      {m.month}
                    </span>
                    <div className="flex-1 bg-[#F5F2ED] rounded h-4 overflow-hidden">
                      <div
                        className="h-full bg-[#6B5C32]/70 rounded"
                        style={{
                          width: `${Math.max(2, (m.meters / fabMonthMax) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-[11px] font-semibold text-[#1F1D1B] w-20 text-right tabular-nums">
                      {Math.round(m.meters).toLocaleString()} m
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-[#9CA3AF] mt-2">
              Fabric actually issued to production (RM_ISSUE).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top sellers */}
      <div>
        <SectionHeader label="Top Sellers" />
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 xl:grid-cols-4">
          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ClipboardCheck className="h-4 w-4 text-[#6B5C32]" /> Bedframe
                <span className="text-[10px] text-[#9CA3AF] font-normal">
                  by units
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(ov.topSellers?.BEDFRAME ?? []).length === 0 && (
                <p className="text-xs text-[#9CA3AF]">No sales.</p>
              )}
              {(ov.topSellers?.BEDFRAME ?? []).map((p) => (
                <div
                  key={p.productCode}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-[#5A5550] truncate pr-2">
                    <span className="font-medium text-[#1F1D1B]">
                      {p.productCode}
                    </span>{" "}
                    <span className="text-xs text-[#9CA3AF]">
                      ×{p.qtySold.toLocaleString()}
                    </span>
                  </span>
                  <span className="font-semibold text-[#1F1D1B] tabular-nums">
                    {rm(p.valueSen)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ClipboardCheck className="h-4 w-4 text-[#6B5C32]" /> Sofa
                <span className="text-[10px] text-[#9CA3AF] font-normal">
                  by model / sets
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(ov.topSellers?.SOFA ?? []).length === 0 && (
                <p className="text-xs text-[#9CA3AF]">No sales.</p>
              )}
              {(ov.topSellers?.SOFA ?? []).map((p) => (
                <div
                  key={p.model}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-[#5A5550] truncate pr-2">
                    <span className="font-medium text-[#1F1D1B]">
                      {p.model}
                    </span>{" "}
                    <span className="text-xs text-[#9CA3AF]">
                      ×{p.setsSold.toLocaleString()} sets
                    </span>
                  </span>
                  <span className="font-semibold text-[#1F1D1B] tabular-nums">
                    {rm(p.valueSen)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ClipboardCheck className="h-4 w-4 text-[#6B5C32]" /> Accessory
                <span className="text-[10px] text-[#9CA3AF] font-normal">
                  by units
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(ov.topSellers?.ACCESSORY ?? []).length === 0 && (
                <p className="text-xs text-[#9CA3AF]">No sales.</p>
              )}
              {(ov.topSellers?.ACCESSORY ?? []).map((p) => (
                <div
                  key={p.productCode}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-[#5A5550] truncate pr-2">
                    <span className="font-medium text-[#1F1D1B]">
                      {p.productCode}
                    </span>{" "}
                    <span className="text-xs text-[#9CA3AF]">
                      ×{p.qtySold.toLocaleString()}
                    </span>
                  </span>
                  <span className="font-semibold text-[#1F1D1B] tabular-nums">
                    {rm(p.valueSen)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Scissors className="h-4 w-4 text-[#6B5C32]" /> Fabric
                <span className="text-[10px] text-[#9CA3AF] font-normal">
                  by meters used
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(ov.topFabrics ?? []).length === 0 && (
                <p className="text-xs text-[#9CA3AF]">No fabric issued.</p>
              )}
              {(ov.topFabrics ?? []).map((f) => (
                <div
                  key={f.fabCode}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-[#5A5550] truncate pr-2">
                    <span className="font-medium text-[#1F1D1B]">
                      {f.fabCode}
                    </span>{" "}
                    <span className="text-xs text-[#9CA3AF]">
                      {Math.round(f.meters).toLocaleString()} m
                    </span>
                  </span>
                  <span className="font-semibold text-[#1F1D1B] tabular-nums">
                    {rm(f.costSen)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
