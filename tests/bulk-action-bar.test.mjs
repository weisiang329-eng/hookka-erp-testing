// ---------------------------------------------------------------------------
// bulk-action-bar.test.mjs — the shared BulkActionBar is actually mounted, and
// it only offers what the page can already do to a single row.
//
// The audit that prompted this claimed 17 pages had row selection but "only
// Sales, Delivery and vouchers offer bulk actions". That is not what the code
// says: Purchase Orders, GRN, Invoices and Consignment Orders all shipped their
// own INLINE selection toolbars (bulk PDF, bulk convert, bulk arrival). What
// was genuinely missing was Purchase Invoices — it could print ONE invoice from
// the row menu, and `generateCombinedPurchaseInvoicePdf` had been written for
// "PI list → bulk Download PDF" and never called from anywhere.
//
// So these pin two things:
//   • the bar is mounted on PI with print + confirm, both of which exist as
//     single-row actions on that same page — no invented bulk operations;
//   • the bar's Clear genuinely clears, which needs the grid's own selection
//     to be clearable (it wasn't; a page emptying its own mirror left every
//     checkbox ticked).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const PI = readFileSync("src/pages/procurement/pi.tsx", "utf8");
const BAR = readFileSync("src/components/ui/bulk-action-bar.tsx", "utf8");
const GRID = readFileSync("src/components/ui/data-grid.tsx", "utf8");

test("the BulkActionBar is no longer dead code", () => {
  assert.match(PI, /import \{ BulkActionBar \} from "@\/components\/ui\/bulk-action-bar"/);
  assert.match(PI, /<BulkActionBar/);
});

test("the bar renders nothing when nothing is selected", () => {
  // The page must not have to short-circuit it — that is the component's job.
  assert.match(BAR, /if \(selectedCount <= 0\) return null;/);
});

test("PI's bulk actions are a SUBSET of what its row menu can already do", () => {
  // Row menu (single row) — the source of truth for "what this page can do".
  const rowMenu = PI.slice(PI.indexOf("piGridContextMenu"), PI.indexOf("Bulk print"));
  const rowLabels = [...rowMenu.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(rowLabels.includes("Print PI"), "row menu should still print one PI");
  assert.ok(rowLabels.includes("Confirm"), "row menu should still confirm one draft");

  // Bulk bar — every action must correspond to one of those.
  const bar = PI.slice(PI.indexOf("<BulkActionBar"));
  assert.match(bar, /Print \(\$\{selectedRows\.length\}\)|Print \(\{selectedRows\.length\}\)|`Print \(/);
  assert.match(bar, /Confirm \$\{selectedDraftCount\}/);
  // Nothing that isn't a row action: no bulk delete, no bulk pay, no bulk void.
  for (const forbidden of ["Delete", "Void", "Mark Paid", "Cancel"]) {
    assert.ok(
      !new RegExp(`>\\s*${forbidden}`).test(bar),
      `bulk bar must not offer "${forbidden}" — it is not a row action wired here`,
    );
  }
});

test("Confirm only appears when the selection actually contains drafts", () => {
  // A bulk button that would 409 on every row is worse than no button.
  const bar = PI.slice(PI.indexOf("<BulkActionBar"));
  assert.match(bar, /\{selectedDraftCount > 0 && \(/);
  assert.match(
    PI,
    /selectedRows\.filter\(\(r\) => r\.status === "DRAFT"\)\.length/,
    "draft count must be derived from the real selection",
  );
});

test("bulk print reuses the SAME loader as the single print", () => {
  // Two implementations would drift: different letterhead, different supplier
  // block, and a bulk PDF that doesn't match the one the operator proofed.
  assert.match(PI, /const loadPiForPrint = useCallback/);
  const single = PI.slice(PI.indexOf('label: "Print PI"'), PI.indexOf("Bulk print"));
  assert.match(single, /loadPiForPrint\(row\.id\)/);
  const bulk = PI.slice(PI.indexOf("const printSelected"));
  assert.match(bulk, /loadPiForPrint\(row\.id\)/);
  assert.match(bulk, /generateCombinedPurchaseInvoicePdf/);
});

test("a row that fails to load is reported, not silently dropped", () => {
  const bulk = PI.slice(PI.indexOf("const printSelected"));
  assert.match(bulk, /could not be loaded/);
  assert.match(bulk, /Could not load any of the selected invoices/);
});

test("the page's duplicate inline selection strip is gone", () => {
  assert.ok(
    !PI.includes("draft invoice(s) selected"),
    "the old inline amber strip must not co-exist with the bar",
  );
});

test("Clear actually clears — the grid's own selection is clearable", () => {
  // DataGrid owns `selectedKeys`; before this a page could only empty its own
  // mirror, leaving the checkboxes ticked.
  assert.match(GRID, /clearSelectionToken\?: number;/, "prop must be declared");
  assert.match(GRID, /if \(clearSelectionToken === lastClearToken\.current\) return;/);
  assert.match(GRID, /setSelectedKeys\(\(prev\) => \(prev\.size === 0 \? prev : new Set\(\)\)\)/);

  // ...and PI drives both halves from one Clear.
  const bar = PI.slice(PI.indexOf("<BulkActionBar"));
  assert.match(bar, /setSelectedRows\(\[\]\)/);
  assert.match(bar, /setClearSelectionToken\(\(t\) => t \+ 1\)/);
  assert.match(PI, /clearSelectionToken=\{clearSelectionToken\}/);
});

test("the clear is opt-in — grids that pass no token are untouched", () => {
  // Undefined === undefined on every render, so the effect returns early and
  // no existing grid loses its selection.
  assert.match(GRID, /const lastClearToken = useRef<number \| undefined>\(clearSelectionToken\);/);
});

test("the pages that already had bulk actions kept them", () => {
  // Regression guard for the audit's false premise: these were never missing.
  const cases = [
    ["src/pages/procurement/index.tsx", /downloadSelectedPdf/, /handleBulkConvertToGRN/],
    ["src/pages/procurement/grn.tsx", /downloadSelectedPdf/, /runBulkArrivalTransition/],
    ["src/pages/invoices/index.tsx", /downloadSelectedPdf/, /selectedInvoices\.length/],
    ["src/pages/consignment/index.tsx", /bulkPrinting/, /bulkConverting/],
  ];
  for (const [file, a, b] of cases) {
    const src = readFileSync(file, "utf8");
    assert.match(src, a, `${file} lost a bulk action`);
    assert.match(src, b, `${file} lost a bulk action`);
  }
});
