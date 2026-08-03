// ---------------------------------------------------------------------------
// Planning > department drill-in — SHARED scaffold for the downstream teams
// whose snapshot sheet is a PLAIN day-keyed table (no Lane column, no per-SO
// grouping): Sofa Foam Bonding, Upholstery, Packing — and a same-day variant
// for Webbing.
//
// The grouped Calendar in _DepartmentSchedulePage needs a Lane column + a
// per-SO group key, which these sheets don't have (they are one row per
// working day). This scaffold renders the same page chrome — header +
// Recalculate button + snapshot caption + a snapshot-result Card — but with a
// plain (header + body) table as the main result, so the four new dept pages
// stay visually consistent with the existing four while honouring their real,
// simpler column shapes.
//
// The prose "Scheduling Process" / "Scheduling Logic / Prompt" panels were
// removed 2026-08-03 (owner) — see the note in _DepartmentSchedulePage.tsx.
//
// All UI copy is English (project rule). Snapshot DATA renders as-is, except
// each sheet's header row is replaced by a curated English header list
// (headerOverride) so no mixed-language column titles leak into the UI.
// ---------------------------------------------------------------------------
import { formatDate } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  RefreshCw,
  CalendarDays,
  Info,
} from "lucide-react";
import type { Snapshot } from "./_DepartmentSchedulePage";

export type { Snapshot };

// ── Plain table ────────────────────────────────────────────────────────────
// Renders a snapshot sheet as a header + body table. The sheet's own header
// row is dropped in favour of `headerOverride` (curated English titles).
//
// By default the table shows the first N source columns (N = headerOverride
// length). Pass `valueCols` to instead pick specific source columns by index
// (used by Webbing, which lifts only Date / Day / webbing-pieces / SOs out of
// the wider framing By Day sheet). `wideCol` and the emphasised first column
// are indexed by the RENDERED column position (0..headerOverride.length-1).
function PlainTable({
  sheet,
  headerOverride,
  wideCol,
  valueCols,
}: {
  sheet: Snapshot["sheets"][string] | undefined;
  headerOverride: string[];
  wideCol: number | null;
  valueCols?: number[];
}) {
  if (!sheet || sheet.length < 2) {
    return <p className="text-sm text-[#6B7280]">No rows in this snapshot.</p>;
  }
  // Map each rendered column to its source-column index.
  const srcCols = valueCols ?? headerOverride.map((_, i) => i);
  const body = sheet
    .slice(1)
    .filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined));
  return (
    <div className="overflow-x-auto rounded-lg border border-[#E2DDD8]">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-[#F0ECE9] text-left text-[#1F1D1B]">
            {headerOverride.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-t border-[#EFEAE5]">
              {srcCols.map((sc, ci) => {
                const raw = row[sc];
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

// ── Page ───────────────────────────────────────────────────────────────────
export type PlainDeptSchedulePageProps = {
  /** Display name, e.g. "Foam Bonding". */
  departmentName: string;
  /** Short tagline under the title. */
  subtitle?: string;
  /** Icon element shown in the header badge. */
  icon: React.ReactNode;
  /** Accent colour for the header badge (brand palette hex). */
  accentColor: string;
  /** The imported snapshot JSON object. */
  snapshot: Snapshot;
  /** Sheet name inside the snapshot to render as the main result. */
  sheetName: string;
  /** Heading shown above the main result table. */
  resultHeading: string;
  /** Curated English column titles (replaces the sheet's own header row). */
  headerOverride: string[];
  /**
   * Optional: pick specific SOURCE columns by index (one per headerOverride
   * entry). Omit to show the first N source columns. Webbing uses this to lift
   * only Date / Day / webbing-pieces / SOs out of the wider framing By Day sheet.
   */
  valueCols?: number[];
  /** A value column (rendered position) given extra min-width. */
  wideCol: number | null;
  /**
   * Optional extra content rendered inside the result Card ABOVE the table —
   * used by the Webbing page to explain its "same day as framing" model.
   */
  resultIntro?: React.ReactNode;
};

export default function PlainDeptSchedulePage(props: PlainDeptSchedulePageProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const SNAP = props.snapshot;
  const generatedAt = SNAP.generatedAt ? formatDate(SNAP.generatedAt) : "unknown date";
  const sheet = SNAP.sheets?.[props.sheetName];

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
          <strong>{generatedAt}</strong>. The Recalculate button does not re-run the schedule
          yet — live re-scheduling from current orders is the next phase.
        </p>
      </div>

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
        <CardContent className="space-y-4">
          {props.resultIntro}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[#1F1D1B]">{props.resultHeading}</h3>
            <PlainTable
              sheet={sheet}
              headerOverride={props.headerOverride}
              valueCols={props.valueCols}
              wideCol={props.wideCol}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
