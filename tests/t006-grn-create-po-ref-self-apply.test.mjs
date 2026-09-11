// BUG (found in QA, 2026-09-11): "column \"po_id\" of relation \"grn_items\"
// does not exist" on a fresh database's FIRST GRN create — reproduced by any
// import-in-transit or OCR receipt (both land as DRAFT).
//
// Root cause: app.post("/") writes grn_items.po_id/po_item_id
// UNCONDITIONALLY (every create, DRAFT or POSTED), but ensureGrnItemPoRef
// (the self-apply for those two columns) was only ever called from inside
// resolveGrnLineTargets, which only runs on the POSTED-only stock/PO-counter
// branch. A DRAFT create skipped that branch entirely and hit the INSERT
// with the columns never added.
// Source-static — the mocked-D1 test harness doesn't model missing columns,
// which is why this shipped past tests/grn-multi-po.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/routes/grn.ts", "utf8");

test("ensureGrnItemPoRef runs unconditionally in create, not just on the POSTED branch", () => {
  const start = SRC.indexOf('app.post("/", async (c) => {');
  assert.ok(start !== -1, "GRN create handler must exist");
  const postedBranchIdx = SRC.indexOf('if (initialStatus === "POSTED")', start);
  const ensureCallIdx = SRC.indexOf("await ensureGrnItemPoRef(c.var.DB);", start);
  assert.ok(ensureCallIdx !== -1, "ensureGrnItemPoRef must be called in the create handler");
  assert.ok(
    ensureCallIdx < postedBranchIdx,
    "the self-apply must run before the POSTED-only branch, so a DRAFT create (import-in-transit / OCR) is covered too",
  );
});

test("the unconditional INSERT that needs it comes after the self-apply call", () => {
  const start = SRC.indexOf('app.post("/", async (c) => {');
  const ensureCallIdx = SRC.indexOf("await ensureGrnItemPoRef(c.var.DB);", start);
  const insertIdx = SRC.indexOf("INSERT INTO grn_items (grnId, poItemIndex, po_id, po_item_id", start);
  assert.ok(ensureCallIdx !== -1 && insertIdx !== -1 && ensureCallIdx < insertIdx);
});
