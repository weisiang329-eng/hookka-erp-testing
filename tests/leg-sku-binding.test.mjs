// ---------------------------------------------------------------------------
// leg-sku-binding.test.mjs — explicit leg-height → raw-material SKU binding.
//
// Owner 2026-07-30: leg raw-material consumption must stop GUESSING the SKU
// from the leg's inch height (the old `description LIKE '%N"%' AND '%LEG%'`
// fuzzy match) and instead deduct the EXACT SKU the shop binds to each leg
// height in Maintenance → Leg Heights. Quantity is unchanged — it stays the
// BOM leg line's qty; the binding only decides WHICH raw material.
//
// Contract pinned here (source-level structural pins, house style — no DB / no
// worker runtime):
//   Backend (src/api/lib/po-cost-cascade.ts):
//     (i)   resolveBoundLegSku() reads kv_config['variants-config'] and looks
//           up the leg height in legHeights / sofaLegHeights.
//     (ii)  SOFA orders consult sofaLegHeights, others consult legHeights.
//     (iii) The LEG autoDetect branch prefers the bound SKU BEFORE the legacy
//           fuzzy description fallback (order matters — binding is
//           authoritative).
//     (iv)  The binding is resolved ONCE per PO (not re-read per line).
//   Frontend (src/pages/products/index.tsx):
//     (v)   PricedOption carries an optional legSku.
//     (vi)  updateLegSku writer + a SKU <select> bound to entry.legSku, on the
//           leg tabs only.
//     (vii) The active raw-materials list is fetched for the picker.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CASCADE = resolve(process.cwd(), "src/api/lib/po-cost-cascade.ts");
const PRODUCTS_FE = resolve(process.cwd(), "src/pages/products/index.tsx");

function read(p) {
  return readFileSync(p, "utf8");
}
function flat(p) {
  return read(p).replace(/\s+/g, " ");
}

// ===========================================================================
// Backend — po-cost-cascade.ts
// ===========================================================================

test("(i) resolveBoundLegSku reads kv_config['variants-config']", () => {
  const f = flat(CASCADE);
  assert.match(
    f,
    /async function resolveBoundLegSku\s*\(/,
    "resolveBoundLegSku must exist — it resolves the explicit leg→SKU binding.",
  );
  assert.match(
    f,
    /SELECT value FROM kv_config WHERE key = \?[\s\S]*?\.bind\("variants-config"\)/,
    "resolveBoundLegSku must read the variants-config blob from kv_config.",
  );
});

test("(ii) SOFA consults sofaLegHeights, others consult legHeights", () => {
  const f = flat(CASCADE);
  assert.match(
    f,
    /itemCategory \?\? ""\)\.toUpperCase\(\) === "SOFA"/,
    "category discrimination (SOFA vs bedframe) must drive which leg list is primary.",
  );
  assert.match(
    f,
    /isSofa \? cfg\.sofaLegHeights : cfg\.legHeights/,
    "SOFA orders must consult sofaLegHeights first; everything else legHeights.",
  );
});

test("(iii) LEG branch prefers the bound SKU BEFORE the fuzzy fallback", () => {
  const src = read(CASCADE);
  const legBranch = src.indexOf('line.autoDetect === "LEG"');
  assert.ok(legBranch !== -1, "LEG autoDetect branch must exist.");
  const boundUse = src.indexOf("boundLegSku", legBranch);
  const fuzzy = src.indexOf("description LIKE", legBranch);
  assert.ok(boundUse !== -1, "LEG branch must use the resolved boundLegSku.");
  assert.ok(fuzzy !== -1, "the legacy fuzzy description fallback must remain.");
  assert.ok(
    boundUse < fuzzy,
    "the bound SKU must be checked BEFORE the fuzzy description match — binding is authoritative.",
  );
});

test("(iv) the leg binding is resolved once per PO (not per line)", () => {
  const src = read(CASCADE);
  // The resolveBoundLegSku call sits ABOVE the `for (const line of lines)`
  // loop inside substituteAutoDetectMaterials.
  const fnStart = src.indexOf("async function substituteAutoDetectMaterials");
  assert.ok(fnStart !== -1, "substituteAutoDetectMaterials must exist.");
  const resolveCall = src.indexOf("await resolveBoundLegSku(", fnStart);
  const loop = src.indexOf("for (const line of lines)", fnStart);
  assert.ok(resolveCall !== -1 && loop !== -1);
  assert.ok(
    resolveCall < loop,
    "resolveBoundLegSku must be awaited ONCE before the per-line loop, not inside it.",
  );
});

// ===========================================================================
// Frontend — products/index.tsx (Maintenance → Leg Heights)
// ===========================================================================

test("(v) PricedOption carries an optional legSku", () => {
  assert.match(
    flat(PRODUCTS_FE),
    /type PricedOption = \{[^}]*legSku\?: string[^}]*\}/,
    "PricedOption must have an optional legSku for the leg→SKU binding.",
  );
});

test("(vi) updateLegSku writer + a SKU select bound to entry.legSku", () => {
  const f = flat(PRODUCTS_FE);
  assert.match(
    f,
    /function updateLegSku\s*\(\s*idx: number,\s*legSku: string\s*\)/,
    "updateLegSku writer must exist.",
  );
  assert.match(
    f,
    /value=\{entry\.legSku \?\? ""\}[\s\S]*?onChange=\{\(e\) => updateLegSku\(idx, e\.target\.value\)\}/,
    "the leg row must render a SKU picker bound to entry.legSku via updateLegSku.",
  );
  assert.match(
    f,
    /isLegTab &&/,
    "the SKU picker must be gated to the leg tabs.",
  );
});

test("(vii) the active raw-materials list is fetched for the picker", () => {
  assert.match(
    flat(PRODUCTS_FE),
    /\/api\/raw-materials\?status=ACTIVE/,
    "active raw materials must be fetched to populate the leg SKU picker.",
  );
});
