// ---------------------------------------------------------------------------
// height-surcharge.test.mjs — pins the 2026-07-22 fix for the third instance of
// "a surcharge component the server takes on trust from whichever client
// posted" (after totalHeightPriceSen on 07-14 and specialOrderPriceSen on
// 07-17, BUG-2026-07-17-002).
//
// Prod evidence the fix is answering: of the live non-service SO lines carrying
// a 10" or 12" divan, 104 typed by hand were charged and 105 of 105 that came
// through the scan-PO modal were not. RM 9,895 of divan + RM 2,560 of leg
// surcharge never billed.
//
// The structural half matters as much as the unit half: it is the part that
// catches a future edit quietly restoring `Number(item.divanPriceSen) || 0`.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseHeightLabelInches,
  deriveHeightSurchargeSen,
  resolveHeightPriceSen,
} from "../src/lib/height-surcharge.ts";

// The shape the owner's list actually has on prod today.
const DIVAN = [
  { value: '4"', priceSen: 0 },
  { value: '8"', priceSen: 0 },
  { value: '10"', priceSen: 5500 },
  { value: '12"', priceSen: 13000 },
  { value: '16"', priceSen: 16000 },
];
const LEG = [
  { value: "No Leg", priceSen: 0 },
  { value: '4"', priceSen: 0 },
  { value: '7"', priceSen: 16000 },
];

test("parseHeightLabelInches accepts the label spellings an owner might type", () => {
  assert.equal(parseHeightLabelInches('10"'), 10);
  assert.equal(parseHeightLabelInches("10"), 10);
  assert.equal(parseHeightLabelInches("10 inch"), 10);
  assert.equal(parseHeightLabelInches("10in"), 10);
  assert.equal(parseHeightLabelInches('10.5"'), 10.5);
  assert.equal(parseHeightLabelInches("No Leg"), null, "a heightless choice is not a height");
  assert.equal(parseHeightLabelInches(null), null);
});

test("deriveHeightSurchargeSen reads the owner's list", () => {
  assert.equal(deriveHeightSurchargeSen(10, DIVAN), 5500);
  assert.equal(deriveHeightSurchargeSen(12, DIVAN), 13000);
  assert.equal(deriveHeightSurchargeSen("10", DIVAN), 5500, "string height from JSON");
  assert.equal(deriveHeightSurchargeSen(8, DIVAN), 0, "the standard height is free");
  assert.equal(deriveHeightSurchargeSen(7, LEG), 16000);
});

test("an unknown height prices at 0 — never invent money", () => {
  assert.equal(deriveHeightSurchargeSen(9, DIVAN), 0);
  assert.equal(deriveHeightSurchargeSen(10, null), 0, "no config → no charge");
  assert.equal(deriveHeightSurchargeSen(10, []), 0);
  assert.equal(deriveHeightSurchargeSen(null, DIVAN), 0);
  assert.equal(deriveHeightSurchargeSen(0, DIVAN), 0);
});

test("TRUST MODEL: a client-supplied number always wins, including 0", () => {
  // The typed form computes its own price — a hand-discounted or waived height
  // must survive untouched.
  assert.equal(resolveHeightPriceSen(0, 10, DIVAN), 0, "explicit 0 = deliberate waiver");
  assert.equal(resolveHeightPriceSen(3000, 10, DIVAN), 3000, "hand-set price is not overridden");
  assert.equal(resolveHeightPriceSen("5500", 10, DIVAN), 5500);
});

test("TRUST MODEL: an omitted field is derived — this is the scan-PO leak", () => {
  assert.equal(resolveHeightPriceSen(undefined, 10, DIVAN), 5500);
  assert.equal(resolveHeightPriceSen(null, 12, DIVAN), 13000);
  assert.equal(resolveHeightPriceSen(undefined, 7, LEG), 16000);
});

test("service orders stay free even when the price is omitted", () => {
  assert.equal(resolveHeightPriceSen(undefined, 10, DIVAN, true), 0);
  // …but an explicit number on a service order is still honoured.
  assert.equal(resolveHeightPriceSen(9900, 10, DIVAN, true), 9900);
});

// --- structural: the write paths must not go back to trusting the client ----
const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/sales-orders.ts"),
  "utf8",
);

test("sales-orders write paths derive both heights server-side", () => {
  assert.doesNotMatch(
    SRC,
    /const divanPriceSen = Number\(item\.divanPriceSen\) \|\| 0/,
    "Reverting to Number(item.divanPriceSen) || 0 re-opens the leak: the scan-PO " +
      "paths post a height with no price, so every scanned line stores 0.",
  );
  assert.doesNotMatch(
    SRC,
    /const legPriceSen = Number\(item\.legPriceSen\) \|\| 0/,
    "Same for legs — 0 of 12 scanned 7\" leg lines were ever charged.",
  );
  const derives = SRC.match(/resolveHeightPriceSen\(/g) ?? [];
  assert.equal(
    derives.length,
    4,
    "Both the POST and the PUT item loops must resolve BOTH divan and leg " +
      "(2 call sites × 2 components). PUT matters too: editing a scanned SO " +
      "would otherwise re-store the surcharge as 0.",
  );
  assert.match(SRC, /loadHeightsConfig\(c\.var\.DB\)/);
});
