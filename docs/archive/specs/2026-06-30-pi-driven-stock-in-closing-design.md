> **ARCHIVED / SUPERSEDED — stopped being true when Stage 1 landed (on/after 2026-06-30).** The design's load-bearing rule is live in code: `src/api/routes/accounting.ts` carries the `grn_item_id IS NULL` PI-only receipt filter, so PI-only lines enter the FIFO closing exactly as specced and converted PIs are skipped. Kept for history only; do not treat as current — read the code, not this doc, before changing the material window.

# PI-Driven Stock-In for P&L Closing — Design

**Date:** 2026-06-30
**Status:** Approved (owner, 2026-06-30)

## Context
Follows the just-shipped "PURCHASE = PI" change (commit `c0484c76`), which made the
P&L RAW MATERIALS **purchase** line come from the purchase ledger (PI) instead of GRN
receipts. That left **closing stock** still GRN-only, so in any month where PI ≠ GRN
(e.g. June: PI ≈ 130k, GRN ≈ 2.2k) the bought-but-not-GRN'd materials fall into
`consumed` and COGS balloons. The owner's common workflow is **PI-only** (no separate
GRN), so closing must recognise PI receipts too.

## Goal
Make the P&L RAW MATERIALS **closing stock** (and the FIFO valuation behind it)
recognise materials brought in by **PI-only** receipts, while keeping GRN as a backup
source — with **no double-counting** and **no data mutation** (read-only).

## Owner rules (binding)
1. PURCHASE = all PI (already shipped). Unchanged.
2. Stock-in is **read-only**: NO `invoiced_qty` deduction, NO writes, NO new tracking
   columns. Use the existing `grn_item_id` flag on PI lines only as a *read* signal.
   (Owner: "别用扣，我怕留痕迹.")
3. When both a GRN and a PI exist for the same goods, the PI is created via the
   **"convert to PI"** flow from the GRN → the PI line carries `grn_item_id`. Confirmed
   by owner (case A); the convert flow sets it (purchase-invoices.ts `body.grnId` path).
4. GRN stays a valid **backup** stock-in source — GRN-only receipts can happen and must
   appear in stock.

## The rule
> **Stock-in receipts = (all GRN items) + (PI STOCKED lines where `grn_item_id` IS NULL)**
> **Purchase (P&L) = all PI STOCKED lines** (unchanged)

| Case | grn_item_id | Stock-in counts | Double-count? |
|---|---|---|---|
| Both (PI converted from GRN) | set | GRN (the PI line is skipped) | No |
| GRN-only | — (no PI) | GRN | No |
| PI-only | null | the PI line | No |

Dedup is purely the presence/absence of `grn_item_id` — read-only, no arithmetic.

## Consequence: GRNI (received-not-invoiced) — accepted
A GRN-only receipt enters stock (closing) but is not yet a purchase (no PI). In its
receipt month `consumed = opening + purchase − closing` dips low / negative for that
material, self-correcting when the PI is later created. Affects only not-yet-invoiced
GRN goods (the backup case); PI-only and convert flows are unaffected. Documented.

## Architecture — the three material aggregations (accounting.ts)
- **A. GL closing-stock JE** (`computeMonthlyClosingStockJE` + its `cost_ledger`-based
  group aggregator, ~4480): posts opening/closing stock to the GL (balance sheet).
  Reads `cost_ledger` RM_RECEIPT (GRN) / RM_ISSUE.
- **B. P&L FIFO engine** (`loadMaterialCostData` ~5050 + `materialWindow` ~5424): drives
  the P&L statement + 12-month matrix RAW MATERIALS. Receipts currently = GRN
  (`goods_received_notes`). Purchase already = PI (`piPurchaseCum`).
- **C. /cost-structure** (~5789): cost-vs-sales analysis. **Out of scope** (note the
  divergence; align later if the owner wants).

For the P&L closing (B) and the balance-sheet stock (A) to tie, BOTH must use the same
stock-in rule.

## Implementation — two stages (ship + prod-verify each)

### Stage 1 — P&L closing (engine B)
- In `loadMaterialCostData`, add **PI-only** STOCKED lines (`grn_item_id IS NULL`, status
  NOT IN DRAFT/CANCELLED, post-cutover, materialCode resolvable) as FIFO **receipt
  events**: `date` = PI invoice date, `qty` = line qty, `unitCostSen` =
  `round(lineTotalSen / qty)`. Pushed into `eventsByRm` next to the existing GRN receipts.
- GRN receipt loop (5a) unchanged → "both" and "GRN-only" handled by GRN; PI-only handled
  by the new events. No dedup math — the new query filters `grn_item_id IS NULL`.
- `materialWindow` already derives closing from the checkpoints and `consumed = opening +
  purchase − closing`; purchase stays `piPurchaseCum` (all PI). Net: closing now includes
  PI-only receipts → June stops ballooning; consumed = real issues for PI-only + convert.

### Stage 2 — GL / balance-sheet tie (engine A)
- Update the `cost_ledger`-based group aggregator (A) so its closing includes the same
  PI-only receipts → the GL / balance-sheet stock equals the P&L closing. Read-only,
  mirroring Stage 1 (read PI-only STOCKED lines; add to the opening/closing accumulation).
  Exact wiring decided in the plan.

## Unchanged
- Opening seed (`material_opening_stock` + `inventory_opening`). Untouched.
- WIP / FG (`cost_ledger` RM_ISSUE / `fg_batches`). Untouched.
- PURCHASE = PI (shipped).
- **No writes** to `invoiced_qty` / `grn_item_id` / any table. Read-only throughout.

## Testing
- Stage 1: a PI-only receipt lands in closing; a converted PI (`grn_item_id` set) does NOT
  double-count (closing counts the GRN once); GRN-only still in closing; the
  `opening + purchase − closing = consumed` identity holds. Full suite green.
- Stage 2: `bs-section` + the GL closing-stock posting ties to the P&L closing.
- `tsc -p tsconfig.app.json --noEmit` + `eslint` clean; full `npm test` before each push;
  prod verify after each stage.

## Verification (prod erp.hookka.com, after each stage)
- Stage 1: June RAW MATERIALS — purchase ≈ PI, closing now includes June PI-only receipts,
  consumed no longer ballooned, **opening unchanged**.
- Stage 2: balance-sheet stock = P&L closing.
