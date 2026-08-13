# Layer-consistency audit — frontend ⟷ API ⟷ database

**Date:** 2026-08-13 · **Branch:** `audit/frontend-backend-db` · **Prod access:** none
(`.dev.vars` is rotated dead, no browser session). Everything below is proven from
source unless a row says **NEEDS PROD CHECK**, in which case §5 gives the exact
one-line probe that settles it.

## Why this class matters

These defects **fail silently**. No error, no crash, no stack trace, no bug report —
just a column that has been blank since the day it shipped, or a number that is wrong
in a direction nobody happens to check. The three that started this audit:

* `src/pages/suppliers/detail.tsx:214` reads `invResp.data.finishedGoods`;
  `GET /api/inventory` emits `finishedProducts` (`src/api/routes/inventory.ts:170`).
* the Master Tracker reads `jc.actualMinutes`, which the projection it asks for never
  carries — so efficiency printed 100% forever.
* `/planning`'s `useActual` toggle reads the same stripped field, so the toggle is a
  permanent no-op.

Three mechanisms produce almost all of them:

1. **`DataGrid` column keys and `.data.X` reads are plain strings.** `tsc` cannot see a
   mismatch, and a missing key renders empty rather than throwing.
2. **The pg shim renames columns in flight.** `columnFrom` (`src/api/lib/db-pg.ts:57`)
   is `snakeToCamel[col] ?? postgres.toCamel(col)` — so a **SQL alias**, which by
   definition is *not* in the rename map, gets camelCased by the fallback. A route that
   returns rows unmapped therefore ships a different key than its author expected.
3. **A stale shared type.** When `src/types/index.ts` still describes a pre-rename API,
   `tsc --noEmit` actively *certifies* the wrong read. That is the root cause of the
   credit/debit-note money bug below, and the reason it survived for so long.

A fourth, rarer but the most damaging: **a statement naming a column production does
not have.** It throws, the surrounding `try/catch` answers `400 "Invalid request body"`
or swallows it into `changes: 0`, and the feature is simply dead.

## Method

* Route response builders read against every consumer, **both sides opened** — never a
  grep conclusion. Every row cites `file:line` on both sides.
* Three mechanical sweeps, each hand-verified afterwards:
  * every frontend response-key read whose identifier appears **nowhere** in
    `src/api` + `src/lib` + `src/types` — found exactly one, `finishedGoods`;
  * every `INSERT INTO t (cols)` and `UPDATE t SET cols` in `src/api` checked against
    the production schema snapshot `tests/db-schema.json` — the half
    `tests/sql-columns-exist.test.mjs` does **not** cover (it parses only flat,
    join-free `SELECT` lists);
  * the same check for `WHERE` / `SET` identifiers on single-table statements.
* `tests/db-schema.json` is a real `information_schema` snapshot of production, last
  refreshed **2026-08-04** (`e66404f7`). Anything a migration ≥ 0211 added is expected
  to be missing from it and is **not** treated as evidence. Every schema finding below
  comes from migrations that long predate it.
* **Re-verified after rebase.** `main` gained #291/#292/#293 while this audit was open.
  Every reported row's cited expression was re-checked against the rebased tree; three
  (33, 36, 37) had been fixed there in the meantime and now say so, and shifted line
  numbers were corrected. Nothing in the tables below is inherited unchecked.

---

## 1. Fixed on this branch

| # | Bug id | Frontend ref | API emits / writes | DB reality | Effect |
|---|---|---|---|---|---|
| 1 | `-030` | *(no caller — latent)* | `src/api/routes/lorries.ts` POST + both PUTs wrote `created_at`, `updated_at` | `lorries` has neither: `0001_init.sql:343` created the table, and `0014_drivers_lorries.sql` — which declares them — is `CREATE TABLE IF NOT EXISTS`, a no-op | Every lorry create/edit threw into the catch and answered `400 "Invalid request body"` |
| 2 | `-031` | `src/pages/maintenance.tsx:196-220` "Log maintenance" | `src/api/routes/equipment.ts:260` and `src/api/routes/maintenance-logs.ts:86` INSERT `created_at` | `maintenance_logs` has none: same `0001_init.sql:1306` / `0015` `IF NOT EXISTS` story | Logging maintenance failed with `400 "Invalid request body"`, shown to the operator as "Couldn't log maintenance." **See the caveat below** |
| 3 | `-032` | `src/pages/production/folders.tsx:210`, `:82`; `components/BatchActionToolbar.tsx:424`; `production/index.tsx:1497` — `folder.jc_count` | `src/api/routes/production-folders.ts:121` returns rows **unmapped**, so the `jc_count` alias is camelCased to `jcCount` | `folder_job_cards` COUNT alias | Folder card read "` job cards`", the picker read `Name ()`. It looked right immediately after *creating* a folder, because POST (`:177`) hand-builds a snake_case literal |
| 4 | `-033` | `src/pages/procurement/grn.tsx:687` grid key `"supplierDoNo"` | `src/api/routes/grn.ts:423` emits `supplier_do_no` | `grns.supplier_do_no` | "Supplier DO No." on the GRN list permanently blank, its sort and filter no-ops. `grn-detail.tsx:783` reads the right key, which is why detail worked and the list did not |
| 5 | `-034` | `src/lib/generate-credit-note-pdf.ts:29,73,75,115,117,166,173,210` and the debit-note twin; `src/pages/invoices/credit-notes.tsx:50-51` (voucher) and `:421-422` (CSV), same in `debit-notes.tsx` | routes emit `noteNumber`, `invoiceNumber`, `quantity`, `unitPriceSen`, `totalSen`, `totalAmount` (`credit-notes.ts:65-98`) | `credit_notes` / `debit_notes` + items JSON | **Customer-facing money document printing zero.** The downloaded Credit/Debit Note PDF showed doc-no "-", Invoice Ref "-", Qty **0**, Amount **RM 0.00** per line, **TOTAL RM 0.00**, "Amount in words: zero", and always saved as `CreditNote.pdf`. The on-screen voucher printed `RMNaN` in Unit Price and Amount; the CSV wrote `0.00` |

**Fix shape.** 1 and 2 drop the nonexistent columns from the statements (both columns
carry a `DEFAULT` in the version of the DDL that *does* declare them, so omitting them
is safe whichever table production actually has). 3, 4 and 5 are dual-keyed reads or a
corrected key. 5 also corrects `src/types/index.ts:1669`/`:1685`, whose stale
`{unitPrice, total}` item shape is exactly why `tsc` never objected — the legacy
spellings stay as deprecated optionals so no other consumer breaks.

> **Caveat on #2, stated plainly.** Dropping `created_at` is *necessary*; I cannot
> prove from code that it is *sufficient*. Production's `maintenance_logs` is
> `0001_init`'s table, and that definition carries
> `FOREIGN KEY (equipment_id) REFERENCES equipment_list(id)` — a different table from
> the `equipment` that `equipment.ts` reads and writes. If that FK is live and
> `equipment_list` is not populated, the INSERT will still fail. Probe in §5.

---

## 2. Reported, not fixed — write paths that cannot land

| # | Site | Column named | Reality | Effect |
|---|---|---|---|---|
| 6 | `src/api/routes/import-completion/so-co-do-backfills.ts:795` | `delivery_order_items.sizeCode`, `.salesOrderId`, `.lineNo` | the table has `size_label` and `sales_order_no`; it has **no** `size_code`, `sales_order_id` or `line_no` | `.catch(() => ({meta:{changes:0}}))` swallows it, so `POST /api/import/backfill-downstream-product-names` returns `deliveryOrderItemsUpdated: 0` **always** — indistinguishable from "nothing needed fixing" |
| 7 | same file `:812` | `invoice_items.salesOrderId`, `.lineNo` | neither column exists | `invoiceItemsUpdated: 0` always, same swallow. Only the `production_orders` branch of that loop can ever match |
| 8 | `src/api/routes/consignment-notes.ts:1331` (CN `/return`) | `UPDATE customers SET outstandingSen = …, updated_at = ?` | `customers` has no `updated_at` — never created, no migration adds one | The statement is inside `DB.batch(statements)` at `:1337`, which is atomic. So a return on a CN that had already been converted to an invoice fails **entirely** and the A/R refund never posts. **Money path — not fixed here on purpose** |
| 9 | `src/api/routes/grn.ts:2048-2069` | the DRAFT re-line branch of `PUT /api/grn/:id` DELETEs and re-INSERTs `grn_items` **without** `po_id` / `po_item_id` | both columns exist in prod | Per-line PO ownership recorded at create is wiped by any draft edit, and resolution falls back to positional matching against the header PO — the exact failure `po_item_id` was added to prevent |
| 10 | `src/api/routes/purchase-orders.ts:747` (PUT) | awaits only `ensurePoItemLineNo` but writes `purchase_order_items.material_code` (`:897`) and `purchase_orders.purchase_org_code` (`:944`) | both created only by `ensurePendingMigrations` (`:1059`, `:1062`), which this handler does not await | Both columns are present in prod today, so this is a latent violation of the self-apply rule rather than a live outage: a fresh isolate serving a PUT before any POST would 500 |
| 11 | `src/api/routes/e-invoices.ts:175` | `const totalIncludingTax = invoice.totalSen / 100;` bound at `:210-212` | `e_invoices.total_including_tax` is `INTEGER` (`0001_init.sql:645-647`, never altered) | A ringgit **float** into an integer column. postgres.js types the parameter from the target column, so any invoice whose total is not a whole ringgit is rejected; the blanket catch at `:229` turns that into a misleading `400 "Invalid request body"` which `invoices/e-invoice.tsx:118` never inspects. **NEEDS PROD CHECK** for the exact failure mode |

## 3. Reported — reads under a key the payload never carries

| # | Frontend ref | API emits | DB column | Effect |
|---|---|---|---|---|
| 12 | `src/pages/warehouse.tsx:610` `!po.stockedIn` | `rowToMinimalPO` (`production-orders/_helpers.ts:858-902`) drops it; full `rowToPO:978` has it | `production_orders.stocked_in`, genuinely written at `_helpers.ts:4933` | The Stock-In dropdown never excludes an already-stocked PO → duplicate rack assignment and a duplicate `STOCK_IN` movement. Highest-impact read on this list |
| 13 | `src/pages/planning/index.tsx:327, 948, 1158, 1503, 1518, 1639, 1695, 1778` `jc.actualMinutes` | `slimJobCardsToPlanningLite` (`_helpers.ts:5284`) keeps 12 fields, not this one | `job_cards.actual_minutes` | `useActual` is a permanent no-op. **Correction to the brief: `src/pages/production/tracker.tsx` does not exist** — the Master Tracker is a tab *inside* `planning/index.tsx:202`, so the two reported instances are one file. `actualMinutes` is the **only** field the lite projection drops that any consumer reads |
| 14 | `src/pages/consignment/detail.tsx:1093` `order.preHoldStatus` | `rowToCO` (`consignment-orders.ts:168-203`) never emits it; the PUT writes only `hold_reason/held_by/held_at` | nothing written | Resuming an ON_HOLD **CO** always returns it to `CONFIRMED` — a CO held from IN_PRODUCTION silently walks backwards a stage. The SO side of this was fixed and is written up at `sales-orders/_helpers.ts:285-288` |
| 15 | `src/pages/consignment/edit.tsx:557` `expect: { … customerPOId … }` | `rowToCO` has no `customerPOId`; no such column on `consignment_orders` | none | `verifiedSave` compares `"PO-…"` against `undefined` → **every CO save with a Customer PO filled in reports "Save did NOT take effect"** and aborts the navigate, although every other field persisted fine |
| 16 | `src/pages/consignment/detail.tsx:1225` `order.customerPOId`; `:1231`/`:1481` `order.hookkaDeliveryOrder` | neither emitted by `rowToCO` | none | CO detail's "Customer PO" is permanently `-` and the Document Relationship diagram never draws a DO node for any CO. The page is typed `SalesOrder`, which is why `tsc` was silent |
| 17 | `src/pages/consignment/detail.tsx:302`/`:388-394` `orderResp.statusHistory`, `.priceOverrides` | `GET /api/consignment-orders/:id` returns `{success,data,lockReason,linkedCNs,linkedPayments,linkedPOs}` (`:1549-1568`) | `co_status_changes` **is** populated (`production-orders/_helpers.ts:3709…`) | The CO Status Timeline is permanently empty even though the data — and an endpoint for it, `/status-changes` at `:1011` — exist; the page simply never calls it. Price Override History never renders |
| 18 | `src/pages/procurement/detail.tsx:1081` `item.supplierSKU` | `purchase-orders.ts:99` reads `r.supplierSKU ?? r.suppliersku`; the driver delivers **`supplierSku`** | `purchase_order_items.supplier_sku` — **confirmed present in prod** | The stored SKU never reaches the API; each PO line's SKU is re-derived from bindings and blank whenever ambiguous. The in-file comment at `:59` ("that column never existed") is factually wrong, and the "fix" it justifies added a second dead key |
| 19 | *(server-internal)* `src/api/routes/grn.ts:1574` `poItem?.material_code \|\| poItem?.supplierSKU` | rows come from a raw `SELECT * FROM purchase_order_items`; the driver delivers `materialCode` / `supplierSku` | `grn_items.material_code` | Every PO-sourced GRN line is stored with `material_code = ""` → blank Material Code on GRN detail and the GRN PDF, and the binding-based RM resolver never fires. **Not fixed: filling it changes which RM a line resolves to, which is a stock-posting cascade** |
| 20 | *(server-internal)* `src/api/routes/three-way-match.ts:380` `it.supplierSKU` | same wrong key | `purchase_order_items.supplier_sku` | PO lines are never bucketed by supplier SKU in PO↔GRN↔PI reconciliation, contrary to `deriveMatCode`'s stated precedence |
| 21 | *(server-internal)* `src/api/routes/scan-supplier.ts:177` `row.supplierHint` | `SELECT … supplierHint` at `:172`; the physical column is folded `supplierhint` | `supplier_scan_samples.supplierhint` — the fold is documented at `0178_catchup_runtime_tables.sql:204` | Gold-marking a sample without a `supplierId` never re-distils that supplier's OCR rules. Siblings: `ocr-accuracy.ts:240`, `lib/ocr-distill.ts:479` |
| 22 | `src/pages/m/screens/ProductionScreen.tsx:92, 114` `str(po,"companySO")` | `production-orders.ts:3372` emits `companySOId` | `production_orders.company_so_id` | The mobile board **displays** the SO ref (`:240` uses a fallback chain) but searching for it returns nothing — under a placeholder that reads "Search PRD · product · SO · customer" |
| 23 | `src/pages/m/config/modules.ts:1339` `str(r,"reference")`, and `:1323` | `_helpers.ts:530, 867` emit `customerReference` | `production_orders.customer_reference` | The mobile "Ref" search column is permanently blank, and the "Ref" meta falls through and labels the **department code** as "Ref" |
| 24 | `src/pages/m/config/modules.ts:1443`, `:1479`, `:2405` `o.data?.departments ?? o.departments` | `department-performance.ts:713-729` emits `{range, departmentCode, category, totals, daily}` | — | Mobile Employees → Dept Performance and both Planning capacity tabs render **0 rows, forever, no error**. Even after a rename the per-row readers (`totalHours`, `utilisationPct`, `backlogDays`, `plannedPct`, `headcount`) match nothing the route produces |
| 25 | `src/pages/quality.tsx:644` `r.itemName` | `raw-materials.ts:112` emits `description` | `raw_materials.description` | RM subject options render `RM-CODE — undefined` |
| 26 | `src/pages/quality.tsx:657` `f.remainingQty` | `fg-units.ts:113-155` `rowToFGUnit` has no such field | n/a — wrong entity (units, not batches; the FE type is still named `FgBatchOpt`) | The qty parenthetical never renders |
| 27 | `src/lib/unified-doc-download.ts:163` `taxSen: Number(inv.taxSen) \|\| 0` | `invoices.ts` `rowToInvoice` (`:356-393`) emits `subtotalSen` and `totalSen`, **never** `taxSen` — though `InvoiceRow` declares it at `:267` and the INSERT writes it at `:1747` | `invoices.tax_sen` | The **browser-downloaded** invoice PDF can never print a Tax line (`unified-do-invoice-pdf.ts:400` gates on it), so Subtotal + Tax ≠ TOTAL. The **server**-rendered emailed PDF derives it instead (`delivery-orders/_helpers.ts:4030`) — one invoice, two different PDFs. Dormant only while the SST rate is 0 |
| 28 | `src/pages/invoices/detail.tsx` TOTAL row renders `liveSubtotal` (`:998`) | `invoices.ts:380` `totalSen` is gross | `invoices.total_sen` | The detail page's "TOTAL" understates by the SST while the Balance card on the same page uses `invoice.totalSen` (`:458`). Same dormancy |
| 29 | `src/pages/accounting/shared.ts:29` `value: o.code.toLowerCase()` → `&orgId=${company}` | `src/api/lib/tenant.ts:213` binds that to the `org_id` column | `invoices`/`ledger_journal_entries`.`org_id` is `'hookka'` for **both** companies (`0142_organisations_registry.sql:92,100`) | The Accounting company selector cross-wires the *display* dimension (`code`, i.e. HOOKKA/OHANA — the real one is `sales_org_code`/`purchase_org_code`, `src/lib/company-dimension.ts:13`) onto the *tenant* column. Picking "OHANA" filters `org_id='ohana'` and P&L / BS / AR / AP / TB all render empty. Only "HOOKKA" works, and only by coincidence |
| 30 | `src/pages/accounting/index.tsx:6522-6526` `PaymentGroup` has no `reference`; `:6659` `setReference("")`; `:6613` posts `reference: reference \|\| undefined` | `accounting.ts:4266` emits `reference`; the restate writes `body.reference ?? null` at `:4550` | `other_party_payments.reference` | **Silent data loss**: every in-place edit of an Other Debtor/Creditor payment NULLs the stored reference. `undefined` is dropped by `JSON.stringify`, so the route's `?? null` wins |
| 31 | `src/pages/accounting/index.tsx:3551` renders `data.invoiceOutstandingSen` (gross); the type at `:3432-3439` omits `netOutstandingSen` | `accounting.ts:1796` computes `netOutstandingSen = invoiceOutstandingSen − unappliedAdvanceSen` and `:1812` bases the drift on the **net** | — | The AR drift badge at `:3552` contradicts the figure printed above it whenever a customer advance is un-knocked. The AP twin does it correctly (`:3931`, `:3936`) |
| 32 | `src/pages/production/index.tsx:2862` `o.createdAt` | dropped by `rowToMinimalPO` (full `rowToPO:979` has it) | `production_orders.created_at` | `?axis=created_at` is a silent no-op. URL-only since the dropdown was removed 2026-05-07, so low reach |
| 33 | ~~`src/pages/suppliers/detail.tsx:214` `invResp.data.finishedGoods`~~ | `inventory.ts` emits `finishedProducts` | n/a | **Already fixed on `main` while this branch was open** — BUG-2026-08-13-024 (#292) removed the dead key rather than renaming it, for the same two reasons §6 gives below. Kept here only so the reasoning survives |

## 4. Reported — writes the server discards, and dead computation inputs

| # | Site | What |
|---|---|---|
| 34 | `src/pages/consignment/create.tsx:741`, displayed `:1753` | The CO create screen computes, shows and posts a **Total-Height surcharge**; `consignment-orders.ts:744` (POST) and `:2090` (PUT) compute `unitPrice = base + divan + leg + special` and the INSERT column list omits it. `consignment_order_items.total_height_price_sen` exists in prod (self-applied at `sales-orders/_helpers.ts:1335`) and is uniformly `0`. The saved CO total is therefore **lower than the figure the operator approved on screen**, and the CO PDF's "T.Height" column is always 0. This is BUG-CLASS **C1**, fixed for SOs on 2026-07-23 (`resolveTotalHeightPriceSen`) and still open for COs. `consignment/edit.tsx:465-477` already documents the gap in a comment |
| 35 | `src/pages/bom.tsx:3558` → PUT `:6232` | "L1 Materials" is put in the request body; `bom.ts:501` whitelists only `l1Processes`, and the string `l1Materials` appears **zero** times in that route. No `l1_materials` column exists on `bom_templates` — only inside `bom_master_templates.data` JSON, which is why "Load Default" fills it and makes the loss read as a save bug. An optimistic `setTemplates` hides it until reload. A fix needs a snake_case column **and** a `column-rename-map.json` entry, or the write 400s |
| 36 | `src/api/routes/forecasts.ts` | `actual_qty` is INSERTed as a literal `NULL` and there is **no other writer anywhere** — no PUT, no PATCH — so `analytics/forecast.tsx:204`'s `filter(f => f.actualQty !== null)` is always empty. **The fabricated half is already fixed on `main`**: BUG-2026-08-13-014 (#292) removed the hardcoded `accuracy: 84.2` (`// Mock accuracy`) and the KPI now renders `—` with a stated reason. The dead input itself remains — nothing will ever write `actual_qty`, so that branch stays unreachable until a writer exists |
| 37 | ~~`src/api/routes/inventory.ts:163`~~ | `stockQty: 0` on every finished product asserted *"zero on hand"* rather than *"not computed"*. **Already fixed on `main` while this branch was open** — it is now `stockQty: null` with the distinction spelled out at `inventory.ts:215` |
| 38 | `src/lib/generate-grn-pdf.ts:83, 84, 92` | Reads `supplierAddress` / `supplierContact` / `doRef ?? supplierDoNo`; none of the three call sites (`grn.tsx:517`, `grn.tsx:743`, `grn-detail.tsx:607`) pass them, though `sup` is in scope at two of them. The GRN PDF always prints "-" for Address, Contact and Supplier DO No. |
| 39 | `src/api/routes/cost-ledger.ts` | All four endpoints have **zero** frontend callers |
| 40 | `dashboard-overview.ts:2163, 2170-2174, 2203-2204` | `deliveredThisMonthSen`, `monthlySales`, `monthlySalesByCustomer` and five purchasing keys are computed and serialized into every response *and* into the snapshot blob; `dashboard-b/index.tsx` declares them in a type and never reads them |
| 41 | `accounting.ts:1814` / `:2690` / `:12053` | A full `aging` array and `pnlPriorCum` are emitted with no reader in `accounting/index.tsx`. `/ar-control`'s aging loop walks every non-draft invoice to produce a discarded value |
| 42 | `src/pages/accounting/index.tsx:5526` `row.badge` | `accounting.ts:7304` declares `badge?: string` on the row type and no push ever assigns it, so the `[badge]` suffix on P&L lines can never render (cosmetic) |
| 43 | `src/pages/consignment/index.tsx:1097` | "Transfer to Delivery Order" posts `salesOrderId: transferDORow.id` where the row is a **ConsignmentOrder**, writing a `co-…` id into a sales-order-typed FK. **NEEDS PROD CHECK** |
| 44 | `src/pages/accounting/index.tsx:4747` vs `accounting.ts:7430-7431` | `csSection()` classifies by name prefix while the route splits sales on `r.code === "500-0000"` over possibly-historical `revLines`; a historical revenue line that fails the name match lands in `salesSofa` and skews SPEND % SALES for pre-opening months. **NEEDS PROD CHECK** |
| 45 | `src/api/routes/invoices.ts:1289`, `:1311` | `/api/invoices/stats`' unfiltered branch omits `orgId` while the grid filters on it (`:1103`). Harmless while every row is `org_id='hookka'`; a live divergence the moment a second tenant is seeded (BUG-CLASS **C12**) |

## 5. Type drift (no user-visible symptom today)

| # | Where | What |
|---|---|---|
| 46 | `src/types/index.ts:229-260` `SalesOrderItem`, `:1096-1120` `ConsignmentOrderItem` | Neither declares `discountSen`; `SalesOrderItem` also lacks `totalHeightPriceSen`. Both are emitted. Harmless now — both order pages carry their own `LineItem` types — but a new consumer typed off the shared type cannot see the discount without a cast |
| 47 | `src/types/index.ts:305` `isStock?`, `:1082-1094` `COStatus` | `rowToSO` never emits `isStock`; `CO_VALID_TRANSITIONS` (`consignment-orders.ts:85-97`) can never produce `SHIPPED` / `PARTIALLY_SOLD` / `FULLY_SOLD` / `RETURNED`. Dead type surface — recorded so nobody builds on it |
| 48 | `src/api/routes/lorries.ts`, `maintenance-logs.ts` | `LorryRow.createdAt` / `MaintenanceLogRow.createdAt` were typed `string` for columns that do not exist. Relaxed to `?: string \| null` on this branch |

---

## 6. Two fixes that look obvious and are wrong

**Row 33 — do not rename `finishedGoods` to `finishedProducts`** (recorded because
`main` reached the same conclusion independently in BUG-2026-08-13-024, and the reasoning
is the reusable part). The consumer maps
each entry to `{id, itemCode, description, baseUOM, itemGroup}` for the SKU dialog's
**raw-material** autocomplete (`suppliers/detail.tsx:210-223`). `finishedProducts`
entries are *products* — `code`/`name`, no `itemCode`/`description`/`baseUOM` — so the
rename would inject ~380 rows with `itemCode: undefined`. The `wipItems` spread on the
next line already does exactly that, and the crash it caused is memorialised in a
defensive comment at `sku-form-dialog.tsx:105-108`. The correct change is to drop
**both** non-RM spreads, which is a behaviour change and belongs to whoever owns that
dialog.

**Row 13 — do not simply add `actualMinutes` back to the lite projection.**
`BUG-2026-08-13-005` records that on prod all 4,289 non-zero `actual_minutes` values are
byte-identical to that card's own `est_minutes`. Restoring the field would resurrect a
figure that is 100% by construction. Settle it with the probe below; if
`genuinely_measured = 0` the fix is to **remove** the `useActual` branch, which is what
`reports.tsx:781` already concluded for the Reports page.

---

## 7. Probes for the main session

Each is one line and settles exactly one row.

```sql
-- rows 1,2,8: confirm the dead write columns (snapshot is 2026-08-04, so re-check)
SELECT table_name, column_name FROM information_schema.columns
 WHERE (table_name='lorries'          AND column_name IN ('created_at','updated_at'))
    OR (table_name='maintenance_logs' AND column_name='created_at')
    OR (table_name='customers'        AND column_name='updated_at');   -- expect ZERO rows

-- row 2 caveat: is the 0001_init FK to equipment_list still live? (a second blocker)
SELECT conname, confrelid::regclass FROM pg_constraint
 WHERE conrelid='maintenance_logs'::regclass AND contype='f';

-- rows 6,7: the two backfill branches that can never match
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('delivery_order_items','invoice_items')
   AND column_name IN ('size_code','sales_order_id','line_no');        -- expect ZERO rows

-- row 34: how much CO total-height surcharge has been silently dropped
SELECT count(*) AS eligible_lines, sum(quantity) AS units
  FROM consignment_order_items
 WHERE COALESCE(gap_inches,0)+COALESCE(divan_height_inches,0)+COALESCE(leg_height_inches,0) > 0
   AND total_height_price_sen = 0;

-- row 18: blast radius of the dead supplier_sku read
SELECT count(*) FILTER (WHERE COALESCE(supplier_sku,'') <> '') AS stored, count(*) AS total
  FROM purchase_order_items;

-- row 19: blast radius of the blank GRN material code
SELECT count(*) FILTER (WHERE COALESCE(material_code,'') = '') AS blank, count(*) AS total
  FROM grn_items;

-- row 9: how many draft edits have already wiped per-line PO ownership
SELECT count(*) FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
 WHERE g.po_id IS NOT NULL AND gi.po_item_id IS NULL;

-- rows 27,28: are the two tax rows live or dormant? (dormant iff the rate is 0/absent)
SELECT value FROM kv_config WHERE key='gst_rate_pct';

-- row 29: confirm no accounting row carries org_id='ohana'
SELECT org_id, count(*) FROM invoices GROUP BY 1;
SELECT org_id, count(*) FROM ledger_journal_entries GROUP BY 1;

-- row 43: has the CO->DO transfer ever written a CO id into a sales-order FK
SELECT id, "doNo", "salesOrderId" FROM delivery_orders
 WHERE "salesOrderId" IN (SELECT id FROM consignment_orders);          -- zero = latent

-- row 13: is actual_minutes a measurement, or a copy of the estimate
SELECT count(*) AS populated,
       count(*) FILTER (WHERE actual_minutes IS DISTINCT FROM est_minutes) AS genuinely_measured
  FROM job_cards WHERE actual_minutes IS NOT NULL AND actual_minutes <> 0;
```

On the wire, **with the exact query strings the pages use** — a bare call is not what
any page does:

```bash
curl -s "$HOST/api/production-orders?fields=minimal&include=" -b "$COOKIE" \
  | jq '.data[0] | has("stockedIn"), has("createdAt")'         # rows 12, 32 — expect false,false
curl -s "$HOST/api/production-folders"      -b "$COOKIE" | jq '.data[0]|keys'   # row 3  — jcCount
curl -s "$HOST/api/grn?limit=1"             -b "$COOKIE" | jq '.data[0]|keys'   # row 4  — supplier_do_no
curl -s "$HOST/api/production-orders/board" -b "$COOKIE" | jq '.data[0]|keys'   # row 22 — no companySO
curl -s "$HOST/api/inventory"               -b "$COOKIE" | jq '.data|keys'      # row 33 — finishedProducts
curl -s "$HOST/api/department-performance?from=2026-08-01&to=2026-08-13" -b "$COOKIE" | head -c 400  # row 24
# row 11 — post an e-invoice for an invoice whose total_sen % 100 <> 0 and read the status
```

After the deploy of this branch, the two fixes worth watching on prod are the
maintenance log (create one, then `SELECT * FROM maintenance_logs ORDER BY date DESC
LIMIT 1`) and a downloaded credit note (the PDF must show real Qty and Amount).

---

## 8. What was checked and found clean

Recorded so the next reader does not re-walk it.

* **Projections.** `include=jobCards-lite` — every field `planning/index.tsx` reads off
  a job card was enumerated; `actualMinutes` is the only drop. The dept-slim
  `rowToMinimalJobCard` path drops 15 fields, every one of which is read only on the
  active-dept row, which always gets the full shape. `?fields=minimal&include=`
  consumers in `sales/index.tsx:340` and `consignment/index.tsx:142` read only fields
  `MinimalPOOut` declares. SO list `?fields=price-index` / `delivery-refs` /
  `orders-due` against every caller: no dropped-but-read field. `rowToCOList`'s item
  projection against all its consumers: clean.
* **Endpoint↔page shapes.** `GET /api/sales-orders/:id` and `/stats`, the
  `PUT /api/sales-orders/:id` `verifiedSave` contract, `GET /api/consignment-notes`
  (+ `/stats`, `/ready-planning`, `/:id/print-extras`), `/api/sofa-combos`,
  `/api/consignments`, `/api/job-cards`, `/api/mrp`, `/overdue-counts`, `jobcard-sync`,
  `/api/production-folders/:id` and `/rows`, `three-way-match/by-po/:poId`,
  `purchase-invoices` `rowToPI`/`rowToItem`, `suppliers` `rowToSupplier`,
  `goods-in-transit`, `credit-notes`/`debit-notes` list shapes,
  `supplier-payments`, `supplier-scorecards`, `supplier-materials`, `cash-flow`,
  `payments`, trade finance, the audit log, KPI (`/library`, `/people`, `/me`,
  `/payout`), all 13 accounting report endpoints (`/pl`, `/pl-statement`, `/pl-trend`,
  `/pl-monthly`, `/cost-structure`, `/cost-expense-classes`, `/cashflow-statement`,
  `/trial-balance`, `/gl`, `/gl-report`, `/stock-summary`, `/cost-by-line`,
  `/wip-detail`, `/cleanup-report`), the AR/AP surface, and both dashboards.
* **Grid column keys** extracted and checked against each route's emit list for every
  procurement, sales, consignment and production grid — `grn.tsx:687` was the only
  wrong one.
* **Folded-lowercase reads.** `dispatchemailat` / `deliveredemailat` are dual-keyed on
  both the DO and CN sides, with the folded spelling used consistently in the DDL and
  the UPDATEs. `repairScope` is dual-keyed at all seven read sites. A mechanical sweep
  of every `AS <MixedCase>` alias across the accounting routes found zero instances
  (every hit was a TypeScript `as` cast).
* **Runtime self-apply.** Every column added by a migration numbered **0192 or later**
  has a matching `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `src/api`. The procurement
  family (`supplier_do_no` ×2, `supplier_invoice_no`, `purchase_invoice_items.po_id`,
  `grn_items.invoiced_qty`, `three_way_matches.po_ids`,
  `supplier_material_bindings.effective_from`, `price_histories.effective_from`,
  `grns.cancelled_at`/`cancelled_reason`) is guarded at the top of every handler that
  writes it. `grn_items.po_id` / `po_item_id` have **no migration file at all** and are
  self-applied only inside `resolveGrnLineTargets` (`grn.ts:909`), not in the POST — but
  both columns **are present in production**, so that gap is a rule violation, not an
  outage. Row 10 is the same shape on the PO PUT.
* **camelCase-in-SQL vs `column-rename-map.json`** across all procurement routes: three
  apparent hits, all false positives (double-quoted aliases pass through verbatim, plus
  the one intentional folded column in row 21). No unmapped camelCase write.
* **A near-miss that is not a bug** — `bom.ts:889` uses an unquoted
  `jc.departmentCode AS deptCode` and reads `r.deptCode`. It looks exactly like the
  folded-lowercase trap and is safe: `supabase-compat.ts:113-120` rewrites the bare
  alias through the rename map to `dept_code` and the driver maps it back. All seven
  aliases in that query round-trip. Do not "fix" it.

### Stale comments found (not bugs, but they mislead the next reader)

* `src/api/routes/purchase-orders.ts:59-60` — "the rename-map lists `supplier_sku`
  (wrong — that column never existed)". `0001_init.sql:458` created exactly that column
  and the prod snapshot confirms it.
* `src/pages/production/folders.tsx:26-28` (corrected on this branch) — claimed
  `jc_count` "stays snake_case because it comes from a SQL alias". The opposite is true:
  SQL aliases are precisely the names `columnFrom` hands to `toCamel`.
* `src/pages/consignment/note.tsx:1877` says the CN PUT does not update `sentDate` — it
  does. `src/lib/pricing.ts:23` says `totalHeightPriceSen` is not sent to the API — on
  the SO path it is, since 0209. `consignment-notes.ts:210` filters
  `status <> 'CANCELLED'`, a value nothing writes to `consignment_notes`.

---

## 9. Why the existing guards caught none of this

* `tests/sql-columns-exist.test.mjs` parses **only** flat, join-free `SELECT` column
  lists. Rows 1, 2, 6, 7 and 8 are `INSERT`s, `UPDATE`s and `WHERE`s — the half it
  explicitly declines to parse. Extending it to `INSERT INTO t (…)` and `UPDATE t SET …`
  (both trivially parseable and single-table by construction) would have caught all five
  mechanically. **That is the single highest-value follow-up in this document.**
* `tests/db-schema.json` is nine days stale. It is the only thing standing between a
  nonexistent column and production, and refreshing it is a manual step
  (`node scripts/refresh-db-schema-fixture.mjs`) that nothing enforces.
* `DataGrid`'s `Column<T>.key` is `string`, not `keyof T`. Row 4 and every other grid
  key mismatch is invisible to `tsc` by construction.
* Frontend response types are hand-written inline generics, and nothing compares them to
  what the route emits. Worse, when a shared type in `src/types/index.ts` goes stale it
  does not merely fail to help — it **certifies the wrong read**, which is exactly how
  row 5 shipped RM 0.00 on a customer-facing document.
