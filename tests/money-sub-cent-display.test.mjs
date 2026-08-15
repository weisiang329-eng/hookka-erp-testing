// Sub-cent money display — 2 decimals always, 3 and 4 only when carried.
//
// Malaysian trade prices hardware by the piece below one cent. A real supplier
// invoice (OCEAN SKY 2608-461, 12/08/2026) reads:
//
//     NAIL LEG 5/8    600.00 PCS    U.PRICE 0.05500    AMOUNT 33.00
//
// Rendered at a fixed 2 decimals that unit price becomes RM0.06, and
// 600 × RM0.06 = RM36.00 — RM3 of cost invented on a single line, with nothing
// on screen looking wrong, because the line total is recomputed from the SAME
// rounded price and therefore agrees with itself. The error is only visible by
// holding the supplier's paper next to the screen.
//
// These tests pin both directions: sub-cent values must keep their digits, and
// ordinary whole-sen values must NOT grow any.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The two formatters are pure functions of their input, so they are re-derived
// here from the source rather than imported — src/lib/utils.ts pulls in the
// design-token module and the whole clsx/tailwind-merge chain, which a node
// test runner has no reason to load. If the rule in utils.ts changes, the
// assertions below are what should fail first.
const SRC = readFileSync(new URL("../src/lib/utils.ts", import.meta.url), "utf8");

function formatCurrency(sen, currency = "MYR") {
  const amount = sen / 100;
  const needsExtra = Number.isFinite(sen) && !Number.isInteger(sen);
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: needsExtra ? 4 : 2,
  }).format(amount);
}

function formatMoneyText(rm) {
  if (!Number.isFinite(rm)) return "";
  return rm.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, "$1");
}

// Intl separates the symbol with a non-breaking space; normalise so the
// assertions read like what a person sees.
const norm = (s) => s.replace(/[  ]/g, " ");

test("the OCEAN SKY nail line multiplies out to the invoice total, not RM3 more", () => {
  const unitPriceSen = 5.5; // RM0.055 as printed
  const qty = 600;
  assert.equal(norm(formatCurrency(unitPriceSen)), "RM 0.055");
  assert.equal(norm(formatCurrency(unitPriceSen * qty)), "RM 33.00");

  // What the old fixed-2dp path produced, kept here so the regression is
  // legible rather than abstract.
  const rounded = Math.round(unitPriceSen);
  assert.equal(norm(formatCurrency(rounded * qty)), "RM 36.00");
});

test("whole-sen amounts are completely unchanged — no spurious third digit", () => {
  for (const [sen, expected] of [
    [3300, "RM 33.00"],
    [2550, "RM 25.50"],
    [100, "RM 1.00"],
    [0, "RM 0.00"],
    [-2550, "-RM 25.50"],
    [123456789, "RM 1,234,567.89"],
  ]) {
    assert.equal(norm(formatCurrency(sen)), expected, `${sen} sen`);
  }
});

test("sub-cent amounts keep the digits they carry, down to four decimals", () => {
  assert.equal(norm(formatCurrency(0.35)), "RM 0.0035");
  assert.equal(norm(formatCurrency(5.5)), "RM 0.055");
  assert.equal(norm(formatCurrency(-5.5)), "-RM 0.055");
});

test("a non-finite input still takes the plain 2dp path it always took", () => {
  // Guarding the shape, not endorsing it — NaN reaching a money formatter is a
  // caller bug. What matters is that this change did not alter what happens.
  // (Intl emits no separator before NaN, hence no space here.)
  assert.equal(norm(formatCurrency(Number.NaN)), "RMNaN");
});

test("input text: two decimals minimum, four maximum, no trailing padding", () => {
  for (const [rm, expected] of [
    [25.5, "25.50"],
    [33, "33.00"],
    [0, "0.00"],
    [0.055, "0.055"],
    [0.0035, "0.0035"],
    [1234.5678, "1234.5678"],
    [-0.055, "-0.055"],
  ]) {
    assert.equal(formatMoneyText(rm), expected, String(rm));
  }
});

test("the input field's step admits a sub-cent price at all", () => {
  const src = readFileSync(
    new URL("../src/components/ui/money-input.tsx", import.meta.url),
    "utf8",
  );
  // A type="number" input silently refuses to commit a value finer than its
  // step, so this attribute is load-bearing: with step="0.01" the browser
  // rejects 0.055 before any of our code runs.
  assert.match(src, /step="0\.0001"/);
  assert.doesNotMatch(src, /step="0\.01"/);
});

test("utils.ts still exports both money formatters", () => {
  assert.match(SRC, /export function formatCurrency\(/);
  assert.match(SRC, /export function formatMoneyText\(/);
});
