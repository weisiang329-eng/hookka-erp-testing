// ---------------------------------------------------------------------------
// scan-supplier-scoped-match.test.mjs — search the SUPPLIER, not the catalogue.
//
// Owner 2026-08-04: "这个供应商里面有什么 code 也是唯一的，他应该是看到这个供应商，
// 去供应商里面找，不是吗？"
//
// Right, and it matters more than convenience. Two plywoods that differ only in
// size score almost identically, so choosing between them on a fuzzy score is a
// guess about a REAL physical difference — a 4x8 sheet is not a 1220x2440 sheet
// just because the words look alike. Scoping the search to what a supplier
// actually supplies turns an ambiguous problem into an easy one.
//
// The first version of this scoped to `supplier_material_bindings`, which was
// too narrow to be useful: a binding only exists after somebody has already
// picked that line by hand, so the FIRST appearance of an item searched an
// empty list and always fell through to a manual pick. Owner, same day:
// "为什么第一次一定要手动 pick 呢？… 他一定要能自己找啊."
//
// So the scoping now comes from a ladder (see supplier-material-candidates):
// the linked PO, then everything ever ordered from this supplier, then the
// whole catalogue at a stricter bar. These tests hold the wiring; the ladder's
// own behaviour is covered in supplier-material-candidates.test.mjs.
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

test("both scan modes resolve through the tiered ladder", () => {
  assert.equal(
    SRC.split("resolveMaterialForLine(text, tiers, {").length - 1,
    2,
    "create-PI and create-GRN must behave identically",
  );
  assert.equal(
    SRC.split("const tiers = tiersFor(sId, linkedPos);").length - 1,
    2,
    "each mode builds its own tiers from the card's resolved PO",
  );
});

test("no path searches the whole catalogue at the scoped bar", () => {
  assert.equal(
    SRC.split("matchCatalogItem(text, rawMaterials)").length - 1,
    0,
    "an unscoped search at the default threshold is what made matches unsafe",
  );
  assert.equal(
    SRC.split("materialsForSupplier(").length - 1,
    0,
    "the bindings-only candidate set is gone, not merely bypassed",
  );
});

test("the PO is resolved before the lines, not after", () => {
  // Tier 1 is the linked PO's own lines, so the link has to exist while each
  // line is being identified. Resolving it afterwards — as both modes used to —
  // leaves the strongest evidence unused.
  const piPoIdx = SRC.indexOf("const tiers = tiersFor(sId, linkedPos);");
  const piLinesIdx = SRC.indexOf("const lines: PreviewLine[]");
  assert.ok(piPoIdx > 0 && piLinesIdx > piPoIdx, "create-PI resolves the PO first");

  const grnLinesIdx = SRC.indexOf("const lines: GRNPreviewLine[]");
  const grnPoIdx = SRC.lastIndexOf("const tiers = tiersFor(sId, linkedPos);", grnLinesIdx);
  assert.ok(grnPoIdx > 0 && grnLinesIdx > grnPoIdx, "create-GRN resolves the PO first");
});

test("the code index is built the way the lookups key it", () => {
  // `materialByCode` (trim+uppercase) and the ladder's index (punctuation
  // stripped) are NOT interchangeable — sharing the former silently produces
  // empty candidate sets for every hyphenated code, which is most of them.
  assert.equal(
    SRC.split("indexByCode(rawMaterials)").length - 1,
    2,
    "both modes must build the ladder's own index",
  );
});

test("the operator can always correct a line by hand", () => {
  // The picker used to be narrowed to materials the supplier had a BINDING
  // for, so a supplier with none got an EMPTY dropdown — no auto-match AND no
  // way to fix it without first creating the binding on another page. Owner
  // 2026-08-04: "他可以 manually pick，当错的时候". The coherence intent is now
  // carried by ordering: the supplier's own materials first, the rest below.
  assert.equal(
    SRC.split("const internalCodeOptionsFor = useCallback(").length - 1,
    2,
    "both modes must offer the full catalogue, ranked",
  );
  assert.equal(
    SRC.split("internalCodeOptionsBy").length - 1,
    0,
    "the bindings-only dropdown is gone, not merely reordered",
  );
  assert.match(SRC, /not supplied by this supplier before/);
});

test("a catalogue-tier guess is not allowed to teach a binding", () => {
  // Creating a document now writes a supplier↔material binding. A binding
  // resolves silently forever, so a weak guess that got learned would stop
  // being flagged and become permanent. Both create paths must mark it.
  assert.equal(
    SRC.split(`l.autoMatched === true && l.matchTier === "catalog"`).length - 1,
    2,
    "create-PI and create-GRN must both flag the uncorroborated tier",
  );
});

test("the operator is told which tier answered", () => {
  // A PO line and a bare catalogue reading must not look alike on the row.
  assert.match(SRC, /function matchTierHint\(/);
  assert.match(SRC, /matchTierHint\(line\.matchTier\)/);
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

test("Supplier SKU is filled from the binding even on a text match", () => {
  // `binding?.supplierSku ?? rawSku` left the column blank whenever the line
  // resolved by TEXT — and ADD WOOD prints no code, so rawSku was "" too. The
  // operator saw an empty Supplier SKU next to a correct Internal Code while
  // the SKU dropdown was offering the right value all along.
  assert.equal(
    SRC.split("binding ?? (sId && rm ? resolveBindingForMaterial(sId, rm.itemCode) : null)")
      .length - 1,
    2,
    "create-PI and create-GRN must both back-fill",
  );
  assert.equal(
    SRC.split("const sku = binding?.supplierSku ?? rawSku;").length - 1,
    0,
    "the binding-only read is what left the column empty",
  );
  assert.match(SRC, /const sku = resolvedBinding\?\.supplierSku \?\? rawSku;/);
});

test("a binding pointing at a missing material is named on the card", () => {
  // Otherwise it is invisible: gone from the auto-match and from the Internal
  // Code dropdown, still listed in the Supplier SKU dropdown.
  assert.equal(SRC.split("brokenBindingsFor = useCallback(").length - 1, 2);
  assert.match(SRC, /not in the active catalogue/);
});
