// T-006 R1 — the Sales page "Transfer to Delivery Order" sent hand-built
// items with no productionOrderIds, so validateDoComposition's once-only-
// delivery guard never ran (BUG-2026-05-16 class: 13 duplicate DOs, RM
// 24,647 of stock double-consumed). Source-static — no live D1 in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Sales page sends productionOrderIds, not hand-built items, on Transfer to Delivery Order', () => {
  const src = readFileSync('src/pages/sales/index.tsx', 'utf8');
  assert.match(
    src,
    /productionOrderIds: transferReadyPOs\.map\(\(po\) => po\.id\)/,
    'the DO create body must be sourced from ready production orders, not SO items',
  );
  assert.doesNotMatch(
    src,
    /const mappedItems = transferDORow\.items\.map/,
    'the old hand-built items path must be gone',
  );
});

test('the ready-production-orders list is fetched from the same source the working Delivery page uses', () => {
  const src = readFileSync('src/pages/sales/index.tsx', 'utf8');
  assert.match(src, /\/api\/delivery-orders\/ready-planning/);
  assert.match(
    src,
    /forThisSO = \(rp\.ready \?\? \[\]\)\.filter\(\(po\) => po\.salesOrderId === row\.id\)/,
  );
});

test('the create button is disabled when there is nothing ready to transfer', () => {
  const src = readFileSync('src/pages/sales/index.tsx', 'utf8');
  assert.match(
    src,
    /disabled=\{transferLoading \|\| transferPOsLoading \|\| transferReadyPOs\.length === 0\}/,
  );
});

test('the server refuses an SO-linked DO create with no productionOrderIds', () => {
  const src = readFileSync('src/api/routes/delivery-orders/_helpers.ts', 'utf8');
  assert.match(
    src,
    /if \(salesOrderId && productionOrderIds\.length === 0\) \{/,
    'this is the authoritative backstop — even a future caller repeating the old mistake must be refused',
  );
  const idx = src.indexOf('if (salesOrderId && productionOrderIds.length === 0)');
  const guardIdx = src.indexOf('const composition = await validateDoComposition');
  assert.ok(idx > 0 && guardIdx > 0, 'both markers must be present');
  assert.ok(
    guardIdx < idx,
    'the refusal must sit AFTER the point where productionOrderIds is resolved from the request, not before',
  );
});
