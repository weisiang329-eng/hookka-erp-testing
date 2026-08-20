// ---------------------------------------------------------------------------
// grid-export-coverage.test.mjs — the WYSIWYG export reaches the lists that
// lacked it, and still exports only what the operator can see.
//
// The engine (src/lib/grid-export.ts + src/lib/doc-detail-listings.ts) was
// wired to four pages: Sales Orders, Purchase Orders, GRN, Delivery Orders.
// This adds Invoices, Purchase Invoices, Consignment Orders and Customers.
//
// The load-bearing property is row visibility, not the file format: the export
// is built in the browser from the rows the grid already holds — which came
// from the customer-scoped API — over the CURRENTLY visible columns. It can
// therefore never widen what a scoped salesperson sees. These pin that the
// export reads `sortedData` (post-filter, post-search) and NOT the raw `data`,
// and that it never re-fetches behind the scope middleware's back.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const dl = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/doc-detail-listings.ts")).href
);

// ── Consignment Order detail listing ───────────────────────────────────────

const CO = {
  companyCOId: "CO-0001",
  companyCODate: "2026-08-01T00:00:00.000Z",
  customerCOId: "THEIR-77",
  customerName: "Acme Bedding",
  customerState: "Selangor",
  hubName: "Shah Alam",
  status: "CONFIRMED",
  totalSen: 1_250_00,
  items: [
    {
      itemCategory: "SOFA",
      productCode: "SF-01",
      productName: "Milano 3-Seater",
      sizeLabel: "3S",
      fabricCode: "F-220",
      quantity: 2,
      unitPriceSen: 50_000,
      discountSen: 5_000,
      lineTotalSen: 95_000,
    },
    {
      itemCategory: "ACCESSORY",
      productCode: "AC-09",
      productName: "Scatter Cushion",
      sizeLabel: "",
      fabricCode: "F-220",
      quantity: 4,
      unitPriceSen: 7_500,
      discountSen: 0,
      lineTotalSen: 30_000,
    },
  ],
};

test("CO detail listing is ONE ROW PER LINE with the header repeated", () => {
  const aoa = dl.buildCoDetailListingAoa([CO]);
  assert.deepEqual(aoa[0], [...dl.CO_DETAIL_HEADERS]);
  assert.equal(aoa.length, 3, "header + 2 lines");
  // Header fields repeat on every line.
  assert.equal(aoa[1][0], "CO-0001");
  assert.equal(aoa[2][0], "CO-0001");
  assert.equal(aoa[1][1], "2026-08-01", "an ISO timestamp exports as its day");
  assert.equal(aoa[1][2], "THEIR-77");
});

test("CO detail money exports as a summable RM number, not a sen integer", () => {
  const aoa = dl.buildCoDetailListingAoa([CO]);
  const i = dl.CO_DETAIL_HEADERS.indexOf("Line Total");
  assert.equal(aoa[1][i], 950);
  assert.equal(aoa[2][i], 300);
  assert.equal(aoa[1][dl.CO_DETAIL_HEADERS.indexOf("Unit Price")], 500);
  assert.equal(aoa[1][dl.CO_DETAIL_HEADERS.indexOf("Discount")], 50);
  assert.equal(aoa[1][dl.CO_DETAIL_HEADERS.indexOf("Doc Total")], 1250);
});

test("a CO with no lines still exports one row — the order does not vanish", () => {
  const aoa = dl.buildCoDetailListingAoa([{ ...CO, items: [] }]);
  assert.equal(aoa.length, 2);
  assert.equal(aoa[1][0], "CO-0001");
  assert.equal(aoa[1][dl.CO_DETAIL_HEADERS.indexOf("Qty")], 0);
});

test("the CO listing reads CO field names, never the SO ones", () => {
  // consignment_orders has no customerPOId / companySOId column, so reading SO
  // names here would export a column of blanks that looks like missing data.
  // (The list page used to annotate its rows as SalesOrder, which is where the
  // confusion came from — fixed 2026-08-08, see the test below.)
  const src = readFileSync("src/lib/doc-detail-listings.ts", "utf8");
  const co = src.slice(src.indexOf("CODetailOrder"), src.indexOf("DoDetailItem"));
  assert.doesNotMatch(co, /companySOId|customerPOId/);
  assert.match(co, /companyCOId/);

  // And proven at runtime: an SO-shaped row exports blanks, a CO-shaped one
  // does not — which is why the field names matter.
  const wrong = dl.buildCoDetailListingAoa([
    { companySOId: "SO-1", customerPOId: "PO-1", items: [] },
  ]);
  assert.equal(wrong[1][0], "");
});

test("the CO list page shows no column the CO route cannot fill", () => {
  // The grid and the CSV both carried a "Customer PO" column. There is no
  // customer-PO column on consignment_orders and rowToCOList never emits one,
  // so it could only ever render blank — which reads as missing data, not as a
  // field that does not apply. The page's rows are ConsignmentOrder now, not an
  // alias of it named SalesOrder, so the compiler can say so.
  const page = readFileSync("src/pages/consignment/index.tsx", "utf8");
  assert.doesNotMatch(
    page,
    /key: "customerPOId"/,
    "the grid must not offer a column the route never fills",
  );
  assert.doesNotMatch(page, /o\.customerPOId/, "nor export one");
  assert.doesNotMatch(
    page,
    /ConsignmentOrder as SalesOrder/,
    "CO rows must not be annotated as sales orders",
  );

  // Every column key the grid renders must be a field the route actually
  // returns. rowToCO + rowToCOList are the contract; read the keys straight
  // out of them.
  const route = readFileSync("src/api/routes/consignment-orders.ts", "utf8");
  const rowToCo = route.slice(
    route.indexOf("function rowToCO("),
    route.indexOf("function rowToCOListItem("),
  );
  const emitted = new Set(
    [...rowToCo.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]),
  );
  assert.ok(emitted.has("companyCOId") && emitted.has("customerCOId"));

  const columnKeys = [...page.matchAll(/\{ key: "(\w+)", label:/g)].map((m) => m[1]);
  assert.ok(columnKeys.length > 5, "the grid's columns must be parseable");
  const orphans = columnKeys.filter((k) => !emitted.has(k));
  assert.deepEqual(orphans, [], "a column the route never fills is always blank");
});

// ── Coverage ───────────────────────────────────────────────────────────────

const EXPORT_PAGES = {
  // Already had it before this task — regression guard. (Sales names its
  // export from the page's dual SO/service-order mode, hence the loose match.)
  "src/pages/sales/index.tsx": "sales-orders",
  "src/pages/procurement/index.tsx": "purchase-orders",
  "src/pages/procurement/grn.tsx": "goods-receipts",
  "src/pages/delivery/index.tsx": "delivery-orders",
  // Added here.
  "src/pages/invoices/index.tsx": "invoices",
  "src/pages/procurement/pi.tsx": "purchase-invoices",
  "src/pages/consignment/index.tsx": "consignment-orders",
  "src/pages/customers.tsx": "customers",
};

for (const [file, name] of Object.entries(EXPORT_PAGES)) {
  test(`${file} offers the WYSIWYG export as "${name}"`, () => {
    const src = readFileSync(file, "utf8");
    assert.match(src, new RegExp(`exportName=(?:"${name}"|\\{[^\\n]*"${name}")`));
  });
}

test("Consignment Orders also offers the per-line detail listing", () => {
  const src = readFileSync("src/pages/consignment/index.tsx", "utf8");
  assert.match(src, /buildCoDetailListingAoa/);
  assert.match(src, /detailExport=\{\{/);
});

test("a list with no line items in its payload may only detail-export if it fetches them", () => {
  // Invoices and Purchase Invoices ship rows with no items[] (a deliberate
  // list-payload trim). Wiring a per-line export straight to those rows would
  // download a page of blank line columns and read as data loss — that is the
  // fault this guard exists to stop, and it still does.
  //
  // What it USED to assert was narrower and, by 2026-08-20, wrong: that these
  // pages must have NO detailExport at all. The owner asked for exactly that
  // export ("check details listing price"), and the real requirement was never
  // "don't offer it" — it was "don't offer it without the fetch". A guard
  // written as "this feature must not exist" cannot tell the difference between
  // the feature being absent and the feature being done properly; it just
  // blocks both. Same shape as the assertion that pinned BUG-2026-08-20-158 in
  // place by requiring the defective line to stay.
  //
  // So the rule is now the real one: no detailExport, OR a builder that goes
  // and gets the lines.
  for (const f of ["src/pages/invoices/index.tsx", "src/pages/procurement/pi.tsx"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /exportName=/, `${f} should still offer Listing`);
    if (!/detailExport=/.test(src)) continue;
    assert.match(
      src,
      /buildInvoiceDetailRows|DetailRows\(/,
      `${f} offers a Detail Listing, so it must fetch the lines rather than ` +
        `map the trimmed list rows`,
    );
  }
  // The premise stays checked: if the list mapper ever starts shipping items,
  // the fetch becomes unnecessary and this whole rule can go.
  assert.match(
    readFileSync("src/api/routes/invoices.ts", "utf8"),
    /items: \[\]/,
    "the invoices list mapper must still be shipping empty items",
  );
});

test("the invoice detail export fetches per invoice and paces itself", () => {
  // The reason the export did not exist for three months. Each invoice costs
  // two requests and this API aborts under load, so the builder must go one at
  // a time with a gap — not fire them all and hand back a half-file.
  const src = readFileSync("src/lib/invoice-detail-export.ts", "utf8");
  assert.match(src, /DETAIL_EXPORT_GAP_MS/, "there must be a deliberate gap");
  assert.match(src, /DETAIL_EXPORT_CAP/, "and a cap that asks before a long run");
  assert.match(
    src,
    /EXPORT FAILED/,
    "an invoice that cannot be read must be REPORTED in the file, never skipped",
  );
});

// ── Scope safety ───────────────────────────────────────────────────────────

test("the export reads the FILTERED rows and the VISIBLE columns, never raw data", () => {
  const src = readFileSync("src/components/ui/data-grid.tsx", "utf8");
  assert.match(
    src,
    /buildListingAoa\(visibleColumns as unknown as ExportColumn<T>\[\], sortedData\)/,
    "listing must be built from visibleColumns × sortedData",
  );
  assert.match(
    src,
    /detailExport\.build\(sortedData\)/,
    "the detail listing must also be built from the filtered rows",
  );
});

test("no export path re-fetches around the customer-scope middleware", () => {
  // The rows are whatever the scoped API already returned to this page; the
  // export is a pure client-side transform of them. A fetch inside the export
  // menu would be the way that guarantee gets lost.
  const src = readFileSync("src/components/ui/data-grid.tsx", "utf8");
  const start = src.indexOf("{/* Export — WYSIWYG");
  const end = src.indexOf("{/* Column customizer */}");
  assert.ok(start > 0 && end > start, "export menu block should be locatable");
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /fetch\(/, "the export block must not call the API");

  // Invoices / customers / consignment are all scoped prefixes, so the rows
  // reaching those grids are already narrowed for a SALES user.
  const scope = readFileSync("src/api/lib/customer-scope.ts", "utf8");
  for (const p of ["/api/invoices", "/api/customers", "/api/consignment-orders"]) {
    assert.ok(scope.includes(`"${p}"`), `${p} must stay a scoped prefix`);
  }
});
