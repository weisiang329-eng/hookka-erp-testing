// ---------------------------------------------------------------------------
// purchase-orders-pagination.test.mjs — search-safe pagination for the PO list
// (2026-08-01). The PO list used to pull every PO (+ items) on each load; as
// POs accumulate that grows unbounded. Pagination is added the SAME way SO does
// it: opt-in ?page&limit on the list, BUT the list page drops pagination the
// moment any filter/search is active so a search always sees EVERY PO (never
// just the current page — the rule the owner flagged after a past pagination
// broke search). Summary widgets read a separate whole-dataset /stats payload
// so their counts never shrink to the current page.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(
  resolve(process.cwd(), "src/api/routes/purchase-orders.ts"),
  "utf8",
);
const page = readFileSync(
  resolve(process.cwd(), "src/pages/procurement/index.tsx"),
  "utf8",
);

test("backend list supports opt-in pagination, full list when params omitted", () => {
  const f = route.replace(/\s+/g, " ");
  assert.match(f, /const paginate = pageParam !== undefined \|\| limitParam !== undefined/);
  // paginated branch uses SQL LIMIT ? OFFSET ?
  assert.match(f, /ORDER BY created_at DESC, id DESC LIMIT \? OFFSET \?/);
  // and returns total/page/limit only when paginating
  assert.match(f, /paginate \? \{ success: true, data, total, page, limit \} : \{ success: true, data \}/);
});

test("backend /stats returns whole-dataset header rows (no items), before /:id", () => {
  assert.match(route, /app\.get\("\/stats"/);
  // items-less map — rowToPO(p) with no items arg (cheap; widgets need none)
  assert.match(route, /\.map\(\(p\) => rowToPO\(p\)\)/);
  assert.ok(
    route.indexOf('app.get("/stats"') < route.indexOf('app.get("/:id"'),
    "/stats must be registered before /:id",
  );
});

test("frontend drops pagination whenever a filter/search is active (search-safe)", () => {
  assert.match(page, /const poFiltersActive = !!\(/);
  // gridSearch must be part of the widen trigger
  assert.match(page, /poFiltersActive[\s\S]{0,400}gridSearch\.trim\(\)/);
  // the list fetch is conditional: whole dataset (no page params) when active,
  // else paginated. Both branches present, keyed off a poFiltersActive ternary.
  assert.match(page, /poFiltersActive\s*\r?\n?\s*\?/);
  assert.match(page, /\?\s*page=\$\{poPage\}&limit=\$\{PO_PAGE_SIZE\}/);
  // the bare (no-page) URL is the widen branch
  assert.ok(
    /useCachedJson[\s\S]{0,300}"\/api\/purchase-orders"[\s\S]{0,200}page=\$\{poPage\}/.test(page),
    "both the widen (bare) and paginated URLs must be in the PO list fetch",
  );
});

test("summary widgets read the whole-dataset /stats payload, not the page", () => {
  assert.match(page, /\/api\/purchase-orders\/stats/);
  // The tab strip's counts (and, since the status-tab-strip rollout, its money)
  // come from `poTabSource`: poStatsRows — the whole dataset, never the
  // paginated `purchaseOrders` — when nothing is filtered, and the filtered
  // rows when something is, so the badge and the RM figure beside it describe
  // the same POs the grid shows.
  const srcIdx = page.indexOf("const poTabSource");
  assert.ok(srcIdx >= 0, "poTabSource must exist");
  const srcBody = page.slice(srcIdx, srcIdx + 420);
  assert.ok(
    srcBody.includes("poStatsRows"),
    "the unfiltered tab source must be poStatsRows (whole dataset)",
  );
  assert.ok(
    srcBody.includes("filteredOrdersByUserFilters"),
    "under a filter the tab source must be the filtered rows",
  );
  assert.ok(
    !srcBody.includes("purchaseOrders"),
    "the tab source must never be the paginated page of rows",
  );
  for (const w of ["draftTab", "confirmedTab"]) {
    const idx = page.indexOf(`const ${w}`);
    assert.ok(idx >= 0, `${w} must exist`);
    assert.ok(
      page.slice(idx, idx + 200).includes("poTabSource"),
      `${w} must compute over poTabSource`,
    );
  }
  const overdueIdx = page.indexOf("const overduePoList");
  assert.ok(overdueIdx >= 0, "overduePoList must exist");
  assert.ok(
    page.slice(overdueIdx, overdueIdx + 160).includes("poStatsRows"),
    "overduePoList must compute over poStatsRows (whole dataset), not the page",
  );
});

test("page controls are hidden while filtering (whole set already shown)", () => {
  assert.match(page, /!poFiltersActive && poTotalPages > 1/);
});
