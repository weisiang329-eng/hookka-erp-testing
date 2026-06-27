// More — the grouped module menu (reached from the "More" bottom tab).
// Each row links to its module screen under /m/* (Phase 2 supplies the real
// screens; Phase 1 routes to a placeholder so navigation works end-to-end).
import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { MobileHeader, MobileCard } from "../components";
import { MORE_GROUPS } from "../nav";
import { M } from "../theme";

export default function MobileMore() {
  const navigate = useNavigate();
  return (
    <>
      <MobileHeader title="More" />
      <div style={{ padding: "12px 12px 0", display: "grid", gap: 18 }}>
        {MORE_GROUPS.map((group) => (
          <section key={group.title}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                color: M.muted,
                padding: "0 6px 8px",
              }}
            >
              {group.title}
            </div>
            <MobileCard padded={false}>
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
                      gap: 12,
                      minHeight: 50,
                      padding: "12px 14px",
                      background: "none",
                      border: "none",
                      borderBottom: last ? "none" : `1px solid ${M.border}`,
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
                        backgroundColor: "#F0EAD8",
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
                        fontWeight: 600,
                        color: M.raisin,
                      }}
                    >
                      {item.label}
                    </span>
                    <ChevronRight size={18} strokeWidth={1.75} color={M.muted} />
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
            padding: "4px 0 8px",
          }}
        >
          Open the full desktop app
        </a>
      </div>
    </>
  );
}
