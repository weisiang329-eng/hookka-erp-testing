// ---------------------------------------------------------------------------
// sofa-combo-pass-components.test.mjs
//
// BUG-CLASS C1, the THIRD site — the recompute SHARED by Sales Orders and
// Consignment Orders.
//
// `runSofaComboPass` renegotiates a matched sofa set down to its combo total by
// rewriting each affected line's basePriceSen, then recomputing that line's
// unit price and line total. That recompute named FOUR of the five price
// components and dropped the per-line discount:
//
//     it.unitPriceSen = calculateUnitPrice({ base, divan, leg, special });
//     it.lineTotalSen = calculateLineTotal(unit, qty);          // ← no discount
//
// so any renegotiated line lost its total-height surcharge from the stored unit
// price, and had its discount handed back to us in the stored line total. Both
// halves make the SAVE disagree with the screen — the create page's own combo
// preview passes `getLineTotal(l)`, i.e. discount included, and lists
// totalHeight among the per-unit surcharges.
//
// Fixing only consignment-orders.ts would have left this one, and it is on both
// document types' path. That is the whole reason BUG-CLASSES.md exists.
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
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;

const { runSofaComboPass } = await import(src("src/api/lib/sofa-combo-pass.ts"));

// Two modules of model 5531 at seat 28", tier PRICE_1, negotiated as a set for
// RM 2,000.00. Each line also carries a RM 80.00 total-height surcharge and the
// second carries a RM 50.00 line discount.
const COMBO_TOTAL_SEN = 200000;
const TOTAL_HEIGHT_SEN = 8000;
const DISCOUNT_SEN = 5000;

function makeDb() {
  function prepare(sql) {
    const s = String(sql);
    let bound = [];
    const rows = () => {
      if (/FROM products/i.test(s)) {
        return [
          { id: "p-1", baseModel: "5531" },
          { id: "p-2", baseModel: "5531" },
        ];
      }
      if (/FROM fabric_trackings/i.test(s)) {
        return [{ fabricCode: "F-1", sofaPriceTier: "PRICE_1", priceTier: null }];
      }
      if (/FROM sofa_combo_rules/i.test(s)) {
        return [
          {
            baseModel: "5531",
            componentSizes: JSON.stringify(["1A(LHF)", "2A(RHF)"]),
            fabricTier: "PRICE_1",
            pricesByHeight: JSON.stringify({ 28: COMBO_TOTAL_SEN }),
            customerId: null,
            effectiveFrom: "2020-01-01",
          },
        ];
      }
      return [];
    };
    const obj = {
      bind(...a) {
        bound = a;
        return obj;
      },
      async all() {
        void bound;
        return { results: rows() };
      },
      async first() {
        return rows()[0] ?? null;
      },
      async run() {
        return { success: true };
      },
    };
    return obj;
  }
  return { prepare, batch: async () => [] };
}

/** Two sofa lines priced ABOVE the combo total, so the pass renegotiates. */
function makeItems() {
  return [
    {
      id: "i-1",
      productId: "p-1",
      productCode: "5531-1A(LHF)",
      itemCategory: "SOFA",
      sizeCode: "28",
      sizeLabel: "28",
      fabricCode: "F-1",
      quantity: 1,
      basePriceSen: 130000,
      divanPriceSen: 0,
      legPriceSen: 0,
      totalHeightPriceSen: TOTAL_HEIGHT_SEN,
      specialOrderPriceSen: 0,
      discountSen: 0,
      unitPriceSen: 138000,
      lineTotalSen: 138000,
    },
    {
      id: "i-2",
      productId: "p-2",
      productCode: "5531-2A(RHF)",
      itemCategory: "SOFA",
      sizeCode: "28",
      sizeLabel: "28",
      fabricCode: "F-1",
      quantity: 1,
      basePriceSen: 120000,
      divanPriceSen: 0,
      legPriceSen: 0,
      totalHeightPriceSen: TOTAL_HEIGHT_SEN,
      specialOrderPriceSen: 0,
      discountSen: DISCOUNT_SEN,
      unitPriceSen: 128000,
      lineTotalSen: 123000,
    },
  ];
}

const rawItems = [{ seatHeight: "28" }, { seatHeight: "28" }];

test("the combo recompute keeps the total-height surcharge in the stored unit price", async () => {
  const items = makeItems();
  await runSofaComboPass(makeDb(), "cust-1", items, rawItems);

  assert.notEqual(
    items[0].basePriceSen,
    130000,
    "fixture check: the pass must actually have renegotiated these lines",
  );
  for (const it of items) {
    assert.equal(
      it.unitPriceSen,
      it.basePriceSen + it.totalHeightPriceSen,
      `unit price must be base + EVERY surcharge. Dropping totalHeightPriceSen ` +
        `understates this line by ${TOTAL_HEIGHT_SEN} sen (RM 80.00).`,
    );
  }
});

test("the combo recompute does not hand the per-line discount back to us", async () => {
  const items = makeItems();
  await runSofaComboPass(makeDb(), "cust-1", items, rawItems);

  assert.equal(
    items[0].lineTotalSen,
    items[0].unitPriceSen * items[0].quantity,
    "an undiscounted line is unit × qty",
  );
  assert.equal(
    items[1].lineTotalSen,
    items[1].unitPriceSen * items[1].quantity - DISCOUNT_SEN,
    `the discount the operator granted must survive the recompute — it used to be ` +
      `overwritten, so the order stored RM 50.00 MORE than the screen quoted`,
  );
});

test("a line with no total-height component is byte-identical to before the fix", async () => {
  // The mirror-image risk: `?? 0` must not start inventing a surcharge on the
  // lines (every sofa line on prod today) that legitimately have none.
  const items = makeItems().map((it) => ({ ...it, totalHeightPriceSen: 0 }));
  await runSofaComboPass(makeDb(), "cust-1", items, rawItems);
  for (const it of items) {
    assert.equal(it.unitPriceSen, it.basePriceSen);
  }
  assert.equal(
    items.reduce((s, i) => s + i.lineTotalSen, 0),
    COMBO_TOTAL_SEN - DISCOUNT_SEN,
    "the agreed combo total still holds, less the operator's own discount",
  );
});

test("an item type that predates the field is tolerated, not crashed on", async () => {
  // ComboPassItem's two new members are optional because callers built before
  // 2026-08-13 do not set them. Absent must read as 0, never NaN.
  const items = makeItems().map(({ totalHeightPriceSen: _t, discountSen: _d, ...rest }) => rest);
  await runSofaComboPass(makeDb(), "cust-1", items, rawItems);
  for (const it of items) {
    assert.ok(Number.isFinite(it.unitPriceSen), "unit price must not be NaN");
    assert.equal(it.unitPriceSen, it.basePriceSen);
    assert.equal(it.lineTotalSen, it.unitPriceSen * it.quantity);
  }
});
