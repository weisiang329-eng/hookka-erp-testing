// ===========================================================================
// FormSheet — the ONE reusable create/edit form, driven by a FormSpec.
//
// Renders inside the existing bottom-Sheet. Field controls: text, number,
// money (RM in / integer sen out via roundSen), date, select (static or fetched
// from an existing list endpoint via the SWR cache), textarea, plus an
// add/remove line-item editor. A live "Amount" total (Σ qty × unit price) is
// shown when the line-item spec declares qty/price keys.
//
// Self-contained inline feedback: there is NO ToastProvider on /m, so success
// and error are rendered as a banner inside the sheet. On a successful submit
// the sheet closes and (if the spec returns navigateTo) the caller navigates
// to the new/edited document.
//
// ADDITIVE: consumes existing endpoints + the Phase-1 Sheet primitive only.
// ===========================================================================
import { useMemo, useState } from "react";
import { Plus, Trash2, AlertCircle, Check } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency, roundSen } from "@/lib/utils";
import { Sheet } from "./Sheet";
import { M } from "../theme";
import {
  type FormSpec,
  type FormField,
  type LineItemSpec,
  type FormValues,
  type SelectOption,
  type FieldKind,
} from "../config/form-types";

type Props = {
  open: boolean;
  onClose: () => void;
  spec: FormSpec | null;
  /** Called with the route to navigate to after a successful save. */
  onSaved?: (navigateTo?: string) => void;
};

export function FormSheet({ open, onClose, spec, onSaved }: Props) {
  // Re-seed working state when the sheet transitions closed→open (so an edit
  // form prefills, and a create form resets). Render-time state adjustment
  // (React's endorsed alternative to setState-in-effect).
  const [values, setValues] = useState<FormValues>(spec?.initial ?? {});
  const [wasOpen, setWasOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (open && !wasOpen) {
    setWasOpen(true);
    setValues(spec?.initial ?? {});
    setError(null);
    setSaving(false);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const set = (name: string, v: unknown) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  if (!spec) return null;

  const handleSubmit = async () => {
    setError(null);
    const vErr = spec.validate?.(values);
    if (vErr) {
      setError(vErr);
      return;
    }
    // Required-field check (top-level fields).
    for (const f of spec.fields) {
      if (!f.required) continue;
      const v = values[f.name];
      if (v == null || (typeof v === "string" && v.trim() === "")) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    setSaving(true);
    const res = await spec.submit(values);
    setSaving(false);
    if (!res.ok) {
      setError(res.error || "Save failed.");
      return;
    }
    onClose();
    onSaved?.(res.navigateTo);
  };

  return (
    // No Sheet title — the editor renders its own header (title + red "Cancel"
    // text link) to match the design source 1:1. Sheet still supplies the drag
    // handle + backdrop-tap / Esc close.
    <Sheet open={open} onClose={onClose}>
      <div style={{ display: "grid", gap: 13 }}>
        {/* Header — design source: title 18/800, "Cancel" red text link. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 3,
          }}
        >
          <span
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: M.raisin,
              letterSpacing: "-0.3px",
            }}
          >
            {spec.title}
          </span>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              background: "none",
              border: "none",
              padding: 4,
              fontSize: 13,
              fontWeight: 600,
              color: "#9A3A2D",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            Cancel
          </button>
        </div>

        {spec.note ? (
          <div
            style={{
              fontSize: 12,
              color: M.body,
              backgroundColor: "#F0EAD8",
              border: `1px solid ${M.border}`,
              borderRadius: 12,
              padding: "10px 12px",
              lineHeight: 1.45,
            }}
          >
            {spec.note}
          </div>
        ) : null}

        {/* Fields — design source: single column, full-width inputs. */}
        <div style={{ display: "grid", gap: 13 }}>
          {spec.fields.map((f) => (
            <div key={f.name} style={{ minWidth: 0 }}>
              <FieldControl
                field={f}
                value={values[f.name]}
                onChange={(v) => set(f.name, v)}
              />
            </div>
          ))}
        </div>

        {/* Line-item editor */}
        {spec.lineItems ? (
          <LineItemEditor
            spec={spec.lineItems}
            items={(values[spec.lineItems.name] as Record<string, unknown>[]) ?? []}
            onChange={(arr) => set(spec.lineItems!.name, arr)}
          />
        ) : null}

        {/* Error banner */}
        {error ? (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              fontSize: 13,
              color: "#9A3A2D",
              backgroundColor: "rgba(154,58,45,0.08)",
              border: "1px solid rgba(154,58,45,0.28)",
              borderRadius: 12,
              padding: "10px 12px",
            }}
          >
            <AlertCircle size={16} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Footer — design source: full-width taupe Save with a check glyph. */}
        <button
          onClick={handleSubmit}
          disabled={saving}
          style={{
            width: "100%",
            height: 52,
            marginTop: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderRadius: 15,
            border: "none",
            backgroundColor: M.taupe,
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {saving ? (
            "Saving…"
          ) : (
            <>
              <Check size={19} strokeWidth={2.2} />
              {spec.submitLabel || "Save"}
            </>
          )}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Top-level field control.
// ---------------------------------------------------------------------------
function FieldControl({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div>
      <Label text={field.label} required={field.required} />
      <Control
        kind={field.kind}
        value={value}
        onChange={onChange}
        placeholder={field.placeholder}
        options={field.options}
        optionsUrl={field.optionsUrl}
        optionsSelect={field.optionsSelect}
        optionsMap={field.optionsMap}
      />
      {field.hint ? (
        <div style={{ fontSize: 11, color: M.muted, marginTop: 3 }}>
          {field.hint}
        </div>
      ) : null}
    </div>
  );
}

// One control, shared by top-level fields + line-item cells.
function Control({
  kind,
  value,
  onChange,
  placeholder,
  options,
  optionsUrl,
  optionsSelect,
  optionsMap,
  compact,
}: {
  kind: FieldKind;
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string;
  options?: SelectOption[];
  optionsUrl?: string;
  optionsSelect?: (resp: unknown) => unknown[];
  optionsMap?: (row: unknown) => SelectOption;
  compact?: boolean;
}) {
  const style = compact ? inputStyleCompact : inputStyle;

  if (kind === "money") {
    // value is integer sen; show RM with 2 decimals.
    const sen = typeof value === "number" ? value : 0;
    const display = value === "" || value == null ? "" : (sen / 100).toString();
    return (
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        value={display}
        placeholder={placeholder ?? "0.00"}
        onChange={(e) => {
          const rm = e.target.value;
          if (rm === "") {
            onChange(0);
            return;
          }
          const n = Number(rm);
          onChange(Number.isFinite(n) ? roundSen(n * 100) : 0);
        }}
        style={style}
      />
    );
  }

  if (kind === "number") {
    return (
      <input
        type="number"
        inputMode="decimal"
        value={value == null || value === "" ? "" : Number(value)}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : Number(e.target.value))
        }
        style={style}
      />
    );
  }

  if (kind === "date") {
    return (
      <input
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        style={style}
      />
    );
  }

  if (kind === "textarea") {
    return (
      <textarea
        value={typeof value === "string" ? value : ""}
        placeholder={placeholder}
        rows={4}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...style,
          height: "auto",
          padding: "12px 14px",
          resize: "vertical",
          minHeight: 92,
        }}
      />
    );
  }

  if (kind === "select") {
    return (
      <SelectControl
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
        placeholder={placeholder}
        options={options}
        optionsUrl={optionsUrl}
        optionsSelect={optionsSelect}
        optionsMap={optionsMap}
        style={style}
      />
    );
  }

  // text
  return (
    <input
      type="text"
      value={typeof value === "string" ? value : ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={style}
    />
  );
}

// Select with optional fetched options (cached).
function SelectControl({
  value,
  onChange,
  placeholder,
  options,
  optionsUrl,
  optionsSelect,
  optionsMap,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  options?: SelectOption[];
  optionsUrl?: string;
  optionsSelect?: (resp: unknown) => unknown[];
  optionsMap?: (row: unknown) => SelectOption;
  style: React.CSSProperties;
}) {
  const { data } = useCachedJson<unknown>(optionsUrl ?? null);
  const fetched = useMemo<SelectOption[]>(() => {
    if (!optionsUrl || !data) return [];
    const rows = optionsSelect ? optionsSelect(data) : selectDataArr(data);
    const map =
      optionsMap ??
      ((r: unknown) => {
        const o = (r ?? {}) as Record<string, unknown>;
        const v = String(o.id ?? o.code ?? "");
        return { value: v, label: String(o.name ?? o.code ?? v) };
      });
    return rows
      .map(map)
      .filter((o) => o.value !== "");
  }, [optionsUrl, data, optionsSelect, optionsMap]);

  const opts = options ?? fetched;

  // Design source: selects render as a wrap of pill chips, the active one
  // filled taupe. When the option list is long (fetched catalogs, e.g. a
  // customer/supplier picker) chips would overflow the sheet — fall back to a
  // native select for those. The threshold keeps short status/scope enums as
  // chips (the design's intent) while staying usable for big lists.
  const asChips = !optionsUrl && opts.length > 0 && opts.length <= 6;

  if (asChips) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {opts.map((o) => {
          const active = value === o.value;
          return (
            <span
              key={o.value}
              role="button"
              tabIndex={0}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onChange(o.value);
                }
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "8px 13px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                border: `1px solid ${active ? M.taupe : M.hairline}`,
                backgroundColor: active ? M.taupe : M.card,
                color: active ? "#fff" : M.body,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {o.label}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...style, appearance: "auto" }}
    >
      <option value="">{placeholder ?? "Select…"}</option>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function selectDataArr(resp: unknown): unknown[] {
  if (!resp || typeof resp !== "object") return Array.isArray(resp) ? resp : [];
  const o = resp as { data?: unknown };
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(resp)) return resp as unknown[];
  return [];
}

// ---------------------------------------------------------------------------
// Line-item editor.
// ---------------------------------------------------------------------------
function LineItemEditor({
  spec,
  items,
  onChange,
}: {
  spec: LineItemSpec;
  items: Record<string, unknown>[];
  onChange: (items: Record<string, unknown>[]) => void;
}) {
  const total = useMemo(() => {
    if (!spec.qtyKey || !spec.priceKey) return null;
    let sum = 0;
    for (const it of items) {
      const q = Number(it[spec.qtyKey]) || 0;
      const p = Number(it[spec.priceKey]) || 0; // sen
      sum += q * p;
    }
    return roundSen(sum);
  }, [items, spec.qtyKey, spec.priceKey]);

  const updateItem = (i: number, name: string, v: unknown) => {
    const next = items.map((it, idx) =>
      idx === i ? { ...it, [name]: v } : it,
    );
    onChange(next);
  };
  const removeItem = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const addItem = () => onChange([...items, spec.blank()]);

  // Design source layout: the first text field is the "name" (full-width input
  // + trash on the same row); every remaining field sits in a labelled column
  // on a second flex row. This keeps the editor config-driven while matching
  // the design's name / QTY / UNIT PRICE shape exactly.
  const nameField = spec.fields.find((f) => f.kind === "text") ?? spec.fields[0];
  const restFields = spec.fields.filter((f) => f !== nameField);

  return (
    <div>
      {/* Header — design source: uppercase label + taupe "Add item" link. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "5px 0 9px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#A89F8D",
            textTransform: "uppercase",
            letterSpacing: "0.4px",
          }}
        >
          {spec.label}
        </span>
        <button onClick={addItem} style={addBtnStyle}>
          <Plus size={16} strokeWidth={2.2} />
          Add item
        </button>
      </div>

      <div style={{ display: "grid", gap: 9 }}>
        {items.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: M.muted,
              padding: "10px 12px",
              border: `1px dashed ${M.border}`,
              borderRadius: 12,
              textAlign: "center",
            }}
          >
            No line items yet — tap Add item.
          </div>
        ) : (
          items.map((it, i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${M.border}`,
                borderRadius: 12,
                padding: "11px 12px",
                backgroundColor: M.card,
              }}
            >
              {/* Name row + trash (design source). */}
              {nameField ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Control
                      kind={nameField.kind}
                      value={it[nameField.name]}
                      onChange={(v) => updateItem(i, nameField.name, v)}
                      placeholder={nameField.placeholder ?? "Item name"}
                      options={nameField.options}
                      optionsUrl={nameField.optionsUrl}
                      optionsSelect={nameField.optionsSelect}
                      optionsMap={nameField.optionsMap}
                      compact
                    />
                  </div>
                  <button
                    onClick={() => removeItem(i)}
                    aria-label="Remove item"
                    style={trashBtnStyle}
                  >
                    <Trash2 size={18} strokeWidth={2} />
                  </button>
                </div>
              ) : null}

              {/* Remaining fields (QTY, UNIT PRICE, …) on a labelled flex row. */}
              {restFields.length ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  {restFields.map((lf) => (
                    <div key={lf.name} style={{ flex: lf.grow ?? 1, minWidth: 0 }}>
                      <Label text={lf.label} required={lf.required} small />
                      <Control
                        kind={lf.kind}
                        value={it[lf.name]}
                        onChange={(v) => updateItem(i, lf.name, v)}
                        placeholder={lf.placeholder}
                        options={lf.options}
                        optionsUrl={lf.optionsUrl}
                        optionsSelect={lf.optionsSelect}
                        optionsMap={lf.optionsMap}
                        compact
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* Total — design source: plain row (no card), "Total" left, big amount
          right. Wording kept as "Amount" per the spec when no qty/price total
          is computable; the live qty×price sum reads "Total" like the design. */}
      {total != null ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 4px 4px",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: M.muted }}>
            Amount
          </span>
          <span
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: M.raisin,
              letterSpacing: "-0.3px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatCurrency(total)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Label({
  text,
  required,
  small,
}: {
  text: string;
  required?: boolean;
  small?: boolean;
}) {
  // Design source: uppercase label, 11/700, letter-spacing .4, taupe-grey ink.
  // Line-item cell labels (small) drop to 10px without uppercase emphasis.
  return (
    <div
      style={{
        fontSize: small ? 10 : 11,
        color: "#A89F8D",
        marginBottom: small ? 3 : 7,
        fontWeight: small ? 600 : 700,
        textTransform: small ? "none" : "uppercase",
        letterSpacing: small ? undefined : "0.4px",
      }}
    >
      {text}
      {required ? <span style={{ color: "#9A3A2D" }}> *</span> : null}
    </div>
  );
}

// Design source: full-width input, 46px tall, radius 12, #E2DDD8 hairline,
// white fill, 15px raisin ink.
const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 46,
  padding: "0 14px",
  borderRadius: 12,
  border: `1px solid ${M.hairline}`,
  backgroundColor: M.card,
  fontSize: 15,
  color: M.raisin,
  outline: "none",
  fontVariantNumeric: "tabular-nums",
  boxSizing: "border-box",
};

// Line-item cell input — design source: 38px tall, radius 9, 14px.
const inputStyleCompact: React.CSSProperties = {
  ...inputStyle,
  height: 38,
  padding: "0 11px",
  borderRadius: 9,
  fontSize: 14,
};

// Design source: "Add item" is a taupe text link (icon + label), not a pill.
const addBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: 0,
  border: "none",
  background: "none",
  color: M.taupe,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

// Design source: bare red trash glyph beside the item name.
const trashBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  padding: 4,
  border: "none",
  background: "none",
  color: "#9A3A2D",
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};
