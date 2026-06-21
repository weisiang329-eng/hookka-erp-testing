// ---------------------------------------------------------------------------
// supplier-effective-pricing.test.mjs — behavioral test of effective-dated
// supplier pricing, driven through the REAL supplier-materials.ts Hono route
// handlers against a stateful in-memory mock D1.
//
// Asserts:
//   • POST stamps effectiveFrom on the binding and seeds an opening
//     price_histories row (oldPrice 0 → "first price").
//   • PUT with a NEW price + a NEW effectiveFrom updates the binding's price +
//     effectiveFrom AND appends a price_histories row whose oldPrice is the
//     previous binding price (the "previous effective row's price").
//   • PUT that does NOT change the price appends NO new history row (and does
//     not bump effectiveFrom).
//   • The price-history trail is append-only — every change adds a row; none
//     are overwritten.
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

const smbApp = (
  await import(
    pathToFileURL(
      resolve(process.cwd(), "src/api/routes/supplier-materials.ts"),
    ).href,
  )
).default;

// ---------------------------------------------------------------------------
// Minimal stateful in-memory mock D1 — implements just the statements the
// supplier-materials route issues against supplier_material_bindings and
// price_histories. Identifiers are written camelCase in route SQL.
// ---------------------------------------------------------------------------
function makeDb() {
  const tables = {
    supplier_material_bindings: [],
    price_histories: [],
  };
  const norm = (s) => s.trim().replace(/\s+/g, " ");

  function prepare(rawSql) {
    const sql = norm(rawSql);
    let binds = [];
    return {
      bind(...args) {
        binds = args;
        return this;
      },
      async run() {
        exec(sql, binds);
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        // Return an independent snapshot (real D1/Postgres hand back a fresh
        // object, not a live reference into storage) so a subsequent UPDATE
        // doesn't retroactively mutate a row the handler already read.
        const r = query(sql, binds)[0];
        return r ? { ...r } : null;
      },
      async all() {
        return { results: query(sql, binds).map((r) => ({ ...r })) };
      },
    };
  }

  function exec(sql, binds) {
    if (/^ALTER TABLE/i.test(sql) || /^CREATE/i.test(sql)) return;
    let m = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]*)\)/i);
    if (m) {
      const table = m[1];
      const cols = m[2].split(",").map((c) => c.trim());
      const row = {};
      cols.forEach((col, i) => {
        row[col] = binds[i];
      });
      tables[table].push(row);
      return;
    }
    m = sql.match(/^UPDATE supplier_material_bindings SET (.+) WHERE id = \?/i);
    if (m) {
      const setClause = m[1];
      const nSet = (setClause.match(/\?/g) || []).length;
      const id = binds[nSet];
      const row = tables.supplier_material_bindings.find(
        (r) => String(r.id) === String(id),
      );
      if (row) {
        let bi = 0;
        for (const part of setClause.split(",")) {
          const eq = part.trim().match(/^(\w+) = \?$/);
          if (eq) row[eq[1]] = binds[bi++];
        }
      }
      return;
    }
    m = sql.match(/^DELETE FROM (\w+) WHERE id = \?/i);
    if (m) {
      const table = m[1];
      tables[table] = tables[table].filter(
        (r) => String(r.id) !== String(binds[0]),
      );
      return;
    }
  }

  function query(sql, binds) {
    // SELECT * FROM supplier_material_bindings WHERE id = ?
    let m = sql.match(
      /^SELECT \* FROM supplier_material_bindings WHERE id = \?/i,
    );
    if (m) {
      return tables.supplier_material_bindings.filter(
        (r) => String(r.id) === String(binds[0]),
      );
    }
    // SELECT * FROM supplier_material_bindings WHERE orgId = ? [AND supplierId = ?] [AND materialCode = ?] ORDER BY ...
    m = sql.match(/^SELECT \* FROM supplier_material_bindings WHERE (.+?)( ORDER BY .+)?$/i);
    if (m) {
      const preds = m[1].split(/ AND /i).map((p) => p.trim());
      let rows = tables.supplier_material_bindings.slice();
      let bi = 0;
      for (const p of preds) {
        const eq = p.match(/^(\w+) = \?$/);
        if (eq) {
          const col = eq[1];
          const val = binds[bi++];
          // orgId isn't a stored column in the mock rows — skip filtering on it.
          if (col === "orgId") continue;
          rows = rows.filter((r) => String(r[col]) === String(val));
        }
      }
      return rows;
    }
    // price_histories reads (not used by these route paths, but support it)
    if (/^SELECT \* FROM price_histories/i.test(sql)) {
      return tables.price_histories.slice();
    }
    return [];
  }

  return { prepare, _tables: tables };
}

// Build a Hono app that injects DB + auth context, then mounts the real route.
function makeApp(db) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("userRole", "SUPER_ADMIN");
    c.set("orgId", "hookka");
    await next();
  });
  app.route("/api/supplier-materials", smbApp);
  return app;
}

test("POST stamps effectiveFrom + seeds an opening price-history row", async () => {
  const db = makeDb();
  const app = makeApp(db);
  const res = await app.request("/api/supplier-materials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      supplierId: "sup-1",
      materialCode: "RM-100",
      materialName: "Foam 9MM",
      supplierSku: "F9",
      unitPrice: 1000,
      effectiveFrom: "2026-06-01",
    }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.data.effectiveFrom, "2026-06-01");
  // priceValidFrom mirrors effectiveFrom for back-compat consumers.
  assert.equal(json.data.priceValidFrom, "2026-06-01");

  const hist = db._tables.price_histories;
  assert.equal(hist.length, 1, "an opening history row is seeded");
  assert.equal(Number(hist[0].oldPrice), 0, "opening price old = 0");
  assert.equal(Number(hist[0].newPrice), 1000);
  assert.equal(hist[0].effectiveFrom, "2026-06-01");
});

test("PUT price change appends an append-only history row (old = prior price) and bumps effectiveFrom", async () => {
  const db = makeDb();
  const app = makeApp(db);
  const created = await (
    await app.request("/api/supplier-materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierId: "sup-1",
        materialCode: "RM-100",
        materialName: "Foam 9MM",
        supplierSku: "F9",
        unitPrice: 1000,
        effectiveFrom: "2026-06-01",
      }),
    })
  ).json();
  const id = created.data.id;

  const res = await app.request(`/api/supplier-materials/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      unitPrice: 1200,
      effectiveFrom: "2026-06-30",
      changedBy: "Wei Siang",
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.unitPrice, 1200);
  assert.equal(json.data.effectiveFrom, "2026-06-30", "binding effectiveFrom bumped");

  const hist = db._tables.price_histories;
  assert.equal(hist.length, 2, "trail is append-only: opening + the change");
  const change = hist[1];
  assert.equal(Number(change.oldPrice), 1000, "old = previous binding price");
  assert.equal(Number(change.newPrice), 1200);
  assert.equal(change.effectiveFrom, "2026-06-30", "history carries the effective date");
  assert.equal(change.changedBy, "Wei Siang");
});

test("PUT with unchanged price appends NO new history row and keeps effectiveFrom", async () => {
  const db = makeDb();
  const app = makeApp(db);
  const created = await (
    await app.request("/api/supplier-materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierId: "sup-1",
        materialCode: "RM-100",
        materialName: "Foam 9MM",
        supplierSku: "F9",
        unitPrice: 1000,
        effectiveFrom: "2026-06-01",
      }),
    })
  ).json();
  const id = created.data.id;

  // Edit only a non-price field; price stays 1000.
  const res = await app.request(`/api/supplier-materials/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moq: 50, leadTimeDays: 14 }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.moq, 50);
  assert.equal(json.data.effectiveFrom, "2026-06-01", "effectiveFrom unchanged");

  const hist = db._tables.price_histories;
  assert.equal(hist.length, 1, "only the opening row — no change logged");
});
