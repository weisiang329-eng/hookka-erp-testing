// ===========================================================================
// Mobile Home / Dashboard
//
// Reskinned 1:1 to the design source (Hookka ERP Mobile.dc.html — HOME screen)
// while keeping ALL existing real-data wiring. No data layer / route changes.
//
// KPI wiring (UNCHANGED — real data):
//   • Open orders  → /api/sales-orders/stats  (byStatus: Confirmed +
//                    In Production + Ready to Ship + Shipped — orders that are
//                    live but not yet Delivered/Invoiced/Closed/Cancelled).
//   • WIP units    → /api/dashboard/overview   (production.activeJobs:
//                    bedframeUnits + sofaSets — units currently on the floor).
//   • On-time %    → derived from the fetched SO list: of open orders with an
//                    Expected DD, the share whose DD has NOT already passed.
//   • AR due       → /api/sales-orders/stats  (outstandingItemsSen).
//
// Lists:
//   • Stock alerts → /api/inventory (raw materials at/below reorder / low).
//   • Orders due   → /api/sales-orders (soonest Expected DD, non-terminal).
//
// Design deltas: the source shows static dummy deltas (+5, +38, -1.3%, "6 late").
// We only render a delta we can actually compute (Open-orders MoM sales %); the
// other cards show a real "N late" count (AR) / a muted hint instead of a
// fabricated number. See inline TODOs for KPIs lacking a real prior-period
// source.
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ShoppingCart,
  Factory,
  Truck,
  Receipt,
  Plus,
  PackageCheck,
  HardHat,
  Bell,
  CircleAlert,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import {
  SO_STATUS_COLOR,
  type SemanticStyle,
} from "@/lib/design-tokens";
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

  // ---- Sales month-over-month delta (Open-orders card) ----
  const salesDeltaPct = useMemo(() => {
    const rev = overview?.monthlyRevenue ?? [];
    if (rev.length < 2) return null;
    const cur = rev[rev.length - 1]?.salesOrderSen ?? 0;
    const prev = rev[rev.length - 2]?.salesOrderSen ?? 0;
    if (prev <= 0) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }, [overview]);

  // ---- Orders due + On-time % (both derived from the live SO list) ----
  const orders = useMemo(
    () => (soList?.success ? soList.data ?? [] : []),
    [soList],
  );

  const onTimePct = useMemo(() => {
    const today = todayISO();
    let tracked = 0;
    let onTime = 0;
    for (const so of orders) {
      if (TERMINAL_STATUSES.has(so.status)) continue;
      const dd = so.hookkaExpectedDD;
      if (!dd) continue;
      tracked++;
      if (dd.slice(0, 10) >= today) onTime++;
    }
    // TODO(wave-x): replace with a dedicated delivered-on-time endpoint; this is
    // a live, non-fabricated proxy (open orders not yet past due).
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

  // Count of late orders, shown as the AR-due delta badge ("N late").
  const lateCount = useMemo(
    () => ordersDue.filter((o) => o.overdue).length,
    [ordersDue],
  );

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
          <KpiCard
            icon={ShoppingCart}
            accent="gold"
            label="Open orders"
            value={openOrders.toLocaleString()}
            delta={
              salesDeltaPct == null
                ? null
                : {
                    text: `${salesDeltaPct >= 0 ? "+" : ""}${salesDeltaPct}%`,
                    good: salesDeltaPct >= 0,
                  }
            }
          />
          <KpiCard
            icon={Factory}
            accent="info"
            label="WIP units"
            value={wipUnits.toLocaleString()}
            // TODO(wave-x): no prior-period WIP snapshot to derive a delta from.
            delta={null}
          />
          <KpiCard
            icon={Truck}
            accent="moss"
            label="On-time"
            value={onTimePct == null ? "—" : `${onTimePct}%`}
            // TODO(wave-x): no prior-period on-time figure; delta omitted.
            delta={null}
          />
          <KpiCard
            icon={Receipt}
            accent="danger"
            label="AR due"
            value={formatCurrency(arDueSen)}
            delta={
              lateCount > 0
                ? { text: `${lateCount} late`, good: false }
                : null
            }
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
