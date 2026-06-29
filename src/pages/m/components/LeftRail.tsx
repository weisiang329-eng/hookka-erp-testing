// ===========================================================================
// LeftRail — Galaxy Fold / wide-landscape navigation column.
//
// Owner 2026-06-28 dc12 Fold variant: phones get the bottom tab bar; folds +
// landscape tablets get a 198px LEFT RAIL with sectioned module nav (mirrors
// the desktop sidebar shape). Saves a precious row of vertical pixels on the
// shorter fold viewport and matches the Fold design source 1:1.
//
// Sections + items match dc12 Fold's railDefs (lines 1384-1400). Active row
// = taupe pill with white text + icon. Account row pinned bottom (avatar +
// name + role + log-out).
//
// ADDITIVE: imported only by MobileLayout when the fold media query matches.
// ===========================================================================
import { type LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  ShoppingCart,
  Truck,
  Wallet,
  Wrench,
  Factory,
  Warehouse,
  ShoppingBag,
  HardHat,
  Megaphone,
  Mail,
  LogOut,
  Moon,
  Sun,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { M } from "../theme";
import { useMobileThemeMode } from "../lib/theme-mode";
import { getCurrentUser, clearAuth } from "@/lib/auth";

type RailEntry =
  | { kind: "section"; label: string }
  | { kind: "item"; key: string; label: string; icon: LucideIcon; path: string };

// dc12 Fold railDefs — same order + section labels.
const ENTRIES: RailEntry[] = [
  { kind: "section", label: "Workspace" },
  { kind: "item", key: "home", label: "Dashboard", icon: LayoutDashboard, path: "/m" },
  { kind: "section", label: "Sales & Customers" },
  { kind: "item", key: "sales", label: "Sales Orders", icon: ShoppingCart, path: "/m/sales" },
  { kind: "item", key: "delivery", label: "Delivery Orders", icon: Truck, path: "/m/delivery" },
  { kind: "item", key: "invoices", label: "Receivables", icon: Wallet, path: "/m/invoices" },
  { kind: "item", key: "servicecases", label: "Service Cases", icon: Wrench, path: "/m/servicecases" },
  { kind: "section", label: "Operations" },
  { kind: "item", key: "production", label: "Production", icon: Factory, path: "/m/production" },
  { kind: "item", key: "warehouse", label: "Warehouse", icon: Warehouse, path: "/m/warehouse" },
  { kind: "item", key: "procurement", label: "Procurement", icon: ShoppingBag, path: "/m/procurement" },
  { kind: "section", label: "People & Comms" },
  { kind: "item", key: "employees", label: "Employees", icon: HardHat, path: "/m/employees" },
  { kind: "item", key: "announcements", label: "Announcements", icon: Megaphone, path: "/m/announcements" },
  { kind: "item", key: "mailcenter", label: "Mail Center", icon: Mail, path: "/m/mail-center" },
];

function isActive(itemPath: string, pathname: string): boolean {
  if (itemPath === "/m") return pathname === "/m" || pathname === "/m/";
  return pathname.startsWith(itemPath);
}

export function LeftRail() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const user = getCurrentUser();
  const initials = (user?.displayName || "U")
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const displayName = user?.displayName || "User";
  // Best-effort role label — falls back to empty if not available.
  const role = (user as unknown as { role?: string } | null)?.role || "";

  return (
    <nav
      style={{
        width: 198,
        flex: "none",
        height: "100dvh",
        background: "#F3EEE6",
        borderRight: "1px solid #E4DDD0",
        display: "flex",
        flexDirection: "column",
        padding: "14px 11px",
        position: "sticky",
        top: 0,
      }}
    >
      {/* Brand logo tile (matches the ERP-mobile black-on-white app icon). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "4px 8px 12px",
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: M.raisin,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 15,
            fontWeight: 800,
          }}
        >
          H
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: M.raisin }}>
          Hookka
        </span>
      </div>

      {/* Scrollable rail body — sections + items. */}
      <div
        className="scrollarea"
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          minHeight: 0,
        }}
      >
        {ENTRIES.map((e, i) => {
          if (e.kind === "section") {
            return (
              <div
                key={`sec-${i}`}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#A89F8D",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  padding: "9px 10px 4px",
                }}
              >
                {e.label}
              </div>
            );
          }
          const act = isActive(e.path, pathname);
          const Icon = e.icon;
          return (
            <button
              key={e.key}
              onClick={() => navigate(e.path)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "7px 11px",
                borderRadius: 10,
                cursor: "pointer",
                marginBottom: 1,
                background: act ? M.taupe : "transparent",
                border: "none",
                width: "100%",
                textAlign: "left",
                fontFamily: "inherit",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Icon
                size={18}
                strokeWidth={1.75}
                color={act ? "#fff" : "#8A8270"}
              />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: act ? 700 : 500,
                  color: act ? "#fff" : "#5A5346",
                }}
              >
                {e.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Dark/Light mode toggle — CHANGELOG: "Fold 版在左栏底部". */}
      <ThemeModeRow />

      {/* Account footer — avatar · name · role · log-out. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 10px 4px",
          marginTop: 8,
          borderTop: "1px solid #E4DDD0",
        }}
      >
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: M.taupe,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            flex: "none",
          }}
        >
          {initials}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: M.raisin,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayName}
          </div>
          {role ? (
            <div style={{ fontSize: 10, color: M.muted }}>{role}</div>
          ) : null}
        </div>
        <button
          onClick={() => {
            clearAuth();
            // Browser-level redirect so RequireAuth re-evaluates against the
            // freshly-cleared cookie/session storage.
            window.location.href = "/login";
          }}
          aria-label="Log out"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 4,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <LogOut size={16} color="#9A3A2D" />
        </button>
      </div>
    </nav>
  );
}

function ThemeModeRow() {
  const { mode, toggle } = useMobileThemeMode();
  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        WebkitTapHighlightColor: "transparent",
        marginTop: 4,
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: mode === "dark" ? "#2A2722" : "#FAEFCB",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
        }}
      >
        {mode === "dark" ? (
          <Moon size={14} color="#D9BD7B" strokeWidth={1.9} />
        ) : (
          <Sun size={14} color="#9C6F1E" strokeWidth={1.9} />
        )}
      </span>
      <span style={{ flex: 1, fontSize: 12, color: M.raisin, fontWeight: 600, textAlign: "left" }}>
        {mode === "dark" ? "Dark" : "Light"}
      </span>
      <span
        style={{
          width: 32,
          height: 18,
          borderRadius: 10,
          background: mode === "dark" ? M.taupe : M.hairline,
          position: "relative",
          flex: "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: mode === "dark" ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .18s",
          }}
        />
      </span>
    </button>
  );
}
