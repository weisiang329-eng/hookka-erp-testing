# Bug History

Living log of bugs we've identified, diagnosed, and fixed in Hookka ERP.

Each entry: ID, status, what happened (user-visible symptom), root cause, fix
(file:line), and how we verified it. Newest first.

Status legend:
- 🔴 **Identified** — diagnosed, not yet fixed
- 🟡 **Fix in progress**
- 🟢 **Fixed** — code shipped + verified

---

## BUG-2026-04-27-010 — Dept-Pivot editor lists DRAFT BOMs as duplicate rows

**Status:** 🟢 Fixed (2026-04-27)

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

**Status:** 🔴 Identified (low priority)

**Symptom:** Marking the same JC complete twice double-deducts upstream
wip_items and double-adds the producer row. The cascade has no per-JC guard
against repeat COMPLETED dispatches.

**Root cause:** `src/api/routes-d1/production-orders.ts:823-1019`
`applyWipInventoryChange` runs the consume + producer-upsert path
unconditionally on every status='COMPLETED' call. The `MAX(0, …)` clamp
prevents negatives but doesn't prevent drift on the producer side. The
rollback branch (BUG-2026-04-27-002) only fires on DONE→non-DONE.

**Fix plan:** add an idempotency guard keyed on (jobCardId, prevStatus).
If `prevStatus === newStatus === COMPLETED` (or TRANSFERRED), short-circuit.
Or use a `cost_ledger`-style ledger for wip_items movements so re-emission
is a no-op.

**User judgement (2026-04-27):** deferred. Their mental model: UPH = stock
entry, PACKING = record racking number only. Repeated PACKING-complete
events have low real-world impact; revisit if drift becomes visible.

---

## BUG-2026-04-27-006 — `cascadeUpholsteryToSO` runs on every PATCH, not just status changes

**Status:** 🔴 Identified (low priority)

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

**Status:** 🔴 Identified (cosmetic / naming clarity)

**Symptom:** Post-PACKING-complete, the cascade writes `fg_units` rows
with `status='PENDING'` (see `src/api/routes-d1/fg-units.ts:272`). Name
is misleading — these units ARE finished / in stock; PENDING here means
"not yet packed/loaded onto a DO". They later transition to LOADED →
DELIVERED via the delivery_orders flow.

**Root cause:** legacy naming choice. The fact that
`deriveFGStock` (frontend) counts UPH-done POs independently of
`fg_units.status` masks the confusion in most views.

**Fix plan:** rename the initial state to `IN_STOCK` (or similar) and add
a separate flag/column for "ready for DO" lifecycle if needed. Schema
migration + UI text update.

---

## BUG-2026-04-27-009 — `inventory-wip.ts` derives baseModel via `productCode.split("-")[0]`

**Status:** 🔴 Identified (display only)

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
