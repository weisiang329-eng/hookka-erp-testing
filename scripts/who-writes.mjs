#!/usr/bin/env node
// ---------------------------------------------------------------------------
// who-writes — enumerate EVERY writer and reader of a column or symbol.
//
// WHY THIS EXISTS
// Every wrong conclusion reached on this repo on 2026-08-14 had one shape:
// a slice of the evidence was read, and the conclusion was published as if the
// whole had been. Four in one day:
//
//   · measured ONE column (`delivery_order_item_id`, 1.5% populated) and
//     concluded the book was unauditable — `production_order_id` was 92.9%
//     populated and printed in the very output being read
//   · grepped `src/pages` only and declared an 8-vs-14 leave conflict a false
//     alarm — the second literal was in `src/api/routes/worker.ts:2491`
//   · fixed a NUL byte in the one file in front of me; five others carried it
//   · told an agent the on-time metric lived in `agent-learning.ts:458`; it
//     lived in `operations-report.ts:873`
//
// The counter-examples all had the opposite shape: enumerate first, conclude
// second. The secret scan swept 2,079 files; the completion-write audit listed
// 19 sites; the PCB audit listed 17. None of those was wrong.
//
// So this is not a rule asking anyone to be thorough. It is the two minutes of
// thoroughness, pre-packaged, so the correct habit is the cheap one.
//
// USAGE
//   node scripts/who-writes.mjs pcb_enabled
//   node scripts/who-writes.mjs actualMinutes --reads
//   node scripts/who-writes.mjs completedDate --all
//
// Matches BOTH spellings automatically (snake_case ⇄ camelCase), because the
// pg adapter camelCases any column absent from column-rename-map.json and half
// the bugs here come from one spelling being searched and the other existing.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const showReads = args.includes("--reads") || args.includes("--all");
const showWrites = !args.includes("--reads") || args.includes("--all");

if (!name) {
  console.error("usage: node scripts/who-writes.mjs <column-or-symbol> [--reads] [--all]");
  process.exit(2);
}

const snake = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "");
const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const spellings = [...new Set([name, snake, camel])];

const ROOTS = ["src", "scripts", "migrations", "migrations-postgres", "tests"];
const SKIP = new Set(["node_modules", ".git", "dist", ".wrangler", "coverage"]);

const files = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(e.name)) files.push(p);
  }
}
for (const r of ROOTS) walk(r);

// THREE buckets, not two. A first draft lumped every `foo:` and `foo =` in with
// the SQL and produced 116 "writers" for `actualMinutes` — mostly type
// declarations. A list that long focuses no attention and gets skimmed, which
// is the same way a noisy lint gets switched off. What answers "who SETS this
// column" is the SQL; JS assignment is the second ring; everything else is
// noise until the first two are understood.
const sqlWritePatterns = (s) => [
  new RegExp(`INSERT\\s+INTO[^;]{0,4000}?\\b${s}\\b`, "is"),
  new RegExp(`UPDATE[^;]{0,2000}?\\bSET\\b[^;]{0,2000}?\\b${s}\\b`, "is"),
  new RegExp(`ALTER\\s+TABLE[^;]{0,400}?\\b${s}\\b`, "is"),
];
// An assignment to a PROPERTY (`x.foo = …`, `foo = …`) — but not a type
// annotation (`foo: number`) and not an object key whose value is a type.
const assignPatterns = (s) => [
  new RegExp(`\\b${s}\\s*=[^=>]`),
  new RegExp(`\\b${s}\\s*:\\s*(?!number|string|boolean|null|undefined|Date|unknown|any|\\{|Record|Array|Promise)`),
];
const isTypeDecl = (line) =>
  /^\s*(readonly\s+)?[A-Za-z_$][\w$]*\??\s*:\s*(number|string|boolean|null|undefined|Date|unknown|any)(\s*\|\s*(number|string|boolean|null|undefined))*\s*;?\s*$/.test(
    line.trim(),
  );

const seen = new Set();
const sqlWrites = [];
const assigns = [];
const reads = [];

for (const f of new Set(files)) {
  let text;
  try {
    if (statSync(f).size > 8_000_000) continue;
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;

  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const bare = line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    if (!spellings.some((s) => new RegExp(`\\b${s}\\b`).test(bare))) return;

    const key = `${f}:${i + 1}`;
    if (seen.has(key)) return;
    seen.add(key);

    // Look at a small window so a multi-line INSERT/UPDATE is still caught.
    const window = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
    const entry = `${f}:${i + 1}  ${bare.trim().slice(0, 100)}`;

    if (spellings.some((s) => sqlWritePatterns(s).some((re) => re.test(window)))) {
      sqlWrites.push(entry);
    } else if (
      !isTypeDecl(bare) &&
      spellings.some((s) => assignPatterns(s).some((re) => re.test(bare)))
    ) {
      assigns.push(entry);
    } else {
      reads.push(entry);
    }
  });
}

const report = (title, arr, limit = 60) => {
  console.log(`\n${title}: ${arr.length}`);
  arr.slice(0, limit).forEach((x) => console.log(`  ${x}`));
  if (arr.length > limit) console.log(`  … and ${arr.length - limit} more`);
};

console.log(`\nspellings searched: ${spellings.join(", ")}`);
if (showWrites) {
  report("① SQL WRITES — these SET the column. Start here.", sqlWrites);
  report("② JS assignments — build the value that the SQL then binds", assigns);
}
if (showReads) report("③ reads / types / other mentions", reads);

console.log(`
Before concluding anything about this field, ask of the list above:
  · is EVERY writer accounted for, or only the one you were looking at?
  · does a writer bind the SAME variable to two columns? (that is how
    production_time_minutes and est_minutes can never differ)
  · is a "current state" claim measured, or inferred from a migration?

WHAT THIS TOOL CANNOT DO — do not let it become false reassurance.
It searches an IDENTIFIER. It cannot find a second place that expresses the same
CONCEPT under a different name. The 2026-08-14 leave bug was exactly that shape:
'annualEntitlement = 14' in worker.ts against 'LEAVE_ENTITLEMENTS.ANNUAL = 8' in
employees.tsx — searching either name finds one site and looks complete. Tested:
running this on 'annualEntitlement' returns ZERO hits in employees.tsx.

So for a CONCEPT (an entitlement, a rate, a threshold, a status vocabulary), also
search the plain word ('entitlement', 'pcb', 'overtime'), and search the VALUE
itself (grep for '14' near 'leave'). "One writer found" is not "one writer
exists" — it is "one name searched".
`);
