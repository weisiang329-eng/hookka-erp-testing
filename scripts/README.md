# scripts/

Maintenance + CI scripts. Run from the repo root.

## check-schema-applied.mjs

Schema-drift guard. Parses every `CREATE TABLE` in `migrations-postgres/*.sql`,
queries live Postgres (`information_schema.tables`, `public` schema), and
fails if any migration-declared table is missing from the database.

Wired into `.github/workflows/deploy.yml` after the Pages deploy step so a
shipped migration that never reached Supabase gets caught before it silently
breaks runtime ("relation does not exist" - see migration 0063 incident).

Env: `DATABASE_URL` (Supabase pooler, port 6543).

```sh
# CI mode (exit 1 on drift)
DATABASE_URL=postgres://... node scripts/check-schema-applied.mjs

# Local check, never fails
DATABASE_URL=postgres://... node scripts/check-schema-applied.mjs --dry-run
```

## apply-postgres-migrations.mjs

Applies every migration in `migrations-postgres/` against `DATABASE_URL`.
Drops & recreates `public` schema - pass `--reset` to confirm against a
populated DB.
