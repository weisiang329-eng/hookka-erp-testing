# Hookka — Hard-Won Gotchas

Read this BEFORE touching schema, money, SQL, or shipping. These are the
non-obvious traps that have repeatedly cost real time and, in one case, nearly
shipped a broken prod. They are Hookka-specific and intentionally NOT in the
generic context packs.

## Schema / migrations (the #1 trap)

- **Deploys do NOT auto-run Postgres migration files.** `deploy.yml` does not
  replay `migrations-postgres/*.sql` (the D1 migrations step was retired). A
  migration file alone is **INERT on prod**. A new column reaches prod ONLY via
  a runtime self-apply: a module-level promise running idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, **awaited at the TOP of the
  relevant POST/PUT handler, before the first INSERT/UPDATE that uses the
  column.** Reference patterns: `ensurePendingMigrations` in
  `src/api/routes/sales-orders.ts`, `ensureGrnMigrations` in `grn.ts`. Skip this
  and the first write 500s on a missing column (BUG-2026-06-20-002 — caught in
  verify-live, one step from a broken prod). Still write the migration file too
  (record + SQLite test mirror), but the runtime self-apply is what's load-bearing.

- **Make new columns snake_case.** Route SQL is written camelCase and translated
  to snake_case by `src/api/lib/supabase-compat.ts` using
  `src/api/lib/column-rename-map.json`. A camelCase column referenced in route
  SQL **without** a rename-map entry **silently 400s** ("Invalid request body").
  snake_case columns need no map entry — prefer them. CI-guarded by
  `tests/sql-write-column-coverage.test.mjs`. (A 400 on a well-formed body is
  usually a DB write throwing inside a try/catch — suspect this first.)

## Build / ship

- **build:strict before every push** = `npx tsc -p tsconfig.app.json --noEmit`.
  The base `tsconfig.json` is LOOSER and misses errors the deploy gate fails on.
  Ignore exactly **3 known sandbox module errors**: jsbarcode
  (`production/index.tsx`) and @zxing/library (`rack-scan.tsx`, `worker/scan.tsx`).
- **Verify live on prod after every deploy — read AND write path.** Deploy exit 0
  ≠ feature works (stale chunks, silent schema-apply failures, cache bite).
- Rapid back-to-back deploys make open tabs throw "Something went wrong" (stale
  dynamic-import chunk) — not a code bug; a hard refresh fixes it.

## Data shapes

- **Money is sen (integer)** = RM × 100. Use `MoneyInput` (value is `number|null`
  in RM dollars, commits on blur) for sen-int state fields. `DiscountInput`
  (`%`-aware) computes a discount off a base amount and emits sen.
- **PO line code is mashed into the name** as "CODE - DESCRIPTION" —
  `purchase_order_items` has no dedicated code column. Recover it with
  `splitCodeName(code, name)` in `pdf-utils.ts`. GRN/PI and all sales-side docs
  DO have a proper code field (`material_code` / `product_code`) — don't split those.

## Process (how this codebase is worked)

- **Money / inventory / payroll / cascade changes:** investigate → propose with
  options → confirm before coding; when fixing one case, sweep the whole dataset
  for the same pattern. Schema/cascade rewrites go on a dedicated branch.
- **`docs/BUG-HISTORY.md` is the living bug log** — append every diagnosed+fixed
  bug (newest first). It is the source of truth, not GitHub issues.
- **Shared UI primitives** (don't hand-roll): `ObjectPageHeader`/`PageHeader`,
  `useConfirm`, `DataGrid`, `MoneyInput`, `DiscountInput`, `SearchableSelect`;
  one shared PDF letterhead via `drawLetterhead`. See `docs/UI-CONVENTIONS.md`.
