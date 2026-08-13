// ---------------------------------------------------------------------------
// RecordLoadError — the card a detail page shows when the record could not be
// LOADED, as opposed to not EXISTING.
//
// Why this exists (BUG-2026-08-13-016, audit finding D3). `api-client.ts`
// aborts every `/api/*` request at 30 s. `cached-fetch.ts` used to swallow
// that abort with no error set, so a page was handed
// `data = null, loading = false, error = null` — the exact state it would get
// if the server had answered and had nothing. Eight detail pages therefore
// printed "Order not found." / "Invoice not found." / "GRN not found." over
// requests that had merely been killed, and four sat on a permanent "Loading…".
//
// "Not found" is a STATEMENT ABOUT THE BUSINESS: it tells an operator the
// document is gone, and people act on that — they re-key orders that already
// exist. This component is the honest alternative, and it says three things a
// blank "not found" does not: that the record could not be LOADED, WHY, and
// that its absence was never observed. Same rule, same shape as `ReportError`
// on `reports.tsx`, one level down: the record, not the range.
//
// It is shown only when there is NOTHING to render. A page still holding
// cached data keeps showing it — never blank a populated page (the 2026-06-04
// blank-page guard).
// ---------------------------------------------------------------------------
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "./button";
import { Card, CardContent } from "./card";
import type { CachedFetchFailure } from "@/lib/cached-fetch";

export type RecordLoadErrorProps = {
  /**
   * What the operator was opening, lowercase and singular — "sales order",
   * "invoice", "GRN". Used in both sentences, so it must read naturally after
   * "This " and after "does not exist".
   */
  subject: string;
  /** The classified failure from `useCachedJson` / `cachedFetchJsonResult`. */
  failure: CachedFetchFailure;
  /** Re-runs the fetch. `useCachedJson`'s `refresh` is exactly this. */
  onRetry: () => void;
  /** Optional route back to the list this record came from. */
  backTo?: string;
  backLabel?: string;
};

export function RecordLoadError({
  subject,
  failure,
  onRetry,
  backTo,
  backLabel,
}: RecordLoadErrorProps) {
  return (
    <div className="space-y-4">
      {backTo && (
        <Link
          to={backTo}
          className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> {backLabel ?? "Back"}
        </Link>
      )}
      <Card className="border-[#C2410C]/30 bg-[#FFF7ED]">
        <CardContent className="p-5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-[#C2410C] shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm font-semibold text-[#1F1D1B]">
              This {subject} couldn&apos;t be loaded
            </p>
            <p className="text-sm text-[#4B5563]">{failure.message}</p>
            <p className="text-xs text-[#6B7280]">
              Nothing is shown because the data never arrived — this is not a
              statement that the {subject} does not exist.
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
