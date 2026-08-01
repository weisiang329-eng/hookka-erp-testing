// ---------------------------------------------------------------------------
// party-name-propagate.test.mjs — a party rename must reach every table that
// snapshotted the name (owner 2026-08-01: 「全部回填，包括发票」).
//
// Measured regression: renaming supplier 400-A002 from "ADD WOORD TRADING SDN.
// BHD." to "ADD WOOD…" left all 24 purchase invoices and 13 purchase orders
// showing the typo, because those tables store supplier_name and never join
// suppliers on read.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  propagateCustomerName,
  propagateSupplierName,
  PROPAGATE_TABLES,
} from "../src/api/lib/party-name-propagate.ts";

/** Records every statement instead of running it. */
function stubDb({ failOn = [] } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async run() {
              const table = /UPDATE (\w+)/.exec(sql)?.[1];
              if (failOn.includes(table)) {
                throw new Error(`relation "${table}" does not exist`);
              }
              calls.push({ sql, binds, table });
              return { meta: { changes: 3 } };
            },
          };
        },
      };
    },
  };
}

test("supplier rename updates every supplier snapshot table, keyed by id", async () => {
  const db = stubDb();
  const r = await propagateSupplierName(db, "sup-1", "ADD WOORD TRADING SDN. BHD.", "ADD WOOD TRADING SDN. BHD.");
  assert.equal(r.changed, true);
  const touched = db.calls.map((c) => c.table).sort();
  assert.deepEqual(touched, [...PROPAGATE_TABLES.supplierIdTables].sort());
  // The tables that actually held the stale typo must be in there.
  for (const t of ["purchase_invoices", "purchase_orders", "grns"]) {
    assert.ok(touched.includes(t), `${t} must be updated`);
  }
  // Every supplier table is id-keyed — none may fall back to name matching.
  assert.ok(db.calls.every((c) => /WHERE supplier_id = \?/.test(c.sql)));
  assert.ok(db.calls.every((c) => c.binds[0] === "ADD WOOD TRADING SDN. BHD." && c.binds[1] === "sup-1"));
  assert.equal(r.totalRows, PROPAGATE_TABLES.supplierIdTables.length * 3);
});

test("owner ruling: financial documents are included, not skipped", async () => {
  const db = stubDb();
  await propagateSupplierName(db, "sup-1", "Old", "New");
  const touched = db.calls.map((c) => c.table);
  for (const t of ["purchase_invoices", "purchase_credit_notes", "supplier_payments", "ap_aging"]) {
    assert.ok(touched.includes(t), `${t} must be propagated (owner: 全部回填，包括发票)`);
  }
  const cust = stubDb();
  await propagateCustomerName(cust, "cust-1", "Old", "New");
  const ct = cust.calls.map((c) => c.table);
  for (const t of ["invoices", "e_invoices", "credit_notes", "debit_notes", "payment_records", "ar_aging"]) {
    assert.ok(ct.includes(t), `${t} must be propagated`);
  }
});

test("customer rename: id-keyed tables by id, the 7 id-less tables by old name", async () => {
  const db = stubDb();
  await propagateCustomerName(db, "cust-1", "Old Name Sdn Bhd", "New Name Sdn Bhd");
  const byId = db.calls.filter((c) => /WHERE customer_id = \?/.test(c.sql)).map((c) => c.table);
  const byName = db.calls.filter((c) => /WHERE customer_name = \?/.test(c.sql)).map((c) => c.table);
  assert.deepEqual(byId.sort(), [...PROPAGATE_TABLES.customerIdTables].sort());
  assert.deepEqual(byName.sort(), [...PROPAGATE_TABLES.customerNameOnlyTables].sort());
  // Name-matched statements bind (newName, oldName) — never the id.
  for (const c of db.calls.filter((x) => byName.includes(x.table))) {
    assert.deepEqual(c.binds, ["New Name Sdn Bhd", "Old Name Sdn Bhd"]);
  }
});

test("no-op when the name did not change, or the new name is blank", async () => {
  for (const [oldN, newN] of [["Same", "Same"], ["Same", "  Same  "], ["Something", ""], ["Something", null]]) {
    const db = stubDb();
    const r = await propagateSupplierName(db, "sup-1", oldN, newN);
    assert.equal(r.changed, false, `${oldN} → ${newN} must be a no-op`);
    assert.equal(db.calls.length, 0);
  }
});

test("a blank OLD name skips name-matched tables (would hit every NULL row)", async () => {
  const db = stubDb();
  await propagateCustomerName(db, "cust-1", "", "Brand New");
  const byName = db.calls.filter((c) => /WHERE customer_name = \?/.test(c.sql));
  assert.equal(byName.length, 0, "must not mass-update rows on an empty match key");
  // id-keyed tables still run — those are unambiguous.
  assert.equal(db.calls.length, PROPAGATE_TABLES.customerIdTables.length);
});

test("a missing table is recorded and never aborts the rest", async () => {
  const db = stubDb({ failOn: ["three_way_matches", "goods_in_transit"] });
  const r = await propagateSupplierName(db, "sup-1", "Old", "New");
  const failed = r.tables.filter((t) => t.updated === null);
  assert.deepEqual(failed.map((t) => t.table).sort(), ["goods_in_transit", "three_way_matches"]);
  assert.ok(failed.every((t) => typeof t.error === "string" && t.error.length > 0));
  // The remaining 6 still ran.
  assert.equal(r.tables.filter((t) => t.updated !== null).length, PROPAGATE_TABLES.supplierIdTables.length - 2);
  assert.equal(r.totalRows, (PROPAGATE_TABLES.supplierIdTables.length - 2) * 3);
});

// Registry drift guard: the table lists were derived from the migrations. If a
// new table starts snapshotting a party name, this fails until it's registered.
test("registry covers every table that snapshots a party name", () => {
  const sql = ["migrations-postgres/0001_init.sql", "migrations-postgres/0010_accounting.sql",
    "migrations-postgres/0057_purchase_invoices.sql", "migrations-postgres/0064_consignment_orders.sql",
    "migrations-postgres/0119_supplier_payments.sql", "migrations-postgres/0156_purchase_credit_notes.sql"]
    .map((p) => readFileSync(p, "utf8")).join("\n");
  const known = new Set([
    ...PROPAGATE_TABLES.customerIdTables,
    ...PROPAGATE_TABLES.customerNameOnlyTables,
    ...PROPAGATE_TABLES.supplierIdTables,
  ]);
  const missing = [];
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = m;
    if (/^\s*(customer_name|supplier_name)\s/m.test(body) && !known.has(table)) missing.push(table);
  }
  assert.deepEqual(missing, [], `unregistered snapshot table(s): ${missing.join(", ")} — add to party-name-propagate.ts`);
});

test("both PUT routes call the propagation on a name change", () => {
  const sup = readFileSync("src/api/routes/suppliers.ts", "utf8");
  const cus = readFileSync("src/api/routes/customers.ts", "utf8");
  assert.match(sup, /merged\.name !== existing\.name/);
  assert.match(sup, /propagateSupplierName\(/);
  assert.match(cus, /merged\.name !== existing\.name/);
  assert.match(cus, /propagateCustomerName\(/);
});
