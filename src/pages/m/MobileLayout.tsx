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
import { type ComponentType } from "react";
import { Route, Routes } from "react-router-dom";
import { BottomTabBar } from "./components";
import { M, M_FONT, M_MAX_WIDTH } from "./theme";
import MobileHome from "./screens/Home";
import MobileMore from "./screens/More";
import { ComingSoon } from "./screens/ComingSoon";
import { ModuleListScreen } from "./screens/ModuleListScreen";
import { DocumentDetailScreen } from "./screens/DocumentDetailScreen";
import { LineItemDetailScreen } from "./screens/LineItemDetailScreen";
import { WarehouseScreen } from "./screens/WarehouseScreen";
import { MODULE_CONFIGS } from "./config/modules";

// Modules whose L1 list is a bespoke screen (not the generic ModuleListScreen).
// Their L2 detail route still uses the config-driven DocumentDetailScreen.
const CUSTOM_L1: Record<string, ComponentType> = {
  warehouse: WarehouseScreen,
};

export default function MobileLayout() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: M.paper,
        fontFamily: M_FONT,
        color: M.raisin,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: M_MAX_WIDTH,
          minHeight: "100dvh",
          // Clear the fixed bottom tab bar (56px + safe area).
          paddingBottom: "calc(72px + env(safe-area-inset-bottom))",
          position: "relative",
        }}
      >
        <Routes>
          <Route path="/" element={<MobileHome />} />
          <Route path="/more" element={<MobileMore />} />

          {/* Config-driven L1 lists + L2 document detail (Phase 3).
              When a module declares `detail`, /m/<slug>/:id renders the generic
              <DocumentDetailScreen> and /m/<slug>/:id/item/:itemId the minimal
              L3 line-item view. Modules with no per-id endpoint fall back to a
              ComingSoon detail. */}
          {MODULE_CONFIGS.map((cfg) => {
            const CustomL1 = CUSTOM_L1[cfg.slug];
            return (
            <Route key={cfg.slug}>
              <Route
                path={cfg.slug}
                element={
                  CustomL1 ? <CustomL1 /> : <ModuleListScreen config={cfg} />
                }
              />
              <Route
                path={`${cfg.slug}/:id`}
                element={
                  cfg.detail ? (
                    <DocumentDetailScreen config={cfg} />
                  ) : (
                    <ComingSoon title={`${cfg.title} detail`} />
                  )
                }
              />
              {cfg.detail ? (
                <Route
                  path={`${cfg.slug}/:id/item/:itemId`}
                  element={<LineItemDetailScreen config={cfg} />}
                />
              ) : null}
            </Route>
            );
          })}

          {/* Unknown /m/* → Home. */}
          <Route path="*" element={<MobileHome />} />
        </Routes>
      </div>
      <BottomTabBar />
    </div>
  );
}
