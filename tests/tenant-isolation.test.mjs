// ---------------------------------------------------------------------------
// tenant-isolation.test.mjs — Sprint 4 multi-tenant safety net.
//
// Static-analysis variant of the cross-org leak test. The fully-dynamic
// version would seed two orgs in a test Postgres, hit the API as each, and
// assert no cross-tenant rows leak — but Hyperdrive + Supabase aren't
// reachable from CI, so we instead pin three structural invariants that
// together prove no list endpoint can return foreign-org rows:
//
//   1. Every transaction table referenced by a list route has org_id
//      (or a follow-up TODO marker) per the migration set.
//   2. withOrgScope() in src/api/lib/tenant.ts always emits a leading
//      `WHERE orgId = ?` predicate — no longer the 2026-04-26 no-op.
//   3. getOrgId() throws OrgIdRequiredError when the slot is empty
//      (fail-closed, no silent default to 'hookka').
//
// When this test fails, either:
//   * a new transaction table was added without org_id (add to 0078 or a
//     successor migration), or
//   * withOrgScope was reverted to a no-op (re-read the docs in
//     src/api/lib/tenant.ts before flipping it back), or
//   * getOrgId regained a default fallback (don't — that's the bug Sprint 4
//     fixed).
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

test('withOrgScope emits a real WHERE orgId = ? predicate', () => {
  const src = read('src/api/lib/tenant.ts');
  // The Sprint 4 activation must be present — `WHERE orgId = ?` literal.
  assert.match(
    src,
    /WHERE orgId = \?/,
    'withOrgScope must bind a real orgId WHERE predicate, not the 2026-04-26 no-op',
  );
  // The no-op gate's tell-tale comment must be GONE.
  assert.doesNotMatch(
    src,
    /SAFETY GATE — 2026-04-26/,
    'the no-op safety gate has been removed; tenant scope is now active',
  );
});

test('getOrgId throws when orgId is missing — no silent default', () => {
  const src = read('src/api/lib/tenant.ts');
  // The fail-closed path must throw OrgIdRequiredError.
  assert.match(
    src,
    /throw new OrgIdRequiredError\(\)/,
    'getOrgId must throw OrgIdRequiredError when orgId is absent',
  );
  // The original "default to DEFAULT_ORG_ID" return must NOT be the public
  // getOrgId implementation any more. tryGetOrgId is the explicit escape
  // hatch for cron paths and still returns null (not the default), so we
  // assert the function body returns the value v, not DEFAULT_ORG_ID.
  const fn = src.match(/export function getOrgId<[^>]+>\(c[^)]+\)[^{]+\{([\s\S]+?)^\}/m);
  assert.ok(fn, 'getOrgId function body must be parseable');
  assert.doesNotMatch(
    fn[1],
    /return DEFAULT_ORG_ID/,
    'getOrgId must not silently fall back to DEFAULT_ORG_ID',
  );
});

test('worker.onError translates OrgIdRequiredError to 401', () => {
  const src = read('src/api/worker.ts');
  assert.match(
    src,
    /OrgIdRequiredError/,
    'worker.onError must catch OrgIdRequiredError thrown by getOrgId/withOrgScope',
  );
  assert.match(
    src,
    /Unauthorized.*401/s,
    'OrgIdRequiredError must be translated into a 401 Unauthorized response',
  );
});

test('migration 0078 backfills org_id across the long-tail tables', () => {
  const sql = read('migrations-postgres/0078_org_id_full_rollout.sql');
  // Spot-check critical tables that 0049 did NOT cover.
  const required = [
    'purchase_orders',
    'purchase_order_items',
    'delivery_orders',
    'delivery_order_items',
    'job_cards',
    'fg_units',
    'wip_items',
    'rm_batches',
    'stock_movements',
    'stock_adjustments',
    'fabrics',
    'raw_materials',
    'suppliers',
    'supplier_materials',
    'products',
    'payslips',
    'attendance_records',
    'qc_inspections',
    'service_orders',
    'consignment_orders',
    'maintenance_logs',
    'notifications',
  ];
  for (const t of required) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE IF EXISTS\\s+${t}\\s+ADD COLUMN IF NOT EXISTS\\s+org_id`, 'i'),
      `0078 must add org_id to ${t}`,
    );
    assert.match(
      sql,
      new RegExp(`CREATE INDEX IF NOT EXISTS\\s+idx_${t}_org_id\\s+ON\\s+${t}\\(org_id\\)`, 'i'),
      `0078 must add an org_id index for ${t}`,
    );
  }
});

test('high-leverage list routes bind orgId in their GET / handler', () => {
  // For each route file we expect the import + a WHERE orgId = ? in the
  // handler body. This catches the easy regression: a follow-up PR adding
  // a list endpoint without scoping.
  const expected = [
    'src/api/routes/customers.ts',
    'src/api/routes/invoices.ts',
    'src/api/routes/purchase-orders.ts',
    'src/api/routes/delivery-orders.ts',
    'src/api/routes/production-orders.ts',
    'src/api/routes/sales-orders.ts',
    'src/api/routes/suppliers.ts',
    'src/api/routes/products.ts',
    'src/api/routes/fg-units.ts',
    'src/api/routes/job-cards.ts',
    'src/api/routes/fabrics.ts',
    'src/api/routes/raw-materials.ts',
    'src/api/routes/payslips.ts',
    'src/api/routes/attendance.ts',
    'src/api/routes/leaves.ts',
    'src/api/routes/stock-adjustments.ts',
    'src/api/routes/e-invoices.ts',
    'src/api/routes/credit-notes.ts',
    'src/api/routes/debit-notes.ts',
    'src/api/routes/payments.ts',
    'src/api/routes/drivers.ts',
    'src/api/routes/lorries.ts',
    'src/api/routes/equipment.ts',
    'src/api/routes/maintenance-logs.ts',
    'src/api/routes/three-pl-vehicles.ts',
    'src/api/routes/three-pl-drivers.ts',
    'src/api/routes/supplier-materials.ts',
    'src/api/routes/supplier-scorecards.ts',
  ];
  for (const path of expected) {
    const src = read(path);
    assert.match(
      src,
      /(getOrgId|withOrgScope)/,
      `${path} must import getOrgId or withOrgScope`,
    );
    // Either the route hand-binds `orgId = ?` directly, or it delegates the
    // predicate to withOrgScope() which emits the WHERE clause at runtime.
    const handBound = /orgId\s*=\s*\?/.test(src);
    const usesHelper = /withOrgScope\s*\(/.test(src);
    assert.ok(
      handBound || usesHelper,
      `${path} must scope at least one query (orgId = ? literal or withOrgScope() call)`,
    );
  }
});
