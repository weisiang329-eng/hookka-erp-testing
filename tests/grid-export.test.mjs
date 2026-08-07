// WYSIWYG grid export + AutoCount SO detail listing (src/lib/grid-export.ts,
// src/lib/so-detail-listing.ts).
//
// The owner's two hard rules: export must follow the CURRENT columns (visible,
// in order) and the CURRENT rows (whatever the filter left). And the detail
// listing must match the AutoCount 36-column shape (one row per line item,
// header repeated). These pin both.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const ge = await import(pathToFileURL(resolve(process.cwd(), "src/lib/grid-export.ts")).href);
const dl = await import(pathToFileURL(resolve(process.cwd(), "src/lib/so-detail-listing.ts")).href);

// ── WYSIWYG listing ──────────────────────────────────────────────────────
test("listing header + rows follow the columns GIVEN, in order", () => {
  const cols = [
    { key: "companySOId", label: "SO No.", type: "docno" },
    { key: "customerName", label: "Customer", type: "text" },
    { key: "totalSen", label: "Total", type: "currency" },
  ];
  const rows = [
    { companySOId: "SO-1", customerName: "Acme", totalSen: 600000 },
    { companySOId: "SO-2", customerName: "Beta", totalSen: 12345 },
  ];
  const aoa = ge.buildListingAoa(cols, rows);
  assert.deepEqual(aoa[0], ["SO No.", "Customer", "Total"]);
  assert.deepEqual(aoa[1], ["SO-1", "Acme", 6000]); // currency sen→RM as a NUMBER
  assert.deepEqual(aoa[2], ["SO-2", "Beta", 123.45]);
});

test("a hidden column simply isn't passed — export mirrors what's visible", () => {
  // The caller passes visibleColumns; dropping 'Customer' drops it from export.
  const cols = [
    { key: "companySOId", label: "SO No." },
    { key: "totalSen", label: "Total", type: "currency" },
  ];
  const aoa = ge.buildListingAoa(cols, [{ companySOId: "SO-1", customerName: "Acme", totalSen: 600000 }]);
  assert.deepEqual(aoa[0], ["SO No.", "Total"]);
  assert.deepEqual(aoa[1], ["SO-1", 6000]);
});

test("select/actions pseudo-columns are excluded", () => {
  const cols = [
    { key: "__select__", label: "" },
    { key: "companySOId", label: "SO No." },
    { key: "__actions__", label: "" },
  ];
  const aoa = ge.buildListingAoa(cols, [{ companySOId: "SO-1" }]);
  assert.deepEqual(aoa[0], ["SO No."]);
});

test("currency null → blank; date ISO → day; computed uses filterAccessor", () => {
  const cols = [
    { key: "totalSen", label: "Total", type: "currency" },
    { key: "companySODate", label: "Date", type: "date" },
    { key: "x", label: "Items", filterAccessor: (r) => r.items.length },
  ];
  const aoa = ge.buildListingAoa(cols, [{ totalSen: null, companySODate: "2026-08-05T09:00:00Z", items: [1, 2, 3] }]);
  assert.deepEqual(aoa[1], ["", "2026-08-05", 3]);
});

test("exportValue wins over everything", () => {
  const cols = [{ key: "totalSen", label: "T", type: "currency", exportValue: () => "custom" }];
  assert.equal(ge.buildListingAoa(cols, [{ totalSen: 999 }])[1][0], "custom");
});

// ── AutoCount SO detail listing ──────────────────────────────────────────
test("detail listing: 36 columns, one row per line item, header repeated", () => {
  const orders = [
    {
      companySOId: "SO-011120", companySODate: "2026-04-01T00:00:00Z",
      customerName: "Rebzuan", customerState: "KL", customerPOId: "PO-9",
      subtotalSen: 600000, totalSen: 600000, status: "CONFIRMED",
      items: [
        { itemCategory: "MATTRESS", productCode: "AK-ULT", productName: "AKEMI ULTIMATE", quantity: 1, unitPriceSen: 600000, lineTotalSen: 600000 },
        { itemCategory: "BEDFRAME", productCode: "HOK-2008", productName: "TRION", quantity: 1, unitPriceSen: 0, lineTotalSen: 0, divanHeightInches: 8, gapInches: 14, specialOrder: "Col:TBC" },
      ],
    },
  ];
  const aoa = dl.buildSoDetailListingAoa(orders);
  assert.equal(aoa[0].length, 36, "36 columns");
  assert.deepEqual(aoa[0], [...dl.SO_DETAIL_HEADERS]);
  assert.equal(aoa.length, 3, "header + 2 item rows");
  // Header fields repeat on every line:
  assert.equal(aoa[1][1], "SO-011120");
  assert.equal(aoa[2][1], "SO-011120");
  assert.equal(aoa[1][2], "2026-04-01"); // date → day
  assert.equal(aoa[1][10], 6000); // Total (header) sen→RM
  assert.equal(aoa[2][10], 6000);
  // Per-line fields differ:
  assert.equal(aoa[1][16], "MATTRESS"); // Item Group
  assert.equal(aoa[2][16], "BEDFRAME");
  assert.equal(aoa[1][23], 6000); // Unit Price (line 1)
  assert.equal(aoa[2][23], 0); // Unit Price (line 2)
});

test("detail listing: spec line built from divan/leg/gap/special", () => {
  assert.equal(
    dl.detailDescription2({ divanHeightInches: 8, gapInches: 14, specialOrder: "Col:TBC" }),
    "div:8inch / gap:14inch / Col:TBC",
  );
  assert.equal(dl.detailDescription2({}), "");
});

test("detail listing: cancelled flag, and an item-less order still yields one row", () => {
  const aoa = dl.buildSoDetailListingAoa([{ companySOId: "SO-X", status: "CANCELLED", items: [] }]);
  assert.equal(aoa.length, 2, "header + one placeholder row");
  assert.equal(aoa[1][12], "T"); // Cancelled
});

test("detail listing: Inclusive=T, UOM by category, BALANCE=0", () => {
  const aoa = dl.buildSoDetailListingAoa([
    { companySOId: "SO-1", items: [
      { itemCategory: "BEDFRAME" }, { itemCategory: "SOFA" }, { itemCategory: "ACCESSORY" },
    ] },
  ]);
  assert.equal(aoa[1][7], "T"); // Inclusive?
  assert.equal(aoa[1][19], "SET");  // bedframe → SET
  assert.equal(aoa[2][19], "SET");  // sofa → SET
  assert.equal(aoa[3][19], "UNIT"); // accessory → UNIT
  assert.equal(aoa[1][32], 0); // BALANCE numeric 0
});

test("detail listing: Debtor Code + Agent come from caller lookups by customerId", () => {
  const orders = [
    { companySOId: "SO-1", customerId: "cust-a", items: [{ itemCategory: "BEDFRAME" }] },
    { companySOId: "SO-2", customerId: "cust-x", items: [{ itemCategory: "SOFA" }] }, // no lookup entry
  ];
  const opts = {
    debtorCodeByCustomerId: new Map([["cust-a", "300-C002"]]),
    agentByCustomerId: new Map([["cust-a", "STANLEY"]]),
  };
  const aoa = dl.buildSoDetailListingAoa(orders, opts);
  assert.equal(aoa[1][3], "300-C002"); // Debtor Code
  assert.equal(aoa[1][5], "STANLEY");  // Agent
  assert.equal(aoa[2][3], ""); // unknown customer → blank, never invented
  assert.equal(aoa[2][5], "");
});
