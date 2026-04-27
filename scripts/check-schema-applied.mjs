// Schema-diff guard for CI.
//
// Walks every migrations-postgres/*.sql file, harvests the table names
// declared via `CREATE TABLE [IF NOT EXISTS] <name>` (skipping `... AS SELECT`
// view-style statements), then queries live Postgres for the actual public
// tables. If migrations promise tables the database doesn't have, the
// script exits non-zero with a pointer to the offending migration.
//
// Triggered by .github/workflows/deploy.yml AFTER the Pages deploy step.
// Reads DATABASE_URL from the env (CI sets it from secrets - use the
// Supabase pooler URL on port 6543).
//
// Flags:
//   --dry-run   print expected/actual without exiting non-zero
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

const DRY_RUN = process.argv.includes('--dry-run')
const DIR = 'migrations-postgres'

// `CREATE TABLE [IF NOT EXISTS] <name>` - capture the name, ignore views.
// Handles optional schema qualifier (`public.foo`) and quoted identifiers.
const RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*(?!as\b)/gi

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const expected = new Map() // table -> first migration that creates it
for (const f of files) {
  const body = fs.readFileSync(path.join(DIR, f), 'utf8')
  // Strip line + block comments so they cannot host fake matches.
  const clean = body.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(RE)) {
    // Guard against `CREATE TABLE foo AS SELECT ...` - RE already negates
    // a trailing `as` token but a stray match is cheap to double-check.
    const tail = clean.slice(m.index + m[0].length, m.index + m[0].length + 32)
    if (/^\s*as\s/i.test(tail)) continue
    const name = m[1].toLowerCase()
    if (!expected.has(name)) expected.set(name, f)
  }
}

const url = process.env.DATABASE_URL
if (!url) {
  // Soft-skip when the secret is missing - we don't want every CI run to
  // turn red just because the schema-diff secret hasn't been provisioned
  // yet. The actual Pages deploy already ran by this point, so blocking
  // the workflow on a missing audit secret is overkill. Surface a warning
  // banner and exit 0 so the deploy stays green.
  console.warn('::warning::DATABASE_URL not set - skipping schema-diff check. Set DATABASE_URL repo secret (Supabase pooler URL on port 6543) to enable post-deploy schema verification.')
  process.exit(0)
}

const sql = postgres(url, { ssl: 'require', max: 1, idle_timeout: 4, prepare: false })
const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
await sql.end()

const actual = new Set(rows.map((r) => r.table_name.toLowerCase()))
const missing = [...expected.keys()].filter((t) => !actual.has(t)).sort()

console.log(`Expected ${expected.size} tables across ${files.length} migrations; live DB has ${actual.size}.`)
if (DRY_RUN) {
  if (missing.length) console.log(`(dry-run) missing: ${missing.join(', ')}`)
  process.exit(0)
}

if (missing.length) {
  console.error('\nSchema drift detected - these tables are declared in migrations-postgres/ but missing from live Postgres:')
  for (const t of missing) console.error(`  - ${t}  (declared in ${expected.get(t)})`)
  console.error('\nFix: run `node scripts/apply-postgres-migrations.mjs` against the same DATABASE_URL, or apply the offending migration via the Supabase SQL Editor.')
  process.exit(1)
}

console.log('OK - every migration-declared table exists in live Postgres.')
