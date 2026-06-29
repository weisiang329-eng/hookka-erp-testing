// More — the profile + grouped module menu (reached from the "More" bottom tab).
//
// Reskinned (Wave 4) 1:1 to the design source (Hookka ERP Mobile.dc.html — the
// `isMore` view): a profile header card (round taupe avatar with the user's
// initials, display name, "Role · Company", and a red sign-out icon), then the
// grouped module list (parchment icon tile + label + optional red count badge +
// chevron). Real user identity comes from the signed-in session
// (getCurrentUser); sign-out reuses the SAME POST /api/auth/logout + clearAuth
// flow as the desktop top bar. No fabricated profile data.
import { useNavigate } from "react-router-dom";
import { ChevronRight, LogOut, Moon, Sun } from "lucide-react";
import { MobileHeader, MobileCard } from "../components";
import { MORE_GROUPS } from "../nav";
import { M } from "../theme";
import { useMobileThemeMode } from "../lib/theme-mode";
import { getCurrentUser, clearAuth } from "@/lib/auth";

// POST /api/auth/logout, then clear local state and bounce to /login — the same
// best-effort flow the desktop top bar uses (a network hiccup must not trap the
// user; the client token is wiped regardless so a reload won't auto-sign-in).
async function handleSignOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // ignore — best effort
  }
  clearAuth();
  window.location.href = "/login";
}

/** Initials from a display name (up to 2), falling back to email / "H". */
function initialsOf(name: string, email: string): string {
  const src = (name || email || "H").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

/** Human-readable role (SUPER_ADMIN → "Super Admin"). */
function prettyRole(role: string): string {
  if (!role) return "";
  return role
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function MobileMore() {
  const navigate = useNavigate();
  const { mode, toggle } = useMobileThemeMode();
  const user = getCurrentUser();
  const name = user?.displayName || user?.email || "—";
  const role = prettyRole(user?.role || "");
  // Company is a fixed brand constant for this single-tenant office app (the
  // desktop top bar defaults the same). TODO: surface the active organisation
  // here if a multi-org session field becomes available on the office session.
  const company = "HOOKKA INDUSTRIES";
  const initials = initialsOf(user?.displayName || "", user?.email || "");

  return (
    <>
      <MobileHeader title="More" />
      <div style={{ padding: "12px 18px 0", display: "grid", gap: 0 }}>
        {/* Profile header card — design source: avatar + name + role·company +
            sign-out. */}
        <MobileCard
          radius={18}
          style={{
            padding: 16,
            display: "flex",
            alignItems: "center",
            gap: 13,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: "50%",
              background: M.taupe,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 18,
              flex: "none",
            }}
          >
            {initials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: M.raisin,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: M.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {[role, company].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            style={{
              background: "none",
              border: "none",
              padding: 6,
              margin: -6,
              cursor: "pointer",
              display: "flex",
              flex: "none",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <LogOut size={20} strokeWidth={1.9} color="#C0463A" />
          </button>
        </MobileCard>

        {/* Dark/Light Mode toggle — CHANGELOG: "手机版在 More 菜单、即时切换、
            记忆设置". A single-row card that flips the body[data-theme] attribute
            and persists to localStorage. */}
        <MobileCard radius={14} style={{ padding: 0, marginBottom: 18, overflow: "hidden" }}>
          <button
            onClick={toggle}
            aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "13px 16px",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              color: M.raisin,
              textAlign: "left",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: mode === "dark" ? "#2A2722" : "#FAEFCB",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              {mode === "dark" ? (
                <Moon size={18} color="#D9BD7B" strokeWidth={1.9} />
              ) : (
                <Sun size={18} color="#9C6F1E" strokeWidth={1.9} />
              )}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: M.raisin }}>
                {mode === "dark" ? "Dark mode" : "Light mode"}
              </div>
              <div style={{ fontSize: 12, color: M.muted, marginTop: 1 }}>
                Tap to switch to {mode === "dark" ? "light" : "dark"}
              </div>
            </div>
            <span
              style={{
                width: 44,
                height: 26,
                borderRadius: 13,
                background: mode === "dark" ? M.taupe : M.hairline,
                position: "relative",
                flex: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: mode === "dark" ? 21 : 3,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left .18s",
                  boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                }}
              />
            </span>
          </button>
        </MobileCard>

        {MORE_GROUPS.map((group) => (
          <section key={group.title}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "#A89F8D",
                margin: "14px 4px 9px",
              }}
            >
              {group.title}
            </div>
            <MobileCard padded={false} radius={16}>
              {group.items.map((item, idx) => {
                const Icon = item.icon;
                const last = idx === group.items.length - 1;
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 13,
                      minHeight: 50,
                      padding: "13px 15px",
                      background: "none",
                      border: "none",
                      borderBottom: last ? "none" : `1px solid ${M.divider}`,
                      cursor: "pointer",
                      textAlign: "left",
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        backgroundColor: "#F4EFE6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Icon size={18} strokeWidth={1.75} color={M.taupe} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 14,
                        fontWeight: 500,
                        color: M.raisin,
                      }}
                    >
                      {item.label}
                    </span>
                    {item.badge ? (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#fff",
                          background: "#C0463A",
                          padding: "1px 8px",
                          borderRadius: 20,
                        }}
                      >
                        {item.badge}
                      </span>
                    ) : null}
                    <ChevronRight size={18} strokeWidth={1.75} color="#C4BDB2" />
                  </button>
                );
              })}
            </MobileCard>
          </section>
        ))}

        {/* Link back to the full desktop app. */}
        <a
          href="/dashboard"
          style={{
            textAlign: "center",
            fontSize: 12,
            color: M.muted,
            textDecoration: "none",
            padding: "18px 0 8px",
          }}
        >
          Open the full desktop app
        </a>
      </div>
    </>
  );
}
