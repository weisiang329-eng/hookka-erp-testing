// ---------------------------------------------------------------------------
// pi-void.test.mjs — voiding a POSTED purchase invoice must undo everything
// raising it did, and only the finance desk may do it.
//
// Owner 2026-08-05, on an imported GVP invoice (PI-2605-011, RM 2,650 sitting
// in the creditor aging with a live CR on 400-0000): 「帮我做 void 的功能，但是
// 权限放在 finance 和 super admin」.
//
// Before this there was no way out of CONFIRMED except PAID — DELETE is
// DRAFT-only and the status machine has no CANCELLED edge — so a wrongly
// imported invoice stayed on the books forever.
//
// The three guarantees that keep the books straight, asserted against the
// source because the handler is a batch of statements, not a pure function:
//   1. the ledger is reversed (or 400-0000 keeps the phantom liability)
//   2. grn_items.invoiced_qty is given back (or the GRN can never be re-billed)
//   3. a part-paid invoice is refused (or a payment strands on a dead invoice)
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/purchase-invoices.ts"),
  "utf8",
).replace(/\r\n/g, "\n");
const RBAC = readFileSync(resolve(process.cwd(), "src/api/lib/rbac.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

const VOID = SRC.slice(SRC.indexOf('app.post("/:id/void"'));

test("the route exists and is gated by the finance guard, not a resource permission", () => {
  assert.ok(VOID.length > 0, "POST /:id/void must exist");
  assert.match(VOID.slice(0, 400), /const denied = requireFinance\(c\);/);
});

test("requireFinance admits FINANCE, SUPER_ADMIN and ADMIN — and nobody else", () => {
  assert.match(RBAC, /export function requireFinance/);
  const fn = RBAC.slice(RBAC.indexOf("export function requireFinance"));
  assert.match(
    fn.slice(0, 700),
    /role !== "FINANCE" && role !== "SUPER_ADMIN" && role !== "ADMIN"/,
  );
});

test("a paid invoice is refused before anything is written", () => {
  const guardAt = VOID.indexOf("has been paid against this invoice");
  const writeAt = VOID.indexOf("await db.batch(statements)");
  assert.ok(guardAt > 0, "must refuse a part-paid invoice");
  assert.ok(guardAt < writeAt, "the refusal must come before the batch");
});

test("the ledger reversal mirrors the VISIBLE legs, netted per account", () => {
  assert.match(SRC, /hidden = 0 AND sourceType LIKE 'purchase_invoice%'/);
  // Debit and credit swap: reversing a net DR emits a CR.
  assert.match(SRC, /debitSen: delta > 0 \? delta : 0/);
  assert.match(SRC, /creditSen: delta < 0 \? -delta : 0/);
});

// --------------------------------------------------------------------------
// Unvoid. Owner 2026-08-05 voided PI-2606-073 — the half of the SUNMAT
// duplicate pair that carried the supplier's DO number — and asked for a way
// back. It must reverse every step of the void, and the void/unvoid/void cycle
// must stay correct however many times it is run.
// --------------------------------------------------------------------------
const UNVOID = SRC.slice(SRC.indexOf('app.post("/:id/unvoid"'));

test("unvoid exists and is gated by the same finance guard as void", () => {
  assert.ok(UNVOID.length > 0, "POST /:id/unvoid must exist");
  assert.match(UNVOID.slice(0, 400), /const denied = requireFinance\(c\);/);
});

test("unvoid restores the ledger to BASE — the invoice's own legs, not zero", () => {
  assert.match(UNVOID, /buildPiDeltaLegs\(base, total,/);
  assert.match(UNVOID, /sourceType: "purchase_invoice_unvoid"/);
});

test("base excludes the reversal legs, or unvoid would restore nothing", () => {
  assert.match(SRC, /const PI_REVERSAL_TYPES = \["purchase_invoice_void", "purchase_invoice_unvoid"\]/);
  assert.match(SRC, /if \(!PI_REVERSAL_TYPES\.includes\(String\(l\.sourceType\)\)\) \{/);
});

test("the journal is appended to, never edited — no DELETE of the void legs", () => {
  assert.doesNotMatch(UNVOID, /DELETE FROM ledger_journal_entries/);
});

test("unvoid re-claims the GRN quantity, and is REFUSED if it no longer fits", () => {
  assert.match(UNVOID, /buildGrnReconsumeStatements\(db, id\)/);
  const guardAt = UNVOID.indexOf("if (!reconsume.ok)");
  const writeAt = UNVOID.indexOf("await db.batch(statements)");
  assert.ok(guardAt > 0 && guardAt < writeAt, "the refusal must come before the batch");
  assert.match(SRC, /if \(invoiced \+ qty > accepted\) \{/);
});

test("the status returns to what it WAS, not a hardcoded guess", () => {
  assert.match(SRC, /ADD COLUMN IF NOT EXISTS pre_void_status TEXT/);
  assert.match(VOID, /SET status = 'CANCELLED', pre_void_status = \?/);
  assert.match(UNVOID, /preVoidStatus \?\?/);
  assert.match(UNVOID, /\|\| "CONFIRMED"/);
});

test("unvoiding a live invoice is a no-op, not an error", () => {
  assert.match(UNVOID, /alreadyLive: true/);
});

test("the reversal is idempotent — voiding twice cannot double-reverse", () => {
  // Derived from what is POSTED, not from how many times the button was
  // pressed: a second void computes delta = −total = 0 and writes nothing.
  assert.match(VOID, /buildPiDeltaLegs\(new Map\(\), total,/);
  assert.match(SRC, /if \(delta === 0\) continue;/);
});

test("the GRN convert-chain gets its quantity back", () => {
  assert.match(VOID, /buildGrnRestoreStatements\(db, id\)/);
});

test("the invoice ends CANCELLED so every subledger reader drops it", () => {
  assert.match(VOID, /SET status = 'CANCELLED'/);
});

test("a DRAFT is sent to delete instead, and a second void is a no-op", () => {
  assert.match(VOID, /A draft isn't posted/);
  assert.match(VOID, /alreadyVoid: true/);
});
