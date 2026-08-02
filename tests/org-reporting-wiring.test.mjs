// ---------------------------------------------------------------------------
// org-reporting-wiring.test.mjs
//
// Owner 2026-08-02: 「无论是有新添加的人或者部门，我只要能把 reporting line 放对，
// 这整个东西就会做出来了」— and, when I over-read that as "…and notify people
// too": 「reporting line 是给 org chart 的而已」.
//
// So the promise is bounded and specific: adding a person or a department needs
// NO code change, and setting the manager is the only input. These pin exactly
// that, and nothing beyond it.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const API = read("src/api/routes/org-chart.ts");
const UI = read("src/components/org-chart.tsx");

const { personKey, buildOrgTree, wouldCycle } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/org-people.ts")).href
);

test("a new person appears with no registration step", () => {
  // Both people tables are read live on every request. Nothing has to be
  // inserted into an org-chart-specific table for someone to show up — the
  // only optional row is their reporting line.
  assert.match(API, /FROM users/);
  assert.match(API, /FROM workers WHERE empNo NOT LIKE 'TEST%'/);
  assert.ok(
    !/INSERT INTO org_reporting[\s\S]{0,200}loadPeople/.test(API),
    "appearing on the chart must not require an org_reporting row",
  );
});

test("someone with no manager is a root, not a missing person", () => {
  // A person added a minute ago has no edge at all. They must still be drawn.
  const people = [
    { key: "user:gm", name: "GM", managerKey: null },
    { key: "worker:new", name: "Brand New", managerKey: null },
    { key: "worker:w1", name: "W1", managerKey: "user:gm" },
  ];
  const roots = buildOrgTree(people);
  assert.deepEqual(
    roots.map((r) => r.key).sort(),
    ["user:gm", "worker:new"],
    "the unassigned newcomer must be a root",
  );
});

test("a manager who is filtered out re-roots their reports, never hides them", () => {
  // Ticking "show inactive" off must not make a whole team vanish underneath a
  // resigned manager.
  const roots = buildOrgTree([
    { key: "worker:a", name: "A", managerKey: "user:gone" },
    { key: "worker:b", name: "B", managerKey: "user:gone" },
  ]);
  assert.equal(roots.length, 2);
});

test("the reporting line is the ONLY input, and a loop is refused", () => {
  const managerOf = new Map([
    ["user:a", "user:b"],
    ["user:b", null],
  ]);
  assert.equal(wouldCycle("user:b", "user:a", managerOf), true);
  assert.equal(wouldCycle("user:a", null, managerOf), false);
  assert.match(API, /wouldCycle\(pk, mk, managerOf\)/);
  assert.match(API, /would create a loop/);
});

test("an edge can cross the two people tables", () => {
  // A Fab Cut operator reporting to an office manager is one row keyed by the
  // composite — neither side needs an account it does not have.
  assert.equal(personKey("worker", "worker-b311d39e"), "worker:worker-b311d39e");
  assert.equal(personKey("user", 42), "user:42");
  assert.match(API, /org_reporting/);
});

test("a new DEPARTMENT needs no code — the chart reads the real table", () => {
  // The chart shipped a hardcoded list of nine, so a department added in
  // Settings landed at the end of the board under its raw code.
  assert.match(API, /SELECT code, name, sequence FROM departments/);
  assert.match(UI, /departments\?: DeptMeta\[\]/, "the chart must consume the list");
  assert.ok(
    !/const DEPT_ORDER = \[/.test(UI),
    "the hardcoded order must be a fallback, not the source of truth",
  );
  assert.match(UI, /DEPT_ORDER_FALLBACK/);
  // Name and position both come from the table, not from the code string.
  assert.match(UI, /deptMeta\.get\(code\)\?\.name/);
  assert.match(UI, /deptMeta\.get\(code\)\?\.sequence/);
});

test("the reporting line stays a drawing — it must not grow side effects", () => {
  // Owner: 「reporting line 是给 org chart 的而已」. Setting a manager updates
  // the chart and nothing else; if that ever changes it should be a decision,
  // not a drift.
  assert.ok(
    !/notifyManagerChain|org-notify/.test(API),
    "PUT /reporting must not notify anyone — the line is for the chart only",
  );
  const put = API.slice(API.indexOf('app.put("/reporting"'));
  assert.match(
    put,
    /return c\.json\(\{ success: true, data: \{ personKey: pk, managerKey: mk \} \}\);/,
    "the PUT must return just what it wrote",
  );
});
