# `routes-d1/` — [LEGACY directory name; live runtime is Postgres]

The directory name is historical. When this code was first authored, every
route here talked to Cloudflare D1 via `c.env.DB` (a `D1Database` binding).

Today (post 2026-04-27, commit `7059259`):

- The D1 binding has been removed from `wrangler.toml`.
- `src/api/worker.ts` middleware constructs a `D1Compat` adapter
  (`src/api/lib/d1-compat.ts`) that wraps a `postgres.js` client connected
  through Hyperdrive to Supabase Postgres, then stashes it on `c.var.DB`.
- Every route here uses `c.var.DB.prepare(...)` (NOT `c.env.DB`) — so they
  all run against Postgres at runtime, despite the directory name.

## Why hasn't the directory been renamed?

The `routes-d1` name is referenced in 60+ `import` statements across
`src/api/worker.ts`. A rename is mechanically trivial but creates a
high-touch diff that is easy to do badly under time pressure. It will be
done as a low-risk, separate PR. Until then, treat the path as a quirk and
don't read "D1" into the actual data path.

## When in doubt

- "Where does my route's SQL go?" → Through `D1Compat` → Postgres.
- "Should I use `c.env.DB` or `c.var.DB`?" → `c.var.DB`. Always. The raw
  `c.env.DB` field no longer exists in the `Bindings` type, so TypeScript
  will yell if you reach for it.
- "Where do I add a new migration?" → See `migrations-postgres/README.md`.

See also `docs/d1-retirement-plan.md` for the historical context of the
D1 → Supabase migration.
