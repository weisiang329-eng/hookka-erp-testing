import { useMemo, useState } from "react";
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
  X,
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
type JobsBreakdown = {
  bedframeUnits: number;
  sofaSets: number;
  byCustomer: { customer: string; bedframeUnits: number; sofaSets: number }[];
};
type Overview = {
  success?: boolean;
  salesThisMonthSen?: number;
  deliveredThisMonthSen?: number;
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    activeJobs: JobsBreakdown;
    completedYesterday: JobsBreakdown;
    capacityDays: { date: string; minutes: number }[];
    backlogByDept: {
      dept: string;
      sofaMin: number;
      bedframeMin: number;
      totalMin: number;
      dailyCapMin: number;
      backlogDays: number;
    }[];
    backlogGrandMin: number;
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
  };
  topFabrics?: { fabCode: string; fabName: string; meters: number; costSen: number }[];
  monthlySales?: { month: string; bedframeUnits: number; sofaSets: number }[];
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
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
// Employee efficiency = production minutes ÷ (clocked production hours
// × 60) × 100 — exact same formula as the Employee page, over the
// last 7 working days.
type JcSummaryResp = {
  data?: { workerId: string; productionMinutes: number; jcCount: number }[];
};
type WheSummaryResp = {
  data?: {
    workerId: string;
    totalHours: number;
    byDept: Record<string, number>;
    daysWithEntries: number;
  }[];
};
type WorkersResp = {
  data?: { id: string; name: string; departmentCode?: string; status?: string }[];
};

const PROD_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
]);

// Last 7 working days (Mon–Sat), ending yesterday — same window the
// dashboard's Daily Capacity uses, so efficiency lines up with it.
function last7WorkingDays(): { from: string; to: string } {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const days: string[] = [];
  const cur = new Date();
  cur.setHours(0, 0, 0, 0);
  cur.setDate(cur.getDate() - 1);
  while (days.length < 7) {
    if (cur.getDay() !== 0) days.push(iso(cur));
    cur.setDate(cur.getDate() - 1);
  }
  days.sort((a, b) => a.localeCompare(b));
  return { from: days[0], to: days[days.length - 1] };
}

// ---------- helpers ----------

const rm = (sen: number | undefined) => formatCurrency(sen ?? 0);
const hrs = (min: number | undefined) =>
  `${Math.round((min ?? 0) / 60).toLocaleString()}h`;
// "201h 50m" — matches the Planning page's capacity/backlog modals.
const hm = (min: number | undefined) => {
  const m = Math.max(0, Math.round(min ?? 0));
  return `${Math.floor(m / 60).toLocaleString()}h ${m % 60}m`;
};

function KPICard({
  title,
  value,
  subtitle,
  icon: Icon,
  onClick,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  onClick?: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={`bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] ${
        onClick
          ? "cursor-pointer hover:shadow-[0_2px_8px_rgba(0,0,0,0.12)] transition-shadow"
          : ""
      }`}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-[#5A5550] font-medium mb-1">
              {title}
              {onClick && (
                <span className="text-[#9CA3AF] font-normal"> · view</span>
              )}
            </p>
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

// Lightweight centred modal used by every dashboard drill-through.
function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 sm:p-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[#E2DDD8] px-6 py-4">
          <div>
            <h3 className="text-base font-bold text-[#1F1D1B]">{title}</h3>
            {subtitle && (
              <p className="text-xs text-[#9CA3AF] mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 hover:bg-[#F5F2ED] text-[#5A5550]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

// Customer-contribution table shared by the Active Jobs / Completed
// Yesterday drill-throughs.
function CustomerJobsTable({
  rows,
}: {
  rows: { customer: string; bedframeUnits: number; sofaSets: number }[];
}) {
  if (rows.length === 0)
    return <p className="text-xs text-[#9CA3AF]">Nothing here.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
          <th className="py-1.5 font-medium">Customer</th>
          <th className="py-1.5 font-medium text-right">Bedframe units</th>
          <th className="py-1.5 font-medium text-right">Sofa sets</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.customer} className="border-b border-[#F0ECE6]">
            <td className="py-1.5 text-[#1F1D1B]">{r.customer}</td>
            <td className="py-1.5 text-right tabular-nums">
              {r.bedframeUnits ? r.bedframeUnits.toLocaleString() : "—"}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {r.sofaSets ? r.sofaSets.toLocaleString() : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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

  // Employee efficiency — last 7 working days (Employee-page formula).
  const effWin = useMemo(() => last7WorkingDays(), []);
  const { data: jcSumRaw, loading: jcSumL } = useCachedJson<JcSummaryResp>(
    `/api/job-cards/summary?from=${effWin.from}&to=${effWin.to}`,
  );
  const { data: wheSumRaw, loading: wheSumL } = useCachedJson<WheSummaryResp>(
    `/api/working-hour-entries/summary?from=${effWin.from}&to=${effWin.to}`,
  );
  const { data: workersRaw, loading: workersL } =
    useCachedJson<WorkersResp>("/api/workers");

  const loading =
    soL ||
    ovL ||
    poL ||
    doL ||
    poValL ||
    soItemsL ||
    jcSumL ||
    wheSumL ||
    workersL;

  // Top / bottom 5 by efficiency = prodMins ÷ (prodHours × 60) × 100,
  // production-dept hours only, workers with real activity.
  const efficiency = useMemo(() => {
    const prodMin = new Map<string, number>();
    for (const r of jcSumRaw?.data ?? [])
      prodMin.set(r.workerId, Number(r.productionMinutes) || 0);
    const name = new Map<string, string>();
    for (const w of workersRaw?.data ?? []) name.set(w.id, w.name || w.id);
    const rows: { name: string; pct: number }[] = [];
    for (const e of wheSumRaw?.data ?? []) {
      if ((e.daysWithEntries ?? 0) === 0) continue;
      let prodHours = 0;
      for (const [dept, h] of Object.entries(e.byDept ?? {}))
        if (PROD_DEPTS.has(dept)) prodHours += Number(h) || 0;
      if (prodHours <= 0) continue;
      const mins = prodMin.get(e.workerId) ?? 0;
      const pct = (mins / (prodHours * 60)) * 100;
      rows.push({ name: name.get(e.workerId) ?? e.workerId, pct });
    }
    rows.sort((a, b) => b.pct - a.pct);
    return {
      top: rows.slice(0, 5),
      bottom: rows.slice(-5).reverse(),
      count: rows.length,
    };
  }, [jcSumRaw, wheSumRaw, workersRaw]);

  const so = soRaw ?? {};
  const ov = ovRaw ?? {};
  const prod = ov.production;
  const pur = ov.purchasing;
  const fab = ov.fabricCostPerMeterSen;

  const [drill, setDrill] = useState<{
    title: string;
    subtitle?: string;
    node: React.ReactNode;
  } | null>(null);

  const monthLabel = new Date().toLocaleDateString("en-MY", {
    month: "long",
    year: "numeric",
  });

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
            title="This Month Sales"
            value={rm(ov.salesThisMonthSen)}
            subtitle={`Confirmed SO total · ${monthLabel}`}
            icon={DollarSign}
          />
          <KPICard
            title="This Month Delivered"
            value={rm(ov.deliveredThisMonthSen)}
            subtitle={`Goods shipped (item-level) · ${monthLabel}`}
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
            onClick={
              prod?.capacityDays
                ? () =>
                    setDrill({
                      title: "Daily Capacity — Past 7 Working Days",
                      subtitle: `Average: ${hm(prod.dailyCapacityMin)}/day across all production depts`,
                      node: (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                              <th className="py-1.5 font-medium">Date</th>
                              <th className="py-1.5 font-medium text-right">
                                Production Time
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                vs Avg
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {prod.capacityDays.map((d) => {
                              const diff =
                                d.minutes - prod.dailyCapacityMin;
                              return (
                                <tr
                                  key={d.date}
                                  className="border-b border-[#F0ECE6]"
                                >
                                  <td className="py-1.5 text-[#1F1D1B] tabular-nums">
                                    {d.date}
                                  </td>
                                  <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                                    {hm(d.minutes)}
                                  </td>
                                  <td
                                    className={`py-1.5 text-right tabular-nums ${diff >= 0 ? "text-[#15803D]" : "text-[#DC2626]"}`}
                                  >
                                    {diff >= 0 ? "+" : "−"}
                                    {hm(Math.abs(diff))}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ),
                    })
                : undefined
            }
          />
          <KPICard
            title="Backlog"
            value={`${(prod?.backlogDays ?? 0).toLocaleString()} days`}
            subtitle={`${hrs(prod?.backlogMin)} of work queued`}
            icon={Clock}
            onClick={
              prod?.backlogByDept
                ? () =>
                    setDrill({
                      title: "Total Backlog — per Department",
                      subtitle: `${hm(prod.backlogGrandMin)} of active work across ${prod.backlogByDept.length} dept${prod.backlogByDept.length === 1 ? "" : "s"}`,
                      node: (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                              <th className="py-1.5 font-medium">
                                Department
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                SOFA
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                BEDFRAME
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                Total
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                Daily Capacity
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                Backlog Days
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {prod.backlogByDept.map((d) => (
                              <tr
                                key={d.dept}
                                className="border-b border-[#F0ECE6]"
                              >
                                <td className="py-1.5 text-[#1F1D1B]">
                                  {d.dept}
                                </td>
                                <td className="py-1.5 text-right tabular-nums text-[#5A5550]">
                                  {hm(d.sofaMin)}
                                </td>
                                <td className="py-1.5 text-right tabular-nums text-[#5A5550]">
                                  {hm(d.bedframeMin)}
                                </td>
                                <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                                  {hm(d.totalMin)}
                                </td>
                                <td className="py-1.5 text-right tabular-nums text-[#5A5550]">
                                  {hm(d.dailyCapMin)}/day
                                </td>
                                <td className="py-1.5 text-right tabular-nums font-semibold text-[#B45309]">
                                  {d.backlogDays.toLocaleString()}d
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ),
                    })
                : undefined
            }
          />
          <KPICard
            title="Active Jobs"
            value={`${(prod?.activeJobs?.bedframeUnits ?? 0).toLocaleString()} / ${(prod?.activeJobs?.sofaSets ?? 0).toLocaleString()}`}
            subtitle="Pending bedframe units / sofa sets"
            icon={Package}
            onClick={
              prod?.activeJobs
                ? () =>
                    setDrill({
                      title: "Active Jobs — pending by customer",
                      subtitle:
                        "Bedframe = pieces still in production · Sofa = sets (1 SO = 1 set)",
                      node: (
                        <CustomerJobsTable
                          rows={prod.activeJobs.byCustomer}
                        />
                      ),
                    })
                : undefined
            }
          />
          <KPICard
            title="Completed Yesterday"
            value={`${(prod?.completedYesterday?.bedframeUnits ?? 0).toLocaleString()} / ${(prod?.completedYesterday?.sofaSets ?? 0).toLocaleString()}`}
            subtitle="Bedframe units / sofa sets finished yesterday"
            icon={CheckCircle2}
            onClick={
              prod?.completedYesterday
                ? () =>
                    setDrill({
                      title: "Completed Yesterday — by customer",
                      subtitle:
                        "Production finished (last upholstery completed yesterday)",
                      node: (
                        <CustomerJobsTable
                          rows={prod.completedYesterday.byCustomer}
                        />
                      ),
                    })
                : undefined
            }
          />
        </div>
      </div>

      {/* Employees + Purchasing */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-[#6B5C32]" /> Worker Efficiency
              <span className="text-[10px] text-[#9CA3AF] font-normal">
                7-working-day avg
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {efficiency.count === 0 ? (
              <p className="text-xs text-[#9CA3AF]">
                No production activity in the window.
              </p>
            ) : (
              <>
                <div>
                  <p className="text-[11px] font-semibold text-[#15803D] mb-1">
                    Top 5
                  </p>
                  {efficiency.top.map((r, i) => (
                    <div
                      key={`t${i}-${r.name}`}
                      className="flex items-center justify-between text-sm py-0.5"
                    >
                      <span className="text-[#5A5550] truncate pr-2">
                        {r.name}
                      </span>
                      <span className="font-semibold text-[#15803D] tabular-nums">
                        {Math.round(r.pct)}%
                      </span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-[#E2DDD8] pt-2">
                  <p className="text-[11px] font-semibold text-[#DC2626] mb-1">
                    Lowest 5
                  </p>
                  {efficiency.bottom.map((r, i) => (
                    <div
                      key={`b${i}-${r.name}`}
                      className="flex items-center justify-between text-sm py-0.5"
                    >
                      <span className="text-[#5A5550] truncate pr-2">
                        {r.name}
                      </span>
                      <span className="font-semibold text-[#DC2626] tabular-nums">
                        {Math.round(r.pct)}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <p className="text-[10px] text-[#9CA3AF]">
              Production minutes ÷ clocked production hours. {effWin.from} →{" "}
              {effWin.to}.
            </p>
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
            {(ov.monthlyRevenue ?? []).length === 0 ? (
              <p className="text-xs text-[#9CA3AF]">No revenue data.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                    <th className="py-1.5 font-medium">Month</th>
                    <th className="py-1.5 font-medium text-right">
                      Sales Orders
                    </th>
                    <th className="py-1.5 font-medium text-right">
                      Invoices
                    </th>
                    <th className="py-1.5 font-medium text-right">
                      Production
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(ov.monthlyRevenue ?? []).map((r) => (
                    <tr
                      key={r.month}
                      className="border-b border-[#F0ECE6]"
                    >
                      <td className="py-1.5 text-[#5A5550] tabular-nums">
                        {r.month}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                        {rm(r.salesOrderSen)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                        {rm(r.invoiceSen)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                        {rm(r.productionSen)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[10px] text-[#9CA3AF] mt-2">
              Sales Orders = order total by SO date. Invoices = invoiced
              total by invoice date (excl. cancelled). Production = value
              finished, by the month its last upholstery completed (same
              rule as the Employee revenue).
            </p>
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
                <th className="py-1.5 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {(ov.aovByCustomer ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={6}
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
                  <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                    {rm(r.totalSen)}
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
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
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

      {drill && (
        <Modal
          title={drill.title}
          subtitle={drill.subtitle}
          onClose={() => setDrill(null)}
        >
          {drill.node}
        </Modal>
      )}
    </div>
  );
}
