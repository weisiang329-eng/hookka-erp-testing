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
import { readFile } from "node:fs/promises";

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
  // Older rows hold the whole thing in bank_account with no bank set. The 67
  // seeded "CIMB-<empNo>XXXX" rows were blanked on prod 2026-08-02, but the
  // single-string SHAPE is still what a hand-typed account looks like.
  assert.equal(pm.paymentDestinationLabel("TRANSFER", null, "CIMB-004XXXX"), "CIMB-004XXXX");
});

test("the seed never invents a bank account", async () => {
  // It used to: `CIMB-${empNo}XXXX`, which the seed carried into the real
  // payslips table, so 67 stored payslips would have PRINTED an account that
  // does not exist. Blanking prod fixes the rows that are there; this stops a
  // re-seed from putting them back (owner: 「假的acc就不要放了 放空都好过放假的」).
  //
  // Scanned as source text rather than imported: mock-data.ts resolves "@/lib"
  // through the Vite alias, which the test runner has no idea about.
  const src = await readFile(resolve(process.cwd(), "src/lib/mock-data.ts"), "utf8");
  // Object-literal assignments only — `bankAccount: string;` in the type is a
  // declaration, not a value, and matching it would fail on nothing real.
  const assignments = [...src.matchAll(/^\s*bankAccount:\s*(.+?),\s*$/gm)].map((m) =>
    m[1].trim(),
  );
  assert.ok(assignments.length > 0, "no bankAccount assignment found — has it moved?");
  for (const value of assignments) {
    assert.ok(
      value === '""' || value === "''",
      `seed must not invent a bank account, got bankAccount: ${value}`,
    );
  }
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
