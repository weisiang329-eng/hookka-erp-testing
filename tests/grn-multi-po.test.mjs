// ---------------------------------------------------------------------------
// grn-multi-po.test.mjs — a goods receipt spanning several purchase orders.
//
// Owner 2026-08-04: "正常都是 GR 会 generate from 好几张 PO 的" — receiving
// against several POs at once is the NORMAL case here, not an edge case. The
// old model could not express it: `grn_items.po_item_index` is a POSITION into
// the single `grns.poId`, so every line necessarily belonged to one PO, and the
// position was only meaningful while that PO's line order held still.
//
// Each line now names the PO line it actually receives. These tests pin the
// two things that matter for the money path: the right PO line is drawn down,
// and EVERY purchase order the receipt touched has its status recomputed —
// missing the second PO would leave it CONFIRMED while its goods are already
// in the building.
//
// Source-level pins (house style for this route — the real cascade needs a DB).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(process.cwd(), "src/api/routes/grn.ts"), "utf8");

function fnBody(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  const after = SRC.indexOf("\nasync function ", start + 1);
  return SRC.slice(start, after === -1 ? undefined : after);
}

test("the per-line PO columns are self-applied, not assumed", () => {
  const body = fnBody("ensureGrnItemPoRef");
  // Migrations are inert on deploy in this repo — a new column reaches prod
  // ONLY through a runtime ALTER.
  assert.match(body, /ADD COLUMN IF NOT EXISTS po_id TEXT/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS po_item_id TEXT/);
  // A failed self-apply must not block a receipt.
  assert.match(body, /catch/);
});

test("an explicit po_item_id wins over the legacy position", () => {
  const body = fnBody("resolveGrnLineTargets");
  assert.match(body, /const explicitItem = \(\(l\.poItemId \?\? l\.po_item_id\) \?\? ""\)\.trim\(\)/);
  // Explicit lines short-circuit before the positional lookup.
  assert.match(body, /if \(explicitItem\)[\s\S]*?continue;/);
});

test("legacy rows still resolve positionally, so no backfill is required", () => {
  const body = fnBody("resolveGrnLineTargets");
  assert.match(body, /needPositional/);
  assert.match(body, /poItemsOrdered\[idx\]\.id/);
  // The positional path is only taken when a line lacks po_item_id.
  assert.match(body, /lines\.some\(\s*\(l\) => !\(\(l\.poItemId \?\? l\.po_item_id\) \?\? ""\)\.trim\(\)/);
});

test("a line's own PO is used, with the header PO only as fallback", () => {
  const body = fnBody("resolveGrnLineTargets");
  assert.match(body, /const explicitPo = \(\(l\.poId \?\? l\.po_id\) \?\? headerPoId \?\? ""\)\.trim\(\)/);
});

test("posting draws down each line's own PO line", () => {
  const body = fnBody("cascadePOStatusAfterGRNPost");
  assert.match(body, /resolveGrnLineTargets\(db, grnId, grn\?\.poId \?\? null\)/);
  assert.match(body, /receivedQty = receivedQty \+ \?[\s\S]*?\.bind\(t\.qty, t\.poItemId\)/);
  // No positional lookup survives in the cascade itself.
  assert.doesNotMatch(body, /poItemIndex/);
});

test("posting recomputes EVERY purchase order the receipt touched", () => {
  const body = fnBody("cascadePOStatusAfterGRNPost");
  assert.match(
    body,
    /for \(const poId of \[\.\.\.new Set\(targets\.map\(\(t\) => t\.poId\)\)\]\)/,
    "a second PO must not be left at CONFIRMED while its goods are in the building",
  );
  assert.match(body, /recomputePoStatusFromReceipts\(db, poId\)/);
});

test("reversal decrements each line's own PO line and clamps at zero", () => {
  const body = fnBody("restorePOReceivedQtyForGRN");
  assert.match(body, /resolveGrnLineTargets\(db, grnId, grn\?\.poId \?\? null\)/);
  assert.match(body, /clampDecrement\(currentById\.get\(t\.poItemId\) \?\? 0, t\.qty\)/);
  assert.match(body, /receivedQty = receivedQty - \?/);
});

test("two lines against the SAME PO line cannot over-restore", () => {
  const body = fnBody("restorePOReceivedQtyForGRN");
  // Each clamp must see the running figure, not the original — otherwise both
  // lines clamp against the same starting value and take more than was there.
  assert.match(
    body,
    /currentById\.set\(t\.poItemId, \(currentById\.get\(t\.poItemId\) \?\? 0\) - dec\)/,
  );
});

test("reversal also recomputes every touched purchase order", () => {
  const body = fnBody("restorePOReceivedQtyForGRN");
  assert.match(body, /for \(const poId of \[\.\.\.new Set\(targets\.map\(\(t\) => t\.poId\)\)\]\)/);
  // A PO another GRN still covers stays RECEIVED.
  assert.match(body, /if \(allFull\) continue;/);
});

test("partial receipt still accumulates rather than overwrites", () => {
  // The owner confirmed a PO is received across several deliveries, so the
  // draw-down must be += / -=, never =.
  const post = fnBody("cascadePOStatusAfterGRNPost");
  assert.match(post, /receivedQty = receivedQty \+ \?/);
  assert.doesNotMatch(post, /SET receivedQty = \?/);
});

test("create PERSISTS the per-line PO reference, not just reads it", () => {
  // The columns are useless if nothing writes them — the resolver would then
  // fall back to the positional path forever and multi-PO stays unreachable.
  assert.match(
    SRC,
    /INSERT INTO grn_items \(grnId, poItemIndex, po_id, po_item_id, materialCode/,
  );
  assert.match(SRC, /item\.poId \?\? null,\s*\n\s*item\.poItemId \?\? null,/);
});

test("a PO-linked line falls back to the header PO line when the caller omits it", () => {
  // An older client that still posts only poItemIndex must keep producing
  // resolvable rows rather than NULLs that silently stop drawing down.
  assert.match(SRC, /poId: \(item\.poId \?\? ""\)\.trim\(\) \|\| grnPoId/);
  assert.match(SRC, /poItemId: \(item\.poItemId \?\? ""\)\.trim\(\) \|\| poItem\?\.id \|\| null/);
});

test("a manual receipt records no PO line at all", () => {
  // No purchase order behind it, so there is nothing to draw down and the
  // columns must stay NULL rather than pointing somewhere plausible.
  assert.match(SRC, /poItemIndex: null,\s*\n\s*poId: null,\s*\n\s*poItemId: null,/);
});

test("the schema fixture records the self-applied columns", () => {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), "tests/db-schema.json"), "utf8"));
  assert.ok(schema.grn_items.includes("po_id"));
  assert.ok(schema.grn_items.includes("po_item_id"));
});
