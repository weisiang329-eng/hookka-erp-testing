// ---------------------------------------------------------------------------
// /consignment/return — Consignment Returns
//
// BUG-2026-08-13-071. This page used to call `buildMockCRs()`, which mixed real
// consignment-note figures with invented ones:
//
//   * `crNo`      a module-level counter (`CR-00001`…) restarted on every page
//                 load and presented in a `docno` column as a document number.
//                 No CR document exists in this system — there is no cr table,
//                 no CR numbering series, nothing.
//   * `status`    PENDING / INSPECTED / ACCEPTED / RESTOCKED, chosen by
//                 `Math.random()` thresholds. That vocabulary appears NOWHERE
//                 else in the repo — not in a migration, not in a route, not in
//                 a type. It was invented here.
//   * `returnDate` `now − Math.floor(Math.random()*10+1)` days for the
//                 fully-returned bucket.
//
// …and exported all of it to CSV. Real customer names and real RM figures beside
// an invented status is worse than an obviously-fake page: the correct money
// makes the fabricated column look credible.
//
// WHAT THE DATABASE ACTUALLY RECORDS (read before changing anything here):
//
//   POST /api/consignment-notes/:id/return (routes/consignment-notes.ts:1073)
//   is the ONLY writer of a return, and it does the whole thing in ONE batch:
//     - fully-returned line → consignment_items.status='RETURNED' + returnedDate
//     - partial return      → consignment_items.quantity is REDUCED, and
//                             nothing else: no status, no returnedDate
//     - fg_units DELIVERED → RETURNED (+ returnedAt), stock_movements STOCK_IN
//       with reason='CONSIGNMENT_RETURN'
//     - the parent note flips to RETURNED (all lines back) or PARTIALLY_SOLD
//
//   There is no inspection step, no acceptance step and no separate restock
//   step — the goods are booked back into stock at the moment the return is
//   recorded. So a four-stage PENDING→INSPECTED→ACCEPTED→RESTOCKED pipeline is
//   not "not implemented yet", it is a workflow this business does not have.
//   It is therefore GONE, not stubbed, and the page says so.
//
// TWO THINGS THIS PAGE CANNOT SOURCE, AND SAYS SO INSTEAD OF GUESSING:
//
//   1. Partial returns. The endpoint records them only as a smaller quantity on
//      a line that stays AT_BRANCH. There is no per-line returnedQty column
//      (the endpoint's own header explains why). A note whose lines were all
//      partially returned therefore has NO return record to show.
//   2. The money on a return. `consignment_items.unitPrice` is routinely 0 —
//      the real price lives on the parent CONSIGNMENT ORDER line
//      (`consignment_order_items.unitPriceSen`, see api/lib/cn-value.ts). The
//      CN *list* endpoint resolves that into a note-level `valueSen`, but
//      /api/consignments (this page's source) does not carry a per-line price,
//      and a note-level total is not the value of the returned lines. So the
//      value here is Σ(qty × unitPrice) over the lines that CARRY a price, the
//      "Value Basis" column publishes how many lines that is, and a note with
//      no priced line shows "—" — never RM 0.00, which would be a claim that
//      the returned goods were worth nothing.
//
// The rule this page is now built on (docs/BUG-CLASSES.md § C15):
// where a real source exists, use it; where none exists, render "—" and say
// why; never a plausible-looking value.
// ---------------------------------------------------------------------------
import { useState, useMemo, useCallback, useDeferredValue } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  Package,
  Layers,
  Info,
  Eye,
  ExternalLink,
  RefreshCw,
  CalendarClock,
  Download,
  RotateCcw,
} from "lucide-react";
import type { ConsignmentItem, ConsignmentNote } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rendered wherever there is no real source for a figure. */
const NO_FIGURE = "—";

type ConsignmentReturnRow = {
  /** consignment_notes.id — the row key AND the drill-through target. */
  id: string;
  /** consignment_notes.noteNumber (CGN-YYMM-NNN / legacy CON-*). The real
   *  document number. The page previously invented a "CR-00001" in its place. */
  noteNumber: string;
  customerId: string;
  customerName: string;
  branchName: string;
  /** consignment_notes.status verbatim — RETURNED / PARTIALLY_SOLD / … */
  noteStatus: string;
  /** consignment_items rows with status='RETURNED'. */
  returnedLines: ConsignmentItem[];
  /** returnedLines.length, materialised as a row field because the DataGrid
   *  sorts, value-filters and exports by `column.key` off the row object — a
   *  key with no field behind it silently sorts and exports as blank. */
  returnedLineCount: number;
  /** How many of those lines carry a non-zero unitPrice (the value basis). */
  pricedLineCount: number;
  /** Σ(qty × unitPrice) over the PRICED returned lines; null when none is
   *  priced — "not recorded" is not "worth nothing". */
  returnValueSen: number | null;
  /** Latest consignment_items.returnedDate among the returned lines; null when
   *  no line carries one. Never synthesised. */
  returnDate: string | null;
  remarks: string;
};

// ---------------------------------------------------------------------------
// Derivation — every field below traces to a column the return endpoint writes
// ---------------------------------------------------------------------------

function buildReturnRows(notes: ConsignmentNote[]): ConsignmentReturnRow[] {
  const rows: ConsignmentReturnRow[] = [];

  for (const n of notes) {
    const returnedLines = (n.items ?? []).filter((i) => i.status === "RETURNED");

    // A note qualifies on a per-line record, or on the note itself having been
    // flipped to RETURNED. The second case can exist without line records (a
    // plain status edit through PUT), and then every per-line figure below is
    // legitimately empty — the row still appears, because the note IS marked
    // returned and hiding it would be its own kind of lie.
    if (returnedLines.length === 0 && n.status !== "RETURNED") continue;

    // DAMAGED lines are deliberately NOT treated as returns. `DAMAGED` is a
    // condition flag on a line that is still at the branch; nothing in the API
    // writes it, it carries no returnedDate, and the old code listed such
    // notes as "returns needing inspection" — an invented workflow on top of a
    // status with no writer.

    const priced = returnedLines.filter((i) => i.unitPrice > 0);
    const returnDates = returnedLines
      .map((i) => i.returnedDate)
      .filter((d): d is string => !!d)
      .sort();

    rows.push({
      id: n.id,
      noteNumber: n.noteNumber,
      customerId: n.customerId,
      customerName: n.customerName,
      branchName: n.branchName,
      noteStatus: n.status,
      returnedLines,
      returnedLineCount: returnedLines.length,
      pricedLineCount: priced.length,
      returnValueSen:
        priced.length > 0
          ? priced.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
          : null,
      returnDate: returnDates.length > 0 ? returnDates[returnDates.length - 1] : null,
      remarks: n.notes,
    });
  }

  // Newest recorded return first; rows with no recorded date sort last rather
  // than being given one.
  rows.sort((a, b) => {
    if (a.returnDate && b.returnDate) return b.returnDate.localeCompare(a.returnDate);
    if (a.returnDate) return -1;
    if (b.returnDate) return 1;
    return a.noteNumber.localeCompare(b.noteNumber);
  });

  return rows;
}

/** CSV cell: quote anything containing a comma, quote or newline. A customer
 *  name with a comma in it used to shift every later column by one. */
function csvCell(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConsignmentReturnPage() {
  const navigate = useNavigate();
  const [detailRow, setDetailRow] = useState<ConsignmentReturnRow | null>(null);

  // Filters. The customer filter is a free-text contains-match — wrap it in
  // useDeferredValue so each keystroke updates the input synchronously but the
  // expensive filter pass runs at React's leisure (typically the next idle
  // slot). Saves ~1-2 frames per char on a 500-row consignment list.
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const deferredFilterCustomer = useDeferredValue(filterCustomer);
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // ---------- Fetch ----------
  const {
    data: consignmentsResp,
    loading,
    error,
    refresh: fetchData,
  } = useCachedJson<{ success?: boolean; data?: ConsignmentNote[] }>("/api/consignments");

  // Pure derive — there is no local mutation to preserve any more. The old page
  // kept crRows in state so its Mark Inspected / Accept / Restock buttons could
  // rewrite the invented status in memory (nothing was ever persisted: no
  // endpoint accepts those transitions, and a refresh reshuffled every row).
  const rows = useMemo(
    () =>
      consignmentsResp?.success && consignmentsResp.data
        ? buildReturnRows(consignmentsResp.data)
        : [],
    [consignmentsResp],
  );

  // The read failed — say so, rather than drawing an empty grid that reads as
  // "no returns" (BUG-2026-08-13-005: a dead request rendered as no data).
  const loadFailed = !loading && (!!error || consignmentsResp?.success === false);

  // ---------- Filtered data ----------
  const filteredRows = useMemo(() => {
    let data = rows;

    if (filterStatus) {
      data = data.filter((d) => d.noteStatus === filterStatus);
    }

    // Customer filter — uses the deferred value so the input stays responsive
    // while the filter pass yields to other work.
    if (deferredFilterCustomer) {
      const needle = deferredFilterCustomer.toLowerCase();
      data = data.filter((d) => d.customerName.toLowerCase().includes(needle));
    }

    // Date filters run on the RECORDED return date. Rows with no recorded date
    // drop out of a date-bounded view — they are not placed inside the range.
    if (filterDateFrom) {
      const from = new Date(filterDateFrom);
      data = data.filter((d) => d.returnDate && new Date(d.returnDate) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      data = data.filter((d) => d.returnDate && new Date(d.returnDate) <= to);
    }

    return data;
  }, [rows, filterStatus, deferredFilterCustomer, filterDateFrom, filterDateTo]);

  // Status options come from the data, so the dropdown can only ever offer a
  // status the notes actually carry.
  const statusOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.noteStatus))).sort(),
    [rows],
  );

  // ---------- Summary (all four measured) ----------
  const summary = useMemo(() => {
    const returnedLineCount = rows.reduce((s, r) => s + r.returnedLineCount, 0);

    // Summed WITHOUT a `?? 0` coalesce on purpose: a total inherits the weakest
    // input, and coalescing an unrecorded value to zero is how a missing figure
    // gets laundered into a complete-looking total.
    let valueSen = 0;
    let valuedRowCount = 0;
    for (const r of rows) {
      if (r.returnValueSen === null) continue;
      valueSen += r.returnValueSen;
      valuedRowCount++;
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = rows.filter(
      (r) => r.returnDate && new Date(r.returnDate) >= startOfMonth,
    ).length;
    const datedRows = rows.filter((r) => r.returnDate).length;

    return {
      noteCount: rows.length,
      returnedLineCount,
      valueSen: valuedRowCount > 0 ? valueSen : null,
      valuedRowCount,
      thisMonth,
      datedRows,
    };
  }, [rows]);

  // ---------- Export CSV ----------
  // Same values as the screen, cell for cell. A column with no real source is
  // exported EMPTY — never a filler that a spreadsheet would read as fact.
  const CSV_HEADERS = [
    "CN No.",
    "Customer",
    "Branch",
    "Returned Lines",
    "Return Value (RM)",
    "Value Basis",
    "Return Date",
    "Note Status",
  ];

  const handleExportCSV = () => {
    const csvRows = filteredRows.map((r) => [
      r.noteNumber,
      r.customerName,
      r.branchName,
      // Empty, not 0 — the same semantics the screen shows. A note flagged
      // RETURNED with no line record has an UNKNOWN number of returned lines,
      // and a spreadsheet reads 0 as a counted zero.
      r.returnedLineCount === 0 ? "" : r.returnedLineCount,
      r.returnValueSen === null ? "" : (r.returnValueSen / 100).toFixed(2),
      r.returnedLineCount === 0
        ? ""
        : `${r.pricedLineCount}/${r.returnedLineCount} priced`,
      r.returnDate ? formatDate(r.returnDate) : "",
      r.noteStatus,
    ]);
    const csv = [CSV_HEADERS, ...csvRows]
      .map((row) => row.map(csvCell).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consignment-returns-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- Columns ----------
  const columns: Column<ConsignmentReturnRow>[] = useMemo(
    () => [
      { key: "noteNumber", label: "CN No.", type: "docno", width: "140px", sortable: true },
      {
        key: "customerName",
        label: "Customer",
        type: "text",
        sortable: true,
        render: (_value, row) => (
          <p className="font-medium text-[#1F1D1B]">{row.customerName}</p>
        ),
      },
      { key: "branchName", label: "Branch", type: "text", width: "120px", sortable: true },
      {
        key: "returnedLineCount",
        label: "Returned Lines",
        type: "number",
        width: "110px",
        align: "right",
        sortable: true,
        render: (_value, row) =>
          row.returnedLines.length > 0 ? row.returnedLines.length : NO_FIGURE,
      },
      {
        key: "returnValueSen",
        label: "Return Value",
        type: "currency",
        width: "120px",
        align: "right",
        sortable: true,
        render: (_value, row) =>
          row.returnValueSen === null ? NO_FIGURE : formatCurrency(row.returnValueSen),
      },
      {
        key: "pricedLineCount",
        label: "Value Basis",
        type: "text",
        width: "120px",
        sortable: true,
        render: (_value, row) =>
          row.returnedLines.length === 0 ? (
            <span className="text-[#9CA3AF]">{NO_FIGURE}</span>
          ) : (
            <span className="text-xs text-[#6B7280]">
              {row.pricedLineCount}/{row.returnedLines.length} priced
            </span>
          ),
      },
      {
        key: "returnDate",
        label: "Return Date",
        type: "date",
        width: "110px",
        sortable: true,
        render: (_value, row) => (
          <span>{row.returnDate ? formatDate(row.returnDate) : NO_FIGURE}</span>
        ),
      },
      { key: "noteStatus", label: "Note Status", type: "status", width: "130px", sortable: true },
    ],
    [],
  );

  // ---------- Context menu ----------
  // No Accept / Restock / Print CR. The first two wrote an invented status into
  // local state only; the third printed a document that does not exist.
  const getContextMenuItems = useCallback(
    (row: ConsignmentReturnRow): ContextMenuItem[] => [
      {
        label: "View Details",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => setDetailRow(row),
      },
      {
        label: "Open Consignment Note",
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        action: () => navigate(`/consignment/${row.id}`),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ],
    [fetchData, navigate],
  );

  return (
    <div className="space-y-6 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Consignment Returns</h1>
          <p className="text-xs text-[#6B7280]">
            Consignment note lines recorded as returned
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={handleExportCSV}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button variant="primary" onClick={() => navigate("/consignment/note")}>
            <RotateCcw className="h-4 w-4" /> Record a Return
          </Button>
        </div>
      </div>

      {/* Summary Cards — four measured figures */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5">
              <Package className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#6B5C32]">
                {loading ? NO_FIGURE : summary.noteCount}
              </p>
              <p className="text-xs text-[#6B7280]">Notes with returns</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-blue-50 p-2.5">
              <Layers className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600">
                {loading ? NO_FIGURE : summary.returnedLineCount}
              </p>
              <p className="text-xs text-[#6B7280]">Returned lines</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-green-50 p-2.5">
              <RotateCcw className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">
                {loading || summary.valueSen === null
                  ? NO_FIGURE
                  : formatCurrency(summary.valueSen)}
              </p>
              <p className="text-xs text-[#6B7280]">
                Recorded value{" "}
                {!loading && summary.noteCount > 0
                  ? `(${summary.valuedRowCount}/${summary.noteCount} notes priced)`
                  : ""}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-amber-50 p-2.5">
              <CalendarClock className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">
                {loading ? NO_FIGURE : summary.thisMonth}
              </p>
              <p className="text-xs text-[#6B7280]">
                Returned this month{" "}
                {!loading && summary.noteCount > 0
                  ? `(${summary.datedRows}/${summary.noteCount} dated)`
                  : ""}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* What this page can and cannot tell you. This replaced a four-stage
          PENDING → INSPECTED → ACCEPTED → RESTOCKED pipeline whose every value
          came out of Math.random(). */}
      <Card>
        <CardContent className="p-4 flex gap-3">
          <Info className="h-4 w-4 text-[#6B5C32] shrink-0 mt-0.5" />
          <div className="space-y-1.5 text-xs text-[#6B7280]">
            <p>
              <span className="font-medium text-[#1F1D1B]">
                Return processing is not tracked.
              </span>{" "}
              A consignment return is recorded as a single event: the line is
              flagged returned, the units go back into finished-goods stock and a
              STOCK_IN movement is written — all at once. There is no inspection,
              acceptance or restocking status in the database, so none is shown.
            </p>
            <p>
              <span className="font-medium text-[#1F1D1B]">
                Partial returns leave no line record.
              </span>{" "}
              Returning some of a line&apos;s units reduces its quantity and stamps
              no date, so a note appears here only once a whole line is returned.
            </p>
            <p>
              <span className="font-medium text-[#1F1D1B]">
                Return value covers priced lines only.
              </span>{" "}
              Consignment note lines are commonly created with a unit price of 0
              (the price lives on the parent consignment order), and this page has
              no per-line price for those. Such notes show &ldquo;{NO_FIGURE}
              &rdquo; rather than RM 0.00; the Value Basis column says how many
              lines are behind each figure.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20"
        >
          <option value="">All Note Statuses</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <Input
          placeholder="Filter by customer..."
          value={filterCustomer}
          onChange={(e) => setFilterCustomer(e.target.value)}
          className="h-9 w-48"
        />
        <Input
          type="date"
          value={filterDateFrom}
          onChange={(e) => setFilterDateFrom(e.target.value)}
          className="h-9 w-40"
        />
        <span className="text-sm text-[#6B7280]">to</span>
        <Input
          type="date"
          value={filterDateTo}
          onChange={(e) => setFilterDateTo(e.target.value)}
          className="h-9 w-40"
        />
        {(filterStatus || filterCustomer || filterDateFrom || filterDateTo) && (
          <Button
            variant="outline"
            onClick={() => {
              setFilterStatus("");
              setFilterCustomer("");
              setFilterDateFrom("");
              setFilterDateTo("");
            }}
          >
            Clear Filters
          </Button>
        )}
      </div>

      {/* DataGrid */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-[#6B5C32]" /> Consignment Returns
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {loadFailed && (
            <p className="mb-3 text-xs text-red-600">
              Could not load consignment notes — this list is not empty, it is
              unknown. Refresh to try again.
            </p>
          )}
          <DataGrid<ConsignmentReturnRow>
            columns={columns}
            data={filteredRows}
            keyField="id"
            loading={loading}
            stickyHeader
            maxHeight="calc(100vh - 280px)"
            emptyMessage={
              loadFailed
                ? "Consignment notes could not be loaded."
                : "No consignment note has a line recorded as returned."
            }
            onDoubleClick={(row) => setDetailRow(row)}
            contextMenuItems={getContextMenuItems}
          />
        </CardContent>
      </Card>

      {/* ---------- Detail Dialog (inline, fixed inset-0 z-50) ---------- */}
      {detailRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDetailRow(null)}
          />
          {/* Panel */}
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B] doc-number">
                  {detailRow.noteNumber}
                </h2>
                <p className="text-xs text-[#6B7280]">Recorded consignment return</p>
              </div>
              <button
                onClick={() => setDetailRow(null)}
                className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
              <div className="flex items-center gap-3">
                <Badge variant="status" status={detailRow.noteStatus} />
              </div>

              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Consignment Note</p>
                  <p className="font-medium doc-number">{detailRow.noteNumber}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{detailRow.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{detailRow.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Returned Lines</p>
                  <p className="font-medium">
                    {detailRow.returnedLines.length > 0
                      ? detailRow.returnedLines.length
                      : NO_FIGURE}
                  </p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Return Value</p>
                  <p className="font-medium">
                    {detailRow.returnValueSen === null
                      ? NO_FIGURE
                      : formatCurrency(detailRow.returnValueSen)}
                  </p>
                  {detailRow.returnedLines.length > 0 && (
                    <p className="text-[10px] text-[#9CA3AF]">
                      {detailRow.pricedLineCount}/{detailRow.returnedLines.length} lines
                      carry a unit price
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Return Date</p>
                  <p className="font-medium">
                    {detailRow.returnDate ? formatDate(detailRow.returnDate) : NO_FIGURE}
                  </p>
                </div>
              </div>

              {/* The returned lines themselves — the actual record. This
                  replaced a four-step "Processing Status" timeline driven
                  entirely by the invented status. */}
              <div className="border-t border-[#E2DDD8] pt-4">
                <h3 className="text-sm font-semibold text-[#1F1D1B] mb-3">
                  Returned Lines
                </h3>
                {detailRow.returnedLines.length === 0 ? (
                  <p className="text-xs text-[#6B7280]">
                    This note is marked {detailRow.noteStatus.replace(/_/g, " ")}, but no
                    individual line carries a return record, so there is nothing to list.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#9CA3AF] text-left">
                          <th className="pb-2 font-medium">Product</th>
                          <th className="pb-2 font-medium text-right">Qty</th>
                          <th className="pb-2 font-medium text-right">Unit Price</th>
                          <th className="pb-2 font-medium text-right">Returned</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailRow.returnedLines.map((it: ConsignmentItem) => (
                          <tr key={it.id} className="border-t border-[#F0ECE9]">
                            <td className="py-2">
                              <span className="doc-number">{it.productCode}</span>
                              {it.productName ? (
                                <span className="text-[#6B7280]"> — {it.productName}</span>
                              ) : null}
                            </td>
                            <td className="py-2 text-right">{it.quantity}</td>
                            <td className="py-2 text-right">
                              {it.unitPrice > 0 ? formatCurrency(it.unitPrice) : NO_FIGURE}
                            </td>
                            <td className="py-2 text-right">
                              {it.returnedDate ? formatDate(it.returnedDate) : NO_FIGURE}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Remarks */}
              {detailRow.remarks && (
                <div className="border-t border-[#E2DDD8] pt-4">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Remarks</h3>
                  <p className="text-xs text-[#6B7280]">{detailRow.remarks}</p>
                </div>
              )}
            </div>

            {/* Footer Actions — no status transitions: nothing on this screen
                can advance a return, because the system has no stage to
                advance it to. */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              <Button
                variant="outline"
                onClick={() => navigate(`/consignment/${detailRow.id}`)}
              >
                <ExternalLink className="h-4 w-4" /> Open Consignment Note
              </Button>
              <Button variant="outline" onClick={() => setDetailRow(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
