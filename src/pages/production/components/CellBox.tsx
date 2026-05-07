import { Check } from "lucide-react";
import type { Cell } from "../types";
import { fmtShortDate } from "../utils";

// Each cell shows state colour + the relevant date. Text is white so it
// stays legible against the teal/olive/red state backgrounds — previously
// text-color matched bg-color and both the ✓ and date were invisible.
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
    return (
      <div className={`${base} bg-[#9A3A2D] text-white cursor-pointer hover:bg-[#B04536]`}>
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
