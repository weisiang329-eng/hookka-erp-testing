// ---------------------------------------------------------------------------
// org-auto-wire.test.mjs — the chart showed 44 separate roots because NOTHING
// infers a hierarchy.
//
// Owner 2026-08-02:「明明我已经设置了我是最高层级，这样的话，它怎么会没有把
// Hierarchy 自动生成下来?」 Because the dropdown sets ONE edge at a time, and
// marking yourself "no manager (top)" only says you have no manager — it pulls
// nobody under you.
//
// POST /auto-wire-production applies the owner's rules to the FACTORY half:
//   1. an Operator Leader is their department's head
//   2. every other worker in that department reports to that head
//   3. a department with no leader reports straight to the Production Head
//   4. the leaders themselves report to the Production Head
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("src/api/routes/org-chart.ts", "utf8");
const block = route.slice(
  route.indexOf('app.post("/auto-wire-production"'),
  route.indexOf('app.put("/reporting"'),
);

test("it never touches an office reporting line", () => {
  // Violet → owner, Production Head → Violet etc. are set by hand.
  // Owner:「就跟着 reporting line」.
  assert.match(block, /p\.source === "worker"/);
  assert.doesNotMatch(block, /source === "user"/);
});

test("a resigned worker is never wired", () => {
  // Their line would outlive them on the chart.
  assert.match(block, /p\.source === "worker" && p\.active/);
});

test("two leaders in one department are PEERS, not a chain", () => {
  // Upholstery really has two. Making the second report to the first would
  // invent a rank nobody stated.
  assert.match(block, /const isHeadAnywhere = /);
  assert.match(block, /isHeadAnywhere \|\| heads\.length === 0 \? productionHeadKey : heads\[0\]/);
});

test("a department with no leader falls through to the Production Head", () => {
  // Wood Cut / Foam / Webbing / Packing — 13 people with nobody in charge.
  assert.match(block, /has no leader → Production Head/);
});

test("category is NOT used to split anyone", () => {
  // Only the two leaders carry one (BEDFRAME / SOFA); all fifteen operators
  // under them are blank, so splitting on it would be guessing.
  assert.doesNotMatch(block, /categor/i);
});

test("it is dry-run by default and refuses without a head", () => {
  assert.match(block, /const apply = c\.req\.query\("apply"\) === "1";/);
  assert.match(block, /head=<user:id\|worker:id> is required/);
  assert.match(block, /requirePermission\(c, "users", "update"\)/);
});

test("an existing worker edge is preserved unless overwrite is asked for", () => {
  // Re-running must not undo a hand correction.
  assert.match(block, /if \(!overwrite && w\.managerKey && w\.managerKey !== manager\) continue;/);
  assert.match(block, /if \(w\.managerKey === manager\) continue;/);
});

test("a department can be pointed at a head it is not filed under", () => {
  // ANN is filed under Fabric Sewing but also runs Fabric Cutting.
  assert.match(block, /\?map=FAB_CUT:/);
  assert.match(block, /leadersByDept\.set\(dept\.trim\(\), \[key\]\)/);
});

test("a leader is a peer of every other leader, wherever they are FILED", () => {
  // ZAW LIN's primary department is Upholstery but he heads Framing. Checking
  // only his OWN department made him a report of Upholstery's head — one
  // Operator Leader under another, a rank nobody stated.
  const src = readFileSync("src/api/routes/org-chart.ts", "utf8");
  const b = src.slice(
    src.indexOf('app.post("/auto-wire-production"'),
    src.indexOf('app.put("/reporting"'),
  );
  assert.match(b, /const isHeadAnywhere = \[\.\.\.leadersByDept\.values\(\)\]\.some\(\(ks\) => ks\.includes\(w\.key\)\)/);
  assert.doesNotMatch(b, /const isHeadHere = heads\.includes\(w\.key\);/);
});
