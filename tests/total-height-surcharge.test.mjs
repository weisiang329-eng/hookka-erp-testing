// ---------------------------------------------------------------------------
// total-height-surcharge.test.mjs — the 4th price component (BUG-CLASSES C1),
// finally given a stored column + server derivation like divan/leg/special.
//
// Total height = gap + divan + leg; the owner's variants-config.totalHeights
// prices specific totals (26"=RM 80, 28"=RM 160). It was folded into
// unit_price_sen with no column and no server fallback, so it landed in 0/125
// eligible lines on prod (RM 10,240 uncharged).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  totalHeightInches,
  deriveTotalHeightSurchargeSen,
  resolveTotalHeightPriceSen,
} from "../src/lib/total-height-surcharge.ts";

const CFG = [
  { value: '19"', priceSen: 4000 },
  { value: '25"', priceSen: 4000 },
  { value: '26"', priceSen: 8000 },
  { value: '28"', priceSen: 16000 },
];

test("total height = gap + divan + leg", () => {
  assert.equal(totalHeightInches(14, 8, 4), 26);
  assert.equal(totalHeightInches("14", "8", "4"), 26); // strings from JSON
  assert.equal(totalHeightInches(null, 8, null), 8);
});

test("derive reads the owner's totalHeights list", () => {
  assert.equal(deriveTotalHeightSurchargeSen(26, CFG), 8000);
  assert.equal(deriveTotalHeightSurchargeSen(28, CFG), 16000);
  assert.equal(deriveTotalHeightSurchargeSen(22, CFG), 0, "22\" is not priced → 0");
  assert.equal(deriveTotalHeightSurchargeSen(26, null), 0, "no config → no charge");
});

test("TRUST MODEL: a client-supplied number wins, including 0", () => {
  assert.equal(resolveTotalHeightPriceSen(0, 14, 8, 4, CFG), 0, "explicit waiver");
  assert.equal(resolveTotalHeightPriceSen(9000, 14, 8, 4, CFG), 9000, "hand-set stands");
});

test("TRUST MODEL: an omitted field derives from gap+divan+leg — the scan-PO leak", () => {
  assert.equal(resolveTotalHeightPriceSen(undefined, 14, 8, 4, CFG), 8000, "26\" → RM 80");
  assert.equal(resolveTotalHeightPriceSen(null, 16, 8, 4, CFG), 16000, "28\" → RM 160");
});

test("service orders stay free when omitted", () => {
  assert.equal(resolveTotalHeightPriceSen(undefined, 14, 8, 4, CFG, true), 0);
});

test("both SO write paths store + derive total-height (structural)", () => {
  const SRC = readFileSync(resolve(process.cwd(), "src/api/routes/sales-orders.ts"), "utf8");
  const derives = SRC.match(/resolveTotalHeightPriceSen\(/g) ?? [];
  assert.ok(derives.length >= 2, "POST + PUT loops must both resolve total-height");
  assert.doesNotMatch(
    SRC,
    /const totalHeightPriceSen = Number\(item\.totalHeightPriceSen\) \|\| 0/,
    "must not revert to trusting the client — the scan/import paths never send it",
  );
  assert.match(SRC, /total_height_price_sen INTEGER NOT NULL DEFAULT 0/, "schema self-apply");
  assert.match(SRC, /specialOrderPriceSen, totalHeightPriceSen, customSpecials/, "stored in the INSERT");
});
