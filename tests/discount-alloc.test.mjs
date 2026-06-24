// discount-alloc.test.mjs — pure allocation math for a Supplier Discount.
// Mirrors tests/supplier-payment-alloc.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/discount-alloc.ts")).href
);

const open = [
  { piId: "pi-1", outstandingSen: 10000 },
  { piId: "pi-2", outstandingSen: 5000 },
];

test("no allocation → nothing applied, whole discount unallocated", () => {
  const r = m.computeDiscountAlloc({ discountTotalSen: 8000, open, allocations: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.equal(r.unallocatedSen, 8000);
});

test("partial allocation against one PI", () => {
  const r = m.computeDiscountAlloc({ discountTotalSen: 8000, open, allocations: [{ piId: "pi-1", amountSen: 3000 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [{ piId: "pi-1", appliedSen: 3000 }]);
  assert.equal(r.unallocatedSen, 5000);
});

test("full allocation against one PI (= its outstanding)", () => {
  const r = m.computeDiscountAlloc({ discountTotalSen: 10000, open, allocations: [{ piId: "pi-1", amountSen: 10000 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [{ piId: "pi-1", appliedSen: 10000 }]);
  assert.equal(r.unallocatedSen, 0);
});

test("allocation across multiple PIs, balances", () => {
  const r = m.computeDiscountAlloc({
    discountTotalSen: 9000,
    open,
    allocations: [{ piId: "pi-1", amountSen: 4000 }, { piId: "pi-2", amountSen: 5000 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.applied.length, 2);
  const sum = r.applied.reduce((s, a) => s + a.appliedSen, 0);
  assert.equal(sum, 9000);
  assert.equal(r.unallocatedSen, 0);
});

test("blank (zero) rows are dropped", () => {
  const r = m.computeDiscountAlloc({
    discountTotalSen: 8000,
    open,
    allocations: [{ piId: "pi-1", amountSen: 3000 }, { piId: "pi-2", amountSen: 0 }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [{ piId: "pi-1", appliedSen: 3000 }]);
});

test("rejects allocation exceeding a PI's outstanding", () => {
  const r = m.computeDiscountAlloc({ discountTotalSen: 20000, open, allocations: [{ piId: "pi-1", amountSen: 12000 }] });
  assert.equal(r.ok, false);
});

test("rejects total allocation exceeding the discount", () => {
  const r = m.computeDiscountAlloc({
    discountTotalSen: 6000,
    open,
    allocations: [{ piId: "pi-1", amountSen: 4000 }, { piId: "pi-2", amountSen: 5000 }],
  });
  assert.equal(r.ok, false);
});

test("rejects an allocation to a PI that isn't open for this supplier", () => {
  const r = m.computeDiscountAlloc({ discountTotalSen: 8000, open, allocations: [{ piId: "pi-99", amountSen: 1000 }] });
  assert.equal(r.ok, false);
});

test("rejects a non-positive discount total", () => {
  const r = m.computeDiscountAlloc({ discountTotalSen: 0, open, allocations: [] });
  assert.equal(r.ok, false);
});

test("rejects duplicate PI allocations", () => {
  const r = m.computeDiscountAlloc({
    discountTotalSen: 8000,
    open,
    allocations: [{ piId: "pi-1", amountSen: 1000 }, { piId: "pi-1", amountSen: 2000 }],
  });
  assert.equal(r.ok, false);
});
