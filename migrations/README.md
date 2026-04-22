# D1 Migrations

Migrations run with `wrangler d1 migrations apply hookka-erp-db --local` (or
`--remote`). Files are applied in lexical order, so the `0001_`, `0002_`
… numbering matters.

Coming in **Phase 1**:

- `0001_init.sql` — canonical schema (customers, products, BOM, SOs, POs,
  GRNs, inventory batches, cost ledger, workers, attendance, …)
- `seed.sql` — dumps `src/lib/mock-data.ts` initial rows as INSERTs so a
  fresh local D1 looks identical to the current dev environment.

Until then, `npm run db:migrate:local` will just create an empty DB.
