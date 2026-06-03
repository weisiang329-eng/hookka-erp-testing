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
  type Para,
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

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at packing cards that still need to be done — the " +
      "WAITING packing cards pulled live from the orders. Cards already packed, " +
      "on-hold orders and cancelled orders are left out, so the table shows the " +
      "real remaining packing work only.",
  },
  {
    heading: "Packing is the last stage and follows upholstery",
    body:
      "Packing sits at the very end of the line. An order is packed on the SAME " +
      "day its upholstery is done — there is no separate handoff wait. Orders " +
      "whose upholstery is already done are ready to pack from day one.",
  },
  {
    heading: "No capacity cap",
    body:
      "Packing is not capacity-limited — it does not have a daily hour budget like " +
      "the other stages. Whatever finishes upholstery on a day is packed that same " +
      "day, so the packing date simply mirrors the upholstery date.",
  },
  {
    heading: "Day total and lane split",
    body:
      "Each day shows the total number of pieces to pack, plus how many bedframe " +
      "and sofa orders fall on that day, so the packing team can see the day's " +
      "volume and mix at a glance.",
  },
  {
    heading: "Working days only",
    body:
      "The calendar runs Monday to Saturday. Sundays and public holidays are " +
      "skipped, so an order is never scheduled on a day the team isn't in.",
  },
];

const LOGIC_SECTIONS: Para[] = [
  {
    heading: "No capacity gate",
    body:
      "Unlike framing, foam bonding and upholstery, packing keeps no daily hour " +
      "budget. Every order is packed on the day its upholstery completes, so the " +
      "day's load is whatever upholstery delivered that day.",
  },
  {
    heading: "Upstream handoff (same day)",
    body:
      "An order's packing date equals its upholstery date — packing's due date " +
      "rides upholstery. Orders whose upholstery is already done start from day " +
      "one.",
  },
  {
    heading: "Priority",
    body:
      "Because packing follows upholstery one-to-one, its order on the calendar " +
      "inherits the upholstery priority: earliest Customer DD first, then earliest " +
      "ready.",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

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
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the packing schedule, kept here as a reference for the owner."
    />
  );
}
