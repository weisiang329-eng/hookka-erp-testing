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
  type Para,
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

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at sofa foam-bonding cards that still need to be " +
      "done — the WAITING foam cards pulled live from the orders. Cards already " +
      "bonded, on-hold orders and cancelled orders are left out, so the table " +
      "shows the real remaining foam-bonding work only.",
  },
  {
    heading: "Foam bonding runs after sofa framing",
    body:
      "Foam bonding is a sofa back-end stage. Each sofa's webbing is done the " +
      "same day as its framing, and its foam bonding runs the next working day. " +
      "So an order can only be foam-bonded once its framing day has passed.",
  },
  {
    heading: "Base and armrest set the pace; back cushion rides along",
    body:
      "The day's hour budget counts the base and armrest foam bonding only. The " +
      "back cushion is bonded the same day as its base — it follows the base even " +
      "when the base is pushed to a later day — but its hours do not count toward " +
      "the daily cap. The Base / Armrest / Cushion piece counts are shown per SO.",
  },
  {
    heading: "Priority by customer delivery date",
    body:
      "Orders are ordered by the customer delivery date first — the real promise " +
      "to the customer — then by the earliest day they are ready. A whole order is " +
      "foam-bonded together, never split across days.",
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
    heading: "Capacity gate (production hours per day)",
    body:
      "Sofa base + armrest foam bonding is capped at 8 hours per day (real recent " +
      "average around 6.3 h). When a day is full, the overflow pushes to the next " +
      "working day. The back-cushion bonding does NOT consume this 8-hour budget — " +
      "it simply rides the same day as its base.",
  },
  {
    heading: "Foam -> frame handoff (1 working day)",
    body:
      "An order's foam-bonding floor is (its sofa framing day) + 1 working day — " +
      "bonded the next working day after framing. Orders whose sofa is already " +
      "framed start from day one.",
  },
  {
    heading: "Whole-SO grouping and priority",
    body:
      "A whole sofa SO is foam-bonded on the same day, never split. Priority is " +
      "earliest Customer DD first, then earliest ready (the framing floor).",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

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
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the foam-bonding schedule, kept here as a reference for the owner."
    />
  );
}
