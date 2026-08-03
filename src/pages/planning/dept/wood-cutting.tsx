// ---------------------------------------------------------------------------
// Planning > Wood Cutting department drill-in.
//
// Thin wrapper over the shared _DepartmentSchedulePage component, supplying the
// Wood Cutting snapshot, curated English Process / Logic content, and the Wood
// Cut Calendar / By Day column layout. Wood cutting sits downstream in the
// chain (Fab Cut → Fab Sew → Wood Cut): an order's wood cut can only start
// after its fabric sewing is done.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Wood Cutting" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Axe } from "lucide-react";
import snapshot from "@/data/woodcut-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Wood Cut Calendar column layout ────────────────────────────────────────
// Sheet columns: 0 Cut Date, 1 Lane, 2 SO ID, 3 Model, 4 Sizes, 5 Item,
// 6 Pieces (件), 7 Sets, 8 Customer, 9 Customer DD, 10 Sew done. The first row
// of each SO carries Lane + SO ID + Sets; the following item rows leave them
// blank (a whole SO is cut on the same day, never split).
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Cut Date",
    "Lane",
    "SO ID",
    "Model",
    "Sizes",
    "Item",
    "Pieces",
    "Sets",
    "Customer",
    "Customer DD",
    "Sew done",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 9,
  wideCol: 5, // Item
  chips: [
    { label: "item", kind: "count" },
    { label: "piece", kind: "sum", col: 6 },
    { label: "set", kind: "first", col: 7 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day (model), 4 SO count,
// 5 Sets, 6 Cap.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "SOs", "Sets", "Cap"],
  laneValueCols: [2, 3, 4, 5, 6],
  wideCol: 3,
};

export default function WoodCuttingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Wood Cutting"
      upstream={[{ label: "Fabric Sewing", route: "/planning/dept/fabric-sewing" }]}
      icon={<Axe className="h-4 w-4 text-[#F59E0B]" />}
      accentColor="#F59E0B"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/wood-cutting"
      calendarSheetName="Wood Cut Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Wood Cut Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
