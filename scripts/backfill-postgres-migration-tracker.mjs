// ---------------------------------------------------------------------------
// One-time backfill: mark every existing migration file as already-applied
// in the `_migrations` tracker EXCEPT the three pending files (0061, 0062,
// 0063).
//
// Why this exists:
//   The new incremental applier (apply-postgres-migrations-incremental.mjs)
//   would otherwise try to re-apply ALL migrations on its first run against
//   the existing prod Supabase, which would fail because the tables already
//   exist. This script seeds the tracker so the next incremental run only
//   tries the three actually-pending files.
//
// Usage:
//   node scripts/backfill-postgres-migration-tracker.mjs           # do it
//   node scripts/backfill-postgres-migration-tracker.mjs --dry-run # preview
//
// Safe to re-run: uses INSERT ... ON CONFLICT DO NOTHING. The list of
// "pending" filenames is hard-coded — adjust PENDING_FILES below if the
// set of unapplied migrations on your target DB differs.
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import postgres from 'postgres'

const DRY_RUN = process.argv.includes('--dry-run')
const DIR = 'migrations-postgres'

// Filenames that are NOT yet on the live Supabase prod DB. Anything else
// in migrations-postgres/ is presumed already-applied and will be marked
// as such. Keep this list in sync with reality before running.
const PENDING_FILES = new Set([
  '0061_working_hour_entries.sql',
  '0062_dept_isProduction_and_admin.sql',
  '0063_three_pl_vehicles_drivers.sql',
])

// --- env loading ----------------------------------------------------------

const DEV_VARS = new URL('../.dev.vars', import.meta.url)
let env
try {
  const text = fs.readFileSync(DEV_VARS, 'utf8')
  env = Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('\nERROR: .dev.vars not found at repo root.')
    console.error('       Create it with at minimum a DATABASE_URL line, e.g.')
    console.error('         DATABASE_URL=postgresql://USER:PASS@HOST:6543/postgres?sslmode=require')
    console.error('       See docs/SETUP.md and migrations-postgres/README.md.\n')
    process.exit(1)
  }
  throw err
}

if (!env.DATABASE_URL) {
  console.error('\nERROR: DATABASE_URL missing from .dev.vars.\n')
  process.exit(1)
}

const sql = postgres(env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  idle_timeout: 4,
  prepare: false,
})

// --- file discovery -------------------------------------------------------

let files
try {
  files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`\nERROR: ${DIR}/ directory not found. Run from repo root.\n`)
    await sql.end()
    process.exit(1)
  }
  throw err
}

const toMark = files.filter((f) => !PENDING_FILES.has(f))
const willSkip = files.filter((f) => PENDING_FILES.has(f))

console.log(`▸ ${files.length} migration files in ${DIR}/`)
console.log(`▸ ${toMark.length} will be marked as already-applied`)
console.log(`▸ ${willSkip.length} left as pending (not in tracker yet):`)
for (const f of willSkip) console.log(`     • ${f}`)

if (DRY_RUN) {
  console.log('\n[DRY-RUN] Would mark the following as applied:')
  for (const f of toMark) console.log(`   • ${f}`)
  console.log('\nNo changes made. Re-run without --dry-run to backfill.')
  await sql.end()
  process.exit(0)
}

// --- ensure tracker table -------------------------------------------------

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

// --- backfill -------------------------------------------------------------

let inserted = 0
let already = 0
for (const f of toMark) {
  const result = await sql`
    INSERT INTO _migrations (filename) VALUES (${f})
    ON CONFLICT (filename) DO NOTHING
    RETURNING filename
  `
  if (result.length > 0) {
    inserted++
  } else {
    already++
  }
}

console.log('')
console.log(`Done. Inserted ${inserted} tracker rows. ${already} already present.`)
console.log(`Next: run 'npm run db:migrate:supabase:dry' to confirm only the`)
console.log(`pending files (above) will be applied, then 'npm run db:migrate:supabase'.`)

await sql.end()
