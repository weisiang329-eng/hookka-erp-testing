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

const coaMap = new Map([
  ["300-0000", acct("300-0000", "ASSET", "SDC")],
  ["350-0000", acct("350-0000", "LIABILITY", null, "GST Payables")],
  ["400-0000", acct("400-0000", "LIABILITY", "SCC")],
  ["750-0010", acct("750-0010", "COST", null, "Production Salary")],
  ["700-0010", acct("700-0010", "COST", null, "Rental - factory")],
  ["900-0001", acct("900-0001", "EXPENSE", null, "Transport expense")],
  ["200-0040", acct("200-0040", "ASSET", null, "Factory Equipment")],
  ["450-0010", acct("450-0010", "LIABILITY", null, "Director - Lim Wei Siang")],
  ["310-0010", acct("310-0010", "ASSET", "SBK", "Cash at bank")],
]);
const L = (accountCode, creditSen, debitSen, ym, sourceType = "x", sourceId = "s") =>
  ({ accountCode, creditSen, debitSen, ym, sourceType, sourceId });

test("buildStatement — reconciles c/f = b/f + cash surplus", () => {
  const classified = [
    L("300-0000", 100000, 0, "2026-03"),
    L("400-0000", 0, 60000, "2026-03", "supplier_payment", "PI1"),
    L("900-0001", 0, 15000, "2026-03"),
    L("450-0010", 12500, 0, "2026-03"),
  ];
  const bankLegs = [
    { accountCode: "310-0010", debitSen: 100000, creditSen: 0, ym: "2026-03" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 60000, ym: "2026-03" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 15000, ym: "2026-03" },
    { accountCode: "310-0010", debitSen: 12500, creditSen: 0, ym: "2026-03" },
  ];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coaMap, map: {},
    rmSplit: { PI1: [{ line: "Purchase of Fabric", weight: 1 }] },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const cfRow = st.rows.find((r) => r.kind === "cf");
  const bfRow = st.rows.find((r) => r.kind === "bf");
  const totRow = st.rows.find((r) => r.kind === "total");
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  assert.equal(totRow.values[mIdx], 37500);
  assert.equal(cfRow.values[mIdx], bfRow.values[mIdx] + totRow.values[mIdx]);
});

test("buildStatement — raw materials split into material lines", () => {
  const classified = [L("400-0000", 0, 90000, "2026-03", "supplier_payment", "PI1")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 90000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coaMap, map: {},
    rmSplit: { PI1: [
      { line: "Purchase of Fabric", weight: 60000 },
      { line: "Purchase of Wooden", weight: 30000 },
    ] },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const fabric = st.rows.find((r) => r.label === "Purchase of Fabric");
  const wooden = st.rows.find((r) => r.label === "Purchase of Wooden");
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  assert.equal(fabric.values[mIdx], 60000);
  assert.equal(wooden.values[mIdx], 30000);
});

test("buildStatement — unmapped contra account lands in Unallocated", () => {
  const coa2 = new Map(coaMap);
  coa2.set("130-0000", acct("130-0000", "ASSET", null, "Mystery"));
  const classified = [L("130-0000", 0, 5000, "2026-03")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 5000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coa2, map: {}, rmSplit: {},
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  assert.ok(st.rows.some((r) => r.section === "UNALLOCATED" && r.kind === "line"));
});
