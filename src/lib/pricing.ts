// ---------------------------------------------------------------------------
// Shared pricing helpers — single source of truth for unit-price & line-total
// calculations across the Sales create page and SO API handlers.
// ---------------------------------------------------------------------------
import { roundSen, roundUpToRinggitSen } from "./utils";

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

/**
 * Line total with a per-line discount applied (migration 0179).
 * discount is subtracted AFTER qty×price; result is clamped ≥ 0.
 */
export function calculateLineTotalWithDiscount(
  unitPriceSen: number,
  quantity: number,
  discountSen: number,
): number {
  return Math.max(0, unitPriceSen * quantity - discountSen);
}

/**
 * Resolve one `DiscountInput` entry to sen. Pure half of the component so the
 * money rule is testable without rendering React (`DiscountInput` in
 * `src/components/ui/discount-input.tsx` is the only caller).
 *
 *   "20%"   → 20% of `baseAmountSen`, rounded UP to a whole ringgit
 *   "50.00" → 5000 sen, exactly as typed
 *   ""      → null (cleared)
 *
 * Why the `%` branch rounds up (owner 2026-08-07): a percentage is a COMPUTED
 * money value, so it lands on a whole ringgit like every other computed figure
 * — otherwise `whole unit × qty − 149.25` puts the cents straight back into the
 * line total. Rounding a DISCOUNT up gives the customer the extra, never us, so
 * it can never produce an "you charged me more than quoted" dispute.
 *
 * The typed-RM branch is left EXACTLY as typed — the operator's own number is
 * not a computed value, and silently moving it would be worse than a stray
 * 50-sen discount.
 */
export function parseDiscountEntrySen(
  raw: string,
  baseAmountSen: number,
): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.endsWith("%")) {
    const pct = parseFloat(trimmed.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return roundUpToRinggitSen((baseAmountSen * pct) / 100);
  }
  const rm = parseFloat(trimmed);
  if (!Number.isFinite(rm)) return null;
  return roundSen(rm * 100);
}
