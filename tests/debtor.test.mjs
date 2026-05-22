// ---------------------------------------------------------------------------
// debtor.test.mjs — unit tests for src/lib/debtor.ts.
//
// `parseDebtorCode` is the single source of truth for the debtor (AR
// sub-account) code FORMAT and for deriving the control-account code. It is
// imported by BOTH the customers Save handler (frontend) and the customers
// POST/PUT route (backend), so the reject is identical on both sides. If
// this drifts, the operator gets a different message inline vs. on the 422.
//
// Rule (from the module comment + DEBTOR_CODE_RE):
//   - Format: "<3-digit control prefix>-<debtor suffix>", e.g. 300-H,
//     305-2, 300-12. Suffix is one-or-more alphanumerics ([A-Za-z0-9]+).
//   - Derived control code: "<prefix>-0000" (e.g. 300-0000).
//   - Empty / whitespace-only input -> "Creditor Code is required".
//   - Anything else malformed -> the "300-X" shape hint.
//   - Input is .trim()'d before matching.
//
// These tests lock the regex boundaries (3 digits exactly, suffix charset,
// dash placement) and the control-code derivation.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let debtor;
try {
  debtor = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/debtor.ts")).href
  );
} catch (err) {
  console.warn(
    "[debtor.test] Could not import debtor module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[debtor.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// Happy path — well-formed codes parse and derive the right control code.
// ---------------------------------------------------------------------------
test("parseDebtorCode: '300-H' -> ok, prefix 300, control 300-0000", () => {
  const r = debtor.parseDebtorCode("300-H");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "300");
  assert.equal(r.controlCode, "300-0000");
});

test("parseDebtorCode: '305-2' -> ok, prefix 305, control 305-0000", () => {
  const r = debtor.parseDebtorCode("305-2");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "305");
  assert.equal(r.controlCode, "305-0000");
});

test("parseDebtorCode: multi-char numeric suffix '300-12' is accepted", () => {
  const r = debtor.parseDebtorCode("300-12");
  assert.equal(r.ok, true);
  assert.equal(r.controlCode, "300-0000");
});

test("parseDebtorCode: mixed alphanumeric suffix 'H1' is accepted", () => {
  const r = debtor.parseDebtorCode("300-H1");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "300");
});

test("parseDebtorCode: lowercase suffix is accepted (charset is [A-Za-z0-9])", () => {
  const r = debtor.parseDebtorCode("412-abc");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "412");
  assert.equal(r.controlCode, "412-0000");
});

test("parseDebtorCode: control code always uses the literal 4-zero suffix", () => {
  // The derivation is `${prefix}-0000` regardless of the input suffix.
  assert.equal(debtor.parseDebtorCode("999-XYZ").controlCode, "999-0000");
});

// ---------------------------------------------------------------------------
// Trimming — surrounding whitespace is stripped before matching.
// ---------------------------------------------------------------------------
test("parseDebtorCode: leading/trailing whitespace is trimmed", () => {
  const r = debtor.parseDebtorCode("  300-H  ");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "300");
});

test("parseDebtorCode: tab/newline whitespace is trimmed", () => {
  const r = debtor.parseDebtorCode("\t305-2\n");
  assert.equal(r.ok, true);
  assert.equal(r.controlCode, "305-0000");
});

// ---------------------------------------------------------------------------
// Empty / nullish — the dedicated "required" error.
// ---------------------------------------------------------------------------
test("parseDebtorCode: empty string -> required error", () => {
  const r = debtor.parseDebtorCode("");
  assert.equal(r.ok, false);
  assert.equal(r.error, "Creditor Code is required");
});

test("parseDebtorCode: whitespace-only -> required error (trimmed to empty)", () => {
  const r = debtor.parseDebtorCode("   ");
  assert.equal(r.ok, false);
  assert.equal(r.error, "Creditor Code is required");
});

test("parseDebtorCode: null -> required error", () => {
  const r = debtor.parseDebtorCode(null);
  assert.equal(r.ok, false);
  assert.equal(r.error, "Creditor Code is required");
});

test("parseDebtorCode: undefined -> required error", () => {
  const r = debtor.parseDebtorCode(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error, "Creditor Code is required");
});

// ---------------------------------------------------------------------------
// Malformed but non-empty — the "300-X" shape hint.
// ---------------------------------------------------------------------------
test("parseDebtorCode: no dash -> format error", () => {
  const r = debtor.parseDebtorCode("300H");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: prefix shorter than 3 digits is rejected", () => {
  const r = debtor.parseDebtorCode("30-H");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: prefix longer than 3 digits is rejected", () => {
  // The regex anchors ^(\d{3})- so a 4-digit prefix has no valid match.
  const r = debtor.parseDebtorCode("3000-H");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: non-numeric prefix is rejected", () => {
  const r = debtor.parseDebtorCode("ABC-H");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: empty suffix ('300-') is rejected", () => {
  // Suffix is [A-Za-z0-9]+ — at least one char required.
  const r = debtor.parseDebtorCode("300-");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: suffix with disallowed char (space) is rejected", () => {
  const r = debtor.parseDebtorCode("300-H X");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: suffix with punctuation is rejected", () => {
  const r = debtor.parseDebtorCode("300-H.2");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: a second dash makes the suffix invalid", () => {
  // "300-H-2" — the suffix "H-2" contains a dash, not in [A-Za-z0-9].
  const r = debtor.parseDebtorCode("300-H-2");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

test("parseDebtorCode: a fully numeric string with no dash is rejected", () => {
  const r = debtor.parseDebtorCode("3001");
  assert.equal(r.ok, false);
  assert.match(r.error, /300-X/);
});

// ---------------------------------------------------------------------------
// DEBTOR_CODE_RE — the exported regex itself. Confirm it is anchored so
// partial matches inside a longer string don't slip through.
// ---------------------------------------------------------------------------
test("DEBTOR_CODE_RE: is anchored — does not match a substring", () => {
  // If unanchored, "x300-Hx" would match the inner "300-H". The ^...$
  // anchors must reject it.
  assert.equal(debtor.DEBTOR_CODE_RE.test("x300-Hx"), false);
  assert.equal(debtor.DEBTOR_CODE_RE.test("300-H"), true);
});

test("DEBTOR_CODE_RE: capture group 1 is the 3-digit prefix", () => {
  const m = "742-K9".match(debtor.DEBTOR_CODE_RE);
  assert.ok(m);
  assert.equal(m[1], "742");
});
