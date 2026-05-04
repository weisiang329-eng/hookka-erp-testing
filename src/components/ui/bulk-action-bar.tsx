// ---------------------------------------------------------------------------
// BulkActionBar — sticky toolbar that appears when rows are selected in a
// list page. Renders nothing when no rows are selected, so list pages
// don't need to short-circuit it themselves.
//
// Pairs with DataGrid's built-in `selectable` + `onSelectionChange` props:
//   const [selected, setSelected] = useState<T[]>([]);
//   <DataGrid selectable onSelectionChange={setSelected} ... />
//   <BulkActionBar
//     selectedCount={selected.length}
//     onClear={() => setSelected([])}
//     actions={
//       <>
//         <Button onClick={() => bulkDelete(selected)}>Delete</Button>
//         <Button onClick={() => bulkExport(selected)}>Export</Button>
//       </>
//     }
//   />
//
// Floats above the page bottom-center (Odoo / Linear / Notion convention)
// so it stays in view regardless of scroll position.
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";
import { X } from "lucide-react";

export function BulkActionBar({
  selectedCount,
  onClear,
  actions,
  noun = "item",
}: {
  selectedCount: number;
  onClear: () => void;
  actions: ReactNode;
  /** Singular noun for the count label, e.g. "row", "order". */
  noun?: string;
}) {
  if (selectedCount <= 0) return null;
  const plural = selectedCount === 1 ? noun : `${noun}s`;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 bg-[#1F1D1B] text-white rounded-full shadow-2xl">
      <button
        type="button"
        onClick={onClear}
        className="p-1 -ml-1 rounded-full hover:bg-white/10 transition-colors"
        aria-label="Clear selection"
      >
        <X className="w-4 h-4" />
      </button>
      <span className="text-xs font-medium tabular-nums">
        {selectedCount} {plural} selected
      </span>
      <div className="h-4 w-px bg-white/30" />
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  );
}
