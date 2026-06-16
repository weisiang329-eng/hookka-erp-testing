import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/bs-section.ts")).href);

test("defaultBsSection — type + code band (incl 480-489 NCL fix)", () => {
  assert.equal(m.defaultBsSection("130-0000", "ASSET"), "FIXED_ASSET");
  assert.equal(m.defaultBsSection("300-0000", "ASSET"), "CURRENT_ASSET");
  assert.equal(m.defaultBsSection("400-0000", "LIABILITY"), "CURRENT_LIABILITY");
  assert.equal(m.defaultBsSection("485-0000", "LIABILITY"), "LONG_TERM_LIABILITY");
  assert.equal(m.defaultBsSection("500-0000", "EQUITY"), "EQUITY");
  assert.equal(m.defaultBsSection("900-0001", "EXPENSE"), null);
});

test("bsSectionClass", () => {
  assert.equal(m.bsSectionClass("FIXED_ASSET"), "asset");
  assert.equal(m.bsSectionClass("CURRENT_ASSET"), "asset");
  assert.equal(m.bsSectionClass("CURRENT_LIABILITY"), "liabeq");
  assert.equal(m.bsSectionClass("LONG_TERM_LIABILITY"), "liabeq");
  assert.equal(m.bsSectionClass("EQUITY"), "liabeq");
});

test("bsSectionFor — any valid override wins (cross-side allowed), null stays null", () => {
  assert.equal(m.bsSectionFor("400-0000", "LIABILITY", { "400-0000": "LONG_TERM_LIABILITY" }), "LONG_TERM_LIABILITY");
  assert.equal(m.bsSectionFor("130-0000", "ASSET", { "130-0000": "CURRENT_LIABILITY" }), "CURRENT_LIABILITY");
  assert.equal(m.bsSectionFor("130-0000", "ASSET", { "130-0000": "NONSENSE" }), "FIXED_ASSET");
  assert.equal(m.bsSectionFor("485-0000", "LIABILITY", {}), "LONG_TERM_LIABILITY");
  assert.equal(m.bsSectionFor("900-0001", "EXPENSE", { "900-0001": "EQUITY" }), null);
});
