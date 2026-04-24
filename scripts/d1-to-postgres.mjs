// ---------------------------------------------------------------------------
// SQLite (D1) → Postgres schema preprocessor · snake_case edition.
//
// Transforms:
//   1. Type swaps
//      INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
//      REAL                              → DOUBLE PRECISION
//      datetime('now')                   → NOW()
//   2. Identifier conversion camelCase → snake_case
//      shortName      → short_name
//      creditLimitSen → credit_limit_sen
//      POId           → po_id
//      unitM3         → unit_m3
//   3. Lowercase-only and UPPERCASE-only bare words pass through untouched.
//      (Former are identifiers that already match Postgres' default
//      lowercasing; latter are SQL keywords / types.)
//
// Preserves comments, string literals, already-quoted identifiers.
//
// Also emits `migrations-postgres/_rename_map.json` — the full camelCase →
// snake_case mapping, used in Phase 3 to rewrite route SQL.
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'

const IN_DIR = 'migrations'
const OUT_DIR = 'migrations-postgres'

const renameMap = new Map() // camelCase → snake_case

/** True if the word has BOTH a lowercase and an uppercase ASCII letter. */
function isMixedCase(word) {
  return /[a-z]/.test(word) && /[A-Z]/.test(word)
}

/** camelCase → snake_case with correct acronym handling. */
function toSnake(word) {
  if (renameMap.has(word)) return renameMap.get(word)
  const snake = word
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // HTTPRequest → HTTP_Request
    .replace(/([a-z\d])([A-Z])/g, '$1_$2') // fooBar → foo_Bar, price1Sen → price1_Sen
    .toLowerCase()
  renameMap.set(word, snake)
  return snake
}

/**
 * Walk the SQL char-by-char, preserving comments / strings / quoted IDs, and
 * converting any bare mixed-case identifier to snake_case.
 */
function rewriteIdentifiers(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]

    // Line comment: -- ... \n
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      out += sql.slice(i, end === -1 ? n : end)
      i = end === -1 ? n : end
      continue
    }
    // Block comment: /* ... */
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      out += sql.slice(i, end === -1 ? n : end + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    // Single-quoted string (with '' escapes)
    if (c === "'") {
      out += c
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''"
          i += 2
          continue
        }
        out += sql[i]
        if (sql[i] === "'") {
          i++
          break
        }
        i++
      }
      continue
    }
    // Already double-quoted identifier — pass through verbatim (we don't
    // convert these; if the schema already quoted it, the author wanted
    // the exact case).
    if (c === '"') {
      const end = sql.indexOf('"', i + 1)
      out += sql.slice(i, end === -1 ? n : end + 1)
      i = end === -1 ? n : end + 1
      continue
    }
    // Bare identifier start?
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j])) j++
      const word = sql.slice(i, j)
      out += isMixedCase(word) ? toSnake(word) : word
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

/** Type / function dialect swaps. Applied BEFORE identifier rewriting. */
function swapDialect(sql) {
  let out = sql
  // INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
  out = out.replace(
    /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    'BIGSERIAL PRIMARY KEY',
  )
  out = out.replace(/\bAUTOINCREMENT\b/gi, '')
  // REAL → DOUBLE PRECISION (column type only — word-boundary + context)
  out = out.replace(/(\s|\()REAL(\s|,|\))/g, '$1DOUBLE PRECISION$2')
  // datetime('now') → NOW()
  out = out.replace(/\bdatetime\(\s*'now'\s*\)/gi, 'NOW()')
  // INSERT OR IGNORE INTO t (...) VALUES (...); →
  // INSERT INTO t (...) VALUES (...) ON CONFLICT DO NOTHING;
  // Non-greedy match to the next semicolon is safe for our schema (no
  // semicolons inside INSERT string literals).
  out = out.replace(
    /\bINSERT\s+OR\s+IGNORE\s+INTO\b([\s\S]*?);/gi,
    'INSERT INTO$1 ON CONFLICT DO NOTHING;',
  )
  // DROP TABLE IF EXISTS t;  →  DROP TABLE IF EXISTS t CASCADE;
  // Needed for migration 0010 which drops older stub tables that 0001 now
  // creates with FK dependents. CASCADE is safe on fresh install (empty DB).
  out = out.replace(
    /\bDROP\s+TABLE\s+IF\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/gi,
    'DROP TABLE IF EXISTS $1 CASCADE;',
  )
  // WHERE 0  →  WHERE FALSE  (used in CTAS skeletons: CREATE TABLE x AS SELECT ... WHERE 0)
  // SQLite auto-coerces integer 0/1 to boolean in WHERE; Postgres is strict.
  out = out.replace(/\bWHERE\s+0(?=\s*[;)])/gi, 'WHERE FALSE')
  out = out.replace(/\bWHERE\s+1(?=\s*[;)])/gi, 'WHERE TRUE')
  // ALTER TABLE x ADD COLUMN col ...  →  ADD COLUMN IF NOT EXISTS
  // SQLite doesn't support IF NOT EXISTS on ADD COLUMN so the authors ran
  // partial alters manually; Postgres supports it cleanly since 9.6.
  out = out.replace(
    /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi,
    'ADD COLUMN IF NOT EXISTS ',
  )
  // strftime(fmt, 'now') → to_char(NOW() AT TIME ZONE 'UTC', pg_fmt)
  // Two format variants used in our schema:
  //   %Y-%m-%dT%H:%M:%fZ → ms precision
  //   %Y-%m-%dT%H:%M:%SZ → s precision
  out = out.replace(
    /strftime\s*\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi,
    `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  )
  out = out.replace(
    /strftime\s*\(\s*'%Y-%m-%dT%H:%M:%SZ'\s*,\s*'now'\s*\)/gi,
    `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
  )
  return out
}

function convert(sql) {
  return rewriteIdentifiers(swapDialect(sql))
}

// ---- main ------------------------------------------------------------------
const files = fs
  .readdirSync(IN_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

fs.mkdirSync(OUT_DIR, { recursive: true })

let total = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(IN_DIR, f), 'utf8')
  const dst = convert(src)
  fs.writeFileSync(path.join(OUT_DIR, f), dst, 'utf8')
  total++
}

// Persist the rename map.  Two copies:
//   migrations-postgres/_rename_map.json — reference / tooling
//   src/api/lib/column-rename-map.json    — bundled into the Worker so the
//     D1-compat adapter can translate SQL strings at request time.
const mapObj = Object.fromEntries([...renameMap.entries()].sort())
const mapJson = JSON.stringify(mapObj, null, 2)
fs.writeFileSync(path.join(OUT_DIR, '_rename_map.json'), mapJson, 'utf8')
fs.writeFileSync('src/api/lib/column-rename-map.json', mapJson, 'utf8')

console.log(`✓ Converted ${total} migration files → ${OUT_DIR}/`)
console.log(`✓ Wrote ${Object.keys(mapObj).length} renames → ${OUT_DIR}/_rename_map.json + src/api/lib/`)
