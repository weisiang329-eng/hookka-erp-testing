// ---------------------------------------------------------------------------
// /production/:deptCode → per-department route.
//
// Thin wrapper around the shared ProductionPage component with mode="dept".
// The URL segment is the dept code in kebab-case (fab-cut, fab-sew, foam,
// wood-cut, framing, webbing, upholstery, packing). We map it back to the
// UPPER_SNAKE_CASE code the backend + sheet logic expect.
//
// Benefits over the old all-tabs-in-one page:
//   • Backend fetch passes ?dept=CODE so each PO's jobCards array is
//     narrowed to only this dept's JCs. Payload drops from ~1.5MB (minimal)
//     to roughly 1/8 of that for single-dept depts.
//   • No sibling-dept render cost on the client — the matrix overview
//     never mounts on these pages.
//   • Fab Cut merge logic (sofa merge by SO+fabric, BF/ACC merge per PO)
//     is inherited from ProductionPage unchanged; it fires whenever
//     activeTab === "FAB_CUT", which is exactly what we pass here.
// ---------------------------------------------------------------------------
import { useLocation, Navigate } from "react-router-dom";
import ProductionPage from "./index";

// Accepts kebab-case or UPPER_SNAKE directly. Any unknown dept bounces
// back to /production so stray /production/pord-xxxx requests (the legacy
// PO-detail pattern) don't accidentally mount the dept page.
const VALID_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "FOAM_CUTTING",
  "FOAM",
  "WOOD_CUT",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
]);

function normalizeDept(raw: string | undefined): string | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase().replace(/-/g, "_");
  return VALID_DEPTS.has(upper) ? upper : null;
}

export default function ProductionDept() {
  // Routes are registered as LITERAL paths (/production/fab-cut, etc.)
  // not as /:deptCode, so useParams() returns {}. Read the last path
  // segment directly — that's the kebab-case dept code.
  const { pathname } = useLocation();
  const rawDeptCode = pathname.split("/").filter(Boolean).pop();
  const code = normalizeDept(rawDeptCode);
  if (!code) {
    return <Navigate to="/production" replace />;
  }
  // key={code} was added 2026-05-10 to dodge a 50s freeze where in-place
  // dept switching cascaded through 22 intermediate-state re-renders
  // (Wei Siang report). The remount collapsed those into one render —
  // BUT it then introduced its own bug: with ~700-1900 rows per dept,
  // unmount+mount of the entire ProductionPage (5800-line component
  // tree, dozens of useMemos, DataGrid initial shape) took 5-12s, during
  // which React kept the OLD dept committed on screen. From the
  // operator's POV the URL changed but the page froze (Wei Siang
  // 2026-05-12 report).
  //
  // 2026-05-12: dropped `key`, switched ProductionPage to a synchronous
  // useLayoutEffect that atomically clears orders + syncs activeTab when
  // deptCode changes. The original 22-cascade is collapsed by React 18's
  // automatic batching inside the layout effect, and the new dept's H2
  // / sidebar highlight reflect the prop immediately because they read
  // deptCode directly (not the lagging activeTab state). The DataGrid
  // shows a Loading… placeholder while the new dept's fetch is in
  // flight, so the operator can see the click registered. Net cost:
  // single dept switch ~1.5s (the fetch) instead of 5-12s.
  return <ProductionPage mode="dept" deptCode={code} />;
}
