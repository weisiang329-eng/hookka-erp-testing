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

// "Remember me" decides WHERE the public user blob lives, mirroring where the
// HttpOnly session cookie lives:
//   • checked   → localStorage   (persists across browser restart, just like
//                 the persistent on-disk session cookie). Owner stays signed in.
//   • unchecked → sessionStorage (wiped when the browser closes, just like the
//                 session-only cookie). Next launch = blob gone + cookie gone
//                 = a clean signed-out state with no flash of authed UI.
// readBlob() checks sessionStorage first (a same-session login wins over any
// stale persistent blob) then falls back to localStorage.
function readBlob(): AuthBlob | null {
  const raw =
    safeGet(sessionStorage, STORAGE_KEY) ?? safeGet(localStorage, STORAGE_KEY);
  if (!raw) return null;
  try {
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

// localStorage / sessionStorage can throw (private-mode quota, disabled
// storage). Keep every access infallible so auth never hard-crashes the app.
function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
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

export function setAuth(data: { user: AuthUser; rememberMe?: boolean }): void {
  // If an OTHER user's session is lingering, snapshot+wipe it first so we
  // never mix state across accounts. Then restore the incoming user's own
  // snapshot (if they've signed in on this browser before).
  const blob: AuthBlob = { user: data.user };
  const serialized = JSON.stringify(blob);
  // Where the blob lives must match the cookie's persistence (see readBlob):
  // Remember-me → localStorage; otherwise → sessionStorage. Default false so
  // an absent flag is treated as session-only (the safer choice).
  const persist = data.rememberMe === true;
  try {
    const current = getCurrentUser();
    if (current?.id && current.id !== data.user.id) {
      snapshotFor(current.id);
      wipeLiveUserKeys();
    }
    // Unconditionally, even for the SAME user id: what a person may see can
    // change without the person changing. sales@hookka.com went from Super
    // Admin to Sales and kept every cached list from before the change,
    // which is what the owner was looking at.
    wipeApiCache();
    writeBlob(serialized, persist);
    restoreFor(data.user.id);
  } catch {
    // Even if state juggling fails, make sure the user blob lands so the
    // sidebar/topbar can render correctly.
    writeBlob(serialized, persist);
  }
}

// Write the blob to the chosen store and clear the OTHER store, so the blob
// only ever lives in one place — otherwise a stale localStorage blob from a
// prior "Remember me" login would survive a later session-only login and keep
// the user "signed in" across restart. Each access is wrapped so a throwing
// store never aborts login.
function writeBlob(serialized: string, persist: boolean): void {
  const primary = persist ? localStorage : sessionStorage;
  const secondary = persist ? sessionStorage : localStorage;
  try {
    primary.setItem(STORAGE_KEY, serialized);
  } catch {
    /* best-effort */
  }
  try {
    secondary.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
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

/**
 * Drop every cached API response.
 *
 * `useCachedJson` keys its localStorage entries by URL alone, with no notion of
 * who fetched them. On a shared floor terminal that means the next person to
 * sign in is served the previous person's customer list, sales orders and
 * invoices — from cache, before any request goes out, so no amount of
 * server-side scoping can stop it. Owner 2026-08-05: "出来的 Sales Order 基本上
 * 全部也没有根据那个 sales 看得到的东西."
 *
 * Swept on BOTH sign-out and sign-in: a tab that was closed without logging out
 * never runs the sign-out path, and that is exactly the case worth covering.
 *
 * The prefix is written out rather than imported from cached-fetch, which
 * imports this module — and it is matched WITHOUT the build id that follows it,
 * so entries left by an earlier deploy are cleared too rather than lingering
 * under a namespace nothing sweeps.
 */
const API_CACHE_PREFIX = "hookka-cache:";

function wipeApiCache(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(API_CACHE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* private-mode quotas — best-effort */
  }
}

export function clearAuth(): void {
  try {
    // Snapshot the current user's UI state before wiping live keys, so a
    // future login as the same user restores their tabs/columns/etc.
    const current = getCurrentUser();
    if (current?.id) snapshotFor(current.id);
    wipeLiveUserKeys();
    wipeApiCache();
    // Clear the blob from BOTH stores — we don't know (or care) which one a
    // given login used; logout must leave neither behind.
    localStorage.removeItem(STORAGE_KEY);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* best-effort */
    }
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
