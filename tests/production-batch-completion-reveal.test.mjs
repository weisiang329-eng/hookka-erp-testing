// ---------------------------------------------------------------------------
// production-batch-completion-reveal.test.mjs — lock test for BUG-2026-06-23-004.
//
// Symptom: on a dept Production Sheet, batch "Apply Completion" flips the
// selected rows' status → COMPLETED. The sheet default-hides COMPLETED rows
// (the Status value-filter via `defaultExcludedValues`), so the just-completed
// rows filtered THEMSELVES out of view — it LOOKED like the completion vanished
// (it was saved; the Folder showed them). The owner wants to SEE the completion
// after batch-applying, like single-cell completion edits + the Folder.
//
// Fix (option A — no-remount force-show): a `forceShowKeys` allowlist (a Set of
// the just-completed DeptRow ids, in component state, cleared on tab change /
// reload) EXEMPTS those rows from the hide-COMPLETED Status value-filter WITHOUT
// remounting the grid.
//
// CRITICAL CONSTRAINT: a prior attempt bumped `gridResetNonce` (part of the
// DataGrid `key`) to re-reveal the rows → REMOUNTED the grid → wiped the
// uncontrolled checkbox selection → cleared `selectedDeptRows` → the
// BatchActionToolbar self-hid → BROKE the operator's Apply Completion → Apply
// PIC → Save to Folder chaining. So the reveal must NOT touch `gridResetNonce`,
// must NOT clear the selection, and `forceShowCompletedIds` must NOT be part of
// the grid `key`.
//
// Source-level structural test (no DB / no React runtime), matching the pattern
// of production-overdue-counts.test.mjs. These wirings are subtle and easy to
// silently regress in a future "perf"/"cleanup" PR, so pin them in CI.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FE = resolve(process.cwd(), "src/pages/production/index.tsx");
const GRID = resolve(process.cwd(), "src/components/ui/data-grid.tsx");

function read(p) {
  return readFileSync(p, "utf8");
}

// Isolate the Apply Completion handler (ApplyBatchDateDialog's onApply) so the
// assertions only inspect that one handler, not the whole ~8k-line file. It
// runs from `<ApplyBatchDateDialog` to the next `<ApplyBatch` dialog tag.
function extractApplyCompletionHandler(src) {
  const start = src.indexOf("<ApplyBatchDateDialog");
  if (start < 0) return null;
  const after = src.slice(start + 1);
  const nextDecl = after.indexOf("<ApplyBatch");
  return nextDecl < 0 ? src.slice(start) : src.slice(start, start + 1 + nextDecl);
}

// ---------------------------------------------------------------------------
// 1. DataGrid exposes a `forceShowKeys` prop and uses it to EXEMPT rows from
//    the per-column TEXT + VALUE filters (the hide mechanism), without
//    exempting global search.
// ---------------------------------------------------------------------------
test("DataGrid declares a forceShowKeys prop (Set of keyField values)", () => {
  const g = read(GRID);
  assert.match(
    g,
    /forceShowKeys\?:\s*ReadonlySet<string>;/,
    "DataGrid must declare an optional `forceShowKeys?: ReadonlySet<string>` prop.",
  );
  assert.match(
    g,
    /forceShowKeys = EMPTY_FORCE_SHOW,/,
    "The prop must default to a STABLE shared empty Set (EMPTY_FORCE_SHOW) so an " +
      "omitted prop doesn't bust the filteredData useMemo on every render.",
  );
});

test("forceShowKeys exempts rows from the per-column TEXT and VALUE filters", () => {
  const g = read(GRID);
  // The filteredData memo must short-circuit force-shown rows past BOTH the
  // text-filter `.every(...)` and the value-filter `.every(...)`.
  assert.match(
    g,
    /isForceShown\(row\)\s*\|\|\s*\n?\s*activeFilters\.every\(/,
    "Force-shown rows must bypass the per-column TEXT filters " +
      "(`isForceShown(row) || activeFilters.every(...)`).",
  );
  assert.match(
    g,
    /isForceShown\(row\)\s*\|\|\s*\n?\s*activeValueFilters\.every\(/,
    "Force-shown rows must bypass the per-column VALUE filters " +
      "(`isForceShown(row) || activeValueFilters.every(...)`) — this is the " +
      "hide-COMPLETED Status filter the reveal must defeat.",
  );
  // forceShowKeys must be in the filteredData memo deps so a change re-filters.
  assert.match(
    g,
    /\}, \[data, deferredSearch, columnFilters, columnValueFilters, visibleColumns, alwaysSearchKeys, forceShowKeys, keyField, columns\]\);/,
    "filteredData useMemo must depend on forceShowKeys (so adding an id re-runs " +
      "the filter and the row appears).",
  );
});

test("global SEARCH is NOT exempted by forceShowKeys (it's an explicit operator narrowing)", () => {
  const g = read(GRID);
  // The isForceShown bypass must come AFTER the global-search block, not be
  // wired into it — typing a query is an explicit narrowing the operator owns.
  const searchIdx = g.indexOf("// Global search (deferred");
  const exemptIdx = g.indexOf("const isForceShown =");
  assert.ok(searchIdx >= 0 && exemptIdx >= 0, "anchors not found");
  assert.ok(
    exemptIdx > searchIdx,
    "The forceShow exemption must be defined AFTER the global-search filter so " +
      "search still narrows force-shown rows (intentional).",
  );
});

// ---------------------------------------------------------------------------
// 2. The dept Production grid wires forceShowKeys to the new state, and that
//    state is NOT part of the grid `key` (so updating it never remounts).
// ---------------------------------------------------------------------------
test("dept grid passes forceShowKeys={deptForceShowKeys} (unions forceShowCompletedIds)", () => {
  const fe = read(FE);
  // v3 (2026-06-23): the dept grid now passes `deptForceShowKeys` — a memo that
  // unions forceShowCompletedIds (the Apply-Completion reveal allowlist) with the
  // search-matched dept-row ids while searching, so a searched COMPLETED order is
  // exempt from the seeded hide-COMPLETED value-filter.
  assert.match(
    fe,
    /forceShowKeys=\{deptForceShowKeys\}/,
    "The dept <DataGrid> must pass the force-show allowlist (deptForceShowKeys) as forceShowKeys.",
  );
  assert.match(
    fe,
    /const \[forceShowCompletedIds, setForceShowCompletedIds\] = useState<ReadonlySet<string>>/,
    "forceShowCompletedIds must be component state (a Set), not sessionStorage.",
  );
  // deptForceShowKeys must still be built FROM forceShowCompletedIds (the reveal
  // allowlist) — search only adds matched rows on top, it must not drop it.
  assert.match(
    fe,
    /const deptForceShowKeys =[\s\S]{0,600}forceShowCompletedIds/,
    "deptForceShowKeys must union forceShowCompletedIds (the Apply-Completion reveal allowlist).",
  );
});

test("CRITICAL: the grid `key` must NOT include forceShowCompletedIds (no remount on reveal)", () => {
  const fe = read(FE);
  // The dept grid key is `dept-grid-${activeDept.code}-${gridResetNonce}`.
  // It must contain gridResetNonce (Clear-All remount) but MUST NOT contain
  // forceShowCompletedIds — that would remount on every reveal and wipe the
  // checkbox selection (the exact prior-attempt failure).
  const keyRe = /key=\{`dept-grid-\$\{activeDept\.code\}-\$\{gridResetNonce\}`\}/;
  assert.match(
    fe,
    keyRe,
    "The dept grid `key` must remain `dept-grid-${activeDept.code}-${gridResetNonce}`.",
  );
  const keyLine = fe.match(/key=\{`dept-grid-[^`]*`\}/);
  assert.ok(keyLine, "dept grid key template literal not found");
  assert.doesNotMatch(
    keyLine[0],
    /forceShow/,
    "REGRESSION GUARD: forceShowCompletedIds must NOT be part of the grid `key`. " +
      "Putting it in the key remounts the grid on every reveal, wiping the " +
      "uncontrolled checkbox selection and breaking the batch chaining workflow.",
  );
});

// ---------------------------------------------------------------------------
// 3. Apply Completion populates the allowlist AND keeps the selection.
//    A prior attempt called a revealCompletedRows() that bumped gridResetNonce;
//    that pattern must never come back inside this handler.
// ---------------------------------------------------------------------------
test("Apply Completion populates forceShowCompletedIds with the completed row ids", () => {
  const h = extractApplyCompletionHandler(read(FE));
  assert.ok(h, "Could not isolate the ApplyBatchDateDialog onApply handler.");
  assert.match(
    h,
    /setForceShowCompletedIds\(/,
    "Apply Completion must add the just-completed rows to the force-show set.",
  );
  // It must add the COMPLETED rows (date set) and remove un-completed ones.
  assert.match(
    h,
    /const completedRowIds = date \? selectedDeptRows\.map\(\(r\) => r\.id\) : \[\];/,
    "Must collect the DeptRow composite ids of the rows being completed.",
  );
});

test("CRITICAL: Apply Completion must NOT clear the selection or bump gridResetNonce", () => {
  const h = extractApplyCompletionHandler(read(FE));
  assert.ok(h, "handler missing — see previous test");
  // The whole point of the chaining workflow: selection survives.
  assert.doesNotMatch(
    h,
    /setSelectedDeptRows\(\s*\[\s*\]\s*\)/,
    "Apply Completion must NOT clear selectedDeptRows — the operator chains " +
      "Apply Completion → Apply PIC → Save to Folder on the SAME selection.",
  );
  // The prior failed attempt bumped gridResetNonce to remount + re-reveal.
  assert.doesNotMatch(
    h,
    /setGridResetNonce/,
    "REGRESSION GUARD: Apply Completion must NOT bump gridResetNonce. That " +
      "remounts the grid, wiping the checkbox selection and self-hiding the " +
      "batch toolbar — the exact prior-attempt bug.",
  );
  // No revival of a remount-based reveal helper.
  assert.doesNotMatch(
    h,
    /revealCompletedRows/,
    "REGRESSION GUARD: the remount-based revealCompletedRows() helper must not " +
      "return — the reveal is the no-remount forceShowKeys allowlist instead.",
  );
});

// ---------------------------------------------------------------------------
// 4. The reveal is session-scoped: it lives in component state (resets on a
//    full reload) and is dropped on a dept-tab switch.
// ---------------------------------------------------------------------------
test("force-show resets on dept-tab change (clean default-hide view per dept)", () => {
  const fe = read(FE);
  assert.match(
    fe,
    /setForceShowCompletedIds\(\(prev\) => \(prev\.size === 0 \? prev : new Set\(\)\)\);/,
    "Switching dept tab must clear the force-show set so the new dept opens with " +
      "the clean hide-COMPLETED default.",
  );
});

// ---------------------------------------------------------------------------
// 5. English-only (repo convention).
// ---------------------------------------------------------------------------
test("no Chinese characters in the force-show wiring (FE handler region)", () => {
  const h = extractApplyCompletionHandler(read(FE));
  assert.ok(h, "handler missing — see previous test");
  assert.doesNotMatch(h, /[一-鿿]/, "Code/comments must be English-only.");
});

// ---------------------------------------------------------------------------
// 6. OVERVIEW search-exemption (BUG-2026-06-24-001 — the Overview half of the
//    same class). The DEFAULT /production view is the hand-rolled Overview
//    matrix (activeTab === "ALL"), NOT the dept <DataGrid>. v1/v2/v3 (the
//    forceShowKeys work above) only fixed the dept grid; the Overview hides
//    COMPLETED via its OWN per-dept column value-filter (`f.deptStatuses`,
//    persisted in localStorage) and date-filter (`f.deptDates`) inside the
//    `visibleOrders` memo — these have NO search exemption, so a searched
//    COMPLETED order matched only 2-of-6 ("6 of 1608" counted, 2 rendered).
//
//    Fix: while a top-bar search is active, BYPASS those two dept-column-filter
//    loops in the visibleOrders memo (mirroring the dept grid's forceShowKeys
//    exemption + the filteredOrders `!q` date-window skip). With NO search
//    active the loops run exactly as before (byte-identical). Pin it so a
//    future refactor of the visibleOrders memo can't silently un-gate it.
// ---------------------------------------------------------------------------

// Isolate the visibleOrders memo (from its declaration to the closing
// `useMemo` dep array) so assertions inspect only that memo.
function extractVisibleOrdersMemo(src) {
  const start = src.indexOf("const visibleOrders = useMemo(");
  if (start < 0) return null;
  // The memo ends at its dependency array, which includes deferredOverviewFilters.
  const after = src.slice(start);
  const end = after.indexOf("deferredOverviewFilters, deferredFltSearch]);");
  return end < 0 ? after : after.slice(0, end + "deferredOverviewFilters, deferredFltSearch]);".length);
}

test("Overview visibleOrders bypasses the dept-column filters while searching", () => {
  const memo = extractVisibleOrdersMemo(read(FE));
  assert.ok(memo, "Could not isolate the visibleOrders memo.");
  // A deferred-derived search flag (NOT the urgent `searchActive`) so the
  // bypass flips in lockstep with filteredOrders (which reads deferredFltSearch).
  assert.match(
    memo,
    /const searchActiveOverview = deferredFltSearch\.trim\(\)\.length > 0;/,
    "visibleOrders must derive a search flag from the DEFERRED search " +
      "(deferredFltSearch) so the dept-column-filter bypass tracks filteredOrders.",
  );
  // Both dept-column filter loops must sit INSIDE `if (!searchActiveOverview)`.
  assert.match(
    memo,
    /if \(!searchActiveOverview\) \{[\s\S]*Object\.keys\(f\.deptStatuses\)[\s\S]*Object\.keys\(f\.deptDates\)[\s\S]*\}\s*return true;/,
    "The f.deptStatuses AND f.deptDates filter loops must both be gated behind " +
      "`if (!searchActiveOverview)` so a searched COMPLETED/TRANSFERRED order is " +
      "not dropped by a persisted dept-status/date filter on the Overview.",
  );
});

test("Overview dept-column filters STILL apply when no search is active (byte-identical)", () => {
  const memo = extractVisibleOrdersMemo(read(FE));
  assert.ok(memo, "memo missing — see previous test");
  // The deptStatuses loop body must be unchanged (the hide still works with no
  // search): wanted-state membership check + empty-cell drop remain present.
  assert.match(
    memo,
    /const wanted = f\.deptStatuses\[deptCode\] \|\| \[\];/,
    "The dept-status filter body must be preserved (so the hide still applies " +
      "with no search active).",
  );
  assert.match(
    memo,
    /if \(!wanted\.includes\(c\.state as "pending" \| "overdue" \| "done"\)\) return false;/,
    "The dept-status membership check must remain — non-search behaviour is " +
      "byte-identical.",
  );
  // visibleOrders memo must depend on deferredFltSearch so the bypass recomputes
  // when the search changes.
  assert.match(
    memo,
    /\}, \[filteredOrders, activeTab, deferredOverviewSort, deferredOverviewFilters, deferredFltSearch\]\);/,
    "The visibleOrders useMemo must list deferredFltSearch in its deps so the " +
      "search-bypass re-runs when the query changes.",
  );
});
