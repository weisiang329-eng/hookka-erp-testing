// ---------------------------------------------------------------------------
// [LEGACY-NAMED COMPONENT, but actively load-bearing.]
// D1 → Supabase Postgres compatibility adapter.
//
// The "D1" in the name reflects the *interface shape* this exposes
// (Cloudflare's `D1Database` API surface), not the destination — every
// query routed through here lands in Postgres. The real D1 binding was
// retired 2026-04-27 (commit 7059259). This adapter is the bridge that
// lets ~60 route files keep their existing `c.var.DB.prepare(...)` calls
// unchanged while talking to Supabase under the hood.
//
// Wraps a postgres.js client and exposes a *subset* of the Cloudflare D1
// `D1Database` interface — just enough that existing routes written against
// `env.DB.prepare(...)` keep working unchanged.
//
// Responsibilities:
//   1. Translate `?` placeholders to Postgres `$1`, `$2`, ... positional
//      parameters (outside string literals / comments).
//   2. Rewrite camelCase identifiers to their snake_case Postgres names
//      using the rename map emitted by scripts/d1-to-postgres.mjs.
//   3. Swap SQLite-only syntax (INSERT OR IGNORE, strftime, datetime('now'))
//      to Postgres equivalents.
//   4. Return result shapes matching D1Database: { results, success, meta }.
//
// NOT supported:
//   * INSERT OR REPLACE — must be rewritten to explicit
//     `INSERT INTO ... ON CONFLICT (cols) DO UPDATE SET ...` in the route.
//   * exec() / dump() / D1 admin APIs — these routes don't use them.
// ---------------------------------------------------------------------------
import type { Sql } from 'postgres'
import renameMapJson from './column-rename-map.json' with { type: 'json' }

const renameMap = renameMapJson as Record<string, string>

// --- SQL transform ---------------------------------------------------------

/**
 * Walk the SQL string, preserving comments and string literals, and:
 *   * replace each bare `?` with `$N` (N = 1-based position of `?`)
 *   * rewrite each mixed-case identifier to snake_case (via renameMap)
 *
 * Returns the translated SQL.  Assumes dialect-level rewrites (INSERT OR
 * IGNORE, strftime, datetime('now')) have already been applied.
 */
function transformBody(sql: string): string {
  let out = ''
  let i = 0
  let paramIdx = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]

    // Line comment
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      out += sql.slice(i, end === -1 ? n : end)
      i = end === -1 ? n : end
      continue
    }
    // Block comment
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      out += sql.slice(i, end === -1 ? n : end + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    // Single-quoted string
    if (c === "'") {
      out += c
      i++
      let closed = false
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''"
          i += 2
          continue
        }
        out += sql[i]
        if (sql[i] === "'") {
          i++
          closed = true
          break
        }
        i++
      }
      // Unterminated string literals would let the rest of the SQL run
      // through the identifier rewriter with quoting disabled — a silent
      // footgun if a future caller interpolates user input into the raw
      // SQL template.  Fail loud.
      if (!closed) {
        throw new Error(
          "translateSql: unterminated string literal in SQL — refuse to rewrite identifiers past it",
        )
      }
      continue
    }
    // Already double-quoted identifier — pass through verbatim
    if (c === '"') {
      const end = sql.indexOf('"', i + 1)
      out += sql.slice(i, end === -1 ? n : end + 1)
      i = end === -1 ? n : end + 1
      continue
    }
    // Question mark placeholder → $N
    if (c === '?') {
      paramIdx++
      out += '$' + paramIdx
      i++
      continue
    }
    // Bare identifier
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j])) j++
      const word = sql.slice(i, j)
      const renamed = renameMap[word]
      out += renamed ?? word
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Dialect-level rewrites applied before identifier / placeholder walking.
 * Regex-safe because we only match known SQLite constructs that cannot appear
 * as substrings of valid Postgres syntax.
 */
function swapDialect(sql: string): string {
  let out = sql
  // INSERT OR IGNORE INTO … ; → INSERT INTO … ON CONFLICT DO NOTHING;
  out = out.replace(
    /\bINSERT\s+OR\s+IGNORE\s+INTO\b([\s\S]*?);/gi,
    'INSERT INTO$1 ON CONFLICT DO NOTHING;',
  )
  // Some route queries don't end with ';' when passed to prepare().  Handle
  // INSERT OR IGNORE without trailing ; by appending ON CONFLICT DO NOTHING
  // at end of string.
  if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    if (!/\bON\s+CONFLICT\b/i.test(out)) out += ' ON CONFLICT DO NOTHING'
  }
  // datetime('now') → NOW()
  out = out.replace(/\bdatetime\(\s*'now'\s*\)/gi, 'NOW()')
  // strftime('%Y-%m-%dT%H:%M:%fZ','now') → iso-ms UTC
  out = out.replace(
    /strftime\s*\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi,
    `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  )
  // strftime('%Y-%m-%dT%H:%M:%SZ','now') → iso-s UTC
  out = out.replace(
    /strftime\s*\(\s*'%Y-%m-%dT%H:%M:%SZ'\s*,\s*'now'\s*\)/gi,
    `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
  )
  // IFNULL(x, y) → COALESCE(x, y).  Postgres has COALESCE only — IFNULL
  // would fail with "function ifnull does not exist".  Whole-word boundary
  // match avoids touching column names that happen to contain "ifnull".
  out = out.replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
  // INSERT OR REPLACE is intentionally NOT rewritten — the Postgres equivalent
  // requires knowing the conflict target, which differs per table.  Routes
  // using it must be rewritten by hand to explicit ON CONFLICT … DO UPDATE.
  return out
}

/** Full pipeline: dialect swaps → token-aware identifier & placeholder rewrite. */
export function translateSql(rawSql: string): string {
  return transformBody(swapDialect(rawSql))
}

// --- D1-shaped adapter -----------------------------------------------------

type D1Meta = {
  changes: number
  last_row_id: number
  duration: number
  rows_read: number
  rows_written: number
  size_after: number
}

const emptyMeta: D1Meta = {
  changes: 0,
  last_row_id: 0,
  duration: 0,
  rows_read: 0,
  rows_written: 0,
  size_after: 0,
}

export class PgBoundStatement {
  readonly pgSql: string
  readonly params: unknown[]
  private sql: Sql
  constructor(sql: Sql, pgSql: string, params: unknown[]) {
    this.sql = sql
    this.pgSql = pgSql
    this.params = params
  }

  // D1PreparedStatement shape compat — bind on an already-bound returns self,
  // raw() not used by any current route but present so the cast holds.
  bind(..._params: unknown[]): PgBoundStatement {
    return this
  }
  async raw<T = unknown>(): Promise<T[]> {
    const rows = (await this.sql.unsafe(this.pgSql, this.params as never)) as unknown as T[]
    return rows
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: D1Meta }> {
    const t0 = Date.now()
    const rows = (await this.sql.unsafe(this.pgSql, this.params as never)) as unknown as T[]
    return {
      results: rows,
      success: true,
      meta: { ...emptyMeta, duration: Date.now() - t0, rows_read: rows.length },
    }
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = (await this.sql.unsafe(this.pgSql, this.params as never)) as unknown as T[]
    return rows[0] ?? null
  }

  async run(): Promise<{ success: true; meta: D1Meta; results: [] }> {
    const t0 = Date.now()
    const res = (await this.sql.unsafe(this.pgSql, this.params as never)) as unknown as {
      count?: number
    }
    const changes = typeof res.count === 'number' ? res.count : 0
    return {
      success: true,
      meta: { ...emptyMeta, changes, rows_written: changes, duration: Date.now() - t0 },
      results: [],
    }
  }
}

export class PgPreparedStatement {
  readonly pgSql: string
  private sql: Sql
  constructor(sql: Sql, pgSql: string) {
    this.sql = sql
    this.pgSql = pgSql
  }

  bind(...params: unknown[]): PgBoundStatement {
    return new PgBoundStatement(this.sql, this.pgSql, params)
  }

  // Allow calling all/first/run/raw directly without bind() (D1 supports this
  // shape for param-free queries).
  all<T = unknown>() {
    return new PgBoundStatement(this.sql, this.pgSql, []).all<T>()
  }
  first<T = unknown>() {
    return new PgBoundStatement(this.sql, this.pgSql, []).first<T>()
  }
  run() {
    return new PgBoundStatement(this.sql, this.pgSql, []).run()
  }
  raw<T = unknown>() {
    return new PgBoundStatement(this.sql, this.pgSql, []).raw<T>()
  }
}

/**
 * Quacks like D1Database (for the methods routes actually use).  Construct
 * once per request inside the Hono middleware, cast to D1Database and stash
 * on c.var.DB — routes keep using the full D1 type surface.
 *
 * Route-unsafe methods (dump / exec / withSession) aren't implemented;
 * nothing in the codebase calls them.  If a future route does it will fail
 * at runtime with a clear "not a function" error.
 */
export class D1Compat {
  private sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  prepare(rawSql: string): PgPreparedStatement {
    return new PgPreparedStatement(this.sql, translateSql(rawSql))
  }

  async batch<T = unknown>(
    stmts: (PgBoundStatement | PgPreparedStatement | D1PreparedStatement)[],
  ): Promise<{ results: T[]; success: true; meta: D1Meta }[]> {
    return await this.sql.begin(async (tx) => {
      const out: { results: T[]; success: true; meta: D1Meta }[] = []
      for (const s of stmts) {
        // D1PreparedStatement from routes that still type-annotate locally —
        // tolerated at runtime because our own prepare() emits PgPrepared* too.
        if (!(s instanceof PgBoundStatement || s instanceof PgPreparedStatement)) {
          throw new Error(
            "D1Compat.batch: got a D1PreparedStatement from the real D1 API — mixing D1 and Supabase in one batch is not supported.",
          )
        }
        const t0 = Date.now()
        const params = s instanceof PgBoundStatement ? s.params : []
        const rows = (await tx.unsafe(s.pgSql, params as never)) as unknown as T[]
        const rowsCount = (rows as unknown as { count?: number }).count
        out.push({
          results: rows,
          success: true,
          meta: {
            ...emptyMeta,
            duration: Date.now() - t0,
            changes: typeof rowsCount === 'number' ? rowsCount : rows.length,
            rows_read: rows.length,
          },
        })
      }
      return out
    })
  }
}
