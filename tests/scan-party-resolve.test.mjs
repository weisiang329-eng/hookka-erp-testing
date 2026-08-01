// ---------------------------------------------------------------------------
// scan-party-resolve.test.mjs — customer + delivery hub resolution for scanned
// customer POs (owner 2026-08-01).
//
// The regression these pin: scan-po-modal displayed the right customer in its
// <select> but never wrote that match back to state, so `po.customerId` stayed
// null. The hub picker was the only consumer reading raw `po.customerId` — it
// saw null, concluded "this customer has no hubs", never rendered its dropdown,
// and fell back to a text badge showing the OCR'd hub name. `deliveryHubId` was
// never set and 9 Houzs Century SOs were created hub-less in one batch while
// the preview looked correct.
//
// Everything now goes through resolveScanParty, so the pickers, the pre-create
// hub gate and the create payload read ONE value.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHubName,
  resolveScanParty,
} from "../src/lib/scan-party-resolve.ts";

const HOUZS = {
  id: "cust-1",
  name: "Houzs Century",
  hubs: [
    { id: "hub-kl", shortName: "Houzs KL", state: "KL" },
    { id: "hub-pg", shortName: "Houzs PG", state: "PG" },
  ],
};
const ALPHA = {
  id: "cust-2",
  name: "Alpha Furniture Sdn Bhd",
  hubs: [{ id: "hub-a1", shortName: "Alpha KL", state: "KL" }],
};
const NO_HUBS = { id: "cust-3", name: "Beta Trading", hubs: [] };
const CUSTOMERS = [HOUZS, ALPHA, NO_HUBS];

test("normalizeHubName uppercases and strips non-alphanumerics", () => {
  assert.equal(normalizeHubName("Houzs KL"), "HOUZSKL");
  assert.equal(normalizeHubName("houzs-kl"), "HOUZSKL");
  assert.equal(normalizeHubName("  HOUZS   KL  "), "HOUZSKL");
  assert.equal(normalizeHubName(null), "");
  assert.equal(normalizeHubName(""), "");
});

// The exact live failure: legal name on the letterhead, hub printed on the doc,
// backend left customerId null, state was "Selangor" (which the old hard-coded
// mapDeliveryHub table could never turn into a hub).
test("THE REGRESSION: legal-suffix name + OCR'd hub → customer AND hub resolve", () => {
  const r = resolveScanParty(CUSTOMERS, {
    customerId: null,
    customerName: "Houzs Century Sdn Bhd",
    deliveryHub: "Houzs KL",
    deliveryHubId: null,
  });
  assert.equal(r.customerId, "cust-1");
  assert.equal(r.hubId, "hub-kl");
  assert.equal(r.hubs.length, 2, "hub dropdown must have options to render");
});

test("hub name alone identifies the customer when the name does not match", () => {
  const r = resolveScanParty(CUSTOMERS, {
    customerId: null,
    customerName: "Totally Unknown Enterprise",
    deliveryHub: "Houzs PG",
  });
  assert.equal(r.customerId, "cust-1");
  assert.equal(r.hubId, "hub-pg");
});

test("an explicit operator pick is never overridden", () => {
  // Operator chose Alpha even though the letterhead reads Houzs.
  const r = resolveScanParty(CUSTOMERS, {
    customerId: "cust-2",
    customerName: "Houzs Century Sdn Bhd",
    deliveryHub: "Houzs KL",
    deliveryHubId: "hub-a1",
  });
  assert.equal(r.customerId, "cust-2");
  assert.equal(r.hubId, "hub-a1");
});

test("explicit customer + OCR hub that is NOT theirs leaves the hub unset", () => {
  // Reject-don't-guess: "Houzs KL" is not one of Alpha's hubs.
  const r = resolveScanParty(CUSTOMERS, {
    customerId: "cust-2",
    deliveryHub: "Houzs KL",
    deliveryHubId: null,
  });
  assert.equal(r.customerId, "cust-2");
  assert.equal(r.hubId, null);
  assert.deepEqual(r.hubs.map((h) => h.id), ["hub-a1"]);
});

test("ambiguous hub name across two customers resolves nothing", () => {
  const twins = [
    { id: "a", name: "A Co", hubs: [{ id: "h1", shortName: "Main", state: null }] },
    { id: "b", name: "B Co", hubs: [{ id: "h2", shortName: "Main", state: null }] },
  ];
  const r = resolveScanParty(twins, {
    customerId: null,
    customerName: "Nobody",
    deliveryHub: "Main",
  });
  assert.equal(r.customerId, null, "must not guess between two companies");
  assert.equal(r.hubId, null);
});

test("hub matching tolerates spacing / case drift from OCR", () => {
  const r = resolveScanParty(CUSTOMERS, {
    customerName: "Houzs Century",
    deliveryHub: "houzs  kl",
  });
  assert.equal(r.hubId, "hub-kl");
});

test("customer with no hubs on file resolves the customer, no hub", () => {
  const r = resolveScanParty(CUSTOMERS, {
    customerName: "Beta Trading",
    deliveryHub: "Beta KL",
  });
  assert.equal(r.customerId, "cust-3");
  assert.equal(r.hubId, null);
  assert.deepEqual(r.hubs, [], "badge fallback path — nothing to pick from");
});

test("no catalog yet (best-effort fetch still in flight) degrades safely", () => {
  for (const empty of [null, undefined, []]) {
    const r = resolveScanParty(empty, {
      customerName: "Houzs Century Sdn Bhd",
      deliveryHub: "Houzs KL",
    });
    assert.equal(r.customerId, null);
    assert.equal(r.hubId, null);
    assert.deepEqual(r.hubs, []);
  }
});

test("an explicit customerId survives an empty catalog", () => {
  const r = resolveScanParty(null, { customerId: "cust-1" });
  assert.equal(r.customerId, "cust-1");
});

test("no hub printed on the document → no hub guessed", () => {
  const r = resolveScanParty(CUSTOMERS, {
    customerName: "Houzs Century Sdn Bhd",
    deliveryHub: null,
  });
  assert.equal(r.customerId, "cust-1");
  assert.equal(r.hubId, null, "never invent a hub the document did not name");
});

// Wiring guard: the three call sites must all go through the resolver, or the
// preview and the created SO can drift apart again.
test("scan-po-modal routes pickers, hub gate and create through the resolver", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/components/scan-po-modal.tsx", "utf8");
  const calls = src.match(/resolveScanParty\(/g) ?? [];
  assert.ok(
    calls.length >= 4,
    `expected the hub gate, create payload, customer picker and hub picker to share the resolver, found ${calls.length} call(s)`,
  );
  assert.match(
    src,
    /value=\{resolved\.hubId \?\? ""\}/,
    "hub <select> must render the resolved hub id, not raw po.deliveryHubId",
  );
  assert.doesNotMatch(
    src,
    /\(c\) => c\.id === po\.customerId,/,
    "hub picker must not read raw po.customerId again (the original defect)",
  );
});
