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
    "Upstream",
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
    />
  );
}
