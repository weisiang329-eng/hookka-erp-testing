import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSupplierDoc } from "../src/api/lib/scan-engine.ts";

// BUG price=0: a faint scan reads the bold line TOTAL but misses the small
// unit-price cell, so the PI line came out RM 0. sanitizeSupplierDoc now backs
// the unit price out of amount ÷ qty when it is blank/0 — only filling a hole,
// never overwriting a real price.

const line = (doc) => sanitizeSupplierDoc(doc).lines[0];

test("derives unit price from amount ÷ qty when unit price is missing", () => {
  const l = line({ lines: [{ description: "Foam", qty: 4, amount: 400 }] });
  assert.equal(l.unitPrice, 100);
});

test("derives when unit price read as 0 (the NHL IV-91176 case)", () => {
  const l = line({
    lines: [{ description: "Sponge", qty: 7, unitPrice: 0, amount: 757.68 }],
  });
  assert.equal(l.unitPrice, 108.24); // 757.68 / 7, rounded to sen
});

test("NEVER overwrites a real unit price", () => {
  const l = line({
    lines: [{ description: "Fabric", qty: 2, unitPrice: 50, amount: 999 }],
  });
  assert.equal(l.unitPrice, 50);
});

test("no derive when amount is missing (stays null, not a guess)", () => {
  const l = line({ lines: [{ description: "Legs", qty: 4 }] });
  assert.equal(l.unitPrice, null);
});

test("no divide-by-zero when qty is 0/absent", () => {
  const l0 = line({ lines: [{ description: "X", qty: 0, amount: 100 }] });
  assert.equal(l0.unitPrice, null);
  const lNoQty = line({ lines: [{ description: "Y", amount: 100 }] });
  assert.equal(lNoQty.unitPrice, null);
});

// OCR now also captures discount (line + doc) and foam density/thickness
// (owner 2026-07-01) — sanitize must pass them through cleanly.
test("passes through line discount, density, thickness", () => {
  const l = line({
    lines: [
      { description: "Sponge", qty: 2, unitPrice: 50, discount: 5, density: "NLY22GH", thickness: "25MM" },
    ],
  });
  assert.equal(l.discount, 5);
  assert.equal(l.density, "NLY22GH");
  assert.equal(l.thickness, "25MM");
});

test("passes through document-level discount; absent spec stays null", () => {
  const doc = sanitizeSupplierDoc({ discount: 30, lines: [{ description: "Legs", qty: 4 }] });
  assert.equal(doc.discount, 30);
  assert.equal(doc.lines[0].density, null);
  assert.equal(doc.lines[0].thickness, null);
  assert.equal(doc.lines[0].discount, null);
});
