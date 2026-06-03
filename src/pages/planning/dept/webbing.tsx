// ---------------------------------------------------------------------------
// Planning > Webbing department drill-in.
//
// Webbing has NO standalone schedule: each SO's webbing is done on the SAME day
// as that SO's framing (different people / stations, run in parallel — it does
// not consume the framing hour budget). The live chain emits a per-SO grouped
// "Webbing Calendar" (each row a framing day with the SOs webbed that day) and a
// per-day By Day volume, so this page uses the same rich renderer as the other
// departments. A live fetch drives it; the saved snapshot is the offline
// fallback.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Webbing" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { LayoutGrid } from "lucide-react";
import snapshot from "@/data/webbing-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type Para,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// ── Webbing Calendar column layout ─────────────────────────────────────────
// Sheet columns: 0 Frame Date (same day), 1 Lane, 2 SO ID, 3 Model, 4 Item,
// 5 Webbing Pieces, 6 Webbing Mins, 7 Customer DD. Webbing rides framing the
// same day; each SO appears once on its framing day.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Frame Date (same day)",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Webbing Pieces",
    "Webbing Mins",
    "Customer DD",
  ],
  laneCol: 1,
  groupKeyCol: 2, // SO ID — non-empty only on the SO's first row
  groupChipPrefix: "SO",
  cddCol: 7,
  wideCol: 4, // Item
  chips: [
    { label: "SO", kind: "count" },
    { label: "pc", kind: "sum", col: 5 },
    { label: "min", kind: "sum", col: 6 },
  ],
};

// ── By Day column layout ───────────────────────────────────────────────────
// The webbing By Day sheet has NO lane column — it is one row per framing day:
// 0 Frame Date (same day), 1 Day, 2 Webbing Pieces (same day),
// 3 SOs framed that day (model). Rendered as a plain table; the long SO list
// (col 3) gets extra width.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "plain",
  wideCol: 3,
};

const PROCESS_SECTIONS: Para[] = [
  {
    heading: "Webbing has no separate schedule",
    body:
      "Webbing is not scheduled on its own. Each order's webbing is done on the " +
      "SAME day as that order's framing — so the webbing plan is simply the " +
      "framing plan, read from the webbing team's point of view.",
  },
  {
    heading: "Runs in parallel with framing",
    body:
      "Webbing is done by different people at a different station and runs " +
      "alongside framing. It does NOT eat into the framing hours — it just rides " +
      "along on the same day. That is why webbing does not need its own daily " +
      "capacity budget.",
  },
  {
    heading: "What this page shows",
    body:
      "The calendar groups each framing day's orders so you can see which SOs are " +
      "webbed that day and how many webbing pieces fall on it (pulled straight " +
      "from the framing plan). The By Day table sums the webbing pieces per day.",
  },
  {
    heading: "Sofa webbing is also same-day",
    body:
      "Sofa webbing (base, back cushion and armrest) is likewise done the same " +
      "day as the sofa's framing. Sofa foam bonding then follows the next working " +
      "day — that is the Foam Bonding department's plan.",
  },
  {
    heading: "Working days only",
    body:
      "Because webbing follows framing exactly, it inherits the framing calendar: " +
      "Monday to Saturday, with Sundays and public holidays skipped.",
  },
];

const LOGIC_SECTIONS: Para[] = [
  {
    heading: "Same-day rider — no capacity gate",
    body:
      "Webbing is a same-day rider on framing. Unlike framing, foam bonding and " +
      "upholstery, it has no daily hour budget: whatever is framed on a day is " +
      "webbed on that day, on a separate crew running in parallel.",
  },
  {
    heading: "Date inherited from framing",
    body:
      "A webbing card's date is exactly its framing date — there is no handoff " +
      "wait and no separate floor. Move an order's framing day and its webbing " +
      "moves with it.",
  },
  {
    heading: "Volume pulled from the framing plan",
    body:
      "The per-day webbing piece count on this page comes directly from the " +
      "framing schedule's same-day webbing column, so the two can never drift " +
      "apart.",
  },
  {
    heading: "Calendar boundaries",
    body:
      "Schedule starts 2026-06-02 (1 June is a holiday). Sundays and public " +
      "holidays are skipped. The plan is read-only — nothing is written back to " +
      "the ERP.",
  },
];

export default function WebbingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Webbing"
      subtitle="Same day as framing — runs in parallel, no separate schedule"
      upstream={[{ label: "Framing (same day)", route: "/planning/dept/framing" }]}
      icon={<LayoutGrid className="h-4 w-4 text-[#10B981]" />}
      accentColor="#10B981"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/webbing"
      calendarSheetName="Webbing Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Webbing Calendar (same day as framing)"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set behind the webbing plan, kept here as a reference for the owner."
    />
  );
}
