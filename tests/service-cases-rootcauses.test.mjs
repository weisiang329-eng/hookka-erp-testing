// ---------------------------------------------------------------------------
// service-cases-rootcauses.test.mjs — multi root cause on Service Cases (0169).
//
// A case can have several root causes (owner 2026-06-12). The backend stores
// them as a JSON array on the runtime-added lowercase column
// service_cases.rootcauses, mirrors the FIRST entry into the legacy
// root_cause_category / root_cause_details columns (so the list "Category"
// column + any legacy reader keep working), and synthesizes the array from the
// legacy columns on GET for old single-category cases.
//
// Part 1: unit tests for the two pure helpers exported from the route module —
//   sanitizeRootCauses (PUT) and synthesizeRootCauses (GET).
// Part 2: structural pins (source-text assertions, same style as
//   repair-scope.test.mjs / service-hub-chain.test.mjs) — the migration file
//   exists, the runtime ensure block self-applies the lowercase column, the
//   PUT mirrors entries[0] into the legacy columns + binds rootcauses, and
//   rowToApi returns the synthesized array.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const ROUTE_PATH = resolve(process.cwd(), "src/api/routes/service-cases.ts");
const route = await import(pathToFileURL(ROUTE_PATH).href);
const { sanitizeRootCauses, synthesizeRootCauses } = route;

const ROUTE_SRC = readFileSync(ROUTE_PATH, "utf8");

// ===========================================================================
// Part 1 — sanitizeRootCauses (PUT input sanitizer)
// ===========================================================================

test("sanitizeRootCauses: keeps only valid categories, drops the rest", () => {
  const out = sanitizeRootCauses([
    { category: "DESIGN", details: { suggestedFix: "wider" } },
    { category: "BOGUS", details: {} },
    { category: "MATERIAL", details: { supplierName: "ACME" } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.category), ["DESIGN", "MATERIAL"]);
  assert.deepEqual(out[0].details, { suggestedFix: "wider" });
  assert.deepEqual(out[1].details, { supplierName: "ACME" });
});

test("sanitizeRootCauses: order is preserved (entries[0] is the mirror source)", () => {
  const out = sanitizeRootCauses([
    { category: "TRANSPORT", details: {} },
    { category: "DESIGN", details: {} },
  ]);
  assert.equal(out[0].category, "TRANSPORT");
});

test("sanitizeRootCauses: non-object / array details coerce to {}", () => {
  const out = sanitizeRootCauses([
    { category: "PRODUCTION", details: "oops" },
    { category: "PROCESS", details: ["a"] },
    { category: "SALES", details: null },
    { category: "PICKING" },
  ]);
  assert.equal(out.length, 4);
  for (const e of out) assert.deepEqual(e.details, {});
});

test("sanitizeRootCauses: entries missing / non-string category are dropped", () => {
  const out = sanitizeRootCauses([
    { details: {} },
    { category: 5, details: {} },
    null,
    "PRODUCTION",
    ["DESIGN"],
    { category: "OTHER", details: {} },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "OTHER");
});

test("sanitizeRootCauses: non-array input → []", () => {
  assert.deepEqual(sanitizeRootCauses(undefined), []);
  assert.deepEqual(sanitizeRootCauses(null), []);
  assert.deepEqual(sanitizeRootCauses("DESIGN"), []);
  assert.deepEqual(sanitizeRootCauses({ category: "DESIGN" }), []);
});

test("sanitizeRootCauses: caps the array at 12 entries", () => {
  const many = Array.from({ length: 30 }, () => ({ category: "OTHER", details: {} }));
  const out = sanitizeRootCauses(many);
  assert.equal(out.length, 12);
});

test("sanitizeRootCauses: accepts all 9 valid categories", () => {
  const cats = [
    "PRODUCTION", "DESIGN", "MATERIAL", "PROCESS",
    "CUSTOMER", "TRANSPORT", "SALES", "PICKING", "OTHER",
  ];
  const out = sanitizeRootCauses(cats.map((category) => ({ category, details: {} })));
  assert.deepEqual(out.map((e) => e.category), cats);
});

// ===========================================================================
// Part 2 — synthesizeRootCauses (GET reader)
// ===========================================================================

test("synthesizeRootCauses: parses a stored JSON array", () => {
  const stored = JSON.stringify([
    { category: "DESIGN", details: { x: 1 } },
    { category: "MATERIAL", details: {} },
  ]);
  const out = synthesizeRootCauses(stored, null, {});
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.category), ["DESIGN", "MATERIAL"]);
  assert.deepEqual(out[0].details, { x: 1 });
});

test("synthesizeRootCauses: stored array is re-sanitized (junk category dropped)", () => {
  const stored = JSON.stringify([
    { category: "DESIGN", details: {} },
    { category: "JUNK", details: {} },
  ]);
  const out = synthesizeRootCauses(stored, null, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "DESIGN");
});

test("synthesizeRootCauses: empty/missing column + legacy category → one synthesized block", () => {
  const legacyDetails = { departmentName: "Framing" };
  for (const raw of [null, undefined, "", "[]"]) {
    const out = synthesizeRootCauses(raw, "PRODUCTION", legacyDetails);
    assert.equal(out.length, 1, `raw=${JSON.stringify(raw)}`);
    assert.equal(out[0].category, "PRODUCTION");
    assert.deepEqual(out[0].details, legacyDetails);
  }
});

test("synthesizeRootCauses: stored array WINS over the legacy single column", () => {
  const stored = JSON.stringify([{ category: "TRANSPORT", details: {} }]);
  const out = synthesizeRootCauses(stored, "PRODUCTION", { dept: "x" });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "TRANSPORT");
});

test("synthesizeRootCauses: malformed JSON falls back to legacy synthesis", () => {
  const out = synthesizeRootCauses("{not json", "MATERIAL", { supplierName: "ACME" });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "MATERIAL");
});

test("synthesizeRootCauses: nothing stored + no legacy category → []", () => {
  assert.deepEqual(synthesizeRootCauses(null, null, {}), []);
  assert.deepEqual(synthesizeRootCauses("[]", null, {}), []);
  // An invalid legacy category is also dropped (not surfaced as a block).
  assert.deepEqual(synthesizeRootCauses(null, "JUNK", {}), []);
});

// ===========================================================================
// Part 3 — structural pins (guard the wiring against drift)
// ===========================================================================

test("migration 0169 exists and adds the lowercase rootcauses column", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "migrations-postgres/0169_service_cases_rootcauses.sql"),
    "utf8",
  );
  assert.match(
    sql,
    /ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS rootcauses TEXT/,
  );
});

test("runtime ensure block self-applies the lowercase rootcauses column", () => {
  // The same ALTER ... IF NOT EXISTS runs at runtime so a tool apply is a
  // no-op (adapter rule). Must live inside ensureCaseLinkColumns.
  assert.match(
    ROUTE_SRC,
    /ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS rootcauses TEXT/,
  );
});

test("PUT mirrors entries[0] into the legacy columns + binds rootcauses", () => {
  // entries[0] drives the legacy category + details mirror.
  assert.match(ROUTE_SRC, /rcNext = first \? first\.category : null/);
  assert.match(ROUTE_SRC, /rcDetailsJson = first \? JSON\.stringify\(first\.details\) : null/);
  // The UPDATE writes the rootcauses column.
  assert.match(ROUTE_SRC, /rootcauses = \?/);
});

test("rowToApi returns the synthesized rootCauses array (dual-key read)", () => {
  assert.match(ROUTE_SRC, /row\.rootCauses \?\? row\.rootcauses/);
  assert.match(ROUTE_SRC, /rootCauses,/);
});
