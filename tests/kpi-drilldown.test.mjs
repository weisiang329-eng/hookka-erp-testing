// ---------------------------------------------------------------------------
// KPI drill-downs — "See the list →" must open the rows the number counted.
//
// Owner 2026-08-07: "如果是 showable 的话，就要确保这些全部数据是可以被看到的."
// Before this, every AUTO KPI showed the link and three of the five went
// nowhere useful: /sales and /products never READ `?filter=`, so the operator
// landed on the unfiltered list, and /reports/operations was not a route at
// all — a blank page.
//
// These tests assert BEHAVIOUR, not imports:
//   • the param actually narrows the set, and narrows it by the metric's own
//     rule (not some looser lookalike);
//   • the month travels with the link, so the list and the card agree;
//   • the predicate the SQL counts with is the SAME STRING the drill-down
//     list selects with, so the two cannot drift;
//   • no catalogue entry links somewhere that does not exist.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { KPI_CATALOG } from "../src/api/lib/kpi-catalog.ts";
import {
  drillHref,
  narrowToIds,
  periodBounds,
  serviceCaseCountedIn,
  validPeriod,
  PERIOD_TOKEN,
} from "../src/lib/kpi-drill.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ROUTES = read("src/dashboard-routes.tsx");
const METRICS = read("src/api/lib/kpi-metrics.ts");

// ── 1. every drillPath resolves to a real route ─────────────────────────────

test("every drill-down link points at a route that exists", () => {
  // /reports/operations sat in the catalogue for weeks. There is no
  // `operations` tab on /reports and no /reports/:tab route, so React Router
  // matched nothing and the page rendered blank. A link that renders nothing
  // is worse than no link — it reads as "the data is gone".
  const declared = new Set(
    [...ROUTES.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
  );
  const linked = KPI_CATALOG.filter((k) => k.drillPath);
  assert.ok(linked.length > 0, "the catalogue still offers drill-downs");
  for (const k of linked) {
    const path = k.drillPath.split("?")[0];
    assert.ok(
      declared.has(path),
      `${k.key} links to ${path}, which is not in DASHBOARD_ROUTES`,
    );
  }
});

test("no drill-down survives as a bare list link", () => {
  // A link to the UNFILTERED page is the failure this whole change is about:
  // the card says 11 and the page says 348, and the reader cannot tell which
  // is lying. Every drill-down must carry a filter of some kind.
  for (const k of KPI_CATALOG) {
    if (!k.drillPath) continue;
    assert.ok(
      k.drillPath.includes("?"),
      `${k.key} links to ${k.drillPath} with no filter — either filter it or drop drillPath`,
    );
  }
});

// ── 2. the month travels with the link ──────────────────────────────────────

test("a month-scoped drill-down carries the card's period", () => {
  assert.equal(
    drillHref("/sales?filter=late-to-customer&period={period}", "2026-06"),
    "/sales?filter=late-to-customer&period=2026-06",
  );
  // A point-in-time KPI is left alone rather than given a parameter nothing
  // reads — that is the same lie in a smaller font.
  assert.equal(
    drillHref("/products?filter=incomplete", "2026-06"),
    "/products?filter=incomplete",
  );
});

test("the monthly AUTO KPIs all ask for the period", () => {
  // setup_completeness is deliberately exempt: a SKU is missing its price NOW,
  // not "in July", and the metric takes no period argument.
  const pointInTime = new Set(["setup_completeness", "documents_not_stuck"]);
  for (const k of KPI_CATALOG) {
    if (!k.drillPath || k.scoring !== "AUTO" || pointInTime.has(k.key)) continue;
    assert.ok(
      k.drillPath.includes(PERIOD_TOKEN),
      `${k.key} is scored per month, so its list must be too`,
    );
  }
  // …and the exemption is only legitimate while the metric really ignores the
  // period. `setupCompleteness(c)` takes no second argument; if that ever
  // changes the link has to start carrying the month.
  assert.match(
    METRICS,
    /export async function setupCompleteness\(\s*c: Context<Env>,\s*\)/,
    "setupCompleteness gained a period — its drill-down must now pass one",
  );
});

test("a junk period is refused rather than passed through", () => {
  assert.equal(validPeriod("2026-06"), "2026-06");
  assert.equal(validPeriod("2026-13"), "");
  assert.equal(validPeriod("2026-6"), "");
  assert.equal(validPeriod("'; DROP TABLE"), "");
  assert.equal(validPeriod(null), "");
});

// ── 3. the params NARROW the set ────────────────────────────────────────────

test("the late-to-customer id set narrows the Sales list", () => {
  const orders = [
    { id: "so-1", status: "DELIVERED" },
    { id: "so-2", status: "DELIVERED" },
    { id: "so-3", status: "IN_PRODUCTION" },
  ];
  // The whole point: 3 orders in, only the ones the metric counted come out.
  assert.deepEqual(
    narrowToIds(orders, new Set(["so-2"])).map((o) => o.id),
    ["so-2"],
  );
  // Nothing late that month is a REAL answer and must empty the grid, not
  // silently fall back to showing everything.
  assert.deepEqual(narrowToIds(orders, new Set()), []);
  // Still loading leaves the list alone rather than flashing "0 records".
  assert.equal(narrowToIds(orders, null).length, 3);
});

test("the Sales page reads the drill param and applies it to the rows", () => {
  const sales = read("src/pages/sales/index.tsx");
  // The 2026-08-07 bug in one line: setSearchParams was destructured for
  // WRITING only, so `?filter=` was never read.
  assert.match(
    sales,
    /useUrlState<string>\("filter", ""\)/,
    "the Sales page must READ ?filter=, not just write params",
  );
  assert.match(sales, /useUrlState<string>\("period", ""\)/);
  // Read is not enough — it has to reach the rows.
  assert.match(
    sales,
    /narrowToIds\(orders, lateIds\)/,
    "the id set must be applied to the order list",
  );
  // Every late order has SHIPPED, so the grid's hide-shipped default would
  // empty a correctly-filtered list.
  assert.match(
    sales,
    /tab === "DRAFT" \|\| lateDrillActive\s*\?\s*undefined/,
    "the hide-shipped default must be off under the drill-down",
  );
  // The whole dataset has to be fetched — the late orders are spread across
  // every page of the table by definition.
  assert.match(sales, /tab === "DRAFT" \|\| lateDrillActive\s*\n?\s*\);/);
});

test("the Products page reads the drill param and ignores the category tab", () => {
  const products = read("src/pages/products/index.tsx");
  assert.match(
    products,
    /searchParams\.get\("filter"\) === "incomplete"/,
    "the Products page must READ ?filter=incomplete",
  );
  assert.match(products, /searchParams\.get\("missing"\)/);
  // Ignoring the category tab is load-bearing, not cosmetic: the page defaults
  // to BEDFRAME and the gap is overwhelmingly sofa components, so honouring
  // the tab would show a fraction of the number that led here.
  assert.match(
    products,
    /if \(incompleteCodes !== null\) \{\s*\n\s*const inDrill = products\.filter\(\(p\) => incompleteCodes\.has\(p\.code\)\)/,
    "the drill-down must narrow to the returned codes across every category",
  );
});

test("the service-case drill applies the metric's own WHERE clause", () => {
  const period = "2026-06";
  const { start, end } = periodBounds(period);
  assert.equal(start, "2026-06-01");
  assert.equal(end, "2026-06-30");

  // Closed inside the month — counted.
  assert.ok(
    serviceCaseCountedIn({ createdAt: "2026-05-20", closedAt: "2026-06-03" }, period),
  );
  // Closed in a LATER month — not this month's average.
  assert.ok(
    !serviceCaseCountedIn({ createdAt: "2026-05-20", closedAt: "2026-07-01" }, period),
  );
  // Closed BEFORE the month — likewise out.
  assert.ok(
    !serviceCaseCountedIn({ createdAt: "2026-04-02", closedAt: "2026-05-31" }, period),
  );
  // Still open, raised before the month ended — counted, measured to today.
  // Dropping these would make "never close it" the top-scoring strategy.
  assert.ok(serviceCaseCountedIn({ createdAt: "2026-02-11", closedAt: "" }, period));
  // Still open but raised AFTER the month — belongs to a later month.
  assert.ok(!serviceCaseCountedIn({ createdAt: "2026-07-04", closedAt: null }, period));
  // Timestamps, not bare dates, are what the API actually returns.
  assert.ok(
    serviceCaseCountedIn(
      { createdAt: "2026-06-10T08:12:00Z", closedAt: "2026-06-12T17:00:00Z" },
      period,
    ),
  );
  // A row with no raised date cannot be placed and is excluded, same as the
  // SQL's `createdAt IS NOT NULL`.
  assert.ok(!serviceCaseCountedIn({ createdAt: null, closedAt: null }, period));

  const cases = read("src/pages/service-cases/index.tsx");
  assert.match(
    cases,
    /serviceCaseCountedIn\(c, kpiPeriod\)/,
    "the page must apply the predicate to its rows",
  );
  // The status chips have to count the narrowed set too, or a chip advertises
  // 40 cases over a grid showing 6.
  assert.match(cases, /casesInPeriod\.filter\(\(c\) => c\.status === s\)\.length/);
});

test("the Daily Report opens the section / month the link asked for", () => {
  const daily = read("src/pages/daily-report.tsx");
  assert.match(
    daily,
    /searchParams\.get\("section"\)/,
    "?section= must open that exception's detail, not the tile overview",
  );
  assert.match(
    daily,
    /searchParams\.get\("edition"\)/,
    "?edition=monthly must open the Monthly Operations edition",
  );
  assert.match(
    daily,
    /searchParams\.get\("period"\)/,
    "?period= must anchor the edition to the card's month",
  );
});

// ── 4. list and metric share ONE predicate ──────────────────────────────────

test("the drill-down list runs the metric's own SQL, not a copy of it", () => {
  // Two hand-written copies agree on the day they are written. The card would
  // then say 11 and the list would show 14, and the number loses its
  // authority — which is the whole reason the link exists.
  for (const frag of ["FIRST_DISPATCH_CTE", "DISPATCHED_IN_PERIOD", "IS_LATE"]) {
    const uses = METRICS.match(new RegExp(`\\$\\{${frag}\\}`, "g")) ?? [];
    assert.ok(
      uses.length >= 2,
      `${frag} must be interpolated by BOTH the metric and its drill-down (found ${uses.length})`,
    );
  }
  // Same for the four setup checks.
  for (const f of ["price", "volume", "fabric", "bom"]) {
    const uses = METRICS.match(
      new RegExp(`SETUP_FIELD_SQL\\.${f}\\b`, "g"),
    ) ?? [];
    assert.ok(
      uses.length >= 2,
      `SETUP_FIELD_SQL.${f} must be shared by the count and the list (found ${uses.length})`,
    );
  }
  // And no second copy of the join was left behind.
  const cteCopies = METRICS.match(/WITH first_dispatch AS \(/g) ?? [];
  assert.equal(cteCopies.length, 1, "there must be exactly one first-dispatch CTE");
});

test("the drill-down endpoints are row-scoped in SQL and sit before /:id", () => {
  const salesRoute = read("src/api/routes/sales-orders.ts");
  // Scoped in the QUERY. A response filter cannot un-send rows, and a
  // browser-side filter has already received them.
  assert.match(
    salesRoute,
    /customerScopeSql\(c, "so\.customerId"\)/,
    "the late-to-customer list must be narrowed by the row-level customer scope",
  );
  // Hono matches in registration order, so a handler declared after /:id is
  // never reached — the request would be read as a sales-order id.
  const drillAt = salesRoute.indexOf('app.get("/late-to-customer"');
  const idAt = salesRoute.indexOf('app.get("/:id"');
  assert.ok(drillAt > 0 && idAt > 0);
  assert.ok(drillAt < idAt, "/late-to-customer must be registered before /:id");

  const productsRoute = read("src/api/routes/products.ts");
  const pDrillAt = productsRoute.indexOf('app.get("/setup-incomplete"');
  const pIdAt = productsRoute.indexOf('app.get("/:id"');
  assert.ok(pDrillAt > 0 && pIdAt > 0);
  assert.ok(pDrillAt < pIdAt, "/setup-incomplete must be registered before /:id");
  // A typo'd field must 400, not quietly widen to the full list — a link that
  // returns MORE than it promised is the same class of bug in reverse.
  assert.match(productsRoute, /!isSetupField\(raw\)\) \{\s*\n\s*return c\.json\(/);
  // A junk period must not reach the query builder.
  assert.match(salesRoute, /period must be YYYY-MM/);
});
