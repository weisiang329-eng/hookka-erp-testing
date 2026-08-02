// The catalogue and SQL builder behind GET /api/search
// (src/api/lib/search-sources.ts).
//
// Two things must never go wrong here, and neither is visible by reading the
// endpoint: an identifier reaching SQL from user input, and a source losing
// its org filter so a search leaks another company's rows.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const ss = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/search-sources.ts")).href
);

const colsOf = (s) =>
  new Set([s.idCol, s.labelCol, ...s.subCols, ...s.searchCols, s.orgCol].filter(Boolean));

test("every source is org-scoped — a search must not cross companies", () => {
  for (const s of ss.SEARCH_SOURCES) {
    assert.ok(s.orgCol, `${s.kind} has no org column`);
    const { sql } = ss.buildSourceSql(s, colsOf(s), 5);
    assert.match(sql, new RegExp(`${s.orgCol} = \\?`), `${s.kind} lost its org filter`);
  }
});

test("every source declares an RBAC resource and a link prefix", () => {
  for (const s of ss.SEARCH_SOURCES) {
    assert.ok(s.resource, `${s.kind} has no resource`);
    assert.ok(s.hrefPrefix.startsWith("/"), `${s.kind} has a bad href prefix`);
    assert.ok(s.searchCols.length > 0, `${s.kind} searches no columns`);
  }
});

test("source kinds are unique", () => {
  const kinds = ss.SEARCH_SOURCES.map((s) => s.kind);
  assert.equal(new Set(kinds).size, kinds.length);
});

test("the term is bound, never interpolated", () => {
  const s = ss.SEARCH_SOURCES[0];
  const { sql, bindCount } = ss.buildSourceSql(s, colsOf(s), 10);
  assert.equal(bindCount, s.searchCols.length + 1, "one bind per search column, plus the org");
  assert.equal((sql.match(/\?/g) || []).length, bindCount);
  // The builder never receives the search term at all, so interpolating it is
  // structurally impossible. The only literals allowed are the empty-string
  // defaults inside COALESCE.
  const literals = sql.match(/'[^']*'/g) || [];
  assert.deepEqual([...new Set(literals)], ["''"], "the only literal may be COALESCE's ''");
});

test("the limit is clamped and inlined as a plain integer", () => {
  const s = ss.SEARCH_SOURCES[0];
  assert.match(ss.buildSourceSql(s, colsOf(s), 999).sql, /LIMIT 50$/);
  assert.match(ss.buildSourceSql(s, colsOf(s), 0).sql, /LIMIT 1$/);
  assert.match(ss.buildSourceSql(s, colsOf(s), 7.9).sql, /LIMIT 7$/);
});

test("a missing cosmetic column is dropped, not fatal", () => {
  const s = ss.SEARCH_SOURCES[0];
  // Only what the query strictly needs — every cosmetic sub-column absent.
  const minimal = new Set([s.idCol, s.labelCol, ...s.searchCols, s.orgCol]);
  const droppable = s.subCols.filter((c) => !minimal.has(c));
  assert.ok(droppable.length > 0, "fixture needs at least one droppable sub-column");
  const { sql } = ss.buildSourceSql(s, minimal, 5);
  assert.equal((sql.match(/NULL AS sub/g) || []).length, droppable.length,
    "each absent sub-column becomes NULL rather than breaking the query");
  assert.ok(sql.includes(s.labelCol), "the label column still selects");
  for (const c of droppable) assert.ok(!sql.includes(`${c} AS sub`), `${c} must not be selected`);
});

test("a table missing a required column is not searched at all", () => {
  const s = ss.SEARCH_SOURCES[0];
  const full = new Map([[s.table, colsOf(s)]]);
  assert.equal(ss.isSourceUsable(s, full), true);

  const missingSearchCol = new Set(colsOf(s));
  missingSearchCol.delete(s.searchCols[0]);
  assert.equal(ss.isSourceUsable(s, new Map([[s.table, missingSearchCol]])), false);

  assert.equal(ss.isSourceUsable(s, new Map()), false, "absent table is never searched");
});

test("org filter admits NULL so un-tenanted legacy rows stay findable", () => {
  // Rows written before multi-tenancy carry a NULL org. Excluding them would
  // silently hide real history from search.
  const s = ss.SEARCH_SOURCES[0];
  const { sql } = ss.buildSourceSql(s, colsOf(s), 5);
  assert.match(sql, new RegExp(`${s.orgCol} IS NULL`));
});

test("search predicates are null-safe", () => {
  // Without COALESCE, a NULL column makes the whole OR chain NULL and the row
  // never matches — a customer with no email would drop out of a name search.
  for (const s of ss.SEARCH_SOURCES) {
    const { sql } = ss.buildSourceSql(s, colsOf(s), 5);
    for (const c of s.searchCols) {
      assert.ok(
        sql.includes(`COALESCE(${c}::text,'') ILIKE ?`),
        `${s.kind}.${c} is not null-safe`,
      );
    }
  }
});

test("coverage — the modules that were previously unsearchable are present", () => {
  const kinds = new Set(ss.SEARCH_SOURCES.map((s) => s.kind));
  for (const k of [
    "purchase_order", "purchase_invoice", "grn", "supplier",
    "production_order", "service_order", "service_case",
    "employee", "lead", "journal_entry",
  ]) {
    assert.ok(kinds.has(k), `${k} is missing from global search`);
  }
});
