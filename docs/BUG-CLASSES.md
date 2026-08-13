# Recurring bug classes — the index that makes P5 executable

`PLAYBOOKS.md` **P5** says: *"Fix all instances of the same class, not just the flagged one."*

That instruction is unusable without a list of the instances. `BUG-HISTORY.md` is ordered by
**date**, so "the same class" only exists in whoever's memory. The result, measured:

| class | times fixed | each fix repaired |
|---|---|---|
| server trusts a client-supplied price | 3 | only the one column that had been noticed |
| write path skips the dept-sheet cache wipe | 3 | only the one file someone was looking at |
| fallback to the customer's DEFAULT hub | 3 | only the one document that printed wrong |
| a child array scanned once per parent row (C14) | 3 | only the one list endpoint that was slow that week — the third miss was the hottest path in the app |
| a dead request rendered as an answer (C15) | 2 so far | the reports pass (2026-08-13) fixed 5 tabs and left the same conflation on 19 detail/edit screens, because the shared primitive was swallowing the abort |

The 2026-07-17 fix header literally reads *"This is the same bug class as the 2026-07-14
totalHeightPriceSen fix"* — the author saw the class, and still fixed one column. The sibling
fields were on adjacent lines.

**This file is the missing list.** When you fix anything below, you are not done until every
row in that class is ✅ or has a written reason.

> **Adding a class:** you have earned one the moment you write "same bug as…" in a commit
> message or a code comment. Add the section then, not later.

---

## C1 — The server stores whatever the client posted

**Shape.** A write path does `const x = Number(item.x) || 0`. One client computes `x` and
sends it; another does not. The order looks fine on the screen that computes it and is silently
wrong from every other entry point.

**Why it keeps happening.** The components sit on adjacent lines, so a fix to one reads as
complete. Both scan-PO clients POST `/api/sales-orders` **directly**, never through the form.

**The rule.** The server derives the value when the client OMITS the field, and trusts any
supplied number — including a deliberate `0`. Never guess a price for something not in the
owner's list.

| # | component | fixed | cost | resolver |
|---|---|---|---|---|
| 1 | `totalHeightPriceSen` | 2026-07-14 | — | client-supplied (no stored height to derive from) |
| 2 | `specialOrderPriceSen` | 2026-07-17 | RM 8,060 / 66 SOs | `resolveSpecialOrderPriceSen` |
| 3 | `divanPriceSen` | 2026-07-22 | RM 9,895 | `resolveHeightPriceSen` |
| 4 | `legPriceSen` | 2026-07-22 | RM 2,560 | `resolveHeightPriceSen` |
| 5 | `basePriceSen` | n/a — correct by design | — | customer price → product price (`resolveLineBasePriceSen`) |

**Enforced by** `tests/price-component-class.test.mjs` — fails if any component returns to
`Number(item.X) || 0`, or if a resolver is missing from either the POST or the PUT loop.

**Adding a 6th component?** Add it to `COMPONENTS` in that test first. It will fail until wired.

---

## C2 — A write that the dept sheets never hear about

**Shape.** Something writes `production_orders`, but the operator's screen reads a
cache-aside snapshot behind a KV body. Neither layer notices the write, so the shop floor keeps
seeing the old state until a TTL expires.

**Both layers, always.** Wiping only the snapshot leaves a warm KV body serving `X-Cache: HIT`;
bumping only the KV version lets the snapshot re-serve stale. `invalidateProductionListCaches`
in `src/api/lib/po-list-cache.ts` does both — call it, don't hand-roll.

**Do not trust the freshness probe.** It compares `built_from` against `MAX(updated_at)` across
mixed TEXT/TIMESTAMP columns and is documented in `snapshot.ts` as unreliable ("the probe
lies"). Wipe explicitly.

| # | writer | fixed | symptom that exposed it |
|---|---|---|---|
| 1 | scan completion | 2026-06-06 | Fab Cut stuck PENDING while the card was COMPLETED |
| 2 | `applyPoUpdate` (dept-cell edit) | 2026-06-24 | a PIC / completion-date edit invisible for a full day |
| 3 | SO status cascade | 2026-07-22 | an SO went ON_HOLD; the Fab Sew sheet showed no hold |
| 4 | CO status cascade | 2026-07-22 | same, consignment side |
| 5 | `admin.ts` rebuild-all-pos | 2026-07-23 | found by the class test, not by an incident |
| 6 | `import-completion.ts` | 2026-07-23 | ditto |
| 7 | `service-orders.ts` cascade | 2026-07-23 | ditto |
| 8 | `sheets-sync.ts` webhook | 2026-07-23 | ditto |

Rows 5–8 are the point of this file: the 07-22 fix repaired 3 and 4 and stopped, because
nothing counted the rest.

**Enforced by** `tests/production-write-invalidation-class.test.mjs` — enumerates the writers
from disk. A new writer fails the test until wired, or is listed in `EXEMPT` with a reason.

---

## C3 — Falling back to the customer's DEFAULT hub

**Shape.** Code needs a hub, the specific one is unavailable on that path, so it takes
`ORDER BY isDefault DESC LIMIT 1`. Every Houzs document silently becomes "Houzs KL".

**The rule.** Derive the hub from the document's own contents. A consolidated DO has no single
`salesOrderId`, but its LINES all carry one — and the composition guard already proves they
share one hub, so the lookup is safe.

| # | site | fixed | symptom |
|---|---|---|---|
| 1 | FG sticker `customerHub` | 2026-06-05 | every box label printed "Houzs KL", incl. Sabah / Sarawak |
| 2 | service-order DO | 2026-06-11 | service DO printed a blank / wrong Deliver-To |
| 3 | SO create hub resolution | — | correct: `body.hubId` → customer default only when absent |
| 4 | **consolidated DO header** (`delivery-orders.ts`) | ✅ 2026-07-23 | 15 post-guard DOs whose lines are 100% PG/SRW/SBH were labelled "Houzs KL" |

Row 4 is now derived from the SO lines (DISTINCT hub across the DO's SOs, accepted only when
there is exactly one — the composition guard's invariant), before the default-hub fallback.
The 15 already-shipped DOs were deliberately left as-is per the owner: **fix forward, do not
relabel shipped documents**. The printed address was always correct; only the header label was
wrong, so the damage was to reporting (delivery planning, 3PL state rates), not deliveries.
Pinned by `tests/do-consolidated-hub.test.mjs`.

**Not the same as** a mixed-hub DO. Different hubs on one DO is blocked by the composition
guard (BUG-2026-06-11-008) and that guard works — zero mixed DOs since it landed.

---

## C4 — More than one copy of the same price list

**Shape.** The same prices exist in several places; only one is read; the others are never
updated and quietly rot. Anyone (human or agent) who reads the wrong copy prices from a dead
list.

| # | copy | read by | state |
|---|---|---|---|
| 1 | `kv_config variants-config.specials` / `.divanHeights` / `.legHeights` | **everything** | ✅ the source of truth |
| 2 | `src/lib/pricing-options.ts` | the silent fallback when the config fails to load | ✅ realigned 2026-07-23 — had drifted a whole price increase behind |
| 3 | `variants-config.bedframeSpecialOrders` / `.sofaSpecialOrders` | **nothing** | ✅ deleted 2026-07-22; the seeder stopped writing them 2026-07-23 |

Copy 3 cost real money: the 2026-07-17 backfill priced from it and had to be topped up RM 30
after read-back. It survived because **one script planted it while another weeded it**
(`seed-from-production-sheet.ts` wrote it; `sync-maintenance-config.ts` deleted it) — whichever
ran last won. Deleting the data was not enough; the producer had to stop.

**Enforced by** the drift assertion in `tests/price-component-class.test.mjs`. It compares the
static catalog against the live values. If the owner changes a price in Settings, update
`pricing-options.ts` and that test's expectations together.

---

## C5 — A leg whose identity carries a suffix, read by exact match

**Shape.** Correction/restate legs reuse their document's identity **plus a suffix** —
sourceType `invoice_restate_post:<stamp>`, sourceId `pi-xxx:edit-<stamp>`. Any reader that
matches the RAW value misses them, and the miss is silent: the leg simply falls into whatever
the fallback is (postedAt dating, "no legs to reverse", "nothing to hide").

| # | reader | matched on | state |
|---|---|---|---|
| 1 | sourceTYPE suffixes everywhere (`stripLegSuffix`) | stripped | ✅ handled since the restate pattern; `tests/doc-date.test.mjs` |
| 2 | `ap-recon.ts` doc attribution | strips `:edit-` | ✅ born correct |
| 3 | `loadDocDateResolver` (dates every leg for /gl, P&L windows, **the opening floor**) | raw sourceId → postedAt fallback | ✅ fixed 2026-07-24 (BUG-2026-07-24-001: two May PI tax-edits dated as July, escaped the floor, +407.04 drift) |
| 4 | `applyLifecycle` reversal SELECT + hidden UPDATEs | raw sourceId | ⬜ latent — unreachable today (PIs don't use lifecycle; PI delete is DRAFT-only = no legs). Warning comment in place; widen the matches if a `:<tag>`-legged doc type is ever wired in |
| 5 | supplier-payment UNVOID leg un-hiding | exact `supplier_payment` sourceType | ✅ fixed 2026-07-24 (BUG-2026-07-24-002: an edited payment's live legs are `restate_post:<stamp>` — unvoid resurrected the stale pre-edit base legs; now picks `latestRestatePostType`) |

**Enforced by** the `stripSourceIdSuffix` cases in `tests/doc-date.test.mjs`. When adding a NEW
suffixed identity (a second `:<tag>` writer), grep every `sourceId = ?` / `.get(sourceId)`
against ledger legs first.

---

## C6 — One day, charged twice

**Shape.** A worker-day's pay is reduced by two INDEPENDENT mechanisms that don't know about
each other:

- **absence** — `labor-engine.ts` calls a day absent when it has **no logged hours**, and docks
  the full contractual day (`salary ÷ workingDaysPerMonth`);
- **hour docks** — `payroll_hour_deductions` rows, valued at the hourly rate.

Nothing ever said they were mutually exclusive, so a day with zero logged hours could take BOTH.
The absence is the bigger charge and the dock rides on top, invisibly — the payroll screen shows
"Absent 18d" and "Late/short 9h" as separate lines and neither looks wrong on its own.

The trigger is always a punch the shift maths can't read as a working day: someone who forgot the
morning punch and does both at knock-off (18:01 in / 18:02 out) produces `regularWorkMin = 0`,
which the dock path read as "short the whole 9h day".

| # | writer | state |
|---|---|---|
| 1 | live punch-out (`POST /worker/clock` → `maybeApplyAutoPunchDock`) | ✅ covered by the core guard. NOTE the call order: `autofillWorkingHoursFromPunch` MUST run first, or the guard sees a day with no hours yet and skips every legitimate dock |
| 2 | monthly settle (`POST /payroll-hour-deductions/settle-period`) | ✅ covered by the core guard |
| 3 | office re-apply-from-punch (`POST /payroll-hour-deductions/apply-punch`) | ✅ covered by the core guard |
| 4 | owner's MANUAL dock (`POST /payroll-hour-deductions`) | ⬜ deliberately NOT guarded — an owner docking an absent day is their decision, and the `manual-exists` guard already stops auto from touching it |
| 5 | the shift maths itself (`computePunchShortfallHours`) | ✅ a window yielding no payable minutes at all is a BROKEN PUNCH, not a zero-hour day → `valid: false`, no evidence, no dock |

**The rule.** *A day with zero logged working hours is an ABSENCE — already charged in full — and
must never also carry an automatic hour dock.* It is enforced in ONE place,
`maybeApplyAutoDayDock` (reason `absent-day`), because every automatic path funnels through it;
it also DELETES any stale AUTO row it finds, so old damage self-heals on the next settle.

**Enforced by** `tests/punch-degenerate-window.test.mjs`. The mock DBs in
`tests/auto-attendance-deduct.test.mjs` and `tests/settle-period-punch.test.mjs` now return a
day's logged hours (default 8) — if you add a dock test and it unexpectedly returns
`absent-day`, that is the guard, not a bug.

**When adding a new deduction mechanism**, ask first: can it land on a day the absence rule
already charges? If yes, route it through `maybeApplyAutoDayDock` rather than writing
`payroll_hour_deductions` directly.

---

## C7 — Two segments of one grid sharing a sticky filter

**Shape.** `DataGrid` persists column value-filters under
`datagrid-filters-<gridId>-<valueFilterKey>-<user>`, and seeds a column's
selection from the values **present in the data it is currently showing**
(`defaultExcludedValues` effect, `data-grid.tsx`). If two segments of the same
page share one storage key, a set seeded while looking at segment A contains
none of segment B's values — so switching to B hides every row while the footer
cheerfully reports `0 of N records · 1 filter active`.

It reads as data loss, not as a filter, which is why it gets re-reported.

**Instances**

| Date | Where | Segmenting state that was missing from the key |
|---|---|---|
| 2026-05-16 | Sales Orders | the Status dropdown → fix added `filterStatus` |
| 2026-08-01 | Sales Orders **again** | the Draft/Confirmed `tab` — never covered by the first fix. Owner: 「包裹为什么by default是kosong的」 |

The repeat is the point: the 2026-05-16 fix repaired the instance in front of
the author and left the sibling state alone.

**The rule.** *Every* state that segments the rows must appear in either
`gridId` or `valueFilterKey`. Adding a new tab / dept / mode selector to a page
that already has a grid means extending that key in the same commit.

**Already-safe siblings** (checked 2026-08-01, pinned by
`tests/grid-filter-session-class.test.mjs`):
* Production — bakes the department into `gridId`
  (`production-dept-<code>`), so each department has its own key.
* Service Cases — `statusFilter` is its only segment and it *is* the key.

**Also worth knowing.** A default exclusion that cannot apply to a segment
should not be sent at all: on the Draft tab every row is already `DRAFT`, so
seeding a Status exclusion there can only narrow a list that is exactly what was
asked for. That was the other half of the blank tab.

## C8 — The D1 integer idiom, bound to a real Postgres BOOLEAN

**Shape.** `.bind(flag ? 1 : 0)` against a column whose type is `boolean`.
`postgres.js` maps **every value that is not a JS boolean** to `FALSE`:

| bound | stored |
|---|---|
| `true` (boolean) | `true` |
| `false` (boolean) | `false` |
| `1` (number) | **`false`** |
| `0` (number) | `false` |
| `"1"` / `"true"` (string) | **`false`** |

No error. No 500. HTTP 200, success toast, and the value on screen is not the
value in the database. That is the whole danger: every other write bug in this
file announces itself somewhere. This one does not.

**Why it keeps happening.** `flag ? 1 : 0` is **correct** for most of this
codebase. It came from Cloudflare D1 (SQLite), where a boolean *is* the integer
0/1, and the great majority of flag columns here really are `INTEGER`. Only
**ten** columns in 267 tables were created as an actual `BOOLEAN`. On those ten,
and nowhere else, the ordinary idiom silently writes false. `tsc` cannot see it
— the SQL is a string — and no test in the suite executes a real INSERT.

**Instances**

| Date | Where | Effect |
|---|---|---|
| 2026-08-02 | `workers.is_outsource` — `merged.isOutsource ? 1 : 0` (`routes/workers.ts`) | Ticking "Outsourced" never stuck. `pay_mode` and `daily_rate_sen` in the SAME statement saved fine, so it read as a cache bug. Owner: 「我明明设置了这个人是 outsource…他又没有 save 成功」 |
| 2026-08-02 | `sales_orders.is_service_order` — bare `0` (`lib/intercompany-mirror-create.ts`) | Latent. `0` lands on `false`, which is the intended value, so nothing was visibly wrong — but only by luck. |

**The rule.** A column of type `boolean` is bound a **JS boolean**. Never
`? 1 : 0`, never `Number(...)`, never a string.

**Covered by** `tests/boolean-column-binds.test.mjs`, which maps `.bind()`
arguments positionally onto the columns of each INSERT/UPDATE and fails on a
non-boolean bound to any column in `tests/db-boolean-columns.json`. That fixture
is regenerated from production by `scripts/refresh-db-schema-fixture.mjs` —
**re-run it after any migration that adds a boolean column**, or the new column
is unguarded.

> The first version of that test counted only the `?` in `SET` and not the one
> in `WHERE id = ?`. The counts disagreed by one, the statement was skipped, and
> the test passed while the bug was still in the file. It was caught by putting
> the bug back and checking the test went red. Do that; a guard nobody has seen
> fail is not a guard.

**The other nine boolean columns, checked 2026-08-02 and safe:**
`workers.{epf,socso,eis,pcb}_enabled` (real booleans on both INSERT and UPDATE),
`worker_pins.must_reset` (SQL literal `false`), `announcements.is_active`
(`? true : false`), `organisations.is_default` (`=== true ? true : false`),
`rd_team_members.active` (real boolean).

## C9 — A runtime migration memoised as a PROMISE

**Shape.** Migrations are inert on deploy here, so a column reaches production
only through an `ALTER TABLE … IF NOT EXISTS` awaited before the first write.
Every one of those was memoised like this:

```ts
let _mig: Promise<void> | null = null;
export function ensureX(db) {
  if (_mig) return _mig;          // a REJECTED promise is still a promise
  _mig = (async () => { … })();
  return _mig;
}
```

Two defects share that one shape:

1. **A failed round is remembered as done.** One transient DDL blip on the first
   write after an isolate boots leaves the column unapplied and never retried
   for that isolate's life. Every later write fails on a missing column and
   nothing says why. Worse where the body did `.catch(() => undefined)`: the
   memo *resolves*, so failure is recorded as success.
2. **A pending promise holds its creator's socket.** `db-pg.ts` forbids sharing
   that across requests in capitals. A cache change doing exactly this took
   Sales Orders down on 2026-08-02.

**Why it keeps happening.** The shape reads as an obvious optimisation, and it
is correct for anything idempotent that cannot fail. It is only wrong because
this is the *load-bearing* path for schema.

**Instances**

| Date | What | Outcome |
|---|---|---|
| 2026-08-02 (am) | #222 converted 26 sites to `runSelfApply` | Half a fix. The helper throws "so the caller's memo can be cleared" — and 38 callers cleared nothing, so the retry it enables never happened. |
| 2026-08-02 (pm) | The 38 remaining callers | 32 by codemod, 6 by hand (they swallowed errors inline). Two of the six guard *unique indexes* that win a concurrent-create race — an isolate that remembered a failed `CREATE INDEX` as done is exactly the one where two documents get the same number. |
| 2026-08-04 | `ensureCustomerOemColumn` + `ensureCustomerGroupColumn` (`customers.ts`), `ensureCustomerStageColumns` (`customer-stage.ts`) | A THIRD variant the sweep produced: promise→boolean, but the setter was placed PAST the `catch`, so the boolean is set true even when the `ALTER` threw. All three feed columns in the customer PUT `UPDATE` (`oem_marking`, `group_org_code`, `customer_stage`, `salesperson_user_id`); one poisoned isolate 500s the whole save — the reported "OEM marking / phone / name won't save". Fixed by moving each setter INSIDE its try, after `.run()` (matching the correct `ensureCustomerCompanyColumn` next door). Behavioural cover: `tests/customer-stage-self-apply-retry.test.mjs` (the generic `self-apply-memo-is-boolean` test passes this variant — an `await` does precede the setter). |

**The rule.** Memoise a **boolean**, set only after the statement lands
(`src/api/lib/payment-columns.ts`), or use `memoizeSelfApply`, which clears the
memo on failure for you. Never cache the promise itself.

**Covered by** `tests/self-apply-memo-is-boolean.test.mjs`.

> Both halves of that test were proved by putting the bug back. The
> premature-flag half did **not** fire at first: it decided "is this a DDL
> guard?" over the window between the declaration and the setter — the exact
> window the bug empties — so it skipped the case it was written for. An earlier
> draft also flagged 16 ordinary local booleans (`inQuotes`, `hasMore`) as
> migration bugs; a test that cries wolf gets muted, and a muted test protects
> nothing. Scope narrowly, then watch it fail.

## C10 — One quantity, two ceilings — and only one branch is checked

**Shape.** A quantity can be drawn down through more than one route (invoice a PO directly, or
invoice the receipt raised against it). Each route grew its OWN ceiling, measured against its
OWN counter. Whichever route was written second is capped only by what IT can see, so the
quantity is spendable once per route. It is invisible from either side: each guard fires
correctly for the case its author had in mind, and the totals only disagree when you add them
up. Worse, these holes are usually **one-directional** — the route whose counter the other one
happens to read is caught, so the pair looks guarded under half the test orders you'd try.

| # | quantity | routes | state |
|---|---|---|---|
| 1 | PO line, invoiced | PI create off a PO / PI create off a GRN | ✅ fixed 2026-08-07 (BUG-2026-08-07-003 — 100 billed off the PO then 100 more off its GRN = 200 payable on a 100 PO. GRN→PO order was already caught, because the PO ceiling reads GRN-sourced lines through `COALESCE(pii.po_id, pi.purchaseOrderId)`) |
| 2 | PO line, invoiced | PI **re-line** (PUT items) | ✅ fixed 2026-08-07 — same hole with one more step: raise the invoice for 1, edit it to 100. Now shares the helper, with the edited PI excluded from its own already-invoiced total |
| 3 | GRN line, invoiced (`grn_items.invoiced_qty`) | PI create / PI re-line / PI delete / PI cancel / GRN un-post | ✅ one counter, incremented and restored through the shared `convert-chain.ts` helpers |
| 4 | PO line, received (`purchase_order_items.receivedQty`) | GRN post-on-create / GRN post-on-PUT | ✅ both go through `cascadePOStatusAfterGRNPost`; reversal through `restorePOReceivedQtyForGRN` |

**The rule.** One quantity gets ONE ceiling function, called by every route that spends it —
not one guard per route. When you add a second way to draw something down, the question is not
"does my branch check?" but "which counter does the OTHER branch read, and would it see mine?"
Two things make the shared helper safe to reuse: the document being written must be excluded
from its own consumption total (or an edit that LOWERS a quantity gets rejected), and requested
quantity must be aggregated per key before measuring (or two lines of one material each pass
against the same remaining).

**Covered by** `tests/purchasing-convert-flow.test.mjs` — the real handlers against a stateful
mock D1, asserting both the block AND that legitimate splits, PO-less receipts and reducing
edits still pass. The source pins in `tests/pi-multi-po.test.mjs` count the callers of the
shared helper, so a fourth route that grows its own copy fails the test.

---

## C11 — A `wip_items` add and its matching take, counted in different units

**Shape.** `wip_items.stock_qty` is a running balance that only ever moves by deltas — nothing
re-derives it, so every mismatched pair is permanent and cumulative. The cascade puts stock in
at one point and takes it out at another, and the two are written by different people at
different times against different mental models of what the row counts. When the add and the
take disagree — about the quantity, about how many times they fire, or about whether they fire
at all — the residue never comes back out, and the order it belonged to shipped months ago.

It is invisible per-order: one card leaves 1 or 2 units behind, and only the whole-ledger sum
shows it. It surfaces as a WIP board carrying stock nobody can find, or — when the take is the
side that runs twice — as **negative** rows, which is the loudest symptom and the worst one.

| # | the add | the take | state |
|---|---|---|---|
| 1 | every stage's `+wipQty` | only ever removed when a DOWNSTREAM card was scanned; the WIP→FG subtract took only UPHOLSTERY's own rows | ✅ fixed 2026-08-08 (`630b9e13`) — `settlePoTerminalWip` drains structurally, whatever the last stage is |
| 2 | one add per completion | the idempotency ticket was keyed `(org, jc, from, to)`, so a redone card's take was swallowed while the revert's refund had already run | ✅ fixed 2026-08-08 (`bdfe14ac`) — the ticket names an OCCURRENCE, not a transition |
| 3 | merged FAB_CUT `+wipQty` = the PIECES the card covers | the set-level consume took the literal `1`, believing the row counted SETS | ✅ fixed 2026-08-08 (BUG-2026-08-08-005) — the consume takes the upstream card's own `wipQty`, and the rollback refund the same |

**The rule.** Before changing either side, name the UNIT the row is in, and check the other side
agrees. `src/api/lib/wip-expected.ts` is the answer, and it is deliberately not a mirror of the
cascade's arithmetic: it is a physical model — *a stage's output sits on a shelf iff the stage
is finished, its downstream has not started, and the order has not left WIP; quantity carried =
the card's OWN `wipQty`*. Any consume that does not bring the stored balance to what that model
says is wrong, whichever side looks more natural. And every forward path needs its exact
rollback inverse written in the same commit: a refund that hands back less than the consume took
is how a row goes negative, which is the failure mode this class is being cleaned up to remove.

**Covered by** `tests/wip-quantity-drift.test.mjs` — the real cascade against an in-memory stub
of the three tables it writes, asserting balances (not source shape), including a
`reconcileWip` cross-check that the ledger and the derivation agree. The stub reads each
STATEMENT to decide what it enforces, so reintroducing a fixed instance fails the suite instead
of quietly passing.

**Still open:** none of the three fixes repairs the data they already produced. Prod carries
~2,100 net overstated units and 162 negative rows; `GET /api/inventory/wip/reconcile` lists
them, read-only. A one-off correction pass is owed.

---

## C12 — Narrowed by CUSTOMER, not by TENANT

**Shape.** A read carries a row-level rule — `customerScopeSql`, an RBAC check, a status
filter — and the reviewer, seeing a `WHERE` clause that is visibly *about who may see this*,
reads the query as scoped. It is not. Those rules narrow WITHIN one tenant; the tenant boundary
itself is `withOrgScope`, and it is a separate predicate. A query with one and not the other
looks more finished than a query with neither, which is exactly why it survives review.

**Why it keeps happening.** Three compounding reasons:

1. **There is one org on prod.** Every instance is latent, so nothing fails, no page looks
   wrong, and no bug report is ever filed. These are found only by reading.
2. **`customerScopeSql` is deliberately a choke point** (one middleware, all 29 endpoints) and
   `withOrgScope` deliberately is not (per-query, because each query knows its own table). So
   the one that scales is the one that does NOT draw the boundary.
3. **The fixes are one-line**, which makes "fix the instance in front of me" feel complete.

**The rule.** `withOrgScope` is not an alternative to the customer scope — the orgId binds
FIRST, the row rule follows, both apply. And when the endpoint is CACHED, the query's scope must
match the cache's key: a snapshot keyed per-org over a query computed org-wide is the same
defect wearing a different hat, and needs a `cacheKey` bump so pre-fix rows cannot still be
served.

| # | endpoint | state |
|---|---|---|
| 1 | `GET/PUT /api/notifications` | ✅ fixed 2026-08-08 (BUG-2026-08-08-003) — no scope of any kind, read side and write side |
| 2 | `GET /api/consignment-orders/stats` | ✅ fixed 2026-08-08 (`39fd7a99`) — customer-scoped, org-unscoped, cached per org |
| 3 | `GET /api/consignment-orders` + every by-id read on that router | ✅ fixed 2026-08-09 (BUG-2026-08-09-001) |
| 4 | `GET /api/consignment-notes` + `/stats` + `/linked-po-ids` + `/:id/print-extras` | ✅ fixed 2026-08-09 (BUG-2026-08-09-001) — `/stats` was #2's untouched twin |
| 5 | `GET/PUT/DELETE /api/consignments` (legacy surface, SAME tables) | ✅ fixed 2026-08-09 (BUG-2026-08-09-001) — found only by sweeping the module, not the two files named in the report |
| 6 | `GET /api/sales-orders/:id` | ⬜ open — the LIST is org-scoped, the by-id read next to it is not. Same shape as #3, different module; not in scope for the consignment pass. Sweep sales the way consignment was swept. |
| 7 | write-side `orgId` stamping | ⬜ open — `INSERT INTO consignment_orders` (and its siblings) do NOT stamp orgId; the column takes its SQL `DEFAULT 'hookka'` (see `lib/tenant.ts`, "§1 finish step"). Read scoping is therefore only half the boundary: a second tenant's writes would land labelled `hookka`. **Do this before onboarding a second org**, or the reads above will correctly hide rows from the tenant that created them. |

**Covered by** `tests/consignment-tenant-scope.test.mjs` — the real handlers against a
two-tenant book, asserting a caller in org A cannot reach org B through a list OR a by-id read,
that the customer scope still narrows on top, and that the CN `/stats` cacheKey moved. The mock
reads binds POSITIONALLY, so deleting an org predicate stops the filtering and the assertions
fail rather than passing over a query that no longer narrows.

**Finding the next one.** Grep is the wrong tool (it times out here, and a missing predicate has
no text to match). Enumerate instead: for a router, list every `FROM <tenant_table>` with the
handler it sits in, and require each ENTRY-POINT read to carry `orgId`. Downstream reads keyed
off an already-gated id are transitively safe and should say so in a comment, so the next
reader does not "fix" them again.

---

## C13 — The screen calls a field optional; the write path requires it

**Shape.** A form labels a field "optional" (or simply doesn't mark it required), the operator
leaves it blank, and a table two hops downstream has a NOT NULL or a FOREIGN KEY on the column
it feeds. The refusal therefore arrives from **Postgres**, at INSERT time, phrased as a
constraint name. Two separate defects fall out of one root: the user was told the field didn't
matter by the very screen that then failed, **and** the failure text is unusable — and because
`humanizeError` correctly classifies a constraint string as technical, what actually reaches the
toast is *"Something went wrong. Please try again."*, which is worse than the raw string,
because retrying fails identically forever.

**Why it keeps happening.** The requirement is not written down anywhere both sides can read.
The screen encodes one belief about what a mode/branch needs, the route encodes another, and
nothing forces them to agree — so they drift the moment either side is edited. `?? ""` makes it
land as a *constraint* error rather than a *null* error, which reads like a data problem instead
of a validation gap: **an empty string is not NULL**, so a nullable FK column still runs its
check against `""` and rejects it.

**The rule.** Derive the requirement from **what the branch WRITES**, put it in one pure module,
and have the screen and the route both call it. Refuse BEFORE composing any statement, so the
refusal can name the row the operator can see and say what to do. Never coerce a missing foreign
key to `""` — pass `null` if the column truly allows it, or refuse.

| # | surface | state |
|---|---|---|
| 1 | Spawn Service Order — CODE "optional", REPRODUCE's `production_orders.product_id` FK | ✅ fixed 2026-08-10 — rules moved to `src/lib/service-order-modes.ts`, called by dialog AND route |
| 2 | `PUT /api/service-orders/:id/mode` → REPRODUCE — the same FK, reached by "decide later" | ✅ fixed 2026-08-10 in the same pass; fixing only #1 would have left this door open |
| 3 | STOCK_SWAP "FG Batch" pickers fed from `/api/inventory` (which returns **products**, not `fg_batches`) — the id sent as `resolutionFgBatchId` was always a `prod-*` id, so the mode could never succeed | ✅ fixed 2026-08-10 — the route derives the batch FIFO from the product and tolerates a product-id hint; the spawn dialog's column is gone, the mode-change dropdown relabelled (it also printed a hardcoded "(0 on hand)") |
| 4 | `CreateServiceOrderModal` in `src/pages/service-orders/index.tsx` — 900 lines that POST **without** `caseId`, which the route has required since 0074 | ⬜ open, but **unreachable**: `setCreateOpen(true)` is never called and nothing imports it. Delete it or wire it to the shared module; do not let it be re-enabled as-is |
| 5 | the rest of the app | ⬜ unswept. The shape to look for is a form control whose label says *optional* feeding a column with a FK/NOT NULL, or a route binding `x ?? ""` into an id column |

**Covered by** `tests/service-order-spawn-product.test.mjs` — the real handlers against an
in-memory book whose `production_orders` insert **re-implements the FK** (an unknown id,
including `""`, throws exactly what prod threw) and whose `batch()` is atomic like
`SupabaseAdapter.batch`. So a regression that reintroduces `?? ""` fails the test the same way
it failed the operator, and every refusal is asserted to pass `looksTechnical === false`.

**Finding the next one.** Start from the SCHEMA, not the screen: list the FK / NOT NULL columns
a route writes, then find the control that feeds each one and read its label. A field the user
can leave blank must map to a column that accepts blank — or the screen must say so.

---

## C14 — A child array scanned once per parent row

**Shape.** A LIST handler fetches its rows' children in ONE batched query, then
hands the **whole** child array to a per-row mapper whose first act is
`children.filter(c => c.parentFk === row.id)`. That is a full scan of the child
array for every parent — O(N×M) — and it reads as correct, because it *is*
correct. Only the cost is wrong, and nothing about the code says so.

**Why it keeps happening.** Three reinforcing reasons:

1. **The batched fetch looks like the fix.** Most of these sites were *already*
   improved once, by narrowing `SELECT * FROM child` to `WHERE fk IN (...)`. That
   removes the wire cost and leaves the join cost, and the commit reads as done.
2. **It never fails, it only gets slower** — so there is no bug report, no stack
   trace, and no date on which it started. It is found by reading or by
   measuring, never by an incident, until it crosses the cliff.
3. **The failure is a CLIFF, not a slope.** Cost is quadratic while the cache
   window is constant, so the endpoint is fine, fine, fine, then unusable. The
   dashboard broke exactly this way when sales orders grew 720 → 1,334 in two
   months.

**The rule.** Bucket the child array into a `Map<parentId, child[]>` **once** at
the handler, and hand each mapper its own bucket. Keep the mapper's internal
`.filter()` — as a passthrough it makes the change byte-identical by
construction, and because `.filter()` copies before any following `.sort()`, the
shared bucket can never be reordered under another row.

Use the *other* shape — an optional pre-grouped `Map` parameter on the mapper
(`groupJobCardsByPoId` / `rowToMinimalPO`) — only when the mapper also has
single-record callers that must keep the legacy filter. That variant DOES need
an explicit `.slice()` before sorting, because it drops the filter.

**Instances**

| # | site | fixed | scale when measured |
|---|---|---|---|
| 1 | production orders, NON-minimal path (`rowsToPOsBatch`) | ✅ 2026-05-21 | 530 PO × 2,200 JC ≈ 1.16 M |
| 2 | sales orders full list (`itemsBySO`) | ✅ 2026-06-04 | — |
| 3 | `customers.ts` hubs · `suppliers.ts` materials · `warehouse.ts` rack items · `consignment-orders.ts` items · `delivery-orders.ts` items | ✅ (caller-side buckets) | all small |
| 4 | production orders, **MINIMAL** path (`rowToMinimalPO`) | ✅ 2026-08-13 (#275) | **957 PO × 36,796 JC ≈ 35 M — 6,473 ms of a 9,587 ms `/planning` cold call** |
| 5 | `qc-inspections.ts` defects + items | ✅ 2026-08-13 | 500 × 2,151 = 1,075,500 — 20.8 ms |
| 6 | `products.ts` boms + dept_working_times | ✅ 2026-08-13 | 365 × 1,697 = 619,405 — 18.2 ms |
| 7 | `purchase-orders.ts` items | ✅ 2026-08-13 | 165 × 369 = 60,885 — 1.3 ms |
| 8 | `grn.ts` items | ✅ 2026-08-13 | 37 × 45 = 1,665 — 0.1 ms |
| 9 | `accounting.ts:190` + `cash-flow.ts:185` journal lines | ⬜ **open, deliberate** | 2 entries × 50 lines = 100 |
| 10 | `qc-templates.ts:91` · `qc-pending.ts:388` · `service-cases.ts:494,506` · `service-orders.ts:311,325` · `rd-projects.ts:166` · `consignment-note-shared.ts:132` | ⬜ measured-and-cheap | ≤ 7,781 cmp each, 2026-08-13 |

Row 4 is why this class exists: rows 1 and 2 fixed the same shape twice and
neither author looked for row 4, which was on the hottest path in the app.

**Row 9 is the one to watch.** Both fetch the ENTIRE `journal_lines` table with
no scoping and put no `LIMIT` on the entries — the exact pair of defects #275
fixed — and are trivial only because the GL is unused (2 entries). Fix it when
the GL is adopted, and fix it by **reusing the entries query's own `WHERE`** as a
sub-select: that query carries a `LEFT JOIN document_lifecycle`, and
hand-writing a second predicate that can drift from the first is the specific
trap #275 documented (a child fetch scoped to a different parent set than the
parent fetch silently drops rows).

**Row 10 is closed, not unexamined.** Every one was measured on prod on
2026-08-13 and costs under 7,781 comparisons over a structurally small parent
set. If a grep brings you back to one of those lines, that is the answer — do
not re-audit them.

**Not instances** (checked 2026-08-13, and each says so in place): `invoices.ts`
— the LIST passes `[]`, only the single-invoice read passes real arrays;
`production-orders/_helpers.ts:422,923` — the documented single-PO path, every
batched caller goes through `rowsToPOsBatch`; `wip-expected.ts:103`,
`assistant-tools.ts:1696`, `worker.ts:2762`, `_helpers.ts:3858` — each is
already handed a per-parent bucket, a one-document set, or a `LIMIT 100`.

**Enforced by** `tests/list-endpoint-child-grouping.test.mjs` — part 1 pins the
equivalence every fix in this class rests on (`bucket[id].filter(pred)` is
element-for-element the same objects, in the same order, as
`all.filter(pred)`) against an adversarial fixture; part 2 is a per-site source
guard that fails if a handler goes back to passing the whole array. All four
2026-08-13 guards were proved by reintroducing the bug and watching them go red.
`tests/production-orders-jobcard-grouping.test.mjs` covers row 4's own shape.

**Finding the next one.** Grep `\.(filter|find)\(...=== \w+\.\w*[Ii]d\)` under
`src/api` — but a match is not a bug. Establish, in this order: (a) is it inside
a per-row `.map()`/loop, or a single-record path? (b) how many parents and
children does the real prod payload have? (c) is the parent set **bounded** (a
`LIMIT`, a work queue that drains) or unbounded? An unbounded list is worth
fixing at any size; a bounded one is worth fixing only for what it costs today.

---

## C15 — A request that DIED, rendered as an answer

**Shape.** A read fails, the failure is not distinguishable from success-with-
nothing, and the screen states the empty case as fact. Three surfaces, one
shape:

| surface | the false sentence |
|---|---|
| a report over a date range | *"No data available"* |
| a record detail page | *"Order not found"* / *"Invoice not found"* |
| a list page | *"No draft orders."* |

Each is a **statement about the business**, and each has a recovery an operator
will actually perform — re-key the order, re-raise the invoice, tell the
customer nothing shipped.

**Why it keeps happening.** The failure is *silent by construction*. Before
this fix `useCachedJson` caught the 30 s `AbortError` and `return`ed with no
error set, while `.finally` cleared `loading` — so a dead request produced
`data = null, loading = false, error = null`, which is the exact state a
successful empty response produces. There is no stack trace, no toast and no
red anything; the page looks like it worked. And `cachedFetchJson` (the
non-hook variant) still returns `null` for a timeout, a 500 and a `_stub` body
alike, so `json?.data || []` writes emptiness into state.

**The rule.** *Only an observed HTTP 404 licenses the words "not found", and
only a 2xx body licenses "no data".* Everything else — abort, network, 5xx, a
`_stub` envelope — leaves the answer UNKNOWN, and the screen must say it could
not load, why, and offer a retry. Never launder a real absence into a network
message either: a genuine 404 must still read as absence.

Mechanically: `classifyFetchFailure` (`src/lib/cached-fetch.ts`) is the single
decision, `isUnknownOutcome(failure)` is the single guard, and
`useCachedJson().failure` / `cachedFetchJsonResult().kind` are the only two ways
to obtain it. `cachedFetchJson` cannot express the distinction — a page in this
class must not use it.

**Instances**

| # | surface | state |
|---|---|---|
| 1 | **reports** (5 tabs) — *"No data available"* over `/api/production-orders` killed at 30,012 ms | ✅ 2026-08-13 (BUG-2026-08-13-005) — `cachedFetchJsonResult` + `<ReportError>` |
| 2 | **detail pages / edit forms / one embedded panel / the public QR page** — 11 printed a false absence, 4 hung on `Loading…`, 1 asserted an empty child set | ✅ 2026-08-13 (BUG-2026-08-13-016) — `useCachedJson().failure` + `isUnknownOutcome` + `<RecordLoadError>`; 19 files changed, 6 more repaired by the primitive alone |
| 3 | **list pages** — ~25 grids whose empty caption (*"No draft orders."*, `DataGrid`'s default *"No data found."*) renders over a failed fetch | ⬜ **open, enumerated.** Each page owns its own caption and its own fetch shape, so this is a separate PR with its own before/after — not a blind sweep. Start from the files that import `useCachedJson` and pass an `emptyMessage`, and give `DataGrid` a `loadFailure` prop rather than editing 25 captions by hand |
| 4 | **`cachedFetchJson` callers outside this class** | ⬜ unswept. The function returns `null` on every failure; any caller that renders that null as a factual empty state is row 1/2/3 wearing a different hat. `products/bom.tsx` and `products/documents.tsx` were two, found by this pass |

Rows 3 and 4 are why this section exists rather than a note in the bug entry.
Row 2's pass fixed **19 files across 11 modules**; every one would have been
missed by an author who fixed only `sales/detail.tsx`, which is the file the
audit named.

**Cancellation is not a failure.** An unmount or a URL change aborts in-flight
reads on purpose, and making that noisy is a new bug. The separation is
structural: `releaseInflight` aborts only when the refcount hits 0, i.e. after
every subscriber has set its own `cancelled` flag and returned — so an
`AbortError` that reaches a *non-cancelled* consumer is the 30 s timeout.

**Enforced by** `tests/record-load-failure-class.test.mjs` — it pins the
primitive (the swallowed-abort line must stay gone; the `cancelled` guard must
stay FIRST), enumerates every consumer with the guard it uses, and **fails when
a new file reads through the cache layer and prints "…not found" without being
in the map**. Behaviour is proved separately in
`tests/cached-fetch-result.test.mjs`, which runs the real fetch wrapper for all
three outcomes. Every guard was proved by reintroducing the bug and watching it
go red — including one that did NOT fire at first: the consumer check only
looked for the identifier `isUnknownOutcome` and passed happily while the guard
had been short-circuited out of the branch. It now requires the CALL to gate
the `<RecordLoadError>` render.

---

## What tests cannot catch — and what covers it

None of C1–C4's money leaks were introduced by a code change on the day they started leaking:

- the height surcharge broke when the **scan flow became the main entry route**
- the price list drifted when someone **edited a price in Settings**
- 202 invoice lines under-bill because of **history**, not present-day code

Tests protect the code. Only a data check protects the data — `src/api/lib/pricing-integrity.ts`
runs the money invariants on every daily report:

| invariant | catches |
|---|---|
| `unit <> base + divan + leg + special` | C1, a dropped component |
| a priced height stored at 0 | C1, the scan-path leak |
| an issued invoice line under its SO line | history, revisions, partial fixes |

Had it existed in May, the RM 12,455 would have surfaced on day one instead of after ten weeks
and 105 mispriced lines.

---

## When you fix something here

1. Find its class above. If there isn't one, add it.
2. Fix **every ⬜ row**, or write why not.
3. Extend the class test so the next instance cannot be added silently.
4. Ask whether a data invariant would have caught it sooner — if yes, add it to
   `pricing-integrity.ts`.
5. Update the row: date, cost, and how it was verified.

*Sources: `BUG-HISTORY.md` (chronological detail), `WORK-TRACKER.md` (2026-07-22/23 audit),
`PLAYBOOKS.md` P5.*
