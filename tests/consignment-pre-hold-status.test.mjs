// ---------------------------------------------------------------------------
// consignment-pre-hold-status.test.mjs
//
// BUG-2026-08-13-041 — resuming an ON_HOLD Consignment Order walked it
// BACKWARDS.
//
// `consignment/detail.tsx:1093` decides where "Resume Order" goes with
//     const resumeTarget = (order.preHoldStatus) || "CONFIRMED";
// and the CO route never emitted — nor stored — `preHoldStatus`. So the
// fallback was the whole behaviour: a CO held from IN_PRODUCTION came back as
// CONFIRMED, losing a stage, while the confirmation dialog announced exactly
// where it was going. The Sales Order side closed the identical gap on
// 2026-08-04 (`SalesOrder.preHoldStatus`, and the comment in
// `src/types/index.ts` recording that it moved IN_PRODUCTION orders backwards
// silently until then).
//
// Pinned here, against the REAL PUT handler:
//   1. holding CAPTURES the status being left;
//   2. the by-id read EMITS it, so the button has something to read;
//   3. a header-only edit while held PRESERVES it (an edit is not a resume);
//   4. resuming CLEARS it, and a re-hold captures the new origin — a stale
//      value would send the next resume to the wrong stage;
//   5. a hold-to-hold write can never store 'ON_HOLD' as its own origin;
//   6. READY_TO_SHIP is a legal resume target, because a CO can be held FROM
//      it — without that the fix would make such an order unresumable;
//   7. leaving a hold still cascades to the shop floor, for EVERY resume
//      target and not just the two that used to be enumerated.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

const { default: consignmentOrdersApp } = await import(
  src("src/api/routes/consignment-orders.ts")
);

function makeDb(co, { productionOrders = [] } = {}) {
  const writes = [];
  function prepare(sql) {
    const s = String(sql).trim();
    let bound = [];
    const rows = () => {
      if (/FROM kv_config/i.test(s)) return [{ value: "{}" }];
      if (/FROM customers/i.test(s)) return [{ id: "cust-1", name: "Test Customer" }];
      if (/FROM consignment_notes/i.test(s)) return [];
      if (/FROM production_orders/i.test(s)) return productionOrders;
      if (/FROM job_cards/i.test(s)) return [];
      if (/FROM consignment_order_items/i.test(s)) return [];
      if (/FROM consignment_orders/i.test(s)) {
        if (/LIKE/i.test(s)) return [];
        return [co];
      }
      return [];
    };
    const obj = {
      bind(...a) {
        bound = a;
        return obj;
      },
      async first() {
        return rows()[0] ?? null;
      },
      async all() {
        return { results: rows() };
      },
      async run() {
        writes.push({ sql: s, bound });
        return { success: true, meta: { changes: 1 } };
      },
      __record() {
        writes.push({ sql: s, bound });
      },
    };
    return obj;
  }
  return {
    writes,
    db: {
      prepare,
      async batch(stmts) {
        for (const st of stmts) st.__record?.();
        return stmts.map(() => ({ success: true }));
      },
    },
  };
}

function mount(db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("orgId", "hookka");
    c.set("userRole", "SUPER_ADMIN");
    c.set("userId", "user-1");
    await next();
  });
  parent.route("/", consignmentOrdersApp);
  return parent;
}

const baseCo = (over = {}) => ({
  id: "co-1",
  orgId: "hookka",
  customerId: "cust-1",
  customerName: "Test Customer",
  status: "IN_PRODUCTION",
  subtotalSen: 100000,
  totalSen: 100000,
  ...over,
});

async function put(db, body) {
  return mount(db).request("/co-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The value bound to `pre_hold_status` in the header UPDATE. */
function preHoldBound(writes) {
  const w = writes.find((x) => /UPDATE consignment_orders SET/i.test(x.sql));
  assert.ok(w, "the PUT must issue a header UPDATE");
  const flat = w.sql.replace(/\s+/g, " ");
  assert.match(
    flat,
    /pre_hold_status = \?/,
    "the UPDATE must name pre_hold_status, or the capture is never persisted",
  );
  // Count the `?` placeholders in SET up to and including pre_hold_status.
  const setClause = flat.slice(flat.indexOf("SET"), flat.indexOf("WHERE"));
  const upTo = setClause.slice(0, setClause.indexOf("pre_hold_status = ?") + "pre_hold_status = ?".length);
  const idx = (upTo.match(/\?/g) ?? []).length - 1;
  return w.bound[idx];
}

// ---------------------------------------------------------------------------

test("holding a CO captures the status it was interrupted at", async () => {
  const { db, writes } = makeDb(baseCo({ status: "IN_PRODUCTION" }));
  const res = await put(db, { status: "ON_HOLD", holdReason: "customer paused" });
  assert.equal(res.status, 200, await res.text());
  assert.equal(
    preHoldBound(writes),
    "IN_PRODUCTION",
    "the stage being left is the only honest resume target — falling back to " +
      "CONFIRMED moves the order backwards a stage",
  );
});

test("the by-id read emits preHoldStatus, so Resume has something to read", async () => {
  const { db } = makeDb(
    baseCo({ status: "ON_HOLD", pre_hold_status: "IN_PRODUCTION" }),
  );
  const res = await mount(db).request("/co-1");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.data.preHoldStatus,
    "IN_PRODUCTION",
    "rowToCO must emit it dual-keyed — the page read this field for months " +
      "against a payload that never carried it",
  );
});

test("a header-only edit while held preserves the resume target", async () => {
  // Editing notes is not resuming. Clearing the capture here would silently
  // downgrade the resume target to CONFIRMED on the next Resume click.
  const { db, writes } = makeDb(
    baseCo({ status: "ON_HOLD", pre_hold_status: "READY_TO_SHIP" }),
  );
  const res = await put(db, { notes: "chased the customer" });
  assert.equal(res.status, 200, await res.text());
  assert.equal(preHoldBound(writes), "READY_TO_SHIP");
});

test("a hold-to-hold write never stores ON_HOLD as its own origin", async () => {
  const { db, writes } = makeDb(
    baseCo({ status: "ON_HOLD", pre_hold_status: "IN_PRODUCTION" }),
  );
  await put(db, { status: "ON_HOLD", holdReason: "still paused" });
  assert.notEqual(preHoldBound(writes), "ON_HOLD");
  assert.equal(preHoldBound(writes), "IN_PRODUCTION");
});

test("resuming clears the capture", async () => {
  const { db, writes } = makeDb(
    baseCo({ status: "ON_HOLD", pre_hold_status: "IN_PRODUCTION" }),
  );
  const res = await put(db, { status: "IN_PRODUCTION" });
  assert.equal(res.status, 200, await res.text());
  assert.equal(
    preHoldBound(writes),
    null,
    "a stale capture would send the NEXT resume to a stage this order has " +
      "since moved past",
  );
});

test("a CO held from READY_TO_SHIP can actually be resumed there", async () => {
  // The transition table allowed ON_HOLD → CONFIRMED / IN_PRODUCTION / CANCELLED
  // only. Storing the real origin without widening it would have turned a
  // silent downgrade into an outright refusal — the order could not come off
  // hold at all.
  const { db, writes } = makeDb(
    baseCo({ status: "ON_HOLD", pre_hold_status: "READY_TO_SHIP" }),
  );
  const res = await put(db, { status: "READY_TO_SHIP" });
  assert.equal(
    res.status,
    200,
    `resuming to the stage the order was held at must not be rejected as an ` +
      `illegal transition: ${await res.text()}`,
  );
  assert.equal(preHoldBound(writes), null);
});

test("leaving a hold cascades to the shop floor for EVERY resume target", async () => {
  // The cascade condition enumerated CONFIRMED / IN_PRODUCTION. A CO resumed to
  // READY_TO_SHIP would have come off hold with its production orders and job
  // cards still ON_HOLD — the exact symptom the cascade was written for.
  const { db, writes } = makeDb(
    baseCo({ status: "ON_HOLD", pre_hold_status: "READY_TO_SHIP" }),
    { productionOrders: [{ id: "po-1", poNo: "PRD-001", status: "ON_HOLD" }] },
  );
  await put(db, { status: "READY_TO_SHIP" });
  const freed = writes.filter((w) =>
    /UPDATE production_orders SET status = 'PENDING'/i.test(w.sql),
  );
  assert.equal(
    freed.length,
    1,
    "the held production order must be released when its CO is resumed",
  );
});

test("the SO side's resume is defined by what it leaves, not where it lands", () => {
  // Same edit, same reason, on the sales-order twin: `VALID_TRANSITIONS.ON_HOLD`
  // gained READY_TO_SHIP there too, and an enumerated cascade condition would
  // have left the floor held.
  const helpers = read("src/api/routes/sales-orders/_helpers.ts");
  assert.match(
    helpers,
    /ON_HOLD: \["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "CANCELLED"\]/,
    "an SO held from READY_TO_SHIP stores that as its resume target; the " +
      "transition table has to accept it or the order cannot be resumed at all",
  );
  assert.match(
    helpers,
    /const isResume = fromStatus === "ON_HOLD" && !isHold && !isCancel;/,
    "cascadeSOStatusToPOs must treat any departure from ON_HOLD as a resume",
  );
});
