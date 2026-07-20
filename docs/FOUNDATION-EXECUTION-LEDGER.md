# Hookka ERP foundation execution ledger

> Canonical cross-session handoff for the 2026-07 foundation, FE/BE/DB,
> performance, staging, and production-safety programme. Read this before
> continuing the programme. Update it in every related PR.

Last verified: **2026-07-20 (Asia/Kuala_Lumpur)**  
Owner policy: **all changes prove on `staging` first; production/main remains
unchanged until the owner accepts staging.** This policy overrides older handoff
documents that say bug fixes go straight to main.

## Current state — read first

- Foundation runtime candidate: `76687226dc0c01aab9037ffba3db9822f7f0e319`
  (`security: remove embedded database credentials (#75)`). PR #76 adds this
  ledger only, so it advances the branch SHA without changing runtime code.
- Always resolve the exact current head instead of trusting a copied value:
  `git fetch origin staging && git rev-parse origin/staging`.
- `main` / production: deliberately untouched by this programme.
- Latest staging deploy: [run 29754021143](https://github.com/weisiang329-eng/hookka-erp-testing/actions/runs/29754021143),
  stopped in the first read-only DB preflight because the GitHub
  `STAGING_DATABASE_URL` credential failed PostgreSQL password authentication.
- Migration preview, migration apply, build, and Cloudflare deploy were all
  skipped. The previously deployed staging site is still serving; do not claim
  the new foundation release is deployed yet.
- Required owner action: rotate both Supabase database passwords and update the
  GitHub `PROD_DATABASE_URL` and `STAGING_DATABASE_URL` secrets. Never paste the
  values into an issue, PR, chat, command output, or tracked file.
- After secrets are updated, rerun 29754021143. Do not bypass the DB target or
  data-integrity gates.

## Completed and merged to staging

| PR | Outcome |
|---|---|
| [#64](https://github.com/weisiang329-eng/hookka-erp-testing/pull/64) | Repository/worktree hygiene and generated-file cleanup |
| [#65](https://github.com/weisiang329-eng/hookka-erp-testing/pull/65) | Dependency security baseline |
| [#66](https://github.com/weisiang329-eng/hookka-erp-testing/pull/66) | Machine-readable BugHistory and regression policy |
| [#67](https://github.com/weisiang329-eng/hookka-erp-testing/pull/67) | Page-aware route prefetch; removed indiscriminate warming |
| [#68](https://github.com/weisiang329-eng/hookka-erp-testing/pull/68) | API idempotency, tenant boundaries, invoice uniqueness foundation |
| [#69](https://github.com/weisiang329-eng/hookka-erp-testing/pull/69) | Release identity, schema version, production-promotion gate |
| [#70](https://github.com/weisiang329-eng/hookka-erp-testing/pull/70) | Deterministic API contract inventory |
| [#71](https://github.com/weisiang329-eng/hookka-erp-testing/pull/71) | Customer/supplier payment tenant and total contracts |
| [#72](https://github.com/weisiang329-eng/hookka-erp-testing/pull/72) | Canonical receipt linkage; removed the second quick-pay rule |
| [#73](https://github.com/weisiang329-eng/hookka-erp-testing/pull/73) | Integrated foundation rollup into staging |
| [#74](https://github.com/weisiang329-eng/hookka-erp-testing/pull/74) | Staging-only migration proving gate and Node 22/Wrangler 4 fix |
| [#75](https://github.com/weisiang329-eng/hookka-erp-testing/pull/75) | Removed 113 embedded DB URLs from 109 scripts; fail-closed env injection and secret-scan CI |
| [#76](https://github.com/weisiang329-eng/hookka-erp-testing/pull/76) | Canonical cross-session execution ledger (documentation-only) |

## Current P1 delivery candidate

- [PR #77](https://github.com/weisiang329-eng/hookka-erp-testing/pull/77)
  (`agent/high-risk-contracts`) closes the first auth/admin contract batch.
  Admin create/update/reset/invite and public invite acceptance now use shared,
  strict request schemas; every password write uses the canonical strength
  policy in FE and BE.
- `users.role` is now the single runtime role source for session authorization,
  backend permission checks, and frontend navigation permissions. The retained
  `users.roleId` compatibility column no longer contradicts a successful role
  change in the UI.
- Regression: `tests/user-admin-contract.test.mjs`; BugHistory
  `BUG-2026-07-20-004`. Production remains unchanged.

## Last complete local evidence

- Full suite: **1780 tests / 1779 pass / 0 fail / 1 skip**.
- Strict app typecheck: pass.
- Production build: pass, **3448 modules** transformed.
- `npm audit`: **0 vulnerabilities**.
- Script syntax audit: **110 files / 0 failures**.
- Repository PostgreSQL credential scan: **0 current-tree findings**.
- BugHistory: **457 unique entries**, machine policy current.
- API inventory: **881 endpoints / 531 mutations / 322 JSON-body routes / 8
  schema-validated routes**. The auth/admin batch raised this from 3. The low
  overall count is an explicit follow-up,
  not a claim that the API contract work is finished.
- Latest intended schema version: **0211**. Migrations 0208–0211 have not yet
  been proven/applied by the new staging workflow.

## Exact resume procedure

1. Confirm the owner has rotated both database passwords and updated both
   GitHub repository secrets. Do not ask for or handle plaintext values.
2. Rerun staging workflow run 29754021143 (or push a no-op follow-up only if a
   rerun is unavailable).
3. Inspect the `Preflight staging database migrations` output:
   - target must be the reviewed staging project ref;
   - active invoice/DO duplicate groups must be zero;
   - AR/AP historical exception counts are warnings only; do not expose rows.
4. Confirm the dry-run reports only the explicit allow-list:
   `0208`, `0209`, `0210`, `0211`. Any other pending migration is a blocker.
5. Confirm all four apply successfully, then tests/typecheck/build and
   Cloudflare deploy complete.
6. Verify staging, in this order:
   - `/version.json` identifies the exact staging merge SHA and schema `0211`;
   - `/api/health` is 200;
   - `/api/pg-ping` is 200 and targets staging;
   - authenticated smoke: login, core lists, one safe read per money flow;
   - browser console/network: no new 4xx/5xx loop or duplicate mutation.
7. Record evidence here and in BugHistory. Do not merge to main until the owner
   explicitly accepts staging.

## If a gate fails

- Password/authentication: fix/rotate the GitHub secret; never weaken the ref
  check and never insert a password into source.
- Wrong project ref: stop immediately. Treat it as a production-safety event.
- Active duplicate invoices: inspect aggregate scope and the documented create
  paths. Do not delete/cancel or auto-dedupe financial records without an
  approved remediation plan.
- Unexpected pending migrations: review ordering and dependencies; do not widen
  `MIGRATION_ALLOWED_PENDING` merely to make CI green.
- Cloudflare failure after DB apply: migrations are forward-only; fix deploy and
  rerun. Never roll back by destructive schema edits.

## Remaining programme backlog

### P0 — security response and staging proof

- Rotate both DB passwords and update GitHub secrets (owner/external action).
- Deploy and verify the current staging head through schema 0211.
- Decide whether to purge credentials from Git history. This is a coordinated,
  destructive force-rewrite and must happen only after rotation and explicit
  owner approval.
- Production still contains the old tracked script values until an approved
  promotion or emergency security patch. Rotation is what makes those values
  harmless; current-tree deletion alone is insufficient.

### P1 — FE/BE/DB contract convergence

- Move the highest-risk JSON mutation routes from ad-hoc parsing to shared
  schemas, starting with money, inventory movement, auth/admin, and bulk writes.
- Eliminate remaining duplicate business-rule owners by tracing every FE write
  to one backend service/transaction and one DB invariant.
- Add contract tests for idempotency, tenant ownership, state transitions,
  cent-exact totals, and concurrent retry behaviour.
- Compare route fields with migrations/runtime rename maps and generate a
  FE ↔ API ↔ DB drift report in CI.

### P1 — measured performance, page by page

- Preserve page-aware prefetch. Do not apply one loading strategy globally.
- Establish budgets for login/core shell, list pages, heavy PDF/Excel routes,
  scanner/mobile routes, and weak-network first load.
- Measure route navigation only after asserting pathname changed and expected
  data rendered; prior `0 ms` readings were false measurements.
- Root-cause the common React route-transition floor on staging; prioritise
  planning/delivery before invoices, which remeasurement showed was relatively
  cheap.
- Add API timing, query-count, payload-size, cache-hit, and abort/dedup evidence
  before changing indexes, pooling, caching, virtualization, or skeletons.

### P2 — repository and AI-development efficiency

- Classify legacy one-off scripts as keep, archive, or replace only after
  checking references and BugHistory. Do not mass-rename or mass-delete them.
- Add naming rules for new files; rename existing files only when ambiguity or
  tooling cost is measurable, with import/reference-safe commits.
- Keep generated inventories, BugHistory, release identity, secret scan, and
  staging evidence machine-checkable so future agents do not repeat audits.
- Reconcile older handoff/work-tracker entries against shipped code; mark stale
  items instead of reimplementing them.

### P2 — external ERP lessons

- Continue comparing Odoo, ERPNext, and public Oracle material by failure class:
  transaction/idempotency, tenant/security, migration/upgrade, accounting
  immutability, concurrency, N+1/query plans, caching, and UI loading.
- Adopt only controls that match Hookka's Cloudflare + Postgres + React stack.
  Record the Hookka failure mode and regression evidence; do not copy technology
  merely because a larger ERP uses it.

## Safe verification commands

```sh
npm run security:secrets:check
npm run bugs:check
npm run api:contracts:check
npm run release:check
npm run test:all
npm run build:strict
npm audit --audit-level=high
```

Never run a historical DB script without explicitly supplying the intended
environment variable and independently verifying the target. Never print a
connection URL.

## Handoff definition of done

A successor can continue when they can state all five facts without guessing:

1. the exact staging SHA and last workflow run;
2. whether migrations 0208–0211 are pending or applied;
3. why production is unchanged;
4. the current external blocker and who owns it;
5. the next smallest safe PR and its regression evidence.
