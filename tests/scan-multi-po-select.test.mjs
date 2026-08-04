// ---------------------------------------------------------------------------
// scan-multi-po-select.test.mjs — one document, several linked POs, chosen by hand.
//
// Owner 2026-08-04: "它一定要可以 multiselect，因为可能会有好几张 PO 跟着来，
// 也就是好几个 PO 都要 convert 这一个."
//
// The backend has been per-line since the multi-PO work (`grn_items.po_id /
// po_item_id`, `purchase_invoice_items.po_id`) and the wizard already linked
// every PO a document NAMED. What was missing is the operator naming them:
// the picker was a single select, so a document that did not print both refs
// could only ever be tied to one order.
//
// The re-allocation on every change is the substance, not the widget. The
// first cut computed each line's `poId` once at card build and never again, so
// changing the Linked PO by hand re-priced the lines while leaving them drawn
// down against the order they were first matched to — the invoice would bill
// one PO and consume another, silently.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/scan-supplier-modal.tsx"),
  "utf8",
);

test("the picker ADDS to a set instead of replacing one value", () => {
  assert.equal(
    SRC.split("onPatch(relinkPatch([...linkedPoIds, poId]));").length - 1,
    2,
    "create-PI and create-GRN must behave identically",
  );
  assert.equal(
    SRC.split('onChange={(poId) => onPatch({ purchaseOrderId: poId || null })}').length - 1,
    0,
    "the single-value picker is gone",
  );
});

test("an already-linked PO is not offered again", () => {
  assert.equal(
    SRC.split("options={linkedPoOptions.filter(").length - 1,
    2,
  );
  assert.equal(SRC.split("if (!poId || linkedPoIds.includes(poId)) return;").length - 1, 2);
});

test("each linked PO can be removed", () => {
  assert.equal(
    SRC.split("relinkPatch(linkedPoIds.filter((x) => x !== id))").length - 1,
    2,
  );
});

test("EVERY change re-allocates the lines — this is the point", () => {
  assert.equal(SRC.split("const relinkPatch = (nextIds: string[])").length - 1, 2);
  assert.equal(SRC.split("relinkToPos(card.lines, nextIds, purchaseOrders)").length - 1, 2);
  assert.match(SRC, /function relinkToPos\(/);
});

test("a re-link re-prices off each line's OWN order", () => {
  // Pricing the whole card off the header would charge the second order's
  // goods at the first order's rates.
  assert.match(
    SRC,
    /applyPoPriceFill\(\[\{ \.\.\.l, poId \}\], byId\.get\(poId \?\? ""\) \?\? null\)\[0\]/,
  );
});

test("the GRN re-link carries the PO LINE, not just the PO", () => {
  // grn_items records po_item_id; without it the receipt draws down the right
  // order but not the right line on it.
  const grn = SRC.slice(SRC.lastIndexOf("const relinkPatch = (nextIds: string[])"));
  assert.match(grn.slice(0, 900), /poItemId: allocations\[i\]\?\.poItemId \?\? null/);
  assert.match(grn.slice(0, 900), /poItemIndex: allocations\[i\]\?\.poItemIndex \?\? null/);
});

test("the header PO is derived from the allocation, never picked", () => {
  assert.equal(SRC.split("purchaseOrderId: headerPoId(allocations, nextIds)").length - 1, 2);
});

test("a card built before the set existed still works", () => {
  // Falls back to its single header PO rather than showing nothing linked.
  assert.equal(
    SRC.split("      : card.purchaseOrderId\n        ? [card.purchaseOrderId]\n        : [];").length - 1,
    2,
  );
});

test("each chip says how many lines it actually owns", () => {
  // A linked PO that won no line is worth seeing — it means the document
  // claims goods from an order this document does not bill.
  assert.equal(
    SRC.split("const owned = card.lines.filter((l) => l.poId === id).length;").length - 1,
    2,
  );
});
