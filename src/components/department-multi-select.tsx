// ---------------------------------------------------------------------------
// Departments picker — a dropdown that happens to allow more than one tick.
//
// Shared by the Employee Master inline-edit row and the employee drawer. It
// used to live inside employees.tsx and the drawer grew its own wall of
// fourteen checkboxes instead, which is a different control for the same field
// (owner 2026-08-02: 「department太乱了 做成dropdown」「规格全部一样？」). One
// component, so the two doors to the same record cannot drift again.
//
// Owns its own open/close state. That is not a style choice: DataGrid memoizes
// cells on row data, so an `open` boolean held by the parent re-rendered the
// parent but NOT the memoized cell — the operator had to click twice to open
// the panel (Wei Siang 2026-05-10: 「很卡，要点两下才开」). Child state forces
// the cell to re-render through React's normal path.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";

export type DepartmentOption = { id?: string; code: string; name: string };

export function DepartmentMultiSelect({
  selectedCodes,
  allDepts,
  onChange,
  className,
}: {
  selectedCodes: string[];
  allDepts: DepartmentOption[];
  /** `primaryDept` is the FIRST ticked one — legacy single-dept lookups use it. */
  onChange: (codes: string[], primaryDept: DepartmentOption | undefined) => void;
  /** Trigger width. The grid cell wants a fixed 176px; the drawer wants full. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside via document mousedown rather than a backdrop div: the edit
  // row scrolls horizontally and an opaque shield would block the Save button
  // on a narrow screen.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const deptNamesOf = (codes: string[]) =>
    codes.map((code) => allDepts.find((d) => d.code === code)?.name ?? code).join(", ");

  const summary =
    selectedCodes.length === 0
      ? "— Select —"
      : selectedCodes.length <= 2
        ? deptNamesOf(selectedCodes)
        : `${selectedCodes.length} departments`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`h-8 text-xs border border-[#E2DDD8] rounded-md bg-white px-2 pr-2 text-left flex items-center justify-between gap-1 focus:outline-none focus:ring-2 focus:ring-[#6B5C32] ${
          className ?? "w-44"
        }`}
        title={selectedCodes.length > 0 ? deptNamesOf(selectedCodes) : ""}
      >
        <span className="truncate flex-1">{summary}</span>
        <svg className="h-3 w-3 text-[#6B7280] shrink-0" viewBox="0 0 12 12" fill="none">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-56 bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-64 overflow-y-auto">
          {allDepts.map((d) => {
            const checked = selectedCodes.includes(d.code);
            return (
              <label
                key={d.id ?? d.code}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[#FAF9F7] ${
                  checked ? "bg-[#FAF7EE]" : ""
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#6B5C32]"
                  checked={checked}
                  onChange={() => {
                    const set = new Set(selectedCodes);
                    if (set.has(d.code)) set.delete(d.code);
                    else set.add(d.code);
                    const codes = Array.from(set);
                    onChange(
                      codes,
                      allDepts.find((x) => x.code === codes[0]),
                    );
                  }}
                />
                <span className="text-[#374151]">{d.name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DepartmentMultiSelect;
