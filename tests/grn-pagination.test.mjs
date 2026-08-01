// ---------------------------------------------------------------------------
// grn-pagination.test.mjs — search-safe pagination for the GRN list
// (2026-08-01). Same shape as the PO list (purchase-orders-pagination): opt-in
// ?page&limit on the list, whole-dataset fetch the moment a filter/search is
// active so search sees EVERY GRN, and a /stats payload feeding the summary
// widgets so their counts never shrink to the current page.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(resolve(process.cwd(), "src/api/routes/grn.ts"), "utf8");
const page = readFileSync(resolve(process.cwd(), "src/pages/procurement/grn.tsx"), "utf8");

test("backend list supports opt-in pagination over the same where-clause", () => {
  const f = route.replace(/\s+/g, " ");
  assert.match(f, /const paginate = pageParam !== undefined \|\| limitParam !== undefined/);
  assert.match(f, /ORDER BY grnNumber DESC LIMIT \? OFFSET \?/);
  assert.match(f, /paginate \? \{ success: true, data, total, page, limit \} : \{ success: true, data \}/);
  // count uses the SAME where clause (poId/supplierId filters honored)
  assert.match(f, /SELECT COUNT\(\*\) AS n FROM grns \$\{where\}/);
});

test("backend /stats returns whole-dataset header rows (no items), before /:id", () => {
  assert.match(route, /app\.get\("\/stats"/);
  assert.match(route, /\.map\(\(g\) => rowToGRN\(g, \[\]\)\)/);
  assert.ok(
    route.indexOf('app.get("/stats"') < route.indexOf('app.get("/:id"'),
    "/stats must be registered before /:id",
  );
});

test("frontend widens to whole dataset on any filter/search (search-safe)", () => {
  assert.match(page, /const grnFiltersActive = !!\(/);
  assert.match(page, /grnFiltersActive[\s\S]{0,300}gridSearch\.trim\(\)/);
  assert.match(page, /grnFiltersActive\s*\r?\n?\s*\?/);
  assert.match(page, /\?\s*page=\$\{grnPage\}&limit=\$\{GRN_PAGE_SIZE\}/);
  // the grid's search box is now lifted to state so it triggers the widen
  assert.match(page, /onSearchChange=\{setGridSearch\}/);
});

test("summary widgets read the whole-dataset /stats payload, not the page", () => {
  assert.match(page, /\/api\/grn\/stats/);
  for (const w of ["draftCount", "tabConfirmedCount"]) {
    const idx = page.indexOf(`const ${w}`);
    assert.ok(idx >= 0, `${w} must exist`);
    assert.ok(page.slice(idx, idx + 160).includes("grnStatsRows"), `${w} must read grnStatsRows`);
  }
  // arrival-state tallies + Total also come from the whole dataset
  assert.match(page, /grnStatsRows\.filter\(g => g\.arrival_state === state\)/);
});

test("page controls hidden while filtering", () => {
  assert.match(page, /!grnFiltersActive && grnTotalPages > 1/);
});
