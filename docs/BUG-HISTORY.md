# Bug History

Living log of bugs we've identified, diagnosed, and fixed in Hookka ERP.

Each entry: ID, status, what happened (user-visible symptom), root cause, fix
(file:line), and how we verified it. Newest first.

Status legend:
- 🔴 **Identified** — diagnosed, not yet fixed
- 🟡 **Fix in progress**
- 🟢 **Fixed** — code shipped + verified

---

## Categories — Quick Index

Each entry below jumps to the first BUG with that category tag.
Entries themselves stay newest-first.

- `inventory-display` (23) — [BUG-2026-04-27-032](#bug-2026-04-27-032-wip-page-inflated-displayed-qty-by-summing-uph-jc-capacity-instead-of-trusting-wip_itemsstockqty)
- `ui-frontend` (21) — [BUG-2026-04-29-004](#bug-2026-04-29-004--cn-detail-dialog-vs-do-detail-dialog-9-layout--data-gaps-after-first-parity-pass)
- `production-orders` (18) — [BUG-2026-04-29-001](#bug-2026-04-29-001--production-sheet-so-id-column-blank-for-sofa-rows-of-co-origin-pos)
- `bom` (15) — [BUG-2026-04-27-010](#bug-2026-04-27-010-dept-pivot-editor-lists-draft-boms-as-duplicate-rows)
- `infrastructure` (15) — [BUG-2026-04-27-029](#bug-2026-04-27-029-fixdb-hyperdrive-needs-preparefalse-supavisor-6543-rejects-prepared-statements)
- `inventory-cascade` (16) — [BUG-2026-04-29-005](#bug-2026-04-29-005--cn-dispatch-left-fg_units--stock_movements--wip_items-untouched-no-inventory-cascade)
- `delivery-orders` (10) — [BUG-2026-04-29-003](#bug-2026-04-29-003--updateconsignmentnotebyid-silently-dropped-sentdate-and-items-on-put)
- `sales-orders` (7) — [BUG-2026-04-26-021](#bug-2026-04-26-021-fixsales-drop-wrong-mattress-label-on-sofa-category-option)
- `pricing-products` (6) — [BUG-2026-04-24-029](#bug-2026-04-24-029-fixcustomers-sofa-seat-prices-now-render-in-customer-products-panel)
- `data-migration` (5) — [BUG-2026-04-25-014](#bug-2026-04-25-014-fixd1-compat-ifnullcoalesce-bom-search-likeilike)
- `data-integrity` (4) — [BUG-2026-04-25-008](#bug-2026-04-25-008-stability-add-timeout-abort-propagation-to-fetchjson)
- `auth-rbac` (2) — [BUG-2026-04-26-033](#bug-2026-04-26-033-fixauthz-invalidate-kv-session-cache-on-role-change-p38)
- `scheduling` (2) — [BUG-2026-04-24-035](#bug-2026-04-24-035-fixschedule-lead-time-days-before-delivery-per-dept-parallel-not-serial)
- `audit-logging` (1) — [BUG-2026-04-27-007](#bug-2026-04-27-007-audit-event-write-failures-swallowed-silently)

---

## BUG-2026-04-29-005 — CN dispatch left fg_units / stock_movements / wip_items untouched (no inventory cascade)

**Status:** 🟢 Fixed (2026-04-29)
**Category:** inventory-cascade

**Symptom (user-reported):** the user dispatched a Consignment Note
(`ACTIVE → PARTIALLY_SOLD`, FE-labelled "Mark Dispatched") and the goods
physically left the warehouse, but the Inventory page's Available count
never dropped. The CN's `dispatchedAt` got stamped, the FE list moved
the CN to the Dispatched tab, and that was it — `fg_units` rows for the
CN's source POs stayed `PENDING`, no `STOCK_OUT` row was written into
`stock_movements`, and `wip_items.stockQty` still carried the residual
UPH ledger entry. Net effect: the CN was a black hole for inventory
accounting.

**Root cause:** `updateConsignmentNoteById` in
`src/api/lib/consignment-note-shared.ts` was a status-+-timestamp-only
helper. DO had a full cascade in
`src/api/routes/delivery-orders.ts:1346-1577` for the symmetric event
(`DRAFT → LOADED` and the reverse), but no equivalent existed on the CN
helper — Mark Dispatched was wired straight to a status flip with no
inventory awareness. The CN→PO→fg_units link couldn't be expressed
either: `fg_units` had only a `doId` column, not a `cnId` column, so
even if the cascade had been written it would have had nowhere to stamp
the back-reference.

**Fix:** Three changes in commit `fa1f3ee`:

1. **Migration** `migrations-postgres/0077_fg_units_cn_link.sql` adds
   `cnId TEXT` + `idx_fg_units_cn_id` to `fg_units`. Separate column
   from `doId` — overloading would silently fan out wrong joins on
   every report that filters fg_units by source document. A unit can
   hold AT MOST one of `{doId, cnId}`; the cascade WHERE clauses
   enforce that with `(doId IS NULL OR doId='') AND (cnId IS NULL OR
   cnId='')`. Manual-apply via Supabase SQL Editor (D1 retired
   2026-04-27).
2. **Forward cascade** (`ACTIVE → PARTIALLY_SOLD`) in
   `updateConsignmentNoteById`:
   - `UPDATE fg_units SET cnId=?, status='LOADED', loadedAt=? WHERE poId=? AND (doId IS NULL OR doId='') AND (cnId IS NULL OR cnId='')` per source PO
   - `INSERT stock_movements (STOCK_OUT, reason="CN <noteNumber> dispatched")` per PO
   - `UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?` for each UPH job_card wipLabel of those POs (mirrors BUG-2026-04-27-021's DO-side fix)
3. **Reverse cascade** (`PARTIALLY_SOLD → ACTIVE`, the FE's "Reverse to
   Pending Dispatch" action) is the symmetric inverse: clear cnId, flip
   fg_units back to PENDING, write STOCK_IN, re-credit wip_items.

`PARTIALLY_SOLD → FULLY_SOLD` (Mark Delivered) and `FULLY_SOLD → CLOSED`
(Mark Acknowledged) intentionally do NOT trigger another fg_units flip
— goods are already out of inventory after dispatch, and consignment
delivery semantics differ from DO's (per-line `consignment_items.soldDate`
instead of header-level `deliveredAt`).

**Verification:** typecheck + eslint clean. Runtime verification deferred
until user applies migration 0077 manually — until applied, the forward
UPDATE throws "column cnId does not exist". Documented in commit body
+ migration header.

---

## BUG-2026-04-29-004 — CN Detail dialog vs DO Detail dialog: 9 layout / data gaps after first parity pass

**Status:** 🟢 Fixed (2026-04-29)
**Category:** ui-frontend

**Symptom (user-reported, after commit `55f18c0` "CN Detail parity v1"):**
the user opened a freshly-created CN whose row already had Provider /
Vehicle / Driver populated, clicked Edit (Pencil icon), and the inline
edit-mode opened with **Vehicle and Driver dropdowns blank** ("—
Optional —"). The user had to re-pick them every time. Same applied to
the **Mark Dispatched** dialog — the picker opened with all three
dropdowns blank even though the CN already had transport set. The list
row Status cell showed `RM 0.00` instead of the m³ total (DO shows
`X.XX m³`).

**Root cause:** Three independent gaps in
`src/pages/consignment/note.tsx` from the v1 CN parity work:

1. `enterEditMode` hardcoded `vehicleId: ""` and `driverPersonId: ""`.
   The DO equivalent at `src/pages/delivery/index.tsx:1340` seeds
   `vehicleId` from `row.vehicleId` and uses a
   `pendingDriverNameToResolveRef` pattern to resolve the driver
   PERSON id from `driverName` once the per-provider drivers list
   loads.
2. `mapCNToRow` didn't extract `vehicleId` from the API response.
   `consignment-note-shared.ts:rowToConsignmentNote` returns it, the
   FE just dropped it on the floor, so the row had no `vehicleId`
   field for `enterEditMode` to seed from.
3. The list Status cell render at line ~1690 used
   `formatCurrency(row.totalValueSen)` instead of
   `(row.totalM3 ?? 0).toFixed(2) + " m³"`. CN row didn't carry
   `totalM3` either — DO computes it from
   `delivery_orders.totalM3`; CN had no aggregate column, just per-line
   `itemM3`.

**Fix (commit `707e515`, 9 numbered gaps in commit body):**

- Edit dialog Vehicle dropdown pre-selects from `row.vehicleId`; Driver
  dropdown resolves PERSON id by name via `pendingDriverNameToResolveRef`
  (DO pattern).
- Mark Dispatched dialog (both context-menu + Detail-dialog footer)
  routed through new `openDispatchDialog(row)` that pre-fills
  Provider/Vehicle from row + stashes driver name for resolve-on-load.
- List Status secondary line: `formatCurrency(totalValueSen)` →
  `(totalM3).toFixed(2) + " m³"`.
- `ConsignmentNoteRow` gains `vehicleId` and `totalM3`. `mapCNToRow`
  now copies `vehicleId` from the API response and computes `totalM3`
  from `productM3Map` (same source as items-table footer, so the two
  totals always agree).
- Detail dialog basics grid: `CN Number / CO Reference / Items` →
  `CN Number / Total M³ / Items` (mirrors DO 1:1; CO Reference moved
  to chip strip below).
- Edit-mode basics grid: same swap, with live `editItems`-derived
  Total M³ that updates as the operator adds/removes items.
- Dispatch dialog Cancel/backdrop/X all clear the pending driver-name
  ref to prevent name bleeding between sessions.
- `cancelEditMode` clears `pendingDriverNameToResolveRef` (mirrors DO).

**Verification:** typecheck + eslint clean. User testing confirmed
pre-fill works after deploy.

---

## BUG-2026-04-29-003 — `updateConsignmentNoteById` silently dropped `sentDate` and `items[]` on PUT

**Status:** 🟢 Fixed (2026-04-29)
**Category:** delivery-orders

**Symptom:** the new CN inline edit-mode (commit `6a21d18`) PUT all
edited fields back through `/api/consignment-notes/:id`, but two of the
four primary editable fields silently no-op'd: changing the Delivery
Date had no effect, and adding / removing / re-quantifying items also
had no effect. Operators saw their edits "save" (toast confirmed
success) but on reload the persisted state was unchanged for those two
fields. Other fields (provider / vehicle / driver / hub / notes)
worked.

**Root cause:** `updateConsignmentNoteById` in
`src/api/lib/consignment-note-shared.ts` (the helper both
`/api/consignment-notes` and `/api/consignments` route through) had no
handling for `body.sentDate` — the `UPDATE consignment_notes` statement
just didn't include the `sentDate = ?` column. The function also had
no items-replace path at all: `consignment_items` rows were immutable
through this endpoint.

**Fix (commit `a28dcce`):**

1. Add `sentDate` to the UPDATE SET clause. Optional in body — undefined
   keeps the existing value, null clears, string overwrites. Mirrors
   the same body-undefined→keep / body-null→clear semantics already in
   place for `consignmentOrderId` / `hubId`.
2. Items replace via delete-and-reinsert when `body.items` is an array
   AND `existing.status === "ACTIVE" && nextStatus === "ACTIVE"`. The
   status guard exists because `consignment_items` carry per-line
   `soldDate` / `returnedDate` state once the CN crosses into
   `PARTIALLY_SOLD` / `RETURNED` / `FULLY_SOLD` — wiping rows then
   would lose committed sale/return history. Edit-mode is FE-gated to
   PENDING (= ACTIVE backend) anyway, but the guard is a hard backstop
   against future status drift. Stable ids: incoming `item.id` matching
   `coni-*` is reused; fresh ids are minted only for newly-added items.

**Verification:** typecheck + eslint clean. Manual: operator changed
delivery date + added an item, reloaded, both persisted.

---

## BUG-2026-04-29-002 — CN Edit button routed to non-existent `/consignment/note/:id/edit` page (blank page on click)

**Status:** 🟢 Fixed (2026-04-29)
**Category:** ui-frontend

**Symptom (user-reported):** opening a Consignment Note Detail dialog
and clicking the Edit (Pencil) icon — or the footer "Edit" button —
navigated to a blank page at `/consignment/note/<id>/edit`. The user
saw a clean dashboard chrome with no content, no error toast, and no
back path beyond the browser back button.

**Root cause:** commit `55f18c0` (CN Detail dialog parity v1) added the
Edit button with `onClick={() => navigate('/consignment/note/'+id+'/edit')}`,
on the assumption that a standalone edit page existed. It didn't —
`src/dashboard-routes.tsx` registered no such route. The router fell
through to the dashboard 404 fallback, which renders empty.

**Fix (commit `6a21d18`):** removed both `navigate(...)` calls and
implemented inline edit-mode in the Detail dialog itself, mirroring DO's
pattern at `src/pages/delivery/index.tsx:1340-1478`:

- Added state: `editMode`, `editForm`, `editItems`, `editSaving`,
  `editVehicles`, `editDrivers`, `editAddItemSearch`,
  `editShowAddItemPanel`.
- Added handlers: `enterEditMode`, `cancelEditMode`, `removeEditItem`,
  `addReadyPOToEdit`, `addableEditPOs` memo, `saveEditCN`.
- `useEffect` keyed on `editForm.providerId` refetches per-provider
  vehicles + drivers, parallel to DO's `editDialogVehicles` /
  `editDialogDrivers` effect.
- Detail dialog body swaps read-only fields for inputs when
  `editMode === true` — 3PL Provider / Vehicle / Driver / Hub pickers,
  Delivery Date, Remarks. Items table gets a Trash2 remove column +
  an Add Items panel restricted to same-customer Pending-CN POs.
- Header swaps to "Edit Consignment Note" + adds an "Editing" chip;
  Print/Document icons hidden in edit mode; Tracking timeline + Remarks
  display hidden in edit mode.
- Footer: Cancel + Save Changes (with `RefreshCw` spinner) when
  editing; backdrop click is a no-op so unsaved changes don't drop.

**Followup:** the v1 inline implementation introduced
BUG-2026-04-29-003 (silent no-op on `sentDate` + `items[]`) and
BUG-2026-04-29-004 (dialog seeding gaps). Both fixed same day.

---

## BUG-2026-04-29-001 — Production Sheet "SO ID" column blank for SOFA rows of CO-origin POs

**Status:** 🟢 Fixed (2026-04-29)
**Category:** production-orders

**Symptom (user-reported):** in the Production page's per-department
sheet (Fab Cut / Wood Cut / Upholstery / etc.), the "SO ID" column
rendered blank for SOFA rows whose parent was a Consignment Order
(rather than a Sales Order). Bedframe and Accessory rows from the same
CO showed correctly (`CO-2604-001-01`). The Overview tab also worked.
Only the dept sheets, only on SOFA, only for CO-origin POs.

**Root cause:** `src/pages/production/index.tsx:1401`:

```ts
soId: (o.itemCategory === "SOFA" ? o.companySOId : o.poNo) || "",
```

For a CO-origin SOFA PO, `o.companySOId` is empty (the order is a CO,
not an SO) and the parent doc id lives on `o.companyCOId`. The fall-
through to `""` silently rendered a blank cell. The non-SOFA branch
read `o.poNo`, which is the line-suffixed `CO-YYMM-NNN-NN` for both SO
and CO POs, so bedframe / accessory worked.

The display rule (sofa drops the line suffix because a sofa set spans
multiple variant-POs and no single suffix belongs to the whole set) is
correct — the bug was forgetting CO is also a valid parent doc class.

**Fix:** SOFA branch now reads `companySOId || companyCOId`. Also
widened `salesOrderNo` similarly so the row metadata exposes the parent
doc id for both flows. `salesOrderId` stays SO-only — CO double-click
navigation to `/consignment/order/:id` is a separate follow-up; for
now CO rows become double-click no-ops on the SO ID column instead of
routing to a `/sales/<co_id>` 404.

Type drift caught while fixing: `src/lib/mock-data.ts` `ProductionOrder`
got `consignmentOrderId?` + `companyCOId?` added (the API has been
returning these since `f0936ea` / 2026-04-28's `rowToPO` fix, but the
shared type didn't carry them, so TS was permissive instead of
helpful). Followup hotfix `da9c7b6` discovered a second `ProductionOrder`
type **shadowing** the import at `src/pages/production/index.tsx:26`
that ALSO needed the same fields — the deploy of the first commit
(`f35bcd5`) failed type-check on it.

**Verification:** typecheck clean after both commits. Manual: dept
sheets now show `CO-2604-002` for SOFA rows whose parent is CO-2604-002.

---

## BUG-2026-04-27-032 — WIP page inflated displayed qty by summing UPH JC capacity instead of trusting `wip_items.stockQty`

> Originally logged as BUG-2026-04-27-022 in the task brief; renumbered to
> 032 because IDs 022–031 were already taken by the bulk backfill commit
> `d6d91fc` (2026-04-27).

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom (user-reported):** the WIP grid showed three rows at 322 / 190
/ 42 for wipLabels whose ledger `stock_qty` was 4 / 2 / 1 respectively.
The displayed numbers were ~80× the true ledger truth. Specifically, the
user observed that one shared UPH `wipLabel` was being aggregated across
~160 not-yet-fully-complete UPH JCs (each contributing `wipQty=2`),
producing a 322-unit display for a row whose ledger was just +4.

**Root cause:** `src/api/routes-d1/inventory-wip.ts:296-309` (pre-fix)
walked every linked UPH JC of a UPH-coded `wip_items` row, summed
`wipQty` over the JCs whose PO was NOT fully UPH-complete, and used that
sum as the displayed `setQty` / `pieceQty` / `totalQty`. The intent was
"per-PO attribution" so a wipLabel shared by partial + fully-complete POs
wouldn't double-count the fully-complete contribution (which is also
surfaced via `deriveFGStock`).

The intent was right; the implementation summed the wrong thing. JC
`wipQty` is JC capacity — what the JC *would* produce when complete, not
what's actually on the shelf. For 160 UPH JCs whose POs are still partial
(no UPH JC done yet), every one contributed `wipQty=2` to the sum, so the
displayed qty became 320 even though `wip_items.stockQty` was just the
+4 produced by the few JCs that had actually completed.

The cascade (`applyWipInventoryChange` in `production-orders.ts`) already
maintains `wip_items.stockQty` as the ledger truth: producer-add at UPH
COMPLETED (BUG-2026-04-27-014/-017), dispatch decrement at DO LOADED
(BUG-2026-04-27-021), rollback paths (BUG-2026-04-27-002). The read
path's per-JC sum was a redundant — and wrong — second-source-of-truth.

**Fix:** `src/api/routes-d1/inventory-wip.ts:279-318, 530-553`. Replace
the `adjustedStockByRowId` map and the `displayQty` branch with a pure
visibility filter:

```ts
const linkedUphJcs = (jcsByLabel.get(w.code) ?? []).filter(
  (jc) => (jc.departmentCode || "").toUpperCase() === "UPHOLSTERY",
);
if (
  linkedUphJcs.length > 0 &&
  linkedUphJcs.every((jc) => poFullyUphComplete.get(jc.productionOrderId))
) {
  return false; // hide — every contributing PO is now FG
}
return true;
```

`w.stockQty` is used directly as the displayed qty for `setQty`,
`pieceQty`, and `totalQty`. The orphan default-show case
(BUG-2026-04-27-019) is automatically handled — `linkedUphJcs.length === 0`
returns `true`. The multi-PO mixed case (BUG-2026-04-27-018, partial vs
fully): the row stays visible at the full ledger qty; the fully-complete
portion is also surfaced via FG (`deriveFGStock`) — that's a known design
decision, now documented in `docs/INVENTORY-WIP-FLOW.md` § 7.

**Verification:** `npm run typecheck:app` clean, `eslint
src/api/routes-d1/inventory-wip.ts` clean, `npm test` 84/84 passing
(no test pinned the inflated qty — that was the bug). Manual: the grid
now reads 4 / 2 / 1 for the same three rows that had been showing 322 /
190 / 42.

**Companion:** new doc `docs/INVENTORY-WIP-FLOW.md` consolidates the
entire `wip_items` lifecycle (entry / exit / negative-qty / edge cases /
intentional double-counts / failure modes) so the next time someone
debugs WIP drift they have one document to read instead of grep-walking
the cascade + reading bug-history threads.

---

## BUG-2026-04-27-021 — DO Dispatch left wip_items.stockQty +qty forever

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** When a Delivery Order transitioned DRAFT → LOADED (the
"dispatch" / stamp-on-dispatch event), the wip_items rows produced by
each PO's UPHOLSTERY job cards stayed at +qty in D1 indefinitely. The
WIP read path (`/api/inventory/wip`) hides them because the PO is fully
UPH-complete (BUG-2026-04-27-017) and the FG read path (`deriveFGStock`)
drops the PO once its DO is dispatched, so the +qty was effectively
invisible — but the underlying `wip_items` ledger was wrong: a row that
no longer represented physical stock kept claiming inventory.

**Root cause:** The dispatch path in
`src/api/routes-d1/delivery-orders.ts` (the `stampedOnDispatch`
DRAFT→LOADED branch) wrote `STOCK_OUT` into `stock_movements` and
flipped `fg_units` to LOADED, but never decremented `wip_items.stockQty`
for the UPH-coded rows produced by those POs. The UPH producer-add
write at JC completion time (`applyWipInventoryChange`) had no
counterparty in the DO state machine.

**Fix:** Two symmetric writes added inside the existing
`stampedOnDispatch` and `revertedToDraft` branches in
`src/api/routes-d1/delivery-orders.ts`:

- DRAFT → LOADED: query `job_cards` for every UPH JC of every PO
  referenced by the DO that has `wipLabel IS NOT NULL`. For each, push
  `UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?` into
  the same batch as the existing dispatch SQL. Decrement uses the JC's
  own `wipQty` if set, else falls back to the PO's quantity.
- LOADED → DRAFT (the existing reversal path): symmetric inverse,
  re-credit `+ ?` for each UPH wipLabel of each PO that was stamped.

Idempotency is the predicate gates: `stampedOnDispatch` only fires when
`existing.status === 'DRAFT' && nextStatus === 'LOADED'`, so re-PATCHing
a LOADED DO with the same status is a no-op. Same for `revertedToDraft`.
No `MAX(0)` clamp — symmetric with BUG-2026-04-27-013, where negative
`stockQty` is a visibility signal rather than a clamp violation.

**Verification:** typecheck:app clean for delivery-orders.ts (the
pre-existing `delivery/index.tsx` merge-conflict markers are unchanged
and unrelated to this fix); lint:app clean for delivery-orders.ts;
`npm test` 84/84 passing (no new test pinned — out-of-scope per the
task brief).

---

## BUG-2026-04-27-020 — UPH rollback didn't reverse cascadeUpholsteryToSO

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** When an operator un-completed a UPHOLSTERY job card (DONE
→ WAITING via the Production Sheet date-cell or the form), the
inventory cascade rollback (BUG-2026-04-27-002) correctly refunded the
wip_items numbers, but the parent Sales Order stayed at READY_TO_SHIP
forever — even though one of its UPH JCs was now back to WAITING.
The SO supervisor saw the order ready to ship; the floor saw a UPH JC
still pending.

**Root cause:** `cascadeUpholsteryToSO` (the forward path that bumps
the SO to READY_TO_SHIP once every sibling PO is fully UPH-complete)
has an `else if` branch that flips READY_TO_SHIP back to CONFIRMED
when the condition no longer holds, but it (a) emits no audit row and
(b) doesn't clear the PO's `stockedIn` flag, leaving partial state
that the PO/SO views read inconsistently. Operationally, callers
treated the absence of an audit row as "this transition didn't
happen", and the `stockedIn=1` flag pinned by the forward path was
never reset.

**Fix:** New helper `cascadeUpholsteryRollbackToSO` in
`src/api/routes-d1/production-orders.ts` (added after
`cascadeUpholsteryToSO`). The helper:

1. Looks up the SO via the PO row.
2. Clears `stockedIn = 0` on the PO (the forward cascade sets it to 1).
3. If the SO is currently READY_TO_SHIP, recomputes the
   "every sibling PO is fully UPH-complete" condition. If it no longer
   holds, batches a SO status flip back to CONFIRMED with a
   `so_status_changes` audit row (mirrors the forward audit pattern in
   `sales-orders.ts`).

Hook point: `applyPoUpdate` tracks a `uphRollbackTriggered` flag in
the body.jobCardId block, set when `wasDone && !isDone` and the JC's
`departmentCode` is UPHOLSTERY. After the JC + PO UPDATEs commit and
the existing `cascadeUpholsteryToSO` runs, the new helper fires gated
on the flag. Defensive try/catch matches the existing cascade pattern.

The forward `cascadeUpholsteryToSO` is unchanged — its existing
`else if` is correct as-is and continues to handle the soft case
(rollback during a non-UPH PATCH that triggers the cascade); the new
helper adds the audit + stockedIn reset that the operator-facing
rollback specifically needs.

**Verification:** typecheck:app clean for production-orders.ts; lint
clean for the same; `npm test` 84/84 passing (no new test pinned —
optional per task brief).

---

## BUG-2026-04-27-017 — WIP page double-counted UPH-completed rows alongside FG view

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom:** Items that had finished UPHOLSTERY were appearing on the
warehouse **WIP** tab AND on the **Finished Products** tab at the same
time, double-counting them. User screenshot showed rows like
`5531 -Back Cushion 24` with positive `pieceQty` on the WIP grid even
though those pieces were already finished and should only live in FG.

**Root cause:** Per the user's mental model, UPHOLSTERY-completed = the
piece is now FG (in-stock), surfaced via `deriveFGStock` (frontend
roll-up that counts POs whose UPH JCs are all COMPLETED). The
`applyWipInventoryChange` cascade still writes a positive
`wip_items` row for the UPH JC's own `wipLabel` though (the
"producer-add" leg, written at UPH COMPLETED for symmetry with the
non-terminal depts). And `/api/inventory/wip` was reading every
non-zero `wip_items` row, so those UPH producer rows showed up on the
WIP grid too.

**Fix (initial):** Filter at the SQL source in
`src/api/routes-d1/inventory-wip.ts`. The main query was tightened to
`stockQty != 0 AND (deptStatus IS NULL OR deptStatus != 'UPHOLSTERY')`.

Rationale for SQL-level filter at the time: smaller payload, no join
cost wasted on rows we'd discard. Negative-row stub semantics
(BUG-2026-04-27-013) are unaffected — those carry
`deptStatus='PENDING'`, not `'UPHOLSTERY'`. FG view and `deriveFGStock`
are untouched; PO-level UPH-all-completed still drives FG appearance.

**Verification (initial):** typecheck + lint clean; existing 84 tests
unaffected (no test asserted the UPH-row-on-WIP behavior because it was
a bug). Manual: with a PO whose UPH was fully COMPLETED,
`/api/inventory/wip` no longer returned the UPH-coded rows;
`/api/inventory/finished-products` (or its frontend equivalent via
`deriveFGStock`) still did.

### Follow-up (2026-04-27): blanket filter over-hid partial-UPH POs

**Symptom:** For BF or sofa POs that are only **partially** UPH-complete
(e.g. BF Divan UPH done but HB still WAITING; sofa Cushion UPH done but
Base/Armrest still WAITING), the completed component's UPH `wip_items`
row got hidden from the WIP grid AND the PO didn't qualify as FG yet
(`deriveFGStock` requires *every* UPH JC of the PO to be COMPLETED). Net
result: the completed components disappeared from BOTH the WIP and FG
views — they were "in limbo".

**Root cause:** The initial SQL filter
`AND (deptStatus IS NULL OR deptStatus != 'UPHOLSTERY')` was a
PO-blind blanket exclusion. It assumed UPH-completed = PO-FG, but for a
multi-UPH-JC PO (BF has Divan+HB, sofa has Base+Cushion+Armrest) the
"this row is FG-equivalent" implication only holds when the PO's *last*
UPH JC is COMPLETED. While any UPH JC is still WAITING, the producer
rows for the already-completed UPH JCs need to remain WIP-visible.

**Fix (refined):** Replace the blanket SQL exclusion with a
PO-conditional JS post-filter in `src/api/routes-d1/inventory-wip.ts`.
Read all non-zero `wip_items` rows from SQL, then after the
`(pos, jcs, jcsByLabel, jcsByPo)` maps are built (used downstream for
sources / age / cost derivation anyway), compute per-PO
`fullyUphComplete` (TRUE iff the PO has at least one UPH JC and every
UPH JC is COMPLETED/TRANSFERRED). A UPH-coded `wip_items` row is HIDDEN
iff every PO that links to it via any JC's `wipLabel` is fully
UPH-complete; if any linked PO still has a pending UPH JC, the row
stays visible.

Implementation chose JS post-filter over the equivalent triple-nested
correlated SQL subquery because the route already loads `pos`/`jcs`
into memory for the per-row derivation that follows the filter — reuses
the same indexes for a smaller, more readable diff.

| State | WIP page | FG page |
|---|---|---|
| Only one UPH JC of a PO done (partial) | **Show** UPH row | Don't show |
| All UPH JCs of the PO done (full) | **Hide** UPH row | Show via `deriveFGStock` |
| Non-UPH dept rows | Always show | n/a |

Edge case preserved: a UPH-deptStatus row whose code has no matching JC
at all is still hidden (no PO is asserting partial-UPH visibility, so
the original blanket-hide intent applies).

**Verification (follow-up):** typecheck + lint clean (warnings/errors
present in the working tree are pre-existing and unrelated to this
file); 84/84 tests pass; manual SQL spot-checks per the task brief
(partial-BF: Divan row visible, HB row absent; full-BF: both rows
absent on WIP, PO surfaces as FG via `deriveFGStock`; partial-sofa:
Cushion row visible).

### Follow-up · BUG-2026-04-27-018: multi-PO sharing same wipLabel double-counted

**Symptom:** When two POs both produced the same UPH `wipLabel` (e.g.
two sofa POs both producing `5531 -Back Cushion 24`),
`wip_items.stockQty` aggregated both contributions (+2). If PO A was
fully UPH-complete (its +1 already in FG via `deriveFGStock`) but PO B
was partial (its +1 should still be in WIP), the per-PO filter saw "at
least one PO is partial → keep visible" and showed the **full** +2 on
the WIP grid. PO A's +1 was double-counted (also in FG).

**Root cause:** The PO-conditional filter from BUG-2026-04-27-017 was a
boolean show/hide gate that ignored qty attribution. It correctly kept
shared rows visible when any PO was partial but emitted the full
aggregate `stockQty`, not the partial-PO subset.

**Fix:** Per-PO attribution. For each UPH `wip_items` row, sum the
`wipQty` of UPH JCs whose PO is NOT fully UPH-complete; that sum is the
displayed `setQty` / `pieceQty` / `totalQty`. Sum = 0 → hide entirely
(every linked PO has gone to FG). Implemented as `adjustedStockByRowId`
in `src/api/routes-d1/inventory-wip.ts` next to the existing post-filter.

The raw `stock_qty` is **not** overridden in the ledger; only the
displayed WIP qty reflects "components not yet FG". Source aggregation
and cost roll-up still walk all completed producer JCs (unchanged) — a
fully-complete PO's source still appears in the row's `sources[]` if
the row is partial-but-shared, so the user can see who has gone to FG.

### Follow-up · BUG-2026-04-27-019: orphan UPH rows incorrectly hidden

**Symptom:** A `wip_items` row whose `code` matched no JC's `wipLabel`
at all (legacy / migration residue / external manual entry / stale
data after a JC purge) was hidden from the WIP grid — invisible to
the user with no recourse for cleanup.

**Root cause:** The follow-up filter from BUG-2026-04-27-017 read "no
linked PO" as vacuous-true on the EXISTS-style "every linked PO is
fully complete" check, so the row was treated as "fully complete
somewhere" and hidden. The original blanket-hide intent (preserved on
purpose) was wrong for orphan rows that have no PO context at all.

**Fix:** Default UPH orphans to **show**. Hide rule is now strictly:
at least one UPH JC links to this row AND every linked PO is fully
UPH-complete. No JC link → keep visible with the raw `stock_qty` so
the user can spot and reconcile orphan ledger entries.

---

## BUG-2026-04-27-016 — PACKING participated in inventory cascade — should be metadata-only step

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** Completing a PACKING job_card was firing the same
inventory-cascade write path as upstream depts: a producer-add to
`wip_items` for the FG-level wipLabel, and (via the `deptUpper !== 'UPHOLSTERY'`
generic-consume gate) potential consume-from-upstream side effects.
This contradicted the user's mental model:

- **UPHOLSTERY completed** = goods physically built. UPH consumes
  upstream wip_items (Divan, HB, Cushion, ...) and writes the FG-level
  +qty rows. Once all UPH JCs of a PO are complete, `deriveFGStock`
  surfaces the PO as FG.
- **PACKING completed** = just records `racking_number` on the PO row.
  It is a metadata step, NOT an inventory event — it does not consume
  any wip_items, it does not produce any. Boxes are just being put
  onto a shelf.

**Root cause:** `applyWipInventoryChange` had no PACKING short-circuit
— it treated PACKING like any other dept, falling through to the
generic upstream-consume gate (BUG-2026-04-27-013) and the
producer-add write at the bottom.

**Fix:** New short-circuit at the top of `applyWipInventoryChange`
(`src/api/routes-d1/production-orders.ts:864-879`), placed AFTER the
BUG-005 same-status guard and BEFORE the `wipLabel` computation:

```ts
const deptCodeRaw = (jcRow.departmentCode || "").toUpperCase();
const isPacking = deptCodeRaw === "PACKING";
if (isPacking) return;
```

Critically this only suppresses the wip_items writes. The PO-level
cascades that DO need to fire on PACKING completion all live in the
OUTER PATCH handler, not in `applyWipInventoryChange`:

- `current_department` flip (`production-orders.ts:1657`)
- PO PENDING/IN_PROGRESS → COMPLETED transition
  (`production-orders.ts:1644-1648`)
- `postJobCardLabor` (labor cost ledger, `production-orders.ts:1622-1635`)
- `postProductionOrderCompletion` — fg_units + fg_batches generation
  (`production-orders.ts:1697-1708`)
- `cascadePoCompletionToSO` (`production-orders.ts:1709-1717`)
- `cascadeUpholsteryToSO` (`production-orders.ts:1719-1726`)

All of those continue to fire on PACKING completion exactly as before.

Updated comment on the existing FAB_CUT/WOOD_CUT generic-consume gate
(`production-orders.ts:907-913`) to mention PACKING is bypassed at the
top.

**Verification:** typecheck + lint clean; existing 84 tests pass.
No test pinned the prior PACKING-cascade behavior (it was a bug).

---

## BUG-2026-04-27-015 — Negative-row Source POs over-collected: every higher-sequence COMPLETED JC in same wipKey was treated as a "trigger"

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom:** Clicking any negative-qty row on the WIP page popped open
the detail modal and listed **too many** Source POs. The same PO would
even repeat when it had multiple COMPLETED downstream JCs in the same
`wipKey`, even though only ONE of those downstreams actually triggered
the consume that wrote the negative.

User's reproduced examples (in D1):

- `wip_items.code = '1007-(K) -HB 20" (WD)"'`, stockQty = -1.
  Producer JC: WOOD_CUT seq=3 (WAITING) on PO `pord-so-bb601356-01`,
  branchKey `(Webbing)`. Cascade trigger: FRAMING seq=4 (COMPLETED)
  consumed `(WD)` → -1. WEBBING seq=5 (COMPLETED) consumed `(Frame)`,
  not `(WD)`. Popup listed **2** sources (both `SO-2604-314-01`)
  because the derivation also picked up WEBBING's completion as a
  "source" of `(WD)`.
- `1007-(K) -HB 20" PC151-01 (FC)` row showed **3** sources
  (FAB_SEW + FRAMING + WEBBING all completed downstream of FAB_CUT in
  the same wipKey).

**Root cause:** In `src/api/routes-d1/inventory-wip.ts` (lines 306-358),
the negative-row sources derivation walked every JC in the same
`wipKey` with `sequence > P.sequence` and status COMPLETED/TRANSFERRED,
not just the **immediate** downstream of the producer in the **same
branch**. For BOMs with parallel branches or multi-step chains this
over-collected: every later completed JC in the chain was attributed
as a "trigger" of the missing producer's negative, even though only the
direct neighbor that ran the cascade consume actually wrote the row.

The cascade write path (`applyWipInventoryChange()` in
`src/api/routes-d1/production-orders.ts`, BUG-2026-04-27-014) is
already correct: each dept's consume targets its **immediate** branch
upstream, and only that completion triggers the negative. The
inventory-wip read path was just attributing causality wrong.

**Fix:** Replaced the higher-sequence-in-same-wipKey collection with a
strict immediate-downstream pick. For each producer JC `P`:

1. Among JCs in `P`'s same `(wipKey, branchKey)`, take the one with the
   smallest `sequence > P.sequence` — this is `P`'s immediate
   downstream in that branch. There is at most one.
2. If that neighbor is COMPLETED or TRANSFERRED, its PO is a Source.
3. If not completed (still WAITING / IN_PROGRESS / NOT_STARTED), that
   PO did **not** trigger this row's negative — skip.

Then dedupe by **PO id** (defensive — under the immediate-downstream
rule duplicates shouldn't surface, but two producer JCs from the same
PO mapping to the same downstream stays one row).

Also fixed the `ageDays` field on negative-row sources: was hardcoded
`0`, now correctly computed as days since the triggering JC's
`completed_date`. `quantity` keeps using the **producer JC's** wipQty
(the consume amount), `completedDate` keeps coming from the
**triggering downstream JC** (the moment the negative was written) —
both per the user spec.

Edit in `src/api/routes-d1/inventory-wip.ts` around line 306-385: the
positive-row branch is unchanged. Producer-side wip_items writes /
cascade consume math is unchanged.

**Verification:**
1. `npm run typecheck:app` — clean for inventory-wip.ts (the
   pre-existing `delivery/index.tsx` merge-conflict markers are the
   same set documented in BUG-2026-04-27-014, unrelated to this fix).
2. `npm run lint:app` — 0 new errors, 0 new warnings (only the same
   pre-existing baseline warnings + the unrelated delivery/index.tsx
   merge-conflict parse error).
3. `npm test` — 83/83 passing.
4. Manual: with the fix, the user's `1007-(K) -HB 20" (WD)` row shows
   1 source (`pord-so-bb601356-01` whose FRAMING completed) instead
   of 2. The `(FC)` row shows 1 source (`pord-so-bb601356-01` whose
   FAB_SEW completed) instead of 3.

**Not touched:**
- The positive-row branch — unchanged.
- The cascade write path (`applyWipInventoryChange()`) — unchanged.
- Any DB schema or producer-side wip_items emit logic.

---

## BUG-2026-04-27-014 — UPH cascade decremented every upstream JC, not just per-branch terminals

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** Marking an Upholstery (UPH) JC `COMPLETED` on a sofa Base BOM
wrote 6 separate `-consumeQty` decrements — one for **every** upstream JC
in the same `wipKey` (FAB_CUT, FAB_SEW, WOOD_CUT, FRAMING, WEBBING, FOAM)
— instead of only the **branch terminal** of each BOM branch. So
completing UPH while wood-side depts (Wood Cut, Framing, Webbing) were
all incomplete drove three separate negative wip_items rows for that
branch, when only Webbing (the branch terminal — the JC immediately
upstream of UPH on that branch) should have gone negative.

User's correction: "Webbing missing should not also make Framing/WoodCut
negative — those would only go negative if Webbing itself were marked
complete with Framing/WoodCut missing." Each dept's negative is the
responsibility of the **direct downstream dept that completes** (FRAMING
consumes WOOD_CUT, WEBBING consumes FRAMING), not transitively from UPH.

**Root cause:** The UPH branch of `applyWipInventoryChange()` in
`src/api/routes-d1/production-orders.ts` (around line 1077-1119) did
`upstreamLabels = new Set<string>()` over every JC with `wipKey === wipKey
&& sequence < jcRow.sequence`, then decremented each one. That flattened
the BOM into a single chain — for a sofa Base with 6 upstream JCs across
2 parallel branches it wrote 6 decrements instead of 2.

The non-UPH consume gate (line 1015) was already correct: filter by
`(wipKey, branchKey)`, sort by sequence desc, take `[0]` — immediate
upstream only.

**Fix:** Replace the upstream-collection loop with a per-branch terminal
pick. Group upstream JCs by `branchKey`, keep the highest-sequence JC
per branch — that JC's wipLabel is the branch terminal, the only thing
UPH should consume. For the sofa Base BOM:

- Branch `(Webbing)` (wood-side): JCs at seq 2 (WOOD_CUT), 3 (FRAMING),
  4 (WEBBING) → terminal is WEBBING.
- Branch `{FABRIC} Foam` (fabric-side): JCs at seq 0 (FAB_CUT), 1
  (FAB_SEW), 5 (FOAM) → terminal is FOAM.

Result: UPH writes 2 decrements (one per branch terminal), not 6.

Edit in `src/api/routes-d1/production-orders.ts` around line 1077-1133:
swapped the `upstreamLabels = new Set<string>()` collection for a
`Map<branchKey, JobCardRow>` that keeps the highest-sequence JC per
branch. The downstream SELECT-then-UPDATE-or-INSERT logic (BUG-2026-04-27-013)
is unchanged. Added a code comment explaining the per-branch-terminal
invariant so a future refactor doesn't silently flatten it back.

**Not touched:**
- The non-UPH forward consume gate (around line 1015) — already correct,
  per-branch terminal pick already in place.
- The UPH rollback path (around line 936-955) — explicitly out of scope
  per the task brief.
- The producer-add path for UPH's own wip_items row.

**Verification:**
1. `npm run typecheck:app` clean for the production-orders.ts changes
   (the pre-existing `delivery/index.tsx` deliveryDate errors are
   unrelated to this fix and existed before this branch).
2. `npm run lint:app` 0 errors, only pre-existing react-hooks/exhaustive-deps
   warnings unchanged from baseline.
3. `npm test` 83/83 passing, including the BUG-2026-04-27-013 pins:
   - "cascade consume is unclamped — no MAX(0, stockQty - qty)"
   - "cascade consume inserts a negative-qty row when upstream is missing"

---

## BUG-2026-04-27-013 — wip_items consume silently no-ops on missing/zero upstream — now goes negative

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** When a downstream dept (e.g. FAB_SEW) is marked COMPLETED
without its upstream dept (e.g. FAB_CUT) ever being completed, the
inventory cascade silently no-op'd. The `wip_items` row for the upstream
dept either didn't exist (so the UPDATE missed) or sat at `stockQty = 0`
(so the `MAX(0, stockQty - ?)` clamp pinned it at 0). The user had no
WIP-board signal that an upstream dept got skipped.

**Root cause:** `applyWipInventoryChange()` in
`src/api/routes-d1/production-orders.ts` had three call sites that all
used `MAX(0, stockQty - ?)`:

1. **Forward non-UPH consume** (around line 906) — fires on
   `becomingActive` for non-FAB_CUT, non-WOOD_CUT, non-UPH depts.
   Updated the most recent done sibling's `wip_items` row at lower
   sequence within the same `(wipKey, branchKey)` chain.
2. **Rollback non-UPH own-row decrement** (around line 957) — the
   `wasDone && !isDone` branch.
3. **UPH cascade upstream consume** (around line 1057) — when UPH
   completes, iterates every upstream `wipKey` sibling and decrements.

In all three, the clamp swallowed the signal: stock just floored at 0.
And the forward path was further blind to the case where the upstream
`wip_items` row had never been INSERTed at all (the UPDATE quietly
matched 0 rows).

**Fix:** Per user's reason ("the negative number is the visibility
signal"), the cascade now **always decrements without clamp**. If the
target row is missing, INSERT a stub row with `stock_qty = -consumeQty`,
`status = 'PENDING'`, matching the producer-upsert path's INSERT shape.
Rollback own-row decrement is also unclamped, symmetric with the forward
path.

Edits in `src/api/routes-d1/production-orders.ts`:
- Forward non-UPH consume: SELECT-then-UPDATE-or-INSERT, no MAX clamp.
- Rollback non-UPH own-row: `stockQty = stockQty - ?`, no MAX clamp.
- UPH cascade upstream: SELECT-then-UPDATE-or-INSERT per upstream label,
  no MAX clamp.
- UPH rollback own-row: also unclamped (symmetric).
- Stale comment "BF uses MAX(0, stockQty - qty) clamp" updated.

**Verification:**
1. `npm run typecheck:app` clean for the production-orders.ts changes
   (the one pre-existing `inventory/index.tsx` ProductionOrderLike.id
   error is unrelated to this fix).
2. `npm run lint:app` no new errors / warnings.
3. `npm test` 83/83 passing, including two new pins in
   `tests/production-wip-producer-output.test.mjs`:
   - "cascade consume is unclamped — no MAX(0, stockQty - qty)"
   - "cascade consume inserts a negative-qty row when upstream is missing"
4. Walked through the FAB_SEW-before-FAB_CUT scenario for a PENDING
   sofa PO. Expected behaviour with the fix: the FAB_SEW
   becomingActive consume looks up the most recent `(wipKey, branchKey)`
   sibling at lower sequence (FAB_CUT). FAB_CUT's `wip_items` row does
   not exist (FAB_CUT was never completed). The SELECT returns null,
   the INSERT path fires, a `wip_items` row appears with
   `code = <FAB_CUT wipLabel>`, `stockQty = -1`, `status = 'PENDING'` —
   surfacing the skipped FAB_CUT on the WIP board.

**Not in scope:** the COMPLETED→COMPLETED replay non-idempotency
(BUG-2026-04-27-005) is unchanged; this fix only swaps clamp for
unclamped + insert-if-missing.

---

## BUG-2026-04-27-010 — Dept-Pivot editor lists DRAFT BOMs as duplicate rows

**Status:** 🟢 Fixed (2026-04-27)
**Category:** bom

**Symptom:** In the new Dept-Pivot Category Editor, products like `1003-(K)`
and `5530-1NA` show twice (identical category/minutes) because the row
builder reads ALL rows in `bom_templates`, not just the ACTIVE one.

**Root cause:** `src/pages/bom.tsx` `DeptPivotCategoryDialog` calls
`buildDeptPivotRows(templates, deptCode)` with the unfiltered `templates`
array. Two products currently have a v2.0 DRAFT alongside the v1.0
ACTIVE row.

**Fix:** filter `templates` to `version_status === 'ACTIVE'` at the call
site before passing to the row builder. Helper stays generic.

**Verification:** total row count drops from 512 → expected ~510 (drops the 2
duplicates) when Wood Cut is selected.

---

## BUG-2026-04-27-011 — Dept-Pivot Branch/Code shows raw template tokens

**Status:** 🟢 Fixed (2026-04-27)
**Category:** bom

**Symptom:** Branch/Code column reads
`{DIVAN_HEIGHT} Divan- {SIZE} / {DIVAN_HEIGHT} Divan- {SIZE} Foam / ...`
instead of the resolved sample (`8" Divan- 6FT (WD)`) the BOM Structure tree
shows. Hard to read at scale.

**Root cause:** `buildDeptPivotRows` joins ancestor `wipCode` strings
verbatim without running them through `resolveWipTokens`. The pivot also
doesn't carry per-product variant context (sizeLabel / divanHeightInches /
fabric etc.) — so even if it tried, the substitutions would be empty.

**Fix:** at row build time, look up the `Product` row by `productCode`,
build a `BomVariantContext`, and call `resolveWipTokens(template, ctx)` on
the **leaf** node's wipCode (the deepest node owning the matched process).
Drop the ancestor-chain join — the leaf alone is the meaningful label.

**Verification:** Wood Cut row for `1003-(K)` should display
`8" Divan- 6FT (WD)`, matching the BOM Structure view.

---

## BUG-2026-04-27-012 — DRAFT BOM versions left orphaned after confirm flow

**Status:** 🔴 Identified (deferred)
**Category:** bom

**Symptom:** `bom_templates` carries 2 leftover DRAFT rows
(`bom-tpl-1003-(K)-v2`, `bom-tpl-5530-1NA-v2`, both v2.0 effective
2026-05-01) alongside their ACTIVE v1.0 counterparts. User asked: "I
confirmed it, why is the DRAFT still there?"

**Root cause (suspected):** the BOM versioning UI lets the user create a
v2.0 DRAFT but doesn't have a clean "confirm = promote DRAFT to ACTIVE,
mark old ACTIVE as OBSOLETE" flow. After "save" the DRAFT just lingers.
Need to inspect the BOM editor's save path to confirm.

**Fix plan (not yet implemented):**
1. Audit the create-DRAFT-then-save code path in `src/pages/bom.tsx`. If
   confirm is supposed to promote the DRAFT, fix the save handler to
   transition `DRAFT → ACTIVE` and the previous `ACTIVE → OBSOLETE`.
2. Until that's done, the 2 leftover DRAFTs are safe to delete (no
   downstream queries match `version_status='DRAFT'` because the BOM-fetch
   helpers all filter `WHERE version_status = 'ACTIVE'`).

---

## BUG-2026-04-27-005 — `applyWipInventoryChange` not idempotent on COMPLETED→COMPLETED replay

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** Marking the same JC complete twice double-deducts upstream
wip_items and double-adds the producer row. The cascade has no per-JC guard
against repeat COMPLETED dispatches. Re-surfaced 2026-04-27 on
`pord-so-f6084c68-02` (5531-L(RHF)): 1 PO, qty=1, 1 UPHOLSTERY JC at
COMPLETED, but the wip_items rows showed `5531-L(RHF) -Base 24` = +2,
`(Foam)` = -2, and `M2402-5` = -2 instead of the expected +1 / -1 / -1 —
the cascade fired twice for the same JC's COMPLETED transition (duplicate
PATCH: form re-submit / refresh-and-retry / two operators racing the same
JC / scan-complete + manual-PATCH overlap).

**Root cause:** `src/api/routes-d1/production-orders.ts:844-851`
`applyWipInventoryChange` ran the consume + producer-upsert path
unconditionally on every status='COMPLETED' call. The `MAX(0, …)` clamp
used to hide the upstream-consume side, but BUG-2026-04-27-013 removed
those clamps so doublings now propagate fully.

**Fix:** Added a single-line short-circuit guard at the very top of
`applyWipInventoryChange()` (`src/api/routes-d1/production-orders.ts:852-856`):

```ts
if (prevStatus !== null && prevStatus === newStatus) return;
```

Bails out only when the PATCH supplied a prevStatus AND it equals the new
status — i.e. the operator re-sent the same status without an actual
transition. The first COMPLETED transition still fires (prevStatus is
WAITING / IN_PROGRESS, !==), the DONE→non-DONE rollback (`wasDone &&
!isDone`) still fires, and legacy callers that omit prevStatus (default
`null`) are unaffected — behaviour matches today.

**Verification:** New source-pin test
`applyWipInventoryChange short-circuits on prevStatus === newStatus` in
`tests/production-wip-producer-output.test.mjs` greps for the guard and
fails if a future refactor removes it. The user's reproduction
(`pord-so-f6084c68-02`, +2 / -2 / -2 instead of +1 / -1 / -1) will
produce the expected counts once the guard is in place — duplicate
PATCHes no-op the second cascade fire.

---

## BUG-2026-04-27-006 — `cascadeUpholsteryToSO` runs on every PATCH, not just status changes

**Status:** 🔴 Identified (low priority)
**Category:** inventory-cascade

**Symptom:** Every PATCH to a job_card (PIC re-assign, due-date edit, etc.)
fires `cascadeUpholsteryToSO`, even when status didn't change.

**Root cause:** the call sits **outside** the `if (body.status …)` gate at
`src/api/routes-d1/production-orders.ts:1642`. Functionally safe (only
writes when SO-completion conditions are met) but does redundant DB work
on every save.

**Fix plan:** move the call inside the `if (body.status …)` branch, or add
a precondition check that bails when no relevant JC has transitioned.

---

## BUG-2026-04-27-007 — Audit event write failures swallowed silently

**Status:** 🔴 Identified (low priority)
**Category:** audit-logging

**Symptom:** When `diffJobCardEvents` → batch INSERT to `job_card_events`
fails (D1 hiccup, schema drift, etc.), the JC update at T+2 has already
committed and we lose the audit row with no user-visible signal.

**Root cause:** `src/api/routes-d1/production-orders.ts:1481-1501` wraps
the audit batch in try/catch and only `console.error`s. Audit-row
insert-failure is not surfaced to the user, so audit gaps accumulate.

**Fix plan:** stand up a dead-letter queue for failed audit rows (so we
can replay), or at least bump these to a structured monitor (Cloudflare
Logs Insights / Analytics Engine) instead of plain console.error so we
can alert.

---

## BUG-2026-04-27-008 — `fg_units.status='PENDING'` after PO completion (not `IN_STOCK`)

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom:** Post-PACKING-complete, the cascade writes `fg_units` rows
with `status='PENDING'` (see `src/api/routes-d1/fg-units.ts:272`). Name
is misleading — these units ARE finished / in stock; PENDING here means
"not yet packed/loaded onto a DO". They later transition to LOADED →
DELIVERED via the delivery_orders flow.

**Root cause:** legacy naming choice. The fact that
`deriveFGStock` (frontend) counts UPH-done POs independently of
`fg_units.status` masks the confusion in most views.

**Fix:** Flipped the INSERT default in `generateFGUnitsForPO`
(`src/api/routes-d1/fg-units.ts:284`) from `'PENDING'` to `'PACKED'`. The
schema CHECK constraint allows
`PENDING / PENDING_UPHOLSTERY / UPHOLSTERED / PACKED / LOADED / DELIVERED
/ RETURNED` (`migrations/0001_init.sql:769`); there is no `IN_STOCK` /
`READY` / `AVAILABLE` value, so we picked the closest existing value.
`PACKED` matches the post-PACKING-JC reality: `generateFGUnitsForPO` is
only invoked from `postProductionOrderCompletion`, which fires on the
PO's PENDING → COMPLETED transition (i.e. ALL job_cards including
PACKING are done). By the time fg_units rows land, the unit is boxed
and racked, awaiting LOAD onto a DO. Downstream scan transitions
(LOADED → DELIVERED → RETURNED) are unchanged. The PACK action handler
gracefully no-ops on already-PACKED rows ("Cannot PACK — unit already
PACKED"), which now reflects the correct lifecycle. No schema
migration was required.

---

## BUG-2026-04-27-009 — `inventory-wip.ts` derives baseModel via `productCode.split("-")[0]`

**Status:** 🔴 Identified (display only)
**Category:** inventory-display

**Symptom:** The inventory-WIP grouping uses
`(po.productCode || "").split("-")[0]` to compute baseModel
(`src/api/routes-d1/inventory-wip.ts:343`). Works for sofa
(`5531-L(RHF)` → `5531`) but fails for BF variants whose suffix uses
parens before any hyphen (e.g. `1003(A)(HF)(W)` has no hyphen → returns
the whole string). Causes incorrect grouping in the WIP board for those
SKUs.

**Root cause:** heuristic instead of reading
`bom_templates.baseModel` (which IS authoritative).

**Fix plan:** join wip_items rows back to `bom_templates` (or
`products.baseModel` if present) and use the canonical value. Alternative:
parse SKU via the existing `parseSku` util elsewhere in the codebase.

---

## BUG-2026-04-27-001 — `completed_date` silently cleared on unrelated PATCH

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom (user-reported):**
User filled the Foam dept completion date for SO-2604-309 / `pord-so-f6084c68-02`
(5531-L(RHF), Carress). Date saved at first — Webbing WIP got consumed as
expected. Then the date silently disappeared. Webbing inventory was already
gone, Foam never appeared, so the warehouse showed nothing.

**Affected data:**
- `job_cards` rows for FOAM dept on `pord-so-f6084c68-02`: `status=WAITING`,
  `completed_date=NULL`
- `wip_items`: no FOAM rows for `5531-L(RHF)`. WEBBING rows existed only for
  Right Arm (Base + Back Cushion gone)

**Root cause:**
`src/api/routes-d1/production-orders.ts:1271-1284` — the PATCH branch:
```ts
if (body.status) {
  ...
  if (isDone) { ... }
  else if (body.completedDate === undefined) {
    updated.completedDate = null;   // ← clears regardless of prior state
  }
}
```
Any PATCH that sent `body.status` without an explicit `body.completedDate`
nulled the field. So *any* status touch on an already-completed JC (e.g. a
PIC re-assign that re-sent status, an "edit due date" form that included
status=WAITING) would wipe the completion date. Coupled with bug #2 below,
the inventory cascade did not roll back, leaving books off.

**Fix:**
Only clear `completed_date` when the JC is **actually transitioning OUT of a
DONE state** (i.e. previous status was COMPLETED/TRANSFERRED and new one is
not). Otherwise leave the date alone — explicit `body.completedDate` still
overrides as before.

**Verification:**
- Code: `production-orders.ts:1271-1295` — see `wasDone` branch.
- Type-check + lint pass.
- TODO: end-to-end replay against a test PO once deployed.

---

## BUG-2026-04-27-002 — `applyWipInventoryChange` has no rollback path

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:**
Toggling a job card COMPLETED → WAITING (intentionally or via bug #001)
does NOT refund the upstream wip_items consumption nor decrement the
producer's own row. Each forward toggle adds; each reverse leaves it. Net
effect: stockQty drifts further from reality on every cycle.

**Evidence in production data:**
- `wip_items` row `5531-L(RHF) -Right Arm (WC)` had `stock_qty=2` while only
  one PO existed (the cycle had been triggered twice).
- `wip_items` had no FOAM rows at all yet UPHOLSTERY showed COMPLETED in
  `job_cards` — the COMPLETED → WAITING transition that cleared FOAM (bug #1)
  never refunded the stock that UPHOLSTERY had already consumed.

**Root cause:**
`src/api/routes-d1/production-orders.ts:823-1019` `applyWipInventoryChange`
only handles forward transitions:
- Becoming active → consume upstream
- Becoming COMPLETED → upsert producer row (or for UPH, consume all upstream
  siblings + write UPH row)
There is no `wasDone && !isDone` branch.

**Fix:**
Pass `prevStatus` into `applyWipInventoryChange`. When prev was DONE and new
is not, run the inverse:
- Non-UPH: `wip_items[wipLabel].stock_qty -= wipQty` (clamped at 0); refund
  the upstream sibling's consumption: `wip_items[upstream.wipLabel].stock_qty
  += wipQty`.
- UPH: `wip_items[wipLabel].stock_qty -= wipQty` (UPH's own row); refund each
  upstream sibling.

**Verification:**
- Code: `production-orders.ts:884-940` (rollback branch added before the
  forward paths).
- Both call sites (`:1483-1493` PATCH path, `:2575-2582` scan path) now
  pass `prevStatus`.
- Type-check + lint pass.
- TODO: end-to-end test toggling COMPLETED → WAITING → COMPLETED and
  asserting `stock_qty` returns to the same value.

---

## BUG-2026-04-26-003 — Upstream-sequence lock disabled

**Status:** 🔴 Identified (deferred)
**Category:** production-orders

**Symptom:**
Operators can mark a downstream dept (e.g. UPHOLSTERY) COMPLETED while
upstream depts (e.g. FOAM) are still WAITING. Combined with bugs #1 + #2,
this produced the Foam-skipped-but-UPH-done state seen in
`pord-so-f6084c68-02`.

**Root cause:**
`src/api/routes-d1/production-orders.ts:1255-1266` — guard intentionally
disabled by user request 2026-04-26 because the wipKey + sequence predicate
didn't model the BOM tree's parallel branches. Within one wipKey the FAB
chain (FAB_CUT→FAB_SEW…) and WOOD chain (WOOD_CUT→FRAMING→WEBBING…) run
independently and only converge at UPHOLSTERY. The previous predicate
treated WOOD_CUT (sequence 3) as downstream of FAB_CUT/FAB_SEW (1/2), so
completing Wood Cut wrongly 409'd date edits on the fabric branch.

**Fix plan (not yet implemented):**
Re-derive the lock chain from the actual BOM template at runtime so parallel
branches are honoured. Until then, the lack of this guard means bug #1 / #2
have larger blast radius.

---

## BUG-2026-04-27-004 — `wip_label` frozen at JC creation, never resyncs from BOM

**Status:** 🟢 Fixed (2026-04-27)
**Category:** bom

**Symptom (user-reported):**
BOM page for SOFA 5531 defines the back-cushion / armrest WIPs as
model-level — `5531 -Back Cushion 30"`, `5531 -Left Arm` — without the
variant prefix (`-2A(LHF)` / `-L(RHF)` etc.). The production tracking sheet
nonetheless shows `5531-L(RHF) -Back Cushion 24 (WC)` and
`5531-2A(LHF) -Left Arm (WC)`. After the user updates a BOM, existing POs
do not pick up the new naming.

**Root cause:**
1. `src/api/lib/bom-wip-breakdown.ts:119` — `resolveWipTokens` substitutes
   the `{MODEL}` placeholder with `productCode`, the same value used for
   `{PRODUCT_CODE}`. The two tokens were intended to differ (`{MODEL}` =
   parent/base model, `{PRODUCT_CODE}` = full variant SKU). With both
   resolving to the variant code, BOM templates that meant "model-level"
   (e.g. `{MODEL} -Back Cushion {SEAT_SIZE}`) render with the full variant
   prefix.
2. `bom_templates` already has a `baseModel` column (e.g. `5531`) but none
   of the call sites (`jobcard-sync.ts:88-101`, `sales-orders.ts:458-466`,
   `sales-orders.ts:825-833`) read it or thread it into the variant context.
3. JC `wip_label` is stamped on INSERT and never re-rendered against the
   current BOM. Existing POs are stuck with whatever was correct (or wrong)
   the day they were generated.

**Fix:**
- Add `model: string | null` to `BomVariantContext`; `resolveWipTokens`
  uses it for `{MODEL}` and falls back to `productCode` only when missing.
- Update every BOM-fetch SQL to also select `baseModel`, and every variant
  builder to set `model: bomRow?.baseModel ?? null`.
- Extend `POST /api/production/sync-jobcards-from-bom` to also UPDATE
  existing JCs' `wip_label` / `wip_code` / `wip_key` for `WAITING` rows
  whose downstream siblings have not yet been completed (so we don't
  orphan `wip_items` keyed by the old label).
- Provide a one-shot migration script `scripts/resync-wip-labels.ts` that
  also renames `wip_items.code` so historical stock follows the new naming.

**Verification:**
- Code: `bom-wip-breakdown.ts:45-59` (`model` field) + `:127-140` (token
  resolution). All 3 BOM-fetch sites updated:
  `jobcard-sync.ts:88-115`, `sales-orders.ts:435-470`, `:806-840`.
- Migration script `scripts/resync-wip-labels.ts` ran against production
  on 2026-04-27. Stats: scanned 561 POs, 176 needed updates, 3556 JC
  field changes, 3556 `wip_items` renames. Post-migration query for
  variant-doubling pollution returned **0** rows.
- Spot-check on `pord-so-f6084c68-02` (the original report): now reads
  `5531 -Back Cushion 24 (WC)`, `5531 -Right Arm (WC)`, with Base
  correctly variant-prefixed (`5531-L(RHF) -Base 24 (WC)`).
- Type-check + lint pass on all 5 modified files.

**Related observations during audit:**
- `inventory-wip.ts:343` derives `baseModel` via `productCode.split("-")[0]`
  rather than reading `bom_templates.baseModel`. Heuristic fails for BF
  variants whose suffixes use parens (e.g. `1003(A)(HF)(W)`). Display-only
  bug — out of scope for this round, logged for follow-up.
- `sales_order_items.size_code` is clean across the corpus (1 row with
  `24 x 37` is intentional stool dimension, not pollution). The size_code
  pollution that surfaced in the JC labels was a render-time artifact, not
  a stored-data bug.

---

## BUG-2026-04-27-022 — fix(do): customerId fallback to first PO's customerName for multi-SO DOs

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** After 9d30215 dropped the multi-customer/state restriction, multi-SO
selections hit the next downstream guard: "customerId or salesOrderId
is required". The check expected either explicit customerId in the body
OR a resolved salesOrderRow — multi-SO DOs left both null.

**Verification:** Code shipped via commit `e4c096d` to `main`.

---

## BUG-2026-04-27-023 — fix(do): single source of truth for Pending Delivery selection

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** ROOT CAUSE of every "multi-customer" toast despite "1 selected" badge:
two parallel selection states.

**Verification:** Code shipped via commit `0b8db36` to `main`.

---

## BUG-2026-04-27-024 — Reapply "fix(delivery): pending-delivery dedup by PO id, not SO id"

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** This reverts commit af815d7ed7016d1e29888e638a6aa3afeeca5518.

**Verification:** Code shipped via commit `c702588` to `main`.

---

## BUG-2026-04-27-025 — Revert "fix(delivery): pending-delivery dedup by PO id, not SO id"

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** This reverts commit 13ce4f8e892a834392156bcbb8973e81148f6240.

**Verification:** Code shipped via commit `af815d7` to `main`.

---

## BUG-2026-04-27-026 — fix(delivery): pending-delivery dedup by PO id, not SO id

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** BUG-2026-04-27 (multi-SO DO follow-up): after creating a DO that spans
multiple SOs (now allowed since 3e2682b), the source POs stayed visible
in "Production Complete — Ready for DO" so the operator could double-
add them to a second DO.

**Verification:** Code shipped via commit `13ce4f8` to `main`.

---

## BUG-2026-04-27-027 — fix(do): create-DO uses live selection, not dialog-open snapshot

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** User report 2026-04-27: clicking Create DO with 1 row selected still
returned "Selected production orders span multiple customers or states"
toast. Verified backend POST works for any single-PO request. Root
cause was on the frontend:

**Verification:** Code shipped via commit `baf3365` to `main`.

---

## BUG-2026-04-27-028 — fix(bom): master-template + Above wraps as parent · delete promotes children

**Status:** Fixed (2026-04-27)
**Category:** bom

**Symptom / Fix:** Two semantic fixes in the Master Template editor:

**Verification:** Code shipped via commit `9560103` to `main`.

---

## BUG-2026-04-27-029 — fix(db): Hyperdrive needs prepare:false (Supavisor 6543 rejects prepared statements)

**Status:** Fixed (2026-04-27)
**Category:** infrastructure

**Symptom / Fix:** ROOT CAUSE for every "empty grid / Data Not Found" the user has reported
since the Cloudflare migration. EVERY DB-touching endpoint returns 500
"Internal Server Error" — verified live:
  /api/inventory   → 500
  /api/products    → 500
  /api/auth/me     → 500 (auth middleware crashes before token check)
  /api/pg-ping     → 500
  /api/health      → 200 (no DB)

**Verification:** Code shipped via commit `2d2e7e5` to `main`.

---

## BUG-2026-04-27-030 — fix(production): packing-row upstream date aggregate (sofa merge view)

**Status:** Fixed (2026-04-27)
**Category:** production-orders

**Symptom / Fix:** Sofa POs have 3 component branches (Base / Cushion / Armrest), each with
their own per-dept JCs. At PACKING they merge into one JC with
wipKey="FG". The Production Sheet's Packing tab was rendering "—" for
every upstream-dept date column on sofa rows because:

**Verification:** Code shipped via commit `96b88db` to `main`.

---

## BUG-2026-04-27-031 — fix(bom): s/Faom/Foam/ across BOM + JC + wip_items (Sofa Base typo)

**Status:** Fixed (2026-04-27)
**Category:** bom

**Symptom / Fix:** The Sofa Base BOM had a long-standing "(Faom)" typo. Functionally
harmless (the BOM-walked branchKey still groups correctly within each
PO because every Sofa Base wood JC consistently shared the same typo'd
key), but visible to operators reading the WIP / branchKey columns —
and confusing because every other Sofa wood branch reads "(Foam)".

**Verification:** Code shipped via commit `a8c89ba` to `main`.

---

## BUG-2026-04-26-004 — fix: strip remaining inline 'm³' suffixes — full system uniform

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Wei Siang Apr 26 2026: '不需要的 我们就全部系统都统一吧'. Cell values
go bare across the system; column/label provides the unit.

**Verification:** Code shipped via commit `1ed675f` to `main`.

---

## BUG-2026-04-26-005 — fix: drop inline m³ suffix on cell values — header already labels the unit

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Wei Siang Apr 26 2026: 'Unit (m³) 那边放了一点格式 可是我其他的没有 ...
你就跟着普通格式就行 不需要把那个 M3 特别放出来 我们已经有 header 了'.

**Verification:** Code shipped via commit `0b7ed24` to `main`.

---

## BUG-2026-04-26-006 — fix(fe-be-align): #2 build /api/purchase-invoices CRUD + migration

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** src/pages/procurement/pi.tsx was 100% client-side mock — generateMockPIs
synthesized rows from RECEIVED purchase_orders and "Approve" / "Mark
Paid" actions only mutated useState. Refresh = state lost. The audit's
case #2.

**Verification:** Code shipped via commit `59868a4` to `main`.

---

## BUG-2026-04-26-007 — fix(inventory-wip): FAB_CUT now uses card.wipLabel like every other dept

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** Wei Siang Apr 26 2026: Inventory WIP page still showed the old
synthesized merged-style label for FAB_CUT rows ('1007-(K) | (6FT) |
(20") | (DV 8") | PC151-01 | (FC)' for both HB and Divan), while
the Production sheet shows them with proper per-component BOM names
('1007-(K) -HB 20" PC151-01' vs '8" Divan-6FT PC151-01').

**Verification:** Code shipped via commit `ab76156` to `main`.

---

## BUG-2026-04-26-008 — fix(fe-be-align): #4 wire Resend into supplier PO notification

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** notifySupplierPoSubmitted was a console.log stub: clicking "Send to
Supplier" returned 200, audit_events recorded a status change, but no
email ever left the building. Suppliers waited indefinitely for orders
they didn't know existed. UI promised something the backend never did.

**Verification:** Code shipped via commit `bedc08c` to `main`.

---

## BUG-2026-04-26-009 — fix(fe-be-align): #3 DO status enum + missing LOADED→IN_TRANSIT button

**Status:** Fixed (2026-04-26)
**Category:** delivery-orders

**Symptom / Fix:** Frontend's DOStatus type drifted from backend's VALID_TRANSITIONS in
two ways the audit caught:

**Verification:** Code shipped via commit `f05548f` to `main`.

---

## BUG-2026-04-26-010 — fix(fe-be-align): batch A — PO close transition · _stub warn · lock UI off · stale comment

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Four FE/BE drift fixes from the 2026-04-26 audit, bundled because each
is a small change with no shared surface area:

**Verification:** Code shipped via commit `3f805ef` to `main`.

---

## BUG-2026-04-26-011 — fix(data-grid): drive virtualizer paddingBottom from sortedData.length

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Filter alignment in Fab Sew was still drifting after the
VIRTUALIZE_MIN_ROWS=100 fix. Root cause: rowVirtualizer.getTotalSize()
lags one render behind a sharp count drop. When a column filter narrows
1,200 rows down to ~150, the body renders the 150 clipped rows
correctly but paddingBottom still computes against the stale 1,200-row
total, leaving a multi-thousand-pixel blank gap below the visible rows.

**Verification:** Code shipped via commit `c905d33` to `main`.

---

## BUG-2026-04-26-012 — fix(delivery): revert Items + Total M³ tooltip mods — only add new column

**Status:** Fixed (2026-04-26)
**Category:** delivery-orders

**Symptom / Fix:** Per Wei Siang Apr 26 2026: '添加 column 不是加进去'. Reverts the
hover tooltip injection on the existing 'Items' (count) and 'Total
M³' columns; both now render exactly as before this session. The
new 'Item Details' column remains as the only addition.

**Verification:** Code shipped via commit `5cda548` to `main`.

---

## BUG-2026-04-26-013 — fix(ts): replace stale JcPatch type reference with Parameters<>

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** See commit `4cf5562` for details.

**Verification:** Code shipped via commit `4cf5562` to `main`.

---

## BUG-2026-04-26-014 — fix(api): no-store cache-control on every /api/* response

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Wei Siang Apr 26 2026: after wrangler --remote D1 reset, browser kept
seeing pre-reset rows even though wrangler confirmed 0 done JCs in
the table. Root cause likely: Cloudflare edge / browser HTTP cache
holding stale API responses without explicit no-store directive.

**Verification:** Code shipped via commit `ebd5240` to `main`.

---

## BUG-2026-04-26-015 — revert(cache): undo v1→v2 namespace bump (was one-shot, not needed)

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Per Wei Siang Apr 26 2026: 'this is only one-time'. 375adc1 already
drops the TTL gate from cachedFetchJson, so once a browser loads the
new bundle every API call hits the network. The v2 namespace bump
was just a one-time cleanup of v1 leftovers — not a permanent fix and
not what the user asked for. Reverting.

**Verification:** Code shipped via commit `0bf01e0` to `main`.

---

## BUG-2026-04-26-016 — fix(cache): bump namespace v1→v2 to orphan stale frontend caches

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Wei Siang Apr 26 2026: every D1 reset / data update was hidden by the
5-min TTL gate on cachedFetchJson. Even after 375adc1 dropped the
gate, browsers still on the OLD bundle kept reading the OLD v1 cache.

**Verification:** Code shipped via commit `fdf0516` to `main`.

---

## BUG-2026-04-26-017 — fix(cache): drop TTL gate on imperative cachedFetchJson too

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Mirror of d8f71d2 (useCachedJson SWR) but for the imperative
`cachedFetchJson` callers. Without this, the 5-min TTL kept Inventory
WIP staring at a stale populated payload after a D1 reset (Wei Siang
Apr 26 2026: cleared all JC completion dates + wip_items.stockQty,
Production page emptied immediately, Inventory WIP didn't budge).

**Verification:** Code shipped via commit `375adc1` to `main`.

---

## BUG-2026-04-26-018 — revert(wip): drop PO-level FAB_CUT suppression (7/8)

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** Reverts `25099c9`. Inventory WIP Pass 1 now uses pure per-component
edge detection (card done && next not done) for every dept including
FAB_CUT. No more PO-level fabric-pulled fan-out.

**Verification:** Code shipped via commit `3833bcc` to `main`.

---

## BUG-2026-04-26-019 — fix(wip): synthesize wipLabel fallback for non-BOM producer JCs

**Status:** Fixed (2026-04-26)
**Category:** inventory-cascade

**Symptom / Fix:** Wood Cut completion silently skipped the wip_items upsert when
jcRow.wipLabel was null (createJobCards() emits non-BOM JCs without
wip* fields). Fallback synthesizes the label from
(productCode, wipCode|wipKey, departmentCode) so every producer dept
always lands a wip_items row.

**Verification:** Code shipped via commit `2f035b1` to `main`.

---

## BUG-2026-04-26-020 — fix(production): scope upstream lock to same wipKey (Wood Cut ≠ Fab Cut chain)

**Status:** Fixed (2026-04-26)
**Category:** production-orders

**Symptom / Fix:** User reported (2026-04-26): Wood Cut completion locked Fab Cut + Fab
Sew on the same row, even though those three are independent component
chains (different wipKey). Per memory/project_production_lifecycle.md
JCs are generated one-per-(wipComponent × department), and the
upstream lock should only fire across the SAME wipKey chain.

**Verification:** Code shipped via commit `ccd0de3` to `main`.

---

## BUG-2026-04-26-021 — fix(sales): drop wrong '(Mattress)' label on SOFA category option

**Status:** Fixed (2026-04-26)
**Category:** sales-orders

**Symptom / Fix:** The system has 3 categories: BEDFRAME / SOFA / ACCESSORY. There is no
'mattress' category — that word was the user's verbal shorthand for
sofa in an earlier conversation, and I incorrectly stamped it into the
filter dropdown label. Reverting to plain 'Sofa' to match the rest of
the app.

**Verification:** Code shipped via commit `97b8e15` to `main`.

---

## BUG-2026-04-26-022 — fix(data-grid): below 100 rows skip virtualizer (cures filter alignment)

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** User reported "为什这个一直不alignment 上千次了" on /production/fab-cut.
After applying a column filter (460 → 3 rows), badge correctly read
"3 of 460 records" + "Record 1 of 3" but the body rendered ~11 rows.

**Verification:** Code shipped via commit `60e1611` to `main`.

---

## BUG-2026-04-26-023 — fix(sales): atomic clearFilters — single setSearchParams, not 7 races

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** User reported "我clear不到那个filter" on /sales. The clearFilters handler
was firing 7 sequential setFilterX("") calls; each calls navigate() under
the hood. react-router-dom v7's setSearchParams reads from a ref that
doesn't always reflect the previous navigate's pending update, so later
deletes could overwrite earlier ones — net effect: filters re-appear.

**Verification:** Code shipped via commit `71e0fdc` to `main`.

---

## BUG-2026-04-26-024 — fix(data-grid): clip virtualItems to sortedData.length so body matches badge

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Fab Cut Production Sheet: applying the Status column dropdown filter
("COMPLETED" only) updated the "X of Y records" badge to "3 of 460" but
the rendered body kept emitting ~11 mixed-status rows. Fab Sew filtered
correctly. Same DataGrid component on both, but FAB_CUT's deptRows merge
plus prior scroll activity left tanstack-virtual's getVirtualItems()
returning indices that were valid against the *previous* count (460)
even after React passed the shrunken count (3) on the same render.

**Verification:** Code shipped via commit `80cbd00` to `main`.

---

## BUG-2026-04-26-025 — fix(prod-500): defensive try/catch + LIMIT caps on 3 dogfood crash sites

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Real-browser dogfood test on prod (https://hookka-erp-testing.pages.dev)
showed three endpoints returning 500 with no `db;dur=` segment in the
Server-Timing header — handler crashing before any D1 query completes:

**Verification:** Code shipped via commit `bfa14bb` to `main`.

---

## BUG-2026-04-26-026 — fix(delivery): cap POD photo size + dashboard Dispatched count

**Status:** Fixed (2026-04-26)
**Category:** delivery-orders

**Symptom / Fix:** POD-dialog now resizes photos to 1280px JPEG@0.7 (~200KB each) before
base64-encoding. Total POD JSON is checked against 700KB ceiling to
stay safely below D1's 1MB row size limit. Pre-launch audit found that
5 unresized iPhone photos (~50-80MB blob) would silently fail D1 write.

**Verification:** Code shipped via commit `653437b` to `main`.

---

## BUG-2026-04-26-027 — fix(cache): SWR — always refetch on mount, cache only for first paint

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** useCachedJson used to skip refetch when cache was <ttlSec old (5 min
default). After a backend deploy fixed an empty-response bug, users
stayed on the cached empty data for up to 5 minutes — exactly the
'Sales Orders 显示 0 但 stats 314' pattern Wei Siang reported repeatedly.

**Verification:** Code shipped via commit `d8f71d2` to `main`.

---

## BUG-2026-04-26-028 — fix(wip): populate sources[] on sofa SET rows so dialog shows POs

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** The SET row dialog ('SO ID / Qty / Completed / Age' table) reads from
WIPRow.sources. Sofa SET rows were emitting sources: [] which rendered
as '0 PO(s)' even when contributing POs existed. The bucket already
tracked members per JC; now it also accumulates one entry per
contributing PO (component qtys summed) and emits that on the SET row.

**Verification:** Code shipped via commit `3491e3b` to `main`.

---

## BUG-2026-04-26-029 — fix(wip): PO-level Fab Cut suppression when any Fab Sew is done

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** Behavior change per Wei Siang Apr 26 2026: when ANY Fab Sew JC inside
a PO is COMPLETED/TRANSFERRED, every remaining FAB_CUT JC in that PO
disappears from Inventory WIP — not just the matching component.

**Verification:** Code shipped via commit `25099c9` to `main`.

---

## BUG-2026-04-26-030 — fix: persist Reports active tab to URL + DataGrid column-hide alignment

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Reports tab persistence
- /reports?tab=inventory now drives the visible tab. Switching shell
  tabs and coming back no longer resets to 'Sales'. Hard-refresh,
  back/forward, and bookmarks all preserve the chosen tab.
- 'sales' (the default) maps to no query param so URLs stay clean.

**Verification:** Code shipped via commit `98f43a7` to `main`.

---

## BUG-2026-04-26-031 — revert(wip): drop (FC HB) component tags from FAB_CUT label

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** User push-back: BOM owns the WIP naming scheme. Adding HB/DV inside
(FC …) wasn't asked for and breaks the user's mental model. The
duplicate-row symptom is a quantity / consume bug, not a labelling
bug — investigating that separately.

**Verification:** Code shipped via commit `c9859b6` to `main`.

---

## BUG-2026-04-26-032 — fix(critical): unblock empty Sales/Production pages + WIP duplicate UX

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** PRIMARY FIX — orgScope safety gate
`withOrgScope` was emitting `WHERE orgId = ?` against tables whose orgId
column doesn't exist on remote D1 yet (migrations 0048–0055 are still
unapplied — admin task per DR-RUNBOOK.md). The query errored at SQL
parse time and the frontend silently rendered zero rows on Sales Orders
+ anywhere else routed through this helper. Until the migrations land,
the helper degrades to a no-op so the app keeps serving rows.

**Verification:** Code shipped via commit `4298d6a` to `main`.

---

## BUG-2026-04-26-033 — fix(authz): invalidate KV session cache on role change (P3.8)

**Status:** Fixed (2026-04-26)
**Category:** auth-rbac

**Symptom / Fix:** Was: 5-min KV TTL meant role revocation took up to 5 minutes to
propagate. Now: explicit invalidation on user role update + user
deletion + logout. TTL stays at 5 min for the cold-start performance
win, but security-critical changes propagate instantly.

**Verification:** Code shipped via commit `58c354b` to `main`.

---

## BUG-2026-04-26-034 — fix(queue): drop hard Env import to break circular type dep

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** See commit `446df78` for details.

**Verification:** Code shipped via commit `446df78` to `main`.

---

## BUG-2026-04-26-035 — fix(env): declare FILES/QUEUE/OAUTH bindings as optional Env fields

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** See commit `072fb71` for details.

**Verification:** Code shipped via commit `072fb71` to `main`.

---

## BUG-2026-04-26-036 — fix(production): unbreak Fab Cut merged-row fan-out PATCH

**Status:** Fixed (2026-04-26)
**Category:** production-orders

**Symptom / Fix:** The merged-row date-cell click on the Production Sheet sends both
status='COMPLETED' and completedDate=<today> in one PATCH. The upstream-
lock guard in applyPoUpdate fired on any payload containing completedDate,
even when the operator's intent was a status change (the date is just a
side-effect stamp). On a clean WAITING -> COMPLETED transition that path
could surface a phantom 409 and the toast 'Fab Cut complete applied to
0/1 components'.

**Verification:** Code shipped via commit `f9f3687` to `main`.

---

## BUG-2026-04-26-037 — fix(production): unbreak Fab Cut merged-row fan-out PATCH

**Status:** Fixed (2026-04-26)
**Category:** production-orders

**Symptom / Fix:** The merged-row date-cell click on the Production Sheet sends both
status='COMPLETED' and completedDate=<today> in one PATCH. The upstream-
lock guard in applyPoUpdate fired on any payload containing completedDate,
even when the operator's intent was a status change (the date is just a
side-effect stamp). On a clean WAITING -> COMPLETED transition that path
could surface a phantom 409 and the toast 'Fab Cut complete applied to
0/1 components'.

**Verification:** Code shipped via commit `d8e0a2f` to `main`.

---

## BUG-2026-04-26-038 — fix(production): repair filters + add 4 new + lazy-load

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** See commit `6795619` for details.

**Verification:** Code shipped via commit `6795619` to `main`.

---

## BUG-2026-04-26-039 — fix(sidebar): replace hardcoded "Lim / Director" with current user (P3.7)

**Status:** Fixed (2026-04-26)
**Category:** auth-rbac

**Symptom / Fix:** Sidebar bottom-left was rendering a stale demo user regardless of who
was logged in. Now reads from getCurrentUser() in src/lib/auth.ts and
shows displayName / role for the actual session.

**Verification:** Code shipped via commit `0e83923` to `main`.

---

## BUG-2026-04-25-001 — fix(bom): PUT /templates/:id is now upsert (was 404 on Create-from-Default flow)

**Status:** Fixed (2026-04-25)
**Category:** bom

**Symptom / Fix:** Frontend bom.tsx 'Create from Default Template' and 'Start Blank' buttons
construct a new BOMTemplate locally with id 'bom-${Date.now()}', add it to
React state, and on save call PUT /api/bom/templates/:id. Backend previously
required the row to already exist and returned 404, surfacing as a
'Failed to save BOM' toast.

**Verification:** Code shipped via commit `c29371c` to `main`.

---

## BUG-2026-04-25-002 — fix(ts): clear remaining 59 TS18046+TS2339 errors across 8 pages

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Final pass on the type-error migration that started in earlier batches.
Targets the 8 files Codex didn't touch:

**Verification:** Code shipped via commit `e74dbc3` to `main`.

---

## BUG-2026-04-25-003 — fix(router): add trailing /* to parent Route so nested Routes match (P-router-warning)

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Console warned "<Routes> rendered under a parent route with no trailing
*" — child routes were about to silently stop matching on deeper
navigation. Fix per React Router v7 docs.

**Verification:** Code shipped via commit `a28add4` to `main`.

---

## BUG-2026-04-25-004 — fix(ts): migrate worker/* (scan, index, issue) to Zod-validated parses

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 21 TS18046 errors across worker scan/index/issue pages by validating
workerFetch JSON responses through passthrough Zod envelopes (workerFetch
is preserved as-is for its 401 handling and X-Worker-Token header).

**Verification:** Code shipped via commit `1b4619b` to `main`.

---

## BUG-2026-04-25-005 — fix(ts): migrate sales/* + invoices/* to fetchJson + Zod schemas

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 18 TS18046 errors across sales/index.tsx and the 5 invoice pages
(index, detail, payments, credit-notes, debit-notes) by piping fetch
responses through fetchJson with shared InvoiceSchema/PaymentSchema/
CreditNoteSchema/DebitNoteSchema mutation envelopes.

**Verification:** Code shipped via commit `745801a` to `main`.

---

## BUG-2026-04-25-006 — fix(ts): migrate products + rd pages to fetchJson + Zod schemas

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 20 TS18046 errors in products/index.tsx and rd/{index,detail}.tsx by
piping fetch responses through fetchJson with ProductSchema/RdProjectSchema
mutation envelopes. The five inline `fetch().then(r => r.json())` chains in
products/index.tsx are also flattened to typed `fetchJson(...).then(...)`.

**Verification:** Code shipped via commit `1fcd468` to `main`.

---

## BUG-2026-04-25-007 — fix(ts): migrate delivery/* to fetchJson + Zod schemas

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 18 TS18046 'data is of type unknown' errors in delivery pages by
piping fetch responses through fetchJson + a shared DeliveryOrderSchema.
Adds src/lib/schemas/ with passthrough Zod schemas mirroring the route-d1
rowToX mappers — schemas validate the boundary, extra fields flow through.

**Verification:** Code shipped via commit `9dc583f` to `main`.

---

## BUG-2026-04-25-008 — stability: add timeout + abort propagation to fetchJson

**Status:** Fixed (2026-04-25)
**Category:** data-integrity

**Symptom / Fix:** See commit `db2ecb6` for details.

**Verification:** Code shipped via commit `db2ecb6` to `main`.

---

## BUG-2026-04-25-009 — fix(bom): per-wipType production order chain (sofa FOAM after WEBBING)

**Status:** Fixed (2026-04-25)
**Category:** bom

**Symptom / Fix:** The flat DEPT_ORDER (FAB_CUT, FAB_SEW, WOOD_CUT, FOAM, FRAMING, WEBBING,
UPH, PACK) lied for sofa: per BOM tree FOAM is downstream of WEBBING
(FOAM <- WEBBING <- FRAMING <- WOOD_CUT chain), but DEPT_ORDER put FOAM
at index 3 -- BEFORE FRAMING/WEBBING -- so JCs got assigned wrong
sequence numbers.  This made wipKey-prev consume logic walk the wrong
direction (sofa FOAM tried to consume WOOD_CUT instead of WEBBING).

**Verification:** Code shipped via commit `a9c7a81` to `main`.

---

## BUG-2026-04-25-010 — fix(production): UPH consume by qty (not zero) + add own wip_items row

**Status:** Fixed (2026-04-25)
**Category:** inventory-cascade

**Symptom / Fix:** User reported: Fab Sewing has 11 items / 13 qty in WIP inventory.
Upholstery completes 6 items / 7 qty.  Expected:
- Fab Sewing's WIP deducted by 7 (13 -> 6 remains)
- Upholstery's own WIP +7 visible

**Verification:** Code shipped via commit `8519f93` to `main`.

---

## BUG-2026-04-25-011 — fix(production): gate sofa atomic-FAB_CUT-zero on isFabSew

**Status:** Fixed (2026-04-25)
**Category:** inventory-cascade

**Symptom / Fix:** Bug: the (SO, fabric) sofa-bolt-leaves-Fab-Cut-shelf logic fired for
every sofa dept transition, not just FAB_SEW.  When a sofa FOAM /
FRAMING / WEBBING / PACKING JC went IN_PROGRESS or COMPLETED, the
backend zeroed every FAB_CUT wip_items row in the (salesOrderId,
fabricCode) group -- regardless of whether FAB_SEW had even started.

**Verification:** Code shipped via commit `853fe37` to `main`.

---

## BUG-2026-04-25-012 — fix(production): derive upstream dept columns from BOM/JC sequence

**Status:** Fixed (2026-04-25)
**Category:** production-orders

**Symptom / Fix:** Replaced the hardcoded UPSTREAM map (FAB_SEW <- FAB_CUT, FOAM <-
FAB_SEW, etc.) with a useMemo that walks every loaded JC matching the
active tab and collects sibling JCs (same wipKey) with smaller
sequence.  Each sibling's deptCode is a BOM-defined upstream.

**Verification:** Code shipped via commit `c6c1b82` to `main`.

---

## BUG-2026-04-25-013 — fix(production): include same-wipKey siblings when ?dept= is set

**Status:** Fixed (2026-04-25)
**Category:** production-orders

**Symptom / Fix:** Bug: every prev-dept CD column on the per-dept Production page rendered
"—" for every row.  On the Upholstery tab, only Upholstery itself
showed pills; FAB_SEW / FOAM / FRAMING / WOOD_CUT / WEBBING all
collapsed to dashes.

**Verification:** Code shipped via commit `e5b7b6e` to `main`.

---

## BUG-2026-04-25-014 — fix(d1-compat): IFNULL→COALESCE + bom search LIKE→ILIKE

**Status:** Fixed (2026-04-25)
**Category:** data-migration

**Symptom / Fix:** Two more SQLite-vs-Postgres semantic gaps that survived the migration:

**Verification:** Code shipped via commit `cb1f965` to `main`.

---

## BUG-2026-04-25-015 — fix(db): preserve acronym casing on column read transform

**Status:** Fixed (2026-04-25)
**Category:** data-migration

**Symptom / Fix:** postgres.toCamel is lossy for acronym fields:
  customer_po -> customerPo  (wrong, code reads customerPO)
  customer_so -> customerSo
  hookka_expected_dd -> hookkaExpectedDd
  company_so_id -> companySoId

**Verification:** Code shipped via commit `55fbb5e` to `main`.

---

## BUG-2026-04-25-016 — fix(db): coerce BIGINT to JS number, fixes Sales Order count explosion

**Status:** Fixed (2026-04-25)
**Category:** data-migration

**Symptom / Fix:** User-reported symptom: 'Sales Order 资料全错了，然后 Sales Order 突然爆发，
变得很多'.  Stats tile showed counts like '029014' instead of 294.

**Verification:** Code shipped via commit `5c850c4` to `main`.

---

## BUG-2026-04-25-017 — stability: restore typecheck gate + fix 3 specific bugs flagged by 3 external reviewers

**Status:** Fixed (2026-04-25)
**Category:** infrastructure

**Symptom / Fix:** Three independent reviewers (Apr 24-25) all flagged the same core issue:
typecheck + lint are red, and the 'build' script was silently bypassing
typecheck. This commit is the stabilization bridgehead — not the full
cleanup (which requires a per-module refactor pass), but enough to make
CI enforce the baseline going forward and to fix the three specific bugs
the reviewers could point at concretely.

**Verification:** Code shipped via commit `e2a2f6c` to `main`.

---

## BUG-2026-04-24-001 — fix(production): dept routes actually render dept view + Wood Cut producer-only

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** 1. /production/fab-cut etc. were redirecting to /production because
   dept.tsx used useParams() on LITERAL routes (no :deptCode binding) →
   rawDeptCode was undefined → normalizeDept returned null → redirect.
   Switched to reading the last pathname segment directly.
2. WOOD_CUT added to the producer-only list alongside FAB_CUT — both are
   raw-material entry points (wood vs fabric chain), neither consumes
   an upstream wip_items row.

**Verification:** Code shipped via commit `576fa5c` to `main`.

---

## BUG-2026-04-24-002 — revert: restore DIVAN BOM qty=2 + undo JC/wip_items halving

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** I shouldn't have modified user's BOM without asking. Migration 0044
undoes every change 0043 made: BOM back to quantity=2, DIVAN JC wipQty
doubled back, DIVAN wip_items stockQty doubled back.

**Verification:** Code shipped via commit `7fc57a0` to `main`.

---

## BUG-2026-04-24-003 — fix(bom): DIVAN qty = 1 per BF (not 2) — BOM + JC + wip_items retro

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** See commit `9092b53` for details.

**Verification:** Code shipped via commit `9092b53` to `main`.

---

## BUG-2026-04-24-004 — revert: don't merge BF at Fab Cut — user wants HB/Divan separate

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** BF components are physically separate stock piles (HB on one shelf,
Divan on another) so Inventory displays them as separate rows — does
NOT mirror Production Fab Cut's merged single-row display. Production
merges for scheduling convenience; Inventory tracks actual stock.

**Verification:** Code shipped via commit `910715c` to `main`.

---

## BUG-2026-04-24-005 — fix(inventory-wip): per-dept filter — sofa SET only at Fab Cut, per-component after

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Sofa at Fab Cut stage shows the merged SET row (one row per set,
matching Production Fab Cut tab). After Fab Sew starts, each component
(Base / Cushion / Armrest) is tracked separately — so those stages
show per-component rows instead of hiding them.

**Verification:** Code shipped via commit `dd40502` to `main`.

---

## BUG-2026-04-24-006 — fix(wip-consume): generalize consume to all depts + fix per-component group

**Status:** Fixed (2026-04-24)
**Category:** inventory-cascade

**Symptom / Fix:** Two bugs fixed in one:

**Verification:** Code shipped via commit `84df3bd` to `main`.

---

## BUG-2026-04-24-007 — fix(wip-consume): Fab Sew COMPLETED also deducts Fab Cut stock

**Status:** Fixed (2026-04-24)
**Category:** inventory-cascade

**Symptom / Fix:** applyWipInventoryChange's sibling-consume used to fire only on
IN_PROGRESS transition, but users who set the completion date directly
(date-cell click) jumped WAITING → COMPLETED and skipped IN_PROGRESS
entirely. Result: Fab Sew wip_items incremented but Fab Cut wip_items
never decremented — Inventory showed ghost Fab Cut stock forever.

**Verification:** Code shipped via commit `1db1e7b` to `main`.

---

## BUG-2026-04-24-008 — fix(inventory-wip): sofa SET label matches Production Fab Cut exactly

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Sofa SET rows now emit "5535-L(LHF)+2A(RHF) | (30) | PC151-02 | (FC)"
— piped format with (size) and (FC) tokens, same as Production page's
fabCutWIP() helper. Previously was "5535-L(LHF)+2A(RHF) PC151-02" which
confused operators cross-referencing the two views.

**Verification:** Code shipped via commit `6e5e84c` to `main`.

---

## BUG-2026-04-24-009 — fix(inventory-wip): Merged sofa rows show set count, not piece sum

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Production Fab Cut's merged sofa row reads "Qty 1" (one set). The
Inventory WIP Merged sets view previously read "Qty N" where N was
sum of all component pieces (e.g. Base 2 + Cushion 2 + Armrest 2 = 6),
which didn't match the operator's mental model.

**Verification:** Code shipped via commit `668822e` to `main`.

---

## BUG-2026-04-24-010 — fix(so-confirm): BF/ACC qty>1 now fans out into N POs (qty=1 each)

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Sofa stays as one PO per SO line (one set per SO by convention).
For BEDFRAME / ACCESSORY, qty=N → N POs each with quantity=1, poNo
suffixed -01, -02, ... via a running poSequence counter. Each PO gets
its own JC chain (wipQty=1) so Fab Cut and Overview show one row per
physical piece — matching shop-floor reality (each piece has its own
fabric cut, frame, sticker).

**Verification:** Code shipped via commit `69971c7` to `main`.

---

## BUG-2026-04-24-011 — fix(inventory-wip): Fab Cut stage uses condensed label matching Production page

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** deriveWIPFromPO now computes wipCodeStr on the fly for FAB_CUT cards:
  {productCode} | ({sizeLabel}) | ({totalH"} only BF) | {fabricCode} | (FC)
Other departments keep the existing wipLabel fallback chain. This lines
sofa WIP inventory code up with the Fab Cut tab on the Production page
so stock consumption math matches operator expectations.

**Verification:** Code shipped via commit `e74147a` to `main`.

---

## BUG-2026-04-24-012 — fix(fab-cut): merged-row completion fans across sibling POs (sofa)

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Sofa merge groups by (SO, fabric) and can span multiple POs (one per
variant). The patch fan-out was sending every JC id under row.poId,
so sibling-PO JCs silently never updated — Overview still showed them
pending after the merged row flipped done. Added _mergedJobCardRefs
carrying (poId, jobCardId) pairs; both patch sites (status select +
completion date cell) now use per-JC poId. BF is unchanged since BF
groups key on poId (all refs share row.poId).

**Verification:** Code shipped via commit `10dcb78` to `main`.

---

## BUG-2026-04-24-013 — fix(fab-cut): BF merged row qty follows HB (fallback Divan)

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** BF group alpha-sorts DIVAN before HB, so `...first` was pulling
Divan's qty. User rule: HB is canonical BF piece count; Divan-only
BFs fall through to `first.qty`. Sofa unchanged (one set per SO).

**Verification:** Code shipped via commit `2778dc5` to `main`.

---

## BUG-2026-04-24-014 — fix(fab-cut): merged sched_FAB_CUT pill + due/completed match row status

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Merged Fab Cut rows showed 'DONE' on the Fab Cut pill even when the
overall row status was IN_PROGRESS because sched_FAB_CUT was inherited
from just the first PO in the merge group — the first PO's JCs happened
to be complete while siblings in the same (SO, fabric) group were not.
Visually contradictory for operators.

**Verification:** Code shipped via commit `a0dff06` to `main`.

---

## BUG-2026-04-24-015 — fix(production): qty > 1 fans QR stickers to one per physical piece

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Before: every production-sheet row generated exactly one QR sticker,
regardless of the row's qty. A row with qty=2 came out as a single
sticker the worker would have to double-scan — which the scan portal
deliberately rejects as a duplicate.

**Verification:** Code shipped via commit `da5e948` to `main`.

---

## BUG-2026-04-24-016 — fix(fab-cut): unify WIP layout — every category pipe-separated

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Sofa no longer glues seat size to the model with a space. All categories
now share one shape:
  '{model} | ({size}) | ({totalH, BF only}) | {fabric} | (FC)'

**Verification:** Code shipped via commit `5456d2b` to `main`.

---

## BUG-2026-04-24-017 — fix(fab-cut): reorder WIP label parts, sofa glues seat size to model

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** WIP label now reads category-aware so sorting / eyeballing is easier:
  BEDFRAME:  '1003-(K) | (6FT) | (18") | PC151-02 | (FC)'
             model | bed size | total heights | fabric | (FC)
  SOFA:      '5537-1A(LHF)+1NA+1A(RHF) (30) | BO315-2 | (FC)'
             model with seat size attached | fabric | (FC)
  ACCESSORY: '{model} | ({size}) | {fabric} | (FC)'

**Verification:** Code shipped via commit `c2093fe` to `main`.

---

## BUG-2026-04-24-018 — fix(fab-cut): bedframe WIP label adds total height after size

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** BF rows now read e.g. '1003-(K) | PC151-02 | (6FT) | (18") | (FC)'.
Sofa / accessory unchanged (totalHeight stays empty for them per the
earlier deptRow gate).

**Verification:** Code shipped via commit `e348113` to `main`.

---

## BUG-2026-04-24-019 — fix(fab-cut): Model column shows baseModel only, WIP carries the variants

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Fab Cut rows (merged + single) now render Model as the clean baseModel
prefix — '5530', '5531', '1003', etc. — and the full variant combo
('5530-1A(LHF)+1NA+1A(RHF)') is relocated into the WIP column alongside
fabric / seat size / (FC). Matches how the floor team reads the sheet:
scan the Model column to group by product family, read WIP when you
need the component detail for the set you're about to cut.

**Verification:** Code shipped via commit `7eb78c6` to `main`.

---

## BUG-2026-04-24-020 — fix(inventory): sofa Fab Sew first scan consumes the whole Fab Cut set

**Status:** Fixed (2026-04-24)
**Category:** inventory-cascade

**Symptom / Fix:** Before: each FAB_SEW JC going IN_PROGRESS decremented only its own
wipQty from its immediate upstream wip_items row. For a 3-piece sofa
set (1A(LHF) + 1NA + 1A(RHF) cut together), that required scanning
every module at Fab Sew before Fab Cut's shelf balance reached zero —
but physically the sewing team grabs the entire cut stack at once, so
the first scan already represents the whole batch leaving storage.

**Verification:** Code shipped via commit `35f4822` to `main`.

---

## BUG-2026-04-24-021 — fix(fab-cut): merged module order — LHF first, RHF last, middle in between

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Previous alpha sort on wipType didn't convey sofa layout ordering. Now
bucket by handedness first: modules with 'LHF' in the model come first,
'RHF' last, everything else (1NA, CNR, 2S, corner, centre) in the
middle. Within bucket, alpha on wipType stays as the tiebreaker so BF
and accessory groups look stable too. Example label now reads
'5537-1A(LHF)+L(LHF)+1NA+CNR+2A(RHF)+L(RHF)' — which is how the floor
team reads a sofa set from left to right.

**Verification:** Code shipped via commit `71b8d46` to `main`.

---

## BUG-2026-04-24-022 — fix(fab-cut): use pipe separator in merged WIP label

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Per user: '5537-1A(LHF)+1NA+1A(RHF) | BO315-2 | (30) | (FC)'.

**Verification:** Code shipped via commit `f65e6e4` to `main`.

---

## BUG-2026-04-24-023 — fix(fab-cut): wrap seat/bed size in parens — '(30)' in merged WIP label

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Gives the size token a visual boundary matching the '(FC)' marker.
Now reads: '5537-1A(LHF)+1NA+1A(RHF) · BO315-2 · (30) · (FC)'.

**Verification:** Code shipped via commit `76a7d3f` to `main`.

---

## BUG-2026-04-24-024 — fix(fab-cut): middle-dot separator between WIP label parts

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Single-space was letting the model, fabric code and size mash together
when they share character classes (e.g. '5537-1A(LHF)+1NA+1A(RHF) BO315-2 30 (FC)').
Middle-dot splits them cleanly:
  5537-1A(LHF)+1NA+1A(RHF) · BO315-2 · 30 · (FC)

**Verification:** Code shipped via commit `2f6229f` to `main`.

---

## BUG-2026-04-24-025 — fix(fab-cut): merged WIP label is '{model} {fabric} {seat/bed size} (FC)'

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** User's preferred compact format. The per-type count variant I tried first
was too abstract — cutters read this column to confirm 'which bolt, which
size'. Now the merged row's WIP says exactly that on one line, e.g.
'5537-1A(LHF)+1NA+1A(RHF) BO315-2 30 (FC)' for a sofa set or
'1003-(K) PC151-02 6FT (FC)' for a bedframe. Size is the seat size for
sofa (already normalised into row.size after the earlier sofa-size
cleanup) and the bed size for bedframe.

**Verification:** Code shipped via commit `05725a3` to `main`.

---

## BUG-2026-04-24-026 — fix(fab-cut): compact merged WIP column to type counts instead of full labels

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Merged Fab Cut rows were dumping every child job card's full wipLabel
(model + component + fabric + '(FC)' marker) separated by '  |  ', so a
3-module sofa set produced a ~250-char wall that wrapped the table.
Everything in that string is already visible elsewhere — Model column
shows the variant combo, Colour shows the fabric, Type shows the
component set. All the WIP column actually needs to say is how many
pieces of each component kind to cut.

**Verification:** Code shipped via commit `527d823` to `main`.

---

## BUG-2026-04-24-027 — fix(fab-cut): sofa rows merge by SO+fabric so a full set is one row

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** The cutter lays one bolt of fabric and cuts every module of the sofa
set in a single pass. Before, Fab Cut merged only within a single PO,
so a 3-piece sofa (1A(LHF) + 1NA + 1A(RHF)) arriving as three PO lines
on the same SO showed as three separate rows — wrong, because the
fabric can't be split between them.

**Verification:** Code shipped via commit `f76b92f` to `main`.

---

## BUG-2026-04-24-028 — fix(bom): normalize l1Processes/wipComponents on load to stop crash

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** BOMManagementPage was hitting the ErrorBoundary because a template with
null l1Processes or wipComponents from D1 (or a stale cache entry) would
throw on the first .forEach / .reduce / .map / .length downstream. The
page has dozens of those call sites — safer to coerce both arrays to []
once at load time than null-guard each render path. Templates are the
authoritative source from cachedFetchJson('/api/bom/templates').

**Verification:** Code shipped via commit `a26278a` to `main`.

---

## BUG-2026-04-24-029 — fix(customers): sofa seat prices now render in Customer Products panel

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** The panel's seatHeightPrices column was rendering '—' for every sofa
row because the TS type declared Record<string,number> but the API
returns Array<{height,priceSen}>. Object.entries over an array yields
numeric-index keys, so formatSeatHeights fell through to the empty
state. Type + formatter aligned to the array shape now, so sofa rows
show e.g. '24":517 28":572 30":572 32":772 35":772' as intended.

**Verification:** Code shipped via commit `dbf5c5c` to `main`.

---

## BUG-2026-04-24-030 — fix(production): QR strip + FG preview hidden by default · sofa BF-only fields blanked

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Two UX problems collapsed into one change:

**Verification:** Code shipped via commit `22e9522` to `main`.

---

## BUG-2026-04-24-031 — fix: sofa cascade is Line-1-only, customer price moves to SO confirm, Add FG polish

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Three batched fixes:

**Verification:** Code shipped via commit `d05ad0f` to `main`.

---

## BUG-2026-04-24-032 — revert(products): drop 4 stool variants from 0033 — user adds them manually

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** 0033 seeded 5530-STOOL / 5531-STOOL / 5535-STOOL / 5536-STOOL by cloning
5537-STOOL. User decided to add these through the Products UI instead
(different prices, per-variant overrides, etc.) so the auto-cloned rows
need to go before anyone creates an SO against them.

**Verification:** Code shipped via commit `4e27d7c` to `main`.

---

## BUG-2026-04-24-033 — fix(sales): sofa special-order toggle propagates to sibling modules

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Checking / unchecking a Special Order on one sofa module line now cascades
the same selection (and matching surcharge + label string) to every other
sofa line that shares the baseModel, same rule that already governs fabric
and seat size. Non-sofa lines still edit in isolation.

**Verification:** Code shipped via commit `3a3a442` to `main`.

---

## BUG-2026-04-24-034 — fix(sales): product picker shows ALL categories even after one is bound

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Filtered-by-current-category options trapped users on whatever they picked
first — no way to switch a line from bedframe to sofa without manually
clearing. Now every search surfaces every product across every category;
selectProduct rebinds itemCategory and baseModel from the picked product
itself, so the template (sofa modules / bedframe heights / accessory qty
strip) flips on the next render.

**Verification:** Code shipped via commit `9b4e6f2` to `main`.

---

## BUG-2026-04-24-035 — fix(schedule): lead time = days-before-delivery per dept, parallel not serial

**Status:** Fixed (2026-04-24)
**Category:** scheduling

**Symptom / Fix:** Rewrites reverse-schedule semantics everywhere job_card dueDates are
computed. Old chain-walk summed lead times backwards, producing 22-day BF
spans and 39-day SF spans between FAB_CUT and PACKING. User clarified the
intent: each dept's lead time is just its offset from the customer's
delivery date. Depts run in PARALLEL, each staggered by its own window.

**Verification:** Code shipped via commit `51566e5` to `main`.

---

## BUG-2026-04-24-036 — fix(leadtimes): Planning page's GET/PUT URL finally matches backend mount

**Status:** Fixed (2026-04-24)
**Category:** scheduling

**Symptom / Fix:** Root cause for "I updated lead times but the data disappears": frontend
Planning page reads + writes `/api/production/leadtimes` (slash), but the
production-leadtimes Hono router was only mounted at
`/api/production-leadtimes` (hyphen). The slash path was mounted to the
standalone leadtimeRecalc router which only has POST /recalc-all — so
GET / returned 404 (no data shown) and PUT / silently landed on a route
with no handler (save looked like it worked, nothing persisted).

**Verification:** Code shipped via commit `ea84016` to `main`.

---

## BUG-2026-04-24-037 — fix(products): widen sofa seat-height price columns + reclassify pillows to ACCESSORY

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Two independent fixes landed together:

**Verification:** Code shipped via commit `9a7e44c` to `main`.

---

## BUG-2026-04-24-038 — fix(pricing): sofa seat-height keys must be strings, defensively match any shape

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Root cause for the "sofa prices not showing on Products page" + the
5530-2A(LHF) duplicate-entry bug: the UI iterates seat heights as strings
("24", "28", …) and does .find((s) => s.height === h || s.height === hNum),
but migrations 0028 / 0030 stored heights as integers. find() never hit,
so:
  1. Products page rendered blank for every sofa seat-height column
  2. Clicking a cell to edit saw "empty", and the submit handler APPENDED
     a new string-keyed entry next to the existing int-keyed one — which
     is exactly how 5530-2A(LHF) ended up with both {"height":28,...}
     and {"height":"28","priceSen":0} in the same array.

**Verification:** Code shipped via commit `207bc0d` to `main`.

---

## BUG-2026-04-24-039 — fix(pricing): rewrite sofa seatHeightPrices to canonical 5-tier JSON (Prod Sheet v10)

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Production Sheet v10 (2026-04-23 SKU SF tab) is the authoritative source
for sofa base + per-seat-height pricing. At least one record — 5530-2A(LHF)
— accumulated a malformed duplicate entry {"height":"28","priceSen":0}
alongside the correct {"height":28,...} so the UI occasionally read the
zero row and showed the sofa as free.

**Verification:** Code shipped via commit `d7afd86` to `main`.

---

## BUG-2026-04-24-040 — fix(db): re-run sofa UPH+PKG backfill so Packing dates show on Overview

**Status:** Fixed (2026-04-24)
**Category:** data-migration

**Symptom / Fix:** Migration 0027 ran on 2026-04-23 before the sofa BOM templates had their
l1Processes[deptCode=PACKING] entries populated, so the INSERT's JOIN on
bom_templates matched nothing for ~180 sofa POs and silently did nothing.
Only 4 sofa POs ended up with Packing JCs (those created live via
createProductionOrdersForSO), which is why the Overview grid shows blank
Packing cells for most sofa rows.

**Verification:** Code shipped via commit `b5d3a2e` to `main`.

---

## BUG-2026-04-24-041 — fix(pricing): correct BF + SF master SKU prices from Production Sheet v5

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Restores authoritative SKU pricing from the master Production Sheet (v5, 2026-04-24).

**Verification:** Code shipped via commit `ea0a4b8` to `main`.

---

## BUG-2026-04-23-001 — fix(db): move seed.sql out of migrations/ so CI stops retrying it

**Status:** Fixed (2026-04-23)
**Category:** infrastructure

**Symptom / Fix:** Wrangler applied every file in migrations/ as a migration, including seed.sql — a 4984-line INSERT-only file meant for local dev seeding. On prod (which already has data) it fails with primary-key conflicts, and with continue-on-error: true in the deploy workflow the failure was silent.

**Verification:** Code shipped via commit `af0d8ca` to `main`.

---

## BUG-2026-04-23-002 — fix(deletes): guard delete mutations against silent HTTP failures

**Status:** Fixed (2026-04-23)
**Category:** data-integrity

**Symptom / Fix:** Last batch from the HTTP-audit triage. Each of these DELETE handlers
used to either ignore errors entirely or only peek at json.success,
so a foreign-key-constrained delete, a 401 after token expiry, or a
500 from the worker would silently let the row disappear from the
list locally while the record stayed in D1. On the next page load
the row would reappear "zombie-style" and the user would have no
idea why.

**Verification:** Code shipped via commit `74d362d` to `main`.

---

## BUG-2026-04-23-003 — fix(sales): guard create / update / status / confirm against silent HTTP failures

**Status:** Fixed (2026-04-23)
**Category:** data-integrity

**Symptom / Fix:** Four mutation paths on the Sales Orders pages only checked json.success
and ignored res.ok, so a 401 (expired auth), 500, or worker crash that
still returned a JSON error body would fall into the success branch.
Users saw navigate-to-detail / "Status updated" / "Order confirmed"
toasts for requests the server actually rejected, and in the worst case
(confirmOrder) the frontend happily moved on to a SO whose production
orders never got created.

**Verification:** Code shipped via commit `6427754` to `main`.

---

## BUG-2026-04-23-004 — fix: sofa seat height stored consistently + kv-config save no longer silently fails

**Status:** Fixed (2026-04-23)
**Category:** data-integrity

**Symptom / Fix:** Two related data-integrity bugs surfaced together when users complained
that (a) sofa SO rows showed the module code ("2A(LHF)") under Size
instead of the seat height ("32\""), and (b) gaps/specials they added
in Product Maintenance disappeared after a refresh even though the
badge said "Auto-saved".

**Verification:** Code shipped via commit `56dad2a` to `main`.

---

## BUG-2026-04-23-005 — fix(products): allow negative variant surcharge (discount)

**Status:** Fixed (2026-04-23)
**Category:** pricing-products

**Symptom / Fix:** The variant-price inputs in Product Maintenance were fronted by a
literal "+RM" label, making it look like only positive amounts were
accepted. In reality the inputs have no min attribute and the state /
save flow pass the number through unclamped, so negative values
already work end-to-end — the SO pricing loop just sums surcharges
without any Math.max gate, so a -5000 sen entry correctly subtracts
RM 50 from the unit price.

**Verification:** Code shipped via commit `dbf35a0` to `main`.

---

## BUG-2026-04-23-006 — fix(sales): sofa Seat Size dropdown on edit page also follows config

**Status:** Fixed (2026-04-23)
**Category:** sales-orders

**Symptom / Fix:** edit.tsx was still reading SEAT_HEIGHT_OPTIONS (hardcoded in mock-data)
for the sofa Seat Size picker, so any sofa size the user added under
Product Maintenance → SOFA → Sizes never appeared when editing an SO.
create.tsx was already wired to kv_config.sofaSizes; sync edit.tsx to
the same source, keeping the hardcoded list as a hydration fallback.

**Verification:** Code shipped via commit `69a1f99` to `main`.

---

## BUG-2026-04-23-007 — fix(sales): read variants config as source of truth, don't filter it

**Status:** Fixed (2026-04-23)
**Category:** sales-orders

**Symptom / Fix:** The bedframe Gap dropdown on the SO create page stopped at 10" even
after Product Maintenance had 17 gap options up to 20". Same
silent-truncation existed for divan heights, leg heights and special
orders (both bedframe and sofa variants).

**Verification:** Code shipped via commit `f94f4b7` to `main`.

---

## BUG-2026-04-23-008 — fix(data-grid): column toggle not hiding in customizer

**Status:** Fixed (2026-04-23)
**Category:** ui-frontend

**Symptom / Fix:** Unchecking a column in the Columns customizer looked like a no-op —
the checkbox appeared to click but the column never left the sheet.
localStorage also stayed unchanged.

**Verification:** Code shipped via commit `0d8cb7d` to `main`.

---

## BUG-2026-04-23-009 — fix(bom): add UPHOLSTERY + PACKING to sofa WIP process chains

**Status:** Fixed (2026-04-23)
**Category:** bom

**Symptom / Fix:** Sofa BOM templates (SF_BASE / SF_CUSHION / SF_ARM) stopped at WEBBING,
so when an SO was confirmed, `createProductionOrdersForSO` never created
UPHOLSTERY or PACKING job cards for sofa POs. This caused:

**Verification:** Code shipped via commit `25b5446` to `main`.

---

## BUG-2026-04-23-010 — fix(data-grid): align right-aligned column headers with cell values

**Status:** Fixed (2026-04-23)
**Category:** ui-frontend

**Symptom / Fix:** For columns marked align="right" (or numeric/currency), the header label
was sitting on the LEFT of the sort/filter icons, while cell values
hugged the right edge — so the Gap/Divan/Leg/Qty headers visually
floated away from the numbers below them.

**Verification:** Code shipped via commit `8078c3b` to `main`.

---

## BUG-2026-04-23-011 — Robustness: per-page ErrorBoundary + per-user grid prefs + deploy-version toast

**Status:** Fixed (2026-04-23)
**Category:** ui-frontend

**Symptom / Fix:** Three defenses so the app stays usable after a crash or mid-session deploy:

**Verification:** Code shipped via commit `9d02579` to `main`.

---

## BUG-2026-04-23-012 — Fix BF tracker col mapping + SO grouping in orders migration

**Status:** Fixed (2026-04-23)
**Category:** data-migration

**Symptom / Fix:** BF Master Tracker headers are misleading:
  col17 = "Blank(Dont use for sofa)"  -> actual Gap (inches)
  col18 = "Sofa Size"                 -> actual Divan height (inches)
  col20 = "Leg (inches)"              -> Leg
Switch BF mapper to column-index access (ignore the header labels) so
gap + divan populate on bedframe orders. SF uses the real labels and
is unchanged.

**Verification:** Code shipped via commit `8698fe4` to `main`.

---

## BUG-2026-04-23-013 — Fix job_card ID collision between parallel WIPs sharing leaf names

**Status:** Fixed (2026-04-23)
**Category:** production-orders

**Symptom / Fix:** After the per-dept wipCode override landed, jcId = `jc-{po}-{wipCode}-{dept}`
collapsed DIVAN's FRAMING row and HEADBOARD's FRAMING row into one
because both use a node literally named "Frame" at their L2 depth. The
INSERT OR IGNORE silently dropped the HEADBOARD row. Switch to scoping
by wipKey (which embeds top-level wipType + index) so parallel WIPs
never collide even if they share leaf node names.

**Verification:** Code shipped via commit `48d8820` to `main`.

---

## BUG-2026-04-23-014 — Fix BOM+QR root-cause regressions from stale cache state

**Status:** Fixed (2026-04-23)
**Category:** bom

**Symptom / Fix:** - bom.tsx: remove the useEffect → saveStoredTemplates fan-out that
  PUT the entire templates list back to /api/bom/templates on every
  setTemplates call. It turned localStorage into a silent write-master
  that kept resurrecting stale per-product BOMs (qty=1 nested DIVAN)
  and overwriting D1 after every bulk reapply-masters run. localStorage
  is now cache-only; D1 is the sole source of truth. Individual edits
  already go through their own /api/bom/:id routes.
- production/index.tsx: gridFilterIdSet incorrectly treated the initial
  empty array as "filter matched 0 rows" and hid all QR stickers when a
  dept tab mounted (DataGrid hadn't reported back yet). Switch the state
  to `Row[] | null` and only build a Set once the grid reports real
  rows — null means "no filter yet, show everything".

**Verification:** Code shipped via commit `4517755` to `main`.

---

## BUG-2026-04-23-015 — Fix BOM page resurrecting stale localStorage on every mount

**Status:** Fixed (2026-04-23)
**Category:** bom

**Symptom / Fix:** The legacy localStorage overlay (hookka-bom-templates-v2) was loaded
IN PREFERENCE to the API response and auto-PUT back to /api/bom/templates
on mount — so every bulk reapply-masters run was silently undone by the
next browser tab that opened the BOM page. D1 is now the authoritative
source; clear the stale overlay key on mount instead.

**Verification:** Code shipped via commit `5135ce4` to `main`.

---

## BUG-2026-04-22-001 — Fix crash: variants page coerces object entries to strings on load

**Status:** Fixed (2026-04-22)
**Category:** ui-frontend

**Symptom / Fix:** Three pages share the localStorage key `hookka-variants-config` but
write incompatible shapes:
  - /settings/variants writes plain strings: ["8\"", "10\""]
  - /products Maintenance tab writes {value, priceSen} objects
  - /sales/create already handles both via extractValues()

**Verification:** Code shipped via commit `7bfe999` to `main`.

---

## How we use this file

- Add a new entry the moment a bug is **identified** (status 🔴), even
  before the fix lands. The diagnosis itself is the most valuable part of
  the record — six months later, "why did we change this" matters more
  than "what changed".
- Move to 🟡 when a fix is open but not deployed, 🟢 when it ships.
- Cross-reference related bugs: many of ours come in clusters (e.g. #001
  and #002 above only ever surfaced together).
- For each fix, name the exact `file:line` you changed and a one-line
  verification step. If we ever roll back, this is the diff.
