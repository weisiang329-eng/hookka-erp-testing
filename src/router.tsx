import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import DashboardLayout from './layouts/DashboardLayout'
import PortalLayout from './layouts/PortalLayout'
import WorkerLayout from './layouts/WorkerLayout'
import { ErrorFallback } from './components/ui/error-boundary'
import { DASHBOARD_ROUTES } from './dashboard-routes'
import RequireAuth from './components/RequireAuth'

// ── Standalone / non-dashboard lazy pages ─────────────────────────────────

// Public tracking (standalone, no auth)
const Track = lazy(() => import('./pages/track'))

// Portal
const Portal = lazy(() => import('./pages/portal'))
const PortalOrders = lazy(() => import('./pages/portal/orders'))
const PortalOrderDetail = lazy(() => import('./pages/portal/order-detail'))
const PortalDeliveries = lazy(() => import('./pages/portal/deliveries'))
const PortalAccount = lazy(() => import('./pages/portal/account'))

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

function S({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>
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
  // the one `TabbedOutlet` inside DashboardLayout; the children list here
  // exists so createBrowserRouter routes each URL to the dashboard shell.
  {
    element: (
      <RequireAuth>
        <DashboardLayout />
      </RequireAuth>
    ),
    errorElement: <ErrorFallback error={null} />,
    children: DASHBOARD_ROUTES,
  },

  // Portal layout — also gated behind RequireAuth (same hookka_auth token).
  {
    element: (
      <RequireAuth>
        <PortalLayout />
      </RequireAuth>
    ),
    errorElement: <ErrorFallback error={null} />,
    children: [
      { path: '/portal', element: <S><Portal /></S> },
      { path: '/portal/orders', element: <S><PortalOrders /></S> },
      { path: '/portal/orders/:id', element: <S><PortalOrderDetail /></S> },
      { path: '/portal/deliveries', element: <S><PortalDeliveries /></S> },
      { path: '/portal/account', element: <S><PortalAccount /></S> },
    ],
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
