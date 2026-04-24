// ---------------------------------------------------------------------------
// /production → Overview route.
//
// Thin wrapper around the shared ProductionPage component with
// mode="overview". The in-page tab bar is hidden (users navigate between
// overview and per-dept pages via the sidebar) and the activeTab is locked
// to "ALL" so the matrix view is the only thing rendered.
//
// All heavy logic (data fetching, filter state, merge logic for FAB_CUT,
// print hooks, QR sticker rendering) still lives in ./index.tsx — this file
// is intentionally a near-empty shell so the split has zero behavioral drift.
// ---------------------------------------------------------------------------
import ProductionPage from "./index";

export default function ProductionOverview() {
  return <ProductionPage mode="overview" />;
}
