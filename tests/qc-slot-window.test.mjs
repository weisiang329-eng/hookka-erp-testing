// Which QC slots the Pending tab shows by default (src/lib/qc-slot-window.ts).
//
// The cost of getting this wrong is not cosmetic: hide one day too many and
// the inspector cannot see the checklist they are supposed to be filling in
// right now, while the page still claims everything is fine.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const qs = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/qc-slot-window.ts")).href
);

const g = (day, n = 1) => [`${day}T08:00:00.000Z`, Array.from({ length: n }, (_, i) => ({ i }))];

test("windowStartDay — 7 days is inclusive of both ends, not 8", () => {
  assert.equal(qs.windowStartDay("2026-08-01", 7), "2026-07-26");
  assert.equal(qs.windowStartDay("2026-08-01", 1), "2026-08-01");
  assert.equal(qs.windowStartDay("2026-08-01", 30), "2026-07-03");
});

test("windowStartDay — crosses a month and a leap-year boundary correctly", () => {
  assert.equal(qs.windowStartDay("2026-03-02", 7), "2026-02-24");
  assert.equal(qs.windowStartDay("2024-03-01", 2), "2024-02-29");
});

test("windowStartDay — no window, or an unparseable date, yields no cutoff", () => {
  assert.equal(qs.windowStartDay("2026-08-01", 0), "");
  assert.equal(qs.windowStartDay("not-a-date", 7), "");
});

test("sliceSlotGroups — keeps the window, counts what it hid", () => {
  const groups = [g("2026-08-01", 17), g("2026-07-28", 17), g("2026-05-02", 17), g("2026-04-28", 34)];
  const r = qs.sliceSlotGroups(groups, 7, "2026-08-01");
  assert.deepEqual(r.shown.map((x) => x[0].slice(0, 10)), ["2026-08-01", "2026-07-28"]);
  assert.equal(r.hiddenGroups, 2);
  assert.equal(r.hiddenRows, 51, "the banner must report inspections, not slots");
});

test("sliceSlotGroups — the boundary day itself stays visible", () => {
  // 2026-07-26 is the seventh day back from 2026-08-01 and must NOT be hidden.
  const r = qs.sliceSlotGroups([g("2026-07-26"), g("2026-07-25")], 7, "2026-08-01");
  assert.deepEqual(r.shown.map((x) => x[0].slice(0, 10)), ["2026-07-26"]);
  assert.equal(r.hiddenGroups, 1);
});

test("sliceSlotGroups — 'All slots' hides nothing", () => {
  const groups = [g("2026-08-01"), g("2026-04-28")];
  const r = qs.sliceSlotGroups(groups, 0, "2026-08-01");
  assert.equal(r.shown.length, 2);
  assert.equal(r.hiddenGroups, 0);
  assert.equal(r.hiddenRows, 0);
});

test("sliceSlotGroups — an unscheduled group is never hidden", () => {
  // An inspection with no slot has no date to judge; silently dropping it
  // would lose work nobody can find again.
  const r = qs.sliceSlotGroups([["no-slot", [{ i: 1 }]], g("2026-04-28")], 7, "2026-08-01");
  assert.deepEqual(r.shown.map((x) => x[0]), ["no-slot"]);
  assert.equal(r.hiddenGroups, 1);
});

test("sliceSlotGroups — an unusable reference day shows everything rather than nothing", () => {
  const groups = [g("2026-08-01"), g("2026-04-28")];
  const r = qs.sliceSlotGroups(groups, 7, "");
  assert.equal(r.shown.length, 2, "no reference day must fail open, not blank the page");
});
