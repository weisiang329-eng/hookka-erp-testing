// ---------------------------------------------------------------------------
// packing-card-resolve.test.mjs — the tolerant PACKING-card narrowing helper
// (src/api/lib/packing-card-resolve.ts).
//
// Locks the NON-BREAKING contract: single-compartment POs resolve byte-identical
// to the old sole-card fallback; the historical substring tier stays the final
// fallback; the new exact / word-token tiers only run earlier and only rescue
// cases the substring tier fails today — and an ambiguous match NEVER returns a
// wrong card (it returns null instead).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const { pickPackingCard } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/packing-card-resolve.ts"))
    .href,
);

const card = (id, wipLabel, status = "PENDING") => ({ id, wipLabel, status });

// ── single-compartment (UNCHANGED) ──────────────────────────────────────────
test("single card returns it regardless of label", () => {
  const c = card("jc1", '8" Divan- 6FT Frame');
  assert.equal(pickPackingCard([c], "DIVAN")?.id, "jc1");
  // Even a non-matching / empty label still returns the sole card (old fallback).
  assert.equal(pickPackingCard([c], "WHATEVER")?.id, "jc1");
  assert.equal(pickPackingCard([c], "")?.id, "jc1");
});

test("empty list returns null", () => {
  assert.equal(pickPackingCard([], "DIVAN"), null);
});

// ── two distinct labels HB vs Divan (each resolves) ─────────────────────────
test("HB vs Divan — each box label resolves to its own card", () => {
  const cards = [
    card("jc-hb", "Headboard 6FT"),
    card("jc-divan", '8" Divan- 6FT Frame'),
  ];
  assert.equal(pickPackingCard(cards, "HB"), null); // 'HB' is not a substring of either label
  assert.equal(pickPackingCard(cards, "HEADBOARD")?.id, "jc-hb");
  assert.equal(pickPackingCard(cards, "DIVAN")?.id, "jc-divan");
});

test("two distinct labels both resolve via substring (historical behaviour)", () => {
  const cards = [card("jc-hb", "HB FRAME"), card("jc-dv", "DIVAN FRAME")];
  assert.equal(pickPackingCard(cards, "HB")?.id, "jc-hb");
  assert.equal(pickPackingCard(cards, "DIVAN")?.id, "jc-dv");
});

// ── collision: substring tier would be ambiguous; exact/word tier resolves ──
test("collision 'Divan 5FT' vs 'Headboard Divan Frame' with pn=DIVAN", () => {
  // Both wipLabels CONTAIN "DIVAN" as a substring → the old substring-only
  // narrowing returned 2 matches → skipped (null). The word-token tier still
  // sees "DIVAN" as a standalone token in BOTH, so it is ALSO ambiguous → null.
  // Critical guarantee: it must NEVER return the wrong card. null is correct.
  const cards = [
    card("jc-a", "Divan 5FT"),
    card("jc-b", "Headboard Divan Frame"),
  ];
  const got = pickPackingCard(cards, "DIVAN");
  assert.equal(got, null, "ambiguous DIVAN must resolve to null, never a wrong card");
});

test("exact tier rescues a collision the substring tier cannot", () => {
  // Box label "DIVAN" — one card is EXACTLY "DIVAN", the other merely contains
  // it. Substring-only = 2 matches = ambiguous/null today. Exact tier picks the
  // precise one. This is a NEW rescue, never a regression.
  const cards = [
    card("jc-exact", "DIVAN"),
    card("jc-loose", "Headboard Divan Frame"),
  ];
  assert.equal(pickPackingCard(cards, "DIVAN")?.id, "jc-exact");
});

test("ambiguous EXACT tier returns null (never falls through to looser tier)", () => {
  // Two cards EXACTLY equal to the label, both open → genuinely ambiguous.
  const cards = [card("jc-1", "DIVAN"), card("jc-2", "DIVAN")];
  assert.equal(pickPackingCard(cards, "DIVAN"), null);
});

// ── open vs completed: prefer the OPEN card ─────────────────────────────────
test("one OPEN + one COMPLETED with same label → picks OPEN", () => {
  const cards = [
    card("jc-done", "DIVAN", "COMPLETED"),
    card("jc-open", "DIVAN", "PENDING"),
  ];
  assert.equal(pickPackingCard(cards, "DIVAN")?.id, "jc-open");
});

test("TRANSFERRED counts as not-open; picks the remaining open card", () => {
  const cards = [
    card("jc-xfer", "DIVAN", "TRANSFERRED"),
    card("jc-open", "DIVAN", "IN_PROGRESS"),
  ];
  assert.equal(pickPackingCard(cards, "DIVAN")?.id, "jc-open");
});

test("both COMPLETED with same exact label → ambiguous → null", () => {
  const cards = [
    card("jc-1", "DIVAN", "COMPLETED"),
    card("jc-2", "DIVAN", "COMPLETED"),
  ];
  assert.equal(pickPackingCard(cards, "DIVAN"), null);
});

// ── no label on a multi-card PO → null (matches today) ──────────────────────
test("multi-card PO with no box label resolves to null", () => {
  const cards = [card("jc-hb", "HB FRAME"), card("jc-dv", "DIVAN FRAME")];
  assert.equal(pickPackingCard(cards, ""), null);
  assert.equal(pickPackingCard(cards, "   "), null);
});

// ── substring still the final fallback ──────────────────────────────────────
test("substring fallback resolves when no exact/word-token match", () => {
  // Label "6FT" is a substring of one card only — neither exact nor a clean
  // word token (it is glued inside "DIVAN-6FT"), so the substring tier rescues.
  const cards = [card("jc-a", "DIVAN-6FT"), card("jc-b", "HEADBOARD 5FT")];
  assert.equal(pickPackingCard(cards, "6FT")?.id, "jc-a");
});
