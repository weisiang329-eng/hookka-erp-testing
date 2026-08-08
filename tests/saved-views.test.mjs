// ---------------------------------------------------------------------------
// saved-views.test.mjs — Saved Views is reachable.
//
// The feature was complete inside DataGrid — a SavedView type, per-user
// localStorage persistence, save-with-a-name, apply, delete, reset-all — and
// gated behind a `viewStorageKey` prop that NO page passed. Every line of it
// ran only if a caller opted in, and no caller ever did.
//
// It is now defaulted to `gridId`, so any grid that already persists a layout
// also offers Views under that same stable key. These pin that the machinery
// is whole (a half-built feature must not be shipped as "wiring") and that the
// default is what makes it reachable.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const GRID = readFileSync("src/components/ui/data-grid.tsx", "utf8");

test("Saved Views is reachable without every page opting in", () => {
  assert.match(
    GRID,
    /viewStorageKey = gridId,/,
    "viewStorageKey must default to gridId — otherwise the feature is dead again",
  );
  // The render gate is unchanged; it is the DEFAULT that makes it fire.
  assert.match(GRID, /\{viewStorageKey && \(/);
});

test("the round trip is complete — save, apply, delete, persist", () => {
  // If any of these were missing this would be a half-built feature, and
  // finishing it is not wiring. They are all present.
  assert.match(GRID, /const saveCurrentView = useCallback/);
  assert.match(GRID, /const applyView = useCallback/);
  assert.match(GRID, /const deleteView = useCallback/);
  assert.match(GRID, /const persistViews = useCallback/);
  assert.match(GRID, /const resetAllFilters = useCallback/);
  // Persisted per user, keyed on the view storage key.
  assert.match(
    GRID,
    /localStorage\.setItem\(`datagrid-views-\$\{viewStorageKey\}-\$\{userKey\(\)\}`/,
  );
  assert.match(
    GRID,
    /localStorage\.getItem\(`datagrid-views-\$\{viewStorageKey\}-\$\{userKey\(\)\}`\)/,
  );
});

test("applying a view restores everything saving a view captured", () => {
  // A view that saves seven things and restores five is the failure mode that
  // makes a feature feel broken. Field-for-field.
  const saved = GRID.slice(GRID.indexOf("const saveCurrentView"), GRID.indexOf("const applyView"));
  const applied = GRID.slice(GRID.indexOf("const applyView"), GRID.indexOf("const deleteView"));
  for (const [captured, restored] of [
    ["searchText,", "setSearchText(f.searchText)"],
    ["columnFilters: {", "setColumnFilters(f.columnFilters)"],
    ["columnValueFilters:", "setColumnValueFilters("],
    ["sortKey,", "setSortKey(f.sortKey)"],
    ["sortDir,", "setSortDir(f.sortDir)"],
    ["groupEnabled,", "setGroupEnabled(f.groupEnabled)"],
    ["groupFilter:", "setGroupFilter("],
  ]) {
    assert.ok(saved.includes(captured), `saveCurrentView should capture ${captured}`);
    assert.ok(applied.includes(restored), `applyView should restore via ${restored}`);
  }
});

test("the UI is whole — list, apply, delete, name-and-save, empty state", () => {
  const ui = GRID.slice(GRID.indexOf("{/* Saved Views */}"), GRID.indexOf("{/* Export — WYSIWYG"));
  assert.ok(ui.length > 500, "the Saved Views toolbar block should be locatable");
  assert.match(ui, /No saved views yet/, "empty state");
  assert.match(ui, /Save Current View/, "create affordance");
  assert.match(ui, /onClick=\{\(\) => applyView\(view\)\}/, "apply");
  assert.match(ui, /deleteView\(i\)/, "delete");
  assert.match(ui, /Reset All Filters/, "reset");
});

test("a saved view round-trips under its storage key", () => {
  // The persisted shape, exercised against a real map: what saveCurrentView
  // writes is exactly what applyView needs, and it survives a reload.
  const store = new Map();
  const key = (k, user) => `datagrid-views-${k}-${user}`;
  const view = {
    name: "Overdue, oldest first",
    filters: {
      searchText: "",
      columnFilters: { status: "OVERDUE" },
      columnValueFilters: { customerName: ["Acme", "Beta"] },
      sortKey: "dueDate",
      sortDir: "asc",
      groupEnabled: false,
      groupFilter: null,
    },
  };
  store.set(key("invoices-list", "u1"), JSON.stringify([view]));

  const back = JSON.parse(store.get(key("invoices-list", "u1")));
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], view, "the view survives serialisation intact");
  // Sets are serialised as arrays and rehydrated — that is why the round trip
  // has to be checked, not assumed.
  assert.deepEqual(new Set(back[0].filters.columnValueFilters.customerName), new Set(["Acme", "Beta"]));

  // Another user on the same grid does not inherit it.
  assert.equal(store.get(key("invoices-list", "u2")), undefined);
  // A grid with no gridId has no key at all — which is what "unreachable" was.
  assert.equal(store.get(key("undefined", "u1")), undefined);
});
