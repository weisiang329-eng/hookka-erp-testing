// ---------------------------------------------------------------------------
// ocr-accuracy-sampleid.test.mjs — the queue carries the engine's REAL scan
// sample id, so corrections actually get written back.
//
// The OCR Accuracy dashboard was permanently empty and the distill gold pool
// never filled. Traced 2026-08-01 to one missing column:
//
//   * runExtract writes a po_scan_samples / supplier_scan_samples row and
//     RETURNS its id — but scan_queue never stored it;
//   * so the customer-PO wizard invented `queue-<rowId>-<docIdx>` and POSTed
//     confirm against it: the UPDATE matched 0 rows and failed silently;
//   * and the supplier wizards passed a hard-coded null, skipping confirm
//     entirely for every queue-built card;
//   * `correctedJson` therefore stayed NULL forever, and BOTH consumers filter
//     on `correctedJson IS NOT NULL`.
//
// Since 2026-06-30 the queue path is the default, so this had starved both
// features for over a month while the weekly distill cron ran green.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const queue = readFileSync("src/api/routes/scan-queue.ts", "utf8");
const poModal = readFileSync("src/components/scan-po-modal.tsx", "utf8");
const supModal = readFileSync("src/components/scan-supplier-modal.tsx", "utf8");

test("scan_queue carries sample_id — fresh installs and existing deployments", () => {
  assert.match(queue, /sample_id\s+TEXT/, "CREATE TABLE must declare it");
  assert.match(
    queue,
    /ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS sample_id TEXT/,
    "migrations are inert on deploy — the column needs a runtime self-apply",
  );
});

test("the worker persists the engine's sample id on completion", () => {
  assert.match(queue, /SET status = 'done',[\s\S]*?sample_id = \?/);
  assert.match(queue, /result\.sampleId \?\? null/);
});

test("sample_id is dual-keyed on read and returned to the client", () => {
  assert.match(queue, /r\.sampleId \?\? r\.sample_id \?\? null/, "camel/snake dual-key");
  const exposed = queue.match(/sampleId: (?:row|hydrated)\.sampleId \?\? null/g) ?? [];
  assert.ok(exposed.length >= 2, `batch + detail payloads must expose it, found ${exposed.length}`);
});

test("the customer-PO wizard no longer fabricates a sample id", () => {
  assert.doesNotMatch(
    poModal,
    /sampleId: `queue-\$\{it\.id\}-\$\{docIdx\}`/,
    "the synthetic id matched no row — confirm silently affected 0 rows",
  );
  assert.match(poModal, /sampleId: it\.sampleId/);
  // A null id must skip the POST rather than 404 and look like a success.
  assert.match(poModal, /if \(row\.sampleId\) \{[\s\S]{0,200}?scan-po\/samples\//);
});

test("both supplier wizards pass the real sample id to buildCard", () => {
  const wired = supModal.match(/buildCard\(it\.fileName, doc, it\.sampleId, it\.id, idx\)/g) ?? [];
  assert.equal(wired.length, 2, `PI + GRN must both wire it, found ${wired.length}`);
  assert.doesNotMatch(
    supModal,
    /buildCard\(it\.fileName, doc, null, it\.id, idx\)/,
    "hard-coded null skipped confirm for every queue-built card",
  );
});

test("the accuracy dashboard still keys off correctedJson — the column this unblocks", () => {
  const route = readFileSync("src/api/routes/ocr-accuracy.ts", "utf8");
  assert.match(route, /correctedJson IS NOT NULL/);
  // Both sample tables feed it, so both wizard families had to be fixed.
  assert.match(route, /FROM po_scan_samples/);
  assert.match(route, /FROM supplier_scan_samples/);
});

// --- accuracy by document type + scan timing (owner asks 4 and 5) ------------

test("supplier accuracy splits PI vs GR off the sample's docType", () => {
  const route = readFileSync("src/api/routes/ocr-accuracy.ts", "utf8");
  // No new column needed — the engine already stored docType on the sample.
  assert.match(route, /SELECT supplierHint, rawJson, correctedJson, docType/);
  assert.match(route, /INVOICE: "Purchase Invoice"/);
  assert.match(route, /DELIVERY_NOTE: "Goods Received \(DO\/GRN\)"/);
  // Exposed both as its own breakdown and as a per-supplier drill-down.
  assert.match(route, /docTypes: supplierDocTypes/);
  assert.match(route, /supBySupplierDoc/);
});

test("scan duration is aggregated per document type", () => {
  const route = readFileSync("src/api/routes/ocr-accuracy.ts", "utf8");
  // Enqueue → done is what the operator waits through.
  assert.match(route, /q\.completed_at::timestamptz - q\.created_at::timestamptz/);
  assert.match(route, /AVG\(EXTRACT\(EPOCH FROM/);
  assert.match(route, /PERCENTILE_CONT\(0\.9\)/, "an average alone hides the slow tail");
  // PI vs GR needs the sample join, which only works now sample_id is stored.
  assert.match(route, /LEFT JOIN supplier_scan_samples s ON s\.id = q\.sample_id/);
  // Cache hits complete in milliseconds and would skew the average.
  assert.match(route, /q\.status = 'done'/);
  assert.doesNotMatch(route, /status IN \('done', ?'cached'\)/);
});

test("the dashboard card renders both new sections", () => {
  const card = readFileSync("src/pages/dashboard-b/OcrAccuracyCard.tsx", "utf8");
  assert.match(card, /Supplier · by Document Type/);
  assert.match(card, /Scan time/);
  assert.match(card, /Slowest 10%/);
  // Long scans must not read as raw seconds.
  assert.match(card, /function secs\(/);
  assert.match(card, /\$\{m\}m \$\{String\(Math\.round\(v - m \* 60\)\)\.padStart\(2, "0"\)\}s/);
});
