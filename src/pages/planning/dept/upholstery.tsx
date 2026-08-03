// ---------------------------------------------------------------------------
// Planning > Upholstery department drill-in.
//
// Rich _DepartmentSchedulePage (per-SO grouped calendar), driven live by the
// chain endpoint and falling back to the saved snapshot offline. Upholstery
// (the subcontract stage) runs the working day after its upstream stage:
// bedframe upholstery = framing + 1; sofa upholstery = base foam-bonding + 1.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Upholstery" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Sofa } from "lucide-react";
import snapshot from "@/data/upholstery-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Uph Calendar column layout ─────────────────────────────────────────────
// Sheet columns: 0 Uph Date, 1 Lane, 2 SO ID, 3 Model, 4 Item, 5 Pieces,
// 6 Mins, 7 Customer DD, 8 Upstream done. The first row of each SO carries
// Lane + SO ID; a whole SO is upholstered the same day.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Uph Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Mins",
    "Customer DD",
    "Upstream done",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 7,
  wideCol: 4, // Item
  chips: [
    { label: "piece", kind: "count" },
    { label: "min", kind: "sum", col: 6 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day, 4 SOs, 5 Load h,
// 6 Cap h.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "SOs", "Load h", "Cap h"],
  laneValueCols: [2, 3, 4, 5, 6],
  wideCol: 3,
};

export default function UpholsteryDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Upholstery"
      subtitle="Subcontract upholstery — bedframe & sofa lanes"
      upstream={[
        { label: "Webbing (bedframe)", route: "/planning/dept/webbing" },
        { label: "Foam Bonding (sofa)", route: "/planning/dept/foam-bonding" },
      ]}
      icon={<Sofa className="h-4 w-4 text-[#F43F5E]" />}
      accentColor="#F43F5E"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/upholstery"
      calendarSheetName="Uph Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Upholstery Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
