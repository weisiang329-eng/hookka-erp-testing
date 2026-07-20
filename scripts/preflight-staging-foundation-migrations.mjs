#!/usr/bin/env node
import postgres from 'postgres'
import { parseSupabaseTarget } from './validate-db-sync-targets.mjs'

const databaseUrl = String(process.env.DATABASE_URL ?? '').trim()
const expectedRef = String(process.env.EXPECTED_SUPABASE_PROJECT_REF ?? '').trim().toLowerCase()

if (!databaseUrl || !expectedRef) {
  console.error('DATABASE_URL and EXPECTED_SUPABASE_PROJECT_REF are required.')
  process.exit(1)
}

let target
try {
  target = parseSupabaseTarget(databaseUrl, 'DATABASE_URL')
} catch (error) {
  console.error(`Staging migration preflight refused the target: ${error.message}`)
  process.exit(1)
}

if (target.projectRef !== expectedRef) {
  console.error('Staging migration preflight refused a database/project-ref mismatch.')
  process.exit(1)
}

const sql = postgres(databaseUrl, {
  ssl: 'require',
  max: 1,
  idle_timeout: 4,
  prepare: false,
})

try {
  const [duplicateInvoices] = await sql`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT org_id, delivery_order_id
      FROM invoices
      WHERE status <> 'CANCELLED'
        AND delivery_order_id IS NOT NULL
        AND delivery_order_id <> ''
      GROUP BY org_id, delivery_order_id
      HAVING COUNT(*) > 1
    ) duplicates
  `
  const [arBalanceDrift] = await sql`
    SELECT COUNT(*)::int AS count
    FROM invoices
    WHERE paid_amount < 0 OR paid_amount > total_sen
  `
  const [apBalanceDrift] = await sql`
    SELECT COUNT(*)::int AS count
    FROM purchase_invoices
    WHERE paid_amount_sen < 0 OR paid_amount_sen > amount_sen
  `

  console.log(`Validated staging migration target: ${target.projectRef}`)
  console.log(`Active invoice/DO duplicate groups: ${duplicateInvoices.count}`)
  console.log(`Historical AR paid-balance exceptions: ${arBalanceDrift.count}`)
  console.log(`Historical AP paid-balance exceptions: ${apBalanceDrift.count}`)

  if (duplicateInvoices.count > 0) {
    console.error('Preflight failed: resolve active invoice/DO duplicates in staging before migration 0209.')
    process.exitCode = 1
  }
  if (arBalanceDrift.count > 0 || apBalanceDrift.count > 0) {
    console.log('::warning::Historical payment balance exceptions remain for audit; 0210 uses NOT VALID and protects new writes.')
  }
} finally {
  await sql.end()
}
