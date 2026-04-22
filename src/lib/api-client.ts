// ---------------------------------------------------------------------------
// Global fetch interceptor — runs once at app boot (imported from main.tsx).
//
// Every page in this repo calls `fetch("/api/...")` directly. Rather than
// rewrite every call site, we monkey-patch `window.fetch` so that:
//
//   • Any request to `/api/*` gets `Authorization: Bearer <token>` injected
//     when the user is logged in.
//   • A 401 response clears the stored auth blob and bounces the user to
//     `/login` (unless they are already on it).
//
// Public endpoints (`/api/auth/login`, `/api/auth/logout`, `/api/health`) are
// still hit with the header if present — the backend ignores it for those
// paths. Worker portal calls (`/api/worker-auth/*` and its sibling routes)
// keep using their own `x-worker-token` header; the Bearer token added here
// is harmless to them.
// ---------------------------------------------------------------------------
import { getAuthToken, clearAuth } from "./auth";

const originalFetch = window.fetch.bind(window);

function isApiRequest(url: string): boolean {
  // Support relative ("/api/...") and absolute URLs that target the same
  // origin's API.
  if (url.startsWith("/api/")) return true;
  try {
    const u = new URL(url, window.location.origin);
    return (
      u.origin === window.location.origin && u.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  // Only inject for same-origin /api/* calls.
  let nextInit = init;
  if (isApiRequest(url)) {
    const token = getAuthToken();
    if (token) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has("authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      nextInit = { ...(init ?? {}), headers };
    }
  }

  const response = await originalFetch(input as RequestInfo, nextInit);

  // 401 on /api/* → auth expired / invalid. Wipe state and redirect, but
  // don't loop if the user is already on /login.
  if (
    response.status === 401 &&
    isApiRequest(url) &&
    window.location.pathname !== "/login"
  ) {
    clearAuth();
    const intended = window.location.pathname + window.location.search;
    window.location.href = `/login?next=${encodeURIComponent(intended)}`;
  }

  return response;
};
