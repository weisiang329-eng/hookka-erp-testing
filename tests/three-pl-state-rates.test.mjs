// ---------------------------------------------------------------------------
// three-pl-state-rates.test.mjs — 3PL per-state rate card (Phase 1).
//
// Two layers, matching the house test styles:
//   1. Unit tests for src/lib/malaysia-states.ts (tsx-loader import, like
//      delivery-pipeline.test.mjs): canonical list shape + resolveStateCode
//      read-side alias resolution.
//   2. Source-level assertions on src/api/routes/three-pl-state-rates.ts
//      (readFileSync + regex, like e2e-happy-path.test.mjs): the PUT /bulk
//      validation gates — RBAC, reject-don't-normalize state validation,
//      non-negative-integer rate validation — stay in place.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

let ms;
try {
  ms = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/malaysia-states.ts")).href
  );
} catch (err) {
  console.warn(
    "[three-pl-state-rates.test] Could not import malaysia-states. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[three-pl-state-rates.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// 1a. MALAYSIA_STATES — canonical list shape.
// ---------------------------------------------------------------------------
test("MALAYSIA_STATES has exactly 16 entries with unique 3-letter codes", () => {
  assert.equal(ms.MALAYSIA_STATES.length, 16);
  const codes = ms.MALAYSIA_STATES.map((s) => s.code);
  assert.equal(new Set(codes).size, 16, "codes must be unique");
  for (const c of codes) {
    assert.match(c, /^[A-Z]{3}$/, `code ${c} must be 3 uppercase letters`);
  }
});

test("MALAYSIA_STATES display order starts KUL, SGR, PNG, JHR", () => {
  assert.deepEqual(
    ms.MALAYSIA_STATES.slice(0, 4).map((s) => s.code),
    ["KUL", "SGR", "PNG", "JHR"],
  );
});

test("isMalaysiaStateCode: exact canonical match only (no case folding)", () => {
  assert.equal(ms.isMalaysiaStateCode("SGR"), true);
  assert.equal(ms.isMalaysiaStateCode("sgr"), false);
  assert.equal(ms.isMalaysiaStateCode("KL"), false, "legacy alias is NOT canonical");
  assert.equal(ms.isMalaysiaStateCode(""), false);
  assert.equal(ms.isMalaysiaStateCode(null), false);
  assert.equal(ms.isMalaysiaStateCode(42), false);
});

// ---------------------------------------------------------------------------
// 1b. resolveStateCode — READ-side resolution of legacy hub shorthand.
// ---------------------------------------------------------------------------
test("resolveStateCode: canonical codes pass through (any casing, trimmed)", () => {
  assert.equal(ms.resolveStateCode("SGR"), "SGR");
  assert.equal(ms.resolveStateCode(" kul "), "KUL");
});

test("resolveStateCode: legacy hub shorthand maps to canonical codes", () => {
  const expectations = {
    KL: "KUL",
    PG: "PNG",
    JB: "JHR",
    SRW: "SWK",
    IPH: "PRK",
    KCH: "SWK",
    KB: "KTN",
    KT: "TRG",
  };
  for (const [legacy, canonical] of Object.entries(expectations)) {
    assert.equal(ms.resolveStateCode(legacy), canonical, `${legacy} -> ${canonical}`);
  }
});

test("resolveStateCode: full labels resolve case-insensitively", () => {
  assert.equal(ms.resolveStateCode("Selangor"), "SGR");
  assert.equal(ms.resolveStateCode("NEGERI SEMBILAN"), "NSN");
  assert.equal(ms.resolveStateCode("kuala lumpur"), "KUL");
});

test("resolveStateCode: unknown / empty input resolves to null, never a guess", () => {
  assert.equal(ms.resolveStateCode("SINGAPORE"), null);
  assert.equal(ms.resolveStateCode("XYZ"), null);
  assert.equal(ms.resolveStateCode(""), null);
  assert.equal(ms.resolveStateCode("   "), null);
  assert.equal(ms.resolveStateCode(null), null);
  assert.equal(ms.resolveStateCode(undefined), null);
});

// ---------------------------------------------------------------------------
// 2. Route source assertions — PUT /bulk validation gates.
// ---------------------------------------------------------------------------
const ROUTE = readFileSync(
  resolve(process.cwd(), "src/api/routes/three-pl-state-rates.ts"),
  "utf8",
);

test("PUT /bulk is registered and RBAC-gated with drivers:update", () => {
  assert.match(ROUTE, /app\.put\(\s*["']\/bulk["']/);
  assert.match(
    ROUTE,
    /requirePermission\s*\(\s*c\s*,\s*["']drivers["']\s*,\s*["']update["']\s*\)/,
    "PUT /bulk must check drivers:update permission",
  );
  assert.match(ROUTE, /if\s*\(\s*denied\s*\)\s*return\s+denied\s*;/);
});

test("PUT /bulk validates states with isMalaysiaStateCode (reject-don't-normalize)", () => {
  assert.match(
    ROUTE,
    /isMalaysiaStateCode\s*\(/,
    "bulk upsert must validate each state against the canonical code list",
  );
  assert.match(
    ROUTE,
    /Unknown state code/,
    "unknown states must be rejected with a 400, not silently normalized",
  );
  assert.ok(
    !/resolveStateCode\s*\(/.test(ROUTE),
    "route must NOT launder input through resolveStateCode on the write path",
  );
});

test("PUT /bulk rejects non-integer / negative rates and duplicate states", () => {
  assert.match(ROUTE, /Number\.isInteger\s*\(\s*trip\s*\)/);
  assert.match(ROUTE, /Number\.isInteger\s*\(\s*drop\s*\)/);
  assert.match(ROUTE, /trip\s*<\s*0/);
  assert.match(ROUTE, /drop\s*<\s*0/);
  assert.match(ROUTE, /Duplicate state in rates/);
});

test("GET seeds lazily with ON CONFLICT DO NOTHING and reads the full card", () => {
  assert.match(ROUTE, /ON CONFLICT \(providerId, state\) DO NOTHING/);
  assert.match(ROUTE, /MALAYSIA_STATES\.map/);
});

// drivers.ts list response stays additive: aggregates present, and the
// 30000/5000 legacy defaults for NEW providers are gone (0/0 = unset).
const DRIVERS = readFileSync(
  resolve(process.cwd(), "src/api/routes/drivers.ts"),
  "utf8",
);

test("drivers list response carries vehicleCount / driverCount / ratedStates", () => {
  assert.match(DRIVERS, /vehicleCount:/);
  assert.match(DRIVERS, /driverCount:/);
  assert.match(DRIVERS, /ratedStates:/);
});

test("new providers default to 0/0 rates (state card is the pricing source)", () => {
  assert.ok(
    !/\|\|\s*30000/.test(DRIVERS),
    "drivers.ts must not default ratePerTripSen to 30000 anymore",
  );
  assert.ok(
    !/\|\|\s*5000/.test(DRIVERS),
    "drivers.ts must not default ratePerExtraDropSen to 5000 anymore",
  );
});
