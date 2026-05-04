// ---------------------------------------------------------------------------
// FilterChips — visible active filter strip for list pages.
//
// Odoo / SAP Fiori signature: every applied filter shows as a removable
// chip above the table, so users always know WHY their list is narrowed.
// Click the × on a chip to clear that single filter; click "Clear all"
// to wipe the lot.
//
// Usage:
//   <FilterChips
//     chips={[
//       fltCustomer && { key: 'customer', label: `Customer: ${fltCustomer}`, onRemove: () => setFltCustomer('') },
//       fltStatus && { key: 'status', label: `Status: ${fltStatus}`, onRemove: () => setFltStatus('') },
//       fltDueFrom && { key: 'from', label: `From ${fltDueFrom}`, onRemove: () => setFltDueFrom('') },
//     ]}
//     onClearAll={() => { setFltCustomer(''); setFltStatus(''); setFltDueFrom(''); }}
//   />
//
// Renders nothing when no chips are active — caller doesn't need to
// short-circuit. Falsy entries (e.g. empty filter string) are filtered
// out, so spreading conditional values is safe.
// ---------------------------------------------------------------------------
import { X } from "lucide-react";

export type FilterChip = {
  key: string;
  label: string;
  onRemove: () => void;
};

export function FilterChips({
  chips,
  onClearAll,
  className,
}: {
  /** Chips to render. Falsy entries (empty string / undefined / null / false) are dropped. */
  chips: ReadonlyArray<FilterChip | false | null | undefined | "">;
  /** Optional "Clear all" button callback. Hidden when there's only one chip. */
  onClearAll?: () => void;
  className?: string;
}) {
  const real = chips.filter(
    (c): c is FilterChip => !!c && typeof c === "object" && "label" in c,
  );
  if (real.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}
      aria-label="Active filters"
    >
      {real.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={c.onRemove}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[#FAF9F7] border border-[#E2DDD8] text-[#1F1D1B] hover:bg-[#F2EEE8] transition-colors group"
          aria-label={`Remove ${c.label}`}
        >
          <span>{c.label}</span>
          <X className="w-3 h-3 text-[#9A918A] group-hover:text-[#1F1D1B]" />
        </button>
      ))}
      {real.length > 1 && onClearAll && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-[#9A918A] hover:text-[#1F1D1B] underline px-1.5"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
