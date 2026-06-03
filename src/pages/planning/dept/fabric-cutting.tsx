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
  type Para,
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
const PROCESS_SECTIONS: Para[] = [
  {
    heading: "What goes into the schedule",
    body:
      "The planner only looks at fabric-cutting cards that still need to be cut " +
      "— the WAITING FAB_CUT cards pulled live from the orders in the system. " +
      "Cards that are already cut, orders that are on hold, and cancelled orders " +
      "are all left out, so the calendar shows the real remaining cutting work only.",
  },
  {
    heading: "One cut = one model + size",
    body:
      "Cutting is batched by model and size together. Each distinct model+size " +
      "combination is one cut (a setup), because that is how the cutter actually " +
      "changes its layout. A 5FT and a 6FT of the same model are two separate cuts.",
  },
  {
    heading: "Priority by customer delivery date",
    body:
      "Cuts are ordered by the customer delivery date — the real promise to the " +
      "customer. The earliest promise is cut first. Within the same deadline " +
      "window, the same model and size are grouped so the cutter changes its " +
      "layout as little as possible.",
  },
  {
    heading: "Batching inside the pull window",
    body:
      "Orders for the same cut are only merged when their customer delivery dates " +
      "fall close together (the pull window). Orders due much later are not pulled " +
      "forward — they wait for a batch near their own deadline, so fabric isn't cut " +
      "too early and finished pieces don't flood storage.",
  },
  {
    heading: "Big batches get split",
    body:
      "A single cut can only hold so many sets. When a batch is bigger than that, " +
      "it is automatically broken into 2, 3 or more cuts. The first (most urgent) " +
      "cut goes as soon as possible; each later cut is placed just a few working " +
      "days before its own pieces are due.",
  },
  {
    heading: "Shared capacity pool + reserve tiers",
    body:
      "Bedframe and sofa share one pool of cutters per day, with sofa guaranteed a " +
      "minimum so its urgent orders are never starved. Accessory (pillows) has its " +
      "own capacity. Capacity is reserved in tiers so the schedule stays realistic:",
    bullets: [
      "Near days (1–3): packed tight and accurate — these are firm orders.",
      "Mid days (4–7): about one slot a day kept free for new orders walking in.",
      "Far days (8+): left loose, because that future data isn't firm yet.",
    ],
  },
  {
    heading: "Working days only",
    body:
      "The calendar runs Monday to Saturday. Sundays and public holidays are " +
      "skipped, so a cut is never scheduled on a day the cutters aren't in.",
  },
];

// ── (c) Scheduling Logic / Prompt — detailed reference ──────────────────────
const LOGIC_SECTIONS: Para[] = [
  {
    heading: "Capacity gate (models per day)",
    body:
      "The gate is models per day, not sets, not cards, not hours. A model that " +
      "carries a lot of sets takes more than one slot: slots = round-up(sets ÷ " +
      "per-cut cap). Per-cut caps: Bedframe 8 sets, Sofa 3 sets, Accessory 8 sets.",
  },
  {
    heading: "Shared pool and lane ceilings",
    body:
      "Bedframe + sofa draw from one shared pool (full ceiling 8 cuts/day). Each " +
      "lane also has its own ceiling: Bedframe 6, Sofa 6, Accessory 8. Bedframe is " +
      "scheduled first; sofa then fills whatever pool capacity is left, up to its " +
      "own ceiling. Sofa is guaranteed a minimum of 3 cuts/day so it is never " +
      "starved by bedframe.",
  },
  {
    heading: "Reserve-capacity tiers",
    body:
      "The per-day pool budget tightens by how near the day is (so near days are " +
      "accurate and far days keep room for incoming work):",
    bullets: [
      "Working days 1–3 → 7 cuts/day (firm orders, pack tight).",
      "Working days 4–7 → 6 cuts/day (keep ~1 slot/day for new orders).",
      "Working days 8+ → 5 cuts/day (loose; data not firm yet).",
      "Occasional rush ceiling = 8 cuts/day (buffer headroom only).",
    ],
  },
  {
    heading: "Pull window (10 days)",
    body:
      "Only merge same-cut orders whose customer delivery dates fall within 10 days " +
      "of each other. Orders due further out wait for a later batch near their own " +
      "deadline — a middle ground between 'merge everything' and 'cut each piece " +
      "separately'.",
  },
  {
    heading: "Chunk lead (3 days)",
    body:
      "When a batch is split into multiple cuts, the first cut goes ASAP. Each " +
      "later cut is placed only 3 working days before its own pieces' earliest " +
      "customer delivery date, so the cuts aren't jammed together and fabric isn't " +
      "cut too early.",
  },
  {
    heading: "Model clustering (model lead 6 days)",
    body:
      "Cuts of the same model are kept together as a block placed around the " +
      "model's earliest deadline (up to 6 working days before it). This pulls a " +
      "model's later cuts in next to its first cut instead of scattering one model " +
      "across the whole week. Clustering applies to Bedframe and Sofa; sizes within " +
      "a model sort K → Q → SS → S (6FT → 5FT → 3.5FT → 3FT).",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. Accessory (pillow) cutting rate is provisional " +
      "(~4–8/day) and not yet confirmed — flagged in the snapshot notes.",
  },
];

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
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the cutting schedule, kept here as a reference for the owner."
    />
  );
}
