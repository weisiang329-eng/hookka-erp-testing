// ---------------------------------------------------------------------------
// supplier-sku-edit-save.test.mjs — pin the supplier SKU edit "Save 不到" fixes.
//
// Two distinct bugs were confirmed LIVE on prod (2026-06-22) on
// /suppliers/:id → Pricing & SKUs → Edit SKU Mapping:
//
//   1. SAVE SILENTLY BLOCKED (the real root cause of "Save 不到").
//      The Internal Code / Internal Description inputs display the live search
//      term while focused:  value={showRmDropdown ? rmSearch : internalRMCode}.
//      They also carried the native HTML `required` attribute. So merely
//      CLICKING into the Internal Code box blanked the displayed value, and the
//      browser's required-validation then refused to submit the form — even
//      though internalRMCode was correctly committed. A price-only edit could
//      never save. Verified on prod: after focus, form.checkValidity() === false
//      ("Please fill out this field") with the committed code intact.
//      Fix: drop `required` from those two search-driven inputs and validate the
//      COMMITTED internalRMCode / materialName inside handleSubmit instead.
//
//   2. RENDER CHURN under the open dialog.
//      suppliers/detail.tsx built `skuColumns` as a fresh array literal every
//      render and passed it to <DataGrid columns={...}>. The grid's
//      visibleColumns → filteredData → sortedData memos all key off `columns`,
//      so an unstable reference made the whole grid recompute on every parent
//      render — and while the dialog is open, every keystroke re-renders the
//      page. Fix: memoise skuColumns (hoisted above the early returns to keep
//      hook order stable).
//
// Regex-on-source, same pattern as data-grid-fill.test.mjs — these contracts
// are cheap to silently re-break in a refactor and have no DOM test runner.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIALOG = readFileSync(
  join(process.cwd(), "src", "pages", "procurement", "sku-form-dialog.tsx"),
  "utf8",
);
const DETAIL = readFileSync(
  join(process.cwd(), "src", "pages", "suppliers", "detail.tsx"),
  "utf8",
);

test("Internal Code input is search-driven and NOT natively required", () => {
  // The value swaps to the search term on focus — so `required` here validates
  // the (empty) transient value and blocks save. The fix removes it.
  // Anchor on the actual <Input ...> JSX element (not surrounding comment prose)
  // and stop at the element's own self-closing `/>`.
  const block = DIALOG.match(
    /<Input\s+value=\{showRmDropdown \? rmSearch : internalRMCode\}[\s\S]*?\/>/,
  );
  assert.ok(block, "Internal Code search input must still exist");
  assert.doesNotMatch(
    block[0],
    /\brequired\b/,
    "Internal Code input must NOT carry native `required` (blanks on focus → blocks save)",
  );
});

test("Internal Description input is search-driven and NOT natively required", () => {
  const block = DIALOG.match(
    /<Input\s+value=\{showDescDropdown \? descSearch : materialName\}[\s\S]*?\/>/,
  );
  assert.ok(block, "Internal Description search input must still exist");
  assert.doesNotMatch(
    block[0],
    /\brequired\b/,
    "Internal Description input must NOT carry native `required`",
  );
});

test("handleSubmit validates the COMMITTED internal material, not the search box", () => {
  // The guard must read the committed state (internalRMCode / materialName) so a
  // price-only edit with an empty search term still saves.
  assert.match(
    DIALOG,
    /if \(!internalRMCode\.trim\(\) \|\| !materialName\.trim\(\)\)/,
    "handleSubmit must validate committed internalRMCode + materialName",
  );
  // The committed code/name must still flow into onSave (not the search term).
  assert.match(
    DIALOG,
    /onSave\(\{[\s\S]*?internalRMCode,[\s\S]*?materialName,/,
    "onSave must carry the committed internalRMCode + materialName",
  );
});

test("skuColumns is memoised so it doesn't churn the grid every render", () => {
  assert.match(
    DETAIL,
    /const skuColumns: Column<SkuBinding>\[\] = useMemo\(\(\) => \[/,
    "skuColumns must be a useMemo (stable reference), not a bare array literal",
  );
  // And it must be defined ABOVE the early returns (hook order stability):
  const memoIdx = DETAIL.indexOf("const skuColumns: Column<SkuBinding>[] = useMemo");
  const earlyReturnIdx = DETAIL.indexOf("if (supLoading || scoreLoading)");
  assert.ok(memoIdx > -1 && earlyReturnIdx > -1, "both anchors must exist");
  assert.ok(
    memoIdx < earlyReturnIdx,
    "skuColumns useMemo must sit ABOVE the loading early-return (Rules of Hooks)",
  );
});
