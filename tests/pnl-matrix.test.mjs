import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPnlMatrix } from "../src/lib/pnl-matrix.ts";

const W = (over = {}) => ({
  netSalesSen: 0, revLines: [], rmGroups: [], rmConsumedSen: 0, carriageSen: 0, sstSen: 0,
  labourLines: [], labourSen: 0, overheadLines: [], overheadSen: 0,
  wipOpen: 0, wipClose: 0, fgOpen: 0, fgClose: 0, manufacturingSen: 0,
  cogsSen: 0, grossProfitSen: 0, otherIncomeSen: 0, otherIncomeLines: [],
  expenseLines: [], expenseSen: 0, netProfitSen: 0, ...over,
});

test("columns echo input meta", () => {
  const m = buildPnlMatrix([
    { key: "acc", label: "Accumulated", accum: true, window: W() },
    { key: "2026-09", label: "Sep", accum: false, window: W() },
  ]);
  assert.deepEqual(m.columns, [
    { key: "acc", label: "Accumulated", accum: true },
    { key: "2026-09", label: "Sep", accum: false },
  ]);
});

test("rows align across columns; revenue line looked up by code; pct of net sales", () => {
  const acc = W({ netSalesSen: 40000, revLines: [{ code: "500-0020", name: "Sofa income", amountSen: 40000 }], grossProfitSen: 16000, netProfitSen: 8000 });
  const sep = W({ netSalesSen: 15000, revLines: [{ code: "500-0020", name: "Sofa income", amountSen: 15000 }], grossProfitSen: 6000, netProfitSen: 3000 });
  const m = buildPnlMatrix([
    { key: "acc", label: "Accumulated", accum: true, window: acc },
    { key: "2026-09", label: "Sep", accum: false, window: sep },
  ]);
  const sales = m.rows.find((r) => r.kind === "group" && r.label === "SALES");
  assert.deepEqual(sales.values, [40000, 15000]);
  assert.deepEqual(sales.pctValues, [100, 100]);
  const revLine = m.rows.find((r) => r.accountCode === "500-0020");
  assert.deepEqual(revLine.values, [40000, 15000]);
  const np = m.rows.find((r) => r.kind === "grandtotal" && r.label.startsWith("NET PROFIT"));
  assert.deepEqual(np.values, [8000, 3000]);
  assert.deepEqual(np.pctValues, [20, 20]);
  const gp = m.rows.find((r) => r.kind === "grandtotal" && r.label.startsWith("GROSS PROFIT"));
  assert.deepEqual(gp.values, [16000, 6000]);
});

test("month missing a spine line yields 0 for that column; netSales 0 -> pct 0", () => {
  const acc = W({ netSalesSen: 100, revLines: [{ code: "A", name: "a", amountSen: 60 }, { code: "B", name: "b", amountSen: 40 }] });
  const m1 = W({ netSalesSen: 0, revLines: [{ code: "A", name: "a", amountSen: 0 }] });
  const mtx = buildPnlMatrix([
    { key: "acc", label: "Acc", accum: true, window: acc },
    { key: "m1", label: "M1", accum: false, window: m1 },
  ]);
  const lineB = mtx.rows.find((r) => r.accountCode === "B");
  assert.deepEqual(lineB.values, [40, 0]);
  assert.deepEqual(lineB.pctValues, [40, 0]);
});

test("salary expense lines grouped under SALARIES & CONTRIBUTION", () => {
  const w = W({ netSalesSen: 1000, expenseSen: 300, expenseLines: [
    { code: "900-S001", name: "Wages", amountSen: 200, salary: true },
    { code: "910-0000", name: "Rent", amountSen: 100, salary: false },
  ], netProfitSen: 700 });
  const m = buildPnlMatrix([{ key: "acc", label: "Acc", accum: true, window: w }]);
  assert.ok(m.rows.some((r) => r.kind === "group" && r.label === "SALARIES & CONTRIBUTION"));
  const wages = m.rows.find((r) => r.accountCode === "900-S001");
  assert.equal(wages.depth, 2);
  const rent = m.rows.find((r) => r.accountCode === "910-0000");
  assert.equal(rent.depth, 1);
});
