import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompanyName,
  matchByCompanyName,
} from "../src/lib/company-name-match.ts";

// BUG-2026-07-01: scanned customer POs print the full legal name
// ("Houzs Century Sdn Bhd") but the catalog stores the short form
// ("Houzs Century"). Exact matching hard-blocked SO create. These tests pin the
// tolerant match: ignore Sdn Bhd / punctuation / spacing, stay unique-guarded.

test("normalizeCompanyName strips legal suffix + formatting", () => {
  assert.equal(normalizeCompanyName("Houzs Century Sdn Bhd"), "HOUZSCENTURY");
  assert.equal(normalizeCompanyName("Houzs Century"), "HOUZSCENTURY");
  assert.equal(normalizeCompanyName("HOUZS CENTURY SDN. BHD."), "HOUZSCENTURY");
  assert.equal(normalizeCompanyName("Houzs  Century  Berhad"), "HOUZSCENTURY");
  assert.equal(normalizeCompanyName("  houzs-century  "), "HOUZSCENTURY");
});

test("normalizeCompanyName handles null/empty", () => {
  assert.equal(normalizeCompanyName(null), "");
  assert.equal(normalizeCompanyName(undefined), "");
  assert.equal(normalizeCompanyName("   "), "");
});

test("matchByCompanyName resolves the Houzs regression", () => {
  const custs = [
    { id: "cust-1", name: "Houzs Century" },
    { id: "cust-2", name: "Alpha Furniture Sdn Bhd" },
  ];
  assert.equal(
    matchByCompanyName(custs, "Houzs Century Sdn Bhd")?.id,
    "cust-1",
  );
  assert.equal(matchByCompanyName(custs, "ALPHA FURNITURE")?.id, "cust-2");
});

test("matchByCompanyName does NOT strip distinguishing trade words", () => {
  const custs = [
    { id: "a", name: "Best Enterprise" },
    { id: "b", name: "Best Trading" },
  ];
  // Different companies stay different — trade descriptors are NOT stripped.
  assert.equal(matchByCompanyName(custs, "Best Enterprise Sdn Bhd")?.id, "a");
  assert.equal(matchByCompanyName(custs, "Best Trading Sdn Bhd")?.id, "b");
});

test("matchByCompanyName returns null when ambiguous (never guesses)", () => {
  const custs = [
    { id: "x", name: "ABC Sdn Bhd" },
    { id: "y", name: "ABC Berhad" }, // both normalize to "ABC"
  ];
  assert.equal(matchByCompanyName(custs, "ABC"), null);
});

test("matchByCompanyName returns null on no match / empty input", () => {
  const custs = [{ id: "a", name: "Houzs Century" }];
  assert.equal(matchByCompanyName(custs, "Totally Different Co"), null);
  assert.equal(matchByCompanyName(custs, ""), null);
  assert.equal(matchByCompanyName(custs, null), null);
});
