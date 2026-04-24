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
import { useParams, Navigate } from "react-router-dom";
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
  const { deptCode: rawDeptCode } = useParams<{ deptCode: string }>();
  const code = normalizeDept(rawDeptCode);
  if (!code) {
    return <Navigate to="/production" replace />;
  }
  return <ProductionPage mode="dept" deptCode={code} />;
}
