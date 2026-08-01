// ---------------------------------------------------------------------------
// historical-sales-groupby.test.mjs
//
// /api/historical-sales returned 500 for EVERY caller since the D1 -> Postgres
// cutover. Confirmed live on prod 2026-08-01:
//
//   {"success":false,"error":"column \"ii.product_name\" must appear in the
//    GROUP BY clause or be used in an aggregate function"}
//
// Cause: the SELECT listed ii.productName and i.customerName while GROUP BY
// only had (period, productCode, customerId). SQLite allows that and returns
// an arbitrary row's value; Postgres rejects the statement outright.
//
// This is a MIGRATION-RESIDUE class, not a one-off: any query carrying a bare
// non-aggregated column past a GROUP BY was legal on D1 and is fatal now.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(process.cwd(), "src/api/routes/historical-sales.ts"),
  "utf8",
);

// Pull the aggregation statement out of its template literal.
const stmt = (() => {
  const i = src.indexOf("SELECT substr(i.invoiceDate");
  assert.ok(i !== -1, "the aggregation SELECT must exist");
  return src.slice(i, src.indexOf("`", i));
})();


test("every selected column is grouped or aggregated (Postgres-legal)", () => {
  const groupBy = stmt.slice(stmt.indexOf("GROUP BY"));
  const selectList = stmt.slice(0, stmt.indexOf("FROM"));

  const refs = [...selectList.matchAll(/\b([a-z]{1,3})\.([A-Za-z_]+)/g)].map(
    (m) => m[0],
  );
  assert.ok(refs.length > 0, "sanity: the select list references columns");

  for (const full of new Set(refs)) {
    // Substring check rather than a built regex: no escaping games, and an
    // aggregate always appears as FN(<ref> in the select list.
    const aggregated = ["SUM", "MAX", "MIN", "COUNT", "AVG", "substr"].some(
      (fn) => selectList.includes(fn + "(" + full),
    );
    const grouped = groupBy.includes(full);
    assert.ok(
      aggregated || grouped,
      full + " is neither aggregated nor in GROUP BY - Postgres rejects this",
    );
  }
});

test("the two columns that broke prod are aggregated, not merely grouped", () => {
  // Widening GROUP BY would also satisfy Postgres, but it can SPLIT one
  // product/customer into several rows when the stored display name differs
  // between invoices - silently changing the numbers the forecast page reads.
  assert.match(stmt, /MAX\(ii\.productName\)\s+AS "productName"/);
  assert.match(stmt, /MAX\(i\.customerName\)\s+AS "customerName"/);

  const groupBy = stmt.slice(stmt.indexOf("GROUP BY"));
  assert.ok(
    !/productName|customerName/.test(groupBy),
    "names must not be added to GROUP BY - that changes the row grouping",
  );
});

test("the grouping keys themselves are unchanged", () => {
  // The fix must not alter what a row MEANS: still one row per
  // (period x productCode x customerId).
  const groupBy = stmt.slice(stmt.indexOf("GROUP BY"), stmt.indexOf("ORDER BY"));
  assert.match(groupBy, /GROUP BY period, ii\.productCode, i\.customerId/);
});
