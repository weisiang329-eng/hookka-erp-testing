// ---------------------------------------------------------------------------
// parseMoneyInput / parseMoneyToSen
//
// The bug this exists to stop (measured on prod code 2026-08-13): every one of
// the accounting page's 119 money inputs is `type="text"`, so a comma is
// accepted, and each fed `parseFloat` — which silently returns 12 for "12,000".
// A fixed asset typed as 12,000 was CREATED at RM 12.00 and depreciated off it.
//
// The contract under test is not "handle commas". It is: NEVER return a number
// the user did not type. Unreadable input must come back null so the caller can
// show an error — a plausible-but-wrong number is the whole failure mode.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The source is TS; strip the types rather than add a build step for one file.
const SRC = readFileSync("src/lib/parse-money.ts", "utf8");
const js = SRC.replace(/export function/g, "function")
  .replace(/: string \| null \| undefined/g, "")
  .replace(/: number \| null/g, "")
  .replace(/^import .*$/gm, "");
const mod = new Function(`${js}; return { parseMoneyInput, parseMoneyToSen };`)();
const { parseMoneyInput, parseMoneyToSen } = mod;

test("the exact bug: a grouped thousand is not truncated", () => {
  assert.equal(parseFloat("12,000"), 12, "sanity: this is what the old code did");
  assert.equal(parseMoneyInput("12,000"), 12000);
  assert.equal(parseMoneyInput("1,200"), 1200);
  assert.equal(parseMoneyInput("1,234,567.89"), 1234567.89);
  assert.equal(parseMoneyToSen("12,000"), 1200000);
});

test("plain and decimal values are unchanged", () => {
  assert.equal(parseMoneyInput("12000"), 12000);
  assert.equal(parseMoneyInput("0"), 0);
  assert.equal(parseMoneyInput("0.50"), 0.5);
  assert.equal(parseMoneyInput("  25.5  "), 25.5);
  assert.equal(parseMoneyToSen("25.5"), 2550);
  assert.equal(parseMoneyToSen("0.005"), 1, "rounds to the nearest sen");
});

test("accounting negatives", () => {
  assert.equal(parseMoneyInput("(1,200)"), -1200);
  assert.equal(parseMoneyInput("-1,200"), -1200);
  assert.equal(parseMoneyInput("(1,200)"), parseMoneyInput("-1200"));
  assert.equal(parseMoneyToSen("(0.50)"), -50);
});

test("currency prefix and alternate grouping characters", () => {
  assert.equal(parseMoneyInput("RM 12,000"), 12000);
  assert.equal(parseMoneyInput("myr 5.25"), 5.25);
  assert.equal(parseMoneyInput("12 000"), 12000, "space-grouped");
  assert.equal(parseMoneyInput("12'000"), 12000, "apostrophe-grouped");
});

test("UNREADABLE INPUT RETURNS null — never a guess", () => {
  for (const bad of ["", "   ", "abc", "12abc", "1.2.3", ".", "-", "RM", "1,2,3.4.5", "12,000.50.1"]) {
    assert.equal(parseMoneyInput(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
  assert.equal(parseMoneyInput(null), null);
  assert.equal(parseMoneyInput(undefined), null);
  assert.equal(parseMoneyToSen("abc"), null);
});

test("European grouping is REFUSED, not guessed", () => {
  // "12.000,50" is twelve-thousand-and-fifty-cents in the EU and ambiguous
  // against "12.000" meaning twelve. Picking either would book a number the
  // user never typed — the exact failure this module exists to prevent.
  assert.equal(parseMoneyInput("12.000,50"), null);
});

test("null is distinguishable from zero", () => {
  // A caller that does `parseMoneyToSen(x) || 0` reintroduces the bug in a new
  // shape: unreadable input silently books RM 0.00. The two must not collapse.
  assert.equal(parseMoneyToSen("0"), 0);
  assert.equal(parseMoneyToSen("oops"), null);
  assert.notEqual(parseMoneyToSen("oops"), 0);
});
