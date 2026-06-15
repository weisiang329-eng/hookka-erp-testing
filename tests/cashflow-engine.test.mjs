import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href
);

const acct = (code, type, sat = null, name = code) => ({ code, name, type, sat });

test("defaultSectionFor — debtor control → REVENUE_COLLECTION", () => {
  assert.equal(cf.defaultSectionFor(acct("300-A001", "ASSET", "SDC")), "REVENUE_COLLECTION");
  assert.equal(cf.defaultSectionFor(acct("305-0000", "REVENUE")), "REVENUE_COLLECTION");
});
test("defaultSectionFor — AP control → RAW_MATERIALS", () => {
  assert.equal(cf.defaultSectionFor(acct("400-0000", "LIABILITY", "SCC")), "RAW_MATERIALS");
});
test("defaultSectionFor — labour / overhead / general", () => {
  assert.equal(cf.defaultSectionFor(acct("750-0010", "COST")), "DIRECT_LABOUR");
  assert.equal(cf.defaultSectionFor(acct("780-0030", "COST")), "FACTORY_OVERHEAD");
  assert.equal(cf.defaultSectionFor(acct("700-1015", "COST")), "FACTORY_OVERHEAD");
  assert.equal(cf.defaultSectionFor(acct("900-0001", "EXPENSE")), "GENERAL_EXPENSE");
});
test("defaultSectionFor — capex / gst / director / fallback", () => {
  assert.equal(cf.defaultSectionFor(acct("200-0040", "ASSET")), "CAPEX");
  assert.equal(cf.defaultSectionFor(acct("350-0000", "LIABILITY")), "REVENUE_COLLECTION");
  assert.equal(cf.defaultSectionFor(acct("450-0010", "LIABILITY")), "LOAN");
  assert.equal(cf.defaultSectionFor(acct("999-9999", "EXPENSE")), "GENERAL_EXPENSE");
  assert.equal(cf.defaultSectionFor(acct("130-0000", "ASSET")), "UNALLOCATED");
});

test("rawMaterialLineFor — maps stock groups to material lines", () => {
  assert.equal(cf.rawMaterialLineFor("B.M-FABR", {}), "Purchase of Fabric");
  assert.equal(cf.rawMaterialLineFor("S-FABRIC", {}), "Purchase of Fabric");
  assert.equal(cf.rawMaterialLineFor("PLYWOOD", {}), "Purchase of Wooden");
  assert.equal(cf.rawMaterialLineFor("WD STRIP", {}), "Purchase of Wooden");
  assert.equal(cf.rawMaterialLineFor("S.FILLER", {}), "Purchase of Filler");
  assert.equal(cf.rawMaterialLineFor("B.OTHERS", {}), "Purchase of Other & Packaging");
  assert.equal(cf.rawMaterialLineFor("ANYTHING-ELSE", {}), "Purchase of Other & Packaging");
  assert.equal(cf.rawMaterialLineFor("PLYWOOD", { PLYWOOD: "Purchase of Filler" }), "Purchase of Filler");
});

test("splitByLargestRemainder — exact sen split, no lost cents", () => {
  const out = cf.splitByLargestRemainder(10000, [
    { key: "a", weight: 1 }, { key: "b", weight: 1 }, { key: "c", weight: 1 },
  ]);
  assert.equal(out.a + out.b + out.c, 10000);
  assert.deepEqual([out.a, out.b, out.c].sort((x, y) => y - x), [3334, 3333, 3333]);
});

test("splitByLargestRemainder — zero weights → all to first bucket", () => {
  const out = cf.splitByLargestRemainder(5000, [{ key: "x", weight: 0 }, { key: "y", weight: 0 }]);
  assert.equal(out.x + out.y, 5000);
});
