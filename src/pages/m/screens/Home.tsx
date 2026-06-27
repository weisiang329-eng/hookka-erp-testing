// ===========================================================================
// Mobile Home / Dashboard (Phase 1)
//
// Wired to the SAME endpoints the desktop dashboard + sales list use (via the
// shared useCachedJson stale-while-revalidate cache). No new backend.
//
// KPI wiring:
//   • Open orders  → /api/sales-orders/stats  (byStatus: Confirmed +
//                    In Production + Ready to Ship + Shipped — orders that are
//                    live but not yet Delivered/Invoiced/Closed/Cancelled).
//   • WIP units    → /api/dashboard/overview   (production.activeJobs:
//                    bedframeUnits + sofaSets — units currently on the floor).
//   • On-time %    → derived from the fetched SO list: of orders with an
//                    Expected DD that aren't terminal, the share whose Expected
//                    DD has NOT already passed (real, computed from live data;
//                    see note — a dedicated on-time endpoint can replace this).
//   • AR due       → /api/sales-orders/stats  (outstandingItemsSen — confirmed
//                    sales value not yet delivered/invoiced).
//
// Lists:
//   • Stock alerts → /api/inventory (rawMaterials below reorder / low).
//   • Orders due   → /api/sales-orders (soonest Expected DD, non-terminal).
//
// Deltas: month-over-month sales delta comes from overview.monthlyRevenue
// where available; KPIs without a readily-available prior-period figure show
// no delta rather than a fabricated one (// TODO notes inline).
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Package,
  Factory,
  Timer,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Truck,
  PackageCheck,
  UserPlus,
  AlertTriangle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import {
  SO_STATUS_COLOR,
  WARNING,
  DANGER,
  type SemanticStyle,
} from "@/lib/design-tokens";
import type { SalesOrder, RawMaterial } from "@/types";
import { MobileCard, StatusPill, ListRow, Sheet } from "../components";
import { M } from "../theme";

// ---------- API response shapes (subset of the desktop dashboard's) ----------
type StatsResp = {
  success?: boolean;
  byStatus?: Record<string, number>;
  csRevenueSen?: number;
  deliveredItemsSen?: number;
  outstandingItemsSen?: number;
};
type OverviewResp = {
  success?: boolean;
  production?: {
    activeJobs?: { bedframeUnits?: number; sofaSets?: number };
  };
  monthlyRevenue?: { month: string; salesOrderSen: number }[];
};
type SOListResp = { success?: boolean; data?: SalesOrder[] };
type InventoryResp = {
  success?: boolean;
  data?: { rawMaterials?: RawMaterial[] };
};

// Statuses that count as a "live / open" order on the floor (not terminal).
const OPEN_STATUSES = new Set([
  "CONFIRMED",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "SHIPPED",
]);
const TERMINAL_STATUSES = new Set([
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "CANCELLED",
]);

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MobileHome() {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const firstName = (user?.displayName || "there").split(" ")[0];

  const [quickAction, setQuickAction] = useState<string | null>(null);

  const { data: stats } = useCachedJson<StatsResp>("/api/sales-orders/stats");
  const { data: overview } = useCachedJson<OverviewResp>(
    "/api/dashboard/overview?period=all",
  );
  // Whole-table SO list (server caps at 5000; current ~350 SOs). Used for the
  // Orders-due list + the on-time % derivation.
  const { data: soList } = useCachedJson<SOListResp>("/api/sales-orders");
  const { data: inventory } = useCachedJson<InventoryResp>("/api/inventory");

  // ---- KPI: Open orders ----
  const openOrders = useMemo(() => {
    const by = stats?.byStatus ?? {};
    let n = 0;
    for (const [k, v] of Object.entries(by)) {
      if (OPEN_STATUSES.has(k)) n += Number(v) || 0;
    }
    return n;
  }, [stats]);

  // ---- KPI: WIP units (bedframe units + sofa sets currently in production) ----
  const wipUnits = useMemo(() => {
    const aj = overview?.production?.activeJobs;
    return (Number(aj?.bedframeUnits) || 0) + (Number(aj?.sofaSets) || 0);
  }, [overview]);

  // ---- KPI: AR due (confirmed sales value not yet delivered) ----
  const arDueSen = stats?.outstandingItemsSen ?? 0;

  // ---- Sales month-over-month delta (for the Open-orders card subtitle) ----
  const salesDeltaPct = useMemo(() => {
    const rev = overview?.monthlyRevenue ?? [];
    if (rev.length < 2) return null;
    const cur = rev[rev.length - 1]?.salesOrderSen ?? 0;
    const prev = rev[rev.length - 2]?.salesOrderSen ?? 0;
    if (prev <= 0) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }, [overview]);

  // ---- Orders due + On-time % (both derived from the live SO list) ----
  const orders = useMemo(() => (soList?.success ? soList.data ?? [] : []), [
    soList,
  ]);

  const onTimePct = useMemo(() => {
    const today = todayISO();
    let tracked = 0;
    let onTime = 0;
    for (const so of orders) {
      if (TERMINAL_STATUSES.has(so.status)) continue;
      const dd = so.hookkaExpectedDD;
      if (!dd) continue;
      tracked++;
      // On time = Expected DD has not already passed.
      if (dd.slice(0, 10) >= today) onTime++;
    }
    // TODO: replace with a dedicated delivered-on-time endpoint when available;
    // this is a live, non-fabricated proxy (open orders not yet past due).
    if (tracked === 0) return null;
    return Math.round((onTime / tracked) * 100);
  }, [orders]);

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
      {/* Greeting */}
      <div style={{ padding: "16px 16px 8px" }}>
        <div style={{ fontSize: 13, color: M.muted }}>Welcome back,</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: M.raisin }}>
          {firstName}
        </div>
      </div>

      {/* 2×2 KPI grid */}
      <div
        style={{
          padding: "0 12px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
        }}
      >
        <KpiCard
          icon={Package}
          label="Open orders"
          value={openOrders.toLocaleString()}
          deltaPct={salesDeltaPct}
          deltaLabel="vs last month sales"
        />
        <KpiCard
          icon={Factory}
          label="WIP units"
          value={wipUnits.toLocaleString()}
          hint="On the floor now"
        />
        <KpiCard
          icon={Timer}
          label="On-time %"
          value={onTimePct == null ? "—" : `${onTimePct}%`}
          hint="Open orders not past due"
        />
        <KpiCard
          icon={Wallet}
          label="AR due"
          value={formatCurrency(arDueSen)}
          hint="Outstanding to deliver"
        />
      </div>

      {/* Quick actions */}
      <div style={{ padding: "16px 12px 4px" }}>
        <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
          <QuickChip
            icon={Plus}
            label="New SO"
            onClick={() => setQuickAction("New Sales Order")}
          />
          <QuickChip
            icon={Truck}
            label="Delivery"
            onClick={() => setQuickAction("New Delivery")}
          />
          <QuickChip
            icon={PackageCheck}
            label="Receive"
            onClick={() => setQuickAction("Receive Goods")}
          />
          <QuickChip
            icon={UserPlus}
            label="Staff"
            onClick={() => setQuickAction("Staff")}
          />
        </div>
      </div>

      {/* Stock alerts */}
      <Section title="Stock alerts" onSeeAll={() => navigate("/m/inventory")}>
        <MobileCard padded={false}>
          {stockAlerts.length === 0 ? (
            <EmptyRow text="No low-stock materials" />
          ) : (
            stockAlerts.map((rm) => {
              const qty = Number(rm.balanceQty) || 0;
              // Pill reflects the alert reason: out-of-stock is danger; any
              // other alerted item is low-stock (warning). getStockSemantic
              // returns NEUTRAL above its LOW threshold, which would wrongly
              // grey a reorder-point alert, so resolve by reason instead.
              const sem = qty === 0 ? DANGER : WARNING;
              return (
                <ListRow
                  key={rm.id}
                  code={rm.itemCode}
                  title={rm.description || rm.itemCode}
                  subLine={rm.itemGroup}
                  meta={[
                    {
                      label: "On hand",
                      value: `${qty} ${rm.baseUOM || ""}`.trim(),
                    },
                  ]}
                  pill={
                    <StatusPill
                      style={sem}
                      label={qty === 0 ? "OUT_OF_STOCK" : "LOW_STOCK"}
                      size="sm"
                    />
                  }
                  onClick={() => navigate("/m/inventory")}
                />
              );
            })
          )}
        </MobileCard>
      </Section>

      {/* Orders due */}
      <Section title="Orders due" onSeeAll={() => navigate("/m/sales")}>
        <div style={{ display: "grid", gap: 10 }}>
          {ordersDue.length === 0 ? (
            <MobileCard padded={false}>
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
      </Section>

      <div style={{ height: 8 }} />

      {/* Quick-action placeholder sheet (Phase 2 wires the real forms). */}
      <Sheet
        open={quickAction != null}
        onClose={() => setQuickAction(null)}
        title={quickAction ?? ""}
      >
        <div style={{ padding: "12px 4px", color: M.body, fontSize: 14 }}>
          The {quickAction?.toLowerCase()} form arrives in the next phase. For
          now, use the full desktop app to create records.
        </div>
      </Sheet>
    </div>
  );
}

// --------------------------------------------------------------------------

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  deltaPct,
  deltaLabel,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  deltaPct?: number | null;
  deltaLabel?: string;
}) {
  const up = (deltaPct ?? 0) >= 0;
  return (
    <MobileCard radius={16}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 12, color: M.muted, fontWeight: 600 }}>
          {label}
        </span>
        <Icon size={18} strokeWidth={1.75} color={M.taupe} />
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 800,
          color: M.raisin,
          marginTop: 6,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {deltaPct != null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            marginTop: 4,
            fontSize: 11,
            color: up ? "#4F7C3A" : "#9A3A2D",
            fontWeight: 600,
          }}
        >
          {up ? (
            <ArrowUpRight size={13} strokeWidth={2} />
          ) : (
            <ArrowDownRight size={13} strokeWidth={2} />
          )}
          {Math.abs(deltaPct)}%
          <span style={{ color: M.muted, fontWeight: 400 }}>{deltaLabel}</span>
        </div>
      ) : hint ? (
        <div style={{ fontSize: 11, color: M.muted, marginTop: 4 }}>{hint}</div>
      ) : null}
    </MobileCard>
  );
}

function QuickChip({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "10px 14px",
        minWidth: 76,
        backgroundColor: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: 14,
        cursor: "pointer",
        flexShrink: 0,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: M.taupe,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={18} strokeWidth={2} color="#fff" />
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, color: M.raisin }}>
        {label}
      </span>
    </button>
  );
}

function Section({
  title,
  onSeeAll,
  children,
}: {
  title: string;
  onSeeAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: "18px 12px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 4px 8px",
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 700, color: M.raisin, margin: 0 }}>
          {title}
        </h2>
        {onSeeAll ? (
          <button
            onClick={onSeeAll}
            style={{
              background: "none",
              border: "none",
              color: M.taupe,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            See all
          </button>
        ) : null}
      </div>
      {children}
    </section>
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
    <MobileCard onClick={onClick} radius={16}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: M.taupe,
              fontSize: 12,
              fontWeight: 700,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            }}
          >
            {so.companySO || so.companySOId}
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: M.raisin,
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {so.customerName}
          </div>
        </div>
        <StatusPill style={sem} label={so.status} size="sm" />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: M.muted }}>Expected DD</div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: overdue ? "#9A3A2D" : M.raisin,
              fontVariantNumeric: "tabular-nums",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {overdue ? <AlertTriangle size={13} strokeWidth={2} /> : null}
            {dd || "—"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10, color: M.muted }}>Amount</div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: M.raisin,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatCurrency(so.totalSen || 0)}
          </div>
        </div>
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
