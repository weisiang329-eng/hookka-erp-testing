// ---------------------------------------------------------------------------
// supplier-material-candidates.test.mjs — the first scan must resolve itself.
//
// The matcher was already good. What defeated it was the candidate set: it was
// built from `supplier_material_bindings`, and a binding only exists after
// somebody picked that line by hand — so the FIRST appearance of an item, the
// case the owner complained about, searched an empty list every time.
//
// These tests pin the ladder that replaces it: the linked PO, then everything
// ever ordered from this supplier, then the whole catalogue at a higher bar.
// The bar rises with the width of the field, because a blank line costs one
// pick while a wrong match books stock against the wrong material.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  normKey,
  indexByCode,
  materialsOnPo,
  materialsEverBought,
  supplierSkuIndex,
  buildCandidateTiers,
  resolveMaterialForLine,
  CATALOG_MIN_SCORE,
} from "../src/lib/supplier-material-candidates.ts";

const CATALOG = [
  { itemCode: "PLY-9-48-AB", description: "PLYWOOD 9MM 4X8 AB" },
  { itemCode: "PLY-18-48", description: "PLYWOOD 18MM 4X8" },
  { itemCode: "PLY-9-46-AB", description: "PLYWOOD 9MM 4X6 AB" },
  { itemCode: "FOAM-D24-2", description: "FOAM D24 2INCH SHEET" },
  { itemCode: "LEG-6-CHR", description: "LEG 6INCH CHROME" },
];

const byCode = indexByCode(CATALOG);

test("the index is keyed the way lookups are done, hyphens and all", () => {
  // A plain trim+uppercase map — which is what the modal already had for other
  // purposes — misses every hyphenated code and silently yields no candidates.
  assert.ok(byCode.has("PLY948AB"));
  assert.equal(byCode.get(normKey("ply-9-48-ab")).itemCode, "PLY-9-48-AB");
});

const ADD_WOOD_PO = {
  id: "po-1",
  supplierId: "sup-addwood",
  items: [
    { materialCode: "PLY-9-48-AB", materialName: "PLYWOOD 9MM 4X8 AB", supplierSKU: "AW-9" },
    { materialCode: "PLY-18-48", materialName: "PLYWOOD 18MM 4X8", supplierSKU: "AW-18" },
  ],
};

const tiersFor = (over = {}) =>
  buildCandidateTiers({
    supplierId: "sup-addwood",
    linkedPo: null,
    purchaseOrders: [],
    bindings: [],
    materialByCode: byCode,
    catalog: CATALOG,
    ...over,
  });

// ── The complaint itself ────────────────────────────────────────────────────

test("a supplier with NO bindings still resolves its lines", () => {
  // This is the whole point. Before the ladder existed this returned nothing
  // and the operator picked both lines by hand on every single first document.
  const tiers = tiersFor({ linkedPo: ADD_WOOD_PO });
  const a = resolveMaterialForLine(`9MM 4' X 8' PLYWOOD AB`, tiers);
  const b = resolveMaterialForLine(`18MM 4' X 8' PLYWOOD`, tiers);
  assert.ok(a, "the OCR read this line — nothing should need a manual pick");
  assert.equal(a.item.itemCode, "PLY-9-48-AB");
  assert.equal(b.item.itemCode, "PLY-18-48");
});

test("a document naming TWO orders searches both", () => {
  // One receipt covers both — "如果它的 PO 来自两个的话，它一定要来自首两张 PO
  // 进一张 GR 的". Searching only the header order would leave every line
  // belonging to the second one unidentified.
  const second = {
    id: "po-2",
    supplierId: "sup-addwood",
    items: [{ materialCode: "FOAM-D24-2" }],
  };
  const tiers = tiersFor({ supplierId: "sup-new", linkedPo: [ADD_WOOD_PO, second] });
  const a = resolveMaterialForLine(`9MM 4' X 8' PLYWOOD AB`, tiers);
  const b = resolveMaterialForLine("FOAM D24 2INCH SHEET", tiers);
  assert.equal(a.tier, "po");
  assert.equal(a.item.itemCode, "PLY-9-48-AB");
  assert.equal(b.tier, "po");
  assert.equal(b.item.itemCode, "FOAM-D24-2");
});

test("materialsOnPo takes one order or several, interchangeably", () => {
  assert.deepEqual(
    materialsOnPo([ADD_WOOD_PO], byCode).map((m) => m.itemCode),
    materialsOnPo(ADD_WOOD_PO, byCode).map((m) => m.itemCode),
  );
});

test("the linked PO is what it searches first, and it says so", () => {
  const tiers = tiersFor({ linkedPo: ADD_WOOD_PO });
  const m = resolveMaterialForLine(`9MM 4' X 8' PLYWOOD AB`, tiers);
  assert.equal(m.tier, "po", "the order we wrote is the strongest evidence there is");
  assert.equal(m.via, "text");
});

test("PO history carries a supplier with no linked PO on this document", () => {
  // A delivery note that never quotes our PO ref still belongs to a supplier we
  // have bought from before.
  const tiers = tiersFor({ purchaseOrders: [ADD_WOOD_PO] });
  const m = resolveMaterialForLine(`9MM 4' X 8' PLYWOOD AB`, tiers);
  assert.ok(m);
  assert.equal(m.item.itemCode, "PLY-9-48-AB");
  assert.equal(m.tier, "supplier");
});

test("a brand-new supplier falls through to the catalogue, not to nothing", () => {
  const tiers = tiersFor({ supplierId: "sup-never-seen" });
  const m = resolveMaterialForLine(`9MM 4' X 8' PLYWOOD AB`, tiers);
  assert.ok(m, "an exact reading identifies the item whoever sent it");
  assert.equal(m.item.itemCode, "PLY-9-48-AB");
  assert.equal(m.tier, "catalog");
});

// ── The bar rises as the field widens ───────────────────────────────────────

test("the catalogue tier demands more than a scoped tier does", () => {
  const line = "PLYWOOD 9MM AB";
  // Scoped to the one board this supplier buys, it is unambiguous.
  const scoped = resolveMaterialForLine(line, tiersFor({ linkedPo: {
    id: "po-2",
    supplierId: "sup-addwood",
    items: [{ materialCode: "PLY-9-48-AB" }],
  } }));
  assert.ok(scoped, "one candidate leaves nothing to be ambiguous about");

  // Across the whole catalogue the same words fit two boards that differ only
  // by a size the supplier did not state.
  assert.equal(
    resolveMaterialForLine(line, tiersFor({ supplierId: "sup-never-seen" })),
    null,
    "a wide search must not resolve a line that names no size",
  );
});

test("CATALOG_MIN_SCORE is genuinely stricter than the scoped default", () => {
  assert.ok(CATALOG_MIN_SCORE > 0.5, "0.5 across thousands of rows is a family resemblance");
});

test("a wrong match is never preferred to no match", () => {
  const tiers = tiersFor({ linkedPo: ADD_WOOD_PO });
  assert.equal(
    resolveMaterialForLine("DELIVERY CHARGE", tiers),
    null,
    "a narrow field must not lower what counts as identification",
  );
  assert.equal(resolveMaterialForLine("", tiers), null);
});

// ── The supplier's own code is a lookup, not a guess ────────────────────────

test("a supplier code seen on a past PO resolves outright", () => {
  const idx = supplierSkuIndex("sup-addwood", [ADD_WOOD_PO], [], byCode);
  const m = resolveMaterialForLine("anything at all", tiersFor(), {
    supplierSku: "AW-9",
    skuIndex: idx,
  });
  assert.ok(m);
  assert.equal(m.item.itemCode, "PLY-9-48-AB");
  assert.equal(m.via, "sku", "this is a lookup — no scoring was involved");
});

test("OCR drift in the supplier code does not break the lookup", () => {
  const idx = supplierSkuIndex("sup-addwood", [ADD_WOOD_PO], [], byCode);
  for (const drift of ["aw 9", "AW.9", "AW-9", "aw9"]) {
    const m = resolveMaterialForLine("", tiersFor(), { supplierSku: drift, skuIndex: idx });
    assert.ok(m, `${drift} should reach the same row`);
    assert.equal(m.item.itemCode, "PLY-9-48-AB");
  }
});

test("a supplier code that two materials claim is dropped, not guessed", () => {
  const messy = [
    {
      id: "po-x",
      supplierId: "sup-addwood",
      items: [
        { materialCode: "PLY-9-48-AB", supplierSKU: "AW-PLY" },
        { materialCode: "PLY-18-48", supplierSKU: "AW-PLY" },
      ],
    },
  ];
  const idx = supplierSkuIndex("sup-addwood", messy, [], byCode);
  assert.equal(idx.has("AWPLY"), false, "an ambiguous code must not silently pick a side");
});

test("bindings still feed the index — they are added to, not replaced", () => {
  const idx = supplierSkuIndex(
    "sup-addwood",
    [],
    [{ supplierId: "sup-addwood", materialCode: "FOAM-D24-2", supplierSku: "F-24" }],
    byCode,
  );
  assert.equal(idx.get("F24")?.itemCode, "FOAM-D24-2");
});

// ── Tier construction ───────────────────────────────────────────────────────

test("materialsOnPo reads only that PO's lines", () => {
  const got = materialsOnPo(ADD_WOOD_PO, byCode).map((m) => m.itemCode);
  assert.deepEqual(got, ["PLY-9-48-AB", "PLY-18-48"]);
  assert.deepEqual(materialsOnPo(null, byCode), []);
  assert.deepEqual(materialsOnPo({ id: "p", items: null }, byCode), []);
});

test("materialsEverBought spans POs and bindings without duplicating", () => {
  const got = materialsEverBought(
    "sup-addwood",
    [ADD_WOOD_PO, ADD_WOOD_PO],
    [{ supplierId: "sup-addwood", materialCode: "FOAM-D24-2" }],
    byCode,
  ).map((m) => m.itemCode);
  assert.deepEqual(got, ["PLY-9-48-AB", "PLY-18-48", "FOAM-D24-2"]);
});

test("another supplier's orders are not this supplier's materials", () => {
  const other = { id: "po-o", supplierId: "sup-other", items: [{ materialCode: "LEG-6-CHR" }] };
  assert.deepEqual(materialsEverBought("sup-addwood", [other], [], byCode), []);
});

test("a code with no catalogue row is skipped rather than faked", () => {
  const stale = { id: "po-s", supplierId: "sup-addwood", items: [{ materialCode: "GONE-1" }] };
  assert.deepEqual(materialsEverBought("sup-addwood", [stale], [], byCode), []);
});

test("a redundant supplier tier is not emitted", () => {
  // The PO covers everything we have ever bought, so a second identical tier
  // would only mislabel where the match came from.
  const tiers = buildCandidateTiers({
    supplierId: "sup-addwood",
    linkedPo: ADD_WOOD_PO,
    purchaseOrders: [ADD_WOOD_PO],
    bindings: [],
    materialByCode: byCode,
    catalog: CATALOG,
  });
  assert.deepEqual(tiers.map((t) => t.tier), ["po", "catalog"]);
});

test("an empty catalogue yields no tiers at all", () => {
  const tiers = buildCandidateTiers({
    supplierId: "sup-new",
    purchaseOrders: [],
    bindings: [],
    materialByCode: byCode,
    catalog: [],
  });
  assert.deepEqual(tiers, []);
  assert.equal(resolveMaterialForLine("PLYWOOD", tiers), null);
});

test("normKey folds every way OCR writes the same code", () => {
  assert.equal(normKey("SL.27"), "SL27");
  assert.equal(normKey("sl 27"), "SL27");
  assert.equal(normKey("SL-27"), "SL27");
  assert.equal(normKey(null), "");
});
