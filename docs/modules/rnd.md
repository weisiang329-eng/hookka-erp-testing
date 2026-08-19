# R&D / New-Model Development — Module Guide

> **Last verified: 2026-08-19** against `src/api/routes/rd-projects.ts` (2,261 lines),
> `src/api/routes/rd-team-members.ts`, `src/pages/rd/{index,detail,maintenance}.tsx`,
> `src/pages/rd/health.ts`, `src/api/worker.ts`, `src/api/lib/column-rename-map.json`,
> `tests/db-schema.json`, and `ls tests/`.
> **Every API-side anchor in this guide is EXACT** — all 6 status-transition endpoints, all
> 4 `stock_movements` INSERTs (`:1224/1460/1699/1852`), both `actualCost` recomputes
> (`:1281/1883`), `computeLabourCostSummary :259`, the graceful-degrade catch `:286`, the
> "PUT does not own actualCost" comment `:577`, the `worker.ts:1380-1381` mounts, and all
> four `rd-team-members.ts` handlers. "No automated tests cover R&D" re-confirmed.
> Corrected 2026-08-19: **`productionBOM` is NOT dead** — the column `rd_projects.production_bom`
> exists and the route reads it (`:136`), inserts it (`:432`) and persists it on PUT
> (`:587-592`); what is true is that no FE file references it, and the claimed "leftover
> comment markers at `detail.tsx ~2225` / `~2739`" **do not exist** (zero `productionBOM`
> hits anywhere under `src/pages/`). Also: every page anchor was 2–4 lines stale and is
> re-derived; the Edit Project modal is `detail.tsx:2454` (was `:2421`, which is a
> "Clear override" button) and the status buttons are `:1795-1860` (was `:1764-1858`); and
> the camelCase/snake_case note was backwards — see the corrected gotcha.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Tracks new-model development as **R&D Projects** moving through a staged pipeline, plus their **prototypes**, **material issuances**, and **labour hours**. Each project carries pricing targets (target selling / material cost) and an auto-computed cost breakdown (material actualCost + labour). Three project types drive different stage labels: `DEVELOPMENT`, `IMPROVEMENT`, and `CLONE` (clone-a-competitor, with a clone-source card + `sourcePriceSen`). Material issuance is **inventory-affecting** — it writes real `stock_movements` and recomputes `rd_projects.actualCost`, so issue/reverse must roll back cleanly. Labour cost derives from `rd_labour_hours` JOIN `rd_team_members` (FULL_TIME billed per hour; PART_TIME contributes 0 to the per-hour bucket by design).

## Entry points
- Pages
  - `/rd` → `src/pages/rd/index.tsx:1313` (`RDPage` — tabbed home: summary/drafts/projects/completed/pipeline/reports + Create Project dialog)
  - `/rd/:id` → `src/pages/rd/detail.tsx:226` (`RDProjectDetailPage` — single-project dashboard, 3,176 lines)
  - `/rd/maintenance` → `src/pages/rd/maintenance.tsx:94` (`RDMaintenancePage` — R&D Team Members CRUD grid)
  - Health-scoring helper (non-page) → `src/pages/rd/health.ts:63` (`getProjectHealth`)
- API routes (mounted in `src/api/worker.ts:1380-1381`)
  - Full R&D lifecycle → `src/api/routes/rd-projects.ts` (2261 lines): CRUD + status transitions + pricing + material issuance + labour hours
  - R&D Team Members CRUD (feeds labour cost) → `src/api/routes/rd-team-members.ts` (305 lines)

## Data model
- `rd_projects` — project header (status, type, pricing targets, actualCost). `milestones` / `production_bom` / `labour_logs` / `material_issuances` are legacy JSON TEXT columns. `production_bom` is **backend-live but UI-dead**: `rowToProject` parses it (`:136`), create INSERTs it (`:432`) and PUT persists it (`:587-592`), yet no file under `src/pages/` references it.
- `rd_prototypes` — prototype records (split in UI by Improvements / Defects).
- `rd_material_issuances` — table-backed issuance log; the source of truth for `actualCost`.
- `rd_labour_hours` — per-member logged hours (JOINed to `rd_team_members` for cost).
- `rd_team_members` — R&D staff (`employmentType` FULL_TIME/PART_TIME, `hourlyRateSen`, `monthlyFixedCostSen`).
- `stock_movements` — written on material issuance / reversal (inventory cascade, not a log).
- **Every physical column is snake_case** (`tests/db-schema.json`): `actual_cost`, `product_category`, `project_type`, `production_bom`, `source_price_sen`, `target_selling_price_sen`, `target_material_cost_sen`, `started_at`, `manual_labour_cost_sen`, and on `rd_team_members` `employment_type` / `hourly_rate_sen` / `monthly_fixed_cost_sen`. What is camelCase is the **identifier the route SQL writes** (`SET actualCost = ?`), which `src/api/lib/column-rename-map.json` rewrites to the snake_case column — the pricing-target cols simply have no camelCase alias and are written snake_case directly.

## Core flows
1. **Create project** — `app.post("/")` `rd-projects.ts:383`. Seeds `milestones` from the stage list; writes pricing-target snake_case cols. Surfaced from `CreateProjectDialog` (`index.tsx:986`).
2. **Status transitions** — dedicated endpoints, NOT raw PUT: start `:796` (sets `status=ACTIVE`, `started_at`), hold `:862`, resume `:915`, complete `:976`, move-to-draft `:1038` (clears `started_at`), reopen `:1098`. Status model: DRAFT / ACTIVE / ON_HOLD / COMPLETED / CANCELLED.
3. **Issue material** — `app.post("/:id/issue-material")` `rd-projects.ts:1157` (and issuances `:1403`, batch `:1555`). Inserts `stock_movements` (`:1224`, `:1460`, `:1699`), inserts `rd_material_issuances`, then recomputes `actualCost` from the table sum (`UPDATE rd_projects SET actualCost` at `:1281`, `:1512`, `:1768` — one per entry point).
4. **Reverse issuance** — `app.delete("/:id/issuances/:issuanceId")` `rd-projects.ts:1807`. Reversing `stock_movement` (`:1852`) + deletes the issuance row + recomputes `actualCost` (`:1883`).
5. **Labour cost** — `computeLabourCostSummary` `rd-projects.ts:259` derives `laborCostSen` (FT hours*rate) + `partTimeFixedCostSen` (distinct PT `monthlyFixedCostSen`); `manual_labour_cost_sen` overrides via `app.patch("/:id/labour-cost")` `:2172`. Log via `app.post("/:id/labour-hours")` `:2048`.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `RDPage` | `src/pages/rd/index.tsx:1313` | Tabbed home; tab switcher (summary/drafts/projects/completed/pipeline/reports) |
| `CreateProjectDialog` | `src/pages/rd/index.tsx:986` | Create-project form |
| `SummaryView` / `PipelineView` / `ReportsView` | `src/pages/rd/index.tsx:487 / 718 / 778` | KPI summary, pipeline board, reports |
| `ProjectCard` / `DraftCard` / `StageProgressBar` | `src/pages/rd/index.tsx:315 / 199 / 98` | List cards + stage progress bar |
| `RDProjectDetailPage` | `src/pages/rd/detail.tsx:226` | Single-project dashboard (all modals inline) |
| `getStageLabels` | `src/pages/rd/detail.tsx:82` | Stage labels by projectType (IMPROVEMENT / CLONE differ) |
| `makeBlankIssuanceLine` / `MilestoneStatusChip` | `src/pages/rd/detail.tsx:135 / 154` | Issuance-line factory + milestone chip |
| `getProjectHealth` / `getMilestoneHealth` | `src/pages/rd/health.ts:63 / 103` | Schedule/budget health scoring |
| `RDMaintenancePage` | `src/pages/rd/maintenance.tsx:94` | Team Members CRUD grid |
| `app.post("/")` (create) | `src/api/routes/rd-projects.ts:383` | Create project + seed milestones |
| `app.put("/:id")` (edit) | `src/api/routes/rd-projects.ts:543` | Edit project (actualCost owned by issuance endpoints) |
| start/hold/resume/complete/move-to-draft/reopen | `rd-projects.ts:796 / 862 / 915 / 976 / 1038 / 1098` | Status transitions (keep audit + started_at consistent) |
| `app.post("/:id/issue-material")` | `src/api/routes/rd-projects.ts:1157` | Issue material → stock_movements + actualCost |
| `app.delete("/:id/issuances/:issuanceId")` | `src/api/routes/rd-projects.ts:1807` | Reverse issuance (clean rollback) |
| `computeLabourCostSummary` | `src/api/routes/rd-projects.ts:259` | FT-hourly + PT-fixed labour summary |
| `app.patch("/:id/labour-cost")` | `src/api/routes/rd-projects.ts:2172` | Set/clear manual labour override |
| R&D Team Members CRUD | `src/api/routes/rd-team-members.ts:61 / 77 / 180 / 275` | GET / POST / PUT / DELETE |

## Gotchas
- **Material issuance is an inventory cascade, not a log.** It writes real `stock_movements` (`rd-projects.ts:1224, 1460, 1699, 1852`) and updates `rd_projects.actualCost`. Issue/reversal must roll back cleanly or you get orphan `stock_movements` with no matching issuance row.
- **PART_TIME labour contributes 0 to the per-hour bucket — intentional.** FT rows add `hours*hourlyRateSen`; PT is a flat `monthlyFixedCostSen` retainer surfaced as a separate "Total Fixed Cost" line (`computeLabourCostSummary` `rd-projects.ts:259`, comment block `:230-258`). Don't "fix" PT contributing 0.
- **Stage labels are project-type dependent** — `getStageLabels` (`detail.tsx:82`) returns different labels for IMPROVEMENT and CLONE. CLONE projects also surface a clone-source card + `sourcePriceSen`.
- **Change status via the transition endpoints, not a raw PUT** — start/hold/resume/complete/move-to-draft/reopen keep the audit trail + `started_at` consistent. PUT deliberately does NOT own `actualCost` (`rd-projects.ts:576-580`); the issuance endpoints recompute it.
- **The DB columns are ALL snake_case; the camelCase you see in `rd-projects.ts` SQL is an alias** that `column-rename-map.json` rewrites (`actualCost`→`actual_cost`, `productCategory`→`product_category`, `projectType`→`project_type`, `productionBOM`→`production_bom`, …). The pricing-target cols (`target_selling_price_sen`, `target_material_cost_sen`, `started_at`, `manual_labour_cost_sen`) have no alias and are written snake_case directly. Prefer snake_case for new columns; a new camelCase write column needs a `column-rename-map.json` entry or it silently 400s.
- **`milestones` / `production_bom` are legacy JSON TEXT on `rd_projects`, not tables.** `production_bom` has **no UI** — no file under `src/pages/` mentions it — but it is NOT dead code: the route still parses (`:136`), inserts (`:432`) and updates (`:587-592`) it, so a write that drops it will silently blank the column. (An earlier version of this guide pointed at "leftover comment markers" in `detail.tsx`; there are none.)
- **Graceful degrade when `rd_labour_hours` is missing** (migration 0098 not yet applied) — `computeLabourCostSummary` returns a zeroed summary rather than 500ing (`rd-projects.ts:286`).
- **No automated tests cover R&D** — verify lifecycle + issuance changes manually on prod (read AND write path) before shipping.

## Common tasks (mini-playbook)
- **Add a field to a project** → snake_case column (+ `column-rename-map.json` if camelCase); persist in `app.post("/")` (`rd-projects.ts:383`) and `app.put("/:id")` (`:543`); surface in `rowToProject` (`:115`); render in `detail.tsx:226` and the Edit Project modal (`detail.tsx:2454`).
- **Add / change a status transition** → add a dedicated `app.post("/:id/<action>")` endpoint alongside `:796-1098`; keep `started_at` + audit consistent; wire a status button in the action block at `detail.tsx:1795-1860` (handlers `handleComplete` `:450`, `handleHold` `:483`, `handleResume` `:489`). Never mutate status via raw PUT.
- **Touch material issuance** → edit `issue-material` (`:1157`) / issuances (`:1403`) / reversal (`:1807`); ALWAYS pair the `stock_movements` write with the `rd_material_issuances` row and the `actualCost` recompute — all three or none.
- **Adjust labour cost rules** → change `computeLabourCostSummary` (`rd-projects.ts:259`); team-member rates live in `rd-team-members.ts` (GET `:61` / POST `:77` / PUT `:180` / DELETE `:275`) + grid `maintenance.tsx:94`.
- **Change project health scoring** → `getProjectHealth` / `getMilestoneHealth` (`health.ts:63 / 103`); chips render via `ProjectHealthChips` (`index.tsx:131`).

## Related modules
[[inventory]] [[production]] [[procurement]] [[accounting]]
