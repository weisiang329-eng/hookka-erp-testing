// ---------------------------------------------------------------------------
// sofa-size-columns.test.mjs — structural pins for the dynamic SOFA seat-price
// columns in Products SKU Master (BUG-2026-07-27-001 follow-up).
//
// The sofa price columns used to be HARDCODED to 24/28/30/32/35, so a seat
// size added in Maintenance → Sizes (e.g. 20", and the long-standing 26")
// could never be priced in the grid — the create-SO dropdown and the price
// grid read different sources. The columns now derive from the SAME
// Maintenance `sofaSizes` list (kv variants-config), numerically sorted.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/pages/products/index.tsx", import.meta.url),
  "utf8",
);

test("SOFA price columns are built from the Maintenance sofaSizes list", () => {
  assert.match(
    src,
    /\.\.\.sofaHeights\.map\(SOFA_HEIGHT_COL\)/,
    "buildBaseCols must spread dynamic height columns",
  );
  assert.match(
    src,
    /sofaHeightsFromConfig\(maintenanceConfig\)/,
    "the height list must come from the live Maintenance config",
  );
  // No static per-height column definition may come back.
  assert.doesNotMatch(
    src,
    /\{ key: "h24"/,
    "static h24 column definition must stay gone",
  );
});

test("height list is cleaned, deduped, numerically sorted, with a fallback", () => {
  assert.match(src, /function sofaHeightsFromConfig\(/);
  assert.match(
    src,
    /sort\(\(a, b\) => Number\(a\) - Number\(b\)\)/,
    "sizes must sort numerically (20 before 24), not lexically",
  );
  assert.match(
    src,
    /DEFAULT_MAINTENANCE_CONFIG\.sofaSizes/,
    "empty/malformed config must fall back to the default size list",
  );
});

test("sort, filter, and price cells all follow the dynamic height keys", () => {
  assert.match(
    src,
    /const H_COL_RE = \/\^h\(\\d\+\(\?:\\\.\\d\+\)\?\)\$\//,
    "shared h-key regex must exist",
  );
  // Sort + filter switches use the regex instead of per-height cases.
  assert.equal(
    (src.match(/H_COL_RE\.exec\(/g) ?? []).length >= 3,
    true,
    "sort/filter/label paths must resolve dynamic h-keys via H_COL_RE",
  );
  assert.doesNotMatch(
    src,
    /case "h24":/,
    "hardcoded per-height switch cases must stay gone",
  );
  // The editable price-cell loop follows the same dynamic list.
  assert.match(
    src,
    /for \(const h of sofaHeightList\.map\(\(n\) => `\$\{n\}"`\)\)/,
    "price cells must iterate the dynamic height list",
  );
});
