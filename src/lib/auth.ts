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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// Per-user UI state that should not leak across logouts / account switches.
// Listed here rather than scattered at call-sites so adding a new persisted
// preference means one place to update.
const PER_USER_EXACT_KEYS = [
  STORAGE_KEY,                     // hookka_auth — token + user blob
  "hookka-global-search-recent",   // GlobalSearch recent searches
  "hookka-open-tabs",              // TabsProvider open tabs
  "sidebar-collapsed-groups",      // Sidebar group collapse state
];
const PER_USER_PREFIXES = [
  "datagrid-cols-",        // DataGrid visible columns per grid
  "datagrid-colorder-",    // DataGrid column order per grid
  "datagrid-views-",       // DataGrid saved views per grid
];

export function clearAuth(): void {
  try {
    for (const key of PER_USER_EXACT_KEYS) localStorage.removeItem(key);
    // Sweep prefixed keys. Collect first, then remove — mutating localStorage
    // while iterating `key(i)` shifts indices.
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (PER_USER_PREFIXES.some((p) => k.startsWith(p))) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    // localStorage can throw in private-mode quotas; best-effort is fine.
  }
}

export function isAuthenticated(): boolean {
  return getAuthToken() !== null;
}
