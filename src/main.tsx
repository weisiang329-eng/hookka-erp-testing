import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { router } from './router'
import './index.css'
// Side-effect import: installs the global fetch interceptor that injects the
// Authorization header and handles 401 redirects. Must run before any
// component mounts, so it sits at the top of the entry point.
import './lib/api-client'

// ---------------------------------------------------------------------------
// Sentry — frontend error monitoring.
// ---------------------------------------------------------------------------
// DSN is a build-time env var so the bundle can ship to a CDN without the
// runtime Cloudflare Pages process having to inject it. Empty DSN disables
// Sentry (used in `npm run dev` and `wrangler pages dev` unless the operator
// exports VITE_SENTRY_DSN locally).
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    // Lean default — error capture only. Tracing / replay can be enabled
    // later once we know the volume + cost picture.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Don't send default PII (IP, cookies, auth headers). The Hookka data
    // is multi-tenant and we don't want operator IPs leaking into Sentry's
    // US region.
    sendDefaultPii: false,
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
