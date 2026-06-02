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
  type Para,
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

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at fabric-sewing cards that still need to be sewn " +
      "— the WAITING FAB_SEW cards pulled live from the orders. Cards already " +
      "sewn, on-hold orders and cancelled orders are left out, so the calendar " +
      "shows the real remaining sewing work only.",
  },
  {
    heading: "Sewing follows the cutting calendar",
    body:
      "This is the whole point of the sewing plan: a card can only be sewn after " +
      "its fabric is cut. If the fabric is already cut (or there is no cutting " +
      "step), it can be sewn from day one. If the fabric still has to be cut, " +
      "sewing starts the next working day after that order's LAST cut day in the " +
      "cutting calendar. An order that needs several cuts waits for the last one.",
  },
  {
    heading: "Priority by customer delivery date",
    body:
      "Within each crew, cards are ordered by the customer delivery date — the " +
      "real promise to the customer. The earliest promise is sewn first; ties keep " +
      "the shortest job first so the day packs tight.",
  },
  {
    heading: "Two separate crews",
    body:
      "Bedframe and sofa are sewn by two different crews with two separate daily " +
      "buckets. A sofa-light day can't be filled with bedframe work, and the other " +
      "way round. Accessory (pillows) sews on its own small budget.",
  },
  {
    heading: "Pack every day full",
    body:
      "Sewing packs each working day to full capacity with no reserve buffer. " +
      "Walk-in and insert orders are absorbed by overtime, and the whole plan is " +
      "re-cut roughly every three days so it stays current.",
  },
  {
    heading: "Waiting-for-fabric signal",
    body:
      "Each day the plan also counts the spare crew time that sits idle only " +
      "because every remaining card is still waiting for its fabric to be cut. A " +
      "big sofa number here is a clear message: cut more sofa earlier so the sofa " +
      "sewers aren't left standing.",
  },
  {
    heading: "Working days only",
    body:
      "The calendar runs Monday to Saturday. Sundays and public holidays are " +
      "skipped, so a card is never scheduled on a day the sewers aren't in.",
  },
];

const LOGIC_SECTIONS: Para[] = [
  {
    heading: "Capacity gate (hours per day, per crew)",
    body:
      "The gate is production hours per day, split by crew. Daily budgets: Sofa " +
      "35 h/day, Bedframe 20 h/day, Accessory (pillow) 4 h/day. Each card consumes " +
      "its own sewing minutes from the matching crew's budget for that day.",
  },
  {
    heading: "Cut → sew handoff (1 working day)",
    body:
      "An order whose fabric is still to be cut has a sew floor of (that order's " +
      "last cut day) + 1 working day. The cut day comes straight from the cutting " +
      "calendar, keyed by order line. Orders whose fabric is already cut, or that " +
      "have no cutting step, can be sewn from day one.",
  },
  {
    heading: "Pillow standard time override",
    body:
      "The ERP stores 300 minutes per pillow, which is far too high. The sewing " +
      "plan overrides this on read to 15 minutes per pillow — the real bench time " +
      "— so the accessory crew's day isn't wildly over-counted.",
  },
  {
    heading: "No reserve tiers",
    body:
      "Unlike cutting, sewing keeps no near/mid/far reserve tiers — every day is " +
      "packed to 100% of the crew budget. Insert orders ride on overtime, and the " +
      "frequent re-cut of the plan keeps the schedule honest.",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

export default function FabricSewingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Fabric Sewing"
      icon={<Workflow className="h-4 w-4 text-[#6366F1]" />}
      accentColor="#6366F1"
      snapshot={snapshot as unknown as Snapshot}
      calendarSheetName="Sew Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Sew Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the sewing schedule, kept here as a reference for the owner."
    />
  );
}
