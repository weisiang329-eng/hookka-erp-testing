// ---------------------------------------------------------------------------
// purchase-edit-rules.test.mjs — pure-rule tests for src/lib/purchase-edit-rules.ts,
// the shared gate that lets the frontend Save handler and the backend PUT
// reject the same PI / GRN edits with the same message.
//
// Asserts:
//   • PI editable for DRAFT only (CONFIRMED / PAID / CANCELLED locked)
//   • GRN POSTED-line accepted-qty edit allowed unless it drops below what a PI
//     already invoiced; delta = new − old
//   • the plain-language stock-delta summary
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const {
  isPiEditable,
  piEditBlockedError,
  isGrnLineEditable,
  isGrnLineLockedByPi,
  isGrnFullyLockedByDownstreamPi,
  countGrnLinesLockedByPi,
  grnLineInvoicedQty,
  checkGrnLineQtyEdit,
  describeGrnStockDelta,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/purchase-edit-rules.ts")).href
);

// ── PI editability ──────────────────────────────────────────────────────────
test("PI is editable for DRAFT and CONFIRMED (owner 2026-06-29 ruling)", () => {
  assert.equal(isPiEditable("DRAFT"), true);
  assert.equal(isPiEditable("draft"), true); // case-insensitive
  assert.equal(isPiEditable("CONFIRMED"), true);
  assert.equal(isPiEditable("confirmed"), true);
  assert.equal(isPiEditable("APPROVED"), true); // legacy status, still editable as CONFIRMED
  assert.equal(isPiEditable("PENDING_APPROVAL"), false);
  assert.equal(isPiEditable("PAID"), false);
  assert.equal(isPiEditable("CANCELLED"), false);
  assert.equal(isPiEditable(null), false);
  assert.equal(isPiEditable(undefined), false);
});

test("PI blocked-edit message names the current status", () => {
  assert.match(piEditBlockedError("PAID"), /DRAFT or CONFIRMED/);
  assert.match(piEditBlockedError("PAID"), /current: PAID/);
});

// ── GRN line editability ────────────────────────────────────────────────────
test("GRN line is editable for DRAFT / CONFIRMED / POSTED", () => {
  assert.equal(isGrnLineEditable("DRAFT"), true);
  assert.equal(isGrnLineEditable("CONFIRMED"), true);
  assert.equal(isGrnLineEditable("POSTED"), true);
  assert.equal(isGrnLineEditable("CANCELLED"), false);
  assert.equal(isGrnLineEditable(""), false);
});

test("GRN qty edit: increasing accepted qty returns a positive delta", () => {
  const r = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 5, newAcceptedQty: 8, invoicedQty: 0 });
  assert.deepEqual(r, { ok: true, delta: 3 });
});

test("GRN qty edit: decreasing accepted qty returns a negative delta", () => {
  const r = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 5, newAcceptedQty: 3, invoicedQty: 0 });
  assert.deepEqual(r, { ok: true, delta: -2 });
});

test("GRN qty edit: a no-op (same qty) is allowed with delta 0", () => {
  const r = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 5, newAcceptedQty: 5, invoicedQty: 2 });
  assert.deepEqual(r, { ok: true, delta: 0 });
});

test("GRN qty edit: an invoiced LINE is frozen in both directions", () => {
  // The lock is per line, and a billed line does not move at all — an UP edit
  // would leave the invoice sitting on a stale qty/price just as a DOWN edit
  // would leave it claiming goods the receipt no longer records.
  const down = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 6, newAcceptedQty: 5, invoicedQty: 5 });
  assert.equal(down.ok, false);
  assert.match(down.error, /billed on a purchase invoice/);
  assert.match(down.error, /other lines on this receipt can still be corrected/);

  const up = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 6, newAcceptedQty: 9, invoicedQty: 5 });
  assert.equal(up.ok, false);
  assert.match(up.error, /billed on a purchase invoice/);

  // Reducing BELOW the invoiced qty keeps its own, more specific message —
  // that is the mistake operators actually make.
  const below = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 6, newAcceptedQty: 4, invoicedQty: 5 });
  assert.equal(below.ok, false);
  assert.match(below.error, /already been invoiced/);
});

test("GRN qty edit: an UN-invoiced line moves freely even when a sibling is billed", () => {
  // Defect B: one billed line used to lock the whole document. The rule is per
  // line, so this untouched line's own invoicedQty (0) is all that matters.
  assert.deepEqual(
    checkGrnLineQtyEdit({ ref: "Wood", oldAcceptedQty: 4, newAcceptedQty: 7, invoicedQty: 0 }),
    { ok: true, delta: 3 },
  );
});

// ── per-line downstream-PI lock helpers ─────────────────────────────────────
test("the PI lock is per LINE, not per document", () => {
  const items = [
    { invoicedQty: 3 }, // billed
    { invoicedQty: 0 }, // free
    { invoiced_qty: 0 }, // free (snake_case read)
  ];
  assert.equal(isGrnLineLockedByPi(items[0]), true);
  assert.equal(isGrnLineLockedByPi(items[1]), false);
  assert.equal(isGrnLineLockedByPi(items[2]), false);
  assert.equal(countGrnLinesLockedByPi(items), 1);
  // One billed line must NOT lock the receipt — that was the defect.
  assert.equal(isGrnFullyLockedByDownstreamPi(items), false);
});

test("only an entirely-invoiced GRN is locked as a document", () => {
  assert.equal(isGrnFullyLockedByDownstreamPi([{ invoicedQty: 2 }, { invoiced_qty: 5 }]), true);
  // An empty receipt has nothing billed, so it is not "fully locked".
  assert.equal(isGrnFullyLockedByDownstreamPi([]), false);
});

test("invoiced qty reads dual-keyed and defaults to 0", () => {
  assert.equal(grnLineInvoicedQty({ invoicedQty: 4 }), 4);
  assert.equal(grnLineInvoicedQty({ invoiced_qty: 4 }), 4);
  assert.equal(grnLineInvoicedQty({}), 0);
  assert.equal(grnLineInvoicedQty({ invoicedQty: null }), 0);
});

test("GRN qty edit: a negative target is rejected", () => {
  const r = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 5, newAcceptedQty: -1, invoicedQty: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /0 or more/);
});

test("GRN qty edit: NaN target (blank input) is rejected, not silently 0", () => {
  const r = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 5, newAcceptedQty: NaN, invoicedQty: 0 });
  assert.equal(r.ok, false);
});

// ── stock-delta summary ─────────────────────────────────────────────────────
test("describeGrnStockDelta summarizes only the moving lines", () => {
  const msg = describeGrnStockDelta([
    { ref: "Foam", delta: -2 },
    { ref: "Wood", delta: 0 },
    { ref: "Webbing", delta: 3 },
  ]);
  assert.match(msg, /Foam: −2/);
  assert.match(msg, /Webbing: \+3/);
  assert.doesNotMatch(msg, /Wood/);
});

test("describeGrnStockDelta returns null when nothing moves", () => {
  assert.equal(describeGrnStockDelta([{ ref: "Foam", delta: 0 }]), null);
  assert.equal(describeGrnStockDelta([]), null);
});
