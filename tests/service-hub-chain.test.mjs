// ---------------------------------------------------------------------------
// service-hub-chain.test.mjs — structural pins for the service-order delivery
// hub chain (2026-06-11, DO-2606-030 root cause).
//
// The chain: source SO/CO --(copied at service-order creation)--> service_
// orders.hubId --(read at DO create / PL-first grouping)--> DO hubId +
// address + state. Legacy service orders predate the column, so the DO side
// falls back to live-deriving the hub from the source order.
//
// These are structural tests (source-text assertions) in the same style as
// pl-first-autosplit.test.mjs: they pin that each link of the chain exists in
// the right file so a refactor can't silently drop one.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const svcSrc = readFileSync(
  new URL("../src/api/routes/service-orders.ts", import.meta.url),
  "utf8",
);
const doSrc =
  readFileSync(
    new URL("../src/api/routes/delivery-orders.ts", import.meta.url),
    "utf8",
  ) +
  "\n\n" +
  readFileSync(
    new URL("../src/api/routes/delivery-orders/_helpers.ts", import.meta.url),
    "utf8",
  );

function count(haystack, regex) {
  return (haystack.match(regex) ?? []).length;
}

test("service order stores hubId at creation (copied from the source order)", () => {
  // Self-applying column so prod works before migration 0158 replays.
  assert.match(
    svcSrc,
    /ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS hubId TEXT/,
    "service-orders.ts must self-apply the hubId column",
  );
  // The INSERT persists it.
  assert.match(
    svcSrc,
    /sourceNo, customerId, customerName, hubId, mode, status,/,
    "INSERT INTO service_orders must include hubId",
  );
  assert.match(
    svcSrc,
    /source\.hubId,/,
    "INSERT must bind the source order's hubId",
  );
});

test("loadSourceOrder exposes the hub from BOTH source types (SO + CO)", () => {
  assert.equal(
    count(svcSrc, /customerState, hubId\s*\n\s+FROM (sales_orders|consignment_orders) WHERE id = \?/g),
    2,
    "both source SELECTs must read hubId",
  );
  // EXTERNAL sources have no order to inherit from — hub stays null.
  assert.match(svcSrc, /status: "EXTERNAL",[\s\S]{0,400}?hubId: null,/);
});

test("DO create resolves the hub for service POs via service_orders", () => {
  assert.equal(
    count(doSrc, /async function loadServiceOrderHubMeta\(/g),
    1,
    "loadServiceOrderHubMeta must be defined exactly once",
  );
  // Legacy fallback: live-derive from the source order when the stored hub is
  // missing (rows created before the column existed).
  assert.match(
    doSrc,
    /SELECT id, hubId FROM sales_orders WHERE id IN /,
    "helper must live-derive legacy service hubs from the source SO",
  );
  assert.match(
    doSrc,
    /SELECT id, hubId FROM consignment_orders WHERE id IN /,
    "helper must live-derive legacy service hubs from the source CO",
  );
  // The create core's hub resolution consults it when no SO hub exists.
  assert.match(
    doSrc,
    /let hubTarget = body\.hubId \?\? salesOrderRow\?\.hubId \?\? null;/,
    "hubTarget must stay caller > SO, then fall through to the service hub",
  );
  assert.match(
    doSrc,
    /if \(!hubTarget && poRowsForItems\.length > 0\) \{[\s\S]{0,600}?loadServiceOrderHubMeta\(c\.var\.DB, svcIds\)/,
    "create core must resolve the service hub before defaulting to the customer hub",
  );
});

test("composition guard folds service customer+hub into the same maps", () => {
  assert.match(
    doSrc,
    /SELECT id, poNo, salesOrderId, serviceOrderId FROM production_orders WHERE id IN /,
    "validateDoComposition must read serviceOrderId",
  );
  assert.match(
    doSrc,
    /const svcMeta = await loadServiceOrderHubMeta\(db, svcIds\);/,
    "validateDoComposition must resolve service destinations",
  );
});

test("packing-list-first groups service POs by their service hub", () => {
  assert.match(
    doSrc,
    /const svcHubMeta = await loadServiceOrderHubMeta\(c\.var\.DB, svcIdsForHub\);/,
    "PL-first must load service hub meta",
  );
  assert.match(
    doSrc,
    /hubId: so\?\.hubId \?\? svc\?\.hubId \?\? "",/,
    "groupInputs must fall back SO hub -> service hub",
  );
});

test("migration 0158 exists and is additive", () => {
  const sql = readFileSync(
    new URL("../migrations-postgres/0158_service_orders_hub.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS hub_id TEXT;/);
});
