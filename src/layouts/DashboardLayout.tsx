import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { TabBar } from "@/components/layout/tab-bar";
import { TabbedOutlet } from "@/components/layout/tabbed-outlet";
import { TabsProvider } from "@/contexts/tabs-context";
import { TabsKeyboardShortcuts } from "@/contexts/tabs-keyboard";
import { ToastProvider } from "@/components/ui/toast";

const mockUser = {
  name: "Lim",
  email: "lim@hookka.com.my",
  role: "Director",
  organisationName: "HOOKKA INDUSTRIES SDN BHD",
  organisationCode: "HOOKKA",
};

export default function DashboardLayout() {
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
