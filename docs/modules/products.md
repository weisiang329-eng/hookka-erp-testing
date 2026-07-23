# Products & MDM — Module Guide

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the **product master** (SKU catalog) and its satellites: per-SKU BOM components + per-department
working times, **master price history** (effective-dated), a **3-way view** page (SKU Master / Catalog /
Maintenance) that shares one `ProductsPage` via a `viewMode` state flag. On top of the master sit
**per-customer SKUs** (`customer_products`) whose prices *shadow* (inherit-or-override) the global master,
**Master BOM Templates** (reusable component recipes) and their **master template** presets, effective-dated
**maintenance config** (product-defaults config that resolves newest-as-of-today), and a **detection-only
MDM review queue** that flags likely-duplicate customer/supplier records for a human to merge elsewhere.
Money is integer sen; many product columns are legacy camelCase.

## Entry points
- **Pages** (all under `/products`, one page hosts three views)
  - `/products` → `src/pages/products/index.tsx:1909` (`ProductsPage`; `viewMode` = `skuMaster|catalog|maintenance` at `:1912`)
  - `/products/:id/bom` → `src/pages/products/bom.tsx:457` (`BOMPage` — Master BOM Templates editor; also reached via `?sku=` from sales/consignment)
  - `/products/:id/documents` → `src/pages/products/documents.tsx:87` (`ProductDocumentsPage` — production docs per variant)
  - Catalog is NOT a route — `ProductCatalog` (`src/pages/products/catalog.tsx:138`) renders inline as `viewMode==="catalog"` (`index.tsx:3921`)
  - Dialogs: `MasterPriceHistoryDialog.tsx:61`, `MaintenanceConfigHistoryDialog.tsx:365` (+ `MaintenanceConfigSaveModal:59`, `EffectiveDateConfirmModal:210`), `MaintenanceItemHistoryDialog.tsx:62`
- **API routes**
  - `/api/products` → `src/api/routes/products.ts` (1148) — core CRUD, nested `bomComponents`+`deptWorkingTimes`, master price history
  - `/api/customer-products` → `src/api/routes/customer-products.ts` (1122) — per-customer SKU + price overrides
  - `/api/bom` → `src/api/routes/bom.ts` (1454) — `/` = `bom_versions`, `/templates` = `bom_templates` (declared BEFORE `/:id`)
  - `/api/bom-master-templates` → `src/api/routes/bom-master-templates.ts` (243) — master template presets CRUD
  - `/api/product-configs` → `src/api/routes/product-configs.ts` (88) — read-only per-product dept config lookup
  - `/api/maintenance-config` → `src/api/routes/maintenance-config.ts` (248) — append-only effective-dated config
  - `/api/mdm` → `src/api/routes/mdm.ts` (248) — detection-only review queue

## Data model
- `products` — SKU master. JSON columns `subAssemblies`/`pieces`/`seatHeightPrices` are parsed back to objects on read.
- `bom_components` / `dept_working_times` — per-SKU children, JOINed and returned as nested arrays (denormalized read shape).
- `product_prices` — **master** price history, effective-dated (resolver picks newest `WHERE effective_from <= asOf`).
- `product_dept_configs` — per-product department config lookup (unitM3, fabric usage, per-dept category+minutes). Read-only via `/api/product-configs`.
- `customer_products` / `customer_product_prices` — per-customer SKU + its own effective-dated price history that **shadows** the master.
- `bom_versions` — versioned BOM records (`/api/bom`). `bom_templates` — reusable component recipes (`/api/bom/templates`).
- `bom_master_templates` — category-scoped preset templates (one `isDefault` per category).
- `maintenance_config_history` — full-config JSON per scope per effective date; **append-only** (edits = new rows).
- `mdm_review_queue` (+ `kv_config`) — detected duplicate flags; resolving only sets `status`/`resolvedAt`, never rewrites the underlying rows.
- Relationships: `customer_products` inherit `products` pricing unless overridden; `bom_components` feed BOM-explosion minutes (shared with production).

## Core flows
1. **Create/edit product** — `app.post("/")` `products.ts:491`, `app.put("/:id")` `products.ts:637`. Both replace-in-full the nested `bomComponents` (`:772`) and `deptWorkingTimes` (`:806`) sets when provided; `rowToProduct` (`:155`) re-nests children + parses JSON columns on read. Column self-apply via `ensureProductCreatedAtColumn` (`:22`).
2. **Master price change** — `app.post("/:productId/prices")` `products.ts:990` appends an effective-dated row; `resolveProductPriceAsOf` (`:905`) picks the newest `<= asOf`; history read at `app.get("/:productId/price-history")` `:968`. Surfaced in `MasterPriceHistoryDialog`.
3. **Per-customer price (inherit-or-override)** — `customer-products.ts` `resolvePrices` (`:95`) returns master price when the override column is NULL, override value when non-null. List GET (`:113`) also flags a `masterPending` future master change (`:189`) so the UI can warn inherited customers. Append price via `app.post("/:customerProductId/prices")` `:434`.
4. **BOM templates (bulk replace)** — `app.put("/templates")` `bom.ts:377` does DELETE-ALL + INSERT-ALL in one D1 batch; single-row upsert at `app.put("/templates/:id")` `:484`. Master presets: `bom-master-templates.ts` upsert `:101`, bulk replace `:190` (clears sibling `isDefault` per category).
5. **Maintenance config (effective-dated)** — `app.post("/changes")` `maintenance-config.ts:174` appends a new full-config row; `resolveMaintenanceConfigAsOf` (`:66`) resolves newest `<= today` and reports the next pending effective date. `GET /resolved` `:120`, `GET /history` `:141`.
6. **MDM detection + resolve** — `app.post("/detection/run")` `mdm.ts:232` (admin-gated) runs `runMdmDetectionPass` (`src/api/lib/mdm-detect.ts`) to insert flags; `resolveRow` (`:148`) marks MERGED/DISMISSED — **closes the flag only**, does not merge records.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `ProductsPage` (default export) | `src/pages/products/index.tsx:1909` | 3-way view host; `viewMode` state at `:1912` |
| `VariantEditorDialog` | `src/pages/products/index.tsx:637` | Add/edit a product variant (mounted `:4949`) |
| `MaintenanceView` | `src/pages/products/index.tsx:1077` | Maintenance-config view (Edit/Save/Cancel) |
| `CustomerAssignmentsSection` | `src/pages/products/index.tsx:455` | Per-customer SKU assignment (expand row) |
| `ProductionConfig` / `CategoryBadge` | `src/pages/products/index.tsx:362 / 349` | Per-dept config display helpers |
| `ProductCatalog` | `src/pages/products/catalog.tsx:138` | Model-based photo grid (inline catalog view) |
| `rowToProduct` | `src/api/routes/products.ts:155` | Re-nests children + parses JSON columns on read |
| `app.post("/")` / `app.put("/:id")` | `src/api/routes/products.ts:491 / 637` | Product create / edit (full-replace children) |
| `resolveProductPriceAsOf` | `src/api/routes/products.ts:905` | Master price effective-dated resolver |
| `app.post("/:productId/prices")` | `src/api/routes/products.ts:990` | Append master price history row |
| `resolvePrices` | `src/api/routes/customer-products.ts:95` | Inherit-or-override price resolution |
| `app.put("/templates")` | `src/api/routes/bom.ts:377` | Bulk-replace `bom_templates` (DELETE-ALL + INSERT-ALL) |
| `app.put("/templates/:id")` | `src/api/routes/bom.ts:484` | Single-template upsert |
| `app.put("/:id")` (master) | `src/api/routes/bom-master-templates.ts:101` | Master preset upsert (clears sibling isDefault) |
| `resolveMaintenanceConfigAsOf` | `src/api/routes/maintenance-config.ts:66` | Newest-as-of-today config resolver |
| `app.post("/changes")` | `src/api/routes/maintenance-config.ts:174` | Append effective-dated config row |
| `resolveRow` | `src/api/routes/mdm.ts:148` | Mark queue row MERGED/DISMISSED (flag only) |

## Gotchas
- **Read/write shape must stay symmetric.** `products.ts` returns DENORMALIZED nested arrays (`bomComponents` + `deptWorkingTimes` JOINed from child tables) and parses `subAssemblies`/`pieces`/`seatHeightPrices` JSON back to objects on read — POST/PUT replace those children in full, so keep the two sides in lockstep.
- **`customer_products` NULL means INHERIT, not zero.** In `basePriceSen`/`price1Sen`/`seatHeightPrices`, NULL inherits the global master price and a non-null value WINS. Never write `0` when you mean "inherit". This mirrors the Products bulk-edit `dirtyEdits` pattern in `customers.tsx CustomerProductsPanel` — keep in sync, don't fork.
- **Two separate price tables.** Master price lives in `product_prices` (`MasterPriceHistoryDialog`); per-customer overrides in `customer_product_prices`. Reconcile BOTH when changing pricing; a future master change is surfaced to inherited customers as `masterPending`.
- **maintenance-config & master price are APPEND-ONLY effective-dated.** Edits create NEW rows; the resolver picks newest `WHERE effective_from <= today`. Never UPDATE-in-place. The POST endpoint is `/changes` (not `/history` despite older header comments).
- **`/api/bom/templates` MUST stay declared before `/:id`** or Hono's first-match router swallows `"templates"` as an `:id` param (`bom.ts:9`). The templates LIST response is ~1.95 MB — `rowToTemplateListItem` (`:87`) trims it; don't send full rows.
- **Catalog tiles are AUTO-DERIVED** from each distinct `baseModel` in `products` (no dedicated table); `baseProductCode` splits on the first dash (`index.tsx:34`). Modular photos go through `/api/files` `resourceType=modular`, not a products column — and `files.ts` serves them with attachment disposition yet `<img>` still renders, so don't change that disposition.
- **MDM is DETECTION-ONLY.** `merge`/`dismiss` just close the flag (set `status`); the real record merge happens in the existing customer/supplier UI. Detection-run is admin-gated to stop non-admins flooding the queue.
- **camelCase columns need a `column-rename-map.json` entry** (`basePriceSen`, `seatHeightPrices`, `effectiveFrom`, …) or the write 400s "Invalid request body". Prefer snake_case for NEW columns; read dual-keyed `r.camelCase ?? r.snake_case`.
- **`index.tsx` is a 5068-line single page** — three views share one `ProductsPage` (`:1909`); `MaintenanceView` (`:1077`) and `VariantEditorDialog` (`:637`) are large sub-components ABOVE the default export, not separate files.

## Common tasks (mini-playbook)
- **Add a field to a product** → column self-apply near `ensureProductCreatedAtColumn` (`products.ts:22`); persist in `app.post("/")` (`:491`) + `app.put("/:id")` (`:637`); surface in `rowToProduct` (`:155`); render in `VariantEditorDialog` (`index.tsx:637`). New column = snake_case (+ rename-map if camelCase). Verify BOM math with `tests/bom-explosion.test.mjs`.
- **Change master or per-customer pricing** → master history in `products.ts` (`resolveProductPriceAsOf:905`, POST `:990`); per-customer in `customer-products.ts` (`resolvePrices:95`, POST `:434`). Append, never update; reconcile both tables.
- **Edit BOM templates** → `bom.ts` templates block (bulk `:377`, single upsert `:484`); presets in `bom-master-templates.ts` (`:101`/`:190`). Keep `/templates` before `/:id`.
- **Change maintenance defaults** → append via `maintenance-config.ts` POST `/changes` (`:174`); resolver `:66`. Never mutate old rows (old-SO safety banner: `MaintenanceConfigHistoryDialog.tsx:33`).
- **Tune MDM detection** → logic lives in `src/api/lib/mdm-detect.ts` (`runMdmDetectionPass`), not the route; the route only queues + resolves flags.

## Related modules
[[sales]] [[procurement]] [[production]] [[inventory]] [[accounting]]
