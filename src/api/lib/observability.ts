// ---------------------------------------------------------------------------
// Observability — request timing + slow-query logging + trace propagation.
//
// Philosophy: console.log is free and shows up in `wrangler tail`. No external
// service, no billing. When you need dashboards later, swap console.log for
// Analytics Engine binding without changing callsites.
//
// Emission format (single line, key=value, grep-friendly):
//   [req] method=GET path=/api/production-orders status=200 dur_ms=47 traceparent=00-{32hex}-{16hex}-01
//   [slow-query] route=/api/production-orders sql="SELECT ..." dur_ms=342 rows=8919
//
// P6.1 — traceparent (W3C Trace Context):
//   The browser stamps `traceparent: 00-{trace_id}-{span_id}-{flags}` on
//   every fetch (see src/lib/trace.ts). The worker reads it, includes the
//   value in the [req] log line, and gates whether to spend log volume on
//   it via the sampling rule below — 100% in dev/preview, 1% in prod.
//   D1 doesn't accept query annotations so we don't propagate it into SQL;
//   the per-request log line is the join key.
//
// Tune thresholds below. Start loud; turn down once the noisy offenders are fixed.
// ---------------------------------------------------------------------------
import type { Context, Next } from "hono";

export const SLOW_REQUEST_MS = 200;
export const SLOW_QUERY_MS = 100;

// Sampling rate for [req] log lines in production. dev / preview log every
// request. We log slow ones (>= SLOW_REQUEST_MS) regardless of sampling so
// performance regressions never get silently dropped.
const PROD_LOG_SAMPLE_RATE = 0.01;

function shouldEmitReqLine(envName: string | undefined, dur: number): boolean {
  if (dur >= SLOW_REQUEST_MS) return true;
  if (envName !== "production") return true;
  return Math.random() < PROD_LOG_SAMPLE_RATE;
}

// Validate the W3C Trace Context shape: `00-{32hex}-{16hex}-{2hex}`.
// We don't reject malformed headers (downstream still gets the value) but
// we DO refuse to log obviously-bogus values to keep parsers happy.
function isValidTraceparent(v: string): boolean {
  return /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(v);
}

// ---------------------------------------------------------------------------
// P6.2 / P6.3 — Cloudflare Analytics Engine writes.
//
// Schema overview (full spec lives in docs/OBSERVABILITY.md):
//
//   `req` events (P6.2 — written from timingMiddleware after every request):
//     indexes:  ["req|{route}|{status}"]
//     blobs:    ["req", route, String(status), traceparent]
//     doubles:  [dur_ms, db_dur_ms, db_count]
//
//   counter events (P6.3 — emitted via emitCounter()):
//     indexes:  ["{kind}"]                 // e.g. "audit_events.created"
//     blobs:    [kind, resource?, action?, traceparent?]
//     doubles:  [count]                    // always 1 unless caller batches
//
// Querying (admin-health route, P6.4):
//   SELECT
//     quantileWeighted(0.5)(double1, _sample_interval) AS p50,
//     ...
//   FROM hookka_erp_metrics
//   WHERE blob1 = 'req' AND timestamp >= now() - INTERVAL '24' HOUR
//
// All writes are best-effort — wrapped in try/catch and gated on the binding
// being present. With the binding absent (local dev / rollback) every helper
// silently no-ops, the dashboard endpoint serves mock data, and the rest of
// the app is unaffected.
// ---------------------------------------------------------------------------

// Loose ambient interface so this module compiles even when the workers-types
// version in scope predates AnalyticsEngineDataset. The CF runtime only cares
// that .writeDataPoint exists.
type AnalyticsEngineLike = {
  writeDataPoint?: (data: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }) => void;
};

function getMetrics(env: unknown): AnalyticsEngineLike | null {
  if (!env || typeof env !== "object") return null;
  const ae = (env as { ERP_METRICS?: AnalyticsEngineLike }).ERP_METRICS;
  if (!ae || typeof ae.writeDataPoint !== "function") return null;
  return ae;
}

/**
 * Emit a per-resource counter to Analytics Engine. P6.3 hook for
 * `audit_events.created`, `auth.login_success`, `auth.login_fail`,
 * `req.4xx`, `req.5xx`, etc. Pass `c` so we can pull traceparent off ctx.
 *
 * No-ops when ERP_METRICS isn't bound. Failures are swallowed.
 */
export function emitCounter(
  c: Context,
  kind: string,
  details?: { resource?: string; action?: string; count?: number },
): void {
  const ae = getMetrics(c.env);
  if (!ae) return;
  try {
    const traceparent =
      ((c as unknown as { get: (k: string) => unknown }).get("traceparent") as string | undefined) ?? "";
    ae.writeDataPoint?.({
      indexes: [kind],
      blobs: [
        kind,
        details?.resource ?? "",
        details?.action ?? "",
        traceparent,
      ],
      doubles: [details?.count ?? 1],
    });
  } catch {
    /* never let metrics break a real request */
  }
}

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

  // P6.1 — read incoming W3C Trace Context. If the caller didn't send one,
  // mint a placeholder so internal cron / curl traffic is still grep-able.
  // Stash on the context so route handlers + emitMetric (P6.2) can read it.
  const incoming = c.req.header("traceparent") ?? "";
  const traceparent =
    incoming && isValidTraceparent(incoming) ? incoming : "";
  if (traceparent) {
    try { c.set("traceparent", traceparent); } catch { /* ignore */ }
  }

  await next();
  const dur = Date.now() - start;
  const path = new URL(c.req.url).pathname;
  const tpPart = traceparent ? ` traceparent=${traceparent}` : "";
  const line = `[req] method=${c.req.method} path=${path} status=${c.res.status} dur_ms=${dur}${tpPart}`;
  // P6.1 — sampling. Slow lines always emit. Normal lines emit at 1% in
  // prod, 100% otherwise. Gate on c.env.ENVIRONMENT (set in wrangler.toml).
  const envName = (c.env as { ENVIRONMENT?: string } | undefined)?.ENVIRONMENT;
  if (dur >= SLOW_REQUEST_MS) {
    console.warn(`[slow-req] ${line.slice(6)}`); // strip "[req] " prefix
  } else if (shouldEmitReqLine(envName, dur)) {
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

  // P6.2 — Analytics Engine timing event (req).  No-op when binding absent.
  const ae = getMetrics(c.env);
  if (ae) {
    const status = c.res.status;
    try {
      ae.writeDataPoint?.({
        indexes: [`req|${path}|${status}`],
        blobs: ["req", path, String(status), traceparent],
        doubles: [dur, dbTimer.total, dbTimer.count],
      });
    } catch { /* swallow */ }
    // P6.3 — auto-counters for 4xx / 5xx so the dashboard can chart error
    // rate without inspecting every req row. Status < 400 is the happy
    // path; 4xx and 5xx each get their own counter event so the query
    // can `WHERE blob1 = 'req.5xx'` cheaply.
    if (status >= 500) emitCounter(c, "req.5xx", { resource: path });
    else if (status >= 400) emitCounter(c, "req.4xx", { resource: path });
  }
}

// Wrap a D1Database (or Postgres-compat SupabaseAdapter) so every
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
