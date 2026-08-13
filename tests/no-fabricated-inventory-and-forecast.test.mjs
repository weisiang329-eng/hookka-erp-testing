// ---------------------------------------------------------------------------
// no-fabricated-inventory-and-forecast.test.mjs — the fifth appearance of one
// bug class, pinned so there cannot be a sixth.
//
// The four already guarded (tests/no-fabricated-efficiency.test.mjs,
// tests/no-fabricated-worker-metrics.test.mjs,
// tests/no-fabricated-financials.test.mjs):
//   BUG-2026-08-13-004  department efficiency divided an estimate by itself
//   BUG-2026-08-13-005  a dead request rendered as "No data available"
//   BUG-2026-08-13-006  worker metrics came out of seed(w.id)
//   BUG-2026-08-13-009  COGS was revenue × 0.65; opex was four constants
//
// This file covers BUG-2026-08-13-014, which is the same class in seven more
// places:
//
//   A  /api/inventory returned `stockQty: 0` for every finished product — an
//      assertion of "nothing on hand" that five screens printed as a measured
//      quantity, one of them multiplying it by a SELL price to publish an
//      "Amount" of RM 0.00 per SKU.
//   B  Reports › Inventory summed `costPriceSen` with NO QUANTITY and titled
//      the result "Stock Valuation by Category" — and exported it to CSV.
//   C  the same table's "Avg Sell Price" column rendered `p.sizeLabel`.
//   D  /analytics/forecast returned a literal `accuracy: 84.2` on a branch
//      that is always taken, plus a `capacity: 220` reference line and a
//      frozen `["2026-05" … "2026-10"]` window.
//   E  its Accuracy tab published `100 - 0 = 100%` off an empty set.
//   F  POST /api/payroll invented overtime with Math.random() and INSERTed the
//      resulting gross/net pay into payroll_records.
//   G  PUT /api/e-invoices/:id {action:"submit"} minted a random LHDN
//      submission ID and UUID and marked the row VALID, with no LHDN client
//      anywhere in the repo.
//
// STRUCTURAL, for the reason the sibling files give: every one of these is a
// one-token edit away from returning, and no runtime assertion catches a
// number that is merely wrong-but-plausible.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

/** Strip comments — a comment must be free to quote the bug it replaced. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** The body of a named function/const in a file, comments stripped. */
function sliceFn(rel, marker, { comments = false } = {}) {
  const src = read(rel);
  const start = src.indexOf(marker);
  assert.ok(start > 0, `${rel} must still define ${marker}`);
  const end = src.indexOf("\nfunction ", start + marker.length);
  const slice = src.slice(start, end > start ? end : undefined);
  return comments ? slice : stripComments(slice);
}

// ===========================================================================
// A — the API must not assert a finished-goods quantity it did not compute
// ===========================================================================

test("GET /api/inventory does not fabricate a finished-goods stockQty", () => {
  const src = stripComments(read("src/api/routes/inventory.ts"));

  assert.ok(
    !/stockQty:\s*0\b/.test(src),
    "inventory.ts: `stockQty: 0` claims every product has nothing on hand. " +
      "This endpoint does not compute FG stock — emit null and let " +
      "GET /api/inventory/fg-stock answer the question.",
  );
  assert.match(
    src,
    /stockQty:\s*null as number \| null/,
    "inventory.ts: finishedProducts.stockQty must be explicitly null so a " +
      "consumer cannot mistake 'not computed' for 'zero'.",
  );
  // The real source must still exist — the over-correction to guard against is
  // deleting the derivation while cleaning up the fake.
  assert.ok(
    read("src/api/routes/inventory.ts").includes('app.get("/fg-stock"'),
    "inventory.ts: GET /fg-stock is the only real FG on-hand source; it must " +
      "not be removed while tidying up the fabricated one.",
  );
});

test("no screen coerces the absent FG quantity back into a number", () => {
  // `p.stockQty ?? 0` is the exact respelling that turns null back into the
  // fabricated zero. Each of these five sites had it.
  for (const rel of [
    "src/pages/inventory/adjustments.tsx",
    "src/pages/service-cases/detail.tsx",
    "src/pages/service-orders/detail.tsx",
    "src/pages/service-orders/index.tsx",
    "src/pages/m/config/modules.ts",
  ]) {
    const src = stripComments(read(rel));
    assert.ok(
      !/\bstockQty\s*\?\?\s*0/.test(src),
      `${rel}: \`stockQty ?? 0\` re-creates the fabricated "0 on hand". ` +
        'Render "—", or read GET /api/inventory/fg-stock.',
    );
    assert.ok(
      !/\{\s*f\.stockQty[^}]*\}\s*on hand/.test(src),
      `${rel}: a "(N on hand)" label fed from /api/inventory is not a ` +
        "measurement — that payload does not carry a quantity.",
    );
  }
});

test("the mobile Inventory tabs publish no quantity and no value", () => {
  const src = stripComments(read("src/pages/m/config/modules.ts"));

  // Amount = price × quantity, where the quantity was always 0 AND the price
  // was the SELLING price. Both halves must stay gone.
  assert.ok(
    !/basePriceSen[^\n]*\*\s*num\(r,\s*"stockQty"\)/.test(src),
    "modules.ts: an Amount computed as sell-price × a stock quantity this " +
      "payload does not carry is a fabricated stock value twice over.",
  );
  // Scoped to the two sources that select `finishedProducts`. `wipSource`
  // reads `stockQty` off the SAME payload and that is correct —
  // `wip_items.stockQty` is a real running balance — so a file-wide ban would
  // be wrong here.
  for (const name of ["finishedGoodsSource", "stockValueSource"]) {
    const start = src.indexOf(`const ${name}: DataSource = {`);
    assert.ok(start > 0, `modules.ts must still define ${name}`);
    const body = src.slice(start, src.indexOf("\n};", start));
    assert.ok(
      body.includes('selectNested("data", "finishedProducts")'),
      `${name} is expected to read finishedProducts — re-scope this guard if ` +
        "that changed.",
    );
    assert.ok(
      !/stockQty/.test(body),
      `modules.ts: ${name} must not read stockQty — /api/inventory does not ` +
        "compute a finished-goods quantity, so every row rendered 0.",
    );
    assert.ok(
      body.includes("FG_QTY_UNAVAILABLE"),
      `modules.ts: ${name} must render "—" for the figures it cannot source.`,
    );
  }
  // WIP's real balance, on the other hand, must keep flowing: the tab read a
  // key (`data.wip`) the endpoint never sent, so it drew an empty state over a
  // payload that had the rows.
  assert.ok(
    src.includes('selectNested("data", "wipItems")'),
    "modules.ts: the WIP tab must read `wipItems` — the key /api/inventory " +
      'actually sends. `data.wip` does not exist and rendered as "no data".',
  );
});

test("a cost prefill comes from the cost price, never the sell price", () => {
  // Both screens posted `unitCostSen` into the stock/cost ledger, prefilled
  // from `basePriceSen` — the retail price.
  for (const rel of [
    "src/pages/inventory/adjustments.tsx",
    "src/pages/service-cases/detail.tsx",
  ]) {
    const src = stripComments(read(rel));
    assert.ok(
      !/unitCostSen:\s*\w*\.?basePriceSen/.test(src),
      `${rel}: unitCostSen prefilled from basePriceSen values a stock ` +
        "movement at the SELLING price. Use costPriceSen.",
    );
    assert.ok(
      /unitCostSen:\s*\w+\.costPriceSen/.test(src),
      `${rel}: the unit-cost prefill must read costPriceSen.`,
    );
  }
});

// ===========================================================================
// B + C — Reports › Inventory
// ===========================================================================

const inventoryTab = () => sliceFn("src/pages/reports.tsx", "function InventoryReportTab()");

test("stock valuation multiplies a quantity by a cost", () => {
  const tab = inventoryTab();

  assert.ok(
    !/totalValue\s*\+=\s*p\.costPriceSen\s*;/.test(tab),
    "reports.tsx: `totalValue += p.costPriceSen` is a sum of price tags with " +
      "no quantity in it. Adding a SKU to the catalog cannot increase the " +
      "value of stock on hand.",
  );
  assert.ok(
    tab.includes("/api/inventory/fg-stock"),
    "reports.tsx: on-hand units must come from /api/inventory/fg-stock — the " +
      "only real finished-goods quantity in the app.",
  );
  assert.ok(
    /valueSen\s*\+=\s*qty\s*\*\s*p\.costPriceSen/.test(tab),
    "reports.tsx: stock value must be on-hand units × cost price.",
  );
  // Provenance, the "Measured Cards" precedent from BUG-2026-08-13-004: the
  // reader is told how much of the stock the valuation actually covers.
  assert.ok(
    tab.includes("Valuation Basis"),
    "reports.tsx: the table must publish how many of the on-hand units carry " +
      "a cost price behind the value.",
  );
  assert.ok(
    /costedProducts > 0 \? formatCurrency\(roundSen\(v\.valueSen\)\) : NO_FIGURE/.test(tab),
    "reports.tsx: a category with no costed unit publishes “—”, not RM 0.00. " +
      "Zero costed products is not a stock value of nothing.",
  );
});

test("a failed quantity read is not rendered as zero stock", () => {
  const tab = inventoryTab();
  assert.ok(
    /const qtyCell = \(n: number\) => \(haveStock \? String\(n\) : NO_FIGURE\)/.test(tab),
    "reports.tsx: when the stock endpoint did not load, every quantity must " +
      'read "—". Unknown and zero are different claims (BUG-2026-08-13-005).',
  );
  assert.ok(
    tab.includes("fgStockError"),
    "reports.tsx: a failed stock read must be said out loud on the page.",
  );
});

test("every column header names the field the cell renders", () => {
  const tab = inventoryTab();

  assert.ok(
    !tab.includes('"Avg Sell Price"'),
    'reports.tsx: the "Avg Sell Price" column rendered p.sizeLabel, on screen ' +
      "and in the CSV. `products` has no average-sell-price field; which of " +
      "basePriceSen / price1Sen / seatHeightPrices would be one is an owner " +
      "decision, so the column is named for what it shows.",
  );
  // One headers array, used by BOTH the table and the CSV — an export that
  // drifts from the screen re-creates the bug in a spreadsheet.
  for (const shared of ["catHeaders", "detailHeaders"]) {
    assert.equal(
      (tab.match(new RegExp(`\\b${shared}\\b`, "g")) ?? []).length >= 3,
      true,
      `reports.tsx: ${shared} must be declared once and passed to both the ` +
        "ReportTable and the downloadCSV call.",
    );
  }
  assert.ok(
    !/downloadCSV\(\s*"stock-valuation.csv",\s*\[/.test(tab),
    "reports.tsx: the stock-valuation CSV must reuse catHeaders, not carry " +
      "its own literal header list that can drift from the table.",
  );
});

// ===========================================================================
// D + E — /analytics/forecast
// ===========================================================================

test("forecast accuracy is measured or it is a dash — never 84.2", () => {
  const src = stripComments(read("src/pages/analytics/forecast.tsx"));

  assert.ok(
    !/accuracy:\s*84\.2/.test(src),
    "forecast.tsx: `accuracy: 84.2` was a literal on a branch that is always " +
      "taken — forecast_entries.actualQty has no writer, so no forecast can " +
      "ever have an actual to score against.",
  );
  assert.ok(
    /accuracy:\s*null/.test(src),
    "forecast.tsx: with no recorded actual the accuracy must be null.",
  );
  assert.ok(
    src.includes("accuracyData.accuracy === null ? NO_FIGURE"),
    'forecast.tsx: a null accuracy must render "—" with the reason beside it.',
  );
});

test("no capacity line and no frozen month window", () => {
  const src = stripComments(read("src/pages/analytics/forecast.tsx"));

  assert.ok(
    !/capacity:\s*220/.test(src) && !src.includes("Capacity (220/mo)"),
    "forecast.tsx: 220 units/month came from no table, no config and no " +
      "calculation, and the forecast was drawn against it as a reference line.",
  );
  assert.ok(
    !/\["2026-05",\s*"2026-06"/.test(src),
    'forecast.tsx: the "6-month forecast" window was a frozen literal array; ' +
      "three of its six months were already in the past.",
  );
  assert.ok(
    !/period === "2026-05"/.test(src) && !src.includes("May Forecast"),
    'forecast.tsx: the "next forecast" column was pinned to the literal ' +
      "period 2026-05 under a header that said May.",
  );
  assert.ok(
    src.includes("periodFromNow("),
    "forecast.tsx: forecast periods must be derived from the current month.",
  );
});

test("an empty back-test scores nothing, not 100%", () => {
  const src = stripComments(read("src/pages/analytics/forecast.tsx"));

  assert.ok(
    !/if \(comparisonData\.length === 0\) return 0;/.test(src),
    "forecast.tsx: returning 0 MAPE for an empty set made the card print " +
      "`100 - 0 = 100%` — a perfect accuracy score off no data at all.",
  );
  assert.ok(
    /overallMape === null \? null : Math\.round\(\(100 - overallMape\)/.test(src),
    "forecast.tsx: accuracy must be null whenever there is no scored month.",
  );
  // The back-test must not be captioned as something the business forecast.
  assert.ok(
    !src.includes("Forecast vs Actual Comparison") &&
      !src.includes("Forecast vs actual comparisons"),
    "forecast.tsx: the SMA-3 column is computed here, now, from the same " +
      "actuals it is scored against. It is a back-test, and must say so.",
  );
});

test("month arithmetic folds the per-customer rows first", () => {
  const src = stripComments(read("src/pages/analytics/forecast.tsx"));
  assert.ok(
    src.includes("function byPeriod("),
    "forecast.tsx: historical_sales is one row per product PER MONTH PER " +
      "CUSTOMER (historical-sales.ts groups by period, productCode, " +
      "customerId). Anything calling slice(-3) 'the last 3 months' must fold " +
      "to one row per period first.",
  );
  assert.ok(
    !/historicalSales\s*\n?\s*\.filter\(\(s\) => s\.productId === [\w.]+\)\s*\n?\s*\.sort\(/.test(src),
    "forecast.tsx: a raw filter+sort over historicalSales indexes customer " +
      "rows as if they were months. Use byPeriod().",
  );
});

test("the per-product Material Status column is gone", () => {
  const route = stripComments(read("src/api/routes/promise-date.ts"));
  const page = stripComments(read("src/pages/analytics/forecast.tsx"));

  assert.ok(
    /materialAvailability:\s*null/.test(route),
    "promise-date.ts: materialAvailability is ONE whole-table reading of " +
      "raw_materials stamped onto every product — no BOM is consulted. It " +
      "must not be published under a per-product name.",
  );
  assert.ok(
    route.includes("orgMaterialAvailability: stockStatus"),
    "promise-date.ts: the org-wide reading must travel under a name that " +
      "says it is org-wide.",
  );
  assert.ok(
    !/\{p\.materialAvailability\.replace/.test(page),
    "forecast.tsx: the All-Products table rendered the identical org-wide " +
      "value in a per-product Materials column.",
  );
});

// ===========================================================================
// F — payroll
// ===========================================================================

test("payroll never invents overtime", () => {
  const src = stripComments(read("src/api/routes/payroll.ts"));

  assert.ok(
    !/Math\.random\(\)/.test(src),
    "payroll.ts: overtime hours were three Math.random() calls, multiplied " +
      "by 1.5x / 2.0x / 3.0x an hourly rate and INSERTed into payroll_records " +
      "as gross and net pay. Money is never a dice roll.",
  );
  assert.ok(
    !/INSERT (OR IGNORE )?INTO payroll_records/i.test(src),
    "payroll.ts: this route must not write payroll_records at all. The real " +
      "engine is POST /api/payslips (computeMonthlyLabor over " +
      "working_hour_entries); a second writer is how two net-pay figures come " +
      "to disagree.",
  );
  assert.ok(
    /501,/.test(src) && src.includes("POST /api/payslips"),
    "payroll.ts: POST must refuse and name the real payroll endpoint.",
  );
  // The over-correction to guard against: deleting the measured engine too.
  const payslips = read("src/api/routes/payslips.ts");
  assert.ok(
    payslips.includes("computeMonthlyLabor"),
    "payslips.ts must keep computing payroll from labor-engine — it is the " +
      "measured path and must not be swept up in this cleanup.",
  );
});

// ===========================================================================
// G — e-invoice / LHDN
// ===========================================================================

test("no LHDN identifier is minted locally", () => {
  const src = stripComments(read("src/api/routes/e-invoices.ts"));

  assert.ok(
    !/LHDN-SUB-/.test(src),
    "e-invoices.ts: a `LHDN-SUB-…` submission ID built from Math.random() is " +
      "a government reference that no government issued.",
  );
  assert.ok(
    !/Math\.random\(\)/.test(src),
    "e-invoices.ts: the clearance UUID was 15 random characters. There is no " +
      "LHDN/MyInvois client in this repo — nothing was ever transmitted.",
  );
  assert.ok(
    !/\.bind\(\s*"VALID"/.test(src),
    "e-invoices.ts: the submit action flipped the row straight to VALID with " +
      'the comment "Mock auto-validation", and the page painted a green badge.',
  );
  assert.ok(
    src.includes('body.action === "submit"') && /501,/.test(src),
    "e-invoices.ts: submit must refuse until a real MyInvois integration " +
      "exists, and say why.",
  );
});

test("the e-invoice page surfaces the refusal and its own limits", () => {
  const src = read("src/pages/invoices/e-invoice.tsx");
  assert.ok(
    src.includes("setSubmitError"),
    "e-invoice.tsx: submitToLHDN threw the response away, so a failure " +
      "looked like a button that did nothing.",
  );
  assert.ok(
    src.includes("Not connected to LHDN."),
    "e-invoice.tsx: the page must say that nothing is transmitted, and that " +
      "rows already marked VALID were stamped locally.",
  );
});

// ===========================================================================
// The standing rule, applied to the files this sweep touched
// ===========================================================================

test("no fabrication marker sits next to a rendered value in the swept files", () => {
  // Comments are KEPT here on purpose: the marker itself is what is banned.
  // The explanatory headers written by this fix say "Mock auto-validation" only
  // inside a quotation of what was removed, so the pattern is anchored to the
  // shapes that actually produced a number.
  const banned = [
    [/\/\/\s*Mock accuracy/i, "a mock value behind a rendered KPI"],
    [/\/\/\s*220 units\/month capacity/i, "an invented capacity constant"],
    [/=\s*84\.2\b/, "the 84.2 accuracy literal"],
  ];
  for (const rel of [
    "src/pages/analytics/forecast.tsx",
    "src/pages/reports.tsx",
    "src/api/routes/inventory.ts",
  ]) {
    const src = read(rel);
    for (const [re, what] of banned) {
      assert.ok(!re.test(src), `${rel}: ${what} is back.`);
    }
  }
});
