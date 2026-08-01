#!/usr/bin/env node
// ---------------------------------------------------------------------------
// audit-sql-aliases.mjs — find SQL aliases that silently read back `undefined`.
//
// Postgres folds an UNQUOTED identifier to lower case. So
//     SELECT so.id AS soId2 ...
// returns a column literally named `soid2`. On the read side, db-pg.ts's
// `columnFrom` looks the column up in the inverse rename map and otherwise
// falls back to `postgres.toCamel`, which leaves an underscore-free word
// alone — `soid2` stays `soid2`. The route then reads `r.soId2` and gets
// `undefined`, with no error anywhere.
//
// An alias survives ONLY if it is a key in column-rename-map.json (translateSql
// rewrites it to snake_case, and the read maps it back). Anything else invented
// on the spot — `soId2`, `sumSen`, `onTime` — is silently dead.
//
// Found by mirroring Houzs-ERP #1472's lesson: audit the whole column, not the
// one bug that got reported.
//
// Usage:  node scripts/audit-sql-aliases.mjs [--json]
// Exit 1 if any unsafe alias is found, so CI can gate on it.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const renameMap = JSON.parse(
  readFileSync("src/api/lib/column-rename-map.json", "utf8"),
);

/** `AS someAlias` where the alias is bare (not "quoted") and has a capital. */
const ALIAS_RE = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

export function findUnsafeAliases(files) {
  const hits = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      const t = line.trim();
      // Prose, not SQL — several of these files DOCUMENT the trap in a comment.
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      // Cloudflare Analytics Engine is a DIFFERENT engine reached through
      // runAeSql(), not the Postgres adapter — it preserves alias case, so its
      // aliases are correct as written. Identified by its blob/double columns.
      if (/\b(blob\d|double\d|hookka_erp_metrics)\b/.test(line)) return;
      // `AS` also appears in TypeScript (`x as Foo`), CTE definitions
      // (`WITH t AS (`), and casts. Require a capital letter in the alias and
      // reject the ones that cannot be column aliases.
      for (const m of line.matchAll(ALIAS_RE)) {
        const alias = m[1];
        if (!/[A-Z]/.test(alias)) continue; // all-lowercase folds to itself
        if (renameMap[alias]) continue; // rewritten to snake_case, read back
        if (/^(SELECT|MATERIALIZED|NOT|PERMISSIVE|RESTRICTIVE)$/i.test(alias)) continue;
        // `CAST(x AS INTEGER)` — a type, not an alias.
        if (
          /^(INTEGER|INT|BIGINT|SMALLINT|TEXT|VARCHAR|CHAR|NUMERIC|DECIMAL|REAL|DOUBLE|BOOLEAN|BOOL|DATE|TIMESTAMP|TIMESTAMPTZ|TIME|JSON|JSONB|UUID|BYTEA)$/i.test(
            alias,
          )
        ) {
          continue;
        }
        // `AS (` is a CTE, never an alias.
        const after = line.slice(m.index + m[0].length).trimStart();
        if (after.startsWith("(")) continue;
        hits.push({ file, line: idx + 1, alias, text: t.slice(0, 120) });
      }
    });
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = [...walk("src/api")];
  const hits = findUnsafeAliases(files);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(hits, null, 2));
  } else if (hits.length === 0) {
    console.log("No unsafe SQL aliases. ✓");
  } else {
    console.log(`${hits.length} unsafe SQL alias(es) — each reads back undefined:\n`);
    for (const h of hits) console.log(`  ${h.file}:${h.line}  AS ${h.alias}\n      ${h.text}`);
  }
  process.exit(hits.length === 0 ? 0 : 1);
}
