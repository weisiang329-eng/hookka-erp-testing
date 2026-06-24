// pi-posting.test.mjs — pure leg-assembly for an APPROVED purchase invoice.
// Money-correctness: Σ DR === Σ CR, AP credited the booked total, rounding
// drift absorbed by pdefault. Mirrors tests/other-party-bill.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/pi-posting.ts")).href
);

const sum = (legs, k) => legs.reduce((s, l) => s + l[k], 0);

test("buildPiApprovalLegs — DR each mapped bucket, CR 400-0000, balances", () => {
  const legs = m.buildPiApprovalLegs({
    piNo: "PI-2606-001",
    supplierName: "ACME",
    apTotalSen: 15000,
    drBucket: { "704-0010": 10000, "704-0020": 5000 },
    pdefault: "704-0010",
  });
  assert.equal(legs.length, 3); // 2 DR + 1 CR
  assert.equal(sum(legs, "debitSen"), 15000);
  assert.equal(sum(legs, "creditSen"), 15000);
  const cr = legs.find((l) => l.creditSen > 0);
  assert.equal(cr.accountCode, m.AP_CONTROL);
  assert.equal(cr.creditSen, 15000);
});

test("buildPiApprovalLegs — rounding drift parked on pdefault, still balances", () => {
  // line buckets sum to 14999 vs AP total 15000 → +1 sen onto pdefault
  const legs = m.buildPiApprovalLegs({
    piNo: "PI-2606-002",
    supplierName: "ACME",
    apTotalSen: 15000,
    drBucket: { "704-0010": 9999, "704-0020": 5000 },
    pdefault: "704-0010",
  });
  assert.equal(sum(legs, "debitSen"), 15000);
  assert.equal(sum(legs, "creditSen"), 15000);
  const pd = legs.find((l) => l.accountCode === "704-0010");
  assert.equal(pd.debitSen, 10000); // 9999 + 1
});

test("buildPiApprovalLegs — header-only (empty bucket) puts full total on pdefault", () => {
  const legs = m.buildPiApprovalLegs({
    piNo: "PI-2606-003",
    supplierName: "ACME",
    apTotalSen: 8000,
    drBucket: {},
    pdefault: "704-0010",
  });
  assert.equal(legs.length, 2); // 1 DR (pdefault) + 1 CR
  assert.equal(sum(legs, "debitSen"), 8000);
  assert.equal(sum(legs, "creditSen"), 8000);
  const dr = legs.find((l) => l.debitSen > 0);
  assert.equal(dr.accountCode, "704-0010");
});

test("buildPiApprovalLegs — TAX bucket (706-0000) kept as its own DR leg", () => {
  const legs = m.buildPiApprovalLegs({
    piNo: "PI-2606-004",
    supplierName: "ACME",
    apTotalSen: 10600,
    drBucket: { "704-0010": 10000, "706-0000": 600 },
    pdefault: "704-0010",
  });
  assert.equal(sum(legs, "debitSen"), 10600);
  assert.equal(sum(legs, "creditSen"), 10600);
  assert.ok(legs.some((l) => l.accountCode === "706-0000" && l.debitSen === 600));
});

test("buildPiApprovalLegs — does not mutate the caller's bucket", () => {
  const bucket = { "704-0010": 9999 };
  m.buildPiApprovalLegs({
    piNo: "x",
    supplierName: "y",
    apTotalSen: 10000,
    drBucket: bucket,
    pdefault: "704-0010",
  });
  assert.equal(bucket["704-0010"], 9999); // untouched
});

test("buildPiApprovalLegs — leg numbers are 1..n sequential", () => {
  const legs = m.buildPiApprovalLegs({
    piNo: "x",
    supplierName: "y",
    apTotalSen: 15000,
    drBucket: { a: 10000, b: 5000 },
    pdefault: "a",
  });
  assert.deepEqual(
    legs.map((l) => l.legNo),
    [1, 2, 3],
  );
});
