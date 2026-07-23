// ---------------------------------------------------------------------------
// invoice-pdf-breakdown.test.mjs — the customer invoice PDF must itemise the
// Price column (Base + Divan + Leg + T.Height + Special = unit), the way the
// pre-unified jsPDF invoice did. The "unified" rewrite (4aa6b1fa) dropped it;
// this locks the restore in.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  invoicePriceBreakdown,
  buildUnifiedInvoiceData,
} from "../src/lib/build-unified-doc-data.ts";

test("no surcharge → undefined (Price column shows the single price)", () => {
  assert.equal(invoicePriceBreakdown({ baseSen: 83000 }, 83000), undefined);
  assert.equal(invoicePriceBreakdown(undefined, 83000), undefined);
});

test("components that don't reconcile to the charge → undefined (never print a wrong sum)", () => {
  // combo-redistributed sofa: base != charge, no surcharge column → single price
  assert.equal(invoicePriceBreakdown({ baseSen: 109424, divanSen: 0 }, 109424), undefined);
  // base + surcharge != charge → refuse to itemise
  assert.equal(invoicePriceBreakdown({ baseSen: 80000, totalHeightSen: 8000 }, 90000), undefined);
});

test("base + surcharges that reconcile → itemised rows ending in '='", () => {
  const rows = invoicePriceBreakdown(
    { baseSen: 83000, divanSen: 0, legSen: 0, totalHeightSen: 8000, specialSen: 0 },
    91000,
  );
  assert.deepEqual(rows, [
    { label: "Base", sen: 83000 },
    { label: "+ T.Height", sen: 8000 },
    { label: "=", sen: 91000 },
  ]);
});

test("all four surcharges appear in order", () => {
  const rows = invoicePriceBreakdown(
    { baseSen: 28750, divanSen: 13000, legSen: 5000, totalHeightSen: 4000, specialSen: 16000 },
    66750,
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Base", "+ Divan", "+ Leg", "+ T.Height", "+ Special", "="],
  );
  assert.equal(rows.at(-1).sen, 66750);
});

test("buildUnifiedInvoiceData attaches priceBreakdown on a surcharged line", () => {
  const data = buildUnifiedInvoiceData({
    invoiceNo: "INV-TEST-001",
    docDate: "2026-07-23",
    customerName: "Test",
    items: [
      {
        id: "i1", productCode: "2009(A)-(K)", productName: "TRION", quantity: 1,
        priceSen: 91000, lineTotalSen: 91000,
        extra: { itemCategory: "BEDFRAME", baseSen: 83000, totalHeightSen: 8000 },
      },
      {
        id: "i2", productCode: "SOFA-X", productName: "Sofa", quantity: 1,
        priceSen: 109424, lineTotalSen: 109424,
        extra: { itemCategory: "SOFA", baseSen: 109424 }, // combo → no breakdown
      },
    ],
    subtotalSen: 200424, totalSen: 200424,
  });
  const lines = data.groups.flatMap((g) => g.items);
  const bed = lines.find((l) => l.code === "2009(A)-(K)");
  const sofa = lines.find((l) => l.code === "SOFA-X");
  assert.ok(bed.priceBreakdown, "bedframe line itemises");
  assert.equal(bed.priceBreakdown.at(-1).sen, 91000);
  assert.equal(sofa.priceBreakdown, undefined, "combo sofa stays single price");
});
