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
import { reportApiCall } from "./fe-rum";

const originalFetch = window.fetch.bind(window);

const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Hard cap on how long any /api/* request can hang before we abort + report
// it as a timeout. 30s is well past the human "this is broken" threshold
// (typical complaint kicks in at 5-8s) but short enough that a stuck call
// doesn't tie up the connection slot forever. Recovery: the page surfaces
// a fetch error, the user retries / refreshes. Without this cap the call
// hangs indefinitely and never shows up in observability.
const API_TIMEOUT_MS = 30_000;

function pathOf(url: string): string {
  try {
    if (url.startsWith("/")) return url.split(/[?#]/)[0];
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split(/[?#]/)[0].slice(0, 200);
  }
}

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
  // Composed timeout controller — fires AbortController.abort() at 30s so
  // a stuck call resolves as a TypeError instead of hanging forever. If the
  // caller passed their own signal, chain it (caller-abort still wins).
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let aborted = false;
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
    const controller = new AbortController();
    timeoutId = setTimeout(() => {
      aborted = true;
      controller.abort();
    }, API_TIMEOUT_MS);
    // Chain a caller-supplied signal if there is one. This way both
    // caller-cancel and our timeout can fire abort.
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    nextInit = {
      ...(init ?? {}),
      headers,
      signal: controller.signal,
      // Always send cookies along with /api/* requests. Same-origin defaults
      // are usually `same-origin` already, but being explicit keeps things
      // working if the API ever lives on a sibling subdomain behind a CDN.
      credentials: init?.credentials ?? "include",
    };
  }

  // Time the call. Reported to fe-rum (which decides whether to emit —
  // fast successes are dropped; slow / failed / aborted ones bubble up
  // to /admin/health). t0 captured per-request so an in-flight stack of
  // /m's 18 preload calls each gets its own measurement.
  const t0 = isApiRequest(url) ? performance.now() : 0;
  let response: Response;
  try {
    response = await originalFetch(input as RequestInfo, nextInit);
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    if (isApiRequest(url)) {
      reportApiCall({
        endpoint: pathOf(url),
        method: methodOf(input, init),
        // 0 = aborted / network-level fail. The dashboard groups these as
        // "didn't return a response" — distinct from 4xx/5xx server errors.
        status: 0,
        duration: performance.now() - t0,
      });
    }
    // Re-throw so callers' .catch() still fires; we only OBSERVE here.
    throw err;
  }
  if (timeoutId) clearTimeout(timeoutId);
  if (isApiRequest(url)) {
    reportApiCall({
      endpoint: pathOf(url),
      method: methodOf(input, init),
      status: aborted ? 0 : response.status,
      duration: performance.now() - t0,
    });
  }

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

  // ---- movementErrors --------------------------------------------------
  // Some writes commit the DOCUMENT and then fail a downstream MOVEMENT: a
  // job card saves but the raw-material consume and its cost-ledger row never
  // happen; a PO saves but the sister company never gets its mirror order.
  // Those cascades must not roll the document back — the cutting physically
  // happened — but they used to be console.error only, so the operator saw a
  // clean success and nobody ever found out. Routes now report them as
  // `movementErrors` on an otherwise-200 body.
  //
  // Handled HERE rather than per call site so every future route that adopts
  // the field is surfaced automatically. The response is cloned — reading the
  // body here must not consume it for the caller.
  if (isApiRequest(url) && response.ok) {
    void (async () => {
      try {
        const ct = response.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) return;
        const body = (await response.clone().json()) as {
          movementErrors?: unknown;
        };
        const errs = Array.isArray(body?.movementErrors)
          ? body.movementErrors.filter((e): e is string => typeof e === "string")
          : [];
        for (const e of errs) window.dispatchEvent(
          new CustomEvent("hookka:movement-error", { detail: e }),
        );
      } catch {
        // A body that isn't readable/parsable is not a movement error.
      }
    })();
  }

  return response;
};
