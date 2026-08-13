// ---------------------------------------------------------------------------
// no-fabricated-financials.test.mjs — a money figure on Reports › Financial
// must come from a source, or it must be a dash. It may never be a constant,
// and it may never be a fixed ratio of another figure.
//
// This is the FOURTH appearance of one bug class in a single day:
//   BUG-2026-08-13-004  Department Efficiency divided an estimate by itself
//   BUG-2026-08-13-006  Worker Efficiency came out of seed(w.id), a hash of
//                       the worker's primary key; "94.5%" / "8.7" / "12.5"
//                       were typed into the source
//   BUG-2026-08-13-005  a dead 30 s request rendered as "No data available"
//   BUG-2026-08-13-009  the P&L's COGS was `revenue * 0.65` and Salaries /
//                       Utilities / Rent / Others were 5000000 / 800000 /
//                       1500000 / 500000 sen, hardcoded — and gross profit,
//                       net profit and both margins were arithmetic on them
//
// Sibling of tests/no-fabricated-efficiency.test.mjs and
// tests/no-fabricated-worker-metrics.test.mjs, and STRUCTURAL for the same
// reason they are: re-introducing `revenue * 0.65` is a one-token edit, and no
// runtime assertion catches a number that is merely wrong-but-plausible.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// The Financial tab, sliced out so a constant elsewhere on the page (a colour,
// a page size, a timeout) cannot fail these assertions and so nothing outside
// the tab can satisfy them either.
//
// Comments are stripped. A comment cannot fabricate a figure, and the entry
// this file guards is only readable if the code is allowed to explain what it
// replaced — quoting `revenue * 0.65` in a warning must not trip the warning.
function financialTab({ comments = false } = {}) {
  const src = read("src/pages/reports.tsx");
  const start = src.indexOf("function FinancialReportTab()");
  assert.ok(start > 0, "reports.tsx must still define FinancialReportTab");
  const end = src.indexOf("\nfunction ", start + 10);
  assert.ok(end > start, "could not find the end of FinancialReportTab");
  // Normalised to LF first: the working tree checks out CRLF on Windows, and
  // a `$`-anchored strip silently does nothing against a trailing \r.
  const slice = src.slice(start, end).replace(/\r\n/g, "\n");
  if (comments) return slice;
  return slice
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

test("no P&L figure is a fixed ratio of another figure", () => {
  const tab = financialTab();

  // The exact bug, plus the obvious respellings of it. A margin assumption is
  // not a cost of goods sold; it is the answer the reader came to find,
  // handed back to them as if it had been measured.
  for (const bad of [
    "revenue * 0.65",
    "revenue*0.65",
    "0.65 * revenue",
    "revenue * 0.35",
  ]) {
    assert.ok(
      !tab.includes(bad),
      `reports.tsx: "${bad}" is an assumed margin wearing the costume of an ` +
        "account balance. COGS must come from posted COST accounts or read “—”.",
    );
  }

  // Any literal decimal multiplier applied to a money variable is the same
  // bug under another number. Percentages of a total that the page itself
  // computed (`/ net * 100`) are fine; a magic coefficient is not.
  const ratio = tab.match(/\b(revenue|invoicedSen|totalSen|grossProfit|netProfit)\w*\s*\*\s*0\.\d+/i);
  assert.equal(
    ratio,
    null,
    `reports.tsx: "${ratio?.[0]}" derives one money figure from another by a ` +
      "hardcoded coefficient.",
  );
});

test("the four hardcoded operating-expense constants are gone", () => {
  const tab = financialTab();

  // RM 50,000 salaries · RM 8,000 utilities · RM 15,000 rent · RM 5,000 others,
  // in sen, exactly as they were written.
  for (const [sen, what] of [
    ["5000000", "Salaries & Wages RM 50,000"],
    ["800000", "Utilities RM 8,000"],
    ["1500000", "Rent RM 15,000"],
    ["500000", "Others RM 5,000"],
  ]) {
    assert.ok(
      !new RegExp(`(?<![\\d.])${sen}(?![\\d.])`).test(tab),
      `reports.tsx: the literal ${sen} sen (${what}) is back in the Financial ` +
        "tab. An expense line is a posted account or it is a dash.",
    );
  }

  // And the labels those constants were rendered under. The page must not
  // assert that some set of accounts IS "Rent" or "Utilities" — that is a
  // chart-of-accounts decision, and it belongs to the owner.
  for (const label of [
    '"  Salaries & Wages"',
    '"  Utilities"',
    '"  Rent"',
    '"  Others"',
  ]) {
    assert.ok(
      !tab.includes(label),
      `reports.tsx: the invented expense line ${label} is back. Expense lines ` +
        "are listed under their own GL account code and name.",
    );
  }
});

test("the P&L is read from the posted ledger, per account", () => {
  const tab = financialTab();

  assert.ok(
    tab.includes('cachedFetchJsonResult<{ data?: LedgerPl }>("/api/accounting/pl")'),
    "reports.tsx: the P&L must be fetched from /api/accounting/pl — the " +
      "posted general ledger classified by each account's own type.",
  );

  // Provenance, the BUG-2026-08-13-004 "Measured Cards" precedent: the reader
  // is told how many accounts stand behind each subtotal, so a total resting
  // on one account cannot read like a set of books.
  for (const cat of ["REVENUE", "COGS", "OPERATING_EXPENSE"]) {
    assert.ok(
      tab.includes(`inCategory("${cat}")`),
      `reports.tsx: the ${cat} account count must be derived from the ledger ` +
        "entries so it can be published beside the figure.",
    );
  }
  assert.ok(
    tab.includes("account${n === 1 ? \"\" : \"s\"} posted"),
    "reports.tsx: each subtotal must print how many accounts are posted " +
      "behind it.",
  );
  assert.equal(
    (tab.match(/"Accounts Posted"/g) ?? []).length,
    1,
    "reports.tsx: the CSV the operator downloads must carry the accounts-" +
      "posted column too — an export that drops the provenance re-creates the " +
      "bug in a spreadsheet.",
  );
});

test("an unsourced line is a dash, and a total inherits the dash", () => {
  const tab = financialTab();

  // Zero posted accounts is not RM 0.00. The business did not spend nothing;
  // nobody booked it.
  assert.match(
    tab,
    /const sourced = \(n: number, v: number \| undefined\): string =>\s*\n?\s*n > 0 && v !== undefined \? formatCurrency\(roundSen\(v\)\) : NO_FIGURE/,
    "reports.tsx: a figure may only be published when at least one account " +
      'behind it carries a posting; otherwise "—".',
  );
  assert.match(
    tab,
    /const derived = \(deps: number\[\], v: number \| undefined\): string =>\s*\n?\s*deps\.every\(\(n\) => n > 0\)/,
    "reports.tsx: gross profit and net profit must be as sourced as the " +
      "weakest line they derive from — a total may not launder a missing input.",
  );
  // Net profit depends on all three sections; gross profit on two. If either
  // ever stops naming its inputs, the dash stops propagating.
  assert.ok(
    tab.includes("derived([revenueAccts, cogsAccts], totals?.grossProfit)"),
    "reports.tsx: Gross Profit must name revenue AND cogs as its inputs.",
  );
  assert.ok(
    tab.includes(
      "derived([revenueAccts, cogsAccts, opexAccts], totals?.netProfit)",
    ),
    "reports.tsx: Net Profit must name all three sections as its inputs.",
  );

  // A ledger that did not load is not an empty ledger — the same distinction
  // BUG-2026-08-13-005 was about, applied to money.
  assert.ok(
    tab.includes("ledgerError"),
    "reports.tsx: a failed ledger read must be surfaced on screen, not " +
      "rendered as zeroes.",
  );
  assert.match(
    tab,
    /ledger === null\s*\n?\s*\? "ledger unavailable"/,
    "reports.tsx: when the ledger is unavailable the provenance column must " +
      "say so rather than reporting zero posted accounts.",
  );
});

test("invoiced sales is labelled as invoices, and excludes drafts", () => {
  const tab = financialTab();

  // The old revenue line summed EVERY invoice row, drafts and cancellations
  // included, and called the result Revenue.
  assert.ok(
    !/invoices\.reduce\(\(s, i\) => s \+ i\.totalSen, 0\)/.test(tab),
    "reports.tsx: summing every invoice row — drafts and cancellations " +
      "included — is not revenue.",
  );
  assert.match(
    tab,
    /invoices\.filter\(\s*\n?\s*\(i\) => i\.status !== "DRAFT" && i\.status !== "CANCELLED",?\s*\n?\s*\)/,
    "reports.tsx: invoiced sales must exclude DRAFT and CANCELLED, matching " +
      "how the accounting module cuts operational revenue.",
  );
  assert.ok(
    tab.includes("(from invoices, not the ledger)"),
    "reports.tsx: the invoiced-sales card must say it is not the ledger — " +
      "the two figures can legitimately disagree and must never be summed.",
  );
});

test("aging buckets are labelled as what they actually collect", () => {
  const tab = financialTab();

  // The last AR bucket catches everything past 60 days; it was captioned
  // "90+ Days Overdue", so 61-90 day debt was filed under 90+.
  assert.ok(
    !tab.includes('"90+ Days Overdue"'),
    'reports.tsx: the final AR bucket collects everything over 60 days, so ' +
      '"90+ Days Overdue" mislabels 61-90 day debt.',
  );
  assert.ok(
    tab.includes('"61+ Days Overdue"'),
    "reports.tsx: the final AR bucket must be labelled 61+.",
  );
  // A draft invoice is not a receivable.
  assert.ok(
    tab.includes('i.status !== "PAID" && i.status !== "CANCELLED" && i.status !== "DRAFT"'),
    "reports.tsx: AR aging must exclude DRAFT invoices.",
  );

  // The purchase-order card ages UNRECEIVED orders by expected DELIVERY date
  // and excludes every received one — i.e. it excludes the whole population
  // that can be owed for. It is not accounts payable.
  assert.ok(
    !tab.includes("Accounts Payable Aging"),
    "reports.tsx: the purchase-order card excludes received orders and ages " +
      "by expected delivery date. Calling it Accounts Payable Aging is a " +
      "mislabel; real AP is Accounting › AP Aging.",
  );
  assert.ok(
    tab.includes("Open Purchase Orders by Expected Date"),
    "reports.tsx: the purchase-order card must be labelled for what it ages.",
  );
});

test("money on this tab stays integer sen", () => {
  const tab = financialTab();
  // Every displayed sum goes through roundSen — money is integer sen (RM x
  // 100) everywhere in this repo, and a float that reaches formatCurrency is
  // how a half-sen becomes a rounding argument with a customer.
  assert.ok(
    tab.includes("roundSen("),
    "reports.tsx: sums rendered as money must pass through roundSen.",
  );
  assert.ok(
    !/\/\s*100\b(?![^\n]*\/\/)/.test(
      tab.split("\n").filter((l) => l.includes("formatCurrency")).join("\n"),
    ),
    "reports.tsx: formatCurrency takes SEN — dividing by 100 first renders " +
      "the amount 100x too small.",
  );
});
