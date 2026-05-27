// ---------------------------------------------------------------------------
// password-strength.test.mjs — unit tests for src/api/lib/password-strength.ts.
//
// This module is the gate that decides whether a new password is allowed onto
// users.passwordHash. It runs on BOTH the frontend (PasswordStrengthMeter,
// reset-password.tsx) and the backend (auth.ts /change-password +
// /reset-password). If a reject branch ever weakens, the next operator can
// land "hookka" again. These tests lock every rule and the score ladder.
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

let mod;
try {
  mod = await import(
    pathToFileURL(
      resolve(process.cwd(), "src/api/lib/password-strength.ts"),
    ).href
  );
} catch (err) {
  console.warn(
    "[password-strength.test] Could not import password-strength module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[password-strength.test] Error:", err?.message ?? err);
  throw err;
}

const { validatePasswordStrength } = mod;

// ---------------------------------------------------------------------------
// Reject paths — these are the rules that used to be missing.
// ---------------------------------------------------------------------------
test("hookka is rejected (too short AND dictionary)", () => {
  const r = validatePasswordStrength("hookka");
  assert.equal(r.ok, false);
  assert.equal(r.score, 0);
  // First violation hit is length, so error mentions length. That's fine —
  // we just need it rejected; the meter only shows one rule at a time.
  assert.match(r.error, /12 characters/i);
});

test("password123 is rejected (no uppercase, no symbol, also common)", () => {
  const r = validatePasswordStrength("password123");
  assert.equal(r.ok, false);
  assert.equal(r.score, 0);
});

test("Hookka-Sofa-2026! passes all rules", () => {
  const r = validatePasswordStrength("Hookka-Sofa-2026!");
  assert.equal(r.ok, true, `expected ok=true, got error=${r.error}`);
  assert.ok(r.score >= 1, `expected score >= 1, got ${r.score}`);
});

test("password containing email local-part is rejected", () => {
  const r = validatePasswordStrength(
    "weisiang329-Strong!",
    "weisiang329@gmail.com",
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /email/i);
});

test("same password passes when email arg is omitted", () => {
  const r = validatePasswordStrength("weisiang329-Strong!");
  assert.equal(r.ok, true, `expected ok=true, got error=${r.error}`);
});

// ---------------------------------------------------------------------------
// 12-char boundary — must reject 11, accept 12 (assuming other rules pass).
// ---------------------------------------------------------------------------
test("11-char password is rejected (under 12-char floor)", () => {
  const r = validatePasswordStrength("Ab1!Ab1!Ab1"); // 11 chars
  assert.equal(r.ok, false);
  assert.match(r.error, /12 characters/i);
});

test("exactly 12-char password with all 4 types passes", () => {
  const r = validatePasswordStrength("Ab1!Ab1!Ab1!"); // 12 chars
  assert.equal(r.ok, true, `expected ok=true, got error=${r.error}`);
  assert.equal(r.score, 1, "12-char min should score 1, not higher");
});

// ---------------------------------------------------------------------------
// Score ladder — longer is better, even after rules pass.
// ---------------------------------------------------------------------------
test("16-char password scores 2", () => {
  const r = validatePasswordStrength("Ab1!Ab1!Ab1!Ab1!");
  assert.equal(r.ok, true);
  assert.equal(r.score, 2);
});

test("20-char password scores 3", () => {
  const r = validatePasswordStrength("Ab1!Ab1!Ab1!Ab1!Ab1!");
  assert.equal(r.ok, true);
  assert.equal(r.score, 3);
});

test("24-char password scores 4 (excellent)", () => {
  const r = validatePasswordStrength("Ab1!Ab1!Ab1!Ab1!Ab1!Ab1!");
  assert.equal(r.ok, true);
  assert.equal(r.score, 4);
});

// ---------------------------------------------------------------------------
// Char-type rules — each is the first violation when only that one is missing.
// ---------------------------------------------------------------------------
test("missing uppercase is flagged", () => {
  const r = validatePasswordStrength("ab1!ab1!ab1!ab1!");
  assert.equal(r.ok, false);
  assert.match(r.error, /uppercase/i);
});

test("missing lowercase is flagged", () => {
  const r = validatePasswordStrength("AB1!AB1!AB1!AB1!");
  assert.equal(r.ok, false);
  assert.match(r.error, /lowercase/i);
});

test("missing digit is flagged", () => {
  const r = validatePasswordStrength("Ab!Ab!Ab!Ab!Ab!Z");
  assert.equal(r.ok, false);
  assert.match(r.error, /number/i);
});

test("missing symbol is flagged", () => {
  const r = validatePasswordStrength("Ab1Ab1Ab1Ab1Ab1Z");
  assert.equal(r.ok, false);
  assert.match(r.error, /symbol/i);
});
