// ---------------------------------------------------------------------------
// Planning > department drill-in — SHARED page component.
//
// Reached from Planning (Capacity Overview / Capacity Loading) by clicking a
// department name. Extracted from the original Fabric Cutting page so all four
// production-department drill-ins (Fabric Cutting, Fabric Sewing, Wood Cutting,
// Framing) render from ONE component, driven by per-department props.
//
// The page renders (top -> bottom):
//   header + Recalculate button + snapshot caption
//   Schedule Result — the saved snapshot: a date-grouped Calendar (each
//       order/cut headed by a count summary line) + a By Day summary, open by
//       default. Framing additionally renders its downstream-team schedules
//       (Sofa Foam Bonding, Upholstery, Packing) as extra collapsible tables.
//
// The prose "Scheduling Process" and "Scheduling Logic / Prompt" panels were
// removed 2026-08-03 (owner): they described the scheduler in hand-written
// paragraphs that no test or type checked, so they drifted out of step with
// planning-chain.ts / planning-scheduler.ts and became actively misleading.
// The engine's behaviour is documented at its source instead.
//
// The Recalculate button is intentionally inert: live re-scheduling from
// current orders is a later backend phase. It surfaces a toast saying so, and
// a caption notes the table is a snapshot.
//
// All UI copy is English (project rule). Snapshot DATA may contain mixed text;
// lane labels are mapped to English (Bedframe / Sofa / Accessory), every other
// cell renders as-is.
// ---------------------------------------------------------------------------
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { formatDate } from "@/lib/utils";
import { Link, useNavigate } from "react-router-dom";
import { fetchJson, passthrough } from "@/lib/fetch-json";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  RefreshCw,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Info,
  CornerLeftUp,
} from "lucide-react";

// ── Snapshot typing ────────────────────────────────────────────────────────
// Every cell is a string or number (Excel cells); rows are arrays of cells.
export type Cell = string | number | null;
export type Sheet = Cell[][];
export type Snapshot = {
  generatedAt: string;
  department: string;
  sheets: Record<string, Sheet>;
};

// ── Curated explanatory content typing ─────────────────────────────────────

// ── Lane label mapping (data may carry mixed-language lane names) ───────────
// The snapshot's Lane column carries mixed-language labels whose English word
// is always present (Bedframe / Sofa / Pillow). Map each to a clean English
// label + a brand-aligned colour so the calendar reads consistently. Match is
// substring-based on the English word, so a stray space/format variant still
// resolves.
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

function numeric(cell: Cell): number {
  if (typeof cell === "number") return cell;
  const n = parseFloat(String(cell ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

// ── Calendar configuration (per department) ────────────────────────────────
// Each department's calendar sheet shares the same shape — date-separator rows
// split the body into days; inside a day, rows group into ORDERS/CUTS where the
// first row of each group carries the group key (a Cut # for cutting, an SO ID
// for the others) and the lane, and the following item rows leave them blank.
// The config describes which columns hold which meaning so ONE renderer covers
// all four sheets.
//
// A chip is a small summary pill on each group's header line. `kind`:
//   "count"       — number of item rows in the group (e.g. orders / pieces)
//   "sum"         — sum of `col` across the group's item rows (e.g. sets / mins)
//   "first"       — the value of `col` on the group's first row (e.g. slots)
export type ChipDef = {
  label: string; // unit word, e.g. "order" — pluralised automatically
  kind: "count" | "sum" | "first";
  col?: number; // required for "sum" / "first"
};

export type CalendarConfig = {
  headers: string[];
  laneCol: number; // column carrying the lane label
  groupKeyCol: number; // a non-empty value here starts a new group
  groupChipPrefix: string; // e.g. "Cut" -> "Cut B1", or "SO" -> "SO SO-2605-131"
  cddCol: number | null; // Customer-DD column to tint when overdue (null = none)
  wideCol: number | null; // a free-text column given extra min-width (e.g. Item)
  chips: ChipDef[];
};

// A group is one order/cut: its first item row carries the group key, lane, and
// any "first"-kind chip columns; the following item rows continue it.
type Group = {
  groupKey: string;
  lane: Cell;
  firstRow: Cell[];
  rows: Cell[][];
};

function buildGroups(rows: Cell[][], cfg: CalendarConfig): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const row of rows) {
    const key = String(row[cfg.groupKeyCol] ?? "").trim();
    if (key || !current) {
      current = {
        groupKey: key || "—",
        lane: row[cfg.laneCol],
        firstRow: row,
        rows: [],
      };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

function chipValue(chip: ChipDef, group: Group): number {
  if (chip.kind === "count") return group.rows.length;
  if (chip.kind === "first") return numeric(group.firstRow[chip.col ?? -1]);
  // "sum"
  return group.rows.reduce((s, r) => s + numeric(r[chip.col ?? -1]), 0);
}

function pluralise(label: string, n: number): string {
  if (n === 1) return label;
  if (/y$/.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

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
    if (row.every((c) => c === "" || c === null || c === undefined)) continue;
    if (!current) {
      current = { dateLabel: "Unscheduled", rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

// ── Reusable bits ──────────────────────────────────────────────────────────
// A grouped header line that sits above each group's item rows: the group key
// chip (Cut B1 / SO SO-2605-131), the lane, and the count summary chips the
// owner asked for (orders / sets / slots, or pieces / sets / mins, etc.).
function GroupSummaryRow({
  group,
  cfg,
  colSpan,
}: {
  group: Group;
  cfg: CalendarConfig;
  colSpan: number;
}) {
  const lane = resolveLane(group.lane);
  const meta = lane.key ? LANE_META[lane.key] : null;
  return (
    <tr
      className="border-t border-[#E2DDD8]"
      style={{ backgroundColor: meta ? meta.tint : "#F4F1EE" }}
    >
      <td colSpan={colSpan} className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Group key chip */}
          <span
            className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold text-white"
            style={{ backgroundColor: meta?.color ?? "#6B7280" }}
          >
            {cfg.groupChipPrefix} {group.groupKey}
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
          {/* Count chips — the headline numbers */}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {cfg.chips.map((chip, i) => {
              const v = chipValue(chip, group);
              const first = i === 0;
              return (
                <span
                  key={chip.label}
                  className={
                    first
                      ? "inline-flex items-center rounded-full bg-[#1F1D1B] px-2 py-0.5 text-[11px] font-bold text-white"
                      : "inline-flex items-center rounded-full border border-[#D1CFCB] bg-white px-2 py-0.5 text-[11px] font-semibold text-[#4B4642]"
                  }
                >
                  {v} {pluralise(chip.label, v)}
                </span>
              );
            })}
          </span>
        </div>
      </td>
    </tr>
  );
}

function Calendar({ sheet, cfg }: { sheet: Sheet | undefined; cfg: CalendarConfig }) {
  const groups = useMemo(() => buildCalendarGroups(sheet), [sheet]);
  if (!groups.length) {
    return <p className="text-sm text-[#6B7280]">No calendar rows in this snapshot.</p>;
  }
  const colCount = cfg.headers.length;
  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const built = buildGroups(g.rows, cfg);
        return (
          <div key={g.dateLabel} className="overflow-hidden rounded-lg border border-[#E2DDD8]">
            <div className="bg-[#F0ECE9] px-3 py-2 text-sm font-semibold text-[#1F1D1B]">
              {g.dateLabel}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FAF8F6] text-left text-[#6B7280]">
                    {cfg.headers.map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {built.map((group, gi) => {
                    const lane = resolveLane(group.lane);
                    const meta = lane.key ? LANE_META[lane.key] : null;
                    return (
                      <Fragment key={`${group.groupKey}-${gi}`}>
                        <GroupSummaryRow group={group} cfg={cfg} colSpan={colCount} />
                        {group.rows.map((row, ri) => (
                          <tr
                            key={ri}
                            className="border-t border-[#EFEAE5]"
                            style={meta ? { backgroundColor: meta.tint } : undefined}
                          >
                            {cfg.headers.map((_, ci) => {
                              const raw = row[ci];
                              if (ci === cfg.laneCol) {
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
                              const overdue = ci === cfg.cddCol && isOverdueDate(raw);
                              return (
                                <td
                                  key={ci}
                                  className={`px-2 py-1.5 align-top ${
                                    overdue
                                      ? "font-semibold text-[#9A3A2D]"
                                      : "text-[#3A3530]"
                                  } ${ci === cfg.wideCol ? "min-w-[260px]" : "whitespace-nowrap"}`}
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

// ── By Day summary table ───────────────────────────────────────────────────
// Two shapes, picked by config:
//   • lane-banded (cutting / sewing / wood): the By Day sheet has a Lane column
//     and one row per (day × lane). We lift Date + Day into a single day-header
//     row shown once, then colour-band each lane row beneath it. The remaining
//     columns (after Date/Day) are shown on each lane row.
//   • plain (framing): the By Day sheet has no Lane column — it's one row per
//     day with bedframe/sofa as separate columns. We render it as a plain table.
export type ByDayConfig =
  | {
      mode: "lane";
      dateCol: number;
      dayCol: number;
      laneCol: number;
      // Columns shown on each lane row (Date + Day are lifted into the header).
      laneHeaders: string[];
      laneValueCols: number[];
      wideCol: number | null; // a value col given extra min-width (e.g. models list)
    }
  | { mode: "plain"; wideCol: number | null };

type ByDayGroup = { dateLabel: string; dayLabel: string; rows: Cell[][] };

function buildByDayGroups(
  body: Cell[][],
  dateCol: number,
  dayCol: number,
): ByDayGroup[] {
  const groups: ByDayGroup[] = [];
  let current: ByDayGroup | null = null;
  for (const row of body) {
    const dateLabel = String(row[dateCol] ?? "").trim();
    if (!dateLabel) continue;
    const dayCell = row[dayCol];
    const dayLabel =
      dayCell === "" || dayCell === null || dayCell === undefined
        ? ""
        : `Day ${String(dayCell)}`;
    if (!current || current.dateLabel !== dateLabel) {
      current = { dateLabel, dayLabel, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

function ByDayLaneTable({
  sheet,
  cfg,
}: {
  sheet: Sheet | undefined;
  cfg: Extract<ByDayConfig, { mode: "lane" }>;
}) {
  const groups = useMemo(
    () =>
      sheet && sheet.length >= 2
        ? buildByDayGroups(sheet.slice(1), cfg.dateCol, cfg.dayCol)
        : [],
    [sheet, cfg.dateCol, cfg.dayCol],
  );
  if (!groups.length) {
    return <p className="text-sm text-[#6B7280]">No By Day summary in this snapshot.</p>;
  }
  const colCount = cfg.laneHeaders.length;
  return (
    <div className="overflow-x-auto rounded-lg border border-[#E2DDD8]">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-[#F0ECE9] text-left text-[#1F1D1B]">
            {cfg.laneHeaders.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.dateLabel}>
              {/* Day group header — shown once per calendar day */}
              <tr className="border-t-2 border-[#D8D2CC] bg-[#EAE5E0]">
                <td colSpan={colCount} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CalendarDays className="h-3.5 w-3.5 text-[#6B5C32]" />
                    <span className="text-[13px] font-bold text-[#1F1D1B]">{g.dateLabel}</span>
                    {g.dayLabel && (
                      <span className="inline-flex items-center rounded-full bg-[#1F1D1B] px-2 py-0.5 text-[11px] font-semibold text-white">
                        {g.dayLabel}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
              {/* Lane rows for this day — colour-banded by lane */}
              {g.rows.map((row, ri) => {
                const lane = resolveLane(row[cfg.laneCol]);
                const meta = lane.key ? LANE_META[lane.key] : null;
                return (
                  <tr
                    key={ri}
                    className="border-t border-[#EFEAE5]"
                    style={meta ? { backgroundColor: meta.tint } : undefined}
                  >
                    {cfg.laneValueCols.map((ci) => {
                      const raw = row[ci];
                      if (ci === cfg.laneCol) {
                        return (
                          <td key={ci} className="whitespace-nowrap px-2 py-1.5">
                            {String(raw ?? "").trim() ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                                style={{ backgroundColor: meta?.color ?? "#6B7280" }}
                              >
                                {lane.label}
                              </span>
                            ) : null}
                          </td>
                        );
                      }
                      return (
                        <td
                          key={ci}
                          className={`px-2 py-1.5 align-top text-[#3A3530] ${
                            ci === cfg.wideCol ? "min-w-[320px]" : "whitespace-nowrap"
                          }`}
                        >
                          {raw === null || raw === undefined ? "" : String(raw)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A plain sheet renderer (header row + body rows, no grouping). Used for the By
// Day sheets that have no lane column (framing) and for framing's extra
// downstream-team sheets. The first column (a date) is given a left emphasis;
// `wideCol` gets extra min-width for long model lists.
function PlainSheetTable({
  sheet,
  wideCol,
}: {
  sheet: Sheet | undefined;
  wideCol: number | null;
}) {
  if (!sheet || sheet.length < 2) {
    return <p className="text-sm text-[#6B7280]">No rows in this snapshot.</p>;
  }
  const headers = sheet[0];
  const body = sheet
    .slice(1)
    .filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined));
  return (
    <div className="overflow-x-auto rounded-lg border border-[#E2DDD8]">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-[#F0ECE9] text-left text-[#1F1D1B]">
            {headers.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                {h === null || h === undefined ? "" : String(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-t border-[#EFEAE5]">
              {headers.map((_, ci) => {
                const raw = row[ci];
                return (
                  <td
                    key={ci}
                    className={`px-2 py-1.5 align-top text-[#3A3530] ${
                      ci === 0 ? "whitespace-nowrap font-medium text-[#1F1D1B]" : ""
                    } ${ci === wideCol ? "min-w-[320px]" : "whitespace-nowrap"}`}
                  >
                    {raw === null || raw === undefined ? "" : String(raw)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ByDayTable({ sheet, cfg }: { sheet: Sheet | undefined; cfg: ByDayConfig }) {
  if (cfg.mode === "lane") return <ByDayLaneTable sheet={sheet} cfg={cfg} />;
  return <PlainSheetTable sheet={sheet} wideCol={cfg.wideCol} />;
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

// ── Extra downstream sheet (Framing only) ──────────────────────────────────
// A framing-only downstream-team schedule (Sofa Foam Bonding / Upholstery /
// Packing), rendered as its own collapsible plain table below the main result.
export type ExtraSheet = {
  /** Sheet name inside the snapshot. */
  sheetName: string;
  /** English heading shown on the collapsible card. */
  title: string;
  /** Icon for the card header. */
  icon: React.ReactNode;
  /** Value column given extra min-width (the long "SOs (model)" list). */
  wideCol: number | null;
};

// ── Upstream department reference ──────────────────────────────────────────
// Each department's schedule floors on the stage before it (e.g. framing =
// wood-cut day + 1). This reference lets the operator jump to the upstream
// department's page and check the previous stage's plan before reading this
// one. `route` is a dept route such as "/planning/dept/wood-cutting"; pass an
// empty array (or omit) for the first stage, which has no upstream.
export type Upstream = { label: string; route: string };

// ── Page ───────────────────────────────────────────────────────────────────
export type DepartmentSchedulePageProps = {
  /** Display name, e.g. "Fabric Cutting". */
  departmentName: string;
  /** Short tagline under the title. */
  subtitle?: string;
  /** Icon element shown in the header badge. */
  icon: React.ReactNode;
  /** Accent colour for the header badge (brand palette hex). */
  accentColor: string;
  /** The imported snapshot JSON object — used as the fallback when fetchUrl
   *  is unset or the live fetch fails, so the page never breaks. */
  snapshot: Snapshot;
  /** Optional live endpoint. When set, the page fetches this URL on mount (and
   *  on Recalculate) and renders the response as the snapshot; any error falls
   *  back to the imported static `snapshot`. */
  fetchUrl?: string;
  /** Calendar sheet name + its column layout. */
  calendarSheetName: string;
  calendarConfig: CalendarConfig;
  /** Heading shown above the calendar table (e.g. "Cut Calendar"). */
  calendarHeading: string;
  /** By Day sheet name + its render config. */
  byDaySheetName: string;
  byDayConfig: ByDayConfig;
  /** Optional downstream sheets (Framing) rendered below the main result. */
  extraSheets?: ExtraSheet[];
  /** Optional upstream department(s) this stage depends on. Rendered as a
   *  small reference near the top with react-router links so the operator can
   *  jump to the previous stage's plan. Omit (or pass []) for the first stage,
   *  which shows a "First stage" note instead. */
  upstream?: Upstream[];
};

export default function DepartmentSchedulePage(props: DepartmentSchedulePageProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Live schedule, when a fetchUrl is supplied. Starts as the imported static
  // snapshot (so the first paint is never blank) and is replaced by the live
  // recompute once it arrives. Any fetch error keeps the static fallback so the
  // page never breaks.
  const [liveSnap, setLiveSnap] = useState<Snapshot | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadLive = useCallback(
    async (announce: boolean) => {
      if (!props.fetchUrl) return;
      setLoading(true);
      try {
        const data = (await fetchJson(props.fetchUrl, passthrough)) as Snapshot;
        if (!data || typeof data !== "object" || !data.sheets) {
          throw new Error("malformed schedule response");
        }
        setLiveSnap(data);
        setIsLive(true);
        if (announce) toast.success("Schedule recalculated from current orders.");
      } catch {
        // Keep the static fallback; surface a gentle note only on an explicit
        // Recalculate so the page never appears broken on first load.
        setIsLive(false);
        if (announce) {
          toast.error("Could not load the live schedule — showing the saved snapshot.");
        }
      } finally {
        setLoading(false);
      }
    },
    [props.fetchUrl, toast],
  );

  useEffect(() => {
    // loadLive sets state only AFTER an async fetch (not synchronously), so the
    // set-state-in-effect rule is a false positive for this mount-time load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadLive(false);
  }, [loadLive]);

  const SNAP = liveSnap ?? props.snapshot;
  const generatedAt = SNAP.generatedAt ? formatDate(SNAP.generatedAt) : "unknown date";
  const calendarSheet = SNAP.sheets?.[props.calendarSheetName];
  const byDaySheet = SNAP.sheets?.[props.byDaySheetName];

  function handleRecalculate() {
    if (props.fetchUrl) {
      void loadLive(true);
    } else {
      toast.info("Live re-scheduling from current orders is coming next.");
    }
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
            <span
              className="flex h-8 w-8 items-center justify-center rounded-md"
              style={{ backgroundColor: `${props.accentColor}1A` }}
            >
              {props.icon}
            </span>
            <div>
              <h1 className="text-lg font-semibold text-[#1F1D1B]">{props.departmentName}</h1>
              <p className="text-xs text-[#6B7280]">
                {props.subtitle ?? "Department schedule & logic"}
              </p>
            </div>
          </div>
        </div>
        <Button
          variant="primary"
          onClick={handleRecalculate}
          disabled={loading}
          className="gap-1.5"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Recalculating…" : "Recalculate"}
        </Button>
      </div>

      {/* Schedule source caption — live recompute vs saved snapshot. */}
      <div className="flex items-start gap-2 rounded-lg border border-[#E2DDD8] bg-[#FAF8F6] px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#6B5C32]" />
        <p className="text-xs leading-relaxed text-[#4B4642]">
          {isLive ? (
            <>
              The Schedule Result below is a <strong>live recompute</strong> from the current
              orders, generated on <strong>{generatedAt}</strong>. Press Recalculate to refresh it.
              It is read-only — nothing is written to the ERP.
            </>
          ) : props.fetchUrl ? (
            <>
              Showing a <strong>saved snapshot</strong> generated on <strong>{generatedAt}</strong>{" "}
              — the live schedule could not be loaded. Press Recalculate to try again.
            </>
          ) : (
            <>
              The Schedule Result below is a <strong>saved snapshot</strong> generated on{" "}
              <strong>{generatedAt}</strong>. The Recalculate button does not re-run the schedule
              yet — live re-scheduling from current orders is the next phase.
            </>
          )}
        </p>
      </div>

      {/* Upstream department reference — the previous stage(s) this schedule
          floors on. Lets the operator jump back and check that plan first. */}
      {props.upstream && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#E2DDD8] bg-white px-4 py-3">
          <CornerLeftUp className="h-4 w-4 shrink-0 text-[#6B5C32]" />
          <span className="text-xs font-semibold text-[#4B4642]">
            {props.upstream.length > 1 ? "Upstream departments:" : "Upstream department:"}
          </span>
          {props.upstream.length === 0 ? (
            <span className="text-xs text-[#6B7280]">First stage — scheduled from orders.</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              {props.upstream.map((u) => (
                <Link
                  key={u.route}
                  to={u.route}
                  className="inline-flex items-center rounded-full border border-[#C9B27A] bg-[#FBF4E6] px-2.5 py-0.5 text-xs font-semibold text-[#6B5C32] hover:bg-[#F4E9CE]"
                >
                  {u.label}
                </Link>
              ))}
            </span>
          )}
        </div>
      )}

      {/* Schedule Result — main body, open by default */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base text-[#1F1D1B]">
            <span className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-[#6B5C32]" />
              Schedule Result
            </span>
            <span className="text-xs font-normal text-[#6B7280]">Snapshot · {generatedAt}</span>
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
            <h3 className="mb-2 text-sm font-semibold text-[#1F1D1B]">{props.calendarHeading}</h3>
            <Calendar sheet={calendarSheet} cfg={props.calendarConfig} />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-[#1F1D1B]">By Day Summary</h3>
            <ByDayTable sheet={byDaySheet} cfg={props.byDayConfig} />
          </div>
        </CardContent>
      </Card>

      {/* Framing downstream-team schedules — extra collapsible tables */}
      {props.extraSheets?.map((ex) => (
        <CollapsibleCard key={ex.sheetName} icon={ex.icon} title={ex.title} defaultOpen={false}>
          <PlainSheetTable sheet={SNAP.sheets?.[ex.sheetName]} wideCol={ex.wideCol} />
        </CollapsibleCard>
      ))}
    </div>
  );
}
