import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const { labourInjectMonths } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/labour-inject.ts")).href
);

const S = (...yms) => new Set(yms);

test("labourInjectMonths — clamps to opening month and today", () => {
  assert.deepEqual(
    labourInjectMonths({ startYm: "2025-09", endYm: "2026-12", openingYm: "2026-05", nowYm: "2026-08", recordedYms: S() }),
    ["2026-05", "2026-06", "2026-07", "2026-08"],
  );
});

test("labourInjectMonths — a recorded month is skipped (post OR manual JV)", () => {
  assert.deepEqual(
    labourInjectMonths({ startYm: "2026-05", endYm: "2026-08", openingYm: "2026-05", nowYm: "2026-08", recordedYms: S("2026-06", "2026-07") }),
    ["2026-05", "2026-08"],
  );
});

test("labourInjectMonths — single-month window, unbounded window, no opening", () => {
  assert.deepEqual(
    labourInjectMonths({ startYm: "2026-08", endYm: "2026-08", openingYm: "2026-05", nowYm: "2026-08", recordedYms: S() }),
    ["2026-08"],
  );
  assert.deepEqual(
    labourInjectMonths({ startYm: null, endYm: null, openingYm: "2026-07", nowYm: "2026-08", recordedYms: S() }),
    ["2026-07", "2026-08"],
  );
  assert.deepEqual(
    labourInjectMonths({ startYm: "2026-01", endYm: "2026-08", openingYm: null, nowYm: "2026-08", recordedYms: S() }),
    [],
  );
});

test("labourInjectMonths — window entirely before opening or after now", () => {
  assert.deepEqual(
    labourInjectMonths({ startYm: "2026-01", endYm: "2026-04", openingYm: "2026-05", nowYm: "2026-08", recordedYms: S() }),
    [],
  );
  assert.deepEqual(
    labourInjectMonths({ startYm: "2026-09", endYm: "2026-12", openingYm: "2026-05", nowYm: "2026-08", recordedYms: S() }),
    [],
  );
});

test("labourInjectMonths — year boundary iterates correctly", () => {
  assert.deepEqual(
    labourInjectMonths({ startYm: "2026-11", endYm: "2027-02", openingYm: "2026-05", nowYm: "2027-02", recordedYms: S("2026-12") }),
    ["2026-11", "2027-01", "2027-02"],
  );
});
