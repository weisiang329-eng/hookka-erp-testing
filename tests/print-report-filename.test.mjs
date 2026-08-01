// ---------------------------------------------------------------------------
// print-report-filename.test.mjs
//
// A print-to-PDF is named after the document <title>. The shared report engine
// used a constant "<report> - Hookka", so every month of every one of the eight
// report tabs saved as the SAME file — "Payroll - Hookka.pdf" — and HR's folder
// filled with collisions (owner 2026-08-01, from the macOS save dialog).
//
// The title now carries the period. These cases pin the two things that make it
// safe: it must be derived from what the operator is actually looking at, and it
// must never contain a character the OS rejects in a file name — a date range
// like "01/07/2026 – 31/07/2026" would otherwise turn into path separators.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const { buildReportHTML } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/print-report.ts")).href
);

const titleOf = (opts) =>
  /<title>(.*?)<\/title>/.exec(
    buildReportHTML({ columns: [], rows: [], ...opts }),
  )[1];

test("the period lands in the file name", () => {
  assert.equal(
    titleOf({ title: "Payroll", filterSummary: "July 2026" }),
    "Payroll — July 2026 · Hookka",
  );
});

test("only the leading segment of the filter line is used", () => {
  // Payroll's filter line carries an estimate note; the file name wants the period.
  assert.equal(
    titleOf({ title: "Payroll", filterSummary: "July 2026 · Estimate (month in progress)" }),
    "Payroll — July 2026 · Hookka",
  );
});

test("a date range cannot inject path separators", () => {
  const t = titleOf({
    title: "Labor Cost",
    filterSummary: "01/07/2026 – 31/07/2026 · All categories",
  });
  assert.equal(t, "Labor Cost — 01-07-2026 – 31-07-2026 · Hookka");
  for (const bad of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!t.includes(bad), `file name must not contain ${bad}`);
  }
});

test("fileLabel overrides the derived label", () => {
  assert.equal(
    titleOf({ title: "Payroll", filterSummary: "anything", fileLabel: "2026-07" }),
    "Payroll — 2026-07 · Hookka",
  );
});

test("an empty filter line falls back to the old name", () => {
  assert.equal(titleOf({ title: "Payroll", filterSummary: "" }), "Payroll - Hookka");
});

test("an absurdly long label is capped", () => {
  const t = titleOf({ title: "X", filterSummary: "y".repeat(200) });
  assert.ok(t.length < 80, t.length);
});
