// ---------------------------------------------------------------------------
// dashboard-forecast-pct.test.mjs — a forecast percentage divides by FORECAST
// revenue.
//
// BUG-2026-08-06-002. The Cost Structure card built its target share as
// `fc / sales`, where `sales` is the ACTUAL revenue of that period. In a month
// only part-billed that reads a plan against a stub: 2026-08 showed
// 45,000 / 37,098 = 121.30% for a target that is 15% of the 300,000 planned.
// The owner spotted it the moment the forecast column was split out and the
// 300,000 sat beside the 121.30% (「他应该是我 forecast 的 percentage，而不是
// 出 actual 的 percentage」). It was equally wrong before the split, just
// hidden inside the actual cell as "(fc 121.30%)".
//
// Comparing the two only means anything when each is a share of its own
// revenue. The Income Statement card already did this correctly, which is what
// makes the rule the right one rather than a matter of taste.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/pages/finance-dashboard.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

test("there is a forecast-revenue base, distinct from the actual one", () => {
  assert.match(SRC, /const csForecastSales = \(r: Row\): number \| null =>/);
  assert.match(SRC, /const fs = r\.forecast\?\.sales \?\? null;/);
});

test("the cost-structure target share divides by it", () => {
  assert.match(SRC, /fc !== null && fcSales !== null && fcSales > 0\n\s*\? Math\.round\(\(fc \/ fcSales\) \* 10000\) \/ 100/);
});

test("no forecast percentage divides by the ACTUAL sales any more", () => {
  assert.doesNotMatch(SRC, /__fcpct__\$\{cat\}`\] =[\s\S]{0,120}fc \/ sales/);
  assert.doesNotMatch(SRC, /forecastPct: fc !== null && sales > 0/);
});

test("the actual share still divides by the ACTUAL sales", () => {
  // The fix must not swap both sides onto the same base.
  assert.match(SRC, /point\[`__pct__\$\{cat\}`\] = sales > 0 \? Math\.round\(\(amt \/ sales\) \* 10000\) \/ 100 : null;/);
  assert.match(SRC, /pct: sales > 0 \? Math\.round\(\(amt \/ sales\) \* 10000\) \/ 100 : null,/);
});

test("a line view pro-rates the forecast revenue the same way the target is", () => {
  const fn = SRC.slice(SRC.indexOf("const csForecastSales"));
  assert.match(fn.slice(0, 700), /csLine === "bedframe" \? s\.bedframe : s\.sofa/);
});

test("the Income Statement card — already correct — still uses forecast sales", () => {
  assert.match(SRC, /forecastPctOfRevenue: share\(pick\(r\.forecast\), fcSales\)/);
});
