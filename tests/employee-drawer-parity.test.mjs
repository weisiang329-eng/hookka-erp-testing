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

test("the drawer enforces the same save rules as the inline editor", () => {
  const save = PAGE.slice(PAGE.indexOf("const saveDrawer = async"));
  const body = save.slice(0, save.indexOf("\n  const handleUpdate"));
  // A resignation date is what scopes a resigned worker's final month; without
  // it payroll would keep paying them.
  assert.match(body, /RESIGNED[\s\S]*resignedAt/, "resignation-date guard missing");
  assert.match(body, /efficiencyThresholdPct[\s\S]*100/, "threshold range guard missing");
  assert.match(body, /empNo|name/, "required-field guard missing");
});

test("the primary department is sent, not just the list", () => {
  // The backend keys the worker's home department off departmentCode; sending
  // only the array would leave it pointing at the old department.
  const save = PAGE.slice(PAGE.indexOf("const saveDrawer = async"));
  assert.match(save.slice(0, 2500), /departmentCode: draft\.departmentCodes\[0\]/);
});

test("the drawer and the grid offer the SAME departments and categories", () => {
  // Passed in from the page rather than re-declared, so the two lists cannot
  // drift apart.
  assert.match(PAGE, /departments=\{allDepts\.map/);
  assert.match(PAGE, /categories=\{CATEGORIES\}/);
});
