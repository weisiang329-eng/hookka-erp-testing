// ---------------------------------------------------------------------------
// Every camelCase identifier in the KPI route's SQL must be translatable.
//
// The repo's existing guard (sql-write-column-coverage) checks INSERT/UPDATE
// columns only. `lockedAt` appears solely in a WHERE clause, so it passed all
// 3,062 tests and then 500'd every card on prod — /me, every person, the whole
// People tab. A read column is exactly as fatal as a write column; the only
// difference is that nothing was watching for it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { translateSql } from "../src/api/lib/supabase-compat.ts";

// Both files. The route was the only one checked, which was luck rather than
// design: `documentsStuck` and `manualRating` live in kpi-metrics.ts and write
// exactly the same kind of SQL, so an unmapped column there would 500 the same
// cards through a file the guard never opened.
const SOURCES = [
  "src/api/routes/kpi.ts",
  "src/api/lib/kpi-metrics.ts",
].map((f) => [f, readFileSync(resolve(process.cwd(), f), "utf8")]);

/** Every backtick SQL template in the file. */
function sqlBlocks(src) {
  return [...src.matchAll(/`([^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*)`/gi)].map((m) => m[1]);
}

test("no camelCase identifier survives translation", () => {
  const blocks = SOURCES.flatMap(([file, src]) =>
    sqlBlocks(src).map((b) => [file, b]),
  );
  assert.ok(blocks.length >= 8, `expected several SQL blocks, found ${blocks.length}`);

  const offenders = [];
  for (const [file, block] of blocks) {
    // Drop the template holes — `${...}` is JS, not SQL.
    const sql = block.replace(/\$\{[^}]*\}/g, " ");
    // Strip DOUBLE-QUOTED names before looking. `u.id AS "userId"` is an output
    // alias kept camelCase on purpose so the JS can read r.userId — Postgres
    // preserves a quoted identifier, so it is correct exactly as written. Only
    // an UNQUOTED camelCase name is the bug (Postgres folds it to lowercase and
    // the snake_case column is never found).
    const out = translateSql(sql).replace(/"[^"]*"/g, '""');
    for (const id of new Set(out.match(/\b[a-z]+[A-Z][A-Za-z]*\b/g) ?? [])) {
      // Postgres folds unquoted identifiers to lowercase, so a name that is
      // already all-lowercase in the database is fine either way. What is NOT
      // fine is a camelCase name whose column is snake_case — that 400s.
      offenders.push(`${id}  (${file})`);
    }
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `untranslated camelCase in KPI SQL — add to column-rename-map.json:\n  ${[...new Set(offenders)].join("\n  ")}`,
  );
});

test("the KPI tables' own columns are all mapped", () => {
  // Read straight off the DDL so a column added later cannot be forgotten.
  const ddl = readFileSync(resolve(process.cwd(), "src/api/lib/ensure-kpi-tables.ts"), "utf8");
  const map = JSON.parse(
    readFileSync(resolve(process.cwd(), "src/api/lib/column-rename-map.json"), "utf8"),
  );
  const snake = new Set(Object.values(map));
  for (const col of new Set(ddl.match(/^\s{5}([a-z]+_[a-z_]+)\s+/gm)?.map((s) => s.trim()) ?? [])) {
    // Single-word columns (period, target, weight…) need no mapping.
    if (!col.includes("_")) continue;
    assert.ok(
      snake.has(col),
      `${col} is a KPI table column with no camelCase entry in column-rename-map.json`,
    );
  }
});
