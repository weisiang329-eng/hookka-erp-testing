// DocCard — the card-based L1 list item, reskinned 1:1 to the design source
// (Hookka ERP Mobile.dc.html → "LIST (generic, card-based)" branch).
//
// Layout per the design:
//   • Row 1: doc code (12/700 taupe) on the left, status pill on the right.
//   • Title (15/700 raisin, -.2px tracking).
//   • Optional sub-line (12.5 muted, single-line ellipsis).
//   • Footer (margin-top 12, padding-top 12, top hairline #F2EEE6):
//       up to two meta columns — UPPERCASE label (10/600 #A89F8D) + value
//       (13/600 raisin, tabular) — then a spacer and a trailing chevron.
//
// Data-only consumer: every value comes from the module config's RowVM. This
// component changes PRESENTATION ONLY.
import { ChevronRight } from "lucide-react";
import { type ReactNode } from "react";
import { M } from "../theme";

type Meta = { label: string; value: ReactNode };

type Props = {
  code: string;
  title: string;
  subLine?: string;
  /** Up to two footer meta columns (e.g. Expected DD / Amount). */
  meta?: [Meta?, Meta?];
  /** Status pill node (use <StatusPill/>). */
  pill?: ReactNode;
  onClick?: () => void;
};

export function DocCard({ code, title, subLine, meta, pill, onClick }: Props) {
  const interactive = typeof onClick === "function";
  const metas = (meta ?? []).filter(Boolean) as Meta[];
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
        borderRadius: 16,
        padding: "15px 16px",
        cursor: interactive ? "pointer" : undefined,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {/* Row 1 — code + status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: M.taupe,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontVariantNumeric: "tabular-nums",
            letterSpacing: 0.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {code}
        </span>
        {pill ? <span style={{ flexShrink: 0 }}>{pill}</span> : null}
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: M.raisin,
          marginTop: 8,
          letterSpacing: "-0.2px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </div>

      {/* Sub-line */}
      {subLine ? (
        <div
          style={{
            fontSize: 12.5,
            color: M.muted,
            marginTop: 3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subLine}
        </div>
      ) : null}

      {/* Footer — meta columns + chevron */}
      {metas.length > 0 || interactive ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${M.divider}`,
          }}
        >
          {metas.map((m, i) => (
            <div key={i} style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "#A89F8D",
                  letterSpacing: "0.3px",
                  textTransform: "uppercase",
                }}
              >
                {m.label}
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: M.raisin,
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {m.value}
              </div>
            </div>
          ))}
          <span style={{ flex: 1 }} />
          {interactive ? (
            <ChevronRight
              size={19}
              strokeWidth={1.75}
              color="#C4BDB2"
              style={{ flexShrink: 0 }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
