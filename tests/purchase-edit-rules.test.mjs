// ---------------------------------------------------------------------------
// purchase-edit-rules.test.mjs — pure-rule tests for src/lib/purchase-edit-rules.ts,
// the shared gate that lets the frontend Save handler and the backend PUT
// reject the same PI / GRN edits with the same message.
//
// Asserts:
//   • PI editable for DRAFT + APPROVED only (PAID / CANCELLED locked)
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
  checkGrnLineQtyEdit,
  describeGrnStockDelta,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/purchase-edit-rules.ts")).href
);

// ── PI editability ──────────────────────────────────────────────────────────
test("PI is editable for DRAFT and APPROVED only", () => {
  assert.equal(isPiEditable("DRAFT"), true);
  assert.equal(isPiEditable("APPROVED"), true);
  assert.equal(isPiEditable("draft"), true); // case-insensitive
  assert.equal(isPiEditable("PENDING_APPROVAL"), false);
  assert.equal(isPiEditable("PAID"), false);
  assert.equal(isPiEditable("CANCELLED"), false);
  assert.equal(isPiEditable(null), false);
  assert.equal(isPiEditable(undefined), false);
});

test("PI blocked-edit message names the current status", () => {
  assert.match(piEditBlockedError("PAID"), /DRAFT or APPROVED/);
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

test("GRN qty edit: can reduce DOWN TO the already-invoiced qty but no lower", () => {
  // 5 invoiced; reducing accepted to exactly 5 is fine (delta −1 from 6).
  assert.deepEqual(
    checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 6, newAcceptedQty: 5, invoicedQty: 5 }),
    { ok: true, delta: -1 },
  );
  // reducing below 5 (the invoiced qty) is BLOCKED.
  const r = checkGrnLineQtyEdit({ ref: "Foam", oldAcceptedQty: 6, newAcceptedQty: 4, invoicedQty: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /already been invoiced/);
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
