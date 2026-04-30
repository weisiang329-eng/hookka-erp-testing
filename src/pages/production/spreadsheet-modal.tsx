// ---------------------------------------------------------------------------
// SpreadsheetModal — Sheets-style bulk editor for the dept Production Sheet.
//
// Why this exists: filling Completion Date / PIC 1 / PIC 2 across 100 rows
// one click at a time on the live grid is unworkable for the small-shop
// daily flow (operator request 2026-04-29 — they want to copy from a Google
// Sheet column and paste into a row range). This modal opens *over* the
// existing dept grid so the pretty per-cell UI stays intact, and the
// spreadsheet experience is opt-in.
//
// Behaviour (matches Sheets where it's cheap to match):
//   * Click a cell to focus it; Shift+click another cell to range-select
//     (rectangular range — anchor + extent like Sheets).
//   * Drag the bottom-right blue "fill handle" of the selection straight
//     down to fill the anchor cell's value into the rows below (single-
//     column drag-fill — diagonal drag intentionally not supported, since
//     the only realistic ask is "set this PIC for the next 50 rows").
//   * Ctrl/Cmd+C while a range is selected copies the selection as TSV.
//   * Ctrl/Cmd+V parses clipboard TSV and writes it starting at the anchor.
//   * PIC paste resolution: the pasted text is matched (case-insensitive,
//     trimmed) against worker.name OR worker.empNo. Match → cell binds to
//     that worker. Miss → cell is marked invalid (red border). Save is
//     disabled while any invalid cell exists, so half-resolved pastes can
//     never enter the DB.
//   * Date paste is strict — only ISO `YYYY-MM-DD` is accepted (operator
//     request: "应该只可以一个格式啊" / "only one format"). Anything
//     else marks the cell invalid.
//
// Save model: explicit Save button at the footer. Diff against the
// snapshot we opened with → emit one patchJobCard per dirty row. The
// existing patchJobCard call already does optimistic local update + fire-
// and-forget PATCH, so a 100-row save finishes in ~one paint. Cancel
// / close just throws the local edits away.
//
// Read-only columns (#, SO ID, WIP, Qty) are rendered as plain `<td>`s and
// excluded from selection navigation — clicking one focuses the row but
// the cell isn't an edit target. Selection cannot start in a read-only
// column.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

// Subset of DeptRow consumed here. Kept inline so the modal isn't coupled
// to the parent's internal type definition.
export type SpreadsheetRow = {
  id: string;
  poId: string;
  jobCardId: string;
  rowNo: number;
  soId: string;
  wip: string;
  qty: number;
  completedDate: string;   // ISO yyyy-mm-dd or ""
  pic1: string;            // worker name
  pic1Id?: string | null;
  pic2: string;            // worker name
  pic2Id?: string | null;
};

export type WorkerOption = {
  id: string;
  name: string;
  empNo?: string | null;
};

export type SpreadsheetEdit = {
  poId: string;
  jobCardId: string;
  completedDate?: string;
  pic1Id?: string | null;
  pic1Name?: string;
  pic2Id?: string | null;
  pic2Name?: string;
};

// Three editable column keys + their display labels. Column index in the
// spreadsheet is offset by READ_ONLY_COLS.length below.
type EditCol = "completedDate" | "pic1" | "pic2";
const EDIT_COLS: { key: EditCol; label: string }[] = [
  { key: "completedDate", label: "Completion Date" },
  { key: "pic1",          label: "PIC 1" },
  { key: "pic2",          label: "PIC 2" },
];
const READ_ONLY_COLS: { key: keyof SpreadsheetRow; label: string; width: string; align?: "right" | "left" }[] = [
  { key: "rowNo", label: "#",     width: "48px",  align: "right" },
  { key: "soId",  label: "SO ID", width: "150px" },
  { key: "wip",   label: "WIP",   width: "260px" },
  { key: "qty",   label: "Qty",   width: "60px",  align: "right" },
];

// Strict ISO yyyy-mm-dd matcher. Anything else is rejected on paste so we
// don't silently re-interpret ambiguous formats like 4/3/26 (US vs MY).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  if (isNaN(d.getTime())) return false;
  // Round-trip check — rejects e.g. 2026-02-30 which Date silently shifts
  // forward.
  return d.toISOString().slice(0, 10) === s;
}

// Cell value type — plain string carried through editing. Empty string
// means "clear". For PIC cells the string is the worker NAME (not id);
// resolution to id happens at edit-time and on save.
type CellState = {
  value: string;
  workerId?: string | null;  // for PIC cells, set when name resolves cleanly
  invalid?: boolean;         // PIC name doesn't match any worker, or bad date
};

type RowState = Record<EditCol, CellState>;

function buildInitialRowState(row: SpreadsheetRow): RowState {
  return {
    completedDate: { value: row.completedDate ?? "" },
    pic1:          { value: row.pic1 ?? "", workerId: row.pic1Id ?? null },
    pic2:          { value: row.pic2 ?? "", workerId: row.pic2Id ?? null },
  };
}

// Resolve a pasted string to a worker. Match by exact empNo first
// (high-confidence), then by case-insensitive name. Returns null if no
// match — caller marks the cell invalid.
function resolveWorker(raw: string, workers: WorkerOption[]): WorkerOption | null {
  const q = raw.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  // empNo exact (often "EMP-025")
  for (const w of workers) {
    if ((w.empNo ?? "").toLowerCase() === lower) return w;
  }
  for (const w of workers) {
    if (w.name.toLowerCase() === lower) return w;
  }
  return null;
}

type SelectionRange = {
  // Anchor + extent in (rowIdx, colIdx) coordinates. colIdx is into
  // EDIT_COLS only — read-only columns are not selectable.
  anchorRow: number;
  anchorCol: number;
  extentRow: number;
  extentCol: number;
};

function rangeBounds(sel: SelectionRange) {
  return {
    minRow: Math.min(sel.anchorRow, sel.extentRow),
    maxRow: Math.max(sel.anchorRow, sel.extentRow),
    minCol: Math.min(sel.anchorCol, sel.extentCol),
    maxCol: Math.max(sel.anchorCol, sel.extentCol),
  };
}

function inRange(sel: SelectionRange | null, rowIdx: number, colIdx: number) {
  if (!sel) return false;
  const b = rangeBounds(sel);
  return rowIdx >= b.minRow && rowIdx <= b.maxRow && colIdx >= b.minCol && colIdx <= b.maxCol;
}

export function SpreadsheetModal({
  open,
  onClose,
  deptName,
  rows,
  workers,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  deptName: string;
  rows: SpreadsheetRow[];
  workers: WorkerOption[];
  onSave: (edits: SpreadsheetEdit[]) => Promise<void> | void;
}) {
  // Snapshot the rows at the moment the modal opens. Editing happens on
  // top of this snapshot; we never mutate the parent's row list.
  const [snapshot, setSnapshot] = useState<SpreadsheetRow[]>([]);
  const [state, setState] = useState<Record<string, RowState>>({});
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [saving, setSaving] = useState(false);

  // Sorted list of worker NAMES for the dropdown (separate from `workers`
  // which we keep around for empNo lookup during paste).
  const workerNames = useMemo(
    () => [...workers].sort((a, b) => a.name.localeCompare(b.name)),
    [workers],
  );

  /* eslint-disable react-hooks/set-state-in-effect -- seed snapshot +
     edit state when the modal opens. This is a legit one-shot reset on a
     prop transition, the alternative (re-mounting via key) would force a
     full DOM rebuild every time the parent re-renders. */
  useEffect(() => {
    if (!open) return;
    setSnapshot(rows);
    const s: Record<string, RowState> = {};
    for (const r of rows) s[r.id] = buildInitialRowState(r);
    setState(s);
    setSelection(null);
  }, [open, rows]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Diff editing state vs snapshot to figure out what to PATCH on save.
  const dirtyEdits: SpreadsheetEdit[] = useMemo(() => {
    const out: SpreadsheetEdit[] = [];
    for (const r of snapshot) {
      const cur = state[r.id];
      if (!cur) continue;
      const patch: SpreadsheetEdit = { poId: r.poId, jobCardId: r.jobCardId };
      let dirty = false;
      // Completion date
      const newDate = cur.completedDate.value || "";
      if (newDate !== (r.completedDate || "")) {
        patch.completedDate = newDate;
        dirty = true;
      }
      // PIC 1
      const newPic1Name = cur.pic1.value || "";
      const newPic1Id = cur.pic1.workerId ?? null;
      if (newPic1Name !== (r.pic1 || "") || (newPic1Id ?? null) !== (r.pic1Id ?? null)) {
        patch.pic1Name = newPic1Name;
        patch.pic1Id = newPic1Id;
        dirty = true;
      }
      // PIC 2
      const newPic2Name = cur.pic2.value || "";
      const newPic2Id = cur.pic2.workerId ?? null;
      if (newPic2Name !== (r.pic2 || "") || (newPic2Id ?? null) !== (r.pic2Id ?? null)) {
        patch.pic2Name = newPic2Name;
        patch.pic2Id = newPic2Id;
        dirty = true;
      }
      if (dirty) out.push(patch);
    }
    return out;
  }, [snapshot, state]);

  const invalidCount = useMemo(() => {
    let n = 0;
    for (const id of Object.keys(state)) {
      const rs = state[id];
      for (const k of EDIT_COLS) if (rs[k.key].invalid) n++;
    }
    return n;
  }, [state]);

  // ---- mutation helpers --------------------------------------------------

  const writeCell = useCallback(
    (rowId: string, col: EditCol, raw: string) => {
      setState((prev) => {
        const rs = prev[rowId];
        if (!rs) return prev;
        const next: CellState = { value: raw };
        if (col === "completedDate") {
          if (raw === "") {
            // empty = clear, valid
          } else if (!isValidIsoDate(raw)) {
            next.invalid = true;
          }
        } else {
          if (raw === "") {
            next.workerId = null;
          } else {
            const w = resolveWorker(raw, workers);
            if (w) {
              next.value = w.name;     // canonicalize to the worker's stored name
              next.workerId = w.id;
            } else {
              next.invalid = true;
              next.workerId = null;
            }
          }
        }
        return { ...prev, [rowId]: { ...rs, [col]: next } };
      });
    },
    [workers],
  );

  // Apply one logical paste matrix (rows × cols of strings) starting at
  // (originRow, originCol). Used by both Ctrl+V and the fill-handle drag.
  const applyMatrix = useCallback(
    (matrix: string[][], originRow: number, originCol: number) => {
      if (matrix.length === 0) return;
      setState((prev) => {
        const next = { ...prev };
        for (let dr = 0; dr < matrix.length; dr++) {
          const r = originRow + dr;
          if (r < 0 || r >= snapshot.length) continue;
          const row = snapshot[r];
          const rs = next[row.id];
          if (!rs) continue;
          const cells = matrix[dr];
          let updated: RowState = rs;
          for (let dc = 0; dc < cells.length; dc++) {
            const c = originCol + dc;
            if (c < 0 || c >= EDIT_COLS.length) continue;
            const col = EDIT_COLS[c].key;
            const raw = cells[dc];
            const cell: CellState = { value: raw };
            if (col === "completedDate") {
              if (raw === "") {
                // clear
              } else if (!isValidIsoDate(raw)) {
                cell.invalid = true;
              }
            } else {
              if (raw === "") {
                cell.workerId = null;
              } else {
                const w = resolveWorker(raw, workers);
                if (w) {
                  cell.value = w.name;
                  cell.workerId = w.id;
                } else {
                  cell.invalid = true;
                  cell.workerId = null;
                }
              }
            }
            updated = { ...updated, [col]: cell };
          }
          next[row.id] = updated;
        }
        return next;
      });
    },
    [snapshot, workers],
  );

  // ---- selection / mouse interaction -------------------------------------

  const dragStartRef = useRef<{ rowIdx: number; colIdx: number } | null>(null);
  const fillDragRef = useRef<{ originRow: number; col: number } | null>(null);

  const onCellMouseDown = useCallback(
    (rowIdx: number, colIdx: number, shift: boolean) => {
      if (shift && selection) {
        setSelection({ ...selection, extentRow: rowIdx, extentCol: colIdx });
      } else {
        setSelection({ anchorRow: rowIdx, anchorCol: colIdx, extentRow: rowIdx, extentCol: colIdx });
        dragStartRef.current = { rowIdx, colIdx };
      }
    },
    [selection],
  );

  const onCellMouseEnter = useCallback(
    (rowIdx: number, colIdx: number, buttons: number) => {
      // Drag-select while left button held.
      if (buttons !== 1) return;
      if (fillDragRef.current) return; // fill-handle drag handled separately
      if (!dragStartRef.current) return;
      setSelection({
        anchorRow: dragStartRef.current.rowIdx,
        anchorCol: dragStartRef.current.colIdx,
        extentRow: rowIdx,
        extentCol: colIdx,
      });
    },
    [],
  );

  // Fill-handle drag — triggered from the small square at the bottom-right
  // of the current selection. While dragging we extend the selection
  // ROWS-only (column stays where it is). On mouseup we copy the anchor
  // cell's value to every selected row in that column.
  const onFillHandleMouseDown = useCallback(() => {
    if (!selection) return;
    const b = rangeBounds(selection);
    fillDragRef.current = { originRow: b.maxRow, col: b.maxCol };
  }, [selection]);

  useEffect(() => {
    function handleMouseUp() {
      dragStartRef.current = null;
      const fd = fillDragRef.current;
      fillDragRef.current = null;
      if (!fd) return;
      if (!selection) return;
      const b = rangeBounds(selection);
      const anchorRowState = state[snapshot[selection.anchorRow]?.id];
      if (!anchorRowState) return;
      const col = EDIT_COLS[selection.anchorCol].key;
      const anchorCell = anchorRowState[col];
      // Fill every row in the selection's row range with the anchor value
      // (single column).
      const matrix: string[][] = [];
      for (let r = b.minRow; r <= b.maxRow; r++) matrix.push([anchorCell.value]);
      applyMatrix(matrix, b.minRow, selection.anchorCol);
    }
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [selection, state, snapshot, applyMatrix]);

  // ---- clipboard ----------------------------------------------------------

  // Render the current selection as TSV. Used for Ctrl+C export back to
  // Sheets so the operator can round-trip data out of our app.
  const serializeSelection = useCallback((): string => {
    if (!selection) return "";
    const b = rangeBounds(selection);
    const lines: string[] = [];
    for (let r = b.minRow; r <= b.maxRow; r++) {
      const row = snapshot[r];
      if (!row) continue;
      const rs = state[row.id];
      const cells: string[] = [];
      for (let c = b.minCol; c <= b.maxCol; c++) {
        const col = EDIT_COLS[c].key;
        cells.push(rs?.[col].value ?? "");
      }
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }, [selection, snapshot, state]);

  // Window-level Ctrl+C/V handlers — only act when our modal is open and a
  // selection exists.
  useEffect(() => {
    if (!open) return;
    function onCopy(e: ClipboardEvent) {
      if (!selection) return;
      // Don't hijack copy when the user is in a real input/textarea.
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const tsv = serializeSelection();
      if (!tsv) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", tsv);
    }
    function onPaste(e: ClipboardEvent) {
      if (!selection) return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const txt = e.clipboardData?.getData("text/plain") ?? "";
      if (!txt) return;
      e.preventDefault();
      // Parse TSV. Tolerate trailing \r and a final empty line.
      const matrix = txt
        .replace(/\r/g, "")
        .replace(/\n+$/, "")
        .split("\n")
        .map((l) => l.split("\t"));
      const b = rangeBounds(selection);
      applyMatrix(matrix, b.minRow, b.minCol);
    }
    window.addEventListener("copy", onCopy);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("paste", onPaste);
    };
  }, [open, selection, serializeSelection, applyMatrix]);

  // ---- save ---------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (invalidCount > 0 || dirtyEdits.length === 0) return;
    setSaving(true);
    try {
      await onSave(dirtyEdits);
      onClose();
    } finally {
      setSaving(false);
    }
  }, [invalidCount, dirtyEdits, onSave, onClose]);

  // ---- render -------------------------------------------------------------

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-[96vw] h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2DDD8] bg-[#FAF8F4]">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-[#1F1D1B]">
              {deptName} — Spreadsheet Mode
              <span className="ml-2 text-xs font-normal text-[#8A7F73]">({snapshot.length} rows)</span>
            </h3>
            <span className="text-[11px] text-[#8A7F73]">
              Click a cell · Shift+click to range · drag the blue handle to fill down · Ctrl+C / Ctrl+V to copy/paste from Sheets
            </span>
          </div>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Spreadsheet */}
        <div className="flex-1 overflow-auto select-none">
          <table className="border-collapse text-[11px] w-max">
            <thead className="sticky top-0 z-10 bg-[#FAF8F4]">
              <tr>
                {READ_ONLY_COLS.map((c) => (
                  <th
                    key={c.key as string}
                    className="border border-[#E6E0D9] px-2 py-1.5 text-left font-semibold text-[#6B5C32] bg-[#F4EFE3]"
                    style={{ width: c.width, minWidth: c.width }}
                  >
                    {c.label}
                  </th>
                ))}
                {EDIT_COLS.map((c) => (
                  <th
                    key={c.key}
                    className="border border-[#E6E0D9] px-2 py-1.5 text-left font-semibold text-[#3E6570] bg-[#E0EDF0]"
                    style={{ width: "180px", minWidth: "180px" }}
                  >
                    {c.label}
                    {c.key === "completedDate" && (
                      <span className="ml-1 text-[9px] font-normal text-[#7A8B92]">(YYYY-MM-DD)</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot.map((row, rowIdx) => {
                const rs = state[row.id];
                if (!rs) return null;
                return (
                  <tr key={row.id}>
                    {READ_ONLY_COLS.map((c) => {
                      const v = row[c.key];
                      return (
                        <td
                          key={c.key as string}
                          className="border border-[#E6E0D9] px-2 py-1 text-[#1F1D1B] bg-[#FCFAF6]"
                          style={{
                            width: c.width,
                            minWidth: c.width,
                            textAlign: c.align ?? "left",
                          }}
                        >
                          {v as string | number}
                        </td>
                      );
                    })}
                    {EDIT_COLS.map((col, colIdx) => {
                      const cell = rs[col.key];
                      const selected = inRange(selection, rowIdx, colIdx);
                      const isAnchor =
                        selection?.anchorRow === rowIdx && selection?.anchorCol === colIdx;
                      const b = selection ? rangeBounds(selection) : null;
                      const isFillCorner =
                        b !== null && rowIdx === b.maxRow && colIdx === b.maxCol;
                      return (
                        <Cell
                          key={col.key}
                          rowIdx={rowIdx}
                          colIdx={colIdx}
                          col={col.key}
                          cell={cell}
                          selected={selected}
                          isAnchor={isAnchor}
                          isFillCorner={isFillCorner}
                          workers={workerNames}
                          onMouseDown={onCellMouseDown}
                          onMouseEnter={onCellMouseEnter}
                          onWrite={(v) => writeCell(row.id, col.key, v)}
                          onFillHandleDown={onFillHandleMouseDown}
                        />
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-[#E2DDD8] bg-[#FAF8F4]">
          <div className="text-[11px] text-[#6B7280]">
            {dirtyEdits.length > 0 && (
              <span><b>{dirtyEdits.length}</b> unsaved row{dirtyEdits.length === 1 ? "" : "s"}</span>
            )}
            {invalidCount > 0 && (
              <span className="ml-3 text-[#9A3A2D]">
                {invalidCount} cell{invalidCount === 1 ? "" : "s"} need fixing — see red borders.
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={saving || invalidCount > 0 || dirtyEdits.length === 0}
              className="bg-[#3E6570] text-white hover:bg-[#2E4F58]"
            >
              {saving
                ? "Saving…"
                : dirtyEdits.length === 0
                  ? "Save"
                  : `Save ${dirtyEdits.length} change${dirtyEdits.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cell — tiny presentational component so the body of the table stays
// readable. Plain <td> with conditional styling for selection / anchor /
// fill-handle. Edit-on-double-click: single click selects (Sheets feel),
// double-click swaps the cell into edit mode (text input or dropdown).
// ---------------------------------------------------------------------------
function Cell({
  rowIdx,
  colIdx,
  col,
  cell,
  selected,
  isAnchor,
  isFillCorner,
  workers,
  onMouseDown,
  onMouseEnter,
  onWrite,
  onFillHandleDown,
}: {
  rowIdx: number;
  colIdx: number;
  col: EditCol;
  cell: CellState;
  selected: boolean;
  isAnchor: boolean;
  isFillCorner: boolean;
  workers: WorkerOption[];
  onMouseDown: (rowIdx: number, colIdx: number, shift: boolean) => void;
  onMouseEnter: (rowIdx: number, colIdx: number, buttons: number) => void;
  onWrite: (v: string) => void;
  onFillHandleDown: () => void;
}) {
  // Local draft buffer is only meaningful while editing. When not editing
  // we render cell.value directly (no draft state to drift), so there's
  // nothing to sync — avoids the setState-in-effect anti-pattern.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function startEdit() {
    setDraft(cell.value);
    setEditing(true);
  }

  const baseClass =
    "relative border border-[#E6E0D9] px-2 py-1 text-[#1F1D1B] cursor-cell whitespace-nowrap overflow-hidden";
  const stateClass = cell.invalid
    ? "bg-[#FDEDED] text-[#9A3A2D]"
    : col === "completedDate" && cell.value
      ? "bg-[#E0EDF0] text-[#3E6570]"
      : "bg-white";
  const selClass = selected
    ? isAnchor
      ? "outline outline-2 outline-[#3E6570] outline-offset-[-2px]"
      : "bg-[#E0EDF0]/60"
    : "";

  const commit = () => {
    setEditing(false);
    if (draft !== cell.value) onWrite(draft);
  };

  return (
    <td
      onMouseDown={(e) => {
        if (editing) return;
        onMouseDown(rowIdx, colIdx, e.shiftKey);
      }}
      onMouseEnter={(e) => {
        if (editing) return;
        onMouseEnter(rowIdx, colIdx, e.buttons);
      }}
      onDoubleClick={startEdit}
      className={`${baseClass} ${stateClass} ${selClass}`}
      style={{ width: "180px", minWidth: "180px" }}
      title={cell.invalid
        ? col === "completedDate"
          ? `Bad date — use YYYY-MM-DD`
          : `No worker matches "${cell.value}"`
        : undefined}
    >
      {editing ? (
        col === "completedDate" ? (
          // Native HTML5 date input — browsers render a calendar picker on
          // focus / icon click. Value/onChange use the same ISO yyyy-mm-dd
          // string the rest of the spreadsheet works with, so no format
          // conversion is needed at the boundary.
          <input
            autoFocus
            type="date"
            value={draft}
            onChange={(e) => {
              // <input type="date"> always emits ISO yyyy-mm-dd (or "" when
              // cleared), so we can persist immediately and close — no need
              // for a separate Enter / blur commit dance.
              const v = e.target.value;
              setDraft(v);
              setEditing(false);
              onWrite(v);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { setDraft(cell.value); setEditing(false); }
            }}
            className="w-full bg-white border border-[#3E6570] px-1 outline-none text-[11px]"
          />
        ) : (
          <select
            autoFocus
            value={draft}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              setEditing(false);
              onWrite(v);
            }}
            onBlur={commit}
            className="w-full bg-white border border-[#3E6570] px-1 outline-none text-[11px]"
          >
            <option value="">— Clear —</option>
            {workers.map((w) => (
              <option key={w.id} value={w.name}>
                {w.empNo ? `${w.empNo} — ` : ""}{w.name}
              </option>
            ))}
          </select>
        )
      ) : (
        <span>{cell.value || <span className="text-[#BDB4A8]">—</span>}</span>
      )}
      {/* Fill handle — small square at the bottom-right of the selection's
          bottom-right cell. Only one handle visible at a time. */}
      {isFillCorner && !editing && (
        <span
          onMouseDown={(e) => {
            e.stopPropagation();
            onFillHandleDown();
          }}
          className="absolute -bottom-[3px] -right-[3px] w-[7px] h-[7px] bg-[#3E6570] cursor-crosshair"
          title="Drag down to fill"
        />
      )}
    </td>
  );
}
