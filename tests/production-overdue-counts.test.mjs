// ---------------------------------------------------------------------------
// production-overdue-counts.test.mjs — lock test for the Production "Overdue"
// badge counts in GET /api/production-orders/overdue-counts.
//
// Owner-verified rule (2026-06-12). A PO/piece is OVERDUE when ALL hold:
//   1. its SO hookkaExpectedDD is non-empty AND < today (Overview branch),
//   2. its UPHOLSTERY job card is still open (NOT IN COMPLETED/TRANSFERRED),
//   3. PO status NOT IN (COMPLETED, CANCELLED),
//   4. the piece is NOT already on a dispatched/delivered DO — checked PER
//      PIECE via delivery_order_items.productionOrderId joined to a
//      delivery_orders row whose status IN (LOADED, IN_TRANSIT, DELIVERED,
//      INVOICED). This is the key fix: a partially invoiced SO can read
//      INVOICED at SO level while a specific overdue piece is still in the
//      factory, so we must NOT exclude by SO status.
//
// Counts use DIFFERENT units:
//   • BEDFRAME = overdue PIECES (each overdue bedframe PO counts 1) — from the
//     raw per-PO `rows`, NOT the by-SO `breakdown`.
//   • SOFA = overdue SETS = distinct SOs with >=1 overdue sofa piece — the
//     existing by-SO `breakdown` count, kept.
//
// Source-level structural test (no DB / no worker runtime), matching the
// pattern of production-orders-dept-narrow-guard.test.mjs. The SQL ship-
// exclusion + the bedframe-by-piece switch are subtle and easy to silently
// regress in a future "perf" / "cleanup" PR, so pin them in CI.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src/api/routes/production-orders.ts");
const FE = resolve(process.cwd(), "src/pages/production/index.tsx");

function read(p) {
  return readFileSync(p, "utf8");
}

// Isolate the overdue-counts handler so the assertions only inspect that
// route, not the rest of the ~7k-line file. The handler runs from its
// `app.get("/overdue-counts"` registration to the next `app.get(`/`app.post(`.
function extractOverdueHandler(src) {
  const start = src.indexOf('app.get("/overdue-counts"');
  if (start < 0) return null;
  const after = src.slice(start + 1);
  const nextDecl = after.search(/\napp\.(get|post|put|patch|delete)\(/);
  return nextDecl < 0 ? src.slice(start) : src.slice(start, start + 1 + nextDecl);
}

test("overdue-counts handler exists", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(
    h,
    'Could not find `app.get("/overdue-counts"` in production-orders.ts. ' +
      "If it was renamed/restructured, update this test — but the invariants below must still hold.",
  );
});

// ---------------------------------------------------------------------------
// 1. Per-piece ship-exclusion is present, and keyed on the PO's OWN delivery
//    linkage (di.productionOrderId = po.id) — NOT on SO status.
//    It must appear TWICE: once in the Overview (dept === null) branch and
//    once in the per-dept branch.
// ---------------------------------------------------------------------------
test("ship-exclusion: NOT EXISTS over delivery_order_items joined to a dispatched/delivered DO", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");

  // The exclusion clause, written in the file's camelCase SQL style.
  const clauseRe =
    /NOT EXISTS\s*\(\s*SELECT 1 FROM delivery_order_items di\s+JOIN delivery_orders d ON d\.id = di\.deliveryOrderId\s+WHERE di\.productionOrderId = po\.id\s+AND d\.status IN \('LOADED','IN_TRANSIT','DELIVERED','INVOICED'\)\s*\)/g;

  const matches = h.match(clauseRe) ?? [];
  assert.equal(
    matches.length,
    2,
    "Expected the per-piece ship-exclusion NOT EXISTS clause in BOTH the " +
      "Overview branch and the per-dept branch (2 occurrences), found " +
      `${matches.length}. It must filter delivery_order_items by the PO's own ` +
      "id (di.productionOrderId = po.id) and the DO status whitelist.",
  );
});

test("ship-exclusion is PER PIECE, never by SO status (no sales_orders.status check in the exclusion)", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");

  // The whole point: excluding by SO status would wrongly drop genuinely-
  // overdue pieces on a partially-invoiced SO. The overdue SQL must not gate
  // on sales_orders.status anywhere.
  assert.doesNotMatch(
    h,
    /so\.status/,
    "The overdue rule must NOT read sales_orders.status — ship-exclusion is " +
      "per piece via delivery_order_items, because an SO can be partially " +
      "invoiced while a specific overdue piece is still in the factory.",
  );
});

// ---------------------------------------------------------------------------
// 2. BEDFRAME = pieces (from raw `rows`), SOFA = sets (from `breakdown`).
// ---------------------------------------------------------------------------
test("bedframeCount counts overdue PIECES from raw rows (itemCategory BEDFRAME + earliestOverdue)", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");

  // Must derive from rows.filter(...), gated on BEDFRAME + an overdue signal.
  assert.match(
    h,
    /const bedframeCount = rows\.filter\(/,
    "bedframeCount must be computed from the raw per-PO `rows` (by piece), " +
      "not from the by-SO `breakdown`.",
  );
  const bedBlock =
    h.slice(h.indexOf("const bedframeCount = rows.filter("));
  assert.match(
    bedBlock.slice(0, 400),
    /itemCategory === "BEDFRAME"/,
    "bedframeCount filter must match itemCategory === 'BEDFRAME'.",
  );
  assert.match(
    bedBlock.slice(0, 400),
    /earliestOverdue/,
    "bedframeCount must count only overdue rows (earliestOverdue set).",
  );

  // Guard against the OLD by-SO bedframe computation sneaking back.
  assert.doesNotMatch(
    h,
    /const bedframeCount = breakdown\.filter\(/,
    "Regression guard: bedframeCount must NOT be the by-SO breakdown count " +
      "again — bedframes are sold per piece.",
  );
});

test("sofaCount stays the by-SO breakdown count (sets)", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");
  assert.match(
    h,
    /const sofaCount = breakdown\.filter\(\s*\(r\)\s*=>\s*\n?\s*r\.overdueCategories\.includes\("SOFA"\),?\s*\)\.length;/,
    "sofaCount must remain the distinct-SO (set) count from `breakdown`.",
  );
});

// ---------------------------------------------------------------------------
// 3. Snapshot freshness: delivery tables added to sourceTables; cacheKey
//    versioned so the old (bedframe-by-SO) snapshot rows aren't served.
// ---------------------------------------------------------------------------
test("snapshot sourceTables include delivery_orders + delivery_order_items", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");
  const stIdx = h.indexOf("sourceTables:");
  assert.ok(stIdx >= 0, "sourceTables not found in the handler");
  const stBlock = h.slice(stIdx, stIdx + 260);
  for (const t of [
    "production_orders",
    "job_cards",
    "sales_orders",
    "delivery_orders",
    "delivery_order_items",
  ]) {
    assert.match(
      stBlock,
      new RegExp(`"${t}"`),
      `sourceTables must list "${t}" so the count rolls forward when that ` +
        "table changes (delivery state now affects overdue).",
    );
  }
});

test("cacheKey is version-bumped (vN) so stale old-semantics snapshots are bypassed", () => {
  // 2026-08-01: the key moved out of the handler into the exported
  // overdueCountsCacheKey() so the warm cron cannot drift from the route (the
  // dept-sheet warmer was reverted once for exactly that). The INTENT of this
  // test is unchanged and still load-bearing - assert it at the new location.
  const src = read(SRC);
  assert.match(
    src,
    /export function overdueCountsCacheKey\([\s\S]*?return `v\d+&dept=\$\{dept \?\? ""\}&today=\$\{today\}`;/,
    "the shared key builder must carry a version token (vN) — the cached payload's " +
      "meaning/shape has changed over time (bedframe by piece + ship-exclusion at v2; " +
      "the overdue PO id arrays at v3), so pre-existing snapshot rows must not be " +
      "served. Bump the version on any payload SHAPE change.",
  );
  // And the handler must actually use it, or the version guard is decorative.
  const h = extractOverdueHandler(src);
  assert.ok(h, "handler missing — see previous test");
  assert.match(h, /const cacheKey = overdueCountsCacheKey\(dept, today\)/);
});

// ---------------------------------------------------------------------------
// 4. Postgres-safety + English-only (repo conventions).
// ---------------------------------------------------------------------------
test("no 2-arg MAX( in the handler (SQLite form) — Postgres uses GREATEST", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");
  // MIN(jc.dueDate) is a legit 1-arg aggregate; only flag a 2-arg MAX(a, b)
  // / MAX(0, x) clamp, which is the SQLite form that broke Postgres.
  assert.doesNotMatch(
    h,
    /\bMAX\(\s*[^)]+,\s*[^)]+\)/,
    "Do not reintroduce 2-arg MAX(a,b) — use GREATEST(a,b) on Postgres " +
      "(BUG-2026-06-12-005).",
  );
});

test("no Chinese characters in the handler", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");
  assert.doesNotMatch(
    h,
    /[一-鿿]/,
    "Code/comments must be English-only (no Chinese).",
  );
});

// ---------------------------------------------------------------------------
// 5. Frontend chip labels reflect the new units (piece vs set).
// ---------------------------------------------------------------------------
test("frontend chip tooltips state the correct units (Bedframe = piece, Sofa = set)", () => {
  const fe = read(FE);
  assert.match(
    fe,
    /overdue Bedframe piece/,
    "The Bedframe chip tooltip must say it counts pieces.",
  );
  assert.match(
    fe,
    /overdue Sofa set/,
    "The Sofa chip tooltip must say it counts sets.",
  );
});

// ---------------------------------------------------------------------------
// 6. Chip-click FILTERS THE GRID (owner request 2026-06-23) — not a separate
//    SO-list panel. The endpoint exposes per-category overdue PO-id sets, and
//    the FE narrows the main grid by them via `overduePoIdSet`. Lock both ends
//    so a future "cleanup" can't silently revert to the old drill-down panel.
// ---------------------------------------------------------------------------
test("endpoint returns per-category overdue PO-id sets (overdueBedframePoIds / overdueSofaPoIds)", () => {
  const h = extractOverdueHandler(read(SRC));
  assert.ok(h, "handler missing — see previous test");
  assert.match(
    h,
    /const overdueBedframePoIds = rows\s*\.filter\(/,
    "Handler must derive overdueBedframePoIds from the overdue bedframe rows.",
  );
  assert.match(
    h,
    /const overdueSofaPoIds = rows\s*\.filter\(/,
    "Handler must derive overdueSofaPoIds from the overdue sofa rows.",
  );
  assert.match(
    h,
    /overdueBedframePoIds,\s*\n\s*overdueSofaPoIds,/,
    "Both id sets must be returned in the response payload so the grid can " +
      "filter to exactly the overdue work the chips count.",
  );
});

test("frontend grid filters by the overdue PO-id set (no separate SO-list panel)", () => {
  const fe = read(FE);
  // The grid-filter set built from the active chip + the endpoint's id arrays.
  assert.match(
    fe,
    /const overduePoIdSet = useMemo<Set<string> \| null>/,
    "FE must build `overduePoIdSet` from the active chip's overdue PO ids.",
  );
  // The main grid predicate must drop rows outside the active overdue set.
  assert.match(
    fe,
    /if \(overduePoIdSet && !overduePoIdSet\.has\(o\.id\)\) return false;/,
    "filteredOrders must exclude POs not in the active overdue id set.",
  );
  // Regression guard: the old drill-down panel (its own <table> titled
  // "<label> Overdue — N SOs") must be gone.
  assert.doesNotMatch(
    fe,
    /Overdue — \{filteredRows\.length\} SO/,
    "The separate overdue-SO drill-down panel must be removed — clicking a " +
      "chip now filters the main grid below instead.",
  );
});

// ---------------------------------------------------------------------------
// 7. Stale-SHAPED client cache must not filter the grid to 0 (BUG-2026-06-23).
//    A browser holding a counts payload cached BEFORE the id arrays existed has
//    bedframeCount:29 but NO overdueBedframePoIds. The memo must treat ABSENT
//    ids (undefined) as "not loaded yet" → null (skip the id-filter + refetch),
//    NOT as an empty Set (which filtered all 1032 rows out → "0 of 1032").
//    PRESENT-BUT-EMPTY ([]) must still build the Set so a genuine 0 stays 0.
// ---------------------------------------------------------------------------
test("absent overdue id array → null (skip filter + self-heal), not an empty Set", () => {
  const fe = read(FE);
  // The bug was `new Set(ids ?? [])` — absent ids collapsed to an empty Set,
  // which the grid predicate then used to exclude every row. That exact
  // fallback must be gone.
  assert.doesNotMatch(
    fe,
    /return new Set\(ids \?\? \[\]\)/,
    "The `ids ?? []` fallback collapses an ABSENT id array (stale-shape cache) " +
      "into an empty Set, filtering the grid to 0. Distinguish absent from empty.",
  );
  // Absent (undefined) ids must short-circuit to null so the id-filter is
  // skipped (overduePoIdSet === null) instead of excluding everything.
  assert.match(
    fe,
    /if \(!ids\) return null;\s*\n\s*return new Set\(ids\);/,
    "Memo must return null when the id array is ABSENT (skip the id-filter, " +
      "let the self-heal refetch land) and build the Set only when present.",
  );
  // A stale-shape payload (present object, missing array) must force a
  // cache-bypass refetch so the array-bearing payload arrives without a reload.
  assert.match(
    fe,
    /if \(overdueCountsResp && !ids\) refreshOverdueCounts\(\)/,
    "When the counts payload is present but the active chip's id array is " +
      "absent, force a refetch so the stale-shape client cache self-heals.",
  );
});
