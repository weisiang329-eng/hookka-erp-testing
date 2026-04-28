// ---------------------------------------------------------------------------
// Dashboard route definitions — single source of truth shared between:
//   • src/router.tsx         → createBrowserRouter (top-level URL ↔ layout)
//   • TabbedOutlet           → keep-alive rendering of every open tab
//
// Each entry is also reused to build the <Route> JSX list that
// <Routes location={path}> consumes inside TabbedOutlet.
// ---------------------------------------------------------------------------
import { lazy, Suspense } from 'react'
import { Navigate, Route, type RouteObject } from 'react-router-dom'
import { ErrorBoundary } from './components/ui/error-boundary'
import RequirePermission from './components/auth/RequirePermission'
import RequireRole from './components/auth/RequireRole'

// ── Lazy-loaded pages ─────────────────────────────────────────────────────

// Dashboard
const Dashboard = lazy(() => import('./pages/dashboard'))

// Sales
const Sales = lazy(() => import('./pages/sales'))
const SalesCreate = lazy(() => import('./pages/sales/create'))
const SalesDetail = lazy(() => import('./pages/sales/detail'))
const SalesEdit = lazy(() => import('./pages/sales/edit'))

// Production
// The split-by-dept refactor introduced overview.tsx (/production) and
// dept.tsx (/production/:deptCode) as thin wrappers over the main
// ProductionPage component. Importing ./pages/production (the index) is
// still kept so any legacy direct consumer keeps working, but the active
// routes below point at the new wrappers.
const ProductionOverview = lazy(() => import('./pages/production/overview'))
const ProductionDeptPage = lazy(() => import('./pages/production/dept'))
const DepartmentDetail = lazy(() => import('./pages/production/department'))
const ProductionScan = lazy(() => import('./pages/production/scan'))
const FGScan = lazy(() => import('./pages/production/fg-scan'))

// Delivery
const Delivery = lazy(() => import('./pages/delivery'))
const DeliveryDetail = lazy(() => import('./pages/delivery/detail'))

// Invoices
const Invoices = lazy(() => import('./pages/invoices'))
const InvoiceDetail = lazy(() => import('./pages/invoices/detail'))
const Payments = lazy(() => import('./pages/invoices/payments'))
const CreditNotes = lazy(() => import('./pages/invoices/credit-notes'))
const DebitNotes = lazy(() => import('./pages/invoices/debit-notes'))
const EInvoice = lazy(() => import('./pages/invoices/e-invoice'))

// Procurement
const Procurement = lazy(() => import('./pages/procurement'))
const ProcurementDetail = lazy(() => import('./pages/procurement/detail'))
const GRN = lazy(() => import('./pages/procurement/grn'))
const InTransit = lazy(() => import('./pages/procurement/in-transit'))
const ProcurementMaintenance = lazy(() => import('./pages/procurement/maintenance'))
const PI = lazy(() => import('./pages/procurement/pi'))
const ProcurementPricing = lazy(() => import('./pages/procurement/pricing'))

// Inventory
const Inventory = lazy(() => import('./pages/inventory'))
const Fabrics = lazy(() => import('./pages/inventory/fabrics'))
const StockValue = lazy(() => import('./pages/inventory/stock-value'))
const StockAdjustments = lazy(() => import('./pages/inventory/adjustments'))

// BOM
const BOM = lazy(() => import('./pages/bom'))

// Products
const Products = lazy(() => import('./pages/products'))
const ProductBOM = lazy(() => import('./pages/products/bom'))

// Single-page modules
const Customers = lazy(() => import('./pages/customers'))
const Employees = lazy(() => import('./pages/employees'))
const Warehouse = lazy(() => import('./pages/warehouse'))

// Accounting
const Accounting = lazy(() => import('./pages/accounting'))
const CashFlow = lazy(() => import('./pages/accounting/cash-flow'))

// Planning
const Planning = lazy(() => import('./pages/planning'))
const MRP = lazy(() => import('./pages/planning/mrp'))

// Quality
const Quality = lazy(() => import('./pages/quality'))

// R&D
const RD = lazy(() => import('./pages/rd'))
const RDDetail = lazy(() => import('./pages/rd/detail'))

// Reports, Notifications, Maintenance
const Reports = lazy(() => import('./pages/reports'))
const Notifications = lazy(() => import('./pages/notifications'))
const Maintenance = lazy(() => import('./pages/maintenance'))

// Settings
const Settings = lazy(() => import('./pages/settings'))
const Organisations = lazy(() => import('./pages/settings/organisations'))
const SettingsUsers = lazy(() => import('./pages/settings/Users'))

// Admin (SUPER_ADMIN-only screens — system health, etc.)
const AdminHealth = lazy(() => import('./pages/admin/health'))

// Consignment
const Consignment = lazy(() => import('./pages/consignment'))
const ConsignmentDetail = lazy(() => import('./pages/consignment/detail'))
const ConsignmentCreate = lazy(() => import('./pages/consignment/create'))
const ConsignmentEdit = lazy(() => import('./pages/consignment/edit'))
const ConsignmentNote = lazy(() => import('./pages/consignment/note'))
const ConsignmentReturn = lazy(() => import('./pages/consignment/return'))

// Analytics
const Forecast = lazy(() => import('./pages/analytics/forecast'))

// ── Loading fallback ──────────────────────────────────────────────────────

function PageLoading() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="animate-pulse text-sm text-[#5A5550]">Loading...</div>
    </div>
  )
}

// S() = Suspense + per-page ErrorBoundary. Any lazy page that throws (render,
// unhandled promise, ChunkLoadError) is caught and only that page shows the
// fallback UI — the dashboard shell + sidebar + other open tabs keep working.
// Without this a single page crash blanks the whole screen.
function S({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

// ── Route entries ─────────────────────────────────────────────────────────
// IMPORTANT: each entry's `element` is rendered both from createBrowserRouter
// and from the TabbedOutlet. They reference the SAME lazy component refs so
// a chunk loaded by one is cached for the other (Vite caches lazy modules
// by import specifier).

export const DASHBOARD_ROUTES: RouteObject[] = [
  // Dashboard
  { path: '/dashboard', element: <S><Dashboard /></S> },

  // Sales
  { path: '/sales', element: <S><Sales /></S> },
  { path: '/sales/create', element: <S><SalesCreate /></S> },
  { path: '/sales/:id', element: <S><SalesDetail /></S> },
  { path: '/sales/:id/edit', element: <S><SalesEdit /></S> },

  // Production
  // Order matters: specific literal child paths (scan, fg-scan, the 8 dept
  // codes, department/:code) must come BEFORE the `/production/:id` PO
  // detail wildcard, otherwise React Router matches the dynamic segment
  // first and swallows "/production/fab-cut" into the detail route.
  { path: '/production', element: <S><ProductionOverview /></S> },
  { path: '/production/scan', element: <S><ProductionScan /></S> },
  { path: '/production/fg-scan', element: <S><FGScan /></S> },
  { path: '/production/tracker', element: <Navigate to="/planning" replace /> },
  { path: '/production/department/:code', element: <S><DepartmentDetail /></S> },
  // Per-department split routes — each renders the shared ProductionPage
  // with mode="dept" and narrows the backend fetch to that dept's JCs only.
  { path: '/production/fab-cut', element: <S><ProductionDeptPage /></S> },
  { path: '/production/fab-sew', element: <S><ProductionDeptPage /></S> },
  { path: '/production/foam', element: <S><ProductionDeptPage /></S> },
  { path: '/production/wood-cut', element: <S><ProductionDeptPage /></S> },
  { path: '/production/framing', element: <S><ProductionDeptPage /></S> },
  { path: '/production/webbing', element: <S><ProductionDeptPage /></S> },
  { path: '/production/upholstery', element: <S><ProductionDeptPage /></S> },
  { path: '/production/packing', element: <S><ProductionDeptPage /></S> },
  // /production/:id PO-detail route deleted (2026-04-26, user request).
  // PO double-clicks now route directly to /sales/:salesOrderId — the SO
  // page is the canonical place to track an order. Any stale link to
  // /production/<pord-id> falls through to the dept routes above (which
  // only match literal /production/<dept>) and then to the global 404.

  // Legacy redirects
  { path: '/production-test', element: <Navigate to="/production" replace /> },
  { path: '/production-test/:id', element: <Navigate to="/production" replace /> },
  { path: '/production-test/department/:code', element: <Navigate to="/production" replace /> },
  { path: '/production-test/scan', element: <Navigate to="/production/scan" replace /> },
  { path: '/production-test/fg-scan', element: <Navigate to="/production/fg-scan" replace /> },

  // Delivery
  { path: '/delivery', element: <S><Delivery /></S> },
  { path: '/delivery/:id', element: <S><DeliveryDetail /></S> },
  { path: '/delivery-test', element: <Navigate to="/delivery" replace /> },
  { path: '/delivery-test/:id', element: <Navigate to="/delivery" replace /> },

  // Invoices (P3.6 — gated on invoices:read; non-Finance users redirect
  // to /dashboard rather than landing on a 403-everywhere shell).
  {
    path: '/invoices',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><Invoices /></S>
      </RequirePermission>
    ),
  },
  {
    path: '/invoices/:id',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><InvoiceDetail /></S>
      </RequirePermission>
    ),
  },
  {
    path: '/invoices/payments',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><Payments /></S>
      </RequirePermission>
    ),
  },
  {
    path: '/invoices/credit-notes',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><CreditNotes /></S>
      </RequirePermission>
    ),
  },
  {
    path: '/invoices/debit-notes',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><DebitNotes /></S>
      </RequirePermission>
    ),
  },
  {
    path: '/invoices/e-invoice',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><EInvoice /></S>
      </RequirePermission>
    ),
  },

  // Procurement
  { path: '/procurement', element: <S><Procurement /></S> },
  { path: '/procurement/:id', element: <S><ProcurementDetail /></S> },
  { path: '/procurement/grn', element: <S><GRN /></S> },
  { path: '/procurement/in-transit', element: <S><InTransit /></S> },
  { path: '/procurement/maintenance', element: <S><ProcurementMaintenance /></S> },
  { path: '/procurement/pi', element: <S><PI /></S> },
  { path: '/procurement/pricing', element: <S><ProcurementPricing /></S> },

  // Inventory
  { path: '/inventory', element: <S><Inventory /></S> },
  { path: '/inventory/fabrics', element: <S><Fabrics /></S> },
  { path: '/inventory/stock-value', element: <S><StockValue /></S> },
  { path: '/inventory/adjustments', element: <S><StockAdjustments /></S> },

  // BOM
  { path: '/bom', element: <S><BOM /></S> },

  // Products
  { path: '/products', element: <S><Products /></S> },
  { path: '/products/:id/bom', element: <S><ProductBOM /></S> },

  // Single-page modules
  { path: '/customers', element: <S><Customers /></S> },
  { path: '/employees', element: <S><Employees /></S> },
  { path: '/warehouse', element: <S><Warehouse /></S> },

  // Accounting (P3.6 — gated on accounting:read; non-Finance users redirect
  // to /dashboard rather than landing on a 403-everywhere shell).
  {
    path: '/accounting',
    element: (
      <RequirePermission resource="accounting" action="read">
        <S><Accounting /></S>
      </RequirePermission>
    ),
  },
  {
    path: '/accounting/cash-flow',
    element: (
      <RequirePermission resource="accounting" action="read">
        <S><CashFlow /></S>
      </RequirePermission>
    ),
  },

  // Planning
  { path: '/planning', element: <S><Planning /></S> },
  { path: '/planning/mrp', element: <S><MRP /></S> },

  // Quality
  { path: '/quality', element: <S><Quality /></S> },

  // R&D
  { path: '/rd', element: <S><RD /></S> },
  { path: '/rd/:id', element: <S><RDDetail /></S> },

  // Reports, Notifications, Maintenance
  { path: '/reports', element: <S><Reports /></S> },
  { path: '/notifications', element: <S><Notifications /></S> },
  { path: '/maintenance', element: <S><Maintenance /></S> },

  // Settings
  { path: '/settings', element: <S><Settings /></S> },
  { path: '/settings/organisations', element: <S><Organisations /></S> },
  // User Management is SUPER_ADMIN only — coarsest gate, role-based.
  {
    path: '/settings/users',
    element: (
      <RequireRole role="SUPER_ADMIN">
        <S><SettingsUsers /></S>
      </RequireRole>
    ),
  },

  // Admin — SUPER_ADMIN-only system health dashboard (P6.4). Same gate
  // pattern as /settings/users; both server-side and client-side checks
  // enforce the role (defense-in-depth).
  {
    path: '/admin/health',
    element: (
      <RequireRole role="SUPER_ADMIN">
        <S><AdminHealth /></S>
      </RequireRole>
    ),
  },

  // Consignment
  { path: '/consignment', element: <S><Consignment /></S> },
  { path: '/consignment/:id', element: <S><ConsignmentDetail /></S> },
  { path: '/consignment/create', element: <S><ConsignmentCreate /></S> },
  { path: '/consignment/:id/edit', element: <S><ConsignmentEdit /></S> },
  { path: '/consignment/note', element: <S><ConsignmentNote /></S> },
  { path: '/consignment/return', element: <S><ConsignmentReturn /></S> },

  // Analytics
  { path: '/analytics/forecast', element: <S><Forecast /></S> },
]

// JSX array usable inside <Routes> — same refs as DASHBOARD_ROUTES
export const DASHBOARD_ROUTE_ELEMENTS = DASHBOARD_ROUTES.map((r) => (
  <Route key={r.path!} path={r.path!} element={r.element} />
))
