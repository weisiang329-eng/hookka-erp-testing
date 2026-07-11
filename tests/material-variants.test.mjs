import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/material-variants.ts")).href);

test("materialVariantCode — base/variant with '/' separator", () => {
  assert.equal(m.materialVariantCode("NC36/50", "6mm"), "NC36/50/6mm");
  assert.equal(m.materialVariantCode(" NC36/50 ", ' 1" '), 'NC36/50/1"');
});

test("materialVariantDescription — base + variant, or just variant when blank", () => {
  assert.equal(m.materialVariantDescription("Foam Sheet", "6mm"), "Foam Sheet 6mm");
  assert.equal(m.materialVariantDescription("", "6mm"), "6mm");
  assert.equal(m.materialVariantDescription("  ", '2"'), '2"');
});

test("seed — FOAM variant list present", () => {
  assert.ok(Array.isArray(m.DEFAULT_MATERIAL_VARIANTS.FOAM));
  assert.ok(m.DEFAULT_MATERIAL_VARIANTS.FOAM.includes("6mm"));
  assert.ok(m.DEFAULT_MATERIAL_VARIANTS.FOAM.includes('1"'));
});
