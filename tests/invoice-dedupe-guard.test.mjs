// ---------------------------------------------------------------------------
// invoice-dedupe-guard.test.mjs — pins the DB-level fix for BUG-2026-07-14-006.
//
// The double-invoice bug was "fixed" twice (staging 07-14, prod 07-23 cleanup)
// but kept RECURRING because the only guard was an application check-then-write
// with a race window, and the definitive DB constraint was deferred. On
// 2026-07-23 four more duplicates appeared on prod. This test locks in the
// partial-unique index so the prevention can't be dropped again.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(process.cwd(), "src/api/routes/invoices.ts"), "utf8");

test("a migration creates the partial-unique index on (delivery_order_id) WHERE not cancelled", () => {
  const dir = resolve(process.cwd(), "migrations-postgres");
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .find((s) => /uniq_invoice_active_delivery_order/.test(s));
  assert.ok(hit, "a migration must define uniq_invoice_active_delivery_order");
  assert.match(hit, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_delivery_order/);
  assert.match(hit, /WHERE status <> 'CANCELLED'/, "must be PARTIAL — a cancelled invoice must not block re-invoicing");
});

test("the index is self-applied at runtime (deploy.yml does not replay migrations)", () => {
  assert.match(SRC, /function ensureInvoiceDedupeIndex/, "runtime self-apply must exist");
  assert.match(
    SRC,
    /CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_delivery_order/,
    "self-apply must create the same partial-unique index",
  );
  assert.match(
    SRC,
    /await ensureInvoiceDedupeIndex\(c\.var\.DB\)/,
    "the create-invoice POST must call ensureInvoiceDedupeIndex before writing",
  );
});

test("a unique-violation on insert returns a graceful 409, not a raw 500", () => {
  assert.match(
    SRC,
    /uniq_invoice_active_delivery_order\|duplicate key\|23505/,
    "the INSERT batch must catch the storage-layer unique violation (the race loser) " +
      "and return the existing invoice as a 409 — the same shape the app-level guard returns.",
  );
});
