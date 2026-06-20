# AI Context Improvement Backlog

Purpose: track the next improvements after the initial LLM context strategy, development modes, onboarding SOP, and context packs. The current setup is useful, but it is not perfect; this backlog lists what would make AI-assisted development faster and more reliable over time.

## Current baseline

The repository now has:

- `docs/LLM-CONTEXT-STRATEGY.md` for low-token loading rules.
- `docs/AI-DEVELOPMENT-MODES.md` for choosing Fast lane, Focused change, Flow change, or Deep review.
- `docs/ENGINEERING-ONBOARDING-SOP.md` for onboarding and change-impact checks.
- `docs/context-packs/` for broad architecture, frontend, backend, database, core flow, and security entry points.

This is enough to stop most full-repo scans. The next step is to make the context packs more specific and more machine-checkable.

## Improvement roadmap

| Priority | Improvement | Why it helps | When to do it |
| --- | --- | --- | --- |
| P1 | Module-specific context packs | Lets AI work on one module without reading broad packs every time | When a module gets repeated work |
| P1 | Route → frontend → DB table map | Lets AI jump directly from page to API to tables | Before major flow work |
| P1 | Change-impact PR template | Forces concise impact analysis without long reports | Before larger team/AI parallel work |
| P2 | Ownership map | Shows which module/domain owns each route/table/test | When module boundaries become confusing |
| P2 | Test selection matrix | Tells AI which tests to run for each module/change type | When test suite becomes slower or harder to choose |
| P2 | Common task playbooks | Gives step-by-step SOPs for frequent tasks | When a task is repeated 3+ times |
| P3 | Generated dependency inventory | Keeps file/API/table relationships current automatically | When docs drift becomes a problem |
| P3 | Architecture diagrams | Helps humans onboard faster | When non-engineers need to review flows |

## Suggested module-specific packs

Create these only when the module is actively changing. Do not create all of them upfront if they will not be used.

- `docs/context-packs/sales.md`
- `docs/context-packs/production.md`
- `docs/context-packs/delivery.md`
- `docs/context-packs/invoices-accounting.md`
- `docs/context-packs/procurement.md`
- `docs/context-packs/inventory.md`
- `docs/context-packs/payroll-worker.md`
- `docs/context-packs/service-cases.md`
- `docs/context-packs/rd.md`

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
