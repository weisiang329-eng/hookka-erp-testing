// Sub-cent UNIT PRICES survive storage — the half that actually stops the RM3.
//
// Worked example, from the paper (OCEAN SKY TRADING invoice 2608-461, dated
// 12/08/2026, PO 2608-030):
//
//     NAIL LEG 5/8    600.00 PCS    U.PRICE 0.05500    AMOUNT 33.00
//
// Two independent things had to be true for this line to book at RM36.00:
//   1. purchase-invoices.ts ran Math.round() on the unit price (the RATE),
//      turning 5.5 sen into 6 sen BEFORE multiplying.
//   2. purchase_invoice_items.unit_price_sen is an INTEGER column, so even
//      without (1) Postgres would have rounded it on the way in.
//
// (1) is fixed by roundUnitPriceSen + rounding once on the product. (2) is
// fixed by the ALTER ... TYPE NUMERIC(14,4) in each route's self-apply block —
// and since migrations are inert in this repo, the ALTER being present in that
// block is the only thing that gets it to production. These tests pin both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { roundUnitPriceSen, lineTotalSen } from "../src/lib/unit-price.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the OCEAN SKY nail line books at the amount printed on the invoice", () => {
  const unitPriceSen = roundUnitPriceSen(5.5); // RM0.055
  assert.equal(unitPriceSen, 5.5, "the rate keeps its half-sen");
  assert.equal(lineTotalSen(600, unitPriceSen), 3300, "600 x RM0.055 = RM33.00");

  // The old behaviour, kept so the regression stays legible.
  assert.equal(Math.round(5.5) * 600, 3600, "rounding the RATE first gave RM36.00");
});

test("rounding happens on the product, never on the rate", () => {
  // 7 pieces at RM0.0035: rounding the rate to whole sen gives 0, and the line
  // silently books as free. Rounding once on the product keeps it honest.
  assert.equal(lineTotalSen(7, roundUnitPriceSen(0.35)), 2);
  assert.equal(Math.round(0.35) * 7, 0, "the old path lost the line entirely");
});

test("unit prices quantise to two decimals of sen (four of ringgit)", () => {
  assert.equal(roundUnitPriceSen(5.5), 5.5);
  assert.equal(roundUnitPriceSen(0.35), 0.35);
  assert.equal(roundUnitPriceSen(5.5049), 5.5);
  assert.equal(roundUnitPriceSen(5.5051), 5.51);
  assert.equal(roundUnitPriceSen(600), 600, "whole sen is untouched");
  assert.equal(roundUnitPriceSen(0), 0);
});

test("junk stays junk — it must not quietly become zero", () => {
  // The callers validate with Number.isFinite; returning 0 here would smuggle a
  // free line past that check.
  assert.ok(Number.isNaN(roundUnitPriceSen(Number.NaN)));
  assert.ok(Number.isNaN(roundUnitPriceSen(Number.POSITIVE_INFINITY)));
  assert.ok(Number.isNaN(roundUnitPriceSen(Number("abc"))));
});

test("purchase-invoices no longer rounds the rate", () => {
  const src = read("../src/api/routes/purchase-invoices.ts");
  assert.match(src, /const unitPriceSen = roundUnitPriceSen\(Number\(it\.unitPriceSen\)\)/);
  assert.doesNotMatch(
    src,
    /unitPriceSen = Math\.round\(Number\(it\.unitPriceSen\)\)/,
    "the whole bug was this one Math.round",
  );
});

test("every table holding a unit price is widened in a self-apply block", () => {
  // Migrations are inert in this repo — a migration file alone would change
  // nothing in production. The ALTER must live in the runtime block that is
  // awaited before the first write, so that is what is asserted.
  for (const [file, alter] of [
    [
      "../src/api/routes/purchase-invoices.ts",
      /ALTER TABLE purchase_invoice_items ALTER COLUMN unit_price_sen TYPE NUMERIC\(14,4\)/,
    ],
    [
      "../src/api/routes/purchase-orders.ts",
      /ALTER TABLE purchase_order_items ALTER COLUMN unit_price_sen TYPE NUMERIC\(14,4\)/,
    ],
    [
      "../src/api/routes/grn.ts",
      /ALTER TABLE grn_items ALTER COLUMN unit_price TYPE NUMERIC\(14,4\)/,
    ],
  ]) {
    assert.match(read(file), alter, file);
  }
});

test("the GRN header total is still whole sen", () => {
  // Unit prices may now be fractional; a document's own money total may not.
  const src = read("../src/api/routes/grn.ts");
  assert.match(
    src,
    /const totalAmount = Math\.round\(\s*grnItems\.reduce/,
    "a fractional GRN total would leak sub-sen into the ledger",
  );
});

test("line totals are still whole sen everywhere", () => {
  // The rate carries precision; the amount does not. If this ever changes,
  // sub-sen values start reaching the general ledger.
  for (const qty of [1, 7, 600, 15000]) {
    for (const price of [5.5, 0.35, 2, 12345.67]) {
      assert.ok(
        Number.isInteger(lineTotalSen(qty, price)),
        `${qty} x ${price} produced a fractional line total`,
      );
    }
  }
});
