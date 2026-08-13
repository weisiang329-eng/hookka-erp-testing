// Floating batch-action toolbar for the Production dept page.
//
// Shows when the operator has multi-selected one or more dept rows via the
// DataGrid checkbox column. Provides:
//   - Apply Completion Date   → bulk stamp completedDate (+ status=COMPLETED)
//   - Apply PIC                → bulk assign pic1 across the selection
//   - Save to Folder           → snapshot the selection into a named folder
//   - Clear / X                → drop the selection
//
// Designed 2026-05-12 per Wei Siang request:
//   "我可以点选需要的 schedule，然后通过 multi-select 的方式 + 批量操作
//    设置 Schedule Date / 完成时间 + 直接进入一个专门给我存档的 Production
//    Schedule (类似 Create Folder)"
//
// The toolbar is just UI — every action delegates to a parent-provided
// callback so the page owns the network calls + optimistic state updates.
// This keeps the toolbar testable in isolation and pluggable into the
// future overview tab if we want batch there too.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { X, Calendar, CalendarClock, User, FolderPlus, Trash2 } from "lucide-react";

export type BatchActionToolbarProps = {
  count: number;
  // Sum of Prod Time (min) across the selected rows. Shown next to the count
  // so the operator can see the total time budget of their selection while
  // planning (Wei Siang 2026-05-28).
  prodTimeTotalMin?: number;
  onClear: () => void;
  onApplyDate: () => void;
  // Wei Siang 2026-05-13: batch Due Date editing — sits next to Apply Date
  // (completion). Same dialog shape, different field. Lets operators
  // reschedule N rows at once (e.g. delivery slipped a week → push every
  // related JC's due date forward 7 days).
  onApplyDueDate: () => void;
  onApplyPic: () => void;
  onSaveToFolder: () => void;
  // Optional — used by the folder detail page where "remove from folder"
  // makes sense. When omitted the button is hidden.
  onRemoveFromFolder?: () => void;
};

export function BatchActionToolbar({
  count,
  prodTimeTotalMin = 0,
  onClear,
  onApplyDate,
  onApplyDueDate,
  onApplyPic,
  onSaveToFolder,
  onRemoveFromFolder,
}: BatchActionToolbarProps) {
  if (count === 0) return null;
  const hrs = (prodTimeTotalMin / 60).toFixed(1);
  return (
    <div className="sticky bottom-3 left-3 right-3 z-30 flex items-center gap-2 rounded-md border border-[#C9A227] bg-[#FFF8E6] px-3 py-2 shadow-md">
      <div className="text-[12px] font-semibold text-[#5A4500]">
        {count} job card{count === 1 ? "" : "s"} selected
      </div>
      {prodTimeTotalMin > 0 && (
        <div className="text-[12px] text-[#5A4500] tabular-nums border-l border-[#E0C766] pl-2">
          Prod Time:{" "}
          <span className="font-semibold">
            {prodTimeTotalMin.toLocaleString()} min
          </span>
          <span className="text-[#9C7A1E] ml-1">({hrs} h)</span>
        </div>
      )}
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={onApplyDueDate} title="Set the due (schedule) date on every selected row">
        <CalendarClock className="h-3.5 w-3.5 mr-1" /> Apply Due Date
      </Button>
      <Button size="sm" variant="outline" onClick={onApplyDate} title="Stamp completion date on every selected row">
        <Calendar className="h-3.5 w-3.5 mr-1" /> Apply Completion
      </Button>
      <Button size="sm" variant="outline" onClick={onApplyPic} title="Set PIC 1 on every selected row">
        <User className="h-3.5 w-3.5 mr-1" /> Apply PIC
      </Button>
      <Button size="sm" variant="outline" onClick={onSaveToFolder} title="Save these rows into a folder for later retrieval">
        <FolderPlus className="h-3.5 w-3.5 mr-1" /> Save to Folder
      </Button>
      {onRemoveFromFolder && (
        <Button size="sm" variant="outline" onClick={onRemoveFromFolder} title="Remove these rows from this folder">
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove from Folder
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClear} title="Clear selection">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ===========================================================================
// Apply Completion Date dialog — one date input + Apply / Cancel.
// Submit handler receives the chosen date string (YYYY-MM-DD) or "" to clear.
// ===========================================================================
type ApplyBatchDateDialogProps = {
  open: boolean;
  count: number;
  onCancel: () => void;
  onApply: (date: string) => void;
};

export function ApplyBatchDateDialog({ open, count, onCancel, onApply }: ApplyBatchDateDialogProps) {
  const { confirm } = useConfirm();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState<string>(today);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg w-[400px]">
        <h3 className="mb-2 text-[14px] font-semibold text-[#3A2E22]">
          Apply Completion Date
        </h3>
        <p className="mb-3 text-[12px] text-[#6B5E50]">
          Stamps this date on <strong>{count}</strong> selected job card{count === 1 ? "" : "s"} and marks them COMPLETED.
        </p>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px]"
          autoFocus
        />
        <div className="mt-4 flex justify-between items-center gap-2">
          {/* Wei Siang 2026-05-13: explicit batch-clear path. Passing
              empty-string to the parent handler triggers completedDate=""
              + status=WAITING (cell auto-clears). Red text + confirm to
              avoid accidental wipeout of N completion dates. */}
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:text-red-700"
            onClick={async () => {
              if (await confirm({ title: "Clear completion date", message: `Clear completion date on ${count} job card${count === 1 ? "" : "s"}? Status will revert to WAITING.`, danger: true })) {
                onApply("");
              }
            }}
          >
            Clear date
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button size="sm" onClick={() => onApply(date)} disabled={!date}>
              Apply to {count}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Apply Due Date dialog — one date input + Apply / Cancel.
//
// Wei Siang 2026-05-13: counterpart to Apply Completion Date, but writes
// `dueDate` (the SCHEDULED date the JC should be done) instead of
// `completedDate`. Status is NOT touched here — a JC's status reflects its
// actual progress, not the schedule. Operator uses this when delivery dates
// shift and N upstream JCs need their due dates pushed in one click.
//
// Submit handler receives YYYY-MM-DD string or "" to clear. Clear is gated
// behind a confirm because losing N due dates breaks the overdue colouring
// on the sheet.
// ===========================================================================
type ApplyBatchDueDateDialogProps = {
  open: boolean;
  count: number;
  onCancel: () => void;
  onApply: (date: string) => void;
};

export function ApplyBatchDueDateDialog({ open, count, onCancel, onApply }: ApplyBatchDueDateDialogProps) {
  const { confirm } = useConfirm();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState<string>(today);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg w-[400px]">
        <h3 className="mb-2 text-[14px] font-semibold text-[#3A2E22]">
          Apply Due Date
        </h3>
        <p className="mb-3 text-[12px] text-[#6B5E50]">
          Sets the scheduled due date on <strong>{count}</strong> selected job card{count === 1 ? "" : "s"}. Status is unchanged.
        </p>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px]"
          autoFocus
        />
        <div className="mt-4 flex justify-between items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:text-red-700"
            onClick={async () => {
              if (await confirm({ title: "Clear due date", message: `Clear due date on ${count} job card${count === 1 ? "" : "s"}? Overdue colouring will be lost on these rows.`, danger: true })) {
                onApply("");
              }
            }}
          >
            Clear due date
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button size="sm" onClick={() => onApply(date)} disabled={!date}>
              Apply to {count}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Apply PIC dialog — TWO worker dropdowns (PIC 1 + PIC 2) + Apply / Cancel.
//
// Wei Siang 2026-05-12: "这个 apply to pic 不能放两个人吗" — operators often
// pair workers on a single job card, so the batch action must support setting
// both PIC slots in one click. Empty dropdown = "don't touch that slot"
// (different from "clear it"), which is the safer default for batch actions.
// Explicit clear is via the "— (clear PIC)" choice in either dropdown.
// ===========================================================================
type WorkerOption = { id: string; name: string };
type ApplyPicPayload = {
  pic1: WorkerOption | null | undefined;  // undefined = leave alone, null = clear
  pic2: WorkerOption | null | undefined;
};
type ApplyBatchPicDialogProps = {
  open: boolean;
  count: number;
  workers: WorkerOption[];
  // Optional fuller roster — when provided, the dialog adds a "Show all
  // departments" checkbox that swaps to this list. Lets operators batch-
  // assign a cross-dept temp (Upholstery worker covering Fab Sew etc.)
  // without leaving the dialog. Wei Siang feedback 2026-05-12.
  allWorkers?: WorkerOption[];
  onCancel: () => void;
  onApply: (payload: ApplyPicPayload) => void;
};

// Sentinel values for the select's "leave alone" vs "explicit clear" modes.
const LEAVE_ALONE = "__leave__";
const EXPLICIT_CLEAR = "__clear__";

export function ApplyBatchPicDialog({ open, count, workers, allWorkers, onCancel, onApply }: ApplyBatchPicDialogProps) {
  const { confirm } = useConfirm();
  // Default value = LEAVE_ALONE which renders as "— Select —" placeholder.
  // Operator picks a worker or "— Remove —" to act; leaving the placeholder
  // = skip that slot.
  const [pic1Id, setPic1Id] = useState<string>(LEAVE_ALONE);
  const [pic2Id, setPic2Id] = useState<string>(LEAVE_ALONE);
  const [showAll, setShowAll] = useState<boolean>(false);
  if (!open) return null;

  // When showAll is on AND a fuller roster was passed in, swap the list.
  // Falls back to the dept-filtered `workers` otherwise.
  const list = showAll && allWorkers && allWorkers.length > 0 ? allWorkers : workers;
  const hasToggle = Array.isArray(allWorkers) && allWorkers.length > workers.length;

  const resolve = (id: string): WorkerOption | null | undefined => {
    if (id === LEAVE_ALONE) return undefined;
    if (id === EXPLICIT_CLEAR) return null;
    return list.find((w) => w.id === id) ?? undefined;
  };
  const pic1 = resolve(pic1Id);
  const pic2 = resolve(pic2Id);
  const canApply = pic1 !== undefined || pic2 !== undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg w-[440px]">
        <h3 className="mb-1 text-[14px] font-semibold text-[#3A2E22]">Apply PIC</h3>
        <p className="mb-3 text-[12px] text-[#6B5E50]">
          Sets PIC 1 / PIC 2 on <strong>{count}</strong> selected job card{count === 1 ? "" : "s"}. Leave a dropdown on "— Select —" to skip that slot.
        </p>

        <label className="block mb-1 text-[11px] font-semibold text-[#6B5E50]">PIC 1</label>
        <select
          value={pic1Id}
          onChange={(e) => setPic1Id(e.target.value)}
          className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px] mb-3"
          autoFocus
        >
          <option value={LEAVE_ALONE}>— Select —</option>
          {list.map((w) => (
            <option key={`p1-${w.id}`} value={w.id}>{w.name}</option>
          ))}
        </select>

        <label className="block mb-1 text-[11px] font-semibold text-[#6B5E50]">PIC 2</label>
        <select
          value={pic2Id}
          onChange={(e) => setPic2Id(e.target.value)}
          className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px]"
        >
          <option value={LEAVE_ALONE}>— Select —</option>
          {list.map((w) => (
            <option key={`p2-${w.id}`} value={w.id}>{w.name}</option>
          ))}
        </select>

        {hasToggle && (
          // Wei Siang 2026-05-13: toggle button moved BELOW the dropdowns,
          // not above — operator's eyes land on the picker first, the
          // "expand" affordance is right after.
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 w-full rounded border border-dashed border-[#C9A227] bg-[#FFF8E6] px-2 py-1.5 text-[12px] font-medium text-[#5A4500] hover:bg-[#FBEBAE]"
          >
            {showAll
              ? `↑ Show only dept workers (${workers.length})`
              : `↓ Show all departments (${allWorkers?.length})`}
          </button>
        )}

        {/* Wei Siang 2026-05-13: explicit batch-clear path for each slot.
            Confirm-on-click so a misclick doesn't wipe N PICs. Red text
            so the destructive nature reads at a glance. */}
        <div className="mt-3 pt-3 border-t border-[#E6E0D9] flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:text-red-700 flex-1 text-[11px]"
            onClick={async () => {
              if (await confirm({ title: "Clear PIC 1", message: `Clear PIC 1 on ${count} job card${count === 1 ? "" : "s"}?`, danger: true })) {
                onApply({ pic1: null, pic2: undefined });
              }
            }}
          >
            Clear PIC 1
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:text-red-700 flex-1 text-[11px]"
            onClick={async () => {
              if (await confirm({ title: "Clear PIC 2", message: `Clear PIC 2 on ${count} job card${count === 1 ? "" : "s"}?`, danger: true })) {
                onApply({ pic1: undefined, pic2: null });
              }
            }}
          >
            Clear PIC 2
          </Button>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => onApply({ pic1, pic2 })} disabled={!canApply}>
            Apply to {count}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Save-to-Folder dialog — pick existing folder OR create new with name input.
// ===========================================================================
// `jc_count` is a SQL alias, so the pg shim camelCases it to `jcCount` on the
// LIST endpoint while the POST response hand-builds the snake_case spelling.
// Read dual-keyed. (BUG-2026-08-13-032)
type FolderOption = {
  id: string;
  name: string;
  jcCount?: number;
  jc_count?: number;
};
type SaveToFolderDialogProps = {
  open: boolean;
  count: number;
  existing: FolderOption[];
  onCancel: () => void;
  // mode='existing' → folderId is set, name unused.
  // mode='new'      → folderId is unset, name is the new folder's name.
  onSave: (args: { mode: "existing"; folderId: string } | { mode: "new"; name: string }) => void;
};

export function SaveToFolderDialog({ open, count, existing, onCancel, onSave }: SaveToFolderDialogProps) {
  const [mode, setMode] = useState<"existing" | "new">(existing.length > 0 ? "existing" : "new");
  const [folderId, setFolderId] = useState<string>("");
  const [newName, setNewName] = useState<string>("");
  if (!open) return null;
  const canSave =
    (mode === "existing" && folderId !== "") ||
    (mode === "new" && newName.trim().length > 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg w-[420px]">
        <h3 className="mb-2 text-[14px] font-semibold text-[#3A2E22]">Save to Folder</h3>
        <p className="mb-3 text-[12px] text-[#6B5E50]">
          Saves <strong>{count}</strong> selected job card{count === 1 ? "" : "s"} into a folder for later retrieval.
        </p>
        <div className="mb-2 flex items-center gap-3 text-[12px]">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
              disabled={existing.length === 0}
            />
            Existing folder
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            New folder
          </label>
        </div>
        {mode === "existing" ? (
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px]"
            autoFocus
          >
            <option value="">— select folder —</option>
            {existing.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({Number(f.jcCount ?? f.jc_count ?? 0)})
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            placeholder="e.g. 2026-05-13 Wood Cut Sheet"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px]"
            autoFocus
            maxLength={200}
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => {
              if (mode === "existing") onSave({ mode: "existing", folderId });
              else onSave({ mode: "new", name: newName.trim() });
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
