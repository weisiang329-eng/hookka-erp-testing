# AI Development Modes

> **Last verified: 2026-08-13** against `docs/context-packs/` (all 7 files, including
> `core-flow.md`), `docs/DEV-OPERATING-FRAMEWORK.md`, and `src/api/lib/supabase-compat.ts`.
> No corrections needed — every doc path and every high-risk area this file names resolves
> to something that exists. This document is policy, not a description of code, so most of
> it is judgement rather than fact.

Purpose: choose how much context an AI assistant should load before changing Hookka ERP. The goal is to move fast for small work, while still using deeper review when risk is high.

## Default rule

Do not run a full Pass A/B/C/D review before every development task. Use the smallest mode that matches the risk.

A full pass is useful for audits, rewrites, migrations, security work, or cross-module changes. For normal module work, start with a focused context pack and proceed after a small impact check.

The concrete HIGH-RISK areas that always need deep review — schema/migrations, money/accounting/ledger, payroll, inventory cascade, status lifecycle, security/RBAC/tenancy, shared libraries, and the supabase-compat camelCase layer — are listed with their key files in `docs/DEV-OPERATING-FRAMEWORK.md`.

## Modes

| Mode | Use when | Context to load first | Expected behavior |
| --- | --- | --- | --- |
| Fast lane | Small UI copy/layout fixes, simple field display, low-risk table/filter tweaks | Relevant context pack + target file | Edit quickly after confirming no backend/DB contract change. |
| Focused change | Normal feature/bug in one module | Relevant context pack + target frontend page + target backend route + tests touching that path | Do a compact impact check, then implement. |
| Flow change | Status transitions or Sales → Production → Delivery → Invoice behavior | `docs/context-packs/core-flow.md` + involved pages/routes/migrations/tests | Trace the exact flow before editing. |
| Deep review | Security, accounting, DB schema, data migration, tenant isolation, broad refactor | Relevant context packs + architecture/onboarding docs + all affected files | Slow down; produce a full impact report before implementation. |

## Fast-lane checklist

Use fast lane only when all are true:

- No database schema change.
- No API contract change.
- No auth/RBAC/tenant logic change.
- No accounting, inventory, payroll, or status transition change.
- No customer-facing PDF/email/export data shape change.
- The affected UI/component is easy to locate.

If all are true, the assistant can edit after reading the target files and running a focused check.

## Focused-change checklist

For normal module work, the assistant should identify only:

1. The target page/component.
2. The API endpoint or route, if any.
3. The table or state touched, if any.
4. The smallest relevant tests/checks.
5. One rollback note if the change affects runtime behavior.

Do not require a full system report unless one of these items crosses module boundaries.

## When a full Pass A/B/C/D is needed

Run the deeper pass only when the task changes or investigates:

- A full business flow across multiple modules.
- Database schema, migration, or backfill.
- Security, auth, RBAC, tenancy, sessions, or public endpoints.
- Accounting postings, ledger hash chain, payment allocation, invoices, payroll, or stock valuation.
- Production planning, delivery grouping, inventory cascade, or status lifecycle rules.
- Performance problems where the source is unknown.
- A module with unclear ownership or stale documentation.

## Module maturity rule

New or small modules should be fast. Do not over-audit them by default. Read the module page/route/tests, make the change, and add missing documentation only if the module is becoming reused or business-critical.

Large or old modules need more guardrails because behavior may be coupled to reports, snapshots, PDFs, accounting, inventory, or worker flows.

## AI prompt template

```text
Use the smallest safe development mode.
Do not run a full repo review unless risk requires it.
First classify this task as Fast lane, Focused change, Flow change, or Deep review.
Then read only the files required for that mode, do a short impact check, and implement.
If you need more files, explain the reason briefly before expanding scope.
```
