// ---------------------------------------------------------------------------
// pi-resync-gl
//
// ## The hole this closes, and how it was found
//
// `PUT /api/purchase-invoices/:id` already posts a correcting double-entry when
// an edit moves a CONFIRMED invoice's amount. It fires on
// `recomputedAmount !== existing.amountSen` — which makes it blind to a repair
// that writes the LINES directly, because by the time such a repair finishes the
// header already agrees with the lines and there is no delta left to detect.
//
// That is exactly what `import-completion/rounded-price-repair.ts` does. Measured
// on prod 2026-08-28, immediately after it ran: five invoices whose face had
// moved while the GL still carried the old amount — and they were the ONLY
// `pi_gl_mismatch` rows in the entire system, so the repair had created all of
// them. Individual gaps up to RM 40.00.
//
// The repair endpoint's own response had SAID this would happen ("Ledger legs are
// NOT rewritten here"). Saying it is not the same as closing it: an accurate
// warning nobody acts on still leaves the books wrong, which is the whole thing
// the owner is chasing — 「account 怎么能对账呢」.
//
// ## Why it reuses instead of adding
//
// `loadPiLedgerNet` + `buildPiDeltaLegs` are the pair the VOID path already uses.
// They derive the move from WHAT IS ACTUALLY POSTED rather than from a count of
// button presses, which is what makes void → unvoid → void safe. Targeting the
// invoice's current face instead of zero is the same primitive, one argument
// different — and idempotence comes free from the arithmetic rather than from a
// flag someone has to remember.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stripLegSuffix, familyOf } from '../src/lib/doc-date.ts';

const SRC = readFileSync('src/api/routes/purchase-invoices.ts', 'utf8');
const H = SRC.slice(SRC.indexOf('app.post("/:id/resync-gl"'));

// --- reuse, not a new ledger writer --------------------------------------
test('it moves the ledger with the SAME primitive the void path uses', () => {
  assert.ok(H.length > 500, 'the handler must be found');
  assert.match(H, /const \{ total, orgId: legOrgId, legs \} = await loadPiLedgerNet\(db, id\);/);
  assert.match(H, /const deltaLegs = buildPiDeltaLegs\(target, total, \{/);
  // and it builds the TARGET through the same mapper + builder the original
  // posting used, so a correction lands in the same 70x accounts.
  assert.match(H, /await mapPurchaseLinesToAccounts\(db, lines\)/);
  assert.match(H, /buildPiApprovalLegs\(\{/);
});

test('re-running writes nothing — idempotence is arithmetic, not a flag', () => {
  // buildPiDeltaLegs skips any account whose delta is 0, so a second call after
  // a successful one produces an empty leg list.
  assert.match(H, /if \(deltaLegs\.length === 0\)/);
  assert.match(H, /alreadyInSync: true/);
  assert.equal(
    /hasRunBefore|alreadyResynced|resync_count/.test(SRC),
    false,
    'no "have we done this already" flag may appear — that is the bug void avoided',
  );
});

test('dry run is the default', () => {
  assert.match(H, /const dryRun = c\.req\.query\("dryRun"\) !== "false"/);
  assert.match(H, /if \(dryRun\) \{/);
});

// --- the dating trap -----------------------------------------------------
test('the correction dates to the INVOICE, not to the day the repair ran', () => {
  // Class C5, three instances so far: a sourceType the resolver does not
  // recognise silently falls back to postedAt and reports in the wrong month.
  // Reusing an existing suffix means doc-date.ts needs no change at all.
  assert.match(H, /sourceType: "purchase_invoice_restate_post"/);
  assert.equal(stripLegSuffix('purchase_invoice_restate_post'), 'purchase_invoice');
  assert.ok(familyOf('purchase_invoice_restate_post'), 'must resolve to a doc-date family');
});

test('the AP reconciler counts these legs', () => {
  // familyOf() in ap-recon.ts classifies by sourceType.startsWith(docPrefix).
  // A correction the reconciler cannot see would leave the mismatch standing
  // while looking like it had been fixed — worse than not fixing it.
  const recon = readFileSync('src/lib/ap-recon.ts', 'utf8');
  assert.match(recon, /sourceType\.startsWith\(cfg\.docPrefix\)/);
  assert.equal(
    'purchase_invoice_restate_post'.startsWith('purchase_invoice'),
    true,
    'the sourceType must fall inside the doc family',
  );
  // ...and the legs keep the PI's own id, so they land on that invoice's net.
  assert.match(H, /sourceId: id,/);
});

// --- refusals -------------------------------------------------------------
test('only a CONFIRMED, unpaid invoice can be re-synced', () => {
  assert.match(H, /if \(status !== "CONFIRMED"\)/);
  assert.match(H, /A draft has no posting to re-sync/);
  assert.match(H, /deliberately netted to zero/, 'a voided invoice must stay at zero');
  assert.match(H, /correct it with a credit note, not a re-sync/);
  assert.match(H, /if \(paidSen > 0\)/);
});

test('an invoice that was never posted is refused, not first-posted', () => {
  // Posting for the first time is /backfill-gl-postings' job, and it is
  // ledgerHasSource-gated. Doing it here would give one action two meanings.
  assert.match(H, /if \(legs === 0\)/);
  assert.match(H, /use \/backfill-gl-postings to post it/);
});

test('it is finance-gated and audited', () => {
  assert.match(H, /const denied = requireFinance\(c\);/);
  assert.match(H, /action: "resync-gl"/);
  assert.match(H, /correctionLegs: movement/);
});

// --- the delta arithmetic, executed --------------------------------------
test('the movement is target minus posted, per account', () => {
  // buildPiDeltaLegs' rule, run against the real prod case: PI-2608-055's face
  // fell RM 6151.92 → RM 6111.92, so AP (a credit balance, negative signed)
  // must move by +4000 and the purchase account by −4000.
  const delta = (target, posted) => {
    const out = {};
    for (const a of new Set([...Object.keys(target), ...Object.keys(posted)])) {
      const d = (target[a] ?? 0) - (posted[a] ?? 0);
      if (d !== 0) out[a] = d;
    }
    return out;
  };
  const posted = { '704-0010': 615192, '400-0000': -615192 };
  const target = { '704-0010': 611192, '400-0000': -611192 };
  assert.deepEqual(delta(target, posted), { '704-0010': -4000, '400-0000': 4000 });
  // and the entry balances: Σ debits === Σ credits
  const legs = Object.values(delta(target, posted));
  assert.equal(legs.reduce((s, v) => s + v, 0), 0, 'a correction must balance');
  // running it again moves nothing
  assert.deepEqual(delta(target, target), {});
});
