// ---------------------------------------------------------------------------
// Planning > Upholstery department drill-in.
//
// Thin wrapper over the shared _PlainDeptSchedulePage scaffold, supplying the
// "Upholstery" sheet of the Framing snapshot, curated English Process / Logic
// content, and the sheet's English column titles. Upholstery (the subcontract
// stage) runs the working day after its upstream stage: bedframe upholstery =
// framing + 1; sofa upholstery = base foam-bonding + 1.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Upholstery" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { Sofa } from "lucide-react";
import snapshot from "@/data/framing-schedule-snapshot.json";
import PlainDeptSchedulePage, {
  type Snapshot,
  type Para,
} from "./_PlainDeptSchedulePage";

// ── Upholstery column layout ───────────────────────────────────────────────
// Sheet columns: 0 Date, 1 Day, 2 Bedframe hours, 3 Bedframe cap, 4 Sofa hours,
// 5 Sofa cap, 6 Bedframe SOs, 7 Sofa SOs, 8 SOs (model). One row per working
// day; the long SO list (col 8) gets width.
const HEADER_OVERRIDE = [
  "Date",
  "Day",
  "Bedframe h",
  "Bedframe Cap",
  "Sofa h",
  "Sofa Cap",
  "Bedframe SOs",
  "Sofa SOs",
  "SOs (model)",
];

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
      "round. The table shows each lane's hours used against its cap side by side.",
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
    <PlainDeptSchedulePage
      departmentName="Upholstery"
      subtitle="Subcontract upholstery — bedframe & sofa lanes"
      icon={<Sofa className="h-4 w-4 text-[#F43F5E]" />}
      accentColor="#F43F5E"
      snapshot={snapshot as unknown as Snapshot}
      sheetName="Upholstery"
      resultHeading="Upholstery by Day"
      headerOverride={HEADER_OVERRIDE}
      wideCol={8}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set that drives the upholstery schedule, kept here as a reference for the owner."
    />
  );
}
