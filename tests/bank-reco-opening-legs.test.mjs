// ---------------------------------------------------------------------------
// bank-reco-opening-legs.test.mjs — opening-balance legs are the GL floor,
// never 未达账项.
//
// BUG-2026-09-02-173: the reconciliation report counted unmatched
// opening_balance / opening_balance_reversal legs into unclearedBookSen. They
// also sat in glSen, so they cancelled out of (computedGl − gl) — which made
// "Out by" completely INSENSITIVE to the keyed opening figure: the owner could
// correct the 310-0010 opening and the report would not move one sen. The
// same legs were offered as match candidates, where an opening leg's amount
// (e.g. RM 1,600.00) could be amount-grabbed by a real statement line within
// ±7 days of the opening date.
//
// The fix excludes opening-family legs (via the existing isOpeningSource
// helper) from: the GET /bank-reco book list, the automatch candidate pool,
// and the report's uncleared walk — while glSen keeps them. This test pins
// that wiring the way the repo pins other cross-cutting rules: by asserting
// the guard is present in each handler's source. Crude, but a deleted guard
// fails loudly here instead of silently un-fixing the report.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const src = readFileSync("src/api/routes/accounting.ts", "utf8");

/** Slice the handler body between its route registration and the next one. */
function handler(route) {
  const start = src.indexOf(route);
  assert.notEqual(start, -1, `route ${route} not found`);
  const end = src.indexOf("\napp.", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("GET /bank-reco excludes opening legs from the matchable book list", () => {
  const body = handler('app.get("/bank-reco", async (c) => {');
  assert.match(body, /!isOpeningSource\(l\.sourceType\)/);
});

test("automatch never offers an opening leg as a candidate", () => {
  const body = handler('app.post("/bank-reco/automatch", async (c) => {');
  assert.match(body, /!isOpeningSource\(l\.sourceType\)/);
});

test("report keeps opening legs in glSen but out of the uncleared walk", () => {
  const body = handler('app.get("/bank-reco/report", async (c) => {');
  // glSen accumulates BEFORE the uncleared guard…
  assert.match(body, /glSen \+= amt;/);
  // …and the uncleared line carries BOTH conditions.
  assert.match(body, /!matchedIds\.has\(l\.id\) && !isOpeningSource\(l\.sourceType\)/);
});
