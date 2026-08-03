// ---------------------------------------------------------------------------
// Planning > Foam Cutting department drill-in.
//
// Foam Cutting is a NEW tracking / scheduling / labor stage placed immediately
// BEFORE Foam Bonding in the production line. It exists so the floor can track
// and schedule the foam-cutting labor step on its own department. Raw material
// is still consumed at Fab Cut — this stage touches no RM.
//
// NOTE: unlike the other planning drill-ins, Foam Cutting does NOT yet have a
// dedicated forward-capacity schedule endpoint or owner-confirmed capacity
// numbers. Building that (a real /api/planning/schedule/foam-cutting with a
// capacity stage) is deliberately deferred — it is scheduling/capacity math
// that must be confirmed with the owner, not guessed. Until then this page
// renders the saved (empty) snapshot via the shared _DepartmentSchedulePage,
// and the live Recalculate button is inert (the fetch 404s and falls back to
// the snapshot). All UI copy is English.
// ---------------------------------------------------------------------------
import { Layers } from "lucide-react";
import snapshot from "@/data/foamcutting-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Foam Cutting Calendar column layout ─────────────────────────────────────
// Sheet columns: 0 Cut Date, 1 Lane, 2 SO ID, 3 Model, 4 Item, 5 Pieces,
// 6 Mins, 7 Customer DD, 8 Upstream.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Cut Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Mins",
    "Customer DD",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 7,
  wideCol: 4, // Item
  chips: [
    { label: "SO", kind: "count" },
    { label: "min", kind: "sum", col: 6 },
  ],
};

// ── By Day column layout ────────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day, 4 SOs, 5 Cut h, 6 Cap h.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "SOs", "Cut h", "Cap h"],
  laneValueCols: [2, 3, 4, 5, 6],
  wideCol: 3,
};

export default function FoamCuttingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Foam Cutting"
      subtitle="Foam cutting — tracking/labor stage before foam bonding"
      upstream={[{ label: "Wood Cutting", route: "/planning/dept/wood-cutting" }]}
      icon={<Layers className="h-4 w-4 text-[#A78BFA]" />}
      accentColor="#A78BFA"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/foam-cutting"
      calendarSheetName="Foam Cutting Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Foam Cutting Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
