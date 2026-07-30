import { cn } from "@/lib/utils";
import { HUB_STATE_CODES } from "@/lib/contact-format";

export interface StateSelectProps {
  value: string | null | undefined;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** Placeholder for the empty option. Defaults to "— State —". */
  placeholder?: string;
}

/**
 * StateSelect — the canonical delivery-hub state-CODE picker (KL / SGR / PG …).
 * These codes drive the 3PL state-rate table and the CS-agent transit-day map,
 * so this stores the code (not a full state name). Centralising the list here
 * means every hub form (Customers page, Convert dialog, …) picks from ONE
 * source instead of duplicating the array inline. A legacy value not in the
 * list is preserved as its own option so existing rows still display.
 */
export function StateSelect({ value, onChange, disabled, className, id, placeholder }: StateSelectProps) {
  const v = (value ?? "").trim();
  const known = (HUB_STATE_CODES as readonly string[]).includes(v);
  return (
    <select
      id={id}
      value={v}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm bg-white text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]",
        className,
      )}
    >
      <option value="">{placeholder ?? "— State —"}</option>
      {HUB_STATE_CODES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
      {v && !known ? <option value={v}>{v}</option> : null}
    </select>
  );
}
