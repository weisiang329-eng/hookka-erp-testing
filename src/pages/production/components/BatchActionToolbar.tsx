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
import { X, Calendar, User, FolderPlus, Trash2 } from "lucide-react";

export type BatchActionToolbarProps = {
  count: number;
  onClear: () => void;
  onApplyDate: () => void;
  onApplyPic: () => void;
  onSaveToFolder: () => void;
  // Optional — used by the folder detail page where "remove from folder"
  // makes sense. When omitted the button is hidden.
  onRemoveFromFolder?: () => void;
};

export function BatchActionToolbar({
  count,
  onClear,
  onApplyDate,
  onApplyPic,
  onSaveToFolder,
  onRemoveFromFolder,
}: BatchActionToolbarProps) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-3 left-3 right-3 z-30 flex items-center gap-2 rounded-md border border-[#C9A227] bg-[#FFF8E6] px-3 py-2 shadow-md">
      <div className="text-[12px] font-semibold text-[#5A4500]">
        {count} job card{count === 1 ? "" : "s"} selected
      </div>
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={onApplyDate} title="Stamp completion date on every selected row">
        <Calendar className="h-3.5 w-3.5 mr-1" /> Apply Date
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
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState<string>(today);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg w-[360px]">
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
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => onApply(date)} disabled={!date}>
            Apply to {count}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Apply PIC dialog — single worker dropdown + Apply / Cancel.
// ===========================================================================
type WorkerOption = { id: string; name: string };
type ApplyBatchPicDialogProps = {
  open: boolean;
  count: number;
  workers: WorkerOption[];
  onCancel: () => void;
  onApply: (worker: WorkerOption | null) => void;  // null = clear PIC
};

export function ApplyBatchPicDialog({ open, count, workers, onCancel, onApply }: ApplyBatchPicDialogProps) {
  const [workerId, setWorkerId] = useState<string>("");
  if (!open) return null;
  const chosen = workers.find((w) => w.id === workerId) ?? null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg w-[400px]">
        <h3 className="mb-2 text-[14px] font-semibold text-[#3A2E22]">Apply PIC 1</h3>
        <p className="mb-3 text-[12px] text-[#6B5E50]">
          Sets PIC 1 on <strong>{count}</strong> selected job card{count === 1 ? "" : "s"}.
        </p>
        <select
          value={workerId}
          onChange={(e) => setWorkerId(e.target.value)}
          className="w-full rounded border border-[#D4CFC7] bg-white px-2 py-1 text-[12px]"
          autoFocus
        >
          <option value="">— (clear PIC)</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => onApply(chosen)}>
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
type FolderOption = { id: string; name: string; jc_count: number };
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
                {f.name} ({f.jc_count})
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
