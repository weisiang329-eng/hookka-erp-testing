// One-shot connection smoke test for Supabase Transaction pooler.
// Reads .dev.vars (simple KEY=VALUE) to avoid adding dotenv dep.
// Usage: node scripts/test-supabase.mjs
import fs from 'node:fs'
import postgres from 'postgres'

const envText = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const url = env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL missing in .dev.vars')

console.log('Connecting to:', url.replace(/:[^:@]+@/, ':***@'))
const sql = postgres(url, { ssl: 'require', max: 1, idle_timeout: 2 })

try {
  const t0 = Date.now()
  const rows = await sql`SELECT version() AS version, now() AS now, current_database() AS db, current_user AS "user"`
  const ms = Date.now() - t0
  console.log('✅ connected in', ms, 'ms')
  console.log(rows[0])

  const t1 = Date.now()
  const count = await sql`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`
  console.log('public tables:', count[0].n, '(' + (Date.now() - t1) + 'ms)')
} catch (e) {
  console.error('❌ connection failed:', e.message)
  process.exitCode = 1
} finally {
  await sql.end()
}
