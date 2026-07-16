// ---------------------------------------------------------------------------
// prefetch-routes.ts — warm the heavy page chunks while the browser is idle.
//
// Why: every dashboard page is `lazy(() => import(...))`, so the FIRST visit to
// each page downloads + parses its own chunk — that is the "第一次卡，之後才順"
// the owner reported (2026-07-16). The server side is already warmed every 5
// min by warm-lists.yml, so the lag is purely the browser fetching chunks it
// has never seen. Keeping a PC open only warms that one browser's cache; it
// does nothing for anyone else. Prefetching fixes it for every user.
//
// How: re-issue the SAME dynamic import() the lazy() route uses. The module
// graph is keyed by specifier, so this downloads the chunk once and the later
// lazy() resolves from cache — instant. Failures are swallowed: a prefetch is
// an optimisation, never a reason for the app to misbehave.
//
// Discipline: ONE chunk at a time, only while idle, and skipped entirely on a
// metered / slow link — the factory's wifi is weak (see the weak-wifi
// campaign), so we must never race the page the operator is actually waiting
// for.
// ---------------------------------------------------------------------------

/** The pages the office actually lives in, in rough order of use. */
const ROUTES: Array<() => Promise<unknown>> = [
  () => import("../pages/sales"),
  () => import("../pages/delivery"),
  () => import("../pages/production"),
  () => import("../pages/planning"),
  () => import("../pages/inventory"),
  () => import("../pages/invoices"),
  () => import("../pages/customers"),
  () => import("../pages/sales/detail"),
];

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
};

/** True when the link is metered or too slow to spend on speculative work. */
function linkTooWeak(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!conn) return false; // unknown → assume fine
  if (conn.saveData) return true;
  const t = conn.effectiveType ?? "";
  return t === "slow-2g" || t === "2g";
}

function whenIdle(cb: () => void): void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb, { timeout: 4000 });
  else window.setTimeout(cb, 500);
}

let started = false;

/**
 * Kick off idle prefetching of the main page chunks. Safe to call more than
 * once — only the first call does anything.
 */
export function prefetchRoutesWhenIdle(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (linkTooWeak()) return;

  let i = 0;
  const step = () => {
    if (i >= ROUTES.length) return;
    const load = ROUTES[i++];
    // Re-check between chunks: the operator may have moved onto mobile data.
    if (linkTooWeak()) return;
    void load()
      .catch(() => {
        /* a stale/removed chunk must never surface to the user */
      })
      .then(() => whenIdle(step));
  };
  whenIdle(step);
}
