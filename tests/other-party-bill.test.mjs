import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prefixForPartyType,
  computeBillTotals,
  validateBillShape,
  buildBillLegs,
  reverseLegs,
  editedBillStatus,
  OTHER_DEBTOR_CONTROL,
  OTHER_CREDITOR_CONTROL,
  OUTPUT_SST_ACCT,
  INPUT_SST_ACCT,
} from "../src/lib/other-party-bill.ts";

const sum = (legs, k) => legs.reduce((s, l) => s + l[k], 0);

test("prefixForPartyType", () => {
  assert.equal(prefixForPartyType("CREDITOR"), "OCB");
  assert.equal(prefixForPartyType("DEBTOR"), "ODB");
});

test("computeBillTotals sums lines + tax", () => {
  const items = [{ counterAccount: "700-1015", amountSen: 30000 }, { counterAccount: "780-0000", amountSen: 10000 }];
  assert.deepEqual(computeBillTotals(items, 2400), { subtotalSen: 40000, totalSen: 42400 });
  assert.deepEqual(computeBillTotals(items, 0), { subtotalSen: 40000, totalSen: 40000 });
});

test("validateBillShape rejects bad input", () => {
  assert.equal(validateBillShape([], 0), "At least one line is required");
  assert.match(validateBillShape([{ counterAccount: "", amountSen: 100 }], 0), /counter account/);
  assert.match(validateBillShape([{ counterAccount: "405-0000", amountSen: 100 }], 0), /cannot be used/);
  assert.match(validateBillShape([{ counterAccount: "706-0000", amountSen: 100 }], 0), /cannot be used/);
  assert.match(validateBillShape([{ counterAccount: "700-1015", amountSen: 0 }], 0), /greater than zero/);
  assert.match(validateBillShape([{ counterAccount: "700-1015", amountSen: 100 }], -5), /negative/);
  assert.equal(validateBillShape([{ counterAccount: "700-1015", amountSen: 100 }], 0), null);
});

test("buildBillLegs CREDITOR with tax balances and routes input SST to 706", () => {
  const legs = buildBillLegs({
    partyType: "CREDITOR",
    billNo: "OCB-2606-001",
    partyName: "ABC Transport",
    items: [{ counterAccount: "700-1015", amountSen: 30000 }, { counterAccount: "780-0000", amountSen: 10000 }],
    taxSen: 2400,
  });
  assert.equal(legs.length, 4);
  assert.equal(sum(legs, "debitSen"), sum(legs, "creditSen"));
  assert.equal(sum(legs, "creditSen"), 42400);
  const dr = legs.filter((l) => l.debitSen > 0);
  assert.deepEqual(dr.map((l) => l.accountCode).sort(), ["700-1015", "706-0000", "780-0000"]);
  const cr = legs.find((l) => l.creditSen > 0);
  assert.equal(cr.accountCode, OTHER_CREDITOR_CONTROL);
  assert.equal(cr.creditSen, 42400);
  assert.equal(legs.find((l) => l.accountCode === INPUT_SST_ACCT).debitSen, 2400);
  legs.forEach((l, i) => assert.equal(l.legNo, i + 1));
});

test("buildBillLegs DEBTOR with tax balances and routes output SST to 350", () => {
  const legs = buildBillLegs({
    partyType: "DEBTOR",
    billNo: "ODB-2606-001",
    partyName: "Staff X",
    items: [{ counterAccount: "500-0000", amountSen: 50000 }],
    taxSen: 3000,
  });
  assert.equal(legs.length, 3);
  assert.equal(sum(legs, "debitSen"), sum(legs, "creditSen"));
  const dr = legs.find((l) => l.debitSen > 0);
  assert.equal(dr.accountCode, OTHER_DEBTOR_CONTROL);
  assert.equal(dr.debitSen, 53000);
  assert.equal(legs.find((l) => l.accountCode === OUTPUT_SST_ACCT).creditSen, 3000);
  assert.equal(legs.find((l) => l.accountCode === "500-0000").creditSen, 50000);
});

test("buildBillLegs without tax has no SST leg", () => {
  const cred = buildBillLegs({ partyType: "CREDITOR", billNo: "OCB-2606-002", partyName: "P", items: [{ counterAccount: "700-1015", amountSen: 30000 }], taxSen: 0 });
  assert.equal(cred.length, 2);
  assert.equal(cred.some((l) => l.accountCode === INPUT_SST_ACCT), false);
  const deb = buildBillLegs({ partyType: "DEBTOR", billNo: "ODB-2606-002", partyName: "P", items: [{ counterAccount: "500-0000", amountSen: 30000 }], taxSen: 0 });
  assert.equal(deb.length, 2);
  assert.equal(deb.some((l) => l.accountCode === OUTPUT_SST_ACCT), false);
});

test("reverseLegs swaps DR/CR, renumbers, prefixes REVERSAL", () => {
  const legs = buildBillLegs({ partyType: "CREDITOR", billNo: "OCB-2606-003", partyName: "P", items: [{ counterAccount: "700-1015", amountSen: 30000 }], taxSen: 0 });
  const rev = reverseLegs(legs);
  assert.equal(rev.length, legs.length);
  assert.equal(sum(rev, "debitSen"), sum(legs, "creditSen"));
  assert.equal(sum(rev, "creditSen"), sum(legs, "debitSen"));
  rev.forEach((l, i) => { assert.equal(l.legNo, i + 1); assert.match(l.description, /^REVERSAL · /); });
});

test("editedBillStatus — paid below/equal/above the new total (edit-in-place guard)", () => {
  assert.deepEqual(editedBillStatus(10000, 0), { ok: true, status: "OPEN" });
  assert.deepEqual(editedBillStatus(10000, 4000), { ok: true, status: "PARTIAL_PAID" });
  assert.deepEqual(editedBillStatus(10000, 10000), { ok: true, status: "PAID" });
  const over = editedBillStatus(10000, 12000);
  assert.equal(over.ok, false);
  assert.match(over.error, /already paid/);
});
