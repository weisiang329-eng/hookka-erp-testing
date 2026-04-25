// ---------------------------------------------------------------------------
// TabbedOutlet — active-pane-only renderer for the dashboard shell.
//
// Only the *active* tab's React tree is mounted at any time. Switching tabs
// unmounts the previous pane and mounts the new one. This means:
//
//   • Each fetch made by a page only fires when that page is visible —
//     no N concurrent slow `[slow-fetch]` calls fan out from hidden tabs.
//   • Scroll position / unsaved form state in inactive tabs is lost on switch
//     (acceptable: the user explicitly asked for "Mount on activation,
//     unmount on switch (or at least suspend rendering)" after observing
//     7 dept tabs each firing 8s production-orders queries on Production).
//   • The browser URL remains authoritative — the active pane uses the live
//     `location`, so each tab's saved per-pane state isn't needed any more.
//
// History
// -------
// Earlier this file kept *every* open tab mounted (with `display: none` for
// inactive panes). Mounted = effects run = fetches fire, so opening 4 tabs
// triggered 4 parallel API calls on every page render. The cap on cached
// panes only bounded memory; it didn't stop the fan-out. Per the user's
// 2026-04-25 perf report we now mount one pane at a time.
//
// How it hooks into react-router
// ------------------------------
// The router config (src/router.tsx) maps every dashboard URL to
// <DashboardLayout /> via a single splat child route. DashboardLayout
// renders this TabbedOutlet, which re-does the matching itself using
// DASHBOARD_ROUTE_ELEMENTS and the live URL.
// ---------------------------------------------------------------------------
import { Routes, useLocation } from 'react-router-dom'
import { useTabs } from '@/contexts/tabs-context'
import { DASHBOARD_ROUTE_ELEMENTS } from '@/dashboard-routes'

function normalisePath(path: string): string {
  if (!path.startsWith('/')) path = '/' + path
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

export function TabbedOutlet() {
  const { tabs, activeId } = useTabs()
  const location = useLocation()

  // Decide which pane is the visible one. Prefer the explicit activeId;
  // fall back to the URL (covers the first-render case before TabsUrlSync
  // has finished wiring up). The active pane is the only thing we render —
  // inactive tabs have no React tree, so their fetches never fire.
  const activeTab = tabs.find((t) => t.id === activeId)
  const visiblePath = activeTab
    ? normalisePath(activeTab.path)
    : normalisePath(location.pathname)

  return (
    <div data-tab-pane={visiblePath}>
      <Routes location={location}>
        {DASHBOARD_ROUTE_ELEMENTS}
      </Routes>
    </div>
  )
}
