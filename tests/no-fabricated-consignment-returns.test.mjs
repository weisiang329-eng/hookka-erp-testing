// ---------------------------------------------------------------------------
// no-fabricated-consignment-returns.test.mjs — BUG-2026-08-13-071, the last
// known live fabrication after a day of sweeping out the rest of the class
// (docs/BUG-CLASSES.md § C15).
//
// Already guarded elsewhere:
//   tests/no-fabricated-efficiency.test.mjs             (-004, -005)
//   tests/no-fabricated-worker-metrics.test.mjs         (-006)
//   tests/no-fabricated-financials.test.mjs             (-009, -010)
//   tests/no-fabricated-inventory-and-forecast.test.mjs (-014, rows 6-16)
//
// What this file pins. `src/pages/consignment/return.tsx` built its rows in a
// function named `buildMockCRs()` that mixed real consignment-note values with
// three invented ones, and exported the result to CSV:
//
//   crNo        `CR-${_crCounter.padStart(5,"0")}` — a module-level counter,
//               reset on every page load, rendered in a `docno` column. There
//               is no CR document, no cr table and no CR numbering series.
//   status      PENDING / INSPECTED / ACCEPTED / RESTOCKED chosen by
//               Math.random() thresholds, then advanced by on-screen buttons
//               that wrote to local state only. That vocabulary exists nowhere
//               else in the repo — no migration, no route, no type.
//   returnDate  now − Math.floor(Math.random()*10+1) days.
//
// The dangerous part was the honest half: real customer, real branch and (where
// priced) real RM sat beside the invented status, so the row read as credible.
//
// STRUCTURAL, for the reason the sibling files give: every one of these is a
// one-token edit away from returning, and no runtime assertion catches a value
// that is merely wrong-but-plausible. Comments are stripped before matching so
// this file's own header — which quotes the bug verbatim — cannot satisfy or
// trip a guard.
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

const PAGE = "src/pages/consignment/return.tsx";
const page = () => stripComments(read(PAGE));

// ===========================================================================
// 1 — no dice roll anywhere on this page
// ===========================================================================

test("the returns page rolls no dice", () => {
  const src = page();

  assert.ok(
    !/Math\.random\s*\(/.test(src),
    `${PAGE}: Math.random() picked the return STATUS of every row and the ` +
      "return DATE of the fully-returned ones, next to real customer names " +
      "and real RM. Nothing on this screen may be drawn at random.",
  );
  assert.ok(
    !/\bbuildMockCRs\b/.test(src),
    `${PAGE}: buildMockCRs() is the generator this bug lived in. Rows are ` +
      "derived from consignment_items records or they do not exist.",
  );
});

// ===========================================================================
// 2 — no counter posing as a document number
// ===========================================================================

test("no client-side counter is rendered as a document number", () => {
  const src = page();

  assert.ok(
    !/\b_crCounter\b/.test(src),
    `${PAGE}: _crCounter was a module-level integer that restarted at 0 on ` +
      "every mount, so the same return carried a different 'CR No.' after a " +
      "refresh. A number minted in the browser is not a document number.",
  );
  assert.ok(
    !/`CR-\$\{/.test(src) && !/"CR-"\s*\+/.test(src),
    `${PAGE}: a \`CR-\${…}\` identifier is fabricated — this system issues no ` +
      "CR series. Show the source consignment note number instead.",
  );
  // The generic shape, so a rename cannot bring it back: a counter formatted
  // with padStart into an id-looking string.
  assert.ok(
    !/\+\+\s*\w*[Cc]ounter/.test(src) && !/\w*[Cc]ounter\s*\+\+/.test(src),
    `${PAGE}: incrementing a module-level counter to label rows re-creates ` +
      "the fake document number under a new name.",
  );
  assert.ok(
    !/\bcrNo\b/.test(src),
    `${PAGE}: the crNo field carried the fabricated identifier onto the ` +
      "screen, into the detail dialog header and into the CSV.",
  );
  // The real identifier must be what the column shows.
  assert.ok(
    /key:\s*"noteNumber",\s*label:\s*"CN No\.",\s*type:\s*"docno"/.test(src),
    `${PAGE}: the document column must render consignment_notes.noteNumber — ` +
      "the only real identifier a recorded return has.",
  );
});

// ===========================================================================
// 3 — no date derived from now
// ===========================================================================

test("a return date is the recorded one or it is a dash", () => {
  const src = page();

  assert.ok(
    !/setDate\s*\(/.test(src),
    `${PAGE}: \`returnDate.setDate(returnDate.getDate() - Math.floor(...))\` ` +
      "back-dated every fully-returned row by 1-10 random days. A return date " +
      "comes from consignment_items.returnedDate or it is not shown.",
  );
  assert.ok(
    !/getDate\s*\(\s*\)\s*-/.test(src) && !/getTime\s*\(\s*\)\s*-/.test(src),
    `${PAGE}: now-minus-an-offset is a fabricated date however it is spelled.`,
  );
  assert.ok(
    !/returnDate\s*:\s*[\w.[\]]*\s*(\|\||\?\?)\s*now/.test(src) &&
      !/returnedDate\s*(\|\||\?\?)\s*now\.toISOString/.test(src),
    `${PAGE}: \`returnedDate || now.toISOString()\` was the second date fake — ` +
      'it stamped TODAY on any line whose return was never dated. Use "—".',
  );
  // The real source, and the dash, must both be present.
  assert.ok(
    /\.returnedDate/.test(src),
    `${PAGE}: consignment_items.returnedDate is the only recorded return ` +
      "date; it must still be read.",
  );
  assert.ok(
    /row\.returnDate \? formatDate\(row\.returnDate\) : NO_FIGURE/.test(src),
    `${PAGE}: an undated return must render "—" in the grid, not a stand-in.`,
  );
});

// ===========================================================================
// 4 — the invented status workflow stays deleted
// ===========================================================================

test("no CR status workflow is invented", () => {
  const src = page();

  for (const word of ["INSPECTED", "RESTOCKED", "CRStatus", "STATUS_LABEL"]) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`).test(src),
      `${PAGE}: ${word} belongs to a PENDING→INSPECTED→ACCEPTED→RESTOCKED ` +
        "pipeline that exists in no migration, no route and no type. The " +
        "database records a return as ONE event (routes/consignment-notes.ts " +
        "POST /:id/return): the line is flagged RETURNED, the units go back " +
        "into fg_units and a STOCK_IN movement is written, all in one batch.",
    );
  }
  // The buttons that advanced the invented status. They persisted nothing —
  // no endpoint accepts those transitions — so they were a workflow the
  // operator could believe they had completed.
  for (const label of ["Mark Inspected", "Accept Return", "Restock Items", "Print CR"]) {
    assert.ok(
      !src.includes(label),
      `${PAGE}: the "${label}" action wrote an invented status into local ` +
        "state (or printed a document that does not exist) and vanished on " +
        "refresh.",
    );
  }
  assert.ok(
    !/\bsetCrRows\b/.test(src),
    `${PAGE}: rows are a pure derive of the fetched notes. Local row state ` +
      "existed only to hold the fabricated status transitions.",
  );
  // The status column must publish the note's own status verbatim.
  // Anchored to the trailing comma: `noteStatus: n.status === "RETURNED" ? …`
  // is a mapped guess and must NOT satisfy this.
  assert.ok(
    /noteStatus:\s*n\.status,/.test(src),
    `${PAGE}: the Status column must be consignment_notes.status verbatim — ` +
      "not a value mapped from a guess.",
  );
});

// ===========================================================================
// 5 — the real source, and the dash where there is none
// ===========================================================================

test("rows are built from recorded RETURNED lines", () => {
  const src = page();

  assert.ok(
    /\.filter\(\(i\) => i\.status === "RETURNED"\)/.test(src),
    `${PAGE}: the row set must come from consignment_items rows the return ` +
      "endpoint actually flagged RETURNED.",
  );
  assert.ok(
    !/i\.status === "DAMAGED"/.test(src),
    `${PAGE}: DAMAGED lines were listed as "returns needing inspection". ` +
      "DAMAGED is a condition flag on a line still at the branch, nothing in " +
      "the API writes it, and it carries no returnedDate.",
  );
  assert.ok(
    !/\|\|\s*n\.items\.length/.test(src) && !/\|\|\s*n\.totalValue/.test(src),
    `${PAGE}: \`filter(RETURNED).length || n.items.length\` and ` +
      "`… || n.totalValue` invented an item count and a return value for " +
      "notes that had no returned line at all.",
  );
});

test("an unpriced return shows a dash, never RM 0.00", () => {
  const src = page();

  assert.ok(
    /const NO_FIGURE = "—"/.test(src),
    `${PAGE}: the page must define the "—" it renders for absent figures.`,
  );
  assert.ok(
    /returnValueSen:\s*\n?\s*priced\.length > 0/.test(src),
    `${PAGE}: consignment_items.unitPrice is routinely 0 (the real price is ` +
      "on the parent consignment ORDER line — api/lib/cn-value.ts), so a sum " +
      "over unpriced lines is RM 0.00 asserting the goods were worth nothing. " +
      "Value only from lines that carry a price; null otherwise.",
  );
  assert.ok(
    /row\.returnValueSen === null \? NO_FIGURE/.test(src),
    `${PAGE}: a null return value must render "—".`,
  );
  assert.ok(
    !/returnValueSen\s*\?\?\s*0/.test(src),
    `${PAGE}: \`returnValueSen ?? 0\` turns "not recorded" back into a claim ` +
      "of zero (docs/BUG-CLASSES.md § C15: 0 is a claim, not a blank).",
  );
  // Provenance beside the figure — the "Valuation Basis" precedent.
  assert.ok(
    src.includes('label: "Value Basis"') && /pricedLineCount/.test(src),
    `${PAGE}: the page must publish how many of a note's returned lines carry ` +
      "a price behind the value it shows.",
  );
});

test("a failed read is not drawn as an empty list", () => {
  const src = page();
  // Both halves are required: the derivation AND the render. Checking only the
  // identifier passes happily against `loadFailedRemoved` — the exact
  // "the guard matched a prefix" trap BUG-2026-08-13-070 was caught by.
  assert.ok(
    /const loadFailed =/.test(src) && /\{loadFailed &&/.test(src),
    `${PAGE}: a dead /api/consignments request must be said out loud — an ` +
      'empty grid reads as "no returns" (BUG-2026-08-13-005).',
  );
  assert.ok(
    /error,\s*\n\s*refresh: fetchData,/.test(src),
    `${PAGE}: the failure must come from the fetch hook's own error, not be ` +
      "inferred from an empty array.",
  );
});

// ===========================================================================
// 6 — the CSV carries nothing the screen does not
// ===========================================================================

test("the export contains no invented cell", () => {
  const src = page();

  assert.ok(
    /r\.returnValueSen === null \? ""/.test(src),
    `${PAGE}: the CSV must leave the value cell EMPTY when no returned line ` +
      "is priced. A spreadsheet reads 0.00 as a measured figure.",
  );
  assert.ok(
    /r\.returnDate \? formatDate\(r\.returnDate\) : ""/.test(src),
    `${PAGE}: the CSV must leave the date cell empty when no return date was ` +
      "recorded.",
  );
  assert.ok(
    /r\.returnedLineCount === 0 \? "" : r\.returnedLineCount/.test(src),
    `${PAGE}: a note with no line record must export an EMPTY line count, the ` +
      'same semantics the screen shows as "—". A spreadsheet reads 0 as a ' +
      "counted zero.",
  );
  assert.ok(
    !/STATUS_LABEL\[/.test(src) && !/"CR No\."/.test(src),
    `${PAGE}: the CSV shipped the fabricated CR number and the fabricated ` +
      "status label out of the building in a file someone may file or send.",
  );
  // One headers array, used by the export — a header list that drifts from the
  // row builder re-creates the bug in a spreadsheet.
  assert.ok(
    (src.match(/\bCSV_HEADERS\b/g) ?? []).length >= 2,
    `${PAGE}: the CSV headers must be declared once and reused by the export.`,
  );
  // A customer name containing a comma used to shift every later column by one.
  assert.ok(
    /function csvCell\(/.test(src) && /\.map\(csvCell\)\.join\(","\)/.test(src),
    `${PAGE}: every CSV cell must be quoted/escaped — an unescaped comma in a ` +
      "customer name silently moves the status into the date column.",
  );
});

// ===========================================================================
// 7 — do not over-correct: the real return path must survive this cleanup
// ===========================================================================

test("the endpoint that records a real return is untouched", () => {
  const route = read("src/api/routes/consignment-notes.ts");

  assert.ok(
    route.includes('app.post("/:id/return"'),
    "consignment-notes.ts: POST /:id/return is the ONLY writer of a " +
      "consignment return. Removing it while cleaning up the fake page would " +
      "be the mirror-image mistake.",
  );
  assert.ok(
    /SET status = 'RETURNED', returnedDate = \?/.test(route),
    "consignment-notes.ts: the return must keep stamping " +
      "consignment_items.returnedDate — it is the page's only real date.",
  );
  assert.ok(
    /reason='CONSIGNMENT_RETURN'|"CONSIGNMENT_RETURN"/.test(route),
    "consignment-notes.ts: the return must keep booking the units back in " +
      "(fg_units RETURNED + a STOCK_IN movement). That single step IS the " +
      "restock — which is why no separate restock status exists to show.",
  );
  // And the page must still read the live list.
  assert.ok(
    page().includes('useCachedJson<{ success?: boolean; data?: ConsignmentNote[] }>("/api/consignments")'),
    `${PAGE}: the page must keep reading real consignment notes.`,
  );
});
