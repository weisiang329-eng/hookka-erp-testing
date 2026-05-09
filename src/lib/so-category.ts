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
 * User-facing error message when a SOFA line has quantity > 1.
 *
 * Per Wei Siang (2026-05-09): SOFA must use one unit per SO line. If the
 * customer wants multiple sofas, the operator should add one line per
 * unit (each line qty=1). This avoids ambiguity in production tracking
 * — sofa BOM is per-piece (BASE / CUSHION / ARMREST etc.) and a single
 * PO with qty=N is harder to schedule + complete unit-by-unit than N
 * separate POs each qty=1. BEDFRAME and ACCESSORY do not have this rule;
 * their generator already expands qty>1 into per-unit POs.
 */
export const SOFA_QTY_GT_1_ERROR =
  "Sofa lines must use 1 unit each. Add separate lines for additional units (each line qty=1).";

interface CategorisedItemWithQty extends CategorisedItem {
  quantity?: number | null;
  productCode?: string | null;
  lineNo?: number | null;
}

/**
 * Returns the first SOFA line whose quantity is > 1, or null when all
 * SOFA lines comply with the qty-1-per-line rule. Use the return value
 * to surface a precise error referencing the offending line.
 */
export function findInvalidSofaQty(
  items: CategorisedItemWithQty[],
): CategorisedItemWithQty | null {
  for (const it of items) {
    const cat = (it.itemCategory ?? "").toUpperCase();
    if (cat !== "SOFA") continue;
    const qty = Number(it.quantity ?? 1);
    if (qty > 1) return it;
  }
  return null;
}

/**
 * Format the user-facing error referencing the offending sofa line.
 */
export function formatSofaQtyError(
  offending: CategorisedItemWithQty,
): string {
  const ln = offending.lineNo != null ? `line ${offending.lineNo} ` : "";
  const pc = offending.productCode ? `(${offending.productCode}) ` : "";
  const qty = offending.quantity ?? 1;
  return `Sofa ${ln}${pc}qty=${qty}: ${SOFA_QTY_GT_1_ERROR}`;
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
