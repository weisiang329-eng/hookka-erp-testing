// ---------------------------------------------------------------------------
// dashboard-truthfulness.test.mjs — the Command Center (`/dashboard`) audit of
// 2026-08-14. Pins three defects, all in docs/BUG-CLASSES.md C15:
//
//   BUG-2026-08-13-107  C15 — a dead read rendered as an answer, on the
//                       highest-traffic screen in the app. The Daily Report
//                       tile printed `compCounts?.total ?? 0` — a large GREEN
//                       0 captioned "All clear — nothing flagged today" —
//                       whenever /api/reports/compliance.json timed out, 500'd
//                       or was aborted, because `useCachedJson` hands back
//                       `data = null, loading = false` for a killed request and
//                       for a genuinely clean day alike. /daily-report reads the
//                       SAME endpoint and already says "Could not load the
//                       report." Same data, two screens, one of them lying.
//                       The class's growth guard
//                       (record-load-failure-class.test.mjs) could never catch
//                       this: it scans for the string "not found", and this
//                       page's false sentence is "All clear".
//
//   BUG-2026-08-13-104  C15 — the same shape one card down. OcrAccuracyCard
//                       printed "No scans yet. Once you scan and import orders
//                       / supplier docs, the accuracy shows here automatically."
//                       over a failed fetch, because `!d` is true for an abort
//                       and for an empty 2xx body alike.
//
//   BUG-2026-08-13-105  C15, third corollary (publish the provenance beside the
//                       figure). MIN_SAMPLE exists BECAUSE the Supplier panel
//                       printed a red 0% off ONE document (owner 2026-08-05:
//                       "one edited field on one scan is 0%… neither says
//                       anything about the scanner"). Every table forwards its
//                       bucket's `total` to rateColor()/pct() so a thin sample
//                       greys out and gets a "*" — except the by-Supplier rows,
//                       which called `rateColor(s.rate)` / `pct(s.rate)` with no
//                       total. The guard was live everywhere except on the panel
//                       it was written for.
//
// STRUCTURAL (readFileSync source assertions), for the reason every sibling
// no-fabricated-* / *-truthfulness file gives: none of these is a runtime
// error. `0` is a valid number, "All clear" is valid copy and a green tick is
// valid markup — a plausible screen is exactly what the bug produces, so only
// the source can be pinned. Comments are stripped before matching so this
// header may quote each bug verbatim without satisfying or tripping a guard,
// and every read normalises CRLF + BOM so the assertions are EOL-agnostic (the
// repo's files are CRLF; a literal \n anchor would silently match nothing).
//
// Each assertion below was proved RED by reintroducing the exact removed
// expression in the worktree and watching this file fail.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) =>
  readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

// Block comments are anchored to the start of a line — the unanchored pattern
// eats JSX `accept="*/*"`-style attributes and silently blanks the rest of the
// file, which is how a guard passes while the bug is still in it.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const DASH = "src/pages/dashboard-b/index.tsx";
const OCR = "src/pages/dashboard-b/OcrAccuracyCard.tsx";
const EDITIONS = "src/pages/hookka-report-editions.tsx";
const AGG = "src/api/lib/operations-report.ts";
const dash = () => stripComments(read(DASH));
const ocr = () => stripComments(read(OCR));

// ===========================================================================
// BUG-2026-08-13-107 — the Daily Report tile
// ===========================================================================

test("the Daily Report tile classifies its failure before printing a count", () => {
  const src = dash();
  assert.ok(
    /failure:\s*compFailure/.test(src),
    "the compliance fetch must destructure `failure` — `data`+`loading` alone " +
      "cannot tell a clean day from a killed request",
  );
  assert.ok(
    /const compFailed\s*=[\s\S]{0,200}?isUnknownOutcome\(compFailure\)/.test(src),
    "`compFailed` must be derived through isUnknownOutcome(compFailure): only " +
      "an observed 404 is an absence, everything else leaves the answer UNKNOWN",
  );
});

test("'All clear' cannot render over a failed compliance read", () => {
  const src = dash();
  // The caption ternary must test compFailed FIRST. Anchored on the literal
  // copy so a reworded tile still has to re-enter this guard deliberately.
  assert.ok(
    /\{compFailed\s*\?[\s\S]{0,400}?All clear/.test(src),
    "the 'All clear — nothing flagged today' caption must sit behind the " +
      "compFailed branch; an unknown day is not a quiet one",
  );
  // …and the headline number itself must not be reachable while compFailed.
  assert.ok(
    /compFailed\s*\?\s*\([\s\S]{0,400}?—[\s\S]{0,400}?\)\s*:/.test(src),
    "the headline must render an em dash on failure — `?? 0` states 'zero " +
      "exceptions', which is a claim about the business",
  );
});

// ===========================================================================
// BUG-2026-08-13-104 — the OCR card's empty caption
// ===========================================================================

test("'No scans yet' cannot render over a failed OCR read", () => {
  const src = ocr();
  assert.ok(
    /const loadFailed\s*=[\s\S]{0,200}?isUnknownOutcome\(failure\)/.test(src),
    "OcrAccuracyCard must classify its failure — `!d` is true for a 30 s " +
      "abort and for an empty 2xx body alike",
  );
  assert.ok(
    /loadFailed\s*\?[\s\S]{0,1400}?No scans yet/.test(src),
    "the 'No scans yet.' caption must sit AFTER the loadFailed branch, or a " +
      "dead request again reads as 'the scanner was never used'",
  );
  assert.ok(
    /not a statement that nothing was scanned/.test(read(OCR)),
    "the failure card must say what it is NOT claiming — the sentence is the " +
      "whole point of the honest branch",
  );
});

// ===========================================================================
// BUG-2026-08-13-105 — MIN_SAMPLE reaching the panel it was written for
// ===========================================================================

test("every OCR rate cell forwards its sample size to the MIN_SAMPLE guard", () => {
  const src = ocr();
  // Any rateColor()/pct() call with a single argument re-opens the hole: a
  // one-document supplier renders a confident red 0% with no asterisk.
  const singleArg = [...src.matchAll(/\b(rateColor|pct)\(([^(),]*)\)/g)].map(
    (m) => `${m[1]}(${m[2]})`,
  );
  assert.deepEqual(
    singleArg,
    [],
    "these calls pass a rate with no total, so the <5-document greying never " +
      "applies to them: " + singleArg.join(", "),
  );
  assert.ok(
    /rateColor\(s\.rate,\s*s\.total\)/.test(src) && /pct\(s\.rate,\s*s\.total\)/.test(src),
    "the by-Supplier rows must pass s.total — that panel is the one the owner " +
      "reported a red 0% off ONE document on",
  );
  assert.ok(
    /const MIN_SAMPLE\s*=\s*5/.test(src),
    "the sample-size floor itself must stay",
  );
});

// ===========================================================================
// BUG-2026-08-13-106 — the Hookka Report's receivables strip must render
// every bucket the aggregator computes, or the boxes do not add up to the
// total printed beside them.
// ===========================================================================

test("the printed receivables strip renders all five aging buckets", () => {
  const agg = stripComments(read(AGG));
  // Establish the population from the SOURCE, so this test tracks the
  // aggregator rather than a hardcoded list of five names.
  const buckets = [...agg.matchAll(/aging\.(\w+Sen)\s*\+=/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(buckets)].sort(),
    ["currentSen", "d30Sen", "d60Sen", "d90Sen", "over90Sen"],
    "the aggregator's bucket set changed — update the strip and this guard together",
  );
  const strip = stripComments(read(EDITIONS));
  for (const b of new Set(buckets)) {
    assert.ok(
      strip.includes(`r.receivables.aging.${b}`),
      `the printed strip drops \`${b}\`: money in that bucket vanishes from a ` +
        `receivables statement and the boxes stop tying to the total beside them`,
    );
  }
  assert.ok(
    /grid-cols-5/.test(strip),
    "five buckets need five columns — a 4-column grid is what hid one of them",
  );
});

test("the receivables captions do not claim days over a month-diff bucket", () => {
  const agg = stripComments(read(AGG));
  assert.ok(
    /const mo = monthsOverdue\(/.test(agg),
    "the bucketing is month-based; if it becomes day-based, relabel the strip",
  );
  const strip = stripComments(read(EDITIONS));
  // The old shifted day labels sat directly on the aging tuples. Anchor on the
  // tuple so an unrelated "90d+" elsewhere on the page cannot trip this.
  assert.ok(
    !/\["\d+–\d+d",\s*r\.receivables\.aging\./.test(strip),
    'a "31–60d"-style caption is back on a bucket counted in whole months',
  );
});
