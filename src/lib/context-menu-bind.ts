// ---------------------------------------------------------------------------
// BUG-2026-08-27-001 — bind a DataGrid context-menu item's action to its row.
//
// The menu component invokes `item.action({})` (both the click and the
// keyboard path), so every action must arrive PRE-BOUND to the row it acts
// on. The grid wrapped the ARRAY form of `contextMenuItems` but passed the
// FUNCTION form's items through raw — any action that read its argument got
// `{}`: JournalsTab's Post sent `PUT /api/accounting/journals/undefined` and
// the owner saw "Journal entry not found" on every JV (Post / Delete / Void /
// Duplicate were all dead in that menu, on every page using the function
// form). One binder, used for BOTH forms, ends the split.
//
// Actions that ignore their argument (closure style, `() => doX(row.id)`)
// pass through unchanged in behaviour — binding only fixes the arg.
// ---------------------------------------------------------------------------

export function bindContextMenuRow<T, I extends { action: (row: T) => void }>(
  items: I[],
  row: T,
): I[] {
  return items.map((item) => ({ ...item, action: () => item.action(row) }));
}
