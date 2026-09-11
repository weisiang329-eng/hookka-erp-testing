// T-006 R6 — a Purchase Return wrote only purchase_returns/purchase_return_items
// and never touched grn_items.invoiced_qty or purchase_order_items.receivedQty —
// so a returned line stayed counted as received/invoiced forever, and nothing
// stopped the same GRN line being returned twice over.
//
// Fix: createPurchaseReturn now (1) caps cumulative returns per GRN line at
// grn_items.accepted_qty before writing anything, and (2) decrements
// grn_items.invoiced_qty + purchase_order_items.receivedQty in the SAME batch
// as the header/item inserts, clamped at 0.
// Source-static — no live D1 in CI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/lib/purchase-return-create.ts", "utf8");
const ROUTES = readFileSync("src/api/routes/purchase-returns.ts", "utf8");

function fnBody(name) {
  const start = SRC.indexOf(`export async function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  return SRC.slice(start);
}

test("the counters a return needs are self-applied here too, not assumed from another route", () => {
  const body = fnBody("ensurePurchaseReturnTables");
  assert.match(body, /ADD COLUMN IF NOT EXISTS invoiced_qty NUMERIC DEFAULT 0/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS po_id TEXT/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS po_item_id TEXT/);
});

test("a return is capped at what was actually accepted on the GRN line", () => {
  const body = fnBody("createPurchaseReturn");
  assert.match(
    body,
    /SELECT COALESCE\(SUM\(quantity\),0\) AS qty FROM purchase_return_items WHERE grn_item_id = \?/,
  );
  assert.match(body, /if \(already \+ thisReturn > accepted\)/);
  // Rejected BEFORE any statement is built — no partial write on the reject path.
  const rejectIdx = body.indexOf("if (already + thisReturn > accepted)");
  const batchIdx = body.indexOf("await db.batch(stmts)");
  assert.ok(rejectIdx < batchIdx, "the cap check must run before the batch");
});

test("a line with no grnItemId skips the cap (nothing to check it against)", () => {
  const body = fnBody("createPurchaseReturn");
  assert.match(body, /\.filter\(\(v\): v is string => !!v\)/);
});

test("the batch decrements both counters, clamped at 0", () => {
  const body = fnBody("createPurchaseReturn");
  assert.match(
    body,
    /UPDATE grn_items SET invoiced_qty = GREATEST\(0, invoiced_qty - \?\) WHERE id = \?/,
  );
  assert.match(
    body,
    /UPDATE purchase_order_items SET receivedQty = GREATEST\(0, receivedQty - \?\) WHERE id = \?/,
  );
});

test("header, items, and counter updates all land in ONE atomic batch", () => {
  const body = fnBody("createPurchaseReturn");
  assert.match(body, /const stmts: D1PreparedStatement\[\] = \[/);
  assert.match(body, /await db\.batch\(stmts\)/);
  // No lingering per-statement .run() calls inside the function body.
  const beforeBatch = body.slice(0, body.indexOf("await db.batch(stmts)"));
  assert.doesNotMatch(beforeBatch, /\.run\(\)/);
});

test("createPurchaseReturn returns ok:false on cap violation instead of throwing", () => {
  const body = fnBody("createPurchaseReturn");
  assert.match(body, /return \{\s*ok: false,\s*error: `Return exceeds/);
  assert.match(body, /return \{ ok: true, id, returnNo \};/);
});

test("the route surfaces a cap rejection as 409, not a silent 200", () => {
  assert.match(ROUTES, /if \(!created\.ok\) \{\s*\n\s*return c\.json\(\{ success: false, error: created\.error \}, 409\);/);
});
