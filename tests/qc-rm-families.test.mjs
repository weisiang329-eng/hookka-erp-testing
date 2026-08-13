// ---------------------------------------------------------------------------
// A goods-receipt line must reach the checklist that matches the MATERIAL, and
// it must do so off the AutoCount item group rather than off whatever text the
// supplier printed on their delivery order.
//
// Owner 2026-08-08: "你可以看一下我们大部分的供应商都是进的什么货物 … 针对我们
// 是 bedframe 或者沙发的生产商，我们的 raw material 基本上都会进什么东西，需要
// 检查什么东西？"
//
// The taxonomy is the one already in the repo — `StockCategory`
// (src/types/index.ts) read in the routing direction. (The forward map used to
// live in src/lib/material-lookup.ts; that file had no importer and was
// deleted, so ITEM_GROUP_TO_FAMILY is now the only copy.)
// Routing off the group is what makes a NEW
// material code inherit the right checks the moment it is filed correctly.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  ITEM_GROUP_TO_FAMILY,
  RM_FAMILIES,
  RM_FAMILY_DEFAULT_TEMPLATE_ID,
  pickRmTemplate,
  rmFamiliesOnReceipt,
  rmFamilyForLine,
} from "../src/api/lib/qc-rm-families.ts";

test("every item group in the material taxonomy routes to a family", () => {
  // These are the groups the BOM's StockCategory maps onto.
  // B.OTHERS is deliberately not in the direct table — it holds two
  // families and is handled separately below.
  const groups = [
    "B.M-FABR", "S.M-FABR", "S-FABR", "PLYWOOD",
    "BED-FILL", "SOFA-FIL", "WEBBING", "EQUIPMEN", "PACKING",
  ];
  for (const g of groups) {
    assert.ok(ITEM_GROUP_TO_FAMILY[g], `${g} has no family — a receipt of it would fall to GENERAL`);
    assert.ok(RM_FAMILIES.includes(ITEM_GROUP_TO_FAMILY[g]));
  }
});

test("every family has a seeded template id", () => {
  for (const f of RM_FAMILIES) {
    assert.ok(RM_FAMILY_DEFAULT_TEMPLATE_ID[f], `${f} has no template — its receipts would go uninspected`);
  }
});

test("bedframe and sofa fabric share one checklist; their fillers do not", () => {
  // Same five observations either grade (swatch, width, dye-lot, defects,
  // length), so one template. Splitting it would only create two rows that
  // drift apart.
  assert.equal(rmFamilyForLine({ itemGroup: "B.M-FABR" }), "FABRIC");
  assert.equal(rmFamilyForLine({ itemGroup: "S.M-FABR" }), "FABRIC");
  assert.equal(rmFamilyForLine({ itemGroup: "S-FABR" }), "FABRIC");

  // Sofa foam is density-graded PU (a stamped density rating, a rebound spec);
  // bedframe filler is sheet/fibre measured in GSM and loft. Running one
  // checklist on both produces four N/A answers.
  assert.equal(rmFamilyForLine({ itemGroup: "SOFA-FIL" }), "SOFA_FOAM");
  assert.equal(rmFamilyForLine({ itemGroup: "BED-FILL" }), "BED_FILLER");
});

test("webbing and mechanism cannot be split by product line — the data does not carry it", () => {
  // WEBBING/S_WEBBING both map to 'WEBBING', MECHANISM/S_MECHANISM both to
  // 'EQUIPMEN'. Two templates would be a guess; the single template carries a
  // "matches the retained sample for THIS product line" item instead.
  assert.equal(rmFamilyForLine({ itemGroup: "WEBBING" }), "WEBBING");
  assert.equal(rmFamilyForLine({ itemGroup: "EQUIPMEN" }), "MECHANISM");
});

test("plywood is not timber", () => {
  // Delamination, core voids, ply count and face grade are plywood problems;
  // knots, moisture and straightness are solid-timber problems. Sending a
  // plywood delivery through the timber checklist looks like QC and finds
  // nothing.
  assert.equal(rmFamilyForLine({ itemGroup: "PLYWOOD" }), "PLYWOOD");
  assert.notEqual(rmFamilyForLine({ itemGroup: "PLYWOOD" }), "TIMBER");
});

test("B.OTHERS is the one ambiguous group and splits on the material text", () => {
  // The taxonomy folds BOTH wood strip and accessories into B.OTHERS, so the
  // group alone cannot route it. Wood words win; everything else falls to
  // ACCESSORIES rather than being guessed into a timber checklist it would
  // fail on every item.
  assert.equal(
    rmFamilyForLine({ itemGroup: "B.OTHERS", materialName: "Wood strip 2x2 meranti" }),
    "TIMBER",
  );
  assert.equal(
    rmFamilyForLine({ itemGroup: "B.OTHERS", materialCode: "TIMBER-45", materialName: "45mm" }),
    "TIMBER",
  );
  assert.equal(
    rmFamilyForLine({ itemGroup: "B.OTHERS", materialName: "Chrome leg 4 inch" }),
    "ACCESSORIES",
  );
  assert.equal(
    rmFamilyForLine({ itemGroup: "B.OTHERS", materialName: "Button stud gold" }),
    "ACCESSORIES",
  );
});

test("an unresolved or unknown material falls to GENERAL, never to nothing", () => {
  assert.equal(rmFamilyForLine({}), "GENERAL");
  assert.equal(rmFamilyForLine({ itemGroup: null }), "GENERAL");
  assert.equal(rmFamilyForLine({ itemGroup: "SOMETHING-NEW" }), "GENERAL");
});

test("a mixed receipt reports every family on it, once each", () => {
  const families = rmFamiliesOnReceipt([
    { itemGroup: "S.M-FABR" },
    { itemGroup: "S.M-FABR" },
    { itemGroup: "B.M-FABR" },
    { itemGroup: "PLYWOOD" },
    { itemGroup: "B.OTHERS", materialName: "Wood strip" },
  ]);
  assert.deepEqual(families.sort(), ["FABRIC", "PLYWOOD", "TIMBER"]);
});

test("pickRmTemplate prefers a family tag, then the seeded id, then GENERAL", () => {
  const tagged = { id: "custom-1", stage: "RM", active: 1, materialFamily: "PLYWOOD" };
  const seeded = { id: "qct-rm-plywood", stage: "RM", active: 1, materialFamily: null };
  const general = { id: "qct-rm-general", stage: "RM", active: 1, materialFamily: "GENERAL" };

  assert.equal(pickRmTemplate([tagged, seeded, general], "PLYWOOD").id, "custom-1");
  // A database where migration 0215's UPDATE has not run yet still routes,
  // because the seeded ids are known.
  assert.equal(pickRmTemplate([seeded, general], "PLYWOOD").id, "qct-rm-plywood");
  // Nothing for this family at all → the general incoming checklist, so the
  // receipt is still inspected.
  assert.equal(pickRmTemplate([general], "PLYWOOD").id, "qct-rm-general");
  // Nothing at all → null. The caller MUST count and report this rather than
  // substituting a checklist that does not fit the goods.
  assert.equal(pickRmTemplate([], "PLYWOOD"), null);
});

test("pickRmTemplate has the hook a per-supplier override needs", () => {
  // No template carries a supplier today and qc_templates has no supplier
  // column — this is the shape a later override slots into without reshaping
  // generation or the templates that already exist.
  const generic = { id: "qct-rm-wood", stage: "RM", active: 1, materialFamily: "TIMBER" };
  const perSupplier = { id: "qct-rm-wood-addwood", stage: "RM", active: 1, materialFamily: "TIMBER", supplierId: "sup-addwood" };

  assert.equal(pickRmTemplate([generic, perSupplier], "TIMBER", "sup-addwood").id, "qct-rm-wood-addwood");
  assert.equal(pickRmTemplate([generic, perSupplier], "TIMBER", "sup-other").id, "qct-rm-wood");
  assert.equal(pickRmTemplate([generic, perSupplier], "TIMBER").id, "qct-rm-wood");
});

test("an inactive or non-RM template is never used for a receipt", () => {
  const inactive = { id: "qct-rm-plywood", stage: "RM", active: 0, materialFamily: "PLYWOOD" };
  const wipRow = { id: "qct-wip-x", stage: "WIP", active: 1, materialFamily: "PLYWOOD" };
  assert.equal(pickRmTemplate([inactive, wipRow], "PLYWOOD"), null);
});
