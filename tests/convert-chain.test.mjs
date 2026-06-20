// ---------------------------------------------------------------------------
// convert-chain.test.mjs — pure-math tests for src/lib/convert-chain.ts, the
// availability / double-convert guard shared by the PO→GRN→PI convert chain.
//
// Asserts:
//   • availableQty = ordered − consumed, floored at 0
//   • a 2nd convert is ALLOWED when qty remains, BLOCKED only on the over-drawn
//     line (the line-level guard that replaced the old PO-level 409)
//   • clampDecrement never drives a consumed counter below 0 (restore safety)
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const {
  availableQty,
  checkLineAvailable,
  checkConvertAvailability,
  clampDecrement,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/convert-chain.ts")).href
);

// ---------------------------------------------------------------------------
// availableQty
// ---------------------------------------------------------------------------
test("availableQty = ordered − consumed", () => {
  assert.equal(availableQty(10, 0), 10);
  assert.equal(availableQty(10, 4), 6);
  assert.equal(availableQty(10, 10), 0);
});

test("availableQty floors at 0 on over-consumption", () => {
  assert.equal(availableQty(10, 11), 0);
  assert.equal(availableQty(5, 99), 0);
});

test("availableQty tolerates fractional (metre) qty + bad input", () => {
  assert.equal(availableQty(10.5, 2.5), 8);
  assert.equal(availableQty(undefined, undefined), 0);
  assert.equal(availableQty("7", "2"), 5);
});

// ---------------------------------------------------------------------------
// checkLineAvailable — single line
// ---------------------------------------------------------------------------
test("line guard: requesting up to available passes", () => {
  assert.deepEqual(
    checkLineAvailable({ ref: "A", orderedQty: 10, consumedQty: 4, requestedQty: 6 }),
    { ok: true },
  );
});

test("line guard: requesting MORE than available is blocked", () => {
  const r = checkLineAvailable({ ref: "Foam", orderedQty: 10, consumedQty: 4, requestedQty: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.ref, "Foam");
  assert.equal(r.available, 6);
  assert.equal(r.requested, 7);
  assert.match(r.error, /exceeds available 6/);
});

test("line guard: a zero / negative draw is always allowed (fee/credit line)", () => {
  assert.deepEqual(
    checkLineAvailable({ ref: "Freight", orderedQty: 0, consumedQty: 0, requestedQty: 0 }),
    { ok: true },
  );
  assert.deepEqual(
    checkLineAvailable({ ref: "Rebate", orderedQty: 10, consumedQty: 10, requestedQty: -5 }),
    { ok: true },
  );
});

// ---------------------------------------------------------------------------
// checkConvertAvailability — whole payload (the core scenario)
// ---------------------------------------------------------------------------
test("convert: 1st PI within available passes", () => {
  const r = checkConvertAvailability([
    { ref: "A", orderedQty: 10, consumedQty: 0, requestedQty: 6 },
    { ref: "B", orderedQty: 5, consumedQty: 0, requestedQty: 5 },
  ]);
  assert.deepEqual(r, { ok: true });
});

test("convert: 2nd PI is ALLOWED when qty remains (not a blanket PO-level block)", () => {
  // After a 1st PI billed 6 of 10 on line A, a 2nd PI for the remaining 4 must
  // pass — this is exactly what the old PO-level 409 wrongly blocked.
  const r = checkConvertAvailability([
    { ref: "A", orderedQty: 10, consumedQty: 6, requestedQty: 4 },
  ]);
  assert.deepEqual(r, { ok: true });
});

test("convert: 2nd PI is BLOCKED only on the over-drawn line", () => {
  // Line A still has 4 available; line B has 0. The whole payload fails, and
  // the failure points at B (the over-drawn line), not A.
  const r = checkConvertAvailability([
    { ref: "A", orderedQty: 10, consumedQty: 6, requestedQty: 4 },
    { ref: "B", orderedQty: 5, consumedQty: 5, requestedQty: 1 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.ref, "B");
});

test("convert: exact-fill 2nd PI passes; one-over fails", () => {
  assert.equal(
    checkConvertAvailability([{ ref: "A", orderedQty: 10, consumedQty: 7, requestedQty: 3 }]).ok,
    true,
  );
  assert.equal(
    checkConvertAvailability([{ ref: "A", orderedQty: 10, consumedQty: 7, requestedQty: 4 }]).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// clampDecrement — restore safety
// ---------------------------------------------------------------------------
test("clampDecrement: normal restore decrements by the requested amount", () => {
  assert.equal(clampDecrement(6, 4), 4);
});

test("clampDecrement: never drives consumed below 0 (double-restore safe)", () => {
  assert.equal(clampDecrement(4, 6), 4); // can't give back more than is consumed
  assert.equal(clampDecrement(0, 5), 0);
  assert.equal(clampDecrement(3, 0), 0);
  assert.equal(clampDecrement(3, -2), 0);
});

// ---------------------------------------------------------------------------
// End-to-end arithmetic story: consume → consume again → restore
// ---------------------------------------------------------------------------
test("story: consume 6, available drops to 4; consume 4, drops to 0; restore 4, back to 4", () => {
  const ordered = 10;
  let consumed = 0;
  assert.equal(availableQty(ordered, consumed), 10);

  // PI #1 bills 6
  assert.equal(checkLineAvailable({ ref: "A", orderedQty: ordered, consumedQty: consumed, requestedQty: 6 }).ok, true);
  consumed += 6;
  assert.equal(availableQty(ordered, consumed), 4);

  // PI #2 bills the remaining 4 (allowed)
  assert.equal(checkLineAvailable({ ref: "A", orderedQty: ordered, consumedQty: consumed, requestedQty: 4 }).ok, true);
  consumed += 4;
  assert.equal(availableQty(ordered, consumed), 0);

  // a 3rd PI for even 1 more is blocked
  assert.equal(checkLineAvailable({ ref: "A", orderedQty: ordered, consumedQty: consumed, requestedQty: 1 }).ok, false);

  // delete PI #2 → restore 4 → available back to 4
  consumed -= clampDecrement(consumed, 4);
  assert.equal(availableQty(ordered, consumed), 4);
});
