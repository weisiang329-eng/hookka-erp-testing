// ---------------------------------------------------------------------------
// po-line-allocate.test.mjs — one document, two purchase orders, one receipt.
//
// Owner 2026-08-04: "如果它的 PO 来自两个的话，它一定要来自首两张 PO 进一张 GR
// 的，这东西是串联的."
//
// `po-ref-match` reads both references off the document; this decides which PO
// LINE each scanned line actually draws down. The asymmetry that shapes every
// rule below: an unallocated line costs the operator one pick, while a WRONG
// allocation draws down the wrong purchase order — it reconciles cleanly and is
// discovered only when the other order is chased for goods that already
// arrived. So it allocates confidently or not at all.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateLinesToPos,
  headerPoId,
  allocatedPoIds,
} from "../src/lib/po-line-allocate.ts";

const PO_A = {
  id: "po-a",
  poNo: "2607-003",
  items: [
    { id: "a1", materialCode: "PLY-9-48-AB", quantity: 100, receivedQty: 0 },
    { id: "a2", materialCode: "PLY-18-48", quantity: 50, receivedQty: 0 },
  ],
};
const PO_B = {
  id: "po-b",
  poNo: "2607-020",
  items: [{ id: "b1", materialCode: "FOAM-D24-2", quantity: 20, receivedQty: 0 }],
};

test("lines from two orders land on one receipt, each on its own PO", () => {
  const got = allocateLinesToPos(
    [{ materialCode: "PLY-9-48-AB" }, { materialCode: "FOAM-D24-2" }],
    [PO_A, PO_B],
  );
  assert.equal(got[0].poId, "po-a");
  assert.equal(got[0].poItemId, "a1");
  assert.equal(got[1].poId, "po-b");
  assert.equal(got[1].poItemId, "b1");
});

test("poItemIndex is a position on the line's OWN order", () => {
  // It is the legacy fallback key, and a global index would resolve to the
  // wrong row the moment a second PO is involved.
  const got = allocateLinesToPos(
    [{ materialCode: "PLY-18-48" }, { materialCode: "FOAM-D24-2" }],
    [PO_A, PO_B],
  );
  assert.equal(got[0].poItemIndex, 1, "second line of PO A");
  assert.equal(got[1].poItemIndex, 0, "first line of PO B — not the third overall");
});

test("an outstanding order beats one already fully received", () => {
  const closed = {
    id: "po-old",
    items: [{ id: "o1", materialCode: "PLY-9-48-AB", quantity: 100, receivedQty: 100 }],
  };
  const got = allocateLinesToPos([{ materialCode: "PLY-9-48-AB" }], [closed, PO_A]);
  assert.equal(got[0].poId, "po-a", "goods arriving now belong to the open order");
  assert.equal(got[0].outstanding, true);
});

test("two open orders for the same material are NOT guessed between", () => {
  const other = {
    id: "po-c",
    items: [{ id: "c1", materialCode: "PLY-9-48-AB", quantity: 40, receivedQty: 0 }],
  };
  assert.equal(
    allocateLinesToPos([{ materialCode: "PLY-9-48-AB" }], [PO_A, other])[0],
    null,
    "drawing down the wrong PO reconciles cleanly and hides the error",
  );
});

test("two fully-received candidates are refused as well", () => {
  const a = { id: "p1", items: [{ id: "x", materialCode: "M", quantity: 5, receivedQty: 5 }] };
  const b = { id: "p2", items: [{ id: "y", materialCode: "M", quantity: 5, receivedQty: 5 }] };
  assert.equal(allocateLinesToPos([{ materialCode: "M" }], [a, b])[0], null);
});

test("a closed order still allocates when it is the only candidate", () => {
  // Over-receipt is a real situation and the API has its own 110% guard; this
  // module's job is identifying the line, not policing the quantity.
  const closed = {
    id: "po-old",
    items: [{ id: "o1", materialCode: "PLY-9-48-AB", quantity: 100, receivedQty: 100 }],
  };
  const got = allocateLinesToPos([{ materialCode: "PLY-9-48-AB" }], [closed]);
  assert.equal(got[0].poItemId, "o1");
  assert.equal(got[0].outstanding, false, "the caller can warn on this");
});

test("a PO line is consumed once", () => {
  const got = allocateLinesToPos(
    [{ materialCode: "PLY-9-48-AB" }, { materialCode: "PLY-9-48-AB" }],
    [PO_A],
  );
  assert.equal(got[0].poItemId, "a1");
  assert.equal(got[1], null, "the same PO line must not be drawn down twice");
});

test("the supplier's own code is a fallback, not a rival to the internal one", () => {
  const po = {
    id: "po-s",
    items: [
      { id: "s1", materialCode: "PLY-9-48-AB", supplierSKU: "AW-9", quantity: 10, receivedQty: 0 },
      { id: "s2", materialCode: "", supplierSKU: "AW-18", quantity: 10, receivedQty: 0 },
    ],
  };
  // Internal code present → that decides it.
  assert.equal(
    allocateLinesToPos([{ materialCode: "PLY-9-48-AB", supplierSku: "AW-18" }], [po])[0].poItemId,
    "s1",
  );
  // No internal code → fall back to what the supplier printed.
  assert.equal(
    allocateLinesToPos([{ supplierSku: "AW-18" }], [po])[0].poItemId,
    "s2",
  );
});

test("a line naming nothing identifiable allocates nothing", () => {
  assert.equal(allocateLinesToPos([{}], [PO_A])[0], null);
  assert.equal(allocateLinesToPos([{ materialCode: "NOT-ON-ANY-PO" }], [PO_A])[0], null);
});

test("no purchase orders means no allocations, not a throw", () => {
  assert.deepEqual(allocateLinesToPos([{ materialCode: "X" }], []), [null]);
  assert.deepEqual(allocateLinesToPos([], [PO_A]), []);
  assert.deepEqual(allocateLinesToPos([{ materialCode: "X" }], [{ id: "p", items: null }]), [null]);
});

test("codes still match across punctuation drift", () => {
  const got = allocateLinesToPos([{ materialCode: "ply 9 48 ab" }], [PO_A]);
  assert.equal(got[0].poItemId, "a1");
});

// ── What the card shows ─────────────────────────────────────────────────────

test("the header PO is the first order that actually owns a line", () => {
  const allocs = allocateLinesToPos([{ materialCode: "FOAM-D24-2" }], [PO_A, PO_B]);
  assert.equal(headerPoId(allocs, ["po-a", "po-b"]), "po-b");
});

test("with nothing allocated the header still shows what was named", () => {
  assert.equal(headerPoId([null, null], ["po-a", "po-b"]), "po-a");
  assert.equal(headerPoId([], []), null);
});

test("allocatedPoIds reports every order the receipt touches, in order, once", () => {
  const allocs = allocateLinesToPos(
    [{ materialCode: "PLY-9-48-AB" }, { materialCode: "FOAM-D24-2" }, { materialCode: "PLY-18-48" }],
    [PO_A, PO_B],
  );
  assert.deepEqual(allocatedPoIds(allocs), ["po-a", "po-b"]);
});
