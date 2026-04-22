// ---------------------------------------------------------------------------
// Auth client-side helpers.
//
// The token + public user blob are stored in localStorage under
// `hookka_auth` as a single JSON object. Everything that touches auth state
// should go through these helpers so the shape is enforced in one place.
// ---------------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  displayName: string;
};

type AuthBlob = {
  token: string;
  user: AuthUser;
};

const STORAGE_KEY = "hookka_auth";

function readBlob(): AuthBlob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthBlob;
    if (!parsed || typeof parsed.token !== "string" || !parsed.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  const blob = readBlob();
  return blob ? blob.token : null;
}

export function getCurrentUser(): AuthUser | null {
  const blob = readBlob();
  return blob ? blob.user : null;
}

export function setAuth(data: { token: string; user: AuthUser }): void {
  // If an OTHER user's session is lingering, snapshot+wipe it first so we
  // never mix state across accounts. Then restore the incoming user's own
  // snapshot (if they've signed in on this browser before).
  try {
    const current = getCurrentUser();
    if (current?.id && current.id !== data.user.id) {
      snapshotFor(current.id);
      wipeLiveUserKeys();
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    restoreFor(data.user.id);
  } catch {
    // Even if state juggling fails, make sure the token blob lands so the
    // user can still use the app.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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

function userSpecificKeys(): string[] {
  const keys = new Set<string>(PER_USER_EXACT_KEYS);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
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
  return getAuthToken() !== null;
}
