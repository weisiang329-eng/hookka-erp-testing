// ---------------------------------------------------------------------------
// order-footprint.test.mjs — "this order is empty, delete it" must be CHECKED.
//
// A sales order is the head of a chain reaching production orders, job cards,
// delivery orders and invoices. Hard-deleting the head orphans dispatch and
// accounting records that month-end reconciliation depends on, and that cannot
// be undone. This report exists so the claim can be verified first — so it has
// to be honest about three things: what is attached, what would BLOCK a delete,
// and when it could not read a table at all (an incomplete report must never
// read as a clean bill of health).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { buildOrderFootprint } from "../src/api/lib/order-footprint.ts";

/** `tables` maps a probe's table keyword to the rows it should return. */
function makeDb({ order = null, tables = {}, broken = [] } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const exec = {
        async all() {
          for (const kw of broken) {
            if (sql.includes(kw)) throw new Error(`no such column: ${kw}`);
          }
          for (const [kw, rows] of Object.entries(tables)) {
            if (sql.includes(kw)) return { results: rows };
          }
          return { results: [] };
        },
        async first() {
          return sql.includes("FROM sales_orders") ? order : null;
        },
        async run() {
          writes.push(sql);
        },
      };
      return { ...exec, bind: () => exec };
    },
  };
}

const ORDER = { id: "so-1", so_ref: "SO-2605-309", customer: "Houzs Century", status: "ON_HOLD" };

test("an unknown reference is reported as not found, never as empty", async () => {
  const r = await buildOrderFootprint(makeDb({ order: null }), "SO-NOPE");
  assert.equal(r.found, false);
  assert.equal(r.safeToDelete, false, "not-found must never read as safe to delete");
  assert.match(r.recommendation, /No sales order matched/);
});

test("a genuinely empty order is reported as empty", async () => {
  const r = await buildOrderFootprint(makeDb({ order: ORDER }), "SO-2605-309");
  assert.equal(r.found, true);
  assert.equal(r.soRef, "SO-2605-309");
  assert.equal(r.totalRows, 0);
  assert.equal(r.safeToDelete, true);
  assert.match(r.recommendation, /really is empty/);
});

test("attached invoices block deletion and are named in the advice", async () => {
  const db = makeDb({
    order: ORDER,
    tables: { "FROM invoices": [{ k: "INV-001" }, { k: "INV-002" }] },
  });
  const r = await buildOrderFootprint(db, "SO-2605-309");
  assert.equal(r.safeToDelete, false);
  const inv = r.rows.find((x) => x.table === "invoices");
  assert.equal(inv.count, 2);
  assert.deepEqual(inv.sample, ["INV-001", "INV-002"]);
  assert.match(r.recommendation, /Do NOT delete/);
  assert.match(r.recommendation, /CANCELLED/, "the safe alternative must be offered");
});

test("delivery orders and unfinished job cards also block deletion", async () => {
  for (const kw of ["FROM delivery_orders", "NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')"]) {
    const r = await buildOrderFootprint(
      makeDb({ order: ORDER, tables: { [kw]: [{ k: "X-1" }] } }),
      "SO-2605-309",
    );
    assert.equal(r.safeToDelete, false, `${kw} should block deletion`);
  }
});

test("harmless leftovers do not block, but still steer to CANCELLED", async () => {
  // Order lines only — nothing financial, nothing on the floor.
  const r = await buildOrderFootprint(
    makeDb({ order: ORDER, tables: { "FROM sales_order_items": [{ k: "li-1" }] } }),
    "SO-2605-309",
  );
  assert.equal(r.safeToDelete, true);
  assert.ok(r.totalRows > 0);
  assert.match(r.recommendation, /CANCELLED is still the safer action/);
});

test("an unreadable table makes the report INCOMPLETE, not clean", async () => {
  const r = await buildOrderFootprint(
    makeDb({ order: ORDER, broken: ["FROM invoices"] }),
    "SO-2605-309",
  );
  assert.equal(r.safeToDelete, false, "a report with a hole must never say safe");
  assert.match(r.recommendation, /INCOMPLETE/);
  const inv = r.rows.find((x) => x.table === "invoices");
  assert.ok(inv.error, "the failing table must say so on its own row");
});

test("the report never writes", async () => {
  const db = makeDb({ order: ORDER, tables: { "FROM invoices": [{ k: "INV-1" }] } });
  await buildOrderFootprint(db, "SO-2605-309");
  assert.equal(db.writes.length, 0, "an audit must not mutate what it is auditing");
});

test("every probe reports a row, so nothing is silently unchecked", async () => {
  const r = await buildOrderFootprint(makeDb({ order: ORDER }), "SO-2605-309");
  for (const t of [
    "sales_order_items",
    "production_orders",
    "job_cards",
    "delivery_orders",
    "invoices",
    "cs_promise_log",
    "schedule_proposals",
  ]) {
    assert.ok(
      r.rows.some((x) => x.table === t),
      `${t} must appear in the report even when empty`,
    );
  }
});
