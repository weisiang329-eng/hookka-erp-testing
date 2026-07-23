// ---------------------------------------------------------------------------
// price-component-class.test.mjs
//
// The second CLASS test. Its subject is the defect that has now been fixed
// three separate times, one column at a time:
//
//   2026-07-14  totalHeightPriceSen   recompute dropped a client-sent field
//   2026-07-17  specialOrderPriceSen  BUG-2026-07-17-002, RM 8,060 / 66 SOs
//   2026-07-22  divanPriceSen + legPriceSen                 RM 12,455
//
// Every time, the author noticed the class — the 07-17 file header literally
// says "This is the same bug class as the 2026-07-14 totalHeightPriceSen fix"
// — and still repaired only their own column, because the sibling components
// sat on adjacent lines and nothing forced anyone to count them.
//
// So this test counts them. `unit_price = base + divan + leg + special` is the
// contract (src/lib/pricing.ts); each priced component must reach the stored
// price through a RESOLVER that can derive it when the client omits the field,
// not through `Number(item.X) || 0`, which silently stores 0 for every client
// that does not compute prices — i.e. both scan-PO paths.
//
// Adding a fifth component means adding it to COMPONENTS here, and this test
// fails until it is wired the same way.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  divanHeightOptions,
  specialOrderOptions,
} from "../src/lib/pricing-options.ts";

const SO = readFileSync(resolve(process.cwd(), "src/api/routes/sales-orders.ts"), "utf8");

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
];

for (const { field, resolver, note } of COMPONENTS) {
  test(`${field} is resolved server-side, not taken on trust`, () => {
    const naive = new RegExp(`const\\s+${field}\\s*=\\s*Number\\(item\\.${field}\\)\\s*\\|\\|\\s*0`);
    assert.doesNotMatch(
      SO,
      naive,
      `\`Number(item.${field}) || 0\` stores whatever the client posted, and the scan-PO ` +
        `clients post nothing — ${note}. Route it through ${resolver}() instead, which ` +
        `trusts a supplied number (including a deliberate 0) and derives ONLY when the ` +
        `field was omitted.`,
    );
    assert.match(SO, new RegExp(`${resolver}\\(`), `${field} must go through ${resolver}()`);
  });
}

test("both write paths — POST and PUT — resolve every component", () => {
  // A fix applied only to create leaves editing a scanned order re-storing 0.
  for (const { field, resolver } of COMPONENTS) {
    const uses = SO.match(new RegExp(`${resolver}\\(`, "g")) ?? [];
    assert.ok(
      uses.length >= 2,
      `${resolver} (for ${field}) appears ${uses.length}x — it must be called from BOTH the ` +
        `POST and the PUT item loops.`,
    );
  }
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
