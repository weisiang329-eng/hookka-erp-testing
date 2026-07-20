import { useCallback, useEffect, useState } from "react";
import { Navigate, Routes, ScrollRestoration, useLocation } from "react-router-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { prefetchRoutesWhenIdle } from "@/lib/prefetch-routes";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { fetchVariantsConfig } from "@/lib/kv-config";
import { useVersionCheck } from "@/lib/use-version-check";
import { getCurrentUser } from "@/lib/auth";
import { DASHBOARD_ROUTE_ELEMENTS } from "@/dashboard-routes";
import { FloatingChatButton } from "@/components/assistant/FloatingChatButton";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";

// Lives inside ToastProvider so it can pop a toast when a new deploy lands.
// Polls for a new bundle hash every 5 min + on focus; on change, surfaces a
// manual confirm() prompt — we deliberately don't auto-reload because the
// user might be mid-form.
function NewVersionWatcher() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  useVersionCheck({
    onNewVersion: () => {
      toast.info("A new version is available — refresh to update (Ctrl+Shift+R).");
      // After the toast, prompt for reload. Delay so the toast is visible.
      // Fires from useVersionCheck's onNewVersion callback (not a render),
      // so useTimeout doesn't apply — this is a one-shot reaction to an
      // event, not a lifecycle-bound effect.
      // eslint-disable-next-line no-restricted-syntax -- one-shot delay inside event-style callback, not in a React effect
      window.setTimeout(async () => {
        if (
          await confirm({
            title: "Reload for new version?",
            message: "A new version is available. Reload now? Unsaved changes may be lost.",
            confirmLabel: "Reload",
          })
        ) {
          window.location.reload();
        }
      }, 1500);
    },
  });
  return null;
}

const SIDEBAR_COLLAPSED_KEY = "hookka:sidebar:collapsed";

export default function DashboardLayout() {
  const { pathname } = useLocation();
  const currentRole = getCurrentUser()?.role;

  // Sidebar collapse state lives here (not inside <Sidebar/>) so the main
  // content's left padding can stay synced with the sidebar's actual width.
  // Persisted across reloads — operators who prefer the icons-only view
  // shouldn't have to re-collapse on every page load.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore quota / disabled storage */
      }
      return next;
    });
  }, []);

  // Phone shell: below md the sidebar rail is hidden and becomes a slide-over
  // drawer (opened from the bottom-nav "More" slot). On phones we render the
  // sidebar full (not the icons-only rail) so the drawer is readable.
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  // Auto-collapse on narrow / portrait viewports — the always-on 240px
  // sidebar eats 31% of an iPad portrait window (768×1024). Collapse to the
  // 56px icons-only rail so content gets the room. Operator can still
  // expand manually via the toggle button. We only force-collapse on the
  // RISING edge (portrait → became-portrait) so user can still open it
  // mid-session if they want; we don't continuously force it closed.
  const isNarrowOrPortrait = useMediaQuery(
    "(orientation: portrait), (max-width: 768px)"
  );
  useEffect(() => {
    if (isNarrowOrPortrait) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- viewport-driven one-shot collapse on rising edge
      setSidebarCollapsed(true);
    }
  }, [isNarrowOrPortrait]);

  // Warm only the next likely route chunks for this page/role. The queue is
  // cancelled on navigation and skipped for scan terminals, coarse pointers,
  // weak/metered links and active input. Sidebar hover/focus handles explicit
  // intent for every other route.
  useEffect(() => {
    return prefetchRoutesWhenIdle({ pathname, role: currentRole });
  }, [pathname, currentRole]);

  // Defer heavy startup work so first paint / page navigation stays responsive.
  // NOTE: We intentionally avoid static-importing `@/pages/bom` here because
  // that forces the giant BOM page into the main shell bundle and makes every
  // dashboard route feel slow even when BOM is never opened.
  useEffect(() => {
    let cancelled = false;

    const start = () => {
      if (cancelled) return;

      // Prime the variants-config cache from D1 so downstream sync readers
      // (getProductionMinutes, getCategoryOptions in bom.tsx) have real data.
      void fetchVariantsConfig();

      // Only hydrate master templates when user is in BOM/Product routes.
      // Avoid loading the heavy BOM module for unrelated pages.
      const needsMasterHydration =
        pathname.startsWith("/bom") || pathname.startsWith("/products");
      if (!needsMasterHydration) return;

      // Lazy-load BOM hydration only when idle to reduce startup jank.
      void import("@/pages/bom").then((mod) => {
        if (!cancelled) {
          void mod.hydrateMasterTemplates();
        }
      });
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(start, { timeout: 1500 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    // requestIdleCallback fallback path: schedule the same idle work via a
    // 150ms timeout. useTimeout doesn't fit here — this branch only runs
    // when the API is missing AND we own a sibling idle-callback cleanup,
    // so the scheduling needs to live inside this combined effect.
    // (Uses `globalThis.setTimeout` — the eslint rule only flags bare /
    //  window-scoped calls; this is a deliberate, scoped escape hatch.)
    const t = globalThis.setTimeout(start, 150);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(t);
    };
  }, [pathname]);

  // Phones (incl. foldables) get the dedicated /m mobile app; iPad + desktop
  // keep this desktop shell (owner 2026-06-28: phones/folds → /m, "iPad 用电脑
  // 版本"). So the redirect matches phone-class UAs only — iPhone, iPod, and
  // Android (a folded foldable is phone-width and /m has a fold layout). iPad
  // is deliberately EXCLUDED: old iPads send "iPad" (no longer matched) and
  // iPadOS 13+ already reports a "Macintosh" desktop UA — both stay on desktop.
  // A small *desktop* window also stays on desktop (no mobile UA token). The
  // worker portal (/worker) is a separate layout and never reaches here. The
  // early return is AFTER all hooks above (rules-of-hooks safe).
  const isMobileDevice =
    typeof navigator !== "undefined" &&
    /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobileDevice) return <Navigate to="/m" replace />;

  return (
    <ToastProvider>
      <NewVersionWatcher />
      <div className="h-full">
        {/* App chrome is hidden when printing so a report page prints clean
            (only the routed <main> content — e.g. the Hookka Report). */}
        <div className="print:hidden">
          <Sidebar
            collapsed={isMobile ? false : sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
            mobileOpen={mobileNavOpen}
            onMobileClose={closeMobileNav}
          />
        </div>
        {/* Full-width on phones (no rail); rail-padded at md+. Print drops the
            rail offset so content starts at the page edge. */}
        <div className={`pl-0 ${sidebarCollapsed ? "md:pl-14" : "md:pl-60"} transition-all duration-300 print:!pl-0`}>
          <div className="print:hidden">
            <Topbar />
            <Breadcrumbs />
          </div>
          {/* Extra bottom padding on phones so content clears the bottom nav. */}
          <main className="p-4 pb-24 md:p-6 print:!p-0">
            <Routes>{DASHBOARD_ROUTE_ELEMENTS}</Routes>
          </main>
        </div>
        {/* Phone-only bottom navigation; "More" opens the sidebar drawer. */}
        <div className="print:hidden">
          <MobileBottomNav onMore={() => setMobileNavOpen(true)} />
        </div>
        {/* Hookka AI launch button + slide-over panel. SUPER_ADMIN-only.
            Mounted here so the same instance overlays every authenticated
            dashboard route (state survives in-page navigation). */}
        <div className="print:hidden">
          <FloatingChatButton />
        </div>
      </div>
      <ScrollRestoration />
    </ToastProvider>
  );
}
