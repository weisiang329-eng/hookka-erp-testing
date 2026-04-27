# Inventory WIP Flow — `wip_items` Lifecycle

Single source-of-truth for the `wip_items` ledger: when a row appears, when
it changes, when it disappears, and what the read paths do with it.

This document was written after BUG-2026-04-27-032 (per-JC attribution
inflation) to consolidate the BUG-005 / -013 / -014 / -016 / -017 / -018 /
-019 / -021 / -022 thread into one place. Cross-reference the individual
entries in `docs/BUG-HISTORY.md` for the original root-cause diagnoses.

Schema (from `migrations/0001_init.sql:740-748`):

```sql
CREATE TABLE wip_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,           -- the JC's wipLabel (also the row key)
  type TEXT NOT NULL,           -- short type: DIVAN | HB | BASE | CUSHION | ARMREST | WIP
  relatedProduct TEXT,          -- productCode of the producer PO
  deptStatus TEXT,              -- departmentCode of the latest writer (or 'PENDING' for negative stubs)
  stockQty INTEGER NOT NULL DEFAULT 0,  -- the ledger qty (positive, zero, or negative)
  status TEXT NOT NULL          -- 'COMPLETED' | 'IN_PRODUCTION' | 'PENDING'
);
```

Key invariants:

- **`code` is the JC `wipLabel`.** Every write keys by `code`; rename
  `wip_items.code` if you rename JC `wipLabel` (see `scripts/resync-wip-labels.ts`,
  BUG-2026-04-27-004).
- **`stockQty` is the ledger truth** (post BUG-2026-04-27-032). Read paths
  trust it; they may filter rows out of the view but never override the qty.
- **No `MAX(0)` clamp.** Cascade decrements unconditionally so an
  out-of-order downstream completion writes a negative-qty stub that
  surfaces the upstream gap (BUG-2026-04-27-013).

---

## 1. Sources of writes

Every code path that touches `wip_items`. File:line cited; comments in the
source carry the original BUG-NNN diagnoses.

### 1a. `applyWipInventoryChange()` — the JC-status cascade

`src/api/routes-d1/production-orders.ts:844-1309`. Called from two sites:

- The PATCH `/api/production-orders/:id/job-cards/:jcId` handler at
  `:1741` (form / dept-pivot edits, with `prevStatus`).
- The "scan" path at `:2853` (barcode-driven JC completion).

The cascade has the following internal branches, in order:

1. **Same-status short-circuit (BUG-2026-04-27-005)** — `:856`. Returns
   immediately if `prevStatus === newStatus`. Prevents a duplicate PATCH
   from doubling every consume + producer-add.

2. **Idempotency / wipLabel-fallback guard** — `:879-895`. Synthesizes a
   `wipLabel` from `productCode + wipCode + (DEPT)` when the JC was created
   without BOM (legacy seed). Without this fallback, completing a non-BOM
   PO silently no-ops the wip_items upsert.

3. **PACKING bypass (BUG-2026-04-27-016)** — `:871-872`. PACKING is a
   metadata-only step; it records the racking_number on the PO row but
   does NOT participate in the inventory cascade. UPH already wrote the
   +qty rows and consumed its upstreams; `deriveFGStock` counts the PO as
   FG once all UPH JCs are COMPLETED; DO/DR handles dispatch from FG.

4. **Rollback branch (BUG-2026-04-27-002)** — `:939-1020`. Symmetric
   inverse of the forward path, fires when `wasDone && !isDone`:
   - **Non-UPH:** subtract `wipQty` from this JC's own row, refund the same
     qty to the upstream sibling that the forward path consumed from.
     Sibling lookup is `(wipKey, branchKey)`-aware (BUG-2026-04-27 / mig
     0058) so parallel BOM branches don't cross-refund.
   - **UPH:** subtract from UPH's own row, refund every upstream `wipKey`
     sibling that the forward UPH-COMPLETED path consumed from.
   - **No `MAX(0)` clamp** — symmetric with the forward consume; rollback
     before any forward-completion can go negative as a visibility signal.

5. **Forward consume (non-UPH, non-FAB_CUT, non-WOOD_CUT)** —
   `:1025-1085`. On `IN_PROGRESS` or `COMPLETED`, decrement the immediate
   upstream sibling within the same `(wipKey, branchKey)` by this JC's
   `wipQty`.
   - FAB_CUT and WOOD_CUT are raw-material entry points — neither has an
     upstream wip_items to consume.
   - **BUG-2026-04-27-013 cascade write:** if the upstream wip_items row
     doesn't exist (the upstream JC was skipped or never completed), INSERT
     a row with `stockQty = -consumeQty` and `deptStatus = 'PENDING'` so
     the negative number surfaces the missed dept on the WIP grid.

6. **Producer-add for non-UPH dept on COMPLETED** — `:1198-1230`. Upsert
   by `code = wipLabel`, accumulate `+wipQty` on each completion. Sets
   `deptStatus = jc.departmentCode` and `status = 'COMPLETED'`.

7. **UPH branch-terminal consume (BUG-2026-04-27-014)** — `:1097-1155`.
   When UPH reaches COMPLETED:
   - Find the **branch terminal** of each BOM branch — the JC at the
     highest `sequence < UPH.sequence` per `branchKey`. Earlier upstreams
     in the chain (FRAMING ← WOOD_CUT, etc.) are NOT UPH's direct
     upstream; their stock is already consumed by their own direct
     downstream dept.
   - Decrement each branch terminal's wip_items row by `consumeQty`. Same
     no-clamp + INSERT-negative-stub semantics as branch (5).

8. **UPH producer-add own row** — `:1162-1194`. Upsert UPH's own row
   keyed by its `wipLabel`, `+consumeQty` accumulating. Sets `deptStatus
   = 'UPHOLSTERY'`. The read path uses `deptStatus = 'UPHOLSTERY'` to
   recognize this row as "FG-equivalent if every UPH JC of the PO is
   complete" (BUG-2026-04-27-017 follow-up).

9. **Sofa Fab Sew → all-FAB_CUT-on-(SO,fabricCode) zero-out** —
   `:1234-1272`. Legacy sofa rule: the moment Fab Sew picks up the
   stack to start sewing ANY piece of a (SO, fabric) sofa set, the whole
   batch has left Fab Cut's shelf. The first FAB_SEW IN_PROGRESS in a
   `(salesOrderId, fabricCode)` group zeros every upstream FAB_CUT
   wip_items row in that group. Subsequent siblings are no-ops because
   the stock is already 0.

10. **Default IN_PROGRESS consume (BF / accessory / non-sofa Fab Sew)** —
    `:1273-1307`. Per-JC consumption of the immediate upstream within the
    same `(wipKey, branchKey)`, clamped at 0 here (`Math.max(0, …)`) —
    note: this is the IN_PROGRESS-only path; the COMPLETED path
    (branches 5/7) is the unclamped one that surfaces negatives.

### 1b. DO Dispatch (BUG-2026-04-27-021)

`src/api/routes-d1/delivery-orders.ts:1109-1167` (forward) and `:1229-1271`
(reverse).

- **DRAFT → LOADED (`stampedOnDispatch`)**: query `job_cards` for every
  UPH JC of every PO referenced by the DO that has `wipLabel IS NOT NULL`.
  For each, push `UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?`
  into the same batch as the dispatch SQL. Decrement uses the JC's own
  `wipQty` if set, else the PO's quantity.
- **LOADED → DRAFT (`revertedToDraft`)**: symmetric inverse — re-credit
  `+ ?` for each UPH wipLabel of each PO that was stamped.
- Idempotency: gated on the exact transition predicate, so re-PATCHing a
  LOADED DO with `status=LOADED` is a no-op. No `MAX(0)` clamp —
  symmetric with BUG-013.

This balances the books once the goods physically leave: the UPH
producer-add is no longer represented by anything physical we own.

### 1c. Admin DEV Clear

`src/api/routes-d1/admin.ts:719-767`. Endpoint
`POST /admin/clear-all-completion-dates?confirm=YES_CLEAR_ALL_COMPLETION_DATES`.
Resets every JC + active PO + wipes cascade-written `wip_items` rows. Two
SQL writes:

- `UPDATE wip_items SET stockQty = 0 WHERE stockQty != 0`
- `DELETE FROM wip_items WHERE id LIKE 'wip-dyn-%'`

The first zeroes producer-add rows and negative stubs; the second deletes
cascade-created stubs (id prefix `wip-dyn-`). Manually-seeded zero-stock
rows are preserved (id NOT LIKE `wip-dyn-%`).

(Historic note: the cascade fix in commit `a3e68ed` added the
DELETE-pattern; before that the DEV Clear left orphaned cascade artifacts.)

### 1d. Migrations

- `migrations/0041_retro_fab_cut_consume.sql` — one-shot retro consume
  for sofa Fab Cut where the IN_PROGRESS path was added later than the
  data.
- `migrations/0042_retro_all_dept_consume.sql` — generalized retro
  zero-out across all dept pairs after the IN_PROGRESS-only restriction
  was lifted.
- `migrations/0043_fix_divan_bom_qty.sql` / `0044_revert_divan_bom.sql` —
  data-fixup migrations on the BOM rather than the cascade itself; they
  affect the `wipQty` value the cascade reads but not the cascade logic.

### 1e. (None) cost-cascade write site

`src/api/lib/po-cost-cascade.ts:671-674` carries a `TODO(wip-phase-2)`
to walk the BOM tree + emit per-WIP-node ledger entries. It does NOT
write `wip_items` today — only `cost_ledger`.

---

## 2. Sources of reads

Every code path that displays / aggregates `wip_items`.

### 2a. WIP page

`src/api/routes-d1/inventory-wip.ts` — `GET /api/inventory/wip`.

- Reads every non-zero `wip_items` row (`stockQty != 0`).
- Joins each row to the active POs + JCs to enrich with category, sources,
  ageDays, cost.
- Filters out UPH-coded rows whose every linked PO is fully UPH-complete
  (BUG-2026-04-27-017 / -018 / -019 + the BUG-2026-04-27-032 follow-up).
- **Trusts `wip_items.stockQty` as the displayed qty** (post BUG-022). No
  per-PO attribution sum.

### 2b. FG page (`deriveFGStock`)

`src/pages/inventory/index.tsx:259-326`. Frontend roll-up that **does NOT
read `wip_items`.** It iterates `productionOrders[]`, finds POs where every
UPH JC is `COMPLETED` / `TRANSFERRED`, and emits one FG row per PO
(adjusted by `poStatusByDO` for DRAFT-reservation vs DISPATCHED-skip).

This is the dual data source that BUG-017 / -018 reconcile: a UPH-coded
`wip_items` row that's hidden by the WIP filter is surfaced here instead.

### 2c. `inventory.ts` master fetch

`src/api/routes-d1/inventory.ts:135-146` (`GET /api/inventory`) returns
the entire `wip_items` table as `wipItems[]` for the maintenance page
(`src/pages/procurement/maintenance.tsx`) and the BOM page
(`src/pages/bom.tsx`). Pure pass-through, no filter.

### 2d. (Indirect) Cost rollups

`cost_ledger` has a `TODO(wip-phase-2)` to track WIP layer costs (see
1e). When that lands it will be a read+write site; today it's neither.

---

## 3. WIP entry conditions

When does a `wip_items` row APPEAR with positive qty?

| Trigger | Code path | Branch |
|---|---|---|
| Non-UPH dept JC reaches COMPLETED — producer-add | production-orders.ts:1198-1230 | branch 6 |
| UPH JC reaches COMPLETED — UPH producer-add | production-orders.ts:1162-1194 | branch 8 |
| FAB_CUT / WOOD_CUT JC reaches COMPLETED — entry-point producer-add | production-orders.ts:1198-1230 | branch 6 (same upsert; FAB_CUT/WOOD_CUT skip the consume side) |

A row is INSERTed (id prefix `wip-dyn-`) only if the keyed code doesn't
already exist; otherwise the existing row's `stockQty` accumulates `+wipQty`.

---

## 4. WIP exit conditions

When does a row DISAPPEAR (or go to 0 / hide from view)?

### Ledger writes (`stockQty` decremented or zeroed)

| Trigger | Code path | Effect |
|---|---|---|
| Downstream non-UPH dept goes IN_PROGRESS — immediate upstream consume | production-orders.ts:1273-1307 | `-wipQty` on the immediate upstream sibling (clamped 0) |
| Downstream non-UPH dept goes COMPLETED — same consume on the COMPLETED branch | production-orders.ts:1025-1085 | `-wipQty` (unclamped, may go negative) |
| UPH JC goes COMPLETED — branch-terminal consume | production-orders.ts:1097-1155 | `-wipQty` on each branch terminal's row |
| Sofa Fab Sew IN_PROGRESS — group zero | production-orders.ts:1246-1271 | sets every FAB_CUT row in `(salesOrderId, fabricCode)` group to 0 |
| DO Dispatch DRAFT → LOADED | delivery-orders.ts:1109-1167 | `-wipQty` on every UPH wipLabel of every PO on the DO |
| Rollback DONE → non-DONE (non-UPH) | production-orders.ts:985-1018 | `-refundQty` on JC's own row + `+refundQty` on upstream sibling |
| Rollback DONE → non-DONE (UPH) | production-orders.ts:945-978 | `-refundQty` on UPH's own row + `+refundQty` on every upstream sibling |
| Admin DEV Clear | admin.ts:754-755 | `stockQty = 0` for every non-zero row + `DELETE` of every cascade-stub |

### View-layer hides (row exists but not shown on WIP page)

| Trigger | Code path | Effect |
|---|---|---|
| Every linked PO of a UPH-coded row is fully UPH-complete (BUG-017/018/019/022) | inventory-wip.ts:306-318 | row hidden — surfaces via FG `deriveFGStock` instead |
| `stockQty == 0` | inventory-wip.ts:178-185 | filtered at SQL (`WHERE stockQty != 0`) |

---

## 5. Negative-qty rows

### When is a negative row written?

The cascade INSERTs `stockQty = -consumeQty` when a downstream dept reaches
COMPLETED but the upstream wip_items row doesn't exist (because the
upstream JC was skipped, never completed, or out-of-order). Two specific
sites (BUG-2026-04-27-013):

- Non-UPH cascade consume INSERT — production-orders.ts:1064-1078
- UPH branch-terminal consume INSERT — production-orders.ts:1139-1153

Both write `deptStatus = 'PENDING'` and `id` prefix `wip-dyn-` so the
read path can recognize them as cascade stubs.

### What does negative qty mean visually?

`inventory-wip.ts:384-469` recognizes `w.stockQty < 0` as a negative row.
For these:

- `completedBy = "PENDING"` (rendered "—" in the UI)
- `oldestAgeDays = null` (rendered "—")
- `estUnitCostSen = 0` (rendered "—")
- `sources[]` lists the **triggering JC's PO** — the JC immediately
  downstream of the missing producer in the same `(wipKey, branchKey)`
  with `status = COMPLETED/TRANSFERRED`. Per-PO deduped (BUG-015).

### When does a negative row return to 0?

Once the missing upstream JC is finally marked COMPLETED, the producer-add
branch upserts the row with `+wipQty`, and the negative + positive cancel
to 0 (or the remaining short still surfaces). Once at 0, the SQL filter
`stockQty != 0` drops it from the WIP grid. Admin DEV Clear deletes the
underlying row outright (id matches `wip-dyn-%`).

---

## 6. Edge cases

| Case | Current handling |
|---|---|
| Multi-PO sharing wipLabel | Aggregate `stockQty` accumulates contributions from every producer PO. Read path filters the row only when EVERY linked PO is fully UPH-complete (otherwise the row is shown at full ledger qty — see § 7 for the design tension). |
| Orphan rows (no JC link) | `inventory-wip.ts:307-310` returns `true` (show as-is) so the user can spot and reconcile (BUG-019). |
| Idempotency on duplicate PATCH | `applyWipInventoryChange:856` short-circuits when `prevStatus === newStatus` (BUG-005). |
| DO Dispatch reversal LOADED → DRAFT | symmetric `+wipQty` re-credit (BUG-021). |
| UPH rollback DONE → non-DONE | `-refundQty` on UPH's own row, `+refundQty` on every upstream sibling (BUG-002). |
| Cascade-companion `cascadeUpholsteryRollbackToSO` | UPH rollback also flips SO status from READY_TO_SHIP → CONFIRMED + clears `production_orders.stockedIn` (BUG-020). |
| FAB_CUT / WOOD_CUT entry points | No upstream consume (raw-material producers); they only emit the producer-add. |
| BOM rename | `scripts/resync-wip-labels.ts` renames `wip_items.code` to follow JC `wip_label` rename (BUG-004). |

---

## 7. Known intentional double-counts / mismatches

These are **not bugs** — design decisions documented for transparency.

### 7a. Multi-PO partial vs fully-UPH

A `wipLabel` like `5531 -Back Cushion 24` shared by 5 sofa POs:

- 3 POs are fully UPH-complete (their qty surfaces as FG via
  `deriveFGStock`).
- 2 POs are partial (UPH still WAITING).

The aggregate `wip_items.stockQty` reflects all 5 POs' producer-adds. The
view filter shows the row as long as ANY linked PO is partial — which
means the row is shown at the full aggregate qty even though 3 of those
units are also surfaced via FG. This is a known double-count in the
displayed numbers.

The previous code (pre BUG-2026-04-27-032) tried to attribute per-PO and
subtract the fully-complete contributions from the displayed qty. That
implementation summed UPH JC capacity rather than produced stock and
inflated the displayed qty for any wipLabel shared by many WAITING UPH
JCs. Until a proper per-PO ledger lands, the simpler "trust stockQty"
rule is preferred — overcount is loud, undercount is silent.

### 7b. WIP read path vs FG read path use different data sources

`inventory-wip.ts` reads `wip_items` directly. `deriveFGStock` reads
`production_orders` + `job_cards` (and ignores `wip_items`). They're
reconciled at the WIP read path's UPH-row hide rule (§ 4 view-layer
hides), which is conditional on a fully-UPH-complete PO — the same
predicate `deriveFGStock` uses to surface a PO as FG. As long as the two
predicates stay aligned, the rows transition cleanly between views.

### 7c. UPH producer-add and dispatch decrement are separate ledger events

UPH completion writes `+wipQty` to `wip_items`. DO Dispatch writes
`-wipQty` to the same row. Between those two events the row is hidden by
the WIP view (§ 4) but still counted in the ledger. This is by design so
the ledger can answer "what was on the floor vs what shipped" — the
view-layer hide is the UX rule, not the accounting rule.

---

## 8. Failure modes / what causes drift

| Failure mode | Mitigation |
|---|---|
| DEV Clear bypassing cascade for unfinished POs | Fixed in commit `a3e68ed` — the DELETE pattern now also drops cascade stubs alongside the zero-out. |
| Stuck negative rows after rollback (the rollback clamp was too aggressive) | Fixed in BUG-2026-04-27-002 — rollback now refunds upstream + subtracts producer-add; combined with BUG-013's no-clamp the negative auto-clears once the upstream finally completes. |
| Same-status PATCH replay doubling writes | Fixed in BUG-2026-04-27-005 short-circuit at `applyWipInventoryChange:856`. |
| Inflated displayed qty from per-JC attribution sum | Fixed in BUG-2026-04-27-032 — read path now trusts `stockQty` as displayed qty; per-PO attribution dropped. |
| BOM rename leaving `wip_items.code` orphaned | One-shot `scripts/resync-wip-labels.ts` renames historical stock when JC `wip_label` changes (BUG-2026-04-27-004). |
| DO Dispatch leaving residual +qty in the ledger | Fixed in BUG-2026-04-27-021 — dispatch decrement + reversal symmetric. |
| Skipped upstream silently swallowed | Fixed in BUG-2026-04-27-013 — cascade now writes negative stubs that surface the missed dept. |
| UPH consuming non-terminal upstreams | Fixed in BUG-2026-04-27-014 — UPH consumes only the branch terminal of each `branchKey`. |

---

Last updated: 2026-04-27 (BUG-2026-04-27-032 fix).
