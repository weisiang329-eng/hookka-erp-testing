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

test("per-piece (mig 0192): notes carry '· pc N of M' when pieceNo set + multi-piece", () => {
  // A DIVAN of 2 → each physical piece a DISTINCT notes signature, so the 2nd
  // piece can sit on its own rack (no "already in this rack" collapse). The
  // description (productName key) is unchanged — only notes diverge.
  const base = {
    wipLabel: '8" Divan- 6FT Frame',
    salesOrderNo: "SO-2606-013",
  };
  const p1 = packingPieceIdentity({ ...base, pieceNo: 1, totalPieces: 2 });
  const p2 = packingPieceIdentity({ ...base, pieceNo: 2, totalPieces: 2 });
  assert.equal(p1.description, '8" Divan- 6FT Frame');
  assert.equal(p2.description, '8" Divan- 6FT Frame');
  assert.equal(p1.notes, "SO SO-2606-013 · pc 1 of 2");
  assert.equal(p2.notes, "SO SO-2606-013 · pc 2 of 2");
  assert.notEqual(p1.notes, p2.notes); // distinct identities → distinct racks
});

test("per-piece suffix works with no SO (pc-only notes)", () => {
  assert.equal(
    packingPieceIdentity({ wipLabel: "Divan", pieceNo: 2, totalPieces: 2 }).notes,
    "pc 2 of 2",
  );
});

test("back-compat: single-piece / no-pieceNo notes stay byte-identical (no suffix)", () => {
  // totalPieces ≤ 1 → legacy notes, so old single-piece rack_items rows match.
  assert.equal(
    packingPieceIdentity({ salesOrderNo: "SO-1", pieceNo: 1, totalPieces: 1 })
      .notes,
    "SO SO-1",
  );
  // pieceNo present but totalPieces absent → legacy notes.
  assert.equal(
    packingPieceIdentity({ salesOrderNo: "SO-1", pieceNo: 2 }).notes,
    "SO SO-1",
  );
  // pieceNo 0 / null → legacy notes even with multi-piece total.
  assert.equal(
    packingPieceIdentity({ salesOrderNo: "SO-1", pieceNo: 0, totalPieces: 3 })
      .notes,
    "SO SO-1",
  );
  assert.equal(
    packingPieceIdentity({ salesOrderNo: "SO-1", pieceNo: null, totalPieces: 3 })
      .notes,
    "SO SO-1",
  );
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
