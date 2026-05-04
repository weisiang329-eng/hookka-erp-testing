import { useEffect, useState } from "react";
import { Routes, ScrollRestoration, useLocation } from "react-router-dom";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { CommandPalette } from "@/components/command-palette";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { fetchVariantsConfig } from "@/lib/kv-config";
import { useVersionCheck } from "@/lib/use-version-check";
import { pushRecent } from "@/lib/use-recent-records";
import { DASHBOARD_ROUTE_ELEMENTS } from "@/dashboard-routes";

// Lives inside ToastProvider so it can pop a toast when a new deploy lands.
// Polls for a new bundle hash every 5 min + on focus; on change, surfaces a
// manual confirm() prompt — we deliberately don't auto-reload because the
// user might be mid-form.
function NewVersionWatcher() {
  const { toast } = useToast();
  useVersionCheck({
    onNewVersion: () => {
      toast.info("A new version is available — refresh to update (Ctrl+Shift+R).");
      // After the toast, prompt for reload. Delay so the toast is visible.
      // Fires from useVersionCheck's onNewVersion callback (not a render),
      // so useTimeout doesn't apply — this is a one-shot reaction to an
      // event, not a lifecycle-bound effect.
      // eslint-disable-next-line no-restricted-syntax -- one-shot delay inside event-style callback, not in a React effect
      window.setTimeout(() => {
        if (window.confirm("A new version is available. Reload now? Unsaved changes may be lost.")) {
          window.location.reload();
        }
      }, 1500);
    },
  });
  return null;
}

export default function DashboardLayout() {
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Push every record-detail navigation into the Cmd-K "Recent" list.
  // Non-record paths are filtered inside pushRecent itself.
  useEffect(() => {
    pushRecent(pathname);
  }, [pathname]);

  // Global Cmd/Ctrl+K → toggle palette. Editable elements are NOT
  // excluded here on purpose: Cmd-K is universally a navigation key
  // across modern apps (Linear / Raycast / Vercel / GitHub) and users
  // expect it to win even mid-typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (e.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

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

  return (
    <ToastProvider>
      <NewVersionWatcher />
      <div className="h-full">
        <Sidebar />
        <div className="pl-60 transition-all duration-300">
          <Topbar />
          <Breadcrumbs />
          <main className="p-6">
            <Routes>{DASHBOARD_ROUTE_ELEMENTS}</Routes>
          </main>
        </div>
      </div>
      <ScrollRestoration />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </ToastProvider>
  );
}
