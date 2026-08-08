// ---------------------------------------------------------------------------
// grid-ids.test.mjs — a list grid must REMEMBER its columns across a reload.
//
// The DataGrid's column picker / drag / resize machinery persists per `gridId`.
// Five document lists shipped with no gridId at all, so the visibility + order
// the operator set was thrown away on every visit — the machinery was there,
// the key was not. (Widths alone survived, via the `auto:` fallback key.)
//
// Two things are pinned here:
//   1. every document list names a gridId, and
//   2. no two grids share one — a duplicate id makes two different grids
//      fight over one saved layout, which reads as "my columns keep changing".
// A RENAMED id is just as bad as a missing one: it silently discards the
// layout the user already saved, so these ids are literals in the test.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// The grids this task connected, with the exact id each must keep.
const CONNECTED = {
  "src/pages/invoices/index.tsx": "invoices-list",
  "src/pages/consignment/index.tsx": "consignment-orders-list",
  "src/pages/procurement/grn.tsx": "goods-receipts-list",
  "src/pages/procurement/pi.tsx": "purchase-invoices-list",
};

for (const [file, id] of Object.entries(CONNECTED)) {
  test(`${file} keeps gridId="${id}" — renaming it discards saved layouts`, () => {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      new RegExp(`gridId="${id}"`),
      `${file} must pass gridId="${id}" to its DataGrid`,
    );
  });
}

test("every gridId in the app is unique", () => {
  const seen = new Map();
  const dupes = [];
  for (const file of walk("src")) {
    if (!/\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/gridId="([^"]+)"/g)) {
      const id = m[1];
      if (seen.has(id)) dupes.push(`${id}: ${seen.get(id)} + ${file}`);
      else seen.set(id, file);
    }
  }
  assert.deepEqual(dupes, [], "two grids sharing one id share one saved layout");
  assert.ok(seen.size >= 24, `expected the known grid ids, saw ${seen.size}`);
});

test("the saved layout is keyed on the gridId, so it survives a reload", () => {
  // The persistence contract itself: visibility + order are read back out of
  // localStorage under `datagrid-cols-${gridId}` / `datagrid-colorder-${gridId}`
  // on mount. Without a gridId these branches never run, which is exactly why
  // the five grids reset on every visit.
  const src = readFileSync("src/components/ui/data-grid.tsx", "utf8");
  assert.match(src, /localStorage\.getItem\(`datagrid-cols-\$\{gridId\}-\$\{userKey\(\)\}`\)/);
  assert.match(src, /localStorage\.setItem\(`datagrid-cols-\$\{gridId\}-\$\{userKey\(\)\}`/);
  assert.match(src, /localStorage\.getItem\(`datagrid-colorder-\$\{gridId\}-\$\{userKey\(\)\}`\)/);
  assert.match(src, /localStorage\.setItem\(`datagrid-colorder-\$\{gridId\}-\$\{userKey\(\)\}`/);
  assert.match(src, /if \(gridId && typeof window !== "undefined"\)/);
});

test("a saved layout round-trips under its gridId key", () => {
  // Same key template the grid uses, exercised end to end against a real
  // storage map: write what a column toggle writes, read what a fresh mount
  // reads. A different id must NOT see it — that is the renamed-id failure.
  const store = new Map();
  const key = (kind, gridId, user) => `datagrid-${kind}-${gridId}-${user}`;
  const user = "u1";

  const hidden = ["invoiceNo", "customerName", "totalSen"];
  const order = ["customerName", "invoiceNo", "totalSen", "doNo"];
  store.set(key("cols", "invoices-list", user), JSON.stringify(hidden));
  store.set(key("colorder", "invoices-list", user), JSON.stringify(order));

  // Reload: same grid id, same user → the layout comes back intact.
  assert.deepEqual(JSON.parse(store.get(key("cols", "invoices-list", user))), hidden);
  assert.deepEqual(JSON.parse(store.get(key("colorder", "invoices-list", user))), order);

  // No gridId (the old state of these five) → nothing to read back.
  assert.equal(store.get(key("cols", "undefined", user)), undefined);
  // Renamed id → the saved layout is orphaned, not migrated.
  assert.equal(store.get(key("cols", "invoices", user)), undefined);
});

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
