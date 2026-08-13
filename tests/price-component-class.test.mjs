// ---------------------------------------------------------------------------
// price-component-class.test.mjs
//
// The second CLASS test. Its subject is the defect that has now been fixed
// three separate times, one column at a time:
//
//   2026-07-14  totalHeightPriceSen   recompute dropped a client-sent field
//   2026-07-17  specialOrderPriceSen  BUG-2026-07-17-002, RM 8,060 / 66 SOs
//   2026-07-22  divanPriceSen + legPriceSen                 RM 12,455
//   2026-08-13  ALL FOUR, on the CONSIGNMENT order          BUG-2026-08-13-040
//
// Every time, the author noticed the class — the 07-17 file header literally
// says "This is the same bug class as the 2026-07-14 totalHeightPriceSen fix"
// — and still repaired only their own column, because the sibling components
// sat on adjacent lines and nothing forced anyone to count them.
//
// The 2026-08-13 pass is the same lesson one level up: every one of those four
// fixes was applied to `sales-orders.ts` alone, and this test read only that
// file — so `consignment-orders.ts`, a structural clone writing the same
// columns for the same customers, kept `Number(it.X) || 0` on three components
// and omitted the fourth from its INSERT entirely. The axis this test counts is
// therefore DOCUMENT TYPE × COMPONENT, not component alone.
//
// So this test counts them. `unit_price = base + divan + leg + totalHeight +
// special` is the contract (src/lib/pricing.ts); each priced component must
// reach the stored price through a RESOLVER that can derive it when the client
// omits the field, not through `Number(item.X) || 0`, which silently stores 0
// for every client that does not compute prices — i.e. both scan-PO paths.
//
// Adding a component means adding it to COMPONENTS here; adding a document type
// that stores a priced line means adding it to DOCUMENTS. Either fails until it
// is wired the same way.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  divanHeightOptions,
  specialOrderOptions,
} from "../src/lib/pricing-options.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

/** Every route that stores a priced order line. Both write the SAME columns. */
const DOCUMENTS = [
  { name: "sales order", path: "src/api/routes/sales-orders.ts" },
  { name: "consignment order", path: "src/api/routes/consignment-orders.ts" },
];

const COMPONENTS = [
  {
    field: "divanPriceSen",
    resolver: "resolveHeightPriceSen",
    note: "scan-po-modal posts divanHeightInches with no price (RM 9,895 lost)",
  },
  {
    field: "legPriceSen",
    resolver: "resolveHeightPriceSen",
    note: "same, legHeightInches (RM 2,560 lost)",
  },
  {
    field: "specialOrderPriceSen",
    resolver: "resolveSpecialOrderPriceSen",
    note: "BUG-2026-07-17-002, RM 8,060 across 66 SOs",
  },
  {
    field: "totalHeightPriceSen",
    resolver: "resolveTotalHeightPriceSen",
    note:
      "0 of 125 eligible SO lines charged (RM 10,240) before 2026-07-23; on the CO " +
      "side the component was dropped from the INSERT altogether, so the saved total " +
      "was LOWER than the total the operator approved on screen (BUG-2026-08-13-040)",
  },
];

for (const { name, path } of DOCUMENTS) {
  const SRC = read(path);

  for (const { field, resolver, note } of COMPONENTS) {
    test(`${name}: ${field} is resolved server-side, not taken on trust`, () => {
      // Anchored to a `const x = Number(y.field) || 0` DECLARATION — the shape
      // that feeds the stored unit price. Projections that merely echo a posted
      // value into a throwaway BOM-check row are not this bug and must not be
      // flagged, or the test cries wolf and gets muted.
      const naive = new RegExp(
        `const\\s+\\w+\\s*=\\s*Number\\(\\w+\\.${field}\\)\\s*\\|\\|\\s*0`,
      );
      assert.doesNotMatch(
        SRC,
        naive,
        `${path}: \`Number(x.${field}) || 0\` stores whatever the client posted, and the ` +
          `scan-PO clients post nothing — ${note}. Route it through ${resolver}() instead, ` +
          `which trusts a supplied number (including a deliberate 0) and derives ONLY when ` +
          `the field was omitted.`,
      );
      assert.match(
        SRC,
        new RegExp(`${resolver}\\(`),
        `${path}: ${field} must go through ${resolver}()`,
      );
    });
  }

  test(`${name}: both write paths — POST and PUT — resolve every component`, () => {
    // A fix applied only to create leaves editing a scanned order re-storing 0.
    for (const { field, resolver } of COMPONENTS) {
      const uses = SRC.match(new RegExp(`${resolver}\\(`, "g")) ?? [];
      assert.ok(
        uses.length >= 2,
        `${path}: ${resolver} (for ${field}) appears ${uses.length}x — it must be called ` +
          `from BOTH the POST and the PUT item loops.`,
      );
    }
  });

  test(`${name}: the stored line names every component in its INSERT`, () => {
    // The CO route summed four components correctly and then left the fifth out
    // of the column list, so the value was computed and thrown away. A resolver
    // that nothing persists is not a fix.
    const inserts =
      SRC.match(/INSERT INTO \w*order_items \([^)]+\)/gi) ?? [];
    assert.ok(inserts.length >= 2, `${path}: expected a POST and a PUT item INSERT`);
    for (const ins of inserts) {
      for (const { field } of COMPONENTS) {
        assert.match(
          ins.replace(/\s+/g, " "),
          new RegExp(`\\b${field}\\b`),
          `${path}: an item INSERT omits ${field}. The component is computed and then ` +
            `discarded, which is exactly how the CO total came out lower than the ` +
            `quotation the operator approved.`,
        );
      }
    }
  });
}

test("the SHARED sofa-combo recompute drops nothing either", () => {
  // runSofaComboPass rewrites basePriceSen for a renegotiated set and then
  // recomputes that line's unit price and total — for BOTH document types. It
  // named four components and used a discount-free line total, so a combo line
  // silently lost its total-height surcharge and had its discount refunded to
  // us. One recompute, both documents: the third site of the same class.
  const SRC = read("src/api/lib/sofa-combo-pass.ts");
  const recompute = SRC.slice(SRC.indexOf("newBaseByKey.get(it.id)"));
  for (const part of [
    "basePriceSen",
    "divanPriceSen",
    "legPriceSen",
    "totalHeightPriceSen",
    "specialOrderPriceSen",
  ]) {
    assert.match(
      recompute,
      new RegExp(part),
      `sofa-combo-pass must include ${part} when it recomputes the unit price of a ` +
        `renegotiated line.`,
    );
  }
  assert.match(
    recompute,
    /calculateLineTotalWithDiscount\(/,
    "the recomputed line total must keep the per-line discount its caller already " +
      "subtracted — `calculateLineTotal(unit, qty)` hands it back to us.",
  );
});

test("the unit price is the sum of its components, nothing dropped", () => {
  const pricing = readFileSync(resolve(process.cwd(), "src/lib/pricing.ts"), "utf8");
  for (const part of [
    "basePriceSen",
    "divanPriceSen",
    "legPriceSen",
    "totalHeightPriceSen",
    "specialOrderPriceSen",
  ]) {
    assert.match(
      pricing,
      new RegExp(`input\\.${part}`),
      `calculateUnitPrice must include ${part}. Dropping one from the sum is exactly the ` +
        `2026-07-14 bug (totalHeightPriceSen was silently lost from the stored unit price).`,
    );
  }
});

// ---------------------------------------------------------------------------
// The other half of the same hazard: TWO price lists that disagree.
// ---------------------------------------------------------------------------
test("the static specials catalog matches the live config's own seeded values", () => {
  // priceOfSen() prefers kv_config variants-config.specials and falls back to
  // this static table when the config is missing or unreadable — and
  // loadSpecialsConfig degrades to null on ANY error, silently. On prod today
  // the two disagree: Left/Right Drawer RM 160 live vs RM 150 static, Front
  // Drawer RM 130 vs RM 120. That RM 10-per-line difference already cost a
  // real error during the 2026-07-17 backfill.
  //
  // A unit test cannot read prod KV, so this asserts the values a reviewer must
  // consciously change — if you edit the catalog, you are also telling whoever
  // maintains kv_config to match it (and vice versa). Update BOTH, or the
  // fallback quietly under-charges the moment the config fails to load.
  const EXPECTED_LIVE_SPECIALS = {
    "Left Drawer": 16000,
    "Right Drawer": 16000,
    "Front Drawer": 13000,
    "No Side Panel": -4000, // a DISCOUNT — the static table had +4000, an RM 80 swing
    "HB Fully Cover": 5000,
    "Divan Full Cover": 8000,
    "Divan Curve": 5000,
    "1 Piece Divan": 25000,
  };
  // Heights had drifted a whole price increase behind the live config —
  // every one RM 5–10 low — until 2026-07-23.
  const EXPECTED_LIVE_DIVAN = {
    '10"': 5500, '11"': 13000, '12"': 13000, '13"': 15000, '14"': 15000, '16"': 16000,
  };

  const drift = [];
  for (const [name, live] of Object.entries(EXPECTED_LIVE_SPECIALS)) {
    const hit = specialOrderOptions.find((o) => o.name === name);
    if (!hit) drift.push(`${name}: missing from the static catalog entirely`);
    else if (hit.surcharge !== live) drift.push(`${name}: static ${hit.surcharge} vs live config ${live}`);
  }
  for (const [h, live] of Object.entries(EXPECTED_LIVE_DIVAN)) {
    const hit = divanHeightOptions.find((o) => o.height === h);
    if (!hit) drift.push(`divan ${h}: missing from the static catalog entirely`);
    else if (hit.surcharge !== live) drift.push(`divan ${h}: static ${hit.surcharge} vs live config ${live}`);
  }
  assert.deepEqual(
    drift,
    [],
    `The static fallback catalog disagrees with the live kv_config prices:\n  ` +
      drift.join("\n  ") +
      `\n\nWhichever is right, make them equal — the fallback is used silently whenever ` +
      `loadSpecialsConfig() degrades, so a mismatch under-charges without any signal. ` +
      `If the owner deliberately changed the live price, update pricing-options.ts and ` +
      `EXPECTED_LIVE here together.`,
  );
});
