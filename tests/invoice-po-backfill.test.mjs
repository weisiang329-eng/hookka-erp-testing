import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/invoice-po-backfill.ts")).href);

const inv = (id, code, fab, size = "5FT", po = null) => ({ id, productCode: code, fabricCode: fab, sizeLabel: size, productionOrderId: po });
const dol = (code, fab, size = "5FT", po = null) => ({ productCode: code, fabricCode: fab, sizeLabel: size, productionOrderId: po });

test("collapsed-PO shape (INV-2606-126): same product+fabric lines from different POs all link", () => {
  const r = m.matchInvoiceLinesToDoLines(
    [inv("a", "1013", "PC151-01"), inv("b", "1013", "PC151-01"), inv("c", "1013", "PC151-04")],
    [dol("1013", "PC151-01", "5FT", "po-C31"), dol("1013", "PC151-01", "5FT", "po-A40"), dol("1013", "PC151-04", "5FT", "po-C13A")],
  );
  assert.equal(r.ok, true);
  assert.equal(r.assignments.length, 3);
  const pos = r.assignments.map((x) => x.productionOrderId).sort();
  assert.deepEqual(pos, ["po-A40", "po-C13A", "po-C31"]); // the group's PO multiset is fully restored
  assert.equal(r.unlinkableLines, 0);
});

test("count mismatch (consolidated invoice line) refuses the whole invoice", () => {
  const r = m.matchInvoiceLinesToDoLines(
    [inv("a", "1013", "PC151-01")],
    [dol("1013", "PC151-01", "5FT", "po-1"), dol("1013", "PC151-01", "5FT", "po-2")],
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /count differs/);
});

test("group mismatch refuses (different fabric sets)", () => {
  const r = m.matchInvoiceLinesToDoLines(
    [inv("a", "1013", "PC151-01"), inv("b", "1013", "PC151-09")],
    [dol("1013", "PC151-01", "5FT", "po-1"), dol("1013", "PC151-04", "5FT", "po-2")],
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /group/);
});

test("already-linked lines are preserved and consume their DO twin", () => {
  const r = m.matchInvoiceLinesToDoLines(
    [inv("a", "1013", "PC151-01", "5FT", "po-X"), inv("b", "1013", "PC151-01")],
    [dol("1013", "PC151-01", "5FT", "po-X"), dol("1013", "PC151-01", "5FT", "po-Y")],
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.assignments, [{ invoiceItemId: "b", productionOrderId: "po-Y" }]); // a untouched
});

test("linked line with no DO twin refuses (never silently rewrite a link)", () => {
  const r = m.matchInvoiceLinesToDoLines(
    [inv("a", "1013", "PC151-01", "5FT", "po-GONE")],
    [dol("1013", "PC151-01", "5FT", "po-Y")],
  );
  assert.equal(r.ok, false);
});

test("DO line without productionOrderId leaves that invoice line unlinked (counted, not guessed)", () => {
  const r = m.matchInvoiceLinesToDoLines(
    [inv("a", "1013", "PC151-01"), inv("b", "1013", "PC151-01")],
    [dol("1013", "PC151-01", "5FT", "po-1"), dol("1013", "PC151-01", "5FT", null)],
  );
  assert.equal(r.ok, true);
  assert.equal(r.assignments.length, 1);
  assert.equal(r.unlinkableLines, 1);
});
