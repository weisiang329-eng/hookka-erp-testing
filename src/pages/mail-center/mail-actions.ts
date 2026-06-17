// ---------------------------------------------------------------------------
// Mail Center — shared mutation helpers for thread actions.
//
// These wrap the ONE real backend mutation endpoint for threads:
//   PATCH /api/mail-center/threads/:id  (status open/closed + assignedTo*)
// so the list rows, the bulk action bar and the reading pane all post the
// same way and invalidate the same caches. Anything not expressible through
// that endpoint (star / label / trash / mark-unread) is handled locally in
// mail-local.ts — see the gap note there.
// ---------------------------------------------------------------------------
import { invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { csrfHeaders } from "@/lib/csrf";

// Refresh both the list cache (prefix — any status/mailbox query) and, when
// known, the single-thread cache so the reading pane updates too.
function refreshThread(id?: string): void {
  invalidateCachePrefix("/api/mail-center/threads");
  if (id) invalidateCache(`/api/mail-center/threads/${id}`);
}

// PATCH a single thread's status (open = Inbox, closed = Done/Archive).
// Returns true on success. Caller surfaces the toast so wording can vary.
export async function patchThreadStatus(
  id: string,
  status: "open" | "closed",
): Promise<boolean> {
  try {
    const res = await fetch(`/api/mail-center/threads/${id}`, {
      method: "PATCH",
      headers: csrfHeaders(),
      credentials: "include",
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return false;
    refreshThread(id);
    return true;
  } catch {
    return false;
  }
}

// Set status on many threads (bulk archive / move-to-inbox). Resolves with the
// count that succeeded so the caller can report partial failures honestly.
export async function patchManyStatus(
  ids: string[],
  status: "open" | "closed",
): Promise<number> {
  // Sequential on purpose: D1/Hyperdrive under load throttles bursts, and these
  // lists are small (a handful of selected rows at a time).
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadStatus(id, status)) ok++;
  }
  return ok;
}

// Assign / unassign a single thread.
export async function patchThreadAssignment(
  id: string,
  assignedToUserId: string | null,
  assignedToName: string | null,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/mail-center/threads/${id}`, {
      method: "PATCH",
      headers: csrfHeaders(),
      credentials: "include",
      body: JSON.stringify({ assignedToUserId, assignedToName }),
    });
    if (!res.ok) return false;
    refreshThread(id);
    return true;
  } catch {
    return false;
  }
}
