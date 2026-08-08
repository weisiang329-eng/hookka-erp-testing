import * as React from "react";
import { cn, formatCurrency } from "@/lib/utils";
import { type StatusTabSpec } from "@/lib/status-tab-strip";

// ---------------------------------------------------------------------------
// StatusTabStrip — ONE status tab strip for every document list.
//
// Each tab shows the number of documents in that state and the money those
// documents represent. The Delivery Order list proved the pattern; this is that
// strip, extracted so Sales Orders, Purchase Orders, GRN, Purchase Invoices,
// Invoices and Consignment Orders all render it from one place instead of six
// hand-written near-copies that drift apart.
//
// The arithmetic (and the "when is a total honest?" rule) lives in
// src/lib/status-tab-strip.ts — this file is chrome only.
//
// Why not fold this into `Tabs` (./tabs.tsx): that one is the app's GENERAL tab
// bar — page sections, department pickers, anything. This one is specifically a
// status-bucket strip carrying money, with a money label attached. Bolting sen
// onto the general component would put a currency concept in every tab bar in
// the app, and would change how the existing Inventory / R&D / Procurement tab
// bars render. Different job, own component.
//
// MONEY LABEL. "How much" means something different on every list — an
// invoice's billed total, a PO's ordered value, a GRN's received value at cost.
// `moneyLabel` is REQUIRED so no strip can ship an unexplained RM figure; it is
// rendered next to the strip and repeated as each figure's tooltip.
// ---------------------------------------------------------------------------

export interface StatusTabStripProps {
  /** The buckets, in display order. Build `valueSen` via lib/status-tab-strip. */
  tabs: readonly StatusTabSpec[];
  /** Key of the active tab. */
  value: string;
  onChange: (key: string) => void;
  /**
   * What the RM figures mean on THIS list, e.g. "Ordered value" /
   * "Received value at cost". Shown beside the strip and as each figure's
   * tooltip. Required — an unlabelled money total is a guess waiting to happen.
   */
  moneyLabel: string;
  /**
   * "segmented" — compact pill group, for a strip that sits in a card header
   * next to the title (Sales Orders, Purchase Orders, GRN, PI, Consignment).
   * "underline" — full-width nav, for a strip that owns its own row
   *   (the Delivery Order layout; used by Invoices).
   */
  variant?: "segmented" | "underline";
  /** Hides the RM lines while the numbers are still loading. */
  loading?: boolean;
  className?: string;
  /** Accessible name for the tab list. */
  ariaLabel?: string;
}

const DEFAULT_ACTIVE = "bg-[#EFEAE2] text-[#1F1D1B] font-medium shadow-sm";

function MoneyLine({
  valueSen,
  moneyLabel,
  className,
}: {
  valueSen: number | null | undefined;
  moneyLabel: string;
  className?: string;
}) {
  // null / undefined = no derivable figure for this state. Render nothing at
  // all rather than RM 0.00 — see lib/status-tab-strip.ts.
  if (valueSen === null || valueSen === undefined) return null;
  return (
    <span
      title={moneyLabel}
      className={cn("text-[10px] font-normal tabular-nums", className)}
    >
      {formatCurrency(valueSen)}
    </span>
  );
}

export function StatusTabStrip({
  tabs,
  value,
  onChange,
  moneyLabel,
  variant = "segmented",
  loading = false,
  className,
  ariaLabel = "Status",
}: StatusTabStripProps) {
  // One place decides whether a money line exists, so the label caption and the
  // figures can never disagree about whether this strip carries money.
  const showMoney = !loading && tabs.some((t) => t.valueSen !== null && t.valueSen !== undefined);

  if (variant === "underline") {
    return (
      <div className={cn("border-b border-[#E2DDD8]", className)}>
        <nav className="flex items-end gap-4 overflow-x-auto" aria-label={ariaLabel}>
          {tabs.map((tab) => {
            const active = tab.key === value;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => onChange(tab.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-start gap-0.5 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap",
                  active
                    ? "border-[#6B5C32] text-[#6B5C32]"
                    : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]",
                )}
              >
                <span className="flex items-center gap-2">
                  {tab.label}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                      active ? "bg-[#6B5C32] text-white" : "bg-[#F0ECE9] text-[#6B7280]",
                    )}
                  >
                    {tab.count}
                  </span>
                </span>
                {showMoney && (
                  <MoneyLine
                    valueSen={tab.valueSen}
                    moneyLabel={moneyLabel}
                    className="text-[#9CA3AF]"
                  />
                )}
              </button>
            );
          })}
          {showMoney && (
            <span className="ml-auto shrink-0 self-center pb-3 pt-1 text-[10px] uppercase tracking-wide text-[#9CA3AF]">
              {moneyLabel}
            </span>
          )}
        </nav>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="inline-flex rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-0.5"
        role="tablist"
        aria-label={ariaLabel}
      >
        {tabs.map((tab) => {
          const active = tab.key === value;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.key)}
              className={cn(
                "flex flex-col items-center gap-0 rounded px-4 py-1.5 text-sm leading-tight transition-colors cursor-pointer whitespace-nowrap",
                active
                  ? (tab.activeClass ?? DEFAULT_ACTIVE)
                  : "text-[#6B7280] hover:text-[#1F1D1B]",
              )}
            >
              <span className="tabular-nums">
                {tab.label} ({tab.count})
              </span>
              {showMoney && (
                <MoneyLine
                  valueSen={tab.valueSen}
                  moneyLabel={moneyLabel}
                  className={active ? "opacity-80" : "text-[#9CA3AF]"}
                />
              )}
            </button>
          );
        })}
      </div>
      {showMoney && (
        <span className="hidden text-[10px] uppercase tracking-wide text-[#9CA3AF] sm:inline">
          {moneyLabel}
        </span>
      )}
    </div>
  );
}

export default StatusTabStrip;
