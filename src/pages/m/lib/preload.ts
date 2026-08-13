// ============================================================================
// /m preload — warm the localStorage cache for the FEW endpoints the Home
// screen actually paints on first load, and nothing else.
//
// 2026-07-04 weak-wifi slim (WORK-TRACKER "cure queue"): the old preload fired
// 18 endpoints in parallel at shell mount — including heavy module lists the
// Home never renders (/api/delivery-orders ~652KB, /api/purchase-orders,
// /api/invoices, /api/production-orders, /api/raw-materials,
// /api/mail-center/threads, /api/payslips, …). Measured cost: /m home = 4.3MB
// across ~20 calls. On a factory phone with weak wifi those 18 parallel
// requests SATURATE the link and STARVE the handful the Home genuinely needs,
// so the dashboard paints slower, not faster. That is the opposite of what a
// preload is for.
//
// Slim rule — preload ONLY the Home's own first-paint endpoints (the cheap KPI
// rail + Stock alerts + Orders-due). Everything else now loads ON DEMAND:
//   • Module lists (Sales / Delivery / Procurement / …) — each
//     ModuleListScreen fetches its own source via useCachedJson on VISIT.
//   • Global Search — GlobalSearchSheet already warms every module endpoint
//     itself when the sheet OPENS (ALL_SOURCE_URLS), so search is unaffected.
// Both paths are cache-backed + deduped, so the first real interaction warms
// them; the persistent localStorage cache still primes the operator's next
// visit. Net: far less contention at boot, faster dashboard on weak wifi, zero
// feature loss.
//
// Cache backing is localStorage (src/lib/cached-fetch.ts) so the warm-up
// PERSISTS across the next reload too.
// ============================================================================
import { cachedFetchJson } from "@/lib/cached-fetch";

/** How many Orders-due cards the /m Home renders (sent to the server as ?top=). */
export const ORDERS_DUE_TOP = 6;

/**
 * The Orders-due URL — exported and imported by Home.tsx rather than written
 * out twice. The localStorage cache (src/lib/cached-fetch.ts) is keyed by URL,
 * so a preload that warms a DIFFERENT string from the one the screen requests
 * is a silent double fetch. One constant makes that impossible.
 */
export const ORDERS_DUE_URL = `/api/sales-orders?fields=orders-due&top=${ORDERS_DUE_TOP}`;

function buildEndpoints(): string[] {
  // Current "YYYY-MM" — the Home's default Command Center period.
  const ym = new Date().toISOString().slice(0, 7);
  return [
    // ---- Home first paint ONLY — the cheap cards the dashboard renders
    // immediately (the heavy Pending-Delivery / analytics fetches are already
    // idle-gated inside Home.tsx behind `pdEnabled`, so we deliberately do NOT
    // preload them here either). ----
    "/api/sales-orders/stats", // Outstanding KPI + Order Pipeline
    `/api/dashboard/overview?period=${ym}`, // Sales / Invoices KPIs + analytics
    // Orders-due card ONLY — six rows, seven fields. It used to be the BARE
    // "/api/sales-orders" (2.16 MB decoded / 1,342 rows on prod), and the
    // "+ Daily Report chips" half of that old comment was already stale: the
    // chips read /api/reports/compliance.json (owner tally audit 2026-07-11).
    ORDERS_DUE_URL,
    "/api/inventory", // Stock alerts
  ];
}

/** True only on the Home route (basename is /m, Home = the index "/"). */
function isHomeLanding(): boolean {
  // pathname is "/m" or "/m/" on Home; "/m/production", "/m/sales", … elsewhere.
  const p = (globalThis.location?.pathname || "").replace(/\/+$/, "");
  return p === "/m" || p === "";
}

/**
 * Warm the Home's first-paint endpoints — but ONLY when the operator actually
 * LANDED on Home. On any other landing this is pure waste.
 *
 * Why route-gate (2026-07-14 mobile-lag fix): the shell mounts this once for the
 * WHOLE /m session, regardless of landing route. A factory worker who opens
 * straight to /m/production doesn't need Home's cards — yet the eager warm-up
 * fired /api/dashboard/overview (a ~7.6s compute-bound query), the full
 * /api/sales-orders (~100KB) and /api/inventory (~95KB) in parallel, saturating
 * the phone's link and starving the production board's own fetch. Home fetches
 * these itself via useCachedJson (and every other screen fetches its own), so
 * the only value of this warm-up is the Home-landing case — where it coalesces
 * with Home's own fetch via cachedFetchJson's in-flight dedup. Gating on the
 * landing route removes the contention on every non-Home screen with zero loss:
 * navigating TO Home later still triggers Home's own cache-backed fetch.
 * (Idle-gating was tried first and doesn't help — the main thread goes idle
 * within a frame of mount, so the deferred fetches still race the board.)
 */
export function preloadMobileCritical(): void {
  if (!isHomeLanding()) return;
  for (const url of buildEndpoints()) {
    // Best-effort background warm-up; a failed one just falls back to an
    // on-demand fetch on first navigation.
    void cachedFetchJson(url).catch(() => {});
  }
}
