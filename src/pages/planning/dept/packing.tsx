// ---------------------------------------------------------------------------
// Planning > Packing department drill-in.
//
// Rich _DepartmentSchedulePage (per-SO grouped calendar), driven live by the
// chain endpoint and falling back to the saved snapshot offline. Packing is the
// last stage: it is NOT capacity-limited — an order is packed the same day its
// upholstery is done.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Packing" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Package } from "lucide-react";
import snapshot from "@/data/packing-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Pack Calendar column layout ────────────────────────────────────────────
// Sheet columns: 0 Pack Date, 1 Lane, 2 SO ID, 3 Model, 4 Item, 5 Pieces,
// 6 Customer DD, 7 Uph done. The first row of each SO carries Lane + SO ID;
// a whole SO is packed the same day its upholstery completes.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Pack Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Customer DD",
    "Uph done",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 6,
  wideCol: 4, // Item
  chips: [
    { label: "piece", kind: "count" },
    { label: "pc", kind: "sum", col: 5 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day, 4 SOs, 5 Total Pieces.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "SOs", "Total Pieces"],
  laneValueCols: [2, 3, 4, 5],
  wideCol: 3,
};

export default function PackingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Packing"
      subtitle="Final packing — follows upholstery, no capacity cap"
      upstream={[{ label: "Upholstery", route: "/planning/dept/upholstery" }]}
      icon={<Package className="h-4 w-4 text-[#06B6D4]" />}
      accentColor="#06B6D4"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/packing"
      calendarSheetName="Pack Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Packing Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
