// MobileHeader — sticky top bar for non-Home screens.
// Optional back button (taupe) + title; centered to the content width.
import { ChevronLeft } from "lucide-react";
import { type ReactNode } from "react";
import { M, M_MAX_WIDTH } from "../theme";

type Props = {
  title: string;
  onBack?: () => void;
  /** Optional trailing action (e.g. a + button). */
  trailing?: ReactNode;
};

export function MobileHeader({ title, onBack, trailing }: Props) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        display: "flex",
        justifyContent: "center",
        backgroundColor: M.paper,
        borderBottom: `1px solid ${M.border}`,
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: M_MAX_WIDTH,
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 52,
          padding: "0 12px",
        }}
      >
        {onBack ? (
          <button
            onClick={onBack}
            aria-label="Back"
            style={{
              background: "none",
              border: "none",
              padding: 6,
              marginLeft: -6,
              cursor: "pointer",
              display: "flex",
              color: M.taupe,
            }}
          >
            <ChevronLeft size={24} strokeWidth={2} />
          </button>
        ) : null}
        <div
          style={{
            flex: 1,
            fontSize: 18,
            fontWeight: 700,
            color: M.raisin,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {trailing ? <div style={{ flexShrink: 0 }}>{trailing}</div> : null}
      </div>
    </div>
  );
}
