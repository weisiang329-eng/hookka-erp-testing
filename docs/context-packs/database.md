# Context Pack: Database

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `migrations-postgres/0001_init.sql` (present; **251** migration files; the newest prefix is **`0229`, and TWO files share it** — `0229_pcb_tax_profile.sql` and `0229_worker_leave_entitlements.sql`), `src/api/lib/supabase-compat.ts`, `db-pg.ts`, `tenant.ts`. Broken link to the old root-level HOOKKA-GOTCHAS path repaired.

Use this pack for schema, migrations, tenancy, indexes, constraints, data repair, or query behavior.

> **Read `docs/context-packs/HOOKKA-GOTCHAS.md` first.** The two traps that bite hardest in DB work live there: (1) deploys do NOT replay migration files — a new column reaches prod only via a runtime self-apply (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, awaited at the top of the POST/PUT handler before the first write; see `ensurePendingMigrations`/`ensureGrnMigrations`); a migration file alone is inert on prod. (2) Make new columns **snake_case** — a camelCase column in route SQL needs a `column-rename-map.json` entry or it silently 400s. DB/schema work is always **deep review** (`docs/DEV-OPERATING-FRAMEWORK.md`).

## Read first

- `src/api/lib/supabase-compat.ts`
- `src/api/lib/db-pg.ts`
- `src/api/lib/tenant.ts`
- `migrations-postgres/0001_init.sql`
- The newest migration files touching the target table.
- The route files that read/write the target table.

## Useful searches

```bash
rg -n "CREATE TABLE|ALTER TABLE|CREATE INDEX|REFERENCES" migrations-postgres
rg -n "<table_name>|<column_name>" migrations-postgres src/api/routes src/api/lib tests
rg -n "org_id|tenant|organisation|organization" migrations-postgres src/api
```

## Migration guidance

- Prefer new migrations over editing already-applied migrations unless this is a local-only reset task.
- Check D1-to-Postgres compatibility assumptions before using SQL syntax that might pass through `SupabaseAdapter`.
- Verify whether transactional tables require `org_id`, audit fields, indexes, or status constraints.
