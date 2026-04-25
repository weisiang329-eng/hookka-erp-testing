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

// Per-request DB time aggregator. timingMiddleware creates one and stashes it
// on the context; instrumentD1 receives a reference and accumulates query
// durations into it so the Server-Timing header can emit a `db` entry alongside
// `app`. count is the number of DB ops (prepare-then-{all,first,run,raw} or
// batch) — handy as the `desc` in DevTools so you can spot N+1s at a glance.
export type DbTimer = { total: number; count: number };

// Hono middleware — times every request. Emits a [req] line for every call,
// upgrades to [slow-req] over SLOW_REQUEST_MS so you can grep, and writes a
// `Server-Timing` response header so Chrome/Firefox DevTools render the
// backend duration in the Network tab's Timing pane (no CLI/wrangler tail
// needed for "where is the page loading slow" inspection).
//
// Server-Timing format (RFC 8673):
//   Server-Timing: app;dur=312, db;dur=248;desc="14 queries"
// We emit an `app` entry covering total handler time, a `db` entry covering
// time spent inside instrumented D1 calls (the count of queries doubles as
// the desc — useful for spotting N+1s in DevTools without opening
// `wrangler tail`), and a `cf-country` hint when the colo header is present.
export async function timingMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  // Per-request DB-time aggregator. The DB-injection middleware (worker.ts)
  // grabs this with c.get("dbTimer") and threads it into instrumentD1 so
  // every .all/.first/.run/.raw/.batch credits its duration here.
  const dbTimer: DbTimer = { total: 0, count: 0 };
  c.set("dbTimer", dbTimer);
  await next();
  const dur = Date.now() - start;
  const path = new URL(c.req.url).pathname;
  const line = `[req] method=${c.req.method} path=${path} status=${c.res.status} dur_ms=${dur}`;
  if (dur >= SLOW_REQUEST_MS) {
    console.warn(`[slow-req] ${line.slice(6)}`); // strip "[req] " prefix
  } else {
    console.log(line);
  }
  // Best-effort Server-Timing header.  Some CF runtimes lock res after
  // streaming starts — wrap in try/catch so a header-set failure never
  // breaks the response.
  try {
    const colo = c.req.header("cf-ipcountry") ?? "";
    const parts = [`app;dur=${dur}`];
    if (dbTimer.count > 0) {
      parts.push(`db;dur=${dbTimer.total};desc="${dbTimer.count} queries"`);
    }
    if (colo) parts.push(`cf-country;desc="${colo}"`);
    c.res.headers.set("Server-Timing", parts.join(", "));
  } catch { /* ignore */ }
}

// Wrap a D1Database (or Postgres-compat D1Compat) so every
// .prepare().all()/first()/run() logs when slow.  Drop-in replacement —
//   const db = instrumentD1(c.var.DB, c.req.url, c.get("dbTimer"))
// Generic preserves the concrete DB type for the caller.  When `timer` is
// supplied, every wrapped call accumulates its duration into it so
// timingMiddleware can emit a Server-Timing `db` entry.
export function instrumentD1<T extends object>(db: T, routeLabel: string, timer?: DbTimer): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (prop === "prepare" && typeof orig === "function") {
        return (sql: string) => {
          const stmt = orig.call(target, sql);
          return wrapStatement(stmt, sql, routeLabel, timer);
        };
      }
      if (prop === "batch" && typeof orig === "function") {
        return async (statements: unknown[]) => {
          const start = Date.now();
          const res = await orig.call(target, statements);
          const dur = Date.now() - start;
          if (timer) {
            timer.total += dur;
            timer.count += 1;
          }
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
  }) as T;
}

function wrapStatement(stmt: object, sql: string, routeLabel: string, timer?: DbTimer): object {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      // .bind(...) returns a new statement; keep wrapping (and keep threading
      // the timer through so chained .bind(...).all() still accumulates).
      if (prop === "bind" && typeof orig === "function") {
        return (...args: unknown[]) => wrapStatement(orig.apply(target, args), sql, routeLabel, timer);
      }
      if ((prop === "all" || prop === "first" || prop === "run" || prop === "raw") && typeof orig === "function") {
        return async (...args: unknown[]) => {
          const start = Date.now();
          const res = await orig.apply(target, args);
          const dur = Date.now() - start;
          if (timer) {
            timer.total += dur;
            timer.count += 1;
          }
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
