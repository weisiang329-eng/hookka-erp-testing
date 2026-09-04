// ---------------------------------------------------------------------------
// bank-reco-finalize.test.mjs — a finalised month is frozen, everywhere.
//
// Owner 2026-09-02:「照理说我 match 完了就要 save 起来，不会因为往后加新的
// 东西就乱了」. Finalising snapshots the report + outstanding lists to kv
// (bank_reco_final:<account>:<month>) and every statement-line write path
// must refuse lines of a finalised month. The live report shows the SAVED
// record and flags drift instead of silently recomputing history.
//
// Source-scan guards in the house style: a deleted guard fails loudly here.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const src = readFileSync("src/api/routes/accounting.ts", "utf8");

function handler(route) {
  const start = src.indexOf(route);
  assert.notEqual(start, -1, `route ${route} not found`);
  const end = src.indexOf("\napp.", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("finalize endpoint exists and snapshots via the SHARED walk", () => {
  const body = handler('app.post("/bank-reco/finalize", async (c) => {');
  assert.match(body, /computeBankRecoReport\(/);
  assert.match(body, /bank_reco_final:\$\{account\}:\$\{month\}/);
  assert.match(body, /reopen/);
});

test("there is exactly ONE reconciliation walk, used by report AND finalize", () => {
  // A duplicated mirror of this loop is the recurring bug class in this repo.
  const defs = src.match(/async function computeBankRecoReport\(/g) ?? [];
  assert.equal(defs.length, 1);
  const calls = src.match(/await computeBankRecoReport\(/g) ?? [];
  assert.ok(calls.length >= 2, `expected report + finalize to call the walk, saw ${calls.length}`);
});

test("the live report carries the saved snapshot for the UI", () => {
  const body = handler('app.get("/bank-reco/report", async (c) => {');
  assert.match(body, /bank_reco_final:\$\{account\}:\$\{month\}/);
  assert.match(body, /final/);
});

for (const [route, name] of [
  ['app.post("/bank-reco/match", async (c) => {', "manual match"],
  ['app.post("/bank-reco/unmatch", async (c) => {', "unmatch"],
  ['app.post("/bank-reco/ignore", async (c) => {', "ignore"],
  ['app.delete("/bank-reco/line/:id", async (c) => {', "line delete"],
  ['app.post("/bank-reco/import-session", async (c) => {', "import-session"],
]) {
  test(`${name} refuses a finalised month`, () => {
    const body = handler(route);
    assert.match(body, /bankRecoMonthFinalized\(/);
    assert.match(body, /BANK_RECO_FINALIZED_ERR/);
  });
}
