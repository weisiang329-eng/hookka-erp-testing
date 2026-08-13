// ---------------------------------------------------------------------------
// inventory-buckets-projection.test.mjs — proof that `?buckets=` on
// GET /api/inventory is a strict SUBSET of the unprojected response, never a
// different one.
//
// Why this test exists (BUG-2026-08-13-020/-021): /api/inventory is 1.16 MB
// (PERF-BACKLOG P6) and was fetched WHOLE by twenty call sites, nineteen of which
// read exactly ONE of its three buckets. The fix adds `?buckets=<csv>` and points
// each of those nineteen at the bucket it consumes. (The twentieth,
// inventory/index.tsx's fallback, reads two and is deliberately left whole.)
//
// The risk that fix carries is the one PERF-BACKLOG calls out: "a narrowed
// query that silently drops or reorders rows is a worse bug than a slow page."
// The endpoint has no live coverage this branch can reach, so the guarantee is
// pinned here instead — by running the REAL route (src/api/routes/inventory.ts)
// against a stub DB and comparing the projected response, key by key and row by
// row, against the unprojected one from the same fixture.
//
// It also pins the two things a future "cleanup" could quietly get wrong:
//   • an unrecognised bucket must degrade to ALL THREE, never to an empty page.
//     An empty inventory response is indistinguishable from "there is no
//     stock" — the exact failure shape BUG-2026-08-13-005 was about.
//   • the SELECTs for unrequested buckets must not run at all. If they still
//     run and are merely dropped from the JSON, the endpoint is no faster and
//     the whole change is theatre.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/api/routes/inventory.ts";

// --- Fixture rows, shaped like the real tables ------------------------------
const PRODUCT_ROWS = [
  {
    id: "prod-1", code: "BF-001", name: "Alpha Bedframe", category: "BEDFRAME",
    description: "Alpha", baseModel: "ALPHA", sizeCode: "Q", sizeLabel: "Queen",
    fabricUsage: 3.5, unitM3: 1.2, status: "ACTIVE", costPriceSen: 12345,
    basePriceSen: 99900, price1Sen: 89900, productionTimeMinutes: 120,
    subAssemblies: '["HB","DIVAN"]', skuCode: "SKU-1", fabricColor: "Grey",
    pieces: '{"count":3,"names":["Headboard","Divan","Divan"]}',
    seatHeightPrices: '[{"height":"18","priceSen":1000}]',
  },
  {
    id: "prod-2", code: "SF-002", name: "Beta Sofa", category: "SOFA",
    description: null, baseModel: null, sizeCode: null, sizeLabel: null,
    fabricUsage: 12, unitM3: 2.4, status: "ACTIVE", costPriceSen: 50000,
    basePriceSen: null, price1Sen: null, productionTimeMinutes: 300,
    subAssemblies: null, skuCode: null, fabricColor: null, pieces: null,
    seatHeightPrices: null,
  },
];
const WIP_ROWS = [
  { id: "wip-1", code: "W-1", type: "FRAME", relatedProduct: "BF-001", deptStatus: "CUT", stockQty: 4, status: "ACTIVE" },
  { id: "wip-2", code: "W-2", type: "FOAM", relatedProduct: null, deptStatus: null, stockQty: 0, status: "ACTIVE" },
];
const RM_ROWS = [
  { id: "rm-1", itemCode: "FAB-001", description: "Grey fabric", baseUOM: "M", itemGroup: "FABRIC", isActive: 1, balanceQty: 120.5, minStock: 20, maxStock: 400 },
  { id: "rm-2", itemCode: "SCR-002", description: "Screw 6mm", baseUOM: "PCS", itemGroup: "HARDWARE", isActive: 0, balanceQty: 0, minStock: null, maxStock: null },
];

/**
 * Stub DB that answers by table name and records every SQL string it was
 * handed, so the test can assert which SELECTs actually ran.
 */
function makeDB(issued) {
  return {
    prepare(sql) {
      issued.push(sql);
      const rows = /FROM products/.test(sql)
        ? PRODUCT_ROWS
        : /FROM wip_items/.test(sql)
          ? WIP_ROWS
          : /FROM raw_materials/.test(sql)
            ? RM_ROWS
            : [];
      return {
        bind: () => ({ all: async () => ({ results: rows }) }),
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
        run: async () => ({ success: true }),
      };
    },
  };
}

// c.var.DB is set by a worker-level middleware in production. Reproduce it by
// wrapping the sub-app in a parent that injects the stub, which is exactly what
// worker.ts does and keeps this test independent of Hono's env-passing shape.
async function call(url) {
  const { Hono } = await import("hono");
  const issued = [];
  const DB = makeDB(issued);
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", DB);
    await next();
  });
  parent.route("/api/inventory", app);
  const res = await parent.request(`/api/inventory${url}`);
  return { status: res.status, body: await res.json(), issued };
}

test("no param returns all three buckets — the pre-existing contract", async () => {
  const { status, body } = await call("");
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ["finishedProducts", "rawMaterials", "wipItems"],
    "an unprojected call must still carry every bucket — inventory/index.tsx's " +
      "fallback still relies on it",
  );
  assert.equal(body.data.finishedProducts.length, 2);
  assert.equal(body.data.wipItems.length, 2);
  assert.equal(body.data.rawMaterials.length, 2);
});

test("each projected bucket is byte-identical to the same bucket unprojected", async () => {
  const full = (await call("")).body;
  for (const bucket of ["finishedProducts", "wipItems", "rawMaterials"]) {
    const { body } = await call(`?buckets=${bucket}`);
    assert.deepEqual(
      Object.keys(body.data),
      [bucket],
      `?buckets=${bucket} must emit that key and no other`,
    );
    // Deep-equal covers row COUNT, row ORDER and every field of every row —
    // the three ways a narrowed read silently changes what a page renders.
    assert.deepEqual(
      body.data[bucket],
      full.data[bucket],
      `?buckets=${bucket} changed the ${bucket} array`,
    );
    // Belt and braces: same JSON text, so no key-order or numeric-format drift
    // can hide inside deepEqual's structural comparison.
    assert.equal(
      JSON.stringify(body.data[bucket]),
      JSON.stringify(full.data[bucket]),
    );
  }
});

test("a multi-bucket request is the union, still identical row for row", async () => {
  const full = (await call("")).body;
  const { body } = await call("?buckets=rawMaterials,wipItems");
  assert.deepEqual(Object.keys(body.data).sort(), ["rawMaterials", "wipItems"]);
  assert.deepEqual(body.data.rawMaterials, full.data.rawMaterials);
  assert.deepEqual(body.data.wipItems, full.data.wipItems);
});

test("unrequested buckets are NOT queried — the point of the change", async () => {
  const { issued } = await call("?buckets=rawMaterials");
  const joined = issued.join("\n");
  assert.match(joined, /FROM raw_materials/);
  assert.doesNotMatch(
    joined,
    /FROM products/,
    "the 365-row product catalogue must not be SELECTed when it was not asked for",
  );
  assert.doesNotMatch(joined, /FROM wip_items/);
});

test("an unrecognised bucket degrades to all three, never to an empty page", async () => {
  // A typo'd or renamed bucket must not blank an inventory picker: an empty
  // response reads exactly like "there is no stock" (BUG-2026-08-13-005's
  // failure shape). Serving more than asked is recoverable; serving nothing
  // is a lie.
  for (const q of ["?buckets=", "?buckets=nonsense", "?buckets=finishedgoods"]) {
    const { body } = await call(q);
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ["finishedProducts", "rawMaterials", "wipItems"],
      `${q} should fall back to the full response`,
    );
  }
});

test("known buckets survive whitespace and unknown neighbours", async () => {
  const { body } = await call("?buckets=rawMaterials%20,%20bogus");
  assert.deepEqual(Object.keys(body.data), ["rawMaterials"]);
});

test("`finishedGoods` is NOT a bucket name — the dead key stays dead", async () => {
  // suppliers/detail.tsx read `data.finishedGoods` for months and got nothing,
  // because the endpoint's finished-goods bucket is `finishedProducts`
  // (BUG-2026-08-13-024). Anyone who re-introduces that spelling should land
  // on the safe fallback, not on a silently empty picker.
  const { body } = await call("?buckets=finishedGoods");
  assert.equal(
    body.data.finishedGoods,
    undefined,
    "the endpoint must never emit a `finishedGoods` key",
  );
  assert.ok(Array.isArray(body.data.finishedProducts));
});
