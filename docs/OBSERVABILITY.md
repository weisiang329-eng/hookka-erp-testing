# Observability — what we emit and where

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/lib/observability.ts:98-135, 276-335`, `src/api/routes/admin-health.ts:82-95, 367-392`, `src/api/routes/auth.ts:199-277`, `src/api/lib/audit.ts:217,241`, `src/api/worker.ts:1082,1474`, and `wrangler.toml` (`[[analytics_engine_datasets]]`, `[vars] SENTRY_DSN`, `CF_ACCOUNT_ID`).
> Corrected 2026-08-13: four things were wrong — (1) every `src/api/routes-d1/...` path; that directory does not exist, the files are in `src/api/routes/`. (2) "no Sentry account required" — Sentry IS wired, both worker-side and client-side. (3) `/api/admin/health/kpis` no longer always returns `_mock: true`; the real AE-SQL path shipped. (4) The AE row shapes were incomplete and the D1 caveats are dead.

This document describes the observability surface added in Phase 6 (P6.1 → P6.4 in [UPGRADE-CONTROL-BOARD.md](archive/UPGRADE-CONTROL-BOARD.md)). It runs on Cloudflare primitives plus Sentry.

## Layers

| Layer | What | Where to read it |
|---|---|---|
| `console.log` | Per-request `[req] ...` and `[slow-req] ...` lines | `wrangler pages deployment tail` |
| Server-Timing | `app;dur`, `db;dur`, `cf-country` headers | Browser DevTools Network panel → Timing |
| Analytics Engine | Per-request timing + per-resource counter events | `/admin/health` page or direct AE SQL |
| Sentry | Uncaught worker exceptions + client-side errors | Sentry project `o4511302465814528` |

### Sentry (not optional, not absent)

- Worker side: `wrangler.toml [vars] SENTRY_DSN` is set, and `src/api/worker.ts:1474` calls `reportWorkerError(err, c.env.SENTRY_DSN, …)` from the global `onError` (via `src/api/lib/monitoring.ts`, which dynamic-imports toucan-js).
- Client side: `.github/workflows/deploy.yml` injects `VITE_SENTRY_DSN` at build time; `@sentry/react` is a direct dependency.
- Both DSNs live in plaintext deliberately — a Sentry DSN grants event submission only.

## P6.1 — `traceparent`

Every browser fetch (via `cached-fetch.ts` / `fetch-json.ts`) stamps a W3C `traceparent: 00-{trace_id_32hex}-{span_id_16hex}-{flags_2hex}` header.

- `trace_id` is per-page-session (sessionStorage), so every fetch from one tab joins one trace.
- `span_id` is fresh per fetch.
- `flags`: 01 (sampled) in dev, 1% probability in prod, 00 otherwise. The header is *always* sent — sampling controls log volume on the worker, not propagation.

The worker reads the incoming header, validates the shape, and:

- Logs `[req] method=X path=Y status=Z dur_ms=N traceparent=...` (1% sampled in prod, 100% in dev/preview, slow lines always emit).
- Stashes the value on `c.var.traceparent` so downstream `emitCounter` writes can reference it.
- We do not annotate SQL with the trace id, so the join key for "all queries from one trace" is the per-request log line + slow-query lines.

## P6.2 — Analytics Engine writes (per-request timing)

Binding (defined in `wrangler.toml`):

```toml
[[analytics_engine_datasets]]
binding = "ERP_METRICS"
dataset = "hookka_erp_metrics"
```

Every request, after `next()`, writes one data point (`src/api/lib/observability.ts:276`):

```ts
ae.writeDataPoint({
  indexes: [`req|${path}|${responseStatus}`],
  blobs:   ["req", path, String(responseStatus), traceparent, method, errMsg],
  doubles: [dur_ms, db_dur_ms, db_count],
});
```

Schema columns mapped:

| Column | Meaning |
|---|---|
| `index1` | `req\|{route}\|{status}` — bounded cardinality. Status is included so dashboards can filter on it cheaply. |
| `blob1` | `"req"` (event-kind discriminator). |
| `blob2` | Route path (e.g. `/api/sales-orders`). |
| `blob3` | HTTP status code as string. |
| `blob4` | `traceparent` (or empty). |
| `blob5` | HTTP method. |
| `blob6` | Error message, when the request produced one. |
| `double1` | Total request duration ms. |
| `double2` | DB time ms (sum of instrumented `prepare(...).{all,first,run,raw,batch}`). |
| `double3` | DB op count. |

There is a third event shape not previously documented — slow SQL
(`src/api/lib/observability.ts:327`):

```ts
ae.writeDataPoint({
  indexes: ["slow_sql"],
  blobs:   ["slow_sql", route, op, sqlSnippet],
  doubles: [durMs, rowsRead ?? 0],
});
```

When `ERP_METRICS` is unbound (e.g. local dev without an account token, or a rollback), every helper short-circuits — no exceptions, no logs.

## P6.3 — per-resource counter events

`emitCounter(c, kind, details?)` writes one data point of the form:

```ts
ae.writeDataPoint({
  indexes: [kind],                                                    // e.g. "audit_events.created"
  blobs:   [kind, details?.resource ?? "", details?.action ?? "", traceparent],
  doubles: [details?.count ?? 1],
});
```

Currently emitted:

| `kind` | Where | What it counts |
|---|---|---|
| `audit_events.created` | `src/api/lib/audit.ts:217,241` after the INSERT succeeds | Successful audit-row writes (per resource + action). |
| `auth.login_success` | `src/api/routes/auth.ts:277` after token issue | Successful password logins. `resource` = role name. |
| `auth.login_fail` | `src/api/routes/auth.ts:199,212,224` on the three failure paths | Failed logins, with `resource` ∈ `{unknown_email, account_disabled, bad_password}`. **Emails are deliberately not stamped** to avoid PII leaks and brute-force enumeration. |
| `req.4xx` | `src/api/lib/observability.ts` after every 4xx response | Client-side errors (auth-rejected, validation, etc.). |
| `req.5xx` | `src/api/lib/observability.ts` after every 5xx response | Server-side errors (DB failures, unhandled throws). |

To add a new counter, call `emitCounter(c, "your.kind", { resource, action })` where appropriate — there's nothing to register elsewhere.

## P6.4 — `/admin/health`

SUPER_ADMIN-only page rendering five KPIs over the last 24 hours:

- `p50`, `p75`, `p95` of `req` `double1` (request duration)
- `longTaskCount` — count of `req` events with `double1 >= 200`
- `cacheHitRatio` — **REAL on the AE path** (corrected 2026-08-14): `hits/(hits+misses)` computed by AE SQL over the `cache.hit` / `cache.miss` counters emitted by `withSnapshot` (`src/api/lib/snapshot.ts:419,428`), aggregated at `admin-health.ts:331-348`. Coverage is PARTIAL — only snapshot callers that pass `c` emit — and it returns 0 with no data. It is a fixed placeholder ONLY in the `_mock: true` path (`admin-health.ts:83`).

Backend at `src/api/routes/admin-health.ts` (`GET /api/admin/health/kpis`). The real AE-SQL path **shipped**: the route fetches the Cloudflare Analytics Engine SQL endpoint with `CF_ACCOUNT_ID` + `AE_QUERY_TOKEN`, derives percentiles and `longTaskCount` in JS over the returned samples, and returns `_mock: false` (`admin-health.ts:367-370`). It falls back to the seeded random mock with `_mock: true` (`admin-health.ts:82-95`) only when the binding or either credential is missing.

Two operational traps, both learned the hard way:

- `CF_ACCOUNT_ID` **must** live in `wrangler.toml [vars]`, not as a Pages dashboard var. Once `[vars]` exists in the toml, a deploy syncs bindings and DELETES dashboard-only vars — that silently dropped prod health back to mock on 2026-08-01. `AE_QUERY_TOKEN` is the real secret and stays in Pages secrets.
- Enabling the `ERP_METRICS` binding before Analytics Engine is enabled on the account caused 30 consecutive CI deploy failures on 2026-04-26. AE was enabled on the account 2026-05-27.

`GET /api/admin/health/kpis-diag` (`admin-health.ts:382-392`) reports whether each credential is set, its length, and a short prefix — use it before assuming the page is lying.

## Verifying writes (when AE is enabled)

```bash
# pseudo — depends on your token + endpoint
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" \
  --data 'SELECT count() FROM hookka_erp_metrics WHERE blob1 = "req" AND timestamp > NOW() - INTERVAL "1" HOUR'
```

## What we deliberately do NOT do

- **SQL-level trace annotation.** Queries are not stamped with the trace id; the slow-query log line + the `slow_sql` AE event are the join.
- **Span-level sampling on the worker side.** We use 1% req-line log sampling, but every AE data point is written — AE costs are a flat per-write fee, no value in dropping them.
- **PII in metrics.** Emails / display names / IPs go to `audit_events` (which has access controls), not Analytics Engine.
- **A full APM / OpenTelemetry collector.** No Datadog, no New Relic, no OTel exporter. (Sentry IS in use — see the Layers table above; the earlier version of this doc claimed otherwise.) Moving to OTel later means swapping `console.log` + `emitCounter` for an exporter — all callsites use the helper, so it's a one-file change.
