// ---------------------------------------------------------------------------
// pi-create-error-surfacing.test.mjs — never throw away the real error.
//
// Owner 2026-08-04, on a scanned ADD WOOD invoice: "为什么第三张照片会有这样的
// 问题，create 不到？" The wizard said only "Something went wrong on our side",
// no draft was written, and the source gave no answer — because the answer had
// been DELETED at runtime.
//
// The PI create wraps its insert batch in a try/catch whose sole purpose was a
// pre-migration-0162 database (currency columns absent): retry with a legacy
// column list. But the catch swallowed the original error for every non-foreign
// invoice — no log, no message — then re-ran a near-identical batch. Whatever
// the retry threw reached the global 500 handler, which strips messages because
// they can leak schema names. So the one fact needed to diagnose it was gone
// before anyone could look.
//
// A fallback for a KNOWN condition must not become a catch-all that erases
// unknown ones.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/purchase-invoices.ts"),
  "utf8",
);

test("the first insert failure is always logged, not only for foreign PIs", () => {
  const block = SRC.slice(SRC.indexOf("  try {\n    await db.batch(statements);"));
  const head = block.slice(0, 1400);
  assert.match(head, /const firstErr = e instanceof Error \? e\.message : String\(e\);/);
  assert.match(head, /first insert attempt failed/);
  // The log must come BEFORE the isForeign branch, or MYR still loses it.
  assert.ok(
    head.indexOf("first insert attempt failed") < head.indexOf("if (isForeign)"),
    "logging must not sit inside the foreign-only branch",
  );
});

test("a failing legacy retry reports the ORIGINAL cause", () => {
  // Retrying a missing-column fix against a constraint or bad-data error
  // achieves nothing; the caller needs to know what actually broke.
  const block = SRC.slice(SRC.indexOf("legacy-column retry ALSO failed"));
  assert.ok(block.length > 0, "the retry must have its own catch");
  assert.match(SRC, /Could not save the invoice: \$\{firstErr\}/);
  assert.match(SRC, /legacy-column retry ALSO failed/);
});

test("the retry failure returns 400, not an anonymous 500", () => {
  // A 500 goes through the global handler, which replaces the message with
  // "Something went wrong on our side" — the exact dead end this fixes.
  const block = SRC.slice(SRC.indexOf("legacy-column retry ALSO failed"));
  assert.match(block.slice(0, 600), /400,/);
});

test("the second batch is actually guarded", () => {
  // Before this, the retry was a bare `await db.batch(statements);` whose
  // rejection propagated straight out of the handler.
  const idx = SRC.indexOf("legacy-column retry ALSO failed");
  const before = SRC.slice(Math.max(0, idx - 700), idx);
  assert.match(before, /try \{\s*\n\s*await db\.batch\(statements\);\s*\n\s*\} catch \(e2\) \{/);
});

test("a self-apply failure is reported too, not just an insert failure", () => {
  // runSelfApply THROWS on a real ALTER failure, and ensurePiMigrations sits
  // BEFORE every statement — so it produces the identical symptom (nothing
  // written, anonymous 500) by a completely different route. Reporting only
  // the insert path leaves the two indistinguishable from the outside.
  assert.match(SRC, /try \{\s*\n\s*await ensurePiMigrations\(db\);\s*\n\s*\} catch \(err\) \{/);
  assert.match(SRC, /Database is missing a column and it could not be added/);
  assert.match(SRC, /self-apply failed before create/);
});
