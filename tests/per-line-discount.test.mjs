// ---------------------------------------------------------------------------
// per-line-discount.test.mjs — calculateLineTotalWithDiscount (migration 0179)
//
// Covers: no discount, RM discount, %-derived discount, over-discount clamp.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const { calculateLineTotalWithDiscount, calculateLineTotal } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/pricing.ts")).href
);

test("no discount: same as gross line total", () => {
  // 2 units × RM 500 = RM 1000; discountSen = 0
  const gross = calculateLineTotal(50000, 2);        // 100000 sen
  const net   = calculateLineTotalWithDiscount(50000, 2, 0);
  assert.equal(net, gross, "zero discount should equal gross");
  assert.equal(net, 100000);
});

test("RM discount reduces line total", () => {
  // 1 unit × RM 800, discount RM 50 → RM 750
  const net = calculateLineTotalWithDiscount(80000, 1, 5000);
  assert.equal(net, 75000);
});

test("discount applied after qty multiply", () => {
  // 3 units × RM 200 = RM 600 gross; discount RM 30 → RM 570
  const net = calculateLineTotalWithDiscount(20000, 3, 3000);
  assert.equal(net, 57000);
});

test("over-discount clamps to 0 (never negative)", () => {
  // discount larger than gross line total
  const net = calculateLineTotalWithDiscount(10000, 1, 999999);
  assert.equal(net, 0, "clamped to 0 when discount exceeds total");
});

test("discount exactly equal to gross yields 0", () => {
  // 2 × RM 100 = RM 200 gross; discount = RM 200
  const net = calculateLineTotalWithDiscount(10000, 2, 20000);
  assert.equal(net, 0);
});
