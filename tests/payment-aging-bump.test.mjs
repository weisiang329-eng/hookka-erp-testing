// ---------------------------------------------------------------------------
// payment-aging-bump.test.mjs — every customer-payment mutation must nudge the
// aging snapshot.
//
// The /aging snapshot rebuilds when a PROBED source table changes; it probes
// kv_config, not payment_records. A payment edit rewrites payment_records and
// bumps invoice paidAmount without touching updated_at — no probed write, so
// the snapshot keeps serving the old set forever.
//
// The supplier side hit this on 2026-07-09 (BUG-2026-07-09-002: voiding an
// advance left phantom aging rows) and got bumpSupplierPaymentsRev. The
// customer side had the SAME hole until 2026-08-06: the owner re-allocated two
// Carress receipts and the aging kept reading 140,473.32 while every live
// endpoint said 126,055.32. Same class, same cure, this time with a test that
// counts the call sites so a new batch can't ship without the bump.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/payments.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

test("the bump helper exists and writes a PROBED table", () => {
  assert.match(SRC, /function bumpPaymentRecordsRev/);
  assert.match(SRC, /VALUES \('payment_records_rev', \?, \?\)/);
  assert.match(SRC, /INSERT INTO kv_config/);
});

test("every statement batch carries the bump — create, status, lifecycle, restate", () => {
  const batches = SRC.match(/await c\.var\.DB\.batch\(statements\);/g) ?? [];
  const bumps = SRC.match(/statements\.push\(bumpPaymentRecordsRev\(c\.var\.DB\)\);/g) ?? [];
  assert.ok(batches.length >= 4, `expected the four mutation batches, found ${batches.length}`);
  assert.equal(
    bumps.length,
    batches.length,
    "every batch over `statements` must push the bump first — a new mutation path without it re-opens BUG-2026-07-09-002 on the customer side",
  );
});

test("each bump sits immediately before its batch", () => {
  // The pairing, not just the counts: a bump parked after the batch would pass
  // the count test and still leave the snapshot stale for that mutation.
  const re = /statements\.push\(bumpPaymentRecordsRev\(c\.var\.DB\)\);\n\s*await c\.var\.DB\.batch\(statements\);/g;
  const paired = SRC.match(re) ?? [];
  const batches = SRC.match(/await c\.var\.DB\.batch\(statements\);/g) ?? [];
  assert.equal(paired.length, batches.length, "every batch must be immediately preceded by the bump");
});
