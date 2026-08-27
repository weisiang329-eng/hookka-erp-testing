// BUG-2026-08-27-001 — the DataGrid context menu invokes item.action({}) and
// relies on every action arriving PRE-BOUND to its row. The array form of
// `contextMenuItems` was wrapped; the FUNCTION form's items went through raw,
// so every action that read its argument received {} — JournalsTab's Post
// sent PUT /api/accounting/journals/undefined and the owner saw
// "Journal entry not found" on every JV he tried to post (2026-08-27).
// One binder now covers BOTH forms; these tests pin it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/context-menu-bind.ts")).href);

test("function-form items: the action receives the ROW even when invoked with {}", () => {
  const row = { id: "je-0468192a", entryNo: "JE-2608-0001" };
  let got = null;
  const items = [{ label: "Post", action: (r) => { got = r; } }];
  const bound = m.bindContextMenuRow(items, row);
  bound[0].action({}); // exactly how the menu calls it
  assert.equal(got, row);
  assert.equal(got.id, "je-0468192a");
});

test("binding preserves every other item field and does not mutate the input", () => {
  const row = { id: "x" };
  const items = [
    { label: "Delete", danger: true, action: () => {} },
    { separator: true, label: "", action: () => {} },
    { label: "Off", disabled: true, action: () => {} },
  ];
  const bound = m.bindContextMenuRow(items, row);
  assert.equal(bound[0].danger, true);
  assert.equal(bound[1].separator, true);
  assert.equal(bound[2].disabled, true);
  assert.notEqual(bound[0], items[0]); // copies, not mutations
  assert.doesNotThrow(() => bound[1].action({})); // separators stay callable no-ops
});

test("closure-style actions (ignore their arg) keep working unchanged", () => {
  const outer = { id: "closure-row" };
  let got = null;
  const items = [{ label: "Void", action: () => { got = outer.id; } }];
  const bound = m.bindContextMenuRow(items, { id: "other" });
  bound[0].action({});
  assert.equal(got, "closure-row");
});
