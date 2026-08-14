# Inventory — Module Guide

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/pages/inventory/*`, `src/api/routes/{inventory,inventory-wip,raw-materials,fg-units,fabric-tracking,fabrics,warehouse,stock-adjustments,stock-value,rm-batches,stock-accounts,_fabric-cascade}.ts`, `src/dashboard-routes.tsx`, `src/api/worker.ts`, and `tests/`.
> Corrected 2026-08-13: the route mounts are `worker.ts:1240-1241` (not 1135-1146/:1225); `fg-units.ts` is 1,216 lines (not 918) and its `/scan` handler is at :1047 (not :801); `dashboard-routes.tsx` registers `/inventory*` at :391-394. `GET /api/inventory/fg-source` confirmed **gone** from the tree. Every other anchor verified within ±30 lines.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Read-mostly stock visibility across the three stages of manufacturing: **Finished Goods** (FG), **Work-In-Progress** (WIP), and **Raw Materials** (RM), plus the supporting sub-modules — RM master CRUD, FG unit lifecycle, fabric tracking, warehouse racks, stock adjustments, and month-end stock valuation snapshots. The headline `/inventory` page is a single 3-tab grid; almost nothing is a stored quantity. **FG stock is DERIVED** (server-side snapshot from `production_orders`/`fg_units`, not a `stock_qty` column), **WIP is DERIVED** (from `job_cards`/`production_orders`), and only RM carries a real perpetual `balanceQty` fed by GRN receipts and FIFO `rm_batches`. Mutations happen through the domain routes (raw-materials, fg-units, fabric-tracking, warehouse, stock-adjustments), never through the aggregate read.

## Entry points
- **Pages**
  - `/inventory` → `src/pages/inventory/index.tsx:1034` (`InventoryPage` — 3 tabs FG/WIP/RM off one `activeTab` state)
  - `/inventory/fabrics` → `src/pages/inventory/fabrics.tsx` (`FabricsPage` — fabric tracking)
  - `/inventory/stock-value` → `src/pages/inventory/stock-value.tsx` (`StockValuePage` — valuation snapshots)
  - `/inventory/adjustments` → `src/pages/inventory/adjustments.tsx` (`StockAdjustmentsPage`)
  - Routes registered in `src/dashboard-routes.tsx:391-394`
- **API routes** (mounted in `src/api/worker.ts:1240-1241`; `/wip` MUST mount before `/inventory`)
  - Aggregate read + drill-downs → `src/api/routes/inventory.ts` (661 lines)
  - WIP derived view → `src/api/routes/inventory-wip.ts` (761) — mounted at `/api/inventory/wip`
  - RM CRUD + dup-code toggle → `src/api/routes/raw-materials.ts` (776)
  - FG lifecycle + backfills + scan → `src/api/routes/fg-units.ts` (1216)
  - Active fabric CRUD → `src/api/routes/fabric-tracking.ts` (466); DEPRECATED `fabrics.ts` (71, writes 410)
  - Warehouse racks + movements → `src/api/routes/warehouse.ts` (801)
  - Stock adjustments → `src/api/routes/stock-adjustments.ts` (583)
  - Valuation → `src/api/routes/stock-value.ts` (287); read-only `rm-batches.ts` (95), `stock-accounts.ts` (42)
  - Internal helper (NOT mounted) → `src/api/routes/_fabric-cascade.ts` (216)

## Data model
- `raw_materials` — RM master (itemCode, balanceQty, minStock, unitCostSen); the only stage with a stored perpetual qty.
- `rm_batches` — per-receipt FIFO layers (originalQty/remainingQty/unitCostSen, JOIN to `grns`). Read-only from here.
- `wip_items` — the WIP ledger (non-zero `stockQty` rows projected to the grid), fed by production cascades.
- `fg_units` — one row per produced/scanned finished piece; FG stock is COUNTED from these, never stored on `products`.
- `fg_batches` — FG FIFO layers (valuation side).
- `stock_adjustments` / `stock_movements` — manual RM/WIP/FG corrections + the physical-movement audit ledger (written together).
- `rack_locations` / `rack_items` — warehouse occupancy; denormalized scalars on the location, optional multi-item child rows.
- `stock_accounts` / `monthly_stock_values` — valuation snapshots; append-only, read from accounting.
- `fabric_trackings` — active fabric records (`fabrics` table is legacy/deprecated).
- Upstream feeders: `production_orders` / `job_cards` / `grns` / `cost_ledger` / `delivery_hubs`.

## Core flows
1. **3-tab aggregate read** — `GET /api/inventory` `inventory.ts:148` returns `{finishedProducts, wipItems, rawMaterials}`. `finishedProducts.stockQty` is deliberately **`null`** (`:215-227`) — NOT `0`. `0` asserts "nothing on hand"; `null` means "not computed by this endpoint". Consumers must render `—` and must NEVER coerce with `?? 0` (BUG-2026-08-13-014, which printed RM 0.00 on five screens). The real FG count comes from `/fg-stock`.
2. **FG stock derivation** — `GET /api/inventory/fg-stock` `inventory.ts:537` runtime-creates `inventory_fg_stock_snapshot` (`CREATE TABLE IF NOT EXISTS` at `:548`) then serves a cache-aside snapshot (`withSnapshot`, `../lib/snapshot`) computed from `production_orders`/`fg_units`. FE consumes it as deltas — this replaced the old client-side `deriveFGStock` (now in shared `@/lib/fg-stock`).
3. **WIP derivation** — `GET /api/inventory/wip` `inventory-wip.ts:159` projects non-zero `wip_items` rows, walking dept sequence. FE also derives its own view via `deriveWIPFromPO` (`index.tsx:325`) + `mergeSofaWIPSets` (`:548`, one synthetic row per SO+fabric for sofas).
4. **Shortage forecast** — `GET /api/inventory/shortage-forecast` `inventory.ts:225` walks CONFIRMED/IN_PRODUCTION SOs, sums per-RM BOM consumption via `collectBomMaterials` (`:205`), subtracts `balanceQty`, adds incoming-PO qty (≤ today+14d), returns `shortBy > 0`.
5. **Stock adjustment** — `POST /api/stock-adjustments` `stock-adjustments.ts:209` validates type (RM/WIP/FG) + reason, then writes `stock_adjustments` (`:392`) AND `stock_movements` (`:421`) in one batch; carries `unitCostSen`/`caseId`.
6. **Drill-downs** — `GET /rm-source/:rmId` (`inventory.ts:460` — which `rm_batches`/GRNs stock this RM). The FG equivalent `/fg-source/:productCode` was **deleted 2026-08-08** (confirmed absent 2026-08-13): the Stock Breakdown panel's Movements-in lists the same production orders off the cost ledger, which is the copy that reconciles.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `InventoryPage` | `src/pages/inventory/index.tsx:1034` | 3-tab grid host |
| `StockBreakdownDrawer` | `src/pages/inventory/StockBreakdownDrawer.tsx` | The per-item panel — opened by a ROW CLICK on any tab |
| `mergeRmReceipts` / `fgProductDetails` | `src/lib/stock-breakdown.ts` | RM lots+inbound-movements merge; the FG product-details field list |
| `deriveWIPFromPO` | `src/pages/inventory/index.tsx:325` | Client WIP derivation across dept stages |
| `mergeSofaWIPSets` | `src/pages/inventory/index.tsx:548` | Collapse sofa WIPs to one row per (SO, fabric) |
| `fgColumns` / `wipColumns` / `rmColumns` | `index.tsx:659 / 766 / 976` | Per-tab column defs |
| `BatchEditRMDialog` | `index.tsx:3509` | Bulk RM edit dialog |
| `GET /` (aggregate) | `src/api/routes/inventory.ts:148` | FG(0)/WIP/RM read |
| `GET /fg-stock` | `inventory.ts:537` | Server snapshot; runtime-creates snapshot table |
| `GET /shortage-forecast` | `inventory.ts:225` | SO-driven RM shortfall projection |
| `collectBomMaterials` | `inventory.ts:205` | Recursive BOM material roll-up |
| `GET /rm-source/:rmId` | `inventory.ts:460` | RM→batch drill-down (the FG twin was deleted 2026-08-08) |
| `GET /` (WIP view) | `src/api/routes/inventory-wip.ts:159` | Derived WIP grid rows |
| RM CRUD | `raw-materials.ts:180/195/250/355/515` | list/get/POST/PUT/DELETE |
| `_unlock` / `_relock-duplicate-codes` | `raw-materials.ts:707 / ~738` | One-shot dup-code index toggle |
| `ensureDupCodesUnlocked` | `raw-materials.ts:47` | Keeps dup-code index OFF at runtime |
| FG units list / scan | `fg-units.ts:563 / 1047` | Lifecycle; `backfill-*` one-shots `:670/:796` |
| Fabric tracking CRUD | `fabric-tracking.ts:133/278/358` | list/POST/DELETE; `wipeFabricSnapshot` `:22` |
| Warehouse racks + movements | `warehouse.ts:248/298/497` | `computeRackStatus` `:91`, `replaceRackItems` `:204` |
| `POST /` (adjustment) | `stock-adjustments.ts:209` | Writes adjustment + movement together |
| Stock value snapshots | `stock-value.ts:58/72/185` | list/POST/PUT valuation |

## Gotchas
- **FG and WIP quantities are DERIVED, not stored.** Aggregate `GET /api/inventory` (`:190`) returns `stockQty: null` for FG (it was `0` until BUG-2026-08-13-014 — never re-introduce `?? 0`); the real count is the `/fg-stock` snapshot (server, `:537`) or `deriveFGStock` in shared `@/lib/fg-stock`. WIP comes from `job_cards`/`production_orders` (`inventory-wip.ts` + `deriveWIPFromPO`). Changing production status models moves these counts.
- **`fabrics.ts` is DEPRECATED** — POST/PUT/DELETE return HTTP 410 (`fabrics.ts:67-69`). All fabric mutation goes through `fabric-tracking.ts`. Don't add write logic to `fabrics.ts`.
- **Dup-code unique index is intentionally OFF.** `ensureDupCodesUnlocked` (`raw-materials.ts:47`) keeps it off for distinct items sharing a code (BO315-21/23, 9MM AA/AB). `_unlock`/`_relock` (`:707` and just below) are one-shots — don't relock without owner sign-off.
- **fg-units one-shots + public SINGLE-UNIT GET.** `backfill-dedupe-fg-units` (`:670`) / `backfill-hub` (`:796`) are migration endpoints. **Only `GET /:id` is auth-bypassed** — `FG_UNIT_PUBLIC_GET_RE = /^/api/fg-units/[^/]+$/` (`auth-middleware.ts:128`), whose comment says it outright: *"only the single-unit GET is public … otherwise anyone on the internet can dump inventory"*. It soft-auths to pick a stripped public shape vs the full one. `GET /` and every write require auth (`GET /` calls `getOrgId(c)`, which throws without a session). COMPLETED / non-PENDING `fg_units` are inviolate.
- **Adjustments write two tables together.** `stock_adjustments` + `stock_movements` are inserted in one batch inside `POST /` (`stock-adjustments.ts:209`); keep `unitCostSen`/`caseId` on the adjustment. Runtime `ensureStockAdjustmentColumns` (`:89`) self-applies `caseid`.
- **`rack_items` has TWO writers.** The `/r/` rack-QR stock-in AND `applyPackingRack` (`src/api/lib/packing-rack-write.ts`) both mirror rows; they share `packingPieceIdentity` (`src/api/lib/packing-piece-identity.ts`) so they converge on ONE row. Don't introduce a third identity formula. Status recomputed on read/write via `computeRackStatus` (`warehouse.ts:91`).
- **`_fabric-cascade.ts` is not mounted** — underscore-prefixed internal helper, not a Hono router (covered by `tests/cascade-fc-aggregator.test.mjs`).
- **`fg-stock` snapshot table is runtime-created** — migration files are inert on deploy, so the `CREATE TABLE IF NOT EXISTS` at `inventory.ts:548` is awaited before `withSnapshot`.
- **`index.tsx` has a LOCAL `Product` type** differing from `@/types` Product — watch category typing under strict tsc.
- **camelCase columns need a `column-rename-map.json` entry** or they 400; prefer snake_case for new inventory columns.
- **ONE row click = ONE panel (owner 2026-08-08).** The Stock Breakdown drawer now also carries a finished good's own catalogue details, read-only, with an **Edit product** button that opens the existing dialog and reopens the drawer afterwards. The dialog's duplicate "Source Production Orders" table is deleted (the panel's inbound movements are the same production orders, from the cost ledger instead of `/api/inventory/fg-source` — which lost its last consumer and has since been deleted). The kebab lost "Stock breakdown" on all three tabs and "View" on FG/RM (it called the same handler as "Edit"); Edit / Delete / Refresh stay, and WIP keeps "View" because its dialog shows the GRID's own derivation, not the panel's server-side job cards.
- **The three item types are NOT the same panel.** RM merges its FIFO lots with its inbound movements into one "Receipts & stock lots" table (`mergeRmReceipts`, pure + tested — nothing is dropped from either side) and keeps a deliberately empty Movements out; FG has NO lots section and NO COGS, just Movements in / Movements out plus a collapsed "Pieces on hand" per-serial list; WIP is unchanged. Full column lists and the reasoning are in [[CODEBASE-MAP]] under Inventory.

## Common tasks (mini-playbook)
- **Add an RM field** → snake_case column (+ rename-map if camelCase); persist in `raw-materials.ts` POST (`:250`)/PUT (`:355`); surface in `rowToApi` (`:108`) and `rmColumns` (`index.tsx:976`).
- **Change how FG stock counts** → edit the `/fg-stock` snapshot source (`inventory.ts:537`) AND shared `@/lib/fg-stock` (kept byte-identical to the old client rule); verify with `tests/production-wip-producer-output.test.mjs`.
- **Change WIP derivation** → the server view (`inventory-wip.ts:159`) and the client `deriveWIPFromPO` (`index.tsx:325`) must stay in lockstep; sofa merge in `mergeSofaWIPSets` (`:548`).
- **Add an adjustment reason/type** → extend `VALID_TYPES`/`VALID_REASONS` and the POST handler (`stock-adjustments.ts:209`); keep the dual `stock_adjustments`+`stock_movements` write.
- **Touch warehouse racks** → `warehouse.ts` (racks POST `:298`, movements POST `:497`); go through `replaceRackItems` (`:204`) + `computeRackStatus` (`:91`); never bypass `packingPieceIdentity`.

## Related modules
[[production]] [[procurement]] [[accounting]] [[sales]] [[delivery]]
