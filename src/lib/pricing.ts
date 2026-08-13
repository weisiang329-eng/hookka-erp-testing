// ---------------------------------------------------------------------------
// Shared pricing helpers — single source of truth for unit-price & line-total
// calculations across the Sales create page and SO API handlers.
// ---------------------------------------------------------------------------
import { formatCurrency, roundSen, roundUpToRinggitSen } from "./utils";
import {
  invoiceLineUnitSen,
  invoicePriceBuildUp,
  type InvoicePriceRow,
} from "./invoice-line-price";

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
 * `totalHeightPriceSen` IS sent to the API and IS stored, on both order types:
 * `sales_order_items.total_height_price_sen` since 0209 and
 * `consignment_order_items.total_height_price_sen` since 2026-08-13. The old
 * text here ("not sent to the API… handlers therefore omit it") described the
 * pre-0209 world and outlived it by months; it is exactly the belief that kept
 * the CO write path summing four components instead of five. It stays optional
 * only because a caller may genuinely have no such component — never because a
 * write path may skip it.
 *
 * This is the ORDER side's name for the same arithmetic the invoice side calls
 * `invoiceLineUnitSen` — the two columns families differ (`basePriceSen` vs
 * `baseSen`), the rule does not. It delegates rather than re-summing, so the
 * component list cannot drift between the two halves of the system; the rule
 * itself is written down at the top of `invoice-line-price.ts`.
 */
export function calculateUnitPrice(input: PricingInput): number {
  return invoiceLineUnitSen({
    baseSen: input.basePriceSen,
    divanSen: input.divanPriceSen,
    legSen: input.legPriceSen,
    totalHeightSen: input.totalHeightPriceSen,
    specialSen: input.specialOrderPriceSen,
  });
}

/**
 * The ORDER-side build-up rows for a line — Base + each non-zero surcharge.
 *
 * Same rule as the invoice side, same module (`invoicePriceBuildUp`); this is
 * only the column-name translation (`basePriceSen` → `baseSen`, …). Returns
 * `undefined` — meaning "show the single unit price" — when there is no
 * surcharge to explain, or when the components do NOT sum to `chargedSen`.
 *
 * Rule 3, written down in `invoice-line-price.ts`: an explanation that does not
 * add up is not an explanation. That applies to an ORDER line's inline
 * "Unit: X (Base A + Divan B …)" exactly as it applies to the invoice screen
 * and the PDF — those are the same sentence about the same money.
 */
export function orderLinePriceBuildUp(
  input: PricingInput,
  chargedSen: number,
): InvoicePriceRow[] | undefined {
  return invoicePriceBuildUp(
    {
      baseSen: input.basePriceSen,
      divanSen: input.divanPriceSen,
      legSen: input.legPriceSen,
      totalHeightSen: input.totalHeightPriceSen,
      specialSen: input.specialOrderPriceSen,
    },
    chargedSen,
  );
}

/**
 * The inline "Unit: …" caption on the order EDIT screens (sales + consignment).
 *
 * `chargedSen` is the unit price the screen will SAVE. It is passed in rather
 * than recomputed so the caption can never quote a different number from the
 * one the save writes — and so the reconciliation guard above is a real guard
 * and not a tautology.
 *
 * Reconciles → "RM 910.00 (Base @28" RM 830.00 + T.Height RM 80.00)".
 * Does not   → "RM 910.00", the charge alone. Showing nothing is honest;
 *              showing a decomposition that contradicts the charge is not.
 */
export function formatOrderLineUnit(
  input: PricingInput,
  chargedSen: number,
  seatHeight?: string | null,
): string {
  const charge = formatCurrency(Number(chargedSen) || 0);
  const rows = orderLinePriceBuildUp(input, chargedSen);
  if (!rows) return charge;
  const parts = rows
    // The "=" row IS the charge, already printed as the headline figure.
    .filter((r) => r.label !== "=")
    .map((r) => {
      const label = r.label === "Base" && seatHeight ? `Base @${seatHeight}` : r.label;
      return `${label} ${formatCurrency(r.sen)}`;
    });
  return `${charge} (${parts.join(" ")})`;
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
