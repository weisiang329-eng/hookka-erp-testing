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
    "Upstream",
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

export default function FramingDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Framing"
      upstream={[{ label: "Wood Cutting", route: "/planning/dept/wood-cutting" }]}
      icon={<Frame className="h-4 w-4 text-[#F97316]" />}
      accentColor="#F97316"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/framing"
      calendarSheetName="Framing Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Framing Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
      extraSheets={EXTRA_SHEETS}
    />
  );
}
