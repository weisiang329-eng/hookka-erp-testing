// ---------------------------------------------------------------------------
// foam-area-consumption.test.mjs — FILLER (sponge) area-based consumption
// (owner 2026-07-30). A sponge is stocked in PCS (sheets) but consumed by AREA:
// a BOM cut piece (L×W inches) consumes  cutArea ÷ sheetArea  of a sheet (a
// decimal). Thickness cancels (piece is cut the full thickness), so area is
// enough. Cost = that fraction × the sheet's FIFO unit cost.
//
// Model check + source-level structural pins (house style).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RM = resolve(process.cwd(), "src/api/routes/raw-materials.ts");
const CASCADE = resolve(process.cwd(), "src/api/lib/po-cost-cascade.ts");
const BOM = resolve(process.cwd(), "src/pages/bom.tsx");
const INV = resolve(process.cwd(), "src/pages/inventory/index.tsx");

const read = (p) => readFileSync(p, "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

// ── The core arithmetic the whole feature rides on ──────────────────────────
test("model: cut 4ft×2ft from an 8ft×4ft sheet = 1/4 sheet", () => {
  const sheetArea = 96 * 48; // inches (8ft × 4ft)
  const cutArea = 48 * 24;   // inches (4ft × 2ft)
  assert.equal(cutArea / sheetArea, 0.25);
});

// ── Raw material: sheet size columns ────────────────────────────────────────
test("raw_materials: sheet dims are runtime self-applied + read/written", () => {
  const f = flat(RM);
  assert.match(f, /ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS \$\{col\}/);
  assert.match(f, /"sheet_length_in DOUBLE PRECISION", "sheet_width_in DOUBLE PRECISION"/);
  assert.match(f, /await ensureSheetDimCols\(c\.var\.DB\)/);
  // rowToApi exposes them (dual-keyed read).
  assert.match(f, /sheetLengthIn: \(r\.sheet_length_in \?\? r\.sheetLengthIn\)/);
  // INSERT + UPDATE persist them.
  assert.match(f, /sheet_length_in, sheet_width_in/);
  assert.match(f, /sheet_length_in = \?, sheet_width_in = \?/);
});

// ── Consumption: area ratio ─────────────────────────────────────────────────
test("MaterialLine carries the cut size and collectTreeMaterials captures it", () => {
  const f = flat(CASCADE);
  assert.match(f, /cutLengthIn\?: number;\s*cutWidthIn\?: number;/);
  assert.match(f, /const cutLenRaw = \(row\.cutLengthIn \?\? row\.cut_length_in\)/);
});

test("resolveRmFromBom SELECT * (column-safe) and returns sheet dims", () => {
  const f = flat(CASCADE);
  // Must not name the runtime-added columns in the SELECT (would throw on a
  // fresh DB) — use SELECT * + dual-keyed read.
  assert.match(f, /SELECT \* FROM raw_materials WHERE itemCode = \? LIMIT 1/);
  assert.doesNotMatch(f, /SELECT id, itemCode, description, itemGroup FROM raw_materials/);
  assert.match(f, /sheetLengthIn: sl != null \? Number\(sl\) : null/);
});

test("consumption deducts cutArea ÷ sheetArea, guarded, with a plain-qty fallback", () => {
  const src = read(CASCADE);
  const i = src.indexOf("FILLER (sponge) area-based consumption (owner 2026-07-30): a BOM line");
  assert.ok(i !== -1, "the area-ratio block must exist in the consume loop");
  // 1600, not 1100: the cut-growth work (2026-08-21) added comment lines
  // between the anchor and the assertions below, and a fixed character window
  // silently stopped covering them. A window measured in characters will do
  // this again — widen it, or slice to the end of the block, but never let it
  // pass by covering less.
  const block = src.slice(i, i + 1600);
  // Fires when the line has a cut size (the sheet size comes from the RM or its
  // category default — resolved just below).
  assert.match(block, /if \(rm && line\.cutLengthIn && line\.cutWidthIn\)/);
  assert.match(block, /required = required \* \(cutArea \/ sheetArea\)/);
  // Divide-by-zero guard.
  assert.match(block, /sheetArea > 0 && cutArea > 0/);
  // required is now reassignable (was const).
  assert.match(src, /let required =\s*line\.qtyPerUnit \*/);
});

// ── UIs ─────────────────────────────────────────────────────────────────────
test("BOM editor shows cut L×W on FILLER material rows only", () => {
  const f = flat(BOM);
  assert.match(f, /function isFillerMaterial\(m: WIPMaterial, rawMaterials: RawMaterialOption\[\]\): boolean/);
  assert.match(f, /\/FILLER\/i\.test\(rm\.itemGroup/);
  // Gated render + writes cutLengthIn / cutWidthIn.
  assert.match(f, /isFillerMaterial\(m, rawMaterials\) &&/);
  assert.match(f, /"cutLengthIn", parseFloat/);
  assert.match(f, /"cutWidthIn", parseFloat/);
});

test("Raw Materials edit dialog has the sheet-size inputs + saves them", () => {
  const f = flat(INV);
  assert.match(f, /Sheet size/);
  assert.match(f, /sheetLengthIn: editRMForm\.sheetLengthIn/);
  assert.match(f, /sheetWidthIn: editRMForm\.sheetWidthIn\.trim\(\) === "" \? null : Number/);
});

// ── Category default (owner: "set once, unified 8×4; special per-SKU") ───────
test("consumption falls back per-SKU → category default → hardcoded 8×4", () => {
  const f = flat(CASCADE);
  assert.match(f, /const HARDCODED_FILLER_SHEET = \{ length: 96, width: 48 \}/);
  assert.match(f, /async function loadSheetDefaults/);
  assert.match(f, /parsed\?\.sheetDefaults/);
  assert.match(f, /if \(\/FILLER\/\.test\(g\)\) return HARDCODED_FILLER_SHEET/);
  // The area block prefers the per-SKU size, else the category default.
  assert.match(f, /const sheetL = rm\.sheetLengthIn \?\? catDef\?\.length \?\? 0/);
  assert.match(f, /const sheetW = rm\.sheetWidthIn \?\? catDef\?\.width \?\? 0/);
});

test("Material Categories dialog sets a per-category default sheet size", () => {
  const f = flat(INV);
  assert.match(f, /Default sheet size for/);
  assert.match(f, /function saveSheetDefault/);
  assert.match(f, /patchVariantsConfig\(\{ sheetDefaults: next \}\)/);
  // S.FILLER shows the unified 8×4 default in the UI.
  assert.match(f, /\/FILLER\/i\.test\(cat\) \? \{ length: 96, width: 48 \}/);
});
