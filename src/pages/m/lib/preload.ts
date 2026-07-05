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
    "/api/sales-orders", // Orders-due list + Daily Report chips
    "/api/inventory", // Stock alerts
  ];
}

/**
 * Fire the Home's first-paint fetches in parallel. Caught errors are silently
 * swallowed — preload is best-effort, never a blocker. Call once at /m shell
 * mount. Module lists + reference data are intentionally NOT preloaded: they
 * fetch on demand (list screen visit) or on search-open.
 */
export function preloadMobileCritical(): void {
  for (const url of buildEndpoints()) {
    // Don't await — let them run in parallel in the background while React
    // continues to mount the home screen.
    void cachedFetchJson(url).catch(() => {
      // Silent — a failed preload just leaves that one endpoint to fetch
      // on first navigation; the page still works.
    });
  }
}
