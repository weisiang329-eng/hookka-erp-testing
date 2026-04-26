# 90-Day Enterprise Upgrade — Final Readout

> **Window**: 2026-04-25 → 2026-04-26 (originally planned 13 weeks; compressed via parallel-agent execution)
> **Status**: Phases 1–6 substantially complete; Phase 7 partial (P7.2 + P7.4 + P7.5 done; P7.1 + P7.3 deferred)
> **Plan it executes against**: [PROGRAM-90D-EXECUTION.md](PROGRAM-90D-EXECUTION.md)
> **Live status board**: [UPGRADE-CONTROL-BOARD.md](UPGRADE-CONTROL-BOARD.md)

## Headline numbers

| Metric | Before | After | Δ |
|---|---|---|---|
| TS errors (`npm run typecheck:app`) | ~190 | 0 | -100% |
| `tsconfig.app.json` `strict` | `false` | `true` | flipped |
| API routes with explicit `requirePermission` middleware | ~3 (ad-hoc `if (role !== "SUPER_ADMIN")`) | 14 route files (invoices, payments, cost-ledger, three-way-match, grn, purchase-orders, debit-notes, e-invoices, payroll, payslips, accounting, users, workers, worker-auth) | +366% |
| Audit-logged mutations | 2 (`job_card_events`, `scan_override_audit` — domain-specific) | 13 (unified `audit_events`: SO create/confirm, payment create, PO create, GRN create, invoice post + void, user role-change, worker hard-delete, payroll post, credit-note create, debit-note create, e-invoice submit, BOM-master publish) | +550% |
| Worker session persistence | in-process Map (lost on every cold start) | D1 `worker_sessions` table | persistent |
| Frontend role/permission gating | none (sidebar showed hardcoded "Lim / Director") | `<RequireRole>` + `<RequirePermission>` + `usePermissions()` hook + nav-link hiding + sidebar reads `getCurrentUser()` | shipped |
| Multi-tenant `orgId` skeleton | none | `orgId` column on `sales_orders`, `customers`, `invoices`, `production_orders`, `audit_events`, `users` + `tenantMiddleware` + `withOrgScope` (first consumer: sales-orders GET) | seeded; full rollout = P7.1 (post-window) |
| Append-only ledger + hash chain | none | `journal_entries` table + `journal-hash.ts` + invoice dual-write on post | shipped |
| Master-data duplicate review queue | none | `mdm_review_queue` table + `mdm-detect.ts` (name/phone/email/tax-id fuzzy match) + `POST /api/mdm/scan` | shipped |
| OAuth + 2FA scaffolding | none | Google Workspace OAuth + TOTP migrations + crypto helpers + route handlers + `docs/AUTH-OAUTH-SETUP.md` | scaffold (e2e production verification pending) |
| Scheduler primitive | none — 30+ raw `setInterval`/`setTimeout` scattered across pages | `src/lib/scheduler.ts` `useInterval` + `useTimeout` (visibility-aware, unmount-safe) + ESLint warn-guard | primitive shipped; P4.3 call-site drain in flight |
| CI gates | smoke test + `vite build` only | smoke + `lint:app` (warn) + `npm test` (48/48) + `build:strict` (typecheck blocking) + canary deploy on PR + bundle size budget (warn) | hardened |
| Pre-commit hook | none | husky + lint-staged with `--no-stash` (multi-agent worktree safe) | shipped |
| Bundle size budget | none | `scripts/check-bundle-size.mjs` against `.bundle-baseline.json` (94 chunk-stems / 4,197 KB; 5% per-stem growth threshold) | shipped (continue-on-error week, then graduates to blocking) |
| Observability | console-only logs | `Server-Timing: app;dur=N, db;dur=M;desc="K queries"` per response + W3C `traceparent` propagation browser → API → D1 (logged in `[req]` lines) + Cloudflare Analytics Engine per-route p50/p75/p95 + per-resource counters + audit/login/4xx/5xx counts | shipped (P6.4 dashboard in flight) |
| `/api/production-orders` p95 | 8–9s (full table scans on dept-narrowed JC + DISTINCT subquery) | TBD — verify post-deploy via `Server-Timing` `db;dur=N` after `migrations/0047_perf_indexes.sql` applies (4 new indexes; expected drop to <500 ms) | indexes shipped, p95 measurement pending |
| Raw timer call sites in `src/` (excl. allowlist) | ~30 | ~13 (37 occurrences across 20 files; ~17 are in allowlist or `scheduler.ts` itself; ~13 remain to migrate) | -57% (P4.3 in flight) |

## Phases — final state

**Phase 1 — CI Gate Foundation.** Complete. `build:strict` (typecheck-blocking) replaced the original ratchet-against-baseline plan once TS hit zero faster than expected (single-day drain via parallel agents). Lint stays non-blocking pending P7.4 debt drain. Husky pre-commit lands on `*.{ts,tsx}` with `--no-stash` to keep multi-agent worktrees stable. P1.1 (`.ci-baseline/` snapshot) was deferred and later marked N/A — never created — because the absolute-zero gate made it moot.

**Phase 2 — Type Baseline Restoration.** Complete with deferral. ~190 TS errors → 0; `strict: true` flipped with 0 net new errors. `noUnusedLocals` + `noUnusedParameters` would have surfaced ~63 latent errors and was split out as TS.E2 (post-window).

**Phase 3 — Authz / RBAC / Audit Foundation.** Complete. Schema (`0045_rbac.sql` 8 roles / ~150 permissions, `0046_audit_events.sql`, `0048_worker_sessions.sql`) + middleware (`requirePermission` over 14 route files) + frontend gates (`<RequirePermission>`, `<RequireRole>`, `usePermissions`) + sidebar reads current user (no more hardcoded demo identity) + KV session-cache invalidation on role change. Worker auth migrated from in-process Map to D1.

**Phase 4 — Scheduler Policy.** Primitive + ESLint guard shipped (P4.1 + P4.2). P4.3 (migrate ~30 raw call sites) is in flight; two entangled cases in `production/index.tsx` are documented as P4.3-followup with block-scoped `eslint-disable` and justifications. P4.4 (lift `useVersionCheck` to root via context) deferred to post-window.

**Phase 5 — API SDK + Unified Query.** Unified API client landed (16 files / 1233 lines: `client.ts` + `request.ts` + `cache.ts` + `errors.ts` + `_crud.ts` + 11 resource modules). Per-page migration (P5.1–P5.6) audited and deferred per cost/benefit — see [SDK-MIGRATION-STATUS.md](SDK-MIGRATION-STATUS.md). Go-forward rule: new code uses `@/lib/api`; legacy `fetchJson + Zod` is sanctioned, not deprecated. P5.6 (lint-block raw `fetch(`) explicitly decided against — would force noise eslint-disables on sanctioned legacy code.

**Phase 6 — Observability.** P6.1 done (W3C traceparent + `Server-Timing` per response). P6.2 + P6.3 landed in commit 0ab1081 — Cloudflare Analytics Engine writes per-route p50/p75/p95 + per-resource counters + audit/login/4xx/5xx counts. P6.4 (`/admin/health` page rendering on top of those queries) is in flight (untracked `src/api/routes-d1/admin-health.ts` + `src/pages/admin/` at sweep time) — slated to land before the window closes.

**Phase 7 — Hardening + Buffer.** P7.2 (bundle size budget script + baseline + non-blocking CI step), P7.4 (lint debt drain — partial, in flight), P7.5 (this readout), P7.B5 (canary deploy on PR), P7.C1 (multi-tenant skeleton), P7.C3 (OAuth + TOTP scaffolding), P7.S2 (default-protect `/api/worker/*`) all shipped. P7.1 (`org_id` scoping rolled out to all read queries) deferred — skeleton + first 5 tables landed, but cross-cutting refactor across all routes is post-window. P7.3 (DR drill execution) deferred — runbook exists; live drill not yet executed.

## Lessons learned

1. **Multi-agent worktree races are real and recurring.** Three sweep-style commits in Batch 1 (9dc583f, 1fcd468, 745801a) carried other agents' WIP under TS-cleanup messages. Three more recurrences across Batches 5–7 (1c9a14c carrying P5.0 chunking, d8e0a2f carrying TS.E + P1.6, 92f9792 carrying P7.4 hooks) were caught and documented via note-only follow-up commits (5ba0b89, 7686b86, 9de262c) per AGENTS-COMMIT-HYGIENE.md Rule 6. Mitigations layered in over the course of the window: AGENTS-COMMIT-HYGIENE.md (commit c9fae6b), husky `--no-stash` (commit 2b21ebf), explicit `git add <paths>` discipline. Net cost: ~6 mislabeled commit messages, no work lost. The sweep pattern keeps appearing — not because the rules aren't documented, but because `git add -A` is muscle memory. The husky stash-collision fix was the single most effective structural mitigation.

2. **Strict typecheck graduation was free at the right moment.** Flipping `strict: true` produced 0 net new errors because the TS.A–TS.D drain had already cleared them. This was timing-luck — had we flipped `strict: true` first, the same flip would have produced ~80+ errors layered on top of the baseline 190. Lesson: drain first, ratchet second. `noUnusedLocals` + `noUnusedParameters` would surface ~63 errors today and were split as TS.E2 — same playbook, different week.

3. **Plans get faster, not slower, when phases are independent.** The 13-week plan compressed to ~2 days because Phases 1, 3, 4, 6, and 7 had near-zero dependencies on each other. The bottleneck was Phase 2 (TS drain) blocking P1.6 (gate flip). When the plan locked the schedule by week-number, parallel agents made the schedule meaningless. Lesson: schedule by dependency, not by calendar.

4. **Deferral is a feature, not a failure.** P5.1–P5.6 + P5.6-as-lint were explicitly decided against / deferred per cost-benefit, not silently dropped. P7.1 (full `orgId` rollout) and P7.3 (DR drill) are similarly explicit deferrals with the skeleton + runbook in place. The control board's Done lane carries those decisions, so anyone reading the audit trail in 6 months sees the reasoning, not just an empty row.

5. **One acceptance command per row is the rate-limiter on completionism.** Rows with vague gates ("dashboard shows trend") sat in Backlog because they couldn't be proven done. Rows with crisp gates ("`select count(*) from role_permissions` > 0", "`POST /api/mdm/scan` returns rows") closed cleanly. This is the same rigor the plan started with — every milestone has a single command that proves it — paying off at scale.

## What's next

Items NOT in scope for this 90-day window — explicit deferrals for the post-window queue:

- **TS.E2** — `noUnusedLocals` + `noUnusedParameters` flip (~63 latent errors)
- **P4.3** — finish raw-timer call-site drain (~13 remaining; entangled with P7.4)
- **P4.4** — lift `useVersionCheck` to root layout via context (~1 instance instead of N)
- **P5.1–P5.5** — per-page SDK migration (deferred per cost-benefit; legacy `fetchJson + Zod` is sanctioned)
- **P6.4** — `/admin/health` page for SUPER_ADMIN rendering the P6.2 + P6.3 telemetry (in flight at sweep time; expected to close in the same batch)
- **P7.1** — apply `withOrgScope` predicate to every read query (skeleton + 5 tables done; full rollout pending)
- **P7.3** — execute the DR drill end-to-end (runbook exists; live restore not yet tested)
- **`/api/production-orders` p95 measurement** — verify the indexes from `migrations/0047_perf_indexes.sql` actually drop p95 to <500 ms via the `Server-Timing` `db;dur` header on a representative production request set
- **P7.2 graduation** — flip the bundle size budget step from `continue-on-error: true` to blocking after one signal week, mirroring the P1.2 typecheck pattern
- **P4.2 graduation** — flip the raw-timer ESLint rule from `warn` to `error` once P4.3 drains the call sites
- **OAuth + TOTP end-user verification** — P7.C3 schema + helpers + handlers landed but the end-to-end flow has not been exercised in production
