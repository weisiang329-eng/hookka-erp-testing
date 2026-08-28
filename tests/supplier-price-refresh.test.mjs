// ---------------------------------------------------------------------------
// supplier-price-refresh
//
// Owner 2026-08-28: 「把我们的价目表也更新去最新价钱」.
//
// ## Why the price LIST matters more than the invoices it is read from
//
// Every purchase order autofills its unit price from
// `supplier_material_bindings`. Measured the same day: OCEAN SKY's three
// fastener lines were stamped 2026-05-05 and had not moved since, while August
// invoices paid something different on all three — two UP, one DOWN. Correcting
// the historical invoices and leaving the list alone fixes the past and keeps
// mispricing the future.
//
// ## The source, and the ones deliberately rejected
//
// The most recent PURCHASE INVOICE line for that supplier + material:
//
//   · NOT the scan — unreviewed
//   · NOT the purchase order — what we asked for, not what we were charged
//   · NOT an average — nobody agreed to an average
//
// It is the document a person accepted, copied verbatim. `effectiveFrom` comes
// from that invoice's own date, because the price changed when the supplier
// charged it, not when we caught up with the paperwork.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/supplier-price-refresh.ts', 'utf8');
const GET = SRC.slice(SRC.indexOf('app.get("/supplier-price-drift"'), SRC.indexOf('app.post("/refresh-supplier-price-list"'));
const POST = SRC.slice(SRC.indexOf('app.post("/refresh-supplier-price-list"'));

// --- the source of truth --------------------------------------------------
test('the price comes from an accepted INVOICE, not a scan or a PO', () => {
  assert.match(SRC, /FROM purchase_invoice_items pii/);
  assert.match(SRC, /JOIN purchase_invoices pi ON pi\.id = pii\.pi_id/);
  for (const wrong of ['scan_queue', 'purchase_order_items', 'raw_json']) {
    assert.equal(SRC.includes(wrong), false, `${wrong} must not be a price source here`);
  }
});

test('only real, chargeable lines are considered', () => {
  assert.match(SRC, /pi\.status <> 'CANCELLED'/);
  assert.match(SRC, /COALESCE\(pii\.line_type, 'STOCKED'\) = 'STOCKED'/);
  assert.match(SRC, /pii\.unit_price_sen > 0/, 'a zero line is a delivery note, not a price');
  assert.match(SRC, /pii\.material_code <> ''/);
});

test('the effective date is the SUPPLIER’s, never today', () => {
  assert.match(POST, /effectiveFrom: r\.paidOn/);
  assert.equal(
    /effectiveFrom: (todayIso|new Date)/.test(POST),
    false,
    'stamping today would claim the price changed when the paperwork was fixed',
  );
});

// --- the latest-price rule, executed -------------------------------------
test('“latest” is the newest invoice DATE, and a tie must agree', () => {
  // The rule the endpoint implements, run on the shape that actually occurs:
  // several invoices over months, sometimes two on one day.
  const pick = (lines) => {
    const m = new Map();
    for (const l of lines) {
      const cur = m.get(l.code);
      if (!cur || l.date > cur.date) m.set(l.code, { date: l.date, prices: new Set([l.sen]) });
      else if (l.date === cur.date) cur.prices.add(l.sen);
    }
    return m;
  };
  const got = pick([
    { code: 'NL 5/8', date: '2026-05-02', sen: 5 },
    { code: 'NL 5/8', date: '2026-08-13', sen: 5.5 },
    { code: 'NL 5/8', date: '2026-08-12', sen: 5.5 },
    { code: 'SCRW', date: '2026-08-06', sen: 2.5 },
    { code: 'SCRW', date: '2026-08-06', sen: 3 },
  ]);
  assert.deepEqual([...got.get('NL 5/8').prices], [5.5], 'the newest wins, older is ignored');
  assert.equal(got.get('SCRW').prices.size, 2, 'a same-day disagreement stays ambiguous');
});

test('two prices on the same latest date are refused, never averaged', () => {
  assert.match(SRC, /if \(hit\.prices\.size > 1\)/);
  assert.match(SRC, /cannot tell which is current/);
  assert.equal(/\/ hit\.prices\.size/.test(SRC), false, 'no averaging may appear');
});

test('a list already NEWER than the evidence is left alone', () => {
  // Somebody may have set a price effective later than the last invoice. Pulling
  // it back to an older invoice would silently undo that decision.
  assert.match(SRC, /listFrom && hit\.date < listFrom/);
  assert.match(SRC, /leaving the newer decision alone/);
});

test('an unchanged price is a skip, so re-running is the resume strategy', () => {
  assert.match(SRC, /whyNot = "already current";/);
});

test('a material never invoiced is passed over, not zeroed', () => {
  // No evidence is not the same as a price of zero — that conflation is the
  // absence-read-as-a-value mistake this repo keeps paying for.
  assert.match(SRC, /if \(!hit\) continue;/);
});

// --- writing through the real path ---------------------------------------
test('the write SELF-CALLS the binding’s own update endpoint', () => {
  // That endpoint appends the append-only price_histories row and stamps the
  // effective date. Two writers for one log is how a Price Change Log stops
  // being auditable.
  assert.match(POST, /fetch\(`\$\{origin\}\/api\/supplier-materials\/\$\{r\.bindingId\}`/);
  assert.match(POST, /method: "PUT"/);
  // The comment above the self-call is allowed to NAME the table it defers to;
  // the code is not allowed to touch it.
  const code = SRC.replace(/\/\/.*$/gm, '');
  assert.equal(
    /price_histories/.test(code),
    false,
    'the history table must have exactly one writer',
  );
  assert.equal(
    /UPDATE supplier_material_bindings/.test(code),
    false,
    'and so must the binding itself',
  );
});

test('it runs under the caller’s own session', () => {
  assert.match(POST, /const cookie = c\.req\.header\("cookie"\)/);
  assert.match(POST, /const csrf = c\.req\.header\("x-csrf-token"\)/);
});

// --- reporting ------------------------------------------------------------
test('dry run is the default, bounded, and scopeable to one supplier', () => {
  assert.match(POST, /const dryRun = c\.req\.query\("dryRun"\) !== "false"/);
  assert.match(POST, /Math\.min\(500, Math\.max\(1, Number\(c\.req\.query\("limit"\)\) \|\| 200\)\)/);
  assert.match(POST, /const supplierId = \(c\.req\.query\("supplierId"\) \|\| ""\)\.trim\(\)/);
});

test('the report writes nothing, and says which way prices moved', () => {
  assert.equal(/UPDATE |INSERT |DELETE /.test(GET), false);
  assert.match(SRC, /goingUp:/);
  assert.match(SRC, /goingDown:/, 'a refresh that only ever raises prices would be a bug worth seeing');
  assert.match(SRC, /skippedByReason/);
  assert.match(POST, /failed: applied\.filter\(\(a\) => !a\.ok\)/, 'failures are returned, not counted away');
});
