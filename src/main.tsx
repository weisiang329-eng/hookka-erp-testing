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

initMonitoring()
initFeRum()

// A dynamically imported chunk failed to load — almost always a stale chunk
// hash after a fresh deploy replaced the file the still-open page references
// (e.g. clicking Print/View right after we shipped a new build). Vite fires
// this for EVERY failed import(), including ones a local try/catch swallows —
// so it catches cases the React ErrorBoundary never sees. Hard-reload once to
// pull the new build instead of leaving the user with a cryptic
// "Failed to fetch dynamically imported module" toast. 30s cooldown (shared
// key with ErrorBoundary) prevents reload loops.
window.addEventListener('vite:preloadError', () => {
  const KEY = 'hookka-stale-chunk-reloaded-at'
  const lastTs = Number(sessionStorage.getItem(KEY) || 0)
  if (Date.now() - lastTs < 30_000) return
  sessionStorage.setItem(KEY, String(Date.now()))
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmProvider>
      <RouterProvider router={router} />
    </ConfirmProvider>
  </StrictMode>,
)
