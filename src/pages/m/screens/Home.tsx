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
  CircleAlert,
  TriangleAlert,
  ClipboardCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
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
import { MobileCard, StatusPill, FormSheet } from "../components";
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
type OverviewResp = {
  success?: boolean;
  salesThisMonthSen?: number;
  invoicesThisMonthSen?: number;
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen?: number;
  }[];
  // ---- Command Center analytics (owner 2026-06-28 design v10) ----
  // The SAME fields the desktop dashboard-b consumes. Optional everywhere —
  // each analytics section guards its own data and renders nothing if absent
  // (we never fabricate a chart).
  aovByCustomer?: { customerName: string; totalSen: number }[];
  topSellers?: {
    BEDFRAME?: { productCode: string; qtySold: number }[];
    SOFA?: { model: string; setsSold: number }[];
  };
  production?: {
    backlogByDept?: {
      dept: string;
      totalMin: number;
      dailyCapMin: number;
      backlogDays: number;
    }[];
  };
};
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

/** Current "YYYY-MM" — the dashboard's default Command Center period. */
const CUR_YM = new Date().toISOString().slice(0, 7);

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "YYYY-MM" → short month label ("2026-06" → "Jun"). */
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function monthShort(ym: string): string {
  const m = Number((ym || "").slice(5, 7));
  return m >= 1 && m <= 12 ? MONTHS_SHORT[m - 1] : ym;
}

/** Compact "RM 283K" / "RM 1.2M" for chart headline figures (sen → RM). */
function kFormat(sen: number): string {
  const rm = (sen || 0) / 100;
  if (rm >= 1_000_000) return `RM ${(rm / 1_000_000).toFixed(1)}M`;
  if (rm >= 1_000) return `RM ${Math.round(rm / 1_000)}K`;
  return `RM ${Math.round(rm)}`;
}

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

  // Quick-action create form: holds the active FormSpec, or null. "Staff" has
  // no in-scope create endpoint, so it routes to the Employees directory.
  const [formSpec, setFormSpec] = useState<FormSpec | null>(null);

  // ---- Pending Delivery is the ONLY expensive section of this Home: it needs
  // five heavy fetches (production-orders + linked-po-ids + po-values +
  // price-index + delivery stats). To keep first paint instant, we defer those
  // five fetches until AFTER the Home is interactive: `pdEnabled` starts false
  // (so the gated useCachedJson calls receive a null URL = skip-fetch) and
  // flips true on the first idle callback (setTimeout fallback for browsers
  // without requestIdleCallback). The cheap KPI cards + Stock alerts + Orders
  // due fetch immediately and paint right away. ----
  const [pdEnabled, setPdEnabled] = useState(false);
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
    `/api/dashboard/overview?period=${CUR_YM}`,
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

  // ---- Daily Report (process exceptions to action today) ----
  // Owner 2026-06-28 design adds a "DAILY REPORT" card. We surface ONLY the
  // exception that is genuinely derivable from this Home's live data: overdue
  // sales orders (non-terminal, Expected DD in the past). The design's other
  // chips (SO-no-DO / PO-not-received / Low-efficiency) need cross-module joins
  // not fetched here — left out rather than fabricated.
  // TODO(api): a consolidated /api/dashboard/daily-report would let us show the
  // full chip set (SO no DO, PO not received, low efficiency) with real counts.
  const overdueCount = useMemo(() => {
    const today = todayISO();
    return orders.filter(
      (so) =>
        !TERMINAL_STATUSES.has(so.status) &&
        !!so.hookkaExpectedDD &&
        (so.hookkaExpectedDD || "").slice(0, 10) < today,
    ).length;
  }, [orders]);

  // ---- Order Pipeline (this month) — Confirmed / Outstanding / Delivered. ----
  // Real figures off /api/sales-orders/stats (the SAME totals the desktop
  // Command Center uses): Confirmed = csRevenueSen, Outstanding =
  // outstandingItemsSen, Delivered = deliveredItemsSen. Bars are scaled to the
  // largest of the three.
  const pipeline = useMemo(() => {
    const confirmed = stats?.csRevenueSen ?? 0;
    const outstanding = stats?.outstandingItemsSen ?? 0;
    const delivered = stats?.deliveredItemsSen ?? 0;
    const max = Math.max(confirmed, outstanding, delivered, 1);
    return [
      { label: "Confirmed", sen: confirmed, color: M.taupe },
      { label: "Outstanding", sen: outstanding, color: M.gold },
      { label: "Delivered", sen: delivered, color: M_DELTA.up },
    ].map((p) => ({ ...p, pct: Math.round((p.sen / max) * 100) }));
  }, [stats]);

  // ---- Command Center analytics (owner 2026-06-28 design v10) ----
  // Sales trend / Sales by customer / Top seller / Plant load. All four read
  // from the SAME /api/dashboard/overview payload already fetched for the KPI
  // rail (no extra request), mirroring the desktop dashboard-b figures. The
  // heavy bar DOM is gated behind `pdEnabled` (the post-first-paint idle flag)
  // so the first paint stays the KPI cards only — `analyticsReady` flips true
  // once the Home is interactive AND the overview has landed.
  const analyticsReady = pdEnabled && overview != null;

  // Sales trend — last 6 months of confirmed-SO revenue (monthlyRevenue series,
  // the dashboard's all-time view). Peak label + latest value match desktop.
  const salesTrend = useMemo(() => {
    const rev = overview?.monthlyRevenue ?? [];
    const last6 = rev.slice(-6);
    if (last6.length === 0) return null;
    const max = Math.max(...last6.map((m) => m.salesOrderSen), 1);
    const last = last6[last6.length - 1]?.salesOrderSen ?? 0;
    return {
      last,
      peak: max,
      bars: last6.map((m) => ({
        // "YYYY-MM" → short month label ("Jun").
        label: monthShort(m.month),
        sen: m.salesOrderSen,
        pct: Math.round((m.salesOrderSen / max) * 100),
      })),
    };
  }, [overview]);

  // Plant load — per-department backlog (days waiting), bars scaled to the
  // busiest department. Same source + scaling as the desktop Plant-Load panel
  // (production.backlogByDept). >= ~capacity-day threshold tints danger.
  const plantLoad = useMemo(() => {
    const depts = overview?.production?.backlogByDept ?? [];
    if (depts.length === 0) return null;
    const max = Math.max(...depts.map((d) => d.backlogDays), 1);
    const rows = depts
      .slice()
      .sort((a, b) => b.backlogDays - a.backlogDays)
      .slice(0, 8)
      .map((d) => {
        // "Overloaded" = more than a working week of queued work (desktop tints
        // long queues red). Threshold kept conservative at 5 backlog-days.
        const over = d.backlogDays >= 5;
        return {
          dept: d.dept,
          days: d.backlogDays,
          pct: Math.round((d.backlogDays / max) * 100),
          color: over ? M_ACCENT.danger.fg : d.backlogDays > 2 ? M.gold : M_DELTA.up,
          over,
        };
      });
    return { rows, overloaded: rows.filter((r) => r.over).length };
  }, [overview]);

  // Sales by customer — top 5 by total confirmed-SO value this scope
  // (aovByCustomer.totalSen), bars scaled to the largest customer.
  const salesByCustomer = useMemo(() => {
    const list = overview?.aovByCustomer ?? [];
    if (list.length === 0) return null;
    const top = list
      .slice()
      .sort((a, b) => b.totalSen - a.totalSen)
      .slice(0, 5);
    const max = Math.max(...top.map((c) => c.totalSen), 1);
    return top.map((c) => ({
      name: c.customerName || "—",
      sen: c.totalSen,
      pct: Math.round((c.totalSen / max) * 100),
    }));
  }, [overview]);

  // Top seller — best-selling products by units (Sofa sets + Bedframe units),
  // merged across both categories, top 5 by quantity. Mirrors desktop Top
  // Sellers (topSellers.SOFA / .BEDFRAME).
  const topSeller = useMemo(() => {
    const sofa = overview?.topSellers?.SOFA ?? [];
    const bed = overview?.topSellers?.BEDFRAME ?? [];
    const merged = [
      ...sofa.map((s) => ({ name: s.model, units: s.setsSold })),
      ...bed.map((b) => ({ name: b.productCode, units: b.qtySold })),
    ];
    if (merged.length === 0) return null;
    const top = merged.sort((a, b) => b.units - a.units).slice(0, 5);
    const max = Math.max(...top.map((t) => t.units), 1);
    return top.map((t, i) => ({
      rank: i + 1,
      name: t.name || "—",
      units: t.units,
      pct: Math.round((t.units / max) * 100),
    }));
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
        {/* ===== 2×2 KPI grid ===== */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 11,
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
                    text: `${salesDeltaPct >= 0 ? "+" : ""}${salesDeltaPct}%`,
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
                    text: `${invoiceDeltaPct >= 0 ? "+" : ""}${invoiceDeltaPct}%`,
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

        {/* ===== Quick actions ===== */}
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

        {/* ===== Daily Report (exceptions to action today) ===== */}
        <MobileCard
          radius={16}
          onClick={() => navigate("/m/sales")}
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
                {overdueCount}
              </div>
            </div>
            <span style={{ fontSize: 11.5, color: M.taupe, fontWeight: 600 }}>
              View ›
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: M.muted, marginTop: 3 }}>
            overdue sales orders to action today
          </div>
          {overdueCount > 0 ? (
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 11 }}
            >
              <span
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
                }}
              >
                Overdue <b>{overdueCount}</b>
              </span>
            </div>
          ) : null}
        </MobileCard>

        {/* ===== Order Pipeline (this month) ===== */}
        <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: M.raisin,
              marginBottom: 13,
            }}
          >
            Order Pipeline · this month
          </div>
          {pipeline.map((p) => (
            <div key={p.label} style={{ marginBottom: 11 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 5,
                }}
              >
                <span style={{ fontSize: 12.5, color: M.body }}>
                  {p.label} · {p.pct}%
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: M.raisin,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatCurrency(p.sen)}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: "#F0EBE0",
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${p.pct}%`,
                    height: "100%",
                    background: p.color,
                    borderRadius: 5,
                  }}
                />
              </div>
            </div>
          ))}
        </MobileCard>

        {/* ===== Command Center analytics (design v10) =====
            Sales trend · Plant load · Sales by customer · Top seller. The bar
            DOM is gated behind `analyticsReady` (post-first-paint idle + the
            overview payload landed) so the first paint stays the KPI rail. */}
        {analyticsReady && salesTrend ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                marginBottom: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: M.raisin }}>
                  Sales trend
                </div>
                <div style={{ fontSize: 11.5, color: M.muted, marginTop: 2 }}>
                  last 6 months
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 800,
                    color: M.taupe,
                    letterSpacing: "-0.3px",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {kFormat(salesTrend.last)}
                </div>
                <div style={{ fontSize: 10.5, color: M.muted }}>
                  peak {kFormat(salesTrend.peak)}
                </div>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 8,
                height: 96,
              }}
            >
              {salesTrend.bars.map((b, i) => (
                <div
                  key={`${b.label}-${i}`}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    height: "100%",
                    justifyContent: "flex-end",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      flex: 1,
                      display: "flex",
                      alignItems: "flex-end",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: `${Math.max(b.pct, 4)}%`,
                        minHeight: 6,
                        background: "linear-gradient(180deg,#8B7A4E,#6B5C32)",
                        borderRadius: "5px 5px 0 0",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: M.muted,
                      marginTop: 6,
                      fontWeight: 600,
                    }}
                  >
                    {b.label}
                  </div>
                </div>
              ))}
            </div>
          </MobileCard>
        ) : null}

        {analyticsReady && plantLoad ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 13,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: M.raisin }}>
                Plant load
              </span>
              {plantLoad.overloaded > 0 ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: M_ACCENT.danger.fg,
                    background: M_ACCENT.danger.bg,
                    border: "1px solid #E8B2A1",
                    padding: "2px 9px",
                    borderRadius: 20,
                  }}
                >
                  {plantLoad.overloaded} overloaded
                </span>
              ) : null}
            </div>
            {plantLoad.rows.map((p) => (
              <div
                key={p.dept}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 9,
                }}
              >
                <span
                  style={{
                    width: 78,
                    flex: "none",
                    fontSize: 11.5,
                    color: M.body,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.dept}
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 9,
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
                    width: 42,
                    flex: "none",
                    textAlign: "right",
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: p.over ? M_ACCENT.danger.fg : M.ink,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {p.days.toFixed(1)}d
                </span>
              </div>
            ))}
          </MobileCard>
        ) : null}

        {analyticsReady && salesByCustomer ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: M.raisin,
                marginBottom: 13,
              }}
            >
              Sales by customer
            </div>
            {salesByCustomer.map((c) => (
              <div key={c.name} style={{ marginBottom: 11 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 5,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: M.ink,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "65%",
                    }}
                  >
                    {c.name}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: M.raisin,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {kFormat(c.sen)}
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    background: "#F0EBE0",
                    borderRadius: 5,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${c.pct}%`,
                      height: "100%",
                      background: M.taupe,
                      borderRadius: 5,
                    }}
                  />
                </div>
              </div>
            ))}
          </MobileCard>
        ) : null}

        {analyticsReady && topSeller ? (
          <MobileCard radius={16} style={{ padding: "15px 16px", marginTop: 14 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: M.raisin,
                marginBottom: 13,
              }}
            >
              Top seller
            </div>
            {topSeller.map((t) => (
              <div
                key={`${t.rank}-${t.name}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 11,
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "none",
                    fontSize: 11,
                    fontWeight: 800,
                    background: t.rank === 1 ? M.taupe : "#F0EAD8",
                    color: t.rank === 1 ? "#fff" : M.taupe,
                  }}
                >
                  {t.rank}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: M.ink,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "62%",
                      }}
                    >
                      {t.name}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: M.taupe,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {t.units} units
                    </span>
                  </div>
                  <div
                    style={{
                      height: 7,
                      background: "#F0EBE0",
                      borderRadius: 5,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${t.pct}%`,
                        height: "100%",
                        background: "linear-gradient(90deg,#C9A961,#8B7A4E)",
                        borderRadius: 5,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
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
  const c = M_ACCENT[accent];
  return (
    <MobileCard radius={16} style={{ padding: "15px 16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 10,
            background: c.bg,
          }}
        >
          <Icon size={17} strokeWidth={1.75} color={c.fg} />
        </span>
        {delta ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: delta.good ? M_DELTA.up : M_DELTA.down,
            }}
          >
            {delta.text}
          </span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 25,
          fontWeight: 800,
          letterSpacing: "-0.6px",
          color: M.raisin,
          marginTop: 13,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: M.muted, marginTop: 5 }}>{label}</div>
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
