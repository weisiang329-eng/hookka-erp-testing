// ---------------------------------------------------------------------------
// "Active Jobs" must mean work still in the factory.
//
// Owner 2026-08-05: "你确定有 60 套还在 pending 没做好吗？我们所谓的 60 套是一个
// sales' order，sofa 的话是一个 sales' order 算一套的，你确定有那么多吗？"
//
// No. The figure excluded only COMPLETED and CANCELLED production orders, so it
// also counted 59 orders on prod whose SALES order was already INVOICED,
// SHIPPED or CLOSED — goods that had left the building, on job cards nobody
// went back to close. 125 units / 60 sets against a real 98 / 49, and the same
// padding flowed into the backlog hours and the queue days beside it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/dashboard-overview.ts"),
  "utf8",
);

const SHIPPED = ["INVOICED", "SHIPPED", "DELIVERED", "CLOSED"];

test("Active Jobs ignores production orders whose sales order already shipped", () => {
  const q = SRC.slice(SRC.indexOf("// Active Jobs"), SRC.indexOf("// Active Jobs") + 1600);
  assert.match(q, /LEFT JOIN sales_orders so ON so\.id = po\.salesOrderId/);
  for (const s of SHIPPED) {
    assert.ok(q.includes(`'${s}'`), `Active Jobs still counts a ${s} sales order`);
  }
  // A production order with NO sales order (consignment, stock build) has
  // nothing to check and must stay counted — dropping it would hide real work.
  assert.match(q, /so\.status IS NULL/);
});

test("the backlog applies the same exclusion", () => {
  // Otherwise the two figures sit side by side disagreeing about what is open.
  assert.match(SRC, /const soShipped =/);
  for (const s of SHIPPED) {
    assert.ok(
      new RegExp(`r\\.soStatus === "${s}"`).test(SRC),
      `the backlog still counts job cards on a ${s} sales order`,
    );
  }
  assert.match(SRC, /!soShipped &&/);
});

test("the exclusion is driven by the sales order, not the job card", () => {
  // Reading it off the job card would be circular: the whole problem is that
  // the job card was never closed.
  assert.match(SRC, /so\.status AS "soStatus"/);
});
