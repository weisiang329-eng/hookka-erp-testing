// ---------------------------------------------------------------------------
// accounting-company-filter-dimension.test.mjs — BUG-2026-08-13-051.
//
// The Accounting company selector fed `organisations.code.toLowerCase()`
// ("hookka" / "ohana" / "houzs" / "hkmfg") into `?orgId=`, which
// `companyFilter` binds straight into the TENANT column `org_id`. Those are
// two different dimensions and they cannot line up: migration
// 0142_organisations_registry.sql seeds BOTH the HOOKKA and the OHANA
// organisation rows with `org_id = 'hookka'`.
//
// So the control had no correct state:
//   • OHANA / HOUZS / HKMFG  → `org_id = 'ohana'` etc. matches nothing →
//     P&L, Balance Sheet, AR, AP and the Trial Balance render EMPTY, silently;
//   • HOOKKA                 → `org_id = 'hookka'` matches EVERY row → the
//     whole group's money printed under one company's name;
//   • the Balance Sheet's per-company card printed RM 0.00 Net Profit and
//     RM 0.00 Equity for all four (BUG-CLASS C15 — a plausible-looking number
//     with no real source behind it).
//
// The fix does NOT invent a mapping. It cannot: a per-company P&L needs a
// company column on `ledger_journal_entries` and `invoices`, and neither
// table has one. This test pins the four facts that together make that the
// only honest answer, so a future "let's just wire the selector back up"
// fails here with the reason attached rather than shipping a wrong figure.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Strip `//` and block comments. The fix's own explanation quotes the buggy
 * expression verbatim, so a source guard that reads the comments would flag
 * the documentation instead of the code.
 */
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SHARED = "src/pages/accounting/shared.ts";
const ACCOUNTING_PAGE = "src/pages/accounting/index.tsx";
const TENANT = "src/api/lib/tenant.ts";
const MIGRATION = "migrations-postgres/0142_organisations_registry.sql";
const SCHEMA = "tests/db-schema.json";

test("FACT: companyFilter binds its value into the tenant column, not a company one", () => {
  const src = read(TENANT);
  const fn = src.slice(
    src.indexOf("export function companyFilter"),
    src.indexOf("export function companyFilter") + 900,
  );
  assert.match(
    fn,
    /col: string = "org_id"/,
    "companyFilter's default column is org_id — that is what makes a code-valued option wrong",
  );
  assert.match(
    fn,
    /sql: `\$\{col\} = \?`/,
    "companyFilter builds an equality predicate on that column",
  );
  assert.match(
    read(TENANT),
    /export const DEFAULT_ORG_ID = "hookka"/,
    "org_id is the tenant dimension, one value per login account",
  );
});

test("FACT: the registry seeds two DIFFERENT companies under the SAME org_id", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /\('org-hookka', 'hookka', 'HOOKKA'/,
    "HOOKKA organisation row carries org_id 'hookka'",
  );
  assert.match(
    sql,
    /\('org-ohana', 'hookka', 'OHANA'/,
    "OHANA organisation row ALSO carries org_id 'hookka' — code and org_id are not the same dimension",
  );
});

test("FACT: no company dimension exists on the tables the finance reports read", () => {
  const schema = JSON.parse(read(SCHEMA));
  for (const table of ["ledger_journal_entries", "invoices"]) {
    const cols = schema[table];
    assert.ok(Array.isArray(cols), `${table} missing from the prod schema snapshot`);
    assert.ok(
      cols.includes("org_id"),
      `${table} should carry the tenant column org_id`,
    );
    assert.equal(
      cols.some((c) => c === "sales_org_code" || c === "purchase_org_code"),
      false,
      `${table} has no company column — so a per-company P&L cannot be derived from it, and no mapping may be invented`,
    );
  }
  // The dimension DOES exist elsewhere; that is what a real fix would build on.
  assert.ok(schema.sales_orders.includes("sales_org_code"));
  assert.ok(schema.purchase_orders.includes("purchase_org_code"));
});

test("the selector no longer turns organisation CODES into org_id filter values", () => {
  const src = codeOnly(read(SHARED));
  assert.equal(
    /\.toLowerCase\(\)/.test(src),
    false,
    "shared.ts must not lower-case an organisation code into a filter value — that is the bug",
  );
  assert.equal(
    /\/api\/organisations/.test(src),
    false,
    "the selector must not source its options from the organisations registry while org_id is the filtered column",
  );
});

test("useCompanyOptions offers only the consolidated group option, with a stable identity", async () => {
  const { useCompanyOptions, orgIdParam } = await import(
    "../src/pages/accounting/shared.ts"
  );
  const a = useCompanyOptions();
  const b = useCompanyOptions();
  assert.deepEqual(a, [{ value: "", label: "All companies (group)" }]);
  assert.equal(a, b, "the option array identity must be stable across calls");
  // The group option must not change any fetch URL — the unfiltered read is
  // the one that was always correct.
  assert.equal(orgIdParam(""), "");
  assert.equal(orgIdParam("ohana"), "&orgId=ohana");
});

test("CompanySelect renders nothing for a single-option list", () => {
  const src = read(ACCOUNTING_PAGE);
  const fn = src.slice(
    src.indexOf("function CompanySelect("),
    src.indexOf("// =============== TYPES ==============="),
  );
  assert.ok(fn.length > 0, "CompanySelect not found");
  assert.match(
    fn,
    /if \(options\.length <= 1\) return null;/,
    "a selector with one option is a dead control that implies a breakdown which does not exist",
  );
});
