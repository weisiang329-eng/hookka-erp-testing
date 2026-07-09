import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/aging-export.ts")).href);

const party = (o) => ({
  name: o.name, currentSen: o.c ?? 0, days30Sen: o.d30 ?? 0, days60Sen: o.d60 ?? 0,
  days90Sen: o.d90 ?? 0, over90Sen: o.o90 ?? 0, docs: o.docs,
});

test("detail shape — name line, one row per doc in its bucket column, subtotal, grand total", () => {
  const aoa = m.buildAgingExportAoa("Supplier", [
    party({
      name: "CHL FOAM", c: 67640, d60: -64000,
      docs: [
        { no: "PI-2607-003", date: "2026-06-24", mo: 0, amountSen: 32000 },
        { no: "PI-2607-002", date: "2026-06-26", mo: 0, amountSen: 35640 },
        { no: "HPV-2605-002 · Advance", date: "2026-05-22", mo: 2, amountSen: -64000 },
      ],
    }),
  ]);
  assert.deepEqual(aoa[0], ["Supplier", "Doc No", "Date", "Current", "1 Month", "2 Months", "3 Months", "> 3 Months", "Total (RM)"]);
  assert.deepEqual(aoa[1], ["CHL FOAM", "", "", "", "", "", "", "", ""]);
  assert.deepEqual(aoa[2], ["", "PI-2607-003", "2026-06-24", 320, "", "", "", "", 320]);
  assert.deepEqual(aoa[4], ["", "HPV-2605-002 · Advance", "2026-05-22", "", "", -640, "", "", -640]);
  assert.deepEqual(aoa[5], ["CHL FOAM — Total", "", "", 676.4, "", -640, "", "", 36.4]);
  assert.deepEqual(aoa[6], ["GRAND TOTAL", "", "", 676.4, 0, -640, 0, 0, 36.4]);
});

test("party without doc detail exports as a single summary line", () => {
  const aoa = m.buildAgingExportAoa("Customer", [party({ name: "HOUZS", d30: 1258070 })]);
  assert.deepEqual(aoa[1], ["HOUZS", "", "", "", 12580.7, "", "", "", 12580.7]);
  assert.deepEqual(aoa[2], ["GRAND TOTAL", "", "", 0, 12580.7, 0, 0, 0, 12580.7]);
});

test("grand total sums every party; out-of-range bucket index clamps", () => {
  const aoa = m.buildAgingExportAoa("Supplier", [
    party({ name: "A", c: 10000, docs: [{ no: "X", date: "d", mo: 0, amountSen: 10000 }] }),
    party({ name: "B", o90: 5000, docs: [{ no: "Y", date: "d", mo: 9, amountSen: 5000 }] }),
  ]);
  const grand = aoa[aoa.length - 1];
  assert.deepEqual(grand, ["GRAND TOTAL", "", "", 100, 0, 0, 0, 50, 150]);
  const yRow = aoa.find((r) => r[1] === "Y");
  assert.equal(yRow[7], 50); // mo 9 clamps into the >3-months column
});

test("agingRowKind — section / subtotal / grand banding classification", () => {
  assert.equal(m.agingRowKind(["CHL FOAM", "", "", "", "", "", "", "", ""]), "section");
  assert.equal(m.agingRowKind(["CHL FOAM — Total", "", "", 676.4, "", -640, "", "", 36.4]), "subtotal");
  assert.equal(m.agingRowKind(["HOUZS", "", "", "", 12580.7, "", "", "", 12580.7]), "subtotal"); // docs-less single line
  assert.equal(m.agingRowKind(["GRAND TOTAL", "", "", 1, 0, 0, 0, 0, 1]), "grand");
  assert.equal(m.agingRowKind(["", "PI-2607-003", "2026-06-24", 320, "", "", "", "", 320]), undefined); // doc row
});
