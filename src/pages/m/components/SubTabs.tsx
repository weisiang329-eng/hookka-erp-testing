// SubTabs — the horizontal, scrollable sub-tab row at the top of every L1
// module list. Active tab = taupe pill; inactive = plain. Intentional
// horizontal scroll (the only allowed horizontal overflow on these screens).
import { M } from "../theme";

type Tab = { key: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
};

export function SubTabs({ tabs, active, onChange }: Props) {
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
          padding: "8px 12px",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              style={{
                flexShrink: 0,
                padding: "6px 14px",
                borderRadius: 9999,
                border: `1px solid ${isActive ? M.taupe : M.border}`,
                backgroundColor: isActive ? M.taupe : M.card,
                color: isActive ? "#fff" : M.body,
                fontSize: 13,
                fontWeight: isActive ? 700 : 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
