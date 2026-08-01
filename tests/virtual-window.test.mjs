// Row-windowing arithmetic (src/lib/virtual-window.ts).
//
// These guard the two bugs that made the accounting tables render 1,798 rows
// to show 8, and that made <DataGrid> leave a giant blank gap under a
// filtered table: stale indices emitted against a previous count, and a total
// height read from a lagging getTotalSize().
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const vw = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/virtual-window.ts")).href
);

const ROW = 26;
// Build the virtual items tanstack would emit for a contiguous run.
const run = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    index: from + i,
    start: (from + i) * ROW,
    end: (from + i + 1) * ROW,
  }));

test("computeWindow — a window in the middle pads both sides to the full height", () => {
  const r = vw.computeWindow(1798, ROW, run(100, 139));
  assert.deepEqual(r.indices[0], 100);
  assert.deepEqual(r.indices.at(-1), 139);
  assert.equal(r.paddingTop, 100 * ROW);
  // Everything below the last rendered row must still be reserved, or the
  // scrollbar shrinks and the user cannot reach the bottom of the ledger.
  assert.equal(r.paddingBottom, 1798 * ROW - 140 * ROW);
  // The three pieces must add up to exactly the un-virtualised height.
  assert.equal(r.paddingTop + r.indices.length * ROW + r.paddingBottom, 1798 * ROW);
});

test("computeWindow — top of the list has no leading spacer", () => {
  const r = vw.computeWindow(1798, ROW, run(0, 20));
  assert.equal(r.paddingTop, 0);
  assert.equal(r.paddingBottom, 1798 * ROW - 21 * ROW);
});

test("computeWindow — bottom of the list has no trailing spacer", () => {
  const r = vw.computeWindow(500, ROW, run(480, 499));
  assert.equal(r.paddingBottom, 0);
  assert.equal(r.paddingTop, 480 * ROW);
});

test("computeWindow — stale indices past the new count are dropped", () => {
  // The filter narrowed 1,798 rows to 3 while the virtualizer still holds
  // items measured against 1,798. Rendering index 900 would pull a row that
  // no longer exists in the filtered data.
  const stale = [...run(0, 2), ...run(900, 910)];
  const r = vw.computeWindow(3, ROW, stale);
  assert.deepEqual(r.indices, [0, 1, 2]);
  assert.equal(r.paddingBottom, 0, "3 rows of 3 rendered — nothing left to reserve");
});

test("computeWindow — padding never derives from the stale, larger total", () => {
  // Same sharp drop, with the virtualizer's stale measurements still present:
  // a total height inferred from what it emitted (911 rows) instead of from
  // `count` would leave ~23,000px of blank space under the 3 real rows.
  const r = vw.computeWindow(3, ROW, [...run(0, 2), ...run(900, 910)]);
  assert.equal(r.paddingTop + r.indices.length * ROW + r.paddingBottom, 3 * ROW);
  assert.ok(r.paddingBottom < ROW, `expected no blank gap, got ${r.paddingBottom}px`);
});

test("computeWindow — negative indices are dropped", () => {
  const r = vw.computeWindow(10, ROW, [{ index: -1, start: -ROW, end: 0 }, ...run(0, 1)]);
  assert.deepEqual(r.indices, [0, 1]);
  assert.equal(r.paddingTop, 0);
});

test("computeWindow — no items, empty count, or zero row height render nothing", () => {
  assert.deepEqual(vw.computeWindow(1798, ROW, []).indices, []);
  assert.deepEqual(vw.computeWindow(0, ROW, run(0, 5)).indices, []);
  assert.deepEqual(vw.computeWindow(10, 0, run(0, 5)).indices, []);
});

test("firstScreenWindow — paints a screenful and reserves the rest", () => {
  const r = vw.firstScreenWindow(1798, ROW, 30);
  assert.equal(r.indices.length, 30);
  assert.equal(r.indices[0], 0);
  assert.equal(r.paddingTop, 0);
  assert.equal(r.paddingBottom, (1798 - 30) * ROW);
  assert.equal(r.paddingTop + r.indices.length * ROW + r.paddingBottom, 1798 * ROW);
});

test("firstScreenWindow — a table shorter than one screen reserves nothing", () => {
  const r = vw.firstScreenWindow(12, ROW, 30);
  assert.equal(r.indices.length, 12);
  assert.equal(r.paddingBottom, 0);
});
