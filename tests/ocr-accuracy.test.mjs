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
const { diffSalesOrderSample, diffSupplierSample, emptyBucket, addToBucket, rateOf, topFails } = core;

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
