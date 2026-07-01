import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/stock-take-import.ts")).href);

test("isCleanImportShape — recognises the Material Group / Closing Stock (RM) header", () => {
  assert.equal(m.isCleanImportShape(["Material Group", "Closing Stock (RM)"]), true);
  assert.equal(m.isCleanImportShape(["material group", "closing stock (rm)"]), true); // case-insensitive
  assert.equal(m.isCleanImportShape(["", "Actual Size", "Total"]), false);
});

test("detectRawShape — 7-column raw file (owner's actual 30/05/2026 file)", () => {
  const header = ["", "Actual Size", "in2", "Qty", "Total in2", "Price/in2", "Total"];
  const shape = m.detectRawShape(header);
  assert.deepEqual(shape, { totalCol: 6, identityCols: [0, 1] });
});

test("detectRawShape — 10-column categorized file (Item column present but irrelevant to this path)", () => {
  const header = ["", "Actual Size", "in2", "Qty", "Total in2", "Price/in2", "Total", "", "", "Item"];
  const shape = m.detectRawShape(header);
  assert.deepEqual(shape, { totalCol: 6, identityCols: [0, 1] });
});

test("detectRawShape — no numeric-section header, only Total: identity = everything before Total", () => {
  const header = ["Code", "Description", "Total"];
  const shape = m.detectRawShape(header);
  assert.deepEqual(shape, { totalCol: 2, identityCols: [0, 1] });
});

test("detectRawShape — no Total header at all -> null", () => {
  assert.equal(m.detectRawShape(["Material Group", "Amount"]), null);
});

test("detectRawShape — Total is the very first column -> no identity columns -> null", () => {
  assert.equal(m.detectRawShape(["Total", "Qty"]), null);
});

test("normalizeItemKey — trims, collapses whitespace, lowercases, joins with ||", () => {
  assert.equal(m.normalizeItemKey(["9MM", "5FT X 10\""]), "9mm||5ft x 10\"");
  assert.equal(m.normalizeItemKey([" 9mm ", "5FT   X 10\""]), "9mm||5ft x 10\"");
});

test("normalizeItemKey — same key for the same item regardless of case/spacing", () => {
  assert.equal(m.normalizeItemKey(["ACC"]), m.normalizeItemKey(["acc"]));
  assert.equal(m.normalizeItemKey(["ACC"]), m.normalizeItemKey(["Acc"])); // this month's real case
});

const SHAPE = { totalCol: 6, identityCols: [0, 1] };

test("parseRawStockTakeRows — sums repeated identity keys, converts RM to integer sen", () => {
  const aoa = [
    ["", "Actual Size", "in2", "Qty", "Total in2", "Price/in2", "Total"],
    ["9MM", "5FT X 10\"", 600, 4, 2400, 0.00694, 16.67],
    ["9MM", "5FT X 8\"", 480, 90, 43200, 0.00694, 300],
    ["9MM", "5FT X 10\"", 600, 2, 1200, 0.00694, 8.33], // same key as row 1 -> sums
  ];
  const rows = m.parseRawStockTakeRows(aoa, SHAPE);
  assert.equal(rows.length, 2);
  const r1 = rows.find((r) => r.key === "9mm||5ft x 10\"");
  assert.equal(r1.totalSen, Math.round(16.67 * 100) + Math.round(8.33 * 100));
  assert.equal(r1.description, "9MM / 5FT X 10\"");
  const r2 = rows.find((r) => r.key === "9mm||5ft x 8\"");
  assert.equal(r2.totalSen, 30000);
});

test("parseRawStockTakeRows — skips fully-blank rows and rows with no identity text", () => {
  const aoa = [
    ["", "Actual Size", "in2", "Qty", "Total in2", "Price/in2", "Total"],
    ["", "", "", "", "", "", ""],
    ["9MM", "5FT X 10\"", 600, 4, 2400, 0.00694, 16.67],
    ["", "", 0, "", 0, "", 0], // identity cells blank -> not a real item, even with a numeric Total
  ];
  const rows = m.parseRawStockTakeRows(aoa, SHAPE);
  assert.equal(rows.length, 1);
});

test("parseRawStockTakeRows — non-numeric Total cell falls back to 0", () => {
  const aoa = [
    ["", "Actual Size", "in2", "Qty", "Total in2", "Price/in2", "Total"],
    ["9MM", "5FT X 10\"", 600, "", 0, 0.00694, "-"],
  ];
  const rows = m.parseRawStockTakeRows(aoa, SHAPE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalSen, 0);
});
