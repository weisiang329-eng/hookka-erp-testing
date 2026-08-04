// ---------------------------------------------------------------------------
// scan-supplier-scoped-match.test.mjs — search the SUPPLIER, not the catalogue.
//
// Owner 2026-08-04: "这个供应商里面有什么 code 也是唯一的，他应该是看到这个供应商，
// 去供应商里面找，不是吗？"
//
// Right, and it matters more than convenience. Two plywoods that differ only in
// size score almost identically on text, so choosing between them on a fuzzy
// score is a guess about a REAL physical difference — a 4x8 sheet is not a
// 1220x2440 sheet just because the words look alike. A supplier carries a
// handful of items, so scoping the search to what they actually supply turns an
// ambiguous problem into an easy one.
//
// No bindings for a supplier means no candidates and a manual pick, which is
// correct: nothing has ever been bought from them, so there is nothing to
// recognise.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { matchCatalogItem } from "../src/lib/material-text-match.ts";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/scan-supplier-modal.tsx"),
  "utf8",
);

test("the candidate set is built from THIS supplier's bindings", () => {
  assert.match(SRC, /const materialsForSupplier = useCallback\(/);
  assert.match(SRC, /bindings\s*\n?\s*\.filter\(\(b\) => b\.supplierId === supplierId\)/);
});

test("a supplier with no bindings yields no candidates", () => {
  assert.match(SRC, /if \(codes\.size === 0\) return \[\];/);
  assert.match(SRC, /if \(!supplierId\) return \[\];/);
});

test("both scan modes search the scoped set, not the whole catalogue", () => {
  const scoped = SRC.split("matchCatalogItem(text, materialsForSupplier(sId))").length - 1;
  assert.equal(scoped, 2, "create-PI and create-GRN must behave identically");
  assert.equal(
    SRC.split("matchCatalogItem(text, rawMaterials)").length - 1,
    0,
    "no path may still search the entire catalogue",
  );
});

// ── Why the scoping matters, demonstrated on the matcher itself ─────────────

const WHOLE_CATALOGUE = [
  { itemCode: "PLY-9-48-AB", description: "PLYWOOD 9MM 4X8 AB" },
  { itemCode: "PLY-9-1224-AB", description: "PLYWOOD 9MM 1220X2440 AB" },
  { itemCode: "PLY-9-46-AB", description: "PLYWOOD 9MM 4X6 AB" },
];

test("across the whole catalogue, near-identical sizes are refused", () => {
  // Exactly the situation the owner objected to — the sizes ARE different and
  // text alone cannot responsibly choose between them.
  assert.equal(
    matchCatalogItem("PLYWOOD 9MM AB", WHOLE_CATALOGUE),
    null,
    "three sizes of the same board must not be resolved by a fuzzy score",
  );
});

test("scoped to what the supplier actually supplies, the same line resolves", () => {
  // ADD WOOD supplies one of the three. Scoping removes the ambiguity that
  // made the unscoped search unsafe.
  const supplierItems = [WHOLE_CATALOGUE[0]];
  const m = matchCatalogItem("PLYWOOD 9MM AB", supplierItems);
  assert.ok(m, "with one candidate there is nothing to be ambiguous about");
  assert.equal(m.item.itemCode, "PLY-9-48-AB");
});

test("scoping does not rescue a genuinely wrong line", () => {
  const supplierItems = [WHOLE_CATALOGUE[0]];
  assert.equal(
    matchCatalogItem("DELIVERY CHARGE", supplierItems),
    null,
    "a narrow search space must not lower the bar for what counts as a match",
  );
});

test("a supplier carrying two sizes still refuses to guess between them", () => {
  const supplierItems = [WHOLE_CATALOGUE[0], WHOLE_CATALOGUE[2]];
  assert.equal(
    matchCatalogItem("PLYWOOD 9MM AB", supplierItems),
    null,
    "scoping narrows the field; it does not license a coin flip inside it",
  );
  // But a line that names the size resolves cleanly.
  const sized = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, supplierItems);
  assert.ok(sized);
  assert.equal(sized.item.itemCode, "PLY-9-48-AB");
});
