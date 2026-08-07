import * as React from "react";
import { cn } from "@/lib/utils";
import { parseDiscountEntrySen } from "@/lib/pricing";

export interface DiscountInputProps {
  /** The amount (in sen) the percentage is computed off — e.g. the invoice subtotal before discount. */
  baseAmountSen: number;
  /** Current discount in sen (controlled). Null means no discount / cleared. */
  valueSen: number | null;
  /** Fires on commit (blur or Enter) with the resolved sen amount, or null when cleared. */
  onChange: (sen: number | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * DiscountInput — percent-aware RM discount field.
 *
 * Entry modes (accepted on blur / Enter) — the maths lives in the pure
 * `parseDiscountEntrySen` (src/lib/pricing.ts) so it is unit-testable:
 *  - "20%"   → 20% of baseAmountSen, rounded UP to a whole ringgit
 *              (owner 2026-08-07; a computed money value must be divisible)
 *  - "50.00" → 5000 sen, exactly as typed (a typed value is never re-rounded)
 *  - ""      → emits null
 *
 * Display (when NOT focused): resolved RM value "(valueSen/100).toFixed(2)".
 * When focused: raw draft text so the operator can type "20%" freely.
 * Select-all on focus.
 */
const DiscountInput = React.forwardRef<HTMLInputElement, DiscountInputProps>(
  (
    {
      baseAmountSen,
      valueSen,
      onChange,
      placeholder = "0.00 or 20%",
      className,
      disabled,
    },
    ref,
  ) => {
    const [focused, setFocused] = React.useState(false);
    const [draft, setDraft] = React.useState("");

    const formatted =
      valueSen === null || valueSen === undefined ? "" : (valueSen / 100).toFixed(2);

    const displayValue = focused ? draft : formatted;

    const commit = (raw: string) => {
      onChange(parseDiscountEntrySen(raw, baseAmountSen));
    };

    return (
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          "flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-right text-[#1F1D1B] placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        value={displayValue}
        onFocus={(e) => {
          setFocused(true);
          setDraft(formatted);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={() => {
          setFocused(false);
          commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(draft);
            e.currentTarget.blur();
          }
        }}
      />
    );
  },
);
DiscountInput.displayName = "DiscountInput";

export { DiscountInput };
