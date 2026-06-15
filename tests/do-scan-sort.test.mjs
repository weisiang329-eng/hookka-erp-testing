// ---------------------------------------------------------------------------
// do-scan-sort.test.mjs — the mobile DO scan list MUST order its lines exactly
// like the printed Delivery Order.
//
// Owner requirement: "D.O. 里的第一行,在扫描 QR 码后出来的也必须是第一行" — the
// phone scan (Pending Dispatch / Delivered) has to mirror the office DO
// row-for-row, including after add/remove line.
//
// The guarantee is structural: ONE shared comparator (compareDoLinesByCustomerPO
// in src/lib/do-item-order.ts) is used by BOTH the print path (print-do.tsx,
// generate-do-pdf.ts) and the scan path (do-scan.tsx). This test pins the
// comparator's order AND asserts both call sites import the shared module so a
// future edit can't silently fork the ordering.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareDoLinesByCustomerPO } from "../src/lib/do-item-order.ts";

// A representative DO that spans two customer POs out of natural (insertion)
// order, plus a blank-PO line — exactly the case where a naive
// "sort by SO no. only" would diverge from the office.
const rawLines = [
  { id: "L1", customerPOId: "PO-008770", salesOrderNo: "SO-1002" },
  { id: "L2", customerPOId: "PO-008636", salesOrderNo: "SO-1005" },
  { id: "L3", customerPOId: "PO-008636", salesOrderNo: "SO-1001" },
  { id: "L4", customerPOId: "", salesOrderNo: "SO-1000" }, // blank PO → last
  { id: "L5", customerPOId: "PO-008770", salesOrderNo: "SO-1003" },
];

test("comparator orders by customer PO asc, then SO no. asc, blanks last", () => {
  const order = [...rawLines]
    .sort(compareDoLinesByCustomerPO)
    .map((l) => l.id);
  // PO-008636 group (SO asc: 1001<1005) → PO-008770 group (1002<1003) → blank.
  assert.deepEqual(order, ["L3", "L2", "L1", "L5", "L4"]);
});

test("numeric (natural) PO order — PO-008636 < PO-008654 < PO-008770", () => {
  const lines = [
    { id: "a", customerPOId: "PO-008770", salesOrderNo: "SO-1" },
    { id: "b", customerPOId: "PO-008654", salesOrderNo: "SO-1" },
    { id: "c", customerPOId: "PO-008636", salesOrderNo: "SO-1" },
  ];
  assert.deepEqual(
    lines.sort(compareDoLinesByCustomerPO).map((l) => l.id),
    ["c", "b", "a"],
  );
});

test("the scan + print + PDF all import the ONE shared comparator (no fork)", () => {
  // If any of these stops importing the shared module, ordering can drift and
  // the owner's row-for-row guarantee breaks. Keep them on the same function.
  const files = [
    "src/pages/do-scan.tsx", // mobile scan list (this change)
    "src/components/delivery/print-do.tsx", // on-screen / print DO
    "src/lib/generate-do-pdf.ts", // emailed DO PDF
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(
      src,
      /compareDoLinesByCustomerPO/,
      `${f} must use the shared compareDoLinesByCustomerPO so the scan, screen and PDF orders stay identical`,
    );
  }
});

test("equal customer PO falls through to SO no. (single-PO DO = SO order)", () => {
  const lines = [
    { id: "x", customerPOId: "PO-1", salesOrderNo: "SO-9" },
    { id: "y", customerPOId: "PO-1", salesOrderNo: "SO-2" },
  ];
  assert.deepEqual(
    lines.sort(compareDoLinesByCustomerPO).map((l) => l.id),
    ["y", "x"],
  );
});
