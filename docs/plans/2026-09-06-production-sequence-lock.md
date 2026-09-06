# Production sequence lock — plan + findings

> **Last verified: 2026-09-06** against `src/api/routes/production-orders.ts`,
> `src/api/routes/production-orders/_helpers.ts`, `src/api/lib/bom-wip-breakdown.ts`,
> `src/api/lib/wip-expected.ts`, `src/api/lib/compliance-report.ts`, and a live
> read of production (3,314 production orders / 45,511 job cards).

Owner 2026-09-06:

> 「正常来说，我们会根据 BOM 的工序，每一次第一道工序做完了，才会进入第二道工序…
> 现在遇到的问题是，我入库和出库的库存数量很不准。原因是因为他们跳了流程」

Goal: a job card cannot be marked complete while the step it depends on is still
open — so WIP stops being consumed before it was produced.

---

## 1. Why the previous attempt was removed, and why it must not be restored

A soft warning existed and was deleted in `760d08b3` (2026-06-08) for two
reasons — one policy, one DATA:

> the BOM-template placeholder data left the `prerequisiteMet` flag unreliable —
> **false** 'Earlier dept hasn't completed' warnings on already-completed
> upstream depts

**`job_cards.prerequisiteMet` is written once at card creation and never rolled
forward.** `production-builder.ts` stamps 1 on the first dept of a chain and 0
on everything downstream; nothing sets it to 1 when an upstream dept completes.

**Measured on production, 370 active POs / 4,967 job cards:**

| | |
| --- | --- |
| `prerequisiteMet = 1` | 287 |
| `prerequisiteMet = 0` | 4,680 |
| …of those, cards with **nothing upstream at all** | **1,673** |
| …of those, cards whose upstream **is already done** | **938** |

At least **2,611 of the 4,680 zeros are demonstrably false**. Re-enabling the old
check as a hard block would stop every department except the first. **Do not use
this column.** Leave it; do not read it.

---

## 2. The rule — derived from the BOM, nothing hardcoded

Owner: 「记得你的这整个流程不可以写死的，应该是根据我的 BOM 的变化的」

He is right, and no new table is needed. The graph is **already in the BOM tree**
and already stamped onto every job card:

- `bom-wip-breakdown.ts` → `collectProcesses` passes `branchKey` down the tree.
  The **first descent adopts the child node's raw `wipCode` as the branch id**;
  deeper nodes inherit it. **Top-level processes (UPHOLSTERY / PACKING) keep
  `branchKey = ""`.**
- So an **empty `branchKey` marks a convergence step** — it belongs to the whole
  product, not to one branch. That is the BOM saying "this one waits for
  everybody".

### The gate

A job card may be completed when:

1. every card with a **lower `sequence`** in the **same `(wipKey, branchKey)`**
   is done; **and**
2. if its `branchKey` is **empty** (a convergence step), the **highest-sequence
   card of every other branch** in the same `wipKey` is also done.

`DONE` = `COMPLETED` or `TRANSFERRED` (the repo's existing definition, verified
in `compliance-report.ts`). Cards at the **same** sequence never block each other
— they are parallel by construction, which matters because 142 branches carry two
different departments on one sequence number.

**It reads `job_cards` only.** No constant, no settings table, no maintenance:
the sequence and branch were burned in at build time from the BOM, so changing a
BOM changes the lock automatically for every card built afterwards.

> `PRODUCTION_ORDER_BY_WIP_TYPE` in `bom-wip-breakdown.ts` IS a hardcoded list of
> six chains — but it is used at BUILD time to order the processes. The gate does
> not read it, and must not.

### Verified against the owner's own description

He described the physics without seeing any code:

> 「例如 Upholstery 要完成的话，它需要 Foam Bonding、Fabric Sewing，还有包括
> Webbing 那一边都做好」

Simulated over the 370 active POs, the rule produces exactly that:

| blocked | by | count |
| --- | --- | --- |
| FRAMING | WOOD_CUT | 364 |
| WEBBING | WOOD_CUT | 364 |
| **UPHOLSTERY** | **FAB_SEW** | **256** |
| FOAM | FAB_SEW | 230 |
| **UPHOLSTERY** | **FOAM** | **202** |
| FOAM | WOOD_CUT | 141 |
| **UPHOLSTERY** | **WEBBING** | **138** |
| WEBBING | FRAMING | 134 |
| PACKING | FOAM / FAB_SEW | 239 |

**2,189 of 3,706 open cards would be blocked; 0 are permanently stuck** (no card
is held by a CANCELLED or BLOCKED upstream).

### The rule that was tried and rejected

Blocking on "everything earlier in the same `wipKey`" (ignoring branches) adds
635 more blocks, and **they are wrong**: `WOOD_CUT ← FAB_SEW` (322),
`FRAMING ← FAB_SEW` (73), `WEBBING ← FAB_SEW` (20). Wood does not wait for
fabric. This is what the flat `DEPT_ORDER` implies, and it is why the branch
dimension is not optional.

---

## 3. Where the gate goes — two choke points

Every completion in the product funnels through one of two places:

| Surface | Path |
| --- | --- |
| Desktop schedule grid (tick / batch date) | `POST /bulk-patch` → loopback `PATCH /:id` → **`applyPoUpdate`** |
| Shop floor scanning | `POST /:id/scan-complete`, `/scan-complete-dept`, `/scan-complete-shared` |

One shared `assertSequenceUnlocked()` called from both — **not four copies**.
`import-completion/*` is deliberately NOT gated: those are the tools used to
repair history, and gating them removes the way out.

### It must cover STARTING, not only completing

`_helpers.ts` consumes upstream WIP on `becomingActive` — which is
`IN_PROGRESS` **or** `COMPLETED`. A gate on completion alone still lets someone
set a card IN_PROGRESS out of order and drain the upstream row. **Gate both
transitions.**

---

## 4. Shadow-unlock (the launch mode)

Owner: 「直接上线，只是在影子模式下它还是会锁起来，不过锁起来的时候他们可以直接
解锁」— the lock is real and visible from day one; anyone may unlock it
themselves. Later the same lock tightens to supervisor-only. Nobody is stopped,
and everybody learns the rule before it bites.

`canSelfUnlock` is decided **by the backend**, never inferred by the client —
otherwise changing the policy means changing three screens, and a worker can
bypass it by calling the API directly.

### Desktop

- A blocked completion cell renders **pale amber with a lock**, before anyone
  clicks; hover says `要先完成 WOOD CUTTING（现在：等待中）`.
- Clicking to tick opens a dialog with **three** actions (owner 2026-09-06):

  | action | effect |
  | --- | --- |
  | **取消** | nothing |
  | **解锁并完成** | audit row + complete this card only |
  | **把上一道也一起完成** | complete the blocking upstream card(s) **and** this one, in order |

  The third is the honest one: most skips happen because the upstream really was
  finished and nobody recorded it. It fixes the cause instead of stepping over it.
  It completes the upstream **first**, so the WIP produce/consume happens in the
  right order and no negative row is created.

- Batch date-stamping must **not** be all-or-nothing: *"17 of 20 can be stamped,
  3 are locked"* with a choice of stamping 17, or 17 + unlocking the 3.

### Mobile (shop floor)

A worker is standing, one-handed, holding something. Large type, few words:
the blocked department, the **list** of what must finish first (a convergence
step shows three lines), and one **仍要解锁完成** button with a second
confirmation to defend against a mis-tap. **No second scan** — the unlock
re-posts the same scan.

After tightening, that button greys out for workers and reads 「要主管解锁」.

### Unlock round trip

```
complete → 409 { blockedBy:[{dept,status}], canSelfUnlock:true }
        → confirm
        → same endpoint + { unlock:{ reason, alsoCompleteUpstream? } }
        → audit row → complete
```

`scan_override_audit` already exists (`workerId, jobCardId, overrideCode,
reason, created_at`) — reuse it, do not add a table.

---

## 5. Launch-day impact — measured

**No completion dates need backfilling.**

| | |
| --- | --- |
| Cards already completed out of order | **46**, across **20** POs |
| Of the missing upstream cards, how many are themselves blocked | **1** (`SO-2608-293-02` FOAM waits on FRAMING — a normal chain, not a deadlock) |

The gate only refuses a **new** completion. The 46 are already done and are not
re-checked; their outstanding upstream cards complete normally. Nothing jams.

> The compliance report counts 29, not 46, because `checkProcessSkips` groups by
> `branchKey` only and therefore cannot see a convergence violation such as
> `UPHOLSTERY` done while `FOAM` is open. Worth aligning it with the gate so the
> report and the lock never disagree.

### No conflicting rule

The scan path already refuses on `po.status === "ON_HOLD"`, `CANCELLED`, and
`jc.status === "BLOCKED"`. Those are administrative stops, orthogonal to order,
and return the same 409 shape. The sequence gate is an additional, independent
check — no contradiction.

---

## 6. WIP in/out — what was actually found

Owner: 「查看一下我的 WIP 的入库出库问题，它应该是有 bug 的，因为数据是不对的」

**Reconcile, live:** 6,251 codes checked, **1,659 disagree**, **513 rows
negative**, net −1,921 units. The damage is concentrated: 1,202 rows are off by
1–2, but 91 rows are off by 11+ and one by 450.

```
8" Divan- 5FT          stored -446   expected 4
5531 -Back Cushion 28  stored -195   expected 0
SQUARE PILLOW BO315-3  stored  198   expected 5
```

### a) Negative WIP is deliberate, and it IS the footprint of skipping

`_helpers.ts` states it: `no MAX(0) clamp` … "go negative **as a visibility
signal**". Consumption fires when a step starts; if the upstream never produced,
the row goes negative. `inventory-wip.ts` even carries a fix written for
*"the user's **skip-to-UPH** workflow"*. **Fixing the sequence stops new
negatives being created.** It does not repair the existing ones.

### b) Three real defects found in the write path

1. **`IN_PROGRESS → WAITING` never refunds.** The consume fires on
   `becomingActive`; the refund branch is `wasDone && !isDone` — i.e. only from
   COMPLETED/TRANSFERRED. Starting a card and putting it back drains the upstream
   permanently.
2. **`PAUSED → IN_PROGRESS` consumes again.** The double-consume guard tests
   `prevStatus` against IN_PROGRESS / COMPLETED / TRANSFERRED — **`PAUSED` is not
   in the list**, so every pause/resume cycle takes another bite.
3. **All 8 stock updates match on `code` alone** —
   `UPDATE wip_items SET stockQty = … WHERE code = ?` — while the upsert conflict
   target is `(org_id, code)` and four organisations exist (HOOKKA / OHANA /
   HOUZS / HKMFG). One org's production can move another org's stock.

**(1) and (2) are NOT the current cause.** Measured: of 45,511 job cards, **2 are
IN_PROGRESS and 0 are PAUSED** — the floor goes WAITING → COMPLETED directly. Both
are latent; fix them, but do not expect the −446 to move.

### c) A hypothesis that was tested and DISPROVEN

The UPH consume uses `consumeQty = jcRow.wipQty` against **every** branch
terminal, rather than each terminal's own `wipQty` — the exact bug class the
sibling non-UPH path was already fixed for ("a hardcoded 1 left `wipQty − 1`
behind"). It looked certain.

**Measured across 12,899 branch terminals on production: 0 quantity
mismatches.** The defect is real in the code and produces no damage today.
Recorded so nobody re-derives it and calls it the answer.

### d) Root cause of the large negatives — ESTABLISHED, and fixed

It was `settlePoTerminalWip`, and the defect is not in what it subtracts but in
**how often**. It drains the terminal rows and `poOrphanedUpstream` when the last
stage finishes, guarded only by `isWipTerminalDone(...)` — which stays true
forever once the last stage is done. It is called at the end of every non-UPH
completion, so **every later completion on the same order settled it again**.

The skip workflow is precisely what creates those later completions: finish
UPHOLSTERY first, then tick the FRAMING nobody recorded, and that second tick
drains the whole order a second time. So the two halves of this document are one
problem — the lock stops the skip, this stops the skip's damage.

**Measured on production 2026-09-06: 779 orders have an upstream card completing
AFTER the terminal — 2,109 extra settles.** Worst labels `1013-(Q) -HB 20"`
(131), `5531-2A(RHF)` (85), `5531-2A(LHF)` (74). That is the shape of −446 on a
shared label: drained once per catch-up, forever.

Fixed by reading the cards as they stood BEFORE the transition and settling only
when THIS change is what made the terminal done — the technique
`unsettlePoTerminalWip` already used for the inverse, so the two are now exact
mirrors. **The drain amounts are untouched**; only when it runs moved. Shipped
separately as `fix/wip-settle-once` with `tests/wip-settle-once.test.mjs`.

**The 513 historical negative rows are still NOT repaired.** The fix stops new
ones. Repairing the old ones is an owner decision, and it comes after the fix is
live — otherwise the repair races the thing that caused it.

---

## 7. Reusing earlier work

- `760d08b3` — the removal commit. Its **shape** is reusable (409 + confirm +
  audit row + `scan_override_audit` insert); its **input** is not: it read
  `prerequisiteMet`. Take the plumbing, replace the predicate.
- `compliance-report.ts` `checkProcessSkips` — the closest existing model, and
  branch-correct. It needs the convergence half added, after which the report and
  the gate should share one function.

---

## 8. Order of work

| # | | |
| --- | --- | --- |
| 1 | Shared `assertSequenceUnlocked()` + gate both choke points, both transitions | — |
| 2 | Shadow-unlock UI (desktop 3 actions, mobile) | — |
| 3 | Weekly unlock report — who unlocked, which step, real skip vs data | ongoing |
| 4 | Tighten to supervisor-only | after the report is quiet |
| 5 | WIP root cause (§6d) — **found and fixed**; repairing the 513 historical rows is still the owner's call | separate |

Defects 6(b)1–3 are small and independent — ship them whenever, they are not
blockers for the lock.
