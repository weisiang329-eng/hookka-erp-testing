import { cn } from "@/lib/utils";
import { COUNTRY_DIAL_CODES, splitPhone, joinPhone } from "@/lib/contact-format";

export interface PhoneInputProps {
  /** Stored phone string, e.g. "+60 12-345 6789". Legacy free-text is tolerated. */
  value: string | null | undefined;
  /** Receives the recombined "<dial> <local>" string (empty when the number is blank). */
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
}

/**
 * PhoneInput — a country dial-code picker (default +60 Malaysia) + a local
 * number field, so local and foreign numbers are entered consistently across
 * the whole system. Storage stays a single string; this is only the entry UX.
 */
export function PhoneInput({ value, onChange, disabled, placeholder, className, id }: PhoneInputProps) {
  const { dial, local } = splitPhone(value);
  return (
    <div className={cn("flex gap-1", className)}>
      <select
        aria-label="Country code"
        value={dial}
        disabled={disabled}
        onChange={(e) => onChange(joinPhone(e.target.value, local))}
        className="w-[74px] shrink-0 border border-[#E2DDD8] rounded-lg px-1.5 py-2 text-sm bg-white text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
      >
        {COUNTRY_DIAL_CODES.map((c) => (
          <option key={c.code} value={c.code} title={c.label}>{c.code}</option>
        ))}
      </select>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        disabled={disabled}
        value={local}
        placeholder={placeholder ?? "12-345 6789"}
        onChange={(e) => onChange(joinPhone(dial, e.target.value))}
        className="flex-1 min-w-0 border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
      />
    </div>
  );
}
