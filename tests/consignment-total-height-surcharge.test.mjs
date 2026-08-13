// ---------------------------------------------------------------------------
// consignment-total-height-surcharge.test.mjs
//
// BUG-2026-08-13-040 — BUG-CLASS C1, instance 6.
//
// The CO create screen computes a TOTAL-HEIGHT surcharge (gap + divan + leg,
// priced off the owner's `variants-config.totalHeights`), shows it to the
// operator as "+RM 80.00", and POSTs it. The CO write path then computed
// `unitPrice = base + divan + leg + special` and left the column out of its
// INSERT altogether — so the saved consignment order's total was LOWER than the
// figure the operator approved on screen, and the CO PDF's "T.Height" column
// printed 0 forever.
//
// This test is not "a number came back". It runs the REAL POST and PUT handlers
// against an in-memory book, reads the values actually bound into
// `consignment_order_items` / `consignment_orders`, and asserts they equal —
// to the sen — what the screen's own arithmetic (`calculateUnitPrice`,
// `calculateLineTotalWithDiscount`, the same two functions the CO pages call)
// produces for the same line.
//
// The fixture, in sen:
//   base 83,000 · divan 10" 5,500 · leg 4" 2,000 · gap 12" · T.Height 26" 8,000
//   qty 2 · discount 3,000
//   BEFORE: unit 90,500  line 178,000  order total 178,000
//   AFTER : unit 98,500  line 194,000  order total 194,000
//   The 8,000-sen/unit surcharge × 2 units = RM 160.00 lost on ONE line.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;

const { default: consignmentOrdersApp } = await import(
  src("src/api/routes/consignment-orders.ts")
);
const { calculateUnitPrice, calculateLineTotalWithDiscount } = await import(
  src("src/lib/pricing.ts")
);

// ---------------------------------------------------------------------------
// The owner's price lists, exactly as kv_config carries them.
// ---------------------------------------------------------------------------
const VARIANTS_CONFIG = JSON.stringify({
  divanHeights: [{ value: '10"', priceSen: 5500 }, { value: '12"', priceSen: 13000 }],
  legHeights: [{ value: '4"', priceSen: 2000 }],
  totalHeights: [{ value: '26"', priceSen: 8000 }, { value: '28"', priceSen: 16000 }],
  specials: [{ value: "Divan Full Cover", priceSen: 8000 }],
  sofaSizes: ["28"],
});

const BASE_SEN = 83000;
const DIVAN_SEN = 5500;
const LEG_SEN = 2000;
const TOTAL_HEIGHT_SEN = 8000; // 12" gap + 10" divan + 4" leg = 26"
const QTY = 2;
const DISCOUNT_SEN = 3000;

/** The line exactly as `consignment/create.tsx` posts it. */
function screenLine(overrides = {}) {
  return {
    productId: "prod-1",
    productCode: "BF-001",
    productName: "Bedframe 001",
    itemCategory: "BEDFRAME",
    sizeCode: "Q",
    sizeLabel: "Queen",
    fabricCode: "FAB-1",
    quantity: QTY,
    basePriceSen: BASE_SEN,
    gapInches: 12,
    divanHeightInches: 10,
    divanPriceSen: DIVAN_SEN,
    legHeightInches: 4,
    legPriceSen: LEG_SEN,
    totalHeightPriceSen: TOTAL_HEIGHT_SEN,
    specialOrder: "",
    specialOrderPriceSen: 0,
    discountSen: DISCOUNT_SEN,
    notes: "",
    ...overrides,
  };
}

/** What the SCREEN shows for that line — the number the operator approved. */
function screenUnitSen(line) {
  return calculateUnitPrice({
    basePriceSen: line.basePriceSen,
    divanPriceSen: line.divanPriceSen,
    legPriceSen: line.legPriceSen,
    totalHeightPriceSen: line.totalHeightPriceSen,
    specialOrderPriceSen: line.specialOrderPriceSen,
  });
}
function screenLineTotalSen(line) {
  return calculateLineTotalWithDiscount(
    screenUnitSen(line),
    line.quantity,
    line.discountSen,
  );
}

// ---------------------------------------------------------------------------
// An in-memory book that records every statement the handlers prepare, so the
// assertions can read the values that were actually BOUND into the INSERT
// rather than whatever the response body happens to echo.
// ---------------------------------------------------------------------------
/** Turn a recorded `INSERT INTO t (cols) VALUES (?…)` back into a row. */
function insertToRow(w) {
  const cols = w.sql
    .replace(/\s+/g, " ")
    .match(/INSERT INTO \w+ \(([^)]+)\)/i)[1]
    .split(",")
    .map((c) => c.trim());
  return Object.fromEntries(cols.map((c, i) => [c, w.bound[i]]));
}

function makeDb({ existingCo = null, existingItems = [] } = {}) {
  const writes = [];

  function prepare(sql) {
    const s = String(sql).trim();
    let bound = [];

    const rows = () => {
      if (/FROM kv_config/i.test(s)) return [{ value: VARIANTS_CONFIG }];
      if (/FROM customers/i.test(s)) return [{ id: "cust-1", name: "Test Customer" }];
      if (/FROM delivery_hubs/i.test(s)) return [{ state: "Selangor" }];
      if (/FROM products/i.test(s)) {
        return [
          {
            id: "prod-1",
            code: "BF-001",
            name: "Bedframe 001",
            category: "BEDFRAME",
            sizeCode: "Q",
            sizeLabel: "Queen",
            basePriceSen: BASE_SEN,
            seatHeightPrices: "[]",
          },
        ];
      }
      if (/FROM raw_materials/i.test(s)) return [{ itemCode: "FAB-1" }];
      // Checked BEFORE consignment_orders: the edit-lock probe names
      // consignment_notes in the outer FROM and consignment_orders in a
      // subquery, so a looser match would answer it with the CO row and lock
      // every edit.
      if (/FROM consignment_notes/i.test(s)) return [];
      if (/FROM production_orders/i.test(s)) return [];
      if (/FROM consignment_order_items/i.test(s)) return existingItems;
      if (/FROM consignment_orders/i.test(s)) {
        // nextCompanyCOId's sequence probe: no prior number this month.
        if (/LIKE/i.test(s)) return [];
        if (existingCo) return [existingCo];
        // The POST re-reads the row it just wrote. Serve the header INSERT's
        // own binds back, so the response body is built from what was stored
        // rather than from a fixture that could disagree with it.
        const w = writes.find((x) => /INSERT INTO consignment_orders/i.test(x.sql));
        return w ? [insertToRow(w)] : [];
      }
      if (/FROM job_cards/i.test(s)) return [];
      return [];
    };

    const obj = {
      bind(...args) {
        bound = args;
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
      // Statements queued into DB.batch() are recorded when the batch runs;
      // record them here too so a queued INSERT is visible either way.
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

/** Pull one column's bound value out of the recorded item INSERT. */
function itemInsert(writes) {
  const w = writes.find((x) => /INSERT INTO consignment_order_items/i.test(x.sql));
  assert.ok(w, "the handler must INSERT a consignment_order_items row");
  const cols = w.sql
    .replace(/\s+/g, " ")
    .match(/INSERT INTO consignment_order_items \(([^)]+)\)/i)[1]
    .split(",")
    .map((c) => c.trim());
  assert.equal(
    cols.length,
    w.bound.length,
    `the column list (${cols.length}) and the binds (${w.bound.length}) must agree — ` +
      `a mismatch means the row is being written into the wrong columns`,
  );
  return Object.fromEntries(cols.map((c, i) => [c, w.bound[i]]));
}

function orderInsert(writes) {
  const w = writes.find((x) => /INSERT INTO consignment_orders/i.test(x.sql));
  assert.ok(w, "the handler must INSERT a consignment_orders row");
  const cols = w.sql
    .replace(/\s+/g, " ")
    .match(/INSERT INTO consignment_orders \(([^)]+)\)/i)[1]
    .split(",")
    .map((c) => c.trim());
  return Object.fromEntries(cols.map((c, i) => [c, w.bound[i]]));
}

async function postCo(db, items) {
  return mount(db).request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "cust-1",
      hubId: "hub-1",
      companyCODate: "2026-08-13",
      items,
    }),
  });
}

// ---------------------------------------------------------------------------
// 1. The money. What is STORED must equal what the SCREEN approved, to the sen.
// ---------------------------------------------------------------------------

test("CO create: the stored unit price carries the total-height surcharge, to the sen", async () => {
  const line = screenLine();
  const { db, writes } = makeDb();
  const res = await postCo(db, [line]);
  assert.equal(res.status, 201, await res.text());

  const stored = itemInsert(writes);

  // The exact figures, stated so a regression reads as a number and not a diff.
  assert.equal(screenUnitSen(line), 98500, "fixture check: the screen shows RM 985.00");
  assert.equal(
    Number(stored.totalHeightPriceSen),
    TOTAL_HEIGHT_SEN,
    "the surcharge the operator approved must be STORED, not discarded — it used to " +
      "be missing from the INSERT column list entirely",
  );
  assert.equal(
    Number(stored.unitPriceSen),
    screenUnitSen(line),
    `stored unit price must equal the screen's calculateUnitPrice. Before this fix ` +
      `the server stored 90,500 sen against a screen showing 98,500 — RM 80.00 per unit ` +
      `of surcharge silently dropped.`,
  );
  assert.equal(
    Number(stored.lineTotalSen),
    screenLineTotalSen(line),
    "line total = unit × qty − discount, off the SAME unit price the screen used " +
      "(194,000 sen, not the old 178,000)",
  );
});

test("CO create: the order total is the sum the operator saw", async () => {
  const line = screenLine();
  const { db, writes } = makeDb();
  await postCo(db, [line]);

  const order = orderInsert(writes);
  assert.equal(Number(order.subtotalSen), 194000);
  assert.equal(
    Number(order.totalSen),
    screenLineTotalSen(line),
    "the header total is what the customer is being asked to pay — it must not be " +
      "RM 160.00 lower than the quotation the operator approved",
  );
});

test("CO create: the response body reports the same money it stored", async () => {
  const line = screenLine();
  const { db } = makeDb();
  const res = await postCo(db, [line]);
  const body = await res.json();
  const it = body.data.items[0];
  assert.equal(it.totalHeightPriceSen, TOTAL_HEIGHT_SEN, "rowToItem must emit it");
  assert.equal(it.unitPriceSen, screenUnitSen(line));
});

// ---------------------------------------------------------------------------
// 2. The TRUST MODEL — the half that makes this a resolver and not a recompute.
// ---------------------------------------------------------------------------

test("CO create: a client that OMITS the surcharge gets it derived from the owner's config", async () => {
  // This is the scan / import shape: heights posted, prices not. Before the
  // resolvers, all four components stored 0 on such a payload.
  const line = screenLine();
  delete line.totalHeightPriceSen;
  delete line.divanPriceSen;
  delete line.legPriceSen;
  delete line.specialOrderPriceSen;

  const { db, writes } = makeDb();
  await postCo(db, [line]);
  const stored = itemInsert(writes);

  assert.equal(Number(stored.divanPriceSen), DIVAN_SEN, '10" divan is RM 55.00 in the config');
  assert.equal(Number(stored.legPriceSen), LEG_SEN, '4" leg is RM 20.00 in the config');
  assert.equal(
    Number(stored.totalHeightPriceSen),
    TOTAL_HEIGHT_SEN,
    '12+10+4 = 26", and the owner prices 26" at RM 80.00',
  );
  assert.equal(Number(stored.unitPriceSen), 98500);
});

test("CO create: a deliberate 0 is trusted, never re-derived", async () => {
  // A waived surcharge is a decision. Deriving over it would BILL for something
  // the operator chose to give away — the failure mode that makes a resolver
  // dangerous if it recomputes instead of filling in.
  const line = screenLine({ totalHeightPriceSen: 0, divanPriceSen: 0, legPriceSen: 0 });
  const { db, writes } = makeDb();
  await postCo(db, [line]);
  const stored = itemInsert(writes);

  assert.equal(Number(stored.totalHeightPriceSen), 0);
  assert.equal(Number(stored.divanPriceSen), 0);
  assert.equal(Number(stored.legPriceSen), 0);
  assert.equal(
    Number(stored.unitPriceSen),
    BASE_SEN,
    "an explicitly waived line is base-only, and stays base-only",
  );
});

test("CO create: an unknown total height prices at 0 — never an invented number", async () => {
  const line = screenLine({ gapInches: 3, divanHeightInches: 1, legHeightInches: 1 });
  delete line.totalHeightPriceSen;
  const { db, writes } = makeDb();
  await postCo(db, [line]);
  const stored = itemInsert(writes);
  assert.equal(
    Number(stored.totalHeightPriceSen),
    0,
    '5" is not in the owner\'s list, so it has no price — do not guess one',
  );
});

// ---------------------------------------------------------------------------
// 3. The EDIT path. A fix applied only to create leaves every edit re-storing
//    the short price — that is precisely how C1 kept coming back.
// ---------------------------------------------------------------------------

test("CO edit: the PUT stores the same total-height surcharge the POST does", async () => {
  const line = screenLine();
  const { db, writes } = makeDb({
    existingCo: {
      id: "co-1",
      orgId: "hookka",
      customerId: "cust-1",
      customerName: "Test Customer",
      status: "DRAFT",
      subtotalSen: 0,
      totalSen: 0,
    },
  });

  const res = await mount(db).request("/co-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId: "cust-1", items: [line] }),
  });
  assert.equal(res.status, 200, await res.text());

  const stored = itemInsert(writes);
  assert.equal(Number(stored.totalHeightPriceSen), TOTAL_HEIGHT_SEN);
  assert.equal(Number(stored.unitPriceSen), screenUnitSen(line));
  assert.equal(Number(stored.lineTotalSen), screenLineTotalSen(line));

  const upd = writes.find((w) => /UPDATE consignment_orders SET/i.test(w.sql));
  assert.ok(upd, "the PUT must update the header totals");
  assert.ok(
    upd.bound.includes(screenLineTotalSen(line)),
    `the recomputed header total must be ${screenLineTotalSen(line)} sen — the same ` +
      `figure the screen shows`,
  );
});
