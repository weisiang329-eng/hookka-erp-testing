# Planning — Module Guide

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/pages/planning/*`, `src/api/routes/{planning-schedule,schedule-proposals,production-leadtimes,mrp,scheduling,agent-console}.ts`, `src/api/lib/{planning-capacity,planning-chain,planning-scheduler,lead-times,schedule-proposals,agent-console}.ts`, `src/api/worker.ts`, and `tests/`.
> Re-verified 2026-08-13 (chore/dead-code-sweep): all nine `src/pages/planning/dept/*.tsx` import `_DepartmentSchedulePage`; the `_PlainDeptSchedulePage.tsx` variant this guide listed had no importer and is deleted.
> Corrected 2026-08-13: `computeChain` is at `planning-chain.ts:2418`, not :1775 (the file is 2,517 lines); `scheduleCutting`/`runCutting` moved to :972/:631; `production-orders.ts` is **3,903 lines, not 7,606** — it was split, with the helpers now in `src/api/routes/production-orders/_helpers.ts` (5,799). Both `production-leadtimes` mounts confirmed (`worker.ts:1361` and `:1361`). All three named tests exist.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns production **planning, scheduling, MRP and lead times** — the read-mostly analytics layer that sits on top of Production. The `/planning` page is a 5-tab console (Capacity Overview / Capacity Loading / Lead Times / Master Tracker / Schedule Proposals) that READS `production_orders` + `job_cards` and never mutates production. The real scheduling math lives in `src/api/lib` (capacity, chain engine, cutting scheduler, lead-times), and the routes are thin. **Lead times** are configurable per department with a history + scheduled-change trail and a due-date (DD) buffer. **MRP** explodes active POs into material requirements. **Schedule Proposals** (Phase-2) are read-only due-date suggestions an agent generates; only the human approve action writes back `job_cards.dueDate`.

## Entry points
- Pages
  - `/planning` → `src/pages/planning/index.tsx:444` (`PlanningPage` — one 4,060-line file, 5 tab-gated render blocks)
  - MRP view → `src/pages/planning/mrp.tsx` (reads/posts `/api/mrp`)
  - Lead-time history + scheduled changes → `src/pages/planning/LeadTimeHistoryDialog.tsx`
  - Per-dept daily schedule (shared renderer) → `src/pages/planning/dept/_DepartmentSchedulePage.tsx` — the ONLY renderer; all nine dept pages import it. (`_PlainDeptSchedulePage.tsx`, a plain-table variant this line used to list, had no importer and was deleted in chore/dead-code-sweep.)
  - Dept config shells (one per dept, no logic) → `src/pages/planning/dept/{fabric-cutting,fabric-sewing,wood-cutting,foam-bonding,foam-cutting,framing,webbing,upholstery,packing}.tsx`
  - Agent Console (SUPER_ADMIN) → `src/pages/agents/index.tsx`
- API routes (mounts in `src/api/worker.ts`)
  - Lead-time config + history → `src/api/routes/production-leadtimes.ts` (mounted at BOTH `/api/production-leadtimes` and `/api/production/leadtimes` — FE uses the latter)
  - Per-dept daily schedule data → `src/api/routes/planning-schedule.ts` (mounted `/api/planning`)
  - Phase-2 due-date proposals → `src/api/routes/schedule-proposals.ts` (mounted `/api/planning`, so `/api/planning/proposals/*`)
  - MRP runs → `src/api/routes/mrp.ts` (`/api/mrp`)
  - Legacy scheduling snapshot → `src/api/routes/scheduling.ts` (`/api/scheduling`)
  - Agent console → `src/api/routes/agent-console.ts` (`/api/agents`, `requireSuperAdmin`)
  - Backend math libs → `src/api/lib/{planning-capacity,planning-chain,planning-scheduler,lead-times,schedule-proposals}.ts`
- Production READS only: `src/api/routes/production-orders.ts` (3903 lines) + `src/api/routes/production-orders/_helpers.ts` (5799), Production-owned — grep targeted handlers, never read whole

## Data model
- `production_orders` — active POs, due dates, progress (READ only from Planning).
- `job_cards` — per-PO dept sequence, `wipKey`, earliest-pending due date; `job_cards.dueDate` is the ONLY thing a proposal approve writes.
- `production_lead_times` — **legacy** single-row config; the history/buffer tables below are the live source.
- `production_lead_times_history` — lead-time change history + future scheduled changes.
- `hookka_dd_buffer_history` — due-date buffer history (days added between production-done and customer DD).
- `mrp_runs` / `mrp_requirements` — MRP run headers + exploded material requirements.
- `schedule_proposals` / `plan_snapshots` — Phase-2 proposals + approved-batch snapshots; **runtime self-apply** via `ensureProposalTables` (NOT migration files).
- `agent_runs` / `agent_controls` / `config_proposals` — agent workforce runtime state (self-apply).
- `kv_config` — `public_holidays`, schedule settings, `lead-time-settings`, `planning_capacity` config.

## Core flows
1. **Capacity / loading / tracker read** — `PlanningPage` (`index.tsx:444`) fetches POs/JCs and renders tab-gated blocks selected by `activeTab`; `ScheduleProposalsTab` is at `:3253` and `DrilldownModal` (`:3563`) shows per-cell detail. (The individual tab JSX blocks live inside `PlanningPage` — jump by tab id, not by a remembered line.)
2. **Lead-time save / recalc** — the inline Save form → `PUT /api/production/leadtimes` + `PUT /settings` (`production-leadtimes.ts:202`); `POST /recalc-all` walks every PO + `job_cards` row and re-derives due dates from lead times + DD buffer. Gated OFF when `autoScheduleEnabled` is false so hand-entered due dates are never clobbered.
3. **Per-dept daily schedule** — `GET /api/planning/schedule/:dept` (`planning-schedule.ts:611`, plus the `fabric-cutting` special `:107`) runs the cutting scheduler and returns per-day lanes rendered by `_DepartmentSchedulePage.tsx`.
4. **Phase-2 proposals (read-only → approve writes)** — `POST /api/planning/proposals/generate` (`schedule-proposals.ts:95`) is pause-gated (`isAgentPaused`) + agent-run-logged (`recordAgentRun`) and calls `generateProposals` (`lib/schedule-proposals.ts:161`) — pure read, no writes. `POST /proposals/approve` (`:158`) is the ONLY path that writes `job_cards.dueDate` and stores one `plan_snapshots` row; `/proposals/reject` (`:249`) just flips status.
5. **MRP run** — `POST /api/mrp` (`mrp.ts:536`) explodes active POs into `mrp_requirements`; `GET /` (`:397`), `GET /runs` (`:458`), `GET /runs/:id` (`:479`) read them.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `PlanningPage` | `src/pages/planning/index.tsx:444` | Default export; 5 tab-gated render blocks keyed off `activeTab` |
| `TABS` def | `src/pages/planning/index.tsx:198` | capacity · loading · leadtimes · tracker · proposals |
| `ScheduleProposalsTab` | `src/pages/planning/index.tsx:3253` | Proposals list + approve/reject UI |
| `DrilldownModal` | `src/pages/planning/index.tsx:3563` | Per-cell schedule drilldown |
| `computeChainWithAssignments` | `src/api/routes/planning-schedule.ts:538` | Phase-2 chain engine with per-(card,day) assignment collector |
| `GET /schedule/:dept` | `src/api/routes/planning-schedule.ts:611` | Per-dept daily schedule data (`fabric-cutting` special at `:107`) |
| `computeChain` | `src/api/lib/planning-chain.ts:2418` | Pure chain engine; takes OPTIONAL `collect` callback |
| `scheduleCutting` / `runCutting` | `src/api/lib/planning-scheduler.ts:972 / 631` | Cutting-queue scheduler snapshot |
| `loadCapacityConfig` / `mergeCapacityConfig` | `src/api/lib/planning-capacity.ts:405 / 317` | Per-dept capacity config from `kv_config` |
| `loadLeadTimes` / `leadDaysFor` | `src/api/lib/lead-times.ts:107 / 147` | Lead-time load + per-category day lookup |
| `loadHookkaDDBuffer` / `hookkaDDBufferFor` | `src/api/lib/lead-times.ts:193 / 220` | DD-buffer load + lookup |
| `loadLeadTimeSettings` / `saveLeadTimeSettings` | `src/api/lib/lead-times.ts:258 / 285` | Auto-schedule toggle in `kv_config` |
| `PUT /settings` | `src/api/routes/production-leadtimes.ts:202` | Persist the `autoScheduleEnabled` toggle |
| `generateProposals` | `src/api/lib/schedule-proposals.ts:161` | Read-only proposal generation |
| `applyPendingProposals` / `ensureProposalTables` | `src/api/lib/schedule-proposals.ts:350 / 34` | Apply approved batch / self-apply tables |
| `POST /proposals/approve` | `src/api/routes/schedule-proposals.ts:158` | ONLY writer of `job_cards.dueDate` + `plan_snapshots` |
| `recordAgentRun` / `isAgentPaused` | `src/api/lib/agent-console.ts:123 / 216` | Agent-run logging + pause gate |

## Gotchas
- **Backend math is in `src/api/lib`, NOT the routes.** Change schedule/capacity/lead-time math in `planning-capacity.ts`, `planning-chain.ts`, `planning-scheduler.ts`, `lead-times.ts` — the routes are thin passthroughs.
- **Proposals are read-only until approved.** `computeChain`'s optional `collect` callback emits per-(card,day) assignments; every pre-Phase-2 call site passes none, so schedules stay byte-identical. Generation writes nothing — only `POST /api/planning/proposals/approve` writes `job_cards.dueDate`. `schedule_proposals` / `plan_snapshots` are runtime self-apply (`ensureProposalTables`), NOT migration files.
- **NUL sentinel in the engines.** `planning-chain.ts` and `planning-scheduler.ts` each contain ONE intentional NUL separator written as the 6-char source escape `\u0000` — never save it as a raw `0x00` byte (a raw NUL makes git/grep treat the file as binary).
- **`production_lead_times` is legacy.** History/buffer tables are the live source. The inline Save Lead Times form in `PlanningPage` and `LeadTimeHistoryDialog.tsx` both hit `/api/production/leadtimes` — keep them consistent (dialog comment flags this).
- **`recalc-all` is server-gated.** It no-ops when `autoScheduleEnabled` is false (`production-leadtimes.ts`), regardless of UI state, so manually-entered due dates are never overwritten. It reads existing `job_cards.wipKey` — do not re-implement the shared `deriveTopLevelWipKey` formula here.
- **Dept pages are config-only shells** over the ONE shared renderer `_DepartmentSchedulePage.tsx`. Layout/column changes belong in the shared file, not the per-dept copies.
- **`PlanningPage` is one 4,060-line file** with TAB-gated render blocks selected by the `activeTab` string, not separate files — edit the matching block.
- **Capacity Loading uses working-day windows** (Mon–Sat, Sundays excluded): 14 past / 21 future days (constants just above `TABS`, `index.tsx:~195`), not calendar days.
- **Planning never mutates Production.** `production-orders.ts` (3,903 lines) + `production-orders/_helpers.ts` (5,799) are Production-owned; Planning only READS them. Grep targeted handlers, never read the whole file.
- **Root-level `*.xlsx` and `scripts/*.py`** (`build_*_xlsx.py`, `dept_flow_scheduler.py`) are throwaway export/planning-data tooling, NOT part of this module — ignore them.

## Common tasks (mini-playbook)
- **Change schedule/capacity math** → edit the `src/api/lib` engine (`planning-scheduler.ts` / `planning-chain.ts` / `planning-capacity.ts`), never the thin route. Verify with `tests/planning-scheduler.test.mjs`, `tests/scheduler.test.mjs`, `tests/scheduler-sent-lock.test.mjs`.
- **Adjust a lead time or DD buffer** → math in `lead-times.ts` (`leadDaysFor:147`, `hookkaDDBufferFor:220`); persist via `PUT /api/production/leadtimes`; after config changes fire `POST /recalc-all`. Keep the inline form + `LeadTimeHistoryDialog` in sync.
- **Add a proposal field / rule** → change `generateProposals` (`lib/schedule-proposals.ts:161`); it must stay read-only. Only extend the writer inside `POST /proposals/approve` (`schedule-proposals.ts:158`). Tables self-apply in `ensureProposalTables` (`:34`).
- **Add a Planning tab** → add to `TABS` (`index.tsx:198`) + a `{activeTab === "x" && (...)}` block; back it with a thin `app.get` in `planning-schedule.ts` calling a `src/api/lib` helper.
- **Touch MRP** → run/read handlers in `mrp.ts` (run `POST /:536`, reads `:397/:458/:479`); page `mrp.tsx`.

## Related modules
[[production]] [[sales]] [[procurement]] [[inventory]] [[delivery]]
