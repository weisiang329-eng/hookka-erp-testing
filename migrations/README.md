# `migrations/` — [LEGACY] SQLite source migrations

> **Source of truth for the live runtime is `migrations-postgres/`** (Supabase
> Postgres via Hyperdrive). D1 was retired on 2026-04-27 — see commit
> `7059259` and `docs/d1-retirement-plan.md`. Files in this directory are no
> longer applied to any live database.

## Why this directory still exists

`scripts/d1-to-postgres.mjs` still uses these SQLite files as INPUT to
regenerate the Postgres migrations + the camelCase → snake_case rename map
that `src/api/lib/d1-compat.ts` consumes at runtime. So the workflow is:

1. (Optional) Author a new migration as `migrations/NNNN_description.sql`
   in SQLite dialect.
2. Run `node scripts/d1-to-postgres.mjs` to regenerate
   `migrations-postgres/NNNN_description.sql` AND
   `src/api/lib/column-rename-map.json`.
3. Apply via the Postgres-aware tool — see `migrations-postgres/README.md`.

You can also skip step 1 entirely and write the Postgres SQL directly in
`migrations-postgres/NNNN_*.sql`, but then you have to remember to add any
new camelCase identifiers to `column-rename-map.json` by hand if route code
relies on the runtime renamer.

## What NOT to do

- Do **not** run `wrangler d1 migrations apply hookka-erp-db ...`. The
  D1 instance still exists in Cloudflare for snapshot rollback, but it has
  zero live traffic. Applying migrations there has no effect on prod.
- Do **not** rely on `npm run db:migrate:local` / `db:migrate:remote` —
  those scripts have been retained as `_LEGACY_*` stubs that print a
  redirect message. The active script is `npm run db:migrate:supabase`.

## Applying migrations to Supabase

See `migrations-postgres/README.md`.
