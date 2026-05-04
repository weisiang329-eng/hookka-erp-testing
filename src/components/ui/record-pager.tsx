// ---------------------------------------------------------------------------
// RecordPager — prev/next pagination between records of the same type.
//
// Pattern from Odoo's record view header: when you're looking at SO 0042
// you can ← → between SO 0041 and SO 0043 of the current list (the same
// list filter that was active on the index page). Saves a round-trip
// back to the list page when reviewing many records in sequence.
//
// Adoption:
//   const ids = ['SO-0001', 'SO-0002', 'SO-0003'];
//   <RecordPager ids={ids} currentId="SO-0002" linkPrefix="/sales/" />
//
// The `ids` list is the responsibility of the parent page — usually
// pulled from sessionStorage (cached when the user clicked through from
// the list page) or from the current useCachedJson list response.
// ---------------------------------------------------------------------------
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function RecordPager({
  ids,
  currentId,
  linkPrefix,
  className,
}: {
  ids: string[];
  currentId: string;
  /** Path prefix; gets concatenated with the id (e.g. "/sales/" + id). */
  linkPrefix: string;
  className?: string;
}) {
  if (ids.length <= 1) return null;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return null;
  const prev = idx > 0 ? ids[idx - 1] : null;
  const next = idx < ids.length - 1 ? ids[idx + 1] : null;

  return (
    <div className={`flex items-center gap-1 text-xs text-[#6B7280] ${className ?? ""}`}>
      {prev ? (
        <Link
          to={`${linkPrefix}${encodeURIComponent(prev)}`}
          className="p-1.5 rounded hover:bg-[#FAF9F7] hover:text-[#1F1D1B] transition-colors"
          aria-label={`Previous: ${prev}`}
          title={`Previous: ${prev}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
      ) : (
        <span className="p-1.5 text-[#C9C2B9] cursor-not-allowed">
          <ChevronLeft className="h-4 w-4" />
        </span>
      )}
      <span className="px-2 font-medium tabular-nums">
        {idx + 1} / {ids.length}
      </span>
      {next ? (
        <Link
          to={`${linkPrefix}${encodeURIComponent(next)}`}
          className="p-1.5 rounded hover:bg-[#FAF9F7] hover:text-[#1F1D1B] transition-colors"
          aria-label={`Next: ${next}`}
          title={`Next: ${next}`}
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : (
        <span className="p-1.5 text-[#C9C2B9] cursor-not-allowed">
          <ChevronRight className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}
