// ---------------------------------------------------------------------------
// SearchableSelect — a drop-in upgrade over native <select> with a
// typeable search box. Built for long option lists (products, customers,
// fabrics...) where scrolling is painful.
//
// API mirrors the minimum a native select needs:
//   value, onChange(value), options[{ value, label }], placeholder,
//   disabled, className
//
// Keyboard:
//   - Arrow Up/Down   move highlight
//   - Enter           select highlight
//   - Escape          close without change
//   - Typing          filter (case-insensitive substring on label)
// ---------------------------------------------------------------------------
import * as React from "react";
import { ChevronDown, Check, Search as SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchableOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Class applied to the trigger button. Keeps backward compat with the
   *  existing `selectClass` strings in sales/create.tsx. */
  className?: string;
  /** Show a "clear" option at the top of the list. Defaults to false so
   *  we don't silently let users wipe required fields. */
  allowClear?: boolean;
  /** Override for empty-state message. */
  emptyMessage?: string;
}

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className,
  allowClear = false,
  emptyMessage = "No matches",
}) => {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);

  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  // Filter — case-insensitive substring on label (this is what users
  // actually want: type "hilton" finds "HILTON BEDFRAME"). We also
  // match on the raw option value so typing a product code works.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Reset search + highlight each time we open. open-transition reset of a
  // user-editable form (query / highlight). Pure derive isn't possible because
  // the user mutates `query` while `open` stays true.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    if (open) {
      setQuery("");
      // Highlight the currently selected option if present, else first.
      const idx = options.findIndex((o) => o.value === value);
      setHighlight(idx >= 0 ? idx : 0);
      // Defer focus so the click that opens doesn't race the blur.
      // Microtask-style 0ms defer; useTimeout is overkill here (and would
      // add an extra render-cycle dependency on `open`).
      // eslint-disable-next-line no-restricted-syntax -- 0ms next-tick defer for focus race-condition
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, options, value]);

  // Clamp highlight when the filtered list shrinks. Highlight is user-driven
  // (arrow keys); we just need to clamp it to a valid index when the list
  // length drops below the current highlight.
  React.useEffect(() => {
    if (highlight >= filtered.length) setHighlight(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlight]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Scroll highlighted item into view.
  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const commit = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt && !opt.disabled) commit(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-left flex items-center justify-between gap-2",
          "focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]",
          "disabled:cursor-not-allowed disabled:bg-[#FAF9F7] disabled:opacity-60",
          open && "ring-2 ring-[#6B5C32]/20 border-[#6B5C32]",
          className,
        )}
      >
        <span
          className={cn(
            "truncate",
            selected ? "text-[#1F1D1B]" : "text-[#9CA3AF]",
          )}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[#9CA3AF]" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[240px] rounded-md border border-[#E2DDD8] bg-white shadow-lg">
          {/* Search input */}
          <div className="border-b border-[#E2DDD8] p-2">
            <div className="relative">
              <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Type to search..."
                className="w-full rounded border border-[#E2DDD8] bg-white pl-7 pr-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
              />
            </div>
          </div>

          {/* Options list */}
          <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
            {allowClear && (
              <button
                type="button"
                onClick={() => commit("")}
                className={cn(
                  "w-full px-3 py-1.5 text-sm text-left italic text-[#9CA3AF] hover:bg-[#FAF9F7]",
                )}
              >
                — Clear selection —
              </button>
            )}
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-[#9CA3AF] text-center">
                {emptyMessage}
              </div>
            ) : (
              filtered.map((opt, i) => (
                <button
                  type="button"
                  key={opt.value}
                  data-idx={i}
                  disabled={opt.disabled}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => {
                    if (!opt.disabled) commit(opt.value);
                  }}
                  className={cn(
                    "w-full px-3 py-1.5 text-sm text-left flex items-center gap-2",
                    "hover:bg-[#FAF9F7]",
                    i === highlight && "bg-[#FAF9F7]",
                    opt.value === value && "font-medium text-[#6B5C32]",
                    opt.disabled && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 flex-shrink-0",
                      opt.value === value
                        ? "text-[#6B5C32]"
                        : "text-transparent",
                    )}
                  />
                  <span className="truncate">{opt.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
