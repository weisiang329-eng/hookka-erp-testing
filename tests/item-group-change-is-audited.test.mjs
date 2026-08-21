// ---------------------------------------------------------------------------
// item-group-change-is-audited
//
// Found 2026-08-21 while answering "should these 12 sponges move from
// B.FILLER to S.FILLER?" — a question that turned out to be an ACCOUNTING
// question, not a labelling one.
//
// `raw_materials.itemGroup` carries the real AutoCount stock-group code, and
// four GL accounts hang off it. Measured on prod that day:
//
//   703-0010  PURCHASE - B.FILLER   RM 76,732.35
//   703-0020  PURCHASE - S.FILLER   RM 92,768.43
//
// So a dropdown on the Inventory screen moves money between P&L accounts —
// and it did it leaving NOTHING behind. The update handler overwrote the old
// group and moved `updated_at`. "Who moved this material, and when did the
// account change?" is a question you only think to ask once the numbers look
// wrong, and by then the before-value was gone. (I had moved 11 materials
// that morning myself; nothing recorded it.)
//
// Two things are pinned here:
//   1. the account resolution matches BOTH live readers, which disagree
//   2. the two write paths that can change a group both emit an audit event
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveGroupAccounts,
  accountDiff,
} from '../src/api/lib/stock-group-accounts.ts';

// A miniature of the real maps — the point is the PRECEDENCE, not the codes.
const DEF = {
  purchase: { 'B.FILLER': '703-0010', 'S.FILLER': '703-0020' },
  purchaseDefault: '704-0010',
  stock: {
    'B.FILLER': { stock: '330-2001', opening: '703-0001', closing: '703-9999' },
    'S.FILLER': { stock: '330-2002', opening: '703-0002', closing: '703-9998' },
  },
  stockDefault: { stock: '330-3001', opening: '704-0001', closing: '704-9991' },
};

// --- the built-in mapping ------------------------------------------------
test('the two filler groups differ on ALL FOUR accounts', () => {
  // The whole reason the sponge question was not cosmetic.
  const b = resolveGroupAccounts('B.FILLER', DEF, null);
  const s = resolveGroupAccounts('S.FILLER', DEF, null);
  assert.deepEqual(b, {
    purchase: '703-0010',
    stock: '330-2001',
    opening: '703-0001',
    closing: '703-9999',
  });
  assert.deepEqual(Object.keys(accountDiff(b, s)), [
    'purchase',
    'stock',
    'opening',
    'closing',
  ]);
});

test('an unmapped group falls to the raw-material default, not to blank', () => {
  assert.deepEqual(resolveGroupAccounts('NO-SUCH-GROUP', DEF, null), {
    purchase: '704-0010',
    stock: '330-3001',
    opening: '704-0001',
    closing: '704-9991',
  });
});

test('a blank group is the default too — never a lookup of ""', () => {
  for (const g of ['', '   ']) {
    assert.equal(resolveGroupAccounts(g, DEF, null).purchase, '704-0010');
  }
});

test('surrounding spaces do not lose the mapping', () => {
  assert.equal(resolveGroupAccounts('  S.FILLER  ', DEF, null).purchase, '703-0020');
});

// --- the owner's kv override, mirrored from the LIVE readers -------------
test('kv rm[g].purchase wins for the purchase account', () => {
  const kv = { rm: { 'B.FILLER': { purchase: '703-9000' } } };
  assert.equal(resolveGroupAccounts('B.FILLER', DEF, kv).purchase, '703-9000');
});

test('a kv entry REPLACES the whole stock triple — it is not field-merged', () => {
  // getStockMap does `rm: {...DEF.rm, ...kv.rm}`, so a kv row carrying only
  // `stock` drops the built-in opening/closing for that group. Mirrored
  // deliberately: tidying this into a field-merge would make this helper
  // disagree with the report that actually posts the numbers.
  const kv = { rm: { 'B.FILLER': { stock: '330-9999' } } };
  const got = resolveGroupAccounts('B.FILLER', DEF, kv);
  assert.equal(got.stock, '330-9999');
  assert.equal(got.opening, '704-0001', 'falls to rmDefault, NOT to 703-0001');
});

test('kv rmDefault only applies where the group is unmapped', () => {
  const kv = { rmDefault: { purchase: '704-8888', stock: '330-8888' } };
  // mapped group → built-in still wins
  assert.equal(resolveGroupAccounts('B.FILLER', DEF, kv).purchase, '703-0010');
  // unmapped group → the override is the default
  assert.equal(resolveGroupAccounts('MYSTERY', DEF, kv).purchase, '704-8888');
});

test('a null / absent override behaves exactly like no override', () => {
  assert.deepEqual(
    resolveGroupAccounts('S.FILLER', DEF, null),
    resolveGroupAccounts('S.FILLER', DEF, {}),
  );
});

// --- accountDiff ---------------------------------------------------------
test('accountDiff names only what moved, with both sides', () => {
  const a = { purchase: 'p1', stock: 's1', opening: 'o1', closing: 'c1' };
  const b = { purchase: 'p2', stock: 's1', opening: 'o1', closing: 'c1' };
  assert.deepEqual(accountDiff(a, b), { purchase: { from: 'p1', to: 'p2' } });
  assert.deepEqual(accountDiff(a, a), {}, 'same group = no diff, so no audit noise');
});

// --- both write paths leave a trace --------------------------------------
test('every path that can change itemGroup emits an audit event', () => {
  // There are two: the single-row update and the bulk-import upsert. Fixing
  // only the one in front of you is this repo's documented failure mode
  // (BUG-CLASSES.md opens with it), and the bulk sheet is the path that can
  // re-group sixty materials at once.
  const src = readFileSync('src/api/routes/raw-materials.ts', 'utf8');

  assert.match(
    src,
    /!== \(merged\.itemGroup \?\? ""\)\) \{[\s\S]{0,900}?emitAudit\(/,
    'the single-row update must audit a group change',
  );
  assert.match(
    src,
    /regrouped\.push\(\{ itemCode, from: priorGroup, to: itemGroup \}\)/,
    'the bulk import must notice a group change',
  );
  assert.match(
    src,
    /if \(regrouped\.length > 0\) \{[\s\S]{0,700}?emitAudit\(/,
    'the bulk import must audit the group changes it made',
  );

  // The bulk path cannot compare groups it never read.
  assert.match(
    src,
    /SELECT id, itemCode, itemGroup FROM raw_materials/,
    'the bulk pre-fetch must include itemGroup',
  );
});

test('the audit records the ACCOUNTS, not just the group name', () => {
  // A group code six months from now is an archaeology problem: the kv map
  // may have been edited since. Snapshotting the accounts makes the row
  // answer the question it exists for without re-deriving anything.
  const src = readFileSync('src/api/routes/raw-materials.ts', 'utf8');
  assert.match(src, /accounts: before/);
  assert.match(src, /accountsChanged: accountDiff\(before, after\)/);
});

test('this module owns no copy of the account codes', () => {
  // The maps stay with the code that posts and reports off them. A second
  // copy here would drift the moment the owner edits one of them.
  const src = readFileSync('src/api/lib/stock-group-accounts.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /["'](?:33|70)\d-\d{4}["']/.test(code),
    false,
    'stock-group-accounts.ts must import the default maps, never restate them',
  );
});
