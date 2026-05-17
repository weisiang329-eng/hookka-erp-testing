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
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  DollarSign,
  Truck,
  Clock,
  Package,
  Factory,
  CheckCircle2,
  X,
  ArrowUpRight,
  ArrowDownRight,
  Scissors,
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
    BEDFRAME: { productCode: string; qtySold: number; valueSen: number }[];
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
  monthlySalesByCustomer?: Record<
    string,
    { customer: string; bedframeUnits: number; sofaSets: number }[]
  >;
  monthlySales?: { month: string; bedframeUnits: number; sofaSets: number }[];
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
const hm = (min: number | undefined) => {
  const m = Math.max(0, Math.round(min ?? 0));
  return `${Math.floor(m / 60).toLocaleString()}h ${m % 60}m`;
};
const CUR_YM = new Date().toISOString().slice(0, 7);

// Roll the last-12 monthly fabric series up into the last 8 quarters.
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

// Customer-mix donut palette — professional financial-report scheme
// (deep navy → teal → steel, grey tail for "Others"). The blue/teal
// family is the convention in audit decks, fintech & SaaS finance UIs.
const PIE_COLORS = [
  "#16425B", // deep navy
  "#1F6E8C", // teal-navy
  "#2E8FA3", // teal
  "#4FA8B8", // light teal
  "#7FB9C6", // steel
  "#A9C7D0", // pale steel
  "#C6CDD3", // neutral grey — Others
];

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

function DeltaChip({ pct }: { pct: number | null }) {
  if (pct === null || !isFinite(pct)) return null;
  const up = pct >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{
        color: up ? "#15803D" : "#DC2626",
        background: up ? "rgba(21,128,61,0.08)" : "rgba(220,38,38,0.08)",
      }}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function KTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = C_SO,
  spark,
  delta = null,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  accent?: string;
  spark?: number[];
  delta?: number | null;
  onClick?: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={`relative bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] overflow-hidden ${
        onClick
          ? "cursor-pointer transition-shadow hover:shadow-[0_4px_14px_rgba(0,0,0,0.10)]"
          : ""
      }`}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550]">
            {label}
            {onClick && (
              <span className="ml-1 text-[#C2BBAE] font-normal">›</span>
            )}
          </p>
          <div className="rounded-lg bg-[#F5F2ED] p-2">
            <Icon className="h-4 w-4 text-[#6B5C32]" />
          </div>
        </div>
        <div className="mt-3 flex items-end gap-2">
          <p className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B] tabular-nums leading-none">
            {value}
          </p>
          <DeltaChip pct={delta} />
        </div>
        <div className="mt-2 flex items-end justify-between">
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

// Centred modal for the drill-throughs (same UX as /dashboard).
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

// Simple two/three-column table used inside several drill-throughs.
function MiniTable({
  cols,
  rows,
}: {
  cols: string[];
  rows: (string | number)[][];
}) {
  if (rows.length === 0)
    return <p className="text-xs text-[#9CA3AF]">Nothing here.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
          {cols.map((c, i) => (
            <th
              key={c}
              className={`py-1.5 font-medium ${i === 0 ? "" : "text-right"}`}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-[#F0ECE6]">
            {r.map((cell, ci) => (
              <td
                key={ci}
                className={`py-1.5 tabular-nums ${
                  ci === 0
                    ? "text-[#1F1D1B]"
                    : "text-right font-semibold text-[#1F1D1B]"
                }`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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

// Donut leader-line label — customer name + share % pointing at the slice.
interface PieLabelArg {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  percent?: number;
  index?: number;
  name?: string | number;
}
function renderPieLabel(a: PieLabelArg): React.ReactElement {
  const RAD = Math.PI / 180;
  const cx = a.cx ?? 0;
  const cy = a.cy ?? 0;
  const mid = a.midAngle ?? 0;
  const oR = a.outerRadius ?? 0;
  const cos = Math.cos(-mid * RAD);
  const sin = Math.sin(-mid * RAD);
  const sx = cx + oR * cos;
  const sy = cy + oR * sin;
  const mx = cx + (oR + 13) * cos;
  const my = cy + (oR + 13) * sin;
  const right = cos >= 0;
  const ex = mx + (right ? 15 : -15);
  const ey = my;
  const idx = a.index ?? 0;
  const color = PIE_COLORS[idx % PIE_COLORS.length];
  const nm = String(a.name ?? "");
  const short = nm.length > 15 ? `${nm.slice(0, 14)}…` : nm;
  const pct = ((a.percent ?? 0) * 100).toFixed(0);
  return (
    <g>
      <polyline
        points={`${sx},${sy} ${mx},${my} ${ex},${ey}`}
        stroke={color}
        strokeWidth={1}
        fill="none"
        opacity={0.55}
      />
      <text
        x={ex + (right ? 4 : -4)}
        y={ey}
        textAnchor={right ? "start" : "end"}
        dominantBaseline="central"
        fontSize={10}
        fill="#5A5550"
      >
        {short}
        <tspan fill="#9CA3AF"> {pct}%</tspan>
      </text>
    </g>
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
  const r = 60;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  return (
    <div className="relative flex items-center justify-center">
      <svg width="184" height="184" viewBox="0 0 184 184">
        <circle
          cx="92"
          cy="92"
          r={r}
          fill="none"
          stroke="#F0ECE6"
          strokeWidth="12"
          strokeDasharray={`${arc} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 92 92)"
        />
        <circle
          cx="92"
          cy="92"
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth="12"
          strokeDasharray={`${arc * pct} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 92 92)"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-[34px] leading-none font-[800] text-[#1F1D1B] tabular-nums">
          {big}
        </span>
        <span className="mt-1 text-[10px] uppercase tracking-wider text-[#9CA3AF]">
          {cap}
        </span>
      </div>
    </div>
  );
}

// ---------- page ----------
export default function DashboardBPage() {
  const [period, setPeriod] = useState("all");
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const toggleSeries = (k: string) =>
    setHiddenSeries((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const [fabMode, setFabMode] = useState<"prev" | "next">("prev");
  const [fabGran, setFabGran] = useState<"month" | "quarter">("month");
  const [hiddenDept, setHiddenDept] = useState<Set<string>>(new Set());
  const toggleDept = (k: string) =>
    setHiddenDept((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const [drill, setDrill] = useState<{
    title: string;
    subtitle?: string;
    node: React.ReactNode;
  } | null>(null);
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

  const aovAll = ov.aovByCustomer ?? [];
  const topBed = ov.topSellers?.BEDFRAME ?? [];
  const topSofa = ov.topSellers?.SOFA ?? [];

  // Period-over-period deltas (last vs previous month in the series).
  const pctDelta = (cur: number, prev: number): number | null =>
    prev > 0 ? ((cur - prev) / prev) * 100 : null;
  const lastR = rev[rev.length - 1];
  const prevR = rev[rev.length - 2];
  const salesDelta = lastR
    ? pctDelta(lastR.salesOrderSen, prevR?.salesOrderSen ?? 0)
    : null;
  const prodDelta = lastR
    ? pctDelta(lastR.productionSen, prevR?.productionSen ?? 0)
    : null;

  // Customer revenue concentration — top 6 + "Others" (financial-
  // report style: who is our revenue actually coming from?).
  const totalCustRev = aovAll.reduce((s, a) => s + a.totalSen, 0);
  const pieTop = aovAll.slice(0, 6).map((a) => ({
    name: a.customerName,
    value: a.totalSen,
  }));
  const othersRev = aovAll
    .slice(6)
    .reduce((s, a) => s + a.totalSen, 0);
  const pieData =
    othersRev > 0
      ? [...pieTop, { name: "Others", value: othersRev }]
      : pieTop;

  // Pipeline conversion rates.
  const deliveredRate =
    confirmed > 0 ? (delivered / confirmed) * 100 : 0;

  // Per-customer monthly AOV (drill-through for Customer Value rows).
  const aovMonthly = ov.aovMonthlyByCustomer ?? {};
  const tsByCust = ov.topSellersByCustomer;

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
          delta={salesDelta}
        />
        <KTile
          label="This-Month Delivered"
          value={rm(ov.deliveredThisMonthSen)}
          sub="item-level shipped value"
          icon={Truck}
          accent={C_PROD}
          spark={delSpark}
          delta={prodDelta}
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
      </div>

      {/* Revenue + Plant load */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Revenue — last 12 months"
              sub="Sales Orders · Invoices · Production · click a legend to toggle"
              right={
                <div className="flex gap-3 text-xs">
                  {(
                    [
                      ["Sales Orders", C_SO],
                      ["Production", C_PROD],
                      ["Invoices", C_INV],
                    ] as const
                  ).map(([k, c]) => {
                    const off = hiddenSeries.has(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => toggleSeries(k)}
                        className="inline-flex items-center gap-1 transition-opacity"
                        style={{
                          color: off ? "#C2BBAE" : c,
                          opacity: off ? 0.55 : 1,
                          textDecoration: off ? "line-through" : "none",
                        }}
                      >
                        ● {k}
                      </button>
                    );
                  })}
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
                      hide={hiddenSeries.has("Sales Orders")}
                    />
                    <Area
                      type="monotone"
                      dataKey="Production"
                      stroke={C_PROD}
                      strokeWidth={2}
                      fill="url(#bPR)"
                      isAnimationActive={false}
                      dot={false}
                      hide={hiddenSeries.has("Production")}
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
                      hide={hiddenSeries.has("Invoices")}
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
            <div className="mt-4 grid w-full grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-[#F7F4EF] px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Workforce
                </p>
                <p className="text-lg font-bold text-[#1F1D1B] tabular-nums">
                  {ov.employee?.activeHeadcount ?? 0}
                </p>
              </div>
              <div className="rounded-lg bg-[#F7F4EF] px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Queue load
                </p>
                <p
                  className="text-lg font-bold tabular-nums"
                  style={{ color: gaugeAccent }}
                >
                  {Math.round(util * 100)}%
                </p>
              </div>
            </div>
            <div className="mt-4 w-full border-t border-[#F0ECE6] pt-3 space-y-2">
              <button
                type="button"
                disabled={!prod?.capacityDays}
                onClick={() =>
                  prod?.capacityDays &&
                  setDrill({
                    title: "Daily Capacity — Past 7 Working Days",
                    subtitle: `Average ${hm(prod.dailyCapacityMin)}/day across all production depts`,
                    node: (
                      <MiniTable
                        cols={["Date", "Production time", "vs Avg"]}
                        rows={[...prod.capacityDays]
                          .sort((a, b) => a.date.localeCompare(b.date))
                          .map((d) => {
                            const diff = d.minutes - prod.dailyCapacityMin;
                            return [
                              d.date,
                              hm(d.minutes),
                              `${diff >= 0 ? "+" : "−"}${hm(Math.abs(diff))}`,
                            ];
                          })}
                      />
                    ),
                  })
                }
                className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Factory className="h-4 w-4 text-[#6B5C32]" />
                  <span className="text-xs text-[#5A5550]">
                    Daily Capacity{" "}
                    <span className="text-[#C2BBAE]">· 7-day avg</span>
                  </span>
                </span>
                <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                  {hrs(prod?.dailyCapacityMin)}
                </span>
              </button>
              <button
                type="button"
                disabled={!prod?.backlogByDept}
                onClick={() =>
                  prod?.backlogByDept &&
                  setDrill({
                    title: "Total Backlog — per Department",
                    subtitle: `${hm(prod.backlogGrandMin)} of active work across ${prod.backlogByDept.length} dept${prod.backlogByDept.length === 1 ? "" : "s"}`,
                    node: (
                      <MiniTable
                        cols={[
                          "Department",
                          "Sofa",
                          "Bedframe",
                          "Total",
                          "Daily cap",
                          "Backlog",
                        ]}
                        rows={prod.backlogByDept.map((d) => [
                          d.dept,
                          hm(d.sofaMin),
                          hm(d.bedframeMin),
                          hm(d.totalMin),
                          `${hm(d.dailyCapMin)}/d`,
                          `${d.backlogDays.toLocaleString()}d`,
                        ])}
                      />
                    ),
                  })
                }
                className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-[#DC2626]" />
                  <span className="text-xs text-[#5A5550]">
                    Total Backlog{" "}
                    <span className="text-[#C2BBAE]">· per dept</span>
                  </span>
                </span>
                <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                  {backlogDays.toLocaleString()}d ·{" "}
                  {hrs(prod?.backlogMin)}
                </span>
              </button>
              <button
                type="button"
                disabled={!prod?.activeJobs}
                onClick={() =>
                  prod?.activeJobs &&
                  setDrill({
                    title: "Active Jobs — pending by customer",
                    subtitle:
                      "Bedframe = pieces in production · Sofa = sets (1 SO = 1 set)",
                    node: (
                      <MiniTable
                        cols={["Customer", "Bedframe units", "Sofa sets"]}
                        rows={prod.activeJobs.byCustomer.map((c) => [
                          c.customer,
                          c.bedframeUnits ? c.bedframeUnits.toLocaleString() : "—",
                          c.sofaSets ? c.sofaSets.toLocaleString() : "—",
                        ])}
                      />
                    ),
                  })
                }
                className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-[#6B5C32]" />
                  <span className="text-xs text-[#5A5550]">
                    Active Jobs{" "}
                    <span className="text-[#C2BBAE]">· pending</span>
                  </span>
                </span>
                <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                  {(prod?.activeJobs?.bedframeUnits ?? 0).toLocaleString()} /{" "}
                  {(prod?.activeJobs?.sofaSets ?? 0).toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                disabled={!prod?.completedLast7}
                onClick={() =>
                  prod?.completedLast7 &&
                  setDrill({
                    title: "Completed — last 7 days",
                    subtitle:
                      "Production finished per day (last upholstery completed)",
                    node: (
                      <MiniTable
                        cols={["Date", "Bedframe units", "Sofa sets"]}
                        rows={prod.completedLast7.map((d) => [
                          d.date,
                          d.bedframeUnits.toLocaleString(),
                          d.sofaSets.toLocaleString(),
                        ])}
                      />
                    ),
                  })
                }
                className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
              >
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
                  <span className="text-xs text-[#5A5550]">
                    Completed yest.{" "}
                    <span className="text-[#C2BBAE]">· view 7d</span>
                  </span>
                </span>
                <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                  {(prod?.completedYesterday?.bedframeUnits ?? 0).toLocaleString()}{" "}
                  /{" "}
                  {(prod?.completedYesterday?.sofaSets ?? 0).toLocaleString()}
                </span>
              </button>
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
              right={
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                    Delivered rate
                  </p>
                  <p className="text-base font-bold text-[#15803D]">
                    {deliveredRate.toFixed(1)}%
                  </p>
                </div>
              }
            />
            {[
              { k: "Confirmed", v: confirmed, c: C_SO, pct: 100 },
              {
                k: "Outstanding",
                v: outstanding,
                c: C_PROD,
                pct: confirmed > 0 ? (outstanding / confirmed) * 100 : 0,
              },
              {
                k: "Delivered",
                v: delivered,
                c: C_GREEN,
                pct: deliveredRate,
              },
            ].map((s) => (
              <div key={s.k} className="flex items-center gap-3 py-1.5">
                <span className="w-24 text-xs text-[#5A5550]">{s.k}</span>
                <div className="flex-1 h-3 rounded-full bg-[#F5F2ED] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(3, (s.v / pipeMax) * 100)}%`,
                      background: s.c,
                    }}
                  />
                </div>
                <span className="w-12 text-right text-[11px] text-[#9CA3AF] tabular-nums">
                  {s.pct.toFixed(0)}%
                </span>
                <span className="w-24 text-right text-xs font-semibold text-[#1F1D1B] tabular-nums">
                  {rm(s.v)}
                </span>
              </div>
            ))}
            <p className="mt-2 text-[11px] text-[#9CA3AF]">
              {rm(outstanding)} still to ship of {rm(confirmed)} confirmed.
            </p>
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

      {/* Revenue by Customer — financial-report concentration exhibit */}
      <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
        <CardContent className="p-5">
          <SectionTitle
            title="Sales by Customer & Month"
            sub="avg order value — bedframe (per unit) vs sofa (per set) · click a customer for the monthly breakdown"
            right={
              <span className="text-[11px] text-[#9CA3AF]">
                Total customer revenue{" "}
                <span className="font-semibold text-[#1F1D1B]">
                  {rm(totalCustRev)}
                </span>
              </span>
            }
          />
          {pieData.length === 0 ? (
            <p className="text-xs text-[#9CA3AF] py-6 text-center">
              No customer revenue.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-center">
                <div
                  className="lg:col-span-2 relative"
                  style={{ width: "100%", height: 340 }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart
                      margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    >
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={66}
                        outerRadius={104}
                        paddingAngle={2}
                        stroke="#fff"
                        strokeWidth={2}
                        isAnimationActive={false}
                        labelLine={false}
                        label={renderPieLabel}
                      >
                        {pieData.map((_, i) => (
                          <Cell
                            key={i}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(val, name) => {
                          const v = Number(val) || 0;
                          return [
                            `${rm(v)} · ${((v / Math.max(1, totalCustRev)) * 100).toFixed(1)}%`,
                            String(name),
                          ];
                        }}
                        contentStyle={{
                          borderRadius: 8,
                          border: "1px solid #E2DDD8",
                          fontSize: 12,
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
                      Top 3
                    </span>
                    <span className="text-3xl font-[800] text-[#1F1D1B]">
                      {(
                        (aovAll
                          .slice(0, 3)
                          .reduce((s, a) => s + a.totalSen, 0) /
                          Math.max(1, totalCustRev)) *
                        100
                      ).toFixed(0)}
                      %
                    </span>
                  </div>
                </div>
                <div className="lg:col-span-3">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] text-[#9CA3AF] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Customer</th>
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
                        <th className="py-1.5 font-medium text-right">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ov.aovCompany && (
                        <tr className="border-b-2 border-[#E2DDD8] bg-[#FAF8F4]">
                          <td className="py-1.5 font-bold text-[#1F1D1B]">
                            All customers
                          </td>
                          <td className="py-1.5 text-right font-semibold text-[#1F1D1B] tabular-nums">
                            {ov.aovCompany.bedframeUnits
                              ? rm(ov.aovCompany.bedframeAvgSen)
                              : "—"}
                          </td>
                          <td className="py-1.5 text-right text-[#9CA3AF] tabular-nums">
                            {ov.aovCompany.bedframeUnits
                              ? ov.aovCompany.bedframeUnits.toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-1.5 text-right font-semibold text-[#1F1D1B] tabular-nums">
                            {ov.aovCompany.sofaSets
                              ? rm(ov.aovCompany.sofaAvgSen)
                              : "—"}
                          </td>
                          <td className="py-1.5 text-right text-[#9CA3AF] tabular-nums">
                            {ov.aovCompany.sofaSets
                              ? ov.aovCompany.sofaSets.toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-1.5 text-right font-bold text-[#1F1D1B] tabular-nums">
                            {rm(ov.aovCompany.totalSen)}
                          </td>
                        </tr>
                      )}
                      {aovAll.slice(0, 10).map((a, i) => {
                        const monthly = aovMonthly[a.customerName];
                        const hasMonthly = !!(
                          monthly && monthly.length > 0
                        );
                        const drillRows =
                          hasMonthly && monthly
                            ? monthly.map((m) => [
                                m.month,
                                m.bedframeUnits
                                  ? rm(m.bedframeAvgSen)
                                  : "—",
                                m.bedframeUnits || "—",
                                m.sofaSets ? rm(m.sofaAvgSen) : "—",
                                m.sofaSets || "—",
                              ])
                            : [
                                [
                                  "All-time",
                                  a.bedframeUnits
                                    ? rm(a.bedframeAvgSen)
                                    : "—",
                                  a.bedframeUnits || "—",
                                  a.sofaSets ? rm(a.sofaAvgSen) : "—",
                                  a.sofaSets || "—",
                                ],
                              ];
                        return (
                          <tr
                            key={a.customerName}
                            onClick={() =>
                              setDrill({
                                title: `${a.customerName} — monthly AOV`,
                                subtitle: hasMonthly
                                  ? "Average per month, by SO date. Bedframe per unit · Sofa per set."
                                  : "No monthly split — all-time average. Bedframe per unit · Sofa per set.",
                                node: (
                                  <MiniTable
                                    cols={[
                                      "Month",
                                      "Bedframe AOV",
                                      "Units",
                                      "Sofa AOV",
                                      "Sets",
                                    ]}
                                    rows={drillRows}
                                  />
                                ),
                              })
                            }
                            className="border-b border-[#F0ECE6] cursor-pointer hover:bg-[#FAF8F4]"
                          >
                            <td className="py-1.5 text-[#1F1D1B]">
                              <span
                                className="inline-block h-2 w-2 rounded-sm mr-2 align-middle"
                                style={{
                                  background:
                                    PIE_COLORS[i % PIE_COLORS.length],
                                }}
                              />
                              {a.customerName}
                              <span className="text-[10px] text-[#9CA3AF]">
                                {" "}
                                · monthly
                              </span>
                              <span className="text-[#C2BBAE]"> ›</span>
                            </td>
                            <td className="py-1.5 text-right text-[#1F1D1B] tabular-nums">
                              {a.bedframeUnits ? rm(a.bedframeAvgSen) : "—"}
                            </td>
                            <td className="py-1.5 text-right text-[#9CA3AF] tabular-nums">
                              {a.bedframeUnits
                                ? a.bedframeUnits.toLocaleString()
                                : "—"}
                            </td>
                            <td className="py-1.5 text-right text-[#1F1D1B] tabular-nums">
                              {a.sofaSets ? rm(a.sofaAvgSen) : "—"}
                            </td>
                            <td className="py-1.5 text-right text-[#9CA3AF] tabular-nums">
                              {a.sofaSets
                                ? a.sofaSets.toLocaleString()
                                : "—"}
                            </td>
                            <td className="py-1.5 text-right font-semibold text-[#1F1D1B] tabular-nums">
                              {rm(a.totalSen)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              {(ov.monthlySales ?? []).length > 0 && (
                <div className="mt-5 border-t border-[#F0ECE6] pt-4">
                  <p className="text-[11px] font-semibold text-[#5A5550] uppercase tracking-wider mb-2">
                    Monthly — Bedframe Units &amp; Sofa Sets
                    <span className="ml-2 font-normal normal-case tracking-normal text-[#9CA3AF]">
                      click a month for the customer breakdown
                    </span>
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    {(ov.monthlySales ?? []).map((m) => {
                      const who =
                        ov.monthlySalesByCustomer?.[m.month] ?? [];
                      return (
                        <button
                          key={m.month}
                          type="button"
                          disabled={who.length === 0}
                          onClick={() =>
                            who.length &&
                            setDrill({
                              title: `${m.month} — by customer`,
                              subtitle:
                                "Who contributed this month's bedframe units / sofa sets",
                              node: (
                                <MiniTable
                                  cols={[
                                    "Customer",
                                    "Bedframe units",
                                    "Sofa sets",
                                  ]}
                                  rows={who.map((c) => [
                                    c.customer,
                                    c.bedframeUnits
                                      ? c.bedframeUnits.toLocaleString()
                                      : "—",
                                    c.sofaSets
                                      ? c.sofaSets.toLocaleString()
                                      : "—",
                                  ])}
                                />
                              ),
                            })
                          }
                          className={`rounded-lg border border-[#F0ECE6] bg-[#FAF8F4] px-3 py-2 text-left transition-colors ${
                            who.length
                              ? "cursor-pointer hover:bg-[#F0ECE6]"
                              : "opacity-60"
                          }`}
                        >
                          <p className="text-[11px] text-[#5A5550] tabular-nums">
                            {m.month}
                            {who.length > 0 && (
                              <span className="text-[#C2BBAE]"> · who ›</span>
                            )}
                          </p>
                          <p className="text-sm font-bold text-[#1F1D1B] tabular-nums mt-0.5">
                            {m.bedframeUnits.toLocaleString()}{" "}
                            <span className="text-[10px] font-normal text-[#9CA3AF]">
                              bf
                            </span>{" "}
                            {m.sofaSets.toLocaleString()}{" "}
                            <span className="text-[10px] font-normal text-[#9CA3AF]">
                              sofa
                            </span>
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="mt-3 text-[11px] text-[#9CA3AF]">
                Concentration:{" "}
                <span className="font-semibold text-[#1F1D1B]">
                  Top 3 ={" "}
                  {(
                    (aovAll.slice(0, 3).reduce((s, a) => s + a.totalSen, 0) /
                      Math.max(1, totalCustRev)) *
                    100
                  ).toFixed(0)}
                  %
                </span>{" "}
                ·{" "}
                <span className="font-semibold text-[#1F1D1B]">
                  Top 5 ={" "}
                  {(
                    (aovAll.slice(0, 5).reduce((s, a) => s + a.totalSen, 0) /
                      Math.max(1, totalCustRev)) *
                    100
                  ).toFixed(0)}
                  %
                </span>{" "}
                of total customer revenue ({rm(totalCustRev)}).
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Top sellers */}
      <div>

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
                {topBed.slice(0, 6).map((p) => {
                  const cr = tsByCust?.BEDFRAME?.[p.productCode] ?? [];
                  return (
                    <div
                      key={p.productCode}
                      onClick={
                        cr.length
                          ? () =>
                              setDrill({
                                title: `${p.productCode} — by customer`,
                                subtitle: `${p.qtySold.toLocaleString()} units · ${rm(p.valueSen)}`,
                                node: (
                                  <MiniTable
                                    cols={["Customer", "Units", "Value"]}
                                    rows={cr.map((c) => [
                                      c.customer,
                                      c.qty.toLocaleString(),
                                      rm(c.valueSen),
                                    ])}
                                  />
                                ),
                              })
                          : undefined
                      }
                      className={`flex items-center justify-between text-sm py-0.5 rounded ${
                        cr.length
                          ? "cursor-pointer hover:bg-[#FAF8F4] -mx-1 px-1"
                          : ""
                      }`}
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
                  );
                })}
              </div>
              <div className="border-l border-[#F0ECE6] pl-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550] mb-1.5">
                  Sofa
                </p>
                {topSofa.slice(0, 6).map((p) => {
                  const cr = tsByCust?.SOFA?.[p.model] ?? [];
                  return (
                    <div
                      key={p.model}
                      onClick={
                        cr.length
                          ? () =>
                              setDrill({
                                title: `Sofa ${p.model} — by customer`,
                                subtitle: `${p.setsSold.toLocaleString()} sets · ${rm(p.valueSen)}`,
                                node: (
                                  <MiniTable
                                    cols={["Customer", "Sets", "Value"]}
                                    rows={cr.map((c) => [
                                      c.customer,
                                      c.sets.toLocaleString(),
                                      rm(c.valueSen),
                                    ])}
                                  />
                                ),
                              })
                          : undefined
                      }
                      className={`flex items-center justify-between text-sm py-0.5 rounded ${
                        cr.length
                          ? "cursor-pointer hover:bg-[#FAF8F4] -mx-1 px-1"
                          : ""
                      }`}
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
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Fabric */}
      <div>
        <div className="flex items-end justify-between mb-3">
          <div>
            <h3 className="text-sm font-bold text-[#1F1D1B] tracking-[-0.2px]">
              Fabric Usage — Bedframe vs Sofa
            </h3>
            <p className="text-xs text-[#9CA3AF] mt-0.5">
              {fabMode === "next"
                ? "forecast — fabric needed next 30 days"
                : "history — fabric used to date"}{" "}
              · {fabGran === "quarter" ? "quarterly trend" : "monthly trend"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {(["prev", "next"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setFabMode(m)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    fabMode === m
                      ? "bg-[#6B5C32] text-white"
                      : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
                  }`}
                >
                  {m === "prev" ? "Previous" : "Next"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {(["month", "quarter"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setFabGran(g)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
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
        {fc && (
          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] mb-4">
            <CardContent className="py-4 px-5 flex flex-wrap items-center gap-x-10 gap-y-3">
              <div className="flex items-center gap-2">
                <Scissors className="h-4 w-4 text-[#6B5C32]" />
                <span className="text-xs font-semibold text-[#5A5550]">
                  Fabric Cost / Meter
                </span>
              </div>
              <div>
                <p className="text-[11px] text-[#9CA3AF]">
                  Overall (all issued)
                </p>
                <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                  {rm(fc.total)}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-[#9CA3AF]">
                  Excl. Bedframe &amp; Sofa
                </p>
                <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                  {rm(fc.exclBedframeSofa)}
                </p>
              </div>
              <p className="text-[10px] text-[#9CA3AF] max-w-[16rem]">
                Weighted avg of fabric actually issued to production
                (consumption).
              </p>
            </CardContent>
          </Card>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(["BEDFRAME", "SOFA"] as const).map((cat) => {
            const blk = ov.fabric?.[cat];
            const trend =
              fabGran === "quarter"
                ? toQuarterly(blk?.monthly ?? [])
                : (blk?.monthly ?? []).map((m) => ({
                    label: m.month,
                    meters: m.meters,
                  }));
            const mMax = Math.max(1, ...trend.map((t) => t.meters));
            const fabRows =
              fabMode === "next"
                ? (blk?.list ?? [])
                    .filter((f) => f.next30Meters > 0)
                    .sort((a, b) => b.next30Meters - a.next30Meters)
                    .slice(0, 10)
                : (blk?.list ?? [])
                    .filter((f) => f.meters > 0)
                    .sort((a, b) => b.meters - a.meters)
                    .slice(0, 10);
            return (
              <Card
                key={cat}
                className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
              >
                <CardContent className="p-5">
                  <SectionTitle
                    title={`${cat === "BEDFRAME" ? "Bedframe" : "Sofa"} Fabric`}
                    sub={
                      fabMode === "next"
                        ? "forecast — next 30 days · purchase price /m"
                        : "used (history) · purchase price /m"
                    }
                    right={
                      <div className="text-right">
                        <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                          Avg cost /m
                        </p>
                        <p className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                          {rm(cat === "BEDFRAME" ? fc?.bedframe : fc?.sofa)}
                        </p>
                      </div>
                    }
                  />
                  {fabRows.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF] py-3">
                      {fabMode === "next"
                        ? "No upcoming fabric demand."
                        : "No fabric issued."}
                    </p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] text-[#9CA3AF] border-b border-[#F0ECE6]">
                          <th className="font-medium pb-1.5">Fabric</th>
                          <th className="font-medium pb-1.5 text-right">
                            {fabMode === "next" ? "Next 30d" : "Used"}
                          </th>
                          <th className="font-medium pb-1.5 text-right">
                            Past 30d
                          </th>
                          <th className="font-medium pb-1.5 text-right">
                            Avg buy
                          </th>
                          <th className="font-medium pb-1.5 text-right">
                            Min–Max
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {fabRows.map((f) => (
                          <tr
                            key={f.fabCode}
                            className="border-b border-[#F7F4EF]"
                          >
                            <td className="py-1 font-medium text-[#1F1D1B]">
                              {f.fabCode}
                            </td>
                            <td
                              className={`py-1 text-right tabular-nums font-semibold ${
                                fabMode === "next"
                                  ? "text-[#6B5C32]"
                                  : "text-[#1F1D1B]"
                              }`}
                            >
                              {fabMode === "next"
                                ? `${f.next30Meters.toLocaleString()} m`
                                : `${Math.round(
                                    f.meters,
                                  ).toLocaleString()} m`}
                            </td>
                            <td className="py-1 text-right tabular-nums text-[#5A5550]">
                              {f.past30Meters.toLocaleString()} m
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
                  )}
                  <div className="mt-3 border-t border-[#F0ECE6] pt-2 space-y-1">
                    <p className="text-[11px] font-semibold text-[#5A5550] mb-1">
                      {fabGran === "quarter"
                        ? "Quarterly meters — last 8"
                        : "Monthly meters — last 12"}
                    </p>
                    {trend.length === 0 ? (
                      <p className="text-xs text-[#9CA3AF]">No data.</p>
                    ) : (
                      trend.map((t) => (
                        <div
                          key={t.label}
                          className="flex items-center gap-2"
                        >
                          <span className="w-14 shrink-0 text-[11px] text-[#9CA3AF] tabular-nums">
                            {t.label}
                          </span>
                          <div className="flex-1 h-2.5 rounded bg-[#F5F2ED] overflow-hidden">
                            <div
                              className="h-full rounded"
                              style={{
                                width: `${Math.max(
                                  2,
                                  (t.meters / mMax) * 100,
                                )}%`,
                                background: C_SO,
                                opacity: 0.7,
                              }}
                            />
                          </div>
                          <span className="w-16 text-right text-[11px] font-semibold text-[#1F1D1B] tabular-nums">
                            {Math.round(t.meters).toLocaleString()} m
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <p className="text-[10px] text-[#9CA3AF] mt-2">
                    Fabric issued to{" "}
                    {cat === "BEDFRAME" ? "bedframe" : "sofa"} production
                    (RM_ISSUE).
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Department backlog + Purchasing */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Department Backlog"
              sub="active work vs daily capacity — bottleneck first · click a legend to toggle"
              right={
                <div className="flex gap-3 text-xs">
                  {(
                    [
                      ["Sofa", C_INV],
                      ["Bedframe", C_SO],
                    ] as const
                  ).map(([k, c]) => {
                    const off = hiddenDept.has(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => toggleDept(k)}
                        className="inline-flex items-center gap-1 transition-opacity"
                        style={{
                          color: off ? "#C2BBAE" : c,
                          opacity: off ? 0.55 : 1,
                          textDecoration: off ? "line-through" : "none",
                        }}
                      >
                        ● {k}
                      </button>
                    );
                  })}
                </div>
              }
            />
            {(() => {
              const sofaOn = !hiddenDept.has("Sofa");
              const bedOn = !hiddenDept.has("Bedframe");
              const mx = Math.max(
                1,
                ...(prod?.backlogByDept ?? []).map(
                  (x) =>
                    (sofaOn ? x.sofaMin : 0) + (bedOn ? x.bedframeMin : 0),
                ),
              );
              const filtered = !(sofaOn && bedOn);
              return (prod?.backlogByDept ?? []).map((d) => {
                const visMin =
                  (sofaOn ? d.sofaMin : 0) + (bedOn ? d.bedframeMin : 0);
                const showDays = filtered
                  ? d.dailyCapMin > 0
                    ? visMin / d.dailyCapMin
                    : 0
                  : d.backlogDays;
                return (
                  <div
                    key={d.dept}
                    className="flex items-center gap-3 py-1"
                  >
                    <span className="w-28 text-xs text-[#1F1D1B]">
                      {d.dept}
                    </span>
                    <div className="flex-1 h-2.5 rounded bg-[#F5F2ED] overflow-hidden flex">
                      {sofaOn && (
                        <div
                          className="h-full"
                          style={{
                            width: `${(d.sofaMin / mx) * 100}%`,
                            background: C_INV,
                          }}
                        />
                      )}
                      {bedOn && (
                        <div
                          className="h-full"
                          style={{
                            width: `${(d.bedframeMin / mx) * 100}%`,
                            background: C_SO,
                          }}
                        />
                      )}
                    </div>
                    <span className="w-12 text-right text-xs font-semibold text-[#DC2626] tabular-nums">
                      {showDays.toFixed(1)}d
                    </span>
                  </div>
                );
              });
            })()}
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
