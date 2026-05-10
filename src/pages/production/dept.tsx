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
  // key={code} forces a fresh ProductionPage instance on every dept hop.
  // Without this, navigating /production/upholstery → /production/foam reused
  // the previous instance, leaving the old `orders` array (~2 Upholstery POs)
  // in state while the new dept fetched its own (~1k FOAM POs). The page
  // re-rendered repeatedly through three intermediate states (URL changed →
  // filters cleared → fetch fired → orders arrived → activeTab synced),
  // each one paying the full pickerIndex / baseRows / visibleOrders memo
  // recompute. Operator saw a 50s freeze with the page stuck rendering
  // the old dept's title + records badge — the Foam click that should
  // have shown Foam data sat at "Upholstery — 2 items" until the cascade
  // finished. (Wei Siang 2026-05-10 report.)
  //
  // Remount runs the init effects exactly once with the right inputs,
  // collapsing those 22 sequential long tasks into one render. Cost: the
  // top-bar filter inputs (search / customer / state / category) reset
  // between dept hops — their state is URL-backed anyway and the URL
  // change clears the params, so the visible result is the same. Column
  // filters / sort survive because DataGrid persists those by gridId.
  return <ProductionPage key={code} mode="dept" deptCode={code} />;
}
