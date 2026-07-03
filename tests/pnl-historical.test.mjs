import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/pnl-historical.ts")).href);

// Minimal PnlWindowLike factory (all-zero, arrays empty)
const W = (over = {}) => ({
  netSalesSen: 0, revLines: [], rmGroups: [], rmConsumedSen: 0, carriageSen: 0, sstSen: 0,
  labourLines: [], labourSen: 0, overheadLines: [], overheadSen: 0,
  wipOpen: 0, wipClose: 0, fgOpen: 0, fgClose: 0, manufacturingSen: 0,
  cogsSen: 0, grossProfitSen: 0, otherIncomeSen: 0, otherIncomeLines: [],
  expenseLines: [], expenseSen: 0, netProfitSen: 0, ...over,
});

// ---------------------------------------------------------------------------
// 1. buildHistoricalMap — groups rows by ym into {all,sofa,bedframe}.
//
// REGRESSION (prod bug 2026-06-30): the db-pg adapter camelCases result
// columns (transform.column.from), so the `window_json` column arrives as
// `windowJson`. The original reader read only `row.window_json` → undefined
// → JSON.parse threw → every row silently skipped → empty map → the 39
// loaded historical rows displayed as zero. buildHistoricalMap now reads the
// value dual-keyed; this test feeds the camelCase key the adapter actually
// produces, so it fails under the old logic.
// ---------------------------------------------------------------------------
test("buildHistoricalMap — reads windowJson (the PG adapter camelCases the column)", () => {
  const wA = W({ netSalesSen: 100 });
  const wS = W({ netSalesSen: 60 });
  const rows = [
    { ym: "2025-12", line: "all",  windowJson: JSON.stringify(wA) },
    { ym: "2025-12", line: "sofa", windowJson: JSON.stringify(wS) },
    { ym: "2025-11", line: "all",  windowJson: JSON.stringify(W({ netSalesSen: 50 })) },
  ];

  const map = m.buildHistoricalMap(rows);

  assert.equal(map.size, 2, "camelCased windowJson MUST populate the map (regression guard)");
  assert.deepEqual(map.get("2025-12")?.all, wA);
  assert.deepEqual(map.get("2025-12")?.sofa, wS);
  assert.equal(map.get("2025-12")?.bedframe, undefined);
  assert.equal(map.get("2025-11")?.all?.netSalesSen, 50);
});

test("buildHistoricalMap — tolerates snake_case window_json; skips bad/missing JSON + unknown line", () => {
  const wA = W({ netSalesSen: 100 });
  const rows = [
    { ym: "2025-12", line: "all",   window_json: JSON.stringify(wA) },       // snake_case fallback
    { ym: "2025-11", line: "other", windowJson: JSON.stringify(W()) },       // unknown line → no line entry
    { ym: "2025-10", line: "all",   windowJson: "not-json" },                // unparseable → skipped
    { ym: "2025-09", line: "all" },                                          // no window at all → skipped
  ];

  const map = m.buildHistoricalMap(rows);

  assert.deepEqual(map.get("2025-12")?.all, wA, "snake_case key must still be read");
  assert.deepEqual(map.get("2025-11"), {}, "unknown line: ym entry exists but no recognised line");
  assert.equal(map.get("2025-10"), undefined, "bad JSON -> no entry");
  assert.equal(map.get("2025-09"), undefined, "missing window -> no entry");
});

// ---------------------------------------------------------------------------
// 2. sumPnlWindows — sums sen fields + merges line arrays correctly
// ---------------------------------------------------------------------------
test("sumPnlWindows — empty array returns zero window", () => {
  const r = m.sumPnlWindows([]);
  assert.equal(r.netSalesSen, 0);
  assert.deepEqual(r.revLines, []);
  assert.equal(r.netProfitSen, 0);
});

test("sumPnlWindows — sums scalar sen fields across two windows", () => {
  const w1 = W({
    netSalesSen: 100000,
    cogsSen: 60000,
    grossProfitSen: 40000,
    expenseSen: 20000,
    netProfitSen: 20000,
    carriageSen: 500,
    sstSen: 300,
    labourSen: 1000,
    overheadSen: 2000,
    rmConsumedSen: 5000,
    manufacturingSen: 8000,
    otherIncomeSen: 1000,
    wipOpen: 200,
    wipClose: 100,
    fgOpen: 150,
    fgClose: 80,
  });
  const w2 = W({
    netSalesSen: 80000,
    cogsSen: 50000,
    grossProfitSen: 30000,
    expenseSen: 15000,
    netProfitSen: 15000,
    carriageSen: 400,
    sstSen: 200,
    labourSen: 800,
    overheadSen: 1500,
    rmConsumedSen: 4000,
    manufacturingSen: 6500,
    otherIncomeSen: 500,
    wipOpen: 100,
    wipClose: 50,
    fgOpen: 70,
    fgClose: 40,
  });

  const r = m.sumPnlWindows([w1, w2]);
  assert.equal(r.netSalesSen, 180000);
  assert.equal(r.cogsSen, 110000);
  assert.equal(r.grossProfitSen, 70000);
  assert.equal(r.expenseSen, 35000);
  assert.equal(r.netProfitSen, 35000);
  assert.equal(r.carriageSen, 900);
  assert.equal(r.sstSen, 500);
  assert.equal(r.labourSen, 1800);
  assert.equal(r.overheadSen, 3500);
  assert.equal(r.rmConsumedSen, 9000);
  assert.equal(r.manufacturingSen, 14500);
  assert.equal(r.otherIncomeSen, 1500);
  assert.equal(r.wipOpen, 300);
  assert.equal(r.wipClose, 150);
  assert.equal(r.fgOpen, 220);
  assert.equal(r.fgClose, 120);
});

test("sumPnlWindows — merges revLines by code, summing amountSen", () => {
  const w1 = W({
    revLines: [
      { code: "500-0020", name: "Sofa income", amountSen: 50000 },
      { code: "500-0000", name: "Bedframe income", amountSen: 30000 },
    ],
  });
  const w2 = W({
    revLines: [
      { code: "500-0020", name: "Sofa income", amountSen: 20000 },
      { code: "500-0030", name: "Accessory income", amountSen: 10000 },
    ],
  });

  const r = m.sumPnlWindows([w1, w2]);
  const sofa = r.revLines.find((l) => l.code === "500-0020");
  const bed = r.revLines.find((l) => l.code === "500-0000");
  const acc = r.revLines.find((l) => l.code === "500-0030");

  assert.ok(sofa, "500-0020 should be present");
  assert.equal(sofa.amountSen, 70000, "sofa: 50000 + 20000");
  assert.ok(bed, "500-0000 should be present");
  assert.equal(bed.amountSen, 30000, "bedframe: only in w1");
  assert.ok(acc, "500-0030 should be present");
  assert.equal(acc.amountSen, 10000, "accessory: only in w2");
  assert.equal(r.revLines.length, 3);
});

test("sumPnlWindows — merges rmGroups by group key, summing opening/purchases/closing", () => {
  const w1 = W({
    rmGroups: [
      { group: "FABRIC", description: "Fabric", openingSen: 1000, purchasesSen: 5000, closingSen: 1500 },
      { group: "FOAM",   description: "Foam",   openingSen: 500,  purchasesSen: 2000, closingSen: 600 },
    ],
  });
  const w2 = W({
    rmGroups: [
      { group: "FABRIC", description: "Fabric", openingSen: 800, purchasesSen: 4000, closingSen: 1200 },
    ],
  });

  const r = m.sumPnlWindows([w1, w2]);
  const fabric = r.rmGroups.find((g) => g.group === "FABRIC");
  const foam   = r.rmGroups.find((g) => g.group === "FOAM");

  assert.ok(fabric, "FABRIC group should be merged");
  assert.equal(fabric.openingSen,   1800);
  assert.equal(fabric.purchasesSen, 9000);
  assert.equal(fabric.closingSen,   2700);
  assert.ok(foam, "FOAM group should pass through from w1");
  assert.equal(foam.openingSen, 500);
});

test("sumPnlWindows — merges expenseLines, preserving salary flag", () => {
  const w1 = W({
    expenseLines: [
      { code: "900-S001", name: "Wages", amountSen: 10000, salary: true },
      { code: "910-0000", name: "Rent",  amountSen: 5000,  salary: false },
    ],
  });
  const w2 = W({
    expenseLines: [
      { code: "900-S001", name: "Wages", amountSen: 8000, salary: true },
    ],
  });

  const r = m.sumPnlWindows([w1, w2]);
  const wages = r.expenseLines.find((l) => l.code === "900-S001");
  const rent  = r.expenseLines.find((l) => l.code === "910-0000");

  assert.ok(wages);
  assert.equal(wages.amountSen, 18000);
  assert.equal(wages.salary, true);
  assert.ok(rent);
  assert.equal(rent.amountSen, 5000);
});

// ---------------------------------------------------------------------------
// 3. selectHistoricalWindow — predicate: picks historical for pre-opening ym
// ---------------------------------------------------------------------------
test("selectHistoricalWindow — returns null when openingMonth is null", () => {
  const map = new Map([["2025-12", { all: W({ netSalesSen: 999 }) }]]);
  assert.equal(m.selectHistoricalWindow(map, null, "2025-12", "all"), null);
});

test("selectHistoricalWindow — returns null when ym >= openingMonth", () => {
  const map = new Map([
    ["2026-05", { all: W({ netSalesSen: 999 }) }],
    ["2026-06", { all: W({ netSalesSen: 888 }) }],
  ]);
  // Opening month is 2026-05; equal → NOT pre-opening
  assert.equal(m.selectHistoricalWindow(map, "2026-05", "2026-05", "all"), null);
  // After opening month
  assert.equal(m.selectHistoricalWindow(map, "2026-05", "2026-06", "all"), null);
});

test("selectHistoricalWindow — returns historical window for pre-opening ym", () => {
  const stored = W({ netSalesSen: 42000 });
  const map = new Map([
    ["2025-12", { all: stored }],
    ["2026-01", { all: W({ netSalesSen: 30000 }) }],
  ]);
  const result = m.selectHistoricalWindow(map, "2026-05", "2025-12", "all");
  assert.deepEqual(result, stored);
});

test("selectHistoricalWindow — returns null when line absent for pre-opening ym", () => {
  const map = new Map([["2025-12", { sofa: W({ netSalesSen: 100 }) }]]);
  // 'all' absent, 'bedframe' absent
  assert.equal(m.selectHistoricalWindow(map, "2026-05", "2025-12", "all"), null);
  assert.equal(m.selectHistoricalWindow(map, "2026-05", "2025-12", "bedframe"), null);
  // 'sofa' is present
  assert.ok(m.selectHistoricalWindow(map, "2026-05", "2025-12", "sofa") !== null);
});

test("selectHistoricalWindow — computePnlWindow used for opening-or-later ym", () => {
  // Simulate the endpoint decision: for each ym, if selectHistoricalWindow returns
  // non-null → use historical; otherwise fall back to computePnlWindow.
  const openingMonth = "2026-05";
  const historical = new Map([
    ["2026-03", { all: W({ netSalesSen: 10 }) }],
    ["2026-04", { all: W({ netSalesSen: 20 }) }],
    ["2026-05", { all: W({ netSalesSen: 30 }) }], // on opening month — should NOT be used
  ]);

  const computeCalled = [];
  function fakeComputePnlWindow(ym) { computeCalled.push(ym); return W(); }

  const months = ["2026-03", "2026-04", "2026-05", "2026-06"];
  for (const ym of months) {
    const hist = m.selectHistoricalWindow(historical, openingMonth, ym, "all");
    if (!hist) fakeComputePnlWindow(ym);
  }

  assert.deepEqual(computeCalled, ["2026-05", "2026-06"],
    "Only opening-or-later months should call computePnlWindow");
});

// ---------------------------------------------------------------------------
// Regression (owner report 2026-07-02): historical windows carry code:"" on
// EVERY line (old-books names, never mapped to COA codes). Merging strictly
// by code collapsed all expense lines into one row (labelled by the first
// line seen — "Bank Charges", RM 407,750.36 lump on prod). Lines must merge
// by code-falling-back-to-name.
// ---------------------------------------------------------------------------
test("sumPnlWindows — empty-coded historical lines merge by NAME, not into one lump", () => {
  const apr = W({
    expenseLines: [
      { code: "", name: "Bank Charges", amountSen: 50, salary: false },
      { code: "", name: "Factory - Rental", amountSen: 1250000, salary: false },
      { code: "", name: "Staff Salaries & Overtime", amountSen: 2398586, salary: true },
    ],
    expenseSen: 50 + 1250000 + 2398586,
  });
  const mar = W({
    expenseLines: [
      { code: "", name: "Bank Charges", amountSen: 5100, salary: false },
      { code: "", name: "Factory - Rental", amountSen: 1250000, salary: false },
    ],
    expenseSen: 5100 + 1250000,
  });
  const out = m.sumPnlWindows([apr, mar]);
  assert.equal(out.expenseLines.length, 3, "three distinct names → three lines");
  const bank = out.expenseLines.find((l) => l.name === "Bank Charges");
  const rent = out.expenseLines.find((l) => l.name === "Factory - Rental");
  const sal = out.expenseLines.find((l) => l.name === "Staff Salaries & Overtime");
  assert.equal(bank.amountSen, 5150);
  assert.equal(rent.amountSen, 2500000);
  assert.equal(sal.amountSen, 2398586);
  assert.equal(sal.salary, true);
  assert.equal(out.expenseSen, apr.expenseSen + mar.expenseSen);
});

test("sumPnlWindows — mixed coded + uncoded lines never collide", () => {
  const a = W({ expenseLines: [{ code: "900-T003", name: "TRANSPORT EXPENSE", amountSen: 60000, salary: false }], expenseSen: 60000 });
  const b = W({ expenseLines: [{ code: "", name: "Transport Expense", amountSen: 270000, salary: false }], expenseSen: 270000 });
  const out = m.sumPnlWindows([a, b]);
  assert.equal(out.expenseLines.length, 2, "coded and name-keyed lines stay separate");
});

test("sumPnlWindows — SHARED placeholder code ('900') with different names stays separate (prod shape)", () => {
  const apr = W({
    expenseLines: [
      { code: "900", name: "Bank Charges", amountSen: 50, salary: false },
      { code: "900", name: "Factory - Rental", amountSen: 1250000, salary: false },
      { code: "900", name: "Staff Salaries & Overtime", amountSen: 2398586, salary: true },
    ],
    expenseSen: 50 + 1250000 + 2398586,
  });
  const mar = W({
    expenseLines: [
      { code: "900", name: "Bank Charges", amountSen: 5100, salary: false },
      { code: "900", name: "Factory - Rental", amountSen: 1250000, salary: false },
    ],
    expenseSen: 5100 + 1250000,
  });
  const out = m.sumPnlWindows([apr, mar]);
  assert.equal(out.expenseLines.length, 3);
  assert.equal(out.expenseLines.find((l) => l.name === "Bank Charges").amountSen, 5150);
  assert.equal(out.expenseLines.find((l) => l.name === "Factory - Rental").amountSen, 2500000);
});
