// ---------------------------------------------------------------------------
// Planning > Fabric Cutting department drill-in.
//
// Thin wrapper over the shared _DepartmentSchedulePage component: it supplies
// the Fabric Cutting snapshot + curated English Process / Logic content and the
// Cut Calendar / By Day column layout. All rendering (date-grouped calendar
// with per-cut header de-dupe, lane colours, By Day lane-banded table,
// collapsible Process/Logic, snapshot caption, Recalculate toast) lives in the
// shared component so all four department drill-ins behave identically.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Fabric Cutting" department name.
//
// All UI copy is English (project rule). Snapshot DATA may contain mixed text;
// lane labels are mapped to English (Bedframe / Sofa / Accessory) by the shared
// component, every other cell renders as-is.
// ---------------------------------------------------------------------------
import { Scissors } from "lucide-react";
import snapshot from "@/data/cutting-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Cut Calendar column layout ─────────────────────────────────────────────
// Sheet columns: 0 Cut Date, 1 Lane, 2 Cut #, 3 Model, 4 Size, 5 SO/PO,
// 6 Customer, 7 Item, 8 Fabric, 9 Sets, 10 Slots, 11 Customer DD,
// 12 Our Expected DD, 13 Batch Deadline.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Cut Date",
    "Lane",
    "Cut #",
    "Model",
    "Size",
    "SO / PO",
    "Customer",
    "Item",
    "Fabric",
    "Sets",
    "Slots",
    "Customer DD",
    "Our Expected DD",
    "Batch Deadline",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2, // Cut # — non-empty only on a cut's first row
  groupChipPrefix: "Cut",
  cddCol: 11,
  wideCol: 7, // Item
  chips: [
    { label: "order", kind: "count" },
    { label: "set", kind: "sum", col: 9 },
    { label: "slot", kind: "first", col: 10 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 Models that day, 4 Slots, 5 Orders,
// 6 Cap. Date + Day lift into the day-header row; the lane rows show the rest.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "Models that day", "Slots", "Orders", "Cap"],
  laneValueCols: [2, 3, 4, 5, 6],
  wideCol: 3,
};

// ── (a) Scheduling Process — curated, plain English ─────────────────────────
// ── (c) Scheduling Logic / Prompt — detailed reference ──────────────────────
export default function FabricCuttingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Fabric Cutting"
      upstream={[]}
      icon={<Scissors className="h-4 w-4 text-[#3B82F6]" />}
      accentColor="#3B82F6"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/fabric-cutting"
      calendarSheetName="Cut Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Cut Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
