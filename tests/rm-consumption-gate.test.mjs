// ---------------------------------------------------------------------------
// rm-consumption-gate.test.mjs — pins the RM-consumption gate (owner 2026-07-29:
// 「等我说 ok 就正式扣料」). With kv_config['rm_consumption_mode'] = 'PREVIEW',
// the consume path records what WOULD be consumed to rm_consume_preview and
// returns WITHOUT touching rm_batches / raw_materials / cost_ledger.
//
// THE DEFAULT IS LIVE, AND THE ASSERTIONS BELOW DELIBERATELY SAY SO.
//
// This gate was written on 2026-07-29 defaulting to PREVIEW, fail-closed,
// because the BOMs were half-finished and consuming against them would deduct
// nonsense. It never merged. By the time it was picked up (2026-08-20) prod had
// moved: 384 of 385 BOM templates carry components, and RM consumption has been
// running normally — 2,150 RM_ISSUE entries since April, 418 in the last 30
// days. Merging the original default would have STOPPED deduction on a working
// system, and nobody would have noticed until the month-end numbers came out
// wrong.
//
// So: PREVIEW is now the thing you switch ON to dry-run a BOM change, not the
// thing you must remember to switch off. If a future reader thinks the default
// looks backwards, this paragraph is the reason it is not.
//
// Structural pins (source assertions, the repo idiom); live behaviour is
// verified on prod after a deliberate switch to PREVIEW.
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

test("an unset or unreadable mode keeps the factory deducting", () => {
  // The failure that matters here is NOT "we deducted when we should not have";
  // it is "we silently stopped deducting and found out at month end". So every
  // ambiguous state resolves to LIVE.
  const fn = src.slice(
    src.indexOf("export async function getRmConsumptionMode"),
    src.indexOf("let rmConsumePreviewTableEnsured"),
  );
  assert.match(fn, /if \(!row\) return "LIVE"/, "no kv_config row → LIVE");
  assert.match(fn, /catch\s*\{\s*return "LIVE"/, "a read error → LIVE, not a silent stop");
});

test("only the exact string PREVIEW turns deduction off", () => {
  // A typo, a stale value or a half-written config must not stop stock moving.
  const fn = src.slice(
    src.indexOf("export async function getRmConsumptionMode"),
    src.indexOf("let rmConsumePreviewTableEnsured"),
  );
  assert.match(
    fn,
    /=== "PREVIEW" \? "PREVIEW" : "LIVE"/,
    "anything other than an explicit PREVIEW must stay LIVE",
  );
});

test("the reason the default was inverted is written down next to it", () => {
  // Without this note the default reads as a bug, and the next person flips it
  // back — re-breaking a working factory. The comment is load-bearing.
  const fn = src.slice(
    src.indexOf("// RM-consumption mode gate"),
    src.indexOf("export type RmConsumptionMode"),
  );
  assert.match(fn, /THE DEFAULT IS "LIVE"/);
  assert.match(fn, /384 of 385/, "the measurement that justifies it must stay");
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
