// The camelCase → snake_case normaliser behind /api/admin/health/db-indexes.
//
// This exists because of a real false alarm: the first version of that
// endpoint compared expectations written as `salesOrderId` against Postgres
// columns actually named `sales_order_id`, and reported 12 of 14 indexes
// "missing" on a database that had every one of them. A monitoring endpoint
// that cries wolf is worse than no monitoring endpoint, so the translation is
// pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const mod = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/admin-health.ts")).href
);

test("snakeCase — the real column names this endpoint compares", () => {
  assert.equal(mod.snakeCase("salesOrderId"), "sales_order_id");
  assert.equal(mod.snakeCase("productionOrderId"), "production_order_id");
  assert.equal(mod.snakeCase("departmentCode"), "department_code");
  assert.equal(mod.snakeCase("deliveryOrderId"), "delivery_order_id");
  assert.equal(mod.snakeCase("customerId"), "customer_id");
  assert.equal(mod.snakeCase("accountCode"), "account_code");
  assert.equal(mod.snakeCase("postedAt"), "posted_at");
  assert.equal(mod.snakeCase("sourceType"), "source_type");
});

test("snakeCase — already snake_case passes through unchanged", () => {
  // Both sides of the comparison run through this, so it has to be idempotent
  // or the Postgres-side name would get mangled instead.
  assert.equal(mod.snakeCase("sales_order_id"), "sales_order_id");
  assert.equal(mod.snakeCase(mod.snakeCase("salesOrderId")), "sales_order_id");
});

test("snakeCase — acronym runs split before the next word, not inside it", () => {
  assert.equal(mod.snakeCase("orgId"), "org_id");
  assert.equal(mod.snakeCase("customerSOId"), "customer_so_id");
  assert.equal(mod.snakeCase("piNo"), "pi_no");
});

test("snakeCase — single words and empty input are left alone", () => {
  assert.equal(mod.snakeCase("status"), "status");
  assert.equal(mod.snakeCase(""), "");
});

const idx = (tablename, indexname, def) => ({ tablename, indexname, indexdef: def });

test("indexSatisfying — a camelCase expectation matches the snake_case index", () => {
  // The real shape on prod: expectation `sales_order_items(salesOrderId)`,
  // index `idx_so_items_sales_order_id ON sales_order_items (sales_order_id)`.
  const rows = [
    idx("sales_order_items", "idx_so_items_sales_order_id",
      "CREATE INDEX idx_so_items_sales_order_id ON public.sales_order_items USING btree (sales_order_id)"),
  ];
  assert.equal(
    mod.indexSatisfying(rows, "sales_order_items", ["salesOrderId"]),
    "idx_so_items_sales_order_id",
  );
});

test("indexSatisfying — a composite index serves a prefix of its columns", () => {
  // idx_lje_org is (org_id, posted_at); a plain (orgId) need is covered.
  const rows = [
    idx("ledger_journal_entries", "idx_lje_org",
      "CREATE INDEX idx_lje_org ON public.ledger_journal_entries USING btree (org_id, posted_at DESC)"),
  ];
  assert.equal(mod.indexSatisfying(rows, "ledger_journal_entries", ["orgId"]), "idx_lje_org");
  assert.equal(
    mod.indexSatisfying(rows, "ledger_journal_entries", ["orgId", "postedAt"]),
    "idx_lje_org",
  );
});

test("indexSatisfying — a prefix in the WRONG order is not a match", () => {
  // (posted_at, org_id) cannot serve a lookup that leads with org_id.
  const rows = [
    idx("ledger_journal_entries", "idx_wrong_order",
      "CREATE INDEX idx_wrong_order ON public.ledger_journal_entries USING btree (posted_at, org_id)"),
  ];
  assert.equal(mod.indexSatisfying(rows, "ledger_journal_entries", ["orgId"]), null);
});

test("indexSatisfying — an index on another table never counts", () => {
  const rows = [
    idx("delivery_order_items", "idx_doi_do",
      "CREATE INDEX idx_doi_do ON public.delivery_order_items USING btree (delivery_order_id)"),
  ];
  assert.equal(mod.indexSatisfying(rows, "sales_order_items", ["deliveryOrderId"]), null);
});

test("indexSatisfying — genuinely absent returns null, not a false positive", () => {
  assert.equal(mod.indexSatisfying([], "job_cards", ["productionOrderId"]), null);
});
