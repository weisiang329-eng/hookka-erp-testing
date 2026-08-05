// ---------------------------------------------------------------------------
// ocr-accuracy-customer-grouping.test.mjs
//
// Two defects the owner hit on the OCR accuracy dashboard, 2026-08-05.
//
// 1. `po_scan_samples.customerHint` was `fileName.split(/[-_ .]/)[0]` — the
//    first token of whatever the operator called the file. Owner report:
//    「为什么它会收到像 PO2068 这样的东西？非常奇怪」. Prod held
//      'PO' x63 · 'Carres Sdn. Bhd.' x59 · 'Houzs Century Sdn Bhd' x57 ·
//      'Ohana' x14 · 'Houzs Century' x3 · 'PO2608' x2 · '9752' x1 ·
//      '2990 HOME SDN. BHD.' x1
//    against real customers.name values
//      '2990 HOME SDN BHD' · 'abc' · 'Carress' · 'Houzs Century' ·
//      'SL HOME DESIGN' · 'SOON' · 'The Conts'
//    — PO numbers filed as customers, and one customer split over several rows.
//
// 2. The parent row counted DOCUMENTS while its expanded children counted
//    LINES, under one "Scans" header: parent 'PO' 59, children 87 + 4 + 1 = 92.
//
// Capture side + read side are both asserted; existing prod rows are NOT
// migrated, so the read side has to keep folding the junk forever.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const hint = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/customer-hint.ts")).href
);
const { isPoNumberFragment, cleanCustomerHint, resolveCustomerHint, UNIDENTIFIED_CUSTOMER } = hint;

// The live customers.name roster (prod, 2026-08-05).
const CUSTOMERS = [
  { id: "c1", name: "2990 HOME SDN BHD" },
  { id: "c2", name: "abc" },
  { id: "c3", name: "Carress" },
  { id: "c4", name: "Houzs Century" },
  { id: "c5", name: "SL HOME DESIGN" },
  { id: "c6", name: "SOON" },
  { id: "c7", name: "The Conts" },
];

// ---- DEFECT 1a: a PO-number fragment is not a customer --------------------

test("the live junk hints are recognised as PO-number fragments", () => {
  for (const junk of ["PO", "PO2608", "9752", "PO-2608", "po/2608", "P.O", "2608"]) {
    assert.equal(isPoNumberFragment(junk), true, `${junk} should be junk`);
  }
});

test("real customer names are never mistaken for PO numbers", () => {
  for (const c of CUSTOMERS) {
    assert.equal(isPoNumberFragment(c.name), false, `${c.name} must survive`);
  }
  for (const name of ["Carres Sdn. Bhd.", "Houzs Century Sdn Bhd", "Ohana", "2990 HOME SDN. BHD."]) {
    assert.equal(isPoNumberFragment(name), false, `${name} must survive`);
  }
});

test("cleanCustomerHint stores NULL rather than a fake customer", () => {
  assert.equal(cleanCustomerHint("PO"), null);
  assert.equal(cleanCustomerHint("PO2608"), null);
  assert.equal(cleanCustomerHint("9752"), null);
  assert.equal(cleanCustomerHint("   "), null);
  assert.equal(cleanCustomerHint(null), null);
  assert.equal(cleanCustomerHint("  Houzs Century  "), "Houzs Century");
});

// ---- DEFECT 1b: a good hint resolves to the customer record ---------------

test("legal-suffix and punctuation spellings fold onto the one catalog name", () => {
  assert.equal(resolveCustomerHint(CUSTOMERS, "Houzs Century Sdn Bhd").name, "Houzs Century");
  assert.equal(resolveCustomerHint(CUSTOMERS, "Houzs Century").name, "Houzs Century");
  assert.equal(resolveCustomerHint(CUSTOMERS, "2990 HOME SDN. BHD.").name, "2990 HOME SDN BHD");
  // The scanner's spelling is one letter short of the record — the unique
  // prefix fallback keeps 59 rows out of the Unidentified bucket.
  assert.equal(resolveCustomerHint(CUSTOMERS, "Carres Sdn. Bhd.").name, "Carress");
});

test("a hint that names nobody resolves to null (→ Unidentified)", () => {
  assert.equal(resolveCustomerHint(CUSTOMERS, "Ohana"), null);
  assert.equal(resolveCustomerHint(CUSTOMERS, "PO"), null);
  assert.equal(resolveCustomerHint(CUSTOMERS, "PO2608"), null);
  assert.equal(resolveCustomerHint(CUSTOMERS, "9752"), null);
  assert.equal(resolveCustomerHint(CUSTOMERS, ""), null);
});

test("two customers matching the same hint is rejected, never guessed", () => {
  const twins = [
    { id: "a", name: "Houzs Century Sdn Bhd" },
    { id: "b", name: "Houzs Century" },
  ];
  assert.equal(resolveCustomerHint(twins, "Houzs Century"), null);
  // …and a fragment shorter than the guard never prefix-matches anything.
  assert.equal(resolveCustomerHint(CUSTOMERS, "S"), null);
  assert.equal(resolveCustomerHint(CUSTOMERS, "SO"), null);
});

test("the live hint distribution collapses to 4 rows, not 8", () => {
  const LIVE = [
    ["PO", 63], ["Carres Sdn. Bhd.", 59], ["Houzs Century Sdn Bhd", 57],
    ["Ohana", 14], ["Houzs Century", 3], ["PO2608", 2], ["9752", 1],
    ["2990 HOME SDN. BHD.", 1],
  ];
  const grouped = new Map();
  for (const [raw, n] of LIVE) {
    const key = resolveCustomerHint(CUSTOMERS, raw)?.name ?? UNIDENTIFIED_CUSTOMER;
    grouped.set(key, (grouped.get(key) ?? 0) + n);
  }
  assert.deepEqual([...grouped.entries()].sort((a, b) => b[1] - a[1]), [
    ["Unidentified", 80], // 'PO' 63 + 'Ohana' 14 + 'PO2608' 2 + '9752' 1
    ["Houzs Century", 60], // 57 + 3, one customer, one row
    ["Carress", 59],
    ["2990 HOME SDN BHD", 1],
  ]);
  // Every unresolvable spelling shares ONE bucket — no row per junk string.
  assert.equal(grouped.size, 4);
  assert.equal([...grouped.values()].reduce((a, b) => a + b, 0), 200);
});

// ---- Capture side ---------------------------------------------------------

const scanPo = readFileSync("src/api/routes/scan-po.ts", "utf8");
const engine = readFileSync("src/api/lib/scan-engine.ts", "utf8");

test("neither capture path stores a raw file-name token any more", () => {
  for (const [name, src] of [["scan-po.ts", scanPo], ["scan-engine.ts", engine]]) {
    assert.match(src, /cleanCustomerHint\(/, `${name} must filter the hint`);
    assert.doesNotMatch(
      src,
      /customerHintGuess\s*=\s*\n?\s*(opts\.fileName|name)\.split/,
      `${name} must not bind the raw file-name token`,
    );
  }
});

test("scan-po prefers the catalog-resolved customer over the letterhead", () => {
  assert.match(
    scanPo,
    /resolvedCustomer\?\.name \?\?\s*\n?\s*cleanCustomerHint\(po\.customerName\) \?\?\s*\n?\s*customerHintGuess/,
    "resolved catalog name → cleaned letterhead → cleaned file name",
  );
  // rawExtracted is the accuracy baseline: it must still be the PRE-enrichment
  // extraction even though the enrichment now runs before the INSERT.
  assert.match(scanPo, /const rawExtracted = JSON\.stringify\(po\);\s*\n\s*const warnings = validateAndEnrichPO/);
});

test("confirm promotes the operator's own customer pick to the hint", () => {
  assert.match(scanPo, /SET correctedJson = \?, isGold = \?, customerHint = \?/);
  assert.match(scanPo, /pickedHint\s*=\s*cleanCustomerHint\(row\?\.name\)/);
  // A failed lookup must leave the stored hint alone, not blank it.
  assert.match(scanPo, /pickedHint\s*\n?\s*\?[\s\S]{0,400}customerHint = \?[\s\S]{0,400}:\s*await/);
});

test("no data migration — prod rows are folded at read time, never rewritten", () => {
  const route = readFileSync("src/api/routes/ocr-accuracy.ts", "utf8");
  assert.doesNotMatch(route, /\bUPDATE\b|\bDELETE\b/i, "the dashboard route is read-only");
  assert.match(route, /resolveCustomerHint\(/);
  assert.match(route, /UNIDENTIFIED_CUSTOMER/);
});

// ---- DEFECT 2: parent and child must not share a unit silently ------------

test("the route stamps a unit on every bucket — documents vs lines", () => {
  const route = readFileSync("src/api/routes/ocr-accuracy.ts", "utf8");
  assert.match(route, /type BucketUnit = "documents" \| "lines"/);
  // customer row = documents, its category children = lines.
  assert.match(route, /bucketOut\(cb, "lines"\)/);
  assert.match(route, /bucketOut\(b, "documents", children\)/);
});

test("the card renders the unit and drops the ambiguous 'Scans' header", () => {
  const card = readFileSync("src/pages/dashboard-b/OcrAccuracyCard.tsx", "utf8");
  // A bare "Scans" header over two different units is the bug. The ONE that
  // may remain is the scan-time table, where a row really is a scan_queue run.
  const scansHeaders = card.match(/>Scans</g) ?? [];
  assert.equal(scansHeaders.length, 1, "only the scan-time table may say 'Scans'");
  assert.match(card, />Documents \/ Lines</);
  assert.match(card, /countWithUnit\(b\.total, b\.unit\)/, "parent row");
  assert.match(card, /countWithUnit\(cc\.total, cc\.unit\)/, "child row");
});
