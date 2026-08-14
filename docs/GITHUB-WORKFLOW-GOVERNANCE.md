# GitHub Workflow Governance

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `.github/` (contains exactly
> `PULL_REQUEST_TEMPLATE.md` + `workflows/`) and all 24 files in `.github/workflows/`.
> No corrections needed. `PULL_REQUEST_TEMPLATE.md`, `deploy.yml` and `sync-staging.yml`
> all exist as named, there is no `ISSUE_TEMPLATE/` (correct — this doc says it is optional
> and not needed), and `docs/BUG-HISTORY.md` is still the live bug log.
>
> For completeness, the **26** workflows present on 2026-08-14 are: agent-heartbeat,
> analyze-staging, auto-clockout, backup, daily-reports, delivery-agent,
> deploy-cron-worker, deploy, distill-ocr-rules, **docs-freshness**, ios-build,
> keep-warm, mail-sync, nightly-counter-rebuild, nightly-pi-gl-backfill,
> process-email-outbox, push-clock-reminder, qc-cron, rebuild-dashboard-snapshot,
> refresh-bundle-baseline, replay-audit-dlq, scan-queue-sweep, **secret-hygiene**,
> sync-staging, trim-staging, warm-lists. *(The list said 24 and omitted exactly the
> two gates this repo relies on for doc freshness and secret hygiene.)*
> Note `ios-build.yml` (Capacitor iOS, `workflow_dispatch` only, unsigned archive) predates
> this doc's "canary deploys on pull requests" framing and is not covered by it.

Purpose: keep GitHub-side project files organized as Hookka ERP moves toward a larger ERP operating model. This document explains what belongs in `.github/`, how to choose direct production vs canary vs staging, and how to reduce bugs from process drift.

## Current baseline

The repository already has GitHub Actions for production deploy, canary deploys on pull requests, staging sync, backups, scheduled reports, mail/outbox processing, audit replay, dashboard snapshot rebuilds, QC cron, bundle baseline refresh, and other operational jobs. The repo also already has a living bug report/history system in `docs/BUG-HISTORY.md`; do not duplicate that with a GitHub issue template unless the team later wants external/operator issue intake.

The next improvement is not to move files around for neatness. The next improvement is to make PRs and workflows easier to review by adding standard templates and keeping each workflow's purpose clear.

## Recommended `.github/` structure

| Path | Purpose |
| --- | --- |
| `.github/PULL_REQUEST_TEMPLATE.md` | Standard PR checklist for development mode, impact check, staging/rollout, and tests. |
| `docs/BUG-HISTORY.md` | Existing living bug report/history log. Use this as the source of truth for identified, in-progress, and fixed bugs. |
| `.github/ISSUE_TEMPLATE/*.md` | Optional later only if GitHub Issues becomes the main intake channel; not needed while `docs/BUG-HISTORY.md` is the working system. |
| `.github/workflows/deploy.yml` | CI/build/deploy/canary pipeline. |
| `.github/workflows/sync-staging.yml` | Controlled prod-to-staging refresh. |
| `.github/workflows/*.yml` | One workflow per scheduled/ops job, with header comments explaining purpose, secrets, timing, and safety. |

## Direct production / canary / staging rule

Use the lowest safe rollout environment. Direct production is acceptable when the impact is small and reversible; staging is a tool for risk, not a ceremony for every change:

| Change type | Rollout path |
| --- | --- |
| Docs-only | Direct PR/production path, no staging needed. |
| Small reversible UI/copy/display fix | Direct production is acceptable after targeted check; use PR canary/screenshot when visual confidence is needed. |
| Single-module logic change | Direct production can be acceptable if reversible and well-tested; use PR canary or staging when the module has uncertain coupling. |
| DB migration/backfill | Prefer staging branch/database first, backup verified, rollback/backfill notes required. Emergency/prod-only fixes need explicit rollback notes. |
| Accounting/payroll/inventory/security | Prefer staging first. Direct production is only acceptable for small, well-understood, reversible fixes with targeted tests and rollback notes. |
| Cron/workflow/ops change | Manual workflow_dispatch test where possible before schedule reliance; direct production is acceptable for safe schedule/comment/config fixes. |

## Bug prevention rules

1. Do not rename or reorganize workflows unless there is an operational reason.
2. Keep scheduled workflows separate by business responsibility; this makes failures easier to triage.
3. Every workflow must document required secrets and the target environment in comments.
4. Every risky PR must state whether it uses Fast lane, Focused change, Flow change, or Deep review.
5. Prefer staging for changes that can corrupt data, change money, change inventory, change payroll, or alter auth/RBAC; direct production is allowed only when the change is small, reversible, and has explicit rollback notes.
6. Use canary for visible UI changes and normal single-module behavior changes when extra confidence is useful; do not block urgent low-risk fixes just to satisfy process.
7. Keep docs close to source-of-truth code, but avoid over-documenting modules that are still small and changing quickly.

## Future GitHub improvements

Do these only when they start saving repeated work:

- Add GitHub issue templates only if the team wants GitHub Issues to replace or supplement `docs/BUG-HISTORY.md` for intake.
- Add CODEOWNERS when module ownership becomes real.
- Add labels for `module:sales`, `module:delivery`, `risk:db`, `risk:accounting`, `mode:fast-lane`, `mode:deep-review`.
- Add a workflow README if scheduled jobs become hard to understand from file names alone.
- Promote currently non-blocking checks only after known debt is cleared.
