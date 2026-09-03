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

// The walk moved into computeBankRecoReport (shared by the report AND the
// finalize snapshot) — the guards follow it there.
function walkBody() {
  const start = src.indexOf("async function computeBankRecoReport(");
  assert.notEqual(start, -1, "computeBankRecoReport not found");
  const end = src.indexOf("\napp.", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("report walk keeps opening legs in glSen but out of the uncleared list", () => {
  const body = walkBody();
  // glSen accumulates BEFORE the uncleared guard…
  assert.match(body, /glSen \+= amt;/);
  // …and the uncleared line carries BOTH conditions.
  assert.match(body, /!matchedIds\.has\(l\.id\) && !isOpeningSource\(l\.sourceType\)/);
});

// ---------------------------------------------------------------------------
// BUG-2026-09-02-174 — the statement-side mirror of the same idea: bank lines
// dated BEFORE the opening date are already inside the keyed opening balance.
// They must not be matchable (a match pairs a pre-boundary bank movement with
// a post-boundary book leg = double count), must not count as unbooked, and a
// stored match on one is void for the report. Found on the owner's first
// opening-month (May) session: he had to hand-ignore 23 pre-opening lines,
// 4 got matched, and "Out by −6,948.84" was exactly those two distortions.
// ---------------------------------------------------------------------------

test("match refuses a pre-opening statement line", () => {
  const body = handler('app.post("/bank-reco/match", async (c) => {');
  assert.match(body, /line\.txnDate < obDateM/);
  assert.match(body, /already inside the opening balance/);
});

test("automatch never offers a pre-opening statement line", () => {
  const body = handler('app.post("/bank-reco/automatch", async (c) => {');
  assert.match(body, /matchableLines = \(lineRes\.results \?\? \[\]\)\.filter\(\(l\) => !obDateAm \|\| l\.txnDate >= obDateAm\)/);
  assert.doesNotMatch(body, /for \(const line of lineRes\.results/);
});

test("shared loader voids pre-opening matches; report floors unbooked at the opening date", () => {
  // The alias/floor/void rules live ONCE in loadBankRecoState (report,
  // finalise snapshot and cash position all consume it).
  const start = src.indexOf("async function loadBankRecoState(");
  assert.notEqual(start, -1, "loadBankRecoState not found");
  const loader = src.slice(start, src.indexOf("async function computeBankRecoReport("));
  assert.match(loader, /if \(!openingDate \|\| r\.txnDate >= openingDate\) clearedOn\.set/);
  assert.match(loader, /legBeforeOpening\(l\.sourceType, l\.day, openingDate\)/);
  assert.match(walkBody(), /if \(obDateRp && r\.txnDate < obDateRp\) continue;/);
});

test("cash position rides the shared loader and skips opening legs as pending", () => {
  const start = src.indexOf('app.get("/cash-position", async (c) => {');
  assert.notEqual(start, -1, "cash-position route not found");
  const body = src.slice(start, src.indexOf("\napp.", start + 1));
  assert.match(body, /loadBankRecoState\(/);
  assert.match(body, /isOpeningSource\(l\.sourceType\)/);
  // Book-only accounts (no imported statements) must not treat legs as pending.
  assert.match(body, /if \(!reconciled\) continue;/);
  // A real statement match ALWAYS beats a board tick, and a tick on a month
  // whose statement showed no such transaction must raise a warning.
  assert.match(body, /const clearedByTick = !clearedByMatch && /);
  assert.match(body, /importedMonths\.has\(l\.day\.slice\(0, 7\)\)/);
  // The repay/receive panels must reuse the AGING inclusion rules, not fork them.
  assert.match(body, /apRowBeforeOpening\(/);
  assert.match(body, /rowBeforeOpening\(/);
});

test("GET /bank-reco only flags legs matched by post-opening lines", () => {
  const body = handler('app.get("/bank-reco", async (c) => {');
  assert.match(body, /if \(!obDateBr \|\| r\.txnDate >= obDateBr\) matchedLegIds\.add/);
});

// BUG-2026-09-02-175 — a void claim (match stored on a pre-opening line) is
// invisible to every read but still occupied the leg in the WRITE path: the
// owner's first manual match after the 174 fix bounced with "already matched".
// Both write paths sweep the account's void claims before acting.
const SWEEP = /UPDATE bank_statement_lines SET matchedLegId = NULL, matchedAt = NULL WHERE accountCode = \? AND matchedLegId IS NOT NULL AND txnDate < \?/;

test("manual match sweeps void pre-opening claims before the taken check", () => {
  const body = handler('app.post("/bank-reco/match", async (c) => {');
  assert.match(body, SWEEP);
  // The sweep must run BEFORE the taken check reads the table.
  assert.ok(body.search(SWEEP) < body.indexOf("already matched to another statement line"));
});

test("automatch sweeps void pre-opening claims before reading state", () => {
  const body = handler('app.post("/bank-reco/automatch", async (c) => {');
  assert.match(body, SWEEP);
  assert.ok(body.search(SWEEP) < body.indexOf("Promise.all"));
});
