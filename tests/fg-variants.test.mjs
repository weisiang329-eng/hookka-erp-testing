import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/fg-variants.ts")).href);

// Naming rules verified against live prod catalog data:
//   bedframe 1003 → "1003-(K)" / "HILTON BEDFRAME (6FT) (183X190CM)"
//   sofa 5539     → "5539-1A(LHF)" / "SOFA 5539 1A(LHF)"

test("bedframeVariantCode — base + (sizeCode)", () => {
  assert.equal(m.bedframeVariantCode("1003", "K"), "1003-(K)");
  assert.equal(m.bedframeVariantCode(" 2050(A) ", " Q "), "2050(A)-(Q)");
});

test("bedframeVariantName — base + (label) + (dimensions)", () => {
  assert.equal(
    m.bedframeVariantName("HILTON BEDFRAME", { code: "K", label: "6FT", dimensions: "183X190CM" }),
    "HILTON BEDFRAME (6FT) (183X190CM)",
  );
});

test("bedframeVariantName — blank label / dimensions drop their parens", () => {
  assert.equal(
    m.bedframeVariantName("ROMA", { code: "K", label: "", dimensions: "" }),
    "ROMA",
  );
  assert.equal(
    m.bedframeVariantName("ROMA", { code: "K", label: "6FT", dimensions: "" }),
    "ROMA (6FT)",
  );
});

test("sofaVariantCode — base + compartment", () => {
  assert.equal(m.sofaVariantCode("5539", "1A(LHF)"), "5539-1A(LHF)");
  assert.equal(m.sofaVariantCode("5531", "2A(LHF)"), "5531-2A(LHF)");
});

test("sofaVariantName — base name wins, else SOFA <model> <compartment>", () => {
  // No base name → the catalog's default shape (matches prod SOFA 5539 1A(LHF)).
  assert.equal(m.sofaVariantName("", "5539", "1A(LHF)"), "SOFA 5539 1A(LHF)");
  // Custom base name → "<name> <compartment>".
  assert.equal(m.sofaVariantName("ROMA SOFA", "5539", "1A(LHF)"), "ROMA SOFA 1A(LHF)");
});

test("seed catalogs — bedframe sizes + sofa compartments present", () => {
  assert.ok(m.DEFAULT_BEDFRAME_SIZES.some((s) => s.code === "K" && s.label === "6FT"));
  assert.ok(m.DEFAULT_BEDFRAME_SIZES.every((s) => s.code && s.dimensions));
  assert.ok(m.DEFAULT_SOFA_COMPARTMENTS.includes("1A(LHF)"));
  assert.ok(m.DEFAULT_SOFA_COMPARTMENTS.includes("2A(RHF)"));
});
