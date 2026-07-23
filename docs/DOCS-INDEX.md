# Documentation Index

This file organizes key documentation so implementation and operations are easy to navigate.

## Start Here
- `docs/CODEBASE-MAP.md` — **THE code map**: find any module by file:line. Read before touching code; never `grep`/`glob` the whole repo (it times out).
- `docs/HOME.md` — Obsidian home note: open `docs/` as a vault and navigate the graph via `[[wikilinks]]`.
- `README.md` — project overview, local run commands, module map.
- `docs/SETUP.md` — development environment setup and troubleshooting.
- `docs/ARCHITECTURE.md` — current system architecture and extension points.
- `docs/archive/` — retired one-off docs (audits, handoffs, dated readouts); kept for history, out of the hot path.


## AI / LLM Context Management
- `docs/DEV-EFFICIENCY-SYSTEM.md` — **the big plan**: the 6-layer ERP Center-of-Excellence (Governance/Knowledge/Reliability/Navigation/Methodology/Data-model), what we have vs need, and the build roadmap.
- `docs/CODEBASE-MAP.md` — **find code fast (no searching)**: every module → pages / API routes / tables / tests + a line-range section index for the 16 monster files. Look here BEFORE grepping.
- `docs/PLAYBOOKS.md` — **fixed steps for recurring tasks** (add a field, fix a camelCase read bug, ship+verify, money field, fix-then-sweep, new grid/PDF, touching a monster file). Follow the playbook instead of re-deriving.
- `docs/DEV-OPERATING-FRAMEWORK.md` — **the operating manual (read first)**: when to review-all vs not (快·准·省 + risk tiers), the high-risk areas that always need deep review, and the durable task-tracking cadence.
- `docs/context-packs/HOOKKA-GOTCHAS.md` — hard-won Hookka-specific traps (migration self-apply, snake_case rename-map, build:strict). Read before any schema/money/SQL/ship work — these are the real time-savers.
- `docs/WORK-TRACKER.md` — living list of assigned / in-progress / shipped work so nothing is forgotten across a long session.
- `docs/LLM-CONTEXT-STRATEGY.md` — token-saving workflow for Claude/Codex sessions; start here before asking an assistant to inspect the repo.
- `docs/context-packs/` — small task-specific file maps so AI sessions can load only the relevant frontend, backend, DB, or security slice.
- `docs/ENGINEERING-ONBOARDING-SOP.md` — onboarding and change-impact workflow for engineers and AI assistants.
- `docs/AI-DEVELOPMENT-MODES.md` — decision guide for choosing fast-lane vs focused vs deep AI-assisted development.
- `docs/AI-CONTEXT-IMPROVEMENT-BACKLOG.md` — prioritized next steps for improving AI context quality without over-documenting.

## Program / Execution
- `docs/GITHUB-WORKFLOW-GOVERNANCE.md` — GitHub PR/workflow organization, staging/canary rules, and bug-prevention guidance.
- `docs/PROGRAM-90D-EXECUTION.md` — **active**. 90-day enterprise upgrade plan (CI gates → RBAC/audit → scheduler → SDK → observability). Updates weekly.
- `docs/UPGRADE-CONTROL-BOARD.md` — **active**. Single source of truth for status (Backlog / In Progress / Blocked / Done). Update on every state change.
- `docs/ENTERPRISE-ERP-ARCHITECTURE.md` — target enterprise architecture blueprint (SAP/Oracle reference shape).
- `docs/archive/PROGRAM-EXECUTION.md` — (archived) legacy 6-task status snapshot. Superseded by PROGRAM-90D-EXECUTION.md.
- `docs/archive/REPO-REVIEW-2026-04-24.md` — (archived) repository health review and stabilization notes.

## Compliance / Standards
- `docs/ISO-9001-GAP-ANALYSIS.md` — **assessment (2026-07-18)**. Code-grounded ISO 9001:2015 gap analysis (traceability, QC release, NCR, CAPA, document control, suppliers, internal audit, management review, etc.) + a suggested build order. No code changed.
- `docs/MFRS-GAP-ANALYSIS.md` — **assessment (2026-07-18)**. Code-grounded MFRS gap analysis of the accounting module (double-entry GL, revenue MFRS 15, inventory MFRS 102, statements MFRS 101, receivables MFRS 9, tax, payroll MFRS 119, PPE MFRS 116, provisions MFRS 137, FX MFRS 121) + a suggested build order. No accounting code/data changed. **Owner: the accountant does MFRS, not Claude.**
- `docs/ISO-9001-BUILD-PLAN.md` — **active (2026-07-18)**. The 4-phase build plan for the ISO 9001 QMS spine Claude is building: NCR (8.7) → CAPA (10.2) → document control + internal audit (7.5/9.2) → management review (9.3); QC release gate (8.6) deferred. Mockup→approve→staging→prod per module.

## Product / Domain
- `docs/MODULES.md` — module-by-module product reference.
- `docs/API.md` — API endpoint inventory and conventions.
- `docs/DESIGN-SYSTEM.md` — UI tokens and shared component conventions.
- `docs/UI-DATA-DOCUMENT-STANDARDS.md` — standards for DataGrid columns, filters, sorting, numeric inputs, and business document layouts.
- `docs/B-FLOW.md` — production/delivery test flow (B-flow).

## Cloudflare / Deployment / Migration
- `docs/CLOUDFLARE_MIGRATION.md` — Cloudflare migration details.
- `docs/d1-retirement-plan.md` — D1 retirement/migration runbook.

## Known Issues / Temporary Debt
- `docs/KNOWN-ISSUES.md` — known lint/typecheck/runtime debt and rationale.
- `B-ROLLBACK.md` — rollback notes.
