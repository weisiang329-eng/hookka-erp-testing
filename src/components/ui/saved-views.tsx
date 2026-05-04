// ---------------------------------------------------------------------------
// SavedViews — Odoo Favorites / SAP Variant Management for any list page.
//
// Stores a name → search-string map per page in localStorage so users
// can save a complex filter combo ("Hot Sales — last 30 days, in DRAFT,
// >MYR 5,000") and re-apply it with one click later.
//
// Storage key is namespaced by the `pageKey` prop so two list pages
// don't share each other's saved views. The search-string is the URL
// `?...` portion (everything after `?`), so any URL-state-driven page
// works out of the box.
//
// Usage (next to a list page's filter bar):
//   <SavedViews pageKey="sales" />
//
// The component reads `window.location.search` to know what to save,
// and calls `navigate(pathname + savedSearch)` to apply.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Bookmark, Plus, Trash2, ChevronDown } from "lucide-react";

type SavedView = { name: string; search: string };

function storageKey(pageKey: string): string {
  return `hookka-saved-views:${pageKey}`;
}

function readViews(pageKey: string): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(pageKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        v && typeof v.name === "string" && typeof v.search === "string",
    );
  } catch {
    return [];
  }
}

function writeViews(pageKey: string, views: SavedView[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(pageKey), JSON.stringify(views));
  } catch {
    /* quota / private mode — best effort */
  }
}

export function SavedViews({
  pageKey,
  className,
}: {
  /** Per-page namespace key, e.g. "sales", "delivery", "production". */
  pageKey: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // `tick` forces a re-read after save/delete. Using useMemo + an
  // explicit invalidation tick avoids the set-state-in-effect lint
  // rule and keeps the read derived rather than mirrored.
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const views = useMemo(() => readViews(pageKey), [pageKey, tick]);

  function saveCurrent() {
    const name = window.prompt("Save current view as…")?.trim();
    if (!name) return;
    const next = [
      ...views.filter((v) => v.name !== name),
      { name, search: search || "" },
    ];
    writeViews(pageKey, next);
    setTick((t) => t + 1);
    setOpen(false);
  }

  function applyView(v: SavedView) {
    navigate(pathname + v.search, { replace: false });
    setOpen(false);
  }

  function deleteView(name: string) {
    if (!window.confirm(`Delete saved view "${name}"?`)) return;
    const next = views.filter((v) => v.name !== name);
    writeViews(pageKey, next);
    setTick((t) => t + 1);
  }

  return (
    <div className={`relative inline-block ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white hover:bg-[#FAF9F7] transition-colors"
      >
        <Bookmark className="w-3.5 h-3.5 text-[#9A918A]" />
        <span>Views</span>
        {views.length > 0 && (
          <span className="text-[10px] text-[#9A918A]">({views.length})</span>
        )}
        <ChevronDown className="w-3 h-3 text-[#9A918A]" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 mt-1 w-64 bg-white border border-[#E2DDD8] rounded-md shadow-lg z-50 py-1">
            <button
              type="button"
              onClick={saveCurrent}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[#FAF9F7]"
            >
              <Plus className="w-3.5 h-3.5 text-[#9A918A]" />
              <span>Save current view…</span>
            </button>
            {views.length > 0 && (
              <div className="border-t border-[#E2DDD8] my-1" />
            )}
            {views.map((v) => (
              <div
                key={v.name}
                className="flex items-center hover:bg-[#FAF9F7] group"
              >
                <button
                  type="button"
                  onClick={() => applyView(v)}
                  className="flex-1 px-3 py-2 text-xs text-left text-[#1F1D1B] truncate"
                  title={v.search || "(no filters)"}
                >
                  {v.name}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteView(v.name);
                  }}
                  className="p-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Delete ${v.name}`}
                >
                  <Trash2 className="w-3 h-3 text-[#9A918A] hover:text-[#9A3A2D]" />
                </button>
              </div>
            ))}
            {views.length === 0 && (
              <p className="px-3 py-2 text-[10px] text-[#9A918A]">
                No saved views yet.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
