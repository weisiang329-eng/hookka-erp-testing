// ---------------------------------------------------------------------------
// employee-drawer-parity.test.mjs
//
// The drawer is a SECOND door to the same record. Two things go wrong when a
// second door exists: a column the grid shows has no editor behind it, and a
// rule only one door enforces.
//
// Owner 2026-08-02: 「全部column都要补齐」/「确保save edit 功能全部一样」.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const PAGE = readFileSync("src/pages/employees.tsx", "utf8");
const DRAWER = readFileSync("src/components/employee-drawer.tsx", "utf8");

// The Employee Master grid's column keys, in declaration order.
const gridKeys = (() => {
  const start = PAGE.indexOf("const columns: Column<Worker>[] = useMemo(");
  assert.ok(start > 0, "could not find the Employee Master columns");
  const block = PAGE.slice(start, PAGE.indexOf("gridId=\"employees-master\"", start));
  return [...block.matchAll(/\n\s+key: "([A-Za-z_]+)"/g)].map((m) => m[1]);
})();

// Columns that are not person data — nothing to edit behind them.
const NOT_FIELDS = new Set(["_actions", "statutory"]);

test("every grid column has an editor in the drawer", () => {
  const missing = gridKeys
    .filter((k) => !NOT_FIELDS.has(k))
    .filter((k) => {
      // departmentCode is edited as the departmentCodes multi-select.
      const key = k === "departmentCode" ? "departmentCodes" : k;
      return !DRAWER.includes(`"${key}"`);
    });
  assert.deepEqual(missing, [], `grid columns with no drawer editor: ${missing.join(", ")}`);
});

test("the statutory column's four flags are all editable", () => {
  for (const f of ["epfEnabled", "socsoEnabled", "eisEnabled", "pcbEnabled"]) {
    assert.ok(DRAWER.includes(f), `${f} missing from the drawer`);
  }
});

// The drawer is now the ONLY editor — the inline row editor was removed
// (owner 2026-08-02: 「点开了才edit 不需要在row edit了」). Everything the row
// editor used to guarantee has to live here or it is simply gone.
const saveDrawerBody = (() => {
  const start = PAGE.indexOf("const saveDrawer = async");
  assert.ok(start > 0, "saveDrawer not found");
  const end = PAGE.indexOf("\n  const confirmSalaryChange", start);
  assert.ok(end > start, "could not bound saveDrawer");
  return PAGE.slice(start, end);
})();

test("the drawer enforces the same save rules the inline editor did", () => {
  // A resignation date is what scopes a resigned worker's final month; without
  // it payroll would keep paying them.
  assert.match(saveDrawerBody, /RESIGNED[\s\S]*resignedAt/, "resignation-date guard missing");
  assert.match(saveDrawerBody, /efficiencyThresholdPct[\s\S]*100/, "threshold range guard missing");
  assert.match(saveDrawerBody, /empNo|name/, "required-field guard missing");
});

test("a salary change still asks WHEN it takes effect", () => {
  // The inline editor kept the OLD salary in the PUT and opened a prompt that
  // writes a dated worker_salary_history row, because a raise can be back- or
  // post-dated and payroll resolves it as of the period. Losing that with the
  // row editor would silently rewrite history for every past month.
  assert.match(saveDrawerBody, /salaryChanged/, "salary-change detection missing");
  assert.match(saveDrawerBody, /basicSalarySen: keptSalarySen/, "PUT must keep the old salary");
  assert.match(saveDrawerBody, /setSalaryChangePrompt\(/, "effective-date prompt missing");
});

test("the save is read back and confirmed, not trusted", () => {
  // verifiedSave, 2026-05-27: worker master data drives payroll, statutory and
  // OT, so a stale-cache silent overwrite would mis-pay people.
  assert.match(saveDrawerBody, /verifiedSave</, "drawer must use verifiedSave");
  assert.match(saveDrawerBody, /readback:/, "no read-back configured");
});

test("categories are cleared for anyone who is not an Operator Leader", () => {
  // Demoting a leader must not leave a stale line filter on their record.
  assert.match(saveDrawerBody, /positionHasCategory\(draft\.position\) \? draft\.categories : \[\]/);
});

test("the row editor is gone — no second door left open", () => {
  const tab = PAGE.slice(
    PAGE.indexOf("function EmployeeMasterTab({"),
    PAGE.indexOf("gridId=\"employees-master\""),
  );
  for (const dead of ["editingId", "editForm", "startEdit", "handleUpdate"]) {
    assert.ok(!tab.includes(dead), `${dead} still referenced — the row editor is not fully removed`);
  }
});

test("the primary department is sent, not just the list", () => {
  // The backend keys the worker's home department off departmentCode; sending
  // only the array would leave it pointing at the old department.
  const save = PAGE.slice(PAGE.indexOf("const saveDrawer = async"));
  assert.match(save.slice(0, 2500), /departmentCode: draft\.departmentCodes\[0\]/);
});

test("all three doors use ONE Departments picker and ONE options list", () => {
  // The grid cell, the Add form and the drawer each grew their own control for
  // the same field — a text box for Position, a fourteen-checkbox wall for
  // Departments (owner 2026-08-02: 「department太乱了 做成dropdown」/
  // 「规格全部一样？」). One component, one list, so they cannot drift again.
  assert.match(PAGE, /departments=\{allDepts\.map/);
  assert.ok(
    DRAWER.includes("DepartmentMultiSelect"),
    "the drawer must use the shared Departments picker",
  );
  assert.ok(
    PAGE.includes("DepartmentMultiSelect"),
    "the Add form must use the shared Departments picker",
  );
  // No hand-rolled department checkbox walls left anywhere.
  for (const [label, src] of [["page", PAGE], ["drawer", DRAWER]]) {
    assert.ok(
      !/allDepts\.map\([\s\S]{0,400}type="checkbox"/.test(src),
      `${label} still hand-rolls a department checkbox list`,
    );
  }
});

test("Position is a dropdown everywhere, from one list", () => {
  // A free-text Position let a typo ("Operater Leader") drop someone out of
  // every leader-scoped view without an error.
  assert.ok(!/value=\{draft\.position\}[\s\S]{0,200}<Input/.test(DRAWER),
    "the drawer's Position must not be a text input");
  assert.ok(DRAWER.includes("POSITIONS"), "the drawer must read the shared POSITIONS list");
  assert.ok(PAGE.includes("POSITIONS"), "the page must read the shared POSITIONS list");
  // Nobody hardcodes the two options any more.
  for (const [label, src] of [["page", PAGE], ["drawer", DRAWER]]) {
    assert.ok(
      !src.includes('<option value="Operator Leader">'),
      `${label} still hardcodes the Position options`,
    );
  }
});

test("Category is a single dropdown, and only for Operator Leaders", () => {
  assert.ok(
    DRAWER.includes("positionHasCategory(draft.position)"),
    "the drawer must hide Category for plain Operators, as the grid and Add form do",
  );
  assert.ok(DRAWER.includes("categoryOptions("), "the drawer must read the shared category list");
  assert.ok(PAGE.includes("categoryOptions("), "the Add form must read the shared category list");
});

test("the drawer's Save cannot sit under the toast stack", () => {
  // Toasts render fixed bottom-6 right-6 at z-[9999]; the drawer is z-50. A
  // right-aligned action bar puts Save under them, and a toast from the
  // previous save eats the next click — the edit looks applied on screen and
  // never reaches the server. Reproduced in the live app on 2026-08-02.
  const toast = readFileSync("src/components/ui/toast.tsx", "utf8");
  assert.match(toast, /fixed bottom-6 right-6/, "toast corner changed — recheck this");
  const footer = DRAWER.slice(DRAWER.indexOf("border-t border-[#E2DDD8] px-4 py-3"));
  assert.doesNotMatch(
    footer.slice(0, 120),
    /justify-end/,
    "the drawer's action bar must not right-align into the toast corner",
  );
});
