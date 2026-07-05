// ---------------------------------------------------------------------------
// do-rate-hasrate-guard.test.mjs — DO create-path 0/0 rate guard.
//
// Regression guard for the latent DO-write bug BUG-2026-06-25 flagged as
// "untouched": in delivery-orders.ts the POST create path resolved
// deliveryCostSen with vehicle-over-provider precedence, but a rate-LESS
// vehicle (rates never keyed in 3PL Maintenance → 0/0) used to "win"
// unconditionally and silently persist deliveryCostSen = 0, masking the
// provider's real rate. The packing-lists.ts money path already treats 0/0
// as UNSET (hasRate fall-through vehicle→provider). This test asserts the DO
// create path now mirrors that: a 0/0 pair is UNSET (not free) and a rate-less
// vehicle falls through to the provider's keyed rate.
//
// House style: source-level assertions (readFileSync + regex), matching
// three-pl-state-rates.test.mjs / e2e-happy-path.test.mjs — the logic lives
// inline in the route handler and is not separately importable. We also verify
// the packing-lists.ts hasRate helper it mirrors is still present, so the two
// paths can't drift back apart silently.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DO = readFileSync(
  resolve(process.cwd(), "src/api/routes/delivery-orders.ts"),
  "utf8",
);
const PL = readFileSync(
  resolve(process.cwd(), "src/api/routes/packing-lists.ts"),
  "utf8",
);

test("DO create path defines a hasRatePair 0/0 guard", () => {
  assert.match(
    DO,
    /const\s+hasRatePair\s*=/,
    "delivery-orders.ts must define a hasRatePair guard (0/0 = unset, not free)",
  );
  // Guard treats a pair as SET only when trip>0 OR extra-drop>0.
  assert.match(
    DO,
    /hasRatePair\s*=\s*\(trip:\s*number,\s*drop:\s*number\)\s*:\s*boolean\s*=>/,
  );
});

test("DO vehicle rate only overrides when the vehicle actually has a rate", () => {
  // The vehicle cost branch must be gated on hasRatePair(vehicle...).
  assert.match(
    DO,
    /hasRatePair\(\s*vehicle\.ratePerTripSen\s*,\s*vehicle\.ratePerExtraDropSen\s*\)/,
    "vehicle rate must only win when the vehicle has a keyed (non 0/0) rate",
  );
});

test("DO rate-less vehicle falls through to the provider's staged rate", () => {
  // A provider-derived fallback is staged, and used when the vehicle is 0/0.
  assert.match(
    DO,
    /providerRateCostSen\s*:\s*number\s*\|\s*null/,
    "a provider-rate fallback must be staged for the fall-through",
  );
  assert.match(
    DO,
    /hasRatePair\(\s*provider\.ratePerTripSen\s*,\s*provider\.ratePerExtraDropSen\s*\)/,
    "provider fallback must only be staged when the provider has a keyed rate",
  );
  assert.match(
    DO,
    /resolvedDeliveryCostSen\s*=\s*providerRateCostSen/,
    "rate-less vehicle must fall through to the provider's rate, not RM 0",
  );
});

test("DO guard is additive — explicit deliveryCostSen still wins", () => {
  // Both rate branches stay gated on `!body.deliveryCostSen`, so an operator
  // who typed a cost (including a legitimate 0) is never overwritten.
  assert.match(DO, /if\s*\(\s*!body\.deliveryCostSen\s*\)/);
});

test("packing-lists.ts hasRate fall-through (the mirrored source) is intact", () => {
  assert.match(
    PL,
    /const\s+hasRate\s*=\s*\(r:\s*RatePair\)\s*:\s*boolean\s*=>/,
    "the PL money path hasRate helper the DO path mirrors must still exist",
  );
  assert.match(
    PL,
    /r\.ratePerTripSen\s*>\s*0\s*\|\|\s*r\.ratePerExtraDropSen\s*>\s*0/,
  );
});
