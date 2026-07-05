// ---------------------------------------------------------------------------
// sales-orders-delivery-refs.test.mjs — unit tests for the
// GET /api/sales-orders?fields=delivery-refs slim projection
// (soListToDeliveryRefs in src/api/routes/sales-orders.ts).
//
// The Delivery page fetches the SO list ONLY to join Customer PO/SO numbers +
// reference + hookkaExpectedDD onto DO rows. ?fields=delivery-refs projects the
// SAME cached snapshot down to just those ref scalars (no line items, no scan
// image) to cut the ~1.4MB payload by >90% on weak-wifi phones.
//
// These tests lock the projection CONTRACT so it can never silently drop a
// field the Delivery grid's soRefMap reads (id / companySOId / customerId +
// the four dual-keyed *Id/plain ref columns + hookkaExpectedDD).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let mod;
try {
  mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/sales-orders.ts")).href
  );
} catch (err) {
  console.warn(
    "[sales-orders-delivery-refs.test] Could not import route module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[sales-orders-delivery-refs.test] Error:", err?.message ?? err);
  throw err;
}

const { soListToDeliveryRefs } = mod;

// The exact set of keys the Delivery grid's soRefMap + soMap + soPriceByProduct
// read. If the projection ever drops one, the DO grids silently show blank
// Customer PO/SO or an RM0 Sales Figure. `items` carries the price fallback.
const EXPECTED_KEYS = [
  "id",
  "companySOId",
  "customerId",
  "customerSO",
  "customerSOId",
  "customerPO",
  "customerPOId",
  "reference",
  "hookkaExpectedDD",
  "items",
].sort();

test("soListToDeliveryRefs projects the ref keys + slim items (no scan image, no other line fields)", () => {
  const out = soListToDeliveryRefs([
    {
      id: "so-1",
      companySOId: "SO-2604-323",
      customerId: "cust-1",
      customerSO: "CSO-1",
      customerSOId: "CSO-1-ID",
      customerPO: "CPO-1",
      customerPOId: "CPO-1-ID",
      reference: "REF-1",
      hookkaExpectedDD: "2026-07-10",
      // A full line item — only productCode + unitPriceSen must survive.
      items: [
        {
          productCode: "X",
          unitPriceSen: 100,
          productName: "should-be-dropped",
          quantity: 5,
          sizeCode: "K",
        },
      ],
      // Fields that must NOT leak into the slim payload:
      customerPOImageB64: "AAAA_huge_base64",
      totalSen: 999,
    },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), EXPECTED_KEYS);
  // Slim items: ONLY productCode + unitPriceSen (the price-fallback join).
  assert.deepEqual(out[0].items, [{ productCode: "X", unitPriceSen: 100 }]);
  // No scan image / totals carried through.
  assert.equal(out[0].customerPOImageB64, undefined);
  assert.equal(out[0].totalSen, undefined);
});

test("soListToDeliveryRefs preserves BOTH dual-keyed ref columns", () => {
  // The grid prefers the *Id column and falls back to the plain one — both
  // must survive the projection so that fallback still works.
  const [row] = soListToDeliveryRefs([
    {
      id: "so-2",
      customerSO: "plain-so",
      customerSOId: "id-so",
      customerPO: "plain-po",
      customerPOId: "id-po",
    },
  ]);
  assert.equal(row.customerSO, "plain-so");
  assert.equal(row.customerSOId, "id-so");
  assert.equal(row.customerPO, "plain-po");
  assert.equal(row.customerPOId, "id-po");
});

test("soListToDeliveryRefs defaults missing string fields to '' (keeps customerId nullable)", () => {
  const [row] = soListToDeliveryRefs([{ id: "so-3" }]);
  assert.equal(row.id, "so-3");
  assert.equal(row.companySOId, "");
  assert.equal(row.customerSO, "");
  assert.equal(row.customerSOId, "");
  assert.equal(row.customerPO, "");
  assert.equal(row.customerPOId, "");
  assert.equal(row.reference, "");
  assert.equal(row.hookkaExpectedDD, "");
  // customerId is passed through as-is (the grid keys hub lookups off it and
  // tolerates undefined) — NOT coerced to "".
  assert.equal(row.customerId, undefined);
  // Missing items → empty array (not undefined) so the price-map builder can
  // iterate without a guard.
  assert.deepEqual(row.items, []);
});

test("soListToDeliveryRefs preserves order and values byte-for-byte", () => {
  const src = [
    { id: "a", companySOId: "SO-A", reference: "RA" },
    { id: "b", companySOId: "SO-B", reference: "RB" },
  ];
  const out = soListToDeliveryRefs(src);
  assert.equal(out[0].id, "a");
  assert.equal(out[0].reference, "RA");
  assert.equal(out[1].id, "b");
  assert.equal(out[1].companySOId, "SO-B");
});

test("soListToDeliveryRefs handles an empty list", () => {
  assert.deepEqual(soListToDeliveryRefs([]), []);
});
