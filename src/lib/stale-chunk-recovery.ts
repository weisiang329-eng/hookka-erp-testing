// Stale-chunk recovery — nuke the service worker + all Cache Storage so a forced
// reload re-fetches everything fresh from the network.
//
// Why: when a stale-chunk / failed dynamic import is detected, the code running
// in the tab no longer matches what the service worker / HTTP cache is serving.
// A plain reload can just re-serve the SAME stale app shell (a cached index.html
// pointing at chunk hashes that were purged by a newer deploy) → the app paints
// WHITE and never recovers. This bit an installed PWA after several rapid
// redeploys on 2026-06-27. Unregistering the SW and clearing Cache Storage first
// guarantees the next load comes straight from the network with the current
// build, then the app re-registers a fresh SW on boot. Best-effort throughout —
// any failure still falls through to the caller's reload.
export async function purgeServiceWorkerAndCaches(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* best-effort — fall through to the reload */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best-effort — fall through to the reload */
  }
}
