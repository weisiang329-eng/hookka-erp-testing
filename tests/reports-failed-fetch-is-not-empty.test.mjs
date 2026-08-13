// ---------------------------------------------------------------------------
// reports-failed-fetch-is-not-empty.test.mjs
//
// BUG-2026-08-13-005. Reports › Production rendered an EMPTY Department
// Efficiency table captioned "No data available" for 2026-06-14 → 2026-08-13 —
// a window in which prod completed 370 job cards on 08-11 and 367 on 08-12. The
// table was empty because the fetch had been KILLED at 30,012 ms by
// api-client's 30 s global abort, not because nothing had happened.
//
// Two independent defects produced that:
//
//   1. the tab fetched BARE `/api/production-orders` — every PO in the org with
//      every job card — purely to aggregate it in the browser; and
//   2. every tab wrote the failure into state as emptiness
//      (`catch { setData([]) }`, plus `cachedFetchJson` returning `null` on
//      failure so `json?.data || []` did the same thing without a throw), and
//      `ReportTable` then printed "No data available" — a factual claim about
//      the business — over a dead request.
//
// This file guards BOTH, and guards them for EVERY tab, because (2) was a
// page-wide pattern and fixing only the flagged instance is the repeat failure
// this repo tracks in docs/BUG-CLASSES.md.
//
// Structural (readFileSync) by the repo idiom: both regressions are one-token
// edits and no runtime assertion can tell an honest empty range from a silent
// failure — that is precisely the confusion being outlawed.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const REPORTS = "src/pages/reports.tsx";

// The five tabs on the Reports hub, by the component that owns each one.
const TABS = [
  "SalesReportTab",
  "ProductionReportTab",
  "InventoryReportTab",
  "FinancialReportTab",
  "EmployeeReportTab",
];

function tabSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${REPORTS}: ${name} not found`);
  // Up to the next top-level `function ` declaration.
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next > 0 ? next : src.length);
}

// Comments in this file quote the very URLs the assertions forbid (that is how
// the bug is documented at its fix site). Strip line comments before matching
// on URLs, or the guard fires on its own explanation.
function stripLineComments(s) {
  return s.replace(/^[ \t]*\/\/.*$/gm, "");
}

test("no Reports tab turns a failed fetch into an empty dataset", () => {
  const src = read(REPORTS);

  // `cachedFetchJson` cannot report failure — it returns null for a timeout, a
  // 500, an abort and a genuinely absent body alike. A report page must use
  // the variant that says which happened.
  assert.ok(
    !/\bcachedFetchJson\s*</.test(src) && !/\bcachedFetchJson\s*\(/.test(src),
    `${REPORTS}: use cachedFetchJsonResult — cachedFetchJson returns null on ` +
      "failure, which the page cannot distinguish from an empty range.",
  );
  assert.ok(
    src.includes("cachedFetchJsonResult"),
    `${REPORTS}: must fetch through cachedFetchJsonResult`,
  );

  for (const tab of TABS) {
    const body = tabSource(src, tab);

    // The literal shape of the bug: swallow the error, store emptiness.
    assert.ok(
      !/catch\s*(\([^)]*\))?\s*\{\s*set\w+\(\s*(\[\s*\]|\{[^}]*\[\s*\][^}]*\})\s*\)/.test(
        body,
      ),
      `${REPORTS} › ${tab}: a catch block that stores [] makes a dead request ` +
        'render as "No data available".',
    );

    // Every tab must check the result and be able to say it failed.
    assert.ok(
      /!\w+(?:Res)?\.ok\b/.test(body),
      `${REPORTS} › ${tab}: must branch on the fetch result's ok flag`,
    );
    assert.ok(
      body.includes("setError("),
      `${REPORTS} › ${tab}: must record the failure message`,
    );
    assert.ok(
      body.includes("<ReportError"),
      `${REPORTS} › ${tab}: must render <ReportError> so the operator is told ` +
        "the report could not load, with a retry",
    );
  }
});

test("ReportError says the emptiness is missing data, not absent activity", () => {
  const src = read(REPORTS);
  const start = src.indexOf("function ReportError(");
  assert.ok(start > 0, `${REPORTS}: ReportError component must exist`);
  const body = src.slice(start, src.indexOf("\nfunction ", start + 1));
  assert.ok(
    /not\s+a statement that there was no activity/.test(body),
    `${REPORTS}: the failure card must explicitly deny the "nothing happened" ` +
      "reading — that inference is the damage this bug caused.",
  );
  assert.ok(
    /onRetry/.test(body),
    `${REPORTS}: the failure card must offer a retry`,
  );
});

test("Reports > Production never fetches the whole org's production orders", () => {
  const body = stripLineComments(
    tabSource(read(REPORTS), "ProductionReportTab"),
  );

  // The bare list read — 2,539 POs with every job card, 30,012 ms on prod,
  // past api-client's 30 s abort. Same family as BUG-2026-08-13-001/-002/-003.
  assert.ok(
    !/["'`]\/api\/production-orders(\?[^"'`]*)?["'`]/.test(body),
    `${REPORTS} › ProductionReportTab: a bare /api/production-orders read ` +
      "downloads every order with every job card and is killed by the 30 s " +
      "global abort. Aggregate server-side instead.",
  );
  assert.ok(
    !body.includes("include=jobCards"),
    `${REPORTS} › ProductionReportTab: job cards must never reach the browser ` +
      "here — the department roll-up is computed in SQL.",
  );
  assert.ok(
    body.includes("/api/production-orders/report-summary?from="),
    `${REPORTS} › ProductionReportTab: must read the windowed server aggregate`,
  );
});

test("the report-summary endpoint refuses an unwindowed scan", () => {
  const src = read("src/api/routes/production-orders.ts");
  const start = src.indexOf('app.get("/report-summary"');
  assert.ok(start > 0, "GET /report-summary must exist");
  const body = src.slice(start, start + 8000);
  assert.match(
    body,
    /if \(!isDate\(fromRaw\) \|\| !isDate\(toRaw\)\) \{[\s\S]{0,400}400,?\s*\n?\s*\);/,
    "report-summary: a missing/invalid from|to must 400, not silently scan " +
      "the whole table — an unbounded aggregate is how this got slow before.",
  );
  // Registered before the /:id catch-all, or "report-summary" is read as an id.
  assert.ok(
    start < src.indexOf('app.get("/:id"'),
    "report-summary must be registered before the /:id route",
  );
});
