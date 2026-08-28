// ---------------------------------------------------------------------------
// unit-price.ts — the one place that decides how precisely a UNIT PRICE is kept.
//
// Deliberately its own module with zero imports. The obvious home would be
// `src/lib/utils.ts`, but that file pulls in clsx, tailwind-merge and the
// design tokens; importing it from an API route would drag the whole front-end
// styling chain into the Worker bundle.
//
// WHY A UNIT PRICE IS NOT LIKE OTHER MONEY
// ----------------------------------------
// Everything else in this system is whole sen, and that is right: a line total,
// an invoice amount, a payment — those are sums that change hands, and a
// fraction of a sen cannot.
//
// A unit price is not a sum. It is a RATE that gets multiplied by a quantity,
// so rounding it first multiplies the rounding error by that quantity. From a
// real supplier invoice (OCEAN SKY TRADING 2608-461, 12/08/2026):
//
//     NAIL LEG 5/8    600.00 PCS    U.PRICE 0.05500    AMOUNT 33.00
//
// Rounded to whole sen, RM0.055 becomes RM0.06, and 600 x RM0.06 = RM36.00.
// RM3 of cost invented on one line — and invisible, because the line total is
// recomputed from the same rounded price and therefore agrees with itself.
//
// Malaysian hardware suppliers quote piece prices at five decimal places on
// paper; four decimals of ringgit (= two decimals of sen) covers every price
// seen in the wild here. Storage is NUMERIC(14,4) on the sen column.
// ---------------------------------------------------------------------------

/** Sen per ringgit-fraction: 100 => two decimals of sen => four of ringgit. */
const UNIT_PRICE_SCALE = 100;

/**
 * Quantise a unit price, in sen, to the stored resolution.
 *
 * Non-finite input returns NaN so the caller's existing `Number.isFinite`
 * validation still rejects it — this must not quietly turn junk into 0.
 */
export function roundUnitPriceSen(sen: number): number {
  if (!Number.isFinite(sen)) return Number.NaN;
  return Math.round(sen * UNIT_PRICE_SCALE) / UNIT_PRICE_SCALE;
}

/**
 * A line total in whole sen, from a quantity and a full-precision unit price.
 *
 * The rounding happens ONCE, on the product — never on the rate first. This is
 * the whole point: 600 x 5.5 sen = 3300 sen = RM33.00 exactly, matching the
 * supplier's own arithmetic.
 */
export function lineTotalSen(qty: number, unitPriceSen: number): number {
  return Math.round(qty * unitPriceSen);
}
