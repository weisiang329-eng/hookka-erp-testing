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

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return getAuthToken() !== null;
}
