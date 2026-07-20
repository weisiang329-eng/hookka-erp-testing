import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const invoiceRoute = readFileSync("src/api/routes/invoices.ts", "utf8");
const migration = readFileSync(
  "migrations-postgres/0209_invoice_active_do_unique.sql",
  "utf8",
);

test("invoice POST keeps the friendly active-DO pre-check", () => {
  assert.match(
    invoiceRoute,
    /SELECT id, invoiceNo FROM invoices WHERE deliveryOrderId = \? AND orgId = \? AND status != 'CANCELLED' LIMIT 1/,
  );
  assert.match(invoiceRoute, /existingInvoiceId:/);
  assert.match(invoiceRoute, /existingInvoiceNo:/);
});

test("Postgres closes the concurrent window with a partial unique index", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_one_active_per_do/,
  );
  assert.match(migration, /ON invoices \(org_id, delivery_order_id\)/);
  assert.match(migration, /GROUP BY org_id, delivery_order_id/);
  assert.match(migration, /WHERE status <> 'CANCELLED'/);
  assert.match(migration, /HAVING COUNT\(\*\) > 1/);
  assert.match(migration, /RAISE EXCEPTION/);
});

test("invoice creation scopes every read and write to the active tenant", () => {
  assert.match(invoiceRoute, /FROM delivery_orders WHERE id = \? AND orgId = \?/);
  assert.match(invoiceRoute, /updated_at, orgId\s*\n\s*\) VALUES/);
  assert.match(invoiceRoute, /discountSen, totalSen, orgId\s*\n\s*\) VALUES/);
  assert.match(invoiceRoute, /WHERE id = \? AND orgId = \?/);
});
