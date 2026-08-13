// Group-windowing arithmetic (src/lib/virtual-group-window.ts).
//
// The /employees Working Hours grid cannot use the flat row windower: its
// Date / Employee / Punch cells are one `<td rowSpan>` per worker-day, so the
// window has to snap to whole groups, and a one-row group is 71px tall while
// a grouped row is 50px. These guard the same two failure modes
// virtual-window.test.mjs guards — stale indices emitted against a previous,
// larger count, and a total height that must come from the caller's own list
// rather than the virtualiser's lagging getTotalSize().
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const vgw = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/virtual-group-window.ts")).href
);

const SOLO = 71;
const SEG = 50;

// 100 groups: every 5th is a two-row (split-department) worker-day.
const heights = Array.from({ length: 100 }, (_, i) => (i % 5 === 4 ? 2 * SEG : SOLO));
const offsets = vgw.groupOffsets(heights);
const TOTAL = heights.reduce((a, b) => a + b, 0);

const items = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i }));

test("groupOffsets — boundaries are cumulative and the last is the total height", () => {
  assert.equal(offsets.length, heights.length + 1);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], SOLO);
  assert.equal(offsets[5], 4 * SOLO + 2 * SEG);
  assert.equal(offsets[heights.length], TOTAL);
});

test("groupOffsets — a negative or non-finite height counts as zero, not as a gap", () => {
  const o = vgw.groupOffsets([10, -5, Number.NaN, 20]);
  assert.deepEqual(o, [0, 10, 10, 10, 30]);
});

test("computeGroupWindow — a window in the middle pads both sides to the full height", () => {
  const r = vgw.computeGroupWindow(offsets, items(20, 29));
  assert.equal(r.start, 20);
  assert.equal(r.end, 29);
  assert.equal(r.paddingTop, offsets[20]);
  assert.equal(r.paddingTop + heightsSum(20, 29) + r.paddingBottom, TOTAL);
});

test("computeGroupWindow — the first window has no top spacer, the last no bottom", () => {
  const head = vgw.computeGroupWindow(offsets, items(0, 9));
  assert.equal(head.paddingTop, 0);
  const tail = vgw.computeGroupWindow(offsets, items(90, 99));
  assert.equal(tail.paddingBottom, 0);
});

test("computeGroupWindow — indices past the count are stale and are dropped", () => {
  // A filter just cut the grid from 100 groups to 12; tanstack can still emit
  // items computed from the previous count in the same render pass.
  const small = vgw.groupOffsets(heights.slice(0, 12));
  const r = vgw.computeGroupWindow(small, items(60, 99));
  assert.equal(r.end, -1, "nothing in the stale window is renderable");
  assert.equal(r.paddingTop, 0);
  assert.equal(r.paddingBottom, 0);
});

test("computeGroupWindow — a window straddling the new count keeps only the live part", () => {
  const small = vgw.groupOffsets(heights.slice(0, 12));
  const r = vgw.computeGroupWindow(small, items(8, 40));
  assert.equal(r.start, 8);
  assert.equal(r.end, 11);
  assert.equal(r.paddingBottom, 0, "the last live group must not leave a gap under it");
});

test("computeGroupWindow — an empty list renders nothing and pads nothing", () => {
  const r = vgw.computeGroupWindow(vgw.groupOffsets([]), items(0, 5));
  assert.equal(r.end, -1);
  assert.equal(r.paddingTop, 0);
  assert.equal(r.paddingBottom, 0);
});

test("firstScreenGroupWindow — renders a screenful from the top and pads the rest", () => {
  const r = vgw.firstScreenGroupWindow(offsets, 18);
  assert.equal(r.start, 0);
  assert.equal(r.end, 17);
  assert.equal(r.paddingTop, 0);
  assert.equal(r.paddingTop + heightsSum(0, 17) + r.paddingBottom, TOTAL);
});

test("firstScreenGroupWindow — a table shorter than a screenful needs no bottom spacer", () => {
  const r = vgw.firstScreenGroupWindow(vgw.groupOffsets([SOLO, SOLO]), 18);
  assert.equal(r.end, 1);
  assert.equal(r.paddingBottom, 0);
});

function heightsSum(from, to) {
  let s = 0;
  for (let i = from; i <= to; i++) s += heights[i];
  return s;
}
