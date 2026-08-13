# Documentation Index

> **Last verified: 2026-08-13** — every link below was checked; entries for docs that were
> archived or corrected in the 2026-08-13 doc-vs-code reconciliation are updated.
> Corrected 2026-08-13: `PROGRAM-90D-EXECUTION` and `UPGRADE-CONTROL-BOARD` were labelled
> "**active**, updates weekly" while untouched since 2026-04-25/26; `B-FLOW.md` described
> `/api/test/*` endpoints that do not exist; the "16 monster files" count contradicted
> CODEBASE-MAP's own "~30".
>
> **How to read any doc in here:** check the `Last verified:` line under its title.
> No line, or an old date, means UNVERIFIED — check the code first.

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
- `docs/CODEBASE-MAP.md` — **find code fast (no searching)**: every module → pages / API routes / tables / tests + a line-range section index for the big files. Look here BEFORE grepping.
- `docs/PLAYBOOKS.md` — **fixed steps for recurring tasks** (add a field, fix a camelCase read bug, ship+verify, money field, fix-then-sweep, new grid/PDF, touching a monster file). Follow the playbook instead of re-deriving.
- `docs/DEV-OPERATING-FRAMEWORK.md` — **the operating manual (read first)**: when to review-all vs not (快·准·省 + risk tiers), the high-risk areas that always need deep review, and the durable task-tracking cadence.
- `docs/BUG-CLASSES.md` — **the recurring bug CLASSES and every known instance**. `BUG-HISTORY` is by date, so "the same class" lived only in memory — and three classes were each "fixed" three times, repairing one instance at a time. Read this before fixing any bug; fix every open row in the class, not just yours.
- `docs/context-packs/HOOKKA-GOTCHAS.md` — hard-won Hookka-specific traps (migration self-apply, snake_case rename-map, build:strict). Read before any schema/money/SQL/ship work — these are the real time-savers.
- `docs/WORK-TRACKER.md` — living list of assigned / in-progress / shipped work so nothing is forgotten across a long session.
- `docs/LLM-CONTEXT-STRATEGY.md` — token-saving workflow for Claude/Codex sessions; start here before asking an assistant to inspect the repo.
- `docs/context-packs/` — small task-specific file maps so AI sessions can load only the relevant frontend, backend, DB, or security slice.
- `docs/ENGINEERING-ONBOARDING-SOP.md` — onboarding and change-impact workflow for engineers and AI assistants.
- `docs/AI-DEVELOPMENT-MODES.md` — decision guide for choosing fast-lane vs focused vs deep AI-assisted development.
- `docs/AI-CONTEXT-IMPROVEMENT-BACKLOG.md` — prioritized next steps for improving AI context quality without over-documenting.

## Program / Execution
- `docs/GITHUB-WORKFLOW-GOVERNANCE.md` — GitHub PR/workflow organization, staging/canary rules, and bug-prevention guidance.
- `docs/archive/PROGRAM-90D-EXECUTION.md` — **(archived)**. 90-day enterprise upgrade plan. Labelled "active, updates weekly" but not touched since 2026-04-25; the 90 days elapsed in July.
- `docs/archive/UPGRADE-CONTROL-BOARD.md` — **(archived)**. Status board for that programme. Last state change 2026-04-26.
- `docs/ENTERPRISE-ERP-ARCHITECTURE.md` — target enterprise architecture blueprint (SAP/Oracle reference shape).
- `docs/archive/PROGRAM-EXECUTION.md` — (archived) legacy 6-task status snapshot. Superseded by PROGRAM-90D-EXECUTION.md.
- `docs/archive/REPO-REVIEW-2026-04-24.md` — (archived) repository health review and stabilization notes.

## Compliance / Standards
- `docs/ISO-9001-GAP-ANALYSIS.md` — **assessment (2026-07-18)**. Code-grounded ISO 9001:2015 gap analysis (traceability, QC release, NCR, CAPA, document control, suppliers, internal audit, management review, etc.) + a suggested build order. No code changed.
- `docs/MFRS-GAP-ANALYSIS.md` — **assessment (2026-07-18)**. Code-grounded MFRS gap analysis of the accounting module (double-entry GL, revenue MFRS 15, inventory MFRS 102, statements MFRS 101, receivables MFRS 9, tax, payroll MFRS 119, PPE MFRS 116, provisions MFRS 137, FX MFRS 121) + a suggested build order. No accounting code/data changed. **Owner: the accountant does MFRS, not Claude.**
- `docs/ISO-9001-BUILD-PLAN.md` — **active (2026-07-18)**. The 4-phase build plan for the ISO 9001 QMS spine Claude is building: NCR (8.7) → CAPA (10.2) → document control + internal audit (7.5/9.2) → management review (9.3); QC release gate (8.6) deferred. Mockup→approve→staging→prod per module.
- `docs/ERP-FEATURE-GAP.md` — **assessment (2026-08-13)**. What this ERP has vs a mature manufacturing ERP, cited `file:line`: what exists and how deep, **what is scaffolding masquerading as a feature** (the section to read first — a shell that looks present gets trusted), and the ranked gaps with business rationale. Covers manufacturing / supply chain / sales-CRM / cross-cutting ops; defers accounting conformance to MFRS-GAP-ANALYSIS and quality to ISO-9001-GAP-ANALYSIS. No code changed.

## Product / Domain
- `docs/modules/*.md` — **the 15 per-module deep guides. Open the one for your module FIRST.**
- `docs/archive/MODULES.md` — **(archived 2026-08-13)**. The old module reference; it documented a `/portal` module and `PortalLayout` that were never built, and declared auth unwired. Use `docs/modules/*.md` + `docs/CODEBASE-MAP.md`.
- `docs/API.md` — **GENERATED** endpoint reference: the full mount table, every registered path, and the exact public/auth surface. Rebuild with `node scripts/gen-api-docs.mjs`; never hand-edit.
- `docs/DESIGN-SYSTEM.md` — UI tokens and shared component conventions.
- `docs/UI-DATA-DOCUMENT-STANDARDS.md` — standards for DataGrid columns, filters, sorting, numeric inputs, and business document layouts.

## Cloudflare / Deployment / Migration
- `docs/archive/CLOUDFLARE_MIGRATION.md` — Cloudflare migration details.
- `docs/archive/d1-retirement-plan.md` — D1 retirement/migration runbook.

## Known Issues / Temporary Debt
- `docs/KNOWN-ISSUES.md` — known lint/typecheck/runtime debt and rationale (counts re-measured 2026-08-13: 20 errors / 97 warnings).

## Deleted 2026-08-13 (do not go looking for them)
- `docs/SYMBOLS.md` — hand-maintained endpoint index; 75% of its 891 line offsets were wrong and 94 pointed past end-of-file. Superseded by the **generated** `docs/API.md`, which carries the same index with correct offsets.
- `docs/B-FLOW.md` and `B-ROLLBACK.md` — described a "B version" sticker flow at `/api/test/*`, `/production-b`, `/delivery-b` and `src/api/index.ts`. None of those files exist in the tree **or anywhere in git history**; the doc mapped to nothing.
- `docs/code-map.md` — a pointer stub duplicating `docs/CODEBASE-MAP.md`.
