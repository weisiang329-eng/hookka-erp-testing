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

/**
 * Render a stored unit price for an EDITABLE text/number input.
 *
 * Two decimals is the floor — RM 25 must still read "25.00" so the ordinary
 * case looks untouched — and the third and fourth digits appear only when the
 * price actually carries them.
 *
 * This exists because `(sen / 100).toFixed(2)` was seeding every unit-price
 * field in the procurement forms. That is a silent truncation on the way IN:
 * the operator opens a saved RM 0.055 line, the field says "0.06", and saving
 * writes 0.06 back. A correct column and a correct multiplication cannot
 * survive a form that rounds the value before the operator has touched it.
 */
export function formatUnitPriceInput(sen: number): string {
  if (!Number.isFinite(sen)) return "";
  let s = (sen / 100).toFixed(4);
  // Trim trailing zeros, but never past two decimals.
  while (s.endsWith("0") && !/\.\d\d$/.test(s)) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// The DB side of the same rule.
//
// These live here, in the zero-import module, rather than next to the runtime
// self-apply that uses them, for one reason: the self-apply file imports the
// Worker's helpers and cannot be loaded by a plain `node --test`. Keeping the
// DECISION pure means the thing that decides "is this column wide enough" is
// executed by a test, not merely read by one.
// ---------------------------------------------------------------------------

/** Decimal places kept on a stored unit price: four of ringgit, two of sen. */
export const UNIT_PRICE_DECIMALS = 4;

/**
 * Every column that holds a unit price or unit COST as a RATE.
 *
 * The test for membership is one question: **is this number multiplied by a
 * quantity?** If yes it is a rate and rounding it multiplies the error by that
 * quantity. If it is a sum that changes hands — a line total, a document total,
 * a landed cost, a payment — it stays whole sen and is NOT listed here.
 *
 * The list follows the supplier's price all the way through, because stopping
 * halfway is its own reconciliation error. RM 0.055 x 600 received at RM 0.06
 * values the batch at RM 36.00 against a supplier invoice of RM 33.00, and the
 * RM 3.00 sits in stock and then in cost of sales:
 *
 *   supplier price list  supplier_material_bindings / supplier_materials
 *          ↓             price_histories (the trail of that price)
 *   PO → GRN → PI        purchase_order_items / grn_items / purchase_invoice_items
 *          ↓
 *   stock valuation      rm_batches / cost_ledger / material_opening_stock
 *          ↓             stock_adjustments / purchase_return_items
 *   cost of sales        rd_material_issuances / fg_batches
 *
 * The SALES side is deliberately absent. The owner's standing ruling is that a
 * computed sales unit price lands on a whole ringgit (「我全套系统都要整除的」,
 * 2026-08-07, `roundUpToWholeRinggit`) — furniture is priced in hundreds and no
 * sub-cent case exists there. Widening those columns would contradict a live
 * ruling to buy nothing.
 */
export const UNIT_PRICE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  // What the supplier quotes.
  { table: "supplier_material_bindings", column: "unit_price" },
  { table: "supplier_materials", column: "unit_price_sen" },
  { table: "price_histories", column: "old_price" },
  { table: "price_histories", column: "new_price" },
  // What we order, receive and are billed.
  { table: "purchase_order_items", column: "unit_price_sen" },
  { table: "grn_items", column: "unit_price" },
  { table: "purchase_invoice_items", column: "unit_price_sen" },
  // What the stock is then worth, and what it costs when it is consumed.
  { table: "rm_batches", column: "unit_cost_sen" },
  { table: "cost_ledger", column: "unit_cost_sen" },
  { table: "material_opening_stock", column: "unit_cost_sen" },
  { table: "stock_adjustments", column: "unit_cost_sen" },
  { table: "purchase_return_items", column: "unit_cost_sen" },
  { table: "rd_material_issuances", column: "unit_cost_sen" },
  { table: "fg_batches", column: "unit_cost_sen" },
];

/**
 * Can this column hold RM 0.055?
 *
 * A column that is ABSENT is not ok. Reporting a missing column as fine is the
 * absence-read-as-a-value mistake this repo keeps paying for, and it would make
 * the diagnostic answer "all good" on a database that has no such table.
 */
export function precisionOk(
  dataType: string | null | undefined,
  scale: number | null | undefined,
): boolean {
  if (!dataType) return false;
  if (scale == null) return false; // integer columns report no scale
  return scale >= UNIT_PRICE_DECIMALS;
}

/** The widening statement for one column. integer → numeric moves no data. */
export function widenUnitPriceSql(table: string, column: string): string {
  return `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE NUMERIC(14,${UNIT_PRICE_DECIMALS})`;
}
