// BottomTabBar — fixed 5-item bottom navigation for the phone shell.
// Active tab = taupe icon+label (stroke 2.2); inactive = muted (stroke 1.75).
// No QR-scan tab. Centered to the phone content width.
import { useLocation, useNavigate } from "react-router-dom";
import { M, M_MAX_WIDTH } from "../theme";
import { TABS, type TabKey } from "../nav";

/** Resolve which tab is active from the current pathname. */
function activeTab(pathname: string): TabKey {
  if (pathname === "/m" || pathname === "/m/") return "home";
  if (pathname.startsWith("/m/sales")) return "sales";
  if (pathname.startsWith("/m/production")) return "production";
  if (
    pathname.startsWith("/m/procurement") ||
    pathname.startsWith("/m/suppliers")
  )
    return "procure";
  return "more";
}

export function BottomTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = activeTab(pathname);

  return (
    <nav
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        backgroundColor: M.card,
        borderTop: `1px solid ${M.border}`,
        boxShadow: "0 -2px 12px rgba(31,29,27,0.06)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: M_MAX_WIDTH,
          display: "flex",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {TABS.map((t) => {
          const isActive = t.key === active;
          const Icon = t.icon;
          // Design source: active = taupe; inactive = #A89F8D.
          const color = isActive ? M.taupe : "#A89F8D";
          return (
            <button
              key={t.key}
              onClick={() => navigate(t.path)}
              aria-label={t.label}
              aria-current={isActive ? "page" : undefined}
              style={{
                flex: 1,
                minHeight: 56,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "9px 0 0",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Icon size={23} strokeWidth={isActive ? 2.2 : 1.75} color={color} />
              <span
                style={{
                  fontSize: 10,
                  fontWeight: isActive ? 700 : 500,
                  color,
                }}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
