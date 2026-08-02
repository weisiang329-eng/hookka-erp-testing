// ---------------------------------------------------------------------------
// outstanding-no-production-order.test.mjs — the Outstanding column has to say
// WHAT is outstanding.
//
// Owner 2026-08-02, looking at two freshly hand-created orders sitting beside
// the rest:「为什么 Outstanding 奇怪地显示在 one piece, two piece?」
//
// The column shows "3/3" (production orders left / total) for everything with
// production behind it, and fell back to a bare "2 pcs" for an order that has
// NO production order at all. Two different units in one column reads as a
// glitch, not as a state — and the state it was trying to report ("nothing is
// being made for this order") is the one worth noticing.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/pages/sales/index.tsx", "utf8");

test("an order with no production order says so, in words", () => {
  assert.match(src, /return \(\s*\n\s*<span\s*\n\s*className="font-semibold text-\[#9A3A2D\]"\s*\n\s*title=\{`\$\{totalQty\} pcs ordered, but no production order exists yet`\}/);
  assert.match(src, /No PO yet/);
});

test("the bare quantity fallback is gone", () => {
  // "{totalQty} pcs" in this column was the whole confusion.
  assert.doesNotMatch(src, /\{totalQty\} pcs\s*\n\s*<\/span>/);
});

test("the quantity is still available, on hover", () => {
  // Removing the number entirely would lose information the operator had.
  assert.match(src, /\$\{totalQty\} pcs ordered/);
});
