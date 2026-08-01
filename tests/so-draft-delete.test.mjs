// ---------------------------------------------------------------------------
// so-draft-delete.test.mjs — a DRAFT sales order can be deleted from the list,
// and only a DRAFT can be deleted at all (owner 2026-08-01: 「我要可以delete SO
// draft，要不然如果不对的话我要删除都做不到，这只是draft」).
//
// Two defects, measured on staging:
//   1. The list had NO delete affordance anywhere — the row context menu ran
//      View / Edit / Print / Transfer×2 / Status log / Refresh, and the Draft
//      toolbar offered only Convert + Re-assign. The endpoint itself was
//      healthy (a bogus id returned 404 not 403; a real draft deleted with
//      200), so "can't delete" was purely a missing entry point.
//   2. DELETE had NO status guard: any order with no FK children could be
//      deleted outright, CONFIRMED and shipped ones included — a worse failure
//      than the one being fixed.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const list = readFileSync("src/pages/sales/index.tsx", "utf8");
const route = readFileSync("src/api/routes/sales-orders.ts", "utf8");

test("the row context menu offers Delete — and only on DRAFT rows", () => {
  assert.match(list, /row\.status === "DRAFT"\s*\?\s*\[/, "menu entry must be gated on DRAFT");
  assert.match(list, /label: "Delete draft"/);
  assert.match(list, /danger: true/);
  assert.match(list, /deleteDrafts\(\[row\]\)/);
});

test("the Draft toolbar offers bulk delete alongside Convert", () => {
  assert.match(list, /deleteDrafts\(selectedRows\)/);
  const convertAt = list.indexOf('"Convert to Confirmed"');
  const deleteAt = list.indexOf("deleteDrafts(selectedRows)");
  assert.ok(convertAt > 0 && deleteAt > convertAt, "bulk delete sits with Convert in the Draft bar");
});

test("deleteDrafts filters to DRAFT, confirms, and reports per-order failures", () => {
  assert.match(list, /rows\.filter\(\(r\) => r\.status === "DRAFT"\)/, "never deletes a non-draft");
  assert.match(list, /await confirm\(\{/, "destructive action must confirm first");
  assert.match(list, /method: "DELETE"/);
  // A linked-document rejection applies to specific rows, so errors are
  // surfaced per order rather than as one blanket toast.
  assert.match(list, /failures\.push\(/);
  assert.match(list, /for \(const f of failures\) toast\.error\(f\);/);
  // The list must refresh and drop the stale selection.
  assert.match(list, /invalidateCachePrefix\("\/api\/sales-orders"\)/);
  assert.match(list, /setSelectedRows\(\[\]\)/);
});

test("DELETE /:id refuses anything that is not a DRAFT", () => {
  assert.match(route, /if \(status !== "DRAFT"\)/, "status guard must exist");
  assert.match(route, /only DRAFT orders can be deleted/);
  // 409, not 400 — the request is well formed, the order's state forbids it.
  assert.match(route, /only DRAFT orders can be deleted[\s\S]{0,200}?409/);
  // The guard has to read status, so the SELECT must fetch it.
  assert.match(route, /SELECT id, companySOId, status FROM sales_orders WHERE id = \?/);
});

test("an FK rejection becomes an actionable message, not a bare HTTP 500", () => {
  assert.match(route, /foreign key\|violates\|constraint/i);
  assert.match(route, /still has linked documents/);
  // Anything that is NOT an FK violation must keep propagating.
  assert.match(route, /throw e;/);
});

// --- SO number uniqueness (same race class as the double-invoice bug) --------

test("companySOId is protected by a storage-level unique index", () => {
  const helpers = readFileSync("src/api/routes/sales-orders/_helpers.ts", "utf8");
  assert.match(helpers, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_company_so_id/);
  assert.match(helpers, /ON sales_orders \(company_so_id\)/);
  // Idempotent + memoised per isolate, and a failure must not block order entry.
  assert.match(helpers, /_soIdUniqueMig/);
  assert.match(helpers, /\.catch\(\(\) => undefined\)/);
});

test("the create path ensures the index before minting a number", () => {
  const ensureAt = route.indexOf("await ensureCompanySOIdUnique(c.var.DB)");
  const mintAt = route.indexOf("const companySOId = await generateCompanySOId(");
  assert.ok(ensureAt > 0 && mintAt > ensureAt, "index must exist before the first mint");
});

test("a lost number race re-mints and retries exactly once", () => {
  assert.match(route, /if \(!isDuplicateSoIdError\(e\)\) throw e;/, "unrelated errors must propagate");
  assert.match(route, /const retryId = await generateCompanySOId\(/);
  assert.match(route, /statements\[0\] = rebuildSoInsert\(retryId\);/);
  // Exactly one retry — no loop.
  assert.equal((route.match(/rebuildSoInsert\(retryId\)/g) ?? []).length, 1);
});

test("isDuplicateSoIdError matches the index by name and by generic 23505", () => {
  const helpers = readFileSync("src/api/routes/sales-orders/_helpers.ts", "utf8");
  assert.match(helpers, /uniq_sales_orders_company_so_id\/i\.test\(msg\)/);
  assert.match(helpers, /duplicate key\|unique constraint\|23505/i);
});
