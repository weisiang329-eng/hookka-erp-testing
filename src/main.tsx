import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
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

initMonitoring()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
