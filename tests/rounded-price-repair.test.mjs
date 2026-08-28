// ---------------------------------------------------------------------------
// rounded-price-repair
//
// Owner: 「你把之前的那个因为三位数、四位数不能填进去的问题，都帮我 backfill
// 回去」.
//
// ## Why this cannot be a simple UPDATE
//
// The rounding happened ON THE WAY IN. RM 0.055 became 6 sen before anything
// was written, and the line total was then recomputed FROM that 6 — so the
// invoice agrees with itself perfectly and NOTHING inside the ERP disagrees.
// There is no arithmetic that recovers 0.055 from the stored row.
//
// The evidence survives in exactly one place: `scan_queue.raw_json`, the
// scanner's structured reading of the supplier's own PDF, which records
// `unitPrice: 0.055` alongside `amount: 33.00` as printed. (The PDF bytes are
// NULLed on consume; that JSON is not.)
//
// So the repair COPIES the supplier's number. That is the owner's standing rule
// for exactly this shape — a repair reads the source's own value, never infers
// one — and three lanes have already drifted into inference and written a wrong
// row each time.
//
// ## What is pinned here
//
// 1. the sub-cent test itself, on the real invoice
// 2. the confidence gate — the document must agree with ITSELF
// 3. every refusal path, because a repair that guesses is worse than no repair
// 4. that PAID invoices cannot enter the plan by CONSTRUCTION, not by a filter
// 5. that the write is idempotent and re-running is the resume strategy
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { roundUnitPriceSen, lineTotalSen } from '../src/lib/unit-price.ts';

const SRC = readFileSync('src/api/routes/import-completion/rounded-price-repair.ts', 'utf8');
const GET = SRC.slice(SRC.indexOf('app.get("/rounded-unit-prices"'), SRC.indexOf('app.post("/repair-rounded-unit-prices"'));
const POST = SRC.slice(SRC.indexOf('app.post("/repair-rounded-unit-prices"'));

// --- 1. the detection rule, executed -------------------------------------
test('sub-cent detection: only prices whole sen cannot express', () => {
  const isSubCent = (rm) => {
    const sen = rm * 100;
    return Number.isFinite(sen) && Math.abs(sen - Math.round(sen)) > 1e-9;
  };
  assert.equal(isSubCent(0.055), true, 'OCEAN SKY NAIL LEG 5/8');
  assert.equal(isSubCent(0.0555), true);
  assert.equal(isSubCent(12.5), false, 'a whole-sen price is not damaged');
  assert.equal(isSubCent(0.06), false, 'the ROUNDED value is not itself suspect');
  assert.equal(isSubCent(0), false);
  // Float noise must not manufacture candidates: 8.87 * 100 is 886.9999...
  assert.equal(isSubCent(8.87), false);
  assert.equal(isSubCent(19.99), false);
});

test('the repaired numbers are the supplier’s own arithmetic', () => {
  const unit = roundUnitPriceSen(0.055 * 100);
  assert.equal(unit, 5.5);
  assert.equal(lineTotalSen(600, unit), 3300, 'RM 33.00, matching the printed amount');
  // and the damage it replaces
  assert.equal(600 * Math.round(0.055 * 100), 3600, 'RM 36.00 was stored');
  assert.equal(3300 - 3600, -300, 'RM 3.00 comes back off the invoice');
});

// --- 2. the confidence gate ----------------------------------------------
test('the scanned document must agree with ITSELF before it is trusted', () => {
  // qty x unitPrice has to equal the amount read off the same row: two
  // independently-read numbers on the supplier's paper confirming each other.
  assert.match(POST.length ? SRC : SRC, /const selfConsistent =/);
  assert.match(
    SRC,
    /amountRm != null && Math\.abs\(Math\.round\(amountRm \* 100\) - scannedLineSen\) <= 1/,
  );
  assert.match(SRC, /the scan read no line amount/);
  assert.match(SRC, /the scan disagrees with itself/);
});

test('a gap bigger than a rounding is NOT treated as this bug', () => {
  // Rounding moves a price by less than one sen. Anything larger is a
  // renegotiated price or a hand correction, and rewriting it would be this
  // endpoint inventing a change nobody asked for.
  assert.match(SRC, /Math\.abs\(storedUnitSen - scannedUnitSen\) > 1/);
  assert.match(SRC, /not this bug/);
});

test('an ambiguous pairing is refused, never picked', () => {
  assert.match(SRC, /hits\.length !== 1/);
  assert.match(SRC, /cannot tell which is which/);
  assert.match(SRC, /no invoice line matches this scanned line/);
  assert.equal(
    /hits\[0\] \?\? hits\[1\]/.test(SRC),
    false,
    'no fallback may quietly choose one',
  );
});

test('every refusal is counted and named in the summary', () => {
  // A backfill that reports only what it changed is unreadable: "12 lines
  // fixed" means something different if 40 were refused on the way there.
  assert.match(SRC, /refusedByReason/);
  assert.match(SRC, /refusedLines: refused\.length/);
  assert.match(SRC, /supplierInvoiceNosWithNoUnpaidInvoice/);
  assert.match(SRC, /scansTruncated/, 'a capped scan read must say so');
});

test('ONE row per invoice line — a document scanned twice is not counted twice', () => {
  // Caught on PRODUCTION, in the dry run, before any write: 9 reported rows
  // were only 7 invoice lines, because two supplier documents had been scanned
  // twice and each reading matched the same line. The WRITE would have been
  // harmless (identical value, twice) but the reported money was -RM 24.50
  // against a true -RM 14.50 — and the money is the thing being approved.
  const SRC2 = readFileSync('src/api/routes/import-completion/rounded-price-repair.ts', 'utf8');
  assert.match(SRC2, /const byItem = new Map<string, Candidate\[\]>\(\);/);
  assert.match(SRC2, /const prices = new Set\(group\.map\(\(g\) => g\.scannedUnitSen\)\);/);
  assert.match(SRC2, /if \(prices\.size === 1\)/, 'agreeing readings collapse to one row');
  assert.match(
    SRC2,
    /scans of this document disagree on the price/,
    'disagreeing readings are refused, never picked',
  );
});

test('the dedupe keeps the refusals visible rather than dropping them', () => {
  // A refused row carries no itemId and must survive to the report — silently
  // dropping it would turn "refused for a reason" into "never existed".
  const SRC2 = readFileSync('src/api/routes/import-completion/rounded-price-repair.ts', 'utf8');
  assert.match(SRC2, /if \(!cd\.eligible \|\| !cd\.itemId\) \{[\s\S]{0,40}?deduped\.push\(cd\);/);
});

// --- 3. safety ------------------------------------------------------------
test('PAID and PARTIAL_PAID invoices cannot enter the plan by construction', () => {
  // Money has changed hands against a document the supplier holds; correcting
  // that is a credit note, not an edit. Excluded in the WHERE clause rather
  // than by a filter someone can forget downstream.
  assert.match(SRC, /status IN \('DRAFT','CONFIRMED'\)/);
  assert.equal(/'PAID'/.test(SRC), false);
});

test('the report writes nothing, ever', () => {
  assert.equal(
    /UPDATE |INSERT |DELETE /.test(GET),
    false,
    'a diagnostic that repairs cannot report the state it found',
  );
  assert.match(GET, /requirePermission\(c, "purchase-invoices", "read"\)/);
});

test('the write is dry-run by default and bounded', () => {
  assert.match(POST, /const dryRun = c\.req\.query\("dryRun"\) !== "false"/);
  assert.match(POST, /requirePermission\(c, "purchase-invoices", "update"\)/);
  assert.match(POST, /const limit = Math\.min\(200, Math\.max\(1, Number\(c\.req\.query\("limit"\)\) \|\| 50\)\)/);
  assert.match(POST, /remaining: Math\.max\(0, eligible\.length - batch\.length\)/);
});

test('re-running is the resume strategy — a repaired line reports "already correct"', () => {
  assert.match(SRC, /whyNot = "already correct";/);
});

test('the header is RE-DERIVED from its lines, never adjusted by a delta', () => {
  // Recomputing cannot accumulate an error and stays right even if a line was
  // edited by hand between the plan and the write.
  assert.match(POST, /COALESCE\(SUM\(CASE WHEN line_type = 'TAX' THEN 0 ELSE line_total_sen END\), 0\)/);
  assert.match(POST, /SET subtotal_sen = \?, tax_sen = \?, amount_sen = \?/);
  assert.equal(
    /amount_sen = amount_sen [+-]/.test(POST),
    false,
    'no delta arithmetic on the header',
  );
});

test('the repair FINISHES the ledger — it does not leave a note asking someone to', () => {
  // This is the test that would have caught the real failure. The endpoint used
  // to return a sentence saying the caller must re-post by hand. Measured on
  // prod minutes after the first run: five CONFIRMED invoices with the GL still
  // on the old amount, gaps to RM 40.00, and they were the ONLY pi_gl_mismatch
  // rows in the system — this endpoint had created every one.
  //
  // An accurate warning nobody acts on still leaves the books wrong.
  assert.match(POST, /\/api\/purchase-invoices\/\$\{piId\}\/resync-gl\?dryRun=false/);
  assert.match(POST, /method: "POST", headers: \{ cookie, "x-csrf-token": csrf \}/);
  assert.equal(
    /Ledger legs are NOT rewritten here/.test(SRC),
    false,
    'the note that stood in for doing the work must be gone',
  );
});

test('a ledger re-sync that fails is REPORTED, never swallowed', () => {
  // Lines corrected + ledger not moved is the worst of the three states: it
  // looks finished and the books are out of step. It must be loud.
  assert.match(POST, /const ledgerFailures = ledger\.filter\(\(l\) => !l\.ok\);/);
  assert.match(POST, /their LEDGER did NOT re-sync/);
  assert.match(POST, /ledgerFailures,/, 'and it rides in the response body');
  // A DRAFT answers 409 because nothing was ever posted — correct, not a failure,
  // but still reported rather than inferred.
  assert.match(POST, /res\.ok \|\| res\.status === 409/);
});

test('the self-call runs under the CALLER’s session', () => {
  // No shared secret, no elevated path: whoever may correct the ledger by hand
  // is exactly who may do it here.
  assert.match(POST, /const cookie = c\.req\.header\("cookie"\)/);
  assert.match(POST, /const csrf = c\.req\.header\("x-csrf-token"\)/);
});

test('it moves the ledger by CALLING the real path, never by copying it', () => {
  // AMENDED 2026-08-28. This test used to assert the note that said "Ledger legs
  // are NOT rewritten here", and it passed while five invoices sat with their GL
  // on the old amount. The property worth pinning was never "does it say so" —
  // it is "does the ledger end up right, without a second copy of the posting
  // logic in this file".
  //
  // Both halves matter. Copying the leg builders here would be the seventh copy
  // of a thing this repo has been burned by duplicating; not moving the ledger
  // at all leaves the books out of step. The self-call is what satisfies both.
  assert.match(POST, /resync-gl\?dryRun=false/, 'the ledger must actually move');
  for (const forbidden of [
    'buildJournalEntryStatements',
    'buildPiDeltaLegs',
    'buildPiApprovalLegs',
    'ledger_journal_entries',
  ]) {
    assert.equal(SRC.includes(forbidden), false, `${forbidden} must stay in its own module`);
  }
});

// --- 4. scope honesty -----------------------------------------------------
test('hand-typed purchase orders are out of scope, and the file says why', () => {
  // A PO never had a scan, so the only record of the true price is the paper on
  // the owner's desk. Silently including them would mean guessing.
  assert.match(SRC, /Hand-typed purchase orders are deliberately out of scope/);
  assert.equal(
    /purchase_order_items/.test(SRC),
    false,
    'this endpoint must not touch a document it has no evidence for',
  );
});

test('it reads the scanner’s reading, not the invoice it produced', () => {
  assert.match(SRC, /FROM scan_queue/);
  assert.match(SRC, /raw_json IS NOT NULL/);
  assert.match(SRC, /scannedUnitSen = roundUnitPriceSen\(unitRm \* 100\)/);
});

test('both raw_json envelope shapes are handled', () => {
  // The async path stores {docs:[...]}; the older sync path stored one doc.
  // Reading only the first shape would silently find nothing on half the rows.
  assert.match(SRC, /Array\.isArray\(env\.docs\) \? env\.docs : \[env\]/);
  assert.match(SRC, /typeof raw === "string"/, 'and it may arrive as a JSON string');
});
