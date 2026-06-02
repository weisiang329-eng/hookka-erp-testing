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
  type Para,
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

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at upholstery cards that still need to be done — " +
      "the WAITING upholstery cards pulled live from the orders. Cards already " +
      "upholstered, on-hold orders and cancelled orders are left out, so the " +
      "table shows the real remaining upholstery work only.",
  },
  {
    heading: "Upholstery follows the stage before it",
    body:
      "Upholstery is a back-end stage and waits on the work just before it. " +
      "Bedframe upholstery runs the next working day after framing (the bedframe " +
      "webbing rides framing the same day, so upholstery is framing + 1). Sofa " +
      "upholstery runs the next working day after the sofa's base foam bonding.",
  },
  {
    heading: "Two separate lanes",
    body:
      "Bedframe and sofa are upholstered with two separate daily hour budgets. A " +
      "sofa-light day cannot be filled with bedframe work, and the other way " +
      "round. The By Day table shows each lane's hours used against its cap.",
  },
  {
    heading: "Priority by customer delivery date",
    body:
      "Within each lane, orders are ordered by the customer delivery date first — " +
      "the real promise to the customer — then by the earliest day they are ready. " +
      "A whole order is upholstered together, never split across days.",
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
    heading: "Capacity gate (production hours per day, per lane)",
    body:
      "Upholstery capacity is measured in production hours per day, split by lane: " +
      "Bedframe 24 h/day, Sofa 12 h/day (set from the last two weeks of real ERP " +
      "history — bedframe around 17 h/day, sofa around 9 h/day). Each order " +
      "consumes its own upholstery minutes from the matching lane's budget; when a " +
      "day is full, the overflow pushes to the next working day.",
  },
  {
    heading: "Upstream handoff (1 working day)",
    body:
      "Bedframe upholstery floor = (its framing day) + 1 working day. Sofa " +
      "upholstery floor = (its base foam-bonding day) + 1 working day. Orders " +
      "whose upstream stage is already done start from day one.",
  },
  {
    heading: "Whole-SO grouping and priority",
    body:
      "A whole SO is upholstered on the same day, never split. Priority is " +
      "earliest Customer DD first, then earliest ready (the upstream floor).",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

export default function UpholsteryDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Upholstery"
      subtitle="Subcontract upholstery — bedframe & sofa lanes"
      icon={<Sofa className="h-4 w-4 text-[#F43F5E]" />}
      accentColor="#F43F5E"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/upholstery"
      calendarSheetName="Uph Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Upholstery Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the upholstery schedule, kept here as a reference for the owner."
    />
  );
}
