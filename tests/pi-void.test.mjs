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
  assert.match(VOID, /hidden = 0 AND sourceType LIKE 'purchase_invoice%'/);
  assert.match(VOID, /netByAccount/);
  // Debit and credit swap: a net DR becomes a CR on the reversal leg.
  assert.match(VOID, /debitSen: net < 0 \? -net : 0/);
  assert.match(VOID, /creditSen: net > 0 \? net : 0/);
});

test("the reversal is idempotent — voiding twice cannot double-reverse", () => {
  assert.match(VOID, /ledgerHasSource\(\s*db,[\s\S]{0,160}?"purchase_invoice_void",\s*id\s*\)/);
  assert.match(VOID, /legs\.length > 0 && !alreadyVoided/);
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
