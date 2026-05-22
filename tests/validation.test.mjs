// ---------------------------------------------------------------------------
// validation.test.mjs — unit tests for the input-validation primitives and
// Sales-Order domain validators in `src/lib/validation.ts`.
//
// This codebase has a hard rule: bad inputs must be REJECTED, not silently
// normalized. validateSO / validateSOItem are the gate that the SO create /
// edit screens run before a save. If a rejection branch ever weakens, an
// invalid SO (zero-qty line, negative price, missing fabric, no delivery
// date) slips through and corrupts every downstream cascade. These tests
// lock every accept path AND every reject branch.
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

let v;
try {
  v = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/validation.ts")).href
  );
} catch (err) {
  console.warn(
    "[validation.test] Could not import validation module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[validation.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// required(value, fieldName) — non-empty check for strings/numbers/arrays.
// ---------------------------------------------------------------------------
test("required: a non-empty string passes", () => {
  assert.deepEqual(v.required("Acme Sdn Bhd", "Customer name"), {
    valid: true,
  });
});

test("required: null is rejected", () => {
  const r = v.required(null, "Customer name");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Customer name is required");
});

test("required: undefined is rejected", () => {
  const r = v.required(undefined, "Customer name");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Customer name is required");
});

test("required: empty string is rejected", () => {
  const r = v.required("", "Customer name");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Customer name is required");
});

test("required: whitespace-only string is rejected (trim applied)", () => {
  // The comment says strings are trimmed before the emptiness check.
  const r = v.required("   ", "Customer name");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Customer name is required");
});

test("required: number 0 is accepted (0 is a real value, not empty)", () => {
  // Only NaN counts as empty for numbers — 0 is a legitimate value.
  assert.equal(v.required(0, "Quantity").valid, true);
});

test("required: NaN number is rejected", () => {
  const r = v.required(NaN, "Quantity");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Quantity is required");
});

test("required: non-empty array passes", () => {
  assert.equal(v.required([1], "Items").valid, true);
});

test("required: empty array is rejected", () => {
  const r = v.required([], "Items");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Items is required");
});

// ---------------------------------------------------------------------------
// minValue / maxValue — numeric bounds.
// ---------------------------------------------------------------------------
test("minValue: value equal to min passes (inclusive boundary)", () => {
  assert.equal(v.minValue(5, 5, "Qty").valid, true);
});

test("minValue: value above min passes", () => {
  assert.equal(v.minValue(6, 5, "Qty").valid, true);
});

test("minValue: value below min is rejected", () => {
  const r = v.minValue(4, 5, "Qty");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Qty must be at least 5");
});

test("minValue: NaN is rejected as not-a-number", () => {
  const r = v.minValue(NaN, 0, "Qty");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Qty must be a valid number");
});

test("minValue: non-number argument is rejected", () => {
  const r = v.minValue("3", 0, "Qty");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Qty must be a valid number");
});

test("maxValue: value equal to max passes (inclusive boundary)", () => {
  assert.equal(v.maxValue(10, 10, "Qty").valid, true);
});

test("maxValue: value above max is rejected", () => {
  const r = v.maxValue(11, 10, "Qty");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Qty must be at most 10");
});

test("maxValue: NaN is rejected as not-a-number", () => {
  const r = v.maxValue(NaN, 10, "Qty");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Qty must be a valid number");
});

// ---------------------------------------------------------------------------
// positiveNumber — strictly > 0. Used for line-item quantity.
// ---------------------------------------------------------------------------
test("positiveNumber: a positive value passes", () => {
  assert.equal(v.positiveNumber(1, "Quantity").valid, true);
});

test("positiveNumber: zero is rejected (must be strictly > 0)", () => {
  const r = v.positiveNumber(0, "Quantity");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Quantity must be greater than 0");
});

test("positiveNumber: negative is rejected", () => {
  const r = v.positiveNumber(-3, "Quantity");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Quantity must be greater than 0");
});

test("positiveNumber: NaN is rejected as not-a-number", () => {
  const r = v.positiveNumber(NaN, "Quantity");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Quantity must be a valid number");
});

// ---------------------------------------------------------------------------
// nonNegativeNumber — >= 0. Used for prices (0 is allowed, negative is not).
// ---------------------------------------------------------------------------
test("nonNegativeNumber: zero passes (free item is legitimate)", () => {
  assert.equal(v.nonNegativeNumber(0, "Base price").valid, true);
});

test("nonNegativeNumber: positive value passes", () => {
  assert.equal(v.nonNegativeNumber(150_00, "Base price").valid, true);
});

test("nonNegativeNumber: negative is rejected", () => {
  const r = v.nonNegativeNumber(-1, "Base price");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Base price must be 0 or greater");
});

test("nonNegativeNumber: NaN is rejected as not-a-number", () => {
  const r = v.nonNegativeNumber(NaN, "Base price");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Base price must be a valid number");
});

// ---------------------------------------------------------------------------
// dateNotBefore / dateNotAfter — accept Date objects or parseable strings.
// ---------------------------------------------------------------------------
test("dateNotBefore: date after the minimum passes", () => {
  assert.equal(
    v.dateNotBefore("2026-05-20", "2026-05-01", "Delivery date").valid,
    true,
  );
});

test("dateNotBefore: date equal to the minimum passes (inclusive)", () => {
  assert.equal(
    v.dateNotBefore("2026-05-01", "2026-05-01", "Delivery date").valid,
    true,
  );
});

test("dateNotBefore: date before the minimum is rejected", () => {
  const r = v.dateNotBefore("2026-04-30", "2026-05-01", "Delivery date");
  assert.equal(r.valid, false);
  assert.match(r.error, /^Delivery date cannot be before /);
});

test("dateNotBefore: unparseable date string is rejected", () => {
  const r = v.dateNotBefore("not-a-date", "2026-05-01", "Delivery date");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Delivery date is not a valid date");
});

test("dateNotBefore: unparseable minimum is rejected", () => {
  const r = v.dateNotBefore("2026-05-20", "garbage", "Delivery date");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Minimum date for Delivery date is not valid");
});

test("dateNotBefore: accepts Date objects", () => {
  const r = v.dateNotBefore(
    new Date(2026, 4, 20),
    new Date(2026, 4, 1),
    "Delivery date",
  );
  assert.equal(r.valid, true);
});

test("dateNotAfter: date before the maximum passes", () => {
  assert.equal(
    v.dateNotAfter("2026-05-20", "2026-06-01", "Delivery date").valid,
    true,
  );
});

test("dateNotAfter: date after the maximum is rejected", () => {
  const r = v.dateNotAfter("2026-06-02", "2026-06-01", "Delivery date");
  assert.equal(r.valid, false);
  assert.match(r.error, /^Delivery date cannot be after /);
});

test("dateNotAfter: unparseable date string is rejected", () => {
  const r = v.dateNotAfter("xyz", "2026-06-01", "Delivery date");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Delivery date is not a valid date");
});

test("dateNotAfter: unparseable maximum is rejected", () => {
  const r = v.dateNotAfter("2026-05-20", "xyz", "Delivery date");
  assert.equal(r.valid, false);
  assert.equal(r.error, "Maximum date for Delivery date is not valid");
});

// ---------------------------------------------------------------------------
// validateSOItem — a single SO line. Returns ALL errors joined with "; ".
// ---------------------------------------------------------------------------
function validItem(overrides = {}) {
  return {
    quantity: 1,
    basePriceSen: 150_00,
    fabricCode: "M2402-4",
    ...overrides,
  };
}

test("validateSOItem: a fully valid line passes", () => {
  assert.deepEqual(v.validateSOItem(validItem()), { valid: true });
});

test("validateSOItem: zero quantity is rejected", () => {
  const r = v.validateSOItem(validItem({ quantity: 0 }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Quantity must be greater than 0/);
});

test("validateSOItem: negative quantity is rejected", () => {
  const r = v.validateSOItem(validItem({ quantity: -2 }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Quantity must be greater than 0/);
});

test("validateSOItem: negative base price is rejected", () => {
  const r = v.validateSOItem(validItem({ basePriceSen: -1 }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Base price must be 0 or greater/);
});

test("validateSOItem: zero base price is accepted (free/promo line)", () => {
  assert.equal(v.validateSOItem(validItem({ basePriceSen: 0 })).valid, true);
});

test("validateSOItem: missing fabric code is rejected", () => {
  const r = v.validateSOItem(validItem({ fabricCode: "" }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Fabric code is required/);
});

test("validateSOItem: whitespace-only fabric code is rejected", () => {
  const r = v.validateSOItem(validItem({ fabricCode: "  " }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Fabric code is required/);
});

test("validateSOItem: explicit negative unitPriceSen is rejected", () => {
  // unitPriceSen is optional, but when present it must be non-negative.
  const r = v.validateSOItem(validItem({ unitPriceSen: -50 }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Unit price must be 0 or greater/);
});

test("validateSOItem: omitted unitPriceSen falls back to basePriceSen", () => {
  // The fallback `unitPriceSen ?? basePriceSen` means a valid basePrice with
  // no unitPrice still passes the unit-price check.
  assert.equal(
    v.validateSOItem(validItem({ basePriceSen: 200_00 })).valid,
    true,
  );
});

test("validateSOItem: collects ALL errors, joined with semicolons", () => {
  // The comment promises "all errors found (not just the first)".
  const r = v.validateSOItem({
    quantity: 0,
    basePriceSen: -1,
    fabricCode: "",
  });
  assert.equal(r.valid, false);
  assert.match(r.error, /Quantity must be greater than 0/);
  assert.match(r.error, /Base price must be 0 or greater/);
  assert.match(r.error, /Fabric code is required/);
  assert.ok(r.error.includes("; "), "errors must be joined with '; '");
});

// ---------------------------------------------------------------------------
// validateSO — a whole Sales Order. Returns ALL errors joined with " | ".
// ---------------------------------------------------------------------------
function validOrder(overrides = {}) {
  return {
    customerName: "Acme Sdn Bhd",
    items: [validItem()],
    customerDeliveryDate: "2026-06-01",
    ...overrides,
  };
}

test("validateSO: a fully valid order passes", () => {
  assert.deepEqual(v.validateSO(validOrder()), { valid: true });
});

test("validateSO: missing customer name is rejected", () => {
  const r = v.validateSO(validOrder({ customerName: "" }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Customer name is required/);
});

test("validateSO: empty items array is rejected", () => {
  const r = v.validateSO(validOrder({ items: [] }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Sales order must have at least 1 item/);
});

test("validateSO: missing items property is rejected", () => {
  const r = v.validateSO({
    customerName: "Acme Sdn Bhd",
    customerDeliveryDate: "2026-06-01",
  });
  assert.equal(r.valid, false);
  assert.match(r.error, /Sales order must have at least 1 item/);
});

test("validateSO: missing delivery date is rejected", () => {
  const r = v.validateSO(validOrder({ customerDeliveryDate: "" }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Customer delivery date is required/);
});

test("validateSO: a bad line item surfaces with its line number", () => {
  const r = v.validateSO(
    validOrder({ items: [validItem(), validItem({ quantity: 0 })] }),
  );
  assert.equal(r.valid, false);
  assert.match(r.error, /Line 2: /);
  assert.match(r.error, /Quantity must be greater than 0/);
});

test("validateSO: first line errors are prefixed 'Line 1:'", () => {
  const r = v.validateSO(validOrder({ items: [validItem({ fabricCode: "" })] }));
  assert.equal(r.valid, false);
  assert.match(r.error, /Line 1: /);
});

test("validateSO: collects errors across header AND items, joined with ' | '", () => {
  const r = v.validateSO({
    customerName: "",
    items: [validItem({ quantity: 0 })],
    customerDeliveryDate: "",
  });
  assert.equal(r.valid, false);
  assert.match(r.error, /Customer name is required/);
  assert.match(r.error, /Line 1: /);
  assert.match(r.error, /Customer delivery date is required/);
  assert.ok(r.error.includes(" | "), "errors must be joined with ' | '");
});

// ---------------------------------------------------------------------------
// validateAll — batch runner over a list of validation thunks.
// ---------------------------------------------------------------------------
test("validateAll: all-passing list yields valid:true, no errors", () => {
  const r = v.validateAll([
    () => v.required("x", "A"),
    () => v.positiveNumber(1, "B"),
  ]);
  assert.deepEqual(r, { valid: true, errors: [] });
});

test("validateAll: empty list is vacuously valid", () => {
  assert.deepEqual(v.validateAll([]), { valid: true, errors: [] });
});

test("validateAll: collects every failure into the errors array", () => {
  const r = v.validateAll([
    () => v.required("", "A"),
    () => v.positiveNumber(1, "B"),
    () => v.positiveNumber(-1, "C"),
  ]);
  assert.equal(r.valid, false);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /A is required/);
  assert.match(r.errors[1], /C must be greater than 0/);
});
