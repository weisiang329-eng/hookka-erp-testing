# `routes/` — Supabase Postgres-backed API routes

Every route in this directory runs against **Supabase Postgres** at runtime.

The data path:

- `src/api/worker.ts` middleware constructs a `SupabaseAdapter`
  (`src/api/lib/supabase-compat.ts`) that wraps a `postgres.js` client
  connected through Hyperdrive to Supabase Postgres, then stashes it on
  `c.var.DB`.
- Every route here uses `c.var.DB.prepare(...)` to issue queries. Despite
  the SQLite-flavoured `prepare/bind/all` API surface, the SQL is rewritten
  on the fly to Postgres syntax inside `SupabaseAdapter`.

## TypeScript types still say `D1Database`

That's intentional. The route code is typed against the SQLite-flavoured
interface for historical reasons (and because `SupabaseAdapter` implements
that interface). The runtime data path is 100% Postgres — no real D1 binding
exists in `wrangler.toml`. The legacy D1 binding was removed 2026-04-27
(commit `7059259`); see `docs/d1-retirement-plan.md`.

## When in doubt

- "Where does my route's SQL go?" → Through `SupabaseAdapter` → Postgres.
- "Should I use `c.env.DB` or `c.var.DB`?" → `c.var.DB`. Always. The raw
  `c.env.DB` field no longer exists on `Bindings`, so TypeScript will yell
  if you reach for it.
- "Where do I add a new migration?" → `migrations/` (SQLite-flavoured
  authoring) → run `node scripts/d1-to-postgres.mjs` → apply via
  `npm run db:migrate:supabase`. See `migrations-postgres/README.md`.

## Local dev

`wrangler pages dev` (`npm run dev:worker`) is the backend for local
development — it serves these real routes against Supabase Postgres via
Hyperdrive, the same way prod does. The earlier `src/api/index.ts` +
`src/api/routes-mock/` in-memory dev server was deleted in
BUG-2026-05-28-003 (D1 → Postgres migration made it obsolete).
