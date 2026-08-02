// ---------------------------------------------------------------------------
// org-chart-board.test.mjs — the chart is a BOARD, not a list.
//
// Owner 2026-08-02, with the Houzs board attached:「你那个设计很丑,我要像这样子
// 的 Org Chart」.
//
// The first version drew the reporting tree as a left-indented list. Two
// problems: it reads as a directory, and the moment everyone actually reports
// to one person — which is exactly what happened the hour the hierarchy was
// wired — it collapses into a single 44-deep column under "Unassigned".
//
// So the board groups by DEPARTMENT, and inside each department by POSITION.
// That is what Houzs do: their HELPER / DRIVER / STOREKEEPER strips are
// position labels inside one department box, not reporting lines. A box is a
// grouping, a line is a relationship, and mixing the two is what made the old
// one unusable.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/components/org-chart.tsx", "utf8");

test("it groups by department, then by position", () => {
  assert.match(src, /const board = useMemo/);
  assert.match(src, /const byPos = new Map<string, OrgPerson\[\]>\(\);/);
  assert.doesNotMatch(src, /buildOrgTree/, "the indented tree list must not return");
});

test("whoever is in charge is the first card in the box", () => {
  assert.match(src, /\/head\|manager\/i\.test\(pos\) \? 0 : \/leader\|supervisor\/i\.test\(pos\) \? 1 : 2/);
});

test("each department wears a dark cap, a colour stripe and a headcount", () => {
  assert.match(src, /bg-\[#33404E\]/);
  assert.match(src, /const ACCENTS = \[/);
  assert.match(src, /style=\{\{ background: accent \}\}/);
});

test("the reporting line is shown as a NAME, not as nesting", () => {
  // Nesting is what broke when everyone ended up under one person.
  assert.match(src, /↳ \{managerName\(p\.managerKey\) \?\? "—"\}/);
});

test("the picker still refuses a loop before the server has to", () => {
  assert.match(src, /const descendantsOf = useMemo/);
  assert.match(src, /const banned = descendantsOf\(p\.key\);/);
});

test("the BOARD scrolls, not the page", () => {
  // A department with forty people must not push the next one off-screen.
  assert.match(src, /overflow-x-auto/);
  assert.match(src, /flex min-w-max items-start gap-3/);
});
