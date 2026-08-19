# RM Consumption Gate + Per-Department Consumption

Owner directive (2026-07-29): 「你可以完善 … 因为我还没有完善我的 BOM，等我说 ok 就正式扣料」
and 「扣料应该跟着 BOM 的 process 走啊」.

## Background — the current reality

- Raw-material consumption is **always-on, no switch**. It fires at
  `production_orders.ts` (FAB_CUT completion) and `fg-completion.ts` (FG
  completion). A manual batch backfill exists in `import-completion.ts`.
- On a normal PO, **the whole BOM tree's materials (fabric + foam + wood) are
  consumed at once at FAB_CUT** — it does NOT consume each material at its own
  department's step. The per-node `deptCode` IS recorded on each material line
  (`MaterialLine.ownerDeptCodes`) but is used ONLY by the Repair-Scope filter,
  not by normal-production consumption timing.
- The owner's BOMs are still being completed, so the always-on consume is
  deducting against incomplete BOMs. He wants **no official consumption until he
  says ok**, and eventually **consumption that follows the BOM's process/dept**.

## Phase 1 — the gate (THIS PR: `feat/rm-consumption-gate`)

Goal: stop the premature consumption now; give a PREVIEW so BOMs can be
validated before go-live. Behaviour-flag, fail-CLOSED.

- **`kv_config['rm_consumption_mode']` ∈ {"LIVE","PREVIEW"}**, default (missing /
  unreadable) = **PREVIEW**. `getRmConsumptionMode()` in `po-cost-cascade.ts`.
- **Gate inside `consumeRawMaterialsForPO`** (covers BOTH live triggers with one
  change): after loading the PO, if mode ≠ LIVE → `recordConsumePreview()` and
  return `{ preview: true, materialCostSen: 0, … }` with **no** rm_batches /
  raw_materials / cost_ledger write. An idempotency `RM_ISSUE`-exists check
  still short-circuits already-consumed POs first.
- **`recordConsumePreview()`** computes each BOM line's would-be qty
  (`qtyPerUnit × po.quantity × (1+waste)`), resolves the raw material, and
  (re)writes `rm_consume_preview` rows. `resolved = 0` rows are **BOM gaps** —
  exactly what the owner needs while completing BOMs. No stock writes.
- **`rm_consume_preview`** table — runtime self-applied (`CREATE TABLE IF NOT
  EXISTS`), snake_case columns.
- **`opts.forceLive`** escape hatch on `consumeRawMaterialsForPO` for a
  deliberate go-live backfill (not wired to any auto-trigger).
- FG material cost during PREVIEW = 0 (nothing officially consumed yet); it
  fills in once LIVE (or via the go-live backfill).

**Effect on merge:** real RM consumption STOPS on prod (fail-closed) until the
owner flips the flag. Loudly flagged; owner verifies/merges (inventory).

### Go-live (when the owner says ok)
1. `kv_config['rm_consumption_mode'] = "LIVE"` (via kv-config PUT or DB).
2. Optionally run the existing `import-completion` backfill to consume the POs
   that completed during the PREVIEW window.

### Deferred out of Phase 1
- A read endpoint / Settings toggle to VIEW previews + flip the mode in-app
  (Phase 1.1). For now previews are queried directly from the DB on request.

## Phase 2 — per-department consumption (SEPARATE PR)

Make consumption follow the BOM's process/dept (owner's 「跟着 process 走」):
consume each material when ITS department's step completes, not all at FAB_CUT.
The per-dept material mapping already exists (`MaterialLine.ownerDeptCodes`,
used today by Repair-Scope) — Phase 2 wires it into normal-production timing.
Touches consume timing + FG/WIP costing + idempotency (per-dept, not per-PO).
High-risk; own PR; owner verifies. Ties into the **Foam Cutting** department
(so foam RM deducts at the cutting step).
