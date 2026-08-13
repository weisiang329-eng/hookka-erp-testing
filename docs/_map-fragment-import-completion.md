# Map fragment — Historical Import & Backfill (`/api/import`)

> **Last verified: 2026-08-13** — every claim below was read out of the code, not out of the
> header comments above each handler. All 65 handlers, all 9 files (15,279 lines) were opened;
> route lines, permission gates, dry-run defaults, SQL write statements and idempotency guards
> were each checked at the line cited. Helper idempotency was chased into
> `src/api/lib/po-cost-cascade.ts` and `src/api/routes/production-orders/_helpers.ts`.
>
> **This section is a fragment for assembly into `docs/CODEBASE-MAP.md`.** It exists because the
> map has never mentioned this family — ~15k lines that no reader could find.

---

## Historical Import & Backfill (`/api/import` — one-shot migration endpoints)

**Status: (a) LIVE AND CALLABLE — every one of the 65 handlers.** None is dead code, none is
commented out, none is feature-flagged. The barrel `src/api/routes/import-completion.ts` (65
lines) mounts all eight sub-routers at `/` (`import-completion.ts:56`-`:63`) and
`src/api/worker.ts:1411` mounts that barrel at `/api/import` — **after** the global auth gate at
`src/api/worker.ts:913`, and `/api/import` is in no PUBLIC_PATHS/PUBLIC_PREFIXES list. So every
endpoint requires a logged-in session, and 64 of 65 additionally call `requirePermission`.

**No frontend page calls any of them** — there is no UI surface. The only callers in the tree are
11 hand-run driver scripts (`scripts/import-historical-purchases.py`,
`scripts/import-prod-completions-2026-04-30.mjs`, `scripts/fix-so-088.mjs`,
`scripts/smoke-*.mjs`, `scripts/sweep-audit-po-alignment.mjs`,
`scripts/summarize-regen-fg-units.mjs`). They are written as one-shots for the 2026-04→08
data migration — several hard-code a document id (`/backfill-5543-co2606002`) or a date clamp —
but **the code cannot tell you whether a given one already ran, and nothing prevents it running
again.** Treat every entry here as a loaded gun that is still on the table.

| File | Lines | What it does | Endpoints | Tests |
|---|---|---|---|---|
| `src/api/routes/import-completion/_shared.ts` | 2109 | No routes. Types, constants, lookup helpers, and `processRow` — the per-row engine that flips a JC to COMPLETED and fires the WIP + labor + PO-completion cascades | 0 | **NONE** |
| `src/api/routes/import-completion/wip-fixes.ts` | 2890 | WIP-inventory repair: pofold backfills, refund/dedupe/zero/rebuild of `wip_items`, JC time + label refresh, JC/FG deletes | 11 | **NONE** |
| `src/api/routes/import-completion/procurement-backfills.ts` | 2384 | Supplier/binding seeding, historical PO+GRN+PI+stock import, PO status recompute, PO line-no + SKU backfills | 12 | `tests/sql-identifier-safety.test.mjs:84` (dropped-column guard only) |
| `src/api/routes/import-completion/sofa-pricing.ts` | 1950 | Price-history seeding, the Houzs sofa price sheet, SO/CO sofa re-pricing and total resync, size/leg-height migrations | 9 | `tests/sofa-combo-drift-guard.test.mjs` (guards the *canonical* engine, not these routes — see gotchas) |
| `src/api/routes/import-completion/so-co-do-backfills.ts` | 1802 | DO migration from Excel, DO revert, SO field backfills (expected DD, product name, reference, OCR fields), PO rebuild, line-qty cascade | 11 | **NONE** |
| `src/api/routes/import-completion/fg-fabric.ts` | 1679 | FAB_CUT merge, FC label refresh, multi-qty PO split, fabric-code audit/fix, `fg_units` delete/regen, pillow PACKING JC | 8 | **NONE** |
| `src/api/routes/import-completion/date-fixes.ts` | 1013 | Maintenance-history sync, snapshot cleanup, misparsed DD/MM date repair, full-width paren normalisation, `updated_at` indexes, punch autofill | 7 | **NONE** |
| `src/api/routes/import-completion/completion-cascades.ts` | 962 | The original importer (`/job-card-completion`) plus the anchor-relative cascade fills and the future-date cleanup | 4 | **NONE** |
| `src/api/routes/import-completion/audits.ts` | 490 | Read-only integrity probes (PO duplicates, procurement invariants, SO↔PO alignment) | 3 | **NONE** |

### 🚩 Read this before calling anything here

1. **`/backfill-fabcut-rm-issue` (`wip-fixes.ts:1843`) has NO `requirePermission` call** — it is the
   only handler in the family without one, and it is one of the handlers that moves raw-material
   **stock and money** (`rm_batches`, `raw_materials.balanceQty`, `cost_ledger` RM_ISSUE, via
   `consumeRawMaterialsForPO` — `src/api/lib/po-cost-cascade.ts:671`). Any authenticated user of
   any role can fire it. It is *safe on re-run* (see below), but the missing gate is real: line
   1844 goes straight to `const dryRun = …` with no `denied` check above it.
2. **Most endpoints default to LIVE WRITE.** The dominant idiom is
   `c.req.query("dryRun") === "true"`, which means **a bare POST with no query string and no body
   writes to production.** Only 6 of 65 use the safe `!== "false"` / `!== false` form, and
   **6 have no dry-run code path at all**. The four different dryRun spellings in this family
   (`=== "true"`, `!== "false"`, `body.dryRun === true`, `body.dryRun !== false`) mean muscle
   memory from one endpoint produces a live write on the next.
3. **Two endpoints are NOT idempotent and corrupt data on a second run** — see the table below.
4. **Test coverage is essentially zero.** Two test files touch this family and neither exercises a
   handler. Nothing else in `tests/` does.

### The non-idempotent ones (a second run does damage)

| Endpoint | Why it breaks | Undo |
|---|---|---|
| `/refund-backfill-overconsume` `wip-fixes.ts:590` | `wip-fixes.ts:824` is `UPDATE wip_items SET stockQty = stockQty + ?` — a raw delta with no marker row. The candidate SELECT keys on fields the endpoint never mutates, so run #2 builds the identical plan and credits every WIP label a second time. Defaults to LIVE (`:595`). | `?revert=true` (`:801`) flips the sign — the built-in one-shot undo |
| `/queen-price-correction-rm5` `sofa-pricing.ts:315` | `sofa-pricing.ts:454` binds `r.basePriceSen - 500` and `:412` computes `active.basePriceSen - 500` — read-then-subtract off *current* DB state. Every run removes another RM5 from every Queen `product_prices` row at `effectiveFrom='2026-04-26'` and from each customer's active price row. Defaults to LIVE (`:320`). Worse: the customer side targets "newest row with `effectiveFrom <= today`" (`:396`-`:401`), so the target row can change between runs. | none |

Also delta-shaped, but self-limiting rather than broken:
`/migrate-do-from-excel` (`so-co-do-backfills.ts:28`) appends `SET totalM3 = totalM3 + ?,
totalItems = totalItems + ?` at `so-co-do-backfills.ts:246`, and its skip guard
(`:122`) only fires when **every** PO of the SO is already migrated — a partially-migrated SO
double-adds its DO header totals and blind-INSERTs duplicate `delivery_order_items`
(`:282`, random id, no `ON CONFLICT`). `/correct-so-line-qty-cascade`
(`so-co-do-backfills.ts:1487`) computes `so.subtotalSen + lineTotalDelta` (`:1564`) but is saved by
a no-op guard at `:1539` plus a PO selector that stops matching after the first run.

### Endpoints that write money or stock tables

`cost_ledger` / `rm_batches` / `raw_materials` / `purchase_invoices` / `product_prices` /
`customer_product_prices` / `wip_items` / `fg_units` — anything below is a money or stock write.

| Endpoint | Money/stock tables written | Default | Re-run safe? |
|---|---|---|---|
| `/historical-purchases-backfill` `procurement-backfills.ts:330` | `purchase_orders` :489, `purchase_order_items` :519, `grns` :541, `grn_items` :569, **`rm_batches`** :593, **`cost_ledger`** :611, **`raw_materials`** :630, **`purchase_invoices`** :641, `purchase_invoice_items` :686 | **no dry-run exists — always live** | only via ONE guard: `SELECT id FROM purchase_invoices WHERE piNo = ?` at :412. See gotchas |
| `/backfill-fabcut-rm-issue` `wip-fixes.ts:1843` | `rm_batches`, `cost_ledger`, `raw_materials` (via `consumeRawMaterialsForPO`) | dry-run (`:1844` uses `!== "false"`) | **yes** — double-guarded (`NOT EXISTS` on the RM_ISSUE ledger row at :1864, plus the helper's own check at `po-cost-cascade.ts:681`) |
| `/refund-backfill-overconsume` `wip-fixes.ts:590` | `wip_items` :824 | **live** | **NO — double-credits** |
| `/dedupe-wip-items` `wip-fixes.ts:886` | `wip_items` UPDATE :1091, DELETE :1095 | **live** | yes (absolute `stockQty = ?`; the `HAVING COUNT(*) > 1` driver returns nothing on run #2) |
| `/zero-out-negative-wips` `wip-fixes.ts:1159` | `wip_items` :1206 (`SET stockQty = 0 WHERE stockQty < 0`) | **live** | yes (self-negating predicate) — but irreversibly destroys the negative balances that are the evidence of an upstream bug |
| `/rebuild-wip-from-jcs` `wip-fixes.ts:1219` | `wip_items` UPDATE :1741, INSERT :1749 (`ON CONFLICT … DO UPDATE`), DELETE :1767 | **live** | yes — full absolute rewrite recomputed from `job_cards` |
| `/queen-price-correction-rm5` `sofa-pricing.ts:315` | `product_prices` :453, `customer_product_prices` :458 | **live** | **NO — subtracts RM5 every run** |
| `/derive-historical-price-baselines` `sofa-pricing.ts:10` | `customer_product_prices` :234, `product_prices` :258 | **live** | yes (pre-existence SELECT at :227/:251, all rows pinned to `PRICE_BASELINE_DATE`) |
| `/apply-houzs-sofa-pricesheet` `sofa-pricing.ts:481` | `product_prices` :588/:597, `customer_product_prices` :631/:640, `customer_products` :657, `products` :674 | **live**, `scope` defaults to `both` | yes — values come from a static in-code sheet, `effectiveFrom` hard-coded |
| `/recompute-so-sofa-prices` `sofa-pricing.ts:689` | `sales_order_items` :1165, `sales_orders` :1200 | **live**, all active statuses | yes arithmetically — but `:1204` binds `sub, sub`, forcing `totalSen = subtotalSen` and discarding any tax/discount |
| `/recompute-co-sofa-prices` `sofa-pricing.ts:1228` | `consignment_order_items` :1559, `consignment_orders` :1573 | **live** | same as above, same tax/discount flattening |
| `/resync-so-totals` `sofa-pricing.ts:1624` / `/resync-co-totals` `sofa-pricing.ts:1583` | `sales_orders` :1661 / `consignment_orders` :1605 | **live** | yes (absolute `SUM(lineTotalSen)`, skip-if-equal) — same `total := subtotal` flattening |
| `/correct-so-line-qty-cascade` `so-co-do-backfills.ts:1487` | `sales_order_items` :1766, `sales_orders` :1771, `production_orders` :1776, `job_cards` :1783 | **live** | delta-based but no-op-guarded — see above |
| `/rebuild-production-orders-from-soi` `so-co-do-backfills.ts:1211` | DELETE `fg_units` :1409, `job_cards` :1415, `production_orders` :1420, then rebuild | **live** | converges, but the FG stubs never come back — see gotchas |
| `/backfill-split-multi-qty` `fg-fabric.ts:516` | DELETE `fg_units` :805, `production_orders` :810, then rebuild | **live** | same FG-loss shape; pre-flight guards at :570/:588/:610/:637/:660 |
| `/delete-fg-units-by-ids` `fg-fabric.ts:1191` | DELETE `fg_units` :1259 | **live** (body with `unitIds`, no `dryRun`) | yes (explicit id list) — refuses DELIVERED/RETURNED/LOADED at :1229 |
| `/regen-fg-units` `fg-fabric.ts:1307` | DELETE `fg_units` :1415 + INSERT via `generateFGUnitsForPO` (`src/api/routes/fg-units.ts:326`) | dry-run (`:1317`) | converges but re-mints serials/ids each run |
| `/cleanup-headboard-only-divans` `wip-fixes.ts:2727` | DELETE `job_cards` :2839, `fg_units` :2855 | dry-run (`:2737`) | yes; skips COMPLETED JCs (:2831) and non-PENDING units (:2847) |
| `/job-card-completion` `completion-cascades.ts:17` + `/cascade-upstream-completion` `completion-cascades.ts:199` | `job_cards`, `production_orders`, then `wip_items` + `cost_ledger` (+ `fg_units`/`fg_batches`/`rm_batches` on PO completion) via the cascade helpers | **live** | yes — see the cascade-guard note below |
| `/cleanup-snapshot-from-master-rows` `date-fixes.ts:141` | DELETE `customer_product_prices` :177 | **live** | yes (`WHERE notes LIKE 'Snapshot from Master%'`) |
| `/normalize-fullwidth-parens` `date-fixes.ts:561` | `wip_items` merge `stockQty = stockQty + ?` :803 then DELETE :808, orphan rename :818 | **live** | yes — the merge is pair-driven and the full-width row is deleted in the same atomic `db.batch` (:824), so run #2 finds no pairs |

### Read-only endpoints (safe to call)

`audits.ts` is the only fully read-only file — all three handlers issue SELECTs and nothing else:
`GET /po-no-duplicates` `audits.ts:22`, `POST /audit-procurement-integrity` `audits.ts:44` (10
named invariant checks), `GET /audit-po-alignment` `audits.ts:441` (delegates to
`loadAndValidatePOAlignment` — `src/api/lib/po-alignment-validator.ts:228`, zero write statements
in that file). Also read-only despite its POST verb and `production-orders:update` gate:
`/audit-orphan-fabric-codes` `fg-fabric.ts:862`.

### Remaining endpoints (no money/stock table)

- `wip-fixes.ts` — `/uph-pofold-backfill` :14, `/fab-cut-pofold-backfill` :289 (both flip
  `job_cards` then fire the WIP + labor cascades), `/backfill-jc-production-time-from-bom` :1967
  (`includeCompleted` defaults **true**, so it rewrites minutes on already-COMPLETED cards),
  `/refresh-jcs-by-id` :2256, `/delete-jcs-by-ids` :2613 (refuses COMPLETED/TRANSFERRED at :2657).
- `procurement-backfills.ts` — `/cancel-leaked-co-pos` :24, `/suppliers-from-history` :110
  (no dry-run), `/supplier-bindings-from-history` :180 (no dry-run),
  `/backfill-supplier-material-bindings` :864, `/backfill-supplier-bindings-multi` :991,
  `/backfill-historical-grns` :1308 (writes `grns`/`grn_items` only, `NOT EXISTS`-guarded at
  :1338), `/recompute-po-status-progress` :1508, `/backfill-po-from-so-lines` :1699,
  `/append-missing-pos` :1999, `/backfill-po-line-no` :2129 (dry-run default),
  `/backfill-supplier-sku-1to1` :2304 (dry-run default).
- `so-co-do-backfills.ts` — `/migrate-do-from-excel` :28, `/revert-dos-to-draft` :335 (**no
  dry-run path; an empty POST reverts every LOADED DO to DRAFT**), `/backfill-so-expected-dd` :404,
  `/backfill-so-item-product-name` :444, `/backfill-5543-co2606002` :505 and
  `/backfill-complete-stray-jc-co2606002` :657 (both audit-first: need
  `{"apply":true,"confirm":…}`), `/backfill-downstream-product-names` :745 (touches
  `invoice_items.productName` at :812), `/backfill-so-reference` :830,
  `/backfill-ocr-so-fields` :953.
- `fg-fabric.ts` — `/backfill-fab-cut-merge` :13 (DELETEs sibling `job_cards` at :256 including
  COMPLETED ones), `/backfill-fc-label-refresh` :283, `/apply-fabric-code-fixes` :1008,
  `/backfill-pillow-packing-jc` :1470 (DELETEs PACKING `job_cards` at :1597 with no status guard,
  then blind-INSERTs at :1605).
- `date-fixes.ts` — `/sync-maintenance-history-from-kv` :23, `/fix-misparsed-jan-dates` :192,
  `/fix-misparsed-dates` :376 (dry-run default), `/create-updated-at-indexes` :860 and
  `/backfill-punch-autofill-blocked` :934 (both audit-first, gated `users:create` +
  `{"apply":true,"confirm":…}`).
- `completion-cascades.ts` — `/clear-future-completions` :129, `/cascade-leak-pass` :683.

**Gotchas**

- **`/historical-purchases-backfill` (`procurement-backfills.ts:330`) is the single widest blast
  radius in the repo's backfill surface and has no dry-run.** It writes nine tables including
  `cost_ledger`, `rm_batches` and `raw_materials` (`balanceQty = balanceQty + ?` at :630 — a blind
  delta), in one atomic `db.batch` at :706. Its *only* duplicate defence is a pre-existence check
  on the invoice number (`piNo`) at :412. Everything else uses fresh random UUIDs (:475-:480), so
  the "deterministic" ids (`rmb-grn-${grnId}-…` :587) are derived from a random parent and are not
  stable dedupe keys across runs. Consequences that follow directly from that: the same physical
  invoice under a renamed `docNo` duplicates PO+GRN+batch+ledger and adds stock twice; deleting or
  voiding the PI row and re-running does the same; and a first run with `skipStock:true` still
  writes the PI, so the corrective re-run with `skipStock:false` is **skipped and the stock never
  lands** (silent under-apply). `poNo` is deterministic (`PO-IMPORT-${docNo}` :476) but is never
  checked in this loop.
- **The WIP + labor cascades ARE replay-guarded, but only when `orgId` is threaded.**
  `applyWipInventoryChange` (`src/api/routes/production-orders/_helpers.ts:2574`) claims an
  idempotency ticket by INSERTing into `wip_cascade_log` (:2645) and returns early when it loses
  the race — but that whole block is wrapped in `if (options.orgId)` at :2635. `processRow`
  (`src/api/routes/import-completion/_shared.ts:317`) passes `{ orgId, source: "BACKFILL" }` at
  :529 and `/cascade-upstream-completion` passes it at `completion-cascades.ts:642`, so both are
  covered. `postJobCardLabor` (`src/api/lib/po-cost-cascade.ts:953`) is independently guarded on an
  existing LABOR_POSTED row (:966). **If you add a new backfill that calls the WIP cascade, pass
  `orgId` or you silently get no guard at all.**
- **`/cascade-leak-pass` (`completion-cascades.ts:683`) flips `job_cards` to COMPLETED and fires
  NOTHING else.** Its only write is the UPDATE at :927. Compare `/cascade-upstream-completion`,
  which after its own UPDATE (:559) deliberately calls `applyWipInventoryChange` (:635) and
  `postJobCardLabor` (:653) — the comment at :579 records that the metadata-only version left ~1300
  phantom consumes without compensating producer-adds. The leak pass still has that shape. Running
  it produces COMPLETED cards with no producer-add in `wip_items` and no labor row in
  `cost_ledger`.
- **`/clear-future-completions` (`completion-cascades.ts:129`) reverses only the metadata.** Its
  UPDATE at :171 resets status/date/PIC/minutes on `job_cards`, and the handler does nothing else —
  the `wip_items` movements and `cost_ledger` LABOR_POSTED rows that those completions already
  created are left behind.
- **`CASCADE_DATE_CLAMP` is a hand-maintained constant, currently `"2026-05-11"`
  (`src/api/routes/import-completion/_shared.ts:684`).** Both cascade endpoints clamp every
  backfilled completion date to it (`completion-cascades.ts:412` and `:837`). The comment above it
  records that it was already stale once. Re-running a cascade today without bumping it pins every
  backfilled date to 2026-05-11.
- **The two rebuild endpoints delete `fg_units` and never recreate them.**
  `/rebuild-production-orders-from-soi` (`so-co-do-backfills.ts:1211`) and
  `/backfill-split-multi-qty` (`fg-fabric.ts:516`) both DELETE the SO's entire `fg_units` set
  (:1409 / :805) and then rebuild from `createProductionOrdersForOrder`, which emits only
  `production_orders` and `job_cards` INSERTs — no `fg_units`. The split endpoint at least gates on
  every unit being PENDING (`fg-fabric.ts:637`); the SO rebuild has **no `fg_units` status check at
  all**, only a JC-status one at :1297.
- **`/migrate-nonstandard-sofa-sizes` (`sofa-pricing.ts:1690`) has no dry-run of any kind** and
  blanks both `sizeLabel` and `sizeCode` (:1750, :1761). `sizeCode` is the sofa *seat height* that
  `/recompute-so-sofa-prices` requires — it skips lines with `missing sizeCode (seat height)`
  (`sofa-pricing.ts:896`). Running the size migration before a re-price silently converts priced
  sofa lines into un-repriceable ones. Its `sales_order_items` SELECT is org-scoped (:1707) but the
  `production_orders` UPDATE at :1761 matches on `salesOrderId` + `lineNo` with no org filter.
- **Sofa combo maths is re-implemented inline here, not imported.** The canonical engine is
  `applySofaCombos` (`src/api/lib/sofa-combo.ts`); `/recompute-so-sofa-prices` and
  `/recompute-co-sofa-prices` carry their own copy with a *deliberate* divergence (no round-up to
  whole ringgit) documented at `sofa-pricing.ts:927`. `tests/sofa-combo-drift-guard.test.mjs` pins
  the canonical engine only — it does **not** execute either endpoint, and its header comment still
  points at the pre-split `import-completion.ts`. Treat it as a drift alarm on the source of truth,
  not as coverage of these routes.
- **`/append-missing-pos` (`procurement-backfills.ts:1999`) runs DDL even on a dry run.** It calls
  `createProductionOrdersForSO` at :2068 before checking `dryRun`, and that helper's inner
  `createProductionOrdersForOrder` executes `ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS
  repairScope` (`src/api/routes/_shared/production-builder.ts:389`). Same for the two rebuild
  endpoints. A "dry run" here is not side-effect-free.
- **Three binding writers disagree about `orgId`.** `/supplier-bindings-from-history` (:294) and
  `/backfill-supplier-material-bindings` (:942) INSERT `supplier_material_bindings` without an
  `orgId` column, while `/backfill-supplier-bindings-multi` probes existing rows with
  `WHERE orgId = ?` (:1135) and inserts *with* `orgId` (:1206). Rows written by the first two are
  invisible to the third, which will then insert duplicate bindings for the same
  (materialCode, supplierId).
- `/regen-fg-units` queries `fg_units … WHERE poId = ?` (`fg-fabric.ts:1415`) while every other
  `fg_units` write in this family uses `po_id` (`fg-fabric.ts:805`, `so-co-do-backfills.ts:1409`).
  Both work only because of `src/api/lib/column-rename-map.json` — see the camelCase rule in
  `CLAUDE.md` before adding another.

**Start here:** `src/api/routes/import-completion.ts` (the 65-line barrel) tells you which
sub-router owns a path. For the completion engine itself read `processRow`
(`src/api/routes/import-completion/_shared.ts:317`) — it is the one function the whole family's
riskiest behaviour flows through. Before running ANY endpoint here, find its row above and check
the Default column: assume live-write unless the table says otherwise.
