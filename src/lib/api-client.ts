// ---------------------------------------------------------------------------
// Global fetch interceptor — runs once at app boot (imported from main.tsx).
//
// Sprint 7: dashboard auth migrated from `Authorization: Bearer <token>`
// (read from localStorage) to a HttpOnly `hookka_session` cookie set by
// the server on login + a non-HttpOnly `hookka_csrf` cookie that this
// interceptor echoes as `X-CSRF-Token` on mutating requests. The browser
// auto-attaches the session cookie when we set `credentials: 'include'`,
// so there's nothing to inject for GET reads.
//
// Every page in this repo calls `fetch("/api/...")` directly. Rather than
// rewrite every call site, we monkey-patch `window.fetch` so that:
//
//   • Any same-origin request to `/api/*` runs with `credentials: 'include'`
//     so the auth + CSRF cookies travel.
//   • POST/PUT/PATCH/DELETE requests get `X-CSRF-Token: <hookka_csrf>`
//     pulled from `document.cookie` (unless the caller already set the
//     header explicitly).
//   • A 401 response clears the cached user blob and bounces the user to
//     `/login` (unless they are already on it).
//
// Public endpoints (`/api/auth/login`, `/api/auth/logout`, `/api/health`)
// also pass through the cookie / CSRF treatment — the backend ignores
// them where appropriate. Worker portal calls (`/api/worker-auth/*` and
// its sibling routes) keep using their own `x-worker-token` header; the
// CSRF header added here is harmless to them (the worker middleware
// doesn't read it).
// ---------------------------------------------------------------------------
import { clearAuth } from "./auth";
import { readCsrfCookie, CSRF_HEADER_NAME } from "./csrf";

const originalFetch = window.fetch.bind(window);

const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m =
    init?.method ??
    (input instanceof Request ? input.method : undefined) ??
    "GET";
  return m.toUpperCase();
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  let nextInit = init;
  if (isApiRequest(url)) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // CSRF on mutating methods. Don't clobber an explicitly-supplied header.
    const method = methodOf(input, init);
    if (CSRF_METHODS.has(method) && !headers.has(CSRF_HEADER_NAME)) {
      const csrf = readCsrfCookie();
      if (csrf) headers.set(CSRF_HEADER_NAME, csrf);
    }
    nextInit = {
      ...(init ?? {}),
      headers,
      // Always send cookies along with /api/* requests. Same-origin defaults
      // are usually `same-origin` already, but being explicit keeps things
      // working if the API ever lives on a sibling subdomain behind a CDN.
      credentials: init?.credentials ?? "include",
    };
  }

  const response = await originalFetch(input as RequestInfo, nextInit);

  // 401 on /api/* → auth expired / invalid. Wipe state and redirect, but
  // don't loop if the user is already on /login.
  //
  // Worker portal exception: pages under /worker/* and calls to
  // /api/worker* run on the separate worker-token auth flow. Bouncing
  // them to the admin /login leaks them out of the mobile portal entirely
  // (Wei Siang 2026-05-10: "为什么登录了之后让我登录电脑版本"). WorkerLayout
  // + workerFetch handle their own 401 → /worker/login redirect.
  const onWorkerPortal = window.location.pathname.startsWith("/worker");
  const isWorkerApi = /^\/api\/worker(-auth)?(\/|$)/.test(
    url.startsWith("/") ? url : new URL(url, window.location.origin).pathname,
  );
  if (
    response.status === 401 &&
    isApiRequest(url) &&
    window.location.pathname !== "/login" &&
    !onWorkerPortal &&
    !isWorkerApi
  ) {
    clearAuth();
    const intended = window.location.pathname + window.location.search;
    window.location.href = `/login?next=${encodeURIComponent(intended)}`;
  }

  return response;
};
