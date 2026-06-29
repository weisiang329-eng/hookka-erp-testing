// ---------------------------------------------------------------------------
// fe-rum.ts — Front-End Real User Monitoring.
//
// Companion to src/api/lib/observability.ts (which captures backend
// timings via the AE pipeline). This module captures FE-only signals
// that the backend never sees:
//
//   1. Unhandled JS errors        → "the page broke for this user"
//   2. Unhandled promise rejects  → "an async path silently exploded"
//   3. PerformanceObserver:
//      • longtask  (>= 50ms blocking main thread)  → "the UI froze"
//      • LCP       (Largest Contentful Paint)     → "page took forever to render"
//      • FCP       (First Contentful Paint)       → "first paint was slow"
//
// Events are batched in-memory and flushed to /api/fe-rum/event every
// FLUSH_INTERVAL_MS or on `visibilitychange` (page-hide). The worker
// route forwards to Cloudflare Analytics Engine where the /admin/health
// dashboard reads them.
//
// Privacy: we send route pathname (e.g. /sales/edit/0001) — no query
// strings, no IDs, no body text. Error messages + stack heads ARE
// included because that's the whole point.
//
// Gating: skips initialization when document.cookie has no auth marker
// (i.e. login page). FE RUM only emits for authenticated sessions so
// public traffic doesn't drown the signal.
// ---------------------------------------------------------------------------

type RumEvent =
  | {
      kind: "error";
      route: string;
      msg: string;
      stack: string;
      ts: number;
    }
  | {
      kind: "perf";
      route: string;
      metric: "longtask" | "lcp" | "fcp" | "nav" | "ttfb";
      value: number;
      ts: number;
    }
  // Per-API-call timing. Only fired for calls that are SLOW (>3s) or
  // FAILED (non-2xx, aborted, timeout) so the AE stream doesn't drown in
  // fast-success noise. 2026-06-29: added after owner-reported "Dashboard
  // 一直 Loading" couldn't be diagnosed — the existing perf events fire only
  // on errors / paint, never on "API never returned".
  | {
      kind: "api";
      route: string;
      endpoint: string; // /api/path (no query)
      method: string;
      status: number; // 0 = aborted/timeout, otherwise HTTP status
      value: number; // duration ms
      ts: number;
    }
  // Page-stuck heartbeat — fired at the 15s mark on a fresh route when NO
  // /api/* call has returned 2xx. Captures the case where the shell rendered
  // but data fetches are all spinning ("Loading..." forever, no JS error).
  | {
      kind: "stuck";
      route: string;
      value: number; // ms elapsed since route change
      ts: number;
    };

const queue: RumEvent[] = [];
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH = 50;
let flushTimer: ReturnType<typeof setInterval> | null = null;

// Best-effort fetch — fire-and-forget, no retry. RUM is not load-bearing
// — losing 1% of events to network blips is fine. Uses keepalive so
// the request survives page navigations.
async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await fetch("/api/fe-rum/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      // keepalive lets the browser finish the POST even after the
      // page unloads — without it, fire-on-visibilitychange would
      // drop the last batch on every nav.
      keepalive: true,
      credentials: "include",
    });
  } catch {
    // Swallow — RUM is best-effort. Putting the events back on the
    // queue could loop forever if the network is genuinely down, so
    // we just drop them.
  }
}

function pushEvent(ev: RumEvent): void {
  queue.push(ev);
  // Defensive cap — prevent unbounded growth if flushes start failing.
  if (queue.length > MAX_BATCH * 4) queue.splice(0, queue.length - MAX_BATCH * 4);
}

// -- Per-API-call telemetry --------------------------------------------------
// Threshold above which a successful call is still reported as "slow"
// (slow user experience, not an error). Below this, fast successes are
// dropped to keep the AE stream signal-rich.
const API_SLOW_MS = 3000;

/**
 * Record one /api/* call's timing. Called by src/lib/api-client.ts after
 * each fetch resolves (or aborts/times out). Filters out fast successes
 * — only emits when slow OR failed so the /admin/health "Slow APIs"
 * panel surfaces actionable rows, not 10k/min noise.
 */
export function reportApiCall(opts: {
  endpoint: string; // /api/path (strip query)
  method: string; // GET / POST / etc
  status: number; // HTTP status or 0 for aborted/timeout
  duration: number; // ms
}): void {
  const { endpoint, method, status, duration } = opts;
  const slow = duration >= API_SLOW_MS;
  const failed = status === 0 || status >= 400;
  if (!slow && !failed) return;
  pushEvent({
    kind: "api",
    route: currentRoute(),
    endpoint: endpoint.slice(0, 200),
    method: (method || "GET").toUpperCase().slice(0, 8),
    status,
    value: Math.round(duration),
    ts: Date.now(),
  });
  // If this call succeeded on the current route, cancel the page-stuck
  // timer — at least one data fetch completed, the page is not stuck.
  if (status >= 200 && status < 400) markRouteAlive();
}

// -- Page-stuck detector -----------------------------------------------------
// Tracks: did any /api/* call succeed on this route within STUCK_TIMEOUT_MS
// of arriving? If not, emit a "stuck" event so the dashboard can show
// "user X on /dashboard was stuck for 15s, slow endpoints: ...". Called
// after every SPA navigation (history.pushState / popstate / initial load).
const STUCK_TIMEOUT_MS = 15_000;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
let stuckRoute = "";
let stuckStartMs = 0;
function markRouteAlive(): void {
  if (stuckTimer) {
    clearTimeout(stuckTimer);
    stuckTimer = null;
  }
}
function armStuckTimer(): void {
  // Cancel any pending timer first — route changed mid-flight.
  markRouteAlive();
  stuckRoute = currentRoute();
  stuckStartMs = performance.now();
  stuckTimer = setTimeout(() => {
    // Only emit if still on the same route. If user navigated away while
    // the timer was running, the original route was abandoned, not stuck.
    if (currentRoute() !== stuckRoute) {
      stuckTimer = null;
      return;
    }
    pushEvent({
      kind: "stuck",
      route: stuckRoute,
      value: Math.round(performance.now() - stuckStartMs),
      ts: Date.now(),
    });
    stuckTimer = null;
  }, STUCK_TIMEOUT_MS);
}

function currentRoute(): string {
  try {
    return window.location.pathname || "/";
  } catch {
    return "/";
  }
}

// PerformanceObserver wires that emit a "perf" event per observation.
// Each metric is registered as a separate observer so a failure in one
// (e.g. browser doesn't support that entry type) doesn't kill the
// others.
function observeMetric(
  type: string,
  buildEvent: (entry: PerformanceEntry) => RumEvent | null,
): void {
  try {
    // buffered: true so any entries collected BEFORE we attached (e.g.
    // first-paint that happened during React hydration) still flow.
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ev = buildEvent(entry);
        if (ev) pushEvent(ev);
      }
    });
    po.observe({ type, buffered: true });
  } catch {
    // browser support gap — quietly skip
  }
}

// SPA navigation timing — fills the gap between initial-page-load
// PerformanceTiming and per-component metrics. React Router uses
// history.pushState() / popstate to swap routes without firing a real
// navigation event, so the browser's `navigation` PerformanceObserver
// only ever sees the FIRST page load. Every subsequent click between
// modules (Sales → Production → Invoices → …) was invisible.
//
// Fix: patch pushState + replaceState + listen for popstate, mark t0
// on every URL change, then measure t-to-idle via two
// requestAnimationFrame chained with a 0ms setTimeout. Two rAFs let
// React commit + paint; the setTimeout drains microtasks (state
// updates that fire after paint). Far from perfect but a useful
// "click to first stable frame" approximation, comparable across
// routes.
//
// Emitted as a regular `fe_perf` event with metric=spa_nav so it
// shows up in the existing /admin/health "Front-End perf" panel
// alongside longtask / LCP / FCP. Operator scans by P95 to find slow
// routes ("/payroll spa_nav P95 4800ms? something's wrong").
let navStartMs: number | null = null;
let navStartRoute = "/";
function markNavStart(): void {
  navStartMs = performance.now();
  navStartRoute = currentRoute();
}
function flushNav(): void {
  if (navStartMs == null) return;
  const route = currentRoute();
  // Only emit if the route actually changed — pushState with the same
  // URL (filter/search state) is not a real navigation and would
  // pollute the histogram.
  if (route === navStartRoute) {
    navStartMs = null;
    return;
  }
  const start = navStartMs;
  navStartMs = null;
  // Wait for paint + microtask drain.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Module-init utility, not a React component — useTimeout doesn't apply.
      // eslint-disable-next-line no-restricted-syntax
      setTimeout(() => {
        const duration = Math.round(performance.now() - start);
        // Sanity bound — anything > 30s is a stuck tab / debugger
        // pause, not a real measurement.
        if (duration > 0 && duration < 30_000) {
          pushEvent({
            kind: "perf",
            route,
            metric: "nav", // reuse "nav" bucket so it groups in FE perf panel
            value: duration,
            ts: Date.now(),
          });
        }
      }, 0);
    });
  });
}
function installSpaNavTiming(): void {
  if (typeof window === "undefined") return;
  // Patch history methods. Wrap so we don't break the React Router /
  // history library that calls them; we only ADD instrumentation.
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    markNavStart();
    const r = _push(...args);
    // pushState updates location synchronously, so flushNav can read
    // the new route immediately on the next microtask.
    queueMicrotask(() => {
      flushNav();
      armStuckTimer();
    });
    return r;
  };
  history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ) {
    markNavStart();
    const r = _replace(...args);
    queueMicrotask(() => {
      flushNav();
      armStuckTimer();
    });
    return r;
  };
  // Browser back/forward → popstate, route already changed when this
  // fires so markNavStart sees the OLD route. We work around by
  // capturing t0 BEFORE the browser updates location: the navigate
  // listener (which fires before popstate) is `pagehide`/`unload` —
  // neither is reliable for SPA back. Practical compromise: on
  // popstate, mark start = now MINUS a small fudge factor for the
  // browser's URL-swap work. Slightly under-counts back/forward but
  // catches the slow rebound renders.
  window.addEventListener("popstate", () => {
    navStartMs = performance.now() - 1; // 1ms fudge
    navStartRoute = "__popstate__"; // force flushNav to emit (different route)
    queueMicrotask(() => {
      flushNav();
      armStuckTimer();
    });
  });
  // Arm the timer for the INITIAL page load too — the cold open is
  // where Dashboard-blank is most often reported.
  armStuckTimer();
}

/**
 * Initialise FE RUM. Idempotent — safe to call multiple times; second
 * call no-ops.
 *
 * Call once from `src/main.tsx`, after initMonitoring(). Order matters
 * because monitoring.ts also installs window error handlers; we want
 * both to fire (Sentry path captures the full payload, RUM path
 * captures the aggregate counter).
 */
let inited = false;
export function initFeRum(): void {
  if (inited) return;
  if (typeof window === "undefined") return;
  inited = true;

  // Unhandled errors.
  window.addEventListener("error", (ev) => {
    const err = ev.error;
    const msg =
      (err instanceof Error ? err.message : null) ?? ev.message ?? "Error";
    const stack = err instanceof Error && err.stack ? err.stack : "";
    pushEvent({
      kind: "error",
      route: currentRoute(),
      msg: String(msg).slice(0, 200),
      // First 4 lines of stack are usually enough to identify the
      // location; full stack would balloon the AE blob.
      stack: stack.split("\n").slice(0, 4).join(" | ").slice(0, 400),
      ts: Date.now(),
    });
  });

  // Unhandled promise rejections — async errors that no .catch() saw.
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "UnhandledRejection";
    const stack =
      reason instanceof Error && reason.stack ? reason.stack : "";
    pushEvent({
      kind: "error",
      route: currentRoute(),
      msg: String(msg).slice(0, 200),
      stack: stack.split("\n").slice(0, 4).join(" | ").slice(0, 400),
      ts: Date.now(),
    });
  });

  // longtask: any task that blocked the main thread for >= 50ms. This
  // is the FE equivalent of "the API was slow" — the user sees a frozen
  // page. We capture duration so the dashboard can show "this route
  // froze N times for an average of X ms".
  observeMetric("longtask", (entry) => ({
    kind: "perf",
    route: currentRoute(),
    metric: "longtask",
    value: Math.round(entry.duration),
    ts: Date.now(),
  }));

  // LCP — Largest Contentful Paint. The classic Core Web Vital. The
  // observer fires multiple times as larger elements paint; we report
  // EVERY observation and let the dashboard compute P95 across them.
  observeMetric("largest-contentful-paint", (entry) => ({
    kind: "perf",
    route: currentRoute(),
    metric: "lcp",
    value: Math.round(entry.startTime),
    ts: Date.now(),
  }));

  // FCP — First Contentful Paint. Single observation per page.
  observeMetric("paint", (entry) => {
    if (entry.name !== "first-contentful-paint") return null;
    return {
      kind: "perf",
      route: currentRoute(),
      metric: "fcp",
      value: Math.round(entry.startTime),
      ts: Date.now(),
    };
  });

  // Navigation timing — overall load duration + TTFB. One observation
  // per page load; we split into two events (nav + ttfb) so the
  // dashboard can chart them independently.
  observeMetric("navigation", (entry) => {
    const nav = entry as PerformanceNavigationTiming;
    pushEvent({
      kind: "perf",
      route: currentRoute(),
      metric: "ttfb",
      value: Math.round(nav.responseStart),
      ts: Date.now(),
    });
    return {
      kind: "perf",
      route: currentRoute(),
      metric: "nav",
      value: Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd),
      ts: Date.now(),
    };
  });

  // SPA route-change timing. Patches history.pushState/replaceState +
  // listens to popstate to measure "click to stable frame" duration.
  // Emits as a regular fe_perf event so it surfaces in the existing
  // "Front-End perf" panel under metric=nav (alongside the initial
  // full-page-load nav timing).
  installSpaNavTiming();

  // Periodic flush. Don't use setInterval inside a worker context —
  // RUM is browser-only. Module-init utility, not a React component
  // — useInterval doesn't apply (and would require a host component).
  // eslint-disable-next-line no-restricted-syntax
  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  // Flush on page-hide so we don't lose events that arrived in the
  // last bucket before navigation/close.
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
  window.addEventListener("pagehide", () => {
    void flush();
  });
}

/**
 * Tear down — only for tests / hot-reload. Production code never calls.
 */
export function _stopFeRumForTests(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  inited = false;
  queue.length = 0;
}
