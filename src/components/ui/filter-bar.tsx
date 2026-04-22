import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "./input";
import { cn } from "@/lib/utils";

/**
 * Unified filter bar for list pages.
 *
 * Handles the most common list-page control surface:
 *   - a search box with the magnifying-glass prefix icon
 *   - one or more extra filter controls (selects, date ranges)
 *   - an optional "clear all" affordance
 *
 * Extra filter controls are passed as children so callers keep
 * full flexibility for selects, date pickers, toggles.
 *
 * Usage:
 *   <FilterBar
 *     search={{ value, onChange: setValue, placeholder: "Search by code..." }}
 *     onClear={() => { setValue(""); setCat(""); }}
 *   >
 *     <select ...>...</select>
 *     <select ...>...</select>
 *   </FilterBar>
 */

export interface FilterBarSearchProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Optional max width for the search input; default is sm (24rem). */
  maxWidthClass?: string;
}

export interface FilterBarProps {
  /** Search-input configuration. Omit if the page has no search. */
  search?: FilterBarSearchProps;
  /** Extra filter controls (selects / date pickers). */
  children?: React.ReactNode;
  /**
   * Called when the "Clear" link is clicked. If provided, the clear link
   * appears on the right side. Pages should reset all filter state here.
   */
  onClear?: () => void;
  /** Wrapper className. */
  className?: string;
}

export function FilterBar({
  search,
  children,
  onClear,
  className,
}: FilterBarProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center",
        className,
      )}
    >
      {search && (
        <div
          className={cn(
            "relative flex-1",
            search.maxWidthClass ?? "sm:max-w-sm",
          )}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9A918A]" />
          <Input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? "Search..."}
            className="h-9 pl-9"
          />
        </div>
      )}
      {children}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs font-medium text-[#6B7280] hover:text-[#6B5C32] sm:ml-auto"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </button>
      )}
    </div>
  );
}
