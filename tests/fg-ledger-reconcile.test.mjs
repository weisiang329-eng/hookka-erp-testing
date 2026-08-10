// ---------------------------------------------------------------------------
// fg-ledger-reconcile.test.mjs — the check that the two finished-goods ledgers
// agree.
//
// WHY THIS EXISTS AT ALL. Houzs shipped the same two-ledger shape — a per-unit
// stock ledger beside a per-lot cost ledger — and the two halves diverged in
// production. Their post-mortem's conclusion was not that the arithmetic was
// wrong; it was that NOTHING EVER ASSERTED THE TWO AGREED, so the drift was
// only found once it was months deep and no longer attributable to any one
// document. These tests pin that the assertion actually fails when it should.
//
// A check that cannot fail is decoration, so the first thing tested is that it
// goes red — including on each of the two identities independently, because a
// check that only notices the loud break is how the quiet one survives.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { diffFgReconciliation } = await import(pathToFileURL(resolve(process.cwd(), "src/api/lib/fg-ledger-reconcile.ts")).href);

const m = (obj) => new Map(Object.entries(obj));

const input = ({ events = {}, units = {}, inFlight = {}, lots = {}, ...rest }) => ({
  ledgerBalance: m(events),
  onHandUnits: m(units),
  inFlightUnits: m(inFlight),
  lotRemaining: m(lots),
  ...rest,
});

test("it passes when all three totals agree", () => {
  const r = diffFgReconciliation(
    input({
      events: { "1013-(Q)": 30, "1007-(K)": 9 },
      units: { "1013-(Q)": 30, "1007-(K)": 9 },
      lots: { "1013-(Q)": 30, "1007-(K)": 9 },
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.disagreements, []);
  assert.deepEqual(r.problems, []);
  assert.equal(r.totals.onHandUnits, 39);
});

test("it fails when the event trail and the unit table disagree", () => {
  // A dispatch that moved fg_units but never wrote its OUT — the exact failure
  // mode a second ledger introduces.
  const r = diffFgReconciliation(
    input({
      events: { "1013-(Q)": 33 },
      units: { "1013-(Q)": 30 },
      lots: { "1013-(Q)": 30 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.disagreements[0].eventsVsUnits, 3);
  assert.equal(r.disagreements[0].unitsVsLots, 0);
  assert.match(r.problems.join(" "), /event trail and the fg_units table disagree/);
});

test("it fails when the pieces and the cost lots disagree", () => {
  // Production's real shape today: 379 lots carry a NEGATIVE remaining_qty and
  // 145 production orders carry duplicate lots that double-count their output.
  // That was invisible because nothing read fg_batches per unit. It must now be
  // loud — and it must NOT be "fixed" by the check.
  const r = diffFgReconciliation(
    input({
      events: { "1013-(Q)": 30 },
      units: { "1013-(Q)": 30 },
      lots: { "1013-(Q)": 794 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.disagreements[0].eventsVsUnits, 0);
  assert.equal(r.disagreements[0].unitsVsLots, -764);
  assert.match(r.problems.join(" "), /cost lots disagree/);
});

test("both identities are checked independently — one holding does not excuse the other", () => {
  const r = diffFgReconciliation(
    input({
      events: { A: 5, B: 2 },
      units: { A: 4, B: 2 },
      lots: { A: 4, B: 7 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2, "both breaks are reported, not just the first");
  const byCode = Object.fromEntries(r.rows.map((x) => [x.productCode, x]));
  assert.equal(byCode.A.eventsVsUnits, 1);
  assert.equal(byCode.A.unitsVsLots, 0);
  assert.equal(byCode.B.eventsVsUnits, 0);
  assert.equal(byCode.B.unitsVsLots, -5);
});

test("goods on a truck are a named timing difference, not a failure", () => {
  // The two halves book a dispatch at different moments and always have:
  // fg_units/stock_movements at DISPATCH, fg_batches at DELIVERY. Three pieces
  // stamped LOADED are legitimately out of one ledger and still in the other.
  // Subtracting that explicitly is the only safe treatment — absorbed into a
  // tolerance, it becomes the place a real break hides.
  const ok = diffFgReconciliation(
    input({
      events: { "1013-(Q)": 30 },
      units: { "1013-(Q)": 30 },
      inFlight: { "1013-(Q)": 3 },
      lots: { "1013-(Q)": 33 },
    }),
  );
  assert.equal(ok.ok, true, "33 lot units − 3 on the truck = 30 on hand");
  assert.equal(ok.rows[0].lotRemainingAtDispatch, 30);

  // …and it is a bridge, not a fudge: it does not absorb a genuine break.
  const bad = diffFgReconciliation(
    input({
      events: { "1013-(Q)": 30 },
      units: { "1013-(Q)": 30 },
      inFlight: { "1013-(Q)": 3 },
      lots: { "1013-(Q)": 40 },
    }),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.disagreements[0].unitsVsLots, -7);
});

test("a product with nothing on any side is not reported as anything", () => {
  const r = diffFgReconciliation(
    input({ events: { A: 0 }, units: { A: 0 }, lots: { A: 0, B: 0 } }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 0, "silence about empty products, or the report is unreadable");
});

test("a deleted unit's orphaned events are reported but never fail the check", () => {
  // fg_stock_events cascades on fg_unit_id, so a regenerate / de-dupe repair
  // takes the events with the unit. A non-zero count means a repair ran, not
  // that the book is wrong — and exiting non-zero on it would train the
  // operator to ignore the check.
  const r = diffFgReconciliation(
    input({
      events: { A: 2 },
      units: { A: 2 },
      lots: { A: 2 },
      orphanEvents: 17,
      unitsWithoutEvents: 0,
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.orphanEvents, 17);
});

test("un-seeded units surface as a count, so a red check is never a mystery", () => {
  // Before the opening balance is seeded, Σ events reads 0 against a real
  // on-hand count. The check still fails — it must, the totals really do
  // disagree — but it carries the number that explains why.
  const r = diffFgReconciliation(
    input({
      events: {},
      units: { "1013-(Q)": 30 },
      lots: { "1013-(Q)": 30 },
      unitsWithoutEvents: 4866,
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.unitsWithoutEvents, 4866);
  assert.equal(r.disagreements[0].eventsVsUnits, -30);
});

test("the opening-balance seed makes Σ events equal the on-hand count exactly", async () => {
  // The seed writes ONE row per unit: from NULL → its CURRENT status. Because
  // direction is onHand(to) − onHand(from), an on-hand piece contributes +1 and
  // a piece already delivered or in transit contributes 0 — no history is
  // invented and identity (A) holds from the first minute.
  const { balanceDelta } = await import(pathToFileURL(resolve(process.cwd(), "src/api/lib/fg-stock-events.ts")).href);
  const prodToday = [
    ...Array(231).fill("PACKED"),
    ...Array(31).fill("LOADED"),
    ...Array(4604).fill("DELIVERED"),
  ];
  const seeded = prodToday.reduce((sum, s) => sum + balanceDelta(null, s), 0);
  const onHand = prodToday.filter((s) => s === "PACKED").length;
  assert.equal(seeded, onHand);
  assert.equal(seeded, 231);
});
