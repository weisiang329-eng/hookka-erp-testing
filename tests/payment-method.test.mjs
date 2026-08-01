// ---------------------------------------------------------------------------
// payment-method.test.mjs — how a worker is paid (owner 2026-08-01).
//
// The labels and the bank list are shared by four surfaces (Employee Master,
// the Payroll row, the payslip, the exports). A bank spelled differently on one
// of them is how a payment file gets rejected, so the list has exactly one home
// and these cases pin its behaviour.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const pm = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/payment-method.ts")).href
);

test("anything that is not CASH is a transfer", () => {
  assert.equal(pm.normalizePaymentMethod("CASH"), "CASH");
  assert.equal(pm.normalizePaymentMethod("cash"), "CASH");
  assert.equal(pm.normalizePaymentMethod(" Cash "), "CASH");
  assert.equal(pm.normalizePaymentMethod("TRANSFER"), "TRANSFER");
  // Legacy rows have no value at all — they must not become "cash in hand".
  assert.equal(pm.normalizePaymentMethod(null), "TRANSFER");
  assert.equal(pm.normalizePaymentMethod(undefined), "TRANSFER");
  assert.equal(pm.normalizePaymentMethod(""), "TRANSFER");
  assert.equal(pm.normalizePaymentMethod("nonsense"), "TRANSFER");
});

test("cash needs no bank details", () => {
  assert.equal(pm.paymentDestinationLabel("CASH"), "Cash");
  assert.equal(pm.paymentDestinationLabel("CASH", "Maybank", "1234"), "Cash");
});

test("a transfer shows bank and account together", () => {
  assert.equal(pm.paymentDestinationLabel("TRANSFER", "Maybank", "512345678901"),
    "Maybank · 512345678901");
});

test("a legacy single-string account still reads correctly", () => {
  // 67 existing payslips hold "CIMB-004XXXX" in bank_account with no bank set.
  assert.equal(pm.paymentDestinationLabel("TRANSFER", null, "CIMB-004XXXX"), "CIMB-004XXXX");
});

test("a transfer with nothing set SAYS so — never a silent blank", () => {
  assert.equal(pm.paymentDestinationLabel("TRANSFER", "", ""), "Bank details not set");
  assert.equal(pm.paymentDestinationLabel("TRANSFER", null, null), "Bank details not set");
});

test("the bank list is a fixed dropdown with no duplicates or stray spaces", () => {
  const banks = pm.MALAYSIAN_BANKS;
  assert.ok(banks.length > 10);
  assert.equal(new Set(banks).size, banks.length, "duplicate bank");
  for (const b of banks) assert.equal(b, b.trim(), `padded: ${JSON.stringify(b)}`);
  assert.ok(banks.includes("Maybank") && banks.includes("CIMB Bank"));
});
