// ===========================================================================
// Dashboard B — experimental "Command" reporting view.
//
// Same data + same numbers as /dashboard (reuses the identical fetches +
// pending-delivery + efficiency computations) and the SAME visual language
// as the rest of the app (light theme, brand brown, app font, white rounded
// cards). The upgrade vs /dashboard is the layout + a real revenue chart,
// not a different skin. Self-contained & disposable: delete this folder,
// the /dashboard-b route line, and the sidebar line to remove it.
// ===========================================================================
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  buildLinkedPOIds,
  poReadyForDelivery,
  type PipelinePO,
} from "@/lib/delivery-pipeline";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  DollarSign,
  Truck,
  Clock,
  Package,
  Factory,
  CheckCircle2,
} from "lucide-react";

// ---------- API response types (mirror /dashboard) ----------
type SoStats = {
  success?: boolean;
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
  topSellers?: {
    BEDFRAME: { productCode: string; qtySold: number; valueSen: number }[];
    SOFA: { model: string; setsSold: number; valueSen: number }[];
  };
  fabric?: {
    BEDFRAME: {
      list: {
        fabCode: string;
        meters: number;
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
        meters: number;
        past30Meters: number;
        next30Meters: number;
        buyAvgSen: number;
        buyMinSen: number;
        buyMaxSen: number;
      }[];
      monthly: { month: string; meters: number }[];
    };
  };
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
  employee?: { activeHeadcount: number };
};
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

// ---------- helpers (same tokens as /dashboard) ----------
const rm = (sen: number | undefined) => formatCurrency(sen ?? 0);
const hrs = (min: number | undefined) =>
  `${Math.round((min ?? 0) / 60).toLocaleString()}h`;
const CUR_YM = new Date().toISOString().slice(0, 7);

// Brand-consistent chart palette (warm, matches the app — no neon).
const C_SO = "#6B5C32"; // brand brown
const C_PROD = "#C9A24B"; // muted gold
const C_INV = "#A8A29A"; // warm grey
const C_GREEN = "#15803D";
const C_RED = "#DC2626";

function Spark({ data, stroke }: { data: number[]; stroke: string }) {
  if (data.length < 2) return null;
  const w = 84;
  const h = 26;
  const max = Math.max(1, ...data);
  const min = Math.min(0, ...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} aria-hidden>
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}

function KTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = C_SO,
  spark,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  accent?: string;
  spark?: number[];
}) {
  return (
    <Card className="relative bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550]">
            {label}
          </p>
          <div className="rounded-lg bg-[#F5F2ED] p-2">
            <Icon className="h-4 w-4 text-[#6B5C32]" />
          </div>
        </div>
        <p className="mt-3 text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B] tabular-nums">
          {value}
        </p>
        <div className="mt-1 flex items-end justify-between">
          <p className="text-xs text-[#9CA3AF]">{sub}</p>
          {spark && spark.length > 1 && (
            <Spark data={spark} stroke={accent} />
          )}
        </div>
      </CardContent>
      <span
        className="absolute inset-x-0 bottom-0 h-[3px]"
        style={{ background: accent, opacity: 0.65 }}
      />
    </Card>
  );
}

function SectionTitle({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <h3 className="text-sm font-bold text-[#1F1D1B] tracking-[-0.2px]">
          {title}
        </h3>
        {sub && <p className="text-xs text-[#9CA3AF] mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function RevTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | string; color?: string }[];
}) {
  if (!props.active || !props.payload?.length) return null;
  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 shadow-md text-xs">
      <div className="font-semibold text-[#5A5550] mb-1">{props.label}</div>
      {props.payload.map((p) => (
        <div
          key={p.name}
          className="flex items-center justify-between gap-5 py-0.5"
        >
          <span style={{ color: p.color }}>● {p.name}</span>
          <span className="font-semibold text-[#1F1D1B] tabular-nums">
            {rm(Number(p.value) * 100)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Light radial gauge — track in brand cream, arc in accent.
function Gauge({
  value,
  big,
  cap,
  accent,
}: {
  value: number;
  big: string;
  cap: string;
  accent: string;
}) {
  const pct = Math.max(0, Math.min(1, value));
  const r = 50;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  return (
    <div className="relative flex items-center justify-center">
      <svg width="150" height="150" viewBox="0 0 150 150">
        <circle
          cx="75"
          cy="75"
          r={r}
          fill="none"
          stroke="#F0ECE6"
          strokeWidth="10"
          strokeDasharray={`${arc} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 75 75)"
        />
        <circle
          cx="75"
          cy="75"
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth="10"
          strokeDasharray={`${arc * pct} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 75 75)"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-2xl font-[800] text-[#1F1D1B] tabular-nums">
          {big}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
          {cap}
        </span>
      </div>
    </div>
  );
}

// ---------- page ----------
export default function DashboardBPage() {
  const [period, setPeriod] = useState("all");
  const { data: soRaw, loading: soL } =
    useCachedJson<SoStats>("/api/sales-orders/stats");
  const { data: ovRaw, loading: ovL } = useCachedJson<Overview>(
    `/api/dashboard/overview?period=${period}`,
  );
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
    soL || ovL || poL || doL || poValL || soItemsL || jcSumL || wheSumL ||
    workersL;

  // Pending Delivery — identical computation to /dashboard.
  const pendingDeliveryValueSen = useMemo(() => {
    const pos = poRaw?.success ? poRaw.data ?? [] : [];
    const dos = doRaw?.success ? doRaw.data ?? [] : [];
    const linkedPOIds = buildLinkedPOIds(dos);
    const poValMap = new Map<string, number>();
    for (const [k, v] of Object.entries(poValRaw?.values ?? {}))
      poValMap.set(k, Number(v) || 0);
    const soPriceByProduct = new Map<string, Map<string, number>>();
    const sos = soItemsRaw?.success ? soItemsRaw.data ?? [] : [];
    for (const s of sos) {
      const m = new Map<string, number>();
      for (const it of s.items ?? [])
        if (it.productCode) m.set(it.productCode, Number(it.unitPriceSen) || 0);
      soPriceByProduct.set(s.id, m);
    }
    let total = 0;
    for (const po of pos) {
      if (!poReadyForDelivery(po, linkedPOIds)) continue;
      total +=
        poValMap.get(po.id) ??
        (soPriceByProduct.get(po.salesOrderId || "")?.get(
          po.productCode || "",
        ) ?? 0) * (po.quantity || 0);
    }
    return total;
  }, [poRaw, doRaw, poValRaw, soItemsRaw]);

  // Worker efficiency — identical computation to /dashboard.
  const efficiency = useMemo(() => {
    const prodMin = new Map<string, number>();
    for (const r of jcSumRaw?.data ?? [])
      prodMin.set(r.workerId, Number(r.productionMinutes) || 0);
    const name = new Map<string, string>();
    const dept = new Map<string, string>();
    for (const w of workersRaw?.data ?? []) {
      name.set(w.id, w.name || w.id);
      dept.set(w.id, DEPT_LABEL[w.departmentCode || ""] ?? w.departmentCode ?? "");
    }
    const rows: { name: string; dept: string; pct: number }[] = [];
    for (const e of wheSumRaw?.data ?? []) {
      if ((e.daysWithEntries ?? 0) === 0) continue;
      let prodHours = 0;
      for (const [d, h] of Object.entries(e.byDept ?? {}))
        if (PROD_DEPTS.has(d)) prodHours += Number(h) || 0;
      if (prodHours <= 0) continue;
      rows.push({
        name: name.get(e.workerId) ?? e.workerId,
        dept: dept.get(e.workerId) ?? "",
        pct: ((prodMin.get(e.workerId) ?? 0) / (prodHours * 60)) * 100,
      });
    }
    rows.sort((a, b) => b.pct - a.pct);
    return { top: rows.slice(0, 5), bottom: rows.slice(-5).reverse() };
  }, [jcSumRaw, wheSumRaw, workersRaw]);

  const so = soRaw ?? {};
  const ov = ovRaw ?? {};
  const prod = ov.production;
  const pur = ov.purchasing;
  const fc = ov.fabricCostPerMeterSen;
  const months = ov.salesMonths ?? [];

  const rev = useMemo(() => ov.monthlyRevenue ?? [], [ov.monthlyRevenue]);
  const revChart = useMemo(
    () =>
      rev.map((r) => ({
        m: r.month.slice(2),
        "Sales Orders": Math.round(r.salesOrderSen / 100),
        Invoices: Math.round(r.invoiceSen / 100),
        Production: Math.round(r.productionSen / 100),
      })),
    [rev],
  );
  const soSpark = useMemo(() => rev.map((r) => r.salesOrderSen), [rev]);
  const delSpark = useMemo(() => rev.map((r) => r.productionSen), [rev]);

  const delivered = so.deliveredItemsSen ?? 0;
  const outstanding = so.outstandingItemsSen ?? 0;
  const confirmed = so.csRevenueSen ?? delivered + outstanding;
  const pipeMax = Math.max(1, confirmed, delivered, outstanding);
  const backlogDays = prod?.backlogDays ?? 0;
  const util = Math.min(1, backlogDays / 14);
  const gaugeAccent = backlogDays > 12 ? C_RED : backlogDays > 7 ? C_PROD : C_GREEN;

  const aov = (ov.aovByCustomer ?? []).slice(0, 8);
  const aovMax = Math.max(1, ...aov.map((a) => a.totalSen));
  const topBed = ov.topSellers?.BEDFRAME ?? [];
  const topSofa = ov.topSellers?.SOFA ?? [];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-xs text-[#6B7280]">Loading Dashboard B…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#6B5C32]">
            Operations Intelligence
          </p>
          <h1 className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B] mt-1">
            Command Center
          </h1>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="text-xs rounded-md border border-[#E2DDD8] bg-[#F5F2ED] px-2.5 py-1.5 font-medium text-[#5A5550] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
        >
          <option value="all">All-time</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m === CUR_YM ? `This month (${m})` : m}
            </option>
          ))}
        </select>
      </div>

      {/* KPI rail */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <KTile
          label="This-Month Sales"
          value={rm(ov.salesThisMonthSen)}
          sub="confirmed SO · current month"
          icon={DollarSign}
          accent={C_SO}
          spark={soSpark}
        />
        <KTile
          label="This-Month Delivered"
          value={rm(ov.deliveredThisMonthSen)}
          sub="item-level shipped value"
          icon={Truck}
          accent={C_PROD}
          spark={delSpark}
        />
        <KTile
          label="Outstanding"
          value={rm(outstanding)}
          sub="confirmed · not yet delivered"
          icon={Clock}
          accent={C_INV}
        />
        <KTile
          label="Pending Delivery"
          value={rm(pendingDeliveryValueSen)}
          sub="made, not yet on a DO"
          icon={Package}
          accent={C_GREEN}
        />
        <KTile
          label="Daily Capacity"
          value={hrs(prod?.dailyCapacityMin)}
          sub="7-working-day actual avg"
          icon={Factory}
          accent={C_SO}
        />
        <KTile
          label="Backlog"
          value={`${backlogDays.toLocaleString()} days`}
          sub={`${hrs(prod?.backlogMin)} queued`}
          icon={Clock}
          accent={C_RED}
        />
        <KTile
          label="Active Jobs"
          value={`${(prod?.activeJobs?.bedframeUnits ?? 0).toLocaleString()} / ${(prod?.activeJobs?.sofaSets ?? 0).toLocaleString()}`}
          sub="pending bedframe / sofa sets"
          icon={Package}
          accent={C_PROD}
        />
        <KTile
          label="Completed Yesterday"
          value={`${(prod?.completedYesterday?.bedframeUnits ?? 0).toLocaleString()} / ${(prod?.completedYesterday?.sofaSets ?? 0).toLocaleString()}`}
          sub="bedframe / sofa finished"
          icon={CheckCircle2}
          accent={C_GREEN}
        />
      </div>

      {/* Revenue + Plant load */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Revenue — last 12 months"
              sub="Sales Orders · Invoices · Production"
              right={
                <div className="flex gap-3 text-xs text-[#9CA3AF]">
                  <span style={{ color: C_SO }}>● Sales Orders</span>
                  <span style={{ color: C_PROD }}>● Production</span>
                  <span style={{ color: C_INV }}>● Invoices</span>
                </div>
              }
            />
            <div style={{ width: "100%", height: 260 }}>
              {revChart.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-[#9CA3AF]">
                  No revenue data.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={revChart}
                    margin={{ top: 6, right: 6, bottom: 0, left: 0 }}
                  >
                    <defs>
                      <linearGradient id="bSO" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C_SO} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={C_SO} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="bPR" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C_PROD} stopOpacity={0.2} />
                        <stop offset="100%" stopColor={C_PROD} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="m"
                      tick={{ fill: "#9CA3AF", fontSize: 11 }}
                      axisLine={{ stroke: "#F0ECE6" }}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                      tick={{ fill: "#9CA3AF", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={38}
                    />
                    <Tooltip
                      content={<RevTooltip />}
                      cursor={{ stroke: "#E2DDD8" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="Sales Orders"
                      stroke={C_SO}
                      strokeWidth={2}
                      fill="url(#bSO)"
                      isAnimationActive={false}
                      dot={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="Production"
                      stroke={C_PROD}
                      strokeWidth={2}
                      fill="url(#bPR)"
                      isAnimationActive={false}
                      dot={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="Invoices"
                      stroke={C_INV}
                      strokeWidth={1.75}
                      fill="none"
                      strokeDasharray="4 3"
                      isAnimationActive={false}
                      dot={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5 flex flex-col items-center">
            <SectionTitle title="Plant Load" sub="backlog vs daily capacity" />
            <Gauge
              value={util}
              big={`${backlogDays.toLocaleString()}d`}
              cap="queue"
              accent={gaugeAccent}
            />
            <div className="mt-3 flex gap-8 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Daily cap
                </p>
                <p className="text-base font-bold text-[#1F1D1B]">
                  {hrs(prod?.dailyCapacityMin)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Workforce
                </p>
                <p className="text-base font-bold text-[#1F1D1B]">
                  {ov.employee?.activeHeadcount ?? 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pipeline + Worker efficiency */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Order Pipeline"
              sub="confirmed → outstanding → delivered"
            />
            {[
              { k: "Confirmed", v: confirmed, c: C_SO },
              { k: "Outstanding", v: outstanding, c: C_PROD },
              { k: "Delivered", v: delivered, c: C_GREEN },
            ].map((s) => (
              <div key={s.k} className="flex items-center gap-3 py-1.5">
                <span className="w-24 text-xs text-[#5A5550]">{s.k}</span>
                <div className="flex-1 h-3 rounded-full bg-[#F5F2ED] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(3, (s.v / pipeMax) * 100)}%`,
                      background: s.c,
                    }}
                  />
                </div>
                <span className="w-24 text-right text-xs font-semibold text-[#1F1D1B] tabular-nums">
                  {rm(s.v)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Worker Efficiency"
              sub="production mins ÷ clocked hours · last 7 working days"
            />
            <div className="grid grid-cols-2 gap-5">
              <div>
                <p className="text-[11px] font-semibold text-[#15803D] mb-1.5">
                  Top 5
                </p>
                {efficiency.top.map((r) => (
                  <div
                    key={`t-${r.name}`}
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
              <div className="border-l border-[#F0ECE6] pl-5">
                <p className="text-[11px] font-semibold text-[#DC2626] mb-1.5">
                  Lowest 5
                </p>
                {efficiency.bottom.map((r) => (
                  <div
                    key={`b-${r.name}`}
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
            </div>
          </CardContent>
        </Card>
      </div>

      {/* AOV + Top sellers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Customer Value"
              sub="total value · bedframe & sofa AOV"
              right={
                ov.aovCompany ? (
                  <div className="text-right text-[11px] text-[#9CA3AF]">
                    <div>
                      All BF{" "}
                      <span className="font-semibold text-[#1F1D1B]">
                        {rm(ov.aovCompany.bedframeAvgSen)}
                      </span>
                      /u
                    </div>
                    <div>
                      All Sofa{" "}
                      <span className="font-semibold text-[#1F1D1B]">
                        {rm(ov.aovCompany.sofaAvgSen)}
                      </span>
                      /set
                    </div>
                  </div>
                ) : undefined
              }
            />
            {aov.map((a, i) => (
              <div
                key={a.customerName}
                className="flex items-center gap-3 py-1"
              >
                <span className="w-5 text-xs font-semibold text-[#6B5C32] tabular-nums">
                  {i + 1}
                </span>
                <span className="w-28 text-xs text-[#1F1D1B] truncate">
                  {a.customerName}
                </span>
                <div className="flex-1 h-2 rounded-full bg-[#F5F2ED] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(a.totalSen / aovMax) * 100}%`,
                      background: C_SO,
                    }}
                  />
                </div>
                <span className="w-24 text-right text-xs font-semibold text-[#1F1D1B] tabular-nums">
                  {rm(a.totalSen)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Top Sellers"
              sub="bedframe by units · sofa by sets"
            />
            <div className="grid grid-cols-2 gap-5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550] mb-1.5">
                  Bedframe
                </p>
                {topBed.slice(0, 6).map((p) => (
                  <div
                    key={p.productCode}
                    className="flex items-center justify-between text-sm py-0.5"
                  >
                    <span className="text-[#5A5550] truncate pr-2">
                      <span className="font-medium text-[#1F1D1B]">
                        {p.productCode}
                      </span>{" "}
                      <span className="text-xs text-[#9CA3AF]">
                        ×{p.qtySold}
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-[#1F1D1B] tabular-nums">
                      {rm(p.valueSen)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="border-l border-[#F0ECE6] pl-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550] mb-1.5">
                  Sofa
                </p>
                {topSofa.slice(0, 6).map((p) => (
                  <div
                    key={p.model}
                    className="flex items-center justify-between text-sm py-0.5"
                  >
                    <span className="text-[#5A5550] truncate pr-2">
                      <span className="font-medium text-[#1F1D1B]">
                        {p.model}
                      </span>{" "}
                      <span className="text-xs text-[#9CA3AF]">
                        ×{p.setsSold} sets
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-[#1F1D1B] tabular-nums">
                      {rm(p.valueSen)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Fabric */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(["BEDFRAME", "SOFA"] as const).map((cat) => {
          const blk = ov.fabric?.[cat];
          const rows = (blk?.list ?? [])
            .filter((f) => f.meters > 0 || f.next30Meters > 0)
            .sort((a, b) => b.meters - a.meters)
            .slice(0, 10);
          const mMax = Math.max(
            1,
            ...(blk?.monthly ?? []).map((m) => m.meters),
          );
          return (
            <Card
              key={cat}
              className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
            >
              <CardContent className="p-5">
                <SectionTitle
                  title={`${cat === "BEDFRAME" ? "Bedframe" : "Sofa"} Fabric`}
                  sub="used · purchase price /m · forecast"
                  right={
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                        Avg cost /m
                      </p>
                      <p className="text-sm font-bold text-[#1F1D1B]">
                        {rm(cat === "BEDFRAME" ? fc?.bedframe : fc?.sofa)}
                      </p>
                    </div>
                  }
                />
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] text-[#9CA3AF] border-b border-[#F0ECE6]">
                      <th className="font-medium pb-1.5">Fabric</th>
                      <th className="font-medium pb-1.5 text-right">Used</th>
                      <th className="font-medium pb-1.5 text-right">Next 30d</th>
                      <th className="font-medium pb-1.5 text-right">Avg buy</th>
                      <th className="font-medium pb-1.5 text-right">Min–Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((f) => (
                      <tr key={f.fabCode} className="border-b border-[#F7F4EF]">
                        <td className="py-1 font-medium text-[#1F1D1B]">
                          {f.fabCode}
                        </td>
                        <td className="py-1 text-right tabular-nums text-[#5A5550]">
                          {Math.round(f.meters).toLocaleString()} m
                        </td>
                        <td className="py-1 text-right tabular-nums font-semibold text-[#6B5C32]">
                          {f.next30Meters.toLocaleString()} m
                        </td>
                        <td className="py-1 text-right tabular-nums text-[#1F1D1B]">
                          {f.buyAvgSen ? rm(f.buyAvgSen) : "—"}
                        </td>
                        <td className="py-1 text-right tabular-nums text-[#9CA3AF]">
                          {f.buyMinSen || f.buyMaxSen
                            ? `${rm(f.buyMinSen)}–${rm(f.buyMaxSen)}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 border-t border-[#F0ECE6] pt-2 space-y-1">
                  <p className="text-[11px] font-semibold text-[#5A5550] mb-1">
                    Monthly meters
                  </p>
                  {(blk?.monthly ?? []).map((m) => (
                    <div key={m.month} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-[11px] text-[#9CA3AF] tabular-nums">
                        {m.month}
                      </span>
                      <div className="flex-1 h-2.5 rounded bg-[#F5F2ED] overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${Math.max(2, (m.meters / mMax) * 100)}%`,
                            background: C_SO,
                            opacity: 0.7,
                          }}
                        />
                      </div>
                      <span className="w-16 text-right text-[11px] font-semibold text-[#1F1D1B] tabular-nums">
                        {Math.round(m.meters).toLocaleString()} m
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Department backlog + Purchasing */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Department Backlog"
              sub="active work vs daily capacity — bottleneck first"
              right={
                <div className="flex gap-3 text-xs text-[#9CA3AF]">
                  <span style={{ color: C_INV }}>● Sofa</span>
                  <span style={{ color: C_SO }}>● Bedframe</span>
                </div>
              }
            />
            {(prod?.backlogByDept ?? []).map((d) => {
              const mx = Math.max(
                1,
                ...(prod?.backlogByDept ?? []).map((x) => x.totalMin),
              );
              return (
                <div key={d.dept} className="flex items-center gap-3 py-1">
                  <span className="w-28 text-xs text-[#1F1D1B]">{d.dept}</span>
                  <div className="flex-1 h-2.5 rounded bg-[#F5F2ED] overflow-hidden flex">
                    <div
                      className="h-full"
                      style={{
                        width: `${(d.sofaMin / mx) * 100}%`,
                        background: C_INV,
                      }}
                    />
                    <div
                      className="h-full"
                      style={{
                        width: `${(d.bedframeMin / mx) * 100}%`,
                        background: C_SO,
                      }}
                    />
                  </div>
                  <span className="w-12 text-right text-xs font-semibold text-[#DC2626] tabular-nums">
                    {d.backlogDays.toLocaleString()}d
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle title="Purchasing" sub="open POs · spend" />
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Open POs
                </p>
                <p className="text-lg font-bold text-[#1F1D1B]">
                  {pur?.openPOCount ?? 0}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Spend / month
                </p>
                <p className="text-lg font-bold text-[#1F1D1B]">
                  {rm(pur?.spendThisMonthSen)}
                </p>
              </div>
            </div>
            <p className="text-[11px] font-semibold text-[#5A5550] mb-1">
              Top suppliers
            </p>
            {(pur?.topSuppliers ?? []).slice(0, 5).map((s) => (
              <div
                key={s.name}
                className="flex items-center justify-between text-xs py-0.5"
              >
                <span className="text-[#5A5550] truncate pr-2">{s.name}</span>
                <span className="font-semibold text-[#1F1D1B] tabular-nums">
                  {rm(s.spendSen)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <p className="text-center text-[11px] text-[#9CA3AF] pt-2">
        Dashboard B · experimental view · full data parity with Dashboard
      </p>
    </div>
  );
}
