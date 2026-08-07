// ---------------------------------------------------------------------------
// grid-export — WYSIWYG "Listing" export for the shared DataGrid.
//
// Owner ask: the export must mirror what's on screen — the CURRENT columns
// (whatever is toggled on, in their current order) over the CURRENT rows
// (whatever the filter/search left showing). The DataGrid already knows both
// (its visibleColumns + sortedData); this turns them into an array-of-arrays
// the existing exportReportCsv/Xlsx download.
//
// Pure + tested: the value each column contributes is the load-bearing part
// (a currency column must export a real number so Excel can SUM it; a date
// must export its day, not an ISO timestamp; a computed column must use its
// export/filter accessor, never "[object Object]").
// ---------------------------------------------------------------------------

import type { Aoa } from "./export-report";

// The minimal column shape this needs — a structural subset of DataGrid's
// Column<T>, so callers pass their columns straight through.
export type ExportColumn<T> = {
  key: string;
  label: string;
  type?: "text" | "date" | "currency" | "number" | "docno" | "status";
  /** Explicit export value — wins over everything. Return a number for money
   *  so Excel keeps it summable. */
  exportValue?: (row: T) => string | number | null;
  /** Reused as a fallback for computed/object columns (same one the value
   *  filter uses), so an exportable value exists without extra wiring. */
  filterAccessor?: (row: T) => string | number | null;
};

/** Dotted-path getter — mirrors the DataGrid's own getNestedValue. */
export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  if (!path.includes(".")) return (obj as Record<string, unknown>)[path];
  return path.split(".").reduce<unknown>(
    (acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]),
    obj,
  );
}

/**
 * The plain value a column contributes to an export cell. Order of preference:
 *   exportValue → filterAccessor → raw path value (type-aware).
 * Currency columns (values stored in sen) export as a RM number so the sheet
 * can total them; everything else exports as a trimmed string.
 */
export function cellExportValue<T>(col: ExportColumn<T>, row: T): string | number {
  if (col.exportValue) {
    const v = col.exportValue(row);
    return v == null ? "" : v;
  }
  const raw = col.filterAccessor
    ? col.filterAccessor(row)
    : (getPath(row, col.key) as string | number | null | undefined);
  if (raw == null) return "";
  if (col.type === "currency" && typeof raw === "number") {
    // Stored in sen → RM, real number (Excel formats/sums it).
    return Math.round(raw) / 100;
  }
  if (col.type === "number" && typeof raw === "number") return raw;
  if (col.type === "date") {
    const s = String(raw);
    // ISO timestamp → just the day; anything else passes through.
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
  }
  return typeof raw === "number" ? raw : String(raw);
}

/**
 * Build the Listing array-of-arrays: header row (column labels, in the given
 * order) followed by one row per data row. `columns` is expected to already be
 * the VISIBLE columns in display order — pass DataGrid's visibleColumns.
 */
export function buildListingAoa<T>(columns: ExportColumn<T>[], rows: T[]): Aoa {
  const cols = columns.filter((c) => c.key !== "__select__" && c.key !== "__actions__");
  const header = cols.map((c) => c.label);
  const body = rows.map((r) => cols.map((c) => cellExportValue(c, r)));
  return [header, ...body];
}

/** A safe, dated filename base. `kind` distinguishes listing vs detail. */
export function exportFilename(base: string, kind: string, ext: string, today: string): string {
  const clean = base.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `${clean}-${kind}-${today}.${ext}`;
}
