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
import { PageSkeleton } from './components/ui/skeleton'

// ── Lazy-loaded pages ─────────────────────────────────────────────────────

// Dashboard — the old /dashboard page was retired 2026-05-21. Dashboard B
// is now the one and only dashboard, served at /dashboard.
const DashboardB = lazy(() => import('./pages/dashboard-b'))

// Sales
const Sales = lazy(() => import('./pages/sales'))
const SalesCreate = lazy(() => import('./pages/sales/create'))
const SalesDetail = lazy(() => import('./pages/sales/detail'))
const SalesEdit = lazy(() => import('./pages/sales/edit'))

// Service Order (0134) — aftersales SO module. Re-exports the Sales pages
// with route-derived mode switching (see src/lib/so-mode.ts). Same data
// model, same form, different list filter + ID prefix.
const ServiceOrder = lazy(() => import('./pages/service-order'))
const ServiceOrderCreate = lazy(() => import('./pages/service-order/create'))
const ServiceOrderDetailV2 = lazy(() => import('./pages/service-order/detail'))
const ServiceOrderEdit = lazy(() => import('./pages/service-order/edit'))

// Production
// The split-by-dept refactor introduced overview.tsx (/production) and
// dept.tsx (/production/:deptCode) as thin wrappers over the main
// ProductionPage component. Importing ./pages/production (the index) is
// still kept so any legacy direct consumer keeps working, but the active
// routes below point at the new wrappers.
const ProductionOverview = lazy(() => import('./pages/production/overview'))
const ProductionDeptPage = lazy(() => import('./pages/production/dept'))
const WipTimesPage = lazy(() => import('./pages/production/wip-times'))
const ProductionFolders = lazy(() => import('./pages/production/folders'))
const ProductionFolderDetail = lazy(() => import('./pages/production/folder-detail'))
const ProductionScan = lazy(() => import('./pages/production/scan'))
const FGScan = lazy(() => import('./pages/production/fg-scan'))

// Delivery
const Delivery = lazy(() => import('./pages/delivery'))
const DeliveryDetail = lazy(() => import('./pages/delivery/detail'))

// Invoices
const Invoices = lazy(() => import('./pages/invoices'))
const InvoiceDetail = lazy(() => import('./pages/invoices/detail'))
const Payments = lazy(() => import('./pages/invoices/payments'))
const SupplierPayments = lazy(() => import('./pages/invoices/supplier-payments'))
const CreditNotes = lazy(() => import('./pages/invoices/credit-notes'))
const DebitNotes = lazy(() => import('./pages/invoices/debit-notes'))
const EInvoice = lazy(() => import('./pages/invoices/e-invoice'))

// Procurement
const Procurement = lazy(() => import('./pages/procurement'))
const ProcurementCreate = lazy(() => import('./pages/procurement/create'))
const ProcurementDetail = lazy(() => import('./pages/procurement/detail'))
const GRN = lazy(() => import('./pages/procurement/grn'))
const GRNCreate = lazy(() => import('./pages/procurement/grn/create'))
const GRNDetail = lazy(() => import('./pages/procurement/grn-detail'))
const ProcurementMaintenance = lazy(() => import('./pages/procurement/maintenance'))
const PI = lazy(() => import('./pages/procurement/pi'))
const PICreate = lazy(() => import('./pages/procurement/pi/create'))
const PIDetail = lazy(() => import('./pages/procurement/PurchaseInvoiceDetail'))
const SupplierDetail = lazy(() => import('./pages/suppliers/detail'))

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
const ProductDocuments = lazy(() => import('./pages/products/documents'))

// CNC Cutting Templates — fabric-cutting file library for the BUYI E-DIGIT
// cutter, grouped by product code.
const CncTemplates = lazy(() => import('./pages/cnc-templates'))

// Background scan queue — async OCR progress per batch. Linked to from the
// scan-supplier / scan-po modals when >2 files are dropped.

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
// Planning > department drill-in pages — one per production department,
// reached by clicking a department name on Capacity Overview / Capacity
// Loading. All four render the shared _DepartmentSchedulePage component.
const PlanningFabricCutting = lazy(() => import('./pages/planning/dept/fabric-cutting'))
const PlanningFabricSewing = lazy(() => import('./pages/planning/dept/fabric-sewing'))
const PlanningWoodCutting = lazy(() => import('./pages/planning/dept/wood-cutting'))
const PlanningFraming = lazy(() => import('./pages/planning/dept/framing'))
const PlanningFoamBonding = lazy(() => import('./pages/planning/dept/foam-bonding'))
const PlanningUpholstery = lazy(() => import('./pages/planning/dept/upholstery'))
const PlanningPacking = lazy(() => import('./pages/planning/dept/packing'))
const PlanningWebbing = lazy(() => import('./pages/planning/dept/webbing'))

// Quality
const Quality = lazy(() => import('./pages/quality'))

// Service Cases (parent — every customer-facing service log).
const ServiceCases = lazy(() => import('./pages/service-cases'))
const ServiceCaseDetail = lazy(() => import('./pages/service-cases/detail'))
// Service Orders (child — heavy rework/swap/repair flows under a case).
const ServiceOrders = lazy(() => import('./pages/service-orders'))
const ServiceOrderDetail = lazy(() => import('./pages/service-orders/detail'))

// R&D
const RD = lazy(() => import('./pages/rd'))
const RDDetail = lazy(() => import('./pages/rd/detail'))
const RDMaintenance = lazy(() => import('./pages/rd/maintenance'))

// Reports, Notifications, Maintenance
const Reports = lazy(() => import('./pages/reports'))
const DailyReport = lazy(() => import('./pages/daily-report'))
const Notifications = lazy(() => import('./pages/notifications'))
// Announcements — office posts that every worker sees on their phone home
// screen (worker portal). Admin-gated by the API (requirePermission); the
// sidebar link is permission-filtered too.
const Announcements = lazy(() => import('./pages/announcements'))
const MailCenter = lazy(() => import('./pages/mail-center'))
const MailCenterDetail = lazy(() => import('./pages/mail-center/detail'))
const Maintenance = lazy(() => import('./pages/maintenance'))
const MaintenanceSofaCombos = lazy(() => import('./pages/maintenance/sofa-combos'))

// Settings
const Settings = lazy(() => import('./pages/settings'))
const Organisations = lazy(() => import('./pages/settings/organisations'))
const SettingsUsers = lazy(() => import('./pages/settings/Users'))

// Admin (SUPER_ADMIN-only screens — system health, etc.)
const AdminHealth = lazy(() => import('./pages/admin/health'))
// Agent Console (Production Agent Phase 3) — SUPER_ADMIN-only status +
// one-click controls for every agent (run-now / pause / kill-all / rollback).
const AgentConsole = lazy(() => import('./pages/agents'))

// 2FA setup (any authenticated user — soft-prompt destination from /login).
const Setup2FA = lazy(() => import('./pages/setup-2fa'))

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
// A layout-shaped skeleton (header + toolbar + table) shown while a lazy
// route chunk downloads. Nicer than a bare "Loading..." string and matches
// the rest of the app's loading UX. The visually-hidden "Loading..." span
// keeps the state announced to screen readers.

function PageLoading() {
  return (
    <>
      <span className="sr-only" role="status">Loading...</span>
      <PageSkeleton />
    </>
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
  // Dashboard — Dashboard B is the canonical dashboard. The old
  // /dashboard-b URL redirects to /dashboard so existing links / bookmarks
  // keep working.
  { path: '/dashboard', element: <S><DashboardB /></S> },
  { path: '/dashboard-b', element: <Navigate to="/dashboard" replace /> },

  // Sales
  { path: '/sales', element: <S><Sales /></S> },
  { path: '/sales/create', element: <S><SalesCreate /></S> },
  { path: '/sales/:id', element: <S><SalesDetail /></S> },
  { path: '/sales/:id/edit', element: <S><SalesEdit /></S> },

  // Service Order (0134) — aftersales SO. Same components as /sales/* but
  // the route prefix flips `useSOMode()` to "service-order", which switches
  // the list filter (?isServiceOrder=true), the POST body
  // (isServiceOrder: true), and every internal navigate(...) base path.
  { path: '/service-order', element: <S><ServiceOrder /></S> },
  { path: '/service-order/create', element: <S><ServiceOrderCreate /></S> },
  { path: '/service-order/:id', element: <S><ServiceOrderDetailV2 /></S> },
  { path: '/service-order/:id/edit', element: <S><ServiceOrderEdit /></S> },

  // Production
  // Order matters: specific literal child paths (scan, fg-scan, the 8 dept
  // codes, department/:code) must come BEFORE the `/production/:id` PO
  // detail wildcard, otherwise React Router matches the dynamic segment
  // first and swallows "/production/fab-cut" into the detail route.
  { path: '/production', element: <S><ProductionOverview /></S> },
  { path: '/production/scan', element: <S><ProductionScan /></S> },
  { path: '/production/fg-scan', element: <S><FGScan /></S> },
  { path: '/production/tracker', element: <Navigate to="/planning" replace /> },
  // Legacy per-dept route — superseded by /production/<dept> (the shared
  // ProductionPage). Redirect so old links/bookmarks land on the live page
  // instead of the orphaned department.tsx (2026-06-10).
  { path: '/production/department/:code', element: <Navigate to="/production" replace /> },
  // Production Folders — archive paper schedules. Both routes are LITERAL
  // prefixes so React Router's route matcher distinguishes them from the
  // dept routes below. `/folders` lists, `/folders/:id` opens one.
  { path: '/production/folders', element: <S><ProductionFolders /></S> },
  { path: '/production/folders/:id', element: <S><ProductionFolderDetail /></S> },
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
    path: '/invoices/supplier-payments',
    element: (
      <RequirePermission resource="invoices" action="read">
        <S><SupplierPayments /></S>
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
  // /procurement/create must come before the :id wildcard so React Router
  // matches the literal path first (otherwise "create" is captured as :id).
  { path: '/procurement/create', element: <S><ProcurementCreate /></S> },
  { path: '/procurement/:id', element: <S><ProcurementDetail /></S> },
  { path: '/procurement/grn', element: <S><GRN /></S> },
  // /procurement/grn/create must precede /procurement/grn/:id so React Router
  // matches the literal "create" segment first (otherwise "create" is captured
  // as the :id wildcard and opens the GRN detail for a non-existent record).
  { path: '/procurement/grn/create', element: <S><GRNCreate /></S> },
  { path: '/procurement/grn/:id', element: <S><GRNDetail /></S> },
  { path: '/procurement/in-transit', element: <Navigate to="/procurement/grn" replace /> },
  { path: '/procurement/maintenance', element: <S><ProcurementMaintenance /></S> },
  { path: '/procurement/pi', element: <S><PI /></S> },
  // /procurement/pi/create must come before /procurement/pi/:id so React
  // Router matches the literal "create" path first (same pattern as /procurement/create).
  { path: '/procurement/pi/create', element: <S><PICreate /></S> },
  { path: '/procurement/pi/:id', element: <S><PIDetail /></S> },
  { path: '/procurement/pricing', element: <Navigate to="/procurement/maintenance" replace /> },

  // Suppliers — Phase 4.1 supplier scorecard panel
  { path: '/suppliers/:id', element: <S><SupplierDetail /></S> },

  // Inventory
  { path: '/inventory', element: <S><Inventory /></S> },
  { path: '/inventory/fabrics', element: <S><Fabrics /></S> },
  { path: '/inventory/stock-value', element: <S><StockValue /></S> },
  { path: '/inventory/adjustments', element: <S><StockAdjustments /></S> },

  // BOM
  { path: '/bom', element: <S><BOM /></S> },
  // WIP catalog — unique-per-WIP production time reference, sourced from
  // job_cards.estMinutes aggregated by (wipLabel × dept). Sibling to /bom
  // because BOM is the canonical recipe — operators use this page as a
  // flat dedup'd view of every wipLabel that's ever run, with its avg time.
  { path: '/bom/wip-times', element: <S><WipTimesPage /></S> },

  // Products
  { path: '/products', element: <S><Products /></S> },
  { path: '/products/:id/bom', element: <S><ProductBOM /></S> },
  { path: '/products/:id/documents', element: <S><ProductDocuments /></S> },

  // CNC Cutting Templates — fabric-cutting file library (BUYI E-DIGIT cutter).
  { path: '/cnc-templates', element: <S><CncTemplates /></S> },

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
  // Literal child paths (mrp, dept/*) come before any future /planning/:id
  // wildcard so the matcher resolves them first.
  { path: '/planning', element: <S><Planning /></S> },
  { path: '/planning/mrp', element: <S><MRP /></S> },
  { path: '/planning/dept/fabric-cutting', element: <S><PlanningFabricCutting /></S> },
  { path: '/planning/dept/fabric-sewing', element: <S><PlanningFabricSewing /></S> },
  { path: '/planning/dept/wood-cutting', element: <S><PlanningWoodCutting /></S> },
  { path: '/planning/dept/framing', element: <S><PlanningFraming /></S> },
  { path: '/planning/dept/foam-bonding', element: <S><PlanningFoamBonding /></S> },
  { path: '/planning/dept/upholstery', element: <S><PlanningUpholstery /></S> },
  { path: '/planning/dept/packing', element: <S><PlanningPacking /></S> },
  { path: '/planning/dept/webbing', element: <S><PlanningWebbing /></S> },

  // Quality
  { path: '/quality', element: <S><Quality /></S> },

  // Service Cases — top-level (parent). Sidebar links here.
  { path: '/service-cases', element: <S><ServiceCases /></S> },
  { path: '/service-cases/:id', element: <S><ServiceCaseDetail /></S> },
  // Service Orders — child detail pages, reachable from a case detail.
  // Not in sidebar anymore; the list page stays for direct linking.
  { path: '/service-orders', element: <S><ServiceOrders /></S> },
  { path: '/service-orders/:id', element: <S><ServiceOrderDetail /></S> },

  // R&D
  { path: '/rd', element: <S><RD /></S> },
  { path: '/rd/maintenance', element: <S><RDMaintenance /></S> },
  { path: '/rd/:id', element: <S><RDDetail /></S> },

  // Reports, Notifications, Maintenance
  { path: '/reports', element: <S><Reports /></S> },
  // Daily Report — process / SOP exceptions ("what needs attention today").
  { path: '/daily-report', element: <S><DailyReport /></S> },
  { path: '/notifications', element: <S><Notifications /></S> },
  // Announcements — post a notice that shows on every worker's phone.
  { path: '/announcements', element: <S><Announcements /></S> },
  { path: '/mail-center', element: <S><MailCenter /></S> },
  { path: '/mail-center/:id', element: <S><MailCenterDetail /></S> },
  { path: '/maintenance', element: <S><Maintenance /></S> },
  { path: '/maintenance/sofa-combos', element: <S><MaintenanceSofaCombos /></S> },

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

  // Agent Console — SUPER_ADMIN only, same defense-in-depth as /admin/health
  // (RequireRole here + requireSuperAdmin on every /api/agents route).
  {
    path: '/agents',
    element: (
      <RequireRole role="SUPER_ADMIN">
        <S><AgentConsole /></S>
      </RequireRole>
    ),
  },

  // 2FA setup — any authenticated user (RequireAuth on the parent layout
  // already gates it). The page reads location.state.severity to decide
  // whether to show the "Skip for now" link (omitted when severity = "hard").
  { path: '/setup-2fa', element: <S><Setup2FA /></S> },

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

// ── Route chunk prefetch ──────────────────────────────────────────────────
// Lazy route chunks only download on first navigation, so the first click on
// a sidebar link pays the full network cost of the JS bundle before the page
// can even start fetching its data. To hide that latency we prefetch a
// route's chunk on sidebar-link HOVER (the user has signalled intent ~200ms
// before they click).
//
// The map below uses the SAME `import('./pages/...')` specifiers as the
// lazy() calls above. Vite/ESM caches a dynamic import by specifier, so
// calling import() here and again inside lazy() loads the chunk exactly
// once — whichever fires first wins, the other is a cache hit.
//
// Keyed by the sidebar's top-level `href`. Only the routes the sidebar
// actually links to need an entry; anything missing simply isn't prefetched
// (safe no-op).
const ROUTE_CHUNK_LOADERS: Record<string, () => Promise<unknown>> = {
  '/dashboard': () => import('./pages/dashboard-b'),
  '/daily-report': () => import('./pages/daily-report'),
  '/notifications': () => import('./pages/notifications'),
  '/announcements': () => import('./pages/announcements'),
  '/mail-center': () => import('./pages/mail-center'),
  '/analytics/forecast': () => import('./pages/analytics/forecast'),
  '/sales': () => import('./pages/sales'),
  '/delivery': () => import('./pages/delivery'),
  '/invoices': () => import('./pages/invoices'),
  '/invoices/credit-notes': () => import('./pages/invoices/credit-notes'),
  '/invoices/debit-notes': () => import('./pages/invoices/debit-notes'),
  '/invoices/payments': () => import('./pages/invoices/payments'),
  '/invoices/supplier-payments': () => import('./pages/invoices/supplier-payments'),
  '/invoices/e-invoice': () => import('./pages/invoices/e-invoice'),
  '/consignment': () => import('./pages/consignment'),
  '/consignment/note': () => import('./pages/consignment/note'),
  '/consignment/return': () => import('./pages/consignment/return'),
  '/customers': () => import('./pages/customers'),
  '/production': () => import('./pages/production/overview'),
  '/production/fab-cut': () => import('./pages/production/dept'),
  '/production/fab-sew': () => import('./pages/production/dept'),
  '/production/foam': () => import('./pages/production/dept'),
  '/production/wood-cut': () => import('./pages/production/dept'),
  '/production/framing': () => import('./pages/production/dept'),
  '/production/webbing': () => import('./pages/production/dept'),
  '/production/upholstery': () => import('./pages/production/dept'),
  '/production/packing': () => import('./pages/production/dept'),
  '/production/scan': () => import('./pages/production/scan'),
  '/production/folders': () => import('./pages/production/folders'),
  '/planning': () => import('./pages/planning'),
  '/planning/mrp': () => import('./pages/planning/mrp'),
  '/planning/dept/fabric-cutting': () => import('./pages/planning/dept/fabric-cutting'),
  '/planning/dept/fabric-sewing': () => import('./pages/planning/dept/fabric-sewing'),
  '/planning/dept/wood-cutting': () => import('./pages/planning/dept/wood-cutting'),
  '/planning/dept/framing': () => import('./pages/planning/dept/framing'),
  '/planning/dept/foam-bonding': () => import('./pages/planning/dept/foam-bonding'),
  '/planning/dept/upholstery': () => import('./pages/planning/dept/upholstery'),
  '/planning/dept/packing': () => import('./pages/planning/dept/packing'),
  '/planning/dept/webbing': () => import('./pages/planning/dept/webbing'),
  '/products': () => import('./pages/products'),
  '/cnc-templates': () => import('./pages/cnc-templates'),
  '/bom': () => import('./pages/bom'),
  '/bom/wip-times': () => import('./pages/production/wip-times'),
  '/maintenance/sofa-combos': () => import('./pages/maintenance/sofa-combos'),
  '/inventory': () => import('./pages/inventory'),
  '/inventory/fabrics': () => import('./pages/inventory/fabrics'),
  '/inventory/stock-value': () => import('./pages/inventory/stock-value'),
  '/inventory/adjustments': () => import('./pages/inventory/adjustments'),
  '/warehouse': () => import('./pages/warehouse'),
  '/procurement': () => import('./pages/procurement'),
  '/procurement/grn': () => import('./pages/procurement/grn'),
  '/procurement/grn/create': () => import('./pages/procurement/grn/create'),
  '/procurement/pi': () => import('./pages/procurement/pi'),
  '/procurement/maintenance': () => import('./pages/procurement/maintenance'),
  '/rd': () => import('./pages/rd'),
  '/rd/maintenance': () => import('./pages/rd/maintenance'),
  '/quality': () => import('./pages/quality'),
  '/service-cases': () => import('./pages/service-cases'),
  '/accounting': () => import('./pages/accounting'),
  '/accounting/cash-flow': () => import('./pages/accounting/cash-flow'),
  '/reports': () => import('./pages/reports'),
  '/employees': () => import('./pages/employees'),
  '/maintenance': () => import('./pages/maintenance'),
  '/settings': () => import('./pages/settings'),
  '/settings/organisations': () => import('./pages/settings/organisations'),
  '/settings/users': () => import('./pages/settings/Users'),
  '/admin/health': () => import('./pages/admin/health'),
  '/agents': () => import('./pages/agents'),
}

// Per-path dedupe — once a chunk has been requested we never request it
// again (the browser caches it, but skipping the call avoids churn).
const prefetched = new Set<string>()

/**
 * Prefetch the lazy JS chunk for a route. Safe to call repeatedly and for
 * unknown paths (no-op). Errors are swallowed — a failed prefetch just means
 * the chunk loads normally on click.
 */
export function prefetchRoute(href: string): void {
  if (prefetched.has(href)) return
  const loader = ROUTE_CHUNK_LOADERS[href]
  if (!loader) return
  prefetched.add(href)
  loader().catch(() => {
    // Network error / chunk 404 — drop the dedupe mark so a later
    // navigation can retry via lazy()'s own import.
    prefetched.delete(href)
  })
}
