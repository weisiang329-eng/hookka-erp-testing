import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apRowBeforeOpening,
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

// --- apRowBeforeOpening: mid-year default-include rule (owner 2026-07-02) ---
// Pre-opening PIs count as opening BY DEFAULT; only excluded ids are floored.

const EXCL = new Set(['pi-bad1', 'pi-bad2']);

test('apRowBeforeOpening — pre-opening + NOT excluded → kept (counted as opening)', () => {
  assert.equal(apRowBeforeOpening({ id: 'pi-keep', date: '2026-05-05', isOpening: 0 }, OPEN, EXCL), false);
});

test('apRowBeforeOpening — pre-opening + excluded → floored (hidden)', () => {
  assert.equal(apRowBeforeOpening({ id: 'pi-bad1', date: '2026-05-21', isOpening: 0 }, OPEN, EXCL), true);
});

test('apRowBeforeOpening — explicit opening seed never floored, even if excluded by mistake', () => {
  assert.equal(apRowBeforeOpening({ id: 'pi-bad1', date: '2026-05-21', isOpening: 1 }, OPEN, EXCL), false);
});

test('apRowBeforeOpening — post-opening rows never floored, excluded or not', () => {
  assert.equal(apRowBeforeOpening({ id: 'pi-bad2', date: '2026-06-10', isOpening: 0 }, OPEN, EXCL), false);
  assert.equal(apRowBeforeOpening({ id: 'pi-new', date: '2026-05-22', isOpening: 0 }, OPEN, EXCL), false);
});

test('apRowBeforeOpening — no opening date → never floored', () => {
  assert.equal(apRowBeforeOpening({ id: 'pi-bad1', date: '2026-05-01', isOpening: 0 }, null, EXCL), false);
});

test('apRowBeforeOpening — null id / missing date handled safely', () => {
  assert.equal(apRowBeforeOpening({ id: null, date: null, isOpening: 0 }, OPEN, EXCL), false);
  assert.equal(apRowBeforeOpening({ id: null, date: '2026-05-01', isOpening: 0 }, OPEN, new Set([''])), true);
});
