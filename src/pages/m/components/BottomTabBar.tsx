// BottomTabBar — fixed 5-slot bottom navigation for the phone shell.
//
// Owner 2026-06-28 (reference: a green circular grid button popping above the
// bar): the MIDDLE slot is now a special RAISED circular action button — our
// "More" entry. The other 4 slots (Home · Sales · Production · Procure) stay
// flat icon+label.
//   • Center button: ~56px taupe (#6B5C32) circle, white LayoutGrid icon,
//     translated up (-16px) so it pops ABOVE the bar, soft shadow + a white
//     ring/notch so it reads as the special action. Tap → /m/more (unchanged).
//   • Active tab = taupe icon+label (stroke 2.2); inactive = muted #A89F8D.
// Centered to the phone content width.
import { useLocation, useNavigate } from "react-router-dom";
import { M, M_MAX_WIDTH } from "../theme";
import { TABS, type TabKey } from "../nav";

/** Resolve which tab is active from the current pathname. */
function activeTab(pathname: string): TabKey {
  if (pathname === "/m" || pathname === "/m/") return "home";
  if (pathname.startsWith("/m/sales")) return "sales";
  if (pathname.startsWith("/m/delivery")) return "delivery";
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
          alignItems: "flex-end",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {TABS.map((t) => {
          const isActive = t.key === active;
          const Icon = t.icon;

          // ----- Center raised button (the special "More" action) -----
          if (t.raised) {
            return (
              <div
                key={t.key}
                style={{
                  flex: 1,
                  display: "flex",
                  justifyContent: "center",
                  // Keep the bar's slot height so the 4 flat tabs align; the
                  // button itself floats up via translateY.
                  minHeight: 56,
                  alignItems: "center",
                }}
              >
                <button
                  onClick={() => navigate(t.path)}
                  aria-label={t.label}
                  aria-current={isActive ? "page" : undefined}
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: "50%",
                    background: M.taupe,
                    // A white ring/notch so it reads as the special action and
                    // visually detaches from the bar.
                    border: "4px solid #FFFFFF",
                    transform: "translateY(-16px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    boxShadow: isActive
                      ? "0 8px 20px rgba(107,92,50,0.45)"
                      : "0 6px 16px rgba(107,92,50,0.35)",
                    WebkitTapHighlightColor: "transparent",
                    flex: "none",
                  }}
                >
                  <Icon size={24} strokeWidth={2.1} color="#FFFFFF" />
                </button>
              </div>
            );
          }

          // ----- Flat tab (Home / Sales / Production / Procure) -----
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
