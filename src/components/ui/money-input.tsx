import * as React from "react";
import { cn } from "@/lib/utils";

export interface MoneyInputProps {
  /** The RM value in dollars (e.g. 25.5 for RM 25.50). Pass null/0 for empty. */
  value: number | null;
  /** Receives the parsed RM dollar number on commit (blur/Enter), or null when cleared to blank. */
  onChange: (next: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
  /** Optional: select-all on focus. Defaults to true to match existing money fields. */
  selectOnFocus?: boolean;
}

/**
 * MoneyInput — entry/display UX for RM amounts.
 *
 * Display behaviour:
 *  - When NOT focused: shows the value formatted to 2 decimals (e.g. "25.50"), blank for null.
 *  - When focused: shows the raw text and lets the user type freely (including clearing to
 *    blank). No reformatting mid-type, so no keystroke-eating.
 *  - Commits a parsed number on blur or Enter. Empty string commits as null.
 *
 * This is ONLY a UX layer — it does not own or transform the money math. The parent keeps its
 * exact state shape; MoneyInput's onChange hands back the same dollar-number shape a raw
 * `<input type="number">`'s `parseFloat(e.target.value)` would produce.
 */
const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onChange, disabled, placeholder, className, id, selectOnFocus = true }, ref) => {
    const [focused, setFocused] = React.useState(false);
    const [draft, setDraft] = React.useState("");

    const formatted =
      value === null || value === undefined || Number.isNaN(value) ? "" : value.toFixed(2);

    // While focused, show the user's raw draft. While blurred, show the formatted value.
    const displayValue = focused ? draft : formatted;

    const commit = (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === "") {
        onChange(null);
        return;
      }
      const parsed = parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
        onChange(parsed);
      } else {
        onChange(null);
      }
    };

    return (
      <input
        ref={ref}
        id={id}
        type="number"
        inputMode="decimal"
        step="0.01"
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          "flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-right text-[#1F1D1B] placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        value={displayValue}
        onFocus={(e) => {
          setFocused(true);
          // Seed the draft from the current formatted value so typing continues naturally.
          setDraft(formatted);
          if (selectOnFocus) e.currentTarget.select();
        }}
        onChange={(e) => {
          // Let the user type freely; don't reformat or coerce mid-keystroke.
          setDraft(e.target.value);
        }}
        onBlur={() => {
          setFocused(false);
          commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(draft);
            // Reflect the committed value immediately without waiting for blur.
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
);
MoneyInput.displayName = "MoneyInput";

export { MoneyInput };
