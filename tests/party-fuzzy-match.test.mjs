// ---------------------------------------------------------------------------
// party-fuzzy-match.test.mjs — rank the closest party instead of giving up
// (owner 2026-08-01: 「找到最像的都可以用啊」).
//
// Anchored on the measured ADD WOORD case: supplier 400-A002's master record
// carried a one-letter typo, both exact-ish matchers returned null, and edit
// distance put the right answer at 1 with the runner-up at 8.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  editDistance,
  rankPartiesByName,
  bestMatch,
} from "../src/lib/party-fuzzy-match.ts";

const SUPPLIERS = [
  { id: "sup-20d0fa1f", name: "ADD WOORD TRADING SDN. BHD." }, // the typo'd master
  { id: "s2", name: "OCEAN SKY TRADING SDN. BHD." },
  { id: "s3", name: "CHL FOAM PARTNER SDN BHD " },
  { id: "s4", name: "INNOVATEX SDN. BHD." },
];

test("editDistance basics", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("ADDWOORDTRADING", "ADDWOODTRADING"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
});

test("THE MEASURED CASE: a one-letter typo in the master still resolves", () => {
  const ranked = rankPartiesByName(SUPPLIERS, "ADD WOOD TRADING SDN BHD");
  assert.equal(ranked[0].party.id, "sup-20d0fa1f");
  assert.equal(ranked[0].distance, 1, "ADDWOODTRADING vs ADDWOORDTRADING");
  assert.ok(ranked[1].distance >= 8, `runner-up should be far behind, got ${ranked[1].distance}`);

  const best = bestMatch(SUPPLIERS, "ADD WOOD TRADING SDN BHD");
  assert.equal(best?.party.id, "sup-20d0fa1f");
});

test("the legal suffix is already normalised away — no distance cost", () => {
  const parties = [{ id: "a", name: "Houzs Century" }];
  const ranked = rankPartiesByName(parties, "Houzs Century Sdn Bhd");
  assert.equal(ranked[0].distance, 0);
  assert.equal(ranked[0].score, 1);
  assert.equal(bestMatch(parties, "HOUZS CENTURY SDN. BHD.")?.party.id, "a");
});

test("a near-tie returns null rather than a coin flip", () => {
  const twins = [
    { id: "a", name: "ADD WOOD TRADING" },
    { id: "b", name: "ADD WOODS TRADING" },
  ];
  // distances 1 and 2 — a one-edit lead is not enough to pre-select.
  assert.equal(bestMatch(twins, "ADD WOOD TRADINGS"), null);
});

test("two parties normalising identically are unresolvable", () => {
  const dup = [
    { id: "a", name: "Acme Sdn Bhd" },
    { id: "b", name: "ACME" },
  ];
  assert.equal(bestMatch(dup, "Acme"), null, "ambiguous — operator must choose");
});

test("a genuinely different company is refused, not force-matched", () => {
  assert.equal(bestMatch(SUPPLIERS, "TOTALLY UNRELATED ENTERPRISE"), null);
  // Shared prefix but a different company — still below threshold.
  assert.equal(bestMatch([{ id: "a", name: "ADD WOOD TRADING" }], "ADD PANEL MARKETING"), null);
});

test("empty / letterless input ranks nothing", () => {
  for (const v of [null, undefined, "", "   ", "---"]) {
    assert.deepEqual(rankPartiesByName(SUPPLIERS, v), []);
    assert.equal(bestMatch(SUPPLIERS, v), null);
  }
});

test("thresholds are tunable per call site", () => {
  const twins = [
    { id: "a", name: "ADD WOOD TRADING" },
    { id: "b", name: "ADD WOODS TRADING" },
  ];
  // Caller that accepts a 1-edit lead gets the top candidate.
  assert.equal(bestMatch(twins, "ADD WOOD TRADINGS", { minLead: 1 })?.party.id, "a");
  // A stricter score gate refuses the ADD WOORD match.
  assert.equal(bestMatch(SUPPLIERS, "ADD WOOD TRADING SDN BHD", { minScore: 0.99 }), null);
});

test("ranking is deterministic when distances tie", () => {
  const parties = [
    { id: "b", name: "Beta Trading" },
    { id: "a", name: "Alpha Trading" },
  ];
  const r1 = rankPartiesByName(parties, "Gamma Trading").map((c) => c.party.id);
  const r2 = rankPartiesByName([...parties].reverse(), "Gamma Trading").map((c) => c.party.id);
  assert.deepEqual(r1, r2, "same input set must rank identically regardless of array order");
});
