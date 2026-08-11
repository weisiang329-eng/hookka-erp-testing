import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/trade-finance.ts")).href);

const legs = [
  { sourceType: "supplier_payment", sourceId: "HPV-2607-001", debitSen: 0, creditSen: 100000 },
  { sourceType: "supplier_payment_restate_post:x", sourceId: "HPV-2607-002", debitSen: 0, creditSen: 50000 },
  // a repayment: DR on the TF account under its own payment no
  { sourceType: "supplier_payment", sourceId: "HPV-2608-009", debitSen: 30000, creditSen: 0 },
];
const metas = [
  { drawSourceId: "HPV-2607-001", drawDate: "2026-07-07", dueDate: "2026-10-05" },
  { drawSourceId: "HPV-2607-002", drawDate: "2026-07-24", dueDate: "2026-08-01" },
];
const allocs = [{ repayPaymentNo: "HPV-2608-009", drawSourceId: "HPV-2607-002", amountSen: 30000 }];

test("deriveDraws nets families, excludes repayments, ties the identity", () => {
  const r = m.deriveDraws(legs, metas, allocs, new Set(["HPV-2608-009"]));
  assert.equal(r.accountNetSen, 120000);
  assert.deepEqual(r.draws.map((d) => [d.drawSourceId, d.amountSen, d.repaidSen, d.outstandingSen]), [
    ["HPV-2607-002", 50000, 30000, 20000], // earlier due date sorts first
    ["HPV-2607-001", 100000, 0, 100000],
  ]);
  assert.equal(r.unallocatedSen, 120000 - 20000 - 100000); // 0 — identity closes
});

test("a voided draw (family nets 0) drops out", () => {
  const r = m.deriveDraws(
    [
      { sourceType: "supplier_payment", sourceId: "A", debitSen: 0, creditSen: 7000 },
      { sourceType: "supplier_payment_void", sourceId: "A", debitSen: 7000, creditSen: 0 },
    ],
    [{ drawSourceId: "A", drawDate: "2026-07-01", dueDate: "2026-09-29" }], [], new Set(),
  );
  assert.equal(r.draws.length, 0);
  assert.equal(r.accountNetSen, 0);
});

test("a draw with no meta surfaces with empty dueDate (caller heals it)", () => {
  const r = m.deriveDraws(
    [{ sourceType: "supplier_payment", sourceId: "B", debitSen: 0, creditSen: 1000 }],
    [], [], new Set(),
  );
  assert.deepEqual(r.draws.map((d) => [d.drawSourceId, d.dueDate]), [["B", ""]]);
});

test("buckets by days past DUE date", () => {
  assert.equal(m.addDays("2026-07-07", 90), "2026-10-05");
  assert.equal(m.tfBucketOf("2026-08-20", "2026-08-11"), "notDue");
  assert.equal(m.tfBucketOf("2026-08-11", "2026-08-11"), "notDue"); // due today = not yet overdue
  assert.equal(m.tfBucketOf("2026-08-01", "2026-08-11"), "d1_30");
  assert.equal(m.tfBucketOf("2026-06-20", "2026-08-11"), "d31_60");
  assert.equal(m.tfBucketOf("2026-05-20", "2026-08-11"), "d61_90");
  assert.equal(m.tfBucketOf("2026-01-01", "2026-08-11"), "over90");
  const t = m.tfTotals([
    { drawSourceId: "A", drawDate: "", dueDate: "2026-08-01", amountSen: 0, repaidSen: 0, outstandingSen: 500 },
    { drawSourceId: "B", drawDate: "", dueDate: "2026-09-01", amountSen: 0, repaidSen: 0, outstandingSen: 300 },
  ], "2026-08-11");
  assert.equal(t.d1_30, 500);
  assert.equal(t.notDue, 300);
  assert.equal(t.total, 800);
});

test("clampRepayAlloc refuses overpay and non-positive", () => {
  assert.equal(m.clampRepayAlloc(1000, 1000).ok, true);
  assert.equal(m.clampRepayAlloc(1000, 1001).ok, false);
  assert.equal(m.clampRepayAlloc(1000, 0).ok, false);
  assert.equal(m.clampRepayAlloc(1000, -5).ok, false);
});
