import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const { parseHlbbStatement } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/hlbb-statement.ts")).href
);

// Synthetic positioned items mimicking the HLBB PrimeBiz layout: header at
// y=100 sets the column right-edges (Deposit ~460, Withdrawal ~560,
// Balance ~680); amounts are right-aligned to those edges.
const H = [
  { str: "Date", x: 40, y: 100, w: 24, page: 1 },
  { str: "Transaction Description", x: 90, y: 100, w: 130, page: 1 },
  { str: "Deposit", x: 420, y: 100, w: 40, page: 1 },
  { str: "Withdrawal", x: 505, y: 100, w: 55, page: 1 },
  { str: "Balance", x: 640, y: 100, w: 40, page: 1 },
];
const money = (str, rightEdge, y) => ({ str, x: rightEdge - 50, y, w: 50, page: 1 });

const base = [
  ...H,
  { str: "A/C No / No Akaun : 23600599073", x: 400, y: 60, w: 180, page: 1 },
  { str: "Balance from previous statement", x: 90, y: 120, w: 160, page: 1 },
  money("4,286.17", 680, 120),
  // Txn 1: deposit on the date line, balance printed.
  { str: "02-07-2026", x: 40, y: 140, w: 55, page: 1 },
  { str: "Fund Transfer at DIO", x: 90, y: 140, w: 110, page: 1 },
  money("11,000.00", 460, 140),
  money("15,286.17", 680, 140),
  // Txn 2: withdrawal one line BELOW the date; multi-line description.
  { str: "03-07-2026", x: 40, y: 160, w: 55, page: 1 },
  { str: "CIB Instant Transfer at DIO", x: 90, y: 160, w: 130, page: 1 },
  { str: "HPV-2607-002", x: 90, y: 172, w: 70, page: 1 },
  money("11,476.00", 560, 172),
  { str: "ADD WOOD TRADING SDN BHD", x: 90, y: 184, w: 150, page: 1 },
  money("3,810.17", 680, 184),
  // Footer.
  { str: "Total Withdrawals / Jumlah Pengeluaran : 1", x: 40, y: 300, w: 220, page: 1 },
  { str: "Total Deposits / Jumlah Simpanan : 1", x: 40, y: 315, w: 200, page: 1 },
  { str: "Closing Balance / Baki Akhir :", x: 400, y: 330, w: 140, page: 1 },
  money("3,810.17", 680, 330),
];

test("parseHlbbStatement — clean statement parses with every lock green", () => {
  const p = parseHlbbStatement(base);
  assert.deepEqual(p.errors, []);
  assert.equal(p.accountNo, "23600599073");
  assert.equal(p.openingSen, 428617);
  assert.equal(p.closingSen, 381017);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0], { date: "2026-07-02", description: "Fund Transfer at DIO", amountSen: 1100000, balanceSen: 1528617 });
  assert.equal(p.rows[1].amountSen, -1147600);
  assert.match(p.rows[1].description, /HPV-2607-002/);
  assert.equal(p.rows[1].balanceSen, 381017);
  assert.equal(p.countIn, 1);
  assert.equal(p.countOut, 1);
});

test("parseHlbbStatement — a corrupted amount breaks the running-balance lock", () => {
  const bad = base.map((i) => (i.str === "11,476.00" ? { ...i, str: "11,476.10" } : i));
  const p = parseHlbbStatement(bad);
  assert.ok(p.errors.some((e) => /running balance breaks/.test(e)));
  assert.ok(p.errors.some((e) => /Closing Balance/.test(e) || /refusing the import/.test(e)));
});

test("parseHlbbStatement — a missing row breaks the closing-balance lock", () => {
  const bad = base.filter((i) => !(i.y === 140 && MONEYISH(i.str)));
  function MONEYISH(s) { return /^\d{1,3}(,\d{3})*\.\d{2}$/.test(s); }
  const p = parseHlbbStatement(bad);
  assert.ok(p.errors.length > 0);
});

test("parseHlbbStatement — refuses a non-HLBB document", () => {
  const p = parseHlbbStatement([{ str: "hello", x: 0, y: 0, w: 10, page: 1 }]);
  assert.ok(p.errors.some((e) => /table header/.test(e)));
});

test("parseHlbbStatement — footer count mismatch is a warning, not silence", () => {
  const off = base.map((i) => (i.str.startsWith("Total Withdrawals") ? { ...i, str: "Total Withdrawals / Jumlah Pengeluaran : 9" } : i));
  const p = parseHlbbStatement(off);
  assert.deepEqual(p.errors, []);
  assert.ok(p.warnings.some((w) => /9 withdrawals, parsed 1/.test(w)));
});
