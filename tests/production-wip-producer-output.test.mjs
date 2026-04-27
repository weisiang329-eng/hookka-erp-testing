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

test('cascade consume is unclamped — no MAX(0, stockQty - qty)', () => {
  const src = read();
  // BUG-2026-04-27-013: skipped / out-of-order dept completions must
  // surface as negative wip_items.stock_qty instead of being clamped to
  // 0. The forward consume, the rollback own-row decrement, and the
  // UPH cascade must all use plain `stockQty - ?` (no MAX(0, ...)).
  // This pin guards against a future refactor silently re-introducing
  // the clamp.
  assert.doesNotMatch(
    src,
    /UPDATE wip_items SET stockQty = MAX\(0, stockQty - \?\)/,
    'no MAX(0, stockQty - ?) clamp anywhere in applyWipInventoryChange',
  );
  // The forward consume / rollback / UPH cascade must still use the
  // unclamped subtraction form on wip_items.
  assert.match(
    src,
    /UPDATE wip_items SET stockQty = stockQty - \?/,
    'cascade consume still subtracts from stockQty (just without the MAX clamp)',
  );
});

test('cascade consume inserts a negative-qty row when upstream is missing', () => {
  const src = read();
  // BUG-2026-04-27-013: when the consume target wip_items row doesn't
  // exist (upstream JC was skipped / never completed), the consume
  // must INSERT a placeholder with stock_qty = -consumeQty so the
  // negative number surfaces the missed dept on the WIP board, instead
  // of silently no-op'ing.
  assert.match(
    src,
    /-consumeQty/,
    'forward / UPH cascade must INSERT with negative qty when row is missing',
  );
  // The PENDING deptStatus marks these stub rows as "no real owner yet"
  // so the UI / queries can distinguish them from completed-by-dept rows.
  assert.match(
    src,
    /VALUES \(\?, \?, \?, \?, \?, \?, 'PENDING'\)/,
    'missing-upstream INSERT uses status=PENDING to flag the stub row',
  );
});

test('PATCH route still calls applyWipInventoryChange when status changes', () => {
  const src = read();
  // The cascade must fire on every status patch (not just COMPLETED) so
  // IN_PROGRESS upstream-consume runs. Pin the call: it must occur inside
  // an `if (body.status)` block, take db/existing/updated/body.status/
  // refreshed, AND pass jcRow.status as the prevStatus arg so the
  // BUG-2026-04-27-002 rollback branch can detect a DONE → non-DONE
  // transition.
  assert.match(
    src,
    /if \(body\.status\) \{[\s\S]*?await applyWipInventoryChange\(\s*db,\s*existing,\s*updated,\s*body\.status,\s*refreshed,\s*jcRow\.status,?\s*\);/,
    'PATCH should invoke applyWipInventoryChange(prevStatus=jcRow.status) on status change',
  );
});

test('applyWipInventoryChange short-circuits on prevStatus === newStatus', () => {
  const src = read();
  // BUG-2026-04-27-005: same-status replays must NOT re-run the cascade,
  // otherwise a duplicate PATCH (form re-submit, two operators racing,
  // scan-complete + manual-PATCH overlap) doubles every consume and
  // producer-add.
  assert.match(
    src,
    /if \(prevStatus !== null && prevStatus === newStatus\) return;/,
    'cascade should bail when the status did not actually change',
  );
});
