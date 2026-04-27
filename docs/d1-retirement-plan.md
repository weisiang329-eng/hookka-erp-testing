# D1 Retirement Plan (Phase 7) — [LEGACY/HISTORICAL]

> **Status (2026-04-27): EXECUTED.** D1 binding removed from
> `wrangler.toml` (commit `7059259`); the `D1Database` field is gone from
> `Bindings`; every route flows `c.var.DB → D1Compat → Postgres → Hyperdrive
> → Supabase`. The original D1 instance (`hookka-erp-db`) still exists in
> Cloudflare for snapshot rollback only — it has zero live traffic. The
> CI step `wrangler d1 migrations apply --remote` was removed from
> `.github/workflows/deploy.yml`; Postgres migrations now apply via
> `npm run db:migrate:supabase` (see `migrations-postgres/README.md`).
>
> The plan below is preserved as historical context.

---

## Pre-conditions

Retirement runs AFTER:

1. Supabase (via Hyperdrive) confirmed stable on production for ≥ 7 days.
2. All routes verified hitting `c.var.DB` (the D1-compat adapter) — none
   still reference `c.env.DB` directly. One-liner check:
   `grep -rn "c\.env\.DB" src/`  should return 0 results (excluding
   `src/api/lib/d1-compat.ts` comments).
3. Any cron / external integration that imports from D1 directly has been
   pointed at Supabase.
4. Final D1 export snapshot archived to R2 (step 2 below).

## Execution steps

### 1. Freeze writes to D1

```bash
# Set a maintenance flag (via wrangler pages secret) so routes can refuse
# any D1 write if they somehow still reach it. Optional — belt & braces.
echo "true" | wrangler pages secret put D1_WRITE_FROZEN
```

### 2. Take final snapshot + archive to R2

```bash
wrangler d1 export hookka-erp-db --remote --output=d1-final.sql
wrangler r2 bucket create hookka-erp-archives
wrangler r2 object put hookka-erp-archives/d1-final-$(date +%Y%m%d).sql \
  --file=d1-final.sql
```

### 3. Remove D1 binding from `wrangler.toml`

Delete the `[[d1_databases]]` block entirely.  The `DB: D1Database` field
can be dropped from `Env.Bindings` in `src/api/worker.ts` once removed.

### 4. Deploy

`wrangler pages deploy dist --branch=main`

### 5. Verify

- All previously working endpoints still return 200.
- `wrangler d1 list` shows the database is still there but unbound from
  this project — do NOT delete the D1 database itself for another 30
  days (belt & braces).

### 6. After 30 days of stable Supabase operation

```bash
# Only if absolutely sure — this is unrecoverable.
wrangler d1 delete hookka-erp-db
```

## Why not retire now?

- Phase 2.5 gates passed on a preview URL, not on main branch.
- No real users on Supabase yet — production traffic still on D1.
- Rollback from Supabase back to D1 today is a `git revert` + `wrangler
  pages deploy`.  After Phase 7 that's a 30-minute data-reimport job.

## Inverse plan (rollback to D1 after Phase 7)

If Supabase dies post-retirement: import the final D1 snapshot back, then
revert the Supabase migration commits.  Data between the retirement date
and the failure would need to be reconciled from Postgres WAL (Supabase
Pro retains 7 days).
