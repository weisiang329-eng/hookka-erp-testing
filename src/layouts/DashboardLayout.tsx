import { useEffect } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { TabBar } from "@/components/layout/tab-bar";
import { TabbedOutlet } from "@/components/layout/tabbed-outlet";
import { TabsProvider } from "@/contexts/tabs-context";
import { TabsKeyboardShortcuts } from "@/contexts/tabs-keyboard";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { hydrateMasterTemplates } from "@/pages/bom";
import { fetchVariantsConfig } from "@/lib/kv-config";
import { useVersionCheck } from "@/lib/use-version-check";

const mockUser = {
  name: "Lim",
  email: "lim@hookka.com.my",
  role: "Director",
  organisationName: "HOOKKA INDUSTRIES SDN BHD",
  organisationCode: "HOOKKA",
};

// Lives inside ToastProvider so it can pop a toast when a new deploy lands.
// Polls for a new bundle hash every 5 min + on focus; on change, surfaces a
// manual confirm() prompt — we deliberately don't auto-reload because the
// user might be mid-form.
function NewVersionWatcher() {
  const { toast } = useToast();
  useVersionCheck({
    onNewVersion: () => {
      toast.info("新版本已发布 — 请刷新页面以更新 (Ctrl+Shift+R)");
      // After the toast, prompt for reload. Delay so the toast is visible.
      window.setTimeout(() => {
        if (window.confirm("系统有新版本。现在刷新吗?(未保存的表单会丢失)")) {
          window.location.reload();
        }
      }, 1500);
    },
  });
  return null;
}

export default function DashboardLayout() {
  // Hydrate Master BOM Templates from D1 once the dashboard shell mounts.
  // On first run this also migrates any legacy localStorage templates to D1
  // and then wipes the legacy keys.
  useEffect(() => {
    void hydrateMasterTemplates();
    // Prime the variants-config cache from D1 so downstream sync readers
    // (getProductionMinutes, getCategoryOptions in bom.tsx) have real data.
    void fetchVariantsConfig();
  }, []);

  return (
    <ToastProvider>
      <NewVersionWatcher />
      <TabsProvider>
        <TabsKeyboardShortcuts />
        <div className="h-full">
          <Sidebar />
          <div className="pl-60 transition-all duration-300">
            <Topbar user={mockUser} />
            <TabBar />
            <main className="p-6">
              <TabbedOutlet />
            </main>
          </div>
        </div>
      </TabsProvider>
    </ToastProvider>
  );
}
