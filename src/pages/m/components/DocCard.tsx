// DocCard — the card-based L1 list item, reskinned 1:1 to the design source
// (Hookka ERP Mobile.dc.html → "LIST (generic, card-based)" branch + dc13 M()
// helper at line ~1693 — every module's cards share the same shape:
//   code · title · items-summary · 2–4 metas in a chip grid · status pill).
//
// Layout per dc13:
//   • Row 1: doc code (12/700 taupe) on the left, status pill on the right.
//   • Title (15/700 raisin, -.2px tracking) — the customer/supplier name.
//   • Items line (12.5 taupe) — what the doc is for (e.g. "Aspen ×12,
//     Hudson HB ×8" on an SO, "Pine 2×2 ×400, MDF ×120" on a PO).
//   • Optional sub-line (12.5 muted) — back-compat for modules with no
//     "items" concept (employees, accounts, etc.) — superseded by `items`
//     when both are set.
//   • Footer (margin-top 11, padding-top 12, top hairline #F2EEE6): a
//     3-column grid of metas — UPPERCASE label (10/600 #A89F8D) + value
//     (13/600 raisin, tabular). Up to 4 metas wrap onto two rows. A
//     trailing chevron sits in the top-right of the footer when interactive.
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
  /** Items summary (dc13 "items" line — what the doc is for). When set,
   * takes the slot below the title; subLine is hidden. */
  items?: string;
  subLine?: string;
  /** Footer meta columns — dc13 cards have 2 to 4. Layout wraps in a
   * 3-col grid. Accepts a 2-tuple (back-compat) or an N-array. */
  meta?: (Meta | undefined)[] | [Meta?, Meta?];
  /** Status pill node (use <StatusPill/>). */
  pill?: ReactNode;
  onClick?: () => void;
};

export function DocCard({ code, title, items, subLine, meta, pill, onClick }: Props) {
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

      {/* Items line (dc13 — preferred). Falls back to subLine when not set. */}
      {items ? (
        <div
          style={{
            fontSize: 12.5,
            color: M.taupe,
            fontWeight: 500,
            marginTop: 3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {items}
        </div>
      ) : subLine ? (
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

      {/* Footer — 3-col metas grid + chevron. dc13 cards have 2–4 metas; this
          wraps cleanly so a 4-meta card flows label/value pairs into 3 + 1. */}
      {metas.length > 0 || interactive ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              metas.length <= 2
                ? `repeat(${metas.length || 1}, minmax(0, 1fr)) auto`
                : "repeat(3, minmax(0, 1fr)) auto",
            alignItems: "start",
            columnGap: 12,
            rowGap: 8,
            marginTop: 11,
            paddingTop: 12,
            borderTop: `1px solid ${M.divider}`,
          }}
        >
          {metas.map((m, i) => (
            <div
              key={i}
              style={{
                minWidth: 0,
                // 4th+ meta flows to row 2 col 1 (grid auto-flow handles it).
                gridColumn: metas.length === 1 ? "1" : undefined,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "#A89F8D",
                  letterSpacing: "0.3px",
                  textTransform: "uppercase",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
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
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {m.value}
              </div>
            </div>
          ))}
          {interactive ? (
            <ChevronRight
              size={19}
              strokeWidth={1.75}
              color="#C4BDB2"
              style={{
                flexShrink: 0,
                alignSelf: "center",
                // Always sits in the last grid column on the FIRST row.
                gridColumn: -1,
                gridRow: 1,
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
