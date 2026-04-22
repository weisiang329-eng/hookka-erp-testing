import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Unified tab bar used across list-centric pages.
 *
 * Two visual variants:
 *   - "underline"  — minimal bottom-border style (Inventory, RD, Procurement).
 *   - "pill"       — rounded segmented-control (Production dept selector).
 *
 * Pure controlled component: parent owns `value` state, gets a callback.
 * Each tab can optionally show a count suffix (e.g. "Finished (42)").
 */

export interface TabItem<T extends string = string> {
  /** Internal key — what `onChange` returns. */
  key: T;
  /** Visible label. */
  label: React.ReactNode;
  /** Optional count displayed in parentheses / suffix. */
  count?: number;
  /** Optional disabled flag — tab is shown greyed out, unclickable. */
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Visual style — default "underline". */
  variant?: "underline" | "pill";
  /** Wrapper className. */
  className?: string;
  /**
   * When `variant="pill"`, optionally constrain to an equal-width grid
   * by passing e.g. "grid-cols-9". If omitted, pills size to their content.
   */
  gridColsClass?: string;
}

export function Tabs<T extends string = string>({
  tabs,
  value,
  onChange,
  variant = "underline",
  className,
  gridColsClass,
}: TabsProps<T>) {
  if (variant === "pill") {
    return (
      <div
        className={cn(
          "rounded-lg border border-[#E6E0D9] bg-[#FAF8F4] p-1",
          className,
        )}
      >
        <div className={cn("gap-1", gridColsClass ? `grid ${gridColsClass}` : "flex")}>
          {tabs.map((tab) => {
            const active = tab.key === value;
            return (
              <button
                key={tab.key}
                type="button"
                disabled={tab.disabled}
                onClick={() => onChange(tab.key)}
                className={cn(
                  "rounded px-3 py-2 text-xs font-semibold uppercase tracking-wide transition truncate",
                  active
                    ? "border border-[#6B5C32] bg-white text-[#1F1D1B] shadow-sm"
                    : "text-[#8A7F73] hover:text-[#1F1D1B]",
                  tab.disabled && "cursor-not-allowed opacity-40 hover:text-[#8A7F73]",
                )}
              >
                {tab.label}
                {typeof tab.count === "number" && (
                  <span className="ml-1 font-normal opacity-60">{tab.count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // underline variant (default)
  return (
    <div className={cn("flex flex-wrap border-b border-[#E6E0D9]", className)}>
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            disabled={tab.disabled}
            onClick={() => onChange(tab.key)}
            className={cn(
              "border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:border-[#D1CBC5] hover:text-[#1F1D1B]",
              tab.disabled && "cursor-not-allowed opacity-40 hover:border-transparent hover:text-[#6B7280]",
            )}
          >
            {tab.label}
            {typeof tab.count === "number" && (
              <span className="ml-1.5 text-xs font-normal opacity-70">
                ({tab.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
