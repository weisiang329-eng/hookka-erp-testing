# Bug History

Living log of bugs we've identified, diagnosed, and fixed in Hookka ERP.

Each entry: ID, status, what happened (user-visible symptom), root cause, fix
(file:line), and how we verified it. Newest first.

Status legend:
- 🔴 **Identified** — diagnosed, not yet fixed
- 🟡 **Fix in progress**
- 🟢 **Fixed** — code shipped + verified

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
