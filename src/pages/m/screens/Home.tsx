// ===========================================================================
// Mobile Home / Dashboard
//
// Owner 2026-06-28 ("把我们的 Home 换成 Dashboard 里的资料"): the /m Home KPI cards
// now mirror the DESKTOP Command Center (src/pages/dashboard-b/index.tsx) so a
// manager opening the phone sees the SAME headline numbers. Card set + data
// sources are aligned 1:1 to the dashboard's KPI rail. Card styling (icon tile
// + delta + big tabular number + label) and the Stock-alerts section are kept.
//
// KPI wiring — each card mirrors the dashboard KPI of the same name, off the
// SAME endpoints (current-month scope, the dashboard's default view):
//   • This Month Sales    → /api/dashboard/overview?period=<YYYY-MM>
//                           (salesThisMonthSen). Dashboard: KTile "This Month
//                           Sales". MoM delta from overview.monthlyRevenue.
//   • This Month Invoices → /api/dashboard/overview?period=<YYYY-MM>
//                           (invoicesThisMonthSen). Dashboard: KTile "This
//                           Month Invoices". MoM delta from monthlyRevenue.
//   • Pending Delivery    → consolidated live figure = poReadyForDelivery sum
//                           (/api/production-orders + /api/delivery-orders/
//                           linked-po-ids + /po-values + /api/sales-orders
//                           price-index) + dispatch chain (DRAFT + LOADED +
//                           IN_TRANSIT) from /api/delivery-orders/stats. SAME
//                           computation as the dashboard's Pending Delivery
//                           KTile (via src/lib/delivery-pipeline.ts).
//   • Outstanding         → /api/sales-orders/stats (outstandingItemsSen).
//                           Dashboard: KTile "Outstanding".
//
// Lists (kept):
//   • Stock alerts → /api/inventory (raw materials at/below reorder / low).
//   • Orders due   → /api/sales-orders (soonest Expected DD, non-terminal).
//
// Deltas: Sales / Invoices show the real month-over-month % from the same
// monthlyRevenue series the dashboard's KTile sparkline/delta use. Pending
// Delivery + Outstanding are point-in-time "live" figures (no prior-period
// source on the dashboard either), so no delta — matching the dashboard.
// ===========================================================================
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DollarSign,
  FileText,
  Package,
  Clock,
  Truck,
  Plus,
  PackageCheck,
  HardHat,
  Bell,
  Search as SearchIcon,
  CircleAlert,
  TriangleAlert,
  ClipboardCheck,
  Calendar,
  CircleCheck,
  ChevronDown,
  Check,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import {
  SO_STATUS_COLOR,
  type SemanticStyle,
} from "@/lib/design-tokens";
import {
  poReadyForDelivery,
  type PipelinePO,
} from "@/lib/delivery-pipeline";
import type { SalesOrder, RawMaterial } from "@/types";
import { MobileCard, StatusPill, FormSheet, Sheet } from "../components";
import { GlobalSearchSheet } from "../components/GlobalSearchSheet";
import { M, M_ACCENT, M_DELTA } from "../theme";
import { type FormSpec } from "../config/form-types";
import {
  newSalesOrderSpec,
  newDeliveryOrderSpec,
  newPurchaseOrderSpec,
} from "../config/forms";

// ---------- API response shapes (subset of the desktop dashboard's) ----------
type StatsResp = {
  success?: boolean;
  byStatus?: Record<string, number>;
  revenueByStatus?: Record<string, number>;
  csRevenueSen?: number;
  deliveredItemsSen?: number;
  outstandingItemsSen?: number;
};
type JobsBreakdown = { bedframeUnits: number; sofaSets: number };
type OverviewResp = {
  success?: boolean;
  salesThisMonthSen?: number;
  invoicesThisMonthSen?: number;
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen?: number;
    productionSen?: number;
  }[];
  // Per-DAY (period=YYYY-MM) revenue buckets — x-axis for the Revenue chart.
  weeklyRevenue?: {
    week: string; // "YYYY-MM-DD" — day-start for a month period
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
  // ---- Command Center analytics (owner 2026-06-28 design v11) ----
  // The SAME fields the desktop dashboard-b consumes. Optional everywhere —
  // each analytics section guards its own data and renders nothing if absent
  // (we never fabricate a chart).
  aovByCustomer?: {
    customerName: string;
    totalSen: number;
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
  }[];
  aovCompany?: { totalSen: number };
  topSellers?: {
    BEDFRAME?: { productCode: string; productName?: string; qtySold: number; valueSen: number }[];
    SOFA?: { model: string; setsSold: number; valueSen: number }[];
  };
  fabricCostPerMeterSen?: { bedframe: number; sofa: number };
  fabric?: {
    BEDFRAME?: { list?: { fabCode: string; fabName?: string; meters: number; costSen?: number; buyAvgSen: number }[] };
    SOFA?: { list?: { fabCode: string; fabName?: string; meters: number; costSen?: number; buyAvgSen: number }[] };
  };
  employee?: { activeHeadcount: number };
  purchasing?: {
    openPOCount: number;
    spendThisMonthSen: number;
    topSuppliers: { name: string; spendSen: number }[];
  };
  production?: {
    dailyCapacityMin?: number;
    backlogDays?: number;
    backlogGrandMin?: number;
    activeJobs?: JobsBreakdown;
    completedYesterday?: JobsBreakdown;
    backlogByDept?: {
      dept: string;
      totalMin: number;
      dailyCapMin: number;
      // null = stalled (zero completions in the rolling window)
      backlogDays: number | null;
    }[];
  };
};
// Worker-Efficiency support shapes — mirror the desktop dashboard-b fetches.
type JcSummaryResp = {
  data?: { workerId: string; productionMinutes: number }[];
};
type WheSummaryResp = {
  data?: {
    workerId: string;
    totalHours: number;
    byDept: Record<string, number>;
    daysWithEntries?: number;
  }[];
};
type WorkersResp = {
  data?: { id: string; name: string; departmentCode?: string }[];
};
// Subset of /api/purchase-orders row shape — only the fields the Daily Report
// "PO not received" chip needs.
type SOListResp = { success?: boolean; data?: SalesOrder[] };
type InventoryResp = {
  success?: boolean;
  data?: { rawMaterials?: RawMaterial[] };
};
// Pending Delivery support shapes — mirror the dashboard's fetches.
type PODeliveryShape = PipelinePO & {
  salesOrderId?: string;
  productCode?: string;
  quantity?: number;
};
type POResp = { success?: boolean; data?: PODeliveryShape[] };
type POValuesResp = { success?: boolean; values?: Record<string, number> };
type SOItemsResp = {
  success?: boolean;
  data?: {
    id: string;
    items?: { productCode?: string; unitPriceSen?: number }[];
  }[];
};
type DoStatsResp = { valueByStatus?: Record<string, number> };

// Statuses excluded from the Orders-due list + on-time derivation (terminal).
const TERMINAL_STATUSES = new Set([
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "CANCELLED",
]);

/** Current "YYYY-MM" — the period selector's default + the dashboard's
 * Command Center period. */
const CUR_YM = new Date().toISOString().slice(0, 7);

/** Short month labels used by the period-selector chip and picker. */
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function periodLabel(ym: string): string {
  const yr = ym.slice(0, 4);
  const m = Number(ym.slice(5, 7));
  return m >= 1 && m <= 12 ? `${MONTHS_SHORT[m - 1]} ${yr}` : ym;
}
/** Build the last 12 months (descending) for the period-picker sheet. */
function buildPeriodOptions(): { ym: string; label: string }[] {
  const opts: { ym: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    opts.push({ ym, label: periodLabel(ym) });
  }
  return opts;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- Worker Efficiency (ported 1:1 from src/pages/dashboard-b/index.tsx) ----
// eff% = production minutes ÷ (production-dept clocked hours × 60). Only the
// eight production departments count toward the denominator.
const PROD_DEPTS = new Set([
  "FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM",
  "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING",
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

/**
 * Date range for the selected "YYYY-MM" worker-efficiency window:
 * [1st .. month end], capped at today for the current month. Same logic as
 * dashboard-b's monthWindow().
 */
function monthWindow(ym: string): { from: string; to: string } {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  const yr = Number(ym.slice(0, 4));
  const mo = Number(ym.slice(5, 7)); // 1-12
  const from = iso(new Date(yr, mo - 1, 1));
  const lastDay = new Date(yr, mo, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const to = ym === CUR_YM && today < lastDay ? iso(today) : iso(lastDay);
  return { from, to };
}

/** min → "Nh" (rounded hours), thousands-separated. */
function hrs(min: number): string {
  return `${Math.round((min || 0) / 60).toLocaleString()}h`;
}

/** Compact "RM 12.03" for per-metre fabric cost (sen → RM, 2dp). */
function rm2(sen: number): string {
  return `RM ${((sen || 0) / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Donut palette for Sales-by-Customer — module scope so the useMemo's deps
 * don't re-trigger on every render. Professional financial-report scheme
 * (navy → teal → steel).
 */
const SBC_COLORS = ["#16425B", "#1F6E8C", "#2E8FA3", "#4FA8B8", "#7FB9C6", "#A9C7D0"];

/** Local time-of-day greeting (design says "Good morning,"). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning,";
  if (h < 18) return "Good afternoon,";
  return "Good evening,";
}

export default function MobileHome() {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const firstName = (user?.displayName || "there").split(" ")[0];
  // Fold-like wide landscape (dc12 design v12 Fold variant) — show the KPI
  // rail as 4 columns instead of 2×2. Other dashboard cards stay stacked
  // vertically (the design has a 2-col grid there too — bigger refactor,
  // deferred).
  const fold = useMediaQuery("(min-width: 720px) and (orientation: landscape)");

  // Quick-action create form: holds the active FormSpec, or null. "Staff" has
  // no in-scope create endpoint, so it routes to the Employees directory.
  const [formSpec, setFormSpec] = useState<FormSpec | null>(null);
  // Global search overlay (CHANGELOG O.1) — fans out across the localStorage
  // cache that preload.ts warmed at /m mount.
  const [searchOpen, setSearchOpen] = useState(false);

  // ---- Pending Delivery is the ONLY expensive section of this Home: it needs
  // five heavy fetches (production-orders + linked-po-ids + po-values +
  // price-index + delivery stats). To keep first paint instant, we defer those
  // five fetches until AFTER the Home is interactive: `pdEnabled` starts false
  // (so the gated useCachedJson calls receive a null URL = skip-fetch) and
  // flips true on the first idle callback (setTimeout fallback for browsers
  // without requestIdleCallback). The cheap KPI cards + Stock alerts + Orders
  // due fetch immediately and paint right away. ----
  const [pdEnabled, setPdEnabled] = useState(false);
  // ---- Analytics period (dc12 design v12: header chip "Jun 2026 ▾"). Drives
  // /api/dashboard/overview + the worker-efficiency window. Defaults to the
  // current month so first paint matches the desktop Command Center. ----
  const [period, setPeriod] = useState(CUR_YM);
  const [pickerOpen, setPickerOpen] = useState(false);
  const periodOptions = useMemo(() => buildPeriodOptions(), []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    type RIC = (cb: () => void, opts?: { timeout?: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: RIC })
      .requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(() => setPdEnabled(true), { timeout: 1500 });
      const cic = (
        window as unknown as { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback;
      return () => {
        if (typeof cic === "function") cic(id);
      };
    }
    const t = window.setTimeout(() => setPdEnabled(true), 200);
    return () => window.clearTimeout(t);
  }, []);

  const { data: stats } = useCachedJson<StatsResp>("/api/sales-orders/stats");
  // Current-month overview = the dashboard's default Command Center period, so
  // salesThisMonthSen / invoicesThisMonthSen match the desktop KPI rail.
  const { data: overview } = useCachedJson<OverviewResp>(
    `/api/dashboard/overview?period=${period}`,
  );
  // Whole-table SO list (server caps at 5000; current ~350 SOs). Used for the
  // Orders-due list.
  const { data: soList } = useCachedJson<SOListResp>("/api/sales-orders");
  const { data: inventory } = useCachedJson<InventoryResp>("/api/inventory");

  // ---- Pending Delivery — SAME fetches + computation as the dashboard's
  // consolidated "Pending Delivery" KTile (src/lib/delivery-pipeline.ts).
  // Lazy-loaded: each URL is gated on `pdEnabled` — until the Home is
  // interactive we pass null, which useCachedJson treats as skip-fetch (see
  // cached-fetch.ts: a null URL returns data:null/loading:false and the effect
  // early-returns without firing a request). The hooks are ALWAYS called
  // (never conditionally), only the URL flips from null to the real endpoint. ----
  const { data: poRaw } = useCachedJson<POResp>(
    pdEnabled ? "/api/production-orders?fields=minimal&include=jobCards" : null,
  );
  const { data: linkedRaw } = useCachedJson<{ poIds?: string[] }>(
    pdEnabled ? "/api/delivery-orders/linked-po-ids" : null,
  );
  const { data: poValRaw } = useCachedJson<POValuesResp>(
    pdEnabled ? "/api/delivery-orders/po-values" : null,
  );
  const { data: soItemsRaw } = useCachedJson<SOItemsResp>(
    pdEnabled ? "/api/sales-orders?fields=price-index" : null,
  );
  const { data: doStatsRaw } = useCachedJson<DoStatsResp>(
    pdEnabled ? "/api/delivery-orders/stats" : null,
  );

  // ---- Worker Efficiency — 3 extra fetches (job-card prod mins + clocked
  // hours + worker directory), merged exactly like the desktop dashboard-b.
  // Gated behind the same `pdEnabled` idle flag so first paint stays the KPI
  // rail. Window = current month [1st..today]. ----
  const effWin = useMemo(() => monthWindow(period), [period]);
  const { data: jcSumRaw } = useCachedJson<JcSummaryResp>(
    pdEnabled ? `/api/job-cards/summary?from=${effWin.from}&to=${effWin.to}` : null,
  );
  const { data: wheSumRaw } = useCachedJson<WheSummaryResp>(
    pdEnabled
      ? `/api/working-hour-entries/summary?from=${effWin.from}&to=${effWin.to}`
      : null,
  );
  const { data: workersRaw } = useCachedJson<WorkersResp>(
    pdEnabled ? "/api/workers" : null,
  );
  // Daily Report chips now read the SAME compliance engine the desktop Daily
  // Report + Command Center card use (owner tally audit 2026-07-11). The old
  // client-side re-derivations used different date columns / status sets / a
  // 70% low-efficiency bar (desktop uses 60%), so the phone's total never
  // matched the desktop's. One source of truth: /api/reports/compliance.json.
  const { data: complianceRaw } = useCachedJson<{
    success?: boolean;
    data?: {
      counts?: {
        overdueOrders?: number;
        soNoDo?: number;
        poNotReceived?: number;
        lowEfficiencyWorkers?: number;
      };
    };
  }>(pdEnabled ? "/api/reports/compliance.json" : null);

  // ---- KPI: This Month Sales (confirmed-SO value, current month) ----
  const salesThisMonthSen = overview?.salesThisMonthSen ?? 0;
  // ---- KPI: This Month Invoices (issued, by invoice date, current month) ----
  const invoicesThisMonthSen = overview?.invoicesThisMonthSen ?? 0;
  // ---- KPI: Outstanding (confirmed sales value not yet delivered) ----
  const outstandingSen = stats?.outstandingItemsSen ?? 0;

  // ---- KPI: Pending Delivery (consolidated, live) — byte-identical to the
  // dashboard: poReadyForDelivery value + DRAFT/LOADED/IN_TRANSIT DO value. ----
  const pendingDeliverySen = useMemo(() => {
    const pos = poRaw?.success ? poRaw.data ?? [] : [];
    // Guard the loading flash: until linkedRaw lands, an empty set would wrongly
    // count every PO as still-pending — bail to 0 (matches the dashboard).
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
    let readySen = 0;
    for (const po of pos) {
      if (!poReadyForDelivery(po, linkedPOIds)) continue;
      readySen +=
        poValMap.get(po.id) ??
        (soPriceByProduct.get(po.salesOrderId || "")?.get(
          po.productCode || "",
        ) ?? 0) * (po.quantity || 0);
    }
    // Dispatch chain (owner 2026-06-11): DRAFT DOs (pending dispatch) +
    // LOADED/IN_TRANSIT (on the road) fold into Pending Delivery.
    const v = doStatsRaw?.valueByStatus ?? {};
    const dispatchChain =
      (v.DRAFT ?? 0) + (v.LOADED ?? 0) + (v.IN_TRANSIT ?? 0);
    return readySen + dispatchChain;
  }, [poRaw, linkedRaw, poValRaw, soItemsRaw, doStatsRaw]);

  // Pending Delivery shows a placeholder until its lazy fetches resolve: true
  // while deferred (pdEnabled false) and while any of the five datasets is
  // still in flight. Once all land, the real value renders (same computation).
  const pendingDeliveryLoading =
    !pdEnabled ||
    !poRaw ||
    !linkedRaw ||
    !poValRaw ||
    !soItemsRaw ||
    !doStatsRaw;

  // ---- Sales month-over-month delta (This Month Sales card) ----
  const salesDeltaPct = useMemo(() => {
    const rev = overview?.monthlyRevenue ?? [];
    if (rev.length < 2) return null;
    const cur = rev[rev.length - 1]?.salesOrderSen ?? 0;
    const prev = rev[rev.length - 2]?.salesOrderSen ?? 0;
    if (prev <= 0) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }, [overview]);

  // ---- Invoices month-over-month delta (This Month Invoices card) ----
  const invoiceDeltaPct = useMemo(() => {
    const rev = overview?.monthlyRevenue ?? [];
    if (rev.length < 2) return null;
    const cur = rev[rev.length - 1]?.invoiceSen ?? 0;
    const prev = rev[rev.length - 2]?.invoiceSen ?? 0;
    if (prev <= 0) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }, [overview]);

  // ---- Orders due (derived from the live SO list) ----
  const orders = useMemo(
    () => (soList?.success ? soList.data ?? [] : []),
    [soList],
  );

  const ordersDue = useMemo(() => {
    const today = todayISO();
    return orders
      .filter(
        (so) => !TERMINAL_STATUSES.has(so.status) && !!so.hookkaExpectedDD,
      )
      .sort((a, b) =>
        (a.hookkaExpectedDD || "").localeCompare(b.hookkaExpectedDD || ""),
      )
      .slice(0, 6)
      .map((so) => ({
        so,
        overdue: (so.hookkaExpectedDD || "").slice(0, 10) < today,
      }));
  }, [orders]);

  // ---- Daily Report — dc12 design v12 chip set (4 exceptions). ----
  // Counts come straight from the compliance engine so phone == desktop
  // (owner tally audit 2026-07-11). Chips with 0 hide.
  const complianceCounts = complianceRaw?.data?.counts;
  const overdueCount = complianceCounts?.overdueOrders ?? 0;
  const soNoDoCount = complianceCounts?.soNoDo ?? 0;
  const poNotReceivedCount = complianceCounts?.poNotReceived ?? 0;

  // ---- Order Pipeline (this month) — Confirmed / Outstanding / Delivered. ----
  // Real figures off /api/sales-orders/stats (the SAME totals the desktop
  // Command Center uses): Confirmed = csRevenueSen, Outstanding =
  // outstandingItemsSen, Delivered = deliveredItemsSen. Bars are scaled to the
  // largest of the three. Delivered RATE = delivered ÷ confirmed.
  const pipeline = useMemo(() => {
    const confirmed = stats?.csRevenueSen ?? 0;
    const outstanding = stats?.outstandingItemsSen ?? 0;
    const delivered = stats?.deliveredItemsSen ?? 0;
    const max = Math.max(confirmed, outstanding, delivered, 1);
    const bars = [
      { label: "Confirmed", sen: confirmed, color: M.taupe },
      { label: "Outstanding", sen: outstanding, color: M.gold },
      { label: "Delivered", sen: delivered, color: M_DELTA.up },
    ].map((p) => ({ ...p, pct: Math.round((p.sen / max) * 100) }));
    const ratePct = confirmed > 0 ? (delivered / confirmed) * 100 : null;
    return {
      bars,
      ratePct,
      note:
        confirmed > 0
          ? `${formatCurrency(outstanding)} still to ship of ${formatCurrency(
              confirmed,
            )} confirmed · ${period}`
          : null,
    };
  }, [stats, period]);

  // ---- Command Center analytics (owner 2026-06-28 design v12) ----
  // Revenue / Plant Load / Worker Efficiency / Sales by Customer / Top Sellers
  // / Fabric Usage / Department Backlog / Purchasing. Read from the SAME
  // /api/dashboard/overview payload already fetched for the KPI rail (+ the
  // three worker-efficiency fetches), mirroring the desktop dashboard-b
  // figures. The heavy fetches are gated behind `pdEnabled` (the
  // post-first-paint idle flag) so the first paint stays the KPI cards only;
  // each card's JSX guards its own null state (no extra ready flag needed).

  // ---- Revenue — 3-line area chart (Sales Orders / Invoices / Production).
  // Per-DAY x-axis off overview.weeklyRevenue (the backend buckets per day
  // when period=YYYY-MM). Each series is an SVG polyline; the first VISIBLE
  // series gets an area fill. Legend toggles are local state (revHide). ----
  const REV_W = 320, REV_H = 132;
  const revenue = useMemo(() => {
    const pts = overview?.weeklyRevenue ?? [];
    if (pts.length === 0) return null;
    const n = pts.length;
    const series = [
      { key: "so" as const, label: "Sales Orders", color: "#5E5129", dash: "", vals: pts.map((p) => p.salesOrderSen) },
      { key: "prod" as const, label: "Production", color: "#C9A961", dash: "", vals: pts.map((p) => p.productionSen) },
      { key: "inv" as const, label: "Invoices", color: "#BBB2A4", dash: "4 3", vals: pts.map((p) => p.invoiceSen) },
    ];
    const max = Math.max(1, ...series.flatMap((s) => s.vals));
    const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * REV_W);
    const y = (v: number) => REV_H - (v / max) * REV_H;
    const lines = series.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      dash: s.dash,
      points: s.vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "),
    }));
    // x-axis day labels (DD), thinned to ~10 ticks so they don't crowd.
    const step = Math.max(1, Math.ceil(n / 10));
    const days = pts
      .map((p, i) => ({ d: (p.week || "").slice(8, 10), i }))
      .filter((_, i) => i % step === 0);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: (REV_H * f).toFixed(1) }));
    return { lines, series, x, y, days, grid, last: pts[n - 1] };
  }, [overview]);
  // Local legend toggle — hide a revenue series by key.
  const [revHide, setRevHide] = useState<Record<string, boolean>>({});

  // ---- Plant Load (gauge + 4 rows) — all from overview.production. ----
  // QUEUE-LOAD % is a DERIVED ratio of real numbers (NOT a stored field):
  //   load% = clamp(0..100, backlogGrandMin ÷ dailyCapacityMin × 10)
  // i.e. the total queued minutes expressed against ~10 days of capacity
  // (10 working days = a sensible "full" plant horizon), clamped to 100.
  const plant = useMemo(() => {
    const p = overview?.production;
    if (!p) return null;
    const dailyCap = p.dailyCapacityMin ?? 0;
    const backlogMin = p.backlogGrandMin ?? 0;
    const loadPct =
      dailyCap > 0
        ? Math.max(0, Math.min(100, Math.round((backlogMin / (dailyCap * 10)) * 100)))
        : null;
    return {
      queue: p.backlogDays != null ? `${p.backlogDays.toFixed(1)}d` : "—",
      loadPct,
      workforce: overview?.employee?.activeHeadcount ?? null,
      rows: [
        { label: "Daily Capacity", sub: `${period} avg`, value: dailyCap ? hrs(dailyCap) : "—", icon: Calendar },
        {
          label: "Total Backlog",
          sub: "per dept",
          value:
            p.backlogDays != null
              ? `${p.backlogDays.toFixed(1)}d · ${hrs(backlogMin)}`
              : "—",
          icon: CircleAlert,
        },
        {
          label: "Active Jobs",
          sub: "pending",
          value: p.activeJobs
            ? `${p.activeJobs.bedframeUnits} / ${p.activeJobs.sofaSets}`
            : "—",
          icon: Package,
        },
        {
          label: "Completed",
          sub: `${period}`,
          value: p.completedYesterday
            ? `${p.completedYesterday.bedframeUnits} / ${p.completedYesterday.sofaSets}`
            : "—",
          icon: CircleCheck,
        },
      ],
    };
  }, [overview, period]);

  // ---- Worker Efficiency (TOP 5 + LOWEST 5) — ported 1:1 from dashboard-b:
  // eff% = production minutes ÷ (production-dept clocked hours × 60). Excludes
  // non-production depts from the denominator. ----
  const workerEff = useMemo(() => {
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
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.pct - a.pct);
    return { top: rows.slice(0, 5), low: rows.slice(-5).reverse() };
  }, [jcSumRaw, wheSumRaw, workersRaw]);

  // Low efficiency: production workers with eff% < 70 this period (the same
  // band Worker Efficiency card colours red). Daily-report chips + total
  // assembled here once all source counts (above + workerEff just-declared)
  // are in scope.
  // Low-efficiency threshold + population come from the compliance engine
  // (60%, yesterday's window) — the phone previously used 70% on live data,
  // so its count never matched the desktop Daily Report.
  const lowEffCount = complianceCounts?.lowEfficiencyWorkers ?? 0;
  const dailyReportTotal =
    overdueCount + soNoDoCount + poNotReceivedCount + lowEffCount;
  const dailyChips = [
    { label: "Overdue", count: overdueCount, to: "/m/sales" },
    { label: "SO no DO", count: soNoDoCount, to: "/m/sales" },
    { label: "PO not received", count: poNotReceivedCount, to: "/m/procurement" },
    { label: "Low efficiency", count: lowEffCount, to: "/m/employees" },
  ].filter((c) => c.count > 0);

  // ---- Sales by Customer (avg order value, donut top-3, category tabs). ----
  const [sbcCat, setSbcCat] = useState<"all" | "bedframe" | "sofa">("all");
  const salesByCustomer = useMemo(() => {
    const list = overview?.aovByCustomer ?? [];
    if (list.length === 0) return null;
    // Category filter is FE-side: pick which total field ranks the rows.
    const totalOf = (c: NonNullable<OverviewResp["aovByCustomer"]>[number]) =>
      sbcCat === "bedframe"
        ? c.bedframeAvgSen * c.bedframeUnits
        : sbcCat === "sofa"
          ? c.sofaAvgSen * c.sofaSets
          : c.totalSen;
    const rows = list
      .map((c) => ({ c, t: totalOf(c) }))
      .filter((r) => r.t > 0)
      .sort((a, b) => b.t - a.t)
      .slice(0, 5);
    if (rows.length === 0) return null;
    const sum = rows.reduce((a, r) => a + r.t, 0) || 1;
    const enriched = rows.map((r, i) => ({
      name: r.c.customerName || "—",
      total: r.t,
      pct: Math.round((r.t / sum) * 100),
      color: SBC_COLORS[i % SBC_COLORS.length],
      sub: `Bedframe ${rm2(r.c.bedframeAvgSen)} · Sofa ${
        r.c.sofaSets > 0 ? rm2(r.c.sofaAvgSen) : "—"
      }`,
    }));
    // Donut conic-gradient over the top rows; top-3 share = first three pcts.
    let acc = 0;
    const donut = enriched
      .map((r) => {
        const seg = `${r.color} ${acc}% ${acc + r.pct}%`;
        acc += r.pct;
        return seg;
      })
      .join(", ");
    const top3 = enriched.slice(0, 3).reduce((a, r) => a + r.pct, 0);
    const company = overview?.aovCompany?.totalSen ?? sum;
    return { rows: enriched, donut: `conic-gradient(${donut})`, top3, total: company };
  }, [overview, sbcCat]);

  // ---- Top Sellers — BEDFRAME by units, SOFA by sets (code + qty + amount). ----
  const topSellers = useMemo(() => {
    const bed = (overview?.topSellers?.BEDFRAME ?? []).slice(0, 5).map((b) => ({
      code: b.productCode,
      qty: `×${b.qtySold}`,
      amt: formatCurrency(b.valueSen || 0),
    }));
    const sofa = (overview?.topSellers?.SOFA ?? []).slice(0, 5).map((s) => ({
      code: s.model,
      qty: `×${s.setsSold} sets`,
      amt: formatCurrency(s.valueSen || 0),
    }));
    if (bed.length === 0 && sofa.length === 0) return null;
    return { bed, sofa };
  }, [overview]);

  // ---- Fabric Usage — BEDFRAME + SOFA (code, metres used, avg cost/m). ----
  const fabricUsage = useMemo(() => {
    const f = overview?.fabric;
    const fc = overview?.fabricCostPerMeterSen;
    if (!f) return null;
    const mapRow = (r: { fabCode: string; meters: number; costSen?: number; buyAvgSen: number }) => ({
      code: r.fabCode,
      used: `${Math.round(r.meters || 0).toLocaleString()} m`,
      // avg cost/m = buyAvgSen, falling back to costSen/meters when present.
      avg: rm2(
        r.buyAvgSen ||
          (r.meters > 0 && r.costSen ? Math.round(r.costSen / r.meters) : 0),
      ),
    });
    const bed = (f.BEDFRAME?.list ?? []).slice(0, 5).map(mapRow);
    const sofa = (f.SOFA?.list ?? []).slice(0, 5).map(mapRow);
    if (bed.length === 0 && sofa.length === 0) return null;
    return {
      bed,
      sofa,
      bedAvg: fc?.bedframe ? rm2(fc.bedframe) : "—",
      sofaAvg: fc?.sofa ? rm2(fc.sofa) : "—",
    };
  }, [overview]);

  // ---- Department Backlog — per-dept days, bottleneck first. ----
  const deptBacklog = useMemo(() => {
    const depts = overview?.production?.backlogByDept ?? [];
    if (depts.length === 0) return null;
    // backlogDays === null = "stalled" (no completions in the window) — sorts
    // first as the loudest flag, rendered as text instead of a fake number.
    const sorted = depts
      .slice()
      .sort((a, b) => (b.backlogDays ?? Infinity) - (a.backlogDays ?? Infinity));
    const max = Math.max(...sorted.map((d) => d.backlogDays ?? 0), 1);
    return sorted.map((d, i) => ({
      dept: d.dept,
      days: d.backlogDays == null ? "stalled" : `${d.backlogDays.toFixed(1)}d`,
      pct: d.backlogDays == null ? 100 : Math.round((d.backlogDays / max) * 100),
      // Bottleneck (#1) red; hot (>20d) gold; rest brown — matches the design.
      color: i === 0 ? "#9A3A2D" : (d.backlogDays ?? Infinity) > 20 ? "#C9A961" : "#5E5129",
      dColor: i === 0 ? "#9A3A2D" : M.ink,
    }));
  }, [overview]);

  // ---- Purchasing — open POs, spend/month, top suppliers. ----
  const purchasing = useMemo(() => {
    const p = overview?.purchasing;
    if (!p) return null;
    return {
      openPOs: p.openPOCount ?? 0,
      spend: formatCurrency(p.spendThisMonthSen ?? 0),
      suppliers: (p.topSuppliers ?? []).slice(0, 5).map((s) => ({
        name: s.name,
        amt: formatCurrency(s.spendSen || 0),
      })),
    };
  }, [overview]);

  // ---- Stock alerts (raw materials at or below reorder / low threshold) ----
  const stockAlerts = useMemo(() => {
    const rms = inventory?.data?.rawMaterials ?? [];
    return rms
      .filter((rm) => {
        if (rm.isActive === false) return false;
        const qty = Number(rm.balanceQty) || 0;
        const min = typeof rm.minStock === "number" ? rm.minStock : null;
        return min != null && min > 0 ? qty <= min : qty < 5;
      })
      .sort((a, b) => (Number(a.balanceQty) || 0) - (Number(b.balanceQty) || 0))
      .slice(0, 5);
  }, [inventory]);

  return (
    <div style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {/* ===== Header — greeting + avatar + bell ===== */}
      <div style={{ padding: "12px 18px 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {/* Brand tile — matches the ERP-mobile app icon (black bg, white "H",
              squircle corner). Owner 2026-06-28: use the erp-mobile logo, same
              rounding as the white-bg app icon. */}
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 11,
              background: "#1F1D1B",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}
          >
            <span style={{ fontWeight: 800, color: "#fff", fontSize: 19 }}>
              H
            </span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: M.muted }}>{greeting()}</div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: M.raisin,
                letterSpacing: "-0.3px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {firstName}
            </div>
          </div>
          {/* Period chip — dc12 design v12: tap to pick last 12 months,
              re-fetches every analytics card under it. Defaults to current
              month so first paint matches the desktop Command Center. */}
          <button
            aria-label="Pick analytics period"
            onClick={() => setPickerOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flex: "none",
              height: 34,
              padding: "0 11px",
              borderRadius: 11,
              backgroundColor: M.card,
              border: `1px solid ${M.hairline}`,
              fontSize: 12,
              fontWeight: 700,
              color: M.taupe,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {periodLabel(period)}
            <ChevronDown size={14} strokeWidth={1.75} color={M.taupe} />
          </button>
          {/* Global Search — CHANGELOG O.1. Opens GlobalSearchSheet which
              fans out across the preloaded localStorage cache (every
              endpoint in preload.ts). Searchable: customer / PO / SO /
              reference / doc number — across every module. */}
          <button
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              backgroundColor: M.card,
              border: `1px solid ${M.hairline}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <SearchIcon size={20} strokeWidth={1.75} color={M.ink} />
          </button>
          {/* Notification bell (round white button, unread dot) */}
          <button
            aria-label="Notifications"
            // TODO(wave-x): wire to a real notifications surface (none in /m yet).
            onClick={() => navigate("/m/announcements")}
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              backgroundColor: M.card,
              border: `1px solid ${M.hairline}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              flex: "none",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <Bell size={20} strokeWidth={1.75} color={M.ink} />
            <span
              style={{
                position: "absolute",
                top: 8,
                right: 9,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#C0463A",
                border: "1.5px solid #fff",
              }}
            />
          </button>
        </div>
      </div>

      <div style={{ padding: "0 18px" }}>
        {/* ===== Quick actions (FIRST per dc13 order) ===== */}
        <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
          <QuickAction
            icon={Plus}
            accent="gold"
            label="New SO"
            onClick={() => setFormSpec(newSalesOrderSpec())}
          />
          <QuickAction
            icon={Truck}
            accent="info"
            label="Delivery"
            onClick={() => setFormSpec(newDeliveryOrderSpec())}
          />
          <QuickAction
            icon={PackageCheck}
            accent="moss"
            label="Receive"
            onClick={() => setFormSpec(newPurchaseOrderSpec())}
          />
          <QuickAction
            icon={HardHat}
            accent="plum"
            label="Staff"
            // No staff-create endpoint is in scope. Route to the directory.
            onClick={() => navigate("/m/employees")}
          />
        </div>

        {/* ===== KPI grid — 2×2 on phone, 1×4 on fold (dc13 sizing — was
            too loose at 25px font, dc13 uses 18px + tighter padding). ===== */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: fold ? "repeat(4, 1fr)" : "1fr 1fr",
            gap: 9,
            marginTop: 11,
          }}
        >
          {/* Mirrors dashboard KTile "This Month Sales" (overview.salesThisMonthSen). */}
          <KpiCard
            icon={DollarSign}
            accent="gold"
            label="This Month Sales"
            value={formatCurrency(salesThisMonthSen)}
            delta={
              salesDeltaPct == null
                ? null
                : {
                    text: `${salesDeltaPct >= 0 ? "+" : ""}${salesDeltaPct}% MoM`,
                    good: salesDeltaPct >= 0,
                  }
            }
          />
          {/* Mirrors dashboard KTile "This Month Invoices" (overview.invoicesThisMonthSen). */}
          <KpiCard
            icon={FileText}
            accent="info"
            label="This Month Invoices"
            value={formatCurrency(invoicesThisMonthSen)}
            delta={
              invoiceDeltaPct == null
                ? null
                : {
                    text: `${invoiceDeltaPct >= 0 ? "+" : ""}${invoiceDeltaPct}% MoM`,
                    good: invoiceDeltaPct >= 0,
                  }
            }
          />
          {/* Mirrors dashboard KTile "Pending Delivery" (consolidated live). */}
          <KpiCard
            icon={Package}
            accent="moss"
            label="Pending Delivery"
            // Lazy-loaded after first paint — show a placeholder until its five
            // deferred fetches resolve, then the real (dashboard-identical) value.
            value={pendingDeliveryLoading ? "…" : formatCurrency(pendingDeliverySen)}
            // Live point-in-time figure — no prior-period delta (as on desktop).
            delta={null}
          />
          {/* Mirrors dashboard KTile "Outstanding" (stats.outstandingItemsSen). */}
          <KpiCard
            icon={Clock}
            accent="danger"
            label="Outstanding"
            value={formatCurrency(outstandingSen)}
            // Live point-in-time figure — no prior-period delta (as on desktop).
            delta={null}
          />
        </div>

        {/* ===== Daily Report — dc12: total + 4 chips (Overdue / SO no DO /
            PO not received / Low efficiency). Each chip taps through to the
            relevant module screen. Chips with 0 count hide. */}
        <MobileCard
          radius={16}
          style={{ padding: "15px 16px", marginTop: 14 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                background: M_ACCENT.gold.bg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              <ClipboardCheck size={20} strokeWidth={1.75} color={M.taupe} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 1,
                  color: "#A89F8D",
                }}
              >
                DAILY REPORT
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  color: M.raisin,
                  letterSpacing: "-0.4px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {dailyReportTotal}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: M.muted, marginTop: 3 }}>
            process &amp; SOP exceptions to action today
          </div>
          {dailyChips.length > 0 ? (
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 11 }}
            >
              {dailyChips.map((c) => (
                <span
                  key={c.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(c.to);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      navigate(c.to);
                    }
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: M_ACCENT.danger.fg,
                    background: M_ACCENT.danger.bg,
                    border: "1px solid #E8B2A1",
                    padding: "3px 9px",
                    borderRadius: 20,
                    cursor: "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {c.label} <b>{c.count}</b>
                </span>
              ))}
            </div>
          ) : null}
        </MobileCard>

        {/* ===== Revenue — 3-line area chart (per-day x-axis) ===== */}
        {revenue ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
              Revenue · {periodLabel(period)}
            </div>
            <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
              Sales Orders · Invoices · Production · tap a legend to toggle
            </div>
            <div style={{ display: "flex", gap: 14, margin: "12px 0 8px" }}>
              {revenue.lines.map((l) => {
                const hidden = !!revHide[l.key];
                return (
                  <span
                    key={l.key}
                    onClick={() =>
                      setRevHide((p) => ({ ...p, [l.key]: !p[l.key] }))
                    }
                    style={{
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      color: hidden ? M.faint : M.body,
                      fontWeight: 600,
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: hidden ? "#E2DDD8" : l.color,
                      }}
                    />
                    {l.label}
                  </span>
                );
              })}
            </div>
            <svg
              viewBox={`0 0 ${REV_W} ${REV_H}`}
              width="100%"
              height="148"
              preserveAspectRatio="none"
            >
              {revenue.grid.map((g, i) => (
                <line
                  key={`g${i}`}
                  x1="0"
                  y1={g.y}
                  x2={REV_W}
                  y2={g.y}
                  stroke="#F2EEE6"
                  strokeWidth="1"
                />
              ))}
              {revenue.lines
                .filter((l) => !revHide[l.key])
                .map((l) => (
                  <polyline
                    key={l.key}
                    points={l.points}
                    fill="none"
                    stroke={l.color}
                    strokeWidth="2"
                    strokeDasharray={l.dash || undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
            </svg>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 4,
              }}
            >
              {revenue.days.map((d, i) => (
                <span
                  key={`d${i}`}
                  style={{ fontSize: 8.5, color: "#A89F8D" }}
                >
                  {d.d}
                </span>
              ))}
            </div>
          </MobileCard>
        ) : null}

        {/* ===== Plant Load — gauge + workforce/queue-load + 4 rows ===== */}
        {plant ? (
          <MobileCard radius={16} style={{ padding: 16, marginTop: 14 }}>
            <div
              style={{
                textAlign: "center",
                fontSize: 14.5,
                fontWeight: 700,
                color: M.raisin,
              }}
            >
              Plant Load
            </div>
            <div
              style={{
                textAlign: "center",
                fontSize: 11,
                color: M.muted,
                marginTop: 2,
              }}
            >
              backlog vs daily capacity
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                margin: "16px 0",
              }}
            >
              <div style={{ position: "relative", width: 140, height: 140 }}>
                <div
                  style={{
                    width: 140,
                    height: 140,
                    borderRadius: "50%",
                    transform: "rotate(135deg)",
                    background: `conic-gradient(#9A3A2D 0% ${
                      plant.loadPct ?? 0
                    }%, #F0EBE0 ${plant.loadPct ?? 0}% 100%)`,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: 18,
                    left: 18,
                    width: 104,
                    height: 104,
                    borderRadius: "50%",
                    background: "#fff",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 28,
                      fontWeight: 800,
                      color: M.raisin,
                      letterSpacing: -1,
                    }}
                  >
                    {plant.queue}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1,
                      color: "#A89F8D",
                    }}
                  >
                    QUEUE
                  </span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
              <PlantStat
                label="WORKFORCE"
                value={plant.workforce != null ? String(plant.workforce) : "—"}
              />
              <PlantStat
                label="QUEUE LOAD"
                value={plant.loadPct != null ? `${plant.loadPct}%` : "—"}
                color="#9A3A2D"
              />
            </div>
            {plant.rows.map((r, i) => {
              const Icon = r.icon;
              return (
                <div
                  key={`pr${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 2px",
                    borderTop: `1px solid ${M.divider}`,
                  }}
                >
                  <Icon size={16} strokeWidth={1.75} color="#9A9082" />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      color: M.body,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.label}{" "}
                    <span style={{ color: "#A89F8D", fontWeight: 500 }}>
                      · {r.sub}
                    </span>
                  </span>
                  <span
                    style={{
                      flex: "none",
                      fontSize: 12.5,
                      fontWeight: 800,
                      color: M.raisin,
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.value}
                  </span>
                </div>
              );
            })}
          </MobileCard>
        ) : null}

        {/* ===== Order Pipeline — header + rate badge + bars + note ===== */}
        <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
                Order Pipeline · {periodLabel(period)}
              </div>
              <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
                shipped vs still to ship
              </div>
            </div>
            {pipeline.ratePct != null ? (
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    color: "#A89F8D",
                  }}
                >
                  DELIVERED RATE
                </div>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 800,
                    color: M_DELTA.up,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {Math.round(pipeline.ratePct)}%
                </div>
              </div>
            ) : null}
          </div>
          <div style={{ marginTop: 14 }}>
            {pipeline.bars.map((p) => (
              <div
                key={p.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    width: 74,
                    flex: "none",
                    fontSize: 12,
                    color: M.body,
                    fontWeight: 600,
                  }}
                >
                  {p.label}
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 14,
                    background: "#F0EBE0",
                    borderRadius: 5,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: `${p.pct}%`,
                      height: "100%",
                      background: p.color,
                      borderRadius: 5,
                    }}
                  />
                </span>
                <span
                  style={{
                    width: 108,
                    flex: "none",
                    textAlign: "right",
                    fontSize: 12,
                    fontWeight: 700,
                    color: M.raisin,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatCurrency(p.sen)}
                </span>
              </div>
            ))}
          </div>
          {pipeline.note ? (
            <div style={{ fontSize: 11, color: M.muted, marginTop: 6 }}>
              {pipeline.note}
            </div>
          ) : null}
        </MobileCard>

        {/* ===== Worker Efficiency — TOP 5 + LOWEST 5 ===== */}
        {workerEff ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
              Worker Efficiency
            </div>
            <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
              production mins ÷ clocked hours · {periodLabel(period)}
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: M_DELTA.up,
                margin: "13px 0 3px",
                letterSpacing: 0.5,
              }}
            >
              TOP 5
            </div>
            {workerEff.top.map((w, i) => (
              <WorkerRow key={`wt${i}`} w={w} first={i === 0} />
            ))}
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: M_DELTA.down,
                margin: "14px 0 3px",
                letterSpacing: 0.5,
              }}
            >
              LOWEST 5
            </div>
            {workerEff.low.map((w, i) => (
              <WorkerRow key={`wl${i}`} w={w} first={i === 0} />
            ))}
          </MobileCard>
        ) : null}

        {/* ===== Sales by Customer — category tabs + donut + rows ===== */}
        {salesByCustomer ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
              Sales by Customer
            </div>
            <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
              avg order value · bedframe/unit vs sofa/set
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 11 }}>
              {(["all", "bedframe", "sofa"] as const).map((k) => {
                const active = sbcCat === k;
                return (
                  <span
                    key={k}
                    onClick={() => setSbcCat(k)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 8,
                      fontSize: 11.5,
                      fontWeight: 700,
                      cursor: "pointer",
                      border: `1px solid ${active ? "#5E5129" : M.hairline}`,
                      background: active ? "#5E5129" : "#fff",
                      color: active ? "#fff" : M.body,
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    {k === "all" ? "All" : k === "bedframe" ? "Bedframe" : "Sofa"}
                  </span>
                );
              })}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                margin: "15px 0",
              }}
            >
              <div
                style={{
                  position: "relative",
                  width: 104,
                  height: 104,
                  flex: "none",
                }}
              >
                <div
                  style={{
                    width: 104,
                    height: 104,
                    borderRadius: "50%",
                    background: salesByCustomer.donut,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: 22,
                    left: 22,
                    width: 60,
                    height: 60,
                    borderRadius: "50%",
                    background: "#fff",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 9,
                      color: "#A89F8D",
                      fontWeight: 700,
                    }}
                  >
                    TOP 3
                  </span>
                  <span
                    style={{
                      fontSize: 16,
                      fontWeight: 800,
                      color: M.raisin,
                    }}
                  >
                    {salesByCustomer.top3}%
                  </span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: M.muted }}>Total</div>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    color: M.raisin,
                    letterSpacing: -0.4,
                  }}
                >
                  {formatCurrency(salesByCustomer.total)}
                </div>
              </div>
            </div>
            {salesByCustomer.rows.map((r, i) => (
              <div
                key={`sbc${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "9px 0",
                  borderTop: i === 0 ? "none" : `1px solid ${M.divider}`,
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    background: r.color,
                    flex: "none",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: M.raisin,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.name}{" "}
                    <span style={{ color: "#A89F8D", fontWeight: 600 }}>
                      · {r.pct}%
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: M.muted,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.sub}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 800,
                    color: M.raisin,
                    flex: "none",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatCurrency(r.total)}
                </span>
              </div>
            ))}
          </MobileCard>
        ) : null}

        {/* ===== Top Sellers — BEDFRAME by units · SOFA by sets ===== */}
        {topSellers ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
              Top Sellers
            </div>
            <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
              bedframe by units · sofa by sets
            </div>
            {topSellers.bed.length > 0 ? (
              <>
                <SubHead label="BEDFRAME" />
                {topSellers.bed.map((t, i) => (
                  <SellerRow key={`tb${i}`} t={t} first={i === 0} />
                ))}
              </>
            ) : null}
            {topSellers.sofa.length > 0 ? (
              <>
                <SubHead label="SOFA" />
                {topSellers.sofa.map((t, i) => (
                  <SellerRow key={`ts${i}`} t={t} first={i === 0} />
                ))}
              </>
            ) : null}
          </MobileCard>
        ) : null}

        {/* ===== Fabric Usage — BEDFRAME + SOFA (code, metres, avg/m) ===== */}
        {fabricUsage ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
                Fabric Usage
              </div>
              <div style={{ fontSize: 11, color: M.muted }}>avg cost /m</div>
            </div>
            {fabricUsage.bed.length > 0 ? (
              <>
                <SubHead label={`BEDFRAME · ${fabricUsage.bedAvg}`} />
                {fabricUsage.bed.map((f, i) => (
                  <FabricRow key={`fb${i}`} f={f} first={i === 0} />
                ))}
              </>
            ) : null}
            {fabricUsage.sofa.length > 0 ? (
              <>
                <SubHead label={`SOFA · ${fabricUsage.sofaAvg}`} />
                {fabricUsage.sofa.map((f, i) => (
                  <FabricRow key={`fs${i}`} f={f} first={i === 0} />
                ))}
              </>
            ) : null}
          </MobileCard>
        ) : null}

        {/* ===== Department Backlog — bottleneck first ===== */}
        {deptBacklog ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
              Department Backlog
            </div>
            <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
              active work vs daily capacity · bottleneck first
            </div>
            <div style={{ marginTop: 13 }}>
              {deptBacklog.map((d, i) => (
                <div
                  key={`db${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 9,
                  }}
                >
                  <span
                    style={{
                      width: 84,
                      flex: "none",
                      fontSize: 11.5,
                      color: M.body,
                      fontWeight: 600,
                    }}
                  >
                    {d.dept}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      height: 10,
                      background: "#F0EBE0",
                      borderRadius: 5,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: `${d.pct}%`,
                        height: "100%",
                        background: d.color,
                        borderRadius: 4,
                      }}
                    />
                  </span>
                  <span
                    style={{
                      width: 42,
                      flex: "none",
                      textAlign: "right",
                      fontSize: 11.5,
                      fontWeight: 800,
                      color: d.dColor,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {d.days}
                  </span>
                </div>
              ))}
            </div>
          </MobileCard>
        ) : null}

        {/* ===== Purchasing — open POs + month spend + top suppliers ===== */}
        {purchasing ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: M.raisin }}>
              Purchasing
            </div>
            <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
              open POs · spend
            </div>
            <div style={{ display: "flex", gap: 10, margin: "13px 0" }}>
              <PlantStat label="OPEN POS" value={String(purchasing.openPOs)} />
              <PlantStat
                label="SPEND / MONTH"
                value={purchasing.spend}
                size="sm"
              />
            </div>
            {purchasing.suppliers.length > 0 ? (
              <>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#A89F8D",
                    letterSpacing: 0.5,
                    marginBottom: 2,
                  }}
                >
                  TOP SUPPLIERS
                </div>
                {purchasing.suppliers.map((s, i) => (
                  <div
                    key={`sup${i}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 0",
                      borderTop: i === 0 ? "none" : `1px solid ${M.divider}`,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        fontWeight: 600,
                        color: M.raisin,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {s.name}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: M.raisin,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {s.amt}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </MobileCard>
        ) : null}

        {/* ===== Stock alerts ===== */}
        <SectionHeader
          title="Stock alerts"
          right={
            stockAlerts.length > 0 ? (
              <span
                style={{
                  background: M_ACCENT.danger.bg,
                  color: M_ACCENT.danger.fg,
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "2px 9px",
                  borderRadius: 20,
                  border: "1px solid #E8B2A1",
                }}
              >
                {stockAlerts.length} low
              </span>
            ) : undefined
          }
        />
        <MobileCard padded={false} radius={16}>
          {stockAlerts.length === 0 ? (
            <EmptyRow text="No low-stock materials" />
          ) : (
            stockAlerts.map((rm, i) => {
              const qty = Number(rm.balanceQty) || 0;
              const min =
                typeof rm.minStock === "number" ? rm.minStock : null;
              const danger = qty === 0;
              const accent = danger ? M_ACCENT.danger : M_ACCENT.warning;
              const AlertIcon = danger ? CircleAlert : TriangleAlert;
              const last = i === stockAlerts.length - 1;
              return (
                <div
                  key={rm.id}
                  onClick={() => navigate("/m/inventory")}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate("/m/inventory");
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "13px 15px",
                    borderBottom: last
                      ? "none"
                      : `1px solid ${M.divider}`,
                    cursor: "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      background: accent.bg,
                      flex: "none",
                    }}
                  >
                    <AlertIcon size={17} strokeWidth={1.75} color={accent.fg} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: M.raisin,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {rm.description || rm.itemCode}
                    </div>
                    <div style={{ fontSize: 11.5, color: M.muted }}>
                      {rm.itemCode}
                      {rm.itemGroup ? ` · ${rm.itemGroup}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flex: "none" }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: M_ACCENT.danger.fg,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {`${qty} ${rm.baseUOM || ""}`.trim()}
                    </div>
                    <div style={{ fontSize: 10.5, color: M.faint }}>
                      {min != null ? `min ${min}` : "low"}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </MobileCard>

        {/* ===== Orders due ===== */}
        <SectionHeader
          title="Orders due this week"
          right={
            <button
              onClick={() => navigate("/m/sales")}
              style={{
                background: "none",
                border: "none",
                color: M.taupe,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              See all
            </button>
          }
        />
        <div style={{ display: "grid", gap: 10 }}>
          {ordersDue.length === 0 ? (
            <MobileCard padded={false} radius={16}>
              <EmptyRow text="No upcoming orders" />
            </MobileCard>
          ) : (
            ordersDue.map(({ so, overdue }) => (
              <OrderDueCard
                key={so.id}
                so={so}
                overdue={overdue}
                onClick={() => navigate("/m/sales")}
              />
            ))
          )}
        </div>
      </div>

      <div style={{ height: 8 }} />

      {/* Quick-action create forms. On save the sheet closes and we navigate
          to the new document's detail. */}
      <FormSheet
        open={formSpec != null}
        onClose={() => setFormSpec(null)}
        spec={formSpec}
        onSaved={(to) => {
          setFormSpec(null);
          if (to) navigate(to);
        }}
      />

      {/* Global search overlay (CHANGELOG O.1) — Home header's search icon. */}
      <GlobalSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Period picker — dc12: pick from the last 12 months. Tapping a row
          updates `period`, refetches the 9 analytics cards, closes the sheet. */}
      <Sheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Period"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {periodOptions.map((opt) => {
            const active = opt.ym === period;
            return (
              <button
                key={opt.ym}
                onClick={() => {
                  setPeriod(opt.ym);
                  setPickerOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "13px 14px",
                  border: "none",
                  background: active ? M_ACCENT.gold.bg : "transparent",
                  borderRadius: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: active ? 700 : 500,
                    color: active ? M.taupe : M.raisin,
                  }}
                >
                  {opt.label}
                </span>
                {active ? (
                  <Check size={17} strokeWidth={2} color={M.taupe} />
                ) : null}
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}

// --------------------------------------------------------------------------

type AccentKey = keyof typeof M_ACCENT;

function KpiCard({
  icon: Icon,
  accent,
  label,
  value,
  delta,
}: {
  icon: LucideIcon;
  accent: AccentKey;
  label: string;
  value: string;
  delta: { text: string; good: boolean } | null;
}) {
  // dc13 mobile tightening: 13×14 padding · 18px value · 11.5px label ·
  // delta on its own line under the label. Was 15×16 / 25px / 12px / delta
  // in the header row — owner flagged it as "松垮" (too loose).
  const c = M_ACCENT[accent];
  return (
    <MobileCard radius={14} style={{ padding: "13px 14px", minWidth: 0 }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 30,
          borderRadius: 9,
          background: c.bg,
        }}
      >
        <Icon size={16} strokeWidth={1.75} color={c.fg} />
      </span>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: "-0.4px",
          color: M.raisin,
          marginTop: 9,
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: M.ink,
          fontWeight: 600,
          marginTop: 3,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      {delta ? (
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: delta.good ? M_DELTA.up : M_DELTA.down,
            marginTop: 1,
          }}
        >
          {delta.text}
        </div>
      ) : null}
    </MobileCard>
  );
}

function QuickAction({
  icon: Icon,
  accent,
  label,
  onClick,
}: {
  icon: LucideIcon;
  accent: AccentKey;
  label: string;
  onClick: () => void;
}) {
  const c = M_ACCENT[accent];
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        backgroundColor: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: 14,
        padding: "13px 8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 7,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 38,
          height: 38,
          borderRadius: 12,
          background: c.bg,
        }}
      >
        <Icon size={20} strokeWidth={1.75} color={c.fg} />
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: M.ink }}>
        {label}
      </span>
    </button>
  );
}

function SectionHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "22px 2px 11px",
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 700, color: M.raisin }}>
        {title}
      </span>
      {right ?? null}
    </div>
  );
}

function OrderDueCard({
  so,
  overdue,
  onClick,
}: {
  so: SalesOrder;
  overdue: boolean;
  onClick: () => void;
}) {
  const sem: SemanticStyle =
    SO_STATUS_COLOR[so.status as keyof typeof SO_STATUS_COLOR] ??
    SO_STATUS_COLOR.DRAFT;
  const dd = (so.hookkaExpectedDD || "").slice(0, 10);
  return (
    <MobileCard onClick={onClick} radius={15} style={{ padding: "14px 15px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: M.taupe,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {so.companySO || so.companySOId}
        </span>
        <StatusPill style={sem} label={so.status} size="sm" />
      </div>
      <div
        style={{
          fontSize: 14.5,
          fontWeight: 600,
          color: M.raisin,
          marginTop: 7,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {so.customerName}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px solid ${M.divider}`,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            color: overdue ? M_DELTA.down : M.muted,
            fontVariantNumeric: "tabular-nums",
            fontWeight: overdue ? 600 : 400,
          }}
        >
          Exp. DD {dd || "—"}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: M.raisin,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatCurrency(so.totalSen || 0)}
        </span>
      </div>
    </MobileCard>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "20px 14px",
        textAlign: "center",
        color: M.muted,
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}

// ---- v12 dashboard card helpers ----------------------------------------------

/** Small stat tile used inside Plant Load + Purchasing cards. */
function PlantStat({
  label,
  value,
  color,
  size,
}: {
  label: string;
  value: string;
  color?: string;
  size?: "sm";
}) {
  return (
    <div
      style={{
        flex: 1,
        background: M.paper,
        border: `1px solid #EFE9DF`,
        borderRadius: 12,
        padding: 11,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: "#A89F8D",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: size === "sm" ? 15.5 : 18,
          fontWeight: 800,
          color: color ?? M.raisin,
          marginTop: 3,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** Tiny section subhead used inside Top Sellers + Fabric Usage cards. */
function SubHead({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: "#A89F8D",
        margin: "13px 0 2px",
      }}
    >
      {label}
    </div>
  );
}

/** Row in Worker Efficiency card (TOP / LOWEST 5). Colour by efficiency band. */
function WorkerRow({
  w,
  first,
}: {
  w: { name: string; dept: string; pct: number };
  first: boolean;
}) {
  const pctColor =
    w.pct >= 100 ? M_DELTA.up : w.pct >= 70 ? M.gold : M_DELTA.down;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 0",
        borderTop: first ? "none" : `1px solid ${M.divider}`,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontWeight: 600,
          color: M.raisin,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {w.name}{" "}
        <span style={{ color: "#A89F8D", fontWeight: 500 }}>· {w.dept}</span>
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 800,
          color: pctColor,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Math.round(w.pct)}%
      </span>
    </div>
  );
}

/** Row in Top Sellers card. */
function SellerRow({
  t,
  first,
}: {
  t: { code: string; qty: string; amt: string };
  first: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 0",
        borderTop: first ? "none" : `1px solid ${M.divider}`,
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 700, color: M.raisin }}>
        {t.code}
      </span>
      <span style={{ fontSize: 11, color: "#A89F8D" }}>{t.qty}</span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 800,
          color: M.raisin,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {t.amt}
      </span>
    </div>
  );
}

/** Row in Fabric Usage card. */
function FabricRow({
  f,
  first,
}: {
  f: { code: string; used: string; avg: string };
  first: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        borderTop: first ? "none" : `1px solid ${M.divider}`,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontWeight: 600,
          color: M.raisin,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {f.code}
      </span>
      <span style={{ fontSize: 11.5, color: "#9A9082" }}>{f.used}</span>
      <span
        style={{
          width: 74,
          textAlign: "right",
          fontSize: 12,
          fontWeight: 700,
          color: M.raisin,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {f.avg}
      </span>
    </div>
  );
}
