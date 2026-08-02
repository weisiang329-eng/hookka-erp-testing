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
  // NOT "buildOrgTree must not appear" — the Hierarchy view added later uses it
  // legitimately. What must not return is the LEFT-INDENTED list: a depth-driven
  // marginLeft, which is what turned into one 44-deep column.
  assert.doesNotMatch(
    src,
    /marginLeft: depth/,
    "the depth-indented list must not return",
  );
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

// --- the textbook chart (owner's 4th reference photo) -----------------------

test("there is a real top-down HIERARCHY view, drawn with connectors", () => {
  // Owner:「目前的 UI 很漂亮了,只是要看怎么去做出来第四章照片的层级图」— the
  // Wikipedia "Agency Department System" chart: one box per person, levels
  // stacked, joined by lines. The board can only NAME an upline; it cannot show
  // rank. So both views stay, and neither is a worse version of the other.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /const \[view, setView\] = useState<"tree" \| "board">\("tree"\)/);
  assert.match(src, /const forest = useMemo\(\(\) => buildOrgTree\(visible\), \[visible\]\)/);
  // A stem down from the parent, and a bus across the siblings that stops at
  // the outermost child instead of hanging in air.
  assert.match(src, /h-5 w-px bg-\[#C2BDB6\]/);
  assert.match(src, /left: i === 0 \? "50%" : 0/);
  assert.match(src, /right: i === kids\.length - 1 \? "50%" : 0/);
});

test("a collapsed branch says how many it is hiding", () => {
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /shut \? `\+\$\{countSubtree\(node\) - 1\}` : "–"/);
});

test("the reporting line is editable from the tree too", () => {
  // Otherwise the hierarchy view is read-only and you have to switch back to
  // the board to fix anything you notice in it.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  const branch = src.slice(src.indexOf("const TreeCard ="), src.indexOf("const Branch ="));
  assert.match(branch, /descendantsOf\(node\.key\)/, "and it still refuses a loop");
  assert.match(branch, /void setManager\(node\.key, e\.target\.value\)/);
});

test("a wide branch opens FOLDED, so the root is the first thing you see", () => {
  // A pure top-down chart is as wide as its widest fan-out, and this one has a
  // Production Head with fourteen direct reports — the first paint was a canvas
  // several screens across, opened mid-way, with the root off-screen.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /if \(n\.children\.length > 14\) wide\.add\(n\.key\)/);
  // Once, keyed on the data — it must not re-fold every time the list refreshes
  // and undo what the operator just opened.
  assert.match(src, /const sig = `\$\{forest\.length\}:\$\{visible\.length\}`/);
  assert.match(src, /if \(!forest\.length \|\| autoFolded === sig\) return;/);
  // Folding ADDS to whatever is already collapsed rather than replacing it.
  assert.match(src, /setCollapsed\(\(prev\) => new Set\(\[\.\.\.prev, \.\.\.wide\]\)\)/);
});

test("MANY reports stack in a box — they do not fan out sideways", () => {
  // Owner:「如果很多下线她是怎么排的」— Houzs stop the tree and drop into a box
  // whose cards stack in columns. Fourteen reports fanned horizontally is a
  // canvas several screens wide; the same fourteen stacked is one card tall.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(
    src,
    /kids\.length > 4 && kids\.every\(\(c\) => c\.children\.length === 0\)/,
    "and only when those children lead nobody — a manager keeps their own branch",
  );
  assert.match(src, /gridTemplateColumns: `repeat\(\$\{Math\.min\(4, Math\.ceil\(kids\.length \/ 4\)\)\}/);
  // The classic fan survives for a SMALL number, because that is the shape that
  // reads as an org chart.
  assert.match(src, /left: i === 0 \? "50%" : 0/);
});
