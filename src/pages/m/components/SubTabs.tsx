// SubTabs — the horizontal, scrollable sub-tab (segment) row at the top of
// every L1 module list. Reskinned 1:1 to the design source's segment pills:
//   • pill: padding 8px 14px, radius 11, font 13/600;
//   • active = taupe bg + white text; inactive = white + #E2DDD8 border + grey;
//   • optional per-tab count badge (rounded, tinted) when a count is supplied.
//
// Intentional horizontal scroll (the only allowed horizontal overflow on these
// screens).
import { M } from "../theme";

type Tab = { key: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
  /** Optional per-tab counts (keyed by tab key) shown as a trailing badge. */
  counts?: Record<string, number>;
};

export function SubTabs({ tabs, active, onChange, counts }: Props) {
  return (
    <div
      style={{
        position: "sticky",
        top: 52, // sits under the MobileHeader (minHeight 52)
        zIndex: 30,
        backgroundColor: M.paper,
        borderBottom: `1px solid ${M.border}`,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          padding: "10px 12px",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {tabs.map((t) => {
          const isActive = t.key === active;
          const count = counts?.[t.key];
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              style={{
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 11,
                border: `1px solid ${isActive ? M.taupe : M.hairline}`,
                backgroundColor: isActive ? M.taupe : M.card,
                color: isActive ? "#fff" : "#6B7280",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {t.label}
              {count ? (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "0 6px",
                    borderRadius: 9999,
                    background: isActive ? "rgba(255,255,255,0.22)" : "#F0ECE9",
                    color: isActive ? "#fff" : M.faint,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
