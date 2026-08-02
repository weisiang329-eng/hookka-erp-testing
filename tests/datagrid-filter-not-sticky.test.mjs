// ---------------------------------------------------------------------------
// datagrid-filter-not-sticky.test.mjs
//
// A grid that opens blank is worse than a grid that opens wide.
//
// Column value-filters were restored from sessionStorage on mount, so an
// operator who narrowed a column, walked away and came back was shown an empty
// table with one small "Clear 1 filter" link as the only explanation. It has
// bitten the same screen twice: Sales Orders "Delivered" showing 0 of 66, and
// the Draft tab showing "0 of 2 records · 1 filter active" while two draft
// orders sat right there (owner 2026-08-02: 「我想要它 by default 是打开的，
// 筛选的那个不要 by default」).
//
// The search box is a deliberate exception — it survives a tab hop, which was
// the original request (2026-04-26: "I search something, switch tabs, come
// back, it's gone"). A visible search term explains its own empty result; an
// invisible column filter does not.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const GRID = readFileSync("src/components/ui/data-grid.tsx", "utf8");
const SALES = readFileSync("src/pages/sales/index.tsx", "utf8");

test("column filters are NOT seeded from storage on mount", () => {
  assert.match(
    GRID,
    /const \[columnFilters, setColumnFilters\] = useState<Record<string, string>>\(\s*seededFilters\?\.columnFilters/,
    "columnFilters must not read the persisted state",
  );
  assert.match(
    GRID,
    /if \(!seededFilters\?\.columnValueFilters\) return \{\};/,
    "columnValueFilters must not read the persisted state",
  );
  // The switch itself: one place to flip if this is ever reconsidered.
  assert.match(GRID, /const seededFilters = null as typeof seeded;/);
});

test("the search box still survives a tab hop", () => {
  // Removing this would regress the 2026-04-26 fix.
  assert.match(
    GRID,
    /useState\(initialSearch \?\? seeded\?\.searchText \?\? ""\)/,
    "search text must still be restored",
  );
});

test("the Draft tab seeds no status exclusion of its own", () => {
  // The other half of how that tab went blank: a "hide shipped" default only
  // makes sense in the Confirmed funnel. On Draft every row is DRAFT, so it
  // could only ever narrow a list that was already exactly what was asked for.
  assert.match(
    SALES,
    /filterStatus \|\| tab === "DRAFT" \? undefined : SHIPPED_STATUS_EXCLUDE/,
  );
});

test("the bulk-action buttons sit together, not spread across the bar", () => {
  // justify-between with THREE children floated Convert into the middle of the
  // banner (owner: 「为什么会跑到中间？非常奇怪」). Label on the left, the two
  // actions grouped on the right.
  const banner = SALES.slice(SALES.indexOf("draft order(s) selected") - 900);
  const head = banner.slice(0, 1400);
  assert.match(head, /justify-between/, "label and actions still spread apart");
  assert.match(
    head,
    /<\/span>\s*<div className="flex items-center gap-2">/,
    "Convert and Delete must be wrapped in one right-hand group",
  );
});
