// ===========================================================================
// MobileLayout — the phone (mobile) app shell, mounted at /m.
//
// ADDITIVE: this is an entirely new route subtree. It reuses the SAME
// cookie-based auth/session as the desktop dashboard (gated by <RequireAuth>
// in router.tsx — the user is already logged in), the SAME global fetch
// interceptor (CSRF + credentials), and the SAME design tokens. It does NOT
// touch or import any desktop layout/page, so the existing app is unchanged.
//
// The shell:
//   • centers content to ~414px (phone width) on any viewport,
//   • paints the paper background + system font,
//   • renders its own nested <Routes> for the /m/* screens,
//   • pins the 5-item BottomTabBar (Home · Sales · Production · Procure · More).
//
// Phase 1: Home + More + placeholders. Phase 2 (this): every module's L1 list
// is wired to <ModuleListScreen> driven by its ModuleConfig (config-driven —
// see src/pages/m/config/modules.ts). L2 detail routes (/m/<slug>/:id) land on
// a ComingSoon detail until Phase 3 supplies the real detail screen.
// ===========================================================================
import { useEffect, type ComponentType, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { BottomTabBar, LeftRail } from "./components";
import { M, M_FONT, M_MAX_WIDTH } from "./theme";
import MobileHome from "./screens/Home";
import MobileMore from "./screens/More";
import { ComingSoon } from "./screens/ComingSoon";
import { ModuleListScreen } from "./screens/ModuleListScreen";
import { DocumentDetailScreen } from "./screens/DocumentDetailScreen";
import { LineItemDetailScreen } from "./screens/LineItemDetailScreen";
import { WarehouseScreen } from "./screens/WarehouseScreen";
import { ProductionScreen } from "./screens/ProductionScreen";
import { SalesScreen } from "./screens/SalesScreen";
import { SalesDetailScreen } from "./screens/SalesDetailScreen";
import { ProductionDetailScreen } from "./screens/ProductionDetailScreen";
import { ServiceCasesScreen } from "./screens/ServiceCasesScreen";
import { AnnouncementsScreen } from "./screens/AnnouncementsScreen";
import { MailCenterScreen, MailThreadScreen } from "./screens/MailCenterScreen";
import { MODULE_CONFIGS } from "./config/modules";
import { preloadMobileCritical } from "./lib/preload";
import { bootstrapMobileTheme } from "./lib/theme-mode";
import "./theme-vars.css";

// Apply persisted dark/light mode BEFORE first paint to avoid a flash. This
// runs once at module load time (the import side-effect).
bootstrapMobileTheme();

// Modules whose L1 list is a bespoke screen (not the generic ModuleListScreen).
// Their L2 detail route still uses the config-driven DocumentDetailScreen.
const CUSTOM_L1: Record<string, ComponentType> = {
  sales: SalesScreen,
  servicecases: ServiceCasesScreen,
  announcements: AnnouncementsScreen,
  "mail-center": MailCenterScreen,
  warehouse: WarehouseScreen,
  // Production is a Kanban-style board grouped by current department (dc12
  // design v12) — the generic list flattens that signal. Detail route stays
  // generic via productionConfig.detail.
  production: ProductionScreen,
};

// Modules whose L2 detail is a bespoke screen (v20 alignment) instead of the
// generic DocumentDetailScreen. Sales = the locked create-form + Total/Paid/
// Balance KPI strip + status action bar (v20 MobileSoDetail).
const CUSTOM_L2: Record<string, ComponentType> = {
  sales: SalesDetailScreen,
  production: ProductionDetailScreen,
  "mail-center": MailThreadScreen,
};

export default function MobileLayout() {
  // Kick off background preload of high-traffic endpoints on mount — every
  // subsequent module list navigation paints from cache, not network. Runs
  // once per shell mount (the shell stays mounted for the whole /m session).
  useEffect(() => {
    preloadMobileCritical();
  }, []);

  // Fold detection — owner 2026-06-30: "折叠如果没有展开,应该是在电话
  // 版本的;展开了之后,才在 Fold 版本". Galaxy Z Fold inner screen is
  // ~884px wide in EITHER orientation (portrait or landscape) when unfolded,
  // and the cover screen is ~390px wide when folded. So a single width
  // threshold (>=720) is the correct gate — orientation does NOT enter the
  // decision. Previously required landscape too, which made the inner screen
  // in portrait incorrectly stay on phone mode.
  const fold = useMediaQuery("(min-width: 720px)");
  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: M.paper,
        fontFamily: M_FONT,
        color: M.raisin,
        display: "flex",
        // On fold, lay the left rail + content side-by-side; on phone, just
        // center the content column (rail isn't rendered).
        justifyContent: fold ? "flex-start" : "center",
      }}
    >
      {fold ? <LeftRail /> : null}
      <div
        style={{
          width: "100%",
          // Fold: take all available width (LeftRail eats 198 on the left;
          // the rest is for content + the 2-pane list/detail split).
          // Phone: cap at the centered phone column.
          maxWidth: fold ? "none" : M_MAX_WIDTH,
          flex: fold ? 1 : "none",
          minHeight: "100dvh",
          paddingBottom: fold
            ? "24px"
            : "calc(72px + env(safe-area-inset-bottom))",
          position: "relative",
          // Safety net — clip horizontal overflow so a wide child (chip
          // strip, toolbar buttons, flow indicator) can't cause the WHOLE
          // page to scroll horizontally. Each scrolling sub-region keeps
          // its own overflowX:auto (SubTabs, StatusFlow, etc.).
          overflowX: "hidden",
        }}
      >
        <Routes>
          <Route path="/" element={<MobileHome />} />
          <Route path="/more" element={<MobileMore />} />

          {/* Config-driven L1 lists + L2 document detail.
              When `detail` is supplied + we're on fold, the L2 route renders
              a two-pane shell: parent list on left, detail on right. On
              phone (or list-only routes) it's the standard single-pane.
              Each module with `detail` also gets /:id/item/:itemId for the
              L3 line-item screen. */}
          {MODULE_CONFIGS.map((cfg) => {
            const CustomL1 = CUSTOM_L1[cfg.slug];
            const L1 = CustomL1 ? <CustomL1 /> : <ModuleListScreen config={cfg} />;
            const CustomL2 = CUSTOM_L2[cfg.slug];
            // The L2 detail: a bespoke screen (CUSTOM_L2) wins; else the generic
            // config-driven detail; else a ComingSoon placeholder.
            const L2 = CustomL2 ? (
              <CustomL2 />
            ) : cfg.detail ? (
              <DocumentDetailScreen config={cfg} />
            ) : null;
            return (
            <Route key={cfg.slug}>
              <Route path={cfg.slug} element={L1} />
              <Route
                path={`${cfg.slug}/:id`}
                element={
                  L2 ? (
                    fold ? (
                      <TwoPane left={L1} right={L2} />
                    ) : (
                      L2
                    )
                  ) : (
                    <ComingSoon title={`${cfg.title} detail`} />
                  )
                }
              />
              {cfg.detail ? (
                <Route
                  path={`${cfg.slug}/:id/item/:itemId`}
                  element={
                    fold ? (
                      <TwoPane
                        left={<DocumentDetailScreen config={cfg} />}
                        right={<LineItemDetailScreen config={cfg} />}
                      />
                    ) : (
                      <LineItemDetailScreen config={cfg} />
                    )
                  }
                />
              ) : null}
            </Route>
            );
          })}

          {/* Unknown /m/* → Home. */}
          <Route path="*" element={<MobileHome />} />
        </Routes>
      </div>
      {fold ? null : <BottomTabBar />}
    </div>
  );
}

/** Fold-only 2-pane shell — list (~320px) left, detail right, independent
 * scrollbars. dc13 v13 Fold layout. */
function TwoPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
      <div
        style={{
          width: 340,
          flex: "none",
          borderRight: `1px solid ${M.border}`,
          overflowY: "auto",
          overflowX: "hidden",
          background: M.paper,
        }}
      >
        {left}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {right}
      </div>
    </div>
  );
}
