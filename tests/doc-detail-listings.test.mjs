// Per-line-item Detail Listing exports for PO / GRN / DO
// (src/lib/doc-detail-listings.ts). Same contract as the SO detail listing:
// one row per line item, document header repeated, money sen→RM as numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const d = await import(pathToFileURL(resolve(process.cwd(), "src/lib/doc-detail-listings.ts")).href);

test("PO detail: one row per item, header repeated, money sen→RM", () => {
  const aoa = d.buildPoDetailListingAoa([
    {
      poNo: "PO-1", orderDate: "2026-05-01T00:00:00Z", supplierName: "Foam Co",
      status: "CONFIRMED", totalSen: 150000,
      items: [
        { materialCategory: "FOAM", materialCode: "F-1", supplierSKU: "SKU-1", materialName: "D40 Foam", unit: "SHEET", quantity: 10, unitPriceSen: 12000, totalSen: 120000, receivedQty: 4 },
        { materialCode: "F-2", materialName: "Spring", quantity: 2, unitPriceSen: 15000, totalSen: 30000, receivedQty: 0 },
      ],
    },
  ]);
  assert.deepEqual(aoa[0], [...d.PO_DETAIL_HEADERS]);
  assert.equal(aoa.length, 3);
  assert.equal(aoa[1][0], "PO-1"); assert.equal(aoa[2][0], "PO-1");
  assert.equal(aoa[1][1], "2026-05-01");
  assert.equal(aoa[1][4], 1500);  // Doc Total RM
  assert.equal(aoa[1][11], 120);  // Unit Price RM
  assert.equal(aoa[1][12], 1200); // Line Total RM
  assert.equal(aoa[1][13], 4);    // Received Qty
});

test("GRN detail: line total = accepted × unit price, sen→RM", () => {
  const aoa = d.buildGrnDetailListingAoa([
    {
      grnNumber: "GRN-1", receiveDate: "2026-05-02T00:00:00Z", supplierName: "Foam Co", status: "POSTED",
      items: [
        { materialCode: "F-1", supplierSKU: "SKU-1", materialName: "D40 Foam", orderedQty: 10, receivedQty: 10, acceptedQty: 8, rejectedQty: 2, rejectionReason: "wet", unitPrice: 12000 },
      ],
    },
  ]);
  assert.deepEqual(aoa[0], [...d.GRN_DETAIL_HEADERS]);
  assert.equal(aoa[1][0], "GRN-1");
  assert.equal(aoa[1][1], "2026-05-02");
  assert.equal(aoa[1][9], 8);      // Accepted Qty
  assert.equal(aoa[1][10], 2);     // Rejected Qty
  assert.equal(aoa[1][11], "wet"); // Rejection Reason
  assert.equal(aoa[1][12], 120);   // Unit Price RM
  assert.equal(aoa[1][13], 960);   // Line Total = 8 × 120
});

test("DO detail: per-line SO/customer refs, item-less DO still yields a row", () => {
  const aoa = d.buildDoDetailListingAoa([
    {
      doNo: "DO-1", dispatchDate: "2026-05-03T00:00:00Z", customerName: "Acme", status: "DISPATCHED",
      items: [
        { salesOrderNo: "SO-9", customerPOId: "CPO-9", productCode: "P-1", productName: "Sofa", sizeLabel: "3S", fabricCode: "FB-1", quantity: 1, itemM3: 1.2, rackingNumber: "R1" },
      ],
    },
    { doNo: "DO-2", status: "PENDING", items: [] },
  ]);
  assert.deepEqual(aoa[0], [...d.DO_DETAIL_HEADERS]);
  assert.equal(aoa.length, 3, "header + DO-1 line + DO-2 placeholder");
  assert.equal(aoa[1][4], "SO-9");
  assert.equal(aoa[1][10], 1);   // Qty
  assert.equal(aoa[1][11], 1.2); // M3
  assert.equal(aoa[2][0], "DO-2"); // placeholder row keeps the header
});
