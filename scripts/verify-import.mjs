import fs from 'node:fs'
import postgres from 'postgres'

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const sql = postgres(env.DATABASE_URL, { ssl: 'require', prepare: false, max: 1 })

// Use ANALYZE first to refresh planner stats, then read n_live_tup.
await sql`ANALYZE`
const rows = await sql`
  SELECT relname AS tablename, n_live_tup::int AS n
  FROM pg_stat_user_tables
  WHERE schemaname = 'public'
  ORDER BY n_live_tup DESC
`

const withData = rows.filter(r => r.n > 0)
const empty = rows.filter(r => r.n === 0)

console.log(`=== ${withData.length} tables with data ===`)
for (const r of withData) console.log(`  ${r.tablename.padEnd(30)} ${r.n}`)

console.log(`\n=== ${empty.length} empty tables ===`)
console.log('  ', empty.map(r => r.tablename).join(', '))

const total = withData.reduce((a, r) => a + r.n, 0)
console.log(`\ntotal rows: ${total.toLocaleString()}`)

await sql.end()
