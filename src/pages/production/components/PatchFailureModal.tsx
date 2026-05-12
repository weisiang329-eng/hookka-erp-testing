// Persistent failure modal for the production matrix page.
//
// When `patchJobCard` exhausts its retries against the server, it pushes the
// failure here and rolls the optimistic UI back to the pre-edit value. The
// modal stays mounted (operator can't miss it via a 2s toast disappearing) and
// lists every still-failed edit with Retry / Discard per row + bulk actions.
//
// Why a modal not a toast: the existing `toast.error("Save failed... Refresh
// and retry")` was easy to miss (operators are looking at the matrix, not the
// corner). Worse — patchJobCard previously did NOT roll back optimistic state
// on failure, so the cell kept showing the user's attempted value while the
// server held the OLD value. Next refetch silently reverted the cell, looking
// to the operator like the system "ate" their edit. Verified on prod via
// job_card_events: 153 COMPLETED_DATE_CLEARED + many silent-dueDate cases.
//
// The dialog returns null when there are no failures so we can render it
// unconditionally at the end of the page tree.
import { Button } from "@/components/ui/button";

export type PatchFailure = {
  id: string;
  poId: string;
  jcId: string;
  deptCode: string;
  deptName: string;
  // Fields the operator tried to set, exactly as sent in the PATCH body.
  attemptedPatch: Record<string, unknown>;
  // The pre-edit value of those same fields. Already restored to the local
  // `orders` state by the time this modal renders — kept here so the row can
  // explain "X reverted to Y".
  prevState: Record<string, unknown>;
  errorMsg: string;
  // Number of retries that were attempted before giving up. 0 = network/server
  // failed on the first call. 2 = both auto-retries also failed.
  attemptsUsed: number;
  // Timestamp the failure was recorded — sorted newest-first in the list.
  at: number;
};

function describePatch(patch: Record<string, unknown>): string {
  return Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} → ${v === null || v === "" ? "(cleared)" : String(v)}`)
    .join(", ");
}

function describePrev(prev: Record<string, unknown>): string {
  return Object.entries(prev)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${v === null || v === "" ? "(empty)" : String(v)}`)
    .join(", ");
}

export function PatchFailureModal({
  failures,
  onRetry,
  onDiscard,
  onRetryAll,
  onDiscardAll,
}: {
  failures: PatchFailure[];
  onRetry: (failure: PatchFailure) => void;
  onDiscard: (id: string) => void;
  onRetryAll: () => void;
  onDiscardAll: () => void;
}) {
  if (failures.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="bg-red-600 text-white px-5 py-4 rounded-t-lg flex items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-lg leading-tight">
              ⚠ {failures.length} Save Failed — Action Required
            </h2>
            <div className="text-sm opacity-90 mt-1">
              The matrix has been rolled back to the previous values. Pick
              Retry to try again, or Discard to keep the previous value.
            </div>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetryAll}
              className="bg-white text-red-700 hover:bg-red-50"
            >
              Retry All
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onDiscardAll}
              className="bg-transparent text-white border border-white hover:bg-red-700"
            >
              Discard All
            </Button>
          </div>
        </div>
        <div className="overflow-auto p-4 space-y-3 flex-1">
          {failures.map((f) => (
            <div
              key={f.id}
              className="border border-red-200 bg-red-50/50 rounded p-3 flex items-start justify-between gap-3"
            >
              <div className="text-sm min-w-0 flex-1">
                <div className="font-medium text-gray-900">
                  {f.deptName || f.deptCode} · JC{" "}
                  <code className="text-xs bg-gray-100 px-1 rounded">
                    {f.jcId.slice(-16)}
                  </code>
                </div>
                <div className="text-gray-700 mt-1">
                  <span className="font-medium">Tried:</span>{" "}
                  {describePatch(f.attemptedPatch)}
                </div>
                <div className="text-gray-500 text-xs mt-1">
                  Previous: {describePrev(f.prevState)}
                </div>
                <div className="text-red-700 text-xs mt-1">
                  ⚠ {f.errorMsg}
                  {f.attemptsUsed > 0 && (
                    <span className="text-gray-500 ml-2">
                      (auto-retried {f.attemptsUsed}× before giving up)
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <Button size="sm" onClick={() => onRetry(f)}>
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDiscard(f.id)}
                >
                  Discard
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
