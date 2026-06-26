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

// Bump this string on any SW logic change to force a clean cache swap.
// The build id is appended at register time via the ?v= query (see main.tsx),
// but we also key the cache name so old caches are dropped on activate.
const CACHE = 'hookka-shell-v2';

// The minimal app shell to pre-cache so a cold offline open still paints.
// Keep this tiny: just the entry HTML + the manifest + icons. Hashed JS/CSS
// are cached on-demand (runtime), not pre-cached, because their names change
// every build.
const SHELL = ['/worker', '/manifest.webmanifest', '/pwa-icon-192.png'];

self.addEventListener('install', (event) => {
  // Pre-cache the shell, but don't fail the whole install if one URL 404s.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.allSettled(SHELL.map((url) => cache.add(url))),
      )
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
        .catch(() =>
          caches
            .match(req)
            .then((hit) => hit || caches.match('/worker')),
        ),
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
        .catch(() => hit);
      return hit || network;
    }),
  );
});

// Allow the page to tell a waiting SW to activate immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
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
