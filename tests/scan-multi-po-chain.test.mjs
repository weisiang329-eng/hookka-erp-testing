// ---------------------------------------------------------------------------
// scan-multi-po-chain.test.mjs — two POs on one document, one receipt.
//
// Owner 2026-08-04: "如果它的 PO 来自两个的话，它一定要来自首两张 PO 进一张 GR
// 的，这东西是串联的."
//
// `po-ref-match` already read both references off a supplier document, but the
// scan wizard then refused to link EITHER — correctly, at the time, because a
// card carried one purchaseOrderId and linking one would have looked reconciled
// while the other order's goods were never drawn down.
//
// That constraint is gone: `grn_items.po_id/po_item_id` and
// `purchase_invoice_items.po_id` record ownership per LINE. So the document is
// filed as ONE receipt (or one invoice) and each line is allocated to its own
// PO line. The header PO is display only.
//
// These tests hold the wiring in the wizard; the allocation rules themselves
// live in po-line-allocate.test.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/scan-supplier-modal.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

test("both modes resolve EVERY PO the document named, not just one", () => {
  assert.equal(
    SRC.split("const linkedPos = namedPoIds").length - 1,
    2,
    "create-PI and create-GRN must behave identically",
  );
  assert.equal(
    SRC.split("poLink.matchedPoIds.length > 0").length - 1,
    2,
    "a document naming two known POs must keep both",
  );
});

test("both modes allocate lines across those POs", () => {
  assert.equal(
    SRC.split("allocateLinesToPos(lines, linkedPos)").length - 1,
    2,
    "each line must find its own PO line, in both wizards",
  );
});

test("the header PO is derived from the allocation, not chosen first", () => {
  // Ownership lives on the lines now; a header picked before allocation would
  // be a guess that the lines then contradict.
  assert.equal(
    SRC.split("headerPoId(allocations, namedPoIds)").length - 1,
    2,
  );
  assert.equal(
    SRC.split("autoLinkPoId(ex, purchaseOrders, defaultPurchaseOrderId)").length - 1,
    0,
    "the single-PO auto-link is gone from the card builders",
  );
});

test("the GRN payload carries each line's own PO line", () => {
  // The backend prefers per-line ownership over the header poId; sending only
  // the header is what limited a scan to one order.
  assert.match(SRC, /poId: l\.poId \?\? null,\s*\n\s*poItemId: l\.poItemId \?\? null,\s*\n\s*poItemIndex: l\.poItemIndex \?\? null,/);
});

test("the PI payload carries each line's own PO", () => {
  // `purchase_invoice_items.po_id` drives the PER-PO over-invoicing ceiling —
  // pooling everything against the header over-bills one order and wrongly
  // rejects a line that is within budget on its own.
  assert.match(SRC, /grnItemId: null,\s*\n(?:\s*\/\/.*\n)*\s*poId: l\.poId \?\? null,/);
});

test("a two-PO invoice prices each line off its OWN order", () => {
  // A single applyPoPriceFill against the header would price the second
  // order's goods at the first order's rates.
  assert.match(SRC, /applyPoPriceFill\(\[l\], poById\.get\(l\.poId \?\? ""\) \?\? null\)\[0\]/);
});

test("the operator is told when a named PO won a line and when it did not", () => {
  // A named order that received nothing is worth saying: the document claims
  // goods from an order this receipt does not actually draw down.
  assert.match(SRC, /could not be\s*\n?\s*matched to a PO line/);
  assert.equal(
    SRC.split("l.materialCode.trim() && !l.poId").length - 1,
    2,
    "both wizards must count unallocated lines",
  );
});

test("the multi-PO banner no longer refuses to link", () => {
  assert.doesNotMatch(SRC, /not linked automatically/);
  assert.match(SRC, /billed as one invoice, each line against its own PO/);
  assert.match(SRC, /on one GRN, each line drawing down its own/);
});

test("the candidate ladder searches every named PO", () => {
  // Searching only the header order leaves every line belonging to the second
  // one unidentified — the exact half-done state this replaces.
  assert.equal(
    SRC.split("const tiers = tiersFor(sId, linkedPos);").length - 1,
    2,
  );
});
