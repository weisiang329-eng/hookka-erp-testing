// ---------------------------------------------------------------------------
// CI guard for the recurring "edit 了沒 save 到" class (silent 400 on write).
//
// The d1-compat shim (src/api/lib/supabase-compat.ts) rewrites camelCase SQL
// identifiers to snake_case ONLY for columns present in column-rename-map.json.
// A camelCase column written in an INSERT/UPDATE that is NOT in the map is left
// as-is; Postgres folds it to lowercase-no-underscore; if the real column is
// snake_case it won't match → the whole statement throws → caught as 400
// "Invalid request body" → the edit silently fails. This bit us repeatedly
// (supplier_description, receivedAt, …). This test fails the build whenever a
// route writes a camelCase column that is neither mapped nor explicitly
// allow-listed as a self-consistent folded-lowercase table.
//
// If this test fails on a NEW column, do ONE of:
//   • add "camelCaseCol": "snake_case_col" to src/api/lib/column-rename-map.json
//     (the column is snake_case in the DB — the normal case), OR
//   • if the table was CREATEd with that same camelCase (folds to the same
//     lowercase as the write, so it's self-consistent), add the column to ALLOW
//     below with a one-line reason.
//
// Scope: non-finance routes (finance is an active build-out, excluded per owner
// 2026-06-18; give it its own pass later).
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = "src/api";
const FINANCE = /\/(finance|accounting|fund-transfer|supplier-payments|purchase-invoices|three-way|expense|payslip|payroll|other-party)/i;

// Verified self-consistent folded-lowercase columns (the table was CREATEd with
// the same camelCase, so write+read+create all fold to the same lowercase).
const ALLOW = new Set([
  "repairScope",
  "boxLengthFt", "boxWidthFt", "boxHeightFt",
  "ocrPromptRules", "isGold",
  // supplier_scan_samples — CREATE TABLE in ocr-distill.ts uses these exact
  // camelCase names (all fold to lowercase), INSERT/SELECT match. Self-consistent.
  "supplierHint", "docIdentifier", "docType", "rawJson", "correctedJson",
]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}
function insertCols(sql) {
  const cols = [];
  for (const m of sql.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]*)\)/gis))
    for (let c of m[1].split(",")) {
      c = c.trim().replace(/["'`]/g, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) cols.push(c);
    }
  return cols;
}
function updateCols(sql) {
  const cols = [];
  for (const m of sql.matchAll(/UPDATE\s+\w+\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|`)/gi))
    for (const part of m[1].split(",")) {
      const mm = part.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (mm) cols.push(mm[1]);
    }
  return cols;
}

test("no unmapped camelCase write-columns in non-finance routes (silent-400 guard)", () => {
  const map = JSON.parse(readFileSync("src/api/lib/column-rename-map.json", "utf8"));
  const mapped = new Set(Object.keys(map));
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (FINANCE.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const c of new Set([...insertCols(src), ...updateCols(src)])) {
      if (!/[A-Z]/.test(c)) continue; // only camelCase can be mis-folded
      if (mapped.has(c) || ALLOW.has(c)) continue;
      offenders.push(`${file}: ${c}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Unmapped camelCase write-column(s) — would silently 400. Add to column-rename-map.json (snake col) or ALLOW (self-consistent folded table):\n  ${offenders.join("\n  ")}`,
  );
});

// ── Every camelCase column an API route SELECTs must be in the rename map ────
//
// The compat layer rewrites camelCase identifiers to their snake_case Postgres
// names using column-rename-map.json. A name that is MISSING is not an error —
// it passes straight through, Postgres folds it to lowercase ("reportsTo" →
// "reportsto"), the column does not exist and the whole query throws. The route
// then returns nothing and the screen renders empty with no message.
//
// That is exactly how /api/org-chart shipped showing "0 people on the chart"
// while the users table below it listed ten (2026-08-01). Types, tests and the
// build were all green — only the live page showed it.
test("org-chart's SELECTs use only mapped camelCase columns", () => {
  const route = readFileSync("src/api/routes/org-chart.ts", "utf8");
  const map = JSON.parse(readFileSync("src/api/lib/column-rename-map.json", "utf8"));
  const selects = [...route.matchAll(/SELECT\s+([\s\S]*?)\s+FROM/gi)].map((m) => m[1]);
  assert.ok(selects.length > 0, "expected at least one SELECT");
  const missing = [];
  for (const cols of selects) {
    for (const col of cols.split(",").map((c) => c.trim())) {
      // Only mixed-case bare identifiers need a mapping.
      if (!/^[a-z][a-zA-Z0-9]*$/.test(col)) continue;
      if (col === col.toLowerCase()) continue;
      if (!(col in map)) missing.push(col);
    }
  }
  assert.deepEqual(missing, [], `unmapped camelCase column(s): ${missing.join(", ")}`);
});

// ---------------------------------------------------------------------------
// The OTHER half of the same trap, found the same day: the WRITE landed and the
// READ threw it away.
//
// `PUT /api/org-chart/reporting` returned 200 with the correct body, and the
// chart still showed "— no manager (top) —" for all 44 people. Owner:
// 「这个edit不到report to谁？」→「完全没有反应 你可以自己try啊」. Reproduced on
// staging: PUT 200 {managerKey: "user:…"} → GET managerKey: null.
//
// db-pg's columnFrom camelCases every column it returns, so `SELECT person_key,
// manager_key` arrives as personKey / managerKey. Reading `e.person_key` gave
// undefined, the Map became { undefined => null }, and edges.has(p.key) was
// never true — every saved reporting line was invisible.
// ---------------------------------------------------------------------------
test("org-chart reads its edge rows DUAL-KEYED", () => {
  const route = readFileSync("src/api/routes/org-chart.ts", "utf8");
  assert.match(
    route,
    /const pk = e\.personKey \?\? e\.person_key;/,
    "snake_case-only reads come back undefined — see PLAYBOOKS fix-camelCase-read-bug",
  );
  assert.match(route, /e\.managerKey \?\? e\.manager_key \?\? null/);
  assert.doesNotMatch(
    route,
    /edges\.set\(e\.person_key, e\.manager_key \?\? null\)/,
    "the snake_case-only read must not return",
  );
});

// ---------------------------------------------------------------------------
// …and the THIRD thing wrong with the same endpoint: the read was stale.
//
// After the dual-key fix, staging still flapped — a PUT returned 200 and the
// following GET returned the OLD managerKey for tens of seconds, across
// otherwise identical requests. Hyperdrive caches plain read queries, and
// `SELECT person_key, manager_key FROM org_reporting` is maximally cacheable:
// identical text every time, tiny result. It does NOT cache inside an explicit
// transaction, which is what batch() (sql.begin) gives us.
// ---------------------------------------------------------------------------
test("org-chart reads its edges inside a transaction, so a write is visible", () => {
  const route = readFileSync("src/api/routes/org-chart.ts", "utf8");
  assert.match(
    route,
    /db\.batch<EdgeRow>\(\[\s*db\.prepare\("SELECT person_key, manager_key FROM org_reporting"\),\s*\]\)/,
    "the edge read must go through batch() — a plain .all() is Hyperdrive-cacheable",
  );
  assert.doesNotMatch(
    route,
    /\.prepare\("SELECT person_key, manager_key FROM org_reporting"\)\s*\n\s*\.all</,
    "the cacheable plain read must not return",
  );
});
