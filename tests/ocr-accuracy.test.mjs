import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const core = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/ocr-accuracy-core.ts")).href
);
const { diffSalesOrderSample, diffSupplierSample, salesOrderLineDiffs, emptyBucket, addToBucket, rateOf, topFails } = core;

test("SO: identical extraction → success, no changed fields", () => {
  const po = { customerPO: "PO-1", customerName: "Houzs", items: [{ productCode: "5543-1B", quantity: 2, fabricCode: "M2402-4", sizeCode: "28" }] };
  const d = diffSalesOrderSample(po, JSON.parse(JSON.stringify(po)));
  assert.equal(d.changed, false);
  assert.deepEqual(d.fields, []);
});

test("SO: case/number noise is NOT a change (5 == '5', lowercase code)", () => {
  const raw = { customerPO: "po-1", items: [{ productCode: "5543-1b", quantity: 2 }] };
  const corr = { customerPO: "PO-1", items: [{ productCode: "5543-1B", quantity: "2" }] };
  assert.equal(diffSalesOrderSample(raw, corr).changed, false);
});

test("SO: operator fixes product code → fail, reason lists Product code", () => {
  const raw = { items: [{ productCode: "5543-1C", quantity: 2 }] };
  const corr = { items: [{ productCode: "5543-1B", quantity: 2 }] };
  const d = diffSalesOrderSample(raw, corr);
  assert.equal(d.changed, true);
  assert.ok(d.fields.includes("Product code"));
});

test("SO: qty + fabric both edited → both fields reported", () => {
  const raw = { items: [{ productCode: "X", quantity: 5, fabricCode: "A" }] };
  const corr = { items: [{ productCode: "X", quantity: 3, fabricCode: "B" }] };
  const d = diffSalesOrderSample(raw, corr);
  assert.deepEqual(d.fields.sort(), ["Fabric code", "Qty"]);
});

test("SO: operator removes a line → fail (Line added/removed)", () => {
  const raw = { items: [{ productCode: "X" }, { productCode: "Y" }] };
  const corr = { items: [{ productCode: "X" }] };
  assert.ok(diffSalesOrderSample(raw, corr).fields.includes("Line added/removed"));
});

test("Supplier: identical multi-doc envelope → success", () => {
  const env = { docs: [{ docNo: "INV-1", lines: [{ supplierCode: "F22", qty: 10, unitPrice: 5 }] }] };
  assert.equal(diffSupplierSample(env, JSON.parse(JSON.stringify(env))).changed, false);
});

test("Supplier: operator fixes unit price → fail (Unit price)", () => {
  const raw = { docs: [{ docNo: "INV-1", lines: [{ supplierCode: "F22", qty: 10, unitPrice: 5 }] }] };
  const corr = { docs: [{ docNo: "INV-1", lines: [{ supplierCode: "F22", qty: 10, unitPrice: 5.5 }] }] };
  assert.ok(diffSupplierSample(raw, corr).fields.includes("Unit price"));
});

test("Supplier: legacy single-doc shape (no docs[]) still compares", () => {
  const raw = { docNo: "INV-1", lines: [{ supplierCode: "F22", qty: 10 }] };
  const corr = { docNo: "INV-1", lines: [{ supplierCode: "F99", qty: 10 }] };
  assert.ok(diffSupplierSample(raw, corr).fields.includes("Material code"));
});

test("aggregation: bucket rate + topFails", () => {
  const b = emptyBucket("Houzs");
  addToBucket(b, { changed: false, fields: [] });
  addToBucket(b, { changed: true, fields: ["Fabric code"] });
  addToBucket(b, { changed: true, fields: ["Fabric code", "Qty"] });
  addToBucket(b, { changed: false, fields: [] });
  assert.equal(b.total, 4);
  assert.equal(b.success, 2);
  assert.equal(rateOf(b), 50);
  assert.deepEqual(topFails(b.failFields, 2), ["Fabric code (2)", "Qty (1)"]);
});

test("rateOf null on empty bucket", () => {
  assert.equal(rateOf(emptyBucket("x")), null);
});

// ---------------------------------------------------------------------------
// The envelope regression (owner 2026-08-05: "它的 sales order 那个 success
// rate 那么低的吗？0%哦？").
//
// Since multi-PO scanning, `rawExtracted` holds the whole document —
// `{ pos: [ … ] }` — while `correctedJson` holds the single PO that was
// imported. Diffing an envelope against a PO reads customerPO and items off an
// object that has neither, so every scan failed: 49 of 49, including ones that
// were byte-for-byte identical to what the operator imported.
// ---------------------------------------------------------------------------
test("an untouched PO inside an envelope is a success, not a fail", () => {
  const po = {
    customerPO: "PO/2608-013",
    customerName: "Carres Sdn. Bhd.",
    items: [{ productCode: "5531-2A(LHF)", sizeCode: "L", fabricCode: "KN390-14", quantity: 1 }],
  };
  const d = diffSalesOrderSample({ pos: [po] }, po);
  assert.equal(d.changed, false, `unchanged scan reported as changed: ${d.fields}`);
});

test("the envelope is matched by PO number, never by position", () => {
  // A real sample: page 1 was PO/2608-027, the imported row was PO/2608-029.
  // Taking pos[0] would compare two different orders and call every field edited.
  const first = { customerPO: "PO/2608-027", customerName: "Carres", items: [{ productCode: "1013-(Q)", quantity: 1 }] };
  const second = { customerPO: "PO/2608-029", customerName: "Carres", items: [{ productCode: "1013-(K)", quantity: 1 }] };
  const env = { pos: [first, second] };
  assert.equal(diffSalesOrderSample(env, second).changed, false);
  assert.equal(diffSalesOrderSample(env, first).changed, false);

  // And a genuine edit inside an envelope is still caught.
  const edited = { ...second, items: [{ productCode: "1013-(Q)", quantity: 1 }] };
  const d = diffSalesOrderSample(env, edited);
  assert.equal(d.changed, true);
  assert.deepEqual(d.fields, ["Product code"]);
});

test("line diffs read the matching PO too", () => {
  const first = { customerPO: "PO/2608-027", items: [{ productCode: "AAA", quantity: 1 }] };
  const second = { customerPO: "PO/2608-029", items: [{ productCode: "BBB", quantity: 2 }] };
  const lines = salesOrderLineDiffs({ pos: [first, second] }, second);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].changed, false, `line reported changed: ${lines[0].fields}`);
});

test("a legacy flat sample still compares the old way", () => {
  const flat = { customerPO: "PO/1", customerName: "X", items: [{ productCode: "A", quantity: 1 }] };
  assert.equal(diffSalesOrderSample(flat, flat).changed, false);
  assert.equal(diffSalesOrderSample(flat, { ...flat, customerPO: "PO/2" }).changed, true);
});

test("a supplier envelope narrows to the imported document", () => {
  const a = { docNo: "K26050470", supplierName: "SUNMAT", lines: [{ supplierCode: "AM275-1", qty: 20, unitPrice: 21 }] };
  const b = { docNo: "K26050471", supplierName: "SUNMAT", lines: [{ supplierCode: "KN390-2", qty: 5, unitPrice: 30 }] };
  assert.equal(diffSupplierSample({ docs: [a, b] }, b).changed, false);
  const d = diffSupplierSample({ docs: [a, b] }, { ...b, lines: [{ supplierCode: "KN390-9", qty: 5, unitPrice: 30 }] });
  assert.equal(d.changed, true);
  assert.deepEqual(d.fields, ["Material code"]);
});
