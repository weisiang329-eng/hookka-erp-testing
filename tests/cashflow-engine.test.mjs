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

test("buildStatement — account lines carry accountCode", () => {
  const classified = [L("900-0001", 0, 15000, "2026-03")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 15000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coaMap, map: {}, rmSplit: {},
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const line = st.rows.find((r) => r.kind === "line" && r.label === "Transport expense");
  assert.equal(line.accountCode, "900-0001");
});

test("buildStatement — raw-material split lines have no accountCode", () => {
  const classified = [L("400-0000", 0, 9000, "2026-03", "supplier_payment", "PI1")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 9000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coaMap, map: {},
    rmSplit: { PI1: [{ line: "Purchase of Fabric", weight: 1 }] },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const fabric = st.rows.find((r) => r.label === "Purchase of Fabric");
  assert.equal(fabric.accountCode, undefined);
});

// Owner 2026-09-04 「可以自动分一下父子account吗？」— lines nest one level under
// their COA parent; stock-group RM rows join the purchase parent of their
// template category. Parent rows are kind "group" with hierarchical groupId
// "<SECTION>><parentCode>" so the UI's collapse logic sees the ancestry.
test("buildStatement — account lines nest under their COA parent with a subtotal", () => {
  const coa2 = new Map(coaMap);
  coa2.set("900-S001", acct("900-S001", "EXPENSE", null, "SALARIES & CONTRIBUTION"));
  coa2.set("900-S005", { ...acct("900-S005", "EXPENSE", null, "STAFFS' EPF"), parentCode: "900-S001" });
  coa2.set("900-S002", { ...acct("900-S002", "EXPENSE", null, "STAFFS' SALARIES"), parentCode: "900-S001" });
  const classified = [
    L("900-S005", 0, 10000, "2026-03"),
    L("900-S002", 0, 90000, "2026-03"),
    L("900-0001", 0, 15000, "2026-03"), // parentless → stays flat
  ];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 115000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coa2, map: {}, rmSplit: {},
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  const parent = st.rows.find((r) => r.kind === "group" && r.label === "SALARIES & CONTRIBUTION");
  assert.ok(parent, "parent cluster row missing");
  assert.equal(parent.groupId, "GENERAL_EXPENSE>900-S001");
  assert.equal(parent.accountCode, "900-S001");
  assert.equal(parent.values[mIdx], 100000); // outflow sections display payments positive
  const child = st.rows.find((r) => r.kind === "line" && r.label === "STAFFS' EPF");
  assert.equal(child.groupId, "GENERAL_EXPENSE>900-S001");
  assert.equal(child.depth, parent.depth + 1);
  const flatRow = st.rows.find((r) => r.kind === "line" && r.label === "Transport expense");
  assert.equal(flatRow.groupId, "GENERAL_EXPENSE"); // untouched
  // The section subtotal still covers everything once.
  const ge = st.rows.find((r) => r.kind === "group" && r.section === "GENERAL_EXPENSE" && r.groupId === "GENERAL_EXPENSE");
  assert.equal(ge.values[mIdx], 115000);
});

test("buildStatement — a lone COA child stays flat; RM stock rows join their purchase parent", () => {
  const coa2 = new Map(coaMap);
  coa2.set("900-S001", acct("900-S001", "EXPENSE", null, "SALARIES & CONTRIBUTION"));
  coa2.set("900-S005", { ...acct("900-S005", "EXPENSE", null, "STAFFS' EPF"), parentCode: "900-S001" });
  coa2.set("701-0000", acct("701-0000", "COST", null, "PURCHASE - FABRIC"));
  const classified = [
    L("900-S005", 0, 10000, "2026-03"), // only child → no cluster
    L("400-0000", 0, 9000, "2026-03", "supplier_payment", "PI1"),
  ];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 19000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coa2, map: {},
    rmSplit: { PI1: [{ line: "B.M-FABR", weight: 1 }] },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  assert.equal(st.rows.some((r) => r.kind === "group" && r.label === "SALARIES & CONTRIBUTION"), false);
  const epf = st.rows.find((r) => r.kind === "line" && r.label === "STAFFS' EPF");
  assert.equal(epf.groupId, "GENERAL_EXPENSE");
  // B.M-FABR maps to "Purchase of Fabric" → parent 701-0000, kept even alone.
  const fabricParent = st.rows.find((r) => r.kind === "group" && r.label === "PURCHASE - FABRIC");
  assert.ok(fabricParent, "RM category parent missing");
  assert.equal(fabricParent.groupId, "RAW_MATERIALS>701-0000");
  const stock = st.rows.find((r) => r.kind === "line" && r.label === "B.M-FABR");
  assert.equal(stock.groupId, "RAW_MATERIALS>701-0000");
});

test("buildStatement — editable emits empty section headers as drop targets", () => {
  const classified = [L("900-0001", 0, 15000, "2026-03")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 15000, ym: "2026-03" }];
  const base = {
    classified, bankLegs, coa: coaMap, map: {}, rmSplit: {},
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  };
  const off = cf.buildStatement(base);
  const on = cf.buildStatement({ ...base, editable: true });
  const hasDeposit = (st) => st.rows.some((r) => r.kind === "group" && r.section === "DEPOSIT");
  assert.equal(hasDeposit(off), false);
  assert.equal(hasDeposit(on), true);
});

test("buildStatement — RM block orders groups, payees, opening, advance, unallocated", () => {
  // Owner 2026-08-27 「必须要知道还什么」: creditor settlements the split can
  // name (other-creditor payees, opening PIs, advances) get labelled rows in a
  // fixed order; "Unallocated raw material" is always the last RM line.
  const classified = [
    L("400-0000", 0, 10000, "2026-03", "supplier_payment", "PV-1"),
    L("400-0000", 0, 20000, "2026-03", "other_party_payment", "HPV-1"),
    L("400-0000", 0, 30000, "2026-03", "supplier_payment", "PV-2"),
    L("400-0000", 0, 4000, "2026-03", "journal", "JV-1"), // no split → unallocated
  ];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 64000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coaMap, map: {},
    rmSplit: {
      "PV-1": [
        { line: "PLYWOOD", weight: 60 },
        { line: "Supplier advance / deposit", weight: 40 },
      ],
      "HPV-1": [{ line: "Houzs Century Sdn Bhd (other creditor)", weight: 1 }],
      "PV-2": [{ line: "Opening creditors settlement", weight: 1 }],
    },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const rmLines = st.rows.filter((r) => r.kind === "line" && r.section === "RAW_MATERIALS");
  assert.deepEqual(rmLines.map((r) => r.label), [
    "PLYWOOD",
    "Houzs Century Sdn Bhd (other creditor)",
    "Opening creditors settlement",
    "Supplier advance / deposit",
    "Unallocated raw material",
  ]);
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  const val = (label) => rmLines.find((r) => r.label === label).values[mIdx];
  assert.equal(val("PLYWOOD"), 6000);
  assert.equal(val("Supplier advance / deposit"), 4000);
  assert.equal(val("Houzs Century Sdn Bhd (other creditor)"), 20000);
  assert.equal(val("Opening creditors settlement"), 30000);
  assert.equal(val("Unallocated raw material"), 4000);
});

test("rmLineOrder — unallocated always after every named row", () => {
  const u = cf.rmLineOrder("Unallocated raw material");
  for (const n of ["PLYWOOD", "SST / TAX", "X (other creditor)", "Trade finance repayment",
    "Opening creditors settlement", "Supplier advance / deposit"]) {
    assert.ok(cf.rmLineOrder(n) < u, n);
  }
});

test("buildStatement — DIRECT_LABOUR legs split by department via deptSplit", () => {
  // Owner 2026-08-27 「salary 那边也是要拆散成department」: a salary settlement
  // leg splits across department rows; without a split it stays on the
  // account's own line.
  const coa2 = new Map(coaMap);
  coa2.set("410-0010", acct("410-0010", "LIABILITY", null, "ACCRUAL - SALARY"));
  const classified = [L("410-0010", 0, 10000, "2026-03", "payment_voucher", "pv-1")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 10000, ym: "2026-03" }];
  const map = { "410-0010": { section: "DIRECT_LABOUR", order: 10 } };
  const st = cf.buildStatement({
    classified, bankLegs, coa: coa2, map, rmSplit: {},
    deptSplit: { "pv-1": [{ line: "SEWING", weight: 70 }, { line: "CUTTING", weight: 30 }] },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  const val = (label) => st.rows.find((r) => r.kind === "line" && r.label === label).values[mIdx];
  assert.equal(val("SEWING"), 7000);
  assert.equal(val("CUTTING"), 3000);
  assert.ok(!st.rows.some((r) => r.kind === "line" && r.label === "ACCRUAL - SALARY"));

  const st2 = cf.buildStatement({
    classified, bankLegs, coa: coa2, map, rmSplit: {},
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const acc = st2.rows.find((r) => r.kind === "line" && r.label === "ACCRUAL - SALARY");
  assert.equal(acc.section, "DIRECT_LABOUR");
  assert.equal(acc.values[mIdx], 10000);
});

test("rmLineOrder — 'Suppliers settled via' rows sit with the other-creditor zone", () => {
  assert.equal(cf.rmLineOrder("Suppliers settled via Houzs Century Sdn Bhd"), 12);
  assert.ok(cf.rmLineOrder("PLYWOOD") < 12);
  assert.ok(cf.rmLineOrder("Opening creditors settlement") > 12);
});

test("defaultSectionFor — 440-band related-party / HP loans → LOAN", () => {
  assert.equal(cf.defaultSectionFor(acct("440-0030", "LIABILITY", null, "LOAN FROM RELATED PARTY - HOUZS VENTURE")), "LOAN");
  assert.equal(cf.defaultSectionFor(acct("450-0010", "LIABILITY")), "LOAN");
});

test("defaultSectionFor — 480 HP creditor band → LOAN", () => {
  assert.equal(cf.defaultSectionFor(acct("480-0000", "LIABILITY", null, "HIRE PURCHASE CREDITOR")), "LOAN");
  assert.equal(cf.defaultSectionFor(acct("480-0010", "LIABILITY", null, "HIRE PURCHASE INTEREST SUSPENSE")), "LOAN");
});

test("defaultSectionFor — PURCHASE 70x accounts → RAW_MATERIALS, other 70x stay overhead", () => {
  assert.equal(cf.defaultSectionFor(acct("701-0000", "COST", null, "PURCHASE - FABRIC")), "RAW_MATERIALS");
  assert.equal(cf.defaultSectionFor(acct("702-0010", "COST", null, "PURCHASE - PLYWOOD")), "RAW_MATERIALS");
  assert.equal(cf.defaultSectionFor(acct("700-0010", "COST", null, "Rental - factory")), "FACTORY_OVERHEAD");
});

test("buildStatement — RM leg on a non-control account keeps its own name", () => {
  const coa2 = new Map(coaMap);
  coa2.set("701-0000", acct("701-0000", "COST", null, "PURCHASE - FABRIC"));
  const classified = [L("701-0000", 0, 8000, "2026-03", "other_party_payment", "HPV-1")];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 8000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coa2, map: {}, rmSplit: {},
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  const line = st.rows.find((r) => r.kind === "line" && r.label === "PURCHASE - FABRIC");
  assert.equal(line.section, "RAW_MATERIALS");
  assert.equal(line.values[mIdx], 8000);
  assert.ok(!st.rows.some((r) => r.kind === "line" && r.label === "Unallocated raw material"));
});

test("buildStatement — rmSplit keyed sourceId@account overrides the plain key", () => {
  const classified = [
    L("400-0000", 0, 6000, "2026-03", "other_party_payment", "HPV-2"),
    L("405-0000", 0, 4000, "2026-03", "other_party_payment", "HPV-2"),
  ];
  const coa2 = new Map(coaMap);
  coa2.set("405-0000", acct("405-0000", "LIABILITY", "SCC", "OTHER CREDITORS"));
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 10000, ym: "2026-03" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa: coa2, map: {},
    rmSplit: {
      "HPV-2": [{ line: "fallback line", weight: 1 }],
      "HPV-2@400-0000": [{ line: "Suppliers settled via X", weight: 1 }],
    },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-03",
  });
  const mIdx = st.columns.findIndex((c) => c.key === "2026-03");
  const val = (label) => st.rows.find((r) => r.kind === "line" && r.label === label)?.values[mIdx];
  assert.equal(val("Suppliers settled via X"), 6000);
  assert.equal(val("fallback line"), 4000);
});

test("rmLineOrder — per-supplier opening/unallocated rows keep their zones", () => {
  assert.equal(cf.rmLineOrder("Opening creditors — SUNMAT INDUSTRIES SDN. BHD"), 13);
  assert.equal(cf.rmLineOrder("Unallocated — NLY SDN BHD"), 15);
  assert.ok(cf.rmLineOrder("Supplier advance / deposit") < cf.rmLineOrder("Unallocated — NLY SDN BHD"));
  assert.ok(cf.rmLineOrder("Unallocated — NLY SDN BHD") < cf.rmLineOrder("Unallocated raw material"));
});
