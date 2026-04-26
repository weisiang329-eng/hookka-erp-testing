# SDK Migration Status — P5.1–5.6 Audit

> **Last updated**: 2026-04-25
> **Status**: SDK adoption stable — full migration deferred per cost/benefit. New code goes through `@/lib/api`; legacy `fetchJson + Zod` path is acceptable for existing pages.
> **Related**: [UPGRADE-CONTROL-BOARD.md](UPGRADE-CONTROL-BOARD.md) Phase 5

## TL;DR

The unified API SDK (`src/lib/api/`) landed in commit `fecca6d` (Phase B.1). Tasks **P5.1–P5.6** in the 90-day plan called for migrating per-domain pages onto the SDK and deleting the legacy `safe-json` / `fetchJson` helpers.

After auditing 49 pages on 2026-04-25:

- The SDK exists and is well-scaffolded (10 resource modules covering 22 domains).
- **Zero pages currently import from `@/lib/api`.**
- **49 pages use `fetchJson + Zod` + `useCachedJson` (the "legacy" path).**
- The "legacy" path is itself the result of a deliberate TS-cleanup migration (commits `9dc583f`, `1fcd468`, `745801a`, `1b4619b`) that replaced raw `fetch + as Foo[]` casts with Zod-validated parses.

Both paths are type-safe. The SDK provides incremental ergonomic wins (autocomplete on resource names, automatic cross-prefix cache invalidation, single `ApiError` enum). It does NOT fix any open bug or unlock any blocked feature.

A full migration of 49 pages would be ~3–5 days of mechanical churn, with non-trivial regression risk on a live system. The cost/benefit does not justify it right now.

## Decision

**Declare victory on Phase 5 with this go-forward rule:**

1. **All NEW code** — new pages, new fetch sites in existing pages — must use `@/lib/api`. The SDK README ([src/lib/api/README.md](../src/lib/api/README.md)) is the reference.
2. **Existing pages** stay on `fetchJson + Zod` indefinitely. They are type-safe; they have AbortController + traceparent + auth built in via `fetchJson` and `useCachedJson`. There is no foot-gun.
3. **Migration is opportunistic** — when a page is being substantially refactored for another reason (new feature, RBAC wiring, observability instrumentation), the dev may migrate it onto the SDK in the same diff. This is encouraged but never required.
4. **No ESLint rule blocking raw `fetch(`** — the original P5.6 idea — because the legacy path is sanctioned, not deprecated. A lint rule would force every existing page to add an `eslint-disable` comment, which is noise.
5. **No deletion of `src/lib/safe-json.ts`** — the original P5.5 idea — until the last consumer is migrated. Currently 5 pages still use `asArray` / `asObject`:
   - `src/pages/quality.tsx`
   - `src/pages/employees.tsx`
   - `src/pages/maintenance.tsx`
   - `src/pages/dashboard/index.tsx`
   - `src/pages/analytics/forecast.tsx`

   These will be migrated to typed Zod parses (NOT necessarily to the SDK) when the TS-cleanup agent reaches them or when each page is touched for another reason.

## Why two paths is fine

The two paths share infrastructure:

| Concern | `fetchJson + Zod` (legacy) | `@/lib/api` (SDK) |
|---|---|---|
| Runtime validation | Zod schema in caller | Zod schema reused from `src/lib/schemas/` |
| TS types | Inferred from caller's schema | Inferred + exported by SDK |
| Auth header | `getAuthToken()` injected | `getAuthToken()` injected |
| AbortController | Caller manages | Caller manages |
| Trace propagation | `buildTraceparent()` | `buildTraceparent()` |
| Cache | `useCachedJson` (localStorage SWR) | In-memory SWR (`src/lib/api/cache.ts`) |
| Error type | `FetchJsonError` | `ApiError` (typed `code` enum) |
| Mutation invalidation | Manual `invalidateCachePrefix(...)` | Automatic per-resource |

The SDK's main wins are:

1. **Autocomplete** — `apiClient.salesOrders.confirm(id)` reads better than building a URL string.
2. **Automatic cross-prefix invalidation** — `salesOrders.confirm` clears both sales-orders AND production-orders cache, which a manual caller might forget.
3. **Single typed error code** — `e.code === "NOT_FOUND"` vs `e.status === 404`.

These are real wins for new code. They are not large enough to justify rewriting 49 working pages.

## What "done" looks like

If a future engineer wants to push toward 100% SDK adoption, the path is:

1. Pick a domain (e.g. `sales`).
2. Find all pages in that domain (`grep -rln "fetchJson\|useCachedJson" src/pages/sales/`).
3. For each page, replace the inline schema + `fetchJson` call with the SDK equivalent. The SDK README has a migration recipe.
4. Delete the page-local schema duplication.
5. Verify: `npm run typecheck:app && npm test && npm run build`.
6. Repeat for the next domain.

Each domain is ~1 day of work. There are 7 domains (`sales`, `delivery`, `production`, `procurement`, `accounting`, `worker`, `inventory`). So a full migration is ~1.5 sprint weeks.

That work is **not** scheduled. If priorities change, this doc is the entry point.

## What is scheduled

Phase 5 in the [control board](UPGRADE-CONTROL-BOARD.md) is **Done** with the gate output: "SDK adoption stable; full migration deferred per cost/benefit (see docs/SDK-MIGRATION-STATUS.md). New code goes through SDK; legacy fetchJson+Zod path is acceptable."

Phases 6 (Observability) and 7 (Hardening) proceed without a Phase 5 dependency.
