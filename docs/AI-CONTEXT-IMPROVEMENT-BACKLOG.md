# AI Context Improvement Backlog

> **Last verified: 2026-08-13** against `docs/context-packs/`, `docs/modules/`,
> `docs/CODEBASE-MAP.md`, `docs/PLAYBOOKS.md`, `.github/PULL_REQUEST_TEMPLATE.md`.
> Corrected 2026-08-13: **four of this backlog's items already shipped** and the file
> did not know it — see the status column added to the roadmap table, and the note on
> the "suggested module-specific packs" list, which was built at a different path.

Purpose: track the next improvements after the initial LLM context strategy, development modes, onboarding SOP, and context packs. The current setup is useful, but it is not perfect; this backlog lists what would make AI-assisted development faster and more reliable over time.

## Current baseline

The repository now has:

- `docs/LLM-CONTEXT-STRATEGY.md` for low-token loading rules.
- `docs/AI-DEVELOPMENT-MODES.md` for choosing Fast lane, Focused change, Flow change, or Deep review.
- `docs/ENGINEERING-ONBOARDING-SOP.md` for onboarding and change-impact checks.
- `docs/context-packs/` for broad architecture, frontend, backend, database, core flow, and security entry points.

This is enough to stop most full-repo scans. The next step is to make the context packs more specific and more machine-checkable.

## Improvement roadmap

| Priority | Improvement | Why it helps | Status (checked 2026-08-13) |
| --- | --- | --- | --- |
| P1 | Module-specific context packs | Lets AI work on one module without reading broad packs every time | ✅ **DONE** — shipped as `docs/modules/*.md` (15 guides), not under `context-packs/` |
| P1 | Route → frontend → DB table map | Lets AI jump directly from page to API to tables | ✅ **DONE** — `docs/CODEBASE-MAP.md` (15 modules → pages/routes/tables/tests) |
| P1 | Change-impact PR template | Forces concise impact analysis without long reports | ✅ **DONE** — `.github/PULL_REQUEST_TEMPLATE.md` exists |
| P2 | Ownership map | Shows which module/domain owns each route/table/test | ⚪ open (partly covered by CODEBASE-MAP) |
| P2 | Test selection matrix | Tells AI which tests to run for each module/change type | ⚪ open — 375 test files now, so this matters more than when written |
| P2 | Common task playbooks | Gives step-by-step SOPs for frequent tasks | ✅ **DONE** — `docs/PLAYBOOKS.md`, 8 procedures (P1–P8) |
| P3 | Generated dependency inventory | Keeps file/API/table relationships current automatically | 🟡 **half done 2026-08-13** — the API half is generated: `scripts/gen-api-docs.mjs` derives `docs/API.md` (139 mounts, 935 handlers, correct `:line` offsets, the real public/auth surface) from `src/api/worker.ts` + `src/api/routes/*.ts`, with a `--check` mode. It replaced the hand-maintained `docs/SYMBOLS.md`, which had drifted to ~25% line-number accuracy (94 of 891 offsets pointed past end-of-file). The table/BOM-relationship half is still open. |
| P3 | Architecture diagrams | Helps humans onboard faster | ⚪ open |

## Suggested module-specific packs — ✅ BUILT, at a different path

**Corrected 2026-08-13.** These were built, but under `docs/modules/`, not
`docs/context-packs/`. **None of the nine `docs/context-packs/<module>.md` paths listed
below exists** — `docs/context-packs/` holds only the 6 broad packs (architecture,
frontend, backend, database, core-flow, security) plus `HOOKKA-GOTCHAS.md`.

The 15 guides that actually exist, in `docs/modules/`: `accounting.md`, `customers.md`,
`dashboard.md`, `delivery.md`, `employees.md`, `inventory.md`, `planning.md`,
`procurement.md`, `production.md`, `products.md`, `quality-warehouse.md`, `reports.md`,
`rnd.md`, `sales.md`, `service-repair.md`.

Original (superseded) proposal, kept for history:

- ~~`docs/context-packs/sales.md`~~ → `docs/modules/sales.md`
- ~~`docs/context-packs/production.md`~~ → `docs/modules/production.md`
- ~~`docs/context-packs/delivery.md`~~ → `docs/modules/delivery.md`
- ~~`docs/context-packs/invoices-accounting.md`~~ → `docs/modules/accounting.md`
- ~~`docs/context-packs/procurement.md`~~ → `docs/modules/procurement.md`
- ~~`docs/context-packs/inventory.md`~~ → `docs/modules/inventory.md`
- ~~`docs/context-packs/payroll-worker.md`~~ → `docs/modules/employees.md`
- ~~`docs/context-packs/service-cases.md`~~ → `docs/modules/service-repair.md`
- ~~`docs/context-packs/rd.md`~~ → `docs/modules/rnd.md`

Each module pack should include:

1. Main frontend pages.
2. Backend routes.
3. Primary DB tables.
4. Key status transitions.
5. Tests to run.
6. Known risks or coupling.

## Suggested route-table map shape

A route-table map can be maintained manually at first, then generated later.

```md
| Module | Frontend | API route | Tables | Tests |
| --- | --- | --- | --- | --- |
| Sales | `src/pages/sales/` | `src/api/routes/sales-orders.ts` | `sales_orders`, `sales_order_items` | `tests/*sales*` |
```

## When not to improve docs

Do not add documentation just for completeness. Add docs when they reduce repeated context loading, prevent mistakes, or speed up a real recurring task.

A small or new module should stay lightweight until it becomes reused, business-critical, or risky.
