# SDK Migration Status — P5.1–5.6 Audit

> **Last verified: 2026-08-13** against `src/lib/api/` (client.ts, request.ts, cache.ts, errors.ts, resources/), `src/lib/safe-json.ts`, and a scan of all 174 files under `src/pages/`.
> Corrected 2026-08-13: the **decision still holds and the headline claim is still true** — 0 of 174 page files import `@/lib/api`. The page counts were stale: the doc said "49 pages use fetchJson + Zod"; measured today it is 88 pages using `useCachedJson` and 14 using `fetchJson` (the two overlap). The `safe-json` consumer list was also wrong: it is now 3 files, not 5, and two names changed — `src/pages/quality.tsx` and `src/pages/analytics/forecast.tsx` no longer import it, `src/pages/maintenance/sofa-combos.tsx` newly does, and `src/pages/dashboard/index.tsx` does not exist at all.

> **Last updated**: 2026-04-25
> **Status**: SDK adoption stable — full migration deferred per cost/benefit. New code goes through `@/lib/api`; legacy `fetchJson + Zod` path is acceptable for existing pages.
> **Related**: [UPGRADE-CONTROL-BOARD.md](archive/UPGRADE-CONTROL-BOARD.md) Phase 5

## TL;DR

The unified API SDK (`src/lib/api/`) landed in commit `fecca6d` (Phase B.1). Tasks **P5.1–P5.6** in the 90-day plan called for migrating per-domain pages onto the SDK and deleting the legacy `safe-json` / `fetchJson` helpers.

Audited 2026-04-25, re-measured 2026-08-13:

- The SDK exists and is well-scaffolded (10 resource modules covering 22 domains).
- **Zero pages currently import from `@/lib/api`.** (Still true on 2026-08-13 — 0 of 174 page files.)
- **~88 pages use `useCachedJson` and 14 use `fetchJson`** (the "legacy" path). The
  original "49 pages" figure was a 2026-04-25 count; the page tree has since grown to 174 files.
- The "legacy" path is itself the result of a deliberate TS-cleanup migration (commits `9dc583f`, `1fcd468`, `745801a`, `1b4619b`) that replaced raw `fetch + as Foo[]` casts with Zod-validated parses.

Both paths are type-safe. The SDK provides incremental ergonomic wins (autocomplete on resource names, automatic cross-prefix cache invalidation, single `ApiError` enum). It does NOT fix any open bug or unlock any blocked feature.

A full migration of 49 pages would be ~3–5 days of mechanical churn, with non-trivial regression risk on a live system. The cost/benefit does not justify it right now.

## Decision

**Declare victory on Phase 5 with this go-forward rule:**

1. **All NEW code** — new pages, new fetch sites in existing pages — must use `@/lib/api`. The SDK README ([src/lib/api/README.md](../src/lib/api/README.md)) is the reference.
2. **Existing pages** stay on `fetchJson + Zod` indefinitely. They are type-safe; they have AbortController + traceparent + auth built in via `fetchJson` and `useCachedJson`. There is no foot-gun.
3. **Migration is opportunistic** — when a page is being substantially refactored for another reason (new feature, RBAC wiring, observability instrumentation), the dev may migrate it onto the SDK in the same diff. This is encouraged but never required.
4. **No ESLint rule blocking raw `fetch(`** — the original P5.6 idea — because the legacy path is sanctioned, not deprecated. A lint rule would force every existing page to add an `eslint-disable` comment, which is noise.
5. **No deletion of `src/lib/safe-json.ts`** — the original P5.5 idea — until the last consumer is migrated. As measured 2026-08-13, **3** pages import it (down from the 5 listed in April, and not the same 5):
   - `src/pages/employees.tsx`
   - `src/pages/maintenance.tsx`
   - `src/pages/maintenance/sofa-combos.tsx`

   No longer consumers: `src/pages/quality.tsx`, `src/pages/analytics/forecast.tsx`
   (it has a local `asArray`, not the shared helper). `src/pages/dashboard/index.tsx`
   does not exist.

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

> Note (2026-08-13): `UPGRADE-CONTROL-BOARD.md` is itself archived/superseded — its last
> real update was 2026-04-26. Do not use it to check current status; only the Phase-5
> decision recorded *here* is still load-bearing.

Phase 5 in the [control board](archive/UPGRADE-CONTROL-BOARD.md) is **Done** with the gate output: "SDK adoption stable; full migration deferred per cost/benefit (see docs/SDK-MIGRATION-STATUS.md). New code goes through SDK; legacy fetchJson+Zod path is acceptable."

Phases 6 (Observability) and 7 (Hardening) proceed without a Phase 5 dependency.
