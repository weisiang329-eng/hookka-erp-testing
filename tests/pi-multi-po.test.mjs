// ---------------------------------------------------------------------------
// pi-multi-po.test.mjs — one supplier invoice may bill several purchase orders.
//
// ADD WOOD prints `P/O No : 2607-003/2607-020` on a single invoice, so
// `purchase_invoices.purchaseOrderId` alone cannot describe it. Each invoice
// LINE now records the PO it bills.
//
// The pin that matters is the over-invoicing guard. It caps a line at its PO
// line's remaining (ordered − already invoiced), matched by material code. If
// the lines of a two-PO invoice are pooled and measured against the header PO,
// two things go wrong at once: one PO gets over-invoiced, and a line that is
// perfectly in budget on its OWN purchase order is wrongly rejected. So the
// guard has to run per purchase order.
//
// Source-level pins (the guard needs a database to exercise end to end).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/purchase-invoices.ts"),
  "utf8",
);

test("the per-line PO column is self-applied", () => {
  // Migrations are inert on deploy — a new column reaches prod only this way.
  assert.match(
    SRC,
    /ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS po_id TEXT/,
  );
});

test("a line carries its own PO through normalisation", () => {
  assert.match(SRC, /poId: string \| null;/);
  assert.match(SRC, /poId: \(it as \{ poId\?: unknown \}\)\.poId == null \? null :/);
});

test("the over-invoicing guard runs PER purchase order", () => {
  assert.match(SRC, /const byPo = new Map<string, typeof normalizedItems\.rows>\(\)/);
  assert.match(SRC, /const poId = r\.poId \|\| String\(body\.purchaseOrderId\)/);
  assert.match(
    SRC,
    /for \(const \[poId, rows\] of byPo\)/,
    "pooling every line against the header PO would over-invoice one PO and wrongly reject another",
  );
});

test("the guard's ceiling and consumption are read for THAT PO", () => {
  // Both halves must be scoped to the same purchase order, or the ceiling and
  // the running total describe different things.
  assert.match(
    SRC,
    /SELECT material_code, materialName, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = \?[\s\S]{0,160}\.bind\(poId\)/,
  );
  assert.match(SRC, /\.bind\(poId\)[\s\S]{0,80}material_code/);
});

test("ONE ceiling serves both invoice paths (BUG-2026-08-07-003)", () => {
  // A GRN-sourced invoice used to be capped only by the receipt's own
  // accepted−invoiced, so a PO could be billed straight off the order AND
  // again off its receipt. Both paths now measure against the same helper —
  // a second copy is how two ceilings come to disagree.
  const calls = SRC.match(/await checkPoRemaining\(db, poId, rows/g) ?? [];
  assert.equal(
    calls.length,
    3,
    "the GRN branch, the PO branch and the re-line path must share one ceiling",
  );
  // The re-line path must EXCLUDE the invoice it is replacing, or an edit that
  // even lowers the quantity is measured against its own lines and rejected.
  assert.match(SRC, /await checkPoRemaining\(db, poId, rows, id\)/);
  assert.match(SRC, /excludePiId \? " AND pii\.pi_id != \?" : ""/);
  assert.match(SRC, /async function checkPoRemaining\(/);
  // The ceiling follows the goods when a receipt legitimately ran over.
  assert.match(SRC, /poInvoiceCeiling\(/);
});

test("already-invoiced counts a line by its OWN PO, falling back to the header", () => {
  // Without COALESCE, a multi-PO invoice's lines would never count toward the
  // second PO's ceiling and it could be invoiced twice over.
  assert.match(SRC, /COALESCE\(pii\.po_id, pi\.purchaseOrderId\) = \?/);
});

test("the guard still rejects, rather than silently trimming", () => {
  assert.match(SRC, /const guard = checkConvertAvailability\(lines\)/);
  assert.match(SRC, /if \(!guard\.ok\) \{[\s\S]{0,120}409\)/);
});

test("create and update both persist the line's PO", () => {
  const inserts = SRC.match(/grn_item_id, po_id, created_at, updated_at/g) ?? [];
  assert.equal(inserts.length, 2, "both the create and update inserts must store po_id");
  // Create takes the header from the body; update takes it from the stored
  // invoice, because a PUT does not re-declare it. A GRN-sourced line falls
  // back to the PO its GRN line was received against, so the order the
  // ceiling guard measured it against is the order it gets recorded against
  // (BUG-2026-08-07-003).
  assert.match(
    SRC,
    /r\.poId \?\?\s*\n\s*body\.purchaseOrderId \?\?\s*\n\s*\(r\.grnItemId \? grnLinePoId\.get\(String\(r\.grnItemId\)\) : undefined\) \?\?\s*\n\s*sourceGrnPoId \?\?\s*\n\s*null/,
  );
  assert.match(SRC, /r\.poId \?\?\s*\n\s*\(existing as unknown as \{ purchaseOrderId\?: string \| null \}\)\.purchaseOrderId/);
});

test("the schema fixture records the self-applied column", () => {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), "tests/db-schema.json"), "utf8"));
  assert.ok(schema.purchase_invoice_items.includes("po_id"));
});
