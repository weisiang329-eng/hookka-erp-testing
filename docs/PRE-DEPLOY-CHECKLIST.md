# Pre-Deploy Checklist — IRON LAW

> Born from a real outage on **2026-04-29** where production lists went
> empty after a multi-tenant rollout. Root cause: `org_id` column missing
> from 6 core tables in production Postgres because migration 0049 never
> applied during the D1→Postgres conversion. Unit tests passed (185/185)
> because they didn't hit real production schema. **End-to-end testing
> against a copy of production data would have caught this.**

---

## THE RULE (no exceptions)

**Before merging any change that touches:**

- Database schema (migrations, ALTER, new tables, dropped columns)
- Query layer (`WHERE` clauses, JOINs, scoping helpers like `withOrgScope`)
- Auth / RBAC / session / multi-tenant code
- Core list/detail/create handlers in `src/api/routes/`

**The author MUST:**

1. **Pull a fresh copy of production schema** (`pg_dump --schema-only`
   or use the Supabase Dashboard SQL Editor to verify table shapes match
   what the code assumes).
2. **Spin up a staging DB** with that schema + a representative slice
   of production data (~100 SOs, ~50 customers, ~30 invoices, etc.).
3. **Boot the worker against staging** (`wrangler pages dev` with the
   staging DATABASE_URL in `.dev.vars`).
4. **Walk the critical paths in a real browser:**
   - Login as a normal user
   - Open Sales Orders list — confirm rows appear
   - Open Delivery Orders list — confirm rows appear
   - Open Bill of Materials — confirm products list
   - Open Inventory — confirm stock numbers
   - Create a draft SO end-to-end (Customer pick → Items → Save)
   - Confirm the SO (triggers PO cascade)
   - Mark a JC complete (triggers WIP cascade)
   - Issue an invoice (triggers GL hash chain)
5. **Diff staging schema vs production schema** before merge:
   ```sql
   SELECT table_schema, table_name, column_name
     FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name;
   ```
   Compare staging output vs prod output. ANY drift on the columns the
   new code reads/writes = blocker.

## What NOT to trust

- ❌ **Unit tests alone** — `node --test` runs against stubs / regex on
  source files. It cannot tell you whether prod's `users` table has the
  column you assume it has.
- ❌ **`npm run build` passing** — TypeScript only knows what your types
  say, not what the DB actually looks like.
- ❌ **The migration file existing** — being in `migrations-postgres/`
  doesn't prove it ran. The applier might have skipped it, the
  D1→Postgres conversion might have dropped it, or someone might have
  rolled it back manually.
- ❌ **Past PR merges and the upgrade-control-board saying "Done"** —
  those reflect intent, not the current production state. **Always
  verify against the actual database.**

## What to ACTUALLY trust

- ✅ A `SELECT column_name FROM information_schema.columns WHERE
  table_schema='public' AND table_name='<X>'` against production right
  before deploy.
- ✅ A real browser session walking the critical path with real data.
- ✅ A staging clone of production that you've personally seen the
  feature work against.

## Process integration

- The PR template MUST include a section: "Schema diff verified
  against production: [paste output]" + "Critical paths verified end
  to end: [list]".
- The reviewer MUST refuse to merge until both checkboxes are filled.
- For database-touching PRs, attach a screenshot of the staging
  browser test (not a GIF, not a description — a real screenshot).

## What we got wrong on 2026-04-29

The Sprint 4 multi-tenant work assumed migration `0049_multi_tenant_skeleton.sql`
had added `org_id` to 6 core tables (`users`, `sales_orders`, `customers`,
`invoices`, `production_orders`, `audit_events`). The migration file
existed and the upgrade-control-board listed it as Done. **Production
Postgres never had those columns.** New code shipped with `WHERE org_id = ?`
predicates that always returned zero rows.

If we had:
1. Run `SELECT column_name FROM information_schema.columns WHERE
   table_schema='public' AND table_name='users';` before merging Sprint 4,
   we would have seen `org_id` was missing.
2. Logged into the deployed canary URL and clicked "Sales Orders",
   we would have seen the empty list immediately.

Both checks take **under 5 minutes**. Both were skipped. The cost of
skipping was a production outage that required a manual `ALTER TABLE`
hotfix during business hours.

**Never again.**

## Hotfix template (for the next time this happens)

```sql
-- HOTFIX: <migration-name> was never applied to Postgres.
-- Add <column> to <tables> and backfill <default> so existing data
-- shows up under the user's session.

ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> <type> NOT NULL DEFAULT <default>;
-- ... repeat for each affected table

CREATE INDEX IF NOT EXISTS idx_<table>_<column> ON <table>(<column>);
-- ... repeat
```

Run via Supabase Dashboard → SQL Editor. After running, **bust the
session cache**: every active user must re-login (or wait
`SESSION_CACHE_TTL_S` = 5 minutes) before the new column shows up in
their session JWT.
