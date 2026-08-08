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
  // consignment_orders has no customerPOId / companySOId column. The list page
  // annotates its rows as SalesOrder, so reading SO names here would export a
  // column of blanks that looks like missing data.
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

test("lists whose payload has no line items offer Listing ONLY", () => {
  // Invoices and Purchase Invoices ship rows with no items[] (a deliberate
  // list-payload trim / mapper). Offering a per-line export there would
  // download a page of blank line columns and read as data loss.
  for (const f of ["src/pages/invoices/index.tsx", "src/pages/procurement/pi.tsx"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /exportName=/, `${f} should still offer Listing`);
    assert.doesNotMatch(src, /detailExport=/, `${f} has no line items to detail`);
  }
  // And the reason is real, not assumed: the routes say so.
  assert.match(
    readFileSync("src/api/routes/invoices.ts", "utf8"),
    /items: \[\]/,
    "the invoices list mapper must still be shipping empty items",
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
