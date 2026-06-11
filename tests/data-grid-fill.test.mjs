// ---------------------------------------------------------------------------
// data-grid-fill.test.mjs — pin the DataGrid column-width contract
// ("fit fit", 2026-06-11).
//
// The grid's width behavior is a three-part contract that broke subtly in
// the past and is cheap to re-break in a refactor:
//
//   1. <colgroup> keeps the explicit per-column `width` (+ the harmless
//      minWidth mirror). Under table-layout:auto + a w-full table this IS
//      the column's minimum: when the declared widths sum past the
//      container the table overflows into the horizontal scrollbar at
//      exactly those widths (never squashing below them), and when they
//      sum under the container the browser flexes every column
//      proportionally to its declared width.
//   2. Cell content in width-bearing columns fills the LIVE cell via the
//      width:0 + min-width:100% trick — contributes ~nothing to intrinsic
//      sizing (so a long value can never balloon a column past its
//      declared width), then renders at 100% of the flexed/resized cell.
//      Replaces the old `maxWidth: <declared px>` clamp that left the
//      right side of every stretched column as permanent dead space.
//      Width-less columns keep the legacy 300px cap (they have no <col>
//      floor, so the fill trick would let them collapse to header width).
//   3. The drag-to-resize handle (startColumnResize) and its double-click
//      reset (resetColumnWidth) keep feeding the SAME colWidths map the
//      colgroup + fill div read from, so resizing keeps working.
//
// Regex-on-source, same pattern as security-route-coverage.test.mjs —
// catches "agent simplified the style object" at commit level without a
// DOM test runner.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src", "components", "ui", "data-grid.tsx"),
  "utf8",
);

test("colgroup keeps explicit width as the column minimum", () => {
  // The <col> style must still carry the resolved width — this is what
  // floors the column on narrow viewports (horizontal scroll, never
  // squash) and what the proportional flex distributes against.
  assert.match(
    SRC,
    /const w = colWidths\[col\.key\] \|\| col\.width;/,
    "colgroup must resolve live colWidths first, then the declared width",
  );
  assert.match(
    SRC,
    /style=\{w \? \{ width: w, minWidth: w \} : undefined\}/,
    "<col> must keep the explicit width (declared/resized) as its floor",
  );
});

test("width-bearing cells fill the live column width (no dead right space)", () => {
  // width:0 + min-width:100% — contributes ~nothing to intrinsic sizing,
  // renders at 100% of the flexed/resized cell. This is what makes the
  // grid consume the full container width when the declared widths sum
  // to less than it.
  assert.match(
    SRC,
    /\? \{ width: 0, minWidth: "100%" \}/,
    "cells in width-bearing columns must use the width:0 + min-width:100% fill",
  );
  // Width-less columns keep the legacy cap so they cannot collapse to
  // header width (they have no <col> floor).
  assert.match(
    SRC,
    /: \{ maxWidth: "300px" \}/,
    "width-less columns must keep the legacy 300px content cap",
  );
  // The fork must key off the column's resolved width.
  assert.match(
    SRC,
    /const resolvedWidth = colWidths\[col\.key\] \|\| col\.width;/,
    "fill-vs-cap fork must read the live resolved width",
  );
});

test("column resize machinery still drives the same width map", () => {
  // Drag handle writes `${w}px` into colWidths (which the colgroup AND
  // the fill fork both read), min 48px so a column can't vanish.
  assert.match(
    SRC,
    /const startColumnResize = useCallback\(/,
    "drag-to-resize handler must exist",
  );
  assert.match(
    SRC,
    /Math\.max\(48, Math\.round\(startW \+ \(ev\.clientX - startX\)\)\)/,
    "resize must clamp at the 48px minimum",
  );
  assert.match(
    SRC,
    /const resetColumnWidth = useCallback\(/,
    "double-click width reset must exist",
  );
  assert.match(
    SRC,
    /onMouseDown=\{\(e\) => startColumnResize\(e, col\.key\)\}/,
    "header resize handle must stay wired to startColumnResize",
  );
});
