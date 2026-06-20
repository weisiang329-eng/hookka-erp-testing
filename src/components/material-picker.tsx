// ---------------------------------------------------------------------------
// MaterialPicker — a searchable catalog combobox for raw materials.
//
// Purchase Invoice + GRN line editors previously FREE-TYPED the material code
// and name, so an operator could key anything ("现在是 Manually Typed，这样子我
// 不是可以随便打了吗"). This component turns that into a catalog PICKER: it
// suggests raw materials (matched on item code OR description) from the
// catalog the page already fetched, and on pick fills BOTH the code and name.
//
// HARD RULE — it never blocks a custom value. A supplier invoice can list
// materials that aren't in our catalog, so the input stays free-text: catalog
// rows are SUGGESTIONS, not a closed dropdown. Whatever the operator commits
// (a picked catalog entry OR a typed off-catalog string) is reported back via
// onCommit, and the parent owns the final value. No normalize-on-write, no
// rejection — suggest, don't gate.
//
// It deliberately does NOT touch price: the standalone PI intentionally
// excludes catalog price-autofill (prior owner decision). Code + name only.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type MaterialOption = {
  itemCode: string;
  description: string;
};

export function MaterialPicker({
  value,
  options,
  onPick,
  onTyped,
  placeholder = "Search code or name…",
  className,
  inputClassName,
}: {
  /** The text shown in the input (the parent decides whether this is the code or the name). */
  value: string;
  /** The raw-materials catalog (active items the parent already fetched). */
  options: MaterialOption[];
  /**
   * Called when the operator picks a catalog row. The parent fills BOTH the
   * material code and the material name from this.
   */
  onPick: (option: MaterialOption) => void;
  /**
   * Called when the operator commits free text that is NOT a catalog pick — a
   * legitimate off-catalog item. The parent keeps the typed value as-is; this
   * component never rejects or rewrites it. (If the typed text happens to match
   * a catalog code exactly, onPick fires instead so both fields fill.)
   */
  onTyped: (text: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  // `draft === null` means "not editing" → the input mirrors the parent's
  // `value` directly, so external changes (OCR autofill, a row reset, a sibling
  // pick) show up automatically with NO setState-in-effect. Typing sets a draft
  // string; committing/closing clears it back to null so the field snaps to the
  // freshly-saved parent value.
  const [draft, setDraft] = useState<string | null>(null);
  const query = draft ?? value ?? "";
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The dropdown renders into <body> via a portal (position:fixed) so it ESCAPES
  // any overflow-hidden ancestor — the PI/GRN create pages wrap the line table in
  // a rounded `overflow-hidden` div, which was clipping the suggestions list.
  // `coords` = the input's on-screen rect; null = closed.
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);

  // Suggestions — match on code OR description, code-prefix matches first.
  // Capped so a 350-row catalog doesn't render a giant list.
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 50);
    const scored = options
      .map((o) => {
        const code = o.itemCode.toLowerCase();
        const desc = (o.description || "").toLowerCase();
        let score = -1;
        if (code.startsWith(q)) score = 0;
        else if (code.includes(q)) score = 1;
        else if (desc.includes(q)) score = 2;
        return { o, score };
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score || a.o.itemCode.localeCompare(b.o.itemCode))
      .slice(0, 50)
      .map((s) => s.o);
    return scored;
  }, [options, query]);

  // Does the current text exactly match a catalog code? Drives the "off-catalog"
  // hint — purely informational, never a block.
  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.some((o) => o.itemCode.toLowerCase() === q);
  }, [options, query]);

  const pick = (o: MaterialOption) => {
    setOpen(false);
    setDraft(null); // snap back to the parent value once it's filled
    onPick(o);
  };

  // Commit whatever was typed as a custom value (no rewrite). If it happens to
  // match a catalog code exactly, treat it as a pick so both fields fill —
  // otherwise the parent keeps the operator's own text verbatim. Only fires
  // when the operator actually edited (draft !== null), so a plain
  // focus-then-blur with no change is a no-op.
  const commitTyped = useCallback(() => {
    if (draft === null) return;
    const typed = draft.trim();
    setDraft(null);
    const hit = options.find(
      (o) => o.itemCode.toLowerCase() === typed.toLowerCase(),
    );
    if (hit) onPick(hit);
    else onTyped(typed);
  }, [draft, options, onPick, onTyped]);

  // Measure the input's on-screen rect for the portaled dropdown's fixed position.
  const measure = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  // Close the dropdown on outside click and commit the typed value. The menu is
  // portaled to <body>, so "inside" means the input wrap OR the portaled menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setOpen(false);
        commitTyped();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, commitTyped]);

  // While open, keep the portaled dropdown tracking the input on scroll/resize.
  // Initial position is measured in the open handlers (not here) so the effect
  // never calls setState synchronously in its body.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={(e) => {
          setOpen(true);
          measure();
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          measure();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (suggestions.length === 1) pick(suggestions[0]);
            else commitTyped();
            setOpen(false);
          } else if (e.key === "Escape") {
            setOpen(false);
            setDraft(null); // discard the edit, snap back to the parent value
          }
        }}
        onBlur={() => {
          // Commit on blur so a typed custom value isn't lost. The dropdown's
          // own onMouseDown fires before blur, so a click-to-pick still wins.
          commitTyped();
        }}
        className={cn(
          "h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs font-medium text-[#1F1D1B] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]",
          inputClassName,
        )}
      />
      {open && coords &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: coords.top, left: coords.left, width: coords.width }}
            className="z-[60] max-h-56 overflow-y-auto rounded-md border border-[#E2DDD8] bg-white shadow-lg"
          >
          {suggestions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[#9CA3AF]">
              No catalog match — “{query.trim()}” will be kept as a custom item.
            </div>
          ) : (
            <>
              {suggestions.map((o) => (
                <button
                  key={o.itemCode}
                  type="button"
                  // onMouseDown (not onClick) so the pick fires before the
                  // input's onBlur commits the half-typed text.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                  className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[#F0ECE9]"
                >
                  <span className="font-medium text-[#1F1D1B] text-xs whitespace-nowrap">
                    {o.itemCode}
                  </span>
                  <span className="text-[11px] text-[#6B7280] truncate">
                    {o.description}
                  </span>
                </button>
              ))}
              {query.trim() && !exactMatch && (
                <div className="border-t border-[#E2DDD8] px-3 py-1.5 text-[11px] text-[#9CA3AF]">
                  Not in catalog? “{query.trim()}” is kept as a custom item.
                </div>
              )}
            </>
          )}
          </div>,
          document.body,
        )}
    </div>
  );
}
