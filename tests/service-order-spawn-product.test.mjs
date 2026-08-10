// ---------------------------------------------------------------------------
// service-order-spawn-product.test.mjs — Spawn Service Order: the affected
// item, the mode that needs it, and the message when it isn't there.
//
// THE BUG (prod, 2026-08-10). A staff member opened a Service Case, clicked
// Spawn Service Order with Resolution Mode = Reproduce, left CODE blank
// (the column was labelled "optional") and typed `1041 (Q)` into PRODUCT NAME.
// The catalogue code is `1041-(Q)` — a space where the code has a hyphen.
//
//   POST /api/service-orders → 400
//   {"success":false,"error":"insert or update on table \"production_orders\"
//    violates foreign key constraint \"production_orders_product_id_fkey\""}
//
// Three faults, stacked:
//   1. Reproduce inserts a production_orders row, and product_id is a FK to
//      products. The route bound `productId ?? ""` — an empty string is not
//      NULL, so Postgres ran the FK check and rejected it. The screen said
//      the field was optional; the write path required it.
//   2. The operator was shown a Postgres constraint name — and because
//      humanizeError correctly classifies that as technical, what actually
//      reached the toast was "Something went wrong. Please try again.", which
//      is worse: retrying fails identically forever.
//   3. Nothing helped them find `1041-(Q)`. It was a free-text box.
//
// What this suite pins is BEHAVIOUR, not wording-by-coincidence:
//   • a mode that needs a product refuses a line that has none, and the
//     refusal NAMES THE LINE and is safe to show an operator;
//   • the folded lookup turns `1041 (Q)` into `1041-(Q)` and the spawn
//     succeeds, writing a real product id (never "");
//   • a refused spawn writes NOTHING — no service order, no line, no PO, no
//     case-status flip;
//   • REPAIR, which writes no product-bound row, is NOT blocked by the rule.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping (Node 22.6+) handles the .ts import without a loader.
}
void loaderRegistered;

import {
  SERVICE_MODE_SPECS,
  normaliseProductKey,
  resolveCatalogueProduct,
  validateSpawnLines,
  spawnProblemsMessage,
} from "../src/lib/service-order-modes.ts";
import { looksTechnical, operatorSafeError } from "../src/lib/humanize-error.ts";
import serviceOrdersApp from "../src/api/routes/service-orders.ts";

// The five real VICTORIA BEDFRAME rows, read off production 2026-08-10.
const CATALOGUE = [
  { id: "prod-52", code: "1041-(K)", name: "VICTORIA BEDFRAME (6FT) (183X190CM)" },
  { id: "prod-53", code: "1041-(Q)", name: "VICTORIA BEDFRAME (5FT) (152X190CM)" },
  { id: "prod-54", code: "1041-(S)", name: "VICTORIA BEDFRAME (3FT) (90X190CM)" },
  { id: "prod-56", code: "1041-(SP)", name: "VICTORIA BEDFRAME (107X200CM)" },
  { id: "prod-55", code: "1041-(SS)", name: "VICTORIA BEDFRAME (3.5FT) (107X190CM)" },
];

// ===========================================================================
// Part 1 — the rules, as pure functions.
// ===========================================================================

test("what each mode needs is derived from what it WRITES", () => {
  // Reproduce opens a production order → product_id FK → a real product.
  assert.equal(SERVICE_MODE_SPECS.REPRODUCE.createsProductionOrder, true);
  assert.equal(SERVICE_MODE_SPECS.REPRODUCE.requiresCatalogueProduct, true);
  // Stock Swap consumes an fg_batch, and a batch belongs to one product.
  assert.equal(SERVICE_MODE_SPECS.STOCK_SWAP.consumesFinishedStock, true);
  assert.equal(SERVICE_MODE_SPECS.STOCK_SWAP.requiresCatalogueProduct, true);
  // Repair writes neither — a case can be about something we never sold.
  assert.equal(SERVICE_MODE_SPECS.REPAIR.createsProductionOrder, false);
  assert.equal(SERVICE_MODE_SPECS.REPAIR.consumesFinishedStock, false);
  assert.equal(SERVICE_MODE_SPECS.REPAIR.requiresCatalogueProduct, false);
});

test("the fold collapses exactly the punctuation the operator got wrong", () => {
  assert.equal(normaliseProductKey("1041 (Q)"), "1041Q");
  assert.equal(normaliseProductKey("1041-(Q)"), "1041Q");
  assert.equal(normaliseProductKey("1041(q)"), "1041Q");
  // It must NOT collapse two genuinely different codes together.
  assert.notEqual(normaliseProductKey("1041-(S)"), normaliseProductKey("1041-(SS)"));
  assert.notEqual(normaliseProductKey("1041-(SS)"), normaliseProductKey("1041-(SP)"));
});

test("the reported input resolves: `1041 (Q)` typed into PRODUCT NAME, CODE blank", () => {
  const res = resolveCatalogueProduct(
    { productId: null, productCode: null, productName: "1041 (Q)" },
    CATALOGUE,
  );
  assert.equal(res.status, "resolved");
  assert.equal(res.product.id, "prod-53");
  assert.equal(res.product.code, "1041-(Q)");
});

test("a stale productId does not veto an otherwise good code", () => {
  const res = resolveCatalogueProduct(
    { productId: "prod-DELETED", productCode: "1041-(Q)" },
    CATALOGUE,
  );
  assert.equal(res.status, "resolved");
  assert.equal(res.product.id, "prod-53");
});

test("a prefix that fits several products is AMBIGUOUS, never a silent guess", () => {
  const res = resolveCatalogueProduct({ productCode: "1041" }, CATALOGUE);
  assert.notEqual(res.status, "resolved");
});

test("REPRODUCE with a blank code and an unmatchable name names the line and says what to do", () => {
  const { problems } = validateSpawnLines(
    "REPRODUCE",
    [{ productCode: "", productName: "HB & Divan thing", qty: 1 }],
    CATALOGUE,
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].lineNo, 1);
  const msg = problems[0].message;
  assert.match(msg, /^Line 1 \(/, "must name the line the operator can see");
  assert.match(msg, /Product list/, "must say what to do about it");
  assert.equal(
    looksTechnical(msg),
    false,
    "must survive humanizeError — a technical message becomes the useless generic toast",
  );
  assert.doesNotMatch(msg, /constraint|product_id|production_orders/i);
});

test("a completely empty affected-item row is refused by line number", () => {
  const { problems } = validateSpawnLines(
    "REPRODUCE",
    [{ productCode: "", productName: "", qty: 1 }],
    CATALOGUE,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /^Line 1:/);
});

test("a near miss offers the real code back", () => {
  const { problems } = validateSpawnLines(
    "REPRODUCE",
    [{ productCode: "1041-(QQ)", qty: 1 }],
    CATALOGUE,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /Did you mean/);
  assert.match(problems[0].message, /1041-\(Q\)/);
});

test("the line number in the message is the row the operator sees, not the first bad one", () => {
  const { problems } = validateSpawnLines(
    "REPRODUCE",
    [
      { productCode: "1041-(Q)", qty: 1 },
      { productCode: "", productName: "sofa leg", qty: 1 },
    ],
    CATALOGUE,
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].lineNo, 2);
  assert.match(problems[0].message, /^Line 2 \(/);
});

test("REPAIR is NOT blocked by the product rule — free text is the point of it", () => {
  const { problems, lines } = validateSpawnLines(
    "REPAIR",
    [{ productCode: "", productName: "Customer's own headboard", qty: 1 }],
    CATALOGUE,
  );
  assert.deepEqual(problems, []);
  assert.equal(lines[0].productId, null, "no product is invented for a Repair line");
  assert.equal(lines[0].productName, "Customer's own headboard");
});

test("REPAIR still binds a product when one is recognisable", () => {
  const { lines } = validateSpawnLines(
    "REPAIR",
    [{ productName: "1041 (Q)", qty: 1 }],
    CATALOGUE,
  );
  assert.equal(lines[0].productId, "prod-53");
});

test("REPAIR refuses a row that names nothing at all", () => {
  const { problems } = validateSpawnLines(
    "REPAIR",
    [{ productCode: "", productName: "", qty: 1 }],
    CATALOGUE,
  );
  assert.equal(problems.length, 1);
});

test("the toast sentence always ends by saying nothing was written", () => {
  const { problems } = validateSpawnLines(
    "REPRODUCE",
    [{ productName: "nope", qty: 1 }],
    CATALOGUE,
  );
  const msg = spawnProblemsMessage(problems);
  assert.match(msg, /Nothing was created/);
  assert.equal(looksTechnical(msg), false);
});

// ===========================================================================
// Part 2 — the catch-all is no longer a Postgres megaphone.
// ===========================================================================

test("operatorSafeError swallows the exact string prod returned, keeps a human one", () => {
  const pg =
    'insert or update on table "production_orders" violates foreign key constraint "production_orders_product_id_fkey"';
  assert.equal(looksTechnical(pg), true);
  assert.equal(
    operatorSafeError(new Error(pg), "Couldn't spawn the service order."),
    "Couldn't spawn the service order.",
  );
  assert.equal(
    operatorSafeError(new Error("Order already confirmed"), "fallback"),
    "Order already confirmed",
  );
});

// ===========================================================================
// Part 3 — the route, against an in-memory DB whose batch() is atomic.
// ===========================================================================

function makeDb({ products = CATALOGUE, cases = [], fgBatches = [] } = {}) {
  const state = {
    serviceOrders: [],
    serviceOrderLines: [],
    productionOrders: [],
    cases: cases.map((r) => ({ ...r })),
    fgBatches: fgBatches.map((r) => ({ ...r })),
    // Every statement the route handed to batch(), in order — lets a test
    // assert what WOULD have been written even when nothing was.
    batchCalls: 0,
  };

  // Applying a statement is separated from preparing it so batch() can run the
  // whole list against a COPY and only publish it if every one succeeds. That
  // mirrors SupabaseAdapter.batch, which wraps the list in sql.begin().
  function apply(s, target) {
    const q = s.sql;
    const b = s.bound;
    if (/INSERT INTO service_orders/i.test(q)) {
      target.serviceOrders.push({
        id: b[0], serviceOrderNo: b[1], caseId: b[2], sourceType: b[3],
        sourceId: b[4], sourceNo: b[5], customerId: b[6], customerName: b[7],
        hubId: b[8], mode: b[9], status: b[10], createdBy: b[11],
        createdByName: b[12], createdAt: b[13], closedAt: null, notes: b[14],
      });
      return;
    }
    if (/INSERT INTO service_order_lines/i.test(q)) {
      target.serviceOrderLines.push({
        id: b[0], serviceOrderId: b[1], sourceLineId: b[2], productId: b[3],
        productCode: b[4], productName: b[5], qty: b[6], issueSummary: b[7],
        resolutionProductionOrderId: b[8], resolutionFgBatchId: b[9],
      });
      return;
    }
    if (/INSERT INTO production_orders/i.test(q)) {
      const productId = b[6];
      // The real table has production_orders_product_id_fkey. Reproduce that
      // here so a regression cannot pass the test and fail in prod: an id that
      // is not a known product (including "") is rejected, exactly as Postgres
      // rejects it — and NULL is allowed, exactly as the column allows.
      if (productId !== null && !products.some((p) => p.id === productId)) {
        throw new Error(
          'insert or update on table "production_orders" violates foreign key constraint "production_orders_product_id_fkey"',
        );
      }
      target.productionOrders.push({
        id: b[0], poNo: b[1], serviceOrderId: b[2], lineNo: b[3],
        customerName: b[4], customerState: b[5], productId,
        productCode: b[7], productName: b[8], quantity: b[9],
      });
      return;
    }
    if (/UPDATE service_cases SET status = 'IN_PROGRESS'/i.test(q)) {
      const row = target.cases.find((r) => r.id === b[0] && r.status === "OPEN");
      if (row) row.status = "IN_PROGRESS";
      return;
    }
    if (/UPDATE fg_batches SET remainingQty/i.test(q)) {
      const row = target.fgBatches.find((r) => r.id === b[1]);
      if (row) row.remainingQty -= b[0];
      return;
    }
    // DDL and anything else: no-op.
  }

  function prepare(sql) {
    const s = sql.trim();
    const stmt = {
      sql: s,
      bound: [],
      bind(...args) {
        stmt.bound = args;
        return stmt;
      },
      async first() {
        if (/FROM service_cases WHERE id = \?/i.test(s)) {
          return state.cases.find((r) => r.id === stmt.bound[0]) ?? null;
        }
        if (/COUNT\(\*\) as n FROM service_orders/i.test(s)) {
          return { n: state.serviceOrders.length };
        }
        if (/FROM fg_batches WHERE id = \?/i.test(s)) {
          return state.fgBatches.find((r) => r.id === stmt.bound[0]) ?? null;
        }
        if (/SUM\(remainingQty\)/i.test(s)) {
          const onHand = state.fgBatches
            .filter((r) => r.productId === stmt.bound[0])
            .reduce((a, r) => a + r.remainingQty, 0);
          return { onHand };
        }
        if (/FROM fg_batches\s+WHERE productId = \? AND remainingQty >= \?/i.test(s)) {
          const [pid, need] = stmt.bound;
          const hit = state.fgBatches
            .filter((r) => r.productId === pid && r.remainingQty >= need)
            .sort((a, b) =>
              String(a.completedDate).localeCompare(String(b.completedDate)),
            )[0];
          return hit ? { id: hit.id, remainingQty: hit.remainingQty } : null;
        }
        if (/FROM service_orders WHERE id = \?/i.test(s)) {
          return state.serviceOrders.find((r) => r.id === stmt.bound[0]) ?? null;
        }
        return null;
      },
      async all() {
        if (/SELECT id, code, name FROM products/i.test(s)) {
          return { results: products.map((p) => ({ ...p })) };
        }
        if (/FROM service_order_lines WHERE serviceOrderId = \?/i.test(s)) {
          return {
            results: state.serviceOrderLines.filter(
              (r) => r.serviceOrderId === stmt.bound[0],
            ),
          };
        }
        if (/FROM service_order_returns/i.test(s)) return { results: [] };
        return { results: [] };
      },
      async run() {
        return { success: true };
      },
    };
    return stmt;
  }

  return {
    state,
    db: {
      prepare,
      // ATOMIC, like the real SupabaseAdapter.batch (sql.begin(...)): stage
      // into a deep copy, and only publish once every statement has landed.
      async batch(stmts) {
        state.batchCalls++;
        const staged = {
          serviceOrders: state.serviceOrders.map((r) => ({ ...r })),
          serviceOrderLines: state.serviceOrderLines.map((r) => ({ ...r })),
          productionOrders: state.productionOrders.map((r) => ({ ...r })),
          cases: state.cases.map((r) => ({ ...r })),
          fgBatches: state.fgBatches.map((r) => ({ ...r })),
        };
        for (const s of stmts) apply(s, staged);
        Object.assign(state, staged);
        return stmts.map(() => ({ results: [], success: true, meta: {} }));
      },
    },
  };
}

function mount(db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("userRole", "SUPER_ADMIN");
    c.set("userId", "user-1");
    await next();
  });
  parent.route("/", serviceOrdersApp);
  return parent;
}

const OPEN_CASE = {
  id: "case-1",
  sourceType: "EXTERNAL",
  sourceId: null,
  sourceNo: null,
  customerId: "cust-1",
  customerName: "Ah Seng Furniture",
  customerState: "JOHOR",
  status: "OPEN",
};

async function spawn(app, body) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// --- the reported click, exactly ------------------------------------------

test("REPRODUCE + blank CODE + `1041 (Q)` in PRODUCT NAME now SUCCEEDS, with a real product id", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);

  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "REPRODUCE",
    lines: [
      {
        sourceLineId: null,
        productId: null,
        productCode: null,
        productName: "1041 (Q)",
        qty: 1,
        issueSummary: "HB & Divan Broken",
      },
    ],
  });

  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.success, true);
  assert.equal(state.productionOrders.length, 1);
  // The whole bug in one assertion: a real id, never "".
  assert.equal(state.productionOrders[0].productId, "prod-53");
  assert.equal(state.productionOrders[0].productCode, "1041-(Q)");
  assert.equal(state.serviceOrderLines[0].productId, "prod-53");
  assert.equal(state.serviceOrders[0].status, "IN_PRODUCTION");
  assert.equal(state.cases[0].status, "IN_PROGRESS");
});

test("REPRODUCE with a product nothing in the catalogue matches is refused, naming the line", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);

  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "REPRODUCE",
    lines: [
      { productId: null, productCode: null, productName: "HB & Divan", qty: 1 },
    ],
  });

  assert.equal(status, 400);
  assert.match(json.error, /^Line 1 \(/);
  assert.match(json.error, /Product list/);
  assert.match(json.error, /Nothing was created/);
  assert.equal(
    looksTechnical(json.error),
    false,
    "the operator must not be shown a constraint name — nor the generic toast it degrades into",
  );
  // ...and NOTHING was written.
  assert.deepEqual(state.serviceOrders, []);
  assert.deepEqual(state.serviceOrderLines, []);
  assert.deepEqual(state.productionOrders, []);
  assert.equal(state.cases[0].status, "OPEN", "the case must not flip to IN_PROGRESS");
  assert.equal(state.batchCalls, 0, "the write batch is never even attempted");
});

test("the second of two lines being bad still writes nothing", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);

  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "REPRODUCE",
    lines: [
      { productCode: "1041-(Q)", qty: 1 },
      { productCode: "", productName: "left armrest", qty: 2 },
    ],
  });

  assert.equal(status, 400);
  assert.match(json.error, /Line 2/);
  assert.deepEqual(state.serviceOrders, []);
  assert.deepEqual(state.productionOrders, []);
  assert.equal(state.cases[0].status, "OPEN");
});

test("REPAIR spawns fine with no code at all — the rule is not imposed on it", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);

  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "REPAIR",
    lines: [
      {
        productId: null,
        productCode: null,
        productName: "Customer's own teak headboard",
        qty: 1,
        issueSummary: "Split along the joint",
      },
    ],
  });

  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(state.serviceOrders.length, 1);
  assert.equal(state.serviceOrders[0].status, "OPEN");
  assert.equal(state.serviceOrderLines[0].productId, null);
  assert.deepEqual(state.productionOrders, [], "Repair opens no production order");
});

test("STOCK_SWAP draws the oldest batch of the resolved product and decrements it", async () => {
  const { db, state } = makeDb({
    cases: [OPEN_CASE],
    fgBatches: [
      { id: "FGB-260701-01-aaa", productId: "prod-53", remainingQty: 2, completedDate: "2026-07-01" },
      { id: "FGB-260505-01-bbb", productId: "prod-53", remainingQty: 4, completedDate: "2026-05-05" },
    ],
  });
  const app = mount(db);

  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "STOCK_SWAP",
    lines: [{ productName: "1041 (Q)", qty: 1 }],
  });

  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(state.serviceOrders[0].status, "RESERVED");
  const drawn = state.fgBatches.find((b) => b.id === "FGB-260505-01-bbb");
  assert.equal(drawn.remainingQty, 3, "FIFO: the May batch, not the July one");
  assert.equal(state.serviceOrderLines[0].resolutionFgBatchId, "FGB-260505-01-bbb");
});

test("STOCK_SWAP given a PRODUCT id where a batch id was expected still works", async () => {
  // Every FG picker in the app is fed from /api/inventory, which returns the
  // products table — so `resolutionFgBatchId` has always carried `prod-53`,
  // and the route used to 404 "FG batch prod-53 not found".
  const { db, state } = makeDb({
    cases: [OPEN_CASE],
    fgBatches: [
      { id: "FGB-260505-01-bbb", productId: "prod-53", remainingQty: 4, completedDate: "2026-05-05" },
    ],
  });
  const app = mount(db);

  const { status } = await spawn(app, {
    caseId: "case-1",
    mode: "STOCK_SWAP",
    lines: [{ productCode: "1041-(Q)", qty: 1, resolutionFgBatchId: "prod-53" }],
  });

  assert.equal(status, 201);
  assert.equal(state.fgBatches[0].remainingQty, 3);
});

test("STOCK_SWAP with nothing on hand is refused in plain English, and writes nothing", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE], fgBatches: [] });
  const app = mount(db);

  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "STOCK_SWAP",
    lines: [{ productCode: "1041-(Q)", qty: 1 }],
  });

  assert.equal(status, 409);
  assert.match(json.error, /Line 1 \(1041-\(Q\)\)/);
  assert.match(json.error, /Reproduce|Repair/);
  assert.equal(looksTechnical(json.error), false);
  assert.deepEqual(state.serviceOrders, []);
  assert.equal(state.cases[0].status, "OPEN");
});

test("an empty lines array is refused in words an operator can act on", async () => {
  const { db } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);
  const { status, json } = await spawn(app, {
    caseId: "case-1",
    mode: "REPRODUCE",
    lines: [],
  });
  assert.equal(status, 400);
  assert.match(json.error, /affected item/i);
  assert.equal(looksTechnical(json.error), false);
});

// --- the door the spawn fix would otherwise have left open ------------------

test("PUT /:id/mode → REPRODUCE refuses a product-less line instead of hitting the FK", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);

  // A mode-less order with a free-text line (spawned before a mode was set).
  const spawned = await spawn(app, {
    caseId: "case-1",
    mode: null,
    lines: [{ productName: "some headboard", qty: 1 }],
  });
  assert.equal(spawned.status, 201, JSON.stringify(spawned.json));
  const id = spawned.json.data.id;
  assert.equal(state.serviceOrders[0].mode, null);

  const res = await app.request(`/${id}/mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "REPRODUCE" }),
  });
  const json = await res.json();

  assert.equal(res.status, 400);
  assert.match(json.error, /Line 1/);
  assert.equal(looksTechnical(json.error), false);
  assert.deepEqual(state.productionOrders, []);
  assert.equal(state.serviceOrders[0].mode, null, "the mode must not have moved");
});

test("PUT /:id/mode → REPRODUCE binds the resolved product onto the line", async () => {
  const { db, state } = makeDb({ cases: [OPEN_CASE] });
  const app = mount(db);

  const spawned = await spawn(app, {
    caseId: "case-1",
    mode: null,
    lines: [{ productName: "1041 (Q)", qty: 1 }],
  });
  const id = spawned.json.data.id;

  const res = await app.request(`/${id}/mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "REPRODUCE" }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  assert.equal(state.productionOrders.length, 1);
  assert.equal(state.productionOrders[0].productId, "prod-53");
});

// --- the screen and the server share ONE rule -------------------------------

test("the Spawn dialog validates with the same module the route refuses with", () => {
  const modal = readSource("src/pages/service-cases/detail.tsx");
  const route = readSource("src/api/routes/service-orders.ts");
  for (const src of [modal, route]) {
    assert.match(src, /validateSpawnLines/);
    assert.match(src, /service-order-modes/);
  }
  // The word that started this: the CODE column no longer promises "optional".
  assert.doesNotMatch(
    modal,
    /productCode: e\.target\.value/,
    "the free-text CODE box is gone — the operator picks the product",
  );
  assert.match(modal, /SearchableSelect/, "reuses the app's existing picker");

  // And NEITHER production_orders insert may coerce a missing product to "".
  // `?? ""` is the whole bug: an empty string is not NULL, so Postgres runs
  // the FK check on it. (The read serialiser further up the file legitimately
  // nulls-to-"" on the wire, so this is scoped to the INSERT bind blocks.)
  const inserts = [...route.matchAll(/INSERT INTO production_orders/g)].map(
    (m) => route.slice(m.index, m.index + 1400),
  );
  assert.equal(inserts.length, 2, "spawn + set-mode; a third would need the same guard");
  for (const block of inserts) {
    assert.doesNotMatch(block, /productId \?\? ""/);
  }
});

function readSource(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
