import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOpeningSourceType,
  legBeforeOpening,
  rowBeforeOpening,
} from "../src/lib/opening-floor.ts";

const OPEN = "2026-05-22";

test("isOpeningSourceType — only the two opening source types", () => {
  assert.equal(isOpeningSourceType("opening_balance"), true);
  assert.equal(isOpeningSourceType("opening_balance_reversal"), true);
  assert.equal(isOpeningSourceType("invoice"), false);
  assert.equal(isOpeningSourceType(null), false);
  assert.equal(isOpeningSourceType(undefined), false);
});

test("legBeforeOpening — no opening date set → never floored", () => {
  assert.equal(legBeforeOpening("invoice", "2026-05-18T10:00:00Z", null), false);
  assert.equal(legBeforeOpening("invoice", "2026-05-18T10:00:00Z", ""), false);
  assert.equal(legBeforeOpening("invoice", "2026-05-18T10:00:00Z", undefined), false);
});

test("legBeforeOpening — regular leg before opening day → excluded", () => {
  assert.equal(legBeforeOpening("invoice", "2026-05-18T13:47:32Z", OPEN), true);
  assert.equal(legBeforeOpening("payment", "2026-05-21", OPEN), true);
});

test("legBeforeOpening — regular leg ON the opening day → kept (not before)", () => {
  assert.equal(legBeforeOpening("invoice", "2026-05-22T00:00:00Z", OPEN), false);
  assert.equal(legBeforeOpening("invoice", "2026-05-22", OPEN), false);
});

test("legBeforeOpening — regular leg after opening day → kept", () => {
  assert.equal(legBeforeOpening("invoice", "2026-06-01T09:00:00Z", OPEN), false);
});

test("legBeforeOpening — opening legs ALWAYS kept, even dated before", () => {
  assert.equal(legBeforeOpening("opening_balance", "2026-01-01T00:00:00Z", OPEN), false);
  assert.equal(legBeforeOpening("opening_balance_reversal", "2026-01-01", OPEN), false);
});

test("legBeforeOpening — missing postedAt → treated as before (excluded)", () => {
  assert.equal(legBeforeOpening("invoice", null, OPEN), true);
  assert.equal(legBeforeOpening("invoice", undefined, OPEN), true);
});

test("rowBeforeOpening — no opening date → never floored", () => {
  assert.equal(rowBeforeOpening("2026-05-18", null, 0), false);
});

test("rowBeforeOpening — regular row before opening → excluded", () => {
  assert.equal(rowBeforeOpening("2026-05-18", OPEN, 0), true);
  assert.equal(rowBeforeOpening("2026-05-18", OPEN, false), true);
  assert.equal(rowBeforeOpening("2026-05-18", OPEN), true); // payment/CN: no isOpening arg
});

test("rowBeforeOpening — opening-seed invoice ALWAYS kept, even dated before", () => {
  assert.equal(rowBeforeOpening("2026-01-01", OPEN, 1), false);
  assert.equal(rowBeforeOpening("2026-01-01", OPEN, true), false);
});

test("rowBeforeOpening — row ON / after opening day → kept", () => {
  assert.equal(rowBeforeOpening("2026-05-22", OPEN, 0), false);
  assert.equal(rowBeforeOpening("2026-06-01", OPEN, 0), false);
});
