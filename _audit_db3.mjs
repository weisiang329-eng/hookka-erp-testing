import postgres from 'postgres'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n')
    .filter((l) => l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = postgres(env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, idle_timeout: 5 })
try {
  console.log('=== All schemas containing tables we created ===')
  const schemas = await sql`SELECT DISTINCT schemaname FROM pg_stat_user_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname`
  for (const s of schemas) console.log('  ' + s.schemaname)

  console.log('\n=== schema_migrations / migrations across ALL schemas ===')
  const m = await sql`SELECT schemaname, relname, n_live_tup::int FROM pg_stat_user_tables WHERE relname IN ('schema_migrations','migrations','d1_migrations') ORDER BY schemaname, relname`
  for (const r of m) console.log(`  ${r.schemaname}.${r.relname}: ${r.n_live_tup} rows`)

  console.log('\n=== expired user_sessions (token TTL) ===')
  const exp = await sql`SELECT COUNT(*)::int AS expired, COUNT(*) FILTER (WHERE expires_at < NOW())::int AS gone, COUNT(*) FILTER (WHERE expires_at >= NOW())::int AS active FROM user_sessions`
  console.log(`  ${JSON.stringify(exp[0])}`)

  console.log('\n=== empty tables (zero rows) ===')
  const empties = await sql`SELECT relname FROM pg_stat_user_tables WHERE schemaname='public' AND n_live_tup = 0 ORDER BY relname`
  console.log(`  ${empties.length} empty tables`)
  console.log('  ' + empties.map(r => r.relname).join(', '))

  console.log('\n=== DB size ===')
  const size = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`
  console.log('  ' + size[0].size)
} finally {
  await sql.end()
}
