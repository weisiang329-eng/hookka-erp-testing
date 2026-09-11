// T-006 R5 — DB backstop for GRN->PI / PO->PI invoice ceiling, mirroring the
// sales-side chk_doi_invoiced_qty. No live D1 in CI (same constraint as
// item-group-change-is-audited.test.mjs) — checks are source-static.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('migration record exists and guards the ADD CONSTRAINT (Postgres has no IF NOT EXISTS for constraints)', () => {
  assert.equal(existsSync('migrations-postgres/0233_grn_items_invoiced_qty_check.sql'), true);
  const sql = readFileSync('migrations-postgres/0233_grn_items_invoiced_qty_check.sql', 'utf8');
  assert.match(sql, /DO \$\$/);
  assert.match(sql, /EXCEPTION WHEN duplicate_object/);
  assert.match(sql, /CHECK \(invoiced_qty >= 0 AND invoiced_qty <= accepted_qty\)/);
});

test('the runtime self-apply (the load-bearing copy) adds the same constraint', () => {
  const src = readFileSync('src/api/routes/purchase-invoices.ts', 'utf8');
  assert.match(
    src,
    /ALTER TABLE grn_items ADD CONSTRAINT chk_grn_items_invoiced_qty CHECK \(invoiced_qty >= 0 AND invoiced_qty <= accepted_qty\)/,
    'must be in the ensurePiMigrations self-apply stmts array, not just the migration file',
  );
});

test('the constraint is added NOT VALID — existing rows are never checked at install time', () => {
  // A validating ADD CONSTRAINT checks every existing row immediately. This
  // repo has already measured real over-invoicing history (that's why the
  // constraint exists), so a validating add could hit a bad historical row
  // and fail to install — which runs before every PI create/edit, so that
  // failure would block the whole feature, not just future races.
  const migrationSql = readFileSync('migrations-postgres/0233_grn_items_invoiced_qty_check.sql', 'utf8');
  assert.match(migrationSql, /CHECK \(invoiced_qty >= 0 AND invoiced_qty <= accepted_qty\) NOT VALID/);

  const routeSrc = readFileSync('src/api/routes/purchase-invoices.ts', 'utf8');
  assert.match(
    routeSrc,
    /ALTER TABLE grn_items ADD CONSTRAINT chk_grn_items_invoiced_qty CHECK \(invoiced_qty >= 0 AND invoiced_qty <= accepted_qty\) NOT VALID/,
    'the runtime self-apply (the actual mechanism) must use NOT VALID too, not just the migration record',
  );
});

test('a raced check-constraint violation on create is translated to a clean 409, not a raw 500', () => {
  const src = readFileSync('src/api/routes/purchase-invoices.ts', 'utf8');
  const createMatches = src.match(/errCode === "23514" \|\| \/chk_grn_items_invoiced_qty\/\.test\(/g) ?? [];
  assert.equal(createMatches.length, 2, 'both create (POST /) and edit (PUT /:id) write paths must translate the violation');
  assert.match(src, /available quantity was just consumed by another invoice/);
});

test('the 409 translation on create happens BEFORE the legacy-column retry fallback', () => {
  const src = readFileSync('src/api/routes/purchase-invoices.ts', 'utf8');
  const checkIdx = src.indexOf('errCode === "23514"');
  const legacyIdx = src.indexOf('Pre-migration-0162 DB');
  assert.ok(checkIdx > 0 && legacyIdx > 0, 'both markers must be present');
  assert.ok(
    checkIdx < legacyIdx,
    'a raced ceiling violation must return 409 immediately, not fall through to a retry that could drop the grn_items increment statement entirely',
  );
});
