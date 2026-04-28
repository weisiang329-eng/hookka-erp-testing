// ---------------------------------------------------------------------------
// <LockBanner /> — render a yellow banner explaining why an entity is
// locked (downstream document already exists). Returns null when the
// `reason` prop is null/empty so it can be dropped at the top of any
// detail / edit page without conditional wrapping.
//
// The reason text comes from the backend lock-helpers (lib/lock-helpers.ts),
// e.g. "Cannot edit Sales Order — Production Order SO-25001-01 is already
// COMPLETED. Cancel the production order first to unlock the SO."
// ---------------------------------------------------------------------------
import { Lock } from "lucide-react";

export function LockBanner({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-[#E8B2A1] bg-[#FBF3F1] px-4 py-3 flex items-start gap-3 text-sm"
    >
      <Lock className="h-4 w-4 text-[#9A3A2D] mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium text-[#7A2E24] mb-0.5">Locked</div>
        <div className="text-[#7A2E24]">{reason}</div>
      </div>
    </div>
  );
}
