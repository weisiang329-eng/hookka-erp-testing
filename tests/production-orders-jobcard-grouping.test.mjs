// ---------------------------------------------------------------------------
// production-orders-jobcard-grouping.test.mjs
//
// Locks the two perf fixes that made the /planning cold start survivable
// (2026-08-13), BOTH of which are only safe because they are output-preserving.
// If a future change breaks that equivalence, this fails instead of shipping a
// payload that is quietly missing job cards.
//
// Measured on prod data before the fix (957 POs / 36,796 org job cards):
//   - rowToMinimalPO's per-PO `jobCards.filter(...)` = 957 × 36,796 ≈ 35M
//     comparisons, 6,473 ms of the 9,587 ms cold call. Pre-grouped: 13 ms.
//   - the full-org job-card SELECT pulled 36,796 rows / 30.8 MB to keep
//     13,418 rows / 10.8 MB (874 ms → 203 ms once narrowed).
//
// Part 1 (behavioural): the pre-grouped path must produce EXACTLY the job-card
// sequence the legacy filter produced — same cards, same order — including the
// awkward cases (duplicate sequence numbers, unsorted input, POs with no cards,
// job cards belonging to no returned PO).
//
// Part 2 (source guard): the no-dept / no-status minimal job-card fetch must
// stay scoped to the request's PO set. Reverting it to `WHERE orgId = ?` alone
// is the exact regression that costs 20 MB and ~670 ms per cold call.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HELPERS = 'src/api/routes/production-orders/_helpers.ts';

const { groupJobCardsByPoId, rowToMinimalPO } = await import(
  '../src/api/routes/production-orders/_helpers.ts'
);

const jc = (id, productionOrderId, sequence, departmentCode) => ({
  id,
  productionOrderId,
  sequence,
  departmentCode,
  status: 'PENDING',
  dueDate: '2026-08-20',
  estMinutes: 10,
  wipQty: 1,
});

const po = (id) => ({
  id,
  poNo: `PO-${id}`,
  quantity: 1,
  itemCategory: 'BEDFRAME',
  status: 'PENDING',
});

// Deliberately adversarial fixture:
//  - job cards are NOT in PO order, and NOT in sequence order
//  - p1 has two cards sharing sequence 2 (stable-sort tie — order must hold)
//  - p3 has no job cards at all
//  - "orphan" belongs to a PO that is not in the returned set
const JCS = [
  jc('c', 'p2', 1, 'FAB_CUT'),
  jc('a', 'p1', 2, 'FAB_SEW'),
  jc('orphan', 'p9', 1, 'FAB_CUT'),
  jc('b', 'p1', 1, 'FAB_CUT'),
  jc('d', 'p1', 2, 'FRAMING'),
  jc('e', 'p2', 3, 'PACKING'),
];
const POS = [po('p1'), po('p2'), po('p3')];

const idsOf = (out) => out.jobCards.map((j) => j.id);

test('grouped path returns the same job cards, in the same order, as the filter', () => {
  const byPo = groupJobCardsByPoId(JCS);
  for (const p of POS) {
    const legacy = rowToMinimalPO(p, JCS, new Map(), null, null, null, null, null);
    const grouped = rowToMinimalPO(p, JCS, new Map(), null, null, null, null, null, null, byPo);
    assert.deepEqual(
      idsOf(grouped),
      idsOf(legacy),
      `job-card order diverged for ${p.id}`,
    );
    // Pin the whole emitted shape, not just the ids — a field dropped only on
    // the grouped path would otherwise slip through.
    assert.deepEqual(grouped.jobCards, legacy.jobCards, `job-card payload diverged for ${p.id}`);
  }
});

test('the stable-sort tie on equal sequence numbers is preserved', () => {
  const byPo = groupJobCardsByPoId(JCS);
  const grouped = rowToMinimalPO(POS[0], JCS, new Map(), null, null, null, null, null, null, byPo);
  // p1: 'b' (seq 1), then the seq-2 pair in SOURCE order — 'a' before 'd'.
  assert.deepEqual(idsOf(grouped), ['b', 'a', 'd']);
});

test('a PO with no job cards yields an empty array, not undefined', () => {
  const byPo = groupJobCardsByPoId(JCS);
  const grouped = rowToMinimalPO(POS[2], JCS, new Map(), null, null, null, null, null, null, byPo);
  assert.deepEqual(grouped.jobCards, []);
});

test('job cards of POs outside the result set are never attached', () => {
  const byPo = groupJobCardsByPoId(JCS);
  for (const p of POS) {
    const grouped = rowToMinimalPO(p, JCS, new Map(), null, null, null, null, null, null, byPo);
    assert.ok(!idsOf(grouped).includes('orphan'), `orphan leaked onto ${p.id}`);
  }
});

test('grouping does not mutate the caller rows array', () => {
  const rows = JCS.map((j) => ({ ...j }));
  const before = rows.map((j) => j.id);
  const byPo = groupJobCardsByPoId(rows);
  for (const p of POS) {
    rowToMinimalPO(p, rows, new Map(), null, null, null, null, null, null, byPo);
  }
  assert.deepEqual(
    rows.map((j) => j.id),
    before,
    'rowToMinimalPO reordered the shared job-card array (missing slice() before sort)',
  );
});

test('the no-dept / no-status job-card fetch stays scoped to the PO set', () => {
  const src = readFileSync(resolve(process.cwd(), HELPERS), 'utf8');
  assert.ok(
    src.includes('const jcNarrowWhere'),
    'jcNarrowWhere is gone — the full-org job-card fetch was un-narrowed',
  );
  assert.ok(
    /jcNarrowWhere\s*=\s*` WHERE orgId = \? AND productionOrderId IN \(SELECT id FROM \$\{poSource\} WHERE \$\{poWhereSql\}\)`/.test(
      src,
    ),
    'jcNarrowWhere must reuse poWhereSql verbatim — a divergent PO predicate silently drops job cards',
  );
  // The narrow is worthless if the fetch stops using it.
  assert.ok(
    src.includes('`SELECT * FROM ${jcSource}${jcNarrowWhere}`'),
    'the minimal full-fetch path no longer applies jcNarrowWhere',
  );
  // Exactly ONE bare full-org job-card SELECT may remain: the non-minimal
  // legacy full-payload path (which also full-scans piece_pics and is already
  // O(N+M) via rowsToPOsBatch — deliberately left alone by the 2026-08-13 perf
  // work). A second occurrence means the minimal path regressed.
  const bare = src.match(/\.prepare\(`SELECT \* FROM \$\{jcSource\} WHERE orgId = \?`\)/g) ?? [];
  assert.equal(
    bare.length,
    1,
    `expected exactly 1 bare full-org job-card SELECT (the non-minimal legacy path), found ${bare.length} — the minimal path likely regressed`,
  );
});
