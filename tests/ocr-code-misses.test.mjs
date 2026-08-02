// ---------------------------------------------------------------------------
// ocr-code-misses.test.mjs — the detector that splits "Product code (54)" into
// the four defects hiding behind one label.
//
// The dashboard's single biggest failure reason is Product code, and its cure
// depends entirely on the split: a normaliser is exact and permanent, an alias
// learns after one correction, and only a genuine misread needs prompt work.
// Guessing the mix spends the effort in the wrong place, so this classifies
// from data and writes nothing.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normaliseCode,
  classifyCodeMiss,
  collectCodeMisses,
  checkOcrCodeMisses,
} from "../src/api/lib/ocr-code-misses.ts";

const KNOWN = new Set(["SL135E", "NLYD30", "HB1200"]);

const sample = (customer, rawItems, corrItems) => ({
  customerHint: customer,
  rawExtracted: JSON.stringify({ items: rawItems }),
  correctedJson: JSON.stringify({ items: corrItems }),
});

test("normaliseCode strips every separator the shop floor writes", () => {
  assert.equal(normaliseCode("SL 13.5 (E)"), "SL135E");
  assert.equal(normaliseCode("sl-13.5-e"), "SL135E");
  assert.equal(normaliseCode(null), "");
  assert.equal(normaliseCode("  "), "");
});

test("an empty extraction is blank_raw, not a misread", () => {
  assert.equal(classifyCodeMiss("", "SL-13.5-E", KNOWN), "blank_raw");
  assert.equal(classifyCodeMiss("   ", "SL-13.5-E", KNOWN), "blank_raw");
});

test("same code, different punctuation is normalisable — checked BEFORE the catalogue", () => {
  // The trap: `SL 13.5 (E)` IS a known code once normalised, so a catalogue-first
  // classifier would call it real_but_wrong and send the work to the model when
  // a pure string normaliser already has it.
  assert.equal(classifyCodeMiss("SL 13.5 (E)", "SL-13.5-E", KNOWN), "normalisable");
});

test("a string that is not one of our codes is learnable as an alias", () => {
  assert.equal(classifyCodeMiss("CUST-PART-9931", "SL-13.5-E", KNOWN), "unknown_raw");
});

test("a valid catalogue code that was still changed is a true misread", () => {
  assert.equal(classifyCodeMiss("HB1200", "SL-13.5-E", KNOWN), "real_but_wrong");
});

test("identical codes are not a change at all", () => {
  const { pairs, summary } = collectCodeMisses(
    [sample("Carres", [{ productCode: "sl-13.5-e" }], [{ productCode: "SL-13.5-E " }])],
    KNOWN,
  );
  assert.deepEqual(pairs, []);
  assert.equal(summary.linesCompared, 1);
  assert.equal(summary.linesChanged, 0);
});

test("the same pair seen twice counts twice and keeps both customers", () => {
  const { pairs } = collectCodeMisses(
    [
      sample("Carres", [{ productCode: "CUST-99" }], [{ productCode: "SL-13.5-E" }]),
      sample("Houzs", [{ productCode: "CUST-99" }], [{ productCode: "SL-13.5-E" }]),
    ],
    KNOWN,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].count, 2);
  assert.deepEqual(pairs[0].customers, ["Carres", "Houzs"]);
});

test("the summary names what a lookup can fix without any model work", () => {
  const { summary } = collectCodeMisses(
    [
      sample("A", [{ productCode: "SL 13.5 (E)" }], [{ productCode: "SL-13.5-E" }]), // normalisable
      sample("A", [{ productCode: "CUST-99" }], [{ productCode: "SL-13.5-E" }]), // unknown_raw
      sample("A", [{ productCode: "" }], [{ productCode: "SL-13.5-E" }]), // blank_raw
      sample("A", [{ productCode: "HB1200" }], [{ productCode: "SL-13.5-E" }]), // real_but_wrong
    ],
    KNOWN,
  );
  assert.equal(summary.linesChanged, 4);
  assert.deepEqual(summary.byKind, {
    normalisable: 1,
    unknown_raw: 1,
    blank_raw: 1,
    real_but_wrong: 1,
  });
  assert.equal(summary.fixableByLookup, 2, "normalisable + unknown_raw");
});

test("a line the operator ADDED is skipped — there was no extraction to judge", () => {
  // Counting it here would double-charge it: the dashboard already reports it
  // under "Line added/removed".
  const { pairs, summary } = collectCodeMisses(
    [sample("A", [{ productCode: "SL-13.5-E" }], [{ productCode: "SL-13.5-E" }, { productCode: "HB1200" }])],
    KNOWN,
  );
  assert.deepEqual(pairs, []);
  assert.equal(summary.linesCompared, 1);
});

test("a sample with no correctedJson is not a sample", () => {
  const { summary } = collectCodeMisses(
    [{ customerHint: "A", rawExtracted: JSON.stringify({ items: [{ productCode: "X" }] }), correctedJson: null }],
    KNOWN,
  );
  assert.equal(summary.linesCompared, 0);
});

test("unparseable JSON is skipped, not thrown on", () => {
  const { summary } = collectCodeMisses(
    [{ customerHint: "A", rawExtracted: "{not json", correctedJson: "{also not json" }],
    KNOWN,
  );
  assert.equal(summary.linesCompared, 0);
});

test("the driver's snake_case keys are read too", () => {
  // db-pg returns whatever the alias spelled; every alias in this file is
  // snake_case on purpose, so the row arrives snake_cased.
  const { pairs } = collectCodeMisses(
    [
      {
        customer_hint: "Carres",
        raw_extracted: JSON.stringify({ items: [{ productCode: "CUST-99" }] }),
        corrected_json: JSON.stringify({ items: [{ productCode: "SL-13.5-E" }] }),
      },
    ],
    KNOWN,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].customers[0], "Carres");
});

test("it never throws — one bad query cannot take a report down", async () => {
  const db = {
    prepare() {
      return {
        async all() {
          throw new Error("boom");
        },
      };
    },
  };
  const out = await checkOcrCodeMisses(db);
  assert.deepEqual(out.pairs, []);
  assert.equal(out.summary.linesChanged, 0);
});

test("the detector writes NOTHING", () => {
  const src = readFileSync("src/api/lib/ocr-code-misses.ts", "utf8");
  assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|DROP TABLE)\b/);
});

test("it is reachable on demand", () => {
  const reports = readFileSync("src/api/routes/reports.ts", "utf8");
  assert.match(reports, /app\.get\("\/ocr-code-misses\.json"/);
});
