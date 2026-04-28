// ---------------------------------------------------------------------------
// Auth client-side helpers.
//
// Sprint 7: the session token now lives in a HttpOnly `hookka_session`
// cookie set by the server on login (see src/api/routes/auth.ts) — JS can
// no longer read it. localStorage still holds the *public* user blob
// ({id,email,role,displayName}) under `hookka_auth` so the UI can render
// the welcome state, sidebar avatar, etc., without a /me round-trip on
// every page load. Per-user UI state snapshotting (tabs, datagrid columns)
// continues to work the same way.
//
// `getAuthToken()` is kept as a no-op shim that always returns null —
// callers that used to inject `Authorization: Bearer` should rely on the
// browser auto-attaching the cookie via `credentials: 'include'`. The shim
// avoids a sweeping rename across kv-config / use-presence / fetch-json /
// api-client; once those are confirmed CSRF-safe in a follow-up sweep the
// shim can be deleted.
// ---------------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  displayName: string;
};

// Persisted blob shape — Sprint 7 dropped the `token` field.
type AuthBlob = {
  user: AuthUser;
};

const STORAGE_KEY = "hookka_auth";

function readBlob(): AuthBlob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthBlob & { token: unknown }>;
    if (!parsed || !parsed.user || typeof parsed.user !== "object") return null;
    // Old blobs from before Sprint 7 had a `token` field; tolerate them by
    // returning just the user — the cookie (if any) supplies the credential
    // now. If the cookie is also gone, the next /api/* call 401s and the
    // api-client redirects to /login, prompting a fresh sign-in that lands
    // a Sprint-7 cookie pair.
    return { user: parsed.user as AuthUser };
  } catch {
    return null;
  }
}

/**
 * @deprecated Sprint 7. Returns null. The session token now lives in a
 * HttpOnly cookie that JS cannot read; callers should rely on the browser
 * auto-attaching it (see api-client.ts using `credentials: 'include'`).
 * Kept so existing call sites compile while we migrate them off.
 */
export function getAuthToken(): string | null {
  return null;
}

export function getCurrentUser(): AuthUser | null {
  const blob = readBlob();
  return blob ? blob.user : null;
}

export function setAuth(data: { user: AuthUser }): void {
  // If an OTHER user's session is lingering, snapshot+wipe it first so we
  // never mix state across accounts. Then restore the incoming user's own
  // snapshot (if they've signed in on this browser before).
  const blob: AuthBlob = { user: data.user };
  try {
    const current = getCurrentUser();
    if (current?.id && current.id !== data.user.id) {
      snapshotFor(current.id);
      wipeLiveUserKeys();
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    restoreFor(data.user.id);
  } catch {
    // Even if state juggling fails, make sure the user blob lands so the
    // sidebar/topbar can render correctly.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  }
}

// Per-user UI state that should not leak across logouts / account switches
// AND should be restored when the same user signs back in. On logout we
// snapshot these keys under `hookka-ui-state:{userId}`; on setAuth we
// restore the snapshot for the incoming user. One place to list them.
const PER_USER_EXACT_KEYS = [
  // NOTE: hookka_auth itself is deliberately NOT in this list — it's managed
  // directly by set/clear below, not snapshotted.
  "hookka-global-search-recent",   // GlobalSearch recent searches
  "hookka-open-tabs",              // TabsProvider open tabs
  "sidebar-collapsed-groups",      // Sidebar group collapse state
];
const PER_USER_PREFIXES = [
  "datagrid-cols-",        // DataGrid visible columns per grid
  "datagrid-colorder-",    // DataGrid column order per grid
  "datagrid-views-",       // DataGrid saved views per grid
];
const SNAPSHOT_KEY_PREFIX = "hookka-ui-state:";

// Keys matching a PER_USER_PREFIX but ending in one of these suffixes are
// org-wide (shared across all users on this browser) — admin-published
// defaults that future first-time viewers should still see after logout.
// Skipping them here is what keeps "Save as Org Default" durable.
const SHARED_SUFFIXES = ["-org-default"];

function userSpecificKeys(): string[] {
  const keys = new Set<string>(PER_USER_EXACT_KEYS);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (SHARED_SUFFIXES.some((s) => k.endsWith(s))) continue;
    if (PER_USER_PREFIXES.some((p) => k.startsWith(p))) keys.add(k);
  }
  return [...keys];
}

function snapshotFor(userId: string): void {
  const snap: Record<string, string> = {};
  for (const k of userSpecificKeys()) {
    const v = localStorage.getItem(k);
    if (v !== null) snap[k] = v;
  }
  localStorage.setItem(SNAPSHOT_KEY_PREFIX + userId, JSON.stringify(snap));
}

function restoreFor(userId: string): void {
  const raw = localStorage.getItem(SNAPSHOT_KEY_PREFIX + userId);
  if (!raw) return;
  try {
    const snap = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(snap)) {
      if (typeof v === "string") localStorage.setItem(k, v);
    }
  } catch {
    // malformed snapshot — drop it silently
  }
}

function wipeLiveUserKeys(): void {
  for (const k of userSpecificKeys()) localStorage.removeItem(k);
}

export function clearAuth(): void {
  try {
    // Snapshot the current user's UI state before wiping live keys, so a
    // future login as the same user restores their tabs/columns/etc.
    const current = getCurrentUser();
    if (current?.id) snapshotFor(current.id);
    wipeLiveUserKeys();
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can throw in private-mode quotas; best-effort is fine.
  }
}

export function isAuthenticated(): boolean {
  // The user blob is set in lockstep with the cookie at login time, so it's
  // a reliable client-side proxy for "do we believe we're authed?".  If the
  // server-side cookie is in fact gone or expired, the next /api/* call
  // 401s and the api-client redirects to /login.
  return getCurrentUser() !== null;
}
