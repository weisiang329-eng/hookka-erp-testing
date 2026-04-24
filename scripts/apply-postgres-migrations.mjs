// Apply converted migrations from migrations-postgres/ to Supabase, in order.
// Uses postgres.js + Transaction pooler from DATABASE_URL in .dev.vars.
// Each migration runs in its own transaction so a failure rolls back cleanly.
import fs from 'node:fs'
import path from 'node:path'
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

const sql = postgres(env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  idle_timeout: 4,
  // Pooler disables prepared statements in transaction mode
  prepare: false,
})

const DIR = 'migrations-postgres'

// Data-repair migrations that fix historical D1 rows.  They rely on
// SQLite-specific functions (json_extract / randomblob) AND target pre-existing
// data — irrelevant for a fresh Supabase.  Skip.
const SKIP = new Set(['0027_sofa_upholstery_packing.sql', '0029_refresh_sofa_dept_backfill.sql'])

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

// Nuke partial state from a prior failed run.  Safe because we're the only
// writer and the DB was empty before this script.
console.log('▸ resetting public schema...')
await sql`DROP SCHEMA IF EXISTS public CASCADE`
await sql`CREATE SCHEMA public`
await sql`GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role`

let applied = 0
let skipped = 0
let failed = null
for (const f of files) {
  if (SKIP.has(f)) {
    console.log(`↷ ${f}  (skipped — data-only repair)`)
    skipped++
    continue
  }
  const p = path.join(DIR, f)
  const body = fs.readFileSync(p, 'utf8')
  const t0 = Date.now()
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
    })
    const ms = Date.now() - t0
    console.log(`✓ ${f}  (${ms}ms)`)
    applied++
  } catch (e) {
    failed = { file: f, error: e.message }
    console.error(`✗ ${f}  → ${e.message}`)
    break
  }
}

// Report
if (failed) {
  console.error(`\n❌ Applied ${applied}/${files.length}. Stopped at ${failed.file}.`)
  await sql.end()
  process.exit(1)
}

const tableRows = await sql`
  SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'
`
const indexRows = await sql`
  SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'
`
console.log(`\n✅ Applied ${applied}/${files.length} migrations`)
console.log(`   public tables : ${tableRows[0].n}`)
console.log(`   public indexes: ${indexRows[0].n}`)

await sql.end()
