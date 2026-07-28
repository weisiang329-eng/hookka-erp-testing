// ---------------------------------------------------------------------------
// overdue-report-delivered-exclusion.test.mjs — behavioral test for the
// emailed Overdue Report (src/api/lib/schedule-overdue-report.ts).
//
// Bug (owner 2026-07-28): already-DELIVERED sales orders kept showing on the
// overdue report. Root cause: collectOverdueData filtered by the denormalized
// sales_orders.status, which goes STALE — an SO delivered on an INVOICED DO
// (e.g. SV-2606-002, whose production was cancelled) still read IN_PRODUCTION,
// so it leaked in. Fix: cross-check REAL delivery and drop any SO that has a
// DELIVERED/INVOICED delivery order, regardless of SO.status.
//
// This exercises the real collectOverdueData with a fake DbLike that routes by
// the table each query hits — no DB needed.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { collectOverdueData } from "../src/api/lib/schedule-overdue-report.ts";

// Minimal DbLike whose all() returns canned rows based on the query's FROM.
function fakeDb({ sos, deliveredSoNos, items }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              // Order matters: match the most specific table first.
              if (sql.includes("FROM delivery_order_items")) {
                return { results: deliveredSoNos.map((soNo) => ({ soNo })) };
              }
              if (sql.includes("FROM sales_order_items")) {
                return { results: items };
              }
              if (sql.includes("FROM sales_orders")) {
                return { results: sos };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

const BASE_SO = {
  customerName: "Houzs Century",
  customerState: "KL",
  customerDeliveryDate: "2026-06-01",
  hookkaExpectedDD: "2026-05-28",
  status: "IN_PRODUCTION",
  totalSen: 125000,
};

test("delivered SO (INVOICED DO) is dropped even though its status is stale IN_PRODUCTION", async () => {
  const db = fakeDb({
    sos: [
      { id: "so-active", companySOId: "SO-ACTIVE", ...BASE_SO },
      { id: "so-delivered", companySOId: "SO-DELIVERED", ...BASE_SO },
    ],
    // SO-DELIVERED has a DELIVERED/INVOICED delivery order.
    deliveredSoNos: ["SO-DELIVERED"],
    items: [
      { salesOrderId: "so-active", productCode: "5549-1A", productName: "Sofa", quantity: 2, lineNo: 1 },
    ],
  });

  const report = await collectOverdueData(db, "2026-07-28");

  const ids = report.rows.map((r) => r.companySOId);
  assert.deepEqual(ids, ["SO-ACTIVE"], "only the still-in-production SO should remain");
  assert.equal(report.totals.salesOrders, 1, "delivered SO must not be counted");
  assert.equal(report.rows[0].itemCount, 1, "items still resolve for the kept SO");
});

test("with no delivered DOs, every overdue SO is kept (no over-filtering)", async () => {
  const db = fakeDb({
    sos: [
      { id: "so-1", companySOId: "SO-1", ...BASE_SO },
      { id: "so-2", companySOId: "SO-2", ...BASE_SO },
    ],
    deliveredSoNos: [],
    items: [],
  });

  const report = await collectOverdueData(db, "2026-07-28");
  assert.equal(report.totals.salesOrders, 2, "nothing delivered → both stay");
});
