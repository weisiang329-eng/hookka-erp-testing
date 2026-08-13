// ---------------------------------------------------------------------------
// pending-delivery-value.test.mjs — the Command Center's PENDING DELIVERY money.
//
// The tile used to build this figure in the BROWSER from four whole-org fetches
// (the ~2,500-PO /api/production-orders?fields=minimal&include=jobCards being
// the killer). On prod that fetch could exceed the 30s global abort in
// src/lib/api-client.ts; the abort left the tile's loading flag stuck ON so
// PENDING DELIVERY spun forever. It now reads ONE server-computed number from
// GET /api/delivery-orders/pending-value.
//
// This is a MONEY path — the owner reads the ringgit off this tile — so the
// move is only safe if the number is provably unchanged. The endpoint does NOT
// re-express the readiness rule in SQL: it sums `valueSen` over the rows the
// SHARED buildReadyPlanning() already produces (which filters with
// poReadyForDelivery and prices each row with the very same
// `poValMap.get(po.id) ?? soLinePrice × qty` expression the tile used).
//
// The tests below therefore run BOTH summations over one dataset and assert
// they agree to the sen, across every branch the parent predicate handles:
//   • a PO already carried on a live DO is excluded
//   • ON_HOLD and CANCELLED are excluded
//   • a COMPLETED ACCESSORY PO with NO upholstery card is INCLUDED
//     (BUG-2026-06-20-001 — 16 sofa-pillow POs were un-shippable)
//   • consignment-sourced POs are excluded (they ship on a CN, not a DO)
//   • the po-value → SO-line-price fallback, INCLUDING that an explicit 0
//     po-value must NOT fall through to the SO price (`??`, not `||`)
// plus a source guard so the heavy client-side derivation cannot creep back.
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
  // Native type-stripping handles it on Node 22+.
}

const dp = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/delivery-pipeline.ts")).href
);

// ---------------------------------------------------------------------------
// The dataset. All money is integer sen (RM × 100) — never a float.
// ---------------------------------------------------------------------------
const UPH_DONE = [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }];

const POS = [
  // READY — plain sofa, upholstery done, not on a DO.
  { id: "p1", poNo: "PO-1", salesOrderId: "so-1", productCode: "SOFA-A", quantity: 1, itemCategory: "SOFA", status: "IN_PRODUCTION", jobCards: UPH_DONE },
  // Still in production — excluded.
  { id: "p2", poNo: "PO-2", salesOrderId: "so-1", productCode: "SOFA-B", quantity: 1, itemCategory: "SOFA", status: "IN_PRODUCTION", jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] },
  // Already on a live DO — excluded (it has been delivered/dispatched).
  { id: "p3", poNo: "PO-3", salesOrderId: "so-1", productCode: "SOFA-C", quantity: 1, itemCategory: "SOFA", status: "COMPLETED", jobCards: UPH_DONE },
  // ON_HOLD — paused work belongs in Outstanding, not Pending Delivery.
  { id: "p4", poNo: "PO-4", salesOrderId: "so-1", productCode: "SOFA-D", quantity: 1, itemCategory: "SOFA", status: "ON_HOLD", jobCards: UPH_DONE },
  // CANCELLED — excluded.
  { id: "p5", poNo: "PO-5", salesOrderId: "so-1", productCode: "SOFA-E", quantity: 1, itemCategory: "SOFA", status: "CANCELLED", jobCards: UPH_DONE },
  // READY — COMPLETED ACCESSORY with NO upholstery card (BUG-2026-06-20-001).
  // Deliberately absent from poValMap so it exercises the SO-price fallback.
  { id: "p6", poNo: "PO-6", salesOrderId: "so-2", productCode: "PILLOW", quantity: 3, itemCategory: "ACCESSORY", status: "COMPLETED", jobCards: [
      { departmentCode: "FAB_CUT", status: "COMPLETED" },
      { departmentCode: "FAB_SEW", status: "COMPLETED" },
      { departmentCode: "PACKING", status: "COMPLETED" },
    ] },
  // Consignment-sourced — ships on a CN, never on a DO. Excluded.
  { id: "p7", poNo: "PO-7", consignmentOrderId: "co-1", productCode: "SOFA-F", quantity: 1, itemCategory: "SOFA", status: "COMPLETED", jobCards: UPH_DONE },
  // READY — BEDFRAME "Headboard Only": the stranded DIVAN card never completes
  // and must be ignored (pickRelevantUphCards), the packed headboard qualifies.
  { id: "p8", poNo: "PO-8", salesOrderId: "so-3", productCode: "BF-A", quantity: 1, itemCategory: "BEDFRAME", specialOrder: "Headboard Only", jobCards: [
      { departmentCode: "UPHOLSTERY", status: "PENDING", wipType: "DIVAN" },
      { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
    ] },
  // READY but unpriced everywhere — contributes 0, still counted as a row.
  { id: "p9", poNo: "PO-9", salesOrderId: "so-9", productCode: "MYSTERY", quantity: 2, itemCategory: "SOFA", status: "IN_PRODUCTION", jobCards: UPH_DONE },
  // READY with an EXPLICIT zero po-value. `??` must keep the 0; a `||` here
  // would silently invent RM 9,999 of revenue from the SO line.
  { id: "p10", poNo: "PO-10", salesOrderId: "so-2", productCode: "FREEBIE", quantity: 1, itemCategory: "SOFA", status: "IN_PRODUCTION", jobCards: UPH_DONE },
];

const LINKED_PO_IDS = new Set(["p3"]);

const PO_VAL_MAP = new Map([
  ["p1", 150000], // RM 1,500.00
  ["p3", 999999],
  ["p4", 888888],
  ["p5", 777777],
  ["p7", 666666],
  ["p8", 220000], // RM 2,200.00
  ["p10", 0], // explicit zero — must stay zero
]);

const SO_PRICE_BY_PRODUCT = new Map([
  ["so-1", new Map([["SOFA-A", 111111]])],
  ["so-2", new Map([["PILLOW", 4500], ["FREEBIE", 999900]])],
  ["so-3", new Map([["BF-A", 333333]])],
]);

// p1 150000 + p6 (4500 × 3 = 13500) + p8 220000 + p9 0 + p10 0
const EXPECTED_SEN = 383500;

// ---------------------------------------------------------------------------
// The OLD client-side derivation, copied VERBATIM from the shape the
// dashboard-b `pendingDeliveryValueSen` useMemo had before this change. This is
// the baseline the new endpoint has to reproduce exactly.
// ---------------------------------------------------------------------------
function legacyClientSum(pos, linkedPOIds, poValMap, soPriceByProduct) {
  let total = 0;
  for (const po of pos) {
    if (!dp.poReadyForDelivery(po, linkedPOIds)) continue;
    total +=
      poValMap.get(po.id) ??
      (soPriceByProduct.get(po.salesOrderId || "")?.get(po.productCode || "") ??
        0) * (po.quantity || 0);
  }
  return total;
}

// The NEW server derivation: Σ valueSen over buildReadyPlanning's ready rows —
// exactly what GET /api/delivery-orders/pending-value returns.
function serverReady() {
  return dp.buildReadyPlanning({
    allPOs: POS,
    linkedPOIds: LINKED_PO_IDS,
    soMap: new Map(),
    soRefMap: new Map(),
    poValMap: PO_VAL_MAP,
    soPriceByProduct: SO_PRICE_BY_PRODUCT,
    productM3Map: new Map(),
  }).ready;
}

function serverSum() {
  let total = 0;
  for (const r of serverReady()) total += r.valueSen || 0;
  return total;
}

// ---------------------------------------------------------------------------
test("pending-value: server sum equals the old client-side sum, to the sen", () => {
  const before = legacyClientSum(
    POS,
    LINKED_PO_IDS,
    PO_VAL_MAP,
    SO_PRICE_BY_PRODUCT,
  );
  assert.equal(before, EXPECTED_SEN);
  assert.equal(serverSum(), before);
});

test("pending-value: the total is an exact integer (sen, never a float)", () => {
  const total = serverSum();
  assert.equal(Number.isInteger(total), true);
  for (const r of serverReady()) assert.equal(Number.isInteger(r.valueSen), true);
});

test("pending-value: a PO already carried on a live DO is excluded", () => {
  const ids = serverReady().map((r) => r.id);
  assert.equal(ids.includes("p3"), false);
  // Removing it from the linked set must pull its RM 9,999.99 back in — proof
  // the exclusion is the linked-PO set doing the work, not an accident.
  const withoutLink = dp.buildReadyPlanning({
    allPOs: POS,
    linkedPOIds: new Set(),
    soMap: new Map(),
    soRefMap: new Map(),
    poValMap: PO_VAL_MAP,
    soPriceByProduct: SO_PRICE_BY_PRODUCT,
    productM3Map: new Map(),
  }).ready.reduce((a, r) => a + r.valueSen, 0);
  assert.equal(withoutLink, EXPECTED_SEN + 999999);
});

test("pending-value: ON_HOLD and CANCELLED POs are excluded", () => {
  const ids = serverReady().map((r) => r.id);
  assert.equal(ids.includes("p4"), false); // ON_HOLD
  assert.equal(ids.includes("p5"), false); // CANCELLED
});

test("pending-value: consignment-sourced POs are excluded (they ship on a CN)", () => {
  assert.equal(serverReady().some((r) => r.id === "p7"), false);
});

test("pending-value: COMPLETED ACCESSORY with no UPHOLSTERY card is INCLUDED", () => {
  // BUG-2026-06-20-001: pillows/cushions run FAB_CUT -> FAB_SEW -> PACKING and
  // never get an upholstery card; they were COMPLETED yet permanently stuck
  // out of Pending Delivery. Included here, priced off the SO line.
  const row = serverReady().find((r) => r.id === "p6");
  assert.ok(row, "COMPLETED accessory PO must be in the ready set");
  assert.equal(row.valueSen, 4500 * 3);
});

test("pending-value: an accessory still in production stays excluded", () => {
  const halfMade = {
    id: "px", poNo: "PO-X", salesOrderId: "so-2", productCode: "PILLOW",
    quantity: 3, itemCategory: "ACCESSORY", status: "IN_PRODUCTION",
    jobCards: [
      { departmentCode: "FAB_CUT", status: "COMPLETED" },
      { departmentCode: "PACKING", status: "PENDING" },
    ],
  };
  const ready = dp.buildReadyPlanning({
    allPOs: [halfMade],
    linkedPOIds: new Set(),
    soMap: new Map(),
    soRefMap: new Map(),
    poValMap: new Map(),
    soPriceByProduct: SO_PRICE_BY_PRODUCT,
    productM3Map: new Map(),
  }).ready;
  assert.equal(ready.length, 0);
});

test("pending-value: po-value wins; the SO line price is only a fallback", () => {
  const rows = new Map(serverReady().map((r) => [r.id, r]));
  // p1 has BOTH a po-value (150000) and an SO price (111111) — po-value wins.
  assert.equal(rows.get("p1").valueSen, 150000);
  // p6 has NO po-value entry → falls back to SO line price × qty.
  assert.equal(rows.get("p6").valueSen, 13500);
  // p9 has neither → 0, and is still a ready ROW (count vs money differ).
  assert.equal(rows.get("p9").valueSen, 0);
});

test("pending-value: an explicit ZERO po-value does NOT fall through to the SO price", () => {
  // `??` not `||`. p10's po-value is 0 while its SO line says RM 9,999 — a
  // `||` here would fabricate revenue on every genuinely free-of-charge line.
  assert.equal(serverReady().find((r) => r.id === "p10").valueSen, 0);
});

test("pending-value: readyCount matches the number of rows summed", () => {
  const ready = serverReady();
  assert.deepEqual(
    ready.map((r) => r.id).sort(),
    ["p1", "p10", "p6", "p8", "p9"],
  );
  assert.equal(ready.length, 5);
});

// ---------------------------------------------------------------------------
// Source guards — the whole point of the change is that the browser stops
// downloading the dataset to count it, and that the server never re-expresses
// the readiness rule. Both are easy to undo by accident.
// ---------------------------------------------------------------------------
test("source guard: /pending-value sums the SHARED ready rows, no SQL of its own", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/api/routes/delivery-orders.ts"),
    "utf8",
  );
  const handler = src.slice(src.indexOf('app.get("/pending-value"'));
  const body = handler.slice(0, handler.indexOf("\n});") + 4);
  assert.match(body, /loadDeliveryReadyPlanning\(c\)/);
  assert.match(body, /pendingDeliveryValueSen/);
  // No hand-rolled readiness SQL / predicate inside the handler.
  assert.equal(/SELECT /i.test(body), false);
  assert.equal(/UPHOLSTERY/.test(body), false);
});

test("source guard: the dashboard tile no longer pulls the whole PO dataset", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/pages/dashboard-b/index.tsx"),
    "utf8",
  );
  // The megabyte fetch and the client-side predicate are gone; only the comment
  // explaining WHY may still name them, so assert on the CODE forms.
  assert.equal(src.includes('useCachedJson<POResp>'), false);
  assert.equal(/poReadyForDelivery\(/.test(src), false);
  assert.equal(src.includes('"/api/delivery-orders/po-values"'), false);
  assert.equal(src.includes('"/api/sales-orders?fields=price-index"'), false);
  assert.match(src, /"\/api\/delivery-orders\/pending-value"/);
});

test("source guard: the MOBILE Home reads the same one number, not the ready LIST", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/pages/m/screens/Home.tsx"),
    "utf8",
  );
  // BUG-2026-08-13-011. The phone had already stopped deriving the figure from
  // /api/production-orders, but it still downloaded the whole
  // {ready[], planning[]} row set from /ready-planning purely to reduce
  // Sum(ready[].valueSen) — the factory floor is on phones and worse links, so
  // it carries MORE of the 30s-abort risk than the desktop did, not less.
  assert.equal(src.includes('"/api/delivery-orders/ready-planning"'), false);
  assert.match(src, /"\/api\/delivery-orders\/pending-value"/);
  // The number must still MEAN the same thing: server ready-sum PLUS the
  // dispatch chain, exactly as the desktop KTile folds it.
  assert.match(src, /pendingDeliveryValueSen/);
  assert.match(src, /v\.DRAFT \?\? 0/);
  assert.match(src, /v\.LOADED \?\? 0/);
  assert.match(src, /v\.IN_TRANSIT \?\? 0/);
  // And no client-side re-summation of a row list may creep back.
  assert.equal(/ready\s*\?\?\s*\[\]/.test(src), false);
});
