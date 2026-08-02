// ---------------------------------------------------------------------------
// boolean-column-binds.test.mjs — never bind `? 1 : 0` to a real BOOLEAN again.
//
// 2026-08-02. The owner ticked "Outsourced" on OSC-001 CHAU, set the day rate
// to RM 85, pressed Save and got "Employee updated." Reopening the drawer, the
// tick was gone. The database said:
//
//     pay_mode        = 'DAILY'   <- saved
//     daily_rate_sen  = 8500      <- saved
//     is_outsource    = false     <- NOT saved
//
// One UPDATE, one request, three columns, and only the boolean was wrong. It
// was not a cache. Bound against a real Postgres BOOLEAN, postgres.js maps
// every value that is not a JS boolean to FALSE:
//
//     bind 1      (number)  -> stored false      <- the bug
//     bind 0      (number)  -> stored false
//     bind "1"    (string)  -> stored false
//     bind "true" (string)  -> stored false
//     bind true   (boolean) -> stored true
//     bind false  (boolean) -> stored false
//
// No error, no 500 — the write "succeeds" and the value is wrong. Which is the
// worst failure mode there is: the screen and the database disagree, and
// nothing anywhere says so.
//
// It is an easy mistake because `flag ? 1 : 0` is CORRECT here. This codebase
// came from Cloudflare D1 (SQLite), where a boolean IS the integer 0/1, and
// most flag columns really are INTEGER. Only ten columns in the whole database
// were created as an actual BOOLEAN, and on those ten the same idiom silently
// writes FALSE. tsc cannot see it (the SQL is a string) and no test executes a
// real INSERT, so nothing else in the suite can catch it.
//
// tests/db-boolean-columns.json is the list of the ten, snapshotted from
// production by scripts/refresh-db-schema-fixture.mjs. Re-run that after any
// migration that adds a boolean column.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const BOOL_COLUMNS = JSON.parse(
  readFileSync(new URL("./db-boolean-columns.json", import.meta.url), "utf8"),
);

// The SupabaseAdapter rewrites camelCase SQL to snake_case, so `isOutsource`
// and `is_outsource` are the same column. Compare with both flattened.
const norm = (s) => s.toLowerCase().replace(/_/g, "");

const boolLookup = new Map();
for (const [table, cols] of Object.entries(BOOL_COLUMNS)) {
  boolLookup.set(norm(table), new Set(cols.map(norm)));
}
const isBoolColumn = (table, column) =>
  boolLookup.get(norm(table))?.has(norm(column)) ?? false;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Strip // line comments so a comment's commas don't split an argument list. */
function stripLineComments(s) {
  return s
    .split("\n")
    .map((line) => {
      let depth = 0;
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\") i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      void depth;
      return line;
    })
    .join("\n");
}

/** Index of the paren matching the `(` at `open`, or -1. */
function matchParen(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split an argument list on TOP-LEVEL commas only. */
function splitTopLevel(s) {
  const out = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === "\\") { buf += s[++i] ?? ""; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; buf += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * One entry per `?` in the statement, in order — `{table, column}` where we can
 * name it, `null` where we cannot.
 *
 * EVERY placeholder has to be listed, not just the interesting ones. The first
 * version of this test only counted the `?` in SET, so an
 * `UPDATE … SET <30 cols> WHERE id = ?` came out as 30 slots against 31 bound
 * arguments, the counts disagreed, and the statement was skipped — which is
 * exactly the statement with the bug in it. A test that quietly skips the case
 * it was written for is worse than no test.
 */
function bindSlots(sql) {
  const total = (sql.match(/\?/g) ?? []).length;
  if (total === 0) return null;
  const pad = (named) => {
    if (named.length > total) return null;
    return [...named, ...Array(total - named.length).fill(null)];
  };

  const insert = sql.match(
    /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^()]*?)\)\s*VALUES\s*\(([^()]*?)\)/is,
  );
  if (insert) {
    const [, table, colBlock, valBlock] = insert;
    if (/\$\{/.test(colBlock) || /\$\{/.test(valBlock)) return null;
    const cols = splitTopLevel(colBlock);
    const vals = splitTopLevel(valBlock);
    if (cols.length !== vals.length) return null; // arity test's job
    const named = [];
    vals.forEach((v, i) => { if (v === "?") named.push({ table, column: cols[i] }); });
    // Trailing ON CONFLICT … DO UPDATE SET placeholders come after these.
    return pad(named);
  }

  const update = sql.match(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([\s\S]*?)(?:\sWHERE\s|$)/i);
  if (update) {
    const [, table, setBlock] = update;
    if (/\$\{/.test(setBlock)) return null;
    const named = [];
    for (const piece of splitTopLevel(setBlock)) {
      const m = piece.match(/^([a-z_][a-z0-9_]*)\s*=\s*([\s\S]+)$/i);
      if (!m) return null;
      const [, column, expr] = m;
      // Only a bare `?` consumes a bind slot. A literal (`= false`, `= NULL`)
      // consumes nothing; anything else with a `?` inside we cannot count, so
      // give up on the whole statement rather than misalign it.
      if (expr.trim() === "?") named.push({ table, column });
      else if (expr.includes("?")) return null;
    }
    // Everything left over belongs to WHERE — unnamed, but it must be counted.
    return pad(named);
  }
  return null;
}

/**
 * Shapes that are definitely NOT a JS boolean. Deliberately narrow: a plain
 * variable could be anything, and a test that guesses would cry wolf in CI.
 * These five are the ones that reach Postgres as a silent FALSE.
 */
function wrongForBoolean(expr) {
  const e = expr.replace(/\s+/g, " ").trim();
  if (/^[01]$/.test(e)) return "a bare number";
  if (/\?\s*[01]\s*:\s*[01]$/.test(e)) return "`? 1 : 0` — the D1 integer idiom";
  if (/^Number\s*\(/.test(e)) return "Number(...)";
  if (/^(["'])[\s\S]*\1$/.test(e)) return "a string literal";
  if (/^\+/.test(e)) return "unary + (coerces to number)";
  return null;
}

test("no non-boolean value is ever bound to a real BOOLEAN column", () => {
  const bad = [];
  for (const file of walk("src/api")) {
    const src = stripLineComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/\.prepare\s*\(/g)) {
      const openPrepare = m.index + m[0].length - 1;
      const closePrepare = matchParen(src, openPrepare);
      if (closePrepare < 0) continue;
      const sql = src.slice(openPrepare + 1, closePrepare);

      const after = src.slice(closePrepare + 1);
      const bindMatch = after.match(/^\s*\.bind\s*\(/);
      if (!bindMatch) continue;
      const openBind = closePrepare + 1 + bindMatch[0].length - 1;
      const closeBind = matchParen(src, openBind);
      if (closeBind < 0) continue;

      const slots = bindSlots(sql);
      if (!slots) continue;
      const args = splitTopLevel(src.slice(openBind + 1, closeBind));
      if (args.length !== slots.length) continue; // spread/dynamic — can't align

      slots.forEach((c, i) => {
        if (!c || !isBoolColumn(c.table, c.column)) return;
        const why = wrongForBoolean(args[i]);
        if (why) {
          bad.push(
            `${file}: ${c.table}.${c.column} is a BOOLEAN but is bound ${why}: \`${args[i]}\`\n` +
              `    postgres.js stores that as FALSE with no error. Bind a real boolean.`,
          );
        }
      });
    }
  }
  assert.deepEqual(bad, [], `\n\n${bad.join("\n")}\n`);
});

test("the boolean-column fixture is present and non-empty", () => {
  const total = Object.values(BOOL_COLUMNS).reduce((n, c) => n + c.length, 0);
  assert.ok(
    total > 0,
    "tests/db-boolean-columns.json is empty — re-run scripts/refresh-db-schema-fixture.mjs",
  );
});
