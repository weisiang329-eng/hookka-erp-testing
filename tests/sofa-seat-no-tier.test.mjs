// ---------------------------------------------------------------------------
// sofa-seat-no-tier.test.mjs — structural pins for BUG-2026-07-27-001.
//
// A sofa product with NO seatHeightPrices matrix (a new model nobody has
// priced yet, e.g. 5549 seat 20") used to be impossible to order: every
// seat-size pick was silently RESET back to "" by selectSeatHeight, so the
// "please select a seat size" validation blocked Save forever. The backend
// explicitly allows RM0 lines (owner 2026-06-11), so the discard was FE-only.
//
// The fix (owner 2026-07-27 「应该要可以开单先，之后 edit 价格」): keep the
// operator's pick when the product has no seat-price matrix; Base Price stays
// manual. These tests pin the keep-pick branch in ALL FOUR line editors
// (sales create/edit + consignment create/edit — CN/CO mirrors DO-side by
// design) so a refactor can't silently reintroduce the reset in any of them.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FILES = {
  "sales/create.tsx": "../src/pages/sales/create.tsx",
  "sales/edit.tsx": "../src/pages/sales/edit.tsx",
  "consignment/create.tsx": "../src/pages/consignment/create.tsx",
  "consignment/edit.tsx": "../src/pages/consignment/edit.tsx",
};

const srcs = Object.fromEntries(
  Object.entries(FILES).map(([label, rel]) => [
    label,
    readFileSync(new URL(rel, import.meta.url), "utf8"),
  ]),
);

for (const [label, src] of Object.entries(srcs)) {
  test(`${label}: no-matrix seat pick is KEPT, not silently reset`, () => {
    // The old combined guard reset the pick whenever the product had no
    // seat-price matrix. It must stay gone.
    assert.doesNotMatch(
      src,
      /if \(!value \|\| !tiers\)|if \(!value \|\| !prod\?\.seatHeightPrices\)/,
      "the old reset-on-no-matrix guard must not come back",
    );
    // The keep-pick branch exists and persists the picked size.
    assert.match(
      src,
      /keep the operator's pick/,
      "keep-pick branch (BUG-2026-07-27-001) must be present",
    );
    assert.match(
      src,
      /\{ seatHeight: value, sizeLabel: value, sizeCode \}/,
      "keep-pick branch must persist seatHeight + sizeLabel + sizeCode",
    );
    // Clearing the field still resets — the reset path survives for !value.
    assert.match(
      src,
      /if \(!value\) \{/,
      "explicit clear must still reset the line",
    );
  });
}
