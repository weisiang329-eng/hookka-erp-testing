// ---------------------------------------------------------------------------
// notifications-feed — the single source of truth for "what does the bell say".
//
// Why this exists: the top-bar bell used to be a dead button with a hardcoded
// pink dot. A permanently-lit indicator that means nothing is worse than no
// indicator, so the dot must be derived from the SAME rows the Notifications
// page renders, and it must go dark the moment those rows are marked read —
// including when they are marked read on the OTHER surface.
//
// Two surfaces (top-bar popover + /notifications page) read one feed, and both
// mark-read through `markNotificationsRead`, which broadcasts so the other
// surface re-reads. No polling loop is needed for correctness; the bell also
// refetches when it is opened and when the tab regains focus, which is when a
// human would expect it to be current.
//
// The parsing / counting / ordering helpers are pure so they are unit-tested
// without a DOM or a database.
// ---------------------------------------------------------------------------
import type { Notification } from "@/types";

/** Endpoint both surfaces read. */
export const NOTIFICATIONS_URL = "/api/notifications";

/**
 * The API returns a bare JSON array, but historic callers also handled a
 * `{ data: [...] }` envelope. Accept both, and NEVER throw on a shape we
 * don't recognise — a malformed payload must leave the bell dark, not crash
 * the whole top bar.
 */
export function parseNotificationList(raw: unknown): Notification[] {
  if (Array.isArray(raw)) return raw as Notification[];
  const data = (raw as { data?: unknown } | null | undefined)?.data;
  if (Array.isArray(data)) return data as Notification[];
  return [];
}

/**
 * `isRead` arrives as a real boolean from the route (it maps the stored
 * integer). Anything that is not explicitly "read" counts as unread — but a
 * row with a truthy legacy value (1 / "1" / true) must NOT be counted, or the
 * dot would stay lit forever on a database that stores integers.
 */
export function isUnread(n: Pick<Notification, "isRead">): boolean {
  const v = (n as { isRead?: unknown }).isRead;
  return !(v === true || v === 1 || v === "1");
}

/** How many of these rows are genuinely unread. 0 → the dot must not render. */
export function unreadCount(list: readonly Notification[]): number {
  return list.reduce((n, x) => n + (isUnread(x) ? 1 : 0), 0);
}

/**
 * What the bell popover shows: unread first (that is why the operator opened
 * it), each group newest-first, capped. Read rows still appear so an empty
 * inbox and a fully-read inbox look different.
 */
export function recentForBell(list: readonly Notification[], limit = 8): Notification[] {
  const byNewest = (a: Notification, b: Notification) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
  const unread = list.filter(isUnread).sort(byNewest);
  const read = list.filter((n) => !isUnread(n)).sort(byNewest);
  return [...unread, ...read].slice(0, Math.max(0, limit));
}

// ── Cross-surface change broadcast ─────────────────────────────────────────
// Deliberately a module-local Set rather than a window event: both surfaces
// live in the same bundle, and a window event would also fire across the
// print/preview iframes the PDF helpers mount.

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeNotifications(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyNotificationsChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* one bad listener must not stop the others */
    }
  }
}

// ── Network ────────────────────────────────────────────────────────────────

/** Fetch the feed. Returns [] on any failure — the bell degrades to dark. */
export async function loadNotifications(): Promise<Notification[]> {
  try {
    const res = await fetch(NOTIFICATIONS_URL);
    if (!res.ok) return [];
    return parseNotificationList(await res.json());
  } catch {
    return [];
  }
}

/**
 * Mark ids read, then tell every surface to re-read. Returns true when the
 * server accepted the write — the caller should only apply an optimistic
 * local read-state when it did, otherwise the dot lies until the next fetch.
 */
export async function markNotificationsRead(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  let ok = false;
  try {
    const res = await fetch(NOTIFICATIONS_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) notifyNotificationsChanged();
  return ok;
}
