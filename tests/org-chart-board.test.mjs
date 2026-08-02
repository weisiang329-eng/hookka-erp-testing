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
  // The bus now lives on the unified cell row (branches + boxes together),
  // which is why it is keyed on the cell index rather than a sibling index.
  assert.match(src, /left: ci === 0 \? "50%" : 0/);
  assert.match(src, /right: ci === all\.length - 1 \? "50%" : 0/);
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

test("MANY reports stack — the department box IS the stack", () => {
  // Owner:「如果很多下线她是怎么排的」— Houzs stop the tree and drop into a box
  // whose cards stack vertically. Fourteen reports fanned horizontally is a
  // canvas several screens wide.
  //
  // The standalone grid this used to pin is gone, superseded rather than
  // reverted: every non-manager child now lands in a department box, and the
  // box already stacks its members in a column. One mechanism, not two.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /<div className="flex flex-col gap-1\.5">\s*\n\s*\{g\.members\.map/);
  assert.doesNotMatch(src, /gridTemplateColumns/, "the separate grid is gone");
});

// --- the tree becomes department boxes (owner's Houzs reference) ------------

test("below the last manager the tree stops and DEPARTMENT BOXES take over", () => {
  // Owner:「为什么这里没有分部门呢?正常的 HouzsERP 里是有看到部门划分的」.
  // A branch is right where there are a few named relationships; forty
  // operators fanned into hairlines is a wall of string.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /const boxesUnder = useCallback/);
  // Branches and boxes render SIDE BY SIDE at every level — it is not either/or.
  assert.match(src, /const leadsManagers = useCallback/);
  assert.match(src, /\.filter\(leadsManagers\)\s*\n\s*\.map\(\(c\) => \(\{ kind: "branch" as const/);
  assert.match(src, /\.\.\.boxesUnder\(node\)\.map\(\(b\) => \(\{/);
  assert.match(src, /bg-\[#33404E\]/, "the dark department cap");
});

test("two leaders share a box — no line divides their team", () => {
  // Owner:「两个 leader…他们应该合在一起,两个 leader 共同带剩下的人才对」.
  // Houzs express co-management the same way: their model is a single
  // manager_id too, and the BOX is what says "these people belong here".
  // Splitting the seventeen between the two was an invention of the layout,
  // not a fact about the factory.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /`Led together by \$\{cell\.box\.leads\.length\}`/);
  assert.match(src, /const leads = \[lead, \.\.\.co\]\.sort/, "co-leaders are collected into ONE box");
  // The team is grouped by POSITION inside the box, not by which leader.
  assert.match(src, /const byPos = new Map<string, OrgNode\[\]>\(\);/);
});

test("the management chain survives — Violet and the Production Head keep their branch", () => {
  // The first cut fired as soon as a subtree merely CONTAINED a manager, so at
  // the owner's level it swallowed Violet and the Production Head into the
  // boxes as ordinary cards and the whole chain vanished. Owner:「整个
  // Production 的上司不是一个叫 Lim 的吗?然后 Lim 的上司不是叫 Violet 吗?
  // 为什么没看到这条线啊?」
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /n\.children\.some\(\(c\) => c\.children\.length > 0\)/);
});

test("a box is keyed by its LEADER, not by department", () => {
  // ANN runs both Fabric Cutting and Fabric Sewing. Splitting her team into two
  // boxes drew a division that does not exist. Owner:「让这个 operator leader
  // 来 leading 这两个部门」.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /key: leads\[0\]\?\.key \?\? fallbackKey/);
  assert.match(src, /label: depts\.map\(deptLabel\)\.join\(" \+ "\)/, "titled with every department it covers");
  // Co-leaders on the same departments share ONE box.
  assert.match(src, /const co = teamLeads\.filter\(/);
});

test("the connector bus has no holes — no flex gap between the boxes", () => {
  // The bus is drawn INSIDE each child, so a flex `gap` leaves the line with a
  // hole exactly where the gap is. Owner 2026-08-02:「那个线好像断掉那样?」.
  // Padding gives the same spacing and keeps the line continuous.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  // Scoped to the CONNECTOR row only — the Departments board's boxes use a
  // flex gap inside themselves and are right to: no bus runs through them.
  const cellRow = src.slice(
    src.indexOf("EVERY level renders the same two things"),
    src.indexOf("{cell.kind === \"branch\""),
  );
  assert.doesNotMatch(
    cellRow,
    /<div className="flex items-start gap-\d/,
    "a flex gap on the connector row is what put the hole in the line",
  );
  assert.match(cellRow, /<div className="flex items-start">/);
  assert.match(cellRow, /className="relative flex flex-col items-center px-1\.5"/);
});

test("every card carries a face, in BOTH views", () => {
  // Owner:「他们的头像啊,好像没有」. The board's cards had an avatar and the
  // tree's did not, so the same person looked like two different things
  // depending on which view you were in.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  const treeCard = src.slice(src.indexOf("const TreeCard ="), src.indexOf("const Branch ="));
  assert.match(treeCard, /\{initials\(node\.name\)\}/);
  assert.match(treeCard, /node\.source === "worker"/, "worker and office are told apart by colour");
});

test("EVERY department gets a box — one person is still a department", () => {
  // Superseded the brief "no box for one person" rule. Owner was explicit:
  //「部门就应该有部门的样子吧?…Finance,还有 Management、lim,然后 siti zamri,
  // 全部都没有啊」and「应该每一个部门,只要有用到放名字的,都要变成那样子的」.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.doesNotMatch(
    src,
    /node\.children\.length > 1 && !node\.children\.some\(leadsManagers\)/,
    "the headcount threshold must not return",
  );
  // A manager rendered as a branch must NOT also appear inside a box.
  assert.match(src, /\(c\) => c\.children\.length > 0 && !leadsManagers\(c\)/);
  assert.match(src, /\(c\) => c\.children\.length === 0 && !leadsManagers\(c\)/);
});

test("a manager wears the same cap the departments under them wear", () => {
  // Owner 2026-08-02, pointing at the owner / Violet / the Production Head:
  //「我觉得这三个你也是要想一下,怎么去设计才好看的」. He was right that it read
  // wrong: the three people who run the company were the three THINNEST cards
  // on the board while every department under them had a heading. Weight has to
  // follow rank, not contradict it. Houzs cap their leadership row the same way.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  const branch = src.slice(src.indexOf("const Branch ="), src.indexOf("if (loading &&"));
  assert.match(branch, /const capped = node\.children\.length > 0;/);
  assert.match(branch, /bg-\[#33404E\]/, "the same dark cap as the department boxes");
  // The cap names their position, and counts the people under them.
  assert.match(branch, /\{cap \|\| "Leadership"\}/);
  assert.match(branch, /\{countSubtree\(node\) - 1\}/);
  // Someone with nobody under them stays a plain card — a cap with no branch
  // beneath it is the "heading with nothing under it" problem again.
  assert.match(branch, /\) : \(\s*\n\s*<TreeCard node=\{node\} \/>\s*\n\s*\)\}/);
});

test("Collapse all / Expand all are gone — they did nothing in the default view", () => {
  // Owner 2026-08-02:「为什么会有 collapse all 还有 expand all？这个功能没有用啊」.
  // He was right, and for a sharper reason than "unused": both buttons wrote
  // DEPARTMENT names into `collapsed`, but the Hierarchy tree — the view the
  // chart opens on — checks `collapsed.has(node.key)`, a person key. So in the
  // default view they were inert, while still occupying the toolbar.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.doesNotMatch(src, />\s*Collapse all\s*</);
  assert.doesNotMatch(src, />\s*Expand all\s*</);
  assert.doesNotMatch(
    src,
    /setCollapsed\(new Set\(board\.map/,
    "the department-keyed bulk collapse must not return",
  );
  // The per-box header toggle is the control that always worked — it stays.
  assert.match(src, /onClick=\{\(\) => toggle\(box\.dept\)\}/);
});

test("the chart prints what you see, expanded and unzoomed", () => {
  // Owner 2026-08-02:「它不能 print 出来吗？」. Printing CLONES the live chart
  // node rather than re-rendering the tree as standalone HTML — a second
  // layout engine would drift from this one the first time a card changes.
  const src = readFileSync("src/components/org-chart.tsx", "utf8");
  assert.match(src, /ref=\{chartRef\}/, "the printed copy comes from the real node");
  assert.match(src, /cloneNode\(true\)/);

  // Two screen conveniences that would silently LOSE people on paper:
  // a collapsed box prints as a bare header with no hint anyone is missing…
  assert.match(src, /setCollapsed\(new Set\(\)\);\s*\n\s*setPendingPrint\(true\)/,
    "expand BEFORE cloning — setState is async, so the handler would clone the old DOM");
  // …and a zoom on top of the sheet's own scale-to-fit clips the right edge.
  assert.match(src, /el\.style\.zoom = "";/);

  // The app's own stylesheets ride along, or the sheet prints unstyled.
  assert.match(src, /link\[rel="stylesheet"\], style/);
  // And the dialog waits for them to apply.
  assert.match(src, /addEventListener\("load"/);

  // Landscape: the tree is far wider than it is tall, and A4 portrait would
  // break it across pages at an arbitrary column.
  assert.match(src, /@page \{ size: A3 landscape/);
  // A department box split across a page boundary is unreadable.
  assert.match(src, /break-inside: avoid/);
  // On paper there is no scrolling — the board must wrap, not clip.
  assert.match(src, /overflow: visible !important/);
  assert.match(src, /flex-wrap: wrap !important/);

  // Controls are not content.
  assert.match(src, /select, button\[aria-label\], \.org-no-print/);

  // A blocked pop-up must say so rather than appear to do nothing.
  assert.match(src, /blocked the print window/);
});
