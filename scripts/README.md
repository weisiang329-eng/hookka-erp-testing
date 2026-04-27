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

## apply-missing-migrations-2026-04-27.sql

One-shot catch-up bundle for the 9 tables the schema-diff agent (commit
`bfb7c2c`) flagged as declared in `migrations-postgres/` but missing from
live Supabase Postgres: `audit_events`, `file_assets`, `ledger_journal_entries`,
`mdm_review_queue`, `oauth_identities`, `permissions`, `role_permissions`,
`roles`, `worker_sessions`.

Concatenates migrations 0045 / 0046 / 0048 / 0051 / 0052 / 0053 / 0055 with
`-- === <filename> ===` split markers. Every `CREATE TABLE` / `CREATE INDEX`
already uses `IF NOT EXISTS` and every `INSERT` uses `ON CONFLICT DO NOTHING`,
so the file is idempotent and safe to re-run.

Apply by pasting into the Supabase SQL Editor (Project → SQL Editor → New
query) and clicking Run. If a single block errors, copy from the preceding
`-- === ... ===` marker to the next one and re-run that slice in isolation.
