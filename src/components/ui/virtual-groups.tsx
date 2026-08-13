"use client";

// ---------------------------------------------------------------------------
// useVirtualGroups — row windowing for a table whose rows come in indivisible
// groups of unequal height.
//
// The sibling of useVirtualRows (./virtual-rows.tsx). That hook covers the
// common case: a flat list of fixed-height rows. This one covers the case its
// model can't express — a `<td rowSpan={n}>` grid, where the window must snap
// to whole groups and a lone row is a different height from a grouped one.
// The arithmetic (and both of its production failure modes) lives in
// ../../lib/virtual-group-window, which is unit-tested without a DOM.
//
// Measured on production (erp.hookka.com, 2026-08-13) the /employees Working
// Hours grid built 695 rows / 46,137 DOM nodes — every other page in the app
// is 900-1,900 — and a plain scroll froze the renderer for over 45 seconds.
// Its 22 API calls totalled 0.17 MB; the entire cost was DOM layout and paint.
//
// The spacers are `<tr>`s holding one full-width `<td>`, so the table's own
// layout algorithm still sees a well-formed body and column widths match the
// non-virtualised path exactly.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  computeGroupWindow,
  firstScreenGroupWindow,
  groupOffsets,
} from "@/lib/virtual-group-window";

// Below this many groups the DOM cost is not worth the windowing machinery,
// and short tables are where spacer rounding would be most visible.
export const VIRTUAL_MIN_GROUPS = 40;

export type UseVirtualGroupsOptions = {
  /**
   * Rendered pixel height of each group, in render order. Its length IS the
   * group count. Memoise it — it is the hook's only source of truth for both
   * the window and the total height.
   */
  groupHeights: number[];
  /** The scrolling element that contains the table. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Column count of the table — the spacer rows' colSpan. */
  colSpan: number;
  /** Groups rendered above and below the viewport. */
  overscan?: number;
  /** Force windowing off. Defaults on once there are VIRTUAL_MIN_GROUPS groups. */
  enabled?: boolean;
};

export type UseVirtualGroupsResult = {
  /** True when only a window of groups is being rendered. */
  active: boolean;
  /** First group to render, inclusive. */
  start: number;
  /** Last group to render, inclusive; `-1` renders nothing. */
  end: number;
  /** Render immediately before the first group; `null` when not needed. */
  topSpacer: React.ReactNode;
  /** Render immediately after the last group; `null` when not needed. */
  bottomSpacer: React.ReactNode;
};

export function useVirtualGroups({
  groupHeights,
  scrollRef,
  colSpan,
  overscan = 6,
  enabled,
}: UseVirtualGroupsOptions): UseVirtualGroupsResult {
  const count = groupHeights.length;
  const active = (enabled ?? true) && count >= VIRTUAL_MIN_GROUPS;

  const offsets = React.useMemo(() => groupOffsets(groupHeights), [groupHeights]);

  // The virtualizer mounts unconditionally — hook order must stay stable
  // across renders even when a filter drops the table under the threshold.
  // Passing count 0 while inactive keeps it inert.
  const virtualizer = useVirtualizer({
    count: active ? count : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const h = groupHeights[i];
      return Number.isFinite(h) && h > 0 ? h : 0;
    },
    overscan,
  });

  if (!active) {
    return { active: false, start: 0, end: count - 1, topSpacer: null, bottomSpacer: null };
  }

  const raw = virtualizer.getVirtualItems();
  const win =
    raw.length > 0
      ? computeGroupWindow(offsets, raw)
      : firstScreenGroupWindow(offsets, overscan * 3);

  return {
    active: true,
    start: win.start,
    end: win.end,
    topSpacer: win.paddingTop > 0 ? spacerRow("__vgrp_top__", win.paddingTop, colSpan) : null,
    bottomSpacer:
      win.paddingBottom > 0 ? spacerRow("__vgrp_bot__", win.paddingBottom, colSpan) : null,
  };
}

function spacerRow(key: string, height: number, colSpan: number): React.ReactNode {
  return (
    <tr key={key} aria-hidden="true">
      <td colSpan={colSpan} style={{ height: `${height}px`, padding: 0, border: 0 }} />
    </tr>
  );
}
