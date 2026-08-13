# Engineering Onboarding and Change Impact SOP

> **Last verified: 2026-08-13** against `README.md`, `docs/` file listing,
> `docs/context-packs/`, `src/router.tsx`, `src/api/worker.ts`.
> Corrected 2026-08-13: the onboarding table pointed at `docs/archive/MODULES.md`, which is now
> archived as superseded and wrong.
>
> **Scope caveat, from `docs/DEV-OPERATING-FRAMEWORK.md`:** this SOP and the PR template
> "describe a human-team flow we don't use (solo + AI, direct-to-main) — keep for
> reference, don't enforce." Treat the checklists here as a thinking aid, not a gate.

Purpose: explain how a new engineer or AI assistant should understand Hookka ERP without reading the whole repository, and how to evaluate impact before changing production code.

## Why we do not read the whole codebase first

Large systems are not onboarded by reading every file line-by-line. Engineers start with a curated map, then follow the specific business flow they need to change. Full-code reading is reserved for audits, migrations, incident reviews, or ownership transfers.

For Hookka ERP, start with:

1. `docs/DOCS-INDEX.md` for the documentation map.
2. `docs/LLM-CONTEXT-STRATEGY.md` for AI context-loading rules.
3. One file from `docs/context-packs/` matching the task.
4. The exact frontend page, backend route, database migration, and tests for the module being changed.

## Standard onboarding layers

| Layer | Goal | Typical files |
| --- | --- | --- |
| Product overview | Understand what the system does | `README.md`, `docs/CODEBASE-MAP.md`, `docs/modules/*.md` (**corrected 2026-08-13** — was `docs/archive/MODULES.md`, now archived/superseded) |
| Architecture | Understand frontend/backend/DB shape | `docs/ARCHITECTURE.md`, `src/router.tsx`, `src/api/worker.ts` |
| Domain flow | Understand business process | `docs/context-packs/core-flow.md`, module docs, target pages/routes |
| Technical conventions | Understand how to code safely | `docs/DESIGN-SYSTEM.md`, `docs/API.md`, route README, tests |
| Operations | Understand deploy, rollback, incidents | `docs/PRE-DEPLOY-CHECKLIST.md`, `docs/DR-RUNBOOK.md`, `docs/OBSERVABILITY.md` |

## Change workflow

Before editing code, answer these questions:

1. What user action or business process is changing?
2. Which frontend route/page starts the action?
3. Which API endpoint receives the request?
4. Which backend route validates and writes data?
5. Which DB tables and columns are read or written?
6. Which status transition, accounting entry, inventory movement, or audit event changes?
7. Which tests already cover this path, and which tests need to be added or updated?
8. What rollback path exists if the change is wrong?

## Impact analysis checklist

Use this checklist for every non-trivial change.

### Frontend impact

- Route or page affected.
- Components reused elsewhere.
- API calls added, removed, or changed.
- Form validation or required fields changed.
- Loading, error, empty, and permission states checked.

### Backend impact

- Endpoint contract changed.
- Auth, RBAC, tenancy, and CSRF assumptions checked.
- Input validation and error envelope checked.
- Transactions, idempotency, and audit events checked.
- Backward compatibility for existing frontend callers checked.

### Database impact

- Tables and columns read/written identified.
- Migration needed or not needed.
- Existing data backfill needed or not needed.
- Index or constraint impact checked.
- `org_id`/tenant isolation checked for transactional tables.

### Business impact

- Sales, production, delivery, invoice, accounting, payroll, or inventory status effects identified.
- Downstream reports and snapshots checked.
- PDF/export/email/customer-facing documents checked if data shape changes.
- Manual operation SOP affected or not affected.

### Verification impact

- Unit/structural tests selected.
- Typecheck/build/lint selected when relevant.
- Manual browser or API check selected when a user-facing flow changes.
- Screenshot captured when a perceptible web UI change is made.

## AI assistant rule

An AI assistant should not claim it understands the whole system from a context pack alone. A context pack gives the correct starting map. Precision still comes from following references to the exact code paths, migrations, and tests for the requested change.
