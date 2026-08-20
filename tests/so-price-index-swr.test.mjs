// Serve-stale on the sales-order snapshot is bound to the dashboard's
// price-index projection, and must stay that way.
//
// One snapshot (`sales_orders_list_snapshot`) backs two very different callers:
//
//   * the Sales LIST — a working screen. A salesperson creates an order,
//     reloads, and expects to see it. Serving them the previous copy is a
//     worse bug than a slow dashboard.
//   * the dashboard's Pending-Delivery tile (`?fields=price-index`) — reads
//     unit prices to size a figure. Nobody watches it for their own edit, so a
//     few seconds of staleness is invisible, and the snapshot is a whole
//     SELECT * over ~720 orders and their items: 30s cold, measured live.
//
// The abandoned perf branch applied serve-stale to BOTH. This pins the
// narrower rule, because the difference is invisible in a diff and someone
// will eventually "simplify" the conditional away.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/api/routes/sales-orders.ts", import.meta.url),
  "utf8",
);

// There are FIVE withSnapshot calls against this one snapshot table, which is
// the whole reason these tests exist: the dashboard's narrow `price-index`
// read and the Sales list's `computeFullList` share a cache table and need
// OPPOSITE freshness. Select a call by the compute function it passes, never
// by "the first one that mentions the table" — an earlier version of this test
// did exactly that and happily passed while the flag sat on the wrong call,
// where it was unreachable dead code.
function snapshotCall(computeFn) {
  // Match the name only where it stands alone as an ARGUMENT on its own line.
  // A plain indexOf finds it inside a comment first ("it also projected
  // computeFullList, so the Delivery page…"), which has no withSnapshot before
  // it and made this helper return nothing — the second way this test caught
  // itself being wrong.
  const arg = new RegExp("^\\s*" + computeFn + ",\\s*$", "m");
  const m = arg.exec(src);
  assert.notEqual(m, null, `no withSnapshot call passing ${computeFn}`);
  const at = m.index;
  const open = src.lastIndexOf("withSnapshot(", at);
  assert.notEqual(open, -1, `no withSnapshot( before ${computeFn}`);
  // Walk to the matching close paren so the assertions cannot drift into
  // neighbouring code.
  let depth = 0;
  for (let i = src.indexOf("(", open); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced parentheses in the withSnapshot call");
}

test("the dashboard's price-index read serves stale", () => {
  assert.match(snapshotCall("computePriceIndex"), /staleWhileRevalidate: true/);
});

test("the Sales LIST does NOT serve stale", () => {
  // The working screen. Serving a salesperson the previous copy means the
  // order they just created is missing from their own list.
  assert.doesNotMatch(
    snapshotCall("computeFullList"),
    /staleWhileRevalidate/,
    "the full list must block for a fresh build",
  );
});

test("the price-index read keeps its own cache key", () => {
  // Sharing the full list's empty key would make the two reads overwrite each
  // other's snapshot, and the narrow one would inherit the wide one's cost.
  assert.match(snapshotCall("computePriceIndex"), /"price-index"/);
});

test("both source tables are still declared, so writes still invalidate", () => {
  // Drop either and the staleness stops being one refresh long and becomes
  // unbounded.
  const call = snapshotCall("computePriceIndex");
  assert.match(call, /"sales_orders"/);
  assert.match(call, /"sales_order_items"/);
});

test("the snapshot helper actually supports the option being passed", () => {
  // Passing an option the helper ignores would look correct and do nothing.
  const snap = readFileSync(
    new URL("../src/api/lib/snapshot.ts", import.meta.url),
    "utf8",
  );
  assert.match(snap, /staleWhileRevalidate\?: boolean/);
  assert.match(snap, /if \(opts\?\.staleWhileRevalidate && snap\)/);
});
