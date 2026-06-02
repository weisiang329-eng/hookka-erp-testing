// ---------------------------------------------------------------------------
// Planning > Foam Bonding department drill-in.
//
// Thin wrapper over the shared _PlainDeptSchedulePage scaffold, supplying the
// "Sofa Foam Bonding" sheet of the Framing snapshot, curated English
// Process / Logic content, and the sheet's English column titles. Foam bonding
// is a sofa back-end stage: it runs the working day AFTER each sofa's framing
// (webbing rides framing the same day; foam bonding is +1).
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Foam Bonding" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Layers } from "lucide-react";
import snapshot from "@/data/framing-schedule-snapshot.json";
import PlainDeptSchedulePage, {
  type Snapshot,
  type Para,
} from "./_PlainDeptSchedulePage";

// ── Sofa Foam Bonding column layout ────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Foam hours, 3 cap, 4 pieces Base/Arm/Cushion,
// 5 SOs (model). One row per working day; the long SO list (col 5) gets width.
const HEADER_OVERRIDE = [
  "Date",
  "Day",
  "Foam Hours",
  "Cap",
  "Pieces (Base/Arm/Cushion)",
  "SOs (model)",
];

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
      "the daily cap. The Pieces column shows Base / Armrest / Cushion counts.",
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
    heading: "Foam → frame handoff (1 working day)",
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
    <PlainDeptSchedulePage
      departmentName="Foam Bonding"
      subtitle="Sofa foam bonding — back-end stage after framing"
      icon={<Layers className="h-4 w-4 text-[#8B5CF6]" />}
      accentColor="#8B5CF6"
      snapshot={snapshot as unknown as Snapshot}
      sheetName="Sofa Foam Bonding"
      resultHeading="Foam Bonding by Day"
      headerOverride={HEADER_OVERRIDE}
      wideCol={5}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the foam-bonding schedule, kept here as a reference for the owner."
    />
  );
}
