// ---------------------------------------------------------------------------
// document-detail-drawer.tsx — the shared CHROME for a document's right-hand
// detail drawer (the slide-over that opens from a row on a document workbench).
//
// Chrome ONLY, no domain knowledge. The page passes its EXISTING detail body as
// `children`; the shell owns the scrim, the right-hand panel, the header bar
// (doc no / doc type / status badge / "Open full page" / close) and the sticky
// action bar at the bottom. A second document type (Sales Order, Invoice) is a
// body component plus a `DRAFT_DOC_CONFIG` entry in src/lib/document-drawer.ts
// — not a fork of this file.
//
// Layout: the PANEL is the scroll container's parent, not the scroller itself —
// header and footer are `shrink-0` siblings of a `flex-1 overflow-y-auto` body,
// so the action bar is genuinely pinned rather than `sticky` inside a scrolling
// box (which loses the pin whenever the body is shorter than the panel).
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { X, ExternalLink } from "lucide-react";

export type DocumentDetailDrawerProps = {
  /** Document number shown as the drawer's title, e.g. "DO-2607-022". */
  docNo: string;
  /** Human label for the document type, e.g. "Delivery Order". */
  docType: string;
  /** Status badge — rendered by the caller so each module keeps its own tones. */
  status?: ReactNode;
  /**
   * Route of the document's existing full page. Omit and the button is not
   * offered (never render a dead link).
   */
  fullPageHref?: string;
  /** Small icon buttons that belong beside the title (edit / delete / print). */
  headerActions?: ReactNode;
  /** The sticky bottom action bar. Usually built from the list's row menu. */
  footer?: ReactNode;
  /** The ✕ button and Escape. */
  onClose: () => void;
  /**
   * Clicking the scrim. Defaults to `onClose`; pass a guarded handler when the
   * body has unsaved state (the DO drawer refuses to close mid-edit).
   */
  onScrimClick?: () => void;
  children: ReactNode;
};

export function DocumentDetailDrawer({
  docNo,
  docType,
  status,
  fullPageHref,
  headerActions,
  footer,
  onClose,
  onScrimClick,
  children,
}: DocumentDetailDrawerProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`${docType} ${docNo}`}
    >
      <div
        className="flex-1 bg-black/40"
        onClick={onScrimClick ?? onClose}
        aria-hidden
      />
      <div className="flex h-full w-full max-w-5xl flex-col border-l border-[#E2DDD8] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[#E2DDD8] px-6 py-4 max-sm:px-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-[#1F1D1B] doc-number">
              {docNo}
            </h2>
            <p className="truncate text-xs text-[#6B7280]">{docType}</p>
          </div>
          {status}
          {fullPageHref && (
            <Link
              to={fullPageHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#A8CAD2] px-2.5 py-1.5 text-[11.5px] font-semibold text-[#3E6570] transition-colors hover:bg-[#E0EDF0]"
            >
              Open full page <ExternalLink className="h-3 w-3" />
            </Link>
          )}
          {headerActions}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="rounded-md p-1.5 text-[#6B7280] transition-colors hover:bg-[#F0ECE9] hover:text-[#1F1D1B]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">{children}</div>

        {/* Sticky action bar */}
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[#E2DDD8] bg-white px-6 py-4 max-sm:px-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export default DocumentDetailDrawer;
