import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import map from "../src/api/lib/column-rename-map.json" with { type: "json" };

// Regression for BUG-2026-06-22: the F6 material-cost P&L returned 500
// ("column pii.piid does not exist") because loadMaterialCostData's SQL used
// camelCase identifiers (piId / lineType / poStatus) that were missing from
// column-rename-map.json. The d1-compat rewriter (supabase-compat.ts) only
// translates identifiers present in that map; an unmapped one passes through and
// Postgres lowercases it (piId -> piid) -> column-not-found -> 500. The existing
// sql-write-column-coverage test only checks INSERT/UPDATE columns, so a JOIN/
// WHERE/alias identifier slipped through.
//
// This test auto-extracts EVERY mixed-case identifier from the SQL strings
// inside loadMaterialCostData and asserts each is in the rename map, so adding a
// new camelCase column to those queries without a map entry fails CI instead of
// 500-ing live.

test("F6 loadMaterialCostData SQL: every camelCase identifier is in column-rename-map", () => {
  const src = fs.readFileSync(new URL("../src/api/routes/accounting.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function loadMaterialCostData(");
  assert.ok(start >= 0, "loadMaterialCostData not found in accounting.ts");
  // function body = from its declaration to the next top-level function decl.
  const nextFn = src.indexOf("\nasync function ", start + 1);
  const nextPlain = src.indexOf("\nfunction ", start + 1);
  const candidates = [nextFn, nextPlain].filter((n) => n > start);
  const end = candidates.length ? Math.min(...candidates) : src.length;
  const body = src.slice(start, end);

  // Queries use BOTH backtick templates (multi-line) and double-quoted strings
  // (short single-line) — scan both. Keep only SELECT-bearing literals so JS
  // key-builders and value literals ('RM_ISSUE') don't widen the surface.
  const literals = [
    ...[...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]),
    ...[...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]),
  ];
  const sqlBlobs = literals.filter((t) => /\bSELECT\b/i.test(t));
  assert.ok(sqlBlobs.length >= 6, `expected the material-cost queries, found ${sqlBlobs.length}`);

  // A mixed-case token (has both a lower and an upper letter) in SQL is a
  // camelCase column ref or alias — it MUST be in the rename map. Uppercase-only
  // value literals ('RM_ISSUE') and snake_case table names are excluded.
  const ids = new Set();
  for (const sql of sqlBlobs) {
    for (const tok of sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
      if (/[a-z]/.test(tok) && /[A-Z]/.test(tok)) ids.add(tok);
    }
  }
  const missing = [...ids].filter((k) => !(k in map));
  assert.deepEqual(
    missing,
    [],
    `unmapped camelCase identifiers in loadMaterialCostData SQL (would 500 on prod): ${missing.join(", ")}`,
  );
});
