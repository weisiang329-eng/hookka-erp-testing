// Route checks are source-static (regex) — no live D1 in CI, same
// constraint as item-group-change-is-audited.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shapeProductBulkRow } from '../src/api/lib/product-bulk-import.ts';

// --- shapeProductBulkRow --------------------------------------------------

test('code is required', () => {
  const r = shapeProductBulkRow({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /code is required/);
});

test('a blank optional cell is ABSENT from the shaped row, not defaulted', () => {
  const r = shapeProductBulkRow({ code: 'BF-001', name: 'Roma', category: 'BEDFRAME', sizeCode: 'K' });
  assert.equal(r.ok, true);
  assert.equal('status' in r.row, false, 'status must be omitted, not ""');
  assert.equal('baseModel' in r.row, false);
  assert.equal('basePriceSen' in r.row, false);
});

test('an empty status cell does not become a value at all — it cannot hide the SKU', () => {
  const r = shapeProductBulkRow({ code: 'BF-001', status: '' });
  assert.equal(r.ok, true);
  assert.equal('status' in r.row, false);
});

test('status must be a valid enum value — an invalid one is REJECTED, not written', () => {
  const r = shapeProductBulkRow({ code: 'BF-001', status: 'DELETED' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /status must be one of ACTIVE, INACTIVE/);
});

test('category is case-insensitive and normalises to upper', () => {
  const r = shapeProductBulkRow({ code: 'SF-001', category: 'sofa' });
  assert.equal(r.ok, true);
  assert.equal(r.row.category, 'SOFA');
});

test('an unknown category is rejected with the valid list in the reason', () => {
  const r = shapeProductBulkRow({ code: 'X-001', category: 'CHAIR' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /BEDFRAME, SOFA, ACCESSORY/);
});

test('a new BEDFRAME row without sizeCode is rejected (BUG-2026-06-22-008 class)', () => {
  const r = shapeProductBulkRow({ code: 'BF-002', category: 'BEDFRAME' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sizeCode is required for BEDFRAME/);
});

test('basePriceSen/costPriceSen arrive in RM (already money-parsed client-side by BatchImportDialog) and convert to sen', () => {
  const r = shapeProductBulkRow({ code: 'SF-002', basePriceSen: 2500, costPriceSen: 1500.5 });
  assert.equal(r.ok, true);
  assert.equal(r.row.basePriceSen, 250000);
  assert.equal(r.row.costPriceSen, 150050);
});

test('a non-numeric price cell is simply omitted, not coerced to 0', () => {
  const r = shapeProductBulkRow({ code: 'SF-003', basePriceSen: 'n/a' });
  assert.equal(r.ok, true);
  assert.equal('basePriceSen' in r.row, false);
});

test('code and other string fields are trimmed', () => {
  const r = shapeProductBulkRow({ code: '  BF-003  ', name: '  Roma Bedframe  ' });
  assert.equal(r.ok, true);
  assert.equal(r.row.code, 'BF-003');
  assert.equal(r.row.name, 'Roma Bedframe');
});

test('description and unitM3 are shaped the same blank-omitted way as every other field', () => {
  const withValues = shapeProductBulkRow({ code: 'SF-004', description: 'Cream leather', unitM3: '1.25' });
  assert.equal(withValues.ok, true);
  assert.equal(withValues.row.description, 'Cream leather');
  assert.equal(withValues.row.unitM3, 1.25);

  const blank = shapeProductBulkRow({ code: 'SF-005', description: '', unitM3: '' });
  assert.equal(blank.ok, true);
  assert.equal('description' in blank.row, false);
  assert.equal('unitM3' in blank.row, false);
});

// --- the route itself (static — no live D1 in CI) -------------------------

test('POST /api/products/bulk-import exists, is transactional, and audits the whole sheet', () => {
  const src = readFileSync('src/api/routes/products.ts', 'utf8');
  assert.match(src, /app\.post\("\/bulk-import"/, 'the endpoint must exist');
  assert.match(
    src,
    /requirePermission\(c, "products", "create"\)/,
    'the endpoint must be permission-gated like every other write',
  );
  assert.match(
    src,
    /buildAuditStatement\(c, \{[\s\S]{0,300}?resource: "products"/,
    'must build the audit row as a statement, not fire-and-forget emitAudit',
  );
  assert.match(
    src,
    /if \(auditStmt\) statements\.push\(auditStmt\);[\s\S]{0,100}?await c\.var\.DB\.batch\(statements\)/,
    'the audit statement must be pushed into the SAME batch as the row writes',
  );
  assert.match(src, /rows\.length > 5000/, 'must cap the sheet size like the RM bulk-import does');
});

test('Inventory Batch Import FG actually calls the endpoint — not just local state', () => {
  const src = readFileSync('src/pages/inventory/index.tsx', 'utf8');
  assert.match(
    src,
    /fetch\("\/api\/products\/bulk-import"/,
    'handleImportFG must POST to the real endpoint',
  );
  assert.doesNotMatch(
    src,
    /these are still local-only; they do not POST to D1/,
    'the old "not wired" comment must be gone once it is actually wired',
  );
});

test('Inventory Batch Import RM calls the existing raw-materials endpoint', () => {
  const src = readFileSync('src/pages/inventory/index.tsx', 'utf8');
  assert.match(
    src,
    /fetch\("\/api\/raw-materials\/bulk-import"/,
    'handleImportRM must POST to the existing RM bulk-import endpoint',
  );
});

test('a blank optional cell in BatchImportDialog is omitted, not coerced to 0/""', () => {
  const src = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(
    src,
    /values\[col\.key\] = col\.type === "boolean" \? false : undefined;/,
    'R5: empty optional number must become undefined (omitted from JSON), not 0',
  );
});

// --- shapeProductBulkRow: id / rename ---------------------------------

test('id passes through when present, absent when not', () => {
  const withId = shapeProductBulkRow({ code: 'BF-001', id: 'prod-abc' });
  assert.equal(withId.ok, true);
  assert.equal(withId.row.id, 'prod-abc');
  const withoutId = shapeProductBulkRow({ code: 'BF-002' });
  assert.equal(withoutId.ok, true);
  assert.equal('id' in withoutId.row, false);
});

// --- rename + unchanged-row filtering (source-static) ------------------

test('BatchImportDialog matches by id first, detects rename vs plain update, and rejects a code collision', () => {
  const src = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(src, /const byIdMatch = idValue \? byId\.get\(idValue\) : undefined;/);
  assert.match(src, /category = "renamed";/);
  assert.match(
    src,
    /is already used by another record/,
    'a renamed row colliding with a different existing record must be rejected, not silently renamed',
  );
});

test('BatchImportDialog drops rows identical to their existing match from the preview', () => {
  const src = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(src, /const fieldsEqual = \(a: ImportRow, b: ImportRow\): boolean =>/);
  assert.match(src, /const nonEmpty = withData\.filter\(\(r\) => !r\.unchanged\);/);
});

test('products.ts bulk-import matches by id and updates the code column on rename', () => {
  const src = readFileSync('src/api/routes/products.ts', 'utf8');
  assert.match(src, /const prior = \(r\.id && idToState\.get\(r\.id\)\) \|\| codeToState\.get\(r\.code\);/);
  assert.match(src, /UPDATE products SET\s*\n\s*code = \?/);
  assert.match(
    src,
    /is already used by another product/,
    'a rename that collides with a different existing product must be rejected',
  );
});

test('raw-materials.ts bulk-import matches by id and updates itemCode on rename', () => {
  const src = readFileSync('src/api/routes/raw-materials.ts', 'utf8');
  assert.match(src, /const priorCode = bodyId \? idToCode\.get\(bodyId\) : undefined;/);
  assert.match(src, /UPDATE raw_materials SET\s*\n\s*itemCode = \?/);
  assert.match(
    src,
    /is already used by another record/,
    'a rename that collides with a different existing item must be rejected',
  );
  // The audit test's pinned patterns must still match after this edit.
  assert.match(src, /regrouped\.push\(\{ itemCode, from: priorGroup, to: itemGroup \}\)/);
  assert.match(src, /if \(regrouped\.length > 0\) \{[\s\S]{0,700}?emitAudit\(/);
});

// --- before/after diff on update rows -----------------------------------

test('BatchImportDialog resolves the matched record onto the row for diff display', () => {
  const src = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(src, /existing\?: ImportRow;/, 'ParsedRow must carry the matched record');
  assert.match(src, /return \{ idx: i \+ 2, values, errors, keyValue, category, unchanged, existing \};/);
});

test('renderCell shows old → new only for fields that actually changed', () => {
  const src = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(src, /function fieldChanged\(col: ImportColumn, incoming: unknown, current: unknown\): boolean \{/);
  assert.match(src, /if \(incoming === undefined\) return false;/, 'a blank cell must never render as a change');
  assert.match(
    src,
    /const showDiff =\s*\n\s*\(r\.category === "update" \|\| r\.category === "renamed"\) &&/,
    'diff rendering must be gated to update/renamed rows, not new rows',
  );
});

// --- the id column is functional but never shown to users --------------

test('a hidden ImportColumn is excluded from the legend and preview table, but still exported/parsed', () => {
  const dialogSrc = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(dialogSrc, /hidden\?: boolean;/, 'ImportColumn must support a hidden flag');
  assert.match(
    dialogSrc,
    /columns\.filter\(\(c\) => !c\.hidden\)\.map\(\(c\) =>/g,
    'legend and preview table must filter out hidden columns',
  );
  assert.match(
    dialogSrc,
    /hidden: c\.hidden \|\| undefined/,
    'the exported Excel column itself must be marked hidden, not just omitted from the on-screen table',
  );
  const count = (dialogSrc.match(/columns\.filter\(\(c\) => !c\.hidden\)\.map\(\(c\) =>/g) ?? []).length;
  assert.equal(count, 3, 'the legend, preview table header, and preview table body must all filter hidden columns');
});

test('the id column on FG/RM import is marked hidden, not shown as a regular field', () => {
  const src = readFileSync('src/pages/inventory/index.tsx', 'utf8');
  const idCols = src.match(/\{ key: "id", label: "ID", hidden: true \}/g) ?? [];
  assert.equal(idCols.length, 2, 'both fgImportColumns and rmImportColumns must hide their id column');
});

// --- Products page migrated onto the shared BatchImportDialog ------------

test('Products page uses BatchImportDialog, not a hand-rolled CSV parser', () => {
  const src = readFileSync('src/pages/products/index.tsx', 'utf8');
  assert.match(src, /import \{ BatchImportDialog, type ImportColumn \} from "@\/components\/ui\/batch-import-dialog";/);
  assert.match(src, /<BatchImportDialog/, 'the dialog must actually be rendered');
  assert.match(src, /onImport=\{handleProductBulkImport\}/);
  assert.doesNotMatch(src, /function parseCsvLine/, 'the hand-rolled CSV line parser must be gone');
  assert.doesNotMatch(src, /function csvEscape/, 'the hand-rolled CSV escaper must be gone');
  assert.doesNotMatch(src, /PUT `\/api\/products\/\$\{existing\.id\}`/, 'the per-row PUT loop must be gone');
});

test('Products page bulk import posts to the real endpoint and refreshes state', () => {
  const src = readFileSync('src/pages/products/index.tsx', 'utf8');
  assert.match(src, /fetch\("\/api\/products\/bulk-import"/);
  assert.match(src, /await reloadProductsAfterSchedule\(\);/);
});

test('Products page id column is hidden, like Inventory', () => {
  const src = readFileSync('src/pages/products/index.tsx', 'utf8');
  assert.match(src, /\{ key: "id", label: "ID", hidden: true \}/);
});
