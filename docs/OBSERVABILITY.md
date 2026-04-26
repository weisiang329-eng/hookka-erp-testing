# Observability — what we emit and where

This document describes the observability surface added in Phase 6 (P6.1 → P6.4 in [UPGRADE-CONTROL-BOARD.md](UPGRADE-CONTROL-BOARD.md)). The goal is the smallest useful telemetry footprint that runs entirely on Cloudflare primitives — no Datadog / New Relic / Sentry account required.

## Layers

| Layer | What | Where to read it |
|---|---|---|
| `console.log` | Per-request `[req] ...` and `[slow-req] ...` lines | `wrangler tail` |
| Server-Timing | `app;dur`, `db;dur`, `cf-country` headers | Browser DevTools Network panel → Timing |
| Analytics Engine | Per-request timing + per-resource counter events | `/admin/health` page or direct AE SQL |

## P6.1 — `traceparent`

Every browser fetch (via `cached-fetch.ts` / `fetch-json.ts`) stamps a W3C `traceparent: 00-{trace_id_32hex}-{span_id_16hex}-{flags_2hex}` header.

- `trace_id` is per-page-session (sessionStorage), so every fetch from one tab joins one trace.
- `span_id` is fresh per fetch.
- `flags`: 01 (sampled) in dev, 1% probability in prod, 00 otherwise. The header is *always* sent — sampling controls log volume on the worker, not propagation.

The worker reads the incoming header, validates the shape, and:

- Logs `[req] method=X path=Y status=Z dur_ms=N traceparent=...` (1% sampled in prod, 100% in dev/preview, slow lines always emit).
- Stashes the value on `c.var.traceparent` so downstream `emitCounter` writes can reference it.
- D1 doesn't accept query annotations, so the join key for "all queries from one trace" is the per-request log line + slow-query lines.

## P6.2 — Analytics Engine writes (per-request timing)

Binding (defined in `wrangler.toml`):

```toml
[[analytics_engine_datasets]]
binding = "ERP_METRICS"
dataset = "hookka_erp_metrics"
```

Every request, after `next()`, writes one data point:

```ts
ae.writeDataPoint({
  indexes: [`req|${path}|${status}`],
  blobs:   ["req", path, String(status), traceparent],
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
| `double1` | Total request duration ms. |
| `double2` | DB time ms (sum of instrumented `prepare(...).{all,first,run,raw,batch}`). |
| `double3` | DB op count. |

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
| `audit_events.created` | `src/api/lib/audit.ts` after the INSERT succeeds | Successful audit-row writes (per resource + action). |
| `auth.login_success` | `src/api/routes-d1/auth.ts` after token issue | Successful password logins. `resource` = role name. |
| `auth.login_fail` | `src/api/routes-d1/auth.ts` on the three failure paths | Failed logins, with `resource` ∈ `{unknown_email, account_disabled, bad_password}`. **Emails are deliberately not stamped** to avoid PII leaks and brute-force enumeration. |
| `req.4xx` | `src/api/lib/observability.ts` after every 4xx response | Client-side errors (auth-rejected, validation, etc.). |
| `req.5xx` | `src/api/lib/observability.ts` after every 5xx response | Server-side errors (DB failures, unhandled throws). |

To add a new counter, call `emitCounter(c, "your.kind", { resource, action })` where appropriate — there's nothing to register elsewhere.

## P6.4 — `/admin/health`

SUPER_ADMIN-only page rendering five KPIs over the last 24 hours:

- `p50`, `p75`, `p95` of `req` `double1` (request duration)
- `longTaskCount` — count of `req` events with `double1 >= 200`
- `cacheHitRatio` — placeholder until we instrument cache hits explicitly

Backend at `src/api/routes-d1/admin-health.ts` (`GET /api/admin/health/kpis`). Currently returns `_mock: true` because Cloudflare Pages Functions cannot perform AE SQL queries from inside the runtime — querying AE requires the `cloudflare-api` token + a separate fetch to the GraphQL/SQL endpoint. The page is built so that flipping `_mock: false` requires only adding the AE-SQL fetch in the route.

## Verifying writes (when AE is enabled)

```bash
# pseudo — depends on your token + endpoint
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" \
  --data 'SELECT count() FROM hookka_erp_metrics WHERE blob1 = "req" AND timestamp > NOW() - INTERVAL "1" HOUR'
```

## What we deliberately do NOT do

- **Distributed tracing into D1.** D1 doesn't accept query annotations.
- **Span-level sampling on the worker side.** We use 1% req-line log sampling, but every AE data point is written — AE costs are a flat per-write fee, no value in dropping them.
- **PII in metrics.** Emails / display names / IPs go to `audit_events` (which has access controls), not Analytics Engine.
- **External APM.** No Datadog / New Relic / Sentry / OpenTelemetry collector. Adding one later means swapping `console.log` + `emitCounter` for an OTel exporter — all callsites use the helper, so it's a one-file change.
