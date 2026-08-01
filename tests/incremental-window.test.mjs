// Growth rule for "show more as you scroll" (src/lib/incremental-window.ts).
//
// Guards the two ways an incremental list goes wrong: an observer that fires
// twice in the same frame walking the count backwards or past the end, and a
// bad step that stalls the list so the reader can never reach the last item.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const iw = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/incremental-window.ts")).href
);

test("nextIncrementalCount — a normal step adds exactly one step", () => {
  assert.equal(iw.nextIncrementalCount(40, 40, 300), 80);
});

test("nextIncrementalCount — never overshoots the list", () => {
  assert.equal(iw.nextIncrementalCount(280, 40, 300), 300);
  assert.equal(iw.nextIncrementalCount(300, 40, 300), 300);
});

test("nextIncrementalCount — a count past the end clamps instead of growing", () => {
  // The list shrank under us (a filter narrowed 300 threads to 12) while the
  // observer was still queued.
  assert.equal(iw.nextIncrementalCount(280, 40, 12), 12);
});

test("nextIncrementalCount — an empty list renders nothing", () => {
  assert.equal(iw.nextIncrementalCount(40, 40, 0), 0);
  assert.equal(iw.nextIncrementalCount(0, 40, 0), 0);
});

test("nextIncrementalCount — a zero or negative step still advances", () => {
  // Otherwise the sentinel stays on screen, fires again, and the reader can
  // never reach the end of the list.
  assert.equal(iw.nextIncrementalCount(40, 0, 300), 41);
  assert.equal(iw.nextIncrementalCount(40, -5, 300), 41);
});

test("nextIncrementalCount — a negative current starts from zero, not below it", () => {
  assert.equal(iw.nextIncrementalCount(-10, 40, 300), 40);
});

test("nextIncrementalCount — repeated calls always reach the end and stop", () => {
  let c = 40;
  for (let i = 0; i < 100; i++) c = iw.nextIncrementalCount(c, 40, 300);
  assert.equal(c, 300, "must converge on the full list");
  assert.equal(iw.nextIncrementalCount(c, 40, 300), 300, "and stay there");
});

test("optionSliceCount — a fresh dropdown renders one page, not the whole list", () => {
  assert.equal(iw.optionSliceCount(360, 60, 0, 15), 60);
});

test("optionSliceCount — the slice stays ahead of the keyboard highlight", () => {
  // Holding ArrowDown walks the highlight through the FULL filtered list. If
  // the slice does not follow, scrollIntoView finds nothing and the selection
  // appears to freeze while Enter still commits an unseen option.
  assert.equal(iw.optionSliceCount(360, 60, 100, 15), 115);
  assert.ok(iw.optionSliceCount(360, 60, 200, 15) > 200, "highlight must be rendered");
});

test("optionSliceCount — never renders more than the list holds", () => {
  assert.equal(iw.optionSliceCount(12, 60, 0, 15), 12);
  assert.equal(iw.optionSliceCount(360, 60, 359, 15), 360);
});

test("optionSliceCount — an empty list renders nothing", () => {
  assert.equal(iw.optionSliceCount(0, 60, 0, 15), 0);
});
