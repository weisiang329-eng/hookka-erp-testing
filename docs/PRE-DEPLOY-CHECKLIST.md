# Pre-Deploy Checklist — IRON LAW

> **Last verified: 2026-08-13** against `migrations-postgres/0049_multi_tenant_skeleton.sql`, `package.json` (`test` = `node --import tsx/esm --test tests/*.test.mjs`; `build` is a bare `vite build`), `src/api/lib/auth-middleware.ts:196` (`SESSION_CACHE_TTL_S = 300`), `src/api/lib/tenant.ts`, and `.github/workflows/deploy.yml`.
> Corrected 2026-08-13: added the staging-DB shortcut that now exists (`wrangler.toml` binds `HYPERDRIVE_STAGING`), and flagged that `npm run build` alone does not type-check — the gate is `build:strict`.
> **UNVERIFIED ASSERTION** (as of 2026-08-13): the 2026-04-29 outage narrative and the "reviewer MUST refuse to merge" process rule are owner/process intent. Neither is checkable from source. The technical claims around them were re-checked and hold.

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
2. **Use the staging DB** — one already exists and is bound as
   `HYPERDRIVE_STAGING` in `wrangler.toml` (Supabase project
   `zaxygxwadidiqcphibma`). Any `*.hookka-erp-testing.pages.dev` preview
   URL, including a PR canary, routes to it automatically
   (`isPreviewHostname` / `pickDbUrl`, `src/api/worker.ts:294-310`).
   Confirm it holds a representative slice of production data before
   trusting a walkthrough against it; `.github/workflows/sync-staging.yml`
   and `trim-staging.yml` maintain it.
3. **Boot the worker against staging** (`npm run dev:worker` with the
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
- ❌ **`npm run build` passing** — twice untrustworthy. First, `build` is
  a bare `vite build` and does **no** type-checking at all; the gate is
  `npm run build:strict` (`typecheck:app && vite build`), which is what
  CI runs. Second, even a green typecheck only knows what your types say,
  not what the DB actually looks like.
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

- The PR template SHOULD include a section: "Schema diff verified
  against production: [paste output]" + "Critical paths verified end
  to end: [list]". **It does not today** — checked 2026-08-14 against
  `.github/PULL_REQUEST_TEMPLATE.md`, which carries `## Impact check`
  (`Database/migrations:`), `## Production-state claims` and `## Testing`,
  but neither of these two strings. Until the template carries them, paste
  the two lines into the PR body by hand.
- The reviewer MUST refuse to merge until both are filled — **these are not
  template checkboxes yet**, so there is nothing pre-rendered for the
  reviewer to look for.
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
`SESSION_CACHE_TTL_S`, which is `300` seconds = 5 minutes —
`src/api/lib/auth-middleware.ts:196`) before the new column shows up in
their cached session.

> Note: migrations do NOT auto-apply on deploy. `.github/workflows/deploy.yml`
> only prints a reminder; the operator runs `npm run db:migrate:supabase`.
> The post-deploy `check-schema-applied.mjs` step catches a missing
> CREATE TABLE, but it runs **after** the deploy and only on pushes to
> `main`, and it does not catch a missing ADD COLUMN.
