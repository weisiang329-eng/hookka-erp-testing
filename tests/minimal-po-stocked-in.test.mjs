// ---------------------------------------------------------------------------
// minimal-po-stocked-in.test.mjs — BUG-2026-08-13-050.
//
// `?fields=minimal` is the shape src/pages/warehouse.tsx asks for
// (`/api/production-orders?fields=minimal&include=`, warehouse.tsx:241) and the
// Stock-In dropdown it feeds is built by
//
//     productionOrders.filter(po => po.status === "COMPLETED" && !po.stockedIn)
//                                                                ^^^^^^^^^^^^^
// (warehouse.tsx:609-611). While `rowToMinimalPO` dropped that key the read was
// `undefined`, so `!po.stockedIn` was TRUE for every completed order — an order
// already on a rack stayed selectable, and picking it POSTed a second
// `/api/warehouse` rack assignment AND a second `/api/warehouse/movements`
// STOCK_IN for stock that only moved once. Inventory movements that never
// happened; nothing errors, nothing is red.
//
// The key was on the payload until b7d00c78 (2026-05-23) switched the page from
// the bare `/api/production-orders` (full `rowToPO`, which has always emitted
// `stockedIn`) to the minimal variant — that commit's per-consumer audit looked
// for `.jobCards` only. So this test pins two things:
//
//   1. FIELD COVERAGE + OUTPUT IDENTITY — `rowToMinimalPO` must emit exactly the
//      key set it emitted before, plus `stockedIn`, and every shared key must
//      carry byte-identical values to `rowToPO`'s. That is the "same rows, same
//      values, plus the new field" proof: a future slim-down that drops any of
//      them fails here rather than blanking a column in production.
//   2. THE 0/1 CAST — `production_orders.stocked_in` is INTEGER, not one of the
//      ten real BOOLEAN columns (tests/db-boolean-columns.json), so the value
//      arriving from the driver is a number. Both projections must expose it as
//      a JS boolean or `!po.stockedIn` reads a truthy `0`… wait, `0` is falsy —
//      but `"0"` from a TEXT-ish path is not, which is exactly why the cast is
//      asserted rather than assumed.
//
// Deliberately NOT asserted: that `stockedIn` means "on a rack". It has two
// writers with different intents — the warehouse PUT (operator stocked it in,
// _helpers.ts:4919-4946) and cascadeUpholsteryToSO/ToCO, which set it to 1 when
// the upholstery set completes and clear it on revert (_helpers.ts:3594, 3695,
// 3768, 3816). Both predate b7d00c78, so restoring the key restores the
// behaviour the page shipped with; changing that overload is a separate,
// owner-facing decision.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { rowToMinimalPO, rowToPO } = await import(
  "../src/api/routes/production-orders/_helpers.ts"
);

const HELPERS = "src/api/routes/production-orders/_helpers.ts";
const WAREHOUSE = "src/pages/warehouse.tsx";

/** A production_orders row as the pg driver hands it over (camelCase keys). */
const poRow = (over = {}) => ({
  id: "po-1",
  poNo: "PRD-2608-001",
  salesOrderId: "so-1",
  salesOrderNo: "SO-2608-001",
  companySOId: "HK-SO-1",
  consignmentOrderId: "",
  companyCOId: "",
  customerPOId: "CPO-9",
  customerReference: "REF-9",
  customerName: "Houzs KL",
  customerState: "Selangor",
  productId: "prod-1",
  productCode: "1003(A)",
  productName: "HILTON(A) BEDFRAME",
  itemCategory: "BEDFRAME",
  sizeCode: "Q",
  sizeLabel: "Queen 5FT",
  fabricCode: "FAB-1",
  quantity: 2,
  gapInches: null,
  divanHeightInches: null,
  legHeightInches: null,
  specialOrder: "",
  repairScope: null,
  notes: "handle with care",
  status: "COMPLETED",
  currentDepartment: "PACKING",
  progress: 100,
  lineNo: 1,
  startDate: "2026-08-01",
  targetEndDate: "2026-08-20",
  completedDate: "2026-08-19",
  rackingNumber: "Rack 3",
  stockedIn: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  ...over,
});

// The full key set of the minimal projection. Transcribed from the return
// object at _helpers.ts rowToMinimalPO; `stockedIn` is the 2026-08-13 addition.
// Every other entry was already emitted before this fix — listing them all is
// what makes the assertion an output-identity proof and not just a presence
// check for the new key.
const MINIMAL_KEYS = [
  "id",
  "poNo",
  "salesOrderId",
  "salesOrderNo",
  "companySOId",
  "consignmentOrderId",
  "companyCOId",
  "customerPOId",
  "customerReference",
  "customerSO",
  "customerDeliveryDate",
  "hookkaExpectedDD",
  "holdReason",
  "heldBy",
  "heldAt",
  "customerName",
  "customerState",
  "productId",
  "productCode",
  "productName",
  "itemCategory",
  "sizeCode",
  "sizeLabel",
  "fabricCode",
  "quantity",
  "gapInches",
  "divanHeightInches",
  "legHeightInches",
  "specialOrder",
  "repairScope",
  "status",
  "currentDepartment",
  "progress",
  "completedDate",
  "lineNo",
  "targetEndDate",
  "stockedIn",
  "jobCards",
];

test("minimal projection emits exactly its documented key set, incl. stockedIn", () => {
  const out = rowToMinimalPO(poRow());
  assert.deepEqual(
    Object.keys(out).sort(),
    [...MINIMAL_KEYS].sort(),
    "rowToMinimalPO's key set changed — a dropped key renders blank, it does not throw",
  );
});

test("every key shared with the full projection carries the identical value", () => {
  const row = poRow();
  const mini = rowToMinimalPO(row);
  const full = rowToPO(row);
  // jobCards is the one shared key whose SHAPE differs by design (minimal vs
  // full job cards); both are empty here, so it is compared like the rest.
  for (const k of Object.keys(mini)) {
    if (!(k in full)) continue; // customerDeliveryDate / hookkaExpectedDD are minimal-only
    assert.deepEqual(
      mini[k],
      full[k],
      `minimal.${k} diverged from full.${k} — the two shapes must agree on shared keys`,
    );
  }
  assert.equal(mini.stockedIn, true);
  assert.equal(full.stockedIn, true);
});

test("stockedIn is a JS boolean for every 0/1-ish value the INTEGER column yields", () => {
  for (const [raw, expected] of [
    [1, true],
    [0, false],
    [true, true],
    [false, false],
    [null, false],
    [undefined, false],
  ]) {
    const out = rowToMinimalPO(poRow({ stockedIn: raw }));
    assert.equal(
      out.stockedIn,
      expected,
      `stockedIn=${String(raw)} must project to ${expected}`,
    );
    assert.equal(typeof out.stockedIn, "boolean");
    assert.equal(rowToPO(poRow({ stockedIn: raw })).stockedIn, expected);
  }
});

test("warehouse's Stock-In dropdown still reads stockedIn off the minimal payload", () => {
  const src = readFileSync(resolve(process.cwd(), WAREHOUSE), "utf8");
  assert.match(
    src,
    /\/api\/production-orders\?fields=minimal&include=/,
    `${WAREHOUSE} no longer requests the minimal payload — re-check which projection feeds availablePOs`,
  );
  assert.match(
    src,
    /po\.status === "COMPLETED" && !po\.stockedIn/,
    `${WAREHOUSE}'s availablePOs filter changed — the duplicate-STOCK_IN guard is this expression`,
  );
});

test("MinimalPOOut declares stockedIn, so a slim-down cannot drop it silently", () => {
  const src = readFileSync(resolve(process.cwd(), HELPERS), "utf8");
  const type = src.slice(
    src.indexOf("export type MinimalPOOut = {"),
    src.indexOf("export function rowToMinimalJobCard"),
  );
  assert.ok(type.length > 0, "MinimalPOOut type block not found");
  assert.match(
    type,
    /\n {2}stockedIn: boolean;/,
    "MinimalPOOut must declare stockedIn — the type is what tsc checks the projection against",
  );
});
