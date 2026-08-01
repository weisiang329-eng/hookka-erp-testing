// ---------------------------------------------------------------------------
// grid-filter-session-class.test.mjs — BUG CLASS: a grid whose rows are
// SEGMENTED by some state must give each segment its own sticky-filter session.
//
// DataGrid persists column value-filters under
//   datagrid-filters-<gridId>-<valueFilterKey>-<user>
// and seeds a column's selection from the values PRESENT IN THE CURRENT DATA
// (data-grid.tsx, defaultExcludedValues effect). So if two segments share one
// key, a set seeded on segment A contains none of segment B's values, and
// switching to B hides every row.
//
// Instances:
//   · 2026-05-16 — Sales Orders, via the Status dropdown. Fixed by adding
//     `filterStatus` to valueFilterKey.
//   · 2026-08-01 — Sales Orders AGAIN, via the Draft/Confirmed tab, which the
//     first fix never covered: "Draft (2)" showed "0 of 2 records · 1 filter
//     active". Owner: 「包裹为什么by default是kosong的」.
//
// Per docs/BUG-CLASSES.md, fixing only the instance in front of you is how this
// class keeps coming back — so these pins cover every grid in the codebase that
// uses the mechanism, not just the one that broke.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sales = readFileSync("src/pages/sales/index.tsx", "utf8");

test("Sales Orders: the Draft/Confirmed tab is part of the filter session key", () => {
  assert.match(
    sales,
    /valueFilterKey=\{`\$\{tab\}:\$\{filterStatus \|\| "all"\}`\}/,
    "both segmenting states (tab AND filterStatus) must key the session",
  );
  assert.doesNotMatch(
    sales,
    /valueFilterKey=\{filterStatus \|\| "all"\}/,
    "the 2026-05-16 form of this bug must not return",
  );
});

test("Sales Orders: the hide-shipped default never applies on the Draft tab", () => {
  // Every Draft row is DRAFT, so a Status exclusion there can only narrow a
  // list that is already exactly what was asked for.
  assert.match(
    sales,
    /filterStatus \|\| tab === "DRAFT" \? undefined : SHIPPED_STATUS_EXCLUDE/,
  );
});

test("CLASS SWEEP: every grid using the mechanism separates its segments", () => {
  // Production — the department is baked into gridId, so each department gets
  // its own storage key without needing valueFilterKey.
  const prod = readFileSync("src/pages/production/index.tsx", "utf8");
  assert.match(
    prod,
    /gridId=\{`production-dept-\$\{activeDept\.code\.toLowerCase\(\)\}`\}/,
    "Production must keep the department in gridId",
  );

  // Service Cases — statusFilter is its ONLY segmenting state and it is the key.
  const cases = readFileSync("src/pages/service-cases/index.tsx", "utf8");
  assert.match(cases, /valueFilterKey=\{statusFilter\}/);
  const otherSegments = cases.match(/const \[(tab|view|activeTab)\b/g) ?? [];
  assert.deepEqual(
    otherSegments,
    [],
    "a new segmenting state on Service Cases must also be added to valueFilterKey",
  );
});

test("no grid ships defaultExcludedValues without a way to separate segments", () => {
  // A default exclusion is what seeds the sticky set, so any grid using it must
  // either vary gridId or vary valueFilterKey. Fails loudly if a new one lands.
  const files = [
    "src/pages/sales/index.tsx",
    "src/pages/production/index.tsx",
    "src/pages/service-cases/index.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/defaultExcludedValues=\{/.test(src)) continue;
    const varies =
      /gridId=\{`[^`]*\$\{/.test(src) || /valueFilterKey=\{[^}]*\$\{|valueFilterKey=\{\w+\}/.test(src);
    assert.ok(varies, `${f} seeds a sticky filter but never varies its storage key`);
  }
});

// --- the OTHER draft-tab bug: rows that never arrive -------------------------

test("the Draft tab fetches the whole dataset, not one server page", () => {
  // Distinct from the sticky-filter bug above. The list is server-PAGINATED
  // while the tab badge reads a whole-table status count and the DRAFT split is
  // applied client-side — so drafts that don't sit on the fetched page produce
  // "Draft (2)" over an empty grid reporting "0 of 0 records" (no filter
  // indicator, because nothing was filtered: nothing arrived).
  assert.match(
    sales,
    /gridSearch\.trim\(\) \|\|\s*\n\s*tab === "DRAFT"/,
    "the Draft tab must force the whole-dataset fetch",
  );
  // `tab` has to be declared before `_filtersActive` reads it.
  const tabAt = sales.indexOf('const [tab, setTab] = useUrlState');
  const filtersAt = sales.indexOf("const _filtersActive");
  assert.ok(tabAt > 0 && tabAt < filtersAt, "tab must be hoisted above _filtersActive");
});
