// ---------------------------------------------------------------------------
// supplier-binding-learn.test.mjs — remember what a human already worked out.
//
// `supplier_material_bindings` had exactly ONE writer — the maintenance page —
// so when an operator resolved a scanned line to an internal code and created
// the PI or GRN, that decision went nowhere. The same supplier document next
// month arrived unrecognised and was picked by hand again. That, not the
// matching algorithm, was the real reason manual picking never stopped.
//
// The rules this holds:
//   • commercial terms on an EXISTING binding are never rewritten by a scan —
//     price, lead time and MOQ are negotiated, not observed;
//   • a blank lookup key on an existing row may be filled in, so a binding
//     gains a second way to be found without losing the first;
//   • a line missing either half teaches nothing;
//   • learning must never be able to fail a document.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { learnSupplierBindings } from "../src/api/lib/supplier-binding-learn.ts";

let seq = 0;
const genId = () => `smb-${++seq}`;

function makeDb(existingRows = []) {
  const inserts = [];
  const updates = [];
  const rows = [...existingRows];
  return {
    inserts,
    updates,
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              return { results: [] };
            },
            async first() {
              if (!sql.includes("SELECT * FROM supplier_material_bindings")) return null;
              const [supplierId, code] = args;
              return (
                rows.find(
                  (r) =>
                    r.supplierId === supplierId &&
                    String(r.materialCode).toUpperCase() === String(code).toUpperCase(),
                ) ?? null
              );
            },
            async run() {
              if (sql.startsWith("INSERT INTO supplier_material_bindings")) inserts.push(args);
              else if (sql.startsWith("UPDATE supplier_material_bindings")) updates.push(args);
            },
          };
        },
      };
    },
  };
}

test("a resolved line becomes a binding", async () => {
  const db = makeDb();
  const r = await learnSupplierBindings(
    db,
    "sup-1",
    [
      {
        materialCode: "PLY-9-48-AB",
        materialName: "PLYWOOD 9MM 4X8 AB",
        supplierSku: "",
        supplierDescription: "9MM 4' X 8' PLYWOOD AB",
        unitPriceSen: 2800,
      },
    ],
    genId,
  );
  assert.equal(r.created, 1);
  assert.equal(db.inserts.length, 1);
  const [, supplierId, code, , sku, desc, price] = db.inserts[0];
  assert.equal(supplierId, "sup-1");
  assert.equal(code, "PLY-9-48-AB");
  assert.equal(sku, "", "this supplier prints no code — the description is the key");
  assert.equal(desc, "9MM 4' X 8' PLYWOOD AB");
  assert.equal(price, 2800);
});

test("a line with no internal code teaches nothing", async () => {
  const db = makeDb();
  const r = await learnSupplierBindings(
    db,
    "sup-1",
    [{ materialCode: "", supplierDescription: "SOMETHING UNRESOLVED" }],
    genId,
  );
  assert.equal(r.created, 0);
  assert.equal(db.inserts.length, 0);
});

test("a line with no supplier wording teaches nothing either", async () => {
  // Both halves are needed: what we call it AND what they call it.
  const db = makeDb();
  const r = await learnSupplierBindings(
    db,
    "sup-1",
    [{ materialCode: "PLY-9-48-AB", supplierSku: "", supplierDescription: "" }],
    genId,
  );
  assert.equal(r.created, 0);
  assert.equal(db.inserts.length, 0);
});

test("an existing binding keeps its commercial terms", async () => {
  const db = makeDb([
    {
      id: "b1",
      supplierId: "sup-1",
      materialCode: "PLY-9-48-AB",
      supplierSku: "AW-PLY-9",
      supplier_description: "9MM 4' X 8' PLYWOOD AB",
    },
  ]);
  const r = await learnSupplierBindings(
    db,
    "sup-1",
    [
      {
        materialCode: "PLY-9-48-AB",
        supplierSku: "AW-PLY-9",
        supplierDescription: "9MM 4' X 8' PLYWOOD AB",
        unitPriceSen: 9999,
      },
    ],
    genId,
  );
  assert.equal(db.inserts.length, 0, "an existing binding must not be duplicated");
  assert.equal(db.updates.length, 0, "nothing was missing, so nothing may be rewritten");
  assert.equal(r.enriched, 0);
});

test("a blank lookup key on an existing binding is filled in", async () => {
  // A binding created by SKU gains the description key, so the supplier whose
  // paperwork carries no code starts resolving too.
  const db = makeDb([
    {
      id: "b1",
      supplierId: "sup-1",
      materialCode: "PLY-9-48-AB",
      supplierSku: "AW-PLY-9",
      supplier_description: "",
    },
  ]);
  const r = await learnSupplierBindings(
    db,
    "sup-1",
    [
      {
        materialCode: "PLY-9-48-AB",
        supplierSku: "AW-PLY-9",
        supplierDescription: "9MM 4' X 8' PLYWOOD AB",
      },
    ],
    genId,
  );
  assert.equal(r.enriched, 1);
  assert.equal(db.updates.length, 1);
  const [sku, desc] = db.updates[0];
  assert.equal(sku, "AW-PLY-9", "the existing key must survive");
  assert.equal(desc, "9MM 4' X 8' PLYWOOD AB", "and the missing one is added");
});

test("the same material billed twice is learned once", async () => {
  const db = makeDb();
  const line = {
    materialCode: "PLY-9-48-AB",
    supplierDescription: "9MM 4' X 8' PLYWOOD AB",
    unitPriceSen: 2800,
  };
  const r = await learnSupplierBindings(db, "sup-1", [line, { ...line }], genId);
  assert.equal(r.created, 1);
  assert.equal(db.inserts.length, 1);
});

test("no supplier means nothing is learned", async () => {
  const db = makeDb();
  const r = await learnSupplierBindings(db, "", [{ materialCode: "X", supplierSku: "Y" }], genId);
  assert.equal(r.created, 0);
  assert.equal(db.inserts.length, 0);
});

test("a database failure never propagates", async () => {
  // The document is the operator's work; a lost binding costs one future
  // auto-match. The former must never be sacrificed for the latter.
  const exploding = {
    prepare() {
      return {
        bind() {
          return {
            async all() { throw new Error("boom"); },
            async first() { throw new Error("boom"); },
            async run() { throw new Error("boom"); },
          };
        },
      };
    },
  };
  const r = await learnSupplierBindings(
    exploding,
    "sup-1",
    [{ materialCode: "PLY-9-48-AB", supplierDescription: "PLYWOOD" }],
    genId,
  );
  assert.equal(r.created, 0);
  assert.ok(r.skipped >= 1, "the failure is counted, not thrown");
});
