// T-006 R7 — Delivery Return had three holes:
//   1. No cap: the same DO line could be returned twice, or returned more
//      than was ever delivered.
//   2. Whole-line exclusion: computeDoInvoiceLines dropped a line ENTIRELY
//      the moment ANY return touched it (a Set<productionOrderId>
//      membership filter) — so returning 1 of 3 left 0 invoiceable, not 2.
//   3. Cancel-after-restock: a return already in RETURNED_TO_STOCK (stock
//      was credited back) could still be cancelled with no reversal,
//      overstating stock by whatever it put back.
//
// (1) and (3) are source-static (no live D1 in CI). (2) is exercised for
// real against computeDoInvoiceLines with a mocked D1, matching PRD
// acceptance A7 exactly: DO line qty 3, return 1, invoiceable qty is 2.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

const CREATE_SRC = read("src/api/lib/delivery-return-create.ts");
const RETURNS_SRC = read("src/api/routes/delivery-returns.ts");
const HELPERS_SRC = read("src/api/routes/delivery-orders/_helpers.ts");

// ===========================================================================
// 1. Cap + duplicate guard (delivery-return-create.ts)
// ===========================================================================

test("a return is capped at what the DO line actually delivered, cumulative across prior returns", () => {
  const fn = CREATE_SRC.slice(CREATE_SRC.indexOf("export async function createDeliveryReturnRecord"));
  assert.match(
    fn,
    /FROM delivery_return_items dri\s*\n\s*JOIN delivery_returns dr ON dr\.id = dri\.delivery_return_id\s*\n\s*WHERE dr\.delivery_order_id = \? AND dr\.status <> 'CANCELLED'/,
  );
  assert.match(fn, /if \(priorReturned \+ thisReturn > doLineQty\)/);
  // Rejected before the insert batch runs.
  const rejectIdx = fn.indexOf("if (priorReturned + thisReturn > doLineQty)");
  const batchIdx = fn.indexOf("await db.batch(statements)");
  assert.ok(rejectIdx < batchIdx, "the cap check must run before anything is written");
});

test("createDeliveryReturnRecord returns ok:false on cap violation instead of null", () => {
  const fn = CREATE_SRC.slice(CREATE_SRC.indexOf("export async function createDeliveryReturnRecord"));
  assert.match(fn, /return \{\s*ok: false,\s*error: `Return exceeds/);
  assert.match(fn, /return \{ ok: true, id, returnNo \};/);
  assert.doesNotMatch(fn, /return null;/);
});

test("the office route surfaces a cap rejection as 409 with the real error", () => {
  assert.match(RETURNS_SRC, /if \(!created\.ok\) \{\s*\n\s*return c\.json\(\{ success: false, error: created\.error \}, 409\);/);
});

// ===========================================================================
// 2. Partial exclusion, not whole-line (delivery-orders/_helpers.ts,
//    computeDoInvoiceLines) — exercised live against a mocked D1.
// ===========================================================================

const { computeDoInvoiceLines } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href
);

function book() {
  return {
    deliveryOrders: [{ id: "do-1", orgId: "hookka", salesOrderId: "so-1" }],
    doItems: [
      { id: "di-1", deliveryOrderId: "do-1", productionOrderId: "po-1", productCode: "CHAIR", productName: "Chair", sizeLabel: "", fabricCode: "", quantity: 3, invoiced_qty: 0 },
    ],
    prodOrders: [
      { id: "po-1", orgId: "hookka", salesOrderId: "so-1", productCode: "CHAIR", sizeCode: "", fabricCode: "" },
    ],
    soItems: [
      { salesOrderId: "so-1", productCode: "CHAIR", sizeCode: "", fabricCode: "", unitPriceSen: 10000, quantity: 3, lineTotalSen: 30000 },
    ],
    returnedQtyByPoId: {}, // populated per-test
  };
}

function fakeDb(b) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    prepare(sql) {
      const q = norm(sql);
      return {
        async run() { return { success: true }; }, // DDL self-applies
        bind(...args) {
          return {
            async first() {
              if (/SELECT orgId, salesOrderId FROM delivery_orders WHERE id = \?/.test(q)) {
                return b.deliveryOrders.find((d) => d.id === args[0]) ?? null;
              }
              throw new Error("unexpected first(): " + q);
            },
            async all() {
              if (/FROM delivery_order_items WHERE deliveryOrderId = \?/.test(q)) {
                return {
                  results: b.doItems
                    .filter((d) => d.deliveryOrderId === args[0])
                    .map((d) => ({ ...d, invoicedQty: d.invoiced_qty })),
                };
              }
              if (/FROM delivery_return_items dri/.test(q)) {
                return {
                  results: Object.entries(b.returnedQtyByPoId).map(([poId, qty]) => ({
                    poId,
                    qty,
                  })),
                };
              }
              if (/FROM production_orders WHERE orgId = \?/.test(q)) {
                return { results: b.prodOrders.filter((p) => p.orgId === args[0]) };
              }
              if (/FROM sales_order_items si JOIN sales_orders s/.test(q)) {
                return { results: b.soItems };
              }
              if (/FROM sales_order_items WHERE salesOrderId IN/.test(q)) {
                return { results: b.soItems.filter((si) => args.includes(si.salesOrderId)) };
              }
              throw new Error("unexpected all(): " + q);
            },
          };
        },
      };
    },
  };
}

test("A7 — DO line qty 3, no return, invoiceable qty is 3", async () => {
  const b = book();
  const db = fakeDb(b);
  const { invItems } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  assert.equal(invItems.length, 1);
  assert.equal(invItems[0].quantity, 3);
});

test("A7 — DO line qty 3, return 1, invoiceable qty is 2 (not 0, not 3)", async () => {
  const b = book();
  b.returnedQtyByPoId["po-1"] = 1;
  const db = fakeDb(b);
  const { invItems } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  assert.equal(invItems.length, 1, "the line must still appear — a partial return does not drop it");
  assert.equal(invItems[0].quantity, 2);
});

test("A7 — a return of the WHOLE line zeroes just that line, a sibling line is unaffected", async () => {
  // A second, untouched line keeps computedTotal > 0 so this test stays on
  // the per-line drawdown path (a DO with only one line, fully returned,
  // hits a separate pre-existing "nothing priced → bill the SO directly"
  // fallback that predates and is unrelated to this fix).
  const b = book();
  b.doItems.push({ id: "di-2", deliveryOrderId: "do-1", productionOrderId: "po-2", productCode: "TABLE", productName: "Table", sizeLabel: "", fabricCode: "", quantity: 2, invoiced_qty: 0 });
  b.prodOrders.push({ id: "po-2", orgId: "hookka", salesOrderId: "so-1", productCode: "TABLE", sizeCode: "", fabricCode: "" });
  b.soItems.push({ salesOrderId: "so-1", productCode: "TABLE", sizeCode: "", fabricCode: "", unitPriceSen: 5000, quantity: 2, lineTotalSen: 10000 });
  b.returnedQtyByPoId["po-1"] = 3;
  const db = fakeDb(b);
  const { invItems } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  const chair = invItems.find((i) => i.productCode === "CHAIR");
  const table = invItems.find((i) => i.productCode === "TABLE");
  assert.equal(chair, undefined, "the fully-returned line must not bill anything");
  assert.equal(table.quantity, 2, "the untouched sibling line bills in full");
});

// ===========================================================================
// 3. Cancel must refuse after restock (delivery-returns.ts)
// ===========================================================================

test("cancel refuses a RETURNED_TO_STOCK return — no reversal exists, so it must not silently succeed", () => {
  const idx = RETURNS_SRC.indexOf('app.post("/:id/cancel"');
  const routeBody = RETURNS_SRC.slice(idx);
  assert.match(routeBody, /h\.status === "RETURNED_TO_STOCK"/);
  assert.match(routeBody, /Cannot cancel a \$\{h\.status\} return/);
});
