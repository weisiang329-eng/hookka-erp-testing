# `migrations-postgres/` — generated Postgres schema

**Do NOT hand-edit files 0001-0044 in this directory.** They are produced by
`scripts/d1-to-postgres.mjs` from the authoritative SQLite migrations in
`migrations/`.

## Why two directories exist (Phase 0-7 coexistence)

- `migrations/` — the historical source of truth (SQLite, applied to D1).
  New migrations land here.
- `migrations-postgres/` — generated output of the preprocessor; applied
  to Supabase via `scripts/apply-postgres-migrations.mjs`.
- The runtime SQL translator (`src/api/lib/d1-compat.ts`) uses the
  `column-rename-map` derived from the same preprocessor to camelCase-proof
  the 68 codemod'd routes.

Phase 7 of the D1 retirement plan (`docs/d1-retirement-plan.md`) collapses
this down to a single directory. Until then, **both must stay in sync**.

## Adding a new migration

1. Write `migrations/NNNN_description.sql` in SQLite dialect, matching the
   existing style (camelCase columns, `INTEGER PRIMARY KEY AUTOINCREMENT`,
   `datetime('now')`, `INSERT OR IGNORE`, etc.).
2. Apply to local D1: `npm run d1:migrate:local`.
3. Regenerate the Postgres copies: `node scripts/d1-to-postgres.mjs`.
   This rewrites every file in this directory AND writes the updated
   `src/api/lib/column-rename-map.json`.
4. Apply to Supabase (dev first, prod second):
   - Dev: `node scripts/apply-postgres-migrations.mjs` (prompts for
     confirmation if the target DB already has tables; pass `--reset` to
     wipe and re-seed).
   - Prod: same script against the prod `DATABASE_URL` with `--reset`
     **only if you mean it**. Live data will be destroyed.
5. Commit both `migrations/NNNN_*.sql` AND the regenerated
   `migrations-postgres/` + `src/api/lib/column-rename-map.json`.

## Exceptions to the generated rule

- `9901_dashboard_mat_views.sql` — hand-written Postgres-only
  (materialized views don't exist in SQLite). Numbered in the 9xxx range to
  stay after the auto-generated 0xxx migrations.
- `0027_sofa_upholstery_packing.sql` and `0029_refresh_sofa_dept_backfill.sql` —
  data-only repairs that use SQLite-specific functions
  (`json_extract`, `randomblob`). Skipped by the applier; the affected rows
  are already present in the D1 data dump imported via
  `scripts/import-d1-data-to-supabase.mjs`.

## Debugging column errors

`column "foo" does not exist` usually means one of:

1. A camelCase identifier was added to a migration in `migrations/` but
   the preprocessor wasn't re-run. → `node scripts/d1-to-postgres.mjs`.
2. A camelCase identifier appears as a SELECT **alias**
   (`SELECT x AS fooBar`) that the D1-compat adapter doesn't rewrite. The
   rename map only covers identifiers that appeared in migrations — aliases
   coined in route code are invisible to it. Fix: quote the alias
   (`AS "fooBar"`) or use snake_case with a camelCase property via
   postgres.js's `toCamel` transform (`AS foo_bar` → `row.fooBar`).
3. A materialized view column was referenced through the rename map.
   MV column names (e.g. `order_count` in `mv_so_summary`) are NOT in the
   rename map — reference them literally in snake_case.
