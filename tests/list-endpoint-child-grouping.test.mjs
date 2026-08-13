// ---------------------------------------------------------------------------
// list-endpoint-child-grouping.test.mjs — the QUADRATIC JOIN class (C14).
//
// The shape: a LIST handler fetches its rows' children in one batched query,
// then hands the WHOLE child array to a per-row mapper whose first act is
// `children.filter(c => c.<parentFk> === row.id)`. That filter is a full scan
// of the child array for EVERY parent row — O(N×M) — and it reads as correct,
// because it IS correct. Only the cost is wrong.
//
// This repo has now fixed that shape SIX times across five years of commits,
// each time repairing only the instance in front of the author:
//   2026-05-21 production orders, non-minimal path (rowsToPOsBatch)
//   2026-06-04 sales orders full list (itemsBySO)
//   ...        customers / suppliers / warehouse / consignment-orders /
//              delivery-orders (all the caller-side bucket pattern)
//   2026-08-13 production orders, MINIMAL path (#275) — 35M comparisons,
//              6,473 ms of a 9,587 ms /planning cold call, missed TWICE
//   2026-08-13 this sweep — the four remaining un-bucketed list endpoints
//
// Two parts, mirroring tests/production-orders-jobcard-grouping.test.mjs:
//
// Part 1 (behavioural) pins the EQUIVALENCE every one of those fixes rests on:
//   bucket(children)[row.id].filter(pred) === children.filter(pred)
// element-for-element, same object references, same order — including the
// awkward cases (unsorted input, ties under a later .sort(), parents with no
// children, children of no returned parent). If that property ever fails, the
// "byte-identical" claim behind every fix in this class is void.
//
// Part 2 (source guard) pins each FIXED SITE: the handler must pass a
// per-parent bucket into the mapper, not the whole array. Reverting any one of
// them reintroduces the quadratic silently — nothing breaks, the page just gets
// slower as the table grows, which is exactly how this class keeps surviving.
//
// ADDING A SITE: add a row to SITES. A new list endpoint that hands a whole
// child array to a per-row mapper belongs here, not in a follow-up PR.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Part 1 — the equivalence the whole class depends on
// ---------------------------------------------------------------------------

/** The bucketing every fixed site performs, written once. */
function bucketBy(rows, fk) {
  const by = new Map();
  for (const r of rows) {
    const arr = by.get(r[fk]);
    if (arr) arr.push(r);
    else by.set(r[fk], [r]);
  }
  return by;
}

// Deliberately adversarial: children are NOT in parent order and NOT in sort
// order; p1 has two children tying on `seq` (a stable-sort tie that must hold);
// p3 has no children; "orphan" belongs to a parent outside the returned set.
const CHILDREN = [
  { id: 'c', pid: 'p2', seq: 1 },
  { id: 'a', pid: 'p1', seq: 2 },
  { id: 'orphan', pid: 'p9', seq: 1 },
  { id: 'b', pid: 'p1', seq: 1 },
  { id: 'd', pid: 'p1', seq: 2 },
  { id: 'e', pid: 'p2', seq: 3 },
];
const PARENTS = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

const legacy = (row, all) => all.filter((c) => c.pid === row.id);
const grouped = (row, by) => (by.get(row.id) ?? []).filter((c) => c.pid === row.id);

test('the bucket yields the same children, in the same order, as the full scan', () => {
  const by = bucketBy(CHILDREN, 'pid');
  for (const p of PARENTS) {
    const l = legacy(p, CHILDREN);
    const g = grouped(p, by);
    assert.deepEqual(
      g.map((c) => c.id),
      l.map((c) => c.id),
      `child order diverged for ${p.id}`,
    );
    // Identity, not just deep-equality: the mapper may hand these objects
    // straight through, so a copy would still be a behaviour change.
    assert.equal(g.length, l.length);
    for (let i = 0; i < l.length; i++) {
      assert.equal(g[i], l[i], `child ${i} of ${p.id} is not the same object`);
    }
  }
});

test('a later .sort() sees the same input, so stable-sort ties hold', () => {
  const by = bucketBy(CHILDREN, 'pid');
  const cmp = (a, b) => a.seq - b.seq;
  for (const p of PARENTS) {
    assert.deepEqual(
      grouped(p, by).sort(cmp).map((c) => c.id),
      legacy(p, CHILDREN).sort(cmp).map((c) => c.id),
      `sorted order diverged for ${p.id}`,
    );
  }
  // p1 explicitly: 'b' (seq 1), then the seq-2 pair in SOURCE order.
  assert.deepEqual(
    grouped(PARENTS[0], by).sort(cmp).map((c) => c.id),
    ['b', 'a', 'd'],
  );
});

test('a parent with no children gets an empty array, never undefined', () => {
  const by = bucketBy(CHILDREN, 'pid');
  assert.deepEqual(by.get('p3') ?? [], []);
  assert.deepEqual(grouped(PARENTS[2], by), []);
});

test('children of parents outside the result set are never attached', () => {
  const by = bucketBy(CHILDREN, 'pid');
  for (const p of PARENTS) {
    assert.ok(
      !grouped(p, by).some((c) => c.id === 'orphan'),
      `orphan leaked onto ${p.id}`,
    );
  }
});

test('the mapper cannot reorder the shared bucket (filter copies before sort)', () => {
  // Every fixed site keeps the mapper's own `.filter()` in place, which returns
  // a NEW array — so the mapper's `.sort()` can never reorder the bucket under
  // another row. (PR #275 removed the filter instead, and needed an explicit
  // .slice() for exactly this reason; the caller-side pattern does not.)
  const by = bucketBy(CHILDREN, 'pid');
  const before = (by.get('p1') ?? []).map((c) => c.id);
  grouped(PARENTS[0], by).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(
    (by.get('p1') ?? []).map((c) => c.id),
    before,
    'the bucket was reordered — the mapper sorted in place',
  );
});

test('bucketing does not mutate or reorder the caller rows array', () => {
  const rows = CHILDREN.map((c) => ({ ...c }));
  const before = rows.map((c) => c.id);
  bucketBy(rows, 'pid');
  assert.deepEqual(rows.map((c) => c.id), before);
});

// ---------------------------------------------------------------------------
// Part 2 — every fixed site stays bucketed
//
// `mapperCall` is matched against the file with whitespace collapsed, so
// reformatting does not break the guard but re-passing the whole array does.
// `mustNotContain` is the pre-fix call verbatim: it is what a revert looks like.
// ---------------------------------------------------------------------------
const SITES = [
  {
    name: 'products GET / — boms + dept_working_times per product',
    file: 'src/api/routes/products.ts',
    buckets: ['const bomsByProductId = new Map<', 'const dwtsByProductId = new Map<'],
    mapperCall: 'bomsByProductId.get(p.id) ?? [], dwtsByProductId.get(p.id) ?? [],',
    mustNotContain: ['rowToProduct( p, boms.results ?? [], dwts.results ?? [],'],
    // 365 ACTIVE products x 1,697 dwts = 619,405 comparisons (prod 2026-08-13).
    // No LIMIT on this list and ~4.65 dwts per SKU, so the cost is ~4.65*N^2 in
    // catalog size — the steepest slope of any site in this class.
  },
  {
    name: 'qc-inspections GET / — defects + items per inspection',
    file: 'src/api/routes/qc-inspections.ts',
    buckets: ['const defsByInspectionId = new Map<', 'const itemsByInspectionId = new Map<'],
    mapperCall: 'defsByInspectionId.get(r.id) ?? [], itemsByInspectionId.get(r.id) ?? [],',
    mustNotContain: ['rowToInspection(r, defRes.results ?? [], itemRes.results ?? [])'],
    // 500 inspections (the LIMIT) x 2,151 items = 1,075,500 comparisons,
    // bounded on both sides by that LIMIT. This used to be annotated "the
    // largest in the class" — it is not: the qc-pending twin below is ~75x
    // bigger and UNBOUNDED, and it was missed because nobody looked past the
    // file the report named. That is this class's whole failure mode.
  },
  {
    name: 'qc-pending GET / — checklist items per pending inspection',
    file: 'src/api/routes/qc-pending.ts',
    buckets: ['const itemsByInspection = new Map<'],
    mapperCall: 'rowToInspection(r, itemsByInspection.get(r.id) ?? []),',
    mustNotContain: ['inspections.map((r) => rowToInspection(r, itemsResults))'],
    // 2,839 PENDING/IN_PROGRESS rows (measured on prod 2026-08-01, recorded in
    // quality.tsx's slot-card geometry note) x ~28,000 checklist items
    // = ~80M comparisons. NO LIMIT on the parent query, and quality.tsx calls
    // the endpoint with no query string at all, so nothing narrows it — the
    // cost grows quadratically with the QC backlog.
  },
  {
    name: 'purchase-orders GET / — items per PO',
    file: 'src/api/routes/purchase-orders.ts',
    buckets: ['const itemsByPoId = new Map<'],
    mapperCall: 'rowToPO(p, itemsByPoId.get(p.id) ?? []),',
    mustNotContain: ['rowToPO(p, items.results ?? []),'],
    // 165 POs x 369 items = 60,885 comparisons; ~2.24*N^2, unbounded list.
  },
  {
    name: 'grn GET / — items per GRN',
    file: 'src/api/routes/grn.ts',
    buckets: ['const itemsByGrnId = new Map<'],
    mapperCall: 'rowToGRN(g, itemsByGrnId.get(g.id) ?? [])',
    mustNotContain: ['grnRows.map((g) => rowToGRN(g, itemsRes.results ?? []))'],
    // 37 GRNs x 45 items = 1,665 comparisons; ~1.2*N^2, unbounded list.
  },
];

const flat = (s) => s.replace(/\s+/g, ' ');

for (const site of SITES) {
  test(`${site.name} stays O(N+M)`, () => {
    const raw = readFileSync(resolve(process.cwd(), site.file), 'utf8');
    const src = flat(raw);

    for (const b of site.buckets) {
      assert.ok(
        src.includes(flat(b)),
        `${site.file}: the per-parent bucket \`${b}\` is gone — the list went back to a full scan per row`,
      );
    }
    assert.ok(
      src.includes(flat(site.mapperCall)),
      `${site.file}: the mapper is no longer called with a bucket (expected \`${site.mapperCall}\`)`,
    );
    for (const bad of site.mustNotContain) {
      assert.ok(
        !src.includes(flat(bad)),
        `${site.file}: the pre-fix call \`${bad}\` is back — every row rescans the whole child array`,
      );
    }
  });
}

// The 2026-08-13 production-orders fix (#275) uses the OTHER shape in this
// class — an optional pre-grouped Map argument on the mapper itself, because
// that mapper has single-PO callers that must keep the legacy filter. Its own
// behaviour is pinned by tests/production-orders-jobcard-grouping.test.mjs;
// pinned here only so the class has one complete instance list.
test('the production-orders minimal path still pre-groups its job cards', () => {
  const src = flat(
    readFileSync(resolve(process.cwd(), 'src/api/routes/production-orders/_helpers.ts'), 'utf8'),
  );
  assert.ok(
    src.includes('export function groupJobCardsByPoId('),
    'groupJobCardsByPoId is gone — the /planning minimal path is quadratic again (35M comparisons on prod)',
  );
  assert.equal(
    (src.match(/groupJobCardsByPoId\(/g) ?? []).length >= 5,
    true,
    'groupJobCardsByPoId lost callers — one of the minimal paths went back to the per-PO filter',
  );
});
