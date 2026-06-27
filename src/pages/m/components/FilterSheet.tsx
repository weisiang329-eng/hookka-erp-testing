// ===========================================================================
// FilterSheet — one reusable, type-aware filter/sort bottom-sheet driven by a
// data source's ColumnDefs. Each column renders the right control for its type:
//   text   → "contains" input
//   number → operator (= > < ≥ ≤ range) + value(s)
//   date   → from / to range
//   enum   → multi-select chips (rendered Title Case via titleCaseStatus)
// Plus a Sort section (any column, asc/desc). Apply / Clear at the bottom.
// ===========================================================================
import { useState } from "react";
import { Sheet } from "./Sheet";
import { M } from "../theme";
import { titleCaseStatus } from "../theme";
import {
  type ColumnDef,
  type ActiveFilter,
  type NumberOp,
  NUMBER_OP_LABEL,
} from "../config/types";

type Sort = { key: string; dir: "asc" | "desc" } | null;

type Props = {
  open: boolean;
  onClose: () => void;
  columns: ColumnDef[];
  filters: Record<string, ActiveFilter>;
  sort: Sort;
  onApply: (filters: Record<string, ActiveFilter>, sort: Sort) => void;
};

export function FilterSheet({
  open,
  onClose,
  columns,
  filters,
  sort,
  onApply,
}: Props) {
  // Local working copy so Cancel discards changes. Re-seed from props each
  // time the sheet transitions closed→open by adjusting state during render
  // (React's endorsed alternative to a setState-in-effect; see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [draft, setDraft] = useState<Record<string, ActiveFilter>>(filters);
  const [draftSort, setDraftSort] = useState<Sort>(sort);
  const [wasOpen, setWasOpen] = useState(open);
  if (open && !wasOpen) {
    setWasOpen(true);
    setDraft(filters);
    setDraftSort(sort);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const setFilter = (key: string, f: ActiveFilter | null) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (f == null) delete next[key];
      else next[key] = f;
      return next;
    });
  };

  return (
    <Sheet open={open} onClose={onClose} title="Filter & sort">
      <div style={{ display: "grid", gap: 18 }}>
        {/* ---- Sort ---- */}
        <div>
          <SectionLabel>Sort by</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {columns.map((c) => {
              const isAsc = draftSort?.key === c.key && draftSort.dir === "asc";
              const isDesc =
                draftSort?.key === c.key && draftSort.dir === "desc";
              return (
                <div
                  key={c.key}
                  style={{ display: "flex", alignItems: "center", gap: 2 }}
                >
                  <Chip
                    active={isAsc}
                    onClick={() => setDraftSort({ key: c.key, dir: "asc" })}
                  >
                    {c.label} ↑
                  </Chip>
                  <Chip
                    active={isDesc}
                    onClick={() => setDraftSort({ key: c.key, dir: "desc" })}
                  >
                    ↓
                  </Chip>
                </div>
              );
            })}
            <Chip active={draftSort == null} onClick={() => setDraftSort(null)}>
              None
            </Chip>
          </div>
        </div>

        {/* ---- Per-column filters ---- */}
        {columns.map((col) => (
          <div key={col.key}>
            <SectionLabel>{col.label}</SectionLabel>
            <ColumnControl
              col={col}
              value={draft[col.key]}
              onChange={(f) => setFilter(col.key, f)}
            />
          </div>
        ))}
      </div>

      {/* ---- Footer ---- */}
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <button
          onClick={() => {
            setDraft({});
            setDraftSort(null);
          }}
          style={btnStyle(false)}
        >
          Clear
        </button>
        <button
          onClick={() => {
            onApply(draft, draftSort);
            onClose();
          }}
          style={btnStyle(true)}
        >
          Apply
        </button>
      </div>
    </Sheet>
  );
}

// --------------------------------------------------------------------------

function ColumnControl({
  col,
  value,
  onChange,
}: {
  col: ColumnDef;
  value: ActiveFilter | undefined;
  onChange: (f: ActiveFilter | null) => void;
}) {
  if (col.type === "text") {
    const v = value?.type === "text" ? value.contains : "";
    return (
      <input
        value={v}
        placeholder="Contains…"
        onChange={(e) =>
          onChange(
            e.target.value
              ? { type: "text", contains: e.target.value }
              : null,
          )
        }
        style={inputStyle}
      />
    );
  }

  if (col.type === "number") {
    const op: NumberOp = value?.type === "number" ? value.op : "gte";
    const a = value?.type === "number" ? value.a : null;
    const b = value?.type === "number" ? value.b : null;
    const update = (next: {
      op?: NumberOp;
      a?: number | null;
      b?: number | null;
    }) => {
      const merged = {
        op: next.op ?? op,
        a: next.a !== undefined ? next.a : a,
        b: next.b !== undefined ? next.b : b,
      };
      if (merged.a == null) onChange(null);
      else onChange({ type: "number", ...merged });
    };
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {(Object.keys(NUMBER_OP_LABEL) as NumberOp[]).map((o) => (
            <Chip key={o} active={op === o} onClick={() => update({ op: o })}>
              {NUMBER_OP_LABEL[o]}
            </Chip>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="number"
            inputMode="decimal"
            value={a == null ? "" : a}
            placeholder="Value"
            onChange={(e) =>
              update({ a: e.target.value === "" ? null : Number(e.target.value) })
            }
            style={inputStyle}
          />
          {op === "between" ? (
            <input
              type="number"
              inputMode="decimal"
              value={b == null ? "" : b}
              placeholder="…and"
              onChange={(e) =>
                update({
                  b: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              style={inputStyle}
            />
          ) : null}
        </div>
      </div>
    );
  }

  if (col.type === "date") {
    const from = value?.type === "date" ? value.from : null;
    const to = value?.type === "date" ? value.to : null;
    const update = (next: { from?: string | null; to?: string | null }) => {
      const merged = {
        from: next.from !== undefined ? next.from : from,
        to: next.to !== undefined ? next.to : to,
      };
      if (!merged.from && !merged.to) onChange(null);
      else onChange({ type: "date", ...merged });
    };
    return (
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="date"
          value={from ?? ""}
          onChange={(e) => update({ from: e.target.value || null })}
          style={inputStyle}
        />
        <input
          type="date"
          value={to ?? ""}
          onChange={(e) => update({ to: e.target.value || null })}
          style={inputStyle}
        />
      </div>
    );
  }

  // enum
  const selected = value?.type === "enum" ? value.selected : [];
  const opts = col.options ?? [];
  const toggle = (o: string) => {
    const next = selected.includes(o)
      ? selected.filter((s) => s !== o)
      : [...selected, o];
    onChange(next.length ? { type: "enum", selected: next } : null);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {opts.map((o) => (
        <Chip key={o} active={selected.includes(o)} onClick={() => toggle(o)}>
          {titleCaseStatus(o)}
        </Chip>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 700,
        color: M.raisin,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: 9999,
        border: `1px solid ${active ? M.taupe : M.border}`,
        backgroundColor: active ? M.taupe : M.card,
        color: active ? "#fff" : M.body,
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  minWidth: 0,
  padding: "9px 12px",
  borderRadius: 12,
  border: `1px solid ${M.border}`,
  backgroundColor: M.card,
  fontSize: 14,
  color: M.raisin,
  outline: "none",
};

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "12px 0",
    borderRadius: 12,
    border: `1px solid ${primary ? M.taupe : M.border}`,
    backgroundColor: primary ? M.taupe : M.card,
    color: primary ? "#fff" : M.body,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  };
}
