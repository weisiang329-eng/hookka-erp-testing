# Production & BOM — Module Guide

> **Last verified: 2026-08-13** against `src/api/routes/production-orders.ts`, `src/api/routes/production-orders/_helpers.ts`, `src/api/routes/{bom,bom-master-templates,job-cards,production-folders,cnc-templates,wip-times,production-leadtimes}.ts`, `src/api/lib/{bom-wip-breakdown,po-cost-cascade,packing-rack-write,packing-piece-identity,fg-completion}.ts`, `src/lib/repair-scope.ts`, `src/pages/production/*`, `src/pages/bom.tsx`, `src/dashboard-routes.tsx`, and `tests/`.
> Corrected 2026-08-13: **`production-orders.ts` was split** — 3,903 lines of handlers plus `src/api/routes/production-orders/_helpers.ts` (5,799) holding every shared function; the 8,595-line figure and ~15 anchors were stale by 2,000–5,000 lines. `src/pages/bom.tsx` is 6,613 lines, so the old `BOMManagementPage` anchor (:6773) pointed **past end of file** — it is at :6136. **`ProductionTimesDialog` does not exist anywhere in `src/pages/` — that row is deleted, not re-pointed.** The `/production/tracker` redirect and the deletion of `production/tracker.tsx` are both confirmed true.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the shop floor: a **dept-tabbed WIP board** (one production_order per confirmed SO item), the **job cards** each PO explodes into, and the **BOM** that drives the explosion. A confirmed SO's production_orders (created upstream in `sales-orders.ts`) are broken into per-department job cards via the BOM's `wipComponents` (`breakBomIntoWips`); workers **scan** each dept complete on the phone, which advances the card, recomputes PO status/progress, cascades completion back to the SO/CO, and fires the **cost cascade** (RM consumption, labour posting, FG batch cost). The board is one 9,643-line page driven entirely by `activeTab` (dept code). **BOM Management** (`bom.tsx`, 6,613 lines) edits `bom_templates` + `bom_versions`, master templates (Bedframe/Sofa/Accessory), per-dept production-time minute rates, and CNC drilldown templates.

## Entry points
- Pages
  - `/production` → `src/pages/production/index.tsx:548` (`ProductionPage` — dept-tabbed WIP board; `activeTab` ∈ ALL/UPHOLSTERY/PACKING/FOAM/FAB_CUT/FAB_SEW)
  - `/production/folders` → `src/pages/production/folders.tsx:39` (`ProductionFoldersPage`) · `/folder-detail` → `src/pages/production/folder-detail.tsx`
  - `/production/tracker` → redirect to `/planning?tab=tracker` (`src/dashboard-routes.tsx`). The Master Tracker lives as a TAB of the Planning page; the standalone `production/tracker.tsx` was deleted 2026-08-13 — unreachable since the route became a redirect, imported nowhere. **`PlanningPage` does not read `?tab=` yet** (`activeTab` is local state), so this redirect and the Production page's own "Master Tracker" button both land on Capacity Overview.
  - `/production/scan` → `src/pages/production/scan.tsx` (shop-floor dept scan) · `/production/fg-scan` → `src/pages/production/fg-scan.tsx`
  - `/production/wip-times` → `src/pages/production/wip-times.tsx` (per-dept minute rates)
  - `/bom` → `src/pages/bom.tsx:6136` (`BOMManagementPage`) · `/cnc-templates` → `src/pages/cnc-templates.tsx`
- API routes
  - PO / job-card / WIP / scan **handlers** → `src/api/routes/production-orders.ts` (3903 lines); every shared
    function lives in `src/api/routes/production-orders/_helpers.ts` (5799). Mounted `worker.ts:1232`.
  - BOM templates + versions → `src/api/routes/bom.ts` (1454) · master variants → `bom-master-templates.ts` (243)
  - Job-card reads + event timeline → `job-cards.ts` (804) · folders group/ungroup → `production-folders.ts` (461)
  - CNC Model→Size/Seat derive → `cnc-templates.ts` (1322) · minute counts → `wip-times.ts` (588) · due-date buffer → `production-leadtimes.ts` (625)
  - BOM explosion engine → `src/api/lib/bom-wip-breakdown.ts` · cost cascade → `src/api/lib/po-cost-cascade.ts`

## Data model
- `production_orders` — one row per confirmed SO item (status, progress, dueDate, `repairscope`). `production_orders_archive` (soft-delete) / `production_orders_list_snapshot` (denormalized fast-read cache).
- `job_cards` — per-department cards a PO explodes into (wipKey, dept, completion PIC/time). `job_cards_archive` / `job_card_events` (event timeline) / `folder_job_cards`.
- `bom_templates` — active BOM (L1 materials + `wipComponents` array holding per-dept minute rates). `bom_versions` — versioned history. `bom_master_templates` — Bedframe/Sofa/Accessory master variants.
- `wip_items` / `wip_cascade_log` (idempotency claim log) · `piece_pics` (per-piece completion + `racking_number`, mig 0192).
- `cnc_templates` — Model→Size/Seat→Files (no category column; `total_height` doubles as sofa seat size; hierarchy DERIVED on FE).
- `cost_ledger` (append-only; written by the cost cascade) · `fg_units` / `fg_batches` (produced on PO completion) · `rack_items` / `rack_locations` (packing occupancy mirror).
- Relationships: SO confirm → production_orders (upstream) → job_cards (via `breakBomIntoWips`); dept scan → recompute PO → cascade to SO/CO + cost cascade → FG units.

## Core flows
1. **BOM explosion → job cards** — `breakBomIntoWips` (`bom-wip-breakdown.ts:350`) reads `bom_templates.wipComponents`, resolves tokens (`resolveWipTokens:151`) and stamps each card's `wipKey` via `deriveTopLevelWipKey` (`:125`) — THE single shared wipKey formula (FAB_SEW splits on `'::'`[2], etc.). Shared with `po-cost-cascade` and `repair-scope`; never re-implement.
2. **Dept scan-complete** — three sibling handlers by dept/sticker: `app.post("/:id/scan-complete")` (`production-orders.ts:1862`, PACKING per-piece), `/scan-complete-dept` (`:2460`, FAB_CUT/FAB_SEW), `/scan-complete-shared` (`:2787`, Sew/Uph). Each has dual auth (dashboard RBAC OR X-Worker-Token), advances the card, then calls `recomputePoStatusAndProgress` (`_helpers.ts:4133`).
3. **PO status recompute + completion cascade** — `recomputePoStatusAndProgress` (`_helpers.ts:4133`) is the single source of truth for PO `status` + progress. On full completion it fans out to `postProductionOrderCompletion` (`fg-completion.ts`, FG units/batches), `postJobCardLabor` (`po-cost-cascade.ts:953`), and the SO/CO cascades (`cascadePoCompletionToSO` `_helpers.ts:3900` / `cascadeUpholsteryToSO` `:3536` / `cascadeCNCompletionToCO` `:3994`).
4. **Cost cascade** — on scan/completion: `consumeRawMaterialsForPO` (`po-cost-cascade.ts:671`, RM_ISSUE), `postJobCardLabor` (`:953`, LABOR_POSTED — idempotent via a `cost_ledger` check in the scan handler), `backfillFGBatchCost` (`:1153`), `postWIPCompletionMarker` (`:1276`). All append-only to `cost_ledger`.
5. **Stock PO create** — `app.post("/stock")` (`production-orders.ts:1187`) builds make-to-stock POs (no SO). Board list read is `app.get("/")` (`:726`) via `fetchFilteredPOs` (`_helpers.ts:1444`); board summary `app.get("/board")` (`:3301`).
6. **BOM edit** — `bom.tsx` `EditBOMDialog` (`:2963`) → `PUT /templates/:id` (`bom.ts:484`); master templates via `MasterTemplatesDialog` (`bom.tsx:3893`). Per-dept minute rates are edited on `src/pages/production/wip-times.tsx` (backed by `wip-times.ts`) and land in `bom_templates.wipComponents`.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `ProductionPage` | `src/pages/production/index.tsx:548` | WIP board; every column/row branches on `activeTab` |
| `filteredOrders` (memo) | `src/pages/production/index.tsx:2825` | Dept-narrow + overdue-set grid filter |
| `loadFgStickers` / `packingStickerUrl` | `src/pages/production/index.tsx:5506 / 5465` | FG sticker set (immediate paint → /p/ token upgrade) |
| `BOMManagementPage` | `src/pages/bom.tsx:6136` | BOM page shell (tabs, list) |
| `EditBOMDialog` / `MasterTemplatesDialog` | `src/pages/bom.tsx:2963 / 3893` | L1+WIP editor / master variants |
| `rowToPO` | `production-orders/_helpers.ts:905` | PO row → API shape (dual-keyed reads) |
| `applyWipInventoryChange` | `production-orders/_helpers.ts:2574` | WIP inventory change; idempotent ONLY when `orgId` passed |
| `recomputePoStatusAndProgress` | `production-orders/_helpers.ts:4133` | Single source of truth for PO status/progress |
| `applyPoUpdate` | `production-orders/_helpers.ts:4274` | Shared PO mutation body (PATCH/PUT) |
| `fetchFilteredPOs` | `production-orders/_helpers.ts:1444` | Board list query |
| `ensurePendingMigrations` | `production-orders/_helpers.ts:98` | Runtime column self-apply |
| `app.post("/:id/scan-complete[-dept/-shared]")` | `production-orders.ts:1862 / 2460 / 2787` | Dept scan complete (3 dept/auth variants) |
| `app.patch("/:id")` / `app.post("/stock")` | `production-orders.ts:3772 / 1187` | PO edit (rack-assign) / make-to-stock create |
| `app.post("/packing-rack-tokens")` | `production-orders.ts:1642` | Authed /p/ piece-token mint (batched) |
| `GET /overdue-counts` | `production-orders.ts:393` | Server overdue set behind the grid chips |
| `deriveTopLevelWipKey` / `breakBomIntoWips` | `src/api/lib/bom-wip-breakdown.ts:125 / 350` | THE wipKey formula / BOM → job-card WIPs |
| `consumeRawMaterialsForPO` / `postJobCardLabor` | `src/api/lib/po-cost-cascade.ts:671 / 953` | RM consumption / labour GL posting |
| `applyPackingRack` | `src/api/lib/packing-rack-write.ts:71` | Rack set/clear + rack_items occupancy mirror |
| `PUT /templates/:id` / `POST /templates/bulk-process-edit` | `src/api/routes/bom.ts:484 / 631` | BOM template update / batch process edit |
| `GET /:id/events` | `src/api/routes/job-cards.ts:430` | Job-card event timeline |

## Gotchas
- **index.tsx is 9,643 lines, driven entirely by `activeTab`.** Almost every column set, row derivation, and render block branches on the dept code — never assume one code path. Don't read end-to-end.
- **WIP idempotency is caller-gated.** `applyWipInventoryChange` (`_helpers.ts:2574`) claims work via `wip_cascade_log` INSERT-ON-CONFLICT **only when `options.orgId` is passed** — callers without orgId stay unguarded (FOAM-326 class). Don't rebuild the table; audit caller coverage.
- **wipKey has one owner.** `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:125`) is shared by `breakBomIntoWips`, `po-cost-cascade`, and `repair-scope`. Never re-derive inline — a stale pick throws at confirm.
- **Repair scope drops lines.** `production_orders.repairscope` stamps partial repairs (FULL=null=byte-identical). Component-scope picks DROP unowned material lines via `filterWipsByRepairScope` (`src/lib/repair-scope.ts:410`) — not cosmetic.
- **Production locks are inviolate.** COMPLETED job_cards / non-PENDING fg_units must not be overridden for cosmetic edits; suggest a UI fix instead.
- **Snapshot must stay in sync.** `production_orders_list_snapshot` is a denormalized fast-read cache (serve-stale + background refresh) — every write to `production_orders` must keep it current, else the list serves the pre-write row for the rebuild window.
- **Migrations are inert** unless runtime self-applied — new columns reach prod only via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `ensurePendingMigrations` (`production-orders/_helpers.ts:98`), awaited before the first write.
- **Minute rates land in `bom_templates.wipComponents`** via `wip-times.tsx` + `wip-times.ts`; they feed `productionCostRatePerMinuteSen` in the cost cascade. (An earlier version of this doc named a `ProductionTimesDialog` in `bom.tsx` — no such component exists in the tree as of 2026-08-13.)
- **camelCase DB columns** are dual-keyed (`r.camelCase ?? r.snake_case`); db-pg `toCamel` can't recover folded-lowercase camelCase. New columns snake_case; a camelCase write column needs a `column-rename-map.json` entry or it 400s.
- **CNC hierarchy is FE-derived.** `cnc_templates` has no category column (from `products.category`) and `total_height` doubles as sofa seat size — no migration for the Model→Size/Seat→Files hierarchy.
- **Packing rack → warehouse occupancy.** Office PATCH `/:id` (`:8419`), the public /p/ scan, and worker scan ALL funnel through `applyPackingRack` (`packing-rack-write.ts:72`), which also mirrors ONE `rack_items` row per piece + recomputes `rack_locations.status`. Piece identity comes from the shared `packingPieceIdentity` (`packing-piece-identity.ts:48`) — don't re-inline the formula (BUG-2026-06-25-007).
- **Overdue chips filter the main grid** (owner 2026-06-23) — clicking "Bedframe ⚠ N" / "Sofa ⚠ N" narrows the grid (`overduePanelMode` state, `filteredOrders`) to the server overdue set from `/overdue-counts` (`production-orders.ts:393`); it does NOT pop a separate panel. Don't reintroduce the drill-down panel.
- **Combo pricing is upstream.** Sofa-combo pricing is backend-unified in `sales-orders.ts`; production reads the already-priced SO — never re-price in the production layer.

## Common tasks (mini-playbook)
- **Add a field to a PO** → column self-apply in `ensurePendingMigrations` (`production-orders/_helpers.ts:98`); persist in `applyPoUpdate` (`_helpers.ts:4274`); surface in `rowToPO` (`_helpers.ts:905`); render in `index.tsx:548`. New column snake_case (+ rename-map if camelCase). Keep the list snapshot in sync.
- **Change the scan/completion cascade** → edit `recomputePoStatusAndProgress` (`_helpers.ts:4133`) and the relevant `scan-complete*` handler (`production-orders.ts:1862`/`:2460`/`:2787`); keep the SO/CO cascade (`cascadePoCompletionToSO` `_helpers.ts:3900`) and cost cascade (`po-cost-cascade.ts`) in sync.
- **Adjust the cost cascade** → `consumeRawMaterialsForPO` / `postJobCardLabor` / `backfillFGBatchCost` in `po-cost-cascade.ts:671/953/1153`; all append-only to `cost_ledger`, guard idempotency (labour checks `cost_ledger` before posting).
- **Change BOM explosion** → `breakBomIntoWips` / `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:350/125`); verify with `tests/bom-explosion.test.mjs` + `tests/production-order-builder.test.mjs`. Never re-implement the wipKey formula.
- **Touch a BOM template** → `bom.tsx` dialogs → `bom.ts` (`GET /templates:231`, `PUT /templates:377`, `PUT /templates/:id:484`, `bulk-process-edit:631`); master variants via `bom-master-templates.ts`.

## Related modules
[[sales]] [[inventory]] [[procurement]] [[delivery]] [[accounting]] [[planning]]
