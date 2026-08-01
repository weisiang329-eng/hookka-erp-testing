// ---------------------------------------------------------------------------
// incremental-window — the arithmetic behind "show more as you scroll".
//
// Kept out of the React hook (src/components/ui/incremental-list.tsx) so the
// growth rule can be unit-tested without a DOM. It is small on purpose: the
// bug this guards against is an observer that fires twice in one frame, or a
// step that overshoots the list and makes `hasMore` flap between true and
// false forever.
// ---------------------------------------------------------------------------

/**
 * How many items to render after the reader reaches the end of the current
 * slice. Never exceeds `total`, never goes backwards, and always advances by
 * at least one so a bad `step` cannot stall the list.
 */
export function nextIncrementalCount(
  current: number,
  step: number,
  total: number,
): number {
  if (total <= 0) return 0;
  const safeCurrent = Math.max(0, Math.min(current, total));
  if (safeCurrent >= total) return total;
  const safeStep = Math.max(1, Math.floor(step));
  return Math.min(total, safeCurrent + safeStep);
}
