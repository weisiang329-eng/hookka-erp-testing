// ---------------------------------------------------------------------------
// pl-first-autosplit.test.mjs — the Packing-List-first dispatch flow.
//
// Two layers, mirroring the house pattern (sofa-combo.test.mjs for pure
// helpers + e2e-happy-path.test.mjs for route-surface pins):
//
//   1. UNIT — src/api/lib/pl-first-grouping.ts:
//      groupPosByCustomerHub  (the enforced one-DO-per-customer-per-hub
//      split: deterministic order, blank hub is its own group) and
//      projectCreditFailure   (credit limit summed ACROSS a customer's
//      groups — the property that makes the flow all-or-nothing where the
//      per-DO gate alone would let combined-over-limit selections through).
//
//   2. STRUCTURAL — pin that POST /api/delivery-orders now delegates to the
//      extracted createDeliveryOrderForPOs core (so the new flow and the old
//      button can never drift), that every original guard still exists, that
//      POST /packing-list-first is registered + RBAC-gated + pre-validates
//      BEFORE creating + rolls back created DOs on mid-way failure, and that
//      packing-lists POST / runs through the shared createPackingListCore.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const { groupPosByCustomerHub, projectCreditFailure } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/pl-first-grouping.ts")).href
);

// ═════════════════════════════════════════════════════════════════════════
// 1. groupPosByCustomerHub — the (customerId, hubId) split
// ═════════════════════════════════════════════════════════════════════════

test("grouping: one customer + one hub → one group, PO order preserved", () => {
  const groups = groupPosByCustomerHub([
    { poId: "p1", customerId: "c1", hubId: "h1" },
    { poId: "p2", customerId: "c1", hubId: "h1" },
    { poId: "p3", customerId: "c1", hubId: "h1" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    customerId: "c1",
    hubId: "h1",
    poIds: ["p1", "p2", "p3"],
  });
});

test("grouping: mixed customers and hubs → one group per (customer, hub)", () => {
  const groups = groupPosByCustomerHub([
    { poId: "p1", customerId: "c1", hubId: "h1" },
    { poId: "p2", customerId: "c2", hubId: "h2" },
    { poId: "p3", customerId: "c1", hubId: "h1" }, // back to group 1
    { poId: "p4", customerId: "c1", hubId: "h9" }, // same customer, other hub
    { poId: "p5", customerId: "c2", hubId: "h2" },
  ]);
  assert.equal(groups.length, 3, "c1+h1, c2+h2, c1+h9");
  // First-seen order is the contract — DO numbers are handed out in this
  // order, so it must be deterministic.
  assert.deepEqual(
    groups.map((g) => [g.customerId, g.hubId]),
    [
      ["c1", "h1"],
      ["c2", "h2"],
      ["c1", "h9"],
    ],
  );
  assert.deepEqual(groups[0].poIds, ["p1", "p3"]);
  assert.deepEqual(groups[1].poIds, ["p2", "p5"]);
  assert.deepEqual(groups[2].poIds, ["p4"]);
});

test("grouping: blank hub is its own group (never shares a DO with a hub)", () => {
  const groups = groupPosByCustomerHub([
    { poId: "p1", customerId: "c1", hubId: "h1" },
    { poId: "p2", customerId: "c1", hubId: "" },
  ]);
  assert.equal(groups.length, 2, "hub-less PO must not ride on the h1 DO");
  assert.deepEqual(groups[0].poIds, ["p1"]);
  assert.deepEqual(groups[1].poIds, ["p2"]);
});

test("grouping: empty input → no groups", () => {
  assert.deepEqual(groupPosByCustomerHub([]), []);
});

// ═════════════════════════════════════════════════════════════════════════
// 2. projectCreditFailure — credit summed ACROSS a customer's groups
// ═════════════════════════════════════════════════════════════════════════

const PRICES = [
  { salesOrderId: "so1", productCode: "BED-A", unitPriceSen: 10000 },
  { salesOrderId: "so2", productCode: "BED-B", unitPriceSen: 20000 },
];

function grp(customerId, soIds, items) {
  return { customerId, soIds, items };
}

test("credit: within limit → null (no failure)", () => {
  const fail = projectCreditFailure(
    [grp("c1", ["so1"], [{ productCode: "BED-A", quantity: 2 }])], // 20000
    PRICES,
    [{ id: "c1", creditLimitSen: 100000, outstandingSen: 50000 }], // 70000 <= 100000
  );
  assert.equal(fail, null);
});

test("credit: TWO groups of one customer sum over the limit → failure (each alone would pass the per-DO gate)", () => {
  const groups = [
    grp("c1", ["so1"], [{ productCode: "BED-A", quantity: 3 }]), // 30000
    grp("c1", ["so2"], [{ productCode: "BED-B", quantity: 2 }]), // 40000
  ];
  const customers = [{ id: "c1", creditLimitSen: 100000, outstandingSen: 50000 }];
  // Per-DO gate would pass each: 50000+30000 and 50000+40000 are both <= 100000.
  // The combined projection 50000+70000 = 120000 must fail.
  const fail = projectCreditFailure(groups, PRICES, customers);
  assert.ok(fail, "combined projection must fail");
  assert.equal(fail.customerId, "c1");
  assert.equal(fail.doTotalSen, 70000);
  assert.equal(fail.projectedSen, 120000);
  assert.equal(fail.limitSen, 100000);
  assert.equal(fail.outstandingSen, 50000);
});

test("credit: other customers' groups never pollute the sum", () => {
  const groups = [
    grp("c1", ["so1"], [{ productCode: "BED-A", quantity: 3 }]), // c1: 30000
    grp("c2", ["so2"], [{ productCode: "BED-B", quantity: 9 }]), // c2: 180000
  ];
  const fail = projectCreditFailure(groups, PRICES, [
    { id: "c1", creditLimitSen: 100000, outstandingSen: 50000 }, // 80000 ok
    { id: "c2", creditLimitSen: 0, outstandingSen: 0 }, // no limit configured
  ]);
  assert.equal(fail, null, "c1 within limit; c2 has no limit → unchecked");
});

test("credit: creditLimitSen <= 0 means no limit configured → unchecked", () => {
  const fail = projectCreditFailure(
    [grp("c1", ["so1"], [{ productCode: "BED-A", quantity: 1000 }])],
    PRICES,
    [{ id: "c1", creditLimitSen: 0, outstandingSen: 999999999 }],
  );
  assert.equal(fail, null);
});

test("credit: price resolution is first-wins per productCode within the group's SOs", () => {
  const dupPrices = [
    { salesOrderId: "soX", productCode: "BED-A", unitPriceSen: 11111 },
    { salesOrderId: "soY", productCode: "BED-A", unitPriceSen: 99999 },
  ];
  const fail = projectCreditFailure(
    [grp("c1", ["soX", "soY"], [{ productCode: "BED-A", quantity: 1 }])],
    dupPrices,
    [{ id: "c1", creditLimitSen: 11110, outstandingSen: 0 }],
  );
  assert.ok(fail, "11111 > 11110 must fail");
  assert.equal(fail.doTotalSen, 11111, "first price (11111) wins, not 99999");
});

test("credit: unknown productCode prices as 0 (same as the per-DO gate)", () => {
  const fail = projectCreditFailure(
    [grp("c1", ["so1"], [{ productCode: "NOT-IN-SO", quantity: 5 }])],
    PRICES,
    [{ id: "c1", creditLimitSen: 1, outstandingSen: 0 }],
  );
  assert.equal(fail, null, "0-priced lines project 0 — gate stays silent");
});

test("credit: exactly AT the limit passes (gate is strictly greater-than)", () => {
  const fail = projectCreditFailure(
    [grp("c1", ["so1"], [{ productCode: "BED-A", quantity: 5 }])], // 50000
    PRICES,
    [{ id: "c1", creditLimitSen: 50000, outstandingSen: 0 }],
  );
  assert.equal(fail, null, "projected == limit must pass, mirroring `>` in the per-DO gate");
});

// ═════════════════════════════════════════════════════════════════════════
// 3. STRUCTURAL — the extraction + the new endpoint stay wired
// ═════════════════════════════════════════════════════════════════════════

const root = process.cwd();
const doSrc =
  readFileSync(resolve(root, "src/api/routes/delivery-orders.ts"), "utf8") +
  "\n\n" +
  readFileSync(resolve(root, "src/api/routes/delivery-orders/_helpers.ts"), "utf8");
const plSrc = readFileSync(resolve(root, "src/api/routes/packing-lists.ts"), "utf8");

function count(haystack, regex) {
  return (haystack.match(regex) ?? []).length;
}

test("structural: POST /api/delivery-orders delegates to the extracted core", () => {
  assert.match(
    doSrc,
    /async function createDeliveryOrderForPOs\(/,
    "createDeliveryOrderForPOs core must exist",
  );
  assert.equal(
    count(doSrc, /async function createDeliveryOrderForPOs\(/g),
    1,
    "exactly ONE definition of the core (no duplicated create logic)",
  );
  assert.match(
    doSrc,
    /const result = await createDeliveryOrderForPOs\(c, body\);\s*\n\s*if \(!result\.ok\) return c\.json\(result\.body, result\.status\);\s*\n\s*return c\.json\(\{ success: true, data: result\.created \}, 201\);/,
    "POST / must map the core result 1:1 onto the original responses",
  );
});

test("structural: every original DO-create guard still exists exactly once (inside the core)", () => {
  // Guard messages that must live ONLY in the core — if one of these shows
  // up twice, create logic got duplicated; zero times, a guard was dropped.
  const onceOnly = [
    /A DO can only deliver for one customer — split into separate DOs, one per customer\./g,
    /A DO can only deliver to one hub — split into separate DOs, one per hub\./g,
    /"customerId or salesOrderId is required"/g,
    /error: "Credit limit exceeded",/g,
  ];
  for (const re of onceOnly) {
    assert.equal(count(doSrc, re), 1, `guard ${re} must appear exactly once`);
  }
  // The CO + once-only-delivery guards exist in the core AND as the
  // packing-list-first pre-check (same wording, by design): exactly twice.
  const twice = [
    /Consignment-Order POs cannot be added to a Delivery Order\./g,
    /a PO can only be delivered once/g,
  ];
  for (const re of twice) {
    assert.equal(count(doSrc, re), 2, `guard ${re} must appear in core + pre-check`);
  }
});

test("structural: create AND edit both enforce composition via ONE shared guard", () => {
  // The duplicate / one-customer / one-hub rules now live in a single helper
  // so the create path and the edit / Add-Items path can never drift (root
  // cause of DO-2606-029: a DO mixed two hubs because Add Items on the edit
  // screen bypassed the create-only guards).
  assert.equal(
    count(doSrc, /async function validateDoComposition\(/g),
    1,
    "validateDoComposition must be defined exactly once",
  );
  // Called from BOTH the create core and the edit (PUT) path.
  assert.ok(
    count(doSrc, /await validateDoComposition\(/g) >= 2,
    "validateDoComposition must be called from create + edit (>= 2 call sites)",
  );
  // The edit path scopes the duplicate-delivery check to THIS DO
  // (excludeDoId = id) so a DO's own existing POs don't trip the rule.
  assert.match(
    doSrc,
    /validateDoComposition\(c\.var\.DB, editPoIds, id\)/,
    "PUT /:id must validate the replacement item set, excluding this DO",
  );
});

test("structural: packing-list-first endpoint registered + RBAC-gated", () => {
  assert.match(
    doSrc,
    /app\.post\("\/packing-list-first", async \(c\) => \{\s*\n[^\n]*\n\s*const denied = await requirePermission\(c, "delivery-orders", "create"\);/,
    "POST /packing-list-first must be gated by delivery-orders:create",
  );
});

test("structural: pre-validation + preview run BEFORE any creation; creation is sequential", () => {
  const endpointStart = doSrc.indexOf('app.post("/packing-list-first"');
  assert.ok(endpointStart > 0, "endpoint must exist");
  const endpoint = doSrc.slice(endpointStart);
  const idxCredit = endpoint.indexOf("projectCreditFailure(");
  const idxPreview = endpoint.indexOf("body.preview === true");
  const idxCreate = endpoint.indexOf("await createDeliveryOrderForPOs(");
  const idxPl = endpoint.indexOf("await createPackingListCore(");
  assert.ok(idxCredit > 0 && idxPreview > 0 && idxCreate > 0 && idxPl > 0);
  assert.ok(
    idxCredit < idxCreate,
    "credit pre-validation must run before any DO is created",
  );
  assert.ok(
    idxPreview < idxCreate,
    "preview must short-circuit before any DO is created",
  );
  assert.ok(
    idxCreate < idxPl,
    "the packing list is created only after every DO",
  );
  // Sequential creation: the core is awaited inside a for-loop (genNextDoNo
  // is read-MAX+1 — Promise.all would collide on doNo).
  assert.match(
    endpoint,
    /for \(let gi = 0; gi < groups\.length; gi\+\+\) \{[\s\S]*?await createDeliveryOrderForPOs\(/,
    "DOs must be created sequentially in a loop",
  );
  assert.ok(
    !/Promise\.all\(\s*groups/.test(endpoint),
    "groups must never be created via Promise.all",
  );
});

test("structural: mid-way failure rolls back every created DO (items + header + SO stamp)", () => {
  const endpoint = doSrc.slice(doSrc.indexOf('app.post("/packing-list-first"'));
  assert.match(
    endpoint,
    /const rollbackCreatedDos = async \(\) => \{/,
    "rollback helper must exist",
  );
  assert.match(
    endpoint,
    /DELETE FROM delivery_order_items WHERE deliveryOrderId = \?/,
    "rollback must delete the DO's items",
  );
  assert.match(
    endpoint,
    /DELETE FROM delivery_orders WHERE id = \?/,
    "rollback must delete the DO header",
  );
  assert.match(
    endpoint,
    /UPDATE sales_orders SET hookkaDeliveryOrder = \? WHERE id = \? AND hookkaDeliveryOrder = \?/,
    "rollback must restore the SO stamp only when it still carries our doNo",
  );
  // Every failure path after creation starts must roll back: core throws,
  // core returns !ok, and the packing-list create fails.
  assert.equal(
    count(endpoint, /await rollbackCreatedDos\(\);/g),
    3,
    "rollback on exactly: core throw, core !ok, PL-create failure",
  );
});

test("structural: the core reports committed rows via onCreated BEFORE the re-read/audit", () => {
  const idxBatch = doSrc.indexOf("await c.var.DB.batch(statements);");
  const idxOnCreated = doSrc.indexOf("onCreated?.({ id, doNo, salesOrderId");
  const idxFetch = doSrc.indexOf("const created = await fetchOrderWithItems(c.var.DB, id);");
  assert.ok(idxBatch > 0 && idxOnCreated > 0 && idxFetch > 0);
  assert.ok(
    idxBatch < idxOnCreated && idxOnCreated < idxFetch,
    "onCreated must fire between the INSERT batch and the re-read so rollback can track a row even when later steps throw",
  );
});

test("structural: packing-lists POST / runs through the shared createPackingListCore", () => {
  assert.match(
    plSrc,
    /export async function createPackingListCore\(/,
    "createPackingListCore must be exported for the packing-list-first flow",
  );
  assert.match(
    plSrc,
    /const result = await createPackingListCore\(c, orgId, body\);\s*\n\s*if \(!result\.ok\) return c\.json\(result\.body, result\.status\);\s*\n\s*return c\.json\(\{ success: true, data: result\.data \}, 201\);/,
    "POST /api/packing-lists must map the core result 1:1 onto the original responses",
  );
  // The one-PL-per-DO rule must live exactly once (in the core).
  assert.equal(
    count(plSrc, /already in another packing list/g),
    1,
    "the one-PL-per-DO guard must not be duplicated",
  );
  // delivery-orders.ts must import the core, not re-implement an INSERT.
  assert.match(
    doSrc,
    /import \{ createPackingListCore \} from "\.\/packing-lists";/,
  );
  assert.ok(
    !/INSERT INTO packing_lists/.test(doSrc),
    "delivery-orders.ts must never insert packing lists directly",
  );
});
