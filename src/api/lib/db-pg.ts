// ---------------------------------------------------------------------------
// Supabase Postgres client for Cloudflare Workers.
//
//   - Connects via Supavisor transaction-mode pooler (port 6543).  Required
//     for Workers because a) many ephemeral invocations would exhaust direct
//     Postgres connections, b) transaction-mode pooling works with stateless
//     request handlers.
//   - prepare: false — transaction-mode pooler doesn't carry session state
//     across statements, so prepared-statement caching is off.
//   - transform.column.from — converts snake_case columns back to the
//     ORIGINAL camelCase identifiers used in app code via the rename map
//     (column-rename-map.json).  postgres.toCamel is lossy — `customer_po`
//     becomes `customerPo` not `customerPO`, so reads like `row.customerPO`
//     silently return undefined for every acronym field.  The rename map
//     was built during D1→Postgres migration and is the canonical source
//     of truth for the original casing.  Unknown columns (SQL aliases,
//     ad-hoc derived columns) fall back to postgres.toCamel.
//
// Usage from a route:
//     import { getSql } from '../lib/db-pg'
//     const sql = getSql(c.env.DATABASE_URL)
//     const rows = await sql`SELECT * FROM customers LIMIT 10`
// ---------------------------------------------------------------------------
import postgres, { type Sql } from 'postgres'
import renameMap from './column-rename-map.json' with { type: 'json' }

// Postgres returns BIGINT (int8, OID 20) as a string by default — JS Number
// can't safely hold the full int64 range so the driver bails to string.  But
// every BIGINT in our schema is bounded:
//   - COUNT(*) results (we cap data growth far below 2^53)
//   - SUM of *_sen INTEGER columns (RM 90 trillion ceiling)
//   - BIGSERIAL ids on auxiliary tables (well under 2^53)
// String results break arithmetic silently — the textbook bug:
//   `total = 0;  total += row.n;  // 0 + "290" === "0290"`
// (real example: /api/sales-orders/stats was producing total = "029014" for
// 290+4, the user-visible "Sales Order 数字突然爆炸" bug.)
//
// Coerce all bigint values to Number at the driver level.  Safe up to 2^53;
// re-evaluate if any single table's row count or money sum approaches that.
const bigintAsNumber = {
  to: 20,
  from: [20],
  parse: (x: string) => Number(x),
  serialize: (x: number | string) => String(x),
}

// Inverse of column-rename-map.json: snake_case → original camelCase.
// Built once at module load.  postgres.toCamel can't preserve acronym
// casing (`customer_po` → `customerPo` not `customerPO`), so we look up
// the canonical original here first and only fall back to toCamel for
// columns that aren't in the migration map (SQL aliases, derived cols).
const snakeToCamel: Record<string, string> = Object.fromEntries(
  Object.entries(renameMap as Record<string, string>).map(
    ([camel, snake]) => [snake, camel],
  ),
)
const columnFrom = (col: string): string =>
  snakeToCamel[col] ?? postgres.toCamel(col)

/**
 * Returns a fresh postgres.js client for the given connection URL.
 *
 * MUST NOT be cached across requests in Cloudflare Workers: sockets and
 * streams created in one request can't be accessed from another ("Cannot
 * perform I/O on behalf of a different request").  Hyperdrive handles
 * connection pooling on its side, so creating a new client per request is
 * cheap — no TCP handshake, no TLS setup (Hyperdrive already holds a warm
 * connection to Supabase).
 *
 * Hyperdrive-backed connections: DO NOT set `ssl` — Hyperdrive terminates
 * TLS origin-side and exposes an internal binding; the driver must not
 * negotiate TLS itself.  Keep `prepare: true` (default) so Hyperdrive's
 * query cache works.
 *
 * Local dev without Hyperdrive (direct Supavisor pooler): ssl required,
 * prepare off (transaction pooler can't keep prepared-statement state).
 */
export function getSql(databaseUrl: string): Sql {
  const isHyperdrive = /hyperdrive\.local/i.test(databaseUrl)
  return isHyperdrive
    ? postgres(databaseUrl, {
        // max:1 — one socket per request, Hyperdrive handles origin-side
        // pooling.  Higher values risk "Cannot perform I/O on behalf of a
        // different request" when postgres.js keeps pool sockets alive past
        // the request boundary.
        max: 1,
        fetch_types: false,
        idle_timeout: 0,
        types: { bigint: bigintAsNumber },
        transform: { column: { from: columnFrom } },
      })
    : postgres(databaseUrl, {
        // verify-full validates the cert chain AND the hostname against the
        // cert's SAN — without it, `require` only checks that TLS is offered,
        // letting any valid cert through (MITM possible on the public pooler).
        ssl: 'verify-full',
        prepare: false,
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        fetch_types: false,
        types: { bigint: bigintAsNumber },
        transform: { column: { from: columnFrom } },
      })
}
