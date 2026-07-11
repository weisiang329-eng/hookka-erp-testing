// ---------------------------------------------------------------------------
// company-dimension.test.mjs — Multi-Company Phase 2 defaults & filter rules.
//
// Locks the ADDITIVE guarantees the feature rests on:
//   • an omitted / blank / non-string company on create defaults to HOOKKA
//     (existing docs + non-company-aware callers are unchanged);
//   • the list filter default ("" / null / undefined) = ALL companies, so the
//     default list view hides nothing (byte-identical to before the feature);
//   • codes round-trip UPPERCASE to match organisations.code.
// Pure functions — every branch pinned so a refactor can't silently weaken the
// default-safe behaviour.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let cd;
try {
  cd = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/company-dimension.ts")).href
  );
} catch (err) {
  console.warn(
    "[company-dimension.test] Could not import module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[company-dimension.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// resolveCompanyCode — create/edit write-side normalisation.
// ---------------------------------------------------------------------------
test("resolveCompanyCode: omitted/blank/non-string → HOOKKA default", () => {
  assert.equal(cd.resolveCompanyCode(undefined), "HOOKKA");
  assert.equal(cd.resolveCompanyCode(null), "HOOKKA");
  assert.equal(cd.resolveCompanyCode(""), "HOOKKA");
  assert.equal(cd.resolveCompanyCode("   "), "HOOKKA");
  assert.equal(cd.resolveCompanyCode(123), "HOOKKA");
  assert.equal(cd.resolveCompanyCode({}), "HOOKKA");
  assert.equal(cd.DEFAULT_COMPANY_CODE, "HOOKKA");
});

test("resolveCompanyCode: a real code is trimmed + uppercased", () => {
  assert.equal(cd.resolveCompanyCode("ohana"), "OHANA");
  assert.equal(cd.resolveCompanyCode("  HouzS  "), "HOUZS");
  assert.equal(cd.resolveCompanyCode("HKMFG"), "HKMFG");
});

// ---------------------------------------------------------------------------
// readCompanyCode — read-side dual-key coalesce with HOOKKA fallback.
// ---------------------------------------------------------------------------
test("readCompanyCode: camel wins, then snake, then HOOKKA", () => {
  assert.equal(cd.readCompanyCode("OHANA", "HOUZS"), "OHANA");
  assert.equal(cd.readCompanyCode(null, "HOUZS"), "HOUZS");
  assert.equal(cd.readCompanyCode(undefined, undefined), "HOOKKA");
  assert.equal(cd.readCompanyCode("", ""), "HOOKKA");
  // pre-column row (both null) reads as the default company
  assert.equal(cd.readCompanyCode(), "HOOKKA");
  // lowercase stored value still normalises up
  assert.equal(cd.readCompanyCode("ohana"), "OHANA");
});

// ---------------------------------------------------------------------------
// matchesCompanyFilter — the LIST default must show EVERYTHING.
// ---------------------------------------------------------------------------
test("matchesCompanyFilter: empty filter = ALL companies (nothing hidden)", () => {
  for (const row of ["HOOKKA", "OHANA", "HOUZS", "HKMFG", "", null, undefined]) {
    assert.equal(cd.matchesCompanyFilter(row, ""), true, `row=${row}`);
    assert.equal(cd.matchesCompanyFilter(row, null), true, `row=${row}`);
    assert.equal(cd.matchesCompanyFilter(row, undefined), true, `row=${row}`);
    assert.equal(cd.matchesCompanyFilter(row, "  "), true, `row=${row}`);
  }
});

test("matchesCompanyFilter: a chosen company narrows to that company only", () => {
  assert.equal(cd.matchesCompanyFilter("OHANA", "OHANA"), true);
  assert.equal(cd.matchesCompanyFilter("HOOKKA", "OHANA"), false);
  // case-insensitive on both sides
  assert.equal(cd.matchesCompanyFilter("ohana", "OHANA"), true);
  assert.equal(cd.matchesCompanyFilter("OHANA", "ohana"), true);
});

test("matchesCompanyFilter: unset row counts as HOOKKA when filtering", () => {
  // A pre-column SO (company null) must appear under a HOOKKA filter and NOT
  // under any sister-company filter — this is what keeps historical data on
  // Hookka after the additive rollout.
  assert.equal(cd.matchesCompanyFilter(null, "HOOKKA"), true);
  assert.equal(cd.matchesCompanyFilter(undefined, "HOOKKA"), true);
  assert.equal(cd.matchesCompanyFilter("", "HOOKKA"), true);
  assert.equal(cd.matchesCompanyFilter(null, "OHANA"), false);
});
