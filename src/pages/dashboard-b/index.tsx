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
import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Skeleton, SkeletonDashboard } from "@/components/ui/skeleton";
import { useCachedJson } from "@/lib/cached-fetch";
import { OcrAccuracyCard } from "./OcrAccuracyCard";
import {
  poReadyForDelivery,
  type PipelinePO,
} from "@/lib/delivery-pipeline";
// recharts (~357 KB) is loaded lazily so the KPI numbers paint first; the
// chart code streams in behind a placeholder. See ./charts.tsx.
const RevenueChart = lazy(() =>
  import("./charts").then((m) => ({ default: m.RevenueChart })),
);
const CustomerPieChart = lazy(() =>
  import("./charts").then((m) => ({ default: m.CustomerPieChart })),
);
import {
  DollarSign,
  FileText,
  Clock,
  Package,
  Factory,
  CheckCircle2,
  X,
  ArrowUpRight,
  ArrowDownRight,
  Scissors,
  ClipboardCheck,
  Info,
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
  invoicesThisMonthSen?: number;
  deliveredOfMonthOrdersSen?: number;
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    activeJobs: JobsBreakdown;
    completedYesterday: JobsBreakdown;
    completedLast7: { date: string; bedframeUnits: number; sofaSets: number }[];
    capacityDays: { date: string; minutes: number; workers: number }[];
    // backlogDays: null = "stalled" (zero completions in the rolling window —
    // no honest way to express the queue in days).
    backlogByDept: {
      dept: string;
      sofaMin: number;
      bedframeMin: number;
      totalMin: number;
      dailyCapMin: number;
      backlogDays: number | null;
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
  weeklyRevenue?: {
    week: string; // ISO week-start date "YYYY-MM-DD" (Monday)
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
  employee?: { activeHeadcount: number };
  // Command Center month-awareness. Describes whether the point-in-time
  // STATE widgets (Backlog, Active Jobs, Workforce) reflect a true
  // historical snapshot, the current live value, or a live value shown for
  // a past month with NO stored history (→ show a muted "live" tag).
  stateSnapshot?: {
    source: "live" | "snapshot" | "reconstructed";
    isHistorical: boolean; // true → past-month value (snapshot-less): live or reconstructed
    asOf: string | null; // snap_date (snapshot) or month-end (reconstructed)
  };
};
type PODeliveryShape = PipelinePO & {
  salesOrderId?: string;
  productCode?: string;
  quantity?: number;
};
type POResp = { success?: boolean; data?: PODeliveryShape[] };
type DOResp = {
  success?: boolean;
  data?: {
    id: string;
    status: string;
    // Goods value the list endpoint attaches per DO (loadDoValueMap — the
    // same resolver behind the Delivery page tab totals, so card figures
    // built from it always tie to that screen).
    valueSen?: number;
    items?: { productionOrderId?: string | null }[];
  }[];
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
// Daily Report (process / SOP exceptions) summary — independent fetch, shown
// as its own card. Mirrors src/api/lib/compliance-report.ts counts.
type ComplianceResp = {
  success?: boolean;
  data?: {
    counts: {
      total: number;
      doPendingDispatch: number;
      doNotDelivered: number;
      doNotInvoiced: number;
      soNoDo: number;
      soNoInvoice: number;
      // The two biggest categories on prod (114 + 39 of 380) and absent from
      // this projection until 2026-08-05, which is why they never reached a chip.
      pricingIssues: number;
      cogsIssues: number;
      overdueOrders: number;
      poNotReceived: number;
      lowEfficiencyWorkers: number;
      processSkips: number;
      missingWipTimes: number;
      incompleteBoms: number;
      rdStalled: number;
    };
  };
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
// Date range for a selected "YYYY-MM": [1st .. month end]. The current
// month is capped at today; a past month runs to its last calendar day.
function monthWindow(ym: string): { from: string; to: string } {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yr = Number(ym.slice(0, 4));
  const mo = Number(ym.slice(5, 7)); // 1-12
  const from = iso(new Date(yr, mo - 1, 1));
  const lastDay = new Date(yr, mo, 0); // day 0 of next month
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const to = ym === CUR_YM && today < lastDay ? iso(today) : iso(lastDay);
  return { from, to };
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
  loading = false,
  tag,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  accent?: string;
  spark?: number[];
  delta?: number | null;
  onClick?: () => void;
  // Optional small badge after the label (e.g. "live" for point-in-time
  // state KPIs that do not move with the period selector).
  tag?: string;
  // When true the value slot shows a pulsing skeleton — used for tiles
  // backed by a slower live fetch while the snapshot-fast tiles are
  // already painted (progressive render).
  loading?: boolean;
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
            {tag && (
              <span className="ml-1.5 rounded bg-[#EEF2F0] px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-[#15803D] align-middle">
                {tag}
              </span>
            )}
            {onClick && (
              <span className="ml-1 text-[#C2BBAE] font-normal">›</span>
            )}
          </p>
          <div className="rounded-lg bg-[#F5F2ED] p-2">
            <Icon className="h-4 w-4 text-[#6B5C32]" />
          </div>
        </div>
        <div className="mt-3 flex items-end gap-2">
          {loading ? (
            <Skeleton height={26} width={96} />
          ) : (
            <p className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B] tabular-nums leading-none">
              {value}
            </p>
          )}
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

// Skeleton placeholder for a card section whose own live fetch is still in
// flight — keeps the card at roughly its final height so the page doesn't
// jump when the real rows arrive (progressive render).
function SectionRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton height={12} width={88} />
          <Skeleton height={12} className="flex-1" />
          <Skeleton height={12} width={56} />
        </div>
      ))}
    </div>
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
    <div className="overflow-x-auto">
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
    </div>
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
    <div className="flex items-end justify-between mb-3 flex-wrap gap-y-2">
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

// RevTooltip + renderPieLabel moved to ./charts.tsx (lazy-loaded with recharts).

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
  // Open the Command Center on the CURRENT month by default (owner request) —
  // not all-time. CUR_YM (module-scope) is the current "YYYY-MM".
  const [period, setPeriod] = useState(CUR_YM);
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
  // Kept only as a loading gate for the Pending Delivery tile (doL). The DO
  // page payload is no longer READ for any KPI: Pending Delivery now uses the
  // whole-dataset linked-PO set (linkedRaw) and the dispatch-chain KPIs use
  // the whole-dataset /stats valueByStatus (doStatsRaw) — both below — so the
  // capped 200-row page is never summed.
  const { loading: doL } = useCachedJson<DOResp>(
    "/api/delivery-orders?page=1&limit=200",
  );
  // Authoritative whole-dataset "already on a DO/CN" PO-id set. Replaces
  // buildLinkedPOIds(dos), which was derived from the capped 200-row page and
  // went wrong once total DOs exceed 200 (Pending Delivery then counted POs
  // that were actually already shipped on a DO beyond row 200).
  const { data: linkedRaw } = useCachedJson<{ poIds?: string[] }>(
    "/api/delivery-orders/linked-po-ids",
  );
  // Whole-dataset per-status value sums (valueByStatus) — the SAME aggregate
  // the Delivery list page reads. The dispatch-chain KPIs (pending-dispatch /
  // in-transit) sum from this so they reflect ALL DOs, not the 200-row page.
  const { data: doStatsRaw } = useCachedJson<{
    valueByStatus?: Record<string, number>;
  }>("/api/delivery-orders/stats");
  const { data: poValRaw, loading: poValL } = useCachedJson<POValuesResp>(
    "/api/delivery-orders/po-values",
  );
  // Slim price-index variant — returns only {id, items:[{productCode,
  // unitPriceSen}]} instead of the full 720-SO payload. The price map built
  // below is byte-identical (same SOs, same items); only the wire payload
  // shrinks, so the Pending-Delivery tile + KPI value are unchanged.
  const { data: soItemsRaw, loading: soItemsL } =
    useCachedJson<SOItemsResp>("/api/sales-orders?fields=price-index");
  // Worker-Efficiency window follows the selected month: a specific month →
  // [1st .. month end] (capped at today for the current month); All-time →
  // the rolling last 7 working days (unchanged).
  const effWin = useMemo(() => {
    if (period === "all") return last7WorkingDays();
    return monthWindow(period);
  }, [period]);
  const { data: jcSumRaw, loading: jcSumL } = useCachedJson<JcSummaryResp>(
    `/api/job-cards/summary?from=${effWin.from}&to=${effWin.to}`,
  );
  const { data: wheSumRaw, loading: wheSumL } = useCachedJson<WheSummaryResp>(
    `/api/working-hour-entries/summary?from=${effWin.from}&to=${effWin.to}`,
  );
  const { data: workersRaw, loading: workersL } =
    useCachedJson<WorkersResp>("/api/workers");
  // Daily Report summary — independent fetch (own loading state), so it paints
  // the instant its data lands without blocking the rest of the dashboard.
  const { data: compRaw, loading: compL } =
    useCachedJson<ComplianceResp>("/api/reports/compliance.json");
  const compCounts = compRaw?.data?.counts;
  // Progressive render — the page used to block on ALL nine fetches before
  // painting anything. Now it gates only on the overview fetch, which is
  // snapshot-accelerated (fast). Every other section renders the instant ITS
  // OWN data arrives; sections still waiting show a skeleton placeholder.
  //
  //   • ovL        → overview (KPI rail, Revenue, Plant Load, Sales by
  //                  Customer, Top Sellers, Fabric, Dept Backlog,
  //                  Purchasing). Snapshot-backed — resolves quickly.
  //   • soL        → Order Pipeline + the "Outstanding" KPI tile.
  //   • pendingL   → the "Pending Delivery" KPI tile (4 heavy live fetches).
  //   • effL       → Worker Efficiency (3 live fetches).
  const overviewLoading = ovL;
  const pendingL = poL || doL || poValL || soItemsL;
  const effL = jcSumL || wheSumL || workersL;

  // Pending Delivery — identical computation to /dashboard.
  const pendingDeliveryValueSen = useMemo(() => {
    const pos = poRaw?.success ? poRaw.data ?? [] : [];
    // Whole-dataset linked-PO set (authoritative). Guard the loading flash:
    // until linkedRaw lands, treat the set as empty would WRONGLY count every
    // PO as still-pending, so bail to 0 until the set is defined.
    if (!linkedRaw) return 0;
    const linkedPOIds = new Set(linkedRaw.poIds ?? []);
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
  }, [poRaw, linkedRaw, poValRaw, soItemsRaw]);

  // Dispatch-chain fold (owner 2026-06-11: "Pending Dispatch 放入 Pending
  // Delivery,Dispatch 放进 Delivered"): value of DOs created but not yet
  // dispatched joins the PENDING DELIVERY card; value on the truck
  // (LOADED / IN_TRANSIT) joins the DELIVERED card. Read from the whole-
  // dataset /stats valueByStatus aggregate (same per-DO value resolver the
  // Delivery page tab strip uses), so both screens tie AND the values are
  // complete — the old 200-row page sum undercounted once DOs exceed 200.
  const dispatchChain = useMemo(() => {
    const v = doStatsRaw?.valueByStatus ?? {};
    const pendingDispatchSen = v.DRAFT ?? 0;
    const inTransitSen = (v.LOADED ?? 0) + (v.IN_TRANSIT ?? 0);
    return { pendingDispatchSen, inTransitSen };
  }, [doStatsRaw]);

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
  // The Revenue trend chart is weekly (last 12 weeks) for All-time, and DAILY
  // (one point per day of the month) when a month is selected — the backend
  // switches the bucket granularity and sends the matching `week` keys, so the
  // frontend just plots whatever points it gets. KPI sparklines / deltas below
  // stay month-over-month off `rev`. — Wei Siang 2026-05-29 / 2026-06-09.
  const weekRev = useMemo(() => ov.weeklyRevenue ?? [], [ov.weeklyRevenue]);
  const revChart = useMemo(
    () =>
      weekRev.map((r) => ({
        // All-time → "MM-DD" of the week-start; month → "MM-DD" of the day.
        m: r.week.slice(5),
        "Sales Orders": Math.round(r.salesOrderSen / 100),
        Invoices: Math.round(r.invoiceSen / 100),
        Production: Math.round(r.productionSen / 100),
      })),
    [weekRev],
  );
  // Sparkline for the Sales card — the monthly confirmed-SO trend.
  const soSpark = useMemo(() => rev.map((r) => r.salesOrderSen), [rev]);
  // Sparkline for the Invoices card — the monthly invoiced trend (same
  // invoice-date source as the card's headline value).
  const invSpark = useMemo(() => rev.map((r) => r.invoiceSen), [rev]);

  const delivered = so.deliveredItemsSen ?? 0;
  const outstanding = so.outstandingItemsSen ?? 0;
  const confirmed = so.csRevenueSen ?? delivered + outstanding;
  // Order Pipeline values. The /api/sales-orders/stats endpoint is NOT
  // period-aware (it only aggregates the whole table), so for a selected month
  // we use the month-scoped figures the dashboard-overview payload computes.
  //   • period === 'all' → original all-time so.* values (UNCHANGED).
  //   • a month          → SAME-COHORT funnel of the orders confirmed that
  //     month: confirmed = salesThisMonthSen, delivered = how much of THAT
  //     cohort has shipped (deliveredOfMonthOrdersSen), outstanding = the rest.
  // Note: the all-time "Outstanding" KPI tile above stays on so.* (the live
  // "orders still open" count) — a different lens from this funnel.
  const isMonthScoped = period !== "all";
  const pipeConfirmed = isMonthScoped ? (ov.salesThisMonthSen ?? 0) : confirmed;
  // Month pipeline is a SAME-COHORT funnel: of the orders CONFIRMED this month
  // (salesThisMonthSen), how much has shipped (deliveredOfMonthOrdersSen — the
  // SO's confirm-month, not the ship date). So delivered ≤ confirmed and
  // Outstanding = the rest is meaningful (≠ the dispatch-month "delivered this
  // month" KPI tile, which folds in prior-month backlog and can exceed 100%).
  const pipeDelivered = isMonthScoped
    ? (ov.deliveredOfMonthOrdersSen ?? 0)
    : delivered;
  const pipeOutstanding = isMonthScoped
    ? Math.max(0, pipeConfirmed - pipeDelivered)
    : outstanding;
  const pipeMax = Math.max(1, pipeConfirmed, pipeDelivered, pipeOutstanding);
  const backlogDays = prod?.backlogDays ?? 0;
  const util = Math.min(1, backlogDays / 14);
  const gaugeAccent = backlogDays > 12 ? C_RED : backlogDays > 7 ? C_PROD : C_GREEN;
  // Month-awareness: the state widgets (Backlog / Active Jobs / Workforce)
  // are point-in-time counts. Three cases for a selected period:
  //   • source === "snapshot"      → a true captured daily snapshot for that
  //                                   past month. Show "as of <date>", no
  //                                   warning tag (it's real history).
  //   • source === "reconstructed" → no snapshot existed, so the backend
  //                                   rebuilt Backlog + Workforce as of the
  //                                   month's last day (best-effort estimate).
  //                                   Show a muted "≈ reconstructed" tag plus
  //                                   "as of <month-end>".
  //   • source === "live" + isHistorical → couldn't reconstruct; current live
  //                                   value shown for a past month. Muted
  //                                   "live (no history)" warning.
  //   • source === "live" (current/all) → no tag.
  const stateReconstructed = ov.stateSnapshot?.source === "reconstructed";
  const stateLiveTag =
    ov.stateSnapshot?.isHistorical === true && !stateReconstructed;
  const stateAsOf =
    ov.stateSnapshot?.source === "snapshot" || stateReconstructed
      ? ov.stateSnapshot?.asOf
      : null;

  const [custCat, setCustCat] = useState<"all" | "bedframe" | "sofa">("all");

  const aovAll = useMemo(() => ov.aovByCustomer ?? [], [ov.aovByCustomer]);
  const topBed = ov.topSellers?.BEDFRAME ?? [];
  const topSofa = ov.topSellers?.SOFA ?? [];

  // Period-over-period deltas (last vs previous month in the series) for the
  // Sales + Invoices cards — month-over-month, shown only on the All-time view.
  const pctDelta = (cur: number, prev: number): number | null =>
    prev > 0 ? ((cur - prev) / prev) * 100 : null;
  const lastR = rev[rev.length - 1];
  const prevR = rev[rev.length - 2];
  const salesDelta = lastR
    ? pctDelta(lastR.salesOrderSen, prevR?.salesOrderSen ?? 0)
    : null;
  const invoiceDelta = lastR
    ? pctDelta(lastR.invoiceSen, prevR?.invoiceSen ?? 0)
    : null;

  // Customer revenue concentration — top 6 + "Others" (financial-
  // report style: who is our revenue actually coming from?).
  // custCat toggle re-derives revenue per customer for bedframe/sofa slices.
  // Each item carries _catRev (category-scoped revenue in sen) for sorting,
  // donut, and Total column — always 0 when category has no activity.
  type AovWithCatRev = NonNullable<Overview["aovByCustomer"]>[number] & {
    _catRev: number;
  };
  const aovFiltered = useMemo<AovWithCatRev[]>(() => {
    return aovAll
      .map((a) => {
        const catRev =
          custCat === "bedframe"
            ? a.bedframeAvgSen * a.bedframeUnits
            : custCat === "sofa"
              ? a.sofaAvgSen * a.sofaSets
              : a.totalSen;
        return { ...a, _catRev: catRev };
      })
      .sort((a, b) =>
        custCat === "all" ? 0 : b._catRev - a._catRev,
      );
  }, [aovAll, custCat]);

  const totalCustRev = useMemo(
    () => aovFiltered.reduce((s, a) => s + a._catRev, 0),
    [aovFiltered],
  );

  const pieData = useMemo(() => {
    const src = (custCat === "all" ? aovFiltered : aovFiltered.filter((a) => a._catRev > 0))
      .map((a) => ({ name: a.customerName, value: a._catRev }));
    const top6 = src.slice(0, 6);
    const othersRev = src.slice(6).reduce((s, a) => s + a.value, 0);
    return othersRev > 0
      ? [...top6, { name: "Others", value: othersRev }]
      : top6;
  }, [aovFiltered, custCat]);

  // Pipeline conversion rate — follows the same period-scoped values as the
  // Order Pipeline widget (month figures for a month, all-time otherwise).
  const deliveredRate =
    pipeConfirmed > 0 ? (pipeDelivered / pipeConfirmed) * 100 : 0;

  // Per-customer monthly AOV (drill-through for Customer Value rows).
  const aovMonthly = ov.aovMonthlyByCustomer ?? {};
  const tsByCust = ov.topSellersByCustomer;

  // Only the overview fetch gates the first paint — it is snapshot-backed
  // and fast. While it resolves, show a layout-shaped skeleton instead of a
  // bare centred string, so the page never flashes empty.
  if (overviewLoading) {
    return (
      <div className="space-y-5">
        <p className="sr-only">Loading Dashboard</p>
        <SkeletonDashboard />
      </div>
    );
  }

  // Flow-KPI labels follow the selected period: All-time → cumulative total,
  // current month → "This Month", a past month → that month. The state KPIs
  // (Outstanding / Pending Delivery) are point-in-time and carry a "live" tag.
  const isAllTime = period === "all";
  const isCurrentMonth = period === CUR_YM;
  // This Month Sales — confirmed-SO value for the selected month (all-time =
  // cumulative). Owner 2026-06-12 kept this card alongside Invoices.
  const salesLabel = isAllTime
    ? "Total Sales"
    : isCurrentMonth
      ? "This Month Sales"
      : `Sales · ${period}`;
  const salesSub = isAllTime
    ? "all-time · confirmed SO"
    : isCurrentMonth
      ? "confirmed SO · current month"
      : `${period} · confirmed SO`;
  // This Month Invoices — invoice-sourced (Σ invoice totals by invoice date),
  // not DO/shipped-value. Owner 2026-06-12: "it captures straight from
  // Invoices — when I deliver, the invoice is issued." Replaces the old
  // delivered/shipped-value card.
  const invoicesLabel = isAllTime
    ? "Total Invoices"
    : isCurrentMonth
      ? "This Month Invoices"
      : `Invoices · ${period}`;
  const invoicesSub = isAllTime
    ? "all-time · issued (by invoice date)"
    : isCurrentMonth
      ? "issued this month"
      : `${period} · issued (by invoice date)`;

  // Labels for the month-aware ROLLING widgets (Revenue, Daily Capacity,
  // Completed, Worker Efficiency). All-time keeps each widget's original
  // rolling phrase; a selected month shows the month string.
  const revTitle = isAllTime ? "Revenue — last 12 weeks" : `Revenue — ${period}`;
  const capacityWindowLabel = isAllTime ? "7-day avg" : `${period} avg`;
  const capacityDrillTitle = isAllTime
    ? "Daily Capacity — Past 7 Working Days"
    : `Daily Capacity — ${period}`;
  const completedDrillTitle = isAllTime
    ? "Completed — last 7 days"
    : `Completed — ${period}`;
  // Completed headline: all-time shows yesterday's live pulse; a selected month
  // (current or past) shows that month's RUNNING TOTAL, summed from the per-day
  // series the backend already returns for the whole month range.
  const completedMonthBf = (prod?.completedLast7 ?? []).reduce(
    (s, d) => s + (d.bedframeUnits || 0),
    0,
  );
  const completedMonthSofa = (prod?.completedLast7 ?? []).reduce(
    (s, d) => s + (d.sofaSets || 0),
    0,
  );
  const completedHeadBf = isAllTime
    ? (prod?.completedYesterday?.bedframeUnits ?? 0)
    : completedMonthBf;
  const completedHeadSofa = isAllTime
    ? (prod?.completedYesterday?.sofaSets ?? 0)
    : completedMonthSofa;
  const completedHeadlineLabel = isAllTime
    ? "Completed yest."
    : `Completed · ${period}`;
  const completedHintLabel = isAllTime ? "· view 7d" : "· view days";
  const effSub = isAllTime
    ? "production mins ÷ clocked hours · last 7 working days"
    : `production mins ÷ clocked hours · ${period}`;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-y-2">
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
          {(months.includes(CUR_YM) ? months : [CUR_YM, ...months]).map((m) => (
            <option key={m} value={m}>
              {m === CUR_YM ? `This month (${m})` : m}
            </option>
          ))}
        </select>
      </div>

      {/* KPI rail — four cards: This Month Sales · This Month Invoices ·
          Pending Delivery (consolidated) · Outstanding. Sales = confirmed-SO
          value; Invoices = invoice-sourced (owner 2026-06-12: "it captures
          straight from Invoices — when I deliver, the invoice is issued"), which
          replaced the old shipped-value Delivered card. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 max-[360px]:grid-cols-1">
        {/* This Month Sales — confirmed-SO value for the selected month
            (all-time = cumulative). Owner 2026-06-12 kept this alongside the
            Invoices card. */}
        <KTile
          label={salesLabel}
          value={rm(ov.salesThisMonthSen)}
          sub={salesSub}
          icon={DollarSign}
          accent={C_SO}
          spark={soSpark}
          delta={isMonthScoped ? null : salesDelta}
        />
        {/* This Month Invoices — Σ invoice totals (excl. cancelled) by invoice
            date for the selected month (all-time = cumulative). Invoice-sourced,
            not DO/shipped-value. Responds to the month selector like the rest. */}
        <KTile
          label={invoicesLabel}
          value={rm(ov.invoicesThisMonthSen)}
          sub={invoicesSub}
          icon={FileText}
          accent={C_PROD}
          spark={invSpark}
          delta={isMonthScoped ? null : invoiceDelta}
        />
        {/* Pending Delivery (consolidated) — one card for everything made but
            not yet delivered: pending delivery (made, not on a dispatched DO)
            + pending dispatch (DRAFT DOs) + dispatched / in-transit (on the
            road). A live as-of-now figure (the DO fetch is not period-scoped),
            so it folds the live dispatch-chain money for every selected period.
            Owner 2026-06-12. */}
        <KTile
          label="Pending Delivery"
          value={rm(
            pendingDeliveryValueSen +
              dispatchChain.pendingDispatchSen +
              dispatchChain.inTransitSen,
          )}
          sub="made / on DO, not yet delivered"
          icon={Package}
          accent={C_GREEN}
          loading={pendingL}
          tag="live"
        />
        <KTile
          label="Outstanding"
          value={rm(outstanding)}
          sub="confirmed · not yet delivered"
          icon={Clock}
          accent={C_INV}
          loading={soL}
          tag="live"
        />
      </div>

      {/* Daily Report — process / SOP exceptions summary. Independent fetch;
          links to the full /daily-report page. */}
      <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="rounded-xl bg-[#F5F2ED] p-3">
                <ClipboardCheck className="h-6 w-6 text-[#6B5C32]" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#5A5550]">
                  Daily Report
                </p>
                {compL && !compCounts ? (
                  <Skeleton height={30} width={64} className="mt-1" />
                ) : (
                  <p
                    className={`mt-0.5 text-3xl font-[800] tabular-nums leading-none ${
                      (compCounts?.total ?? 0) === 0
                        ? "text-[#15803D]"
                        : "text-[#1F1D1B]"
                    }`}
                  >
                    {compCounts?.total ?? 0}
                  </p>
                )}
                <p className="text-xs text-[#9CA3AF] mt-1">
                  {(compCounts?.total ?? 0) === 0
                    ? "All clear — nothing flagged today"
                    : "process & SOP exceptions to action today"}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {compCounts &&
                (
                  // Every category behind the headline, biggest first.
                  //
                  // This list used to omit five of the fourteen — including the
                  // three LARGEST (SO not invoiced 139, pricing issues 114,
                  // COGS issues 39). With `.slice(0,4)` taking the first four in
                  // declaration order rather than by size, the chips added up to
                  // 35 under a headline of 380: 9% of it, and none of the parts
                  // anyone would act on first.
                  [
                    ["Overdue", compCounts.overdueOrders],
                    ["SO not invoiced", compCounts.soNoInvoice],
                    ["Pricing issues", compCounts.pricingIssues],
                    ["COGS issues", compCounts.cogsIssues],
                    ["DO not invoiced", compCounts.doNotInvoiced],
                    ["DO pending dispatch", compCounts.doPendingDispatch],
                    ["DO not delivered", compCounts.doNotDelivered],
                    ["SO no DO", compCounts.soNoDo],
                    ["PO not received", compCounts.poNotReceived],
                    ["Low efficiency", compCounts.lowEfficiencyWorkers],
                    ["Process skips", compCounts.processSkips],
                    ["Missing WIP times", compCounts.missingWipTimes],
                    ["Incomplete BOMs", compCounts.incompleteBoms],
                    ["R&D stalled", compCounts.rdStalled],
                  ] as const
                )
                  .filter(([, n]) => (n ?? 0) > 0)
                  .slice()
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .slice(0, 4)
                  .map(([label, n]) => (
                    <span
                      key={label}
                      className="inline-flex items-center gap-1 rounded-full border border-[#FCA5A5] bg-[#FEE2E2] px-2.5 py-1 text-[11px] font-semibold text-[#B91C1C]"
                    >
                      {label}
                      <span className="tabular-nums">{n}</span>
                    </span>
                  ))}
              <Link
                to="/daily-report"
                className="inline-flex items-center gap-1 rounded-md bg-[#6B5C32] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#4D4224]"
              >
                View Daily Report
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* The Morning Brief · CNC Queue card was removed on 2026-08-05 at the
          owner's instruction ("CNCQ remove 掉"). The brief itself still exists
          and is still emailed at 07:00 MYT — `/api/reports/brief` is unchanged
          — it is the dashboard TILE that is gone. Its headline was a queue in
          CNC minutes with drift pills reading "BEDFRAME speed +466%", which is
          not a number anyone could act on from here. */}

      {/* Revenue + Plant load */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title={revTitle}
              sub="Sales Orders · Invoices · Production · click a legend to toggle"
              right={
                <div className="flex flex-wrap gap-3 text-xs">
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
            <div className="min-w-0" style={{ width: "100%", height: 260 }}>
              {revChart.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-[#9CA3AF]">
                  No revenue data.
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center h-full text-xs text-[#9CA3AF]">
                      Loading chart…
                    </div>
                  }
                >
                  <RevenueChart
                    data={revChart}
                    hiddenSeries={hiddenSeries}
                    cSO={C_SO}
                    cProd={C_PROD}
                    cInv={C_INV}
                  />
                </Suspense>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5 flex flex-col items-center">
            <SectionTitle title="Plant Load" sub="backlog vs daily capacity" />
            {stateLiveTag && (
              <span
                title="Backlog, Active Jobs and Workforce are point-in-time counts. No daily snapshot was stored for this past month, so the current live figures are shown — not that month's true state."
                className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#FBF3E2] px-2 py-0.5 text-[10px] font-medium text-[#9A7B2E]"
              >
                <Info className="h-3 w-3" />
                live (no history before today)
              </span>
            )}
            {stateReconstructed && (
              <span
                title="No daily snapshot was stored for this past month. Backlog and Workforce are reconstructed as of the month's last day from job-card and worker records — a best-effort estimate, not a captured figure. (Active Jobs stays on the current live value.)"
                className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#EEF1F4] px-2 py-0.5 text-[10px] font-medium text-[#5B6675]"
              >
                <Info className="h-3 w-3" />
                ≈ reconstructed (month-end est.)
              </span>
            )}
            {stateAsOf && (
              <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#EEF3EE] px-2 py-0.5 text-[10px] font-medium text-[#4B7A52]">
                <Info className="h-3 w-3" />
                as of {stateAsOf}
              </span>
            )}
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
              <div
                className="rounded-lg bg-[#F7F4EF] px-3 py-2"
                title="Queue length as a share of a 2-week (14-day) buffer — 100% means two full weeks of work are queued. Not a machine/worker utilization figure."
              >
                <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  Queue vs 14d
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
                onClick={() => {
                  if (!prod?.capacityDays) return;
                  const days = prod.capacityDays;
                  // 7-day average capacity per worker — avg daily capacity
                  // ÷ avg workers/day. Days with zero credited workers are
                  // left out so they don't distort the average.
                  const wDays = days.filter((d) => (d.workers ?? 0) > 0);
                  const avgWorkers = wDays.length
                    ? wDays.reduce((s, d) => s + (d.workers ?? 0), 0) /
                      wDays.length
                    : 0;
                  const perWorkerAvg =
                    avgWorkers > 0
                      ? hm(Math.round(prod.dailyCapacityMin / avgWorkers))
                      : "—";
                  setDrill({
                    title: capacityDrillTitle,
                    subtitle: `Average ${hm(prod.dailyCapacityMin)}/day · ${perWorkerAvg}/worker across all production depts`,
                    node: (
                      <MiniTable
                        cols={[
                          "Date",
                          "Production time",
                          "Workers",
                          "Per Worker",
                          "vs Avg",
                        ]}
                        rows={[...days]
                          .sort((a, b) => a.date.localeCompare(b.date))
                          .map((d) => {
                            const diff = d.minutes - prod.dailyCapacityMin;
                            const w = d.workers ?? 0;
                            return [
                              d.date,
                              hm(d.minutes),
                              w > 0 ? String(w) : "—",
                              w > 0 ? hm(Math.round(d.minutes / w)) : "—",
                              `${diff >= 0 ? "+" : "−"}${hm(Math.abs(diff))}`,
                            ];
                          })}
                      />
                    ),
                  });
                }}
                className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Factory className="h-4 w-4 text-[#6B5C32]" />
                  <span className="text-xs text-[#5A5550]">
                    Daily Capacity{" "}
                    <span className="text-[#C2BBAE]">· {capacityWindowLabel}</span>
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
                          d.backlogDays == null ? "stalled" : `${d.backlogDays.toLocaleString()}d`,
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
                    title: completedDrillTitle,
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
                    {completedHeadlineLabel}{" "}
                    <span className="text-[#C2BBAE]">{completedHintLabel}</span>
                  </span>
                </span>
                <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                  {completedHeadBf.toLocaleString()} /{" "}
                  {completedHeadSofa.toLocaleString()}
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
              title={isMonthScoped ? `Order Pipeline — ${period}` : "Order Pipeline"}
              sub={
                isMonthScoped
                  ? `${period} orders — shipped vs still to ship`
                  : "confirmed → outstanding → delivered"
              }
              right={
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                    Delivered rate
                  </p>
                  {soL ? (
                    <Skeleton height={20} width={56} className="ml-auto" />
                  ) : (
                    <p className="text-base font-bold text-[#15803D]">
                      {deliveredRate.toFixed(1)}%
                    </p>
                  )}
                </div>
              }
            />
            {soL ? (
              <SectionRowsSkeleton rows={3} />
            ) : (
              <>
                {[
                  { k: "Confirmed", v: pipeConfirmed, c: C_SO, pct: 100 },
                  {
                    k: "Outstanding",
                    v: pipeOutstanding,
                    c: C_PROD,
                    pct:
                      pipeConfirmed > 0
                        ? (pipeOutstanding / pipeConfirmed) * 100
                        : 0,
                  },
                  {
                    k: "Delivered",
                    v: pipeDelivered,
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
                  {rm(pipeOutstanding)} still to ship of {rm(pipeConfirmed)}{" "}
                  confirmed{isMonthScoped ? ` · ${period}` : ""}.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardContent className="p-5">
            <SectionTitle
              title="Worker Efficiency"
              sub={effSub}
            />
            {effL ? (
              <SectionRowsSkeleton rows={5} />
            ) : (
            <div className="grid grid-cols-2 gap-5 max-sm:grid-cols-1">
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
            )}
          </CardContent>
        </Card>
      </div>

      {/* Revenue by Customer — financial-report concentration exhibit */}
      <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
        <CardContent className="p-5">
          <SectionTitle
            title="Sales by Customer & Month"
            sub={
              custCat === "all"
                ? "avg order value — bedframe (per unit) vs sofa (per set) · click a customer for the monthly breakdown"
                : custCat === "bedframe"
                  ? "bedframe only — avg per unit · click a customer for the monthly breakdown"
                  : "sofa only — avg per set · click a customer for the monthly breakdown"
            }
            right={
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1">
                  {(
                    [
                      ["all", "All"],
                      ["bedframe", "Bedframe"],
                      ["sofa", "Sofa"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setCustCat(v)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        custCat === v
                          ? "bg-[#6B5C32] text-white"
                          : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-[#9CA3AF]">
                  Total{" "}
                  <span className="font-semibold text-[#1F1D1B]">
                    {rm(totalCustRev)}
                  </span>
                </span>
              </div>
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
                  className="lg:col-span-2 relative min-w-0"
                  style={{ width: "100%", height: 340 }}
                >
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center h-full text-xs text-[#9CA3AF]">
                        Loading chart…
                      </div>
                    }
                  >
                    <CustomerPieChart
                      data={pieData}
                      pieColors={PIE_COLORS}
                      totalCustRev={totalCustRev}
                    />
                  </Suspense>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
                      Top 3
                    </span>
                    <span className="text-3xl font-[800] text-[#1F1D1B]">
                      {(
                        (aovFiltered
                          .filter((a) => custCat === "all" || a._catRev > 0)
                          .slice(0, 3)
                          .reduce((s, a) => s + a._catRev, 0) /
                          Math.max(1, totalCustRev)) *
                        100
                      ).toFixed(0)}
                      %
                    </span>
                  </div>
                </div>
                <div className="lg:col-span-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] text-[#9CA3AF] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Customer</th>
                        {custCat !== "sofa" && (
                          <>
                            <th className="py-1.5 font-medium text-right">
                              Bedframe AOV
                            </th>
                            <th className="py-1.5 font-medium text-right">
                              Units
                            </th>
                          </>
                        )}
                        {custCat !== "bedframe" && (
                          <>
                            <th className="py-1.5 font-medium text-right">
                              Sofa AOV
                            </th>
                            <th className="py-1.5 font-medium text-right">
                              Sets
                            </th>
                          </>
                        )}
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
                          {custCat !== "sofa" && (
                            <>
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
                            </>
                          )}
                          {custCat !== "bedframe" && (
                            <>
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
                            </>
                          )}
                          <td className="py-1.5 text-right font-bold text-[#1F1D1B] tabular-nums">
                            {/* Category modes use totalCustRev — the SAME
                                per-customer Σ as the header Total and the
                                rows below. Company-level avg × count rounds
                                differently and showed a few-sen mismatch on
                                the same card. */}
                            {custCat === "all"
                              ? rm(ov.aovCompany.totalSen)
                              : rm(totalCustRev)}
                          </td>
                        </tr>
                      )}
                      {aovFiltered.slice(0, 10).map((a, i) => {
                        const monthly = aovMonthly[a.customerName];
                        const hasMonthly = !!(
                          monthly && monthly.length > 0
                        );
                        // Monthly drill-down: aovMonthlyByCustomer has
                        // per-category fields so we can filter them. The
                        // "Total" column in the drill modal always shows the
                        // blended monthly total because the monthly payload
                        // does not include a totalSen field — only
                        // bedframeAvgSen*units and sofaAvgSen*sets.
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
                        // Row total follows the selected category (_catRev
                        // equals totalSen when custCat === "all").
                        const rowTotal = a._catRev;
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
                            {custCat !== "sofa" && (
                              <>
                                <td className="py-1.5 text-right text-[#1F1D1B] tabular-nums">
                                  {a.bedframeUnits
                                    ? rm(a.bedframeAvgSen)
                                    : "—"}
                                </td>
                                <td className="py-1.5 text-right text-[#9CA3AF] tabular-nums">
                                  {a.bedframeUnits
                                    ? a.bedframeUnits.toLocaleString()
                                    : "—"}
                                </td>
                              </>
                            )}
                            {custCat !== "bedframe" && (
                              <>
                                <td className="py-1.5 text-right text-[#1F1D1B] tabular-nums">
                                  {a.sofaSets ? rm(a.sofaAvgSen) : "—"}
                                </td>
                                <td className="py-1.5 text-right text-[#9CA3AF] tabular-nums">
                                  {a.sofaSets
                                    ? a.sofaSets.toLocaleString()
                                    : "—"}
                                </td>
                              </>
                            )}
                            <td className="py-1.5 text-right font-semibold text-[#1F1D1B] tabular-nums">
                              {rm(rowTotal)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              {/* Monthly multi-month bedframe/sofa strip removed 2026-06-05 —
                  owner views one month at a time and doesn't need the
                  cross-month breakdown here. */}
              <p className="mt-3 text-[11px] text-[#9CA3AF]">
                Concentration:{" "}
                <span className="font-semibold text-[#1F1D1B]">
                  Top 3 ={" "}
                  {(
                    (aovFiltered
                      .filter((a) => custCat === "all" || a._catRev > 0)
                      .slice(0, 3)
                      .reduce((s, a) => s + a._catRev, 0) /
                      Math.max(1, totalCustRev)) *
                    100
                  ).toFixed(0)}
                  %
                </span>{" "}
                ·{" "}
                <span className="font-semibold text-[#1F1D1B]">
                  Top 5 ={" "}
                  {(
                    (aovFiltered
                      .filter((a) => custCat === "all" || a._catRev > 0)
                      .slice(0, 5)
                      .reduce((s, a) => s + a._catRev, 0) /
                      Math.max(1, totalCustRev)) *
                    100
                  ).toFixed(0)}
                  %
                </span>{" "}
                of total{" "}
                {custCat !== "all" ? `${custCat} ` : ""}
                customer revenue ({rm(totalCustRev)}).
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
            <div className="grid grid-cols-2 gap-5 max-sm:grid-cols-1">
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
        <div className="flex items-end justify-between mb-3 flex-wrap gap-y-2">
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
          <div className="flex items-center gap-2 flex-wrap">
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
                    <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] text-[#9CA3AF] border-b border-[#F0ECE6]">
                          <th className="font-medium pb-1.5">Fabric</th>
                          <th className="font-medium pb-1.5 text-right">
                            {fabMode === "next" ? "Next 30d" : "Used"}
                            {/* Next-30d is a rolling window anchored to TODAY, not
                                the selected month — tag it live so a past-month
                                view isn't misread (owner 2026-06-27). "Used" IS
                                month-scoped, so it stays untagged. */}
                            {fabMode === "next" && (
                              <span className="ml-1 text-[8px] uppercase tracking-wide text-[#C9A961]">
                                live
                              </span>
                            )}
                          </th>
                          <th className="font-medium pb-1.5 text-right">
                            Past 30d
                            <span className="ml-1 text-[8px] uppercase tracking-wide text-[#C9A961]">
                              live
                            </span>
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
                    </div>
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
            {stateLiveTag && (
              <span
                title="Backlog is a point-in-time count. No daily snapshot was stored for this past month, so the current live figures are shown — not that month's true state."
                className="mb-2 inline-flex items-center gap-1 rounded-full bg-[#FBF3E2] px-2 py-0.5 text-[10px] font-medium text-[#9A7B2E]"
              >
                <Info className="h-3 w-3" />
                live (no history before today)
              </span>
            )}
            {stateReconstructed && (
              <span
                title="No daily snapshot was stored for this past month. This backlog is reconstructed as of the month's last day from job-card records — a best-effort estimate, not a captured figure."
                className="mb-2 inline-flex items-center gap-1 rounded-full bg-[#EEF1F4] px-2 py-0.5 text-[10px] font-medium text-[#5B6675]"
              >
                <Info className="h-3 w-3" />
                ≈ reconstructed (month-end est.)
              </span>
            )}
            {stateAsOf && (
              <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-[#EEF3EE] px-2 py-0.5 text-[10px] font-medium text-[#4B7A52]">
                <Info className="h-3 w-3" />
                as of {stateAsOf}
              </span>
            )}
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
              // 2026-05-25: bar widths now scale by DAYS-to-clear, not by
              // raw work minutes. Wei Siang reported: "22.8d 的 bar 比 8.7d
              // 还短" — because Fabric Sewing had high work-minutes (long
              // bar) but ALSO high capacity (low days), while Foam Bonding
              // had less work-minutes (short bar) but tiny capacity (high
              // days). The right-side label is days, so the operator
              // intuitively expects bar length to match. Per-segment days
              // = segment minutes / dept's daily capacity; the bar's two
              // segments now sum to `showDays` and each row's total bar
              // width is proportional to the biggest dept's wait days.
              const rows = (prod?.backlogByDept ?? []).map((d) => {
                // dailyCapMin === 0 → "stalled" (no completions in the rolling
                // window). Never divide by a 1-minute fallback — that painted
                // thousands of fake days (owner audit 2026-07-11).
                const stalled = !(d.dailyCapMin > 0);
                const cap = stalled ? 1 : d.dailyCapMin;
                const sofaDays = sofaOn && !stalled ? d.sofaMin / cap : 0;
                const bedDays = bedOn && !stalled ? d.bedframeMin / cap : 0;
                const filtered = !(sofaOn && bedOn);
                const showDays = stalled
                  ? null
                  : filtered
                    ? sofaDays + bedDays
                    : d.backlogDays;
                return { d, sofaDays, bedDays, showDays };
              });
              const mxDays = Math.max(1, ...rows.map((r) => r.showDays ?? 0));
              return rows.map(({ d, sofaDays, bedDays, showDays }) => (
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
                          width: `${(sofaDays / mxDays) * 100}%`,
                          background: C_INV,
                        }}
                      />
                    )}
                    {bedOn && (
                      <div
                        className="h-full"
                        style={{
                          width: `${(bedDays / mxDays) * 100}%`,
                          background: C_SO,
                        }}
                      />
                    )}
                  </div>
                  <span className="w-12 text-right text-xs font-semibold text-[#DC2626] tabular-nums" title={showDays == null ? "No completions in the last 7 working days — queue can't be sized in days" : undefined}>
                    {showDays == null ? "stalled" : `${showDays.toFixed(1)}d`}
                  </span>
                </div>
              ));
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

      {/* OCR accuracy — automation-readiness gauge (owner 2026-07-04, placed
          at the bottom of the dashboard). Follows the same `period` dropdown as
          the rest of the Command Center (owner: pick a month → OCR for that month). */}
      <OcrAccuracyCard period={period} range={period === "all" ? null : monthWindow(period)} />

      <p className="text-center text-[11px] text-[#9CA3AF] pt-2">
        Hookka Command Center
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
