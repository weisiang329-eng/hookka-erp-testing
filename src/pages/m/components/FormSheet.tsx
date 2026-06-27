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
import { Plus, Trash2, AlertCircle } from "lucide-react";
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
    <Sheet open={open} onClose={onClose} title={spec.title}>
      <div style={{ display: "grid", gap: 14 }}>
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

        {/* Field grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px 10px",
          }}
        >
          {spec.fields.map((f) => (
            <div
              key={f.name}
              style={{ gridColumn: f.full ? "1 / -1" : undefined, minWidth: 0 }}
            >
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

        {/* Footer */}
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <button onClick={onClose} disabled={saving} style={btnStyle(false)}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving} style={btnStyle(true)}>
            {saving ? "Saving…" : spec.submitLabel || "Save"}
          </button>
        </div>
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
        rows={3}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...style, resize: "vertical", minHeight: 64 }}
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

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: M.raisin }}>
          {spec.label} ({items.length})
        </div>
        <button onClick={addItem} style={addBtnStyle}>
          <Plus size={14} strokeWidth={2.2} />
          Add
        </button>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
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
            No line items yet — tap Add.
          </div>
        ) : (
          items.map((it, i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${M.border}`,
                borderRadius: 12,
                padding: 10,
                backgroundColor: M.card,
              }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                {spec.fields.map((lf) => (
                  <div key={lf.name}>
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginTop: 8,
                }}
              >
                <button onClick={() => removeItem(i)} style={removeBtnStyle}>
                  <Trash2 size={13} strokeWidth={2} />
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {total != null ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 12,
            padding: "10px 12px",
            backgroundColor: M.card,
            border: `1px solid ${M.border}`,
            borderRadius: 12,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: M.body }}>
            Amount
          </span>
          <span
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: M.raisin,
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
  return (
    <div
      style={{
        fontSize: small ? 10 : 11,
        color: M.muted,
        marginBottom: 3,
        fontWeight: 600,
      }}
    >
      {text}
      {required ? <span style={{ color: "#9A3A2D" }}> *</span> : null}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "9px 12px",
  borderRadius: 12,
  border: `1px solid ${M.border}`,
  backgroundColor: M.card,
  fontSize: 14,
  color: M.raisin,
  outline: "none",
  fontVariantNumeric: "tabular-nums",
  boxSizing: "border-box",
};

const inputStyleCompact: React.CSSProperties = {
  ...inputStyle,
  padding: "8px 10px",
  fontSize: 13,
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

const addBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 12px",
  borderRadius: 9999,
  border: `1px solid ${M.taupe}`,
  backgroundColor: M.taupe,
  color: "#fff",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

const removeBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 10px",
  borderRadius: 9999,
  border: `1px solid ${M.border}`,
  backgroundColor: M.card,
  color: "#9A3A2D",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};
