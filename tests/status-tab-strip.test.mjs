// ---------------------------------------------------------------------------
// status-tab-strip.test.mjs — the shared status tab strip: every document list
// shows, per status, HOW MANY documents are in that state and WHAT THEY ARE
// WORTH (the pattern the Delivery Order list proved, now in one component).
//
// The behaviours pinned here are the ones that make the strip trustworthy —
// each has already cost this codebase a bug somewhere:
//
//   1. the count matches the rows in that state, and the money matches the sum
//      of THOSE rows — never a badge over one row set beside an RM figure over
//      another (the 2026-05-26 Sales KPI class);
//   2. a state whose documents carry no derivable value renders its count and
//      NO money — a confident RM 0.00 is worse than no figure;
//   3. a scoped salesperson's total covers only their own customers' rows, on
//      BOTH paths: a total derived from list rows (the response filter already
//      dropped the others) and a total from a server aggregate, where there is
//      no row for a filter to drop and the narrowing must be in the SQL
//      (owner 2026-08-05: empty grid, cards reading 1,229 / RM 1.4m);
//   4. money is integer sen, rendered through formatCurrency with tabular-nums.
//
// Units under test: src/lib/status-tab-strip.ts (the arithmetic),
// src/components/ui/status-tab-strip.tsx (the rendering), and the two server
// aggregates that feed it — /api/consignment-orders/stats and
// /api/invoices/stats.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
// The app's "@/..." alias — tsx reads the root tsconfig, which has no paths.
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;

const { tabValueSen, sumTabValueSen, tabTotals } = await import(
  src("src/lib/status-tab-strip.ts")
);
const { filterPayload } = await import(src("src/api/lib/customer-scope.ts"));

// ---------------------------------------------------------------------------
// 1. Count and money describe the SAME rows.
// ---------------------------------------------------------------------------

// A document list, deliberately mixed: two states, one row worth nothing, one
// row carrying no money field at all.
const ORDERS = [
  { id: "SO-1", status: "DRAFT", totalSen: 125050 },
  { id: "SO-2", status: "DRAFT", totalSen: 74950 },
  { id: "SO-3", status: "CONFIRMED", totalSen: 1000000 },
  { id: "SO-4", status: "CONFIRMED", totalSen: 0 },
  { id: "SO-5", status: "CONFIRMED", totalSen: null },
  { id: "SO-6", status: "CANCELLED", totalSen: 500000 },
];

test("a tab's count is the number of rows in that state", () => {
  const inState = (s) => ORDERS.filter((o) => o.status === s);
  assert.equal(tabTotals(inState("DRAFT"), (o) => o.totalSen).count, 2);
  assert.equal(tabTotals(inState("CONFIRMED"), (o) => o.totalSen).count, 3);
  assert.equal(tabTotals(inState("CANCELLED"), (o) => o.totalSen).count, 1);
});

test("a tab's money is the sum of exactly those rows' money", () => {
  const drafts = ORDERS.filter((o) => o.status === "DRAFT");
  assert.equal(tabTotals(drafts, (o) => o.totalSen).valueSen, 125050 + 74950);

  // The "Confirmed" tab on these lists is everything that is not a draft, so
  // its money is the money of everything that is not a draft — including the
  // cancelled one, because the tab lists it. Count and figure over one row set.
  const confirmed = ORDERS.filter((o) => o.status !== "DRAFT");
  const t = tabTotals(confirmed, (o) => o.totalSen);
  assert.equal(t.count, 4);
  assert.equal(t.valueSen, 1000000 + 0 + 500000);
});

test("a row carrying no money is skipped, not counted as zero", () => {
  // SO-5 has totalSen null. It is still a document in the bucket (count 3) but
  // it must not drag the total anywhere.
  const confirmed = ORDERS.filter((o) => o.status === "CONFIRMED");
  const t = tabTotals(confirmed, (o) => o.totalSen);
  assert.equal(t.count, 3);
  assert.equal(t.valueSen, 1000000);
});

test("money stays in integer sen — no float arithmetic anywhere", () => {
  const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
  const sum = sumTabValueSen(rows, (r) => r.v);
  assert.equal(sum, 6);
  assert.ok(Number.isInteger(sum), "a sen total must stay an integer");
});

// ---------------------------------------------------------------------------
// 2. No confident RM 0.00.
// ---------------------------------------------------------------------------

test("a non-empty state whose documents are all unpriced yields no figure", () => {
  // The real case: draft GRNs booked in before the supplier's prices are keyed
  // in. Three genuine receipts, none of them valued yet.
  const unpricedGrns = [
    { grnNumber: "GRN-1", totalAmount: 0 },
    { grnNumber: "GRN-2", totalAmount: 0 },
    { grnNumber: "GRN-3", totalAmount: 0 },
  ];
  const t = tabTotals(unpricedGrns, (g) => g.totalAmount);
  assert.equal(t.count, 3, "the documents are still counted");
  assert.equal(t.valueSen, null, "…but they are not worth a confident RM 0.00");
});

test("one priced document among unpriced ones is enough to show a figure", () => {
  const grns = [
    { totalAmount: 0 },
    { totalAmount: 45000 },
    { totalAmount: 0 },
  ];
  assert.equal(tabTotals(grns, (g) => g.totalAmount).valueSen, 45000);
});

test("an empty state shows no figure either", () => {
  assert.equal(tabTotals([], (o) => o.totalSen).valueSen, null);
});

test("tabValueSen normalises a server aggregate the same way", () => {
  assert.equal(tabValueSen(93_806_50), 9380650);
  assert.equal(tabValueSen(0), null, "zero is not a figure");
  assert.equal(tabValueSen(null), null);
  assert.equal(tabValueSen(undefined), null);
  assert.equal(tabValueSen(Number.NaN), null);
  // A credit-side total is real money and must survive.
  assert.equal(tabValueSen(-2500), -2500);
});

// ---------------------------------------------------------------------------
// 3a. Row-scoping, list-derived path.
//
// The customer-scope middleware drops other people's rows out of the response
// before the page ever sees them. A total summed over the rows the list HAS
// therefore inherits the scope for free — provided it is summed over those rows
// and not fetched separately. This is that composition, using the real filter.
// ---------------------------------------------------------------------------

test("a total derived from list rows covers only the rows the user may see", () => {
  const scope = {
    forbidden: new Set(["cust-other"]),
    forbiddenNames: new Set(["HOUZS CENTURY"]),
    denyAll: false,
  };
  const wholeBook = [
    { id: "SO-1", status: "CONFIRMED", customerId: "cust-mine", totalSen: 100000 },
    { id: "SO-2", status: "CONFIRMED", customerId: "cust-other", totalSen: 900000 },
    // No id, only a name — the /pending-sos shape. Still theirs, still dropped.
    { id: "SO-3", status: "CONFIRMED", customerName: "Houzs Century", totalSen: 700000 },
    // Unassigned account: public, stays visible.
    { id: "SO-4", status: "CONFIRMED", customerId: null, totalSen: 50000 },
  ];

  const visible = filterPayload(wholeBook, scope, false).value;
  const t = tabTotals(
    visible.filter((o) => o.status === "CONFIRMED"),
    (o) => o.totalSen,
  );

  assert.deepEqual(visible.map((r) => r.id), ["SO-1", "SO-4"]);
  assert.equal(t.count, 2, "count covers only their own rows");
  assert.equal(t.valueSen, 150000, "and so does the money — not RM 16,500.00");
});

// ---------------------------------------------------------------------------
// 3b. Row-scoping, server-aggregate path.
//
// GET /api/consignment-orders/stats now returns money per status. An aggregate
// is a number, not a row, so the response filter cannot narrow it — the scope
// has to be inside the GROUP BY. Driven against the real handler.
// ---------------------------------------------------------------------------

const { default: consignmentOrdersApp } = await import(
  src("src/api/routes/consignment-orders.ts")
);

/**
 * Mock D1 for the CO stats path. Understands three shapes:
 *   • the customer-scope owner lookup (who is assigned to someone else),
 *   • the status/revenue GROUP BY (applying the NOT IN narrowing itself),
 *   • everything the snapshot helper probes, answered emptily.
 */
function makeCoDb({ cos = [], foreignCustomers = [] } = {}) {
  const seen = [];
  function prepare(sql) {
    const s = sql.trim();
    let bound = [];
    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async first() {
        return null; // no snapshot row → withSnapshot computes fresh
      },
      async all() {
        seen.push({ sql: s, bound });
        if (/FROM customers WHERE salesperson_user_id/i.test(s)) {
          return { results: foreignCustomers };
        }
        if (/FROM consignment_orders/i.test(s) && /GROUP BY status/i.test(s)) {
          // Apply the scope clause the way Postgres would.
          let rows = cos;
          if (/customerId NOT IN/i.test(s)) {
            const forbidden = new Set(bound.map(String));
            rows = rows.filter(
              (r) => r.customerId == null || !forbidden.has(String(r.customerId)),
            );
          }
          const acc = new Map();
          for (const r of rows) {
            const cur = acc.get(r.status) ?? { status: r.status, n: 0, revenueSen: 0 };
            cur.n += 1;
            cur.revenueSen += r.totalSen ?? 0;
            acc.set(r.status, cur);
          }
          return { results: [...acc.values()] };
        }
        return { results: [] };
      },
      async run() {
        return { success: true };
      },
    };
    return obj;
  }
  return { db: { prepare, batch: async () => [] }, seen };
}

function mountCo(db, { role, userId = "user-sales" }) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("orgId", "hookka");
    c.set("userRole", role);
    c.set("userId", userId);
    await next();
  });
  parent.route("/", consignmentOrdersApp);
  return parent;
}

const CO_BOOK = [
  { id: "CO-1", status: "DRAFT", customerId: "cust-mine", totalSen: 120000 },
  { id: "CO-2", status: "CONFIRMED", customerId: "cust-mine", totalSen: 300000 },
  { id: "CO-3", status: "CONFIRMED", customerId: "cust-other", totalSen: 5000000 },
  { id: "CO-4", status: "CONFIRMED", customerId: null, totalSen: 40000 },
];

test("CO /stats: a salesperson's counts AND money exclude other people's customers", async () => {
  const { db } = makeCoDb({
    cos: CO_BOOK,
    foreignCustomers: [{ id: "cust-other", name: "Houzs Century" }],
  });
  const res = await mountCo(db, { role: "SALES" }).request("/stats");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.byStatus.DRAFT, 1);
  assert.equal(body.byStatus.CONFIRMED, 2, "CO-3 belongs to somebody else");
  assert.equal(body.revenueByStatus.DRAFT, 120000);
  assert.equal(
    body.revenueByStatus.CONFIRMED,
    340000,
    "the RM 50,000.00 order they may not see must not be in their total",
  );
  assert.equal(body.totalRevenueSen, 460000);
});

test("CO /stats: an unscoped role still sees the whole book, with money", async () => {
  const { db } = makeCoDb({
    cos: CO_BOOK,
    foreignCustomers: [{ id: "cust-other", name: "Houzs Century" }],
  });
  const res = await mountCo(db, { role: "OFFICE" }).request("/stats");
  const body = await res.json();
  assert.equal(body.byStatus.CONFIRMED, 3);
  assert.equal(body.revenueByStatus.CONFIRMED, 300000 + 5000000 + 40000);
  assert.equal(body.totalRevenueSen, 120000 + 5340000);
});

test("CO /stats: a scoped caller never reads or writes the org-wide snapshot", async () => {
  const { db, seen } = makeCoDb({
    cos: CO_BOOK,
    foreignCustomers: [{ id: "cust-other", name: "Houzs Century" }],
  });
  await mountCo(db, { role: "SALES" }).request("/stats");
  // One salesperson's totals cached under an org-only key would become
  // everybody's. The scoped path must compute fresh.
  assert.ok(
    !seen.some((q) => /consignment_orders_stats_snapshot/i.test(q.sql)),
    "the scoped path must not touch the snapshot table",
  );
});

test("CO /stats: money and counts come from ONE query, so they cannot disagree", async () => {
  const { db, seen } = makeCoDb({
    cos: CO_BOOK,
    foreignCustomers: [{ id: "cust-other", name: "Houzs Century" }],
  });
  await mountCo(db, { role: "SALES" }).request("/stats");
  const grouped = seen.filter(
    (q) => /FROM consignment_orders/i.test(q.sql) && /GROUP BY status/i.test(q.sql),
  );
  assert.equal(grouped.length, 1, "one GROUP BY for both numbers");
  assert.match(grouped[0].sql, /COUNT\(\*\)/);
  assert.match(grouped[0].sql, /SUM\(totalSen\)/);
});

// ---------------------------------------------------------------------------
// 3c. The invoices aggregate gained the same money-per-status shape.
//
// Source-level, because the bug class it guards against is textual: an
// UNQUOTED `AS total_sen` comes back CAMELCASED from the driver and the read is
// silently undefined → RM 0.00 on every tab. This exact fault broke the Stock
// Adjustments picker.
// ---------------------------------------------------------------------------

test("invoices /stats sums totalSen per status on the counts' own GROUP BY, quoted", () => {
  const invoices = readFileSync(
    resolve(process.cwd(), "src/api/routes/invoices.ts"),
    "utf8",
  );
  const start = invoices.indexOf('app.get("/stats"');
  assert.ok(start >= 0, "the /stats handler must exist");
  const handler = invoices.slice(start, invoices.indexOf("app.get(", start + 10));

  assert.match(handler, /COALESCE\(SUM\(totalSen\), 0\)\s+AS "totalSen"/);
  assert.match(handler, /COUNT\(\*\)\s+AS "n"/);
  assert.match(handler, /totalByStatus\[row\.status\] = Number\(row\.totalSen\)/);
  // Already-scoped: the aggregate is narrowed in SQL, not after the fact.
  assert.match(handler, /customerScopeSql\(c, "customerId"\)/);
  // A snapshot written before totalByStatus existed must not be served.
  assert.match(handler, /snap\.data\.totalByStatus/);
});

// ---------------------------------------------------------------------------
// 4. Rendering.
// ---------------------------------------------------------------------------

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { StatusTabStrip } = await import(src("src/components/ui/status-tab-strip.tsx"));

// formatCurrency (Intl, en-MY/MYR) separates "RM" from the digits with a
// NO-BREAK SPACE. Normalise it so the assertions read like what a human sees.
const render = (props) =>
  renderToStaticMarkup(
    React.createElement(StatusTabStrip, {
      value: "confirmed",
      onChange: () => {},
      moneyLabel: "Order value",
      ...props,
    }),
  ).replace(/\u00a0/g, " ");

const VALUED_TABS = [
  { key: "draft", label: "Draft", count: 12, valueSen: null },
  { key: "confirmed", label: "Confirmed", count: 369, valueSen: 134258093 },
];

for (const variant of ["segmented", "underline"]) {
  test(`${variant}: a state with no derivable value renders a count and no money`, () => {
    const html = render({ tabs: VALUED_TABS, variant });
    assert.ok(html.includes("12"), "the count is still shown");
    // The one money figure on the strip is the Confirmed one. Nothing that
    // could read as a zero appears next to Draft.
    const money = html.match(/RM[\s ]?[\d,]+\.\d\d/g) ?? [];
    assert.deepEqual(money, ["RM 1,342,580.93"]);
    assert.ok(!html.includes("RM 0.00"), "never a confident RM 0.00");
  });

  test(`${variant}: money renders through formatCurrency with tabular-nums`, () => {
    const html = render({ tabs: VALUED_TABS, variant });
    // RM 1,342,580.93 = 134,258,093 sen — grouped, two decimals, integer sen in.
    assert.ok(html.includes("RM 1,342,580.93"));
    assert.match(html, /class="[^"]*tabular-nums[^"]*"[^>]*>RM 1,342,580\.93/);
  });

  test(`${variant}: every RM figure carries the label that says what it is`, () => {
    const html = render({ tabs: VALUED_TABS, variant, moneyLabel: "Received value at cost" });
    assert.match(html, /title="Received value at cost"/);
    // …and the label is on screen, not only in a tooltip.
    assert.ok(html.split("Received value at cost").length > 2);
  });

  test(`${variant}: a strip with no money at all renders no money chrome`, () => {
    const html = render({
      tabs: [
        { key: "draft", label: "Draft", count: 3 },
        { key: "confirmed", label: "Confirmed", count: 4, valueSen: null },
      ],
      variant,
    });
    assert.ok(!html.includes("RM"), "no RM anywhere");
    assert.ok(!html.includes("Order value"), "and no dangling money label");
    assert.ok(html.includes("3") && html.includes("4"), "counts still render");
  });

  test(`${variant}: the counts rendered are the counts passed in`, () => {
    const html = render({
      tabs: [
        { key: "draft", label: "Draft", count: 126, valueSen: 9380650 },
        { key: "confirmed", label: "Confirmed", count: 25, valueSen: 1563100 },
      ],
      variant,
    });
    assert.ok(html.includes("126") && html.includes("25"));
    assert.ok(html.includes("RM 93,806.50") && html.includes("RM 15,631.00"));
  });
}

test("loading hides the money rather than showing a placeholder zero", () => {
  const html = render({ tabs: VALUED_TABS, loading: true });
  assert.ok(!html.includes("RM"), "no half-computed figure while loading");
  assert.ok(html.includes("369"), "counts still render");
});
