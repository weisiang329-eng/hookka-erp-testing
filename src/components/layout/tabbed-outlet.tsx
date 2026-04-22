// ---------------------------------------------------------------------------
// TabbedOutlet — keep-alive replacement for <Outlet />.
//
// Instead of unmounting the previous route's component when the URL changes,
// TabbedOutlet renders a <Routes location={tab.path}> for *every* open tab
// and hides inactive ones with `display: none`. This means:
//
//   • Switching tabs is instant — no re-mount, no API re-fetch.
//   • Scroll position, form inputs, local component state survive switches.
//   • Memory grows with the number of open tabs — this is the cost.
//
// How it hooks into react-router
// ------------------------------
// The router config (src/router.tsx) still maps every dashboard URL to
// <DashboardLayout /> so the browser URL stays authoritative for bookmarks,
// browser back/forward, and refresh. But DashboardLayout renders this
// TabbedOutlet *instead of* the standard <Outlet />, so the router's matched
// child is ignored — TabbedOutlet re-does the matching itself using the
// same DASHBOARD_ROUTES list, per tab.
//
// Per-tab location memory
// -----------------------
// Some pages (scan, settings/variants, sales/create, etc.) read query params
// via useSearchParams. To keep those working per-tab — so each tab remembers
// its own ?filter=… — we snapshot the browser URL's {search, hash} into a
// map keyed by pathname every time it changes. When rendering an inactive
// pane we pass its saved snapshot via the `location` prop on <Routes>, so
// its internal useLocation / useSearchParams see what the user last saw
// on that tab, not whatever the browser URL is right now.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef } from 'react'
import { Routes, useLocation } from 'react-router-dom'
import { useTabs } from '@/contexts/tabs-context'
import { DASHBOARD_ROUTE_ELEMENTS } from '@/dashboard-routes'

function normalisePath(path: string): string {
  if (!path.startsWith('/')) path = '/' + path
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

type SavedLoc = { search: string; hash: string }

export function TabbedOutlet() {
  const { tabs, activeId } = useTabs()
  const location = useLocation()

  // pathname → last-seen {search, hash} while that pathname was the active URL.
  const savedLocsRef = useRef<Map<string, SavedLoc>>(new Map())

  useEffect(() => {
    const key = normalisePath(location.pathname)
    savedLocsRef.current.set(key, {
      search: location.search,
      hash: location.hash,
    })
  }, [location.pathname, location.search, location.hash])

  // Decide which pane is the visible one. Prefer the explicit activeId;
  // fall back to the URL (covers the first-render case before TabsUrlSync
  // has finished wiring up).
  const activeTab = tabs.find((t) => t.id === activeId)
  const visiblePath = activeTab
    ? normalisePath(activeTab.path)
    : normalisePath(location.pathname)

  // Build the union of paths we need to render. Keyed by normalised path so
  // duplicates collapse.
  const panes = useMemo(() => {
    const map = new Map<string, { key: string; path: string }>()
    for (const tab of tabs) {
      const p = normalisePath(tab.path)
      if (!map.has(p)) {
        map.set(p, { key: tab.id, path: p })
      }
    }
    // Ensure the current URL is rendered even if no tab has it yet.
    const currentNorm = normalisePath(location.pathname)
    if (!map.has(currentNorm)) {
      map.set(currentNorm, { key: `url:${currentNorm}`, path: currentNorm })
    }
    return Array.from(map.values())
  }, [tabs, location.pathname])

  return (
    <>
      {panes.map((pane) => {
        const isActive = pane.path === visiblePath

        // Active pane: use the live browser location so query-param-driven
        // pages stay reactive. Inactive panes: use the saved snapshot so
        // each tab remembers its own ?filter=… state.
        const paneLocation = isActive
          ? location
          : {
              pathname: pane.path,
              search: savedLocsRef.current.get(pane.path)?.search ?? '',
              hash: savedLocsRef.current.get(pane.path)?.hash ?? '',
              state: null,
              key: `pane:${pane.path}`,
            }

        return (
          <div
            key={pane.key}
            // `display: none` keeps the React tree mounted + DOM preserved
            // (so scroll position, inputs, etc. survive tab switches). The
            // `hidden` attribute adds the right a11y / SEO semantics.
            hidden={!isActive}
            style={{ display: isActive ? 'block' : 'none' }}
            data-tab-pane={pane.path}
          >
            <Routes location={paneLocation}>
              {DASHBOARD_ROUTE_ELEMENTS}
            </Routes>
          </div>
        )
      })}
    </>
  )
}
