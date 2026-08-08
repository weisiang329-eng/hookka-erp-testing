// ---------------------------------------------------------------------------
// stock-breakdown.test.mjs — behaviour tests for the Stock Breakdown drawer's
// shared rules (src/lib/stock-breakdown.ts) and the route's document-recovery
// helpers (src/api/routes/stock-breakdown.ts).
//
// These assert BEHAVIOUR the screen depends on, not implementation:
//
//   • the running balance is DERIVED and equals the sum of the movements at
//     every row — the property that stops the `wip_items` drift from repeating;
//   • a lot with no source document still renders (number without a link);
//   • the WIP panel states that outbound movements are missing rather than
//     showing a reconciled-looking figure.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const {
  withRunningBalance,
  closingBalance,
  reconciliationOf,
  ledgerVsOnHand,
  sourceDocHref,
  deptSlug,
  ageDays,
  fifoAge,
  roundQty,
  fgUnitCostSen,
  valuationNote,
  piecesNote,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/stock-breakdown.ts")).href
);

const { grnIdFromBatchId, grnNoFromNotes } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/stock-breakdown.ts")).href
);

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
function mv(date, direction, qty, extra = {}) {
  seq += 1;
  return {
    id: `cl-${String(seq).padStart(3, "0")}`,
    date,
    direction,
    type: direction === "IN" ? "RM_RECEIPT" : "RM_ISSUE",
    qty,
    unitCostSen: 100,
    totalCostSen: qty * 100,
    balanceAfter: null,
    docType: null,
    docId: null,
    docNo: null,
    docHref: null,
    ...extra,
  };
}

// ── the running balance is DERIVED ──────────────────────────────────────────

test("running balance equals the signed sum of movements up to each row", () => {
  const movements = [
    mv("2026-01-01T00:00:00Z", "IN", 100),
    mv("2026-01-05T00:00:00Z", "OUT", 30),
    mv("2026-01-09T00:00:00Z", "IN", 10),
    mv("2026-01-12T00:00:00Z", "OUT", 5),
  ];
  const rec = reconciliationOf("RM", movements);
  const rows = withRunningBalance(movements, rec);

  // Returned NEWEST first — that is how the panel reads.
  assert.deepEqual(
    rows.map((r) => r.date),
    [
      "2026-01-12T00:00:00Z",
      "2026-01-09T00:00:00Z",
      "2026-01-05T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ],
  );

  // Every row's balance must equal the sum of everything up to and including
  // it, computed independently here. This is the property that makes the
  // column trustworthy — not that it matches a stored total.
  const oldestFirst = [...rows].reverse();
  let expected = 0;
  for (const row of oldestFirst) {
    expected += row.direction === "IN" ? row.qty : -row.qty;
    assert.equal(row.balanceAfter, roundQty(expected), `at ${row.id}`);
  }
  assert.equal(oldestFirst.at(-1).balanceAfter, 75);
  assert.equal(closingBalance(movements, rec), 75);
});

test("running balance is order-independent — the input list may arrive in any order", () => {
  const a = mv("2026-02-01T00:00:00Z", "IN", 40);
  const b = mv("2026-02-02T00:00:00Z", "OUT", 15);
  const c = mv("2026-02-03T00:00:00Z", "IN", 5);
  const rec = reconciliationOf("RM", [a, b, c]);

  const fromOldest = withRunningBalance([a, b, c], rec).map((r) => r.balanceAfter);
  const fromNewest = withRunningBalance([c, b, a], rec).map((r) => r.balanceAfter);
  const shuffled = withRunningBalance([b, c, a], rec).map((r) => r.balanceAfter);

  assert.deepEqual(fromOldest, [30, 25, 40]);
  assert.deepEqual(fromNewest, fromOldest);
  assert.deepEqual(shuffled, fromOldest);
});

test("same-timestamp movements get a stable, total order (id breaks the tie)", () => {
  const rows = withRunningBalance(
    [
      { ...mv("2026-03-01T00:00:00Z", "OUT", 4), id: "cl-b" },
      { ...mv("2026-03-01T00:00:00Z", "IN", 10), id: "cl-a" },
    ],
    reconciliationOf("RM", []),
  );
  // cl-a sorts first, so it is the OLDER of the two and closes at 10; cl-b
  // then closes at 6. Without a tiebreak this pair would flip between runs.
  assert.deepEqual(
    rows.map((r) => [r.id, r.balanceAfter]),
    [
      ["cl-b", 6],
      ["cl-a", 10],
    ],
  );
});

test("fractional quantities do not accumulate float noise in the balance", () => {
  // Raw material is metres and kilos — 0.1 + 0.2 territory. Over a few hundred
  // rows the naive sum drifts into 23300.749999999996 and the column shows it.
  const movements = [];
  for (let i = 0; i < 300; i += 1) movements.push(mv(`2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, "IN", 0.1));
  const rec = reconciliationOf("RM", movements);
  const rows = withRunningBalance(movements, rec);
  assert.equal(rows[0].balanceAfter, 30);
});

// ── a lot with no source document still renders ─────────────────────────────

test("a receipt whose GRN document is gone still yields a number and no link", () => {
  // Prod reality: 542 distinct GRN numbers are referenced by rm_batches but
  // only 37 GRN documents survive. The number lives in the notes.
  const notes = "GRN GRN-IMPORT-PI-2603-058 line 1";
  assert.equal(grnNoFromNotes(notes), "GRN-IMPORT-PI-2603-058");
  assert.equal(grnNoFromNotes("Received via GRN-IMPORT-PI-2601-131"), "GRN-IMPORT-PI-2601-131");
  assert.equal(
    grnNoFromNotes("Edit GRN-IMPORT-PI-2606-002: accepted qty adjusted by -1"),
    "GRN-IMPORT-PI-2606-002",
  );

  // No document id → no href. The panel prints the number as plain text.
  assert.equal(sourceDocHref("GRN", null), null);
  assert.equal(sourceDocHref(null, "grn-3ce6ad0f"), null);
  // Document present → a real, openable link.
  assert.equal(sourceDocHref("GRN", "grn-3ce6ad0f"), "/procurement/grn/grn-3ce6ad0f");
});

test("a lot's GRN id is recoverable from the batch id when the column is NULL", () => {
  // rm_batches.grnId is NULL on all 1,100 GRN-sourced lots on prod; the id
  // itself is built from the GRN id by the post-to-stock cascade.
  assert.equal(grnIdFromBatchId("rmb-grn-grn-cc6e9aca-1"), "grn-cc6e9aca");
  assert.equal(grnIdFromBatchId("rmb-grn-grn-34a33b37-12"), "grn-34a33b37");
  // Opening-balance lots encode nothing — and must not be coerced into one.
  assert.equal(grnIdFromBatchId("rmb-opening-0073"), null);
  assert.equal(grnIdFromBatchId(null), null);
  assert.equal(grnIdFromBatchId(""), null);
});

test("a production order with no sales order has no link, and does not throw", () => {
  // /production/:id was deleted in April; production orders open on their SO.
  assert.equal(
    sourceDocHref("PRODUCTION_ORDER", "pord-so-22e3433c-03", { salesOrderId: "so-22e3433c" }),
    "/sales/so-22e3433c",
  );
  // A stock build has no sales order — no link rather than a dead one.
  assert.equal(sourceDocHref("PRODUCTION_ORDER", "pord-stock-1", {}), null);
});

test("a job card links to its department board, and only when the department is known", () => {
  assert.equal(sourceDocHref("JOB_CARD", "jc-1", { departmentCode: "FAB_CUT" }), "/production/fab-cut");
  assert.equal(sourceDocHref("JOB_CARD", "jc-1", {}), null);
  assert.equal(deptSlug("FOAM_CUTTING"), "foam-cutting");
  assert.equal(deptSlug("UPHOLSTERY"), "upholstery");
});

// ── the WIP panel says it cannot reconcile ──────────────────────────────────

test("WIP is never given a running balance, and says why in plain English", () => {
  const movements = [
    mv("2026-05-01T00:00:00Z", "IN", 23, { type: "LABOR_POSTED" }),
    mv("2026-05-02T00:00:00Z", "IN", 40, { type: "LABOR_POSTED" }),
    mv("2026-05-03T00:00:00Z", "IN", 1, { type: "WIP_COMPLETED" }),
  ];
  const rec = reconciliationOf("WIP", movements);

  assert.equal(rec.reconcilable, false);
  assert.ok(rec.notice, "the panel must be given something to say");
  assert.match(rec.notice, /outbound movements are not recorded/i);
  assert.match(rec.notice, /cannot be reconciled/i);

  // Not one row carries a balance. Nothing plausible-looking is offered.
  const rows = withRunningBalance(movements, rec);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.balanceAfter, null);
  assert.equal(closingBalance(movements, rec), null);
});

test("WIP stays unreconcilable even when a handful of OUT rows exist", () => {
  // Prod has 54 WIP OUT rows — all of them labour reversals from cancelled job
  // cards, not consumption. A ledger that records reversals but not consumption
  // is still one-sided, and 54 rows against 32,837 inbound must not be allowed
  // to flip the panel into looking reconciled.
  const movements = [
    mv("2026-05-01T00:00:00Z", "IN", 23, { type: "LABOR_POSTED" }),
    mv("2026-05-23T00:00:00Z", "OUT", 15, { type: "ADJUSTMENT" }),
  ];
  const rec = reconciliationOf("WIP", movements);
  assert.equal(rec.reconcilable, false);
  assert.equal(rec.inCount, 1);
  assert.equal(rec.outCount, 1);
  for (const r of withRunningBalance(movements, rec)) {
    assert.equal(r.balanceAfter, null);
  }
});

test("an item with movements out but none in is refused a balance too", () => {
  const movements = [mv("2026-06-01T00:00:00Z", "OUT", 5)];
  const rec = reconciliationOf("RM", movements);
  assert.equal(rec.reconcilable, false);
  assert.match(rec.notice, /no inbound/i);
});

test("an item with no movements at all reconciles at zero", () => {
  const rec = reconciliationOf("RM", []);
  assert.equal(rec.reconcilable, true);
  assert.equal(rec.notice, null);
  assert.equal(closingBalance([], rec), 0);
});

// ── ledger vs on-hand ───────────────────────────────────────────────────────

test("the opening-balance gap is explained, not hidden and not silently closed", () => {
  // Real numbers from rm-206 on prod: the ledger closes 12,030 short of the
  // lots, which is exactly the opening seed.
  const v = ledgerVsOnHand(11270.75, 23300.75, 12030);
  assert.equal(v.agrees, true);
  assert.ok(v.note, "the gap must be stated even though it is explained");
  assert.match(v.note, /opening balance/i);
  assert.match(v.note, /11270\.75/);
  assert.match(v.note, /23300\.75/);
  // The reported closing balance is NOT quietly bumped to match on-hand.
  assert.equal(v.ledgerClosingQty, 11270.75);
  assert.equal(v.onHandQty, 23300.75);
});

test("an unexplained gap is reported as unreconciled rather than rounded away", () => {
  const v = ledgerVsOnHand(100, 250, 20);
  assert.equal(v.agrees, false);
  assert.match(v.note, /do not reconcile/i);
});

test("no note at all when the ledger already lands on the on-hand figure", () => {
  const v = ledgerVsOnHand(42, 42, 0);
  assert.equal(v.agrees, true);
  assert.equal(v.note, null);
});

test("a null closing balance (WIP) never claims agreement", () => {
  const v = ledgerVsOnHand(null, 1303, 0);
  assert.equal(v.agrees, false);
  assert.equal(v.note, null);
});

// ── FIFO age ────────────────────────────────────────────────────────────────

test("FIFO age is the age of the oldest layer that still has stock", () => {
  const now = new Date("2026-08-08T00:00:00Z");
  const { ageDays: age, date } = fifoAge(
    [
      { date: "2025-07-07T00:00:00Z", qty: 0 }, // exhausted — not next to go
      { date: "2026-01-29T00:00:00Z", qty: 12 },
      { date: "2026-06-01T00:00:00Z", qty: 3 },
    ],
    now,
  );
  assert.equal(date, "2026-01-29T00:00:00Z");
  assert.equal(age, 191);
});

test("a fully consumed material has no FIFO age rather than a stale one", () => {
  const { ageDays: age, date } = fifoAge([{ date: "2025-01-01T00:00:00Z", qty: 0 }]);
  assert.equal(age, null);
  assert.equal(date, null);
});

test("a negative lot (over-issued) is not treated as stock on hand", () => {
  const now = new Date("2026-08-08T00:00:00Z");
  const { date } = fifoAge(
    [
      { date: "2025-07-07T00:00:00Z", qty: -3.6 },
      { date: "2026-01-29T00:00:00Z", qty: 12 },
    ],
    now,
  );
  assert.equal(date, "2026-01-29T00:00:00Z");
});

// ── finished goods: an uncosted piece renders, it does not read as free ─────

test("a piece with no cost layer and no posted completion has NO cost, not zero", () => {
  // fg_units.batchId is NULL on all 4,866 rows on prod, and only 61 of the 262
  // pieces on hand have an FG completion posted for their production order.
  // Zero is a cost — a free sofa is a different claim from an uncosted one.
  assert.equal(fgUnitCostSen(null, null), null);
  assert.equal(fgUnitCostSen(undefined, undefined), null);
  // A genuine zero is preserved, and must not be mistaken for "unknown".
  assert.equal(fgUnitCostSen(0, 4836), 0);
});

test("a piece's own cost layer wins over its production order's completion", () => {
  // Today the first argument is always null; the moment the write side stamps
  // fg_units.batchId it takes over with no further change.
  assert.equal(fgUnitCostSen(13073, 4836), 13073);
  assert.equal(fgUnitCostSen(null, 4836), 4836);
});

test("a partial valuation says how partial it is", () => {
  const note = valuationNote(18, 30);
  assert.ok(note);
  assert.match(note, /18 of 30/);
  assert.match(note, /batchId is unset/);
  // Fully priced, or nothing on hand — nothing to apologise for.
  assert.equal(valuationNote(30, 30), null);
  assert.equal(valuationNote(0, 0), null);
});

test("finished goods say out loud that they are counted in pieces", () => {
  const note = piecesNote(30, 10);
  assert.ok(note);
  assert.match(note, /30 piece\(s\) = 10 sellable unit\(s\)/);
  assert.equal(piecesNote(0, 0), null);
});

test("the FG ledger gap is explained by the unit-of-measure mismatch, not hidden", () => {
  // prod-40 on prod: the ledger closes at 308 while 30 pieces sit on the shelf.
  // The legs count different things — completions book units, deliveries book
  // one row per FIFO slice.
  const v = ledgerVsOnHand(
    308,
    30,
    0,
    "The two legs of the finished-goods ledger do not count the same thing.",
  );
  assert.equal(v.agrees, false);
  assert.match(v.note, /do not reconcile/i);
  assert.match(v.note, /do not count the same thing/i);
});

test("the explanation is only appended when the figures actually disagree", () => {
  // An explanation attached to agreeing numbers would imply a problem that is
  // not there, which is its own kind of dishonesty.
  const v = ledgerVsOnHand(42, 42, 0, "some explanation");
  assert.equal(v.agrees, true);
  assert.equal(v.note, null);
});

test("a delivery order is a real, openable link", () => {
  assert.equal(sourceDocHref("DELIVERY_ORDER", "do-79c141d3"), "/delivery/do-79c141d3");
  assert.equal(sourceDocHref("DELIVERY_ORDER", null), null);
});

test("ageDays refuses to invent a number from a missing or broken date", () => {
  assert.equal(ageDays(null), null);
  assert.equal(ageDays(""), null);
  assert.equal(ageDays("not a date"), null);
  assert.equal(ageDays("2026-08-09T00:00:00Z", new Date("2026-08-08T00:00:00Z")), 0);
});
