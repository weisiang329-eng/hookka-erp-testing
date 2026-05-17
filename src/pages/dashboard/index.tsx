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
  period?: string;
  salesMonths?: string[];
  salesThisMonthSen?: number;
  deliveredThisMonthSen?: number;
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    activeJobs: JobsBreakdown;
    completedYesterday: JobsBreakdown;
    completedLast7: { date: string; bedframeUnits: number; sofaSets: number }[];
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
  fabricCostPerMeterSen?: {
    total: number;
    exclBedframeSofa: number;
    bedframe: number;
    sofa: number;
  };
  aovByCustomer?: {
    customerName: string;
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  }[];
  aovCompany?: {
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  };
  aovMonthlyByCustomer?: Record<
    string,
    {
      month: string;
      bedframeAvgSen: number;
      bedframeUnits: number;
      sofaAvgSen: number;
      sofaSets: number;
    }[]
  >;
  topSellers?: {
    BEDFRAME: { productCode: string; productName: string; qtySold: number; valueSen: number }[];
    SOFA: { model: string; setsSold: number; valueSen: number }[];
  };
  topSellersByCustomer?: {
    BEDFRAME: Record<
      string,
      { customer: string; qty: number; valueSen: number }[]
    >;
    SOFA: Record<
      string,
      { customer: string; sets: number; valueSen: number }[]
    >;
  };
  fabric?: {
    BEDFRAME: {
      list: {
        fabCode: string;
        fabName: string;
        meters: number;
        costSen: number;
        past30Meters: number;
        next30Meters: number;
        buyAvgSen: number;
        buyMinSen: number;
        buyMaxSen: number;
      }[];
      monthly: { month: string; meters: number }[];
    };
    SOFA: {
      list: {
        fabCode: string;
        fabName: string;
        meters: number;
        costSen: number;
        past30Meters: number;
        next30Meters: number;
        buyAvgSen: number;
        buyMinSen: number;
        buyMaxSen: number;
      }[];
      monthly: { month: string; meters: number }[];
    };
  };
  monthlySales?: { month: string; bedframeUnits: number; sofaSets: number }[];
  monthlySalesByCustomer?: Record<
    string,
    { customer: string; bedframeUnits: number; sofaSets: number }[]
  >;
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
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
const DEPT_LABEL: Record<string, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  WOOD_CUT: "Wood Cutting",
  FOAM: "Foam Bonding",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

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
// Roll a monthly [{month:"YYYY-MM",meters}] series up into quarters
// ("YYYY-Qn"), summing meters. Keeps the last 8 quarters.
function toQuarterly(
  monthly: { month: string; meters: number }[],
): { label: string; meters: number }[] {
  const q = new Map<string, number>();
  for (const m of monthly) {
    const [y, mm] = m.month.split("-");
    const qn = Math.ceil((Number(mm) || 1) / 3);
    const key = `${y}-Q${qn}`;
    q.set(key, (q.get(key) ?? 0) + m.meters);
  }
  return [...q.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-8)
    .map(([label, meters]) => ({ label, meters }));
}

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

// Sales period selector: All-time / This month / a specific past month.
const CUR_YM = new Date().toISOString().slice(0, 7);
function periodLabel(p: string): string {
  if (p === "all") return "All-time";
  if (p === CUR_YM) return `This month (${p})`;
  return p;
}
function PeriodSelector({
  value,
  months,
  onChange,
}: {
  value: string;
  months: string[];
  onChange: (v: string) => void;
}) {
  // "all" + every month present (current month shown as "This month").
  const opts = ["all", ...months];
  if (!months.includes(CUR_YM)) opts.splice(1, 0, CUR_YM);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs rounded-md border border-[#E2DDD8] bg-[#F5F2ED] px-2.5 py-1 font-medium text-[#5A5550] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {periodLabel(o)}
        </option>
      ))}
    </select>
  );
}

// ---------- Dashboard ----------

export default function DashboardPage() {
  // Sales period filter ("all" or "YYYY-MM") — drives the overview
  // fetch so AOV / Monthly / Top Sellers reflect the chosen period.
  const [salesPeriod, setSalesPeriod] = useState<string>("all");
  const { data: soRaw, loading: soL } =
    useCachedJson<SoStats>("/api/sales-orders/stats");
  const { data: ovRaw, loading: ovL } = useCachedJson<Overview>(
    `/api/dashboard/overview?period=${salesPeriod}`,
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
    const dept = new Map<string, string>();
    for (const w of workersRaw?.data ?? []) {
      name.set(w.id, w.name || w.id);
      const code = w.departmentCode || "";
      dept.set(w.id, DEPT_LABEL[code] ?? code ?? "");
    }
    const rows: { name: string; dept: string; pct: number }[] = [];
    for (const e of wheSumRaw?.data ?? []) {
      if ((e.daysWithEntries ?? 0) === 0) continue;
      let prodHours = 0;
      for (const [d, h] of Object.entries(e.byDept ?? {}))
        if (PROD_DEPTS.has(d)) prodHours += Number(h) || 0;
      if (prodHours <= 0) continue;
      const mins = prodMin.get(e.workerId) ?? 0;
      const pct = (mins / (prodHours * 60)) * 100;
      rows.push({
        name: name.get(e.workerId) ?? e.workerId,
        dept: dept.get(e.workerId) ?? "",
        pct,
      });
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
  // Fabric trend granularity toggle (Monthly ↔ Quarterly).
  const [fabGran, setFabGran] = useState<"month" | "quarter">("month");
  // Fabric table mode: Previous (rank by past usage) / Next (rank by
  // next-30 forecast — surfaces upcoming fabrics not used historically).
  const [fabMode, setFabMode] = useState<"prev" | "next">("prev");

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
              prod?.completedLast7
                ? () =>
                    setDrill({
                      title: "Completed — last 7 days",
                      subtitle:
                        "Production finished per day (last upholstery completed). Bedframe = units, Sofa = sets.",
                      node: (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                              <th className="py-1.5 font-medium">Date</th>
                              <th className="py-1.5 font-medium text-right">
                                Bedframe units
                              </th>
                              <th className="py-1.5 font-medium text-right">
                                Sofa sets
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {prod.completedLast7.map((d) => (
                              <tr
                                key={d.date}
                                className="border-b border-[#F0ECE6]"
                              >
                                <td className="py-1.5 text-[#1F1D1B] tabular-nums">
                                  {d.date}
                                </td>
                                <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                                  {d.bedframeUnits.toLocaleString()}
                                </td>
                                <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                                  {d.sofaSets.toLocaleString()}
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
                      <span className="truncate pr-2">
                        <span className="text-[#5A5550]">{r.name}</span>
                        {r.dept && (
                          <span className="text-[10px] text-[#9CA3AF]">
                            {" "}
                            · {r.dept}
                          </span>
                        )}
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
                      <span className="truncate pr-2">
                        <span className="text-[#5A5550]">{r.name}</span>
                        {r.dept && (
                          <span className="text-[10px] text-[#9CA3AF]">
                            {" "}
                            · {r.dept}
                          </span>
                        )}
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

      {/* Monthly revenue trend */}
      <div>
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
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

      {/* Sales by Customer & Month (merged module) */}
      <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">
              Sales by Customer &amp; Month
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[#9CA3AF] uppercase tracking-wider">
                Period
              </span>
              <PeriodSelector
                value={salesPeriod}
                months={ov.salesMonths ?? []}
                onChange={setSalesPeriod}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <p className="text-[11px] font-semibold text-[#5A5550] uppercase tracking-wider mb-2">
                Avg Order Value — Bedframe (per unit) vs Sofa (per set)
              </p>
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
              {ov.aovCompany && (ov.aovByCustomer ?? []).length > 0 && (
                <tr className="border-b-2 border-[#E2DDD8] bg-[#FAF8F4]">
                  <td className="py-1.5 font-bold text-[#1F1D1B]">
                    All customers
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-semibold">
                    {ov.aovCompany.bedframeUnits
                      ? rm(ov.aovCompany.bedframeAvgSen)
                      : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                    {ov.aovCompany.bedframeUnits || "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-semibold">
                    {ov.aovCompany.sofaSets
                      ? rm(ov.aovCompany.sofaAvgSen)
                      : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                    {ov.aovCompany.sofaSets || "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-bold text-[#1F1D1B]">
                    {rm(ov.aovCompany.totalSen)}
                  </td>
                </tr>
              )}
              {(ov.aovByCustomer ?? []).map((r) => {
                const monthly = ov.aovMonthlyByCustomer?.[r.customerName];
                return (
                  <tr
                    key={r.customerName}
                    onClick={
                      monthly && monthly.length
                        ? () =>
                            setDrill({
                              title: `${r.customerName} — monthly AOV`,
                              subtitle:
                                "Average per month, by SO date. Bedframe per unit · Sofa per set.",
                              node: (
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                                      <th className="py-1.5 font-medium">
                                        Month
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Bedframe AOV
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Units
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Sofa AOV
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Sets
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {monthly.map((m) => (
                                      <tr
                                        key={m.month}
                                        className="border-b border-[#F0ECE6]"
                                      >
                                        <td className="py-1.5 text-[#1F1D1B] tabular-nums">
                                          {m.month}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {m.bedframeUnits
                                            ? rm(m.bedframeAvgSen)
                                            : "—"}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                                          {m.bedframeUnits || "—"}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {m.sofaSets
                                            ? rm(m.sofaAvgSen)
                                            : "—"}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums text-[#9CA3AF]">
                                          {m.sofaSets || "—"}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ),
                            })
                        : undefined
                    }
                    className={`border-b border-[#F0ECE6] ${monthly && monthly.length ? "cursor-pointer hover:bg-[#FAF8F4]" : ""}`}
                  >
                    <td className="py-1.5 text-[#1F1D1B]">
                      {r.customerName}
                      {monthly && monthly.length ? (
                        <span className="text-[10px] text-[#9CA3AF]">
                          {" "}
                          · monthly
                        </span>
                      ) : null}
                    </td>
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
                );
              })}
            </tbody>
          </table>
              <p className="text-[10px] text-[#9CA3AF] mt-2">
                Bedframe AOV = total bedframe value ÷ total bedframe units.
                Sofa AOV = total Sales-Order value ÷ number of sofa sets (1
                SO = 1 set). Click a customer for the monthly breakdown.
              </p>
            </div>
            <div className="lg:col-span-1 lg:border-l lg:border-[#E2DDD8] lg:pl-6">
              <p className="text-[11px] font-semibold text-[#5A5550] uppercase tracking-wider mb-2">
                Monthly — Bedframe Units &amp; Sofa Sets
              </p>
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
                  {(ov.monthlySales ?? []).map((m) => {
                    const rows =
                      ov.monthlySalesByCustomer?.[m.month] ?? [];
                    return (
                      <tr
                        key={m.month}
                        onClick={
                          rows.length
                            ? () =>
                                setDrill({
                                  title: `${m.month} — by customer`,
                                  subtitle:
                                    "Who contributed this month's bedframe units / sofa sets",
                                  node: <CustomerJobsTable rows={rows} />,
                                })
                            : undefined
                        }
                        className={`border-b border-[#F0ECE6] ${rows.length ? "cursor-pointer hover:bg-[#FAF8F4]" : ""}`}
                      >
                        <td className="py-1.5 text-[#5A5550] tabular-nums">
                          {m.month}
                          {rows.length ? (
                            <span className="text-[10px] text-[#9CA3AF]">
                              {" "}
                              · who
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                          {m.bedframeUnits.toLocaleString()}
                        </td>
                        <td className="py-1.5 text-right tabular-nums font-semibold text-[#1F1D1B]">
                          {m.sofaSets.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
              <p className="text-[10px] text-[#9CA3AF] mt-2">
                By SO date. Bedframe = pieces sold; Sofa = sets (1 SO = 1
                set). Click a month for the customer breakdown.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Fabric — Bedframe vs Sofa (one module: top fabrics + monthly) */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-bold text-[#5A5550] uppercase tracking-wider">
            Fabric Usage — Bedframe vs Sofa
          </h2>
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1">
              {(["prev", "next"] as const).map((mderef) => (
                <button
                  key={mderef}
                  onClick={() => setFabMode(mderef)}
                  className={`px-2.5 py-1 rounded-md font-medium ${
                    fabMode === mderef
                      ? "bg-[#6B5C32] text-white"
                      : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
                  }`}
                >
                  {mderef === "prev" ? "Previous" : "Next"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {(["month", "quarter"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setFabGran(g)}
                  className={`px-2.5 py-1 rounded-md font-medium ${
                    fabGran === g
                      ? "bg-[#6B5C32] text-white"
                      : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
                  }`}
                >
                  {g === "month" ? "Monthly" : "Quarterly"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] mb-4">
          <CardContent className="py-4 flex flex-wrap items-center gap-x-10 gap-y-3">
            <div className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-[#6B5C32]" />
              <span className="text-xs font-semibold text-[#5A5550]">
                Fabric Cost / Meter
              </span>
            </div>
            <div>
              <p className="text-[11px] text-[#9CA3AF]">Overall (all issued)</p>
              <p className="text-xl font-bold text-[#1F1D1B]">
                {rm(fab?.total)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-[#9CA3AF]">
                Excl. Bedframe &amp; Sofa
              </p>
              <p className="text-xl font-bold text-[#1F1D1B]">
                {rm(fab?.exclBedframeSofa)}
              </p>
            </div>
            <p className="text-[10px] text-[#9CA3AF] max-w-[16rem]">
              Weighted avg of fabric actually issued to production
              (consumption).
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          {(["BEDFRAME", "SOFA"] as const).map((cat) => {
            const blk = ov.fabric?.[cat];
            const trend =
              fabGran === "quarter"
                ? toQuarterly(blk?.monthly ?? [])
                : (blk?.monthly ?? []).map((m) => ({
                    label: m.month,
                    meters: m.meters,
                  }));
            const monthMax = Math.max(1, ...trend.map((t) => t.meters));
            // Show 10 colourways for both Bedframe and Sofa.
            const fabLimit = 10;
            const fabRows =
              fabMode === "next"
                ? (blk?.list ?? [])
                    .filter((f) => f.next30Meters > 0)
                    .sort((a, b) => b.next30Meters - a.next30Meters)
                    .slice(0, fabLimit)
                : (blk?.list ?? [])
                    .filter((f) => f.meters > 0)
                    .sort((a, b) => b.meters - a.meters)
                    .slice(0, fabLimit);
            return (
              <Card
                key={cat}
                className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Scissors className="h-4 w-4 text-[#6B5C32]" />{" "}
                      {cat === "BEDFRAME" ? "Bedframe" : "Sofa"} Fabric
                    </CardTitle>
                    <div className="text-right">
                      <p className="text-[10px] text-[#9CA3AF] uppercase tracking-wider">
                        Avg cost /m
                      </p>
                      <p className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                        {rm(
                          cat === "BEDFRAME"
                            ? fab?.bedframe
                            : fab?.sofa,
                        )}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <p className="text-[11px] font-semibold text-[#5A5550] mb-1">
                      {fabMode === "next"
                        ? "Forecast — fabric needed next 30 days"
                        : "Top fabrics — used (history) & purchase price /m"}
                    </p>
                    {fabRows.length === 0 ? (
                      <p className="text-xs text-[#9CA3AF]">
                        {fabMode === "next"
                          ? "No upcoming fabric demand."
                          : "No fabric issued."}
                      </p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-[10px] text-[#9CA3AF]">
                            <th className="font-medium pb-1">Fabric</th>
                            <th className="font-medium pb-1 text-right">
                              {fabMode === "next" ? "Next 30d" : "Used"}
                            </th>
                            <th className="font-medium pb-1 text-right">
                              {fabMode === "next" ? "Past 30d" : "Past 30d"}
                            </th>
                            <th className="font-medium pb-1 text-right">
                              Avg buy
                            </th>
                            <th className="font-medium pb-1 text-right">
                              Min–Max
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {fabRows.map((f) => (
                            <tr key={f.fabCode}>
                              <td className="py-0.5 font-medium text-[#1F1D1B]">
                                {f.fabCode}
                              </td>
                              <td
                                className={`py-0.5 text-right tabular-nums font-semibold ${fabMode === "next" ? "text-[#6B5C32]" : "text-[#1F1D1B]"}`}
                              >
                                {fabMode === "next"
                                  ? `${f.next30Meters.toLocaleString()} m`
                                  : `${Math.round(f.meters).toLocaleString()} m`}
                              </td>
                              <td className="py-0.5 text-right tabular-nums text-[#5A5550]">
                                {fabMode === "next"
                                  ? `${f.past30Meters.toLocaleString()} m`
                                  : `${f.past30Meters.toLocaleString()} m`}
                              </td>
                              <td className="py-0.5 text-right tabular-nums text-[#1F1D1B]">
                                {f.buyAvgSen ? rm(f.buyAvgSen) : "—"}
                              </td>
                              <td className="py-0.5 text-right tabular-nums text-[#9CA3AF]">
                                {f.buyMinSen || f.buyMaxSen
                                  ? `${rm(f.buyMinSen)}–${rm(f.buyMaxSen)}`
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <p className="text-[10px] text-[#9CA3AF] mt-1">
                      {fabMode === "next"
                        ? "Forecast from Fabric Cutting jobs due ≤ 30 days (BOM). Ranked by next-30 demand."
                        : "Used = actual issued (history). Ranked by usage. Buy = purchase price /m."}
                    </p>
                  </div>
                  <div className="border-t border-[#E2DDD8] pt-2">
                    <p className="text-[11px] font-semibold text-[#5A5550] mb-1">
                      {fabGran === "quarter"
                        ? "Quarterly meters — last 8"
                        : "Monthly meters — last 12"}
                    </p>
                    {trend.length === 0 ? (
                      <p className="text-xs text-[#9CA3AF]">No data.</p>
                    ) : (
                      <div className="space-y-1">
                        {trend.map((m) => (
                          <div
                            key={m.label}
                            className="flex items-center gap-2"
                          >
                            <span className="text-[11px] text-[#9CA3AF] w-14 shrink-0 tabular-nums">
                              {m.label}
                            </span>
                            <div className="flex-1 bg-[#F5F2ED] rounded h-3 overflow-hidden">
                              <div
                                className="h-full bg-[#6B5C32]/70 rounded"
                                style={{
                                  width: `${Math.max(2, (m.meters / monthMax) * 100)}%`,
                                }}
                              />
                            </div>
                            <span className="text-[11px] font-semibold text-[#1F1D1B] w-16 text-right tabular-nums">
                              {Math.round(m.meters).toLocaleString()} m
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-[#9CA3AF]">
                    Fabric issued to {cat === "BEDFRAME" ? "bedframe" : "sofa"}{" "}
                    production (RM_ISSUE).
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Top sellers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-bold text-[#5A5550] uppercase tracking-wider">
            Top Sellers
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#9CA3AF] uppercase tracking-wider">
              Period
            </span>
            <PeriodSelector
              value={salesPeriod}
              months={ov.salesMonths ?? []}
              onChange={setSalesPeriod}
            />
          </div>
        </div>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
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
              {(ov.topSellers?.BEDFRAME ?? []).map((p) => {
                const custRows =
                  ov.topSellersByCustomer?.BEDFRAME?.[p.productCode] ?? [];
                return (
                  <div
                    key={p.productCode}
                    onClick={
                      custRows.length
                        ? () =>
                            setDrill({
                              title: `${p.productCode} — by customer`,
                              subtitle: `${p.qtySold.toLocaleString()} units · ${rm(p.valueSen)}`,
                              node: (
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                                      <th className="py-1.5 font-medium">
                                        Customer
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Units
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Value
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {custRows.map((c) => (
                                      <tr
                                        key={c.customer}
                                        className="border-b border-[#F0ECE6]"
                                      >
                                        <td className="py-1.5 text-[#1F1D1B]">
                                          {c.customer}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {c.qty.toLocaleString()}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {rm(c.valueSen)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ),
                            })
                        : undefined
                    }
                    className={`flex items-center justify-between text-sm ${custRows.length ? "cursor-pointer hover:bg-[#FAF8F4] -mx-1 px-1 rounded" : ""}`}
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
                );
              })}
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
              {(ov.topSellers?.SOFA ?? []).map((p) => {
                const custRows =
                  ov.topSellersByCustomer?.SOFA?.[p.model] ?? [];
                return (
                  <div
                    key={p.model}
                    onClick={
                      custRows.length
                        ? () =>
                            setDrill({
                              title: `Sofa ${p.model} — by customer`,
                              subtitle: `${p.setsSold.toLocaleString()} sets · ${rm(p.valueSen)}`,
                              node: (
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
                                      <th className="py-1.5 font-medium">
                                        Customer
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Sets
                                      </th>
                                      <th className="py-1.5 font-medium text-right">
                                        Value
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {custRows.map((c) => (
                                      <tr
                                        key={c.customer}
                                        className="border-b border-[#F0ECE6]"
                                      >
                                        <td className="py-1.5 text-[#1F1D1B]">
                                          {c.customer}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {c.sets.toLocaleString()}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {rm(c.valueSen)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ),
                            })
                        : undefined
                    }
                    className={`flex items-center justify-between text-sm ${custRows.length ? "cursor-pointer hover:bg-[#FAF8F4] -mx-1 px-1 rounded" : ""}`}
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
                );
              })}
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
