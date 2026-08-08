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

test("an EMPTY WIP ledger still refuses a balance — silence is not a reconciliation", () => {
  // The dangerous case. For every other type, no movements honestly means a
  // balance of zero. For WIP it means the ledger has nothing to say about an
  // item that physically exists, and "0" would be a claim, not an absence.
  const rec = reconciliationOf("WIP", []);
  assert.equal(rec.reconcilable, false);
  assert.ok(rec.notice);
  assert.equal(closingBalance([], rec), null);
  assert.deepEqual(withRunningBalance([], rec), []);
});

test("the WIP notice explains the cause, not just the symptom", () => {
  const { notice } = reconciliationOf("WIP", []);
  // An operator reading this must come away knowing WHY, or they will assume
  // the screen is broken and go looking for the number somewhere else.
  assert.match(notice, /production order/i);
  assert.match(notice, /only ever grow/i);
  assert.match(notice, /physical count/i);
});

test("a WIP movement links to its department board through its job card", () => {
  // WIP rows reference a JOB_CARD, and a job card has no page of its own — the
  // department board it sits on is what actually opens.
  assert.equal(
    sourceDocHref("JOB_CARD", "jc-pord-so-2c538d2d-01-6112", {
      departmentCode: "UPHOLSTERY",
    }),
    "/production/upholstery",
  );
  assert.equal(deptSlug("FAB_SEW"), "fab-sew");
  assert.equal(deptSlug("WOOD_CUT"), "wood-cut");
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
  // fg_units.batchId is still NULL on all 4,866 rows on prod (the backfill has
  // landed but not been run), and only 61 of the 262 pieces on hand have an FG
  // completion posted for their production order.
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
  assert.match(note, /not linked to a cost lot/);
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

// ---------------------------------------------------------------------------
// The drawer's own behaviour — opening it, its sections, and the notices that
// must survive a restyle. Added 2026-08-08 when the panel was reworked to match
// the Houzs Stock Breakdown drawer.
// ---------------------------------------------------------------------------
const {
  fgBreakdownTarget,
  wipBreakdownTarget,
  rmBreakdownTarget,
  toggleBreakdownSection,
  DEFAULT_BREAKDOWN_SECTIONS,
  panelNotices,
  mergeRmReceipts,
  fgProductDetails,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/stock-breakdown.ts")).href
);

const { readFileSync } = await import("node:fs");
const inventoryPageSrc = readFileSync(
  resolve(process.cwd(), "src/pages/inventory/index.tsx"),
  "utf8",
);
const drawerSrc = readFileSync(
  resolve(process.cwd(), "src/pages/inventory/StockBreakdownDrawer.tsx"),
  "utf8",
);
const routeSrc = readFileSync(
  resolve(process.cwd(), "src/api/routes/stock-breakdown.ts"),
  "utf8",
);

test("a row click opens the drawer for THAT row's item, on every tab", () => {
  // The gesture itself: all three grids hand their clicked row to the same
  // deferred opener. Without this the drawer is reachable only from the kebab
  // menu, which is what the owner asked to change.
  assert.equal(
    (inventoryPageSrc.match(/onRowClick=\{\(row\) => openBreakdown\(/g) ?? []).length,
    3,
    "FG, WIP and RM grids must each open the breakdown on a row click",
  );

  // And the row it opens for is its OWN row.
  const fg = fgBreakdownTarget({ id: "prod-40", code: "2050(A)-(K)", name: "ROMA" });
  assert.deepEqual(fg, {
    type: "FG",
    itemId: "prod-40",
    code: "2050(A)-(K)",
    name: "ROMA",
  });
  const other = fgBreakdownTarget({ id: "prod-41", code: "2051(A)-(K)" });
  assert.notEqual(fg.itemId, other.itemId);

  const rm = rmBreakdownTarget({ id: "rm-7", itemCode: "PC151-01", description: "Fabric" });
  assert.deepEqual(rm, { type: "RM", itemId: "rm-7", code: "PC151-01", name: "Fabric" });
});

test("a WIP row opens on its CODE, not the grid's synthetic row id", () => {
  // The grid id is a `wip-dyn-*` key it made up; only the code reaches the
  // ledger (job_cards.wipLabel). Opening on the id would 404 every WIP row.
  const t = wipBreakdownTarget({ wipCode: "FAB_SEW-2050", relatedProduct: "ROMA" });
  assert.equal(t.itemId, "FAB_SEW-2050");
  assert.equal(t.code, "FAB_SEW-2050");
  assert.equal(t.type, "WIP");
});

test("a double-click still edits: the row click is deferred and cancellable", () => {
  // A double-click always delivers its first click to the single-click
  // handler. If the drawer opened immediately, editing a product would leave
  // it open behind the dialog every time.
  assert.match(inventoryPageSrc, /ROW_CLICK_DELAY_MS/);
  assert.equal(
    (inventoryPageSrc.match(/onDoubleClick=\{\(row\) => \{ cancelPendingBreakdown\(\);/g) ?? [])
      .length,
    3,
    "each grid's double-click must cancel the pending breakdown open",
  );
});

test("collapsing one section does not touch the other, and both start open", () => {
  // `pieces` — the finished-goods per-serial list — starts CLOSED: the owner
  // asked for that section to go, and it is kept one click away rather than
  // deleted or reasserted.
  assert.deepEqual(DEFAULT_BREAKDOWN_SECTIONS, {
    movements: true,
    cogs: true,
    pieces: false,
  });

  const closedMovements = toggleBreakdownSection(DEFAULT_BREAKDOWN_SECTIONS, "movements");
  assert.equal(closedMovements.movements, false);
  assert.equal(closedMovements.cogs, true, "closing Movements must leave COGS open");

  const closedBoth = toggleBreakdownSection(closedMovements, "cogs");
  assert.deepEqual(closedBoth, { movements: false, cogs: false, pieces: false });

  // A third section changes nothing about the other two.
  const withPieces = toggleBreakdownSection(closedBoth, "pieces");
  assert.deepEqual(withPieces, { movements: false, cogs: false, pieces: true });

  // Reopening restores it — the state says what is OPEN, it never caches what
  // was rendered, so nothing can be permanently lost by collapsing.
  const reopened = toggleBreakdownSection(closedBoth, "movements");
  assert.equal(reopened.movements, true);
  assert.equal(reopened.cogs, false);
  assert.equal(reopened.pieces, false);
  assert.deepEqual(
    toggleBreakdownSection(reopened, "movements"),
    closedBoth,
    "toggling twice must return to where it started",
  );
});

test("the reconciliation notices still render when the data disagrees", () => {
  // The restyle must not quietly drop a warning. This is the WIP case: no
  // outbound movements, so no balance, plus a ledger that cannot be squared.
  const rec = reconciliationOf("WIP", [{ direction: "IN" }, { direction: "IN" }]);
  const notices = panelNotices({
    qtyNote: "3 piece(s) = 1 sellable unit(s).",
    reconciliation: rec,
    ledgerVsOnHand: ledgerVsOnHand(308, 30, 0, "The two legs count different things."),
    valuationNote: valuationNote(11, 30),
  });

  const keys = notices.map((n) => n.key);
  assert.deepEqual(keys, ["qty", "reconciliation", "ledger", "valuation"]);
  assert.match(notices[1].text, /Outbound movements are not recorded for WIP/);
  assert.match(notices[2].text, /do not reconcile/i);
  assert.match(notices[3].text, /Only 11 of 30 piece\(s\)/);
  // A disagreement is a WARNING, not a footnote.
  assert.equal(notices[1].tone, "warn");
  assert.equal(notices[2].tone, "warn");
  assert.equal(notices[3].tone, "warn");

  // And the panel renders whatever comes back rather than its own list of
  // hand-written conditionals, which is how one gets dropped in a restyle.
  assert.match(drawerSrc, /panelNotices\(header\)\.map\(/);
});

test("a clean header produces no notices at all", () => {
  // Notices are for real problems. A panel that always shows a warning trains
  // people to ignore warnings.
  const notices = panelNotices({
    qtyNote: null,
    reconciliation: reconciliationOf("RM", [{ direction: "IN" }, { direction: "OUT" }]),
    ledgerVsOnHand: ledgerVsOnHand(42, 42, 0),
    valuationNote: valuationNote(5, 5),
  });
  assert.deepEqual(notices, []);
});

test("no column is rendered that this system has no data for", () => {
  // Hookka has no warehouse dimension: rm_batches has no location column and
  // there is no warehouses table. Houzs leads its lot table with Warehouse; a
  // column of em dashes reads as missing data rather than an absent concept.
  assert.doesNotMatch(drawerSrc, /<th className=\{TH\}>Warehouse<\/th>/);
});

// ---------------------------------------------------------------------------
// RM: the lots and the inbound movements are ONE list (2026-08-08)
//
// They were two sections showing the same GRN receipts — same dates, same
// quantities, same costs — fetched down two different paths. The merge exists
// so there is one list; these tests exist so the merge cannot quietly lose a
// row from either side, which is the only way a merge can be worse than the
// duplication it replaces.
// ---------------------------------------------------------------------------
function lot(id, date, over = {}) {
  return {
    kind: "RM_LOT",
    id,
    warehouse: null,
    attributes: null,
    qty: 10,
    originalQty: 10,
    consumedQty: 0,
    unitCostSen: 500,
    valueSen: 5000,
    source: "GRN",
    grnNo: "GRN-1",
    grnHref: null,
    purchaseOrderNo: null,
    purchaseOrderHref: null,
    supplierName: null,
    receivedDate: date,
    ageDays: null,
    hasLot: true,
    movementId: null,
    balanceAfter: null,
    ...over,
  };
}

test("a lot and the movement that created it become ONE row, carrying the balance", () => {
  const lots = [lot("rmb-grn-a-1", "2026-01-02")];
  const movements = withRunningBalance(
    [mv("2026-01-02", "IN", 10, { batchId: "rmb-grn-a-1" })],
    reconciliationOf("RM", [{ direction: "IN" }]),
  );

  const merged = mergeRmReceipts(lots, movements);
  assert.equal(merged.length, 1, "one receipt is one row, not two");
  assert.equal(merged[0].hasLot, true);
  assert.equal(merged[0].qty, 10, "the FIFO layer's remaining quantity survives");
  assert.equal(merged[0].balanceAfter, 10, "and so does the derived running balance");
  assert.equal(merged[0].movementId, movements[0].id);
});

test("an opening lot with no ledger row survives the merge, with no balance", () => {
  // 278 of 279 materials on prod: the opening stock was seeded straight into
  // rm_batches at cut-over and never entered the cost ledger. Dropping those
  // rows would delete most of the shelf; inventing a balance for them would be
  // worse.
  const lots = [lot("rmb-opening-1", "2025-12-01", { source: "OPENING", qty: 1778, originalQty: 1778 })];
  const merged = mergeRmReceipts(lots, []);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].qty, 1778, "quantities are untouched");
  assert.equal(merged[0].balanceAfter, null, "no ledger row means no balance to state");
  assert.equal(merged[0].movementId, null);
});

test("a ledger receipt whose FIFO layer is gone survives too, with no remaining qty", () => {
  const movements = withRunningBalance(
    [mv("2026-02-01", "IN", 12, { batchId: "rmb-vanished" })],
    reconciliationOf("RM", [{ direction: "IN" }]),
  );
  const merged = mergeRmReceipts([], movements);

  assert.equal(merged.length, 1, "a receipt is never dropped because its lot is not there");
  assert.equal(merged[0].hasLot, false);
  assert.equal(merged[0].originalQty, 12, "what came in is known");
  assert.equal(
    merged[0].qty,
    null,
    "what is LEFT of an absent layer is unknown — null, never zero, which would claim it was consumed",
  );
  assert.equal(
    merged[0].valueSen,
    null,
    "and it contributes nothing to the value subtotal rather than the price it was bought at",
  );
  assert.equal(merged[0].balanceAfter, 12);
});

test("the merge loses nothing from either side and reads oldest first", () => {
  const lots = [
    lot("rmb-grn-b-1", "2026-03-05"),
    lot("rmb-opening-1", "2025-11-01", { source: "OPENING" }),
    lot("rmb-grn-a-1", "2026-01-02"),
  ];
  const movements = withRunningBalance(
    [
      mv("2026-01-02", "IN", 10, { batchId: "rmb-grn-a-1" }),
      mv("2026-03-05", "IN", 10, { batchId: "rmb-grn-b-1" }),
      mv("2026-04-01", "IN", 4, { batchId: "rmb-gone" }),
      mv("2026-04-02", "OUT", 3, { batchId: "rmb-grn-a-1" }),
    ],
    reconciliationOf("RM", [{ direction: "IN" }, { direction: "OUT" }]),
  );

  const merged = mergeRmReceipts(lots, movements);
  // 3 lots + 1 inbound movement with no lot. The OUTBOUND row is not a receipt
  // and belongs to Movements out, so it is not here.
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged.map((r) => r.receivedDate),
    ["2025-11-01", "2026-01-02", "2026-03-05", "2026-04-01"],
    "oldest first — the order the next issue will consume them in",
  );
  assert.equal(merged.filter((r) => r.hasLot).length, 3);
  assert.equal(merged.filter((r) => !r.hasLot).length, 1);
});

test("one movement cannot claim two lots, and a second claim keeps its own row", () => {
  // Two ledger rows against one batch id: the first (oldest) is the receipt
  // that made the lot; the second is still a real ledger row and gets a row of
  // its own rather than overwriting the first or disappearing.
  const lots = [lot("rmb-grn-a-1", "2026-01-02")];
  const movements = withRunningBalance(
    [
      mv("2026-01-02", "IN", 10, { batchId: "rmb-grn-a-1" }),
      mv("2026-01-09", "IN", 2, { batchId: "rmb-grn-a-1" }),
    ],
    reconciliationOf("RM", [{ direction: "IN" }, { direction: "IN" }]),
  );

  const merged = mergeRmReceipts(lots, movements);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].hasLot, true);
  assert.equal(merged[1].hasLot, false);
  assert.equal(merged[1].originalQty, 2);
});

test("the merged RM table is what the panel renders, and the duplicate is gone", () => {
  // One section, and no second inbound table to drift away from it.
  assert.match(drawerSrc, /function RmReceiptsTable\(/);
  assert.doesNotMatch(drawerSrc, /function RmInTable\(/);
  assert.match(drawerSrc, /Receipts & stock lots/);
  // Movements out stays, empty and explained — it is the step that does not
  // exist yet, not a step that failed to record anything.
  assert.match(drawerSrc, /No outbound movements\./);
  assert.match(drawerSrc, /no material-requisition step in the system/i);
});

// ---------------------------------------------------------------------------
// COGS says who used it, and on what
// ---------------------------------------------------------------------------

test("COGS carries the department and the person, and shows an em dash when the ledger has neither", () => {
  // The columns exist for the day a requisition step records them. Rendering
  // them empty is the honest state; omitting them would hide that the ledger
  // does not know.
  assert.match(drawerSrc, /<th className=\{TH\}>Department<\/th>/);
  assert.match(drawerSrc, /<th className=\{TH\}>Consumed by<\/th>/);
  assert.match(drawerSrc, /<Txt value=\{r\.department\} \/>/);
  assert.match(drawerSrc, /value=\{r\.consumedByName\}/);
  // Txt is the one place an absent value renders, and it renders an em dash.
  assert.match(drawerSrc, /function Txt\(\{ value \}/);

  // And the route reads the worker off the ledger rather than guessing at one.
  assert.match(routeSrc, /LEFT JOIN workers w\s+ON w\.id\s+= cl\.workerId/);
  assert.match(routeSrc, /consumedByName: src\?\.workerName \?\? null/);
});

// ---------------------------------------------------------------------------
// FG: two movement tables, no lots section, no COGS (2026-08-08)
// ---------------------------------------------------------------------------

test("the finished-goods panel is two movement tables with the columns asked for", () => {
  assert.match(drawerSrc, /<th className=\{TH\}>Completed by dept<\/th>/);
  assert.match(drawerSrc, /<th className=\{TH\}>Completed by<\/th>/);
  assert.match(drawerSrc, /<th className=\{TH\}>Dispatched<\/th>/);
  // The per-piece list is kept and folded away, not deleted: it is the only
  // per-serial view and the source of the Age and Available · Reserved figures.
  assert.match(drawerSrc, /Pieces on hand \(/);
  assert.match(drawerSrc, /sections\.pieces/);
});

test("'who completed it' is the upholsterer, not the packer", () => {
  // A piece is a finished good the moment it is upholstered; packing happens
  // to something that is already stock. Answering with the packer would answer
  // a different question from the one the column asks.
  assert.match(routeSrc, /u\.upholsteredByName AS "workerName"/);
  assert.doesNotMatch(routeSrc, /u\.packerName/, "the packer is not read at all");
  // And the department is the one that makes a piece finished goods — the same
  // rule deriveFGStock uses, not a hardcoded label on the row.
  assert.match(routeSrc, /j\.departmentCode = 'UPHOLSTERY'/);
});

test("the panel and the grid call the same two numbers by the same name", () => {
  assert.match(drawerSrc, /label="Available · Reserved"/);
  assert.doesNotMatch(drawerSrc, /Assigned · Free/);
  assert.match(inventoryPageSrc, /Available · Reserved/);
});

// ---------------------------------------------------------------------------
// The product's details live in the panel, and editing still works
// ---------------------------------------------------------------------------

test("a catalogued product folds its own details into the panel", () => {
  const details = fgProductDetails({
    id: "prod-40",
    category: "BEDFRAME",
    baseModel: "2050(A)",
    sizeCode: "K",
    sizeLabel: "6FT",
    description: "",
    basePriceSen: 250000,
    price1Sen: null,
    unitM3: 0.69,
    fabricUsage: 6,
    skuCode: "5530-1NA",
    fabricColor: null,
    subAssemblies: [{ code: "X" }],
  });

  const byLabel = Object.fromEntries(details.fields.map((f) => [f.label, f]));
  assert.equal(byLabel["Category"].value, "BEDFRAME");
  assert.equal(byLabel["Size label"].value, "6FT");
  // Money is integer sen and stays integer sen — the panel formats it.
  assert.deepEqual(byLabel["Base price"], {
    label: "Base price",
    kind: "money",
    valueSen: 250000,
  });
  // An absent price is NULL, not 0: zero is a price, and a free bedframe is a
  // different claim from an unpriced one.
  assert.equal(byLabel["Price 1"].valueSen, null);
  assert.equal(byLabel["Description"].value, null, "an empty string is an absent value");
  assert.equal(byLabel["Fabric colour"].value, null);

  // What the panel does NOT show is named rather than silently dropped.
  assert.deepEqual(details.advanced, ["Sub-assemblies"]);

  // Code and name are the panel's title bar; repeating them would be noise.
  assert.equal(byLabel["Code"], undefined);
  assert.equal(byLabel["Name"], undefined);
});

test("an off-catalogue FG row gets no details section rather than a shell of zeros", () => {
  // The FG grid synthesises `fg-dyn-*` rows from finished production orders
  // whose product was never catalogued. Their prices are placeholders nobody
  // entered; rendering them as a product record would present them as facts.
  assert.equal(fgProductDetails({ id: "fg-dyn-2050(A)-(K)", basePriceSen: 0 }), null);
  assert.equal(fgProductDetails(null), null);
});

test("editing a product is still reachable, and from inside the panel", () => {
  // Losing the ability to edit a product would be far worse than a busy panel.
  // The drawer offers it; the page hands it the dialog that has always saved.
  assert.match(drawerSrc, /Edit product/);
  assert.match(inventoryPageSrc, /onEdit=\{/);
  assert.match(inventoryPageSrc, /setReopenBreakdownAfterEdit\(breakdownTarget\)/);
  assert.match(inventoryPageSrc, /Save Product/, "the dialog still saves");
  // And the kebab keeps a direct Edit on the two tabs that can write.
  assert.match(inventoryPageSrc, /\{ label: "Edit", action: \(row: FGItem\)/);
  assert.match(inventoryPageSrc, /\{ label: "Edit", action: \(row: RawMaterial\)/);
});

test("the duplicate Source Production Orders table is gone from the dialog", () => {
  // It listed the production orders that produced this SKU — the same ones the
  // panel's inbound movements list, from a different query. Two lists of one
  // fact eventually disagree.
  assert.doesNotMatch(inventoryPageSrc, /Source Production Orders/);
  assert.doesNotMatch(
    inventoryPageSrc,
    /fetch\(\s*`\/api\/inventory\/fg-source/,
    "and nothing fetches the second list any more",
  );
});

test("the kebab no longer offers a second door to the panel", () => {
  // A row click opens it; "Stock breakdown" as a menu item was a second way in
  // to the thing being opened. "View" went with it on the tabs where it called
  // the same handler as "Edit" — one action wearing two labels.
  assert.doesNotMatch(inventoryPageSrc, /label: "Stock breakdown"/);
  assert.doesNotMatch(inventoryPageSrc, /\{ label: "View", action: \(row: FGItem\)/);
  assert.doesNotMatch(inventoryPageSrc, /\{ label: "View", action: \(row: RawMaterial\)/);
  // WIP keeps View: its dialog shows the grid's own derivation, which is not
  // what the panel's server-side job cards show.
  assert.match(inventoryPageSrc, /\{ label: "View", action: \(row: WIPItem\)/);
  // Delete has no equivalent inside a read-only panel, so it stays.
  assert.match(inventoryPageSrc, /\{ label: "Delete", action: \(row: FGItem\)/);
});
