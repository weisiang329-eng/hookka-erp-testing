// ---------------------------------------------------------------------------
// order-edit-unit-price — the ORDER edit screens must SHOW the price they SAVE.
//
// The same disease the invoice screen had ("Jager 是 305，edit 的时候就会变成
// 308"), one document earlier: `src/pages/sales/edit.tsx` computed a line's unit
// as base + divan + leg + special — FOUR components — while
// `PUT /api/sales-orders/:id` stores FIVE, because `resolveTotalHeightPriceSen`
// DERIVES the total-height surcharge whenever the client omits the field, and
// this page had no idea the field existed. Operator edits an order, reads
// RM 830.00 on screen, saves, and the order is worth RM 910.00.
//
// These assert BEHAVIOUR — what the screen displays vs what the save charges —
// not the shape of the implementation. The two source guards at the bottom
// exist for one reason: the fix is only a fix if the sum stays in ONE place.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  calculateUnitPrice,
  formatOrderLineUnit,
  orderLinePriceBuildUp,
} from "../src/lib/pricing.ts";
import {
  deriveTotalHeightSurchargeSen,
  resolveTotalHeightPriceSen,
} from "../src/lib/total-height-surcharge.ts";
// The app's own money formatter — Intl puts a NON-BREAKING space after "RM", so
// expectations are composed with it rather than typed as literals.
import { formatCurrency } from "../src/lib/utils.ts";
const rm = (sen) => formatCurrency(sen);

// The owner's variants-config.totalHeights, as the page and the PUT both read it.
const CFG = [
  { value: '26"', priceSen: 8000 },
  { value: '28"', priceSen: 16000 },
];

// A stored bedframe line carrying a total-height surcharge: 14" gap + 8" divan
// + 4" leg = 26" → RM 80. Base 830.00, unit 910.00.
const STORED_LINE = {
  itemCategory: "BEDFRAME",
  seatHeight: "",
  quantity: 1,
  gapInches: 14,
  divanHeightInches: 8,
  legHeightInches: 4,
  basePriceSen: 83000,
  divanPriceSen: 0,
  legPriceSen: 0,
  specialOrderPriceSen: 0,
  totalHeightPriceSen: 8000,
};

/** What the edit screen puts on the "Unit:" line for an item in its state. */
const displayedUnitSen = (item) => calculateUnitPrice(item);

/**
 * What `PUT /api/sales-orders/:id` stores for the payload this screen posts.
 * Mirrors the handler: every component resolved with the client's value when it
 * sent one, derived when it did not, then summed by `calculateUnitPrice`.
 */
function savedUnitSen(payload, { isServiceOrder = false } = {}) {
  return calculateUnitPrice({
    basePriceSen: Number(payload.basePriceSen) || 0,
    divanPriceSen: Number(payload.divanPriceSen) || 0,
    legPriceSen: Number(payload.legPriceSen) || 0,
    specialOrderPriceSen: Number(payload.specialOrderPriceSen) || 0,
    totalHeightPriceSen: resolveTotalHeightPriceSen(
      payload.totalHeightPriceSen,
      payload.gapInches,
      payload.divanHeightInches,
      payload.legHeightInches,
      CFG,
      isServiceOrder,
    ),
  });
}

/** The page's `updateItem`: gap/divan/leg change → re-derive the surcharge. */
function editHeights(item, updates, { isServiceOrder = false, cfg = CFG } = {}) {
  const merged = { ...item, ...updates };
  if (isServiceOrder) {
    merged.totalHeightPriceSen = 0;
  } else if (Array.isArray(cfg)) {
    merged.totalHeightPriceSen = deriveTotalHeightSurchargeSen(
      (merged.gapInches || 0) + (merged.divanHeightInches || 0) + (merged.legHeightInches || 0),
      cfg,
    );
  }
  return merged;
}

// ---------------------------------------------------------------------------
// (A) displayed === saved, on a line with a T.Height component
// ---------------------------------------------------------------------------

test("the unit shown on the edit screen is the unit the save charges", () => {
  const displayed = displayedUnitSen(STORED_LINE);
  assert.equal(displayed, 91000, "830.00 base + 80.00 T.Height");
  assert.equal(savedUnitSen(STORED_LINE), displayed);
});

test("the four-term sum this page used to show is NOT what the save charges", () => {
  // The bug, stated as an inequality so it can never quietly come back.
  const fourTerms =
    STORED_LINE.basePriceSen +
    STORED_LINE.divanPriceSen +
    STORED_LINE.legPriceSen +
    STORED_LINE.specialOrderPriceSen;
  assert.equal(fourTerms, 83000);
  assert.notEqual(fourTerms, savedUnitSen(STORED_LINE));
  assert.equal(savedUnitSen(STORED_LINE) - fourTerms, 8000, "exactly the T.Height component");
});

test("a payload that OMITS totalHeightPriceSen is repriced by the server", () => {
  // Why carrying the field matters: omit it and the PUT derives its own number,
  // which is precisely how the screen and the stored order came apart.
  const { totalHeightPriceSen: _dropped, ...omitted } = STORED_LINE;
  void _dropped;
  assert.equal(savedUnitSen(omitted), 91000);
  assert.notEqual(savedUnitSen(omitted), 83000);
});

test("Save with nothing typed charges exactly what was already charged", () => {
  // Rule 5, order side: the seed is the line's own stored component, so an
  // open-and-save round trip is a no-op — even when the config no longer prices
  // that height, and even when the stored surcharge was hand-set.
  for (const stored of [0, 8000, 16000, 9999]) {
    const line = { ...STORED_LINE, totalHeightPriceSen: stored };
    assert.equal(savedUnitSen(line), displayedUnitSen(line), `stored ${stored}`);
    assert.equal(savedUnitSen(line), 83000 + stored);
  }
});

test("changing a height moves the screen and the save together", () => {
  // 8" divan → 10" divan: total 26" → 28", RM 80 → RM 160.
  const edited = editHeights(STORED_LINE, { divanHeightInches: 10 });
  assert.equal(edited.totalHeightPriceSen, 16000);
  assert.equal(displayedUnitSen(edited), 99000);
  assert.equal(savedUnitSen(edited), displayedUnitSen(edited));
});

test("an unpriced total height charges nothing, on screen and in the save", () => {
  const edited = editHeights(STORED_LINE, { legHeightInches: 0 }); // 22" — not in the list
  assert.equal(edited.totalHeightPriceSen, 0);
  assert.equal(displayedUnitSen(edited), 83000);
  assert.equal(savedUnitSen(edited), displayedUnitSen(edited));
});

test("service orders stay free, on screen and in the save", () => {
  const edited = editHeights(STORED_LINE, { divanHeightInches: 10 }, { isServiceOrder: true });
  assert.equal(edited.totalHeightPriceSen, 0);
  assert.equal(displayedUnitSen(edited), 83000);
  assert.equal(savedUnitSen(edited, { isServiceOrder: true }), displayedUnitSen(edited));
});

test("with the config unavailable the line keeps its stored surcharge — not zero", () => {
  // A price we cannot look up is not a price of zero. Whatever is kept is still
  // both displayed and posted, so the two can't disagree.
  const edited = editHeights(STORED_LINE, { divanHeightInches: 10 }, { cfg: null });
  assert.equal(edited.totalHeightPriceSen, 8000);
  assert.equal(savedUnitSen(edited), displayedUnitSen(edited));
});

// ---------------------------------------------------------------------------
// (B) a build-up that does not add up is not displayed
// ---------------------------------------------------------------------------

test("a non-reconciling build-up is not displayed — the single price is", () => {
  // Charge 910.00 against components summing to 830.00: the decomposition is
  // refused outright rather than printed next to a number it contradicts.
  const contradicted = { ...STORED_LINE, totalHeightPriceSen: 0 };
  assert.equal(orderLinePriceBuildUp(contradicted, 91000), undefined);
  assert.equal(formatOrderLineUnit(contradicted, 91000), rm(91000));
  assert.ok(!formatOrderLineUnit(contradicted, 91000).includes("("));
});

test("a build-up that DOES reconcile is itemised, T.Height included", () => {
  const rows = orderLinePriceBuildUp(STORED_LINE, 91000);
  assert.deepEqual(rows.map((r) => r.label), ["Base", "+ T.Height", "="]);
  assert.equal(rows.at(-1).sen, 91000, "the '=' row is the charge, never a recomputed sum");
  assert.equal(
    formatOrderLineUnit(STORED_LINE, 91000),
    `${rm(91000)} (Base ${rm(83000)} + T.Height ${rm(8000)})`,
  );
});

test("the headline figure is the charge, reconciling or not", () => {
  for (const charge of [0, 1, 83000, 91000, 30798]) {
    assert.ok(
      formatOrderLineUnit(STORED_LINE, charge).startsWith(
        formatOrderLineUnit({ basePriceSen: charge }, charge),
      ),
      `charge ${charge}`,
    );
  }
});

test("no surcharge → no build-up (base IS the charge, nothing to explain)", () => {
  const plain = { basePriceSen: 109424 };
  assert.equal(orderLinePriceBuildUp(plain, 109424), undefined);
  assert.equal(formatOrderLineUnit(plain, 109424), rm(109424));
});

test("the seat height decorates Base without breaking the sum", () => {
  const sofa = { basePriceSen: 50000, specialOrderPriceSen: 8000 };
  assert.equal(
    formatOrderLineUnit(sofa, 58000, '28"'),
    `${rm(58000)} (Base @28" ${rm(50000)} + Special ${rm(8000)})`,
  );
});

// ---------------------------------------------------------------------------
// (C) structural — ONE sum, ONE build-up renderer
// ---------------------------------------------------------------------------

const SCREENS = ["src/pages/sales/edit.tsx", "src/pages/consignment/edit.tsx"];

test("neither order edit screen hand-rolls the component sum", () => {
  for (const path of SCREENS) {
    const src = readFileSync(resolve(process.cwd(), path), "utf8");
    assert.doesNotMatch(
      src,
      /basePriceSen\s*\+\s*item\.divanPriceSen/,
      `${path}: the sum must come from calculateUnitPrice, not a local copy`,
    );
    assert.match(src, /calculateUnitPrice\(/, `${path}: must use the shared sum`);
    assert.match(
      src,
      /formatOrderLineUnit\(/,
      `${path}: the build-up must go through the guarded shared renderer`,
    );
    assert.doesNotMatch(
      src,
      /\+ Divan \$\{formatCurrency/,
      `${path}: no unguarded inline build-up`,
    );
  }
});

test("the SO edit screen carries the fifth component through its payload", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/sales/edit.tsx"), "utf8");
  // In the LineItem type, seeded from the loaded order, and re-derived when a
  // height changes. Any one of these missing and the save drifts again.
  assert.match(src, /totalHeightPriceSen: number;/, "state must carry it");
  assert.match(
    src,
    /totalHeightPriceSen: \(item\.totalHeightPriceSen as number\) \|\| 0/,
    "seeded from the line's own stored component",
  );
  assert.match(src, /deriveTotalHeightSurchargeSen\(/, "re-derived with the server's helper");
});
