// ---------------------------------------------------------------------------
// Planning > Webbing department drill-in.
//
// Webbing has NO standalone calendar: each SO's webbing is done on the SAME
// day as that SO's framing (different people / stations, run in parallel —
// it does not consume the framing hour budget). So instead of its own
// schedule, this page makes the same-day rule explicit and surfaces the
// per-day webbing volume pulled straight from the framing plan: the same-day
// webbing-pieces column of the Framing snapshot's "By Day" sheet.
//
// Built on the shared _PlainDeptSchedulePage scaffold (same header, snapshot
// caption, Recalculate toast, collapsible Process / Logic sections, and
// snapshot-result Card as the other dept pages) so it stays visually
// consistent. A `resultIntro` banner explains the same-day model, and
// `valueCols` lifts only Date / Day / webbing-pieces / SOs out of the wider
// framing By Day sheet.
//
// Reached from Planning > Capacity Loading / Capacity Overview by clicking the
// "Webbing" department name. All UI copy is English.
// ---------------------------------------------------------------------------
import { LayoutGrid, Frame } from "lucide-react";
import snapshot from "@/data/framing-schedule-snapshot.json";
import PlainDeptSchedulePage, {
  type Snapshot,
  type Para,
} from "./_PlainDeptSchedulePage";

// ── Webbing view of the framing By Day sheet ───────────────────────────────
// The framing "By Day" sheet columns: 0 Date, 1 Day, 2 Bedframe h, 3 cap,
// 4 Sofa h, 5 cap, 6 Bedframe SOs, 7 Sofa SOs, 8 Webbing pieces (same day),
// 9 HB Foam pieces (same day), 10 SOs (model). Webbing rides framing the same
// day, so we lift Date / Day / webbing-pieces / SOs and present them as the
// "same day as framing" volume.
const HEADER_OVERRIDE = [
  "Frame Date (same day)",
  "Day",
  "Webbing Pieces (same day)",
  "SOs framed that day (model)",
];
const VALUE_COLS = [0, 1, 8, 10];

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
      "For each framing day, this page shows how many webbing pieces fall on that " +
      "day (pulled straight from the framing plan's same-day webbing count) and " +
      "which orders are framed — and therefore webbed — that day. To see the full " +
      "framing detail for a day, open the Framing department page.",
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

// Banner shown inside the result Card, above the table — makes the same-day
// model explicit and points to the Framing page for full detail.
const RESULT_INTRO = (
  <div className="flex items-start gap-2 rounded-lg border border-[#D6E9DD] bg-[#EEF7F1] px-4 py-3">
    <Frame className="mt-0.5 h-4 w-4 shrink-0 text-[#0F7A4A]" />
    <p className="text-xs leading-relaxed text-[#2F5740]">
      <strong>Webbing runs the same day as the SO's Framing.</strong> It is done by a separate
      crew at a separate station, in parallel with framing, so it has no schedule of its own.
      The table below is the framing plan seen from webbing's side — each row is a framing day
      with the webbing pieces that ride along on that day. Open the{" "}
      <strong>Framing</strong> department page for the full per-order framing detail.
    </p>
  </div>
);

export default function WebbingDeptPage() {
  return (
    <PlainDeptSchedulePage
      departmentName="Webbing"
      subtitle="Same day as framing — runs in parallel, no separate schedule"
      icon={<LayoutGrid className="h-4 w-4 text-[#10B981]" />}
      accentColor="#10B981"
      snapshot={snapshot as unknown as Snapshot}
      sheetName="By Day"
      resultHeading="Webbing by Day (same day as framing)"
      headerOverride={HEADER_OVERRIDE}
      valueCols={VALUE_COLS}
      wideCol={3}
      processSections={PROCESS_SECTIONS}
      logicSections={LOGIC_SECTIONS}
      logicIntro="The detailed rule set behind the webbing plan, kept here as a reference for the owner."
      resultIntro={RESULT_INTRO}
    />
  );
}
