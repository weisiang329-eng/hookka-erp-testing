// ---------------------------------------------------------------------------
// virtual-window — the pure arithmetic behind row windowing.
//
// Kept separate from the React hook (src/components/ui/virtual-rows.tsx) so
// the parts that have actually gone wrong in production can be unit-tested
// without a DOM. Both known failure modes are arithmetic, not rendering:
//
//   1. STALE INDICES. tanstack-virtual can emit virtual items computed from a
//      PREVIOUS `count` in the same tick that the count shrinks sharply — a
//      date filter narrowing the General Ledger from 1,798 rows to 3. Its
//      internal measurement memo recomputes on the next call, but the render
//      pass in flight uses what it already emitted. Unclipped, rows from the
//      old result render alongside the new ones and the visible row count
//      disagrees with the "X of Y" badge.
//
//   2. STALE TOTAL HEIGHT. `getTotalSize()` lags one render behind the same
//      sharp count drop, so a paddingBottom derived from it leaves thousands
//      of pixels of blank space under the last row. Deriving the total from
//      `count * rowHeight` puts the body and the footer on the same source of
//      truth within one render pass.
//
// Both were found the hard way in <DataGrid> (see the long comments around
// its body render); this module is where the fix lives once.
// ---------------------------------------------------------------------------

/** The subset of a tanstack-virtual item this math needs. */
export type WindowItem = {
  index: number;
  start: number;
  end: number;
};

export type WindowResult = {
  /** Item indices to render, ascending, always < count. */
  indices: number[];
  /** Height of the spacer row rendered BEFORE the first visible row. */
  paddingTop: number;
  /** Height of the spacer row rendered AFTER the last visible row. */
  paddingBottom: number;
};

/**
 * Turn the virtualizer's raw output into the exact set of indices to render
 * plus the two spacer heights that keep the scrollbar honest.
 *
 * `count` is authoritative: anything the virtualizer emits beyond it is a
 * stale index from a previous, larger count and is dropped.
 */
export function computeWindow(
  count: number,
  rowHeight: number,
  items: readonly WindowItem[],
): WindowResult {
  if (count <= 0 || rowHeight <= 0) {
    return { indices: [], paddingTop: 0, paddingBottom: 0 };
  }
  const live = items.filter((v) => v.index >= 0 && v.index < count);
  if (live.length === 0) {
    return { indices: [], paddingTop: 0, paddingBottom: 0 };
  }
  const totalSize = count * rowHeight;
  return {
    indices: live.map((v) => v.index),
    paddingTop: Math.max(0, live[0].start),
    paddingBottom: Math.max(0, totalSize - live[live.length - 1].end),
  };
}

/**
 * First-paint fallback. Before the scroll container has been measured the
 * virtualizer emits nothing; rendering an empty body would flash a blank
 * table where rows are about to appear. Render a screenful and let the next
 * paint replace it with the real window.
 */
export function firstScreenWindow(
  count: number,
  rowHeight: number,
  screenful: number,
): WindowResult {
  if (count <= 0 || rowHeight <= 0 || screenful <= 0) {
    return { indices: [], paddingTop: 0, paddingBottom: 0 };
  }
  const shown = Math.min(count, screenful);
  return {
    indices: Array.from({ length: shown }, (_, i) => i),
    paddingTop: 0,
    paddingBottom: Math.max(0, (count - shown) * rowHeight),
  };
}
