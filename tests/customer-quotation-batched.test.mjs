// ---------------------------------------------------------------------------
// customer-quotation-batched.test.mjs — pins the fix for the "Export Quotation
// PDF hangs" bug (owner 2026-07-29, The Conts = 375 SKUs). The endpoint
// resolved each product's price with a sequential per-row
// `await resolveCustomerPriceAsOf`, serialising 750+ DB round-trips → the
// request aborted and no PDF was produced. Fix: bounded-concurrency chunks.
// Structural pin (source assertion) — the batching is the whole point and must
// not silently regress to sequential; live timing is verified on prod.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/api/routes/customer-quotation.ts", import.meta.url),
  "utf8",
);

test("price resolution is chunked-parallel (bounded concurrency)", () => {
  assert.match(
    src,
    /const PRICE_CHUNK\s*=\s*\d+/,
    "must cap concurrent DB reads with a chunk size",
  );
  assert.match(
    src,
    /Promise\.all\(\s*slice\.map\(/,
    "each chunk must resolve its prices with Promise.all over the slice",
  );
});

test("no sequential per-row price resolution (the N+1 that hung the export)", () => {
  assert.doesNotMatch(
    src,
    /for \(const r of cpRows\)\s*\{\s*const resolved = await resolveCustomerPriceAsOf/,
    "prices must NOT be resolved one-product-at-a-time in a sequential for-loop",
  );
});

test("resolution output shape is unchanged (same fields, same order push)", () => {
  // The fix must not alter what the PDF sees — still pushes the same fields.
  for (const field of [
    "basePriceSen: resolved\\?\\.basePriceSen",
    "price1Sen: resolved\\?\\.price1Sen",
    "seatHeightPrices: resolved\\?\\.seatHeightPrices",
  ]) {
    assert.match(src, new RegExp(field), `push must still map ${field}`);
  }
});
