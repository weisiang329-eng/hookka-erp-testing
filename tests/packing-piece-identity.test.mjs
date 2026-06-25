// Locks the ONE shared warehouse-identity formula for a packed piece. Both the
// office/applyPackingRack path and the /r/ rack-scan resolve import this, so if
// the formula drifts the Warehouse grid would show duplicate rows or a move
// could not find the old row. These assertions pin the exact rule.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping on newer Node.
}

const { packingPieceIdentity } = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/api/lib/packing-piece-identity.ts"),
  ).href
);

test("wipLabel wins as the description", () => {
  const { description } = packingPieceIdentity({
    wipLabel: "1007-(Q)-HB",
    productName: "Bed Frame",
    sizeLabel: "Queen",
  });
  assert.equal(description, "1007-(Q)-HB");
});

test("no wipLabel → productName + size", () => {
  const { description } = packingPieceIdentity({
    wipLabel: "",
    productName: "Bed Frame",
    sizeLabel: "Queen",
  });
  assert.equal(description, "Bed Frame Queen");
});

test("no wipLabel, no size → just the name", () => {
  const { description } = packingPieceIdentity({
    productName: "Bed Frame",
    sizeLabel: "",
  });
  assert.equal(description, "Bed Frame");
});

test("name falls back productName → productCode → poNo", () => {
  assert.equal(
    packingPieceIdentity({ productCode: "1007-(Q)" }).description,
    "1007-(Q)",
  );
  assert.equal(
    packingPieceIdentity({ poNo: "PO-008967" }).description,
    "PO-008967",
  );
});

test("all empty → 'Item' (never blank — a blank key would mass-collide)", () => {
  assert.equal(packingPieceIdentity({}).description, "Item");
  assert.equal(
    packingPieceIdentity({ wipLabel: "", productName: "", sizeLabel: "" })
      .description,
    "Item",
  );
});

test("whitespace is trimmed on the description parts", () => {
  assert.equal(
    packingPieceIdentity({ wipLabel: "  HB  " }).description,
    "HB",
  );
});

test("notes = 'SO <no>' when present, '' when absent (matches pieceNotes)", () => {
  assert.equal(
    packingPieceIdentity({ salesOrderNo: "SO-2606-013" }).notes,
    "SO SO-2606-013",
  );
  assert.equal(packingPieceIdentity({ salesOrderNo: null }).notes, "");
  assert.equal(packingPieceIdentity({}).notes, "");
});

test("the office path and the rack-scan path produce IDENTICAL identity for one piece", () => {
  // Same card object → same key, regardless of which path computed it. This is
  // the property the whole de-dup / move logic relies on.
  const card = {
    wipLabel: "1007-(Q)-HB",
    productName: "Bed Frame",
    productCode: "1007-(Q)",
    poNo: "PO-008967",
    sizeLabel: "Queen",
    salesOrderNo: "SO-2606-013",
  };
  const a = packingPieceIdentity(card);
  const b = packingPieceIdentity({ ...card });
  assert.deepEqual(a, b);
  assert.equal(a.description, "1007-(Q)-HB");
  assert.equal(a.notes, "SO SO-2606-013");
});
