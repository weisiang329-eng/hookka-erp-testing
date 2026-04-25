# 90-Day Enterprise Upgrade — Execution Plan

> **Window**: 2026-04-28 → 2026-07-27 (13 weeks)
> **Last updated**: 2026-04-25
> **Cadence**: this doc updates **weekly**, not one-shot. Replaces the lighter [PROGRAM-EXECUTION.md](PROGRAM-EXECUTION.md) for the upgrade window. The blueprint it executes against is [ENTERPRISE-ERP-ARCHITECTURE.md](ENTERPRISE-ERP-ARCHITECTURE.md).
> **Status board**: live state lives in [UPGRADE-CONTROL-BOARD.md](UPGRADE-CONTROL-BOARD.md).

## Goal

Move hookka-erp-testing from "works in production, but ad-hoc" to enterprise-grade across six axes:

1. **Identity / RBAC / Audit** — unified middleware, role-permission matrix, immutable audit journal
2. **CI quality gates** — typecheck + lint + test enforced; no green build on red types
3. **Timer / scheduler governance** — single visibility-aware scheduler, no scattered raw `setInterval`
4. **Data access layer** — per-domain typed SDK, single `useQuery`, no per-page envelope unwrapping
5. **Execution closure** — owner / deadline / gate / risk on every milestone (this doc)
6. **Single source of truth board** — one place to see status (UPGRADE-CONTROL-BOARD.md)

## Operating rules

- **Owner**: `Claude` for engineering work, `User` for business decisions and gate approvals.
- **Direct push to main** for Claude-authored work (per [push workflow](https://github.com/weisiang329-eng/hookka-erp-testing) — admin bypass).
- **Gate**: every milestone has a single command that proves it. If the command does not exist or does not pass, the milestone is not done.
- **Ratchet, never regress**: introduce baselines (e.g. "192 TS errors"), CI fails on increase, decreases land freely.
- **Migrations forward-only**: every schema change ships with a numbered SQL migration; no manual DB edits.
- **One PR = one phase deliverable**: small, reviewable, revertable. No 5000-line drops.

---

## Phase 1 — CI Gate Foundation (W1, 2026-04-28 → 2026-05-04)

**Why**: today CI runs `npm test` (1 smoke file, 9 assertions) and `npm run build` only. `npm run typecheck:app` and `npm run lint:app` exist but are not enforced. The repo currently has ~190 TS errors and 92 ESLint errors that nothing prevents from growing. ([REPO-REVIEW-2026-04-24.md](REPO-REVIEW-2026-04-24.md), [KNOWN-ISSUES.md](KNOWN-ISSUES.md))

**Deliverables**

| ID | Item | Gate (verification) | Owner |
|---|---|---|---|
| 1.1 | Snapshot baselines: `npm run typecheck:app 2>&1 \| tee .ci-baseline/typecheck.txt`, ditto for lint. Commit `.ci-baseline/`. | Files present in main | Claude |
| 1.2 | Add `typecheck` job to `.github/workflows/deploy.yml` (parallel with build). Hard-fail on **error count > baseline**. | PR with new TS error fails CI | Claude |
| 1.3 | Add `lint` job. Same ratchet. | PR with new ESLint error fails CI | Claude |
| 1.4 | Husky + lint-staged pre-commit: typecheck + lint on staged `.ts`/`.tsx` only. | `git commit` on bad file fails locally | Claude |
| 1.5 | Reconcile [REPO-REVIEW](REPO-REVIEW-2026-04-24.md) #2: either restore `build = tsc -b && vite build`, or update [SETUP.md](SETUP.md) + [README.md](../README.md) to say `build:strict` is the gate. | Doc + script agree | Claude |

**Risk**: ratchet logic in CI is finicky; if baseline drift is too noisy, fall back to allowlist of "known bad files" pinned to commit hash. Mitigation: ship 1.1/1.2 with `continue-on-error: true` for first 24h, then flip.

**Phase exit gate**: PR that introduces 1 new TS error fails CI. Verified by intentional bad-PR test.

---

## Phase 2 — Type Baseline Restoration (W2–W3, 2026-05-05 → 2026-05-18)

**Why**: 190 TS errors + `strict: false` in `tsconfig.app.json` means refactors are unsafe. Per [REPO-REVIEW](REPO-REVIEW-2026-04-24.md), the top fixes are `src/api/lib/password.ts` BufferSource typing and `src/lib/fetch-json.ts` TS1294. Once we hit zero, flip `strict: true` and lock it.

**Deliverables**

| ID | Item | Gate | Owner |
|---|---|---|---|
| 2.1 | Fix `src/api/lib/password.ts` (crypto BufferSource) | `tsc -p tsconfig.app.json --noEmit` no longer reports it | Claude |
| 2.2 | Fix `src/lib/fetch-json.ts` TS1294 / `erasableSyntaxOnly` issues | Same | Claude |
| 2.3 | Module-by-module ratchet: sales → delivery → production → procurement → accounting → worker → settings. Commit per module. | Baseline file decreases each commit | Claude |
| 2.4 | Flip `tsconfig.app.json` `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true` | `npm run typecheck:app` returns 0 | Claude |
| 2.5 | Delete `.ci-baseline/typecheck.txt`; CI now requires absolute zero | CI passes with bare `tsc --noEmit` | Claude |

**Risk**: hidden runtime breakage from now-rejected coercions. Mitigation: smoke test runs against built artifact; manual sanity click of 5 critical pages (sales-order create, PO create, GRN scan, payslip render, invoice export) before flipping strict.

**Phase exit gate**: `npm run typecheck:app` exits 0; `tsconfig.app.json` `strict: true` is committed.

---

## Phase 3 — Authz / RBAC / Audit Foundation (W4–W6, 2026-05-19 → 2026-06-08)

**Why**: today there are two roles (`SUPER_ADMIN`, `STAFF`), one column (`users.role`), and ad-hoc `if (role !== "SUPER_ADMIN")` per route (e.g. [users.ts:22-30](../src/api/routes-d1/users.ts)). Worker auth is **in-memory** (`pinStore`, `tokenStore` in [worker-auth.ts:8-13](../src/api/routes/worker-auth.ts)) and dies with every Worker restart. No unified audit_log — only `job_card_events` and `scan_override_audit` for two narrow domains. Frontend has no `<RequireRole>` or `usePermission()`.

**Deliverables**

| ID | Item | Gate | Owner |
|---|---|---|---|
| 3.1 | Migration `0045_rbac.sql`: `roles`, `permissions(resource, action)`, `role_permissions(role_id, permission_id)`. Seed: `SUPER_ADMIN`, `FINANCE`, `PROCUREMENT`, `PRODUCTION`, `WAREHOUSE`, `SALES`, `WORKER`, `READ_ONLY`. | Tables exist, seed rows present | Claude |
| 3.2 | Migration `0046_audit_events.sql`: single table `audit_events(id, actor_user_id, actor_role, resource, resource_id, action, before_json, after_json, ts, source)`. Indexes on `(resource, resource_id, ts)` + `(actor_user_id, ts)`. | Migration applied | Claude |
| 3.3 | New `src/api/lib/authz.ts` middleware: `requirePermission(resource, action)`. Reads role → permissions map (cached in KV, 5min TTL aligned with session cache). | Drop-in replacement for ad-hoc `if (role !==…)` checks | Claude |
| 3.4 | New `src/api/lib/audit.ts`: `writeAudit(c, {resource, resource_id, action, before, after})`. Wrap into the 12 highest-impact mutations (SO confirm, PO create, GRN, invoice post, payment record, JC status change, user role change, worker delete, payroll post, credit/debit note, e-invoice submit, BOM template publish). | `audit_events` row appears for each | Claude |
| 3.5 | Migration `0047_worker_sessions.sql`: persist worker login. Move `pinStore` → `worker_pins` (already exists, hash-only) and `tokenStore` → `worker_sessions(token, worker_id, expires_at)`. | Worker login survives Worker cold start | Claude |
| 3.6 | Frontend: `<RequireRole role="…">`, `<RequirePermission resource="…" action="…">`, `usePermission()` hook. Wrap settings, accounting, payroll, e-invoice routes. | Non-Finance user redirected from `/accounting` | Claude |
| 3.7 | Sidebar reads from current user, not hardcoded "Lim / Director" ([memory note](https://github.com/weisiang329-eng/hookka-erp-testing/blob/main/src/components/layout/sidebar.tsx)) | Display name == logged-in user's | Claude |
| 3.8 | Reduce KV session cache TTL to 60s **OR** add explicit cache-bust on role change. | Role revocation visible within 60s | Claude |

**Risk**: refactoring 48 routes to use `requirePermission()` is the biggest single change. Mitigation: middleware applies in **shadow mode** first (logs would-have-blocked but lets through), 7 days of telemetry, then flip to enforce.

**Phase exit gate**: (a) every sensitive mutation writes to `audit_events`; (b) `requirePermission` enforces on all 48 routes; (c) worker session survives Worker restart; (d) `<RequireRole>` blocks frontend access by role.

---

## Phase 4 — Scheduler Policy (W7, 2026-06-09 → 2026-06-15)

**Why**: 30+ raw `setInterval`/`setTimeout` calls scattered across `src/components/ui/toast.tsx`, `src/layouts/DashboardLayout.tsx`, `src/lib/kv-config.ts`, etc. Two well-built hooks ([use-presence](../src/lib/use-presence.ts), [use-version-check](../src/lib/use-version-check.ts)) already do visibility-pause correctly — those are the template. Multiple `useVersionCheck` instances mount per page (re-mount on route change) — should be a single root-layout instance via context.

**Deliverables**

| ID | Item | Gate | Owner |
|---|---|---|---|
| 4.1 | New `src/lib/scheduler.ts` exporting `useInterval(fn, ms, {pauseOnHidden, pauseOnUnmount, debounceFocusBy})`. Behaviour mirrors `use-presence`. | Tests cover hidden-pause + unmount-clear | Claude |
| 4.2 | ESLint rule (`no-restricted-syntax`) blocking raw `setInterval`/`setTimeout` in `src/` outside `src/lib/scheduler.ts` and `src/lib/use-presence.ts`. Allow in `tests/`, `scripts/`, `*.test.*`. | New `setInterval` in a page fails lint | Claude |
| 4.3 | Migrate 30+ existing call sites to `useInterval`. Audit each toast/dialog timer for actual desired hidden-tab behaviour. | Count of raw timers in `src/` (excluding allowlist) == 0 | Claude |
| 4.4 | Lift `useVersionCheck` into `<RootLayout>` via context provider; remove per-page instances. | DevTools shows 1 instance, not N | Claude |

**Risk**: some animations legitimately need to keep running when hidden (e.g. server-pushed toast that should still fade). Mitigation: `useInterval` accepts `{pauseOnHidden: false}` for opt-out — explicit choice, not default.

**Phase exit gate**: ESLint passes with the new rule active; no raw timers in `src/`.

---

## Phase 5 — API SDK + Unified Query Layer (W8–W10, 2026-06-16 → 2026-07-06)

**Why**: today every page repeats `?.success ? .data : Array.isArray(x) ? x : []` and `asArray<T>(body)` patterns ([safe-json.ts:16-44](../src/lib/safe-json.ts)). Three competing fetch primitives (`useCachedJson`, `useApi` SWR, raw `fetchJson`). No single place to add caching/retry/auth-injection consistently.

**Deliverables**

| ID | Item | Gate | Owner |
|---|---|---|---|
| 5.1 | New `src/sdk/` per domain: `sales`, `procurement`, `production`, `accounting`, `worker`, `inventory`, `delivery`. Each exports typed methods backed by `fetchJson` + Zod. Envelope unwrap centralized here. | First domain (sales) has SDK; sales pages migrated | Claude |
| 5.2 | New `src/lib/use-query.ts` — single SWR-based hook. Replaces both `useApi` and `useCachedJson`. Cache key = SDK method signature. | One hook, both uses | Claude |
| 5.3 | Migrate sales (W8), delivery + production (W9), procurement + accounting + worker (W10). One PR per domain. | Per-domain page no longer imports `safe-json.ts` | Claude |
| 5.4 | Delete `src/lib/safe-json.ts` `asArray`/`asObject` once last consumer migrates. | File removed; CI green | Claude |
| 5.5 | ESLint rule blocking direct `fetch(` and `res.json()` in `src/pages/**`. SDK only. | New raw fetch in a page fails lint | Claude |

**Risk**: domain typing drift between SDK and D1 routes. Mitigation: Zod schemas are the single source; D1 routes import the same schemas for response validation.

**Phase exit gate**: `safe-json.ts` deleted; raw `fetch(` count in `src/pages/**` == 0; all 60+ pages route through `src/sdk/*`.

---

## Phase 6 — Observability + KPI Dashboard (W11, 2026-07-07 → 2026-07-13)

**Why**: [ENTERPRISE-ERP-ARCHITECTURE](ENTERPRISE-ERP-ARCHITECTURE.md) §7 lists weekly KPIs (p75/p95 route, p95 API latency, JS long tasks, cache hit ratio). Today `Server-Timing` headers exist but nothing aggregates. No browser-side tracing.

**Deliverables**

| ID | Item | Gate | Owner |
|---|---|---|---|
| 6.1 | Browser → API → D1 trace propagation (`traceparent` header). Sampling: 1% prod, 100% staging. | Single trace visible end-to-end | Claude |
| 6.2 | Cloudflare Analytics Engine writes `(route, p50, p75, p95, n)` per minute. | Dashboard query returns rows | Claude |
| 6.3 | Worker reports `audit_events` count, login count, 4xx/5xx count to Analytics Engine. | Dashboard shows trend | Claude |
| 6.4 | New page `/admin/health` (SUPER_ADMIN only) renders the 5 KPIs from §7. | Page loads with live data | Claude |

**Risk**: Cloudflare Analytics Engine is the lock-in path; if blocked, swap for Sentry browser SDK. Decision gate at start of W11.

**Phase exit gate**: `/admin/health` shows the 5 KPIs with non-mock data for ≥7 days.

---

## Phase 7 — Hardening + Buffer (W12–W13, 2026-07-14 → 2026-07-27)

**Why**: 13-week plan needs slack. Use it for: multi-tenant scoping (org/site filtering on every query), perf budget enforcement, DR drill, and remaining lint debt cleanup.

**Deliverables**

| ID | Item | Gate | Owner |
|---|---|---|---|
| 7.1 | Add `org_id` / `site_id` filtering to all read queries via DB view or row-level scoping helper. | Cross-org data leak test fails to leak | Claude |
| 7.2 | Bundle size budget in CI: reject PR that grows top-5 chunks > 5%. | PR with bloat fails CI | Claude |
| 7.3 | DR drill: restore D1 from backup to staging, verify row counts match. Document runbook. | `docs/DR-RUNBOOK.md` exists | Claude + User |
| 7.4 | Drain remaining ESLint debt — target: 0 errors, 0 warnings (currently 92 + 15). | `npm run lint:app` returns 0 | Claude |
| 7.5 | Final readout: KPI snapshot, before/after table, lessons learned. | Doc landed | Claude + User |

**Phase exit gate**: all 6 axes green on the [Control Board](UPGRADE-CONTROL-BOARD.md). Project closes.

---

## Weekly cadence

Every **Monday**:
1. Update [UPGRADE-CONTROL-BOARD.md](UPGRADE-CONTROL-BOARD.md) — move done items to Done, surface blockers.
2. Update this doc's **Last updated** stamp.
3. If a phase slips by more than 3 days, surface in the control board's `Blocked` lane and revise the plan.

If 3 weeks pass with no update, the plan is dead — restart from current state, don't pretend.

## What this plan does NOT cover

- Mobile app — separate track if/when scoped.
- E-invoice country expansion (MY → ID/PH/etc.) — separate spec.
- Migration off D1 to Postgres / Hyperdrive — covered by [d1-retirement-plan.md](d1-retirement-plan.md), parallel track.
- ML-driven forecasting beyond current `mrp` heuristics — out of scope for this window.
