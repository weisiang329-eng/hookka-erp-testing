// ============================================================================
// /m preload — warm the localStorage cache for the high-traffic endpoints at
// app boot. After the first /m load (~3-5s for the parallel fetches), every
// subsequent navigation to Sales/Delivery/Procurement/etc lands from cache
// (useCachedJson reseeds from cache instantly, no spinner).
//
// Pattern matches the desktop pages (bom.tsx, inventory/index.tsx) which call
// cachedFetchJson() at mount in Promise.all. Mobile didn't do this — every
// module list waited for its own first fetch, which on a phone with worse
// network was very noticeable.
//
// Cache backing is localStorage (src/lib/cached-fetch.ts) so the warm-up
// PERSISTS across the next reload too — the operator's second visit to /m
// in the same day is fully primed.
// ============================================================================
import { cachedFetchJson } from "@/lib/cached-fetch";

// Endpoints sorted roughly by visit frequency — the most-hit ones go first
// (they win the cache race on slow connections).
const CRITICAL_ENDPOINTS = [
  // Operator's main lists
  "/api/sales-orders",
  "/api/delivery-orders",
  "/api/purchase-orders",
  "/api/invoices",
  "/api/production-orders",
  // Reference data
  "/api/customers",
  "/api/suppliers",
  "/api/products",
  "/api/raw-materials",
  "/api/inventory",
  // Comms
  "/api/announcements",
  "/api/mail-center/threads",
  // HR / planning
  "/api/workers",
  "/api/payslips",
];

/**
 * Fire all critical fetches in parallel. Caught errors are silently swallowed
 * — preload is best-effort, never a blocker. Call once at /m shell mount.
 */
export function preloadMobileCritical(): void {
  for (const url of CRITICAL_ENDPOINTS) {
    // Don't await — let them run in parallel in the background while React
    // continues to mount the home screen.
    void cachedFetchJson(url).catch(() => {
      // Silent — a failed preload just leaves that one endpoint to fetch
      // on first navigation; the page still works.
    });
  }
}
