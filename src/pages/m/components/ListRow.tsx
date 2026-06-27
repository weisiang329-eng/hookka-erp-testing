// ListRow — the canonical list item for every module list (L1) in Phase 2.
//
// Layout: code (taupe mono) + title + sub-line on the left; up to two meta
// columns (label/value, e.g. Expected DD / Amount) and a status pill on the
// right, with a trailing chevron. Tap target is the whole row (>=44px tall).
import { ChevronRight } from "lucide-react";
import { type ReactNode } from "react";
import { M } from "../theme";

type Meta = {
  label: string;
  value: ReactNode;
};

type Props = {
  /** Document code, e.g. "SO-2606-0142". Rendered taupe + monospace. */
  code: string;
  /** Primary title, e.g. customer name. */
  title: string;
  /** Optional secondary line under the title. */
  subLine?: string;
  /** Up to two right-aligned meta columns. */
  meta?: [Meta?, Meta?];
  /** Status pill node (use <StatusPill/>). */
  pill?: ReactNode;
  onClick?: () => void;
  /** Hide the trailing chevron (e.g. non-navigating rows). */
  noChevron?: boolean;
};

export function ListRow({
  code,
  title,
  subLine,
  meta,
  pill,
  onClick,
  noChevron,
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
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        padding: "12px 14px",
        borderBottom: `1px solid ${M.border}`,
        cursor: interactive ? "pointer" : undefined,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {/* Left block — code, title, sub-line */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            color: M.taupe,
            fontSize: 12,
            fontWeight: 700,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontVariantNumeric: "tabular-nums",
            letterSpacing: 0.2,
          }}
        >
          {code}
        </div>
        <div
          style={{
            color: M.raisin,
            fontSize: 14,
            fontWeight: 600,
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {subLine ? (
          <div
            style={{
              color: M.muted,
              fontSize: 12,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subLine}
          </div>
        ) : null}
        {pill ? <div style={{ marginTop: 6 }}>{pill}</div> : null}
      </div>

      {/* Right block — meta columns */}
      {meta && (meta[0] || meta[1]) ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
            flexShrink: 0,
          }}
        >
          {meta.map((m, i) =>
            m ? (
              <div key={i} style={{ textAlign: "right" }}>
                <div style={{ color: M.muted, fontSize: 10 }}>{m.label}</div>
                <div
                  style={{
                    color: M.raisin,
                    fontSize: 13,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {m.value}
                </div>
              </div>
            ) : null,
          )}
        </div>
      ) : null}

      {!noChevron && interactive ? (
        <ChevronRight
          size={18}
          strokeWidth={1.75}
          color={M.muted}
          style={{ flexShrink: 0 }}
        />
      ) : null}
    </div>
  );
}
