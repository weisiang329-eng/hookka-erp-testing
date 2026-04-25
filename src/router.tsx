import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import DashboardLayout from './layouts/DashboardLayout'
import WorkerLayout from './layouts/WorkerLayout'
import { ErrorBoundary, ErrorFallback } from './components/ui/error-boundary'
import RequireAuth from './components/RequireAuth'

// ── Standalone / non-dashboard lazy pages ─────────────────────────────────

// Public tracking (standalone, no auth)
const Track = lazy(() => import('./pages/track'))

// Auth
const Login = lazy(() => import('./pages/login'))
const InviteAccept = lazy(() => import('./pages/InviteAccept'))

// Worker Portal (mobile, shop floor — uses its own PIN token, not hookka_auth)
const WorkerLogin = lazy(() => import('./pages/worker/login'))
const WorkerHome = lazy(() => import('./pages/worker'))
const WorkerScan = lazy(() => import('./pages/worker/scan'))
const WorkerIssue = lazy(() => import('./pages/worker/issue'))
const WorkerPay = lazy(() => import('./pages/worker/pay'))
const WorkerMe = lazy(() => import('./pages/worker/me'))

// ── Loading fallback ──────────────────────────────────────────────────────

function PageLoading() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="animate-pulse text-sm text-[#5A5550]">Loading...</div>
    </div>
  )
}

// S() = Suspense + per-page ErrorBoundary. A crash in one page only blanks
// that route; login / worker portal / other tabs stay functional.
function S({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

// ── Router ────────────────────────────────────────────────────────────────

export const router = createBrowserRouter([
  // Root redirect
  { path: '/', element: <Navigate to="/dashboard" replace /> },

  // Auth (standalone, no layout — PUBLIC)
  { path: '/login', element: <S><Login /></S> },

  // Invite acceptance (standalone, no auth — the token IS the credential)
  { path: '/invite/:token', element: <S><InviteAccept /></S> },

  // Public FG unit tracking (standalone, no auth, mobile-friendly)
  { path: '/track', element: <S><Track /></S> },

  // Dashboard layout — gated behind RequireAuth. All dashboard routes share
  // the one `TabbedOutlet` inside DashboardLayout, which renders its own
  // <Routes> with the full DASHBOARD_ROUTES list. We use a single splat
  // child route here so:
  //   1. Every URL not handled by the standalone routes above mounts
  //      DashboardLayout (preserves bookmarks, refresh, browser back/forward).
  //   2. The parent route ends in `*`, which silences React Router v7's
  //      "<Routes> rendered under a parent route with no trailing *" warning
  //      that fires because TabbedOutlet renders nested <Routes> internally.
  // The element is intentionally null — TabbedOutlet does the per-URL match.
  {
    element: (
      <RequireAuth>
        <DashboardLayout />
      </RequireAuth>
    ),
    errorElement: <ErrorFallback error={null} />,
    children: [{ path: '*', element: null }],
  },

  // Worker portal (mobile PIN auth — intentionally NOT behind RequireAuth;
  // uses its own /api/worker-auth token flow).
  {
    element: <WorkerLayout />,
    errorElement: <ErrorFallback error={null} />,
    children: [
      { path: '/worker', element: <S><WorkerHome /></S> },
      { path: '/worker/login', element: <S><WorkerLogin /></S> },
      { path: '/worker/scan', element: <S><WorkerScan /></S> },
      { path: '/worker/issue', element: <S><WorkerIssue /></S> },
      { path: '/worker/pay', element: <S><WorkerPay /></S> },
      { path: '/worker/me', element: <S><WorkerMe /></S> },
    ],
  },
])
