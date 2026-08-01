# Recurring bug classes — the index that makes P5 executable

`PLAYBOOKS.md` **P5** says: *"Fix all instances of the same class, not just the flagged one."*

That instruction is unusable without a list of the instances. `BUG-HISTORY.md` is ordered by
**date**, so "the same class" only exists in whoever's memory. The result, measured:

| class | times fixed | each fix repaired |
|---|---|---|
| server trusts a client-supplied price | 3 | only the one column that had been noticed |
| write path skips the dept-sheet cache wipe | 3 | only the one file someone was looking at |
| fallback to the customer's DEFAULT hub | 3 | only the one document that printed wrong |

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
