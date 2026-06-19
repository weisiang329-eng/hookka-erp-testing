// ---------------------------------------------------------------------------
// lifecycle-actions.tsx — shared document-lifecycle UI (F3).
//
// Pure presentational components (no IO, no hooks): the parent supplies the
// row's lifecycleState and the void/delete/unvoid callbacks (which do the
// confirm + fetch + reload). State → buttons:
//   ACTIVE (or null/undefined) → [void] [delete]
//   VOID                        → [unvoid] [delete]
//   DELETED                     → [unvoid]   (only seen in the Audit Log;
//                                 normal lists exclude DELETED rows)
// Button styling mirrors the existing inline action buttons in the accounting
// pages (text-xs underline decoration-dotted).
// ---------------------------------------------------------------------------

type LifecycleState = string | null | undefined;

const RED = "text-[#9A3A2D] hover:text-[#791F1F]";
const GREEN = "text-[#4F7C3A] hover:text-[#3A5C29]";
const BTN = "text-xs underline decoration-dotted cursor-pointer disabled:opacity-50 disabled:no-underline disabled:cursor-default";

export function LifecycleBadge({ state }: { state: LifecycleState }) {
  const s = state ?? "ACTIVE";
  if (s === "ACTIVE") return null;
  const cls =
    s === "DELETED"
      ? "bg-[#E8D5CE] text-[#791F1F]"
      : "bg-[#F3E8E5] text-[#9A3A2D]";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {s}
    </span>
  );
}

export function LifecycleActions({
  state,
  onVoid,
  onDelete,
  onUnvoid,
  disabled,
}: {
  state: LifecycleState;
  onVoid: () => void;
  onDelete: () => void;
  onUnvoid: () => void;
  disabled?: boolean;
}) {
  const s = state ?? "ACTIVE";
  if (s === "VOID") {
    return (
      <span className="inline-flex gap-3">
        <button className={`${GREEN} ${BTN}`} disabled={disabled} onClick={onUnvoid}>unvoid</button>
        <button className={`${RED} ${BTN}`} disabled={disabled} onClick={onDelete}>delete</button>
      </span>
    );
  }
  if (s === "DELETED") {
    return (
      <span className="inline-flex gap-3">
        <button className={`${GREEN} ${BTN}`} disabled={disabled} onClick={onUnvoid}>unvoid</button>
      </span>
    );
  }
  // ACTIVE
  return (
    <span className="inline-flex gap-3">
      <button className={`${RED} ${BTN}`} disabled={disabled} onClick={onVoid}>void</button>
      <button className={`${RED} ${BTN}`} disabled={disabled} onClick={onDelete}>delete</button>
    </span>
  );
}
