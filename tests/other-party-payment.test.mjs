import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePaymentTotal,
  validateAllocations,
  buildPaymentLegs,
} from "../src/lib/other-party-payment.ts";
import { reverseLegs, OTHER_DEBTOR_CONTROL, OTHER_CREDITOR_CONTROL } from "../src/lib/other-party-bill.ts";

const sum = (legs, k) => legs.reduce((s, l) => s + l[k], 0);

test("computePaymentTotal sums allocations", () => {
  assert.equal(computePaymentTotal([{ billId: "b1", amountSen: 42400 }, { billId: "b2", amountSen: 50000 }]), 92400);
  assert.equal(computePaymentTotal([]), 0);
});

test("validateAllocations enforces presence, positivity, outstanding cap", () => {
  const out = { b1: 42400, b2: 150000 };
  assert.match(validateAllocations([], out), /at least one/i);
  assert.match(validateAllocations([{ billId: "x", amountSen: 100 }], out), /Unknown bill/);
  assert.match(validateAllocations([{ billId: "b1", amountSen: 0 }], out), /greater than zero/);
  assert.match(validateAllocations([{ billId: "b1", amountSen: 42401 }], out), /exceeds outstanding/);
  assert.equal(validateAllocations([{ billId: "b1", amountSen: 42400 }, { billId: "b2", amountSen: 50000 }], out), null);
});

test("buildPaymentLegs CREDITOR: DR 405 / CR bank, balances", () => {
  const legs = buildPaymentLegs({ partyType: "CREDITOR", paymentNo: "PV-2606-014", partyName: "ABC", bankAccount: "310-0010", totalSen: 92400 });
  assert.equal(legs.length, 2);
  assert.equal(sum(legs, "debitSen"), sum(legs, "creditSen"));
  const dr = legs.find((l) => l.debitSen > 0), cr = legs.find((l) => l.creditSen > 0);
  assert.equal(dr.accountCode, OTHER_CREDITOR_CONTROL);
  assert.equal(dr.debitSen, 92400);
  assert.equal(cr.accountCode, "310-0010");
  assert.equal(cr.creditSen, 92400);
  legs.forEach((l, i) => assert.equal(l.legNo, i + 1));
});

test("buildPaymentLegs DEBTOR: DR bank / CR 305, balances", () => {
  const legs = buildPaymentLegs({ partyType: "DEBTOR", paymentNo: "OR-2606-009", partyName: "Staff", bankAccount: "320-0000", totalSen: 53000 });
  assert.equal(legs.length, 2);
  assert.equal(sum(legs, "debitSen"), sum(legs, "creditSen"));
  const dr = legs.find((l) => l.debitSen > 0), cr = legs.find((l) => l.creditSen > 0);
  assert.equal(dr.accountCode, "320-0000");
  assert.equal(cr.accountCode, OTHER_DEBTOR_CONTROL);
  assert.equal(cr.creditSen, 53000);
});

test("reverseLegs (reused) swaps DR/CR and balances", () => {
  const legs = buildPaymentLegs({ partyType: "CREDITOR", paymentNo: "PV-2606-015", partyName: "P", bankAccount: "310-0010", totalSen: 10000 });
  const rev = reverseLegs(legs);
  assert.equal(sum(rev, "debitSen"), sum(legs, "creditSen"));
  assert.equal(sum(rev, "creditSen"), sum(legs, "debitSen"));
  rev.forEach((l) => assert.match(l.description, /^REVERSAL · /));
});
