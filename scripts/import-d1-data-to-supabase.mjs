// Import D1 SQL dump (INSERT statements only) into Supabase Postgres.
//
// The dump contains:
//   - PRAGMA / CREATE TABLE / CREATE INDEX      → skip (schema already set)
//   - INSERT INTO "d1_migrations" ...           → skip (D1 internal)
//   - INSERT INTO "<table>" (<cols>) VALUES ... → translate + execute
//
// Translation (per scripts/d1-to-postgres.mjs):
//   * Table / column identifiers:  camelCase → snake_case (via rename map)
//   * Column list quoting:          "shortName" → short_name  (strip quotes too)
//
// FK constraints are deferred for the whole import via
//   SET session_replication_role = replica;
// which tells Postgres to skip trigger-enforced constraints (incl. FK).
// Restored at the end.
import fs from 'node:fs'
import postgres from 'postgres'

// ---- env ------------------------------------------------------------------
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
if (!env.DATABASE_URL) throw new Error('DATABASE_URL missing in .dev.vars')

// ---- rename map -----------------------------------------------------------
const renameMap = JSON.parse(
  fs.readFileSync('migrations-postgres/_rename_map.json', 'utf8'),
)

// ---- dump -----------------------------------------------------------------
const dump = fs.readFileSync('d1-backup.sql', 'utf8')
console.log(`loaded ${(dump.length / 1_048_576).toFixed(1)} MiB dump`)

// Split by lines — each INSERT is on its own line in wrangler's dump format.
const lines = dump.split(/\r?\n/)

/** Convert a SQLite quoted column identifier to Postgres snake_case, unquoted. */
function translateIdent(raw) {
  // `"foo"` → foo
  const m = raw.match(/^"([^"]+)"$/)
  const name = m ? m[1] : raw
  return renameMap[name] ?? name
}

/** Transform SQLite-specific function calls in a VALUES fragment to Postgres
 *  equivalents. Called on the VALUES portion of every INSERT so we don't
 *  accidentally rewrite inside identifiers. */
function translateSqliteFunctions(values) {
  // char(N) → chr(N).  SQLite exposes char() and chr() interchangeably for
  // single-byte codepoints; Postgres only has chr().  Seen in the D1 dump as
  // `replace(..., '\n', char(10))` — dropping rows with embedded newlines.
  return values.replace(/\bchar\(/gi, 'chr(')
}

/** Transform a single INSERT line. Returns null to skip. */
function transformInsertLine(line) {
  // Match: INSERT INTO "table" ("c1","c2",...) VALUES ...
  const m = line.match(/^INSERT INTO "([^"]+)"\s*\(([^)]+)\)\s*VALUES\s*(\(.*\));?\s*$/)
  if (!m) return null
  const [, table, colListRaw, valuesPart] = m
  if (table === 'd1_migrations') return null

  // Table name → snake_case via rename map (nearly always a no-op; tables
  // are already snake_case in our schema).
  const tablePg = renameMap[table] ?? table

  // Columns: split on comma, trim, translate, drop quotes.
  const cols = colListRaw
    .split(',')
    .map((c) => translateIdent(c.trim()))
    .join(', ')

  return `INSERT INTO ${tablePg} (${cols}) VALUES ${translateSqliteFunctions(valuesPart)};`
}

const inserts = []
let skipped = 0
for (const line of lines) {
  if (!line.startsWith('INSERT INTO ')) continue
  const out = transformInsertLine(line)
  if (out === null) {
    skipped++
    continue
  }
  inserts.push(out)
}
console.log(`extracted ${inserts.length} INSERTs (skipped ${skipped})`)

// ---- execute --------------------------------------------------------------
const sql = postgres(env.DATABASE_URL, {
  ssl: 'require',
  prepare: false,
  max: 1,
  idle_timeout: 4,
})

try {
  // session_replication_role MUST be scoped to a single transaction (SET
  // LOCAL) — if we set it globally on a Supavisor transaction-mode pooler
  // connection, the pooler may hand the same backend to another request
  // afterwards with FK triggers still disabled (known PgBouncer/Supavisor
  // footgun).  Per-batch transactions keep the setting local to the tx.
  console.log('using per-batch transactions with SET LOCAL session_replication_role = replica')

  const BATCH = 200
  let done = 0
  const failures = []
  const t0 = Date.now()
  for (let i = 0; i < inserts.length; i += BATCH) {
    const chunkStmts = inserts.slice(i, i + BATCH)
    try {
      // SET LOCAL is committed/rolled back with the transaction — never
      // leaks to the next pooled tenant.
      await sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL session_replication_role = replica')
        await tx.unsafe(chunkStmts.join('\n'))
      })
    } catch (e) {
      // Batch failed. Retry each statement individually so we can pinpoint
      // the bad one(s) without aborting the whole import.  Same tx scope
      // for each single-stmt retry.
      console.log(`  batch ${i} failed: "${e.message.slice(0, 80)}"  — retrying one-by-one`)
      for (let k = 0; k < chunkStmts.length; k++) {
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe('SET LOCAL session_replication_role = replica')
            await tx.unsafe(chunkStmts[k])
          })
        } catch (e2) {
          failures.push({
            index: i + k,
            error: e2.message,
            stmt: chunkStmts[k].slice(0, 300),
          })
        }
      }
    }
    done += chunkStmts.length
    if (done % 2000 === 0 || done === inserts.length) {
      const pct = ((done / inserts.length) * 100).toFixed(1)
      console.log(`  ${done}/${inserts.length} (${pct}%)  ${Date.now() - t0}ms  failures=${failures.length}`)
    }
  }

  if (failures.length) {
    console.log(`\n⚠️ ${failures.length} failed statements:`)
    for (const f of failures.slice(0, 10)) {
      console.log(`  [${f.index}] ${f.error}`)
      console.log(`           ${f.stmt}`)
    }
    if (failures.length > 10) console.log(`  ... +${failures.length - 10} more`)
  }

  console.log(`\n✅ Processed ${done} rows in ${Date.now() - t0}ms (${failures.length} failed)`)

  // Sanity: row counts in a few pilot tables
  const checks = [
    'customers',
    'products',
    'sales_orders',
    'production_orders',
    'job_cards',
    'users',
    'workers',
  ]
  for (const t of checks) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${t}`)
    console.log(`  ${t.padEnd(20)} ${n}`)
  }
} catch (e) {
  console.error('\n❌ import aborted early')
  console.error(e.message)
  process.exitCode = 1
} finally {
  await sql.end()
}
