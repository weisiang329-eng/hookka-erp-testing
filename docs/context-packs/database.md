# Context Pack: Database

Use this pack for schema, migrations, tenancy, indexes, constraints, data repair, or query behavior.

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
