// ---------------------------------------------------------------------------
// Observability — request timing + slow-query logging.
//
// Philosophy: console.log is free and shows up in `wrangler tail`. No external
// service, no billing. When you need dashboards later, swap console.log for
// Analytics Engine binding without changing callsites.
//
// Emission format (single line, key=value, grep-friendly):
//   [req] method=GET path=/api/production-orders status=200 dur_ms=47
//   [slow-query] route=/api/production-orders sql="SELECT ..." dur_ms=342 rows=8919
//
// Tune thresholds below. Start loud; turn down once the noisy offenders are fixed.
// ---------------------------------------------------------------------------
import type { Context, Next } from "hono";

export const SLOW_REQUEST_MS = 200;
export const SLOW_QUERY_MS = 100;

// Hono middleware — times every request. Emits a [req] line for every call
// and a separate [slow-req] line when over SLOW_REQUEST_MS so you can grep
// for just the bad ones.
export async function timingMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  await next();
  const dur = Date.now() - start;
  const path = new URL(c.req.url).pathname;
  const line = `[req] method=${c.req.method} path=${path} status=${c.res.status} dur_ms=${dur}`;
  if (dur >= SLOW_REQUEST_MS) {
    console.warn(`[slow-req] ${line.slice(6)}`); // strip "[req] " prefix
  } else {
    console.log(line);
  }
}

// Wrap a D1Database so every .prepare().all()/first()/run() logs when slow.
// Drop-in replacement — `const db = instrumentD1(c.env.DB, c.req.url)`.
//
// Works by proxying `prepare` to return a proxied statement whose terminal
// methods (.all, .first, .run, .raw) record the elapsed ms. No change needed
// at callsites.
export function instrumentD1(db: D1Database, routeLabel: string): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (prop === "prepare" && typeof orig === "function") {
        return (sql: string) => {
          const stmt = orig.call(target, sql);
          return wrapStatement(stmt, sql, routeLabel);
        };
      }
      if (prop === "batch" && typeof orig === "function") {
        return async (statements: D1PreparedStatement[]) => {
          const start = Date.now();
          const res = await orig.call(target, statements);
          const dur = Date.now() - start;
          if (dur >= SLOW_QUERY_MS) {
            console.warn(
              `[slow-query] route=${routeLabel} op=batch count=${statements.length} dur_ms=${dur}`,
            );
          }
          return res;
        };
      }
      return typeof orig === "function" ? orig.bind(target) : orig;
    },
  });
}

function wrapStatement(stmt: D1PreparedStatement, sql: string, routeLabel: string): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      // .bind(...) returns a new statement; keep wrapping.
      if (prop === "bind" && typeof orig === "function") {
        return (...args: unknown[]) => wrapStatement(orig.apply(target, args), sql, routeLabel);
      }
      if ((prop === "all" || prop === "first" || prop === "run" || prop === "raw") && typeof orig === "function") {
        return async (...args: unknown[]) => {
          const start = Date.now();
          const res = await orig.apply(target, args);
          const dur = Date.now() - start;
          if (dur >= SLOW_QUERY_MS) {
            // Meta.rows_read is available on D1Result; log if present.
            const meta = (res as { meta?: { rows_read?: number; rows_written?: number } } | undefined)?.meta;
            const rowsPart = meta?.rows_read != null ? ` rows_read=${meta.rows_read}` : "";
            const writePart = meta?.rows_written ? ` rows_written=${meta.rows_written}` : "";
            const sqlSnippet = sql.replace(/\s+/g, " ").slice(0, 140);
            console.warn(
              `[slow-query] route=${routeLabel} op=${String(prop)} dur_ms=${dur}${rowsPart}${writePart} sql="${sqlSnippet}"`,
            );
          }
          return res;
        };
      }
      return typeof orig === "function" ? orig.bind(target) : orig;
    },
  });
}
