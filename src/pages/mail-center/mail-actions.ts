// ---------------------------------------------------------------------------
// Mail Center — shared mutation helpers for thread actions.
//
// These wrap the backend thread-mutation endpoint:
//   PATCH /api/mail-center/threads/:id
// which now accepts status (open/closed), assignedTo*, and the email-client
// affordances starred / labels / unread / trashed (all DB-backed). The list
// rows, bulk action bar and reading pane all post the same way and invalidate
// the same caches. Only compose DRAFTS remain local (mail-local.ts) — there is
// no draft table this round.
// ---------------------------------------------------------------------------
import { invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { csrfHeaders } from "@/lib/csrf";

// Refresh both the list cache (prefix — any status/mailbox query) and, when
// known, the single-thread cache so the reading pane updates too.
function refreshThread(id?: string): void {
  invalidateCachePrefix("/api/mail-center/threads");
  if (id) invalidateCache(`/api/mail-center/threads/${id}`);
}

// Generic single-thread PATCH used by the star / label / unread / trash
// helpers below. Posts an arbitrary subset of the mutable fields and
// invalidates the caches on success. Returns true on a 2xx.
type ThreadPatch = {
  status?: "open" | "closed";
  assignedToUserId?: string | null;
  assignedToName?: string | null;
  starred?: boolean;
  labels?: string[];
  unread?: boolean;
  trashed?: boolean;
};

async function patchThread(id: string, patch: ThreadPatch): Promise<boolean> {
  try {
    const res = await fetch(`/api/mail-center/threads/${id}`, {
      method: "PATCH",
      headers: csrfHeaders(),
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    refreshThread(id);
    return true;
  } catch {
    return false;
  }
}

// Star / unstar a single thread (DB-backed). Returns true on success.
export async function patchThreadStarred(
  id: string,
  starred: boolean,
): Promise<boolean> {
  return patchThread(id, { starred });
}

// Replace a thread's label set (DB-backed JSON array). Returns true on success.
export async function patchThreadLabels(
  id: string,
  labels: string[],
): Promise<boolean> {
  return patchThread(id, { labels });
}

// Mark a thread read (unread=false) / unread (unread=true). This is the only
// path that can SET unread back on — GET /threads/:id clears it on open.
export async function patchThreadUnread(
  id: string,
  unread: boolean,
): Promise<boolean> {
  return patchThread(id, { unread });
}

// Move a thread to Trash (trashed=true) / restore it (trashed=false), DB-backed
// soft delete. Returns true on success.
export async function patchThreadTrashed(
  id: string,
  trashed: boolean,
): Promise<boolean> {
  return patchThread(id, { trashed });
}

// Bulk variants — sequential (D1/Hyperdrive throttles bursts; these lists are
// a handful of selected rows). Each resolves with the count that succeeded so
// callers can report partial failures honestly.
export async function patchManyUnread(
  ids: string[],
  unread: boolean,
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadUnread(id, unread)) ok++;
  }
  return ok;
}

export async function patchManyTrashed(
  ids: string[],
  trashed: boolean,
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadTrashed(id, trashed)) ok++;
  }
  return ok;
}

// PATCH a single thread's status (open = Inbox, closed = Done/Archive).
// Returns true on success. Caller surfaces the toast so wording can vary.
export async function patchThreadStatus(
  id: string,
  status: "open" | "closed",
): Promise<boolean> {
  return patchThread(id, { status });
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
  return patchThread(id, { assignedToUserId, assignedToName });
}
