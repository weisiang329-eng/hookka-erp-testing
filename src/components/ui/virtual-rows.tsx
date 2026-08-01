"use client";

// ---------------------------------------------------------------------------
// useVirtualRows — the row-windowing primitive shared by the hand-rolled
// finance tables.
//
// WHY THIS EXISTS
// The shared <DataGrid> already virtualises, but only for a FLAT list: it
// switches virtualisation OFF the moment `groupBy` is enabled, because group
// headers break the "row index === data index" assumption (see the comment
// above `virtualizationActive` in data-grid.tsx). The accounting module is
// the case that comment deferred — General Ledger, Cash Book and the party
// ledgers are *grouped* tables (per-account B/F header, rows, per-account
// totals) rendered as raw `<tbody>` markup, so they could use neither
// DataGrid nor DataGrid's virtualiser.
//
// Measured on production (erp.hookka.com, 2026-08-01) the General Ledger tab
// built 1,798 rows / 17,344 DOM nodes / 63,538px of page height in order to
// show EIGHT rows on screen, freezing the main thread for 844ms on tab entry.
// Its API answered in 296ms — the entire cost was DOM construction.
// /accounting alone accounted for 275 of the system's recorded long-task
// freezes, 25x the next worst page.
//
// THE MODEL
// Callers flatten whatever nested shape they render into ONE array of
// fixed-height items — group headers, data rows and subtotal rows each count
// as one item — and ask this hook which indices are on screen. Spacer rows,
// index clipping and the total-height math live in ../../lib/virtual-window,
// which is unit-tested without a DOM.
//
// The spacers are `<tr>`s holding one full-width `<td>`, so the table's own
// layout algorithm still sees a well-formed body and column widths match the
// non-virtualised path exactly.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { computeWindow, firstScreenWindow } from "@/lib/virtual-window";

// Below this many rows the DOM cost is not worth the windowing machinery,
// and short tables are where spacer-row rounding would be most visible.
// Matches the spirit of DataGrid's VIRTUALIZE_MIN_ROWS, tuned lower because
// the accounting tables pack more rows into the same height.
export const VIRTUAL_MIN_ROWS = 60;

export type UseVirtualRowsOptions = {
  /** Total number of flattened items (headers + rows + subtotals). */
  count: number;
  /** Fixed pixel height of one item. Must match the rendered row height. */
  rowHeight: number;
  /** The scrolling element that contains the table. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Column count of the table — the spacer rows' colSpan. */
  colSpan: number;
  /** Rows rendered above and below the viewport. */
  overscan?: number;
  /**
   * Force windowing off — e.g. while printing or exporting, where every row
   * must exist in the DOM. Defaults on once `count >= VIRTUAL_MIN_ROWS`.
   */
  enabled?: boolean;
};

export type UseVirtualRowsResult = {
  /** True when only a window of rows is being rendered. */
  active: boolean;
  /** Flattened indices to render, in order. Empty when `active` is false. */
  indices: number[];
  /** Render immediately before the first row; `null` when not needed. */
  topSpacer: React.ReactNode;
  /** Render immediately after the last row; `null` when not needed. */
  bottomSpacer: React.ReactNode;
};

export function useVirtualRows({
  count,
  rowHeight,
  scrollRef,
  colSpan,
  overscan = 10,
  enabled,
}: UseVirtualRowsOptions): UseVirtualRowsResult {
  const active = (enabled ?? true) && count >= VIRTUAL_MIN_ROWS;

  // The virtualizer mounts unconditionally — hook order must stay stable
  // across renders even when a filter drops the table under the threshold.
  // Passing count 0 while inactive keeps it inert.
  const virtualizer = useVirtualizer({
    count: active ? count : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  if (!active) {
    return { active: false, indices: [], topSpacer: null, bottomSpacer: null };
  }

  const raw = virtualizer.getVirtualItems();
  const win =
    raw.length > 0
      ? computeWindow(count, rowHeight, raw)
      : firstScreenWindow(count, rowHeight, overscan * 3);

  return {
    active: true,
    indices: win.indices,
    topSpacer: win.paddingTop > 0 ? spacerRow("__virt_top__", win.paddingTop, colSpan) : null,
    bottomSpacer:
      win.paddingBottom > 0 ? spacerRow("__virt_bot__", win.paddingBottom, colSpan) : null,
  };
}

function spacerRow(key: string, height: number, colSpan: number): React.ReactNode {
  return (
    <tr key={key} aria-hidden="true">
      <td colSpan={colSpan} style={{ height: `${height}px`, padding: 0, border: 0 }} />
    </tr>
  );
}
