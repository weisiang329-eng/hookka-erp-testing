// Trade-finance repayment invariants (owner 2026-08-11), pinned at source
// level so a refactor cannot silently drop them:
//  1. TF_REPAYMENT rows must stay OUT of the unapplied-advance machinery —
//     they are liability paydowns, not supplier prepayments.
//  2. The repayment branch never touches purchase_invoices — it pays draws.
//  3. The lifecycle core carries both TF guards (draw-with-repayments cannot
//     void; a voided repayment cannot unvoid).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("advance loader excludes TF_REPAYMENT rows", () => {
  const src = readFileSync("src/api/routes/accounting.ts", "utf8");
  const at = src.indexOf("function loadUnappliedSupplierAdvances");
  assert.notEqual(at, -1);
  const fn = src.slice(at, at + 4000);
  assert.match(fn, /TF_REPAYMENT/);
});

test("repayment branch never bumps purchase_invoices", () => {
  const src = readFileSync("src/api/routes/supplier-payments.ts", "utf8");
  const start = src.indexOf("Trade-finance REPAYMENT");
  assert.notEqual(start, -1);
  const end = src.indexOf("// 2. Issue the payment voucher number", start);
  assert.notEqual(end, -1);
  const branch = src.slice(start, end);
  assert.doesNotMatch(branch, /UPDATE purchase_invoices/);
  assert.match(branch, /trade_finance_repay_allocs/);
  assert.match(branch, /'TF_REPAYMENT'/);
});

test("lifecycle core carries both TF guards and releases allocations on void", () => {
  const src = readFileSync("src/api/routes/supplier-payments.ts", "utf8");
  const at = src.indexOf("async function buildSupplierPaymentLifecycle");
  assert.notEqual(at, -1);
  const fn = src.slice(at, at + 9000);
  assert.match(fn, /TF_DRAW_HAS_REPAYMENTS/);
  assert.match(fn, /TF_REPAYMENT_NO_UNVOID/);
  assert.match(fn, /DELETE FROM trade_finance_repay_allocs WHERE repay_payment_no = \?/);
});
