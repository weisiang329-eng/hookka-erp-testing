// order-lookup-match.test.mjs — unit tests for src/lib/order-lookup-match.ts.
//
// The "Copy from Sales / Consignment Order" resolver used exact equality, so a
// bare "2605-001" never matched the stored "SO-2605-001" — operators were
// forced to type our full doc prefix (Wei Siang 2026-07-02: "why must I type
// the full number?"). matchedOrderField is now prefix-tolerant for OUR ids
// while keeping customer PO / SO / reference exact.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const { matchedOrderField } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/order-lookup-match.ts")).href
);

const so = (over = {}) => ({ id: "so-1", companySOId: "SO-2605-001", ...over });
const co = (over = {}) => ({ id: "co-1", companyCOId: "CO-2605-003", ...over });

// --- the reported case ---------------------------------------------------
test("bare number '2605-001' resolves our SO 'SO-2605-001' (the fix)", () => {
  assert.equal(matchedOrderField(so(), "SO", "2605-001"), "our SO");
});

test("full 'SO-2605-001' still resolves", () => {
  assert.equal(matchedOrderField(so(), "SO", "SO-2605-001"), "our SO");
});

test("prefix without dash 'SO2605-001' resolves", () => {
  assert.equal(matchedOrderField(so(), "SO", "SO2605-001"), "our SO");
});

test("bare CO number '2605-003' resolves our CO 'CO-2605-003'", () => {
  assert.equal(matchedOrderField(co(), "CO", "2605-003"), "our CO");
});

// --- normalization -------------------------------------------------------
test("lowercase + surrounding whitespace is normalized", () => {
  assert.equal(matchedOrderField(so(), "SO", "  so-2605-001  "), "our SO");
});

// --- no false positives --------------------------------------------------
test("a partial that is not the full number does NOT match", () => {
  assert.equal(matchedOrderField(so(), "SO", "001"), null);
  assert.equal(matchedOrderField(so(), "SO", "2605"), null);
});

test("empty / whitespace target -> null", () => {
  assert.equal(matchedOrderField(so(), "SO", ""), null);
  assert.equal(matchedOrderField(so(), "SO", "   "), null);
});

test("wrong number -> null", () => {
  assert.equal(matchedOrderField(so(), "SO", "2605-002"), null);
});

// --- customer documents stay EXACT (not prefix-mangled) ------------------
test("customer PO matches exactly", () => {
  assert.equal(
    matchedOrderField(so({ customerPOId: "PO-XYZ-99" }), "SO", "PO-XYZ-99"),
    "customer PO",
  );
});

test("customer SO matches on either customerSO or customerSOId", () => {
  assert.equal(
    matchedOrderField(so({ customerSO: "THEIR-123" }), "SO", "THEIR-123"),
    "customer SO",
  );
  assert.equal(
    matchedOrderField(so({ customerSOId: "THEIR-456" }), "SO", "THEIR-456"),
    "customer SO",
  );
});

test("reference matches exactly for both SO and CO lookups", () => {
  assert.equal(
    matchedOrderField(so({ reference: "REF-7" }), "SO", "REF-7"),
    "reference",
  );
  assert.equal(
    matchedOrderField(co({ reference: "REF-8" }), "CO", "REF-8"),
    "reference",
  );
});

// --- SO priority: our-id wins over the customer fields -------------------
test("our SO id takes precedence over a colliding customer field", () => {
  assert.equal(
    matchedOrderField(so({ customerPOId: "2605-001" }), "SO", "2605-001"),
    "our SO",
  );
});

// --- CO lookup ignores SO-only fields ------------------------------------
test("CO lookup does not match on companySOId or customer PO", () => {
  assert.equal(
    matchedOrderField({ id: "x", companySOId: "SO-2605-001", customerPOId: "P1" }, "CO", "2605-001"),
    null,
  );
});
