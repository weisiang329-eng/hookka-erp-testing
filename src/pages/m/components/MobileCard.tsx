// MobileCard — the base white surface used across every phone screen.
// 1px hairline border, 16-18px radius, optional padding + tap handling.
import { type ReactNode } from "react";
import { M } from "../theme";

type Props = {
  children: ReactNode;
  /** Inner padding; pass false for edge-to-edge content (e.g. lists). */
  padded?: boolean;
  /** Makes the whole card tappable. */
  onClick?: () => void;
  /** Extra inline styles to merge. */
  style?: React.CSSProperties;
  radius?: number;
};

export function MobileCard({
  children,
  padded = true,
  onClick,
  style,
  radius = 18,
}: Props) {
  const interactive = typeof onClick === "function";
  return (
    <div
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        backgroundColor: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: radius,
        padding: padded ? 16 : 0,
        cursor: interactive ? "pointer" : undefined,
        WebkitTapHighlightColor: "transparent",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
