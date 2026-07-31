import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { ConfirmProvider } from './components/ui/confirm-dialog'
import './index.css'
// Side-effect import: installs the global fetch interceptor that injects the
// Authorization header and handles 401 redirects. Must run before any
// component mounts, so it sits at the top of the entry point.
import './lib/api-client'
// Optional error reporting. No-ops when VITE_SENTRY_DSN is unset, so
// OSS / self-host installs ship zero monitoring bytes. When the DSN is
// present, the actual Sentry SDK is dynamic-imported off the critical path.
// (See src/lib/monitoring.ts — the Sprint 5 facade. Don't add a second
// eager Sentry.init here; it would double-initialise the SDK.)
import { initMonitoring } from './lib/monitoring'
// FE RUM — captures unhandled JS errors + Core Web Vitals + longtasks
// and posts them to /api/fe-rum/event for the /admin/health dashboard.
// Companion to backend observability in src/api/lib/observability.ts.
import { initFeRum } from './lib/fe-rum'
import { purgeServiceWorkerAndCaches } from './lib/stale-chunk-recovery'

initMonitoring()
initFeRum()

// A dynamically imported chunk failed to load — almost always a stale chunk
// hash after a fresh deploy replaced the file the still-open page references
// (e.g. clicking Print/View right after we shipped a new build). Vite fires
// this for EVERY failed import(), including ones a local try/catch swallows —
// so it catches cases the React ErrorBoundary never sees. Hard-reload to pull
// the new build instead of leaving the user with a cryptic
// "Failed to fetch dynamically imported module" toast — or, worse, stranded on
// the boot splash when the failing chunk is one React needs to mount at all
// (the ErrorBoundary never gets a chance to run in that case, so THIS listener
// is the only recovery path).
//
// Recovery budget (shared keys with ErrorBoundary):
//   - hookka-stale-chunk-reloaded-at → timestamp of the last reload
//   - hookka-stale-chunk-attempts    → count, reset to 0 by ErrorBoundary on the
//                                        first successful render
// The previous version used a blunt 30s time cooldown with NO attempt counter.
// That stranded users during CDN edge propagation right after a deploy: the
// first stale chunk recovered, but a SECOND distinct stale chunk (next lazy
// route, or a different edge still serving the old hash map) within 30s was
// silently swallowed → stuck on the splash (observed in QA 2026-08-01). A short
// debounce collapses the burst of preloadError events from a single failed
// render into one reload, while the attempt cap — not a time window — is what
// prevents an infinite loop when a build genuinely 404s every chunk.
const STALE_RELOAD_KEY = 'hookka-stale-chunk-reloaded-at'
const STALE_ATTEMPTS_KEY = 'hookka-stale-chunk-attempts'
const STALE_DEBOUNCE_MS = 3_000
const STALE_MAX_ATTEMPTS = 3
function recoverFromStaleChunk(reason: string) {
  // Hard cap: after N reloads without a successful render, stop and leave the
  // splash/error UI so we never loop forever on a truly broken build. The
  // counter is cleared by ErrorBoundary once React renders, so a recovered app
  // resets to a fresh budget for the next deploy.
  const attempts = Number(sessionStorage.getItem(STALE_ATTEMPTS_KEY) || 0)
  if (attempts >= STALE_MAX_ATTEMPTS) return
  // Short debounce: a single failed render can fire many preloadError events;
  // collapse them into one reload. Successive deploys seconds apart still each
  // recover (that's the whole point — unlike the old 30s gate).
  const lastTs = Number(sessionStorage.getItem(STALE_RELOAD_KEY) || 0)
  if (lastTs && Date.now() - lastTs < STALE_DEBOUNCE_MS) return
  sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()))
  sessionStorage.setItem(STALE_ATTEMPTS_KEY, String(attempts + 1))
  console.warn('[stale-chunk] hard-reloading:', reason)
  void purgeServiceWorkerAndCaches().finally(() => window.location.reload())
}

// (1) Vite's own dynamic-import-failed event — fires for every failed import()
// across the app (lazy route, lazy() chunk, getModule() etc).
window.addEventListener('vite:preloadError', () => {
  recoverFromStaleChunk('vite:preloadError')
})

// (2) A <script> tag that failed to load — covers cases vite:preloadError
// doesn't (e.g. an initial-bundle chunk 404 from a stale index.html, or a
// non-import script tag the bundler emitted). Capture-phase is required —
// 'error' events on <script>/<link>/<img> don't bubble.
window.addEventListener('error', (e) => {
  const t = e.target as HTMLElement | null
  if (!t) return
  // Only act on resource errors for our own JS chunks. Skip random IMG/IFRAME
  // failures (those are content errors, not deploy artefacts).
  let src = ''
  if (t instanceof HTMLScriptElement) src = t.src
  else if (t instanceof HTMLLinkElement) src = t.href
  else return
  if (src.includes('/assets/') && src.includes(location.origin)) {
    recoverFromStaleChunk(`script-error: ${src.split('/').pop()}`)
  }
}, true) // capture = true → catch events on non-bubbling targets

// Per-build id injected by Vite (vite.config.ts `define`). Used to cache-bust
// the service worker registration URL on each deploy.
declare const __BUILD_ID__: string

// PWA Phase 1 — register the minimal service worker (public/sw.js) for
// installability + an offline app-shell. PRODUCTION builds only: a SW in dev
// would cache Vite's HMR modules and break hot reload. The ?v= query is the
// per-build id so the browser re-fetches sw.js on every deploy (the file is
// otherwise byte-identical and would be served from HTTP cache). The SW itself
// is conservative — network-first navigation, never caches /api/*. See sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${__BUILD_ID__}`)
      .catch(() => {
        /* registration failure is non-fatal — the app runs without the SW */
      })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmProvider>
      <RouterProvider router={router} />
    </ConfirmProvider>
  </StrictMode>,
)
