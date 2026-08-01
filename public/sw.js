/* ============================================================
 * Hookka Worker Portal — minimal PWA service worker (Phase 1)
 *
 * Goal: installability + a tiny offline app-shell fallback. It is
 * deliberately CONSERVATIVE — a service worker that serves stale JS
 * can hard-brick the app, so the rules are:
 *
 *   1. NEVER cache /api/* — always go to the network (live data + auth).
 *   2. Navigations (HTML) = NETWORK-FIRST. We only fall back to a cached
 *      shell when the network is unreachable, so a fresh deploy is picked
 *      up immediately and users never get stranded on an old index.html.
 *   3. Hashed build assets (/assets/*) = cache-first (they are immutable;
 *      Vite fingerprints them, a new deploy emits new filenames). Old
 *      entries are purged on activate by CACHE version, and Vite's own
 *      vite:preloadError handler (src/main.tsx) hard-reloads on a stale
 *      chunk anyway.
 *   4. skipWaiting + clients.claim → a new SW takes over fast; bumping
 *      CACHE on each deploy drops every previous cache so we never serve
 *      a stale asset across versions.
 *
 * Registered from src/main.tsx in PRODUCTION builds only.
 * ============================================================ */

// Cache name is keyed to the PER-BUILD id (the ?v= on the registration URL,
// see main.tsx). Each deploy → a distinct cache → activate drops every prior
// build's shell, so a stale index.html that points at chunk hashes a newer
// deploy already purged can never linger and white-screen an installed PWA
// (2026-06-27). Falls back to a fixed name if the query is somehow absent.
const BUILD_VERSION = (() => {
  try {
    return new URL(self.location.href).searchParams.get('v') || 'v3';
  } catch {
    return 'v3';
  }
})();
const CACHE = `hookka-shell-${BUILD_VERSION}`;

// The minimal app shell to pre-cache so a cold offline open still paints.
// Keep this tiny: just the entry HTML + the manifest + icons. Hashed JS/CSS
// are cached on-demand (runtime), not pre-cached, because their names change
// every build.
const SHELL = ['/worker', '/manifest.webmanifest', '/pwa-icon-192.png'];

// Background pre-cache of all hashed build assets referenced by the
// current /dashboard HTML. Solves the owner-reported case (2026-06-29)
// where react-vendor.js took 38s to download on a flaky factory wifi,
// stranding the user on a blank page until React arrived. With this:
//
//   1. First install (any visit) → fetch /dashboard, parse out every
//      /assets/* link, cache them all in background. Next visit (or
//      navigation to a new route) hits SW cache → 0 ms.
//   2. New deploy → new index hash → SW updates → install re-runs →
//      new chunk URLs precached IN BACKGROUND while the user keeps
//      using the OLD cached version. By the time they reload, the new
//      chunks are already local. No "38s react-vendor" wait.
//
// Safety: per-asset 8s timeout, total cap of 60 assets, allSettled so
// one 404 (e.g. removed chunk between deploys) doesn't fail install.
// Skipped if /dashboard fetch itself fails (offline at install time —
// rare, but we don't want to block the SW activation on it).
async function precacheBuildAssets(cache) {
  try {
    // Respect "Data Saver" mode (Android Chrome / Brave / Edge surface this).
    // Pre-cache would silently burn extra MB on a worker's 4G hotspot data
    // plan; if they explicitly opted into saver mode, skip the background
    // pull and fall back to on-demand caching as the user navigates.
    const conn =
      typeof navigator !== 'undefined' && navigator.connection
        ? navigator.connection
        : null;
    if (conn && conn.saveData === true) return;
    const indexResp = await fetch('/dashboard', { credentials: 'omit' });
    if (!indexResp.ok) return;
    const html = await indexResp.text();
    // Match every /assets/<hash>.(js|css) referenced by <script> / <link> tags.
    // Dedupe with a Set (preload + script tag often point at the same URL).
    const urls = new Set();
    const re = /\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g;
    let m;
    while ((m = re.exec(html)) !== null) urls.add(m[0]);
    const list = [...urls].slice(0, 60);
    if (list.length === 0) return;
    // Four at a time. This used to fire all 60 at once, which is what made
    // every deploy look like an outage: install → skipWaiting → the new SW
    // claims the booting page → the page's own entry chunks queue behind 60
    // parallel downloads and arrive MINUTES late. No error, no failed request,
    // just a splash that hangs until the precache drains and then works. The
    // point of this precache is to be invisible; sixty parallel fetches on
    // factory wifi are the opposite of invisible.
    const PARALLEL = 4;
    const queue = [...list];
    const worker = async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        await Promise.race([
          cache.add(url),
          // Per-asset 8s timeout — a single slow chunk can't hold up the rest.
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('precache-timeout')), 8000),
          ),
        ]).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } catch {
    // /dashboard unreachable at install (offline / DNS hiccup) — skip
    // precache and let the on-demand cache-first rule below populate it
    // when the user actually navigates. Better to install the SW with
    // an empty asset cache than to wedge the whole install loop.
  }
}

self.addEventListener('install', (event) => {
  // Pre-cache the shell, but don't fail the whole install if one URL 404s.
  // Then kick off the build-asset precache (background; we don't await it
  // for install to complete — skipWaiting fires immediately, asset
  // download continues after the SW takes over).
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        await Promise.allSettled(SHELL.map((url) => cache.add(url)));
        // The heavy precache does NOT start here. Install runs while a page is
        // booting, and skipWaiting hands that page to this SW immediately — so
        // anything started here competes with the very chunks the app needs to
        // render. The client asks for it once it has actually painted
        // (main.tsx → postMessage 'PRECACHE_ASSETS').
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop every cache that isn't the current version → no cross-deploy staleness.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET; never touch POST/PUT/etc (mutations must hit the network).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept cross-origin requests (fonts, CDNs) — let the browser do it.
  if (url.origin !== self.location.origin) return;

  // RULE 1: never cache the API — always live network, no fallback.
  if (url.pathname.startsWith('/api/')) return;

  // RULE 2: navigations (page loads) = network-first with shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache a copy of successful navigations so offline reopen works.
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          // The network fetch failed (offline / weak wifi). NEVER resolve
          // respondWith to undefined — that throws "Failed to convert value
          // to 'Response'" and the navigation HARD-FAILS into a dead white
          // screen, the exact weak-wifi symptom we're trying to kill (was a
          // real bug: caches.match('/worker') is undefined when the shell
          // isn't cached yet). Fall back cached-page → cached-shell → a tiny
          // self-reloading placeholder so the page recovers the moment the
          // network returns instead of stranding the user.
          return (
            (await caches.match(req)) ||
            (await caches.match('/worker')) ||
            (await caches.match('/dashboard')) ||
            new Response(
              '<!doctype html><meta charset="utf-8">' +
                '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;' +
                'height:100vh;margin:0;color:#6B5C32;background:#FAF9F7">' +
                '<div style="text-align:center"><p>Reconnecting…</p>' +
                '<script>setTimeout(function(){location.reload()},2000)</script></div></body>',
              { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
            )
          );
        }),
    );
    return;
  }

  // RULE 3: hashed build assets = cache-first (immutable, fingerprinted).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Everything else (icons, manifest, favicon): stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        // Both cache miss + network fail must still yield a Response (never
        // undefined → "Failed to convert value to 'Response'").
        .catch(() => hit || new Response('', { status: 504 }));
      return hit || network;
    }),
  );
});

// Allow the page to tell a waiting SW to activate immediately.
let precacheStarted = false;

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  // Sent by the app once it has rendered and been alive a few seconds. Only
  // then is there spare bandwidth to warm the cache for the NEXT visit.
  if (event.data === 'PRECACHE_ASSETS' && !precacheStarted) {
    precacheStarted = true;
    event.waitUntil(caches.open(CACHE).then((c) => precacheBuildAssets(c)));
  }
});

// ============================================================
// Web Push (additive) — Worker Portal notifications.
//
// The backend (src/api/lib/web-push.ts) sends an aes128gcm-encrypted JSON
// payload: { title, body, url?, icon?, badge?, tag? }. We show a system
// notification on `push`, and on `notificationclick` focus an already-open
// worker tab (or open a new one) at the payload's url. Nothing here touches the
// caching rules above.
// ============================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall back to plain text in the body.
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }
  const title = data.title || 'Hookka';
  const options = {
    body: data.body || '',
    // Icons reuse the PWA install icons (already in public/). badge is the
    // monochrome status-bar glyph; both 404-safe — the OS just omits a missing one.
    icon: data.icon || '/pwa-icon-192.png',
    badge: data.badge || '/pwa-icon-192.png',
    // Coalesce repeat reminders so a worker isn't buried under duplicates.
    tag: data.tag || undefined,
    data: { url: data.url || '/worker' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/worker';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open worker-portal tab if there is one; otherwise
        // open a fresh window at the target URL.
        for (const client of clientList) {
          try {
            const url = new URL(client.url);
            if (url.pathname.startsWith('/worker') && 'focus' in client) {
              return client.focus();
            }
          } catch {
            /* ignore unparseable client URLs */
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
        return undefined;
      }),
  );
});
