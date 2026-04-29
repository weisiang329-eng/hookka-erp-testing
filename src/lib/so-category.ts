// ---------------------------------------------------------------------------
// Sales-order category helpers — single source of truth for the rule that
// SOFA + BEDFRAME may NOT be combined on the same Sales Order, and for
// deriving an SO's primary category from its line items.
//
// Sofa and framing run on completely separate production lines (Fab Cut
// merge keys, BF qty derived from HB, parallel lead times). Bundling them
// on one SO breaks the production lifecycle. Accessories are small add-on
// items that ride along with any order — pure-accessory SOs are valid.
// ---------------------------------------------------------------------------

export type SoCategory = "SOFA" | "BEDFRAME" | "ACCESSORY";

interface CategorisedItem {
  itemCategory?: string | null;
}

/**
 * User-facing error message when a caller tries to put both SOFA and
 * BEDFRAME items on the same Sales Order. English-only — the codebase
 * is in the middle of a Chinese-to-English UI sweep.
 */
export const SO_MIXED_CATEGORY_ERROR =
  "Sofa and Bedframe cannot be on the same Sales Order. Please split into two orders.";

/**
 * Returns true when the line items violate the hard restriction (both
 * SOFA and BEDFRAME present on the same order). Empty / accessory-only
 * orders return false.
 */
export function hasMixedSofaBedframe(items: CategorisedItem[]): boolean {
  let hasSofa = false;
  let hasBedframe = false;
  for (const it of items) {
    const cat = (it.itemCategory ?? "").toUpperCase();
    if (cat === "SOFA") hasSofa = true;
    else if (cat === "BEDFRAME") hasBedframe = true;
    if (hasSofa && hasBedframe) return true;
  }
  return false;
}

/**
 * Derive the primary category for an SO from its line items.
 *
 *   - any SOFA line       -> SOFA
 *   - else any BEDFRAME   -> BEDFRAME
 *   - else (all ACCESSORY)-> ACCESSORY
 *
 * SOFA-vs-BEDFRAME ambiguity is impossible because hasMixedSofaBedframe
 * is enforced at SO create / edit / confirm. Empty input falls back to
 * BEDFRAME (matches the SO-item default elsewhere in the codebase).
 */
export function getPrimarySoCategory(items: CategorisedItem[]): SoCategory {
  let hasBedframe = false;
  for (const it of items) {
    const cat = (it.itemCategory ?? "").toUpperCase();
    if (cat === "SOFA") return "SOFA";
    if (cat === "BEDFRAME") hasBedframe = true;
  }
  if (hasBedframe) return "BEDFRAME";
  return "ACCESSORY";
}
