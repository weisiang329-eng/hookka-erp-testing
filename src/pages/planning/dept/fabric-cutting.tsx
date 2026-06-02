// ---------------------------------------------------------------------------
// Planning > Fabric Cutting department drill-in (Phase 1, template).
//
// Reached from Planning > Capacity Loading by clicking the "Fabric Cutting"
// department name. The page leads with the actual schedule and keeps the two
// explanatory sections collapsed so it opens compact:
//   (b) Schedule Result — the saved snapshot in
//       src/data/cutting-schedule-snapshot.json rendered as a date-grouped
//       Cut Calendar (each cut headed by an orders/sets/slots summary line) +
//       a By Day summary. This is the FIRST and primary section.
//   (a) Scheduling Process — plain-English explanation of how Fab Cut is
//       scheduled (curated from docs/PRODUCTION-PLANNING-LOGIC.md and
//       scripts/build_cutting_daily_xlsx.py). Collapsed by default.
//   (c) Scheduling Logic / Prompt — the detailed rule reference. Collapsed by
//       default.
//
// The Recalculate button is intentionally inert for this phase: live
// re-scheduling from current orders is a later backend phase. The button
// surfaces a toast saying so, and a caption notes the table is a snapshot.
//
// All UI copy is English (project rule). Snapshot DATA may contain mixed
// text; lane labels are mapped to English (Bedframe / Sofa / Accessory),
// every other cell renders as-is.
// ---------------------------------------------------------------------------
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  RefreshCw,
  Scissors,
  ListChecks,
  CalendarDays,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react";
import snapshot from "@/data/cutting-schedule-snapshot.json";

// ── Snapshot typing ────────────────────────────────────────────────────────
// Every cell is a string or number (Excel cells); rows are arrays of cells.
type Cell = string | number | null;
type Sheet = Cell[][];
type Snapshot = {
  generatedAt: string;
  department: string;
  sheets: Record<string, Sheet>;
};
const SNAP = snapshot as unknown as Snapshot;

// ── Lane label mapping (data may carry mixed-language lane names) ───────────
// The snapshot's Lane column carries mixed-language labels whose English
// word is always present (Bedframe / Sofa / Pillow). Map each to a clean
// English label + a brand-aligned colour so the Cut Calendar reads
// consistently. Match is substring-based on the English word, so a stray
// space/format variant still resolves.
type LaneKey = "BEDFRAME" | "SOFA" | "ACCESSORY";
const LANE_META: Record<LaneKey, { label: string; color: string; tint: string }> = {
  BEDFRAME: { label: "Bedframe", color: "#3B82F6", tint: "#EFF5FF" },
  SOFA: { label: "Sofa", color: "#9C6F1E", tint: "#FBF4E6" },
  ACCESSORY: { label: "Accessory", color: "#4F7C3A", tint: "#EEF5EA" },
};
function resolveLane(raw: Cell): { key: LaneKey | null; label: string } {
  const s = String(raw ?? "");
  if (/bedframe/i.test(s)) return { key: "BEDFRAME", label: LANE_META.BEDFRAME.label };
  if (/sofa/i.test(s)) return { key: "SOFA", label: LANE_META.SOFA.label };
  if (/pillow|accessor/i.test(s)) return { key: "ACCESSORY", label: LANE_META.ACCESSORY.label };
  return { key: null, label: s };
}

// A row whose only non-empty cell is the first one is a date separator
// (e.g. "2026-06-02  Tue   (Day 1)").
function isDateSeparator(row: Cell[]): boolean {
  if (!row.length) return false;
  const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
  return nonEmpty.length === 1 && row[0] !== "" && row[0] != null;
}

const todayISO = new Date().toISOString().slice(0, 10);

// Is a Customer-DD cell a real date that's already past today? Used to tint
// overdue promise dates so the operator spots them at a glance.
function isOverdueDate(cell: Cell): boolean {
  const s = String(cell ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s < todayISO;
}

// ── (a) + (c) curated content ──────────────────────────────────────────────
// Curated/summarised from docs/PRODUCTION-PLANNING-LOGIC.md (STEP 4) and the
// docstring + planner knobs of scripts/build_cutting_daily_xlsx.py. English
// only, written for the factory owner (plain language).

type Para = { heading: string; body: string; bullets?: string[] };

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

// ── Reusable bits ──────────────────────────────────────────────────────────
function SectionParagraphs({ items }: { items: Para[] }) {
  return (
    <div className="space-y-4">
      {items.map((p) => (
        <div key={p.heading}>
          <h4 className="text-sm font-semibold text-[#1F1D1B]">{p.heading}</h4>
          <p className="mt-1 text-sm leading-relaxed text-[#4B4642]">{p.body}</p>
          {p.bullets && (
            <ul className="mt-2 ml-4 list-disc space-y-1 text-sm text-[#4B4642]">
              {p.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ── (b) Cut Calendar — grouped by date separator rows ──────────────────────
const CUT_CALENDAR_HEADERS = [
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
];

// Column indices in the Cut Calendar sheet.
const CUT_NO_COL = 2; // "Cut #" — non-empty only on a cut's first row
const MODEL_COL = 3; // "Model"
const SIZE_COL = 4; // "Size"
const SETS_COL = 9; // "Sets" — one value per item row
const SLOTS_COL = 10; // "Slots" — carried on the cut's first row only

// A cut is one batch: its first item row carries the Cut # / Model / Size /
// Slots; following item rows have a blank Cut #. We group the raw item rows of
// a date into cuts so each cut can show how many orders are batched into it.
type CutBlock = {
  cutNo: string;
  lane: Cell;
  model: string;
  size: string;
  slots: Cell;
  orders: number; // count of item rows in this cut
  sets: number; // sum of the Sets column across the cut's item rows
  rows: Cell[][];
};

function numeric(cell: Cell): number {
  if (typeof cell === "number") return cell;
  const n = parseFloat(String(cell ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

// Split a date group's item rows into cuts. A new cut begins on any row whose
// Cut # cell is non-empty; subsequent blank-Cut# rows belong to that cut.
function buildCutBlocks(rows: Cell[][]): CutBlock[] {
  const blocks: CutBlock[] = [];
  let current: CutBlock | null = null;
  for (const row of rows) {
    const cutNo = String(row[CUT_NO_COL] ?? "").trim();
    if (cutNo) {
      current = {
        cutNo,
        lane: row[LANE_COL],
        model: String(row[MODEL_COL] ?? "").trim(),
        size: String(row[SIZE_COL] ?? "").trim(),
        slots: row[SLOTS_COL],
        orders: 0,
        sets: 0,
        rows: [],
      };
      blocks.push(current);
    }
    if (!current) {
      // Defensive: an item row before any Cut # — start a fallback cut.
      current = {
        cutNo: "—",
        lane: row[LANE_COL],
        model: String(row[MODEL_COL] ?? "").trim(),
        size: String(row[SIZE_COL] ?? "").trim(),
        slots: row[SLOTS_COL],
        orders: 0,
        sets: 0,
        rows: [],
      };
      blocks.push(current);
    }
    current.orders += 1;
    current.sets += numeric(row[SETS_COL]);
    current.rows.push(row);
  }
  return blocks;
}

// Column index for Lane (shared by Cut Calendar grouping + rendering).
const LANE_COL = 1;
// Customer-DD column (overdue tinting).
const CDD_COL = 11;

type CalGroup = { dateLabel: string; rows: Cell[][] };

function buildCalendarGroups(sheet: Sheet | undefined): CalGroup[] {
  if (!sheet || sheet.length < 2) return [];
  const body = sheet.slice(1); // drop header row
  const groups: CalGroup[] = [];
  let current: CalGroup | null = null;
  for (const row of body) {
    if (isDateSeparator(row)) {
      current = { dateLabel: String(row[0]), rows: [] };
      groups.push(current);
      continue;
    }
    // ignore fully-empty rows
    if (row.every((c) => c === "" || c === null || c === undefined)) continue;
    if (!current) {
      current = { dateLabel: "Unscheduled", rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

// A grouped header line that sits above each cut's item rows, stating the
// cut number, lane, model+size, and — what the owner asked for — how many
// orders are batched into the cut, plus total sets and slots.
function CutSummaryRow({ cut, colSpan }: { cut: CutBlock; colSpan: number }) {
  const lane = resolveLane(cut.lane);
  const meta = lane.key ? LANE_META[lane.key] : null;
  const modelSize = [cut.model, cut.size].filter(Boolean).join(" · ");
  const slots = numeric(cut.slots);
  return (
    <tr
      className="border-t border-[#E2DDD8]"
      style={{ backgroundColor: meta ? meta.tint : "#F4F1EE" }}
    >
      <td colSpan={colSpan} className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Cut number chip */}
          <span
            className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold text-white"
            style={{ backgroundColor: meta?.color ?? "#6B7280" }}
          >
            Cut {cut.cutNo}
          </span>
          {/* Lane */}
          {lane.label && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{
                color: meta?.color ?? "#6B7280",
                border: `1px solid ${meta?.color ?? "#D1CFCB"}`,
              }}
            >
              {lane.label}
            </span>
          )}
          {/* Model + size */}
          {modelSize && (
            <span className="text-[13px] font-semibold text-[#1F1D1B]">{modelSize}</span>
          )}
          {/* Order / set / slot counts — the headline numbers */}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-full bg-[#1F1D1B] px-2 py-0.5 text-[11px] font-bold text-white">
              {cut.orders} {cut.orders === 1 ? "order" : "orders"}
            </span>
            <span className="inline-flex items-center rounded-full border border-[#D1CFCB] bg-white px-2 py-0.5 text-[11px] font-semibold text-[#4B4642]">
              {cut.sets} {cut.sets === 1 ? "set" : "sets"}
            </span>
            <span className="inline-flex items-center rounded-full border border-[#D1CFCB] bg-white px-2 py-0.5 text-[11px] font-semibold text-[#4B4642]">
              {slots} {slots === 1 ? "slot" : "slots"}
            </span>
          </span>
        </div>
      </td>
    </tr>
  );
}

function CutCalendar({ sheet }: { sheet: Sheet | undefined }) {
  const groups = useMemo(() => buildCalendarGroups(sheet), [sheet]);
  if (!groups.length) {
    return <p className="text-sm text-[#6B7280]">No cut calendar rows in this snapshot.</p>;
  }
  const colCount = CUT_CALENDAR_HEADERS.length;
  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const cuts = buildCutBlocks(g.rows);
        return (
          <div key={g.dateLabel} className="overflow-hidden rounded-lg border border-[#E2DDD8]">
            <div className="bg-[#F0ECE9] px-3 py-2 text-sm font-semibold text-[#1F1D1B]">
              {g.dateLabel}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FAF8F6] text-left text-[#6B7280]">
                    {CUT_CALENDAR_HEADERS.map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cuts.map((cut) => {
                    const lane = resolveLane(cut.lane);
                    const meta = lane.key ? LANE_META[lane.key] : null;
                    return (
                      <Fragment key={cut.cutNo}>
                        <CutSummaryRow cut={cut} colSpan={colCount} />
                        {cut.rows.map((row, ri) => (
                          <tr
                            key={ri}
                            className="border-t border-[#EFEAE5]"
                            style={meta ? { backgroundColor: meta.tint } : undefined}
                          >
                            {CUT_CALENDAR_HEADERS.map((_, ci) => {
                              const raw = row[ci];
                              if (ci === LANE_COL) {
                                if (!String(raw ?? "").trim()) {
                                  return <td key={ci} className="px-2 py-1.5" />;
                                }
                                return (
                                  <td key={ci} className="whitespace-nowrap px-2 py-1.5">
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                                      style={{ backgroundColor: meta?.color ?? "#6B7280" }}
                                    >
                                      {lane.label}
                                    </span>
                                  </td>
                                );
                              }
                              const overdue = ci === CDD_COL && isOverdueDate(raw);
                              return (
                                <td
                                  key={ci}
                                  className={`px-2 py-1.5 align-top ${
                                    overdue
                                      ? "font-semibold text-[#9A3A2D]"
                                      : "text-[#3A3530]"
                                  } ${ci === 7 ? "min-w-[260px]" : "whitespace-nowrap"}`}
                                  title={overdue ? "Customer delivery date is overdue" : undefined}
                                >
                                  {raw === null || raw === undefined ? "" : String(raw)}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── (b) By Day summary table ───────────────────────────────────────────────
function ByDayTable({ sheet }: { sheet: Sheet | undefined }) {
  if (!sheet || sheet.length < 2) {
    return <p className="text-sm text-[#6B7280]">No By Day summary in this snapshot.</p>;
  }
  const headers = sheet[0];
  const body = sheet.slice(1);
  const LANE_COL = 2; // "Lane" column in the By Day sheet
  return (
    <div className="overflow-x-auto rounded-lg border border-[#E2DDD8]">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-[#F0ECE9] text-left text-[#1F1D1B]">
            {headers.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                {String(h ?? "")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => {
            const lane = resolveLane(row[LANE_COL]);
            const meta = lane.key ? LANE_META[lane.key] : null;
            return (
              <tr
                key={ri}
                className="border-t border-[#EFEAE5]"
                style={meta ? { backgroundColor: meta.tint } : undefined}
              >
                {headers.map((_, ci) => {
                  const raw = row[ci];
                  if (ci === LANE_COL && String(raw ?? "").trim()) {
                    return (
                      <td key={ci} className="whitespace-nowrap px-2 py-1.5">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                          style={{ backgroundColor: meta?.color ?? "#6B7280" }}
                        >
                          {lane.label}
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={ci}
                      className={`px-2 py-1.5 align-top text-[#3A3530] ${
                        ci === 3 ? "min-w-[320px]" : "whitespace-nowrap"
                      }`}
                    >
                      {raw === null || raw === undefined ? "" : String(raw)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Collapsible card wrapper ───────────────────────────────────────────────
function CollapsibleCard({
  icon,
  title,
  defaultOpen,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-6 py-4 text-left hover:bg-[#FAF8F6]"
      >
        <CardTitle className="flex items-center gap-2 text-base text-[#1F1D1B]">
          {icon}
          {title}
        </CardTitle>
        {open ? (
          <ChevronDown className="h-4 w-4 text-[#6B7280]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[#6B7280]" />
        )}
      </button>
      {open && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function FabricCuttingDeptPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const generatedAt = SNAP.generatedAt ?? "unknown date";
  const cutCalendar = SNAP.sheets?.["Cut Calendar"];
  const byDay = SNAP.sheets?.["By Day"];

  function handleRecalculate() {
    toast.info("Live re-scheduling from current orders is coming next.");
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/planning")}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Planning
          </Button>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#3B82F6]/10">
              <Scissors className="h-4 w-4 text-[#3B82F6]" />
            </span>
            <div>
              <h1 className="text-lg font-semibold text-[#1F1D1B]">Fabric Cutting</h1>
              <p className="text-xs text-[#6B7280]">Department schedule &amp; logic</p>
            </div>
          </div>
        </div>
        <Button variant="primary" onClick={handleRecalculate} className="gap-1.5">
          <RefreshCw className="h-4 w-4" />
          Recalculate
        </Button>
      </div>

      {/* Snapshot caption */}
      <div className="flex items-start gap-2 rounded-lg border border-[#E2DDD8] bg-[#FAF8F6] px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#6B5C32]" />
        <p className="text-xs leading-relaxed text-[#4B4642]">
          The Schedule Result below is a <strong>saved snapshot</strong> generated on{" "}
          <strong>{generatedAt}</strong>. The Recalculate button does not re-run the
          schedule yet — live re-scheduling from current orders is the next phase.
        </p>
      </div>

      {/* (b) Schedule Result — primary section, leads the page */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base text-[#1F1D1B]">
            <span className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-[#6B5C32]" />
              Schedule Result
            </span>
            <span className="text-xs font-normal text-[#6B7280]">
              Snapshot · {generatedAt}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Lane legend */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[#4B4642]">
            <span className="font-medium text-[#6B7280]">Lanes:</span>
            {(Object.keys(LANE_META) as LaneKey[]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: LANE_META[k].color }}
                />
                {LANE_META[k].label}
              </span>
            ))}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-[#1F1D1B]">Cut Calendar</h3>
            <CutCalendar sheet={cutCalendar} />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-[#1F1D1B]">By Day Summary</h3>
            <ByDayTable sheet={byDay} />
          </div>
        </CardContent>
      </Card>

      {/* (a) Scheduling Process — reference, collapsed by default */}
      <CollapsibleCard
        icon={<ListChecks className="h-4 w-4 text-[#6B5C32]" />}
        title="Scheduling Process"
        defaultOpen={false}
      >
        <SectionParagraphs items={PROCESS_SECTIONS} />
      </CollapsibleCard>

      {/* (c) Scheduling Logic / Prompt — reference, collapsed by default */}
      <CollapsibleCard
        icon={<BookOpen className="h-4 w-4 text-[#6B5C32]" />}
        title="Scheduling Logic / Prompt"
        defaultOpen={false}
      >
        <p className="mb-4 text-xs leading-relaxed text-[#6B7280]">
          The detailed rule set that drives the cutting schedule, kept here as a
          reference for the owner.
        </p>
        <SectionParagraphs items={LOGIC_SECTIONS} />
      </CollapsibleCard>
    </div>
  );
}
