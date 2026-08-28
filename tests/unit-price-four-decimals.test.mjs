// ---------------------------------------------------------------------------
// unit-price-four-decimals
//
// Owner 2026-08-28, after Siti reported that the price was STILL rounding:
//
//   「全部啊 我们的 FE BE DB 都要可以 不可以进位成 0.66 的 我们的 account 就
//     不对到完了」
//   「你想看 我需要给 rm0.055 然后变成给 0.06 不是代表给多了吗 account 怎么能
//     对账呢」
//
// He is describing arithmetic, not a preference:
//
//     600 x RM 0.055 = RM 33.00     the supplier's paper
//     600 x RM 0.06  = RM 36.00     what we recorded
//                      RM  3.00     invented, on one line
//
// and it is INVISIBLE, because the line total is recomputed from the rounded
// rate and therefore agrees with itself. Only the supplier's document disagrees.
//
// ## Why this file is long
//
// The first fix (#335) widened the columns, gave `MoneyInput` step="0.0001",
// taught `formatCurrency` a third and fourth digit, and added `lineTotalSen`.
// Every one of those was right, and the operator STILL could not enter 0.055 —
// because the procurement forms do not go through those helpers. They each
// carried their own `step="0.01"`, their own `(sen / 100).toFixed(2)` seed, and
// their own `Math.round(rm * 100)` on submit. Nine sites across six files.
//
// That is this repo's documented failure mode: fix the instance in front of you
// and miss its twins (docs/BUG-CLASSES.md). So the source-structure assertions
// below COUNT the sites rather than checking the one that was reported.
//
// ## Rate vs amount
//
// Only a unit PRICE carries the extra digits. A tax field, a discount, a line
// total, a payment — those are amounts that change hands and stay whole sen.
// Several assertions here exist to stop the precision leaking sideways into
// them, which would be its own reconciliation problem.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  roundUnitPriceSen,
  lineTotalSen,
  formatUnitPriceInput,
  precisionOk,
  widenUnitPriceSql,
  UNIT_PRICE_COLUMNS,
  UNIT_PRICE_DECIMALS,
} from '../src/lib/unit-price.ts';

const read = (p) => readFileSync(p, 'utf8');

// --- 1. the arithmetic, on the real invoice --------------------------------
test('OCEAN SKY 2608-461: 600 x RM 0.055 is RM 33.00, not RM 36.00', () => {
  const unit = roundUnitPriceSen(0.055 * 100); // 5.5 sen
  assert.equal(unit, 5.5, 'the rate keeps its half-sen');
  assert.equal(lineTotalSen(600, unit), 3300, 'RM 33.00');

  // What the old code did, spelled out so the difference is not theoretical.
  const rounded = Math.round(0.055 * 100);
  assert.equal(rounded, 6);
  assert.equal(600 * rounded, 3600, 'RM 36.00 — RM 3 invented');
});

test('rounding happens ONCE, on the product — never on the rate first', () => {
  // 3 pieces at RM 0.055 is RM 0.165, which is a real 16.5 sen. The line total
  // is an AMOUNT, so it lands on whole sen — but only after multiplying.
  assert.equal(lineTotalSen(3, roundUnitPriceSen(5.5)), 17);
  assert.notEqual(3 * Math.round(5.5), 17, 'rate-first gives 18');
});

test('the rate is quantised to two decimals of sen, and junk stays junk', () => {
  assert.equal(roundUnitPriceSen(5.5049), 5.5);
  assert.equal(roundUnitPriceSen(5.5051), 5.51);
  assert.ok(Number.isNaN(roundUnitPriceSen(Number.NaN)), 'must not become 0');
  assert.ok(Number.isNaN(roundUnitPriceSen(Infinity)));
});

// --- 2. what the operator sees in the FIELD --------------------------------
test('an edit form seeds the full price — two decimals floor, four ceiling', () => {
  // The bug this replaces: `(sen / 100).toFixed(2)` ran when the operator
  // pressed Edit, so a saved RM 0.055 line showed "0.06" before anyone touched
  // it, and saving wrote 0.06 back. A correct column cannot survive that.
  assert.equal(formatUnitPriceInput(5.5), '0.055');
  assert.equal(formatUnitPriceInput(5.55), '0.0555');
  assert.equal(formatUnitPriceInput(2500), '25.00', 'the ordinary case is untouched');
  assert.equal(formatUnitPriceInput(0), '0.00');
  assert.equal(formatUnitPriceInput(123.4), '1.234');
  assert.equal(formatUnitPriceInput(Number.NaN), '');
});

test('what it renders round-trips back to the same stored rate', () => {
  for (const sen of [5.5, 5.55, 2500, 0, 123.4, 1, 99.99]) {
    const back = roundUnitPriceSen(Number(formatUnitPriceInput(sen)) * 100);
    assert.equal(back, sen, `${sen} must survive the form`);
  }
});

// --- 3. the DB decision ----------------------------------------------------
test('three columns hold a unit price as a RATE, and only three', () => {
  assert.deepEqual(
    UNIT_PRICE_COLUMNS.map((c) => `${c.table}.${c.column}`),
    [
      'purchase_invoice_items.unit_price_sen',
      'purchase_order_items.unit_price_sen',
      'grn_items.unit_price',
    ],
  );
  assert.equal(UNIT_PRICE_DECIMALS, 4);
});

test('an INTEGER column is not ok, and neither is a MISSING one', () => {
  assert.equal(precisionOk('numeric', 4), true);
  assert.equal(precisionOk('numeric', 6), true, 'wider than required is fine');
  assert.equal(precisionOk('numeric', 2), false);
  assert.equal(precisionOk('integer', null), false, 'integer reports no scale');
  // The one that matters most: a column that is not there must NOT read as
  // healthy. "Not found" meaning "fine" is the absence-as-a-value mistake that
  // has cost this repo three bugs this month.
  assert.equal(precisionOk(null, null), false);
  assert.equal(precisionOk(null, 4), false);
});

test('the widening statement moves no data', () => {
  const sql = widenUnitPriceSql('purchase_invoice_items', 'unit_price_sen');
  assert.equal(
    sql,
    'ALTER TABLE purchase_invoice_items ALTER COLUMN unit_price_sen TYPE NUMERIC(14,4)',
  );
  assert.equal(/USING/.test(sql), false, 'integer → numeric needs no USING clause');
});

// --- 4. the DB fix does not wait for somebody to save a document -----------
test('the schema fix is applied from READ paths, not only writes', () => {
  // Migrations are inert on deploy here (CLAUDE.md): a column reaches
  // production only through a self-apply awaited in a handler. All three of
  // those blocks are awaited on writes ONLY — so between the deploy and the
  // first save, the honest answer to "is it fixed?" was "nobody can say".
  for (const [file, marker] of [
    ['src/api/routes/purchase-invoices.ts', 'app.get("/", async (c) => {'],
    ['src/api/routes/purchase-orders.ts', 'app.get("/", async (c) => {'],
    ['src/api/routes/grn.ts', 'app.get("/", async (c) => {'],
  ]) {
    const src = read(file);
    const at = src.indexOf(marker);
    assert.ok(at > 0, `${file}: list handler must exist`);
    assert.match(
      src.slice(at, at + 900),
      /await ensureUnitPricePrecision\(/,
      `${file}: opening the list must be enough to widen the column`,
    );
  }
});

test('one definition — no route file carries its own widening ALTER', () => {
  for (const file of [
    'src/api/routes/purchase-invoices.ts',
    'src/api/routes/purchase-orders.ts',
    'src/api/routes/grn.ts',
  ]) {
    const sqlOnly = read(file).replace(/\/\/.*$/gm, '');
    assert.equal(
      /ALTER COLUMN unit_price\w* TYPE/.test(sqlOnly),
      false,
      `${file}: the widening belongs to api/lib/unit-price-precision.ts alone`,
    );
  }
});

test('a failed application is not remembered as done', () => {
  // One transient blip on a cold Hyperdrive pool must not leave the column
  // narrow for the life of the isolate — the exact failure `self-apply.ts` was
  // written for. Structural: the module memoises through the shared helper
  // rather than assigning its own promise.
  const src = read('src/api/lib/unit-price-precision.ts');
  assert.match(src, /memoizeSelfApply\(/);
  assert.match(src, /runSelfApply\(/);
});

test('it PROBES before it alters, so the steady state takes no table lock', () => {
  const src = read('src/api/lib/unit-price-precision.ts');
  const body = src.slice(src.indexOf('export function ensureUnitPricePrecision'));
  const probe = body.indexOf('readUnitPricePrecision(db)');
  const alter = body.indexOf('runSelfApply(');
  assert.ok(probe > 0 && alter > probe, 'the read must come first');
  assert.match(body, /if \(narrow\.length === 0\) return;/);
});

test('the diagnostic MEASURES and never repairs what it is measuring', () => {
  // CLAUDE.md: a claim about current production state is MEASURED or carries
  // the word UNMEASURED. Reading a route file is not a measurement. A
  // diagnostic that silently fixes the thing it reports cannot tell you what
  // the state WAS, which is the question being asked.
  const src = read('src/api/routes/import-completion/procurement-backfills.ts');
  const at = src.indexOf('app.get("/unit-price-precision"');
  assert.ok(at > 0, 'the endpoint must exist');
  const block = src.slice(at, at + 700);
  assert.match(block, /readUnitPricePrecision\(c\.var\.DB\)/);
  assert.equal(
    /ensureUnitPricePrecision/.test(block),
    false,
    'a probe that repairs cannot report the state it found',
  );
  assert.match(block, /requirePermission\(c, "purchase-orders", "read"\)/);
});

// --- 5. every FORM, not just the one that was reported --------------------
const FORMS = [
  'src/pages/procurement/pi/create.tsx',
  'src/pages/procurement/PurchaseInvoiceDetail.tsx',
  'src/pages/procurement/create.tsx',
  'src/pages/procurement/detail.tsx',
  'src/pages/procurement/index.tsx',
  'src/pages/procurement/grn/create.tsx',
  'src/components/scan-supplier-modal.tsx',
];

test('no form rounds a unit price to whole sen on the way in', () => {
  // `Math.round(rm * 100)` on a unit price IS the bug, wherever it appears.
  for (const f of FORMS) {
    const src = read(f);
    for (const re of [
      /unitPriceSen: Math\.round\(/,
      /"unitPriceSen",\s*\n\s*Math\.round\(/,
      // the running draft totals, which rounded the RATE and then multiplied
      /Math\.round\(\(moneyFieldToRinggit\(l\.unitPriceRm\) \?\? 0\) \* 100\) \* \(parseFloat/,
    ]) {
      assert.equal(re.test(src), false, `${f}: ${re} rounds the rate`);
    }
  }
});

test('the ONE surviving Math.round on unitPriceRm is the discount branch', () => {
  // A DISCOUNT line reuses the unit-price field to hold a discount, and a
  // discount is an AMOUNT — whole sen is correct there. Pinned by COUNT rather
  // than exempted by a loose regex, so if a fourth site ever appears this test
  // moves instead of quietly covering for it.
  const src = read('src/pages/procurement/PurchaseInvoiceDetail.tsx');
  const hits = [
    ...src.matchAll(/Math\.round\(\(moneyFieldToRinggit\(l\.unitPriceRm\) \?\? 0\) \* 100\)/g),
  ];
  assert.equal(hits.length, 1, 'exactly one, and it is the DiscountInput value');
  assert.match(src.slice(hits[0].index - 60, hits[0].index), /valueSen=\{$/);
});

test('no form seeds a unit-price field with toFixed(2)', () => {
  for (const f of FORMS) {
    const src = read(f);
    assert.equal(
      /unitPrice\w*(?: \|\| 0)?\s*\/\s*100\)\.toFixed\(2\)/.test(src),
      false,
      `${f}: a saved sub-cent price would be truncated on open`,
    );
    assert.equal(
      /unitPriceRm: \(Number\(it\.unitPriceSen \|\| 0\) \/ 100\)\.toFixed\(2\)/.test(src),
      false,
      `${f}: the Edit seed must keep the full price`,
    );
  }
});

test('every unit-price INPUT accepts the keystroke', () => {
  // step="0.01" makes the browser refuse 0.055 outright — the operator cannot
  // even type it, which is what Siti was reporting.
  const cases = [
    ['src/components/ui/money-input.tsx', /step="0\.0001"/],
    ['src/pages/procurement/create.tsx', /step="0\.0001"/],
    ['src/pages/procurement/detail.tsx', /step="0\.0001"/],
    ['src/components/scan-supplier-modal.tsx', /step="0\.0001"/],
  ];
  for (const [f, re] of cases) {
    assert.match(read(f), re, `${f}: the unit-price input must allow sub-cent`);
  }
});

test('the shared MoneyInput is where the step lives for the rest', () => {
  // The PI create page, the PI edit grid, the PO modal and the GRN grid all use
  // MoneyInput, so they inherit the step. Pin that they still do — swapping one
  // back to a raw <Input> is how this reappears.
  for (const f of [
    'src/pages/procurement/pi/create.tsx',
    'src/pages/procurement/PurchaseInvoiceDetail.tsx',
    'src/pages/procurement/index.tsx',
    'src/pages/procurement/grn/create.tsx',
  ]) {
    assert.match(read(f), /MoneyInput/, `${f} must use the shared money field`);
  }
});

test('a line total on screen is rounded once, from the full-precision rate', () => {
  // `formatCurrency(qty * unitPriceSen)` on a fractional rate renders fractional
  // sen — "RM 0.165" on the line-total line, which is not a number anyone pays.
  for (const f of [
    'src/pages/procurement/create.tsx',
    'src/pages/procurement/detail.tsx',
    'src/pages/procurement/index.tsx',
  ]) {
    const src = read(f);
    assert.equal(
      /formatCurrency\((?:item|line)\.quantity \* (?:item|line)\.unitPriceSen\)/.test(src),
      false,
      `${f}: the line total must go through lineTotalSen`,
    );
    assert.match(src, /lineTotalSen\(/, `${f}: ...and it must actually call it`);
  }
});

// --- 6. the precision must NOT leak into amounts --------------------------
test('tax, discount and payment fields stay whole sen', () => {
  // An amount that changes hands cannot be a fraction of a sen. If these ever
  // start carrying four decimals, the reconciliation problem simply moves.
  const scan = read('src/components/scan-supplier-modal.tsx');
  assert.match(
    scan,
    /value=\{num\(line\.taxRM\)\}/,
    'premise: the tax cell is still there to check',
  );
  const taxAt = scan.indexOf('value={num(line.taxRM)}');
  const before = scan.slice(Math.max(0, taxAt - 300), taxAt);
  assert.match(before, /step="0\.01"/, 'SST is an amount — two decimals');

  const pi = read('src/pages/procurement/PurchaseInvoiceDetail.tsx');
  assert.match(
    pi,
    /patchLine\(i, \{ unitPriceRm: sen === null \? "0" : \(sen \/ 100\)\.toFixed\(2\) \}\)/,
    'the DISCOUNT branch is an amount and correctly stays at two decimals',
  );
});

test('the API stores the rate and derives the amount, not the reverse', () => {
  const src = read('src/api/routes/purchase-invoices.ts');
  assert.match(src, /const unitPriceSen = roundUnitPriceSen\(Number\(it\.unitPriceSen\)\);/);
  assert.match(src, /lineTotalSen: computeLineTotalSen\(qty, unitPriceSen\)/);
});
