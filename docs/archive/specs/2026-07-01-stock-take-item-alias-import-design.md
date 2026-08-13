> **ARCHIVED / SUPERSEDED — stopped being true once the alias import shipped (on/after 2026-07-01).** Live in code: `migrations-postgres/0203_stock_take_item_alias.sql`, 6 `stock_take_item_alias` references in `src/api/routes/accounting.ts`, the ~230-row seed at `src/api/lib/stock-take-item-alias-seed-2026-05.ts`, and `tests/stock-take-import.test.mjs`. Kept for history only; do not treat as current.

# Auto-Categorize Raw Stock-Take Import — Design

**Date:** 2026-07-01
**Status:** Approved (owner, 2026-07-01)

## Context

Follows the Month-End Stock Take feature (commits `2ee9d5cf`..`a83c6720`, 2026-06-30/07-01):
a per-material-group / WIP / FG closing-value override the owner enters at month-end,
used by `materialWindow` instead of the FIFO/BOM figure. The owner uploads a monthly
physical stock-count spreadsheet with NO fixed format — column layout AND any category
labels vary month to month — and confirmed they normally upload the RAW variant (no
category/group column at all; grouping must come from item identity, not a label).

## Goal

Let the owner Import Excel their raw monthly stock-count file directly (whatever its
column layout), with the system resolving each LINE ITEM to its material group
automatically once it has been seen before, and asking the owner to resolve only
genuinely new/unrecognized line items — once, remembered forever after.

## Owner rules (binding)

1. The monthly file has no category/group column. Grouping must be inferred from the
   row's own identity (its descriptive columns), not a label — because a label column
   doesn't exist, and even when a similar one did exist (an earlier "categorized"
   variant), its vocabulary changed spelling/case month to month.
2. Column layout varies month to month (confirmed: this month's raw file has 7 columns
   `[ID1, ID2, in2, Qty, Total in2, Price/in2, Total]`; an earlier variant had 10 with
   an added "Item" column). The value column is reliably named "Total"; the identity
   columns are whatever descriptive columns precede the numeric ones.
3. Auto-resolve KNOWN items silently. Surface UNKNOWN items for a one-time inline pick
   (a dropdown of the 22 valid stock-take rows: 20 material groups + WIP + FG). The
   choice is remembered for all future months.
4. Nothing writes to `stock_take` until the owner reviews and hits Save (same gate as
   the existing feature). An unresolved item blocks Save with a clear list — money is
   never silently dropped or mis-bucketed into the wrong group.
5. Seed data: the owner's 30/05/2026 file was manually categorized + corrected this
   session (Others → `OTHERS` not `B.OTHERS`; ACC + Acc merged → `B.ACCE`). That
   ~230-line mapping becomes the INITIAL seed of the alias table, so day-one usage is
   already fully automatic for every item counted this month.

## The rule

> **Identity key** = `normalize(column A) + "||" + normalize(column B)` — the two
> descriptive columns that precede the numeric columns in every file shape seen so far
> (`normalize` = trim, collapse internal whitespace, lowercase).
> **Value** = the column whose header (case-insensitive) is exactly `"Total"`.
> **Resolution**: look up the identity key in a persisted alias table. Known → sum its
> Total into the assigned group. Unknown → collect for owner review (description + its
> Total value + a group-picker, or an explicit "ignore this line").

Confirmed against real files this session (direct cell-reference inspection, not just
`sheet_to_json` defaults): the raw 30/05/2026 file is a clean, consistent 7-column
sheet (`A1:G231`) with header row `["", "Actual Size", "in2", "Qty", "Total in2",
"Price/in2", "Total"]` — no header/data column misalignment. Column A + B (e.g.
`"9MM"` + `"5FT X 10\""`) reliably and uniquely identify a physical stock-count line,
consistent across the March and May files inspected.

## Architecture

- **New table `stock_take_item_alias`**: `id, org_id, item_key (normalized identity),
  item_group, created_at, updated_at`. Unique on `(org_id, item_key)`. Runtime
  self-applied (mirrors `ensureStockTake` in accounting.ts). `item_group` is nullable:
  NULL means "deliberately not a stock line" (e.g. a `GRAND TOTAL` trailer row) — set
  via "Ignore this line" in the review panel, so a recurring non-item row (same literal
  text every month) is skipped silently from then on instead of re-prompting forever.
- **Import Excel handler** (`StockTakeTab`, `src/pages/accounting/index.tsx`) detects
  which of two shapes the uploaded file matches:
  - Clean shape (headers `"Material Group"` + `"Closing Stock (RM)"`) → existing
    behavior, unchanged.
  - Raw shape (a `"Total"` header found, the clean-shape headers absent) → NEW path:
    find the `"Total"` column by header name; treat every column strictly before the
    first of `{in2, Qty, Total in2, Price/in2, Total}` (case-insensitive) as identity
    columns; build the normalized key per row; sum by key. Fetch the alias table
    (`GET /api/accounting/stock-take-item-aliases`); split into THREE buckets: known
    non-null (summed straight into `edits` for the assigned group — multiple keys can
    map to the same group, e.g. this month's case-variant merge), known-null / ignored
    (dropped silently, not shown anywhere), and unresolved (shown in a new "N items
    need mapping" panel: description, RM total, a `<select>` of the 22 valid rows, or
    an "Ignore" option).
- **Extend `PUT /api/accounting/stock-take`**: body gains an optional
  `newAliases: [{ itemKey, itemGroup }]` array (`itemGroup: null` for "Ignore"),
  upserted into `stock_take_item_alias` in the SAME batch as the stock_take
  upserts/deletes — one atomic Save persists both the numbers and the new memory.
- **Seed migration**: a one-time backfill (an admin/maintenance endpoint, mirroring the
  `backfill-gl-postings` pattern — dry-run + idempotent) inserts the ~230 confirmed
  `(item_key → item_group)` pairs derived from this session's categorization of the
  30/05/2026 file, so the alias table starts non-empty and day-one usage needs no
  manual resolution for anything already counted this month.

## UX flow

1. Owner clicks Import Excel, picks their raw monthly file (any shape with a `"Total"`
   header).
2. System parses, resolves against the alias table.
3. Known items' RM total fills the numeric grid exactly as today — the existing grid
   IS the review surface for resolved totals (same as manual entry today).
4. A "Needs mapping" panel appears ONLY if unresolved items exist: each row shows its
   description + RM value + a group dropdown (or "Ignore this line"). Save is blocked
   with a clear message while any row is unassigned.
5. Owner assigns any unknowns (or ignores a genuinely non-stock line so it doesn't
   block Save and isn't remembered as a mapping).
6. Save writes the resolved numbers into `stock_take` (existing behavior) AND the
   newly-assigned aliases into `stock_take_item_alias` — one atomic action.
7. Next month: same physical items (even under a different column layout) resolve
   automatically from the alias table; only a genuinely new material/spec needs a
   fresh one-time pick.

## Known limitation

Auto-resolution assumes column A + B text uniquely identifies a physical stock item
across months (validated against the March/May files inspected — no observed
collisions). If two genuinely different items ever shared identical A+B text, the
mis-resolution would be silent (it wouldn't appear in the "needs mapping" panel, since
it resolves without incident) — bounded only by the owner eyeballing the final
per-group totals in the grid, the same review surface as manual entry. Acceptable
given no such collision has been observed and the value at risk per line is small
relative to the group totals.

## Unchanged

- The existing clean 2-column Import (Export Excel's own round trip) — untouched.
- The 0-means-automatic / positive-means-override Save semantics — unchanged; this
  design only changes HOW the grid gets filled before Save.
- `materialWindow`'s override mechanism — unchanged.

## Testing

- Column/identity detection across the observed 7-column and 10-column shapes: both
  correctly find `"Total"` and build the same identity key for the same physical row.
- Alias resolution: a known `item_key` sums correctly across multiple rows mapping to
  the same group; an unknown `item_key` surfaces in the mapping panel and blocks Save
  until assigned or explicitly ignored.
- Round trip: assigning an unknown this month, saving, then re-importing an identical
  line next month resolves it automatically (no repeat prompt).
- `tsc` + `eslint` clean; full `npm test` before push; prod verify after ship.

## Verification (prod)

Import the owner's actual 30/05/2026 raw file (no Item column) after the seed
migration → confirm it resolves against the seeded aliases with ZERO unmapped items
(validates the seed matches this session's confirmed categorization: RM 87,261.90
total, `B.ACCE` = 4,089.60, `OTHERS` = 3,688.70) → Save → June's RAW MATERIALS opening
ties to the numbers already confirmed in this chat.
