import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/inventory-opening.ts")).href);

// ---------------------------------------------------------------------------
// buildInventoryOpeningSeed — folds inventory_opening rows into {wip,fg,asOf}.
// Reads value_sen / as_of_date dual-keyed (the PG adapter camelCases result
// columns → valueSen / asOfDate). See BUG-2026-06-30-001.
// ---------------------------------------------------------------------------
test("buildInventoryOpeningSeed — reads camelCase valueSen, sums by layer", () => {
  const seed = m.buildInventoryOpeningSeed([
    { layer: "WIP", valueSen: 1016170, asOfDate: "2026-04-30" },
    { layer: "FG", valueSen: 648673, asOfDate: "2026-04-30" },
  ]);
  assert.equal(seed.wipSen, 1016170);
  assert.equal(seed.fgSen, 648673);
  assert.equal(seed.asOfDate, "2026-04-30");
});

test("buildInventoryOpeningSeed — tolerates snake_case value_sen / as_of_date", () => {
  const seed = m.buildInventoryOpeningSeed([
    { layer: "WIP", value_sen: 100, as_of_date: "2026-04-30" },
    { layer: "FG", value_sen: 200, as_of_date: "2026-04-30" },
  ]);
  assert.equal(seed.wipSen, 100);
  assert.equal(seed.fgSen, 200);
  assert.equal(seed.asOfDate, "2026-04-30");
});

test("buildInventoryOpeningSeed — empty rows → zero seed, null date", () => {
  const seed = m.buildInventoryOpeningSeed([]);
  assert.equal(seed.wipSen, 0);
  assert.equal(seed.fgSen, 0);
  assert.equal(seed.asOfDate, null);
});

// ---------------------------------------------------------------------------
// applyOpeningSeed — adds the seed at the cutover month (asOfDate's YYYY-MM),
// so it becomes the NEXT month's opening (window opening = prior month-end).
// ---------------------------------------------------------------------------
test("applyOpeningSeed — lands on the cutover month, leaves later months alone", () => {
  const byYm = new Map([["2026-04", 0], ["2026-05", 5000]]);
  m.applyOpeningSeed(byYm, 648673, "2026-04-30");
  assert.equal(byYm.get("2026-04"), 648673, "seed on cutover month → becomes May opening");
  assert.equal(byYm.get("2026-05"), 5000, "later months untouched (no seed in May closing)");
});

test("applyOpeningSeed — adds onto an existing system value at the cutover month", () => {
  const byYm = new Map([["2026-04", 1000]]);
  m.applyOpeningSeed(byYm, 500, "2026-04-30");
  assert.equal(byYm.get("2026-04"), 1500, "system value + seed");
});

test("applyOpeningSeed — seeds a month absent from the map", () => {
  const byYm = new Map();
  m.applyOpeningSeed(byYm, 700, "2026-04-30");
  assert.equal(byYm.get("2026-04"), 700);
});

test("applyOpeningSeed — no-op for zero seed or missing/invalid date", () => {
  const a = new Map([["2026-04", 10]]);
  m.applyOpeningSeed(a, 0, "2026-04-30");
  assert.equal(a.get("2026-04"), 10, "zero seed → no change");

  const b = new Map([["2026-04", 10]]);
  m.applyOpeningSeed(b, 500, null);
  assert.equal(b.get("2026-04"), 10, "null date → no change");

  const c = new Map([["2026-04", 10]]);
  m.applyOpeningSeed(c, 500, "not-a-date");
  assert.equal(c.get("2026-04"), 10, "invalid date → no change");
});
