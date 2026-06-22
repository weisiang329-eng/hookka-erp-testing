// Unit tests for the material_code resolution helper used by the one-time
// backfill (POST /api/admin/backfill-import-data, Fix #2). Pure-function only —
// no DB. Run via `node --import tsx/esm --test tests/material-code-resolve.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/material-code-resolve.ts")).href
);

function makeLookups({ bindings = [], codes = [], names = {} } = {}) {
  const bindingByKey = new Map();
  for (const b of bindings) {
    bindingByKey.set(m.bindingKey(b.supplierId, b.supplierSku), b.materialCode);
  }
  const validCodes = new Set(codes.map((c) => m.normCode(c)));
  const codeByName = new Map();
  for (const [name, code] of Object.entries(names)) {
    codeByName.set(m.normName(name), code);
  }
  return { bindingByKey, validCodes, codeByName };
}

test("isValidCode / needsFix — blank, valid, and unknown codes", () => {
  const valid = new Set(["RM-001", "RM-002"]);
  assert.equal(m.isValidCode("RM-001", valid), true);
  assert.equal(m.isValidCode("rm-001 ", valid), true); // normalized
  assert.equal(m.isValidCode("", valid), false);
  assert.equal(m.isValidCode(null, valid), false);
  assert.equal(m.isValidCode("NOPE", valid), false);

  assert.equal(m.needsFix("RM-001", valid), false); // already good → leave alone
  assert.equal(m.needsFix("", valid), true);
  assert.equal(m.needsFix(null, valid), true);
  assert.equal(m.needsFix("WRONG-CODE", valid), true);
});

test("resolveMaterialCode — PRIMARY binding wins by (supplierId, supplierSku)", () => {
  const lookups = makeLookups({
    bindings: [{ supplierId: "sup-1", supplierSku: "ABC-99", materialCode: "RM-001" }],
    codes: ["RM-001", "RM-002"],
    names: { "Some Fabric": "RM-002" },
  });
  const r = m.resolveMaterialCode("sup-1", "abc-99", "Some Fabric", lookups);
  assert.deepEqual(r, { code: "RM-001", method: "binding" }); // binding beats name
});

test("resolveMaterialCode — FALLBACK to name when no binding", () => {
  const lookups = makeLookups({
    bindings: [],
    codes: ["RM-002"],
    names: { "Black Foam 9MM": "RM-002" },
  });
  const r = m.resolveMaterialCode("sup-1", "UNKNOWN-SKU", "black foam 9mm", lookups);
  assert.deepEqual(r, { code: "RM-002", method: "name" });
});

test("resolveMaterialCode — name match is space/case insensitive", () => {
  const lookups = makeLookups({ codes: ["RM-003"], names: { "Plywood  18mm AA": "RM-003" } });
  const r = m.resolveMaterialCode("sup-1", "", "  plywood 18mm aa ", lookups);
  assert.deepEqual(r, { code: "RM-003", method: "name" });
});

test("resolveMaterialCode — returns null when nothing resolves (leave untouched)", () => {
  const lookups = makeLookups({ codes: ["RM-001"], names: { "Known": "RM-001" } });
  assert.equal(m.resolveMaterialCode("sup-1", "no-sku", "no name match", lookups), null);
  assert.equal(m.resolveMaterialCode("", "", "", lookups), null);
});

test("resolveMaterialCode — stale binding pointing at a non-existent RM is rejected", () => {
  // binding says RM-DEAD but that code isn't a valid raw_materials itemCode →
  // skip the binding and fall through (here name also fails → null).
  const lookups = makeLookups({
    bindings: [{ supplierId: "sup-1", supplierSku: "X", materialCode: "RM-DEAD" }],
    codes: ["RM-001"],
    names: {},
  });
  assert.equal(m.resolveMaterialCode("sup-1", "X", "whatever", lookups), null);
});

test("resolveMaterialCode — stale binding rejected but name fallback still works", () => {
  const lookups = makeLookups({
    bindings: [{ supplierId: "sup-1", supplierSku: "X", materialCode: "RM-DEAD" }],
    codes: ["RM-009"],
    names: { "Foam Sheet": "RM-009" },
  });
  const r = m.resolveMaterialCode("sup-1", "X", "Foam Sheet", lookups);
  assert.deepEqual(r, { code: "RM-009", method: "name" });
});

test("bindingKey — supplierId scoping prevents cross-supplier leakage", () => {
  const lookups = makeLookups({
    bindings: [{ supplierId: "sup-1", supplierSku: "SKU1", materialCode: "RM-001" }],
    codes: ["RM-001"],
  });
  // same SKU, different supplier → no binding hit, no name → null
  assert.equal(m.resolveMaterialCode("sup-2", "SKU1", "", lookups), null);
  assert.deepEqual(
    m.resolveMaterialCode("sup-1", "SKU1", "", lookups),
    { code: "RM-001", method: "binding" },
  );
});
