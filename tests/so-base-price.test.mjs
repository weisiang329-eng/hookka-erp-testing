// SO line base-price precedence (src/lib/so-base-price.ts).
//
// Owner ruling: customer-specific price is authoritative. The bug was that it
// only applied when the client sent base=0, so a UI branch (or scan path)
// sending the product default silently billed the wrong price. These pin the
// precedence: customer > incoming/manual > product default.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/so-base-price.ts")).href
);
const r = (o) => m.resolveSoBasePriceSen(o);
const Z = { incomingSen: 0, customerSeatSen: null, customerBaseSen: null, productSeatSen: null, productBaseSen: 0 };

test("customer price wins over a non-zero incoming (the exact bug)", () => {
  // UI sent the product default 30500; customer price is 28000 → customer wins.
  assert.equal(r({ ...Z, incomingSen: 30500, customerBaseSen: 28000, productBaseSen: 30500 }), 28000);
});

test("customer SEAT price beats customer flat base and everything else", () => {
  assert.equal(r({ ...Z, incomingSen: 99999, customerSeatSen: 26000, customerBaseSen: 28000, productBaseSen: 30500 }), 26000);
});

test("no customer price → honour the manual/incoming price", () => {
  assert.equal(r({ ...Z, incomingSen: 32000, productBaseSen: 30500 }), 32000);
});

test("no customer price and nothing supplied → product default (seat first)", () => {
  assert.equal(r({ ...Z, productSeatSen: 31000, productBaseSen: 30500 }), 31000);
  assert.equal(r({ ...Z, productBaseSen: 30500 }), 30500);
});

test("zero/negative customer prices are ignored, not treated as free", () => {
  assert.equal(r({ ...Z, incomingSen: 30500, customerBaseSen: 0, productBaseSen: 30500 }), 30500);
  assert.equal(r({ ...Z, incomingSen: 30500, customerSeatSen: 0, customerBaseSen: 0, productBaseSen: 30500 }), 30500);
});

test("all-empty line is 0, never NaN", () => {
  assert.equal(r(Z), 0);
});
