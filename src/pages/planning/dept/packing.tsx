// ---------------------------------------------------------------------------
// Planning > Packing department drill-in.
//
// Thin wrapper over the shared _PlainDeptSchedulePage scaffold, supplying the
// "Packing" sheet of the Framing snapshot, curated English Process / Logic
// content, and the sheet's English column titles. Packing is the last stage:
// it is NOT capacity-limited — an order is packed the same day its upholstery
// is done.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Packing" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Package } from "lucide-react";
import snapshot from "@/data/framing-schedule-snapshot.json";
import PlainDeptSchedulePage, {
  type Snapshot,
  type Para,
} from "./_PlainDeptSchedulePage";

// ── Packing column layout ──────────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Total pieces, 3 Bedframe SOs, 4 Sofa SOs,
// 5 SOs (model). One row per working day; the long SO list (col 5) gets width.
const HEADER_OVERRIDE = [
  "Date",
  "Day",
  "Total Pieces",
  "Bedframe SOs",
  "Sofa SOs",
  "SOs (model)",
];

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
    <PlainDeptSchedulePage
      departmentName="Packing"
      subtitle="Final packing — follows upholstery, no capacity cap"
      icon={<Package className="h-4 w-4 text-[#06B6D4]" />}
      accentColor="#06B6D4"
      snapshot={snapshot as unknown as Snapshot}
      sheetName="Packing"
      resultHeading="Packing by Day"
      headerOverride={HEADER_OVERRIDE}
      wideCol={5}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the packing schedule, kept here as a reference for the owner."
    />
  );
}
