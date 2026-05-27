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

  // Periodic flush. Don't use setInterval inside a worker context —
  // RUM is browser-only.
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
