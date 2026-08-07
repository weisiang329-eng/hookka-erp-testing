// ---------------------------------------------------------------------------
// invoice-dedupe-guard.test.mjs — the storage-layer guard against billing the
// same delivered goods twice.
//
// HISTORY. The double-invoice bug was "fixed" twice (staging 07-14, prod 07-23
// cleanup) and kept RECURRING because the only guard was an application
// check-then-write with a race window. Migration 0208 closed it with a partial
// unique index, `uniq_invoice_active_delivery_order`, so a delivery order could
// hold at most ONE active invoice.
//
// 2026-08-07 — THE GUARD MOVED. One delivery order can now be billed by several
// invoices (owner: 「我应该可以在其中一个 Purchase Invoice 里面 delete 掉，然后
// 重新 generate 成另外一个 Invoice」), so "at most one active invoice" is no
// longer the invariant to protect — it IS the thing being removed. The
// invariant that survives is the one that actually prevents over-billing:
//
//     Σ invoiced_qty on a delivery line can never exceed what was delivered.
//
// That is `chk_doi_invoiced_qty` on delivery_order_items. The race is unchanged
// in shape (two concurrent creates both passing the application check); only
// what the storage layer rejects has moved from "a second row" to "a second
// row that over-draws". This file follows the guard rather than the index, so
// the prevention still cannot be silently dropped.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const SRC = read("src/api/routes/invoices.ts");
const CHAIN = read("src/api/lib/do-partial-invoice.ts");

const migrations = () => {
  const dir = resolve(process.cwd(), "migrations-postgres");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(dir, f), "utf8"));
};

test("a migration records the ceiling constraint that replaces the old index", () => {
  const hit = migrations().find((s) => /chk_doi_invoiced_qty/.test(s));
  assert.ok(hit, "a migration must define chk_doi_invoiced_qty");
  assert.match(hit, /CHECK \(invoiced_qty >= 0 AND invoiced_qty <= quantity\)/);
  assert.match(
    hit,
    /DROP INDEX IF EXISTS uniq_invoice_active_delivery_order/,
    "the index it replaces must be dropped in the SAME migration — leaving both " +
      "would make the very first second invoice fail at INSERT",
  );
});

test("the constraint AND the drop are self-applied at runtime, together", () => {
  // deploy.yml does not replay migration files (CLAUDE.md), so this is the
  // load-bearing copy. They must live in ONE self-apply: applying the drop
  // without the CHECK would leave over-billing completely unguarded.
  assert.match(CHAIN, /function ensureDoPartialInvoiceColumns/);
  assert.match(CHAIN, /ADD CONSTRAINT chk_doi_invoiced_qty CHECK \(invoiced_qty >= 0 AND invoiced_qty <= quantity\)/);
  assert.match(CHAIN, /DROP INDEX IF EXISTS uniq_invoice_active_delivery_order/);
  assert.match(
    SRC,
    /await ensureDoPartialInvoiceColumns\(c\.var\.DB\)/,
    "the create-invoice POST must apply it before writing",
  );
});

test("nothing re-creates the retired index", () => {
  // The old runtime self-apply ran on every POST. Left in place it would
  // re-create the index straight after the drop, and one-DO-many-invoices
  // would fail with a duplicate-key error that points nowhere useful.
  assert.doesNotMatch(
    SRC,
    /CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_delivery_order/,
    "invoices.ts must no longer create uniq_invoice_active_delivery_order",
  );
});

test("a ceiling violation on insert returns a graceful 409, not a raw 500", () => {
  assert.match(
    SRC,
    /chk_doi_invoiced_qty\|check constraint/,
    "the INSERT batch must catch the storage-layer ceiling violation (the race " +
      "loser) and return a 409 saying how much is actually left — the same " +
      "shape the app-level guard returns.",
  );
  assert.match(
    SRC,
    /uniq_invoice_active_delivery_order\|duplicate key\|23505/,
    "and keep handling the legacy unique violation, for any deployment where " +
      "the index drop has not yet run",
  );
});
