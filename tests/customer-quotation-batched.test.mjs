// ---------------------------------------------------------------------------
// customer-quotation-batched.test.mjs — pins the fix for "Export Quotation PDF
// hangs" (owner 2026-07-29, The Conts = 375 SKUs). The endpoint resolved each
// product's price with ~5 sequential per-product DB reads → ~1875 round-trips →
// the request aborted at 30s. Fix: ONE batched resolver (4 bulk queries).
// Structural pins (source assertions, the repo idiom); live timing verified on
// prod (the export must actually download for The Conts).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const endpoint = readFileSync(
  new URL("../src/api/routes/customer-quotation.ts", import.meta.url),
  "utf8",
);
const products = readFileSync(
  new URL("../src/api/routes/customer-products.ts", import.meta.url),
  "utf8",
);

test("endpoint resolves prices via ONE batched call, not per-product", () => {
  assert.match(
    endpoint,
    /const priceMap = await resolveCustomerPricesAsOfBatch\(/,
    "endpoint must call the batched resolver once",
  );
  // The N+1 shapes that hung it must be gone.
  assert.doesNotMatch(endpoint, /const PRICE_CHUNK/, "no per-chunk loop");
  assert.doesNotMatch(
    endpoint,
    /resolveCustomerPriceAsOf\(c\.var\.DB/,
    "must NOT call the per-product resolver in a loop",
  );
});

test("batched resolver exists, uses bulk IN queries, and shares the price math", () => {
  assert.match(
    products,
    /export async function resolveCustomerPricesAsOfBatch\(/,
    "customer-products must export the batched resolver",
  );
  const start = products.indexOf("export async function resolveCustomerPricesAsOfBatch");
  const body = products.slice(start, start + 6500);
  // Bulk fan-in, not a per-product query loop.
  assert.match(body, /IN \(\$\{ph\}\)/, "must fetch the product set with an IN (...) bulk query");
  assert.match(body, /FROM product_prices/, "must bulk-load master effective-dated prices");
  assert.match(body, /FROM customer_product_prices/, "must bulk-load customer price history");
  // Same coalescer as the per-product path → prices can't diverge.
  assert.match(body, /resolvePrices\(/, "must reuse the shared resolvePrices (identical price math)");
});

test("quotation output shape is unchanged (same fields pushed)", () => {
  for (const field of [
    "basePriceSen: resolved\\?\\.basePriceSen",
    "price1Sen: resolved\\?\\.price1Sen",
    "seatHeightPrices: resolved\\?\\.seatHeightPrices",
  ]) {
    assert.match(endpoint, new RegExp(field), `push must still map ${field}`);
  }
});
