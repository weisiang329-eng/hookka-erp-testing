# Context Pack: Architecture

Use this pack for broad system understanding, architecture review, deployment questions, or cross-module refactors.

## Read first

- `README.md`
- `docs/DOCS-INDEX.md`
- `docs/ARCHITECTURE.md`
- `src/main.tsx`
- `src/router.tsx`
- `src/dashboard-routes.tsx`
- `functions/api/[[route]].ts`
- `src/api/worker.ts`

## Key runtime facts

- Frontend: React SPA built by Vite.
- Backend: Hono app served through Cloudflare Pages Functions.
- Database: Supabase Postgres reached through Hyperdrive via the Supabase compatibility adapter.
- Most route code still uses a D1-like `prepare/bind/all` interface, but runtime persistence is Postgres.

## Useful searches

```bash
rg -n "app\.route|app\.(get|post|put|patch|delete|use)" src/api/worker.ts
rg -n "createBrowserRouter|lazy\(|path:" src/router.tsx src/dashboard-routes.tsx
rg -n "Hyperdrive|SupabaseAdapter|D1" src/api docs
```
