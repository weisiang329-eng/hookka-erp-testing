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

// Apply ONE label name to many threads (bulk label). Merges the name into each
// thread's existing set (case-insensitive, no duplicates). Resolves with the
// count that succeeded. Sequential for the same reason as the other bulk
// helpers (D1/Hyperdrive throttles bursts; selections are small). `current` maps
// threadId → its existing label names so we PATCH the merged set per row.
export async function patchManyAddLabel(
  items: { id: string; labels: string[] }[],
  name: string,
): Promise<number> {
  const clean = name.trim();
  if (!clean) return 0;
  let ok = 0;
  for (const it of items) {
    const has = it.labels.some((l) => l.toLowerCase() === clean.toLowerCase());
    const next = has ? it.labels : [...it.labels, clean];
    if (await patchThreadLabels(it.id, next)) ok++;
  }
  return ok;
}

// ── Label catalogue (name → colour) ────────────────────────────────────────
// The per-thread label SET still lives on email_threads.labels; this catalogue
// only carries colours + the canonical managed list. Mutations invalidate the
// catalogue cache AND the thread caches (a rename cascades server-side into the
// thread label arrays, so the list rows must refetch to show the new name).

function refreshLabels(): void {
  invalidateCachePrefix("/api/mail-center/labels");
  // A rename/delete rewrites thread label arrays server-side — refresh those too.
  invalidateCachePrefix("/api/mail-center/threads");
}

export async function createLabel(
  name: string,
  color: string,
): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;
  try {
    const res = await fetch("/api/mail-center/labels", {
      method: "POST",
      headers: csrfHeaders(),
      credentials: "include",
      body: JSON.stringify({ name: clean, color }),
    });
    if (!res.ok) return false;
    refreshLabels();
    return true;
  } catch {
    return false;
  }
}

export async function updateLabel(
  id: string,
  patch: { name?: string; color?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`/api/mail-center/labels/${id}`, {
      method: "PATCH",
      headers: csrfHeaders(),
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    refreshLabels();
    return true;
  } catch {
    return false;
  }
}

export async function deleteLabel(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/mail-center/labels/${id}`, {
      method: "DELETE",
      headers: csrfHeaders(),
      credentials: "include",
    });
    if (!res.ok) return false;
    refreshLabels();
    return true;
  } catch {
    return false;
  }
}

// ── Department / shared mailbox provisioning ───────────────────────────────
// SUPER_ADMIN one-click setup for a SHARED department mailbox (support@/finance@
// /hr@): reuses the existing POST /api/mail-center/addresses (the same endpoint
// User Management uses), creating an address row with an assignedDept and NO
// assigned user — i.e. a shared mailbox several people can be granted. Returns
// the new address id on success, or null on failure / 403 (non-admin). On
// success the addresses cache is invalidated so the sidebar shows it.
export async function createDeptMailbox(
  address: string,
  dept: string,
  label: string,
): Promise<string | null> {
  try {
    const res = await fetch("/api/mail-center/addresses", {
      method: "POST",
      headers: csrfHeaders(),
      credentials: "include",
      body: JSON.stringify({ address, assignedDept: dept, label }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    invalidateCachePrefix("/api/mail-center/addresses");
    return body?.id ?? "";
  } catch {
    return null;
  }
}
