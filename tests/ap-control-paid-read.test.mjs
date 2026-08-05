// ---------------------------------------------------------------------------
// ap-control-paid-read.test.mjs — the AP control card must subtract what has
// already been paid.
//
// BUG-2026-08-05-002 (owner spotted the red drift chip, 2026-08-05): the card
// read `pi.paid_amount_sen` while the adapter camelCases every result column,
// so the read landed on `undefined`, `|| 0` swallowed it, and EVERY bill was
// counted at FULL FACE. The drift chip then showed exactly minus the total
// already paid on part-paid invoices — measured twice on prod, both exact:
//
//   4 part-paid bills → drift −9,804.04 = Σ paid 9,804.04
//   2 part-paid bills → drift −2,322.24 = Σ paid 2,322.24 (420.70 + 1,901.54)
//
// It never moved a cent of real data — the aging report, the ledger and
// /ap-reconciliation all read correctly — but the card could never reach zero
// while any invoice was part-paid, which makes a real drift impossible to see.
//
// Source-scanned because the sum lives inside a route handler over a DB batch.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/accounting.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

const AP_CONTROL = SRC.slice(
  SRC.indexOf('app.get("/ap-control"'),
  SRC.indexOf('app.get("/ap-reconciliation"'),
);

test("/ap-control exists and is the block under test", () => {
  assert.ok(AP_CONTROL.length > 0, "the /ap-control handler must be found");
  assert.match(AP_CONTROL, /piOutstandingSen \+= amt;/);
});

test("outstanding subtracts paid, read under BOTH spellings", () => {
  assert.match(
    AP_CONTROL,
    /Number\(pi\.paidAmountSen \?\? pi\.paid_amount_sen\)/,
    "the camelCase key must be tried first — snake_case alone reads undefined",
  );
});

test("no snake_case-only read of paid_amount_sen survives in this handler", () => {
  const all = AP_CONTROL.match(/\bpi\.paid_amount_sen\b/g) ?? [];
  const guarded = AP_CONTROL.match(/\?\?\s*pi\.paid_amount_sen\b/g) ?? [];
  assert.equal(
    all.length,
    guarded.length,
    "every pi.paid_amount_sen read must sit on the right of a ?? fallback",
  );
});

test("the row type declares both spellings, or the typechecker can't help", () => {
  const type = SRC.slice(SRC.indexOf("type PiAgingRow"), SRC.indexOf("let piRes:"));
  assert.match(type, /paidAmountSen\?: number \| null;/);
  assert.match(type, /paid_amount_sen\?: number \| null;/);
});

test("the reconciler — the endpoint that stayed correct — is still dual-keyed", () => {
  const recon = SRC.slice(SRC.indexOf('app.get("/ap-reconciliation"'));
  assert.match(recon, /r\.paidAmountSen \?\? r\.paid_amount_sen/);
});
