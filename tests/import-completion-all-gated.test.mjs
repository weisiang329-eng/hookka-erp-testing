// ---------------------------------------------------------------------------
// Every /api/import handler must be permission-gated.
//
// THE BUG (found 2026-08-13): of the 11 handlers in wip-fixes.ts, ten opened
// with `requirePermission(c, "production-orders", "update")` and
// `/backfill-fabcut-rm-issue` opened with `const dryRun`. With `?dryRun=false`
// it calls consumeRawMaterialsForPO, which writes rm_batches,
// raw_materials.balanceQty and cost_ledger RM_ISSUE — so any authenticated
// user of any role could move stock and money.
//
// It was an omission, not a decision. That is precisely the kind of thing no
// reviewer catches by eye across 15,279 lines and 65 endpoints in nine files,
// and precisely what a cheap structural test catches every time.
//
// This family is mounted at /api/import (worker.ts) behind the global auth
// gate, so "authenticated" is the only barrier these endpoints ever had. None
// of them is reachable from the UI — the callers are hand-run driver scripts —
// which is exactly why nobody would notice a missing gate in normal use.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const DIR = "src/api/routes/import-completion";

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && f !== "_shared.ts")
  .map((f) => `${DIR}/${f}`);

/** Handler openings: `app.post("/path", async (c) => {` and friends. */
function handlers(src) {
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const lines = withoutComments.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/app\.(post|put|patch|delete)\(\s*["'`]([^"'`]+)/);
    if (!m) return;
    // The gate is by convention the first statement in the body. Allow a few
    // lines of slack for a multi-line handler signature, but not so much that
    // a check buried after the first write would count as gating.
    const body = lines.slice(i, i + 8).join("\n");
    out.push({ method: m[1], path: m[2], line: i + 1, gated: /requirePermission\s*\(/.test(body) });
  });
  return out;
}

test("no mutating /api/import endpoint is ungated", () => {
  const ungated = [];
  let total = 0;
  for (const f of files) {
    const found = handlers(readFileSync(f, "utf8"));
    total += found.length;
    for (const h of found) {
      if (!h.gated) ungated.push(`${f}:${h.line}  ${h.method.toUpperCase()} ${h.path}`);
    }
  }

  assert.ok(total > 40, `expected to find the whole family, only matched ${total} handlers — ` +
    "the matcher has probably drifted from how these routes are declared, which would make " +
    "this test pass by finding nothing");

  assert.deepEqual(
    ungated,
    [],
    `${ungated.length} mutating import endpoint(s) have no requirePermission:\n  ` +
      ungated.join("\n  ") +
      "\n\nThese run behind the global auth gate only, so an unguarded one is writable by any " +
      "logged-in user of any role. Add the same gate its siblings use.",
  );
});
