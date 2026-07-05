// ---------------------------------------------------------------------------
// finance-company-filter.test.mjs — Multi-company finance foundation (Phase 1).
//
// Proves the reconciliation contract for the OPTIONAL ?orgId= / ?company=
// report filter:
//
//   1. companyFilter() is INACTIVE when no param is present → emits NO SQL and
//      NO bind → the report query is byte-identical to today's all-org query.
//   2. companyFilter() is ACTIVE when ?orgId= (or ?company=) is present → emits
//      `<col> = ?` and binds the requested org → the report scopes to that one
//      company.
//   3. The five finance report handlers all gate their filter fragment on
//      `coFilter.active`, so the default (no-param) path appends nothing —
//      i.e. the default P&L / BS / aging / control numbers cannot change.
//   4. ensureFinanceOrgColumns() self-applies org_id (ADD COLUMN IF NOT EXISTS)
//      to every finance table the reports may filter on, and is idempotent
//      (memoised — runs the DDL at most once per isolate).
//
// Dynamic against-DB variants aren't possible in CI (Hyperdrive + Supabase
// aren't reachable), so 1–2 exercise the pure helper directly and 3 is a
// structural assertion over the handler source (same approach as
// tenant-isolation.test.mjs).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { companyFilter } from "../src/api/lib/tenant.ts";

const root = process.cwd();
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

// Minimal Hono-ish context: companyFilter only touches c.req.query(name).
const ctx = (params = {}) => ({
  req: { query: (name) => params[name] },
});

test("companyFilter: absent param → INACTIVE, no SQL, no bind (default = all orgs)", () => {
  const f = companyFilter(ctx({}));
  assert.equal(f.active, false);
  assert.equal(f.sql, "");
  assert.equal(f.param, null);
  assert.equal(f.orgId, null);
});

test("companyFilter: blank / whitespace param → INACTIVE (treated as no filter)", () => {
  assert.equal(companyFilter(ctx({ orgId: "" })).active, false);
  assert.equal(companyFilter(ctx({ orgId: "   " })).active, false);
  assert.equal(companyFilter(ctx({ company: "" })).active, false);
});

test("companyFilter: ?orgId= present → ACTIVE, correct SQL + bind", () => {
  const f = companyFilter(ctx({ orgId: "ohana" }));
  assert.equal(f.active, true);
  assert.equal(f.sql, "org_id = ?");
  assert.equal(f.param, "ohana");
  assert.equal(f.orgId, "ohana");
});

test("companyFilter: ?company= is an accepted alias for ?orgId=", () => {
  const f = companyFilter(ctx({ company: "houzs" }));
  assert.equal(f.active, true);
  assert.equal(f.param, "houzs");
});

test("companyFilter: ?orgId= wins when both orgId and company are given", () => {
  const f = companyFilter(ctx({ orgId: "hkmfg", company: "ohana" }));
  assert.equal(f.param, "hkmfg");
});

test("companyFilter: trims the value and honours a column-name override", () => {
  const f = companyFilter(ctx({ orgId: "  ohana  " }), "pi.org_id");
  assert.equal(f.active, true);
  assert.equal(f.sql, "pi.org_id = ?");
  assert.equal(f.param, "ohana");
});

test("companyFilter: the ACTIVE fragment is a bound `?` placeholder — never interpolates the value", () => {
  // Guards against SQL injection: the org value must flow through bind(), so
  // the fragment must contain a `?` and must NOT contain the literal value.
  const f = companyFilter(ctx({ orgId: "o'hana; DROP TABLE invoices" }));
  assert.match(f.sql, /= \?$/);
  assert.doesNotMatch(f.sql, /o'hana/);
  assert.equal(f.param, "o'hana; DROP TABLE invoices");
});

// --- Structural: every finance report gates the filter on coFilter.active ----
test("finance report handlers append the org filter ONLY when coFilter.active", () => {
  const src = read("src/api/routes/accounting.ts");
  // The helper must be imported.
  assert.match(src, /import\s+\{[^}]*companyFilter[^}]*\}\s+from\s+"\.\.\/lib\/tenant"/);
  // Each report builds its WHERE/AND fragment conditionally on coFilter.active,
  // and binds the param conditionally. Count the guarded appends — one per
  // report source query family. If someone unconditionally appends the filter
  // (dropping the `.active` guard), the default numbers would change and this
  // assertion catches it.
  const guardedFragments = src.match(/coFilter\.active \? ` (?:AND|WHERE) \$\{coFilter\.sql\}` : ""/g) ?? [];
  assert.ok(
    guardedFragments.length >= 5,
    `expected >=5 guarded filter fragments across the finance reports, found ${guardedFragments.length}`,
  );
  const guardedBinds = src.match(/\.bind\(\.\.\.\(coFilter\.active \? \[coFilter\.param\] : \[\]\)\)/g) ?? [];
  assert.ok(
    guardedBinds.length >= 7,
    `expected >=7 guarded binds (each filtered query binds param only when active), found ${guardedBinds.length}`,
  );
});

test("aging snapshot partitions filtered vs consolidated by cache_key", () => {
  const src = read("src/api/routes/accounting.ts");
  // The /aging snapshot MUST use a per-company cacheKey when filtered so a
  // scoped result never overwrites the consolidated ("") cache slot.
  assert.match(src, /const cacheKey = coFilter\.active \? `company:\$\{coFilter\.orgId\}` : ""/);
});

// --- ensureFinanceOrgColumns: additive DDL + idempotent ----------------------
test("ensureFinanceOrgColumns adds org_id to every finance table, additively", () => {
  const src = read("src/api/lib/ensure-finance-org.ts");
  const tables = [
    "purchase_invoices",
    "suppliers",
    "cost_ledger",
    "journal_entries",
    "journal_lines",
    "ar_aging",
    "ap_aging",
  ];
  for (const t of tables) {
    assert.match(
      src,
      new RegExp(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'`),
      `ensure helper must add org_id to ${t} with a 'hookka' backfill default`,
    );
  }
});

test("ensureFinanceOrgColumns is memoised (runs DDL at most once per isolate)", async () => {
  const { ensureFinanceOrgColumns } = await import("../src/api/lib/ensure-finance-org.ts");
  let prepareCalls = 0;
  const fakeDb = {
    prepare() {
      prepareCalls += 1;
      return { run: async () => ({}) };
    },
  };
  await ensureFinanceOrgColumns(fakeDb);
  const afterFirst = prepareCalls;
  assert.ok(afterFirst > 0, "first call must run the DDL statements");
  await ensureFinanceOrgColumns(fakeDb);
  assert.equal(
    prepareCalls,
    afterFirst,
    "second call must be a no-op (memoised) — no extra prepare() on success",
  );
});
