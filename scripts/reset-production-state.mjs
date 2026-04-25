// One-shot: reset all Production state (job_cards completion + wip_items stock
// + production_orders status) back to "nothing has started".  Useful when
// testing the full production lifecycle from scratch without re-seeding the
// whole DB.
//
// What it does (in a single transaction so partial failure rolls back):
//   1. job_cards.completedDate = ''
//      job_cards.status = 'WAITING' for any row that was COMPLETED/TRANSFERRED
//      job_cards.actualMinutes = NULL
//      job_cards.pic1Id / pic2Id / pic1Name / pic2Name = NULL/''
//   2. wip_items.stockQty = 0
//      wip_items.status = 'IN_PRODUCTION'
//   3. production_orders.status = 'PENDING' for any row that was COMPLETED
//      production_orders.completedDate = ''
//      production_orders.stockedIn = 0
//
// What it does NOT touch:
//   - so_status_changes (audit history)
//   - audit_events (audit history)
//   - sales_orders (header table — SO confirmation still stands)
//   - fg_units (the FG units already generated stay; their state will be
//     re-evaluated as upstream JCs roll back)
//   - rack_items / rack_locations (warehouse arrangement)
//
// Idempotent: re-running rewrites identical values (UPDATE WHERE clauses
// are correct on second pass too).
import postgres from 'postgres'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n')
    .filter((l) => l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }),
)
const sql = postgres(env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, idle_timeout: 5 })

try {
  console.log('Pre-state counts:')
  const jcsBefore = await sql`SELECT status, COUNT(*)::int AS n FROM job_cards GROUP BY status ORDER BY n DESC`
  for (const r of jcsBefore) console.log(`  job_cards.${r.status}: ${r.n}`)

  const wipBefore = await sql`SELECT COUNT(*)::int AS rows, SUM(stock_qty)::int AS total FROM wip_items WHERE stock_qty > 0`
  console.log(`  wip_items with stockQty>0: ${wipBefore[0].rows} rows totalling ${wipBefore[0].total}`)

  const poBefore = await sql`SELECT status, COUNT(*)::int AS n FROM production_orders GROUP BY status ORDER BY n DESC`
  for (const r of poBefore) console.log(`  production_orders.${r.status}: ${r.n}`)

  console.log('\nApplying reset…')
  await sql.begin(async (tx) => {
    const jcRes = await tx`
      UPDATE job_cards
         SET completed_date = '',
             status = 'WAITING',
             actual_minutes = NULL,
             pic1_id = NULL, pic1_name = '',
             pic2_id = NULL, pic2_name = ''
       WHERE status IN ('COMPLETED','TRANSFERRED')
          OR (completed_date IS NOT NULL AND completed_date <> '')`
    console.log(`  job_cards reset: ${jcRes.count} rows`)

    const wiRes = await tx`
      UPDATE wip_items
         SET stock_qty = 0,
             status = 'IN_PRODUCTION'
       WHERE stock_qty > 0 OR status = 'COMPLETED'`
    console.log(`  wip_items reset:  ${wiRes.count} rows`)

    const poRes = await tx`
      UPDATE production_orders
         SET status = 'PENDING',
             completed_date = '',
             stocked_in = 0
       WHERE status = 'COMPLETED'
          OR stocked_in = 1
          OR (completed_date IS NOT NULL AND completed_date <> '')`
    console.log(`  production_orders reset: ${poRes.count} rows`)
  })

  console.log('\nPost-state counts:')
  const jcsAfter = await sql`SELECT status, COUNT(*)::int AS n FROM job_cards GROUP BY status ORDER BY n DESC`
  for (const r of jcsAfter) console.log(`  job_cards.${r.status}: ${r.n}`)
  const wipAfter = await sql`SELECT COUNT(*)::int AS rows, SUM(stock_qty)::int AS total FROM wip_items WHERE stock_qty > 0`
  console.log(`  wip_items with stockQty>0: ${wipAfter[0].rows} rows totalling ${wipAfter[0].total ?? 0}`)
  const poAfter = await sql`SELECT status, COUNT(*)::int AS n FROM production_orders GROUP BY status ORDER BY n DESC`
  for (const r of poAfter) console.log(`  production_orders.${r.status}: ${r.n}`)

  console.log('\nDone. Hard-refresh the production page to see all JCs back to WAITING + zero WIP stock.')
} finally { await sql.end() }
