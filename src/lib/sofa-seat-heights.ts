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
// ## Named sizes are KEPT, not filtered (owner 2026-09-08)
//
// The list used to drop anything non-numeric, on the theory that a seat height
// is a measurement in inches. The owner's standing instruction is the opposite:
// the Sizes list is his, and EVERY entry he puts in it — numeric (24, 26 …) or
// NAMED (DEFAULT) — must show up as its own priceable column on every screen
// that reads this. So this function keeps every non-blank entry; only truly
// empty strings drop. Column keys are `h<size>` (e.g. hDEFAULT) and the price is
// stored / looked-up by the size STRING, so a named size round-trips like any
// numeric one. Numeric sizes sort ascending and lead; named sizes follow.
// ---------------------------------------------------------------------------

/** Used when the config is missing or holds nothing usable. */
export const FALLBACK_SOFA_SEAT_HEIGHTS = ["24", "26", "28", "30", "32", "35"];

/** Only the shape this function needs, so callers can pass any config object. */
export type SofaSizesConfigLike = { sofaSizes?: unknown };

/**
 * The seat sizes to show, from the Maintenance config.
 *
 * Every non-blank entry is kept — numeric (`"28"`, `28`, `'28"'` all normalise
 * to `"28"`) or named (`"DEFAULT"`). Numeric sizes sort ascending and lead;
 * named sizes follow, alphabetically.
 *
 * An empty or absent list degrades to {@link FALLBACK_SOFA_SEAT_HEIGHTS} rather
 * than to nothing — a screen with no columns at all reads as "this product has
 * no prices", which is a different and worse lie than showing the usual set.
 */
export function sofaSeatHeights(cfg: SofaSizesConfigLike | null | undefined): string[] {
  const raw = Array.isArray(cfg?.sofaSizes) ? (cfg?.sofaSizes as unknown[]) : [];
  const cleaned = raw
    .map((s) => String(s ?? "").replace(/"/g, "").trim())
    .filter((s) => s.length > 0);
  const uniq = [...new Set(cleaned)];
  const base = uniq.length > 0 ? uniq : FALLBACK_SOFA_SEAT_HEIGHTS;
  const isNum = (s: string) => /^\d+(?:\.\d+)?$/.test(s);
  return [...base].sort((a, b) => {
    const an = isNum(a);
    const bn = isNum(b);
    if (an && bn) return Number(a) - Number(b);
    if (an) return -1;
    if (bn) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Since 2026-09-08 every non-blank size is a valid, priceable column (numeric
 * OR named), so nothing is "unusable" — this always returns []. Kept as a
 * no-op so the (currently unused) callers and the pin test don't have to be
 * deleted in the same change; remove it once nothing references it.
 */
export function unusableSofaSizes(_cfg: SofaSizesConfigLike | null | undefined): string[] {
  return [];
}

/**
 * Display label for a seat size. A numeric size carries the inch mark
 * (`28` → `28"`); a NAMED size (`DEFAULT`) shows exactly as typed. Use this on
 * every screen that prints a seat-size column/row header so a named size never
 * reads as `DEFAULT"`.
 */
export function sofaSeatLabel(size: string): string {
  const s = String(size ?? "").replace(/"/g, "").trim();
  return /^\d+(?:\.\d+)?$/.test(s) ? `${s}"` : String(size ?? "");
}
