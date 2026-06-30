import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/product-line-rm.ts")).href);

// ---------------------------------------------------------------------------
// rmLineOf — classification
// ---------------------------------------------------------------------------
test("rmLineOf: B.M-FABR → bedframe", () => {
  assert.equal(m.rmLineOf("B.M-FABR"), "bedframe");
});
test("rmLineOf: B.ACCE → bedframe", () => {
  assert.equal(m.rmLineOf("B.ACCE"), "bedframe");
});
test("rmLineOf: S.M-FABR → sofa", () => {
  assert.equal(m.rmLineOf("S.M-FABR"), "sofa");
});
test("rmLineOf: S-FABRIC → sofa", () => {
  assert.equal(m.rmLineOf("S-FABRIC"), "sofa");
});
test("rmLineOf: S.ACC → sofa", () => {
  assert.equal(m.rmLineOf("S.ACC"), "sofa");
});
test("rmLineOf: PLYWOOD → shared", () => {
  assert.equal(m.rmLineOf("PLYWOOD"), "shared");
});
test("rmLineOf: WD STRIP → shared", () => {
  assert.equal(m.rmLineOf("WD STRIP"), "shared");
});
test("rmLineOf: MAINTENA → shared", () => {
  assert.equal(m.rmLineOf("MAINTENA"), "shared");
});
test("rmLineOf: PACKING → shared", () => {
  assert.equal(m.rmLineOf("PACKING"), "shared");
});

// ---------------------------------------------------------------------------
// rmScale — line view scale factors
// ---------------------------------------------------------------------------
test("rmScale: bedframe code in sofa view = 0", () => {
  assert.equal(m.rmScale("B.M-FABR", "sofa", 0.6), 0);
});
test("rmScale: bedframe code in bedframe view = 1", () => {
  assert.equal(m.rmScale("B.M-FABR", "bedframe", 0.6), 1);
});
test("rmScale: sofa code in sofa view = 1", () => {
  assert.equal(m.rmScale("S.M-FABR", "sofa", 0.6), 1);
});
test("rmScale: sofa code in bedframe view = 0", () => {
  assert.equal(m.rmScale("S.M-FABR", "bedframe", 0.6), 0);
});
test("rmScale: shared code in sofa view = salesRatio", () => {
  assert.equal(m.rmScale("PLYWOOD", "sofa", 0.6), 0.6);
});
test("rmScale: shared code in bedframe view = salesRatio", () => {
  assert.equal(m.rmScale("PLYWOOD", "bedframe", 0.4), 0.4);
});
test("rmScale: any code in all view = 1", () => {
  assert.equal(m.rmScale("B.M-FABR", "all", 0.6), 1);
  assert.equal(m.rmScale("S.M-FABR", "all", 0.6), 1);
  assert.equal(m.rmScale("PLYWOOD", "all", 0.6), 1);
});
