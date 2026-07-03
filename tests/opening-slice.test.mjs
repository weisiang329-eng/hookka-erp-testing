import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOpeningSlice, windowCoversMonth } from "../src/lib/opening-slice.ts";

const isPnl = (code) => code.startsWith("5") || code.startsWith("7") || code.startsWith("9");

test("applyOpeningSlice — opening minus prior-cum lands in net", () => {
  const net = new Map([["701-0010", 100]]);
  const openingNet = new Map([["701-0010", 2303856]]); // cumulative DR to 21/05
  const priorCum = { "701-0010": 1062006 }; // April TB
  applyOpeningSlice(net, openingNet, priorCum, isPnl);
  assert.equal(net.get("701-0010"), 100 + (2303856 - 1062006)); // May slice on top of real May legs
});

test("applyOpeningSlice — account missing from prior-cum → whole opening is the slice", () => {
  const net = new Map();
  const openingNet = new Map([["500-0000", -14880300]]); // sales CR (April sales = 0)
  applyOpeningSlice(net, openingNet, {}, isPnl);
  assert.equal(net.get("500-0000"), -14880300);
});

test("applyOpeningSlice — opening equals prior-cum → zero slice, no row created", () => {
  const net = new Map();
  const openingNet = new Map([["704-0030", 2800]]);
  applyOpeningSlice(net, openingNet, { "704-0030": 2800 }, isPnl);
  assert.equal(net.has("704-0030"), false);
});

test("applyOpeningSlice — non-P&L accounts are skipped entirely", () => {
  const net = new Map();
  const openingNet = new Map([
    ["310-0010", 160000], // bank
    ["400-0000", -16058081], // creditors control
    ["705-0020", 903445],
  ]);
  applyOpeningSlice(net, openingNet, {}, isPnl);
  assert.equal(net.has("310-0010"), false);
  assert.equal(net.has("400-0000"), false);
  assert.equal(net.get("705-0020"), 903445);
});

test("applyOpeningSlice — re-posted opening nets reversal against re-post", () => {
  // Caller nets opening_balance + opening_balance_reversal into openingNet;
  // simulate: old post 100, reversal −100, new post 120 → net 120.
  const openingNet = new Map([["701-0030", 100 - 100 + 120]]);
  const net = new Map();
  applyOpeningSlice(net, openingNet, { "701-0030": 20 }, isPnl);
  assert.equal(net.get("701-0030"), 100);
});

test("applyOpeningSlice — prior-cum larger than opening still applies (negative slice)", () => {
  // Guards against silent sign errors: engine must surface the anomaly, not hide it.
  const net = new Map();
  const openingNet = new Map([["705-0020", 500]]);
  applyOpeningSlice(net, openingNet, { "705-0020": 800 }, isPnl);
  assert.equal(net.get("705-0020"), -300);
});

test("windowCoversMonth — inclusive bounds, open sides, null month", () => {
  assert.equal(windowCoversMonth("2026-05", "2026-05", "2026-05"), true);
  assert.equal(windowCoversMonth("2026-06", "2026-06", "2026-05"), false);
  assert.equal(windowCoversMonth("2025-09", "2026-08", "2026-05"), true); // FY window
  assert.equal(windowCoversMonth(null, "2026-05", "2026-05"), true);
  assert.equal(windowCoversMonth("2026-05", null, "2026-05"), true);
  assert.equal(windowCoversMonth(null, null, null), false); // no opening date → never
  assert.equal(windowCoversMonth("2026-04", "2026-04", "2026-05"), false);
});
