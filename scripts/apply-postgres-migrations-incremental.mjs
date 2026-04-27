// ---------------------------------------------------------------------------
// Incremental Postgres migration applier (Supabase, via postgres.js).
//
// Replaces the destructive scripts/apply-postgres-migrations.mjs --reset
// flow for ongoing schema evolution. Tracks applied filenames in a
// `_migrations` table so re-runs are idempotent and only NEW files run.
//
// Usage:
//   node scripts/apply-postgres-migrations-incremental.mjs           # apply
//   node scripts/apply-postgres-migrations-incremental.mjs --dry-run # preview
//
// Reads DATABASE_URL from .dev.vars (same pattern as the legacy --reset
// script). Each migration runs inside its own transaction with the
// `_migrations` insert in the same tx — so a failed SQL leaves no trace
// in the tracker, and re-running picks up exactly where it stopped.
//
// First-run-on-existing-prod gotcha: the schema already exists, so most
// migrations would fail trying to re-create tables. Run
//   node scripts/backfill-postgres-migration-tracker.mjs
// ONCE to mark every pre-existing migration as already-applied. After
// that this script will only attempt files newer than the latest
// backfilled migration.
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

const DRY_RUN = process.argv.includes('--dry-run')
const DIR = 'migrations-postgres'

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
  console.error('\nERROR: DATABASE_URL missing from .dev.vars.')
  console.error('       Add a line like:')
  console.error('         DATABASE_URL=postgresql://USER:PASS@HOST:6543/postgres?sslmode=require')
  console.error('       Use the Supabase Connection Pooler (transaction mode, port 6543).\n')
  process.exit(1)
}

const sql = postgres(env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  idle_timeout: 4,
  // Supabase pooler in transaction mode disables prepared statements.
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
    console.error(`\nERROR: ${DIR}/ directory not found. Are you running from the repo root?\n`)
    await sql.end()
    process.exit(1)
  }
  throw err
}

if (files.length === 0) {
  console.log(`No .sql files in ${DIR}/. Nothing to do.`)
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

const applied = new Set(
  (await sql`SELECT filename FROM _migrations`).map((r) => r.filename),
)

const pending = files.filter((f) => !applied.has(f))

console.log(`▸ ${files.length} migration files in ${DIR}/`)
console.log(`▸ ${applied.size} already applied (per _migrations table)`)
console.log(`▸ ${pending.length} pending`)

if (pending.length === 0) {
  console.log('\nNothing to apply.')
  await sql.end()
  process.exit(0)
}

if (DRY_RUN) {
  console.log('\n[DRY-RUN] Would apply (in order):')
  for (const f of pending) console.log(`   • ${f}`)
  console.log('\nNo changes made. Re-run without --dry-run to apply.')
  await sql.end()
  process.exit(0)
}

// --- apply ----------------------------------------------------------------

let appliedCount = 0
let failed = null
for (const f of pending) {
  const p = path.join(DIR, f)
  const body = fs.readFileSync(p, 'utf8')
  const t0 = Date.now()
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO _migrations (filename) VALUES (${f})`
    })
    const ms = Date.now() - t0
    console.log(`  applied  ${f}  (${ms}ms)`)
    appliedCount++
  } catch (e) {
    failed = { file: f, error: e.message }
    console.error(`  FAILED   ${f}  -> ${e.message}`)
    break
  }
}

console.log('')
if (failed) {
  console.error(
    `Stopped after ${appliedCount}/${pending.length} new migrations. ` +
      `Failure in ${failed.file}.`,
  )
  console.error('Fix the SQL and re-run; already-applied migrations are tracked and will be skipped.')
  await sql.end()
  process.exit(1)
}

console.log(
  `Done. Applied ${appliedCount} new migration(s). ` +
    `Skipped ${applied.size} already-applied. 0 failures.`,
)
await sql.end()
