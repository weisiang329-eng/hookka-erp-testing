// ---------------------------------------------------------------------------
// material-text-match.test.mjs — read text → catalogue, without guessing wrong.
//
// The scanner used to resolve a line only through a saved supplier binding, so
// the first appearance of an item always needed a manual pick even though the
// OCR had plainly read its description. This matcher uses that reading.
//
// The bar is deliberately high because the two mistakes cost very different
// amounts: a blank line costs one pick, while a WRONG match books stock and
// cost against the wrong material and surfaces much later. Every test below is
// about that asymmetry — match confidently, or not at all.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenize,
  similarity,
  matchCatalogItem,
  MIN_SCORE,
} from "../src/lib/material-text-match.ts";

const CATALOG = [
  { itemCode: "PLY-9-48-AB", description: "PLYWOOD 9MM 4X8 AB" },
  { itemCode: "PLY-18-48", description: "PLYWOOD 18MM 4X8" },
  { itemCode: "FOAM-D24-2", description: "FOAM D24 2INCH SHEET" },
  { itemCode: "LEG-6-CHR", description: "LEG 6INCH CHROME" },
];

test("punctuation and feet marks do not change the tokens", () => {
  assert.deepEqual(tokenize(`9MM 4' X 8' PLYWOOD AB`), ["9MM", "4X8", "PLYWOOD", "AB"]);
  assert.deepEqual(tokenize("PLYWOOD 9MM 4X8 AB"), ["PLYWOOD", "9MM", "4X8", "AB"]);
});

test("a dimension written either way lands on one token", () => {
  assert.ok(tokenize("4 X 8").includes("4X8"));
  assert.ok(tokenize("4X8").includes("4X8"));
});

test("word order does not matter", () => {
  assert.equal(similarity("PLYWOOD 9MM AB", "AB 9MM PLYWOOD"), 1);
});

test("the real ADD WOOD line resolves to the right plywood", () => {
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, CATALOG);
  assert.ok(m, "this line should not need a manual pick");
  assert.equal(m.item.itemCode, "PLY-9-48-AB");
  assert.ok(m.score >= MIN_SCORE);
});

test("the second ADD WOOD line resolves to the OTHER plywood", () => {
  // The two plywoods differ by one token — the thickness. Getting this wrong
  // would book 18mm stock against a 9mm receipt.
  const m = matchCatalogItem(`18MM 4' X 8' PLYWOOD`, CATALOG);
  assert.ok(m);
  assert.equal(m.item.itemCode, "PLY-18-48");
});

test("a verbose catalogue entry still matches the supplier's terse line", () => {
  // Our catalogue is usually the WORDIER side. Judged on symmetric overlap
  // alone this pair scores 0.33 and the operator is sent to pick a line the
  // text plainly identifies — which was the original complaint.
  const verbose = [{ itemCode: "PLY-9", description: "PLYWOOD SHEET AB GRADE 9MM 4FT X 8FT" }];
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, verbose);
  assert.ok(m, "extra words in OUR description must not defeat the match");
  assert.equal(m.item.itemCode, "PLY-9");
});

test("a metric catalogue size does not defeat an imperial supplier line", () => {
  const metric = [{ itemCode: "PLY-9", description: "PLYWOOD AB 9MM 1220X2440" }];
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, metric);
  assert.ok(m, "PLYWOOD + AB + 9MM is enough to identify it");
});

test("one shared word alone can never carry a match", () => {
  // Without the shared-token floor, containment would rate a single common
  // word as a perfect match and bind the whole family to one item.
  const family = [{ itemCode: "X-1", description: "PLYWOOD" }];
  assert.equal(
    matchCatalogItem("FOAM SHEET PLYWOOD-FREE", family),
    null,
    "a lone common word must not be treated as identification",
  );
});

test("a vague entry cannot outrank a specific one silently", () => {
  // Both score full marks — one by containment, one by exact overlap — so the
  // line is ambiguous and must go to a human rather than pick the vaguer row.
  const mixed = [
    { itemCode: "VAGUE", description: "PLYWOOD 9MM" },
    { itemCode: "EXACT", description: "PLYWOOD 9MM 4X8 AB" },
  ];
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, mixed);
  assert.equal(m, null, "a tie between a vague and a specific entry must be refused");
});

test("an unrelated line matches nothing rather than the nearest thing", () => {
  assert.equal(matchCatalogItem("DELIVERY CHARGE", CATALOG), null);
  assert.equal(matchCatalogItem("", CATALOG), null);
});

test("two equally good candidates are refused, not coin-flipped", () => {
  const ambiguous = [
    { itemCode: "A-1", description: "PLYWOOD 9MM 4X8" },
    { itemCode: "A-2", description: "PLYWOOD 9MM 4X8" },
  ];
  assert.equal(
    matchCatalogItem("PLYWOOD 9MM 4X8", ambiguous),
    null,
    "an ambiguous line must fall back to a human pick",
  );
});

test("a near-tie is refused too", () => {
  const close = [
    { itemCode: "B-1", description: "FOAM D24 2INCH SHEET" },
    { itemCode: "B-2", description: "FOAM D24 3INCH SHEET" },
  ];
  // "FOAM D24 SHEET" is one token away from BOTH — no basis to choose.
  assert.equal(matchCatalogItem("FOAM D24 SHEET", close), null);
});

test("it also reads a supplier printing our own item code", () => {
  const m = matchCatalogItem("LEG-6-CHR", CATALOG);
  assert.ok(m);
  assert.equal(m.item.itemCode, "LEG-6-CHR");
});

test("an empty catalogue is handled, not thrown at", () => {
  assert.equal(matchCatalogItem("PLYWOOD 9MM", []), null);
});

test("the ADD WOOD line is in fact an EXACT token match", () => {
  // `9MM 4' X 8' PLYWOOD AB` and `PLYWOOD 9MM 4X8 AB` differ only in
  // punctuation and word order, so once tokenised they are the same set.
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, CATALOG);
  assert.equal(m.score, 1, "this line needs no judgement at all");
});

test("thresholds are configurable so the bar can be raised per surface", () => {
  // Three of four tokens land, plus one the catalogue never mentions → 0.75.
  // Enough by default; rejected once the bar goes above it.
  const line = "PLYWOOD 9MM AB ZZTOP";
  const relaxed = matchCatalogItem(line, CATALOG);
  assert.ok(relaxed, "three matching tokens still identify it by default");
  assert.equal(relaxed.item.itemCode, "PLY-9-48-AB");

  assert.equal(
    matchCatalogItem(line, CATALOG, { minScore: 0.8 }),
    null,
    "a stricter bar must actually reject",
  );
});

test("the winner reports how clear it was", () => {
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, CATALOG);
  assert.ok(m.margin > 0, "margin lets the UI show how confident the match was");
  assert.ok(m.score <= 1);
});
