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

// "This month" window for analytics endpoints (matches the dashboard's
// default Command Center period). Computed once per page load.
function thisMonthWindow(): { from: string; to: string } {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const from = `${yyyy}-${mm}-01`;
  const to = `${yyyy}-${mm}-${dd}`;
  return { from, to };
}

function buildEndpoints(): string[] {
  const w = thisMonthWindow();
  return [
    // ---- Home (eager — every visit hits these) ----
    "/api/sales-orders/stats",
    `/api/dashboard/overview?period=${w.from.slice(0, 7)}`,
    "/api/inventory",
    "/api/sales-orders",
    // ---- Module lists (operator hits within first 30s) ----
    "/api/delivery-orders",
    "/api/purchase-orders",
    "/api/invoices",
    "/api/production-orders",
    // ---- Reference data ----
    "/api/customers",
    "/api/suppliers",
    "/api/products",
    "/api/raw-materials",
    // ---- Comms ----
    "/api/announcements",
    "/api/mail-center/threads",
    // ---- HR / employees ----
    "/api/workers",
    "/api/payslips",
    `/api/working-hour-entries/summary?from=${w.from}&to=${w.to}`,
    `/api/department-performance?from=${w.from}&to=${w.to}`,
  ];
}

/**
 * Fire all critical fetches in parallel. Caught errors are silently swallowed
 * — preload is best-effort, never a blocker. Call once at /m shell mount.
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
