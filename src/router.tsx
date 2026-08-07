import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import DashboardLayout from './layouts/DashboardLayout'
import WorkerLayout from './layouts/WorkerLayout'
import { ErrorBoundary, ErrorFallback } from './components/ui/error-boundary'
import RequireAuth from './components/RequireAuth'
import { PageSkeleton } from './components/ui/skeleton'

// ── Standalone / non-dashboard lazy pages ─────────────────────────────────

// Public tracking (standalone, no auth)
const Track = lazy(() => import('./pages/track'))

// Public QR dispatch/deliver page (standalone, no auth — the unguessable
// token in /d/:token is the credential; see routes/public-do-qr.ts)
const DoScan = lazy(() => import('./pages/do-scan'))

// Public rack stock-in page (standalone, no auth — the rack id in /r/:rackId
// is the entry point; staff scan a rack QR then scan items into it. Backend
// /api/public/rack-qr only performs the forward stock-in. See routes/public-rack-qr.ts)
const RackScan = lazy(() => import('./pages/rack-scan'))

// Public packing-sticker → rack assignment page (standalone, no auth — the
// unguessable 64-hex token in /p/:token is the credential; a storekeeper scans
// the Packing sticker QR and sets the rack for THAT piece. Backend
// /api/public/rack-write only sets/clears that one card's rack. See
// routes/public-rack-write.ts)
const StickerRack = lazy(() => import('./pages/sticker-rack'))

// Public customer satisfaction survey page (standalone, no auth — the
// unguessable 64-hex token in /s/:token is the credential; the office sends a
// customer the link and the customer rates five questions on their own phone.
// Backend /api/public/survey serves the questions + named 1-5 scale and takes
// exactly one reply per link. See routes/public-kpi-survey.ts)
const CustomerSurvey = lazy(() => import('./pages/survey'))

// Auth
const Login = lazy(() => import('./pages/login'))
const InviteAccept = lazy(() => import('./pages/InviteAccept'))
// Self-service password reset (2026-05-27). Both pages are public — they
// run before the user has any session. The token in the URL is the only
// credential needed for /reset-password.
const ForgotPassword = lazy(() => import('./pages/forgot-password'))
const ResetPassword = lazy(() => import('./pages/reset-password'))

// Mobile (phone) app — NEW additive UI shell mounted at /m. Reuses the SAME
// cookie session as the dashboard (gated by RequireAuth below); renders its own
// phone shell + nested routes. Does not touch the desktop dashboard routes.
const MobileLayout = lazy(() => import('./pages/m/MobileLayout'))

// Worker Portal (mobile, shop floor — uses its own PIN token, not hookka_auth)
const WorkerLogin = lazy(() => import('./pages/worker/login'))
const WorkerHome = lazy(() => import('./pages/worker'))
const WorkerScan = lazy(() => import('./pages/worker/scan'))
const WorkerIssue = lazy(() => import('./pages/worker/issue'))
const WorkerQc = lazy(() => import('./pages/worker/qc'))
const WorkerPay = lazy(() => import('./pages/worker/pay'))
const WorkerMe = lazy(() => import('./pages/worker/me'))
const WorkerTeam = lazy(() => import('./pages/worker/team'))

// ── Loading fallback ──────────────────────────────────────────────────────
// Layout-shaped skeleton shown while a lazy route chunk downloads — matches
// the loading UX used by the dashboard route table. The visually-hidden
// "Loading..." span keeps the state announced to screen readers.

function PageLoading() {
  return (
    <>
      <span className="sr-only" role="status">Loading...</span>
      <PageSkeleton />
    </>
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
  // Self-service password reset — PUBLIC (no session required, token is in URL)
  { path: '/forgot-password', element: <S><ForgotPassword /></S> },
  { path: '/reset-password', element: <S><ResetPassword /></S> },

  // Invite acceptance (standalone, no auth — the token IS the credential)
  { path: '/invite/:token', element: <S><InviteAccept /></S> },

  // Public FG unit tracking (standalone, no auth, mobile-friendly)
  { path: '/track', element: <S><Track /></S> },

  // Public DO/PL QR scan page (standalone, no auth, mobile-friendly —
  // drivers mark Dispatched/Delivered here; token is the credential)
  { path: '/d/:token', element: <S><DoScan /></S> },

  // Public rack stock-in page (standalone, no auth, mobile-friendly — staff
  // scan a physical rack's QR to open /r/:rackId, then scan items into it)
  { path: '/r/:rackId', element: <S><RackScan /></S> },

  // Public packing-sticker rack-assignment page (standalone, no auth,
  // mobile-friendly — a storekeeper scans a Packing sticker's QR to open
  // /p/:token and set the rack for THAT piece; the token is the credential)
  { path: '/p/:token', element: <S><StickerRack /></S> },

  // Public customer satisfaction survey (standalone, no auth, mobile-first —
  // a customer opens /s/:token from the link the office sent, rates the five
  // questions once, and sees a thank-you; the token is the credential and is
  // single-use)
  { path: '/s/:token', element: <S><CustomerSurvey /></S> },

  // Mobile (phone) app — additive shell at /m/*. Gated by the SAME RequireAuth
  // cookie session as the dashboard. MobileLayout renders its own nested
  // <Routes>, so a single splat child is used here (same pattern as the
  // dashboard route below). The "/m" base is more specific than the dashboard
  // catch-all, so React Router matches it first.
  {
    path: '/m',
    element: (
      <RequireAuth>
        <S><MobileLayout /></S>
      </RequireAuth>
    ),
    errorElement: <ErrorFallback error={null} />,
    children: [{ path: '*', element: null }],
  },

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
      { path: '/worker/qc', element: <S><WorkerQc /></S> },
      { path: '/worker/pay', element: <S><WorkerPay /></S> },
      { path: '/worker/me', element: <S><WorkerMe /></S> },
      { path: '/worker/team', element: <S><WorkerTeam /></S> },
    ],
  },
])
