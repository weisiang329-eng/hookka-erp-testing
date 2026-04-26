// ---------------------------------------------------------------------------
// production-wip-producer-output.test.mjs — regression test for Bug 2
// (2026-04-26): Wood Cut completion must add a wip_items row.
//
// Bug history: WOOD_CUT job-card completion silently skipped the wip_items
// upsert when jcRow.wipLabel was null. This happens for legacy / non-BOM POs
// (createJobCards() emits JCs without wip* fields), but also for any future
// data path that forgets to populate wipLabel. The user reported on
// 2026-04-26 that completing Wood Cut left the warehouse WIP empty.
//
// Fix: applyWipInventoryChange synthesizes a fallback wipLabel from
// (productCode, wipCode|wipKey, departmentCode) when jcRow.wipLabel is null,
// so producer depts (FAB_CUT, FOAM, WOOD_CUT, FRAMING, WEBBING, PACKING)
// always land a wip_items row on COMPLETED. The Fab Sew atomic-consume on
// (salesOrderId, fabricCode) — required by memory/project_production_lifecycle.md
// — is unchanged: that branch keys on poRow.fabricCode, not wipLabel.
//
// This is a structural test (no D1 runtime). It pins the source-level
// invariants so a future refactor can't silently re-introduce the early-
// return on null wipLabel.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(
  process.cwd(),
  'src/api/routes-d1/production-orders.ts',
);

function read() {
  return readFileSync(SRC, 'utf8');
}

test('applyWipInventoryChange synthesises wipLabel when jcRow.wipLabel is null', () => {
  const src = read();
  // The fallback expression must combine productCode + wipCode/wipKey +
  // departmentCode so each (PO, dept) emits a uniquely-keyed wip_items row.
  // Without this, the early-return at `if (!wipLabel) return;` swallowed
  // every legacy / non-BOM completion silently.
  assert.match(
    src,
    /const wipLabel =\s*\n\s*jcRow\.wipLabel \|\|/,
    'wipLabel should fall back when jcRow.wipLabel is null',
  );
  assert.match(
    src,
    /poRow\.productCode \|\| ""/,
    'fallback should include productCode',
  );
  assert.match(
    src,
    /jcRow\.wipCode \|\| wipKey \|\| ""/,
    'fallback should include wipCode/wipKey',
  );
  assert.match(
    src,
    /deptCodeRaw \? `\(\$\{deptCodeRaw\}\)` : ""/,
    'fallback should include departmentCode in parens',
  );
});

test('WOOD_CUT and FAB_CUT both bypass the upstream-consume gate', () => {
  const src = read();
  // The upstream-consume gate excludes producer-only stages. WOOD_CUT and
  // FAB_CUT are both raw-material entry points and must skip it.
  assert.match(
    src,
    /if \(!isFabCut && !isWoodCut && !isUpholstery && becomingActive\)/,
    'consume gate should exclude FAB_CUT, WOOD_CUT, and UPHOLSTERY',
  );
});

test('producer dept upsert path runs for non-UPH on COMPLETED', () => {
  const src = read();
  // The COMPLETED branch must reach the upsert SQL for FAB_CUT, WOOD_CUT,
  // FOAM, FRAMING, WEBBING, FAB_SEW, PACKING (UPH has its own special
  // branch). Pin both the conditional and the upsert SQL.
  assert.match(
    src,
    /if \(newStatus === "COMPLETED" \|\| newStatus === "TRANSFERRED"\) \{[\s\S]*?if \(isUpholstery\)/,
    'COMPLETED branch should special-case UPHOLSTERY first',
  );
  assert.match(
    src,
    /\/\/ Non-UPH dept: upsert-by-code, accumulate stock on each completion\./,
    'non-UPH path should upsert wip_items',
  );
  assert.match(
    src,
    /INSERT INTO wip_items \(id, code, type, relatedProduct, deptStatus, stockQty, status\)/,
    'upsert path should INSERT into wip_items when no row exists',
  );
});

test('Fab Sew atomic consume on (salesOrderId, fabricCode) is unchanged', () => {
  const src = read();
  // memory/project_production_lifecycle.md: sofa Fab Sew first IN_PROGRESS
  // zeros every wip_item whose label matches Fab Cut labels of sibling POs
  // sharing (salesOrderId, fabricCode). Pin that this rule survives the
  // wipLabel fallback fix.
  assert.match(
    src,
    /WHERE po\.salesOrderId = \?\s*\n\s*AND po\.fabricCode = \?\s*\n\s*AND po\.itemCategory = 'SOFA'\s*\n\s*AND jc\.departmentCode = 'FAB_CUT'/,
    'sofa Fab Sew atomic consume should query by (salesOrderId, fabricCode, FAB_CUT)',
  );
  assert.match(
    src,
    /UPDATE wip_items SET stockQty = 0, status = 'IN_PRODUCTION' WHERE code = \?/,
    'sofa Fab Sew atomic consume should zero out matching wip_items rows',
  );
});

test('PATCH route still calls applyWipInventoryChange when status changes', () => {
  const src = read();
  // The cascade must fire on every status patch (not just COMPLETED) so
  // IN_PROGRESS upstream-consume runs. Pin the call shape.
  assert.match(
    src,
    /if \(body\.status\) \{[\s\S]*?await applyWipInventoryChange\(db, existing, updated, body\.status, refreshed\);/,
    'PATCH should invoke applyWipInventoryChange on status change',
  );
});
