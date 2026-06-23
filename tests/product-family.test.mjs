import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/product-family.ts")).href);

// Regression: the Catalog tile grid groups by FAMILY (familyOf the code), one
// level coarser than the stored baseModel — so 1003 / 1003(A) / 1003(A)(HF)(W)
// and all their sizes collapse into ONE "1003" tile + one family photo.
test("familyOf — strips size, config/version, and sofa piece suffixes", () => {
  // Bedframe 1003 family: size + config + version suffixes all dropped.
  assert.equal(m.familyOf("1003(A)(HF)(W)-(K)"), "1003");
  assert.equal(m.familyOf("1003(A)-(SP)"), "1003");
  assert.equal(m.familyOf("1003-(SS)"), "1003");
  assert.equal(m.familyOf("1003"), "1003");
  // Other bedframe families.
  assert.equal(m.familyOf("1007(HF)(W)-(Q)"), "1007");
  assert.equal(m.familyOf("2009(A)-(152X200)"), "2009");
  assert.equal(m.familyOf("2010(A)-(K)"), "2010");
  assert.equal(m.familyOf("1005-(SK)"), "1005");
  // Sofa 5535 pieces all collapse to one family.
  assert.equal(m.familyOf("5535-1A(LHF)"), "5535");
  assert.equal(m.familyOf("5535-CNR"), "5535");
  assert.equal(m.familyOf("5535-3S"), "5535");
  // DIVAN base piece (the only real non-numeric family) handled.
  assert.equal(m.familyOf("DIVAN-(K)"), "DIVAN");
});

test("familyOf — trims + uppercases, tolerates blanks", () => {
  assert.equal(m.familyOf("  divan-(k) "), "DIVAN");
  assert.equal(m.familyOf(""), "");
  assert.equal(m.familyOf(undefined), "");
});

// MAJOR-fix regression: a shared-prefix dash code (e.g. accessories
// ACC-001 / ACC-002) must NOT collapse into one "ACC" family — the dash there
// separates real codes, not a size. Only a trailing -(size) parenthesised
// segment is stripped from non-numeric codes.
test("familyOf — does NOT over-collapse dash-prefixed (non-size) codes", () => {
  assert.equal(m.familyOf("ACC-001"), "ACC-001");
  assert.equal(m.familyOf("ACC-002"), "ACC-002");
  assert.notEqual(m.familyOf("ACC-001"), m.familyOf("ACC-002"));
  // a -(size) on a non-numeric base IS still stripped:
  assert.equal(m.familyOf("DIVAN-(Q)"), "DIVAN");
});

// One family = one tile: distinct baseModels under the same family share a key.
test("familyOf — collapses the 1003 family to a single group key", () => {
  const codes = ["1003-(SS)", "1003(A)-(SP)", "1003(A)(HF)(W)-(K)"];
  const keys = new Set(codes.map(m.familyOf));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], "1003");
});
