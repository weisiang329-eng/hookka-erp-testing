import { useEffect } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { TabBar } from "@/components/layout/tab-bar";
import { TabbedOutlet } from "@/components/layout/tabbed-outlet";
import { TabsProvider } from "@/contexts/tabs-context";
import { TabsKeyboardShortcuts } from "@/contexts/tabs-keyboard";
import { ToastProvider } from "@/components/ui/toast";
import { hydrateMasterTemplates } from "@/pages/bom";
import { fetchVariantsConfig } from "@/lib/kv-config";

const mockUser = {
  name: "Lim",
  email: "lim@hookka.com.my",
  role: "Director",
  organisationName: "HOOKKA INDUSTRIES SDN BHD",
  organisationCode: "HOOKKA",
};

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
