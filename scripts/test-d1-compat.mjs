// Adapter smoke test.  Drives the D1Compat shim end-to-end against the real
// Supabase pooler so we can verify:
//   * SQL translation (? → $N, camelCase → snake_case, strftime → to_char)
//   * camelCase auto-transform on returned rows
//   * batch / transaction
// without needing the Worker runtime up.
import fs from 'node:fs'
import postgres from 'postgres'

// Load env
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

// Import the adapter. Node runs .ts via tsx if installed; otherwise fall back
// to loading a small re-implementation. Simpler: since this test file is .mjs
// and the adapter is .ts, run through tsx via child process OR just re-exec
// the logic in JS. Easiest — use Node's native `--experimental-strip-types`
// since we're on Node 24.
import { getSql } from '../src/api/lib/db-pg.ts'
import { D1Compat } from '../src/api/lib/d1-compat.ts'

const sql = getSql(env.DATABASE_URL)
const db = new D1Compat(sql)

async function assert(name, predicate, value) {
  const ok = typeof predicate === 'function' ? predicate(value) : !!predicate
  console.log(`${ok ? '✅' : '❌'} ${name}${value !== undefined ? '  →  ' + JSON.stringify(value).slice(0, 200) : ''}`)
  if (!ok) throw new Error(`FAIL: ${name}`)
}

try {
  // 1. Basic prepare + all — SQL with no camelCase
  {
    const t0 = Date.now()
    const res = await db.prepare('SELECT now() AS ts').all()
    await assert('prepare.all', (r) => r.success && r.results.length === 1, res)
    console.log(`   timing: ${Date.now() - t0}ms`)
  }

  // 2. Parameter substitution (? → $1)
  {
    const res = await db.prepare('SELECT $1::int + $2::int AS sum'.replace(/\$1|\$2/g, '?')).bind(3, 4).first()
    await assert('prepare.bind(3,4).first → 7', (r) => r && r.sum === 7, res)
  }

  // 3. camelCase → snake_case identifier + camelCase row transform
  //    We query the `customers` table which has a `creditLimitSen` column in
  //    SQLite source, mapped to `credit_limit_sen` in Postgres.  The adapter
  //    should rewrite the query AND transform the row back.
  {
    // Insert a throwaway customer
    const id = `test-${Date.now()}`
    await db
      .prepare(
        `INSERT INTO customers (id, code, name, creditLimitSen, outstandingSen, isActive)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, 'T001', 'Test Customer', 500000, 0, 1)
      .run()

    const row = await db
      .prepare('SELECT id, code, name, creditLimitSen, isActive FROM customers WHERE id = ?')
      .bind(id)
      .first()

    await assert(
      'camelCase-in / camelCase-out round trip',
      (r) => r && r.id === id && r.creditLimitSen === 500000 && r.isActive === 1,
      row,
    )

    // Cleanup
    await db.prepare('DELETE FROM customers WHERE id = ?').bind(id).run()
  }

  // 4. batch = transaction
  {
    const id1 = `bt1-${Date.now()}`
    const id2 = `bt2-${Date.now()}`
    await db.batch([
      db.prepare('INSERT INTO customers (id, code, name) VALUES (?,?,?)').bind(id1, 'B1', 'Batch1'),
      db.prepare('INSERT INTO customers (id, code, name) VALUES (?,?,?)').bind(id2, 'B2', 'Batch2'),
    ])
    const count = await db
      .prepare('SELECT count(*)::int AS n FROM customers WHERE id IN (?, ?)')
      .bind(id1, id2)
      .first()
    await assert('batch inserted both rows', (r) => r && r.n === 2, count)
    // Cleanup
    await db.batch([
      db.prepare('DELETE FROM customers WHERE id = ?').bind(id1),
      db.prepare('DELETE FROM customers WHERE id = ?').bind(id2),
    ])
  }

  // 5. strftime rewrite — ensure a route using strftime still works
  {
    const res = await db
      .prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS ts`)
      .first()
    await assert(
      'strftime rewritten and executes',
      (r) => r && typeof r.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.ts),
      res,
    )
  }

  console.log('\n✅ All D1Compat adapter smoke tests passed')
} catch (e) {
  console.error('\n❌', e.message)
  process.exitCode = 1
} finally {
  await sql.end()
}
