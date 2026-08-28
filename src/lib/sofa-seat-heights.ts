// ---------------------------------------------------------------------------
// sofa-seat-heights — THE list of sofa seat heights, for every screen that
// shows one.
//
// ## Why this file exists
//
// Owner 2026-08-21: 「这些不可以写死啊 应该要根据我的 product maintenance 那边啊」
//
// He added `20` to Maintenance → Sofa → Sizes and it appeared in exactly ONE
// place: the SKU Master price grid. A sweep found the same list hardcoded in
// seven other places, and they did not even agree with each other:
//
//   products/index.tsx            reads the config          ← the only one
//   customers.tsx  (twice)        ["24","28","30","32","35"]
//   generate-customer-quotation-pdf-v2.ts
//                                 ["24","28","30","32","35"]
//   cnc-templates.tsx             ["24","26","28","30","32","35"]
//   maintenance/sofa-combos.tsx (twice)
//                                 ["24","28","30","32","35"]
//   SofaComboHistoryDialog.tsx    ["24","28","30","32","35"]
//   MasterPriceHistoryDialog.tsx  ["24","28","30","32","35"]
//
// Six of the eight were missing 26", which has been a live size all along — so
// a customer-specific price for a 26" seat could not be entered at all, and the
// quotation PDF could not print one.
//
// PR #109 (2026-07-27) fixed exactly this, for exactly one screen: "sofa
// seat-price columns follow Maintenance Sizes (dynamic)". The other seven were
// left. That is the repo's own documented failure mode — `BUG-CLASSES.md` opens
// with it: three classes each "fixed" three times because every fix repaired
// only the instance in front of the author.
//
// So: one function, one meaning of "the seat heights", and no second copy to
// drift.
//
// ## Why the filter is numeric
//
// A seat height is a measurement in inches; the Maintenance tab says so on the
// label. The price columns are keyed `h24`, `h26` … and a non-numeric entry has
// nowhere to go. The owner added `DEFAULT` to the list and nothing happened,
// which is a fair complaint — but the answer is that a per-product fallback
// price already exists (`products.basePriceSen`, which the pricer falls back to
// when no seat height matches), not that `DEFAULT` should become a column.
// ---------------------------------------------------------------------------

/** Used when the config is missing or holds nothing usable. */
export const FALLBACK_SOFA_SEAT_HEIGHTS = ["24", "26", "28", "30", "32", "35"];

/** Only the shape this function needs, so callers can pass any config object. */
export type SofaSizesConfigLike = { sofaSizes?: unknown };

/**
 * The seat heights to show, from the Maintenance config.
 *
 * Bare numeric strings, ascending. `"28"`, `28`, and `'28"'` all normalise to
 * `"28"`; anything that is not a measurement is dropped.
 *
 * An empty or absent list degrades to {@link FALLBACK_SOFA_SEAT_HEIGHTS} rather
 * than to nothing — a screen with no columns at all reads as "this product has
 * no prices", which is a different and worse lie than showing the usual set.
 */
export function sofaSeatHeights(cfg: SofaSizesConfigLike | null | undefined): string[] {
  const raw = Array.isArray(cfg?.sofaSizes) ? (cfg?.sofaSizes as unknown[]) : [];
  const cleaned = raw
    .map((s) => String(s ?? "").replace(/"/g, "").trim())
    .filter((s) => /^\d+(?:\.\d+)?$/.test(s));
  const uniq = [...new Set(cleaned)];
  const base = uniq.length > 0 ? uniq : FALLBACK_SOFA_SEAT_HEIGHTS;
  return [...base].sort((a, b) => Number(a) - Number(b));
}

/**
 * Entries the list carries that are NOT usable as a seat height.
 *
 * Exists so a screen can SAY SO instead of silently dropping them — the whole
 * reason this was reported is that adding `DEFAULT` produced no column and no
 * message. Silence is what made a five-minute question take two days.
 */
export function unusableSofaSizes(cfg: SofaSizesConfigLike | null | undefined): string[] {
  const raw = Array.isArray(cfg?.sofaSizes) ? (cfg?.sofaSizes as unknown[]) : [];
  return raw
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length > 0 && !/^\d+(?:\.\d+)?"?$/.test(s));
}
