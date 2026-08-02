// ---------------------------------------------------------------------------
// org-dept-write-path.test.mjs — Department was WRITTEN to one place and READ
// from another.
//
// Owner 2026-08-02, with a screenshot of the Edit-details modal showing
// "Finance" beside a Users grid showing "—" for every single person:
//   「明明我的 Department 里面是有数据的,为什么在外面呈现出来的却是空的?」
//
// The modal wrote department + position to the ALIAS row
// (email_addresses.assigned_dept / assigned_position). The Users grid AND the
// Org Chart read users.department / users.position — the grid's own column
// comment says "Department lives on the USER row now (owner 2026-06-17)". The
// model moved and only one side followed.
//
// Consequence beyond the blank column: every person's departmentCode was empty,
// so the org chart put all 52 people in "Unassigned" and had no shape at all.
// That is the same report as 「我的 Orgchart 显示也不对」.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/pages/settings/Users.tsx", "utf8");
const route = readFileSync("src/api/routes/users.ts", "utf8");

test("saving details writes the USER row, not only the alias", () => {
  assert.match(page, /async function mirrorOrgFieldsToUser\(/);
  assert.match(page, /method: "PATCH",[\s\S]{0,200}JSON\.stringify\(\{ department, position \}\)/);
});

test("BOTH save paths mirror — edit and create", () => {
  // A user acquiring their first alias must land on the chart too, not only
  // one who already had one.
  const calls = page.match(/await mirrorOrgFieldsToUser\(target\.id, aliasDept, aliasPosition\.trim\(\)\)/g) ?? [];
  assert.equal(calls.length, 2, "the EDIT path and the CREATE path both need it");
});

test("the grid refreshes, so the operator sees it land", () => {
  // Otherwise it still reads "—" until a reload and looks exactly as broken.
  const idx = page.indexOf("mirrorOrgFieldsToUser(target.id");
  assert.match(page.slice(idx, idx + 200), /fetchUsers\(\);/);
});

test("existing alias data is carried across, dry-run first", () => {
  assert.match(route, /app\.post\("\/backfill-org-from-aliases"/);
  // Dry run is the DEFAULT — this touches every user row.
  assert.match(route, /const dryRun = c\.req\.query\("apply"\) !== "1";/);
  // Only fills BLANKS: a department already on the user row is the newer truth.
  assert.match(route, /COALESCE\(u\.department, ''\) = ''/);
  assert.match(route, /requireSuperAdmin\(c\)/);
});

test("a worker's REAL department reaches the chart", () => {
  // All 40 workers were forced to "Production", so the chart had one column and
  // nothing to divide by — owner:「Employee 那边,需要按照部门去划分」. They
  // already carry FAB_CUT / FAB_SEW / WOOD_CUT etc.; the query was not even
  // selecting the column.
  const org = readFileSync("src/api/routes/org-chart.ts", "utf8");
  assert.match(org, /SELECT id, empNo, name, position, status, departmentCode FROM workers/);
  assert.match(
    org,
    /\(w\.departmentCode \?\? w\.departmentcode \?\? ""\)\.trim\(\) \|\| WORKER_DEPARTMENT/,
    "dual-keyed, with Production only as the fallback",
  );
  assert.doesNotMatch(
    org,
    /departmentCode: WORKER_DEPARTMENT,/,
    "the hardcoded single department must not return",
  );
});
