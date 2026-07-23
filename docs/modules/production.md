# Production & BOM — Module Guide

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the shop floor: a **dept-tabbed WIP board** (one production_order per confirmed SO item), the **job cards** each PO explodes into, and the **BOM** that drives the explosion. A confirmed SO's production_orders (created upstream in `sales-orders.ts`) are broken into per-department job cards via the BOM's `wipComponents` (`breakBomIntoWips`); workers **scan** each dept complete on the phone, which advances the card, recomputes PO status/progress, cascades completion back to the SO/CO, and fires the **cost cascade** (RM consumption, labour posting, FG batch cost). The board is one 9.6k-line page driven entirely by `activeTab` (dept code). **BOM Management** (`bom.tsx`) edits `bom_templates` + `bom_versions`, master templates (Bedframe/Sofa/Accessory), per-dept production-time minute rates, and CNC drilldown templates.

## Entry points
- Pages
  - `/production` → `src/pages/production/index.tsx:548` (`ProductionPage` — dept-tabbed WIP board; `activeTab` ∈ ALL/UPHOLSTERY/PACKING/FOAM/FAB_CUT/FAB_SEW)
  - `/production/folders` + `/folder-detail` → `src/pages/production/folders.tsx:39`
  - `/production/tracker` → `src/pages/production/tracker.tsx:118` (`MasterTrackerPage`)
  - `/production/scan` → `src/pages/production/scan.tsx:85` (shop-floor dept scan) · `/production/fg-scan` → `src/pages/production/fg-scan.tsx:104`
  - `/production/wip-times` → `src/pages/production/wip-times.tsx:148` (per-dept minute rates)
  - `/bom` → `src/pages/bom.tsx:6773` (`BOMManagementPage`) · `/cnc-templates` → `src/pages/cnc-templates.tsx:252`
- API routes
  - PO / job-card / WIP / scan backend → `src/api/routes/production-orders.ts` (8595 lines)
  - BOM templates + versions → `src/api/routes/bom.ts` (1454) · master variants → `bom-master-templates.ts` (243)
  - Job-card reads + event timeline → `job-cards.ts` (748) · folders group/ungroup → `production-folders.ts` (378)
  - CNC Model→Size/Seat derive → `cnc-templates.ts` (1323) · minute counts → `wip-times.ts` (588) · due-date buffer → `production-leadtimes.ts` (618)
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
1. **BOM explosion → job cards** — `breakBomIntoWips` (`bom-wip-breakdown.ts:346`) reads `bom_templates.wipComponents`, resolves tokens (`resolveWipTokens:148`) and stamps each card's `wipKey` via `deriveTopLevelWipKey` (`:122`) — THE single shared wipKey formula (FAB_SEW splits on `'::'`[2], etc.). Shared with `po-cost-cascade` and `repair-scope`; never re-implement.
2. **Dept scan-complete** — three sibling handlers by dept/sticker: `app.post("/:id/scan-complete")` (`production-orders.ts:6553`, PACKING per-piece), `/scan-complete-dept` (`:7151`, FAB_CUT/FAB_SEW), `/scan-complete-shared` (`:7478`, Sew/Uph). Each has dual auth (dashboard RBAC OR X-Worker-Token), advances the card, then calls `recomputePoStatusAndProgress` (`:3840`).
3. **PO status recompute + completion cascade** — `recomputePoStatusAndProgress` (`:3840`) is the single source of truth for PO `status` + progress. On full completion it fans out to `postProductionOrderCompletion` (`fg-completion.ts:77`, FG units/batches), `postJobCardLabor` (`po-cost-cascade.ts:755`), and the SO/CO cascades (`cascadePoCompletionToSO:3610` / `cascadeUpholsteryToSO:3250` / `cascadeCNCompletionToCO:3703`).
4. **Cost cascade** — on scan/completion: `consumeRawMaterialsForPO` (`po-cost-cascade.ts:504`, RM_ISSUE), `postJobCardLabor` (`:755`, LABOR_POSTED — idempotent via cost_ledger check at `production-orders.ts:4496`), `backfillFGBatchCost` (`:955`), `postWIPCompletionMarker` (`:1078`). All append-only to `cost_ledger`.
5. **Stock PO create** — `app.post("/stock")` (`:5878`) builds make-to-stock POs (no SO). Board list read is `app.get("/")` (`:5438`) via `fetchFilteredPOs` (`:1409`); board summary `app.get("/board")` (`:7992`).
6. **BOM edit** — `bom.tsx` EditBOMDialog (`:2599`) → `PUT /templates/:id` (`bom.ts:484`); master templates via `MasterTemplatesDialog` (`bom.tsx:3408`); minute rates via `ProductionTimesDialog` (`bom.tsx:4401`) → written into `bom_templates.wipComponents`.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `ProductionPage` | `src/pages/production/index.tsx:548` | WIP board; every column/row branches on `activeTab` |
| `filteredOrders` (memo) | `src/pages/production/index.tsx:2814` | Dept-narrow + overdue-set grid filter |
| `loadFgStickers` / `packingStickerUrl` | `src/pages/production/index.tsx:5495 / 5454` | FG sticker set (immediate paint → /p/ token upgrade) |
| `BOMManagementPage` | `src/pages/bom.tsx:6773` | BOM page shell (tabs, list) |
| `EditBOMDialog` / `MasterTemplatesDialog` | `src/pages/bom.tsx:2599 / 3408` | L1+WIP editor / master variants |
| `ProductionTimesDialog` | `src/pages/bom.tsx:4401` | Per-dept minute rates → wipComponents |
| `rowToPO` | `src/api/routes/production-orders.ts:870` | PO row → API shape (dual-keyed reads) |
| `applyWipInventoryChange` | `src/api/routes/production-orders.ts:2358` | WIP inventory change; idempotent ONLY when `orgId` passed |
| `recomputePoStatusAndProgress` | `src/api/routes/production-orders.ts:3840` | Single source of truth for PO status/progress |
| `applyPoUpdate` | `src/api/routes/production-orders.ts:3981` | Shared PO mutation body (PATCH/PUT) |
| `app.post("/:id/scan-complete[-dept/-shared]")` | `.../production-orders.ts:6553 / 7151 / 7478` | Dept scan complete (3 dept/auth variants) |
| `app.patch("/:id")` / `app.post("/stock")` | `.../production-orders.ts:8419 / 5878` | PO edit (rack-assign) / make-to-stock create |
| `app.post("/packing-rack-tokens")` | `.../production-orders.ts:6333` | Authed /p/ piece-token mint (batched) |
| `deriveTopLevelWipKey` / `breakBomIntoWips` | `src/api/lib/bom-wip-breakdown.ts:122 / 346` | THE wipKey formula / BOM → job-card WIPs |
| `consumeRawMaterialsForPO` / `postJobCardLabor` | `src/api/lib/po-cost-cascade.ts:504 / 755` | RM consumption / labour GL posting |
| `applyPackingRack` | `src/api/lib/packing-rack-write.ts:72` | Rack set/clear + rack_items occupancy mirror |
| `PUT /templates/:id` / `POST /templates/bulk-process-edit` | `src/api/routes/bom.ts:484 / 631` | BOM template update / batch process edit |
| `GET /:id/events` | `src/api/routes/job-cards.ts:374` | Job-card event timeline |

## Gotchas
- **index.tsx is 9632 lines, driven entirely by `activeTab`.** Almost every column set, row derivation, and render block branches on the dept code — never assume one code path. Jump to the CODEBASE-MAP section ranges (now shifted, see summary); don't read end-to-end.
- **WIP idempotency is caller-gated.** `applyWipInventoryChange` (`:2358`) claims work via `wip_cascade_log` INSERT-ON-CONFLICT **only when `options.orgId` is passed** — callers without orgId stay unguarded (FOAM-326 class). Don't rebuild the table; audit caller coverage.
- **wipKey has one owner.** `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:122`) is shared by `breakBomIntoWips`, `po-cost-cascade`, and `repair-scope`. Never re-derive inline — a stale pick throws at confirm.
- **Repair scope drops lines.** `production_orders.repairscope` stamps partial repairs (FULL=null=byte-identical). Component-scope picks DROP unowned material lines via `filterWipsByRepairScope` (`src/lib/repair-scope.ts:408`) — not cosmetic.
- **Production locks are inviolate.** COMPLETED job_cards / non-PENDING fg_units must not be overridden for cosmetic edits; suggest a UI fix instead.
- **Snapshot must stay in sync.** `production_orders_list_snapshot` is a denormalized fast-read cache (serve-stale + background refresh) — every write to `production_orders` must keep it current, else the list serves the pre-write row for the rebuild window.
- **Migrations are inert** unless runtime self-applied — new columns reach prod only via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `ensurePendingMigrations` (`production-orders.ts:129`), awaited before the first write.
- **Minute rates have two writers.** Production-time / minute rates land in `bom_templates.wipComponents` from BOTH `bom.tsx` (`ProductionTimesDialog`) and `wip-times.tsx`/route — keep consistent; they feed `productionCostRatePerMinuteSen` in the cost cascade.
- **camelCase DB columns** are dual-keyed (`r.camelCase ?? r.snake_case`); db-pg `toCamel` can't recover folded-lowercase camelCase. New columns snake_case; a camelCase write column needs a `column-rename-map.json` entry or it 400s.
- **CNC hierarchy is FE-derived.** `cnc_templates` has no category column (from `products.category`) and `total_height` doubles as sofa seat size — no migration for the Model→Size/Seat→Files hierarchy.
- **Packing rack → warehouse occupancy.** Office PATCH `/:id` (`:8419`), the public /p/ scan, and worker scan ALL funnel through `applyPackingRack` (`packing-rack-write.ts:72`), which also mirrors ONE `rack_items` row per piece + recomputes `rack_locations.status`. Piece identity comes from the shared `packingPieceIdentity` (`packing-piece-identity.ts:48`) — don't re-inline the formula (BUG-2026-06-25-007).
- **Overdue chips filter the main grid** (owner 2026-06-23) — clicking "Bedframe ⚠ N" / "Sofa ⚠ N" narrows the grid (`overduePanelMode` state, `filteredOrders`) to the server overdue set from `/overdue-counts` (`:4818`); it does NOT pop a separate panel. Don't reintroduce the drill-down panel.
- **Combo pricing is upstream.** Sofa-combo pricing is backend-unified in `sales-orders.ts`; production reads the already-priced SO — never re-price in the production layer.

## Common tasks (mini-playbook)
- **Add a field to a PO** → column self-apply in `ensurePendingMigrations` (`production-orders.ts:129`); persist in `applyPoUpdate` (`:3981`); surface in `rowToPO` (`:870`); render in `index.tsx:548`. New column snake_case (+ rename-map if camelCase). Keep the list snapshot in sync.
- **Change the scan/completion cascade** → edit `recomputePoStatusAndProgress` (`:3840`) and the relevant `scan-complete*` handler (`:6553`/`:7151`/`:7478`); keep the SO/CO cascade (`cascadePoCompletionToSO:3610`) and cost cascade (`po-cost-cascade.ts`) in sync.
- **Adjust the cost cascade** → `consumeRawMaterialsForPO` / `postJobCardLabor` / `backfillFGBatchCost` in `po-cost-cascade.ts:504/755/955`; all append-only to `cost_ledger`, guard idempotency (labour checks cost_ledger at `:4496`).
- **Change BOM explosion** → `breakBomIntoWips` / `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:346/122`); verify with `tests/bom-explosion.test.mjs` + `tests/production-order-builder.test.mjs`. Never re-implement the wipKey formula.
- **Touch a BOM template** → `bom.tsx` dialogs → `bom.ts` (`GET /templates:231`, `PUT /templates/:id:484`, `bulk-process-edit:631`); master variants via `bom-master-templates.ts`.

## Related modules
[[sales]] [[inventory]] [[procurement]] [[delivery]] [[accounting]] [[planning]]
