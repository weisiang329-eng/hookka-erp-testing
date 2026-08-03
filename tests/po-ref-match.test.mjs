// ---------------------------------------------------------------------------
// po-ref-match.test.mjs — a supplier document naming several POs must never be
// half-linked.
//
// ADD WOOD's invoice prints `P/O No : 2607-003/2607-020`. The original matcher
// normalised the whole string to "26070032607020" and tested
// `ref.endsWith(poNo)` — true for the LAST number — so it linked 2607-020 and
// silently dropped 2607-003. That is worse than not linking: the invoice looks
// fully reconciled while the first PO's receipts are never drawn down.
//
// The rule these tests hold: split first, match each reference alone, and
// refuse to choose when the document names more than one.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { splitPoRefs, matchOnePoRef, resolvePoLink } from "../src/lib/po-ref-match.ts";

const POS = [
  { id: "po-a", poNo: "PO-2607-003" },
  { id: "po-b", poNo: "PO-2607-020" },
  { id: "po-c", poNo: "PO-2605-111" },
];

test("splits the separators suppliers actually use", () => {
  assert.deepEqual(splitPoRefs("2607-003/2607-020"), ["2607-003", "2607-020"]);
  assert.deepEqual(splitPoRefs("2607-003, 2607-020"), ["2607-003", "2607-020"]);
  assert.deepEqual(splitPoRefs("2607-003 and 2607-020"), ["2607-003", "2607-020"]);
  assert.deepEqual(splitPoRefs("2607-003 | 2607-020"), ["2607-003", "2607-020"]);
  assert.deepEqual(splitPoRefs("  2607-003  "), ["2607-003"]);
  assert.deepEqual(splitPoRefs(""), []);
});

test("matches one reference through punctuation drift", () => {
  assert.equal(matchOnePoRef("2607-003", POS).id, "po-a");
  assert.equal(matchOnePoRef("2607003", POS).id, "po-a");
  assert.equal(matchOnePoRef("PO 2607 003", POS).id, "po-a");
});

test("an ambiguous single reference resolves to nothing, not to a guess", () => {
  const dupes = [
    { id: "x", poNo: "PO-100" },
    { id: "y", poNo: "AA-100" },
  ];
  // "100" is a suffix of both — guessing here would book against the wrong PO.
  assert.equal(matchOnePoRef("100", dupes), null);
});

test("a single named PO links automatically", () => {
  const r = resolvePoLink("2607-003", POS, null);
  assert.equal(r.poId, "po-a");
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.matchedPoIds, ["po-a"]);
});

test("the real ADD WOOD field links NOTHING and reports both POs", () => {
  const r = resolvePoLink("2607-003/2607-020", POS, null);
  assert.equal(r.ambiguous, true);
  assert.equal(r.poId, null, "a two-PO document must not be silently half-linked");
  assert.deepEqual(r.matchedPoIds.sort(), ["po-a", "po-b"]);
});

test("the old endsWith trap specifically does not fire", () => {
  // Concatenated, "26070032607020" ends with "2607020" — the exact bug.
  const r = resolvePoLink("2607-003/2607-020", POS, null);
  assert.notEqual(r.poId, "po-b", "must not resolve to just the last number");
});

test("an ambiguous document ignores the host's default rather than masking it", () => {
  const r = resolvePoLink("2607-003/2607-020", POS, "po-c");
  assert.equal(r.poId, null, "a fallback must not paper over a multi-PO document");
});

test("an unrecognised reference falls back and is reported", () => {
  const r = resolvePoLink("9999-999", POS, "po-c");
  assert.equal(r.poId, "po-c");
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.unmatchedRefs, ["9999-999"]);
});

test("a blank reference just uses the fallback", () => {
  assert.equal(resolvePoLink("", POS, "po-c").poId, "po-c");
  assert.equal(resolvePoLink(null, POS, null).poId, null);
});

test("the same PO named twice is not treated as ambiguous", () => {
  const r = resolvePoLink("2607-003/2607-003", POS, null);
  assert.equal(r.ambiguous, false);
  assert.equal(r.poId, "po-a");
});

test("one recognised plus one unknown reference is still ambiguous to a human", () => {
  const r = resolvePoLink("2607-003/9999-999", POS, null);
  // Only one resolved, so it links — but the unmatched ref is surfaced so the
  // operator can see the document mentioned something we do not know about.
  assert.equal(r.poId, "po-a");
  assert.deepEqual(r.unmatchedRefs, ["9999-999"]);
});
