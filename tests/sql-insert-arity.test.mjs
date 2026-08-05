// ---------------------------------------------------------------------------
// sql-insert-arity.test.mjs — do the columns, the placeholders and the bound
// values of an INSERT actually agree?
//
// On 2026-08-02 the payslip INSERT listed 33 columns and supplied 31
// expressions: `paymentMethod` and `bankName` had been added to the column list
// AND to .bind(), but the two `?` were never added. Postgres answered
//
//     INSERT has more target columns than expressions
//
// and the route's bare catch reported it as "Invalid request body". Because a
// regenerate DELETEs the period first, pressing it wiped July's 36 drafts and
// then failed — with the error blaming the caller's JSON.
//
// Nothing else could have caught this: it is a string, so tsc sees nothing, and
// no test in the suite executes a real INSERT.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Split a column list on top-level commas. */
const splitCols = (s) =>
  s.split(",").map((c) => c.trim()).filter(Boolean);

test("every INSERT supplies exactly one expression per column", () => {
  // Only the unambiguous shape: a parenthesised column list, then VALUES with a
  // single parenthesised tuple. Multi-row VALUES, INSERT…SELECT and dynamically
  // built column lists are skipped — this is a net for the hand-written ones.
  const RE =
    /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^()]*?)\)\s*VALUES\s*\(([^()]*?)\)/gis;
  const bad = [];
  for (const file of walk("src/api")) {
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const m of src.matchAll(RE)) {
      const [, table, colBlock, valBlock] = m;
      // A column list containing ${...} is built at runtime — not comparable.
      if (/\$\{/.test(colBlock) || /\$\{/.test(valBlock)) continue;
      const cols = splitCols(colBlock);
      if (cols.length === 0) continue;
      const exprs = splitCols(valBlock);
      if (exprs.length === 0) continue;
      if (cols.length !== exprs.length) {
        bad.push(
          `${file}: INSERT INTO ${table} has ${cols.length} columns but ${exprs.length} expressions`,
        );
      }
    }
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}\n`);
});

test("the payslip INSERT specifically — the one that wiped July", () => {
  const src = readFileSync("src/api/routes/payslips.ts", "utf8").replace(/\r\n/g, "\n");
  const i = src.indexOf("INSERT OR IGNORE INTO payslips");
  assert.ok(i > 0, "the payslip INSERT moved — update this test");
  const block = src.slice(i, src.indexOf(")`,", i) + 3);
  const cols = splitCols(block.slice(block.indexOf("(") + 1, block.indexOf(") VALUES")));
  const vals = block.slice(block.indexOf(") VALUES") + 8);
  const placeholders = (vals.match(/\?/g) || []).length;
  const literals = (vals.match(/'DRAFT'/g) || []).length;
  assert.equal(
    cols.length,
    placeholders + literals,
    `payslips: ${cols.length} columns vs ${placeholders + literals} expressions`,
  );
  // And the bound arguments must match the placeholders.
  const bindStart = src.indexOf(".bind(", i);
  const bindBlock = src.slice(bindStart, src.indexOf(")\n        .run()", bindStart));
  const bound = splitCols(bindBlock.slice(bindBlock.indexOf("(") + 1)).length;
  assert.equal(bound, placeholders, `${bound} bound values vs ${placeholders} placeholders`);
});
