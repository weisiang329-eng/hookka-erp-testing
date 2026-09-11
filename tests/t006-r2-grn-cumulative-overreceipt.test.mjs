// T-006 R2 — GRN over-receipt must be checked CUMULATIVELY against the PO
// line's receivedQty (every GRN already posted), not just this document's
// own quantity. Was per-document only: two separate 100-unit GRNs against a
// 100-unit PO line each individually read "100 <= 110" and both posted.
// Source-static — no live D1 in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/grn.ts', 'utf8');
const block = SRC.slice(
  SRC.indexOf('// Over-receipt validation'),
  SRC.indexOf('// Over-receipt validation') + 1200,
);

test('the tolerance check reads receivedQty already on the PO line, not just this document', () => {
  assert.match(block, /const alreadyReceived = Number\(poItem\.receivedQty\) \|\| 0;/);
  assert.match(block, /const cumulative = alreadyReceived \+ item\.receivedQty;/);
});

test('the comparison is against the CUMULATIVE total, not the per-document quantity alone', () => {
  assert.match(block, /if \(cumulative > tolerance\)/);
  assert.doesNotMatch(
    block,
    /if \(item\.receivedQty > tolerance\)/,
    'the old per-document-only comparison must be gone, not left alongside the new one',
  );
});

test('the error message names both the already-received and this-receipt quantities', () => {
  assert.match(block, /already received \$\{alreadyReceived\}/);
  assert.match(block, /this receipt \$\{item\.receivedQty\}/);
});
