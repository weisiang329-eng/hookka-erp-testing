import { Check } from "lucide-react";
import type { Cell } from "../types";
import { fmtShortDate } from "../utils";

// Each cell shows state colour + the relevant date.
// 4-state palette (2026-05-07 user spec — see types.ts CellState comment):
//   done    — teal #3E6570 bg, white text + ✓ check (operator marked done)
//   overdue — teal #3E6570 bg, red #DC2626 text (passed dueDate, not done)
//   edited  — teal #3E6570 bg, white text (operator rescheduled, on track)
//   pending — olive #9C6F1E bg, white text (default — never touched)
// Priority done > overdue > edited > pending is enforced upstream in
// cellFor(); this component just paints the resolved state.
export function CellBox({ cell }: { cell: Cell }) {
  const base =
    "h-full w-full flex flex-col items-center justify-center text-[10px] leading-tight relative";

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
    // Teal bg + red text — operator already rescheduled (or hasn't), but
    // the current dueDate has already passed. Red numbers so the warning
    // still pops against the calmer teal background.
    return (
      <div className={`${base} bg-[#3E6570] text-[#DC2626] cursor-pointer hover:bg-[#4A7686]`}>
        <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
        <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
      </div>
    );
  }
  if (cell.state === "edited") {
    // Teal bg + white text — operator manually rescheduled; on schedule.
    return (
      <div className={`${base} bg-[#3E6570] text-white cursor-pointer hover:bg-[#4A7686]`}>
        <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
        <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
      </div>
    );
  }
  // pending
  return (
    <div className={`${base} bg-[#9C6F1E] text-white cursor-pointer hover:bg-[#B38023]`}>
      <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
      <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
    </div>
  );
}
