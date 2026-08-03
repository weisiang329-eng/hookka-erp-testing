// ---------------------------------------------------------------------------
// Planning > Fabric Sewing department drill-in.
//
// Thin wrapper over the shared _DepartmentSchedulePage component, supplying the
// Fabric Sewing snapshot, curated English Process / Logic content, and the Sew
// Calendar / By Day column layout. Sewing is scheduled ON TOP OF the fabric
// cutting calendar — a card can only be sewn after its fabric is cut.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Fabric Sewing" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Workflow } from "lucide-react";
import snapshot from "@/data/sewing-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Sew Calendar column layout ─────────────────────────────────────────────
// Sheet columns: 0 Lane, 1 SO ID, 2 Customer, 3 Model, 4 Size, 5 PO / Line,
// 6 Item, 7 Qty, 8 Mins, 9 Customer DD, 10 Fabric. The first row of each SO
// carries Lane + SO ID; the following item rows leave them blank.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Lane",
    "SO ID",
    "Customer",
    "Model",
    "Size",
    "PO / Line",
    "Item",
    "Qty",
    "Mins",
    "Customer DD",
    "Fabric",
    "Upstream",
  ],
  laneCol: 0,
  groupKeyCol: 1, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 9,
  wideCol: 6, // Item
  chips: [
    { label: "piece", kind: "count" },
    { label: "qty", kind: "sum", col: 7 },
    { label: "min", kind: "sum", col: 8 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day, 4 Cards, 5 Load h,
// 6 Cap h, 7 Use%, 8 Tier, 9 Cut-blocked h.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "Cards", "Load h", "Cap h", "Use %", "Tier", "Cut-blocked h"],
  laneValueCols: [2, 3, 4, 5, 6, 7, 8, 9],
  wideCol: 3,
};

export default function FabricSewingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Fabric Sewing"
      upstream={[{ label: "Fabric Cutting", route: "/planning/dept/fabric-cutting" }]}
      icon={<Workflow className="h-4 w-4 text-[#6366F1]" />}
      accentColor="#6366F1"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/fabric-sewing"
      calendarSheetName="Sew Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Sew Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
