// ---------------------------------------------------------------------------
// cn-value.test.mjs — behavioral tests for src/api/lib/cn-value.ts.
//
// cn-value.ts is the CN twin of do-value.ts: it derives each Consignment
// Note's "value of goods" by pricing every CN line at its OWN consignment-
// order line price (consignment_order_items.unitPriceSen), NOT the CN item's
// own unitPrice (which is routinely 0 — pricing lives on the CO). A CN can
// span multiple COs, so each item resolves its CO via the item's
// productionOrderId → production_orders.consignmentOrderId, with the CN
// header's consignmentOrderId as a fallback.
//
// These tests drive the REAL loadCnValueMap against a small mock D1 that
// pattern-matches the four bulk SELECTs the module issues (same mock-DB
// approach as worker-auth.test.mjs). The assertions are on the resolved
// money, not on query-string formatting.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const { loadCnValueMap } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/cn-value.ts")).href
);

// ---------------------------------------------------------------------------
// Mock D1 — routes the four bulk SELECTs loadCnValueMap issues through a
// pattern-match dispatch. Seed shape mirrors the real (camelCase) columns.
//
//   consignment_order_items: { consignmentOrderId, productCode, unitPriceSen }
//   production_orders:       { id, consignmentOrderId }   (CO-sourced only)
//   consignment_items:       { consignmentNoteId, productionOrderId, productCode, quantity }
//   consignment_notes:       { id, consignmentOrderId }
// ---------------------------------------------------------------------------
function makeDb(seed) {
  function prepare(sql) {
    const s = sql.trim().replace(/\s+/g, " ");
    return {
      bind() {
        return this;
      },
      async all() {
        if (/FROM consignment_order_items/i.test(s)) {
          return {
            results: seed.coItems.map((r) => ({
              consignmentOrderId: r.consignmentOrderId,
              productCode: r.productCode,
              unitPriceSen: r.unitPriceSen,
            })),
          };
        }
        if (/FROM production_orders/i.test(s)) {
          // Module filters `consignmentOrderId IS NOT NULL` in SQL; honor it.
          return {
            results: seed.productionOrders
              .filter((p) => p.consignmentOrderId != null)
              .map((p) => ({
                id: p.id,
                consignmentOrderId: p.consignmentOrderId,
              })),
          };
        }
        if (/FROM consignment_items/i.test(s)) {
          return {
            results: seed.cnItems.map((r) => ({
              consignmentNoteId: r.consignmentNoteId,
              productionOrderId: r.productionOrderId,
              productCode: r.productCode,
              quantity: r.quantity,
            })),
          };
        }
        if (/FROM consignment_notes/i.test(s)) {
          return {
            results: seed.cns.map((r) => ({
              id: r.id,
              consignmentOrderId: r.consignmentOrderId,
            })),
          };
        }
        return { results: [] };
      },
      async first() {
        return null;
      },
    };
  }
  return { prepare };
}

// ---------------------------------------------------------------------------
// Core case: ONE CN, TWO items, each from a DIFFERENT CO. Each item resolves
// to ITS OWN CO's unitPriceSen × qty, and the CN value is the sum. A third
// item whose product has no CO price contributes 0.
// ---------------------------------------------------------------------------
test("loadCnValueMap: multi-CO CN sums each item at its own CO price; unmatched item = 0", async () => {
  const seed = {
    // CO-A prices SOFA1 @ 100000 sen; CO-B prices BED1 @ 250000 sen.
    coItems: [
      { consignmentOrderId: "co-A", productCode: "SOFA1", unitPriceSen: 100000 },
      { consignmentOrderId: "co-B", productCode: "BED1", unitPriceSen: 250000 },
    ],
    // Each PO is sourced from its own CO.
    productionOrders: [
      { id: "po-A", consignmentOrderId: "co-A" },
      { id: "po-B", consignmentOrderId: "co-B" },
      { id: "po-X", consignmentOrderId: "co-A" }, // no CO price for its product
    ],
    // CN header points at co-A, but item 2 is from co-B (multi-CO CN). The
    // per-item productionOrderId is what selects the correct CO.
    cns: [{ id: "cn-1", consignmentOrderId: "co-A" }],
    cnItems: [
      // item 1 → po-A → co-A → SOFA1 @ 100000 × 2 = 200000
      {
        consignmentNoteId: "cn-1",
        productionOrderId: "po-A",
        productCode: "SOFA1",
        quantity: 2,
      },
      // item 2 → po-B → co-B → BED1 @ 250000 × 1 = 250000
      {
        consignmentNoteId: "cn-1",
        productionOrderId: "po-B",
        productCode: "BED1",
        quantity: 1,
      },
      // item 3 → po-X → co-A, but co-A has no price for GHOST9 → 0
      {
        consignmentNoteId: "cn-1",
        productionOrderId: "po-X",
        productCode: "GHOST9",
        quantity: 5,
      },
    ],
  };

  const db = makeDb(seed);
  const map = await loadCnValueMap(db, "hookka");

  // 200000 (co-A SOFA1×2) + 250000 (co-B BED1×1) + 0 (unmatched) = 450000.
  assert.equal(
    map.get("cn-1"),
    450000,
    "CN value must sum each item priced at ITS OWN CO line (multi-CO), unmatched item contributing 0",
  );
});

// ---------------------------------------------------------------------------
// Guard: an item with no PO link and no matching header-CO price → 0, and a
// CN with zero priced items is still present in the map at 0 (parity with
// do-value's `?? 0` fallback so the FE never reads undefined).
// ---------------------------------------------------------------------------
test("loadCnValueMap: item with no CO match contributes 0 (header-CO fallback miss)", async () => {
  const seed = {
    coItems: [
      { consignmentOrderId: "co-A", productCode: "SOFA1", unitPriceSen: 100000 },
    ],
    productionOrders: [{ id: "po-A", consignmentOrderId: "co-A" }],
    // CN header has NO parent CO; its single item has no PO link either, so
    // there is no CO to resolve a price from → 0.
    cns: [{ id: "cn-2", consignmentOrderId: null }],
    cnItems: [
      {
        consignmentNoteId: "cn-2",
        productionOrderId: null,
        productCode: "SOFA1",
        quantity: 3,
      },
    ],
  };

  const db = makeDb(seed);
  const map = await loadCnValueMap(db, "hookka");

  assert.equal(
    map.get("cn-2"),
    0,
    "an item with no resolvable CO (no PO link, no header CO) must contribute 0",
  );
});
