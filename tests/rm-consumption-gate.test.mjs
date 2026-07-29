// ---------------------------------------------------------------------------
// rm-consumption-gate.test.mjs — pins the RM-consumption gate (owner 2026-07-29:
// 「等我说 ok 就正式扣料」). Until kv_config['rm_consumption_mode']='LIVE', the
// consume path runs PREVIEW: it records what WOULD be consumed to
// rm_consume_preview and returns WITHOUT touching rm_batches / raw_materials /
// cost_ledger. Fail-CLOSED default (PREVIEW) so incomplete BOMs never deduct.
// Structural pins (source assertions, the repo idiom); live behaviour is
// verified on prod after the owner flips to LIVE.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/api/lib/po-cost-cascade.ts", import.meta.url),
  "utf8",
);

// Isolate the recordConsumePreview function body for negative assertions.
const previewFn = (() => {
  const start = src.indexOf("export async function recordConsumePreview");
  assert.ok(start > -1, "recordConsumePreview must exist");
  const end = src.indexOf("export async function consumeRawMaterialsForPO", start);
  assert.ok(end > start, "consumeRawMaterialsForPO must follow recordConsumePreview");
  return src.slice(start, end);
})();

test("mode helper fails CLOSED to PREVIEW (missing row + on error)", () => {
  const fn = src.slice(
    src.indexOf("export async function getRmConsumptionMode"),
    src.indexOf("let rmConsumePreviewTableEnsured"),
  );
  assert.match(fn, /if \(!row\) return "PREVIEW"/, "missing kv_config row → PREVIEW");
  assert.match(fn, /catch\s*\{\s*return "PREVIEW"/, "any read error → PREVIEW (fail-closed)");
  assert.match(fn, /=== "LIVE" \? "LIVE" : "PREVIEW"/, "only an explicit LIVE opts into consumption");
});

test("consume gates on mode BEFORE any FIFO/stock work", () => {
  const gateIdx = src.indexOf("if (mode !== \"LIVE\")");
  // Search for the LIVE-path bomLines AFTER the gate — recordConsumePreview
  // (defined above) also resolves bomLines, so a from-0 indexOf would find that
  // one and give a false negative.
  const bomIdx = src.indexOf("const bomLines = await resolveBomMaterials(db, po)", gateIdx);
  assert.ok(gateIdx > -1, "consume must branch on mode");
  assert.ok(bomIdx > gateIdx, "the PREVIEW early-return must come BEFORE the live consume path");
  // The PREVIEW branch records a preview and returns, all before the live path.
  const previewCallIdx = src.indexOf("recordConsumePreview(db, po)", gateIdx);
  assert.ok(
    previewCallIdx > gateIdx && previewCallIdx < bomIdx,
    "PREVIEW branch must call recordConsumePreview before the live consume path",
  );
  const returnPreviewIdx = src.indexOf("preview: true", gateIdx);
  assert.ok(
    returnPreviewIdx > previewCallIdx && returnPreviewIdx < bomIdx,
    "PREVIEW branch must return preview:true before the live consume path",
  );
});

test("PREVIEW writes ONLY rm_consume_preview — never rm_batches / RM_ISSUE / raw_materials", () => {
  assert.match(previewFn, /INSERT INTO rm_consume_preview/, "preview persists to its own table");
  assert.doesNotMatch(previewFn, /RM_ISSUE/, "preview must NOT write an RM_ISSUE ledger row");
  assert.doesNotMatch(previewFn, /UPDATE rm_batches/, "preview must NOT decrement rm_batches");
  assert.doesNotMatch(previewFn, /UPDATE raw_materials/, "preview must NOT decrement raw_materials balance");
});

test("preview table + a forceLive escape hatch exist", () => {
  assert.match(src, /CREATE TABLE IF NOT EXISTS rm_consume_preview/, "runtime self-applied preview table");
  assert.match(src, /opts\?\: \{ forceLive\?: boolean \}/, "consume accepts a forceLive override for the go-live backfill");
});
