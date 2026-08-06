// ---------------------------------------------------------------------------
// customer-advance.test.mjs — a customer receipt may hold money on account.
//
// Owner 2026-08-06: 「我要的就类似 advance, 如果我收这笔钱，但是没有 knock off
// 单，他们的状态就是字体会显示蓝色」. The blue row shipped first and lit up
// nothing, because the receipt's amount was DERIVED from its allocations —
// `amount: totalAllocated`, and a zero-allocation receipt was refused outright.
// The state the colour was built for could not exist.
//
// The three properties that make an advance safe, asserted against the source
// because they live inside route handlers over statement batches:
//   1. the receipt carries its OWN amount (or an advance rounds down to zero)
//   2. allocations may never EXCEED it (or invoices get credited with money
//      that never arrived)
//   3. the unapplied remainder is netted off the AR control (or every advance
//      reports as drift on the card the owner watches — the same false alarm
//      the supplier side carried until BUG-2026-07-08-003)
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAY = read("src/api/routes/payments.ts");
const ACC = read("src/api/routes/accounting.ts");
const PAGE = read("src/pages/invoices/payments.tsx");

test("the receipt amount is the money received, not the allocation sum", () => {
  // Create sends what the operator entered…
  assert.match(PAGE, /amount: receivedSen,/);
  // …and the restate carries it explicitly, defaulting to the old behaviour.
  assert.match(PAGE, /amountSen: receivedSen/);
  assert.match(PAY, /Number\(body\.amountSen \?\? newTotal\)/);
  assert.match(PAY, /UPDATE payment_records SET amount = \?/);
});

test("allocating MORE than was received is refused, on create and on edit", () => {
  assert.match(PAY, /if \(allocSen > receiptSen\)/);
  assert.match(PAY, /if \(newAmount < newTotal\)/);
  assert.match(PAY, /ALLOCATIONS_EXCEED_AMOUNT/);
});

test("a receipt with no allocations is allowed when it carries an amount", () => {
  // The old guard rejected every zero-allocation edit outright.
  assert.doesNotMatch(PAY, /A receipt must allocate to at least one invoice/);
  assert.match(PAY, /allocs\.length === 0 && !\(Number\(body\.amountSen\) > 0\)/);
});

test("the GL posts the RECEIVED amount, so the debtor control carries the advance", () => {
  const restate = PAY.slice(PAY.indexOf("buildCustomerPaymentRestate"));
  assert.match(restate, /debitSen: newAmount,/);
  assert.match(restate, /creditSen: newAmount,/);
});

test("invoice bumps still follow the ALLOCATIONS, never the received amount", () => {
  // newTotal drives the per-invoice paid bumps and the customer counter; only
  // the GL and the receipt row moved to newAmount.
  assert.match(PAY, /newTotal \+= a\.amount;/);
  assert.match(PAY, /oldTotal !== newTotal/);
});

test("unapplied customer advances are netted off the AR control", () => {
  assert.match(ACC, /async function loadUnappliedCustomerAdvances/);
  assert.match(ACC, /const netOutstandingSen = invoiceOutstandingSen - unappliedAdvanceSen;/);
  assert.match(ACC, /driftControlVsInvoicesSen: tradeControlSen - netOutstandingSen/);
});

test("…and appear in the AR aging as negative rows, like the supplier side", () => {
  assert.match(ACC, /loadUnappliedCustomerAdvances\(c\.var\.DB, orgId\)/);
  assert.match(ACC, /no: `\$\{it\.receiptNumber\} · Advance`/);
  assert.match(ACC, /amountSen: -it\.sen,/);
});

test("a voided receipt holds nothing — excluded from the advance set", () => {
  const fn = ACC.slice(ACC.indexOf("async function loadUnappliedCustomerAdvances"));
  assert.match(fn.slice(0, 1600), /dl\.state <> 'ACTIVE'/);
});

test("the list still marks a part-applied receipt blue", () => {
  assert.match(PAGE, /function hasUnallocated/);
  assert.match(PAGE, /text-blue-600/);
});
