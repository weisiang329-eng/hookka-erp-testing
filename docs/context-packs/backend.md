# Context Pack: Backend

> **Last verified: 2026-08-13** against `src/api/worker.ts`, `src/api/routes/README.md`, `src/api/lib/auth-middleware.ts`, `src/api/lib/supabase-compat.ts`, `src/api/lib/db-pg.ts` — all exist; the `c.var.DB` data path is as described. Broken link to the old root-level HOOKKA-GOTCHAS path repaired. For the full endpoint list use the generated [`API.md`](../API.md).

Use this pack for Hono routes, middleware, API contracts, server-side business logic, queues, and integrations.

> Before any DB write or new column: read `docs/context-packs/HOOKKA-GOTCHAS.md` (migration self-apply + snake_case rename-map — both silently break prod writes if skipped). For how deep to review a given change, see `docs/DEV-OPERATING-FRAMEWORK.md`.

## Read first

- `functions/api/[[route]].ts`
- `src/api/worker.ts`
- `src/api/routes/README.md`
- `src/api/lib/auth-middleware.ts`
- `src/api/lib/supabase-compat.ts`
- `src/api/lib/db-pg.ts`
- The target route under `src/api/routes/<resource>.ts`

## Backend data path

Cloudflare Pages Functions forward `/api/*` to the Hono worker. Middleware injects a Supabase/Postgres-backed D1-compatible adapter into `c.var.DB`. Route files normally query through `c.var.DB.prepare(...).bind(...).all()` or related D1-shaped methods.

## Useful searches

```bash
rg -n "app\.route\('/api/<resource>|<resource>Route" src/api/worker.ts
rg -n "\.get\(|\.post\(|\.put\(|\.patch\(|\.delete\(" src/api/routes/<resource>.ts
rg -n "prepare\(|transaction|audit|org_id|requirePermission" src/api/routes/<resource>.ts src/api/lib
```

## Common follow-up files

- Frontend caller: `src/pages/<module>/`
- Database migrations: `migrations-postgres/*.sql`
- Tests: `tests/*<resource>* test files`
