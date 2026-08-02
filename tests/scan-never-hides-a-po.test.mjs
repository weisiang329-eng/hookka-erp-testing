// ---------------------------------------------------------------------------
// scan-never-hides-a-po.test.mjs — the scan preview must never REMOVE a PO it
// found. It may warn about one; it may leave one unticked. It may not hide one.
//
// Owner 2026-08-02, from a real upload:「为什么我的 OCR PO 9721、9720 会没有出来
// 呢?」The PDF held ELEVEN purchase orders and the preview said "Found 9".
//
// Root cause: the preview filtered on `consumedAt` / `consumedDocIdxs` —
// "a draft was already created from this". That mark survives the draft being
// DELETED, so a PO the operator had scanned, drafted, and then deleted became
// permanently invisible to every future scan of the same file. Two real orders
// disappeared out of eleven and NOTHING said so — no count, no warning, no row.
//
// Owner's rule, stated plainly:「无论什么情况,它都应该要出来,只是做提醒,而不是
// 影响我的 flow」.
//
// A silent removal is worse than a duplicate: a duplicate is visible and can be
// deleted, a missing order is found by the customer.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/components/scan-po-modal.tsx", "utf8");

test("the queue filter no longer drops consumed rows", () => {
  assert.doesNotMatch(
    src,
    /\(it\.status === "done" \|\| it\.status === "cached"\) &&\s*\n\s*!it\.consumedAt/,
    "the !consumedAt test is the bug — it hid POs whose draft was deleted",
  );
  assert.match(src, /\(it\.status === "done" \|\| it\.status === "cached"\) &&\s*\n\s*it\.rawJson != null/);
});

test("a per-doc consumed index is FLAGGED, not skipped", () => {
  assert.doesNotMatch(
    src,
    /if \(consumedIdxs\.has\(docIdx\)\) return;/,
    "skipping is what made two of eleven POs vanish",
  );
  assert.match(src, /alreadyUsed: consumedIdxs\.has\(docIdx\) \|\| !!it\.consumedAt/);
});

test("an already-drafted PO is shown, warned about, and left unticked", () => {
  // Shown and warned…
  assert.match(src, /alreadyUsed && \(/);
  assert.match(src, /Draft made before/);
  // …but not swept into a bulk confirm.
  assert.match(src, /if \(claudeRows\[i\]\?\.alreadyUsed\) continue;/);
});

test("the flag is on every row shape, so no path can forget it", () => {
  assert.match(src, /alreadyUsed: boolean;/);
  assert.match(src, /alreadyUsed: false,/, "the sync /extract path sets it too");
});
