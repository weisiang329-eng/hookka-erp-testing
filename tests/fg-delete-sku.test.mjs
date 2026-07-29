// ---------------------------------------------------------------------------
// fg-delete-sku.test.mjs — pins the FG "Delete SKU" action (owner 2026-07-29:
// the UI had no way to delete a SKU, even unused ones). The FG row menu now has
// a Delete that calls the guarded soft-delete endpoint and surfaces its 409
// lock. Structural pins (source assertions, the repo idiom); live click
// verified in-browser.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/pages/inventory/index.tsx", import.meta.url),
  "utf8",
);

test("FG row menu exposes a Delete action", () => {
  const menu = src.slice(src.indexOf("const fgContextMenu"), src.indexOf("const wipContextMenu"));
  assert.match(menu, /label: "Delete", action: \(row: FGItem\) => \{ void handleDeleteFG\(row\); \}/, "fgContextMenu must include a Delete item wired to handleDeleteFG");
});

test("delete hits the guarded soft-delete endpoint and handles the 409 lock", () => {
  const fn = src.slice(src.indexOf("const handleDeleteFG"), src.indexOf("const handleDeleteFG") + 1200);
  assert.match(fn, /await confirm\(/, "must confirm before deleting");
  assert.match(fn, /fetch\(`\/api\/products\/\$\{row\.id\}`, \{ method: "DELETE" \}\)/, "must call DELETE /api/products/:id");
  assert.match(fn, /res\.status === 409/, "must surface the reference-lock 409 to the operator");
});
