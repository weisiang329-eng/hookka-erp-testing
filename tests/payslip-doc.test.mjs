// ---------------------------------------------------------------------------
// payslip-doc.test.mjs — the one payslip document (owner 2026-08-01).
//
// The bilingual labels come from the worker i18n table, and translateFor()
// returns the KEY when a string is missing ("expose missing keys loudly") — fine
// in the app, but on a payslip it prints "pay.absentDays" where a worker expects
// a word. So the first thing pinned here is that every key the document asks for
// actually exists, in every language.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const i18n = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/worker-i18n.ts")).href
);
const DOC = readFileSync(resolve(process.cwd(), "src/lib/generate-payslip-pdf.ts"), "utf8");

const KEYS = [...DOC.matchAll(/"(pay\.[A-Za-z.]+)"/g)].map((m) => m[1]);

test("the payslip asks for i18n keys that all exist", () => {
  assert.ok(KEYS.length >= 5, `expected several keys, found ${KEYS.length}`);
  for (const k of KEYS) {
    for (const lang of ["en", "ms", "zh", "my"]) {
      const v = i18n.translateFor(lang, k);
      assert.notEqual(v, k, `${k} has no ${lang} string — the raw key would print`);
      assert.ok(v.trim().length > 0, `${k} is blank in ${lang}`);
    }
  }
});

test("a placeholder like {n} never reaches the payslip", () => {
  // The in-app rows interpolate counts; the document does not, so a key that
  // carries "{n}" would print the braces on paper.
  for (const k of KEYS) {
    for (const lang of ["en", "ms", "zh", "my"]) {
      assert.ok(!i18n.translateFor(lang, k).includes("{"), `${k} (${lang}) carries a placeholder`);
    }
  }
});

test("English-only is still available — the second language is opt-in", () => {
  assert.match(DOC, /opts\.lang && opts\.lang !== "en" \? opts\.lang : null/);
});

test("a DRAFT month is stamped as an estimate, not as final", () => {
  assert.match(DOC, /ESTIMATE — NOT FINAL/);
});

test("the fabricated bank account is gone", () => {
  // It used to print `CIMB-${empNo}XXXX` — a made-up account that looked real.
  assert.doesNotMatch(DOC, /CIMB-/);
});
