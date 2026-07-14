import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ap-recon.ts")).href);

// Shorthand builders — every scenario asserts the CORE INVARIANT: the item
// contributions sum EXACTLY to the drift (unexplainedResidualSen === 0), so
// the endpoint can never show a drift it cannot itemize.
const pi = (o) => ({
  id: o.id, piNo: o.piNo ?? o.id, supplierName: o.sup ?? "S", status: o.status ?? "CONFIRMED",
  amountSen: o.face, paidSen: o.paid ?? 0,
  isOpening: !!o.isOpening, preOpeningIncluded: !!o.preOpen, floored: !!o.floored,
});
const leg = (sourceType, sourceId, drSen, crSen) => ({ sourceType, sourceId, debitSen: drSen, creditSen: crSen });
const pay = (o) => ({
  paymentNo: o.no, purchaseInvoiceId: o.pi ?? null, bookedSen: o.booked ?? 0,
  amountSen: o.amount ?? o.booked ?? 0, method: o.method ?? "BANK_TRANSFER",
  active: o.active !== false, supplierName: o.sup ?? "S", date: o.date ?? "2026-06-01",
});
const run = (i) =>
  m.buildApReconciliation({ legs400: [], pis: [], paymentRows: [], pcnPostedSen: 0, cnAllocCtlSen: 0, ...i });
const invariant = (r) => {
  assert.equal(r.unexplainedResidualSen, 0, `residual must be 0, got ${r.unexplainedResidualSen}`);
  assert.equal(r.explainedSen, r.driftSen);
};

test("clean books — post-opening PI + partial payment: drift 0, no items", () => {
  const r = run({
    legs400: [leg("purchase_invoice", "p1", 0, 100000), leg("supplier_payment", "HPV-1", 40000, 0)],
    pis: [pi({ id: "p1", face: 100000, paid: 40000, status: "PARTIAL_PAID" })],
    paymentRows: [pay({ no: "HPV-1", pi: "p1", booked: 40000 })],
  });
  assert.equal(r.controlSen, 60000);
  assert.equal(r.netSubledgerSen, 60000);
  assert.equal(r.driftSen, 0);
  assert.deepEqual(r.items, []);
  invariant(r);
});

test("clean books — opening-covered bills carry NO own GL (OCEAN SKY shape)", () => {
  const r = run({
    legs400: [leg("opening_balance", "ob", 0, 72300)],
    pis: [pi({ id: "p1", face: 72300, isOpening: true })],
  });
  assert.equal(r.driftSen, 0);
  assert.deepEqual(r.items, []);
  invariant(r);
});

test("live PI with no GL at all → pi_gl_mismatch −face", () => {
  const r = run({ pis: [pi({ id: "p1", face: 5000 })] });
  assert.equal(r.driftSen, -5000);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, "pi_gl_mismatch");
  assert.equal(r.items[0].contributionSen, -5000);
  invariant(r);
});

test("stray small DR leg on a live PI (the 15.06 clue) → itemized to the sen", () => {
  const r = run({
    legs400: [leg("purchase_invoice", "p1", 0, 100000), leg("purchase_invoice", "p1", 1506, 0)],
    pis: [pi({ id: "p1", face: 100000 })],
  });
  assert.equal(r.driftSen, -1506);
  assert.equal(r.items[0].kind, "pi_gl_mismatch");
  assert.equal(r.items[0].contributionSen, -1506);
  invariant(r);
});

test("voided payment whose GL legs stayed visible → void_payment_gl_leak", () => {
  const r = run({
    legs400: [leg("purchase_invoice", "p1", 0, 80000), leg("supplier_payment", "HPV-9", 50000, 0)],
    pis: [pi({ id: "p1", face: 80000, paid: 0 })],
    paymentRows: [pay({ no: "HPV-9", pi: "p1", booked: 50000, active: false })],
  });
  assert.equal(r.driftSen, -50000);
  assert.equal(r.items[0].kind, "void_payment_gl_leak");
  assert.equal(r.items[0].contributionSen, -50000);
  invariant(r);
});

test("voided ADVANCE row is excluded from the advance sum (BUG-2026-07-08-003) — no drift, no items", () => {
  const r = run({ paymentRows: [pay({ no: "HPV-2", amount: 95000, booked: 0, active: false })] });
  assert.equal(r.unappliedAdvanceSen, 0);
  assert.equal(r.driftSen, 0);
  assert.deepEqual(r.items, []);
  invariant(r);
});

test("live advance ties GL exactly → no items", () => {
  const r = run({
    legs400: [leg("supplier_payment", "HPV-3", 95000, 0)],
    paymentRows: [pay({ no: "HPV-3", amount: 95000, booked: 0 })],
  });
  assert.equal(r.driftSen, 0);
  assert.deepEqual(r.items, []);
  invariant(r);
});

test("double-bumped paid (INNOVATEX 418→836 shape): paid_drift + overpaid clamp cancel", () => {
  const r = run({
    legs400: [leg("purchase_invoice", "p1", 0, 41800), leg("supplier_payment", "HPV-4", 41800, 0)],
    pis: [pi({ id: "p1", piNo: "PI-2606-041", face: 41800, paid: 83600, status: "PARTIAL_PAID" })],
    paymentRows: [pay({ no: "HPV-4", pi: "p1", booked: 41800 })],
  });
  assert.equal(r.driftSen, 0); // the two defects hide each other in the total…
  const kinds = r.items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["overpaid_clamp", "pi_paid_drift"]); // …but both are surfaced
  assert.equal(r.items.find((i) => i.kind === "pi_paid_drift").contributionSen, 41800);
  assert.equal(r.items.find((i) => i.kind === "overpaid_clamp").contributionSen, -41800);
  invariant(r);
});

test("opening leg no longer matches the covered faces → opening_coverage gap", () => {
  const r = run({
    legs400: [leg("opening_balance", "ob", 0, 16058081)],
    pis: [pi({ id: "p1", face: 16000000, isOpening: true })],
  });
  assert.equal(r.driftSen, 58081);
  assert.equal(r.items[0].kind, "opening_coverage");
  assert.equal(r.items[0].contributionSen, 58081);
  invariant(r);
});

test("payment booked against a floored (excluded pre-opening) PI claims nothing", () => {
  const r = run({
    legs400: [leg("supplier_payment", "HPV-5", 30000, 0)],
    pis: [pi({ id: "px", face: 30000, floored: true })],
    paymentRows: [pay({ no: "HPV-5", pi: "px", booked: 30000 })],
  });
  assert.equal(r.driftSen, -30000);
  assert.equal(r.items[0].kind, "payment_gl_mismatch");
  assert.equal(r.items[0].contributionSen, -30000);
  assert.match(r.items[0].note, /floored\/dead\/unknown/);
  invariant(r);
});

test("CN posted+allocated cleanly nets to zero; CN missing its GL → cn_block_mismatch", () => {
  const clean = run({
    legs400: [leg("purchase_invoice", "p1", 0, 100000), leg("purchase_credit_note", "cn1", 40000, 0)],
    pis: [pi({ id: "p1", face: 100000, paid: 40000, status: "PARTIAL_PAID" })],
    paymentRows: [pay({ no: "CN-1", pi: "p1", booked: 40000, method: "CREDIT_NOTE" })],
    pcnPostedSen: 40000, cnAllocCtlSen: 40000,
  });
  assert.equal(clean.driftSen, 0);
  assert.deepEqual(clean.items, []);
  invariant(clean);

  const broken = run({
    legs400: [leg("purchase_invoice", "p1", 0, 100000)], // CN never posted its DR
    pis: [pi({ id: "p1", face: 100000, paid: 40000, status: "PARTIAL_PAID" })],
    paymentRows: [pay({ no: "CN-1", pi: "p1", booked: 40000, method: "CREDIT_NOTE" })],
    pcnPostedSen: 40000, cnAllocCtlSen: 40000,
  });
  assert.equal(broken.driftSen, 40000);
  assert.equal(broken.items[0].kind, "cn_block_mismatch");
  assert.equal(broken.items[0].contributionSen, 40000);
  invariant(broken);
});

test("manual JV / stray source on 400-0000 → other_source_leg", () => {
  const r = run({ legs400: [leg("journal_entry", "JE-2606-0007", 0, 10000)] });
  assert.equal(r.driftSen, 10000);
  assert.equal(r.items[0].kind, "other_source_leg");
  assert.equal(r.items[0].contributionSen, 10000);
  invariant(r);
});

test("PAID-status PI with face≠paid stays out of aging but not out of the GL → status_excluded_outstanding", () => {
  const r = run({
    legs400: [leg("purchase_invoice", "p1", 0, 100000), leg("supplier_payment", "HPV-6", 80000, 0)],
    pis: [pi({ id: "p1", face: 100000, paid: 80000, status: "PAID" })],
    paymentRows: [pay({ no: "HPV-6", pi: "p1", booked: 80000 })],
  });
  assert.equal(r.driftSen, 20000);
  assert.equal(r.items[0].kind, "status_excluded_outstanding");
  assert.equal(r.items[0].contributionSen, 20000);
  invariant(r);
});

test("kitchen sink — independent defects sum exactly to the drift", () => {
  const r = run({
    legs400: [
      leg("opening_balance", "ob", 0, 500000), // covers 490000 of faces → +10000
      leg("purchase_invoice", "p2", 0, 200000),
      leg("purchase_invoice", "p2", 1506, 0), // stray DR → −1506
      leg("supplier_payment", "HPV-A", 60000, 0), // live, ties
      leg("supplier_payment", "HPV-B", 15240, 0), // voided but visible → −15240
      leg("journal_entry", "JE-1", 0, 700), // stray JV → +700
    ],
    pis: [
      pi({ id: "p1", face: 490000, isOpening: true }),
      pi({ id: "p2", face: 200000, paid: 60000, status: "PARTIAL_PAID" }),
    ],
    paymentRows: [
      pay({ no: "HPV-A", pi: "p2", booked: 60000 }),
      pay({ no: "HPV-B", pi: "p2", booked: 15240, active: false }),
      pay({ no: "HPV-C", amount: 95000, booked: 0, active: false }), // voided advance → filtered, no effect
    ],
  });
  // drift = +10000 −1506 −15240 +700 = −6046
  assert.equal(r.driftSen, -6046);
  assert.equal(r.items.length, 4);
  invariant(r);
});

test("prod shape 2026-07-08 — the −966.60 decomposition (GVP + INNOVATEX + voided-advance fix + edit-leg pair)", () => {
  // Miniature of the live books the endpoint reconciled on 2026-07-08:
  //   GVP 950 booked to an EXCLUDED pre-opening PI  → −950
  //   INNOVATEX GL restate leg kept 836 vs claim 418 → −418
  //   WF LEATHER voided advance 401.40 — after the loader fix it no longer
  //   counts, so it contributes NOTHING (pre-fix it masked +401.40)
  //   pi edit-leg pair ±15.06 cancels within one sourceId after suffix strip
  const r = run({
    legs400: [
      leg("opening_balance", "ob", 0, 100000),
      leg("supplier_payment", "HPV-2605-001", 95000, 0), // GVP: pays the excluded PI
      leg("purchase_invoice", "pinv", 0, 41800),
      leg("supplier_payment", "HPV-2607-009", 83600, 0), // INNOVATEX: GL kept 836
      leg("purchase_invoice", "pinv:edit-1782106749028", 1506, 0), // edit-leg pair folds into
      leg("purchase_invoice", "pinv:edit-1782106902862", 0, 1506), // the base PI → cancels
    ],
    pis: [
      pi({ id: "pop", face: 100000, isOpening: true }),
      pi({ id: "pgvp", piNo: "PI-2605-001", face: 95000, paid: 95000, floored: true }),
      pi({ id: "pinv", piNo: "PI-2606-041", face: 41800, paid: 41800, status: "PAID" }),
    ],
    paymentRows: [
      pay({ no: "HPV-2605-001", pi: "pgvp", booked: 95000 }),
      pay({ no: "HPV-2607-009", pi: "pinv", booked: 41800 }),
      pay({ no: "HPV-2607-026", amount: 40140, booked: 0, active: false }),
    ],
  });
  assert.equal(r.driftSen, -95000 - 41800);
  const byRef = Object.fromEntries(r.items.map((i) => [i.ref, i]));
  assert.equal(byRef["HPV-2605-001"].contributionSen, -95000);
  assert.equal(byRef["HPV-2607-009"].contributionSen, -41800);
  assert.equal(r.unappliedAdvanceSen, 0);
  invariant(r);
});

test("glBySource families aggregate DR/CR/net", () => {
  const r = run({
    legs400: [
      leg("opening_balance", "ob", 0, 100),
      leg("purchase_invoice", "p", 10, 200),
      leg("supplier_payment_restate_post:123", "HPV", 50, 0),
      leg("purchase_credit_note", "cn", 30, 0),
      leg("contra_settlement", "x", 0, 5),
    ],
  });
  const fam = Object.fromEntries(r.glBySource.map((g) => [g.family, g.netSen]));
  assert.equal(fam.opening, 100);
  assert.equal(fam.purchase_invoice, 190);
  assert.equal(fam.supplier_payment, -50);
  assert.equal(fam.purchase_credit_note, -30);
  assert.equal(fam.other, 5);
  invariant(r);
});

test("AR config — swapped legs, DR-normal control: invoice + receipt tie; missing receipt GL itemized", () => {
  // AR mirror: invoice DR 300 fed as CR; receipt CR 300 fed as DR.
  const cfg = m.AR_RECON_CFG;
  const clean = m.buildApReconciliation({
    legs400: [
      { sourceType: "invoice", sourceId: "inv-1", debitSen: 0, creditSen: 100000 }, // swapped DR 1000
      { sourceType: "payment_restate_post:9", sourceId: "pay-1", debitSen: 40000, creditSen: 0 }, // swapped CR 400
    ],
    pis: [{ id: "inv-1", piNo: "INV-1", supplierName: "HOUZS", status: "PARTIAL_PAID", amountSen: 100000, paidSen: 40000, isOpening: false, preOpeningIncluded: false, floored: false }],
    paymentRows: [{ paymentNo: "pay-1", purchaseInvoiceId: "inv-1", bookedSen: 40000, amountSen: 40000, method: "BANK_TRANSFER", active: true, supplierName: "HOUZS", date: "2026-06-01" }],
    pcnPostedSen: 0, cnAllocCtlSen: 0,
  }, cfg);
  assert.equal(clean.driftSen, 0);
  assert.deepEqual(clean.items, []);
  assert.equal(clean.unexplainedResidualSen, 0);

  // Receipt applied in the subledger but its GL CR missing → -paid drift item.
  const broken = m.buildApReconciliation({
    legs400: [{ sourceType: "invoice", sourceId: "inv-1", debitSen: 0, creditSen: 100000 }],
    pis: [{ id: "inv-1", piNo: "INV-1", supplierName: "HOUZS", status: "PAID", amountSen: 100000, paidSen: 100000, isOpening: false, preOpeningIncluded: false, floored: false }],
    paymentRows: [{ paymentNo: "pay-1", purchaseInvoiceId: "inv-1", bookedSen: 100000, amountSen: 100000, method: "BANK_TRANSFER", active: true, supplierName: "HOUZS", date: "2026-06-01" }],
    pcnPostedSen: 0, cnAllocCtlSen: 0,
  }, cfg);
  assert.equal(broken.driftSen, 100000); // control kept the full face, subledger says settled
  assert.equal(broken.items.length, 1);
  assert.equal(broken.items[0].kind, "payment_gl_mismatch");
  assert.equal(broken.unexplainedResidualSen, 0);
});
