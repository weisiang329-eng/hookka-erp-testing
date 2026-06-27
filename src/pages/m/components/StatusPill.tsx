// StatusPill — pill-shaped status chip driven by the app's design-tokens.
//
// Accepts EITHER a pre-resolved SemanticStyle (when the caller already knows
// the right map, e.g. SO_STATUS_COLOR[status]) OR a raw status string + a
// resolver. Always renders the label in Title Case. Colours come from the
// shared SemanticStyle hex values so they match the desktop app exactly.
import { type SemanticStyle, titleCaseStatus } from "../theme";

/** Convert a 6-digit hex foreground into a faint tinted background. */
function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type Props = {
  /** Resolved semantic style (preferred). */
  style: SemanticStyle;
  /** Raw enum value; rendered in Title Case. */
  label: string;
  /** Optional smaller variant for dense rows. */
  size?: "sm" | "md";
};

export function StatusPill({ style, label, size = "md" }: Props) {
  const hex = style.hex;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        borderRadius: 9999,
        backgroundColor: tint(hex, 0.12),
        border: `1px solid ${tint(hex, 0.32)}`,
        color: hex,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        padding: size === "sm" ? "1px 8px" : "3px 10px",
        fontSize: size === "sm" ? 11 : 12,
        lineHeight: 1.3,
      }}
    >
      {titleCaseStatus(label)}
    </span>
  );
}
