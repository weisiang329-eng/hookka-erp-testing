// ---------------------------------------------------------------------------
// Planning > Framing department drill-in.
//
// Thin wrapper over the shared _DepartmentSchedulePage component, supplying the
// Framing snapshot, curated English Process / Logic content, the Framing
// Calendar / By Day column layout, AND framing's downstream-team schedules
// (Sofa Foam Bonding, Upholstery, Packing) rendered as extra collapsible
// tables below the main result. Framing sits late in the chain (Fab Cut →
// Fab Sew → Wood Cut → Framing); webbing + headboard-foam bonding run the same
// day as each order's framing.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Framing" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Frame, Layers, Sofa, Package } from "lucide-react";
import snapshot from "@/data/framing-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type Para,
  type CalendarConfig,
  type ByDayConfig,
  type ExtraSheet,
} from "./_DepartmentSchedulePage";

// ── Framing Calendar column layout ─────────────────────────────────────────
// Sheet columns: 0 Frame Date, 1 Lane, 2 SO ID, 3 Model, 4 Item, 5 Pieces (件),
// 6 Mins (工时), 7 Sets, 8 Webbing same day, 9 HB Foam same day, 10 Customer,
// 11 Customer DD, 12 Wood done. The first row of each SO carries Lane + SO ID +
// Sets; the following item rows leave them blank (a whole SO is framed on the
// same day, never split).
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Frame Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Mins",
    "Sets",
    "Webbing same day",
    "HB Foam same day",
    "Customer",
    "Customer DD",
    "Wood done",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 11,
  wideCol: 4, // Item
  chips: [
    { label: "item", kind: "count" },
    { label: "min", kind: "sum", col: 6 },
    { label: "set", kind: "first", col: 7 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// The Framing By Day sheet has NO lane column — it is one row per day with
// bedframe / sofa as separate columns (床架h / 沙发h / 床架cap / ...). Rendered
// as a plain table; the long "SOs (model)" list (col 10) gets extra width.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "plain",
  wideCol: 10,
};

// ── Framing's downstream-team schedules (extra sheets) ─────────────────────
// These are not framing itself but the teams that run alongside / after it.
// They are plain day-keyed tables; their long "SOs (model)" list is the last
// column and gets extra width.
const EXTRA_SHEETS: ExtraSheet[] = [
  {
    sheetName: "Sofa Foam Bonding",
    title: "Sofa Foam Bonding (downstream)",
    icon: <Layers className="h-4 w-4 text-[#6B5C32]" />,
    wideCol: 5,
  },
  {
    sheetName: "Upholstery",
    title: "Upholstery (downstream)",
    icon: <Sofa className="h-4 w-4 text-[#6B5C32]" />,
    wideCol: 8,
  },
  {
    sheetName: "Packing",
    title: "Packing (downstream)",
    icon: <Package className="h-4 w-4 text-[#6B5C32]" />,
    wideCol: 5,
  },
];

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at framing cards that still need to be done — the " +
      "WAITING FRAMING cards pulled live from the orders. Cards already framed, " +
      "on-hold orders and cancelled orders are left out, so the calendar shows the " +
      "real remaining framing work only.",
  },
  {
    heading: "Framing is the end of the chain",
    body:
      "The chain runs Fabric Cutting → Fabric Sewing → Wood Cutting → Framing. " +
      "Framing for an order can only start after that order's wood cut is done, so " +
      "every earlier stage has to clear first.",
  },
  {
    heading: "Webbing and headboard foam run the same day",
    body:
      "Each order's webbing and headboard-foam bonding happen on the SAME day as " +
      "its framing. They are done by different people at different stations and run " +
      "in parallel, so they do not eat into the framing hours — they just ride " +
      "along. The calendar shows both as 'same day' columns next to each frame.",
  },
  {
    heading: "A whole order is framed together",
    body:
      "A whole SO is framed on the same day — never split across days, so an " +
      "order's parts stay together as it moves to upholstery.",
  },
  {
    heading: "Priority by customer delivery date",
    body:
      "Orders are ordered by the customer delivery date first — the real promise " +
      "to the customer — then by the earliest day they are ready (the wood-cut " +
      "floor). The earliest promise that is ready goes first.",
  },
  {
    heading: "Downstream teams",
    body:
      "Below the framing result, three downstream-team schedules are shown for " +
      "context — Sofa Foam Bonding, Upholstery and Packing. They flow from the " +
      "framing plan and let the owner see the whole back end of the line in one " +
      "place.",
  },
  {
    heading: "Working days only",
    body:
      "The calendar runs Monday to Saturday. Sundays and public holidays are " +
      "skipped, so an order is never scheduled on a day the framing team isn't in.",
  },
];

const LOGIC_SECTIONS: Para[] = [
  {
    heading: "Capacity gate (production hours per day, per lane)",
    body:
      "Framing capacity is measured in production man-hours per day, not set " +
      "count — framing tracks the production-hour output. Bedframe and sofa are " +
      "framed by different teams with their own hour budgets: Bedframe 22 h/day, " +
      "Sofa 8 h/day. Each card consumes its own framing minutes from the matching " +
      "lane's budget for that day.",
  },
  {
    heading: "Wood → frame handoff (1 working day)",
    body:
      "An order's floor is (its wood-cut day) + 1 working day — framed the next " +
      "working day after its wood cut. Orders with no wood-cut waiting (wood " +
      "already done) start from day one.",
  },
  {
    heading: "Same-day riders (webbing + HB foam)",
    body:
      "Each SO's webbing and headboard-foam bonding are scheduled on the same day " +
      "as its framing. They run on separate people / stations and do NOT consume " +
      "the framing hour budget — the calendar surfaces them so the floor can staff " +
      "all three in parallel.",
  },
  {
    heading: "Whole-SO grouping and priority",
    body:
      "A whole SO is framed on the same day, never split. Priority is earliest " +
      "Customer DD first, then earliest ready (the wood-cut floor).",
  },
  {
    heading: "Downstream schedules",
    body:
      "The Sofa Foam Bonding, Upholstery and Packing tables are derived from the " +
      "framing plan and shown as read-only context, so the back end of the line " +
      "can be planned against the same dates.",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

export default function FramingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Framing"
      icon={<Frame className="h-4 w-4 text-[#F97316]" />}
      accentColor="#F97316"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/framing"
      calendarSheetName="Framing Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Framing Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the framing schedule, kept here as a reference for the owner."
      extraSheets={EXTRA_SHEETS}
    />
  );
}
