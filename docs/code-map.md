# Code Map

A guide to where things live in the Hookka ERP repo. Pair with
`docs/INVENTORY-WIP-FLOW.md` for cascade specifics and
`docs/BUG-HISTORY.md` for known issues per area.

The categories here match the `**Category:**` tag on each entry in
`docs/BUG-HISTORY.md` — so a reader can jump from a bug entry → the
relevant code area → the file map for that area.

## Categories

### inventory-cascade

Concerned with how `wip_items.stock_qty` evolves as job_cards
complete: producer-add, consume, rollback, UPH branch-terminal logic,
DO dispatch decrement, and idempotency guards.

- `src/api/routes-d1/production-orders.ts` — `applyWipInventoryChange()`
  is the cascade engine: forward consume, producer-upsert, UPH
  per-branch-terminal consume, rollback (`wasDone && !isDone`), and
  the `prevStatus === newStatus` short-circuit.
- `src/api/routes-d1/production-orders.ts` — `cascadeUpholsteryToSO`
  + `cascadeUpholsteryRollbackToSO` (forward + reverse SO status
  cascade gated on UPH completion).
- `src/api/routes-d1/delivery-orders.ts` — DO Dispatch decrement
  (`stampedOnDispatch`) and LOADED→DRAFT re-credit (`revertedToDraft`).
- `src/api/routes-d1/_fabric-cascade.ts` — sofa (SO, fabric)
  atomic-zero of every FAB_CUT row when first FAB_SEW completes.
- `src/api/lib/bom-wip-breakdown.ts` — `resolveWipTokens`,
  `BomVariantContext` with `model`/`productCode` distinction.
- `tests/production-wip-producer-output.test.mjs` — structural pins
  for cascade behaviour (no MAX clamp, insert-on-missing, idempotency
  guard).
- `scripts/resync-wip-labels.ts` — one-off migration that renamed
  `wip_items.code` + JC `wip_label/code/key` after the model-vs-variant
  fix.
- See: BUG-HISTORY entries tagged `inventory-cascade`.

### inventory-display

WIP grid + FG view rendering: which rows show up, what qty is
displayed, how sources/age/cost are rolled up, label formatting.
Distinct from `inventory-cascade`: this is the read path, not the
write path.

- `src/api/routes-d1/inventory-wip.ts` — main WIP read endpoint;
  contains the per-PO UPH-fully-complete filter, per-PO attribution
  for shared wipLabels, immediate-downstream source derivation for
  negative rows, baseModel heuristic, FAB_CUT label override, sources
  population for sofa SET rows.
- `src/api/routes-d1/inventory.ts` — generic inventory list endpoint.
- `src/api/routes-d1/fg-units.ts` — `generateFGUnitsForPO`,
  `postProductionOrderCompletion` write the FG-units rows; PACKED
  default status; LOADED/DELIVERED/RETURNED transitions.
- `src/pages/inventory/index.tsx` — WIP page UI (rows, dialogs,
  Merged-vs-Pieces toggle, sources dialog).
- `src/pages/warehouse.tsx` — Finished Products tab driven by
  `deriveFGStock` (frontend roll-up of UPH-fully-complete POs).
- `src/lib/wip-name.ts` — WIP label formatting helpers shared between
  Production and Inventory views.
- See: BUG-HISTORY entries tagged `inventory-display`.

### bom

BOM templates, master templates, the cushion/base/armrest subtree,
the Dept-Pivot Category Editor, version status, retro migrations.

- `src/api/routes-d1/bom.ts` — CRUD for `bom_templates`; PUT-as-upsert
  for the Create-from-Default flow.
- `src/api/routes-d1/bom-master-templates.ts` — master template CRUD
  + apply-to-products.
- `src/api/lib/bom-wip-breakdown.ts` — turns a BOM template + variant
  context into the wipLabel / wipCode / wipKey trio; `{MODEL}` vs
  `{PRODUCT_CODE}` distinction.
- `src/pages/bom.tsx` — BOM editor, Master Template editor, Dept-Pivot
  Category Editor, version status flow.
- `migrations/0006_bom_master_templates.sql`, `0043_fix_divan_bom_qty.sql`,
  `0044_revert_divan_bom.sql` — schema + retro fixes.
- `scripts/recover-bom-master-templates.ts`,
  `scripts/restore-bom-templates-and-apply-masters.ts`,
  `scripts/upload-recovered-masters.ts`,
  `scripts/reapply-masters-to-bedframes.ts`,
  `scripts/reapply-masters-to-sofas.ts` — recovery + reapply
  utilities.
- See: BUG-HISTORY entries tagged `bom`.

### production-orders

PO lifecycle: confirm → JC creation → status transitions → completion.
JC reconciliation, dept routing on the Production page, sofa merge
view, scan-complete, branchKey, fan-out for qty>1.

- `src/api/routes-d1/production-orders.ts` — PO CRUD, `applyPoUpdate`
  (PATCH gateway), the upstream-sequence lock, scan-complete branch.
- `src/api/routes-d1/job-cards.ts` — JC CRUD, `branch_key` writes.
- `src/api/routes-d1/jobcard-sync.ts` — POST
  `/api/production/sync-jobcards-from-bom` reconciles JCs against the
  current BOM template, including renaming wipLabel/wipCode/wipKey on
  WAITING rows (BUG-2026-04-27-004).
- `src/api/routes-d1/scan-po.ts` — QR scan endpoint for completing JCs
  from the floor.
- `src/api/lib/lead-times.ts` — schedules `sched_*` due-dates as
  parallel offsets from delivery date.
- `src/pages/production/index.tsx`, `dept.tsx`, `department.tsx`,
  `overview.tsx`, `tracker.tsx`, `scan.tsx`, `fg-scan.tsx` — per-dept
  views, merged Fab Cut, QR fan-out, upstream-dept date pills.
- `src/lib/production-order-builder.ts` — `createProductionOrdersForSO`
  used at SO confirm.
- `migrations/0040_po_status_composite.sql`,
  `0041_retro_fab_cut_consume.sql`, `0042_retro_all_dept_consume.sql`,
  `0058_job_cards_branch_key.sql` — schema/index/backfill.
- `tests/production-wip-producer-output.test.mjs` — see also
  `inventory-cascade`.
- See: BUG-HISTORY entries tagged `production-orders`.

### delivery-orders

DO flow: pending-delivery selection, multi-SO/PO grouping, DRAFT →
LOADED → IN_TRANSIT → DELIVERED transitions, POD photos, racking,
dispatched count.

- `src/api/routes-d1/delivery-orders.ts` — DO CRUD, status
  transitions, multi-customer guard, customerId fallback,
  stampedOnDispatch / revertedToDraft branches (also see
  `inventory-cascade`).
- `src/pages/delivery/index.tsx`, `detail.tsx` — DO list, Pending
  Delivery selection (live vs snapshot), POD-dialog photo resize,
  Items / Total M³ columns.
- `src/components/delivery/` — DO detail components, including POD
  capture.
- `src/api/lib/do-cost-cascade.ts` — DO → cost_ledger emission.
- `src/lib/generate-do-pdf.ts`, `generate-packing-pdf.ts` — DO + PL
  PDF rendering.
- `migrations/0060_do_driver_contact.sql` — driver contact on DO row.
- See: BUG-HISTORY entries tagged `delivery-orders`.

### sales-orders

SO confirm cascade, status transitions, BOM completeness check,
qty>1 fan-out, special-order propagation, picker behaviour, mutation
guards.

- `src/api/routes-d1/sales-orders.ts` — SO CRUD, confirm flow that
  spawns POs + JCs, status cascade hooks, customerProducts join.
- `src/api/routes-d1/customers.ts`,
  `src/api/routes-d1/customer-hubs.ts`,
  `src/api/routes-d1/customer-products.ts` — customer / hub /
  customer-product price overrides.
- `src/pages/sales/index.tsx`, `create.tsx`, `edit.tsx`, `detail.tsx`
  — list (with filter clear), create/edit forms (size dropdowns,
  variant config, special-order toggle, product picker), detail.
- `src/lib/so-category.ts` — SO category classification (Sofa /
  Bedframe / Accessory / mixed forbidden rules).
- `src/lib/pricing.ts` — sofa seat-height pricing, variant surcharges.
- `src/lib/production-order-builder.ts` — see also `production-orders`.
- See: BUG-HISTORY entries tagged `sales-orders`.

### auth-rbac

Login, permissions, role updates, OAuth, KV session cache, worker
PINs, sidebar identity.

- `src/api/routes-d1/auth.ts`, `auth-oauth.ts`, `auth-totp.ts`,
  `worker-auth.ts` — login, OAuth, TOTP, worker token paths.
- `src/api/routes-d1/users.ts` — user/role mutations; KV invalidation
  on role change / delete / logout.
- `src/api/lib/auth-middleware.ts`, `auth-utils.ts`, `authz.ts`,
  `rbac.ts`, `password.ts`, `totp.ts`, `kv-cache.ts` — auth and RBAC
  primitives.
- `src/pages/login.tsx`, `InviteAccept.tsx` — login + invite-accept
  flows.
- `src/components/RequireAuth.tsx` — route guard.
- `src/components/layout/` — sidebar (current-user identity).
- `src/lib/auth.ts` — `getCurrentUser` reader.
- `migrations/0002_auth.sql`, `0003_seed_admin.sql`, `0012_hash_worker_pins.sql`,
  `0045_rbac.sql`, `0048_worker_sessions.sql`, `0053_oauth_identities.sql`,
  `0054_user_totp.sql` — auth schema.
- `tests/authz.test.mjs`, `permissions.test.mjs`,
  `security-permission-matrix.test.mjs`, `worker-auth.test.mjs`,
  `worker-auth-default-protect.test.mjs` — auth/RBAC pins.
- See: BUG-HISTORY entries tagged `auth-rbac`.

### data-migration

Schema migrations, D1 → Postgres compat (IFNULL/COALESCE, LIKE/ILIKE,
BIGINT coercion, column casing), seed scripts, retro backfills.

- `migrations/*.sql` — versioned D1 schema changes (66 files at time
  of writing).
- `migrations-postgres/` — Postgres mirror.
- `src/api/lib/d1-compat.ts`, `db-pg.ts`,
  `src/api/lib/column-rename-map.json` — Postgres compat helpers,
  acronym casing preservation, BIGINT coercion.
- `scripts/d1-to-postgres.mjs`, `apply-postgres-migrations.mjs`,
  `import-d1-data-to-supabase.mjs`, `verify-import.mjs` — migration
  pipeline.
- `scripts/seed-from-production-sheet.ts`, `chunk-seed.ts`,
  `generate-seed-sql.ts`, `seed.sql` — seeding (note: `seed.sql` lives
  *outside* `migrations/` after BUG-2026-04-23-001).
- `scripts/migrate-orders-from-trackers.ts`,
  `inspect-bf-tracker-headers.ts`, etc. — order migration from BF/SF
  master trackers.
- See: BUG-HISTORY entries tagged `data-migration`.

### ui-frontend

DataGrid virtualizer correctness, column toggle/customizer, filter
clearing, alignment, ErrorBoundary, route nesting, tab persistence,
generic page UX not specific to one domain.

- `src/components/ui/` — shadcn-style primitives + DataGrid,
  virtualizer wiring (`paddingBottom`, `getVirtualItems`,
  `VIRTUALIZE_MIN_ROWS`).
- `src/lib/use-url-state.ts`, `use-session-state.ts` — URL/session
  state hooks used for tab persistence and atomic filter clearing.
- `src/router.tsx`, `dashboard-routes.tsx` — route tree (trailing
  `/*` for nested routes).
- `src/components/layout/` — page layout, sidebar, header.
- `src/pages/_root.tsx` — top-level shell + per-page ErrorBoundary.
- `src/pages/reports.tsx`, `analytics`, `dashboard`, etc. — generic
  pages.
- `tests/url-state.test.mjs`, `tabs-cap.test.mjs` — pins.
- See: BUG-HISTORY entries tagged `ui-frontend`.

### infrastructure

Build, deploy, CI, Cloudflare bindings, Hyperdrive/Supavisor, KV
cache namespaces, HTTP cache headers, bundle, env declaration.

- `wrangler.toml`, `wrangler-dev.log` — Cloudflare Worker config.
- `src/api/index.ts`, `worker.ts` — worker entry, mounts the
  routes-d1 routers under `/api/*`.
- `src/api/lib/db-pg.ts` — Hyperdrive/Supavisor connection
  (`prepare:false` for 6543).
- `src/api/queues/`, `src/api/lib/queue-po-emission.ts` —
  Cloudflare Queues for async PO emission.
- `src/api/lib/supabase-storage.ts` — Supabase Storage REST wrapper
  (was `r2-store.ts` before the storage-supabase-migration).
- `src/api/cron/daily-backup.ts` — cron handler.
- `src/lib/cached-fetch.ts`, `swr-fetcher.ts`,
  `use-version-check.ts` — frontend cache behaviour (TTL, namespace
  bumping, deploy-version toast).
- `vite.config.ts`, `package.json` scripts — build + bundle.
- `scripts/check-bundle-size.mjs`, `test-d1-compat.mjs` — CI gates.
- `tests/smoke.test.mjs` — top-level smoke.
- `docs/CANARY-DEPLOY.md`, `docs/QUEUES-SETUP.md`,
  `docs/CLOUDFLARE_MIGRATION.md`, `docs/STORAGE-SETUP.md` — runbooks.
- See: BUG-HISTORY entries tagged `infrastructure`.

### audit-logging

`job_card_events`, `audit_events`, `so_status_changes`, `cost_ledger`,
observability/Server-Timing, dead-letter handling.

- `src/api/lib/audit.ts`, `job-card-events.ts`, `observability.ts` —
  audit primitives, Server-Timing emission.
- `src/api/lib/po-cost-cascade.ts`, `do-cost-cascade.ts` — cost_ledger
  writes downstream of PO/DO completion.
- `src/api/routes-d1/cost-ledger.ts` — read endpoint.
- `migrations/0039_job_card_events.sql`, `0046_audit_events.sql`,
  `0051_journal_entries.sql` — audit schema.
- `tests/audit.test.mjs` — pins.
- See: BUG-HISTORY entries tagged `audit-logging`.

### data-integrity

Silent HTTP failure guards on mutations, localStorage staleness,
kv_config save round-tripping, defensive try/catch at crash sites,
no-store cache headers, orphan record cleanup.

- `src/lib/fetch-json.ts` — adds res.ok + JSON envelope checks +
  timeout/abort propagation.
- `src/lib/cached-fetch.ts` — SWR fetcher behaviour (always-refetch,
  drop TTL gate).
- `src/api/routes-d1/kv-config.ts`, `src/lib/kv-config.ts` —
  kv_config storage shape (sofa sizes, variants, gaps).
- `src/lib/safe-json.ts`, `validation.ts` — defensive parsing.
- `src/lib/job-card-persistence.ts` — JC mutation wrappers.
- See: BUG-HISTORY entries tagged `data-integrity`.

### pricing-products

Variant/seat-height/gap/divan-height pricing, surcharge handling,
SKU master prices, product picker behaviour, customer products panel.

- `src/api/routes-d1/products.ts` — product CRUD, variants,
  seatHeightPrices.
- `src/api/routes-d1/product-configs.ts` — config keys (sofa sizes,
  gaps, variants).
- `src/api/routes-d1/customer-products.ts` — per-customer overrides.
- `src/api/routes-d1/price-history.ts` — price-history audit.
- `src/lib/pricing.ts` — pricing roll-up logic (base + surcharges +
  seat-height tier).
- `src/pages/products/` — Products page, Maintenance tab,
  variants/sizes editors.
- `src/pages/customers.tsx` — Customer Products panel.
- `migrations/0028_price_corrections.sql`,
  `0030_sofa_price_corrections_v10.sql`,
  `0031_sofa_seatheight_string_keys.sql`,
  `0036_customer_product_prices.sql` — pricing data fixes.
- See: BUG-HISTORY entries tagged `pricing-products`.

### scheduling

Lead times (parallel reverse-schedule), planning page, recalc-all,
upstream-sequence locks scoped to wipKey.

- `src/api/routes-d1/production-leadtimes.ts` — Planning page
  GET/PUT (mounted at `/api/production/leadtimes` AND the legacy
  `/api/production-leadtimes`).
- `src/api/routes-d1/scheduling.ts`,
  `src/api/lib/lead-times.ts` — schedule application, recalc-all.
- `src/lib/scheduling.ts`, `scheduler.ts` — frontend helpers.
- `src/pages/planning/` — Planning page.
- `tests/scheduler.test.mjs` — pins.
- See: BUG-HISTORY entries tagged `scheduling`.

### bug-history-meta

Doc-level changes to `BUG-HISTORY.md` itself (categorization,
re-numbering, reformatting). Use sparingly — most bug entries are
about code, not the doc.

- `docs/BUG-HISTORY.md` — this file's structure.
- `docs/code-map.md` — paired index (this document).
- See: BUG-HISTORY entries tagged `bug-history-meta`.

## Conventions

**File naming.** Backend route handlers go in
`src/api/routes-d1/<area>.ts`. The legacy `src/api/routes/<area>.ts`
mirrors are deprecated stubs kept around for the type signatures —
new work lands in `routes-d1/`.

**Backend mount.** All `routes-d1/*` modules are Hono routers mounted
under `/api/*` from `src/api/index.ts` (worker entry). Static routes
must be registered before `/:id` wildcards or they get swallowed (see
the Hono route-ordering note in the project's
`memory/technical_hono_route_ordering.md`).

**Page → API pairing.** Frontend pages under `src/pages/<area>/` are
typically backed by the same-named module in `src/api/routes-d1/`.
Cross-area joins (e.g. SO → PO → JC → wip_items) are handled inside
the backend handlers.

**Shared primitives.** Everything under `src/lib/` is frontend-side;
everything under `src/api/lib/` is backend/worker-side. Schemas live
in `src/lib/schemas/` (Zod, passthrough) and are used at the fetch
boundary by `fetchJson`.

**Migrations.** D1 migrations are numbered `migrations/00NN_*.sql`
and applied in order by Wrangler. The Postgres mirror lives at
`migrations-postgres/`. Note: `seed.sql` lives at the repo root /
inside `scripts/` — *not* in `migrations/` — so CI doesn't retry it
as a migration on every deploy (BUG-2026-04-23-001).

**Tests.** Vitest. Each test file pins one structural invariant
(usually a regex grep over a route handler) so a refactor that
silently removes the invariant fails CI. See
`tests/production-wip-producer-output.test.mjs` for the pattern.

**Scripts.** `scripts/*.ts` are one-off ops scripts run with `tsx` or
`node --import=tsx/esm`. Anything starting with `inspect-`, `check-`,
`verify-`, or `dryrun-` is read-only diagnostic. Anything starting
with `apply-`, `reapply-`, `restore-`, `resync-`, `rebuild-`,
`backfill-`, `import-`, `migrate-`, `chunk-`, `delete-`, `fix-`,
`hold-`, `normalize-`, `reset-`, or `sync-` is a write op — review
before running.
