// ---------------------------------------------------------------------------
// virtual-group-window — the arithmetic behind windowing a table whose rows
// arrive in INDIVISIBLE groups of unequal height.
//
// WHY THIS AND NOT virtual-window.ts
// That module's model is "one item, one fixed row height". The Working Hours
// grid on /employees fits neither half of it:
//
//   • Rows are grouped per worker-day and the group's Date / Employee / Punch
//     cells are a single `<td rowSpan={n}>`. Half a group is not renderable —
//     the window has to snap to group boundaries.
//   • A lone row is TALLER than a grouped one. Measured on the rendered grid
//     (2026-08-13): 71px for a one-row group, because its Employee cell stacks
//     the worker <select> above the day-total chip; 50px per row once a group has
//     two or more, where the same cell spans them. Feeding a single constant to
//     a fixed-height virtualiser drifts the scrollbar by thousands of pixels
//     over 600 rows.
//
// Same discipline as virtual-window.ts, for the same two production failure
// modes it documents: offsets come from the CALLER's own group list inside the
// render pass — never from the virtualiser's lagging getTotalSize() — and any
// index the virtualiser emits against a previous, larger count is dropped.
// ---------------------------------------------------------------------------

/** The subset of a tanstack-virtual item this math needs. */
export type GroupWindowItem = { index: number };

export type GroupWindowResult = {
  /** First group to render, inclusive. */
  start: number;
  /** Last group to render, inclusive. `-1` when nothing renders. */
  end: number;
  /** Height of the spacer row rendered BEFORE the first visible group. */
  paddingTop: number;
  /** Height of the spacer row rendered AFTER the last visible group. */
  paddingBottom: number;
};

const EMPTY: GroupWindowResult = { start: 0, end: -1, paddingTop: 0, paddingBottom: 0 };

/**
 * Cumulative pixel offsets. `offsets[i]` is the top of group `i`;
 * `offsets[heights.length]` is the table body's total height. Negative or
 * non-finite heights are clamped to 0 so one bad entry can't make the whole
 * scrollbar nonsense.
 */
export function groupOffsets(heights: readonly number[]): number[] {
  const out: number[] = new Array(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    out[i + 1] = out[i] + (Number.isFinite(h) && h > 0 ? h : 0);
  }
  return out;
}

/**
 * Turn the virtualiser's raw output into the group range to render plus the
 * two spacer heights that keep the scrollbar honest.
 *
 * `offsets` is authoritative for both the count and the total height.
 */
export function computeGroupWindow(
  offsets: readonly number[],
  items: readonly GroupWindowItem[],
): GroupWindowResult {
  const count = offsets.length - 1;
  if (count <= 0) return EMPTY;
  let lo = Number.POSITIVE_INFINITY;
  let hi = -1;
  for (const it of items) {
    // Stale index from a previous, larger count — drop it.
    if (it.index < 0 || it.index >= count) continue;
    if (it.index < lo) lo = it.index;
    if (it.index > hi) hi = it.index;
  }
  if (hi < 0) return EMPTY;
  return {
    start: lo,
    end: hi,
    paddingTop: Math.max(0, offsets[lo]),
    paddingBottom: Math.max(0, offsets[count] - offsets[hi + 1]),
  };
}

/**
 * First-paint fallback. Before the scroll container has been measured the
 * virtualiser emits nothing; rendering an empty body would flash a blank table
 * where rows are about to appear. Render a screenful of groups and let the
 * next paint replace it with the real window.
 */
export function firstScreenGroupWindow(
  offsets: readonly number[],
  screenful: number,
): GroupWindowResult {
  const count = offsets.length - 1;
  if (count <= 0 || screenful <= 0) return EMPTY;
  const end = Math.min(count, screenful) - 1;
  return {
    start: 0,
    end,
    paddingTop: 0,
    paddingBottom: Math.max(0, offsets[count] - offsets[end + 1]),
  };
}
