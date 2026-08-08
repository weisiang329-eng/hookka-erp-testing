// ---------------------------------------------------------------------------
// status-tab-strip.ts — the arithmetic behind every document list's status tab
// strip (count + money per state).
//
// Kept OUT of the .tsx component on purpose: this is the part with rules in it
// ("when is a total honest?"), so it has to be unit-testable without a DOM.
// See tests/status-tab-strip.test.mjs.
//
// The pattern it encodes was proven on the Delivery Order list
// (src/pages/delivery/index.tsx): each status tab carries the NUMBER of
// documents in that state and the MONEY those documents represent, e.g.
//
//     Planning 126 · RM 93,806.50   |   Pending Delivery 25 · RM 15,631.00
//
// Two rules, both learned from that page:
//
//   1. Count and money must describe the SAME rows. The DO strip's
//      "Dispatched" tab lists LOADED + IN_TRANSIT, so its money sums LOADED +
//      IN_TRANSIT too. A tab whose badge counts one set and whose RM figure
//      sums another is worse than no RM figure at all.
//
//   2. Never render a confident RM 0.00. The DO strip suppresses money on
//      Cancelled entirely ("those goods were handed back… showing an RM figure
//      there would read as revenue that still exists"). The same reasoning
//      applies to any bucket whose documents simply have no priced lines yet —
//      a draft GRN received before the supplier's prices are keyed in is not
//      worth RM 0.00, it is worth "not known yet". `null` means "show the count
//      alone"; the component renders no money line for it.
//
// Money is integer sen throughout (RM × 100), same as the rest of the app.
// ---------------------------------------------------------------------------

/** One status bucket in a strip. */
export type StatusTabSpec = {
  /** Internal key — what the strip hands back to `onSelect`. */
  key: string;
  /** Visible label. UI is 100% English. */
  label: string;
  /** How many documents are in this state. */
  count: number;
  /**
   * Money those documents represent, in integer sen.
   *
   * `null` (or omitted) = no derivable figure → the tab renders its count
   * alone. Produce it with `tabValueSen` / `sumTabValueSen` rather than by
   * hand, so every list applies the same honesty rule.
   */
  valueSen?: number | null;
  /** Optional per-tab active styling, so a page can keep its existing colours. */
  activeClass?: string;
};

/**
 * Normalise an already-summed figure (typically from a server `/stats`
 * aggregate) into the strip's `valueSen`.
 *
 * Returns `null` — meaning "render the count alone" — when the figure is
 * missing, not finite, or exactly zero. Zero is deliberately treated as
 * "nothing derivable" rather than as a value: a bucket holding real documents
 * that all price to nothing has not been valued, it has been left unpriced, and
 * `RM 0.00` states the opposite with confidence. An empty bucket lands here too
 * and likewise shows no money, which is what it deserves.
 */
export function tabValueSen(total: number | null | undefined): number | null {
  if (total === null || total === undefined) return null;
  const n = Number(total);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/**
 * Sum a bucket's rows into the strip's `valueSen`.
 *
 * `valueOf` returns the row's money in sen, or null/undefined when that row
 * carries none — an unpriced line, a document type that does not hold a value.
 * Such rows are skipped, never counted as zero.
 *
 * The result runs through `tabValueSen`, so a bucket that sums to nothing shows
 * its count alone instead of RM 0.00.
 *
 * Pass the SAME rows the tab lists. That is the whole invariant: whatever array
 * the grid renders for this tab is the array whose money belongs on it — which
 * is also why totals derived this way inherit, for free, every filter and every
 * row-level scope already applied to the list (see api/lib/customer-scope.ts: a
 * salesperson's rows are filtered out of the response before the page ever sees
 * them, so a sum over those rows cannot exceed what they may see).
 */
export function sumTabValueSen<T>(
  rows: readonly T[],
  valueOf: (row: T) => number | null | undefined,
): number | null {
  let total = 0;
  for (const row of rows) {
    const v = valueOf(row);
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total += n;
  }
  return tabValueSen(total);
}

/**
 * Count + money for one bucket, from the rows themselves.
 *
 * The convenience form of the invariant above: one array in, both numbers out,
 * so the two can never be computed from different row sets.
 */
export function tabTotals<T>(
  rows: readonly T[],
  valueOf: (row: T) => number | null | undefined,
): { count: number; valueSen: number | null } {
  return { count: rows.length, valueSen: sumTabValueSen(rows, valueOf) };
}
