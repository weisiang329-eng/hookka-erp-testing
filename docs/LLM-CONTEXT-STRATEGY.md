# LLM Context Strategy

Purpose: reduce token usage when asking Claude/Codex/other assistants to work on Hookka ERP. Do not load the full repository by default. Start every new assistant session with one small context pack, then add only the module files needed for the task.

## Recommended session bootstrap

Use this prompt at the beginning of a new assistant conversation:

```text
You are working on Hookka ERP. Do not scan the whole repository unless I explicitly ask.
First read docs/DEV-OPERATING-FRAMEWORK.md, docs/LLM-CONTEXT-STRATEGY.md and docs/AI-DEVELOPMENT-MODES.md.
Classify the task as Fast lane, Focused change, Flow change, or Deep review.
Then read the one context pack I name and propose the smallest file set needed before editing.
```

Then choose one of these packs:

| Task type | Read first |
| --- | --- |
| Understand system architecture | `docs/context-packs/architecture.md` |
| Frontend page work | `docs/context-packs/frontend.md` |
| Backend API work | `docs/context-packs/backend.md` |
| Database/schema/migration work | `docs/context-packs/database.md` |
| Sales → Production → Delivery → Invoice flow | `docs/context-packs/core-flow.md` |
| Auth/RBAC/security work | `docs/context-packs/security.md` |

## Development mode selection

Before loading many files, classify the task using `docs/AI-DEVELOPMENT-MODES.md`. Most implementation work should be Fast lane or Focused change, not a full repo review. Use Flow change or Deep review only when risk crosses module, DB, security, accounting, inventory, payroll, or lifecycle boundaries.

## Context loading rules

1. Read `README.md`, `docs/DOCS-INDEX.md`, and `docs/ARCHITECTURE.md` only when the task is broad or architectural.
2. For a feature request, read the matching context pack first, then only the page, route, lib, migration, and test files named by that pack.
3. Prefer targeted search commands over opening large files end-to-end:
   - `rg -n "<api path>|<table>|<component>|<status>" src docs tests migrations-postgres`
   - `rg --files src/pages/<module> src/api/routes tests | sort`
4. Do not ask the model to "read everything" unless the deliverable is an audit report. For implementation, ask it to read the smallest module slice.
5. When the model discovers another required file, it should explain why that file is needed before loading many more files.
6. Keep durable summaries in `docs/context-packs/` instead of re-sending long chat history.

## Accuracy guardrails

Context packs reduce unnecessary token usage, but they do not replace source-of-truth code. Use them as entry points, then verify the exact files touched by the change.

A task is considered precise only after the assistant has identified:

- The frontend page or component that starts the behavior.
- The backend route and handler that serve it.
- The database table, migration, or adapter behavior involved.
- The tests or checks that cover the changed path.
- Any downstream status, accounting, inventory, PDF/export, email, or reporting impact.

If any of those are unknown, the assistant must say what is unknown and load the smallest additional file set needed to verify it.

## Token usage expectations

This structure lowers token usage for normal feature work because the assistant starts from a small map instead of reading the whole repository. It does not make every task cheap: broad audits, migrations, and cross-module refactors still require more files. The benefit is controlled expansion: load the context pack first, then expand only along the actual dependency path.

## Suggested repository documentation shape

- `docs/DOCS-INDEX.md`: human-facing documentation index.
- `docs/LLM-CONTEXT-STRATEGY.md`: token-saving workflow for AI sessions.
- `docs/context-packs/*.md`: small AI entry files grouped by task type.
- Larger existing docs such as `docs/ARCHITECTURE.md`, `docs/MODULES.md`, and `docs/API.md`: reference material loaded only when needed.

## How to maintain context packs

Update a context pack whenever you add or move one of these things:

- A top-level frontend route or page module.
- A backend route mount in `src/api/worker.ts`.
- A shared API/client/auth/DB abstraction.
- A migration that changes a table used by the pack.
- A high-value test that should be run for that pack.

Keep each context pack short. It should tell the assistant where to look, not duplicate entire source files.
