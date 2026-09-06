// ---------------------------------------------------------------------------
// SequenceUnlockDialog — what a desktop operator sees when the step they ticked
// is waiting on an earlier one.
//
// Owner 2026-09-06 asked for three actions, not two:
//
//   Cancel · Unlock and complete · Complete the earlier step too
//
// The third is the one that fixes the cause. Measured on production the same
// day, 11 of the 20 orders already out of order are WEBBING done with FRAMING
// still open — the frame was almost certainly built and nobody ticked it. Given
// only "unlock", the operator steps over the gap and it stays wrong forever.
// Given "complete the earlier step too", the record catches up with the factory
// — and because it completes upstream FIRST, the WIP produce/consume happens in
// the right order and no negative row is created.
//
// The dialog never decides whether unlocking is allowed: `canSelfUnlock` comes
// from the server on every refusal. During the shadow phase it is true for
// everyone, and when it tightens to supervisors this component needs no change.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";
import {
  UNLOCK_REASONS,
  blockingDepartments,
  type SequenceLockRefusal,
} from "@/lib/sequence-unlock";

export type SequenceUnlockChoice =
  | { action: "unlock"; reason: string }
  | { action: "completeUpstream"; reason: string };

export function SequenceUnlockDialog({
  refusal,
  /** What the operator was trying to finish, for the header. */
  subject,
  onCancel,
  onChoose,
  busy = false,
}: {
  refusal: SequenceLockRefusal | null;
  subject?: string;
  onCancel: () => void;
  onChoose: (choice: SequenceUnlockChoice) => void;
  busy?: boolean;
}) {
  const [reason, setReason] = useState<string>(UNLOCK_REASONS[0]);
  if (!refusal) return null;
  const depts = blockingDepartments(refusal);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-[#E2DDD8] bg-white shadow-lg">
        <div className="flex items-start gap-3 border-b border-[#E2DDD8] px-5 py-4">
          <div className="rounded-lg bg-[#FAEFCB] p-2">
            <Lock className="h-5 w-5 text-[#9C6F1E]" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              An earlier step is not finished
            </h2>
            {subject ? (
              <p className="mt-0.5 truncate text-xs text-[#6B7280]">{subject}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="text-xs text-[#6B7280]">Finish first</p>
            <ul className="mt-1 space-y-1">
              {refusal.blockedBy.map((b) => (
                <li key={b.id} className="text-sm font-medium text-[#1F1D1B]">
                  {b.departmentCode}
                  <span className="ml-2 text-xs font-normal text-[#8A8680]">
                    {b.status.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {refusal.canSelfUnlock ? (
            <>
              {/* Say plainly that this is temporary. The whole point of the
                  shadow phase is that nobody is surprised when it tightens. */}
              <p className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-xs text-[#6B7280]">
                You can release this yourself for now. Once this is switched on
                fully, releasing it will need a supervisor.
              </p>
              <div>
                <label className="block text-xs text-[#6B7280]">Reason</label>
                <select
                  className="mt-1 h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  {UNLOCK_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <p className="rounded border border-[#E8D7D2] bg-[#FBF2F0] px-3 py-2 text-xs text-[#9A3A2D]">
              A supervisor has to release this.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-[#E2DDD8] px-5 py-3">
          {refusal.canSelfUnlock ? (
            <>
              {/* Listed FIRST and given the solid button: it is the action that
                  fixes the cause rather than stepping over it. */}
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => onChoose({ action: "completeUpstream", reason })}
              >
                Complete {depts.join(" + ")} too, then this
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => onChoose({ action: "unlock", reason })}
              >
                Unlock and complete this only
              </Button>
            </>
          ) : null}
          <Button variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
