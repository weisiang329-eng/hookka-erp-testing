// ---------------------------------------------------------------------------
// Supabase Postgres client for Cloudflare Workers.
//
//   - Connects via Supavisor transaction-mode pooler (port 6543).  Required
//     for Workers because a) many ephemeral invocations would exhaust direct
//     Postgres connections, b) transaction-mode pooling works with stateless
//     request handlers.
//   - prepare: false — transaction-mode pooler doesn't carry session state
//     across statements, so prepared-statement caching is off.
//   - transform.column.from — converts snake_case columns to camelCase on
//     read so app code keeps using `row.shortName` instead of `row.short_name`.
//     (Schema is snake_case; app types are camelCase.)  Write-side identifiers
//     inside SQL strings must be written in snake_case by the caller — the
//     rename map in migrations-postgres/_rename_map.json is the canonical list.
//
// Usage from a route:
//     import { getSql } from '../lib/db-pg'
//     const sql = getSql(c.env.DATABASE_URL)
//     const rows = await sql`SELECT * FROM customers LIMIT 10`
// ---------------------------------------------------------------------------
import postgres, { type Sql } from 'postgres'

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
        transform: { column: { from: postgres.toCamel } },
      })
    : postgres(databaseUrl, {
        ssl: 'require',
        prepare: false,
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        fetch_types: false,
        transform: { column: { from: postgres.toCamel } },
      })
}
