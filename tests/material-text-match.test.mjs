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

test("a specific entry beats a vague one that merely fits inside the line", () => {
  // "PLYWOOD 9MM" is contained by the line, so a containment-only reading
  // called this a tie and refused. Weighting by what DISTINGUISHES the
  // candidates settles it properly: 4X8 and AB belong to one row only, and
  // they are exactly the tokens the supplier printed.
  const mixed = [
    { itemCode: "VAGUE", description: "PLYWOOD 9MM" },
    { itemCode: "EXACT", description: "PLYWOOD 9MM 4X8 AB" },
  ];
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, mixed);
  assert.ok(m, "the line names a size — that is enough to choose");
  assert.equal(m.item.itemCode, "EXACT");
  assert.ok(m.margin > 0.2, "and it should win clearly, not by a hair");
});

test("but a line with nothing distinguishing in it is still refused", () => {
  const mixed = [
    { itemCode: "VAGUE", description: "PLYWOOD 9MM" },
    { itemCode: "EXACT", description: "PLYWOOD 9MM 4X8 AB" },
  ];
  assert.equal(
    matchCatalogItem("PLYWOOD 9MM", mixed),
    null,
    "shared words alone must never pick a row",
  );
});

// ── The size is the evidence ────────────────────────────────────────────────
// The supplier always prints it, and it is the only thing separating these
// rows — so it has to outweigh the words every candidate shares.

const SIZES = [
  { itemCode: "PLY-9-48-AB", description: "PLYWOOD 9MM 4X8 AB" },
  { itemCode: "PLY-9-46-AB", description: "PLYWOOD 9MM 4X6 AB" },
  { itemCode: "PLY-9-1224-AB", description: "PLYWOOD 9MM 1220X2440 AB" },
];

test("a stated size picks its board out of near-identical siblings", () => {
  for (const [line, expected] of [
    [`9MM 4' X 8' PLYWOOD AB`, "PLY-9-48-AB"],
    [`9MM 4' X 6' PLYWOOD AB`, "PLY-9-46-AB"],
    ["PLYWOOD 9MM 1220X2440 AB", "PLY-9-1224-AB"],
  ]) {
    const m = matchCatalogItem(line, SIZES);
    assert.ok(m, `${line} should resolve — the size says which board it is`);
    assert.equal(m.item.itemCode, expected);
  }
});

test("shared words cannot outvote the size", () => {
  // PLYWOOD, 9MM and AB appear on every row and carry no information; only the
  // size does. A match must therefore be clear of the runner-up, not marginal.
  const m = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, SIZES);
  assert.ok(m.margin > 0.2, `expected a decisive win, got margin ${m.margin}`);
});

test("no size stated means no basis to choose", () => {
  assert.equal(
    matchCatalogItem("PLYWOOD 9MM AB", SIZES),
    null,
    "without the discriminating token the line is genuinely ambiguous",
  );
});

test("a contradicting size counts against, not merely as absent", () => {
  // One candidate, wrong size. Silence would be "no evidence"; a stated size
  // that disagrees is evidence this is a different board.
  const only48 = [SIZES[0]];
  const wrong = matchCatalogItem(`9MM 4' X 6' PLYWOOD AB`, only48);
  const right = matchCatalogItem(`9MM 4' X 8' PLYWOOD AB`, only48);
  assert.ok(right, "the matching size must still resolve");
  assert.ok(
    !wrong || wrong.score < right.score,
    "a conflicting size must score strictly worse than an agreeing one",
  );
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
