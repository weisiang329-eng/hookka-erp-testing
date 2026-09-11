// T-006 R9 — a PI create body with no header grnId and no header
// purchaseOrderId, but a line still naming its own poId, fell through both
// existing branches (if body.grnId / else if body.purchaseOrderId) and never
// hit checkPoRemaining at all. The line's poId still got INSERTed, so it
// counted against the PO on the NEXT invoice's ceiling — this invoice itself
// was simply never checked.
// Source-static — the live behavioral test lives in purchasing-convert-flow.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/routes/purchase-invoices.ts", "utf8");

test("a third branch covers a header with neither grnId nor purchaseOrderId", () => {
  assert.match(
    SRC,
    /\} else if \(normalizedItems && normalizedItems\.ok && normalizedItems\.rows\.some\(\(r\) => r\.poId\)\) \{/,
  );
});

test("the third branch groups by the line's own poId and runs the SAME ceiling", () => {
  const idx = SRC.indexOf("normalizedItems.rows.some((r) => r.poId)");
  const block = SRC.slice(idx, idx + 1000);
  assert.match(block, /const byPo = new Map<string, typeof normalizedItems\.rows>\(\)/);
  assert.match(block, /if \(!r\.poId\) continue;/);
  assert.match(block, /await checkPoRemaining\(db, poId, rows\)/);
});
