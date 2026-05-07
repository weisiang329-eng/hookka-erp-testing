import { Check } from "lucide-react";
import type { Cell } from "../types";
import { fmtShortDate } from "../utils";

// Original 3-state palette + isEdited text-colour modifier:
//   done    — teal  #3E6570 bg + white text + ✓ check
//   overdue — red   #9A3A2D bg + white text
//   pending — olive #9C6F1E bg + white text
//
// When `cell.isEdited` is true on a non-done cell, the text colour
// flips to cyan #22D3EE so the operator can see "I rescheduled this"
// at a glance — without losing the overdue red bg or pending olive bg
// underneath. Done suppresses the modifier (completion supersedes edit).
export function CellBox({ cell }: { cell: Cell }) {
  const base =
    "h-full w-full flex flex-col items-center justify-center text-[10px] leading-tight relative";
  // Cyan text override for edited non-done cells; otherwise white.
  const textCls =
    cell.state !== "done" && cell.isEdited ? "text-[#22D3EE]" : "text-white";

  if (cell.state === "empty") {
    return <div className={`${base} bg-transparent`} />;
  }
  if (cell.state === "done") {
    return (
      <div className={`${base} bg-[#3E6570] text-white`}>
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
        <span className="text-[9px] mt-0.5 font-semibold">
          {fmtShortDate(cell.latestCompleted || cell.earliestDue)}
        </span>
      </div>
    );
  }
  if (cell.state === "overdue") {
    return (
      <div className={`${base} ${textCls} bg-[#9A3A2D] cursor-pointer hover:bg-[#B04536]`}>
        <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
        <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
      </div>
    );
  }
  // pending
  return (
    <div className={`${base} ${textCls} bg-[#9C6F1E] cursor-pointer hover:bg-[#B38023]`}>
      <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
      <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
    </div>
  );
}
