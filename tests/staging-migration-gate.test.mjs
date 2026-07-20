import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(path, 'utf8')

test('staging deploy applies only the reviewed migration allow-list', () => {
  const workflow = read('.github/workflows/deploy.yml')
  assert.match(workflow, /node-version: 22/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/staging'/)
  assert.match(workflow, /secrets\.STAGING_DATABASE_URL/)
  assert.equal(
    (workflow.match(/EXPECTED_SUPABASE_PROJECT_REF: zaxygxwadidiqcphibma/g) ?? []).length,
    3,
  )
  assert.doesNotMatch(workflow, /vars\.STAGING_SUPABASE_PROJECT_REF/)
  for (const migration of [
    '0208_api_idempotency.sql',
    '0209_invoice_active_do_unique.sql',
    '0210_payment_balance_guards.sql',
    '0211_invoice_payment_receipt_link.sql',
  ]) {
    assert.match(workflow, new RegExp(migration.replace('.', '\\.')))
  }
  assert.match(workflow, /preflight-staging-foundation-migrations\.mjs/)
  assert.match(workflow, /db:migrate:supabase:dry/)
  assert.match(workflow, /run: npm run db:migrate:supabase(?:\r?\n)/)
})

test('incremental applier accepts CI secrets but validates target and pending files', () => {
  const source = read('scripts/apply-postgres-migrations-incremental.mjs')
  assert.match(source, /process\.env\.DATABASE_URL/)
  assert.match(source, /EXPECTED_SUPABASE_PROJECT_REF/)
  assert.match(source, /parseSupabaseTarget/)
  assert.match(source, /MIGRATION_ALLOWED_PENDING/)
  assert.match(source, /pending migration\(s\) outside/)
})

test('preflight blocks duplicate active invoices without exposing row data', () => {
  const source = read('scripts/preflight-staging-foundation-migrations.mjs')
  assert.match(source, /GROUP BY org_id, delivery_order_id/)
  assert.match(source, /HAVING COUNT\(\*\) > 1/)
  assert.match(source, /Historical AR paid-balance exceptions/)
  assert.match(source, /Historical AP paid-balance exceptions/)
  assert.doesNotMatch(source, /SELECT \*/)
})
