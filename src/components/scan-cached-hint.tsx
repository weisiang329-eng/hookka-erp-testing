// ---------------------------------------------------------------------------
// "Already scanned" surfacing for every OCR scanner (owner 2026-08-01).
//
// scan-queue.ts keys a cache on the SHA-256 of the uploaded bytes: re-upload
// the same file and the row is inserted as status='cached', copying the prior
// row's raw_json verbatim instead of re-calling Claude. That is the desired
// behaviour (free + instant), but the modals used to fold 'cached' into 'done'
// and the operator saw an ordinary green tick — no way to tell a fresh read
// from a replay.
//
// PURELY INFORMATIONAL — owner ruling: never block. The operator creates the
// SO / PI / GRN exactly as before; this only tells them what they're looking
// at. Shared by scan-po-modal (customer PO) and scan-supplier-modal (PI+GRN)
// so the wording can never drift between scanners.
//
// Two things worth flagging, because neither is obvious:
//   * the replay is the ORIGINAL OCR output — corrections made last time live
//     in supplier_scan_samples.correctedJson and are NOT written back to
//     scan_queue.raw_json, so a field fixed by hand last time is wrong again;
//   * a cache hit skips the prompt entirely, so any ocrPromptRules the
//     supplier/customer has since learned do not apply to this replay.
// ---------------------------------------------------------------------------
import { Badge } from "@/components/ui/badge";
import { History } from "lucide-react";

const REUSED_TITLE =
  "This file was scanned before — the saved result is being shown instead of re-reading it. Any corrections you made last time are not carried over, so check the figures.";

/** Per-card marker. Sits alongside the file chip / in the collapsed row. */
export function ReusedScanBadge() {
  return (
    <Badge
      className="bg-blue-50 text-blue-700 border border-blue-200"
      title={REUSED_TITLE}
    >
      <History className="h-3 w-3 inline mr-0.5" /> Already scanned · reused
    </Badge>
  );
}

/**
 * Batch-level heads-up above the preview cards. Informational only — no
 * dismiss, no gate; renders nothing when the batch had no cache hits.
 */
export function CachedScanNotice({
  cachedCount,
  totalCount,
}: {
  cachedCount: number;
  totalCount: number;
}) {
  if (cachedCount <= 0) return null;
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-md text-sm"
      style={{
        background: "var(--bg-info, #EFF6FF)",
        border: "0.5px solid var(--border-info, #BFDBFE)",
        color: "var(--text-info, #1E40AF)",
      }}
    >
      <History className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">
          {cachedCount} of {totalCount} file{totalCount !== 1 ? "s" : ""} had been
          uploaded before — showing the earlier scan.
        </p>
        <p className="text-xs opacity-90">
          Identical file, so it wasn&apos;t read again. This is the original OCR
          result: corrections you made last time aren&apos;t carried over. You can
          still create as normal — just check the figures first.
        </p>
      </div>
    </div>
  );
}
