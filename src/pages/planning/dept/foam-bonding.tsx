// ---------------------------------------------------------------------------
// Planning > Foam Bonding department drill-in.
//
// Rich _DepartmentSchedulePage (per-SO grouped calendar), driven live by the
// chain endpoint and falling back to the saved snapshot offline. Foam bonding
// is a sofa back-end stage: it runs the working day AFTER each sofa's framing
// (webbing rides framing the same day; foam bonding is +1). Only base + armrest
// consume the daily hour cap — the back cushion rides the same day uncapped.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Foam Bonding" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Layers } from "lucide-react";
import snapshot from "@/data/foambonding-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Foam Calendar column layout ────────────────────────────────────────────
// Sheet columns: 0 Foam Date, 1 Lane, 2 SO ID, 3 Model, 4 Item, 5 Base,
// 6 Armrest, 7 Cushion, 8 Foam Mins, 9 Customer DD, 10 Frame done. The first
// row of each SO carries Lane + SO ID; a whole SO is bonded the same day.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Foam Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Base",
    "Armrest",
    "Cushion",
    "Foam Mins",
    "Customer DD",
    "Frame done",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 9,
  wideCol: 4, // Item
  chips: [
    { label: "SO", kind: "count" },
    { label: "min", kind: "sum", col: 8 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day, 4 SOs, 5 Foam h,
// 6 Cap h.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "SOs", "Foam h", "Cap h"],
  laneValueCols: [2, 3, 4, 5, 6],
  wideCol: 3,
};

export default function FoamBondingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Foam Bonding"
      subtitle="Sofa foam bonding — back-end stage after framing"
      upstream={[{ label: "Framing", route: "/planning/dept/framing" }]}
      icon={<Layers className="h-4 w-4 text-[#8B5CF6]" />}
      accentColor="#8B5CF6"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/foam-bonding"
      calendarSheetName="Foam Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Foam Bonding Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
