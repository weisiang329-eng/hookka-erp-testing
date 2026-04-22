// ---------------------------------------------------------------------------
// Shared pricing helpers — single source of truth for unit-price & line-total
// calculations across the Sales create page and SO API handlers.
// ---------------------------------------------------------------------------

export interface PricingInput {
  basePriceSen: number;
  divanPriceSen?: number;
  legPriceSen?: number;
  totalHeightPriceSen?: number;
  specialOrderPriceSen?: number;
}

/**
 * Sum all price components into a single unit price (in sen).
 *
 * `totalHeightPriceSen` is used by the frontend create page but is NOT sent
 * to the API as a separate field — it's folded into the line item before
 * submission. API handlers therefore omit it (defaults to 0).
 */
export function calculateUnitPrice(input: PricingInput): number {
  return (
    (input.basePriceSen || 0) +
    (input.divanPriceSen || 0) +
    (input.legPriceSen || 0) +
    (input.totalHeightPriceSen || 0) +
    (input.specialOrderPriceSen || 0)
  );
}

/**
 * Line total = unit price x quantity (both in sen).
 */
export function calculateLineTotal(unitPriceSen: number, quantity: number): number {
  return unitPriceSen * quantity;
}
