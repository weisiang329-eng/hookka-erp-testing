// ---------------------------------------------------------------------------
// The Stock Adjustments picker must read the fields the API actually sends.
//
// It did not. `WipOpt` declared `code` / `type` / `stockQty`; GET
// /api/inventory/wip has only ever sent `wipCode` / `wipType` / `totalQty`.
// Every option rendered as the literal "()" — the owner's screenshot on
// 2026-08-08 is a full page of them — and the submitted quantity was
// `undefined`. `stock_adjustments` has ZERO rows on prod, which is not a
// coincidence: the screen has been unusable since it shipped.
//
// A type that names fields nobody sends is not caught by tsc, because both
// sides typecheck fine against their own idea of the shape. This test is the
// only thing that can catch it, so it compares the two files directly.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(process.cwd(), "src/pages/inventory/adjustments.tsx"), "utf8");
const route = readFileSync(resolve(process.cwd(), "src/api/routes/inventory-wip.ts"), "utf8");

test("the WIP picker reads the field names the route emits", () => {
  // The route's response literal — the fields it genuinely returns.
  const emitted = route.slice(route.indexOf("rows.push({"), route.indexOf("rows.push({") + 700);
  for (const field of ["wipCode", "wipType", "totalQty"]) {
    assert.ok(emitted.includes(`${field}:`), `the route should still emit ${field}`);
    assert.ok(page.includes(`w.${field}`), `the picker must read w.${field}, not a renamed guess`);
  }

  // And must NOT read the three that were never sent. Matched on a word
  // boundary: a bare includes("w.type") also matches "row.type", which is
  // everywhere and entirely correct — a test that fails on correct code is
  // worse than no test.
  for (const dead of ["code", "type", "stockQty"]) {
    assert.doesNotMatch(
      page,
      new RegExp(`\\bw\\.${dead}\\b`),
      `w.${dead} is not a field this route returns`,
    );
  }
});

test("an option says enough to pick the right row out of 1,400", () => {
  // "()" was unusable, but so is a bare code when the list is this long — the
  // label has to carry what the row is and how many are on hand.
  // The OPTION block, not the category-filter block above it — both open with
  // the same `row.type === "WIP"` guard.
  const optIdx = page.indexOf("<option key={w.id}");
  assert.ok(optIdx > 0, "the WIP option element should exist");
  const block = page.slice(optIdx, page.indexOf("</option>", optIdx));
  assert.ok(block.includes("w.wipCode"), "the code");
  assert.ok(block.includes("w.relatedProduct"), "what product it belongs to");
  assert.ok(block.includes("w.totalQty"), "and the quantity being corrected");
});

test("all three stock types are offered, as the backend already accepts", () => {
  assert.match(
    page,
    /TYPE_OPTIONS: AdjustmentType\[\] = \["RM", "WIP", "FG"\]/,
    "FG was missing from the picker while the backend accepted it all along",
  );
  const api = readFileSync(resolve(process.cwd(), "src/api/routes/stock-adjustments.ts"), "utf8");
  assert.match(api, /VALID_TYPES: AdjustmentType\[\] = \["RM", "WIP", "FG"\]/);
});
