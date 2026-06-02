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
  type Para,
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

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at wood-cutting cards that still need to be cut — " +
      "the WAITING WOOD_CUT cards pulled live from the orders. Cards already cut, " +
      "on-hold orders and cancelled orders are left out, so the calendar shows the " +
      "real remaining wood-cutting work only.",
  },
  {
    heading: "Wood cutting follows sewing",
    body:
      "The chain runs Fabric Cutting → Fabric Sewing → Wood Cutting, each stage " +
      "planned after the previous one finishes for that order. An order's wood cut " +
      "can only start after its fabric SEWING is done. Wood cutting lags sewing by " +
      "several days, so there is plenty of freedom in the plan.",
  },
  {
    heading: "A whole order is cut together",
    body:
      "A whole SO is cut on the same day — never split across days. A sofa order " +
      "carries its base, arms and back-cushion (and any sectional left/right " +
      "lines), and ALL of it is cut together. This matters most for sofa, where " +
      "splitting an order across days would scatter its parts.",
  },
  {
    heading: "Same model, no size split",
    body:
      "All sizes of a model are cut together, and the same models are placed next " +
      "to each other wherever the sewing-done floor allows, so the cutter changes " +
      "its setup as little as possible.",
  },
  {
    heading: "Priority by customer delivery date",
    body:
      "Orders are ordered by the customer delivery date first — the real promise " +
      "to the customer — then by the earliest day they are ready (the sewing-done " +
      "floor). The earliest promise that is ready goes first.",
  },
  {
    heading: "Working days only",
    body:
      "The calendar runs Monday to Saturday. Sundays and public holidays are " +
      "skipped, so an order is never scheduled on a day the cutters aren't in.",
  },
];

const LOGIC_SECTIONS: Para[] = [
  {
    heading: "Capacity gate (sets per day, per lane)",
    body:
      "The gate is sets per day, where one set = one SO line = one finished bed or " +
      "one sofa. Daily budgets: Bedframe 20 sets/day, Sofa 10 sets/day. Bedframe " +
      "and sofa are cut on separate lanes with separate budgets.",
  },
  {
    heading: "Sew → wood handoff (2 working days)",
    body:
      "An order's floor is (its fabric-sewing done day) + 2 working days — one " +
      "clear buffer day between sewing and wood cutting. On the buffer day the " +
      "wood team has no material for that order, so its people move to other work. " +
      "Orders whose sewing is already done, or that have no sewing step, start from " +
      "day one.",
  },
  {
    heading: "Whole-SO and whole-model grouping",
    body:
      "A whole SO is one indivisible unit on the floor — every line of the order " +
      "is cut on the same day. Within a model, all sizes are cut together, and the " +
      "same model is kept adjacent across SOs where the floor allows.",
  },
  {
    heading: "Priority order",
    body:
      "Earliest Customer DD first, then earliest ready (the sewing-done floor). An " +
      "order that is urgent but not yet ready waits for its floor before it can be " +
      "placed.",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

export default function WoodCuttingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Wood Cutting"
      icon={<Axe className="h-4 w-4 text-[#F59E0B]" />}
      accentColor="#F59E0B"
      snapshot={snapshot as unknown as Snapshot}
      calendarSheetName="Wood Cut Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Wood Cut Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the wood-cutting schedule, kept here as a reference for the owner."
    />
  );
}
